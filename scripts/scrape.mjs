// Scheduled scrape run: Parallel API -> upsert into snapshot table (day grain).
// Run by the Render cron job. Env:
//   DATABASE_URL       - competitor_writer connection string
//   PARALLEL_API_KEY   - Parallel task API key
//   SNAPSHOT_TABLE     - target table (default listing_snapshots_test while validating;
//                        switch to listing_snapshots to go live)
//   RUNS_TABLE         - run log (default scrape_runs_test)
import pg from 'pg';

const KEY = process.env.PARALLEL_API_KEY;
const SNAPSHOT_TABLE = process.env.SNAPSHOT_TABLE || 'listing_snapshots_test';
const RUNS_TABLE = process.env.RUNS_TABLE || 'scrape_runs_test';
if (!KEY || !process.env.DATABASE_URL) {
  console.error('DATABASE_URL and PARALLEL_API_KEY are required'); process.exit(1);
}
if (!/^[a-z_]+$/.test(SNAPSHOT_TABLE) || !/^[a-z_]+$/.test(RUNS_TABLE)) {
  console.error('bad table name'); process.exit(1);
}

const SCHEMA = { type: 'json', json_schema: { type: 'object', properties: {
  title: { type: 'string' },
  price: { type: ['number', 'null'], description: 'current selling price in INR' },
  mrp: { type: ['number', 'null'], description: 'list price / MRP in INR' },
  rating: { type: ['number', 'null'] },
  review_count: { type: ['integer', 'null'], description: 'global ratings count' },
  availability: { type: 'string', description: 'in stock / out of stock / unavailable' } },
  required: ['title', 'availability'] } };

async function api(method, path, body) {
  const res = await fetch(`https://api.parallel.ai${path}`, {
    method, headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

const startedAt = new Date().toISOString();
const runNo = (await db.query(`SELECT coalesce(max(run_no),0)+1 AS n FROM ${RUNS_TABLE}`)).rows[0].n;
const listings = (await db.query(`
  SELECT DISTINCT own_asin AS asin, true AS is_own FROM matched_sku_map WHERE own_asin IS NOT NULL
  UNION SELECT DISTINCT rival_asin, false FROM matched_sku_map WHERE rival_asin IS NOT NULL`)).rows;
console.log(`run ${runNo}: scraping ${listings.length} listings -> ${SNAPSHOT_TABLE}`);
await db.query(`
  INSERT INTO ${RUNS_TABLE} (run_no, started_at, listings_attempted) VALUES ($1, $2, $3)
  ON CONFLICT (run_no) DO NOTHING`, [runNo, startedAt, listings.length]);

// submit all tasks first (lite processor), then collect results
const runs = [];
for (const l of listings) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await api('POST', '/v1/tasks/runs', {
        input: `Amazon India product page https://www.amazon.in/dp/${l.asin} — extract title, current price (INR), MRP/list price, star rating, total ratings count, availability.`,
        processor: 'lite',
        task_spec: { output_schema: SCHEMA },
      });
      runs.push({ ...l, run_id: r.run_id });
      break;
    } catch (e) {
      console.log(`submit ${l.asin} failed (${attempt + 1}/4): ${e.message}`);
      await sleep(e.message.includes('429') ? 15000 * (attempt + 1) : 5000);
    }
  }
  await sleep(1000);
}
console.log(`submitted ${runs.length}/${listings.length}`);

let written = 0;
for (const r of runs) {
  try {
    const res = await api('GET', `/v1/tasks/runs/${r.run_id}/result`);
    if (res.run.status !== 'completed') { console.log(`${r.asin}: ${res.run.status}`); continue; }
    const d = typeof res.output.content === 'string' ? JSON.parse(res.output.content) : res.output.content;
    // first_run_no/last_run_no exist only on the *_test table (they prove upsert behavior)
    const testMode = SNAPSHOT_TABLE.endsWith('_test');
    const runCols = testMode ? ', first_run_no, last_run_no' : '';
    const runVals = testMode ? ', $9, $9' : '';
    const runSet = testMode ? ', last_run_no = EXCLUDED.last_run_no' : '';
    const params = [r.asin, r.is_own, d.title, d.price, d.mrp, d.rating, d.review_count, d.availability];
    if (testMode) params.push(runNo);
    params.push(r.run_id);
    await db.query(`
      INSERT INTO ${SNAPSHOT_TABLE}
        (workspace_id, snapshot_date, scraped_at, marketplace, asin, is_own,
         title, price, mrp, rating, review_count, availability${runCols}, run_id)
      VALUES ('areoveda', (now() AT TIME ZONE 'Asia/Kolkata')::date, now(), 'amazon', $1, $2,
              $3, $4, $5, $6, $7, $8${runVals}, $${params.length})
      ON CONFLICT (workspace_id, snapshot_date, marketplace, asin) DO UPDATE SET
        title = EXCLUDED.title, price = EXCLUDED.price, mrp = EXCLUDED.mrp,
        rating = EXCLUDED.rating, review_count = EXCLUDED.review_count,
        availability = EXCLUDED.availability, scraped_at = now()${runSet},
        run_id = EXCLUDED.run_id`,
      params);
    written++;
  } catch (e) {
    console.log(`${r.asin}: ${e.message}`);
  }
}

await db.query(`
  UPDATE ${RUNS_TABLE} SET finished_at = now(), listings_written = $2 WHERE run_no = $1`, [runNo, written]);
const check = (await db.query(`
  SELECT (SELECT count(*) FROM ${SNAPSHOT_TABLE}) AS snapshot_rows,
         (SELECT count(*) FROM ${SNAPSHOT_TABLE} WHERE last_run_no = $1) AS touched_this_run,
         (SELECT count(*) FROM ${RUNS_TABLE} WHERE finished_at IS NOT NULL) AS runs_finished`, [runNo])).rows[0];
console.log(`run ${runNo} done: wrote ${written}/${listings.length}`, check);
await db.end();

import express from 'express';
import pg from 'pg';

const app = express();
app.use(express.json());
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows);
// Single-tenant per deployment: every read/write is scoped to this workspace.
// Placeholder 'areoveda' until product integration; then set WORKSPACE_ID to the
// client's real workspace UUID (Lifecell) and retag existing rows.
const WS = process.env.WORKSPACE_ID || 'areoveda';

app.get('/api/summary', async (_req, res) => {
  try {
    const [s] = await q(`
      SELECT (SELECT max(snapshot_date) FROM listing_snapshots WHERE workspace_id = $1) AS as_of,
             (SELECT count(DISTINCT own_product) FROM matched_sku_map WHERE workspace_id = $1) AS products,
             (SELECT count(DISTINCT rival_brand) FROM matched_sku_map WHERE workspace_id = $1) AS competitors,
             (SELECT count(*) FROM listing_snapshots WHERE workspace_id = $1 AND NOT is_own AND availability NOT ILIKE '%in stock%') AS rivals_oos,
             (SELECT round(avg(rating),2) FROM listing_snapshots WHERE workspace_id = $1 AND is_own AND rating IS NOT NULL) AS our_avg_rating,
             (SELECT round(avg(rating),2) FROM listing_snapshots WHERE workspace_id = $1 AND NOT is_own AND rating IS NOT NULL) AS rival_avg_rating`,
      [WS]);
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/competitors', async (_req, res) => {
  try {
    res.json(await q(`
      SELECT rival_brand AS brand, count(*) AS pairs
      FROM matched_sku_map WHERE workspace_id = $1 GROUP BY 1 ORDER BY count(*) DESC, 1`, [WS]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a competitor product to track. Inserts the pair; the scrape pipeline picks
// new pairs up on its next run (wiring the trigger itself is a dev-side job).
app.post('/api/competitors', async (req, res) => {
  try {
    const { brand, product_name, asin, own_product } = req.body || {};
    if (!brand || !asin || !own_product) return res.status(400).json({ error: 'brand, asin and own_product are required' });
    if (!/^B[0-9A-Z]{9}$/.test(asin)) return res.status(400).json({ error: 'that does not look like an ASIN (B + 9 chars)' });
    await q(`
      INSERT INTO matched_sku_map (workspace_id, own_product, own_asin, rival_name, rival_asin, rival_brand, matching_confidence)
      SELECT $5, $1, (SELECT own_asin FROM matched_sku_map WHERE workspace_id = $5 AND own_product = $1 LIMIT 1), $2, $3, $4, 'pending_scrape'
      ON CONFLICT (own_product, rival_asin) DO NOTHING`,
      [own_product, product_name || brand, asin, brand, WS]);
    res.json({ ok: true, queued: true, note: 'pair saved — data appears after the next scrape run' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/battlecard', async (_req, res) => {
  try {
    const rows = await q(`
      WITH own AS (SELECT asin, title, price, mrp, rating, review_count, availability, image_url FROM listing_snapshots WHERE workspace_id = $1 AND is_own),
           riv AS (SELECT asin, title, price, rating, review_count, availability, image_url FROM listing_snapshots WHERE workspace_id = $1 AND NOT is_own)
      SELECT m.own_product, m.own_asin,
             o.price AS our_price, o.rating AS our_rating, o.review_count AS our_reviews, o.availability AS our_availability, o.image_url AS our_image,
             json_agg(json_build_object(
               'brand', m.rival_brand, 'name', m.rival_name, 'asin', m.rival_asin,
               'price', r.price, 'rating', r.rating, 'reviews', r.review_count,
               'availability', r.availability, 'image', r.image_url, 'pending', (r.asin IS NULL)
             ) ORDER BY m.rival_brand) AS rivals
      FROM matched_sku_map m
      LEFT JOIN own o ON o.asin = m.own_asin
      LEFT JOIN riv r ON r.asin = m.rival_asin
      WHERE m.workspace_id = $1
      GROUP BY m.own_product, m.own_asin, o.price, o.rating, o.review_count, o.availability, o.image_url
      ORDER BY m.own_product`, [WS]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/review_summaries', async (_req, res) => {
  try {
    res.json(await q('SELECT asin, is_own, summary, pros, cons, themes, based_on FROM listing_review_summary WHERE workspace_id = $1', [WS]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reviews.csv', async (_req, res) => {
  try {
    const rows = await q(`
      SELECT CASE WHEN r.is_own THEN 'AreoVeda' ELSE mr.rival_brand END AS brand,
             coalesce(mo.own_product, mr.rival_name) AS product,
             r.asin, r.is_own, r.stars, r.title, r.snippet, r.review_date
      FROM listing_reviews r
      LEFT JOIN LATERAL (SELECT own_product FROM matched_sku_map WHERE workspace_id = $1 AND own_asin = r.asin LIMIT 1) mo ON r.is_own
      LEFT JOIN LATERAL (SELECT rival_name, rival_brand FROM matched_sku_map WHERE workspace_id = $1 AND rival_asin = r.asin LIMIT 1) mr ON NOT r.is_own
      WHERE r.workspace_id = $1
      ORDER BY r.is_own DESC, brand, product, r.stars`, [WS]);
    const cell = v => v == null ? '' : '"' + String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
    const csv = ['brand,product,asin,is_own,stars,title,review,date',
      ...rows.map(r => [r.brand, r.product, r.asin, r.is_own, r.stars, r.title, r.snippet, r.review_date].map(cell).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="areoveda_competitor_reviews.csv"');
    res.send('﻿' + csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reviews', async (_req, res) => {
  try {
    res.json(await q(`
      SELECT r.asin, r.is_own, r.stars, r.title, r.snippet, r.review_date,
             coalesce(mo.own_product, mr.rival_name)  AS product,
             coalesce('AreoVeda', mr.rival_brand)     AS brand_label,
             CASE WHEN r.is_own THEN 'AreoVeda' ELSE mr.rival_brand END AS brand
      FROM listing_reviews r
      LEFT JOIN LATERAL (SELECT own_product FROM matched_sku_map WHERE workspace_id = $1 AND own_asin = r.asin LIMIT 1) mo ON r.is_own
      LEFT JOIN LATERAL (SELECT rival_name, rival_brand FROM matched_sku_map WHERE workspace_id = $1 AND rival_asin = r.asin LIMIT 1) mr ON NOT r.is_own
      WHERE r.workspace_id = $1
      ORDER BY (r.stars IS NOT NULL AND r.stars <= 3) DESC, r.fetched_at DESC, r.id DESC`, [WS]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static('public'));
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`competitor_tracking listening on ${port}`));

import express from 'express';
import pg from 'pg';

const app = express();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows);

app.get('/api/summary', async (_req, res) => {
  try {
    const [s] = await q(`
      SELECT (SELECT max(snapshot_date) FROM listing_snapshots) AS as_of,
             (SELECT count(DISTINCT own_product) FROM matched_sku_map) AS products,
             (SELECT count(*) FROM matched_sku_map) AS pairs,
             (SELECT count(*) FROM listing_snapshots WHERE NOT is_own AND availability NOT ILIKE '%in stock%') AS rivals_oos,
             (SELECT round(avg(rating),2) FROM listing_snapshots WHERE is_own AND rating IS NOT NULL) AS our_avg_rating,
             (SELECT round(avg(rating),2) FROM listing_snapshots WHERE NOT is_own AND rating IS NOT NULL) AS rival_avg_rating`);
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/battlecard', async (_req, res) => {
  try {
    const rows = await q(`
      WITH own AS (SELECT asin, title, price, mrp, rating, review_count, availability FROM listing_snapshots WHERE is_own),
           riv AS (SELECT asin, title, price, rating, review_count, availability FROM listing_snapshots WHERE NOT is_own)
      SELECT m.own_product, m.own_asin,
             o.price AS our_price, o.mrp AS our_mrp, o.rating AS our_rating, o.review_count AS our_reviews,
             o.availability AS our_availability,
             round((o.price / NULLIF(percentile_cont(0.5) WITHIN GROUP (ORDER BY r.price),0))::numeric, 2) AS price_position,
             max(r.rating) AS best_rival_rating,
             count(*) FILTER (WHERE r.price < o.price) AS rivals_cheaper,
             count(*) AS rivals_total,
             count(*) FILTER (WHERE r.availability NOT ILIKE '%in stock%') AS rivals_oos,
             json_agg(json_build_object(
               'name', m.rival_name, 'asin', m.rival_asin, 'price', r.price,
               'rating', r.rating, 'reviews', r.review_count, 'availability', r.availability,
               'title', r.title
             ) ORDER BY r.price NULLS LAST) AS rivals
      FROM matched_sku_map m
      JOIN own o ON o.asin = m.own_asin
      JOIN riv r ON r.asin = m.rival_asin
      GROUP BY m.own_product, m.own_asin, o.price, o.mrp, o.rating, o.review_count, o.availability
      ORDER BY price_position DESC NULLS LAST`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reviews', async (req, res) => {
  try {
    const own = req.query.scope !== 'rivals';
    const rows = await q(`
      SELECT r.asin, r.stars, r.title, r.snippet, r.review_date,
             coalesce(m.own_product, m2.rival_name, s.title) AS product
      FROM listing_reviews r
      LEFT JOIN listing_snapshots s ON s.asin = r.asin AND s.is_own = r.is_own
      LEFT JOIN LATERAL (SELECT own_product FROM matched_sku_map WHERE own_asin = r.asin LIMIT 1) m ON $1
      LEFT JOIN LATERAL (SELECT rival_name FROM matched_sku_map WHERE rival_asin = r.asin LIMIT 1) m2 ON NOT $1
      WHERE r.is_own = $1
      ORDER BY (r.stars IS NOT NULL AND r.stars <= 3) DESC, r.fetched_at DESC, r.id DESC
      LIMIT 80`, [own]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static('public'));
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`competitor_tracking listening on ${port}`));

# Competitor Tracking — AreoVeda

Web service over the `Competitor_Tracking_Areoveda` Neon database: battlecard (price
position vs matched rivals, rating gaps, stock), our-reviews feed, rival-reviews feed.

- `server.js` — Express API (`/api/summary`, `/api/battlecard`, `/api/reviews`) + static UI
- `public/index.html` — the UI
- Env: `DATABASE_URL` (Neon connection string — set in Render, never committed)

Run locally: `DATABASE_URL=... npm start` → http://localhost:10000

Data lands via the weekly scrape loaders (matched_sku_map / listing_snapshots / listing_reviews).

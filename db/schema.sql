-- Competitor_Tracking_Areoveda — schema + tracking contract (applied to Neon; idempotent).
-- GRAINS: pricing = DAY · ranking = DAY · reviews rollup = WEEK (review texts append-only).
-- workspace_id is on every table with a placeholder default 'areoveda'; the app inserts the
-- real workspace UUID at runtime after integration (then drop the default).
-- Pricing and ranking loads MUST be upserts on the unique keys below (re-runs stay idempotent).

CREATE TABLE IF NOT EXISTS matched_sku_map (
  pair_id serial PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'areoveda',
  own_product text NOT NULL,
  own_asin text,
  rival_name text,
  rival_asin text NOT NULL,
  rival_brand text,
  marketplace text NOT NULL DEFAULT 'amazon',
  matching_confidence text NOT NULL DEFAULT 'human_confirmed',  -- 'pending_scrape' rows = UI-added, scrape trigger wires here
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (own_product, rival_asin)
);

-- PRICING — day grain. One row per listing per day; same-day re-runs overwrite.
CREATE TABLE IF NOT EXISTS listing_snapshots (
  id serial PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'areoveda',
  snapshot_date date NOT NULL,
  scraped_at timestamptz NOT NULL,
  marketplace text NOT NULL DEFAULT 'amazon',
  asin text NOT NULL,
  is_own boolean NOT NULL,
  title text,
  price numeric,
  mrp numeric,
  unit_price_text text,
  rating numeric,
  review_count integer,
  availability text,
  image_url text,
  run_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_snapshots_ws_day
  ON listing_snapshots (workspace_id, snapshot_date, marketplace, asin);
-- upsert pattern:
-- INSERT INTO listing_snapshots (workspace_id, snapshot_date, scraped_at, marketplace, asin, is_own, title, price, mrp, rating, review_count, availability, image_url, run_id)
-- VALUES (...)
-- ON CONFLICT (workspace_id, snapshot_date, marketplace, asin) DO UPDATE SET
--   price=EXCLUDED.price, mrp=EXCLUDED.mrp, rating=EXCLUDED.rating, review_count=EXCLUDED.review_count,
--   availability=EXCLUDED.availability, image_url=coalesce(EXCLUDED.image_url, listing_snapshots.image_url), scraped_at=EXCLUDED.scraped_at;

-- RANKING — day grain. rank_type 'category_bsr' (rank_context = category name)
-- or 'keyword' (rank_context = the search term). Upsert on the unique key.
CREATE TABLE IF NOT EXISTS listing_ranks (
  id serial PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'areoveda',
  rank_date date NOT NULL,
  marketplace text NOT NULL DEFAULT 'amazon',
  asin text NOT NULL,
  is_own boolean NOT NULL DEFAULT false,
  rank_type text NOT NULL,
  rank_context text NOT NULL DEFAULT '',
  rank_value integer,
  scraped_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ranks_ws_day
  ON listing_ranks (workspace_id, rank_date, marketplace, asin, rank_type, rank_context);
-- upsert pattern:
-- INSERT INTO listing_ranks (workspace_id, rank_date, marketplace, asin, is_own, rank_type, rank_context, rank_value)
-- VALUES (...)
-- ON CONFLICT (workspace_id, rank_date, marketplace, asin, rank_type, rank_context)
-- DO UPDATE SET rank_value=EXCLUDED.rank_value, scraped_at=now();

-- REVIEWS — week grain rollup (week_start = Monday). Rating/count state per week;
-- individual review TEXTS stay append-only in listing_reviews below.
CREATE TABLE IF NOT EXISTS listing_reviews_weekly (
  id serial PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'areoveda',
  week_start date NOT NULL,
  marketplace text NOT NULL DEFAULT 'amazon',
  asin text NOT NULL,
  is_own boolean NOT NULL,
  rating numeric,
  review_count integer,
  reviews_captured integer NOT NULL DEFAULT 0,
  scraped_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_ws_week
  ON listing_reviews_weekly (workspace_id, week_start, marketplace, asin);
-- upsert pattern:
-- INSERT INTO listing_reviews_weekly (workspace_id, week_start, marketplace, asin, is_own, rating, review_count, reviews_captured)
-- VALUES ($1, date_trunc('week', CURRENT_DATE)::date, $2, $3, $4, $5, $6, $7)
-- ON CONFLICT (workspace_id, week_start, marketplace, asin)
-- DO UPDATE SET rating=EXCLUDED.rating, review_count=EXCLUDED.review_count,
--   reviews_captured=EXCLUDED.reviews_captured, scraped_at=now();

-- review texts: append-only capture (dedupe by content in the pipeline if re-scraped)
CREATE TABLE IF NOT EXISTS listing_reviews (
  id serial PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'areoveda',
  marketplace text NOT NULL DEFAULT 'amazon',
  asin text NOT NULL,
  is_own boolean NOT NULL,
  stars numeric,
  title text,
  snippet text NOT NULL,
  review_date text,
  fetched_at timestamptz NOT NULL,
  run_id text
);

-- AI summaries regenerated after each weekly review capture
CREATE TABLE IF NOT EXISTS listing_review_summary (
  asin text PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'areoveda',
  is_own boolean NOT NULL,
  summary text,
  pros jsonb,
  cons jsonb,
  themes jsonb,
  based_on integer,
  generated_at timestamptz NOT NULL DEFAULT now()
);

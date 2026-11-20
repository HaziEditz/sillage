CREATE TABLE IF NOT EXISTS fragrance_reactions (
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES fragrance_products(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  vote text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fragrance_reactions_user_product_idx
  ON fragrance_reactions (product_id, clerk_user_id);

CREATE TABLE IF NOT EXISTS fragrance_reviews (
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES fragrance_products(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  author_name text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fragrance_reviews_user_product_idx
  ON fragrance_reviews (product_id, clerk_user_id);

CREATE INDEX IF NOT EXISTS fragrance_reviews_product_idx
  ON fragrance_reviews (product_id);

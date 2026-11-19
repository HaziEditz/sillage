ALTER TABLE fragrance_orders
ADD COLUMN IF NOT EXISTS discount_code text;

CREATE TABLE IF NOT EXISTS fragrance_discount_codes (
  id serial PRIMARY KEY,
  code text NOT NULL,
  label text NOT NULL DEFAULT '',
  type text NOT NULL,
  percent integer,
  amount_minor integer,
  min_subtotal_minor integer NOT NULL DEFAULT 0,
  usage_limit integer,
  used_count integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fragrance_discount_codes_code_idx
  ON fragrance_discount_codes (code);

CREATE TABLE IF NOT EXISTS fragrance_store_settings (
  id integer PRIMARY KEY,
  shipping_fee_minor integer NOT NULL DEFAULT 1500,
  free_shipping_threshold_minor integer NOT NULL DEFAULT 10000,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO fragrance_store_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE fragrance_orders
  ADD COLUMN IF NOT EXISTS fulfillment text NOT NULL DEFAULT 'to_send',
  ADD COLUMN IF NOT EXISTS tracking text,
  ADD COLUMN IF NOT EXISTS shipped_at timestamptz;

UPDATE fragrance_orders
SET fulfillment = 'collected'
WHERE payment_method = 'cash' AND fulfillment = 'to_send';

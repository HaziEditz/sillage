ALTER TABLE fragrance_orders
ADD COLUMN IF NOT EXISTS discount_minor integer NOT NULL DEFAULT 0;

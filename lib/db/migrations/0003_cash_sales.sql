ALTER TABLE fragrance_orders
ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'paypal';

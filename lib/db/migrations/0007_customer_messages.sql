CREATE TABLE IF NOT EXISTS fragrance_messages (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  topic text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fragrance_messages_kind_idx
  ON fragrance_messages (kind, created_at);

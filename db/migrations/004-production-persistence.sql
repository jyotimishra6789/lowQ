BEGIN;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  operation_key text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, operation_key)
);

COMMIT;

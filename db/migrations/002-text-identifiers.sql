BEGIN;

ALTER TABLE restaurant_tables
  DROP CONSTRAINT IF EXISTS restaurant_tables_restaurant_id_fkey;
ALTER TABLE tokens
  DROP CONSTRAINT IF EXISTS tokens_restaurant_id_fkey,
  DROP CONSTRAINT IF EXISTS tokens_table_id_fkey;
ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_restaurant_id_fkey,
  DROP CONSTRAINT IF EXISTS events_token_id_fkey;

ALTER TABLE restaurants
  ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE restaurant_tables
  ALTER COLUMN id TYPE text USING id::text,
  ALTER COLUMN restaurant_id TYPE text USING restaurant_id::text;
ALTER TABLE tokens
  ALTER COLUMN id TYPE text USING id::text,
  ALTER COLUMN restaurant_id TYPE text USING restaurant_id::text,
  ALTER COLUMN table_id TYPE text USING table_id::text;
ALTER TABLE events
  ALTER COLUMN restaurant_id TYPE text USING restaurant_id::text,
  ALTER COLUMN token_id TYPE text USING token_id::text;

ALTER TABLE restaurant_tables
  ADD CONSTRAINT restaurant_tables_restaurant_id_fkey
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id);
ALTER TABLE tokens
  ADD CONSTRAINT tokens_restaurant_id_fkey
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
  ADD CONSTRAINT tokens_table_id_fkey
  FOREIGN KEY (table_id) REFERENCES restaurant_tables(id);

COMMIT;

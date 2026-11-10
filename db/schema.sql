CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE restaurants (
  id text PRIMARY KEY,
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE restaurant_tables (
  id text PRIMARY KEY,
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  label text NOT NULL,
  capacity integer NOT NULL CHECK (capacity > 0),
  status text NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'occupied', 'cleaning')),
  occupied_since timestamptz,
  UNIQUE (restaurant_id, label)
);

CREATE TABLE tokens (
  id text PRIMARY KEY,
  restaurant_id text NOT NULL REFERENCES restaurants(id),
  phone_hash text NOT NULL,
  phone_encrypted text,
  party_size integer NOT NULL CHECK (party_size > 0 AND party_size <= 20),
  source text NOT NULL CHECK (source IN ('walk_in', 'remote')),
  status text NOT NULL CHECK (status IN ('waiting', 'on_my_way', 'checked_in', 'called', 'seated', 'no_show', 'cancelled')),
  bypass_count integer NOT NULL DEFAULT 0 CHECK (bypass_count >= 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  checked_in_at timestamptz,
  grace_deadline timestamptz,
  table_id text REFERENCES restaurant_tables(id),
  seated_at timestamptz
);

CREATE UNIQUE INDEX tokens_one_active_phone
  ON tokens (restaurant_id, phone_hash)
  WHERE status IN ('waiting', 'on_my_way', 'checked_in', 'called');

CREATE TABLE events (
  event_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY,
  restaurant_id text NOT NULL,
  token_id text,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_restaurant_order ON events (restaurant_id, event_order);
CREATE INDEX tokens_restaurant_status_joined_at ON tokens (restaurant_id, status, joined_at);

CREATE OR REPLACE FUNCTION prevent_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only';
END;
$$;

CREATE TRIGGER events_append_only
BEFORE UPDATE OR DELETE ON events
FOR EACH ROW EXECUTE FUNCTION prevent_event_mutation();

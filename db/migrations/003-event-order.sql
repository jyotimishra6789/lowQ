BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS event_order bigint GENERATED ALWAYS AS IDENTITY;

CREATE UNIQUE INDEX IF NOT EXISTS events_event_order_unique
  ON events (event_order);
DROP INDEX IF EXISTS events_restaurant_created_at;
CREATE INDEX IF NOT EXISTS events_restaurant_order
  ON events (restaurant_id, event_order);

COMMIT;

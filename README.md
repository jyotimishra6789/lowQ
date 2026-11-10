# LowQueue

LowQueue is a restaurant waiting-list and table-allocation system. Guests can join
remotely, share their party size, announce that they are travelling or have arrived,
and follow their position without standing in a crowded physical line. Restaurant
staff can free tables and progress guests through the seating lifecycle.

It is a backend-first prototype built with TypeScript, Fastify, PostgreSQL, and a
small browser dashboard. The queue rules are implemented as a pure deterministic
state machine so they can be tested independently of HTTP and database concerns.

## What problem does it solve?

Traditional restaurant queues often create four problems:

- Guests must remain near the restaurant just to preserve their place.
- Staff manually coordinate arrival, table assignment, and no-shows.
- Parties that are not yet present can accidentally consume tables.
- A missed handoff or duplicate staff action can create inconsistent queue state.

LowQueue separates **joining the queue** from **being ready for a table**. Remote
guests may wait in the queue, but only checked-in guests can receive a table.
The system also records every change as an event and maintains a database
projection for operational queries.

## How the system works

### Guest flow

1. A guest enters a phone number and party size in the dashboard or API.
2. LowQueue hashes the phone number and creates a `WAITING` token.
3. The guest can select **I'm on my way**, moving the token to `ON_MY_WAY`.
4. On arrival, the guest selects **I'm here**, moving the token to `CHECKED_IN`.
5. Staff marks a table free. The engine chooses the oldest eligible checked-in party
   whose party size fits the table.
6. The token receives the table and remains `CHECKED_IN` until the table-ready
   acknowledgement changes it to `CALLED`.
7. A grace-window timer starts. The guest either becomes `SEATED`, or the token
   becomes `NO_SHOW` and the table is released.
8. A guest can cancel at any active stage. Cancellation releases any assigned table.

The lifecycle is:

```text
WAITING -> ON_MY_WAY -> CHECKED_IN -> CALLED -> SEATED
                                      |          |
                                      +-> NO_SHOW

WAITING / ON_MY_WAY / CHECKED_IN / CALLED -> CANCELLED
```

### Queue and table rules

- Party size is validated from 1 to 20.
- One active token is allowed per phone and restaurant.
- A remote or travelling party can be bypassed for an incompatible or unavailable
  table without losing its place unfairly.
- Repeated bypasses eventually re-queue the party with a new ordering timestamp.
- An occupied table cannot be freed and assigned again by a duplicate request.
- `NO_SHOW` and `CANCELLED` always clear their table assignment.
- Grace expiry is scheduled automatically and is also checked lazily when a token
  status is requested after a restart.

## Architecture

```text
Browser dashboard / API clients
              |
           Fastify
       /       |       \
    queue    voice    static UI
     API    proxy
              |
       deterministic engine
              |
    repository abstraction
       /              \
 in-memory       PostgreSQL event store
                         |
              events + operational projections
```

- [src/queue-engine.ts](src/queue-engine.ts) contains the pure reducer, lifecycle
  rules, table allocation, effects, and idempotency handling.
- [src/api.ts](src/api.ts) exposes the restaurant and voice APIs and serializes
  in-process requests per restaurant.
- [src/event-store.ts](src/event-store.ts) appends events and updates token/table
  projections transactionally.
- [public/](public/) contains the browser dashboard.
- [db/schema.sql](db/schema.sql) defines restaurants, tables, tokens, events, and
  append-only event protection.

PostgreSQL deployments also use advisory locks per restaurant to protect
read-modify-write operations across multiple application processes. Events have a
monotonic `event_order` value so replay does not depend on random UUID ordering.

## Why it is better than a basic queue

LowQueue is not intended to replace every mature restaurant-management platform.
Its advantage is a focused, understandable queue core with explicit state
transitions:

| Concern | Traditional physical/manual queue | LowQueue |
|---|---|---|
| Guest waiting | Guest stays near the venue | Guest can wait remotely |
| Arrival certainty | Staff infer or remember arrival | Explicit `ON_MY_WAY` and `CHECKED_IN` states |
| Table assignment | Often manual or ad hoc | Capacity-aware deterministic allocation |
| No-shows | Staff handle them manually | Grace expiry releases the table automatically |
| Duplicate actions | Easy to double-book a table | Occupancy checks and serialized dispatch |
| Recovery | State may live in a clipboard or single process | Append-only events can be replayed |
| Privacy | Phone numbers may be visible | Phone numbers are not stored directly by the queue API |
| Integration | Separate systems are often needed | REST API, browser UI, PostgreSQL, and voice proxy are included |

The tradeoff is that this repository is still a prototype: it does not yet include
full staff identity management, a production notification provider, multi-region
deployment, or a full restaurant administration UI.

## Run locally

Requirements: Node.js 22+, npm, and optionally Docker Desktop for PostgreSQL.

```bash
npm install
npm test
npm run build
npm start
```

The API and dashboard are served at:

```text
http://127.0.0.1:3000/
```

The dashboard supports:

- joining the queue;
- viewing the live token position and status;
- marking a guest as on the way or checked in;
- cancelling a token;
- freeing restaurant tables from the staff console.

## PostgreSQL

Without `DATABASE_URL`, the server uses the in-memory repository. For persistence:

```powershell
docker compose up -d postgres
$env:DATABASE_URL = 'postgres://lowqueue:lowqueue_dev@127.0.0.1:5432/lowqueue'
npm start
```

The development database is configured in [docker-compose.yml](docker-compose.yml).
To stop it:

```powershell
docker compose down
```

For a fresh schema:

```powershell
docker compose down -v
docker compose up -d postgres
```

For an existing development volume, apply migrations without deleting data:

```powershell
Get-Content .\db\migrations\002-text-identifiers.sql |
  docker exec -i lokilowqueue-postgres-1 psql -U lowqueue -d lowqueue
Get-Content .\db\migrations\003-event-order.sql |
  docker exec -i lokilowqueue-postgres-1 psql -U lowqueue -d lowqueue
```

Example API request:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:3000/restaurants/demo/tokens `
  -ContentType 'application/json' `
  -Body '{"phone":"+919999911111","partySize":2,"source":"remote"}'
```

## API routes

```text
POST   /restaurants/{restaurantId}/tokens
GET    /restaurants/{restaurantId}/tokens/{tokenId}
POST   /restaurants/{restaurantId}/tokens/{tokenId}/on-my-way
POST   /restaurants/{restaurantId}/tokens/{tokenId}/check-in
POST   /restaurants/{restaurantId}/tokens/{tokenId}/ready
POST   /restaurants/{restaurantId}/tokens/{tokenId}/seated
DELETE /restaurants/{restaurantId}/tokens/{tokenId}
POST   /restaurants/{restaurantId}/tables/{tableId}/free
GET    /restaurants/{restaurantId}/summary
GET    /restaurants/{restaurantId}/analytics
GET    /restaurants/{restaurantId}/events
GET    /restaurants
POST   /restaurants/{restaurantId}/config
GET    /openapi.json
```

Mutating requests accept an `Idempotency-Key` header. Reusing the same key for the
same operation returns the original result instead of applying the event twice.
Queue changes are also published as Server-Sent Events on the restaurant events
route, which the dashboard subscribes to for live updates.

## Voice APIs

LowQueue can proxy Gnani speech services:

```text
POST /voice/speech-to-text?languageCode=en-IN
POST /voice/text-to-speech
```

Configure the key only through the environment. Never commit it to source control:

```powershell
$env:GNANI_API_KEY = 'your-gnani-api-key'
```

Speech-to-text accepts a multipart `audio_file`. Text-to-speech accepts JSON with
`text` and `voice`, plus optional model, language, speed, and audio configuration.
Voice requests are rate-limited to 20 requests per IP per minute.

## Security configuration

```powershell
$env:STAFF_API_KEY = 'staff-secret'
$env:PHONE_HASH_SECRET = 'long-random-secret'
$env:GRACE_WINDOW_MS = '300000'
```

When `STAFF_API_KEY` is configured, table-management requests must include:

```text
x-staff-api-key: staff-secret
```

The API emits structured JSON request logs through Fastify. The OpenAPI document is
available at `/openapi.json` for import into Swagger UI or other API tooling.

Use a secret manager or deployment environment for production credentials. Do not
paste active API keys into source files, README files, tests, or commits.

## Testing

```bash
npm test
npm run build
```

The tests cover queue ordering, lifecycle validation, idempotent event replay,
duplicate phone protection, table release, double-booking prevention, API behavior,
frontend serving, and Gnani request proxying.

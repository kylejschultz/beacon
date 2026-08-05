# Beacon

Anonymous install telemetry receiver and private analytics dashboard for Nestview and other self-hosted apps.

Beacon is a Cloudflare Worker backed by Cloudflare D1. Apps send a small, opt-in `POST /ping` payload once per day. Beacon records active installs, keeps a lifetime install count, snapshots daily history, and serves a password-protected dashboard.

## What Beacon Collects

Beacon is designed for simple product telemetry, not user tracking. A client app should send only anonymous install-level metadata:

- `project` - stable app slug, such as `nestview`
- `install_id` - random UUID generated once and stored by the client app
- `version` - app version or build label
- `arch` - CPU architecture, usually `amd64` or `arm64`
- `timestamp` - current UTC ISO 8601 timestamp
- `channel` - optional release channel, such as `stable`, `dev`, or `nightly`
- `container_count` - optional aggregate count for apps that manage containers
- `os` - optional operating system name
- `dev` - optional boolean used to mark development or preview installs

Do not send usernames, hostnames, IP addresses, container names, image names, email addresses, or any other personally identifiable data.

## First-Time Beacon Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

### 3. Create a D1 database

```bash
npx wrangler d1 create beacon-analytics
```

Copy the returned `database_id` into `wrangler.toml` under the `ANALYTICS_DB` binding.

### 4. Configure the route

Edit `wrangler.toml` for the domain you want Beacon to use:

```toml
routes = [
  { pattern = "beacon.example.com", custom_domain = true }
]
```

If you are testing before a custom domain is ready, you can deploy to the default Workers domain by removing or commenting out the `routes` block.

### 5. Apply the database schema

For a fresh database, apply the baseline schema:

```bash
npx wrangler d1 execute beacon-analytics --file=schema.sql
```

Then apply the migrations that are not already folded into `schema.sql`:

```bash
npx wrangler d1 execute beacon-analytics --file=migrations/0002_add_is_dev.sql
npx wrangler d1 execute beacon-analytics --file=migrations/0003_add_install_lifetime.sql
```

`migrations/0001_add_channel_container_count_os.sql` is kept for older databases created before those fields were added to the baseline schema. Do not run it against a fresh database created from the current `schema.sql`.

### 6. Set secrets

```bash
npx wrangler secret put STATS_SECRET
npx wrangler secret put API_SECRET
```

`STATS_SECRET` is the dashboard password and JWT signing key.

`API_SECRET` is a bearer token for trusted machine-to-machine requests to `/summary`.

### 7. Run locally

```bash
npm run dev
```

Wrangler starts a local Worker. The dashboard and API paths are served by the same Worker.

### 8. Deploy

```bash
npm run deploy
```

After deployment, open `/dashboard` on the Worker domain and log in with `STATS_SECRET`.

## Adding Beacon to a New App

Beacon does not require a client SDK. A new app only needs to create a stable anonymous install ID, ask the user before enabling telemetry, and send a daily JSON ping.

### 1. Pick a project slug

Use a short, stable, lowercase slug:

```text
myapp
```

Once a project slug is in use, keep it stable. Beacon groups dashboard and API results by `project`.

### 2. Generate and store an install ID

Generate a UUID the first time the app runs and persist it in the app's own settings or database.

Example:

```text
4b7e7f25-1c24-4590-9c1f-94a13da19b92
```

The install ID should be random. Do not derive it from device identifiers, hostnames, usernames, emails, IP addresses, licenses, or account IDs.

### 3. Make telemetry opt-in

Telemetry should be off by default unless the app's own policy says otherwise. A first-run wizard or settings toggle should explain what is sent and let the user enable it.

### 4. Send at most one ping per day

POST to Beacon's `/ping` endpoint:

```bash
curl -X POST https://beacon.example.com/ping \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "myapp",
    "install_id": "4b7e7f25-1c24-4590-9c1f-94a13da19b92",
    "version": "1.0.0",
    "arch": "arm64",
    "timestamp": "2026-08-05T08:00:00.000Z",
    "channel": "stable",
    "container_count": 12,
    "os": "Linux"
  }'
```

Successful response:

```json
{ "ok": true }
```

Beacon intentionally does not authenticate `/ping`, so clients can send telemetry without bundling a secret. Keep accepted fields narrow and anonymous.

### 5. Treat telemetry as best effort

Client apps should never fail startup, setup, or core workflows if Beacon is unavailable. Use a short timeout, ignore network failures, and try again on the next scheduled interval.

### Nestview Client Example

Nestview's client implementation lives in `backend/services/analytics.py` in the Nestview repo. It shows the expected pattern:

- Generate and persist `install_id`
- Check `analytics_enabled`
- Send one ping per UTC day
- Include version, architecture, OS, release channel, and aggregate container count
- Swallow telemetry failures so the app keeps running normally

## API Reference

### `POST /ping`

Public endpoint for anonymous client telemetry.

Required JSON fields:

- `project`: non-empty string
- `install_id`: non-empty string
- `version`: non-empty string
- `arch`: non-empty string
- `timestamp`: non-empty string, preferably UTC ISO 8601

Optional JSON fields:

- `channel`: string
- `container_count`: number
- `os`: string
- `dev`: boolean

Responses:

- `200` with `{ "ok": true }` when accepted
- `400` for invalid JSON, missing fields, invalid optional fields, or oversized field values

### `POST /auth`

Exchanges the dashboard password for a JWT.

```bash
curl -X POST https://beacon.example.com/auth \
  -H 'Content-Type: application/json' \
  -d '{ "password": "your-stats-secret" }'
```

Response:

```json
{ "token": "..." }
```

The dashboard stores this token in `sessionStorage`.

### `GET /summary`

Returns aggregate install counts. Requires `Authorization: Bearer <token>`.

Dashboard JWTs from `/auth` are accepted. `API_SECRET` is also accepted for machine-to-machine requests.

```bash
curl https://beacon.example.com/summary?project=myapp \
  -H "Authorization: Bearer $API_SECRET"
```

Query parameters:

- `project` - optional project filter
- `exclude_dev=true` - optional filter that excludes installs marked with `dev: true`

Response fields:

- `active_recent` - installs seen in the last 36 hours
- `active` and `active_30d` - installs seen in the last 30 days
- `retained` - installs still present in the active installs table
- `total` - lifetime installs
- `stale` - installs seen between 7 and 30 days ago
- `new_today` - installs first seen today in Pacific time

### `GET /installs`

Returns per-install rows. Requires a dashboard JWT in `Authorization: Bearer <token>`.

```bash
curl https://beacon.example.com/installs?project=myapp \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /history`

Returns daily active-install snapshots for the last 90 days. Requires a dashboard JWT in `Authorization: Bearer <token>`.

```bash
curl https://beacon.example.com/history?project=myapp \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /dashboard`

Serves the private browser dashboard.

Log in with `STATS_SECRET`.

## Database Model

Beacon stores current active installs in `installs`, lifetime first-seen records in `install_lifetime`, and daily active-install snapshots in `install_history`.

The scheduled Worker cron runs daily and:

- Counts active installs per project
- Writes that count to `install_history`
- Deletes installs that have not pinged in more than 30 days

Lifetime records remain in `install_lifetime`.

## Development

Generate Worker types:

```bash
npm run cf-typegen
```

Run the TypeScript checker:

```bash
npx tsc --noEmit
```

Run the Worker locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

## Schema Changes

For fresh databases, `schema.sql` creates the baseline tables. Apply any later migrations that have not been folded into that baseline.

For existing databases, add a new migration file under `migrations/` and apply it with:

```bash
npx wrangler d1 execute beacon-analytics --file=migrations/0004_example.sql
```

Apply migrations in order. Do not remove old migration files after production has used them.

## Security Notes

- Never commit `STATS_SECRET`, `API_SECRET`, or Cloudflare tokens.
- Do not put secrets in client apps. `/ping` is public by design.
- Use short client timeouts and best-effort delivery.
- Keep telemetry opt-in and document the exact payload in the client app.
- Avoid collecting personal data. Beacon is intended for anonymous install analytics only.

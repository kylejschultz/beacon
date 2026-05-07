# Beacon

Anonymous telemetry worker for tracking active installs across projects. Runs on Cloudflare Workers with D1 (SQLite) storage, available at `beacon.kjschultz.com`.

## Endpoints

- `POST /ping` — open, no auth. Receives telemetry from a registered project install.
- `GET /stats` — secret-protected. Returns active install counts per project.

## Setup (deploy from scratch)

### 1. Create the D1 database

```bash
wrangler d1 create beacon-analytics
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "ANALYTICS_DB"
database_name = "beacon-analytics"
database_id = "<paste-id-here>"
```

### 2. Apply the schema

```bash
wrangler d1 execute beacon-analytics --file=./schema.sql
```

### 3. Set the stats secret

```bash
wrangler secret put STATS_SECRET
```

Enter a strong random secret when prompted. This is required for `GET /stats`.

### 4. Configure the custom domain

In the Cloudflare Workers dashboard, add `beacon.kjschultz.com` as a custom domain for the `beacon` worker (DNS must be proxied through Cloudflare).

### 5. Deploy

```bash
wrangler deploy
```

## Usage

### POST /ping

```bash
curl -X POST https://beacon.kjschultz.com/ping \
  -H "Content-Type: application/json" \
  -d '{"project":"nestview","install_id":"abc123","version":"1.2.0","arch":"arm64","timestamp":"2025-05-07T00:00:00.000Z"}'
```

### GET /stats

```bash
# All projects
curl -H "Authorization: Bearer <secret>" https://beacon.kjschultz.com/stats

# Single project
curl -H "Authorization: Bearer <secret>" "https://beacon.kjschultz.com/stats?project=nestview"
```

Response:

```json
{
  "window_days": 30,
  "projects": {
    "nestview": 42
  }
}
```

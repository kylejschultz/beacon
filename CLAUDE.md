# CLAUDE.md — Beacon

Beacon is a lightweight Cloudflare Worker that receives anonymous telemetry pings from self-hosted project installs and serves a private analytics dashboard.

---

## Stack

- **Runtime:** Cloudflare Worker (TypeScript)
- **Storage:** Cloudflare D1 (SQLite), bound as `ANALYTICS_DB`
- **Entry point:** `src/index.ts` - single file, all routes handled here
- **Schema:** `schema.sql` defines the D1 tables; migrations live in `migrations/`
- **No build step** - `wrangler deploy` compiles and deploys directly

---

## Repository Layout

```
beacon/
├── src/
│   └── index.ts        # All route handlers and dashboard HTML
├── migrations/         # Sequential D1 migration SQL files
├── schema.sql          # Baseline D1 schema
├── wrangler.toml       # Worker config, D1 binding, cron triggers
├── package.json
└── tsconfig.json
```

---

## Secrets

All secrets are managed via Cloudflare and set with `wrangler secret put`. They are never hardcoded in source files or `wrangler.toml`.

Current secrets:
- `STATS_SECRET` - required for all dashboard and stats endpoints

---

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/ping` | None | Receive telemetry ping from an install |
| `POST` | `/auth` | None | Exchange password for session token |
| `GET` | `/installs` | `?key=` | Per-record install data |
| `GET` | `/history` | `?key=` | Daily snapshot history |
| `GET` | `/summary` | `?key=` | Aggregate counts |
| `GET` | `/` | Cookie/session | Dashboard HTML |

Auth for data endpoints uses a `?key=` query param carrying `STATS_SECRET`. The dashboard login POSTs the password to `/auth`, receives the token, and stores it in `sessionStorage`.

---

## Schema Changes

New columns go in a new migration file under `migrations/` named `{NNNN}_{description}.sql`. Apply to production with:

```bash
wrangler d1 execute beacon-analytics --file=migrations/{file}.sql
```

Never modify `schema.sql` directly for additive changes - that file represents the baseline only.

---

## Commit Conventions

Conventional commits, same as Nestview:

```
feat: add os field to installs response
fix: correct stale count query window
chore: update wrangler compatibility date
```

Common scopes: `worker`, `dashboard`, `schema`, `deps`

Do not use em-dashes anywhere in code, comments, or commit messages. Use regular dashes, commas, or parentheses instead.

---

## Branch and PR Flow

- All work is done on the `dev` branch, not directly on `main`
- Open a PR from `dev` to `main` when the work is ready to ship
- Never push directly to `main`
- Do not open PRs or self-merge - that is handled separately
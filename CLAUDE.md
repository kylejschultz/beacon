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
- `STATS_SECRET` - dashboard password and JWT signing key
- `API_SECRET` - bearer token accepted by `/summary` for machine-to-machine reads

---

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/ping` | None | Receive telemetry ping from an install |
| `POST` | `/auth` | None | Exchange password for session token |
| `GET` | `/projects` | Dashboard JWT | Known project slugs |
| `GET` | `/installs` | Dashboard JWT | Per-record install data |
| `GET` | `/history` | Dashboard JWT | Daily snapshot history |
| `GET` | `/summary` | Dashboard JWT or `API_SECRET` bearer token | Aggregate counts |
| `GET` | `/dashboard` | None | Dashboard HTML |

Dashboard auth uses `Authorization: Bearer <token>`. The dashboard login POSTs the password to `/auth`, receives a JWT, and stores it in `sessionStorage`. `/summary` also accepts `Authorization: Bearer <API_SECRET>` for trusted machine-to-machine reads.

The dashboard project picker loads `/projects`, stores the selected slug in `localStorage` as `beacon_project`, and then fetches selected-project `/installs`, `/history`, and `/summary` data.

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

- `dev` is the default integration branch and `release` is the protected production-release branch.
- Start work from current `dev` on a dedicated feature branch. Open a draft PR from that branch to `dev`.
- When a change is ready, Kyle manually squash-merges it into `dev`. Promote tested work with a PR from `dev` to `release`.
- Never push directly to `dev` or `release`, force-push either branch, delete either branch, approve your own PR, or merge a PR.
- Every PR must pass the required CI checks. Deployment remains a separate, explicitly approved step.

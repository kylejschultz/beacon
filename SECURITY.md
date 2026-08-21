# Security policy

## Reporting a vulnerability

Please do not disclose security vulnerabilities in public issues. Email the maintainer directly with the affected version, a reproduction, and the expected impact.

## Current dependency-security debt

As of 2026-08-21, `npm audit --audit-level=high` reports five high-severity findings in transitive dependencies of the development-only Wrangler and Miniflare toolchain: `esbuild`, `sharp`, `undici`, and `ws`. Beacon does not ship these packages in its Cloudflare Worker bundle.

The CI workflow records this result on `dev` without blocking integration. The dedicated `Release security` workflow blocks `dev` to `release` promotion until the dependency tree is updated or Kyle explicitly accepts a time-bounded exception.

# Security policy

## Reporting a vulnerability

Please do not disclose security vulnerabilities in public issues. Email the maintainer directly with the affected version, a reproduction, and the expected impact.

## Dependency security

Beacon's CI records `npm audit --audit-level=high` on `dev`. The dedicated `Release security` workflow blocks `dev` to `release` promotion when high- or critical-severity dependency findings are present.

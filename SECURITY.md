# Security requirements

- Passwords: bcrypt/Argon2; never plaintext.
- Sessions: short-lived access tokens + secure refresh strategy.
- Payments: server-side only.
- Secrets: environment/secret manager.
- Web: HTTPS, Helmet, rate limiting, input validation.
- Database: parameterized queries and least-privilege credentials.
- Admin: separate role and MFA recommended.
- Money ledger: immutable transaction events + reconciliation.
- Webhooks: verify source, idempotency and replay protection.
- Uploads: type/size scanning and private object storage.
- Privacy: collect only necessary data; provide deletion/export mechanisms.
- Monitoring: audit logs for money/admin events.

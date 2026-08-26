# PostgreSQL + Daraja deployment

Use PostgreSQL for production; keep SQLite for local development. Set DATABASE_URL only in the server secret store.

Daraja secrets must remain server-side: MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY, MPESA_CALLBACK_URL. Never put them in the Android app or Git.

Set MPESA_ENV=sandbox for testing. Use a public HTTPS callback URL. Before real money, implement callback idempotency, transaction reconciliation, status checks, audit logs, refunds and dispute handling.

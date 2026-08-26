# Deployment

## Backend
Recommended production stack:
- Linux container
- Node.js LTS
- PostgreSQL
- HTTPS reverse proxy
- secret manager/environment variables
- automated backups
- monitoring/logging
- rate limiting/WAF

Do not expose SQLite as the production database for a growing marketplace.

## Android
- Install Android Studio and SDK 36.
- Open `android/`.
- Configure the production API base URL.
- Add release signing.
- Build an Android App Bundle (`.aab`).
- Test on multiple physical Android devices.

## M-Pesa
Use Safaricom Daraja 3.0. Credentials stay on the backend. Implement server-side authorization, STK initiation, callback validation, idempotency and reconciliation. Do not mark a payment successful based only on the mobile client.

## Advertising
For user acquisition, create legitimate campaigns with Google Ads/Meta/TikTok. For in-app ads, configure AdMob after the app meets the provider's requirements.

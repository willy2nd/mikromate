# MikroMate — Complete Production Build Pack

This package consolidates the production architecture into one implementation pack.

## Product
MikroMate is a Kenyan micro-task marketplace. Customers post small paid tasks; providers complete them. Initial platform fee is 10%.

## Versions
- V1 Core: Android marketplace + API + development ledger
- V2 Identity: authentication, roles, profiles, verification boundaries
- V3 Money: payment/escrow ledger and M-Pesa Daraja integration boundary
- V4 Trust & Operations: disputes, reviews, notifications, admin console
- V5 Growth & Launch: referrals, featured jobs, advertising hooks, analytics, policies, Play release checklist

## Important limitation
This repository is production-oriented source code and configuration, but it is not a substitute for:
- your own hosting/account credentials
- Safaricom Daraja onboarding and production credentials
- Google Play developer account and verification
- payment-provider business/KYC approval
- legal/privacy/tax review
- independent security testing

Never put M-Pesa secrets in the Android application.

## Run API locally
cd backend
npm install
npm start

The API uses SQLite by default for development. Production should use PostgreSQL and HTTPS.

## Android
Open android/ in Android Studio with Android SDK 36 installed. Build a signed AAB for Play Console.

Google Play currently requires new apps and updates submitted from 31 Aug 2026 to target Android 16/API 36 or higher.

## Deployment
See docs/DEPLOYMENT.md and docs/PLAY_STORE.md.

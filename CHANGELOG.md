# Changelog

All notable changes to `cfx` will be recorded here.

## [Unreleased]

- Added My OKX for trading USDT perpetuals with a user's own demo or live API key.
- Enabled the Admin and Asgard overview pages on their subdomains and at `/admin` and `/asgard` on the main app.
- Added Account menu links to Admin and Asgard for users with the corresponding Firebase claims.
- Added Accounts and Users pages to the Asgard sidebar.
- Added a paginated Firebase user directory to Asgard with server-side access checks.
- Updated Firebase Admin service-account initialization to use Google's JWT constructor.
- Switched the Asgard user directory to the shared data table.
- Added per-user Open Up and Open Down position counts to Asgard.
- Added a dotted average closing price line to the asset chart.
- Smoothed incoming price updates on the Live asset chart.

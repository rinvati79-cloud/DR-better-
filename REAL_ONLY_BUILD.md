# DR Better — REAL ONLY BUILD

This package uses the PostgreSQL backend and JWT authentication.
There is no demo/fallback login and no client-side wallet balance credit.

Real systems included:
- PostgreSQL users + wallets + wallet transactions
- bcrypt password hashing
- JWT login/session
- Contest data from PostgreSQL
- Slot locking / duplicate-slot protection
- Entry-fee deduction in a DB transaction
- Joining records in PostgreSQL
- Admin contest APIs

Important:
- New users start with wallet balance ₹0.
- Real deposits/withdrawals still require a payment provider (for example Razorpay/Cashfree) and verified server-side webhooks. No fake payment flow is included.
- Keep DATABASE_URL and JWT_SECRET only in hosting environment variables.

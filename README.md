# DR Better — REAL ONLY

No demo/local-account fallback.

The frontend is served by the Express backend and uses PostgreSQL for:
- Register/Login
- bcrypt password hashes
- JWT authentication
- User profile
- Wallet balance
- Wallet transactions
- Contest data and joins

See `DEPLOYMENT_HI.md` for the required real-server setup.

**A ZIP opened only in a mobile editor is not an online backend.** The Docker/Node server and PostgreSQL database must be running or deployed before Register/Login can work.


## Database initialization
On server startup, `backend/schema.sql` is applied with idempotent `CREATE TABLE IF NOT EXISTS` statements. This is intended to avoid requiring a Render Shell for initial schema creation.

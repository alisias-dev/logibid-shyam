<div align="center">
  <h1>🚛 FleexBid</h1>
  <p><strong>Freight Reverse-Auction Marketplace</strong></p>
  <p>Enterprise logistics procurement — real-time descending reverse auctions with confidential ranking, AI rate intelligence, and multi-channel notifications.</p>
</div>

---

## Live Deployment

**https://www.fleexbid.live**

- Hosting: Vercel (serverless) — free tier
- Database: Neon Postgres — free tier (pooled connection)
- AI: Google Gemini (rate prediction, transporter matching, negotiation drafts)

## Stack

| Layer | Technology |
| :--- | :--- |
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS v4 + Motion |
| Backend | Node.js + Express + Socket.io (esbuild-bundled) |
| Database | PostgreSQL via `pg.Pool` (Neon), snapshot cache + advisory-lock writes |
| Auth | JWT access/refresh tokens, bcrypt, httpOnly cookies, session table with rotation |
| AI | `@google/genai` (Gemini) |

## Run Locally

**Prerequisites:** Node.js 18+, a PostgreSQL database (Neon free tier works).

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create `.env.local` (or export in your shell):
   ```env
   DATABASE_URL="postgresql://user:password@host/db?sslmode=require"
   JWT_SECRET="<32+ character random secret>"
   GEMINI_API_KEY="your-gemini-api-key"        # optional for AI features
   APP_URL="http://localhost:3000"             # optional
   ```
3. Start the dev server (Vite + Express):
   ```bash
   npm run dev
   ```
   The server listens on **http://localhost:3000**.

On first boot the database schema is created automatically and, only when the `users` table is empty, a master admin is seeded from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (or a random password printed once to the logs). Passwords are **never** reset on subsequent boots.

## Production Build & Deploy

```bash
npm run build     # vite build + esbuild -> dist/app.cjs
npm start         # node dist/app.cjs
```

Vercel (`vercel --prod`) builds automatically via `vercel.json` (`buildCommand: npm run build`), serves the SPA, and routes `/api/*` to the Express serverless function.

**Required production env vars:** `DATABASE_URL`, `JWT_SECRET` (32+ chars), `APP_URL`, `ALLOWED_ORIGINS` (comma-separated, e.g. `https://www.fleexbid.live`). Optional: `GEMINI_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SMTP_HOST/PORT/USER/PASS`, `SEED_ADMIN_EMAIL/PASSWORD/NAME`.

## Roles

| Role | Permissions |
| :--- | :--- |
| `SUPER_ADMIN` | Full access: staff & transporter management, audit logs, notification settings, permanent deletes |
| `LOGISTICS` | Create/publish/extend/cancel/award requirements, onboard & manage transporters |
| `TRANSPORTER` | View invited/public loads, submit & reduce bids (confidential ranking only — never competitor data) |
| Spectator (`APPROVED` status) | Read-only; all state-changing requests return `403` |

## Security Notes

- CORS is restricted to `ALLOWED_ORIGINS`; cookies are `httpOnly` + `SameSite=Lax`.
- Bid reduction rule is enforced inside a serialized, database-arbitrated write (advisory locks), so concurrent bids cannot race.
- Auctions auto-close on expiry — on serverless this runs lazily on request, guarded against double-awarding.
- Security headers (CSP, HSTS, nosniff, frame denial) are applied at the Vercel edge and by Express.

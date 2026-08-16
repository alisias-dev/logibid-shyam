# Automated Backup — Setup Guide

The workflow `.github/workflows/backup.yml` runs **every day at 00:00 UTC (05:30 IST)**
and on manual trigger. It produces a full snapshot of every table (JSON + manifest
with SHA-256 checksums), verifies it, archives it, and alerts you on failure.

## 1. Required repository secret: `DATABASE_URL`

1. Open the repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**
2. Name: `DATABASE_URL`
3. Value: the **production pooled** connection string (the same one Vercel uses).
   Get it from the Neon console (Connect → **Connection pooling** toggle → copy)
   or from Vercel:
   ```bash
   cd "C:\Users\Alisha\Downloads\logibid (6)"
   npx vercel env pull --environment=production .env.prod.pulled
   # then copy the DATABASE_URL value from .env.prod.pulled
   ```
   It should look like:
   `postgresql://neondb_owner:...@ep-mute-flower-au40oxdj-pooler.c-10.us-east-1.aws.neon.tech/neondb?sslmode=require`
   (the `-pooler` hostname matters — it is the PgBouncer pooled endpoint).
4. Save. **Never paste the value into the workflow file or this repo.**

## 2. Optional secrets

| Secret | Purpose |
|---|---|
| `ALERT_WEBHOOK_URL` | Failure notifications. Works with any JSON webhook: [ntfy.sh](https://ntfy.sh) (free, no account: `https://ntfy.sh/<your-topic>`), Slack incoming webhook, or Discord webhook. The workflow POSTs `{"text": "..."}`. |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | Mirror snapshots to S3 / Cloudflare R2 for permanent retention (artifacts expire after 90 days). |
| `AWS_REGION` | e.g. `ap-south-1` (default `us-east-1`). |
| `AWS_S3_BUCKET` | Bucket name, e.g. `fleexbid-backups`. |
| `AWS_ENDPOINT_URL` | Required for **Cloudflare R2** (`https://<accountid>.r2.cloudflarestorage.com`); leave unset for plain AWS S3. |

With R2: create a bucket, an API token with `Object Read & Write`, and set
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` to its access key / secret key.

> Because the GitHub artifact is deleted after 7 days, the S3/R2 mirror (or the
> Neon snapshot in `docs/BACKUP.md`) is what covers anything older than a week.

## 3. Push & activate

```bash
cd "C:\Users\Alisha\Downloads\logibid (6)"
git add .github/workflows/backup.yml .github/backup-setup.md docs/BACKUP.md
git commit -m "Add automated daily database backup workflow"
git push origin main
```

## 4. Trigger a test run (one click)

1. GitHub → **Actions** tab → **Database Backup** workflow
2. Button **Run workflow** (top right) → **Run workflow** — the "schedule" input is
   ignored, the workflow runs immediately
3. Watch it: `backup` job → steps turn green

## 5. Verify the archive

1. In the run's summary, the **Archive snapshot** step produces a downloadable
   artifact: `fleexbid-backup-<run#>`
2. Download it, open `manifest.json`, and confirm the table list + row counts match
   what the app shows (Dashboard → admin counts, or `GET /api/v1/admin/db-audit`)

## 6. What "success" looks like

- All steps green, `Verify snapshot integrity` prints
  `Integrity OK - all 15 tables verified (checksums + row counts)`
- An artifact `fleexbid-backup-N` exists with **7-day retention** and
  maximum compression (level 9) - GitHub auto-deletes old snapshots so the
  free-tier 500 MB artifact storage is never approached
- Only `pg` + `dotenv` are installed (`npm ci --prefix scripts`), keeping the
  run under ~5 min so the 2,000 free compute minutes/month are never at risk
  (the daily cron uses ~30 runs/month)
- On any failure: the `Alert on failure` step logs `::error::` and (if configured)
  POSTs to your webhook; GitHub also emails admins for failed scheduled runs

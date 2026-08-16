# FleexBid — Database Backup & Recovery Strategy

**Short version:** the production database lives on Neon and currently gets **6 hours
of point-in-time recovery (capped at 1 GB of change history) on the Free plan**. That
is *not* enough to guarantee "business data is never permanently lost", so we keep our
own full logical snapshots with `scripts/backup.mjs`. Combined, these give two
independent recovery paths.

---

## 1. What Neon already gives us (built-in)

Neon stores PITR history in its storage layer (no WAL archive to manage):

| Plan        | Default PITR window | Max       | Change-history price |
|-------------|---------------------|-----------|----------------------|
| Free (ours) | **6 hours, 1 GB cap** | 6 hours   | included             |
| Launch      | 1 day               | 7 days    | $0.20 / GB-month     |
| Scale       | 1 day               | 30 days   | $0.20 / GB-month     |

Recovery inside that window (Neon console or CLI):

```bash
# Rewind the root branch to a timestamp, preserving today's state under a new branch
neon branches restore main ^self@2026-08-16T14:30:00Z --preserve-under-name main-pre-restore
```

**Recommendation (cheap upgrade):** move the project to the **Launch plan (~$19/mo)**
for a **7-day PITR window** — roughly the cost of one lunch per month and the cheapest
way to make the *default* recovery window meaningful. Snapshots on top of that are
only $0.09/GB-month.

## 2. Our own snapshots (defense in depth, free)

`scripts/backup.mjs` connects with `DATABASE_URL` (from the environment, falling back
to `.env.local`), exports **every public table to one JSON file** plus a
`manifest.json` (row counts + SHA-256 checksums), and **prunes old snapshots**
(default: keep 7).

```bash
# One snapshot
node scripts/backup.mjs

# Keep 30 snapshots
node scripts/backup.mjs --keep 30

# Store outside the repo
BACKUP_DIR=D:/fleexbid-backups node scripts/backup.mjs
```

Output layout:

```
backups/
  2026-08-16T19-30-00-000Z/
    manifest.json
    users.json
    transporters.json
    requirements.json
    bids.json
    bid_history.json
    awards.json
    audit_logs.json
    sessions.json
    ... (all public tables)
```

**Where to store backups:** NOT in the repo and NOT on the same machine as the app
server. Ideal: a separate local disk, a private S3/R2 bucket, or Google Drive / OneDrive
folder — anywhere that survives "the laptop dies" and "the DB gets wiped".

### Scheduling

- **Windows (dev machine):** Task Scheduler → daily task →
  `node C:\Users\Alisha\Downloads\logibid (6)\scripts\backup.mjs`
- **GitHub Actions:** a cron workflow (e.g. daily 03:00 UTC) that runs
  `node scripts/backup.mjs` with `DATABASE_URL` from a repo secret and uploads
  `backups/` to an S3/R2 bucket.
- **Neon-native alternative:** keep the free PITR window for fast recovery and add a
  **Neon snapshot** (console or `neon branches create --name backup-<date>`), billed
  at $0.09/GB-month.

## 3. Restore

```bash
node scripts/restore.mjs backups/2026-08-16T19-30-00-000Z --yes
```

The restore script **truncates** each table before inserting (full-snapshot restore,
not a merge), verifies every manifest table has its file before touching anything, and
wraps each table in a transaction. It refuses to run without `--yes`.

**Before restoring:** back up the current state first
(`node scripts/backup.mjs`) so you can undo the restore.

## 4. Verification

After a backup, spot-check that the snapshot is restorable:

```bash
# Row counts must match what the app shows
node scripts/backup.mjs | grep -E "bids|requirements|users|transporters"
```

And at least once, do a real restore into a **throwaway database** (create one in the
Neon console, set `DATABASE_URL` to it, restore, confirm counts) — a backup that has
never been restored is a backup that might not work.

## 5. Failure modes covered

| Scenario | Recovery path |
|---|---|
| Accidental row/table deletion within 6 h | Neon PITR restore to timestamp |
| Deletion older than 6 h | `backup.mjs` snapshot restore |
| Bad migration / corrupted schema | Snapshot restore to pre-migration state |
| Neon account/project lost entirely | Offsite snapshot restore into a fresh project |
| Hard-deleted data (shouldn't happen — app is soft-delete only) | Snapshot restore |

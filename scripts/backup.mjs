/**
 * Automated PostgreSQL backup for FleexBid.
 *
 * Why this exists: the production database runs on Neon's FREE plan, whose
 * point-in-time recovery window is only 6 hours (capped at 1 GB of change
 * history). That means a destructive query or a bad migration is recoverable
 * for just a few hours unless we keep our own snapshots. This script writes
 * full logical snapshots (one JSON file per table) to ./backups and prunes
 * old ones, giving us an independent, off-database recovery path.
 *
 * Usage:
 *   node scripts/backup.mjs                     # DATABASE_URL from env or .env.local
 *   node scripts/backup.mjs --keep 30           # retain 30 snapshots instead of 7
 *   BACKUP_DIR=/secure/path node scripts/backup.mjs
 *
 * Scheduling:
 *   - Windows Task Scheduler: daily `node C:\...\scripts\backup.mjs`
 *   - GitHub Actions: cron workflow calling the same command
 *   - Vercel Cron: a /api/cron/backup route could invoke the same logic
 *   - Neon itself: see docs/BACKUP.md for the built-in PITR + snapshot story
 *
 * Restore: node scripts/restore.mjs <backup-dir> --yes
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

// Load .env.local if present (does not override already-set env vars).
dotenv.config({ path: '.env.local' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const BACKUP_ROOT = process.env.BACKUP_DIR || path.join(projectRoot, 'backups');

const args = process.argv.slice(2);
const keepIdx = args.indexOf('--keep');
const KEEP = keepIdx !== -1 ? parseInt(args[keepIdx + 1], 10) : 7;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[backup] FATAL: DATABASE_URL is not set (set it in the environment or .env.local).');
  process.exit(1);
}

const needsSsl = connectionString.includes('neon.tech') || connectionString.includes('sslmode=require');
const pool = new pg.Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000
});

/** Tables are exported in dependency-safe order (no FK constraints, so any
 * order works; alphabetical keeps restores deterministic). */
async function listTables(client) {
  const res = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  return res.rows.map(r => r.table_name);
}

async function main() {
  const client = await pool.connect();
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destDir = path.join(BACKUP_ROOT, stamp);
    fs.mkdirSync(destDir, { recursive: true });

    const tables = await listTables(client);
    const manifest = { createdAt: new Date().toISOString(), tables: {} };

    for (const table of tables) {
      // Raw client query keeps original snake_case column names (no key
      // normalization), so the JSON round-trips directly into INSERTs.
      const res = await client.query(`SELECT * FROM "${table}" ORDER BY 1`);
      const rows = res.rows;
      const file = path.join(destDir, `${table}.json`);
      fs.writeFileSync(file, JSON.stringify(rows));
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      manifest.tables[table] = { rows: rows.length, sha256: hash };
      console.log(`[backup] ${table.padEnd(28)} ${String(rows.length).padStart(6)} rows`);
    }

    fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`[backup] OK -> ${destDir}`);

    // Prune old snapshots, keeping the newest KEEP.
    const dirs = fs
      .readdirSync(BACKUP_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(BACKUP_ROOT, d.name, 'manifest.json')))
      .map(d => d.name)
      .sort();
    const toRemove = dirs.slice(0, Math.max(0, dirs.length - KEEP));
    for (const d of toRemove) {
      fs.rmSync(path.join(BACKUP_ROOT, d), { recursive: true, force: true });
      console.log(`[backup] pruned old snapshot ${d}`);
    }
    console.log(`[backup] retention: keeping ${Math.min(dirs.length, KEEP)} snapshot(s)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[backup] FAILED:', err);
  process.exit(1);
});

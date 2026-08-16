/**
 * Restore a FleexBid backup directory (produced by scripts/backup.mjs) into
 * the database pointed at by DATABASE_URL.
 *
 * DANGER: this TRUNCATES (empties) every table it restores before inserting
 * the backup rows. It is a full-snapshot restore, not a merge. Point it at
 * the right database and make a fresh backup first if you are unsure.
 *
 * Usage:
 *   node scripts/restore.mjs <backup-dir> --yes
 *
 * The <backup-dir> must contain manifest.json (created by backup.mjs) or the
 * script refuses to run. Restores are single-transaction per table; any
 * failure rolls that table back and the script exits non-zero so the operator
 * can stop and investigate before touching anything else.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('[restore] Usage: node scripts/restore.mjs <backup-dir> --yes');
  process.exit(1);
}
const backupDir = path.resolve(projectRoot, args[0]);
if (!args.includes('--yes')) {
  console.error(
    '[restore] Refusing to run without --yes. This TRUNCATES the target tables ' +
    'before restoring. Review DATABASE_URL and the backup dir first.'
  );
  process.exit(1);
}

const manifestPath = path.join(backupDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`[restore] Refusing: ${manifestPath} not found (not a backup.mjs output dir).`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const tables = Object.keys(manifest.tables).sort();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[restore] FATAL: DATABASE_URL is not set.');
  process.exit(1);
}

const needsSsl = connectionString.includes('neon.tech') || connectionString.includes('sslmode=require');
const pool = new pg.Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000
});

async function main() {
  const client = await pool.connect();
  try {
    console.log(`[restore] Restoring ${tables.length} tables from ${backupDir}`);
    for (const table of tables) {
      const file = path.join(backupDir, `${table}.json`);
      if (!fs.existsSync(file)) {
        console.error(`[restore] ABORT: ${file} missing for manifest entry "${table}". Nothing was restored.`);
        process.exit(1);
      }
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));

      await client.query('BEGIN');
      try {
        await client.query(`TRUNCATE TABLE "${table}"`);
        if (rows.length > 0) {
          const cols = Object.keys(rows[0]);
          const colSql = cols.map(c => `"${c}"`).join(', ');
          const BATCH = 500;
          for (let i = 0; i < rows.length; i += BATCH) {
            const batch = rows.slice(i, i + BATCH);
            const values = [];
            const placeholders = batch.map((_, r) =>
              `(${cols.map((_, c) => `$${r * cols.length + c + 1}`).join(', ')})`
            ).join(', ');
            for (const row of batch) {
              for (const c of cols) values.push(row[c] === undefined ? null : row[c]);
            }
            await client.query(`INSERT INTO "${table}" (${colSql}) VALUES ${placeholders}`, values);
          }
        }
        await client.query('COMMIT');
        console.log(`[restore] ${table.padEnd(28)} ${String(rows.length).padStart(6)} rows`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log(`[restore] OK - ${tables.length} tables restored from ${backupDir}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[restore] FAILED:', err);
  process.exit(1);
});

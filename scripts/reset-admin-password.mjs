/**
 * Reset a FleexBid user's login password directly in the database.
 *
 * WHY THIS EXISTS
 * ---------------
 * scripts/rotate-admin-password.mjs can only rotate a password when you already
 * know the working (old) one - it logs in first to authorise the change. If the
 * current password was ever replaced with an unrecorded random value (which is
 * what happened to the master admin), that script cannot help: you are locked
 * out with no way back in, and the app has no "forgot password" flow.
 *
 * This script writes a NEW bcrypt hash straight to the users table, so it works
 * even when nobody knows the current password. Use it for account recovery.
 *
 * Usage:
 *   node scripts/reset-admin-password.mjs --yes                 # use SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD from .env.local
 *   node scripts/reset-admin-password.mjs --yes --email user@example.com --password 'NewPass!123'
 *   node scripts/reset-admin-password.mjs --yes --verify-url https://www.fleexbid.live
 *
 * Flags:
 *   --yes            required; confirms you intend to change a live credential
 *   --email <addr>   account to reset (default: SEED_ADMIN_EMAIL)
 *   --password <pw>  new password (default: SEED_ADMIN_PASSWORD); min 8 chars
 *   --verify-url <u> after the write, prove the new password logs in against
 *                    this base URL (e.g. https://www.fleexbid.live)
 *
 * The hash is written with bcrypt cost 10 - identical to the rest of the app
 * (server/db.ts seeding and the /api/staff + /api/transporters update paths),
 * so a reset account is indistinguishable from a normally-set one.
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

if (!hasFlag('yes')) {
  console.error(
    '[reset-admin-password] Refusing to run without --yes.\n' +
      '  This CHANGES a live login credential. Confirm DATABASE_URL with:\n' +
      '  node scripts/reset-admin-password.mjs --show-target'
  );
  process.exit(1);
}

const email = (flag('email') || process.env.SEED_ADMIN_EMAIL || '').trim();
const password = flag('password') || process.env.SEED_ADMIN_PASSWORD;
const verifyUrl = flag('verify-url');

if (!email) {
  console.error('[reset-admin-password] No email. Pass --email or set SEED_ADMIN_EMAIL in .env.local.');
  process.exit(1);
}
if (!password) {
  console.error('[reset-admin-password] No password. Pass --password or set SEED_ADMIN_PASSWORD in .env.local.');
  process.exit(1);
}
if (password.length < 8) {
  console.error('[reset-admin-password] Password must be at least 8 characters (app rule in /api/staff).');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[reset-admin-password] FATAL: DATABASE_URL is not set (checked .env.local).');
  process.exit(1);
}

const masked = connectionString.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@');
console.log(`[reset-admin-password] target DB: ${masked}`);
console.log(`[reset-admin-password] account:   ${email}`);

if (hasFlag('show-target')) {
  process.exit(0);
}

const needsSsl = connectionString.includes('neon.tech') || connectionString.includes('sslmode=require');
const pool = new pg.Pool({ connectionString, ssl: needsSsl ? { rejectUnauthorized: false } : false });

try {
  const before = await pool.query(
    'SELECT id, email, role, status, is_deleted, password_hash FROM users WHERE lower(email) = lower($1)',
    [email]
  );
  if (before.rows.length === 0) {
    console.error(`[reset-admin-password] FAIL: no row in users for ${email}. Nothing written.`);
    process.exit(1);
  }
  const row = before.rows[0];
  if (row.is_deleted) {
    console.error(`[reset-admin-password] FAIL: ${email} is soft-deleted (is_deleted = true); login would 401 regardless.`);
    process.exit(1);
  }

  // Is the password we were given already the stored one? (No-op guard so an
  // operator does not "reset" a healthy account and think they fixed something.)
  const alreadyWorks = await bcrypt.compare(password, row.password_hash);
  if (alreadyWorks) {
    console.log('[reset-admin-password] NOTE: that password ALREADY matches the stored hash - no change needed.');
  } else {
    const hash = await bcrypt.hash(password, 10);
    if (!/^\$2[aby]\$10\$/.test(hash) || hash.length !== 60) {
      console.error('[reset-admin-password] FAIL: generated hash looks malformed; aborting.');
      process.exit(1);
    }
    if (!(await bcrypt.compare(password, hash))) {
      console.error('[reset-admin-password] FAIL: self-verification of the new hash failed; aborting.');
      process.exit(1);
    }

    // Single-statement write: the app reads users straight from Postgres on
    // every login (no credential cache), so this takes effect immediately.
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, row.id]);

    const after = await pool.query('SELECT password_hash FROM users WHERE id = $1', [row.id]);
    if (!(await bcrypt.compare(password, after.rows[0].password_hash))) {
      console.error('[reset-admin-password] FAIL: read-back verification failed.');
      process.exit(1);
    }
    console.log(`[reset-admin-password] OK: password updated for ${row.email} (role ${row.role}, status ${row.status}).`);
  }

  // Prove the credential actually authenticates, through the real endpoint.
  const base = verifyUrl || (hasFlag('verify-url-local') ? 'http://localhost:3000' : undefined);
  if (base) {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/auth/login-staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: row.email, password, deviceId: 'reset-admin-password-verify' }),
    });
    const body = await res.text();
    console.log(`[reset-admin-password] live login probe -> ${res.status} ${body.slice(0, 160)}`);
    if (res.status !== 200) {
      console.error('[reset-admin-password] FAIL: credential still does not authenticate against ' + base);
      process.exit(1);
    }
    console.log('[reset-admin-password] PASS: login verified end-to-end.');
  }
} finally {
  await pool.end();
}

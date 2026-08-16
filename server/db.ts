import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { queryPool, queryClient, withTransaction } from './db_pool';
import { 
  User, 
  Transporter, 
  Requirement, 
  RequirementInvitation, 
  Bid, 
  BidHistory, 
  Award, 
  NotificationProviderConfig, 
  AuditLog, 
  Session,
  EmailOtpVerification
} from '../src/types';

interface DatabaseSchema {
  users: User[];
  transporters: Transporter[];
  requirements: Requirement[];
  requirementInvitations: RequirementInvitation[];
  bids: Bid[];
  bidHistory: BidHistory[];
  awards: Award[];
  notificationProviderConfigs: NotificationProviderConfig[];
  auditLogs: AuditLog[];
  sessions: Session[];
  emailOtpVerifications: EmailOtpVerification[];
  smsLogs: any[];
  emailLogs: any[];
  whatsAppLogs: any[];
}

/**
 * Generate secure UUID
 */
export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export const dbWriteListeners: (() => void)[] = [];

export function onDBWrite(listener: () => void) {
  dbWriteListeners.push(listener);
}

export function triggerDBWrite() {
  for (const listener of dbWriteListeners) {
    try {
      listener();
    } catch (err) {
      console.error('Error in db write listener:', err);
    }
  }
}

/**
 * Helper to convert camelCase string to snake_case
 */
function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// Write serialization (Phase 2: per-entity locks, no global bottleneck)
// ---------------------------------------------------------------------------
// Writes are serialized per LOCK KEY:
//   - In-process: a promise queue per key, so concurrent writeDB() calls inside
//     one lambda instance never interleave their read-modify-write cycles.
//   - Cross-instance: pg_advisory_xact_lock(hashtextextended(key, 0)) inside the
//     write transaction (pooling-safe - auto-released at COMMIT/ROLLBACK).
//
// The key names the AFFECTED ENTITY: auction writes lock "auction:<id>" so
// bids/awards/extends/auto-close on DIFFERENT auctions run in PARALLEL - only
// writes to the SAME auction serialize against each other. This replaces the
// old single GLOBAL advisory lock that queued every write behind every other
// write system-wide.
//
// The default key is 'global' - it preserves the old serialization for any call
// site not yet annotated, so nothing becomes racy if a lock is forgotten.
// ---------------------------------------------------------------------------
const writeQueues = new Map<string, Promise<void>>();

function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  writeQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

/**
 * Acquire the in-process queues for all keys in deterministic (sorted) order
 * so multi-key writers cannot deadlock each other.
 */
async function withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = Array.from(new Set(keys)).sort();
  if (sorted.length === 0) return fn();
  let run: () => Promise<T> = fn;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const key = sorted[i];
    const inner = run;
    run = () => withKeyLock(key, inner);
  }
  return run();
}

// ---------------------------------------------------------------------------
// Targeted read layer
// ---------------------------------------------------------------------------
// Phase 2: API routes no longer load ALL 14 tables per request. getDB() remains
// ONLY for writeDB()'s in-transaction snapshot (scoped to the tables each write
// actually touches). Route handlers use the targeted helpers below, which run
// small indexed SQL queries (single rows / filtered sets / LIMIT-paginated).
// ---------------------------------------------------------------------------

export type DBTableKey = keyof DatabaseSchema;

const ALL_TABLE_KEYS: DBTableKey[] = [
  'users',
  'transporters',
  'requirements',
  'requirementInvitations',
  'bids',
  'bidHistory',
  'awards',
  'notificationProviderConfigs',
  'auditLogs',
  'sessions',
  'emailOtpVerifications',
  'smsLogs',
  'emailLogs',
  'whatsAppLogs'
];

/**
 * Row shapers: keep the camelCase in-memory shape identical to the old
 * full-snapshot getDB() so updaters and API responses are unchanged.
 */
export function shapeTransporter(t: any): Transporter {
  return {
    ...t,
    vehicleTypes: t.vehicleTypes || [],
    operatingStates: t.operatingStates || [],
    preferredRoutes: t.preferredRoutes || []
  };
}

export function shapeRequirement(r: any): Requirement {
  return {
    ...r,
    weight: r.weight ? Number(r.weight) : 0,
    targetRate: r.targetRate ? Number(r.targetRate) : null,
    documents: r.documents || [],
    vehicleSpecs: r.vehicleSpecs || '',
    targeted_transporter_ids: r.targetedTransporterIds || [],
    targetedTransporterIds: r.targetedTransporterIds || []
  };
}

export function shapeBid(b: any): Bid {
  return { ...b, amount: Number(b.amount) };
}

export function shapeBidHistory(bh: any): BidHistory {
  return { ...bh, amount: Number(bh.amount) };
}

export function shapeAward(a: any): Award {
  return { ...a, amount: Number(a.amount) };
}

/**
 * getDB: in-transaction snapshot used by writeDB(). Loads only the requested
 * tables (all by default) through one connection so reads obey the
 * transaction's isolation level. No caching - every read hits the database.
 *
 * `requirementScope`: when set, the requirement-centric tables (requirements,
 * bids, bid_history, requirement_invitations, awards) load ONLY rows belonging
 * to those requirement ids. This keeps per-auction writes reading a tiny row
 * set instead of whole tables. All other tables load in full.
 */
export async function getDB(
  opts: {
    fresh?: boolean;
    client?: PoolClient;
    tables?: DBTableKey[];
    requirementScope?: string[];
  } = {}
): Promise<DatabaseSchema> {
  const read = (text: string, params?: any[]) =>
    opts.client ? queryClient(opts.client, text, params) : queryPool(text, params);
  const tables = opts.tables && opts.tables.length > 0 ? opts.tables : ALL_TABLE_KEYS;
  const scope = opts.requirementScope && opts.requirementScope.length > 0 ? opts.requirementScope : null;

  // Scoped table loaders - when a requirement scope is active only the rows of
  // those auctions are loaded (no full-table scans on the hot bid path).
  const scopeClause = scope ? 'WHERE id = ANY($1)' : '';
  const scopeArgs = scope ? [scope] : [];
  const scopeClauseReq = scope ? 'WHERE requirement_id = ANY($1)' : '';
  const scopeReqArgs = scope ? [scope] : [];

  const loaders: Record<DBTableKey, (read: (sql: string, params?: any[]) => Promise<any>) => Promise<any[]>> = {
    users: (r) => r('SELECT * FROM users ORDER BY id').then((x) => x.rows),
    transporters: (r) =>
      r('SELECT * FROM transporters ORDER BY id').then((x) => x.rows.map(shapeTransporter)),
    requirements: (r) =>
      r(`SELECT * FROM requirements ${scopeClause} ORDER BY id`, scopeArgs).then((x) => x.rows.map(shapeRequirement)),
    requirementInvitations: (r) =>
      r(`SELECT * FROM requirement_invitations ${scopeClauseReq} ORDER BY id`, scopeReqArgs).then((x) => x.rows),
    bids: (r) =>
      r(`SELECT * FROM bids ${scopeClauseReq} ORDER BY id`, scopeReqArgs).then((x) => x.rows.map(shapeBid)),
    bidHistory: (r) =>
      r(`SELECT * FROM bid_history ${scopeClauseReq} ORDER BY id`, scopeReqArgs).then((x) => x.rows.map(shapeBidHistory)),
    awards: (r) =>
      r(`SELECT * FROM awards ${scopeClauseReq} ORDER BY id`, scopeReqArgs).then((x) => x.rows.map(shapeAward)),
    notificationProviderConfigs: (r) =>
      r('SELECT * FROM notification_provider_configs ORDER BY id').then((x) => x.rows),
    auditLogs: (r) => r('SELECT * FROM audit_logs ORDER BY id').then((x) => x.rows),
    sessions: (r) => r('SELECT * FROM sessions ORDER BY id').then((x) => x.rows),
    emailOtpVerifications: (r) => r('SELECT * FROM email_otp_verifications ORDER BY id').then((x) => x.rows),
    smsLogs: (r) => r('SELECT * FROM sms_logs ORDER BY id').then((x) => x.rows).catch(() => []),
    emailLogs: (r) => r('SELECT * FROM email_logs ORDER BY id').then((x) => x.rows).catch(() => []),
    whatsAppLogs: (r) =>
      r('SELECT * FROM whatsapp_logs ORDER BY id')
        .then((x) =>
          x.rows.map((wl: any) => ({
            ...wl,
            params: typeof wl.params === 'string' ? JSON.parse(wl.params) : wl.params
          }))
        )
        .catch(() => [])
  };

  // Load sequentially when inside a transaction: pg forbids concurrent
  // client.query() on the same client (deprecated in pg@9). When using the
  // pool (autocommit) parallel SELECTs are fine, but sequential is simpler and
  // equally fast for a handful of tables.
  const db: any = {};
  for (const t of tables) {
    db[t] = await loaders[t](read);
  }
  return db as DatabaseSchema;
}

// ---------------------------------------------------------------------------
// Targeted query helpers (Phase 2 - no full-table scans on the read path)
// ---------------------------------------------------------------------------

export async function getUserByEmail(email: string): Promise<User | null> {
  const res = await queryPool('SELECT * FROM users WHERE lower(email) = lower($1) AND is_deleted = FALSE LIMIT 1', [email]);
  return res.rows[0] || null;
}

export async function getUserById(id: string): Promise<User | null> {
  const res = await queryPool('SELECT * FROM users WHERE id = $1 AND is_deleted = FALSE LIMIT 1', [id]);
  return res.rows[0] || null;
}

/** Staff list - never select password hashes. Soft-deleted staff excluded. */
export async function getAllUsers(): Promise<User[]> {
  const res = await queryPool(
    'SELECT id, email, password_hash, role, name, status FROM users WHERE is_deleted = FALSE ORDER BY id'
  );
  return res.rows;
}

export async function getTransporterByEmail(email: string): Promise<Transporter | null> {
  const res = await queryPool('SELECT * FROM transporters WHERE lower(email) = lower($1) AND is_deleted = FALSE LIMIT 1', [email]);
  return res.rows[0] ? shapeTransporter(res.rows[0]) : null;
}

export async function getTransporterById(id: string): Promise<Transporter | null> {
  const res = await queryPool('SELECT * FROM transporters WHERE id = $1 AND is_deleted = FALSE LIMIT 1', [id]);
  return res.rows[0] ? shapeTransporter(res.rows[0]) : null;
}

export async function getAllTransporters(): Promise<Transporter[]> {
  const res = await queryPool(
    'SELECT id, company_name, contact_person, email, mobile_number, gst_number, pan_number, vehicle_types, operating_states, preferred_routes, status FROM transporters WHERE is_deleted = FALSE ORDER BY id'
  );
  return res.rows.map(shapeTransporter);
}

export async function getTransportersByIds(ids: string[]): Promise<Transporter[]> {
  if (!ids.length) return [];
  const res = await queryPool('SELECT * FROM transporters WHERE id = ANY($1) AND is_deleted = FALSE', [ids]);
  return res.rows.map(shapeTransporter);
}

export async function getActiveTransportersByVehicleType(vehicleType: string): Promise<Transporter[]> {
  const res = await queryPool(
    "SELECT * FROM transporters WHERE status = 'ACTIVE' AND is_deleted = FALSE AND $1 = ANY(vehicle_types) ORDER BY id",
    [vehicleType]
  );
  return res.rows.map(shapeTransporter);
}

export async function transporterIdsExist(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const res = await queryPool('SELECT id FROM transporters WHERE id = ANY($1) AND is_deleted = FALSE', [ids]);
  return new Set(res.rows.map((r: any) => r.id));
}

export async function getRequirementById(id: string): Promise<Requirement | null> {
  const res = await queryPool('SELECT * FROM requirements WHERE id = $1 AND is_deleted = FALSE LIMIT 1', [id]);
  return res.rows[0] ? shapeRequirement(res.rows[0]) : null;
}

/**
 * Garbage-collect expired sessions (and stale OTP verification rows). Sessions
 * carry a 90-day expiry; rows are never deleted by the auth flow itself, so
 * without this sweep the table would grow forever. Runs on a timer (self-
 * hosted) or lazily on requests (serverless). Returns the number of rows
 * removed.
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const nowIso = new Date().toISOString();
  let removed = 0;
  const sess = await queryPool('DELETE FROM sessions WHERE expiry < $1', [nowIso]);
  removed += sess.rowCount || 0;
  // The OTP verification table is dead code but may hold stale rows from the
  // pre-password era - sweep them while we are here.
  const otp = await queryPool('DELETE FROM email_otp_verifications WHERE expiry < $1', [nowIso]).catch(() => ({ rowCount: 0 }));
  removed += otp.rowCount || 0;
  return removed;
}

/** LIVE requirements whose bid closing time has passed (auto-close candidates). */
export async function getExpiredLiveRequirements(now: Date): Promise<Requirement[]> {
  const res = await queryPool(
    "SELECT * FROM requirements WHERE status = 'LIVE' AND is_deleted = FALSE AND bid_closing_time <= $1 ORDER BY bid_closing_time",
    [now.toISOString()]
  );
  return res.rows.map(shapeRequirement);
}

/** Highest numeric serial among TR-2026-XXXX ids (0 when none). */
export async function getMaxRequirementSerial(): Promise<number> {
  const res = await queryPool("SELECT MAX(id) AS max_id FROM requirements WHERE id LIKE 'TR-2026-%'");
  const maxId = res.rows[0] && res.rows[0].maxId;
  if (!maxId) return 0;
  const match = String(maxId).match(/^TR-2026-(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

export async function getInvitationsForRequirement(requirementId: string): Promise<RequirementInvitation[]> {
  const res = await queryPool(
    'SELECT * FROM requirement_invitations WHERE requirement_id = $1 ORDER BY id',
    [requirementId]
  );
  return res.rows;
}

export async function hasInvitation(requirementId: string, transporterId: string): Promise<boolean> {
  const res = await queryPool(
    "SELECT 1 FROM requirement_invitations WHERE requirement_id = $1 AND transporter_id = $2 AND status = 'INVITED' LIMIT 1",
    [requirementId, transporterId]
  );
  return res.rows.length > 0;
}

export async function getBidsForRequirement(requirementId: string): Promise<Bid[]> {
  const res = await queryPool('SELECT * FROM bids WHERE requirement_id = $1 ORDER BY id', [requirementId]);
  return res.rows.map(shapeBid);
}

export async function getBidFor(requirementId: string, transporterId: string): Promise<Bid | null> {
  const res = await queryPool(
    'SELECT * FROM bids WHERE requirement_id = $1 AND transporter_id = $2 LIMIT 1',
    [requirementId, transporterId]
  );
  return res.rows[0] ? shapeBid(res.rows[0]) : null;
}

export async function getBidById(id: string): Promise<Bid | null> {
  const res = await queryPool('SELECT * FROM bids WHERE id = $1 LIMIT 1', [id]);
  return res.rows[0] ? shapeBid(res.rows[0]) : null;
}

export async function hasBid(requirementId: string, transporterId: string): Promise<boolean> {
  const res = await queryPool(
    'SELECT 1 FROM bids WHERE requirement_id = $1 AND transporter_id = $2 LIMIT 1',
    [requirementId, transporterId]
  );
  return res.rows.length > 0;
}

export async function getAwardForRequirement(requirementId: string): Promise<Award | null> {
  const res = await queryPool('SELECT * FROM awards WHERE requirement_id = $1 ORDER BY id LIMIT 1', [requirementId]);
  return res.rows[0] ? shapeAward(res.rows[0]) : null;
}

export async function hasAward(requirementId: string, transporterId: string): Promise<boolean> {
  const res = await queryPool(
    'SELECT 1 FROM awards WHERE requirement_id = $1 AND transporter_id = $2 LIMIT 1',
    [requirementId, transporterId]
  );
  return res.rows.length > 0;
}

/** Requirements (staff view) joined with their award, ordered like the old snapshot. */
export async function getRequirementsWithAwards(): Promise<{ requirement: Requirement; award: Award | null }[]> {
  const res = await queryPool(`
    SELECT r.*, a.id AS award_id, a.requirement_id AS award_req_id, a.transporter_id AS award_transporter_id,
           a.amount AS award_amount, a.awarded_at AS award_awarded_at, a.awarded_by AS award_awarded_by,
           a.tie_break_log AS award_tie_break_log
    FROM requirements r
    LEFT JOIN awards a ON a.requirement_id = r.id
    WHERE r.is_deleted = FALSE
    ORDER BY r.id
  `);
  return res.rows.map(rowToRequirementAward);
}

/**
 * Requirements visible to a transporter: public/targeted loads they can see,
 * plus closed/draft auctions they are INVITED to, bid on, or won (mirrors the
 * old in-memory filter exactly). Joined with awards for winner display.
 */
export async function getVisibleRequirementsForTransporter(
  userId: string
): Promise<{ requirement: Requirement; award: Award | null }[]> {
  const res = await queryPool(
    `
    SELECT r.*, a.id AS award_id, a.requirement_id AS award_req_id, a.transporter_id AS award_transporter_id,
           a.amount AS award_amount, a.awarded_at AS award_awarded_at, a.awarded_by AS award_awarded_by,
           a.tie_break_log AS award_tie_break_log
    FROM requirements r
    LEFT JOIN awards a ON a.requirement_id = r.id
    WHERE r.is_deleted = FALSE
      AND (
      (r.targeted_transporter_ids IS NULL OR cardinality(r.targeted_transporter_ids) = 0 OR $1 = ANY(r.targeted_transporter_ids))
      AND (
        r.status IN ('active', 'published', 'LIVE')
        OR (
          r.status <> 'DRAFT'
          AND (
            EXISTS (SELECT 1 FROM requirement_invitations ri WHERE ri.requirement_id = r.id AND ri.transporter_id = $1 AND ri.status = 'INVITED')
            OR EXISTS (SELECT 1 FROM bids b WHERE b.requirement_id = r.id AND b.transporter_id = $1)
            OR EXISTS (SELECT 1 FROM awards a2 WHERE a2.requirement_id = r.id AND a2.transporter_id = $1)
          )
        )
      )
    )
    ORDER BY r.id
    `,
    [userId]
  );
  return res.rows.map(rowToRequirementAward);
}

function rowToRequirementAward(row: any): { requirement: Requirement; award: Award | null } {
  const {
    award_id,
    award_req_id,
    award_transporter_id,
    award_amount,
    award_awarded_at,
    award_awarded_by,
    award_tie_break_log,
    ...reqFields
  } = row;
  const award = award_id
    ? {
        id: award_id,
        requirementId: award_req_id,
        transporterId: award_transporter_id,
        amount: Number(award_amount),
        awardedAt: award_awarded_at,
        awardedBy: award_awarded_by,
        tieBreakLog: award_tie_break_log
      }
    : null;
  return { requirement: shapeRequirement(reqFields), award };
}

export async function getSessionById(id: string): Promise<Session | null> {
  const res = await queryPool('SELECT * FROM sessions WHERE id = $1 LIMIT 1', [id]);
  return res.rows[0] || null;
}

export async function getSessionsForUser(id: string, role: string): Promise<Session[]> {
  const res =
    role === 'TRANSPORTER'
      ? await queryPool('SELECT * FROM sessions WHERE transporter_id = $1 ORDER BY login_time DESC', [id])
      : await queryPool('SELECT * FROM sessions WHERE user_id = $1 ORDER BY login_time DESC', [id]);
  return res.rows;
}

export async function getNotificationConfig(): Promise<NotificationProviderConfig | null> {
  const res = await queryPool("SELECT * FROM notification_provider_configs WHERE id = 'default' LIMIT 1");
  return res.rows[0] || null;
}

/** Audit logs, newest-first with LIMIT/OFFSET pagination + total count. */
export async function getAuditLogsPage(
  page: number,
  limit: number
): Promise<{ rows: AuditLog[]; total: number }> {
  const offset = (page - 1) * limit;
  const totalRes = await queryPool('SELECT count(*) FROM audit_logs');
  const res = await queryPool(
    'SELECT * FROM audit_logs ORDER BY timestamp DESC, id DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return { rows: res.rows, total: parseInt(totalRes.rows[0].count, 10) };
}

/** Notification delivery logs (newest-first, capped per channel). */
export async function getNotificationLogs(
  limit: number
): Promise<{ smsLogs: any[]; emailLogs: any[]; whatsAppLogs: any[] }> {
  const [smsRes, emailRes, waRes] = await Promise.all([
    queryPool('SELECT * FROM sms_logs ORDER BY sent_at DESC NULLS LAST, id DESC LIMIT $1', [limit]).catch(() => ({ rows: [] })),
    queryPool('SELECT * FROM email_logs ORDER BY sent_at DESC NULLS LAST, id DESC LIMIT $1', [limit]).catch(() => ({ rows: [] })),
    queryPool('SELECT * FROM whatsapp_logs ORDER BY sent_at DESC NULLS LAST, id DESC LIMIT $1', [limit]).catch(() => ({ rows: [] }))
  ]);
  return {
    smsLogs: smsRes.rows,
    emailLogs: emailRes.rows,
    whatsAppLogs: waRes.rows.map((wl: any) => ({
      ...wl,
      params: typeof wl.params === 'string' ? JSON.parse(wl.params) : wl.params
    }))
  };
}

/**
 * generic diff-sync function for tables mapping columns to database snake_case.
 * Every statement runs on `client` so the whole write is one atomic transaction.
 */
async function syncTable(
  client: PoolClient,
  tableName: string,
  initialRows: any[],
  updatedRows: any[],
  columns: string[]
) {
  const initialMap = new Map(initialRows.map(r => [r.id, r]));
  const updatedMap = new Map(updatedRows.map(r => [r.id, r]));

  // 1. Rows removed from the snapshot. HARD-DELETE GUARD (Phase 5): business
  //    data must never be physically erased. Every delete path is a soft delete
  //    (is_deleted = TRUE) so a row missing from the updated snapshot is a BUG,
  //    not an operation - refuse loudly so the transaction rolls back instead
  //    of silently destroying historical data.
  for (const row of initialRows) {
    if (!updatedMap.has(row.id)) {
      throw new Error(
        `REFUSED hard delete: ${tableName} row ${row.id} missing from updated snapshot. ` +
        'Business data is soft-delete only (set is_deleted=true); physical deletes are not permitted.'
      );
    }
  }

  // 2. Insert new rows or update changed rows
  for (const row of updatedRows) {
    const initialRow = initialMap.get(row.id);
    
    const getVal = (col: string) => {
      return row[col];
    };

    if (!initialRow) {
      // Insert new row
      const vals = columns.map(getVal);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const snakeCols = columns.map(toSnakeCase).map(c => `"${c}"`).join(', ');
      await queryClient(client, `INSERT INTO ${tableName} (${snakeCols}) VALUES (${placeholders})`, vals);
    } else {
      // Check if diff exists
      let hasDiff = false;
      for (const col of columns) {
        let val1 = initialRow[col];
        let val2 = row[col];

        if (JSON.stringify(val1) !== JSON.stringify(val2)) {
          hasDiff = true;
          break;
        }
      }

      if (hasDiff) {
        // Update changed row
        const vals = columns.filter(c => c !== 'id').map(getVal);
        vals.push(row.id);

        const setClause = columns
          .filter(c => c !== 'id')
          .map((c, i) => `"${toSnakeCase(c)}" = $${i + 1}`)
          .join(', ');

        await queryClient(client, `UPDATE ${tableName} SET ${setClause} WHERE id = $${columns.length}`, vals);
      }
    }
  }
}

export interface WriteContext {
  /** The transaction's dedicated connection - run any additional SQL here if needed. */
  client: PoolClient;
}

/**
 * Runs updater on PostgreSQL state by performing snapshot diffing, inside ONE
 * database transaction so a failure at any step rolls the entire write back.
 *
 * Concurrency guarantees (valid for 100+ concurrent users on Vercel serverless):
 *  1. In-process promise mutex (serializes writers within one lambda instance).
 *  2. Transaction-scoped advisory lock (pg_advisory_xact_lock) serializes
 *     writers across ALL lambda instances - compatible with Neon's pooled
 *     endpoint (PgBouncer transaction mode), unlike session-level locks.
 *  3. REPEATABLE READ isolation: the fresh snapshot is read through the SAME
 *     transaction connection, so it sees the committed state as of lock
 *     acquisition - no phantom reads, no partial multi-table state.
 *  4. Optional row-level locks (SELECT ... FOR UPDATE) on affected auctions.
 *
 * Returns the updater's value (e.g. { award } info) after a successful COMMIT.
 */
// Column lists for the tables writeDB can sync. Sessions, OTP verifications,
// and the notification log tables are managed by dedicated helpers (server/auth.ts,
// server/notifications.ts) and are deliberately NOT diff-synced here.
// NOTE: is_deleted (soft-delete flag) is deliberately NOT in the column lists
// below - it is flipped by the delete routes via a direct UPDATE, and the
// diff-sync INSERT path only writes columns present in these lists. Including
// it would break INSERTs (new rows carry no isDeleted field -> NOT NULL
// violation). Reads filter is_deleted = FALSE; the flag itself is owned by
// the dedicated soft-delete UPDATEs in app.ts.
const SYNC_TABLES: Record<string, { table: string; columns: string[] }> = {
  users: { table: 'users', columns: ['id', 'email', 'passwordHash', 'role', 'name', 'status'] },
  transporters: {
    table: 'transporters',
    columns: [
      'id', 'companyName', 'contactPerson', 'email', 'mobileNumber', 'gstNumber', 'panNumber',
      'vehicleTypes', 'operatingStates', 'preferredRoutes', 'status', 'passwordHash'
    ]
  },
  requirements: {
    table: 'requirements',
    columns: [
      'id', 'pickupLocation', 'deliveryLocation', 'material', 'weight', 'vehicleType',
      'numberOfVehicles', 'pickupDate', 'expectedDelivery', 'specialInstructions', 'documents',
      'bidOpeningTime', 'bidClosingTime', 'targetRate', 'awardType', 'status', 'createdAt',
      'targetedTransporterIds', 'vehicleSpecs'
    ]
  },
  requirementInvitations: {
    table: 'requirement_invitations',
    columns: ['id', 'requirementId', 'transporterId', 'status', 'removedReason']
  },
  bids: { table: 'bids', columns: ['id', 'requirementId', 'transporterId', 'amount', 'timestamp', 'lastUpdated'] },
  bidHistory: { table: 'bid_history', columns: ['id', 'requirementId', 'transporterId', 'amount', 'timestamp'] },
  awards: { table: 'awards', columns: ['id', 'requirementId', 'transporterId', 'amount', 'awardedAt', 'awardedBy', 'tieBreakLog'] },
  notificationProviderConfigs: {
    table: 'notification_provider_configs',
    columns: [
      'id', 'whatsappWabaId', 'whatsappPhoneId', 'whatsappToken', 'whatsappVerifyToken',
      'whatsappStatus', 'whatsappError', 'smsProvider', 'smsApiKey', 'smsAuthToken', 'smsSenderId',
      'smsStatus', 'smsError', 'emailProvider', 'emailApiKey', 'emailSenderAddress', 'emailStatus', 'emailError'
    ]
  },
  auditLogs: {
    table: 'audit_logs',
    columns: ['id', 'userId', 'userEmail', 'role', 'action', 'timestamp', 'ipAddress', 'device', 'oldValue', 'newValue']
  }
};

/**
 * Runs updater on PostgreSQL state by performing snapshot diffing, inside ONE
 * database transaction so a failure at any step rolls the entire write back.
 *
 * Concurrency model (Phase 2 - per-entity locks, no global write bottleneck):
 *  1. In-process promise queue PER LOCK KEY (withLocks) - writes to DIFFERENT
 *     auctions never wait on each other inside one lambda instance.
 *  2. Transaction-scoped advisory lock PER LOCK KEY (pg_advisory_xact_lock on
 *     hashtextextended(key)) serializes writers across ALL lambda instances -
 *     compatible with Neon's pooled endpoint (PgBouncer transaction mode).
 *     The default key is 'global', preserving the old full serialization for
 *     call sites not yet annotated.
 *  3. REPEATABLE READ isolation: the fresh snapshot is read through the SAME
 *     transaction connection, so it sees the committed state as of lock
 *     acquisition - no phantom reads, no partial multi-table state.
 *  4. Optional row-level locks (SELECT ... FOR UPDATE) on affected auctions.
 *  5. Only the tables listed in `tables` are loaded AND synced, so a scoped
 *     write never touches unrelated rows.
 *
 * Serialization conflicts (40001) and deadlocks (40P01) are documented
 * RETRYABLE errors under REPEATABLE READ: another lambda committed a change to
 * a row we read before our snapshot was established. Retry from scratch (fresh
 * transaction, fresh snapshot, updater re-validates against the new committed
 * state) instead of surfacing a 500.
 */
export async function writeDB<T = void>(
  updater: (db: DatabaseSchema, ctx: WriteContext) => T | Promise<T>,
  options: {
    lockKeys?: string[];
    lockRequirementIds?: string[];
    tables?: DBTableKey[];
    requirementScope?: string[];
  } = {}
): Promise<T> {
  const lockKeys = options.lockKeys && options.lockKeys.length > 0 ? options.lockKeys : ['global'];
  const tables = options.tables && options.tables.length > 0 ? options.tables : ALL_TABLE_KEYS;

  // In-process per-key queues, acquired in deterministic order to avoid deadlock.
  return withLocks(lockKeys, async () => {
    const MAX_RETRIES = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await withTransaction(async (client) => {
          // Snapshot isolation must be the first statement after BEGIN.
          await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');

          // Cross-instance per-key write serialization - auto-released at
          // COMMIT/ROLLBACK. Distinct keys (e.g. auction:<id>) run in parallel;
          // writes with the same key serialize. Keys are sorted so multi-key
          // writers acquire locks in the same order and cannot deadlock.
          const sortedKeys = Array.from(new Set(lockKeys)).sort();
          for (const key of sortedKeys) {
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
          }

          // Explicit row-level locks on the auction(s) being modified (belt and
          // braces on top of the advisory lock; satisfies strict row-locking
          // requirements and blocks concurrent direct SQL updates on the same row).
          if (options.lockRequirementIds && options.lockRequirementIds.length > 0) {
            await client.query('SELECT id FROM requirements WHERE id = ANY($1) FOR UPDATE', [
              options.lockRequirementIds
            ]);
          }

          const db = await getDB({ fresh: true, client, tables, requirementScope: options.requirementScope });
          const initial = JSON.parse(JSON.stringify(db));

          const result = await updater(db, { client });

          // Diff-sync ONLY the tables this write loaded - scoped writes never
          // touch (or worse, wipe) rows in tables they didn't read.
          for (const t of tables) {
            const cfg = SYNC_TABLES[t];
            if (cfg) {
              await syncTable(client, cfg.table, initial[t], db[t], cfg.columns);
            }
          }

          invalidateReadCache();
          return result;
        });
      } catch (err: any) {
        const code = err && (err.code || (err.cause && err.cause.code));
        if ((code === '40001' || code === '40P01') && attempt < MAX_RETRIES) {
          console.warn(`writeDB serialization conflict (${code}), retrying (${attempt}/${MAX_RETRIES - 1})...`);
          continue;
        }
        throw err;
      }
    }
  });
}

/**
 * Flush the in-memory snapshot cache and notify listeners (e.g. the auth cache)
 * that the database changed. Called by writeDB and by direct session mutations
 * in server/auth.ts so revoked sessions are honored immediately.
 */
export function invalidateReadCache() {
  triggerDBWrite();
}

/**
 * Auto-initialization sequence that safely applies structural tables and indexes in Neon PostgreSQL.
 * Uses standard snake_case without case-sensitive double quotes.
 */
export async function initDatabase() {
  console.log('Initializing PostgreSQL Database schema and seed data...');
  
  // 1. Create tables
  await queryPool(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(255) PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL,
      is_deleted BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS transporters (
      id VARCHAR(255) PRIMARY KEY,
      company_name VARCHAR(255) NOT NULL,
      contact_person VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      mobile_number VARCHAR(50) NOT NULL,
      gst_number VARCHAR(50) NOT NULL,
      pan_number VARCHAR(50) NOT NULL,
      vehicle_types TEXT[] NOT NULL,
      operating_states TEXT[] NOT NULL,
      preferred_routes TEXT[] NOT NULL,
      status VARCHAR(50) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_deleted BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS requirements (
      id VARCHAR(255) PRIMARY KEY,
      pickup_location VARCHAR(255) NOT NULL,
      delivery_location VARCHAR(255) NOT NULL,
      material VARCHAR(255) NOT NULL,
      weight NUMERIC NOT NULL,
      vehicle_type VARCHAR(255) NOT NULL,
      number_of_vehicles INTEGER NOT NULL,
      pickup_date VARCHAR(50) NOT NULL,
      expected_delivery VARCHAR(50) NOT NULL,
      special_instructions TEXT,
      documents TEXT[] NOT NULL,
      bid_opening_time VARCHAR(50) NOT NULL,
      bid_closing_time VARCHAR(50) NOT NULL,
      target_rate NUMERIC,
      award_type VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL,
      created_at VARCHAR(50) NOT NULL,
      targeted_transporter_ids TEXT[],
      vehicle_specs TEXT,
      is_deleted BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  // Backfill the vehicle_specs column on pre-existing deployments (CREATE TABLE
  // IF NOT EXISTS never alters an existing table).
  await queryPool(`
    ALTER TABLE requirements ADD COLUMN IF NOT EXISTS vehicle_specs TEXT;
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS requirement_invitations (
      id VARCHAR(255) PRIMARY KEY,
      requirement_id VARCHAR(255) NOT NULL,
      transporter_id VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL,
      removed_reason TEXT
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS bids (
      id VARCHAR(255) PRIMARY KEY,
      requirement_id VARCHAR(255) NOT NULL,
      transporter_id VARCHAR(255) NOT NULL,
      amount NUMERIC NOT NULL,
      timestamp VARCHAR(50) NOT NULL,
      last_updated VARCHAR(50) NOT NULL,
      UNIQUE(requirement_id, transporter_id)
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS bid_history (
      id VARCHAR(255) PRIMARY KEY,
      requirement_id VARCHAR(255) NOT NULL,
      transporter_id VARCHAR(255) NOT NULL,
      amount NUMERIC NOT NULL,
      timestamp VARCHAR(50) NOT NULL
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS awards (
      id VARCHAR(255) PRIMARY KEY,
      requirement_id VARCHAR(255) NOT NULL,
      transporter_id VARCHAR(255) NOT NULL,
      amount NUMERIC NOT NULL,
      awarded_at VARCHAR(50) NOT NULL,
      awarded_by VARCHAR(255) NOT NULL,
      tie_break_log TEXT
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS notification_provider_configs (
      id VARCHAR(255) PRIMARY KEY,
      whatsapp_waba_id VARCHAR(255),
      whatsapp_phone_id VARCHAR(255),
      whatsapp_token TEXT,
      whatsapp_verify_token VARCHAR(255),
      whatsapp_status VARCHAR(50) NOT NULL,
      whatsapp_error TEXT,
      sms_provider VARCHAR(50) NOT NULL,
      sms_api_key VARCHAR(255),
      sms_auth_token VARCHAR(255),
      sms_sender_id VARCHAR(255),
      sms_status VARCHAR(50) NOT NULL,
      sms_error TEXT,
      email_provider VARCHAR(50) NOT NULL,
      email_api_key VARCHAR(255),
      email_sender_address VARCHAR(255),
      email_status VARCHAR(50) NOT NULL,
      email_error TEXT
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255),
      user_email VARCHAR(255),
      role VARCHAR(50),
      action VARCHAR(255) NOT NULL,
      timestamp VARCHAR(50) NOT NULL,
      ip_address VARCHAR(50),
      device TEXT,
      old_value TEXT,
      new_value TEXT
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS sessions (
      id VARCHAR(255) PRIMARY KEY,
      transporter_id VARCHAR(255),
      user_id VARCHAR(255),
      user_role VARCHAR(50) NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      browser TEXT NOT NULL,
      os TEXT NOT NULL,
      ip_address VARCHAR(50) NOT NULL,
      login_time VARCHAR(50) NOT NULL,
      last_activity VARCHAR(50) NOT NULL,
      refresh_token VARCHAR(255) NOT NULL,
      expiry VARCHAR(50) NOT NULL
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS email_otp_verifications (
      id VARCHAR(255) PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      hashed_otp VARCHAR(255) NOT NULL,
      expiry VARCHAR(50) NOT NULL,
      attempts INTEGER NOT NULL
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS sms_logs (
      id VARCHAR(255) PRIMARY KEY,
      "to" VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      sent_at VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL,
      error TEXT,
      provider VARCHAR(50) NOT NULL
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS email_logs (
      id VARCHAR(255) PRIMARY KEY,
      "to" VARCHAR(255) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      sent_at VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL,
      error TEXT,
      provider VARCHAR(50) NOT NULL
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS whatsapp_logs (
      id VARCHAR(255) PRIMARY KEY,
      "to" VARCHAR(255) NOT NULL,
      template VARCHAR(255) NOT NULL,
      params JSONB,
      sent_at VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL,
      error TEXT,
      provider VARCHAR(50) NOT NULL
    );
  `);

  await queryPool(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key VARCHAR(255) PRIMARY KEY,
      window_start TIMESTAMPTZ NOT NULL,
      count INTEGER NOT NULL,
      limit_value INTEGER NOT NULL,
      window_seconds INTEGER NOT NULL
    );
  `);

  // 2. Create indexes in standard unquoted snake_case
  await ensureIndexes();

  // 3. Seed users if table is empty.
  // IMPORTANT: We never reset or re-assert passwords on subsequent boots - doing so
  // would silently revert admin-changed passwords to publicly documented defaults.
  const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  const userCheck = await queryPool('SELECT count(*) FROM users');
  if (parseInt(userCheck.rows[0].count, 10) === 0) {
    console.log('Seeding default users...');

    // Prefer explicit SEED_ADMIN_* configuration; otherwise generate a random
    // password and print it ONCE so no publicly known default credential exists.
    const seedEmail = process.env.SEED_ADMIN_EMAIL;
    const seedPassword = process.env.SEED_ADMIN_PASSWORD;
    const seedName = process.env.SEED_ADMIN_NAME || 'Master Administrator';
    const adminEmail = seedEmail || 'admin@fleexbid.com';
    const adminPassword = seedPassword || crypto.randomBytes(12).toString('base64url');
    const adminHash = await bcrypt.hash(adminPassword, 10);

    if (!seedPassword) {
      console.log(`[SEED] Master admin created with a randomly generated password. Save it now: ${adminPassword}`);
    } else {
      console.log(`[SEED] Master admin created from SEED_ADMIN_* environment variables (${adminEmail}).`);
    }

    if (isProduction) {
      // Production: only the single master admin is seeded. No demo accounts,
      // no demo data. Operators create staff/transporters through the UI.
      await queryPool(`
        INSERT INTO users (id, email, password_hash, role, name, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['usr_admin', adminEmail, adminHash, 'SUPER_ADMIN', seedName, 'ACTIVE']);
    } else {
      // Development: seed demo staff accounts with clearly documented dev-only passwords.
      const logisticsHash = await bcrypt.hash('logistics123', 10);
      await queryPool(`
        INSERT INTO users (id, email, password_hash, role, name, status) VALUES
        ($1, $2, $3, $4, $5, $6),
        ($7, $8, $9, $10, $11, $12)
      `, [
        'usr_admin', adminEmail, adminHash, 'SUPER_ADMIN', seedName, 'ACTIVE',
        'usr_logistics', 'logistics@fleexbid.com', logisticsHash, 'LOGISTICS', 'Logistics Executive', 'ACTIVE'
      ]);
    }
  }

  // 4. Seed transporters if table is empty (development environments only)
  const transCheck = await queryPool('SELECT count(*) FROM transporters');
  if (parseInt(transCheck.rows[0].count, 10) === 0 && !isProduction) {
    console.log('Seeding default transporters (development only)...');
    const defaultTrHash = await bcrypt.hash('transporter123', 10);

    const defaultTransporters = [
      {
        id: 'tr_gati',
        companyName: 'Gati Transport',
        contactPerson: 'Ramesh Gati',
        email: 'gati@transport.com',
        mobileNumber: '+919876543210',
        gstNumber: '27AAAAA1111A1Z1',
        panNumber: 'AAAAA1111A',
        vehicleTypes: ['32 FT Trailer', '20 FT Container'],
        operatingStates: ['Maharashtra', 'Delhi', 'Haryana'],
        preferredRoutes: ['Mumbai -> Delhi', 'Delhi -> Jaipur'],
        status: 'ACTIVE',
        passwordHash: defaultTrHash
      },
      {
        id: 'tr_vrl',
        companyName: 'VRL Logistics',
        contactPerson: 'Vijay VRL',
        email: 'vrl@logistics.com',
        mobileNumber: '+919876543211',
        gstNumber: '29BBBBB2222B2Z2',
        panNumber: 'BBBBB2222B',
        vehicleTypes: ['32 FT Trailer', '19 FT Open Truck'],
        operatingStates: ['Karnataka', 'Tamil Nadu', 'Maharashtra'],
        preferredRoutes: ['Mumbai -> Delhi', 'Bangalore -> Chennai'],
        status: 'ACTIVE',
        passwordHash: defaultTrHash
      },
      {
        id: 'tr_tci',
        companyName: 'TCI Freight',
        contactPerson: 'Amit TCI',
        email: 'tci@freight.com',
        mobileNumber: '+919876543212',
        gstNumber: '27CCCCC3333C3Z3',
        panNumber: 'CCCCC3333C',
        vehicleTypes: ['32 FT Trailer', '40 FT Container'],
        operatingStates: ['Maharashtra', 'Delhi', 'Gujarat'],
        preferredRoutes: ['Mumbai -> Delhi'],
        status: 'ACTIVE',
        passwordHash: defaultTrHash
      },
      {
        id: 'tr_inactive',
        companyName: 'Express Cargo (Inactive)',
        contactPerson: 'John Cargo',
        email: 'john@expresscargo.com',
        mobileNumber: '+919876543213',
        gstNumber: '27DDDDD4444D4Z4',
        panNumber: 'DDDDD4444D',
        vehicleTypes: ['20 FT Container'],
        operatingStates: ['Maharashtra'],
        preferredRoutes: ['Mumbai -> Pune'],
        status: 'INACTIVE',
        passwordHash: defaultTrHash
      }
    ];

    for (const tr of defaultTransporters) {
      await queryPool(`
        INSERT INTO transporters (id, company_name, contact_person, email, mobile_number, gst_number, pan_number, vehicle_types, operating_states, preferred_routes, status, password_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        tr.id, tr.companyName, tr.contactPerson, tr.email, tr.mobileNumber, tr.gstNumber, tr.panNumber,
        tr.vehicleTypes, tr.operatingStates, tr.preferredRoutes, tr.status, tr.passwordHash
      ]);
    }
  }

  // 5. Seed default notification config if empty
  const configCheck = await queryPool('SELECT count(*) FROM notification_provider_configs');
  if (parseInt(configCheck.rows[0].count, 10) === 0) {
    console.log('Seeding default notification provider config...');
    await queryPool(`
      INSERT INTO notification_provider_configs (
        id, whatsapp_waba_id, whatsapp_phone_id, whatsapp_token, whatsapp_verify_token, whatsapp_status, whatsapp_error,
        sms_provider, sms_api_key, sms_auth_token, sms_sender_id, sms_status, sms_error,
        email_provider, email_api_key, email_sender_address, email_status, email_error
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
      )
    `, [
      'default', '', '', '', 'verify_token_123', 'NOT_CONNECTED', null,
      'mock', '', '', '', 'NOT_CONNECTED', null,
      'mock', '', 'noreply@fleexbid.com', 'NOT_CONNECTED', null
    ]);
  }

  // 6. Seed sample requirements, invitations, and bids if empty (development only)
  const reqCheck = await queryPool('SELECT count(*) FROM requirements');
  if (parseInt(reqCheck.rows[0].count, 10) === 0 && !isProduction) {
    console.log('Seeding default requirements, invitations, and bids (development only)...');
    const now = new Date();
    const closingTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const closedTime = new Date(now.getTime() - 10 * 60 * 1000);
    const draftTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const requirements = [
      {
        id: 'TR-2026-0001',
        pickupLocation: 'Mumbai',
        deliveryLocation: 'Delhi',
        material: 'Chemical Carboys',
        weight: 18,
        vehicleType: '32 FT Trailer',
        numberOfVehicles: 1,
        pickupDate: '2026-07-10',
        expectedDelivery: '2026-07-13',
        specialInstructions: 'Must carry valid MSDS and hazmat-trained driver.',
        documents: [],
        bidOpeningTime: now.toISOString(),
        bidClosingTime: closingTime.toISOString(),
        targetRate: 45000,
        awardType: 'MANUAL',
        status: 'LIVE',
        createdAt: now.toISOString(),
        targetedTransporterIds: []
      },
      {
        id: 'TR-2026-0002',
        pickupLocation: 'Bangalore',
        deliveryLocation: 'Chennai',
        material: 'Electronic Spares',
        weight: 10,
        vehicleType: '19 FT Open Truck',
        numberOfVehicles: 2,
        pickupDate: '2026-07-12',
        expectedDelivery: '2026-07-13',
        specialInstructions: 'Waterproof tarpaulin sheet is mandatory.',
        documents: [],
        bidOpeningTime: now.toISOString(),
        bidClosingTime: draftTime.toISOString(),
        targetRate: 22000,
        awardType: 'AUTOMATIC',
        status: 'DRAFT',
        createdAt: now.toISOString(),
        targetedTransporterIds: []
      },
      {
        id: 'TR-2026-0003',
        pickupLocation: 'Mumbai',
        deliveryLocation: 'Delhi',
        material: 'FMCG Goods',
        weight: 15,
        vehicleType: '32 FT Trailer',
        numberOfVehicles: 1,
        pickupDate: '2026-07-06',
        expectedDelivery: '2026-07-09',
        specialInstructions: 'No transshipment allowed.',
        documents: [],
        bidOpeningTime: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        bidClosingTime: closedTime.toISOString(),
        targetRate: 46000,
        awardType: 'AUTOMATIC',
        status: 'CLOSED',
        createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        targetedTransporterIds: []
      }
    ];

    for (const req of requirements) {
      await queryPool(`
        INSERT INTO requirements (id, pickup_location, delivery_location, material, weight, vehicle_type, number_of_vehicles, pickup_date, expected_delivery, special_instructions, documents, bid_opening_time, bid_closing_time, target_rate, award_type, status, created_at, targeted_transporter_ids)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      `, [
        req.id, req.pickupLocation, req.deliveryLocation, req.material, req.weight, req.vehicleType, req.numberOfVehicles,
        req.pickupDate, req.expectedDelivery, req.specialInstructions, req.documents, req.bidOpeningTime, req.bidClosingTime,
        req.targetRate, req.awardType, req.status, req.createdAt, req.targetedTransporterIds
      ]);
    }

    const invitations = [
      { id: 'inv_1', requirementId: 'TR-2026-0001', transporterId: 'tr_gati', status: 'INVITED', removedReason: null },
      { id: 'inv_2', requirementId: 'TR-2026-0001', transporterId: 'tr_vrl', status: 'INVITED', removedReason: null },
      { id: 'inv_3', requirementId: 'TR-2026-0001', transporterId: 'tr_tci', status: 'INVITED', removedReason: null },
      { id: 'inv_4', requirementId: 'TR-2026-0003', transporterId: 'tr_gati', status: 'INVITED', removedReason: null },
      { id: 'inv_5', requirementId: 'TR-2026-0003', transporterId: 'tr_vrl', status: 'INVITED', removedReason: null },
      { id: 'inv_6', requirementId: 'TR-2026-0003', transporterId: 'tr_tci', status: 'INVITED', removedReason: null }
    ];

    for (const inv of invitations) {
      await queryPool(`
        INSERT INTO requirement_invitations (id, requirement_id, transporter_id, status, removed_reason)
        VALUES ($1, $2, $3, $4, $5)
      `, [inv.id, inv.requirementId, inv.transporterId, inv.status, inv.removedReason]);
    }

    const bTime = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
    const bids = [
      { id: 'bid_1', requirementId: 'TR-2026-0003', transporterId: 'tr_gati', amount: 42000, timestamp: bTime, lastUpdated: bTime },
      { id: 'bid_2', requirementId: 'TR-2026-0003', transporterId: 'tr_vrl', amount: 42000, timestamp: bTime, lastUpdated: bTime },
      { id: 'bid_3', requirementId: 'TR-2026-0003', transporterId: 'tr_tci', amount: 45000, timestamp: bTime, lastUpdated: bTime }
    ];

    for (const bid of bids) {
      await queryPool(`
        INSERT INTO bids (id, requirement_id, transporter_id, amount, timestamp, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [bid.id, bid.requirementId, bid.transporterId, bid.amount, bid.timestamp, bid.lastUpdated]);

      await queryPool(`
        INSERT INTO bid_history (id, requirement_id, transporter_id, amount, timestamp)
        VALUES ($1, $2, $3, $4, $5)
      `, [`bh_${bid.id}`, bid.requirementId, bid.transporterId, bid.amount, bid.timestamp]);
    }
  }

  console.log('PostgreSQL database initialization successful.');
}

/**
 * Idempotent index creation + column migrations. Runs on EVERY cold start (not
 * just when the schema is created) so schema upgrades reach existing databases.
 * CREATE INDEX IF NOT EXISTS / ADD COLUMN IF NOT EXISTS are cheap catalog
 * checks when the object already exists.
 *
 * Column migrations are required because CREATE TABLE IF NOT EXISTS does NOT
 * alter an existing table - tables created by an older schema keep their old
 * shape. E.g. the live whatsapp_logs table predates the `sent_at` column, so
 * every notification INSERT was failing with "column sent_at does not exist"
 * and the log row was silently lost.
 */
export async function ensureIndexes() {
  // rate_limits may not exist on databases created before Phase 3 - CREATE
  // TABLE IF NOT EXISTS here is the idempotent migration path (runs on every
  // cold start, never fails when the table already exists).
  await queryPool(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key VARCHAR(255) PRIMARY KEY,
      window_start TIMESTAMPTZ NOT NULL,
      count INTEGER NOT NULL,
      limit_value INTEGER NOT NULL,
      window_seconds INTEGER NOT NULL
    );
  `);
  // Soft-delete columns (Phase 5 - data persistence): existing tables created
  // before this migration have no is_deleted column; CREATE TABLE IF NOT EXISTS
  // does not alter them, so add the column idempotently here.
  await queryPool('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;');
  await queryPool('ALTER TABLE transporters ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;');
  await queryPool('ALTER TABLE requirements ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;');
  // Vehicle Specifications / Remarks column (Phase: standardized vehicle types).
  // Added here - NOT only in initDatabase - because production cold starts on an
  // existing schema run ensureIndexes(), never the full initDatabase() DDL.
  await queryPool('ALTER TABLE requirements ADD COLUMN IF NOT EXISTS vehicle_specs TEXT;');

  await queryPool('CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);');
  await queryPool('CREATE INDEX IF NOT EXISTS idx_users_role_status ON users (role, status);');
  await queryPool('CREATE INDEX IF NOT EXISTS idx_bids_requirement_transporter ON bids (requirement_id, transporter_id);');
  await queryPool('CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements (status);');
  // Concurrency-critical lookups for large datasets
  await queryPool('CREATE INDEX IF NOT EXISTS idx_invitations_requirement ON requirement_invitations (requirement_id);');
  await queryPool('CREATE INDEX IF NOT EXISTS idx_invitations_transporter ON requirement_invitations (transporter_id);');
  await queryPool('CREATE INDEX IF NOT EXISTS idx_bid_history_requirement ON bid_history (requirement_id);');
  await queryPool('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, transporter_id);');
  await queryPool('CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);');

  // Idempotent column migrations for notification log tables. Two legacy
  // shapes exist in the wild: (a) fresh tables from initDatabase use snake_case
  // (sent_at NOT NULL), (b) tables created by the original db.json-era code use
  // camelCase "sentAt" NOT NULL while the current INSERTs write sent_at. We
  // ensure sent_at exists AND neutralize the stale camelCase NOT NULL column so
  // INSERTs cannot fail with "null value in column \"sentAt\"".
  await queryPool(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'whatsapp_logs' AND column_name = 'sentAt') THEN
        ALTER TABLE whatsapp_logs ALTER COLUMN "sentAt" DROP NOT NULL;
      END IF;
    END $$;
  `);
  await queryPool(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sms_logs' AND column_name = 'sentAt') THEN
        ALTER TABLE sms_logs ALTER COLUMN "sentAt" DROP NOT NULL;
      END IF;
    END $$;
  `);
  await queryPool(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'email_logs' AND column_name = 'sentAt') THEN
        ALTER TABLE email_logs ALTER COLUMN "sentAt" DROP NOT NULL;
      END IF;
    END $$;
  `);
  await queryPool('ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS sent_at VARCHAR(50);');
  await queryPool('ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS error TEXT;');
  await queryPool('ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS sent_at VARCHAR(50);');
  await queryPool('ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS error TEXT;');
  await queryPool('ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS sent_at VARCHAR(50);');
  await queryPool('ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS error TEXT;');
  await queryPool('ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS params JSONB;');
}

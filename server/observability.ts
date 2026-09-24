import crypto from 'crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { queryPool, getPoolInfo } from './db_pool';

/**
 * Dependency-free observability for FleexBid.
 *
 * WHY THIS EXISTS
 *
 * The platform had no error tracking of any kind: a broken code path (the email
 * dispatcher throwing "duplicate key" on every send) went unnoticed for weeks
 * because the only signal was a line on a serverless log stream nobody reads.
 * Worse, some failures were invisible by design - the notification calls are
 * fire-and-forget (`.catch(console.error)`), so an email that never leaves the
 * building produces no user-visible symptom and no durable record.
 *
 * This module adds three things without adding a dependency or a paid service:
 *
 *   1. A request id on every response (`X-Request-Id`), so a user can quote it
 *      and we can find the matching log line / error row.
 *   2. Structured JSON logs for everything that went wrong or ran slow.
 *   3. A durable, de-duplicated error ledger (`app_errors`) that an admin can
 *      read from the UI, plus an optional webhook so an external monitor can
 *      alert on it (set ERROR_WEBHOOK_URL).
 *
 * FAILURE POLICY: observability must never break the request it is observing.
 * Every function here swallows its own errors, and DB writes are throttled per
 * fingerprint so an error storm cannot turn into a database storm.
 */

const SLOW_REQUEST_MS = 2000;
const MESSAGE_LIMIT = 500;
const STACK_LIMIT = 4000;
const DB_WRITE_THROTTLE_MS = 10_000;
const WEBHOOK_THROTTLE_MS = 60_000;
const MAX_TRACKED_FINGERPRINTS = 500;
const WEBHOOK_TIMEOUT_MS = 3000;

export type Level = 'info' | 'warn' | 'error';

/** Structured single-line log. Kept JSON so log drains can index it. */
export function logEvent(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Only segments that are actually identifiers get collapsed. Matching on "is
 * this segment long?" instead was wrong: it turned `/api/auth/login-staff` into
 * `/api/auth/:id` and `/api/auth/login-transporter` into the SAME label, which
 * would have merged two different endpoints into one error bucket and hidden
 * which one was failing.
 */
const ID_SEGMENT = /^(?:\d+|[0-9a-fA-F]{8,}|(?:usr|tr|req|inv|sess|bid|audit|emaillog|walog|smslog)_[A-Za-z0-9_-]+|[A-Z]{2,4}-\d{4}-\d+)$/;

/**
 * Shapes a request into a bounded-cardinality label: `/api/requirements/
 * TR-2026-0009` and `/api/requirements/TR-2026-0014` fold into one bucket,
 * while distinct static paths stay distinct.
 */
function routeLabel(req?: Request): string {
  // A matched route already carries its own parameterised pattern.
  const pattern = (req as any)?.route?.path;
  if (typeof pattern === 'string' && pattern) {
    return `${req!.baseUrl || ''}${pattern}` || pattern;
  }
  const raw = (req as any)?.path || '';
  if (!raw) return 'unknown';
  const collapsed = raw
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
  return collapsed.slice(0, 200) || 'unknown';
}

/**
 * Groups "same error" occurrences. Volatile parts (ids, numbers, timestamps)
 * are masked before hashing so a retry loop cannot create a new row each time.
 */
export function errorFingerprint(message: string, route: string, status: number): string {
  const normalized = message
    .replace(/\b[0-9a-f]{8,}\b/gi, ':id')
    .replace(/\b[A-Za-z]{2,}-\d{4}-\d+\b/g, ':id')
    .replace(/\b\d+\b/g, ':n')
    .slice(0, 300);
  return crypto.createHash('sha256').update(`${status}|${route}|${normalized}`).digest('hex').slice(0, 32);
}

/**
 * Opaque change-detection token for the streaming endpoint: the client receives
 * only the hash, so an SSE payload can never leak the values inside it (the
 * winner's identity is hashed in, but never sent).
 */
export function snapshotToken(parts: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

const lastDbWrite = new Map<string, number>();
const lastWebhook = new Map<string, number>();

function isThrottled(map: Map<string, number>, key: string, windowMs: number): boolean {
  const now = Date.now();
  const previous = map.get(key);
  if (previous !== undefined && now - previous < windowMs) return true;
  // Bounded memory: a pathological error pattern must not grow the map forever.
  if (map.size >= MAX_TRACKED_FINGERPRINTS) map.clear();
  map.set(key, now);
  return false;
}

let errorsTableReady: Promise<void> | null = null;

/**
 * The error ledger is created here rather than only in initDatabase() because
 * production cold starts on an existing schema run ensureIndexes() and never the
 * full DDL (see the same note in server/db.ts). Memoized per process; a failure
 * clears the memo so the next error retries.
 */
function ensureErrorsTable(): Promise<void> {
  if (!errorsTableReady) {
    errorsTableReady = queryPool(`
      CREATE TABLE IF NOT EXISTS app_errors (
        fingerprint VARCHAR(64) PRIMARY KEY,
        message TEXT NOT NULL,
        stack TEXT,
        route VARCHAR(255),
        method VARCHAR(10),
        status_code INTEGER,
        user_id VARCHAR(255),
        role VARCHAR(50),
        request_id VARCHAR(64),
        occurrences INTEGER NOT NULL DEFAULT 1,
        first_seen VARCHAR(50) NOT NULL,
        last_seen VARCHAR(50) NOT NULL,
        resolved BOOLEAN NOT NULL DEFAULT FALSE
      );
    `)
      .then(() => undefined)
      .catch((err) => {
        errorsTableReady = null;
        throw err;
      });
  }
  return errorsTableReady;
}

export interface ErrorContext {
  req?: Request;
  status?: number;
  scope?: string;
  extra?: Record<string, unknown>;
}

/**
 * Records an error: structured log always, durable ledger row (throttled), and
 * an optional webhook. Never throws and never awaits anything a caller must
 * care about - `await reportError(...)` still resolves even if the DB is down.
 */
export async function reportError(error: unknown, ctx: ErrorContext = {}): Promise<void> {
  try {
    const err = error as any;
    const message = String(err?.message || err || 'Unknown error').slice(0, MESSAGE_LIMIT);
    const stack = typeof err?.stack === 'string' ? err.stack.slice(0, STACK_LIMIT) : null;
    const status = Number(ctx.status ?? err?.status ?? err?.statusCode) || 500;
    const route = ctx.scope ? ctx.scope : routeLabel(ctx.req);
    const requestId = (ctx.req as any)?.requestId ?? null;
    const userId = (ctx.req as any)?.user?.id ?? null;
    const role = (ctx.req as any)?.user?.role ?? null;
    const method = ctx.req?.method ?? null;
    const fingerprint = errorFingerprint(message, route, status);

    logEvent('error', 'app_error', {
      fingerprint,
      message,
      status,
      route,
      method,
      requestId,
      userId,
      role,
      scope: ctx.scope,
      stack: stack ? stack.split('\n').slice(0, 3).join(' | ') : undefined,
      ...(ctx.extra || {})
    });

    if (!isThrottled(lastDbWrite, fingerprint, DB_WRITE_THROTTLE_MS)) {
      const now = new Date().toISOString();
      void ensureErrorsTable()
        .then(() =>
          queryPool(
            `INSERT INTO app_errors
               (fingerprint, message, stack, route, method, status_code, user_id, role, request_id, occurrences, first_seen, last_seen, resolved)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10, FALSE)
             ON CONFLICT (fingerprint) DO UPDATE SET
               occurrences = app_errors.occurrences + 1,
               last_seen = EXCLUDED.last_seen,
               request_id = EXCLUDED.request_id,
               user_id = COALESCE(EXCLUDED.user_id, app_errors.user_id),
               stack = COALESCE(EXCLUDED.stack, app_errors.stack),
               status_code = EXCLUDED.status_code,
               resolved = FALSE`,
            [fingerprint, message, stack, route, method, status, userId, role, requestId, now]
          )
        )
        .catch(() => {
          /* the ledger is best-effort: the structured log above is the floor */
        });
    }

    const webhook = process.env.ERROR_WEBHOOK_URL;
    if (webhook && !isThrottled(lastWebhook, fingerprint, WEBHOOK_THROTTLE_MS)) {
      void fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `text` is Slack-compatible; the rest is for generic ingests.
        body: JSON.stringify({
          text: `FleexBid error [${fingerprint}] ${method || ''} ${route} -> ${status}: ${message}`,
          fingerprint,
          message,
          route,
          method,
          status,
          requestId,
          userId,
          environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown'
        }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
      }).catch(() => {});
    }
  } catch {
    /* never let observability throw into the caller */
  }
}

export interface ErrorRow {
  fingerprint: string;
  message: string;
  stack: string | null;
  route: string | null;
  method: string | null;
  statusCode: number | null;
  userId: string | null;
  role: string | null;
  requestId: string | null;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  resolved: boolean;
}

export async function listErrors(limit: number, includeResolved: boolean): Promise<ErrorRow[]> {
  try {
    await ensureErrorsTable();
    const res = await queryPool(
      `SELECT fingerprint, message, stack, route, method, status_code, user_id, role, request_id,
              occurrences, first_seen, last_seen, resolved
         FROM app_errors
        WHERE ($1::boolean OR resolved = FALSE)
        ORDER BY last_seen DESC
        LIMIT $2`,
      [includeResolved, limit]
    );
    // Mapped explicitly rather than trusting the pool's key normalizer: that
    // normalizer is a FIXED lowercase->camelCase map for known business columns
    // (server/db_pool.ts), so an unlisted `status_code` stays snake_case and the
    // field silently reads as undefined through a camelCase interface.
    return res.rows.map((row: any): ErrorRow => ({
      fingerprint: row.fingerprint,
      message: row.message,
      stack: row.stack ?? null,
      route: row.route ?? null,
      method: row.method ?? null,
      statusCode: row.status_code ?? row.statusCode ?? null,
      userId: row.user_id ?? row.userId ?? null,
      role: row.role ?? null,
      requestId: row.request_id ?? row.requestId ?? null,
      occurrences: Number(row.occurrences) || 0,
      firstSeen: row.first_seen ?? row.firstSeen ?? null,
      lastSeen: row.last_seen ?? row.lastSeen ?? null,
      resolved: !!row.resolved
    }));
  } catch {
    return [];
  }
}

export async function resolveError(fingerprint: string): Promise<boolean> {
  try {
    await ensureErrorsTable();
    const res = await queryPool(
      'UPDATE app_errors SET resolved = TRUE WHERE fingerprint = $1',
      [fingerprint]
    );
    return (res.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Installs the request-id middleware. MUST be registered before any route so
 * every response - including 4xx/5xx from middleware - carries the id.
 */
export function attachRequestContext(app: Express) {
  app.use((req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && /^[A-Za-z0-9._-]{6,64}$/.test(incoming)
      ? incoming
      : crypto.randomBytes(8).toString('hex');
    (req as any).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const startedAt = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - startedAt;
      // Successful fast requests are the overwhelming majority and would drown
      // the log; only record what an operator would actually act on.
      if (res.statusCode < 400 && ms < SLOW_REQUEST_MS) return;
      logEvent(res.statusCode >= 500 ? 'error' : 'warn', 'http_request', {
        requestId,
        method: req.method,
        route: routeLabel(req),
        status: res.statusCode,
        ms,
        userId: (req as any)?.user?.id ?? null
      });
    });
    next();
  });
}

/**
 * Terminal error handler. Must be registered AFTER every route. 5xx bodies stay
 * generic so internal messages and stack traces never reach a client, while the
 * request id is returned so a report can be correlated with the ledger.
 */
export function attachErrorHandler(app: Express) {
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    const status = Number(err?.status || err?.statusCode) || 500;
    void reportError(err, { req, status });

    if (res.headersSent) return next(err);
    if (status >= 500) {
      return res.status(status).json({ error: 'Internal server error', requestId: (req as any).requestId });
    }
    return res.status(status).json({ error: err?.message || 'Request failed', requestId: (req as any).requestId });
  });
}

/**
 * Captures stray rejections so a background failure (a fire-and-forget
 * notification, a cache write) is recorded instead of vanishing - and so it
 * cannot take down the whole serverless invocation.
 *
 * `uncaughtException` is deliberately NOT handled: resuming after one is unsafe,
 * and Node's default (log + exit, with the platform recycling the worker) is the
 * correct behaviour for a synchronous fault.
 */
export function captureProcessErrors() {
  process.on('unhandledRejection', (reason) => {
    void reportError(reason, { scope: 'unhandledRejection' });
  });
}

export interface HealthReport {
  ok: boolean;
  time: string;
  uptimeSeconds: number;
  environment: string;
  commit: string | null;
  region: string | null;
  checks: {
    database: { ok: boolean; latencyMs: number | null; error?: string };
    cronSecretConfigured: boolean;
    errorWebhookConfigured: boolean;
    pool: { total: number; idle: number; waiting: number };
  };
}

/**
 * Cheap, secret-free liveness/readiness snapshot for an uptime monitor. Reports
 * only booleans about configuration, never the values themselves.
 */
export async function healthReport(): Promise<HealthReport> {
  const startedAt = Date.now();
  let database: HealthReport['checks']['database'] = { ok: false, latencyMs: null };
  try {
    await queryPool('SELECT 1');
    database = { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err: any) {
    database = {
      ok: false,
      latencyMs: null,
      error: String(err?.message || 'database unreachable').slice(0, 200)
    };
  }

  let pool = { total: 0, idle: 0, waiting: 0 };
  try {
    const info = getPoolInfo();
    pool = { total: info.totalCount, idle: info.idleCount, waiting: info.waitingCount };
  } catch {
    /* informational only */
  }

  return {
    ok: database.ok,
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || null,
    region: process.env.VERCEL_REGION || null,
    checks: {
      database,
      cronSecretConfigured: !!process.env.CRON_SECRET,
      errorWebhookConfigured: !!process.env.ERROR_WEBHOOK_URL,
      pool
    }
  };
}

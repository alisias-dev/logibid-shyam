import type { Request, Response, NextFunction } from 'express';
import { queryPool } from './db_pool';

// The rate_limits table may not exist yet when the first request arrives (the
// schema migration runs on cold start and can race the first live request). The
// limiter is therefore self-healing: it lazily creates the table + index on
// first use and retries once when a query reports the table is missing.
let tableReady: Promise<void> | null = null;

function ensureRateLimitTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await queryPool(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          key VARCHAR(255) PRIMARY KEY,
          window_start TIMESTAMPTZ NOT NULL,
          count INTEGER NOT NULL,
          limit_value INTEGER NOT NULL,
          window_seconds INTEGER NOT NULL
        );
      `);
      await queryPool('CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);');
    })().catch((err) => {
      // Allow a later request to retry the bootstrap instead of caching a failure.
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

// ============================================================================
// Distributed, database-backed rate limiting (Phase 3)
// ----------------------------------------------------------------------------
// The old express-rate-limit middlewares were process-local: on Vercel every
// cold lambda started with an empty counter, so a determined attacker could
// simply wait for a fresh instance (or spray across instances) to bypass the
// limit entirely. The rate_limits table below is shared state - a limit trip
// in one lambda is honored by every other instance, including cold starts.
//
// Design notes:
//  * One atomic INSERT ... ON CONFLICT DO UPDATE per request (autocommit, no
//    explicit transaction) - safe under Neon's pooled endpoint because each
//    statement is its own transaction.
//  * Fixed window per key: the row records when the window started; when a
//    request arrives after window_start + window_seconds the counter resets
//    to 1 and the window slides forward.
//  * Fail-OPEN: if the database is unreachable (cold-start pool contention,
//    Neon compute waking up) we LOG and ALLOW the request. Rate limiting is a
//    DoS mitigation, not a data-integrity guarantee - a blip must never take
//    the whole API down with 500s.
//  * Lazy cleanup: expired rows are deleted opportunistically on a small
//    fraction of checks (no background timer survives serverless sleep).
// ============================================================================

interface DbRateLimiterOptions {
  /** Unique bucket name, e.g. 'login', 'bid', 'requirements', 'ai' */
  name: string;
  /** Window length in milliseconds */
  windowMs: number;
  /** Maximum requests allowed per key inside the window */
  max: number;
  /** 429 response body message */
  message: string;
  /** When true, key by the authenticated user id (falls back to IP). */
  keyByUser?: boolean;
}

export function dbRateLimiter(options: DbRateLimiterOptions) {
  const { name, windowMs, max, message, keyByUser = false } = options;
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  // Opportunistic cleanup every ~1/64 of checks (keeps the table bounded
  // without a dedicated sweeper process that serverless never runs).
  let checkCounter = 0;

  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    // Identity: authenticated user id (stable per account) or client IP.
    const identity = keyByUser && req.user?.id ? req.user.id : (req.ip || req.socket?.remoteAddress || 'unknown');
    const bucketKey = `${name}:${identity}`;

    try {
      // Ensure the table exists before the first increment (self-healing - the
      // schema migration can race the first live request on a cold start).
      await ensureRateLimitTable();

      // Single atomic statement: create the row, or roll the window + increment.
      const result = await queryPool(
        `INSERT INTO rate_limits (key, window_start, count, limit_value, window_seconds)
         VALUES ($1, now(), 1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE
             WHEN rate_limits.window_start < now() - (rate_limits.window_seconds || ' seconds')::interval
               THEN 1
             ELSE rate_limits.count + 1
           END,
           window_start = CASE
             WHEN rate_limits.window_start < now() - (rate_limits.window_seconds || ' seconds')::interval
               THEN now()
             ELSE rate_limits.window_start
           END
         RETURNING count, limit_value, window_start`,
        [bucketKey, max, windowSeconds]
      );

      const row = result.rows[0];
      const count = row ? parseInt(row.count, 10) : 1;
      const limit = row ? parseInt(row.limit_value, 10) : max;
      const windowStart: Date | null = row?.windowStart || row?.window_start || null;

      // Standard rate-limit headers (RateLimit-* draft spec, same names the old
      // express-rate-limit emitted).
      res.setHeader('RateLimit-Limit', String(limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - count)));
      if (windowStart) {
        res.setHeader('RateLimit-Reset', String(Math.floor((windowStart.getTime() + windowMs) / 1000)));
      }

      // Opportunistic sweep of expired windows (~1.5% of checks).
      if (++checkCounter % 64 === 1) {
        queryPool(`DELETE FROM rate_limits WHERE window_start < now() - (window_seconds || ' seconds')::interval`)
          .catch((err) => console.error('Rate-limit sweep failed:', err));
      }

      if (count > limit) {
        return res.status(429).json({ error: message });
      }
      return next();
    } catch (error: any) {
      // Fail-OPEN: never break the API because rate limiting couldn't reach the DB.
      console.error(`Rate limiter (${name}) DB check failed - allowing request:`, error?.message || error);
      return next();
    }
  };
}

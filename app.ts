import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cookieParser from 'cookie-parser';
import path from 'path';
import bcrypt from 'bcryptjs';
import { createServer as createViteServer } from 'vite';

import {
  getDB,
  writeDB,
  generateId,
  onDBWrite,
  initDatabase,
  ensureIndexes,
  getUserByEmail,
  getUserById,
  getAllUsers,
  getTransporterByEmail,
  getTransporterById,
  getAllTransporters,
  getTransportersByIds,
  transporterIdsExist,
  getRequirementById,
  getInvitationsForRequirement,
  hasInvitation,
  getBidsForRequirement,
  getBidFor,
  getBidById,
  getAwardForRequirement,
  getRequirementsWithAwards,
  getVisibleRequirementsForTransporter,
  getSessionById,
  getSessionsForUser,
  getNotificationConfig,
  getAuditLogsPage,
  getNotificationLogs,
  getExpiredLiveRequirements,
  cleanupExpiredSessions
} from './server/db';
import { queryPool, getPoolInfo } from './server/db_pool';
import { dbRateLimiter } from './server/rate-limit';
import { 
  createSession, 
  rotateSession, 
  revokeSession, 
  verifyToken
} from './server/auth';
import { 
  sendSms,
  sendEmail,
  notifyPublishedRequirement, 
  notifyAwardedBid, 
  notifyLostBid
} from './server/notifications';
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
  TransporterRank,
  RequirementStatus,
  UserRole,
  VEHICLE_TYPES
} from './src/types';
import aiRouter from './server/ai-router';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Enforce strict environment validation at launch
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
if (isProduction) {
  if (!process.env.DATABASE_URL) {
    throw new Error('CRITICAL CONFIGURATION ERROR: DATABASE_URL environment variable is undefined at production runtime.');
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('CRITICAL CONFIGURATION ERROR: JWT_SECRET must be set to a strong secret (32+ characters) at production runtime.');
  }
}

// Explicit cross-origin allowlist. The server NEVER reflects arbitrary origins
// with credentials - doing so would let any website read authenticated data.
const ALLOWED_ORIGINS: string[] = Array.from(
  new Set(
    [
      ...(process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(o => o.trim().replace(/\/$/, ''))
        .filter(Boolean),
      ...(process.env.APP_URL ? [process.env.APP_URL.replace(/\/$/, '')] : [])
    ]
  )
);

function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true; // Same-origin / non-browser request
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Local development servers are allowed ONLY outside production. In
  // production the allowlist is strict (APP_URL / ALLOWED_ORIGINS only) so a
  // malicious localhost site cannot make credentialed requests.
  if (!isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

// Self-initializing database runner for serverless environments.
// The full initDatabase() DDL is expensive (~25 statements) and repeatedly
// timed out against Neon's pooled endpoint on cold starts. We now run it only
// when the core tables are actually missing - a single cheap catalog query
// on warm databases.
let isDbInitialized = false;
async function ensureDbInitialized() {
  if (isDbInitialized) return;
  try {
    const res = await queryPool(
      "SELECT to_regclass('public.users') AS users_tbl, to_regclass('public.bids') AS bids_tbl, to_regclass('public.sessions') AS sessions_tbl"
    );
    const row = res.rows && res.rows[0];
    // NOTE: queryPool's key normalizer does NOT camelCase arbitrary aliases, so
    // the aliases stay snake_case (users_tbl, bids_tbl, sessions_tbl). Reading
    // row.usersTbl here was ALWAYS undefined - which made the check always
    // report "schema missing" and re-run the full schema DDL on every cold
    // start (the DDL storms). Use the snake_case keys.
    const schemaMissing = !row || !row.users_tbl || !row.bids_tbl || !row.sessions_tbl;
    if (schemaMissing) {
      console.log('Core tables missing - running full database initialization...');
      await initDatabase();
    } else {
      console.log('Database schema already present; skipping initialization.');
      // Idempotent index/column migrations reach existing databases too.
      await ensureIndexes();
    }
    isDbInitialized = true;
  } catch (err) {
    // A connectivity blip (Neon compute waking up, pool contention during a
    // cold-start burst) must NOT be treated as "schema missing". Doing so
    // caused every request in a cold lambda to re-run the FULL schema DDL, and
    // simultaneous cold lambdas produced concurrent DDL storms -> connection
    // timeouts -> transient 500s. Assume the schema exists (it does in every
    // production deployment) and continue; the check retries next cold start.
    console.error('Database initialization check failed (assuming schema present, continuing):', err);
    isDbInitialized = true;
  }
}

// Trigger initialization in background on load
ensureDbInitialized();

// Register database check as Express middleware
app.use(async (req, res, next) => {
  await ensureDbInitialized();
  next();
});
const server = http.createServer(app);
const PORT = 3000;

// Initialize Socket.io with the same origin policy as the HTTP API
const io = new SocketIOServer(server, {
  cors: {
    origin: (origin, callback) => {
      callback(null, isAllowedOrigin(origin || undefined));
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Strict CORS: only allow listed origins to read responses. Requests without an
// Origin header (same-origin / curl) are always permitted.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-refresh-token, x-device-id');
  
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Baseline security headers. A strict CSP is only applied in production because
// Vite's dev server relies on looser policy.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
  }
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Dynamic helper to get cookie options. Cookies are always SameSite=Lax so a
// cross-site page cannot drive authenticated requests (CSRF protection); they
// are only sent over HTTPS in production.
function getCookieOptions(req: express.Request, maxAge: number) {
  const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  return {
    httpOnly: true,
    secure: isProd ? true : (req.secure || req.headers['x-forwarded-proto'] === 'https'),
    // SameSite=Strict: the cookie is never sent on cross-site requests, so a
    // foreign page cannot drive authenticated requests (defense in depth on
    // top of the CORS allowlist).
    sameSite: 'strict' as const,
    maxAge
  };
}

// Simple cache for app url
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Sanity cap for bid amounts (₹10 crore) to reject absurd/overflow values
const MAX_BID_AMOUNT = 100_000_000;

/**
 * Thrown inside serialized writeDB() updaters when a bid is invalid against the
 * FRESH committed state (e.g. auction closed or reduction rule violated by a
 * concurrent bid). The handler maps it to a 400 response.
 */
class BidValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BidValidationError';
  }
}

// Advisory-lock key for the auction auto-close pass (must match across instances)

/**
 * Strip passwordHash from user/transporter records before they leave the API.
 */
function stripSecrets<T extends Record<string, any>>(record: T): Omit<T, 'passwordHash'> {
  const { passwordHash, ...rest } = record;
  return rest as Omit<T, 'passwordHash'>;
}

/**
 * Redact secrets embedded in JSON audit-log payloads.
 */
function redactSecrets(jsonStr: string | null): string | null {
  if (!jsonStr) return jsonStr;
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed === 'object') {
      if ('passwordHash' in parsed) parsed.passwordHash = '[REDACTED]';
    }
    return JSON.stringify(parsed);
  } catch {
    return jsonStr;
  }
}

/**
 * Resolve the authenticated user for a socket handshake token.
 * Returns null for invalid/expired/blocked credentials.
 */
async function resolveSocketUser(token: string): Promise<Express.Request['user'] | null> {
  try {
    const decoded = verifyToken(token) as { id: string; email: string; role: UserRole; name: string; jti?: string };
    if (!decoded || !decoded.id || !decoded.role) return null;

    // jti binding: the token must reference a live session row (see
    // authenticate). Revoked sessions reject the socket handshake too.
    if (!decoded.jti) return null;
    const session = await getSessionById(decoded.jti);
    if (!session || new Date(session.expiry) <= new Date()) return null;

    if (decoded.role !== 'TRANSPORTER') {
      const staff = await getUserById(decoded.id);
      if (!staff) return null;
      const statusLower = (staff.status || '').toLowerCase();
      if (statusLower === 'blocked') return null;
      if (statusLower !== 'authorized' && statusLower !== 'approved' && statusLower !== 'active') return null;
      return { id: decoded.id, email: decoded.email, role: decoded.role, name: decoded.name, status: staff.status };
    } else {
      const transporter = await getTransporterById(decoded.id);
      if (!transporter) return null;
      const statusLower = (transporter.status || '').toLowerCase();
      if (statusLower === 'blocked' || statusLower === 'inactive') return null;
      return { id: decoded.id, email: decoded.email, role: decoded.role, name: decoded.name, status: transporter.status };
    }
  } catch (error) {
    return null;
  }
}

// Authenticate every socket connection. Unauthenticated clients are rejected at
// the handshake instead of being allowed to eavesdrop on auction events.
io.use(async (socket, next) => {
  const token =
    (socket.handshake.auth && socket.handshake.auth.token) ||
    (socket.handshake.headers && (socket.handshake.headers as any).cookie?.match(/(?:^|;\s*)accessToken=([^;]+)/)?.[1]);
  if (!token) {
    return next(new Error('Unauthorized: Access token missing'));
  }
  const user = await resolveSocketUser(token);
  if (!user) {
    return next(new Error('Unauthorized: Invalid access token'));
  }
  socket.data.user = user;
  next();
});

// Global Socket Io namespace - joins are authorized per requirement
io.on('connection', (socket) => {
  socket.on('join_requirement', async (requirementId: string) => {
    const user = socket.data.user;
    if (!user || typeof requirementId !== 'string') return;

    try {
      const reqItem = await getRequirementById(requirementId);
      if (!reqItem) return;

      if (user.role === 'TRANSPORTER') {
        // Transporters may only join auctions they are allowed to participate in
        const isPublic = !reqItem.targeted_transporter_ids || reqItem.targeted_transporter_ids.length === 0;
        const isTargeted = reqItem.targeted_transporter_ids && reqItem.targeted_transporter_ids.includes(user.id);
        const isInvited = await hasInvitation(requirementId, user.id);
        const hasBid = !!(await getBidFor(requirementId, user.id));
        const award = await getAwardForRequirement(requirementId);
        const hasAward = !!(award && award.transporterId === user.id);
        if (!isPublic && !isTargeted && !isInvited && !hasBid && !hasAward) return;
      }

      socket.join(`req_${requirementId}`);
    } catch (error) {
      console.error('Socket join_requirement error:', error);
    }
  });
  
  socket.on('leave_requirement', (requirementId) => {
    socket.leave(`req_${requirementId}`);
  });
});

/**
 * Global Audit Logger helper
 */
async function logAudit(
  userId: string | null,
  userEmail: string | null,
  role: UserRole | null,
  action: string,
  req: express.Request,
  oldValue: string | null = null,
  newValue: string | null = null
) {
  const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || null;
  const device = req.headers['user-agent'] || null;

  // Append-only audit trail: a single targeted INSERT. Audit logging must never
  // be coupled to (or block on) the domain write serialization, and it does not
  // need a snapshot diff - the row is immutable once written.
  await queryPool(
    `INSERT INTO audit_logs (id, user_id, user_email, role, action, timestamp, ip_address, device, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [generateId('audit'), userId, userEmail, role, action, new Date().toISOString(), ipAddress, device, oldValue, newValue]
  );
}

// ============================================================================
// SYSTEM SECURITY & HARDENING MIDDLEWARES
// ============================================================================

// Global unhandled process error catches to guarantee absolute system resilience
process.on('uncaughtException', (error) => {
  console.error('Critical Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Critical Unhandled Rejection at:', promise, 'reason:', reason);
});

// Highly efficient, stateless, in-memory auth cache to prevent parsing db.json repeatedly for 1000 concurrent users
interface AuthCacheEntry {
  user: {
    id: string;
    email: string;
    role: UserRole;
    name: string;
    status: string;
  };
  expiry: number;
}
const authCache = new Map<string, AuthCacheEntry>();

// Instantly invalidate authentication caches on database modifications to ensure 100% database consistency
onDBWrite(() => {
  authCache.clear();
});

// Clean up expired cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of authCache.entries()) {
    if (entry.expiry < now) {
      authCache.delete(token);
    }
  }
}, 10000); // Check every 10 seconds

// Distributed rate limiters backed by the rate_limits table - limits persist
// across serverless cold starts (an in-memory limiter resets on every new
// lambda, so spraying across instances could bypass it). Keys are per-user id
// when authenticated (stable identity), per-IP otherwise. See server/rate-limit.ts.
const loginLimiter = dbRateLimiter({
  name: 'login',
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: 'Too many login attempts. Please try again after 15 minutes.'
});

const biddingLimiter = dbRateLimiter({
  name: 'bid',
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300,
  keyByUser: true,
  message: 'Too many bidding requests. Please rate limit your API calls.'
});

const requirementsLimiter = dbRateLimiter({
  name: 'req',
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 500,
  keyByUser: true,
  message: 'Too many requests for requirement resources. Please slow down.'
});

// AI endpoints call paid Gemini APIs - cap usage to prevent cost abuse
const aiLimiter = dbRateLimiter({
  name: 'ai',
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  keyByUser: true,
  message: 'Too many AI requests. Please slow down.'
});

/**
 * Authentication Middleware
 */
async function authenticate(req: express.Request, res: express.Response, next: express.NextFunction) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }
  if (!token) {
    token = req.cookies?.accessToken;
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Access token missing' });
  }

  // 1. Efficient In-Memory Cache Check for Stateless Authorization Lookup
  const cached = authCache.get(token);
  if (cached && cached.expiry > Date.now()) {
    req.user = cached.user;
    return next();
  }

  try {
    const decoded = verifyToken(token) as { id: string; email: string; role: UserRole; name: string; jti?: string };

    // SESSION-SPECIFIC revocation: the access token carries jti = the session
    // id it was issued for. The token is only valid while THAT session row
    // exists - so logout (which deletes the row) kills the token immediately,
    // closing the old "any session for this user validates every token" gap.
    if (!decoded.jti) {
      return res.status(401).json({ error: 'Unauthorized: Invalid access token' });
    }
    const session = await getSessionById(decoded.jti);
    if (!session || new Date(session.expiry) <= new Date()) {
      return res.status(401).json({ error: 'Unauthorized: Session revoked or expired' });
    }
    const sessionValid = decoded.role === 'TRANSPORTER'
      ? session.transporterId === decoded.id
      : session.userId === decoded.id;
    if (!sessionValid) {
      return res.status(401).json({ error: 'Unauthorized: Session revoked or expired' });
    }

    let finalStatus = '';

    // Verify status from live database to enforce blocks/permissions immediately
    if (decoded.role !== 'TRANSPORTER') {
      const staffUser = await getUserById(decoded.id);
      if (!staffUser) {
        return res.status(401).json({ error: 'Unauthorized: Staff account not found' });
      }
      
      const statusLower = (staffUser.status || '').toLowerCase();
      if (statusLower === 'blocked') {
        // Invalidate active sessions for the blocked user directly in the database
        await queryPool('DELETE FROM sessions WHERE user_id = $1', [decoded.id]);
        authCache.delete(token);
        return res.status(403).json({ error: "Access Denied: Your account is blocked. Please contact the administrator." });
      }
      
      if (statusLower !== 'authorized' && statusLower !== 'approved' && statusLower !== 'active') {
        return res.status(403).json({ error: "Access Denied: Your staff account has not been authorized by the Admin." });
      }
      
      finalStatus = staffUser.status;
      req.user = {
        ...decoded,
        status: staffUser.status
      };
    } else {
      const transporter = await getTransporterById(decoded.id);
      if (!transporter) {
        return res.status(401).json({ error: 'Unauthorized: Transporter account not found' });
      }
      
      const statusLower = (transporter.status || '').toLowerCase();
      if (statusLower === 'blocked' || statusLower === 'inactive') {
        // Invalidate active sessions for blocked transporter directly in the database
        await queryPool('DELETE FROM sessions WHERE transporter_id = $1', [decoded.id]);
        authCache.delete(token);
        return res.status(403).json({ error: "Access Denied: Your account is blocked. Please contact the administrator." });
      }
      
      finalStatus = transporter.status;
      req.user = {
        ...decoded,
        status: transporter.status
      };
    }

    // Cache verified session to dramatically reduce database read burden
    authCache.set(token, {
      user: {
        id: decoded.id,
        email: decoded.email,
        role: decoded.role,
        name: decoded.name,
        status: finalStatus
      },
      expiry: Date.now() + 15000 // Cache for 15 seconds
    });

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid access token' });
  }
}

/**
 * Role authorization guard
 */
function authorize(roles: UserRole[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }

    // Check if staff member is in "approved" (spectator) mode
    if (req.user.role !== 'TRANSPORTER') {
      const statusLower = (req.user.status || '').toLowerCase();
      if (statusLower === 'approved') {
        const isMutative = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
        const isAuthRoute = req.path.startsWith('/api/auth/') || req.path === '/api/auth/logout';
        if (isMutative && !isAuthRoute) {
          return res.status(403).json({ error: "Spectator Mode: You must be an Authorized staff member to perform this action." });
        }
      }
    }

    next();
  };
}

// Extend Express Request interface to hold user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: UserRole;
        name: string;
        status?: string;
      };
    }
  }
}

/**
 * Calculate standard competition ranking (1-2-2-4).
 * Pass dbOverride to compute ranks against a specific (e.g. fresh in-transaction)
 * snapshot instead of the shared cached read.
 */
export async function calculateRanks(requirementId: string, dbOverride?: any): Promise<TransporterRank[]> {
  let invitations: any[];
  let reqBids: Bid[];
  let transportersById: Map<string, Transporter>;

  if (dbOverride) {
    // In-transaction snapshot (called from inside a serialized writeDB): use the
    // fresh committed state directly - no extra database round trips.
    const req = dbOverride.requirements.find((r: any) => r.id === requirementId);
    if (!req) return [];
    invitations = dbOverride.requirementInvitations.filter(
      (i: any) => i.requirementId === requirementId && i.status === 'INVITED'
    );
    reqBids = dbOverride.bids.filter((b: Bid) => b.requirementId === requirementId);
    transportersById = new Map(dbOverride.transporters.map((t: Transporter) => [t.id, t]));
  } else {
    // Standalone route read: targeted queries only - one auction's invitations,
    // its bids, and the participating companies. No full-table scans.
    const req = await getRequirementById(requirementId);
    if (!req) return [];
    invitations = (await getInvitationsForRequirement(requirementId)).filter(i => i.status === 'INVITED');
    reqBids = await getBidsForRequirement(requirementId);
    const allIds = Array.from(new Set([
      ...invitations.map(i => i.transporterId),
      ...reqBids.map(b => b.transporterId)
    ]));
    const transports = await getTransportersByIds(allIds);
    transportersById = new Map(transports.map(t => [t.id, t]));
  }

  const invitedTransporterIds = invitations.map(i => i.transporterId);
  const biddingTransporterIds = reqBids.map(b => b.transporterId);

  // Combine invited and bidding transporters
  const allTransporterIds = Array.from(new Set([...invitedTransporterIds, ...biddingTransporterIds]));

  // Build ranking list for all participating/invited transporters
  const ranks: TransporterRank[] = allTransporterIds.map(transporterId => {
    const trans = transportersById.get(transporterId);
    const bid = reqBids.find(b => b.transporterId === transporterId);
    
    return {
      transporterId,
      companyName: trans ? trans.companyName : 'Unknown',
      amount: bid ? bid.amount : null,
      rank: null,
      timestamp: bid ? bid.timestamp : null,
      isL1: false,
      status: bid ? 'SUBMITTED' : 'PENDING'
    };
  });

  // Sort actual bids ascending by amount
  const submittedBids = ranks.filter(r => r.amount !== null) as (TransporterRank & { amount: number })[];
  submittedBids.sort((a, b) => a.amount - b.amount);

  // Standard competition ranking (1-2-2-4): rank = 1 + count of strictly cheaper
  // bids. Computed in O(n) over the sorted list instead of the previous O(n^2)
  // filter-inside-loop approach, so large auctions stay fast.
  const firstIndexOfAmount = new Map<number, number>();
  submittedBids.forEach((bid, index) => {
    if (!firstIndexOfAmount.has(bid.amount)) {
      firstIndexOfAmount.set(bid.amount, index);
    }
  });
  submittedBids.forEach((curr) => {
    curr.rank = firstIndexOfAmount.get(curr.amount)! + 1;
    curr.isL1 = curr.rank === 1;
  });

  // Merge ranked bids back into invited list
  const rankedById = new Map(submittedBids.map(s => [s.transporterId, s]));
  ranks.forEach(r => {
    const ranked = rankedById.get(r.transporterId);
    if (ranked) {
      r.rank = ranked.rank;
      r.isL1 = ranked.isL1;
    }
  });

  // Sort overall: submitted bids by rank, then unsubmitted alphabetically
  ranks.sort((a, b) => {
    if (a.amount !== null && b.amount === null) return -1;
    if (a.amount === null && b.amount !== null) return 1;
    if (a.amount !== null && b.amount !== null) {
      return (a.rank || 999) - (b.rank || 999);
    }
    return a.companyName.localeCompare(b.companyName);
  });

  return ranks;
}

/**
 * Close requirements on expiry and execute AUTOMATIC awarding when configured.
 *
 * Each expired auction is handled in ONE atomic, serialized writeDB call:
 *  - pg_advisory_xact_lock inside writeDB serializes across ALL lambda
 *    instances (session-level locks are unusable on Neon's pooled endpoint),
 *  - the FRESH status re-check makes closure exactly-once (a second racing
 *    instance becomes a no-op and skips duplicate notifications),
 *  - the winner is recomputed from the FRESH in-transaction snapshot, so a
 *    bid that landed milliseconds before close is never missed (no stale
 *    winning bids).
 */
async function autoCloseAndAwardRequirements() {
  try {
    const now = new Date();

    // Targeted read: only LIVE auctions whose closing time has passed - no
    // full-table scan of the requirements table.
    const expiredLive = await getExpiredLiveRequirements(now);

    for (const req of expiredLive) {
      console.log(`Auto-closing requirement ${req.id} due to expiry...`);

      const result = await writeDB(async (dbStore) => {
        const targetReq = dbStore.requirements.find(r => r.id === req.id);
        // Already closed/awarded by another instance - exactly-once guard.
        if (!targetReq || targetReq.status !== 'LIVE') return null;

        // Winner decision from the FRESH committed snapshot (not the outer
        // possibly-stale read).
        const ranks = await calculateRanks(req.id, dbStore);
        const l1Bids = ranks.filter(r => r.isL1 && r.amount !== null);

        if (targetReq.awardType === 'AUTOMATIC' && l1Bids.length === 1) {
          const winner = l1Bids[0];
          dbStore.awards.push({
            id: generateId('award'),
            requirementId: req.id,
            transporterId: winner.transporterId,
            amount: winner.amount!,
            awardedAt: now.toISOString(),
            awardedBy: 'SYSTEM_AUTO',
            tieBreakLog: null
          });
          targetReq.status = 'AWARDED';
          return { status: 'AWARDED', winner: { transporterId: winner.transporterId, amount: winner.amount! }, ranks };
        }

        if (targetReq.awardType === 'AUTOMATIC' && l1Bids.length > 1) {
          // L1 tie - automatic award paused, manual tie-resolution gate.
          targetReq.status = 'TIE_RESOLUTION_REQUIRED';
          return { status: 'TIE_RESOLUTION_REQUIRED', winner: null, ranks };
        }

        // No bids, or MANUAL award type -> plain close.
        targetReq.status = 'CLOSED';
        return { status: 'CLOSED', winner: null, ranks };
      }, {
        // Phase 2: per-auction lock key + row-level lock on THIS requirement only
        // - different auctions close concurrently without blocking each other.
        lockKeys: [`auction:${req.id}`],
        lockRequirementIds: [req.id],
        requirementScope: [req.id],
        tables: ['requirements', 'requirementInvitations', 'bids', 'transporters', 'awards']
      });

      if (!result) continue; // another instance already closed this auction

      // Append-only audit trail, recorded AFTER the atomic state transition (the
      // winner + status are committed together; the audit row is telemetry).
      const auditAction =
        result.status === 'AWARDED'
          ? `AUTO_AWARDED: Requirement ${req.id} -> ${result.winner!.transporterId} @ ₹${result.winner!.amount}`
          : result.status === 'TIE_RESOLUTION_REQUIRED'
            ? `AUTO_AWARD_PAUSED_TIE_DETECTED: Requirement ${req.id}`
            : `AUTO_CLOSED: Requirement ${req.id}`;
      await queryPool(
        `INSERT INTO audit_logs (id, user_id, user_email, role, action, timestamp, ip_address, device, old_value, new_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [generateId('audit'), 'SYSTEM', 'system@fleexbid.com', null, auditAction, now.toISOString(), null, null, 'LIVE', result.status]
      ).catch((err) => console.error('Auto-close audit insert failed:', err));

      // Post-commit notifications (fire-and-forget - the award itself is committed).
      if (result.status === 'AWARDED' && result.winner) {
        const [winTrans] = await getTransportersByIds([result.winner!.transporterId]);
        if (winTrans) {
          notifyAwardedBid(req, winTrans, result.winner.amount, APP_URL).catch(console.error);
        }
        const loserIds = result.ranks
          .filter(r => r.transporterId !== result.winner!.transporterId && r.amount !== null)
          .map(r => r.transporterId);
        const loseTransports = await getTransportersByIds(loserIds);
        for (const loseTrans of loseTransports) {
          notifyLostBid(req, loseTrans).catch(console.error);
        }
        io.to(`req_${req.id}`).emit('rank_updated', { requirementId: req.id });
        io.emit('requirement_updated', { id: req.id, status: 'AWARDED' });
      } else if (result.status === 'TIE_RESOLUTION_REQUIRED') {
        io.to(`req_${req.id}`).emit('rank_updated', { requirementId: req.id });
        io.emit('requirement_updated', { id: req.id, status: 'TIE_RESOLUTION_REQUIRED' });
      } else {
        io.emit('requirement_updated', { id: req.id, status: 'CLOSED' });
      }
    }
  } catch (error) {
    console.error('Error in auto close check:', error);
  }
}
// Guarded runner used by both the background interval and lazy request-time
// checks so expired auctions are closed exactly once even under concurrency.
let isClosingCheckRunning = false;
async function maybeAutoCloseExpired() {
  if (isClosingCheckRunning) return;
  isClosingCheckRunning = true;
  try {
    await autoCloseAndAwardRequirements();
  } catch (error) {
    console.error('Error in lazy auto-close check:', error);
  } finally {
    isClosingCheckRunning = false;
  }
}

// Garbage collection for expired sessions. Runs on the same cadence as the
// auto-close pass but is THROTTLED to at most once per hour - session rows are
// low-volume and only accumulate when users abandon devices without logging
// out. The throttle matters because the lazy auto-close can fire on every
// requirements request under serverless load.
let lastSessionCleanup = 0;
async function maybeCleanupExpiredSessions() {
  const now = Date.now();
  if (now - lastSessionCleanup < 60 * 60 * 1000) return;
  lastSessionCleanup = now;
  try {
    const removed = await cleanupExpiredSessions();
    if (removed > 0) console.log(`Session GC: removed ${removed} expired row(s)`);
  } catch (error) {
    console.error('Session GC failed:', error);
  }
}

// Background loop for always-on (self-hosted / VM) deployments.
if (!process.env.VERCEL) {
  setInterval(maybeAutoCloseExpired, 10000); // Check every 10 seconds
  setInterval(maybeCleanupExpiredSessions, 60 * 60 * 1000); // Hourly session GC
} else {
  // On serverless platforms (Vercel) setInterval does not run reliably, so
  // expired auctions are closed lazily on request (see handlers below).
  console.log('Serverless runtime detected: relying on lazy auto-close checks.');
}

// ==========================================
// API ROUTES
// ==========================================

/**
 * POST /api/auth/login-staff
 * Email + password login for Admins/Logistics
 */
app.post('/api/auth/login-staff', loginLimiter, async (req, res) => {
  const { email, password, deviceId } = req.body;
  if (!email || !password || !deviceId) {
    return res.status(400).json({ error: 'Missing credentials or deviceId' });
  }

  try {
    const user = await getUserByEmail(email);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const statusLower = (user.status || '').toLowerCase();
    if (statusLower === 'blocked') {
      return res.status(403).json({ error: "Access Denied: Your account is blocked. Please contact the administrator." });
    }
    const isAuthorized = statusLower === 'authorized' || statusLower === 'approved' || statusLower === 'active';
    if (!isAuthorized) {
      return res.status(403).json({ error: "Access Denied: Your staff account has not been authorized by the Admin." });
    }

    // Capture User Agent/IP for session
    const userAgent = req.headers['user-agent'] || 'Unknown Browser';
    const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

    const { accessToken, refreshToken } = await createSession(
      user.id,
      user.role,
      deviceId,
      userAgent,
      'Web-Staff',
      ipAddress
    );

    // Set secure HTTP-only cookies
    res.cookie('accessToken', accessToken, getCookieOptions(req, 15 * 60 * 1000));
    res.cookie('refreshToken', refreshToken, getCookieOptions(req, 90 * 24 * 60 * 60 * 1000));

    await logAudit(user.id, user.email, user.role, 'STAFF_LOGIN_SUCCESS', req);

    // Tokens are ONLY issued as HttpOnly cookies - never returned in the JSON
    // body, so page JavaScript cannot read or exfiltrate them.
    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        status: user.status
      }
    });
  } catch (error: any) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/login-transporter
 * Direct Email + Password login for Transporters with Admin authorization check (No OTP required)
 */
app.post('/api/auth/login-transporter', loginLimiter, async (req, res) => {
  const { email, password, deviceId } = req.body;
  if (!email || !password || !deviceId) {
    return res.status(400).json({ error: 'Email, password, and deviceId are required' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const transporter = await getTransporterByEmail(normalizedEmail);

    if (!transporter) {
      return res.status(401).json({ error: 'Invalid registered email address or password' });
    }

    // Validate account status: must be explicitly 'authorized' or 'approved' (supporting 'ACTIVE' to maintain compatibility with system seeds)
    const statusLower = (transporter.status || '').toLowerCase();
    const isAuthorized = statusLower === 'authorized' || statusLower === 'approved' || statusLower === 'active';
    if (!isAuthorized) {
      return res.status(403).json({ error: "Access Denied: Your account has not been authorized by the Logistics Administrator." });
    }

    // Verify password against stored passwordHash
    const passwordValid = await bcrypt.compare(password, transporter.passwordHash || '');
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid registered email address or password' });
    }

    const userAgent = req.headers['user-agent'] || 'Unknown Browser';
    const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

    const { accessToken, refreshToken } = await createSession(
      transporter.id,
      'TRANSPORTER',
      deviceId,
      userAgent,
      'Web-Mobile',
      ipAddress
    );

    res.cookie('accessToken', accessToken, getCookieOptions(req, 15 * 60 * 1000));
    res.cookie('refreshToken', refreshToken, getCookieOptions(req, 90 * 24 * 60 * 60 * 1000));

    await logAudit(transporter.id, transporter.email, 'TRANSPORTER', 'TRANSPORTER_LOGIN_SUCCESS', req);

    // Tokens are ONLY issued as HttpOnly cookies - never returned in the JSON
    // body, so page JavaScript cannot read or exfiltrate them.
    return res.json({
      success: true,
      user: {
        id: transporter.id,
        email: transporter.email,
        role: 'TRANSPORTER' as UserRole,
        name: transporter.companyName
      }
    });
  } catch (error) {
    console.error('Transporter direct login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/refresh
 * Silent access token refresh using rotating refresh tokens
 */
app.post('/api/auth/refresh', async (req, res) => {
  const { deviceId, refreshToken: bodyRefreshToken } = req.body;
  const customHeader = req.headers['x-refresh-token'];
  let token = bodyRefreshToken || (customHeader ? String(customHeader) : null) || req.cookies?.refreshToken;

  if (!token || !deviceId) {
    return res.status(400).json({ error: 'Refresh token or deviceId missing' });
  }

  const userAgent = req.headers['user-agent'] || 'Unknown Browser';
  const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

  const result = await rotateSession(token, deviceId, userAgent, 'Web-Client', ipAddress);

  if (!result) {
    // Clear cookies since rotation failed or token was stolen/expired
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
    return res.status(401).json({ error: 'Unauthorized: Invalid session or rotation failed' });
  }

  res.cookie('accessToken', result.accessToken, getCookieOptions(req, 15 * 60 * 1000));
  res.cookie('refreshToken', result.refreshToken, getCookieOptions(req, 90 * 24 * 60 * 60 * 1000));

  return res.json({ success: true });
});

/**
 * POST /api/auth/logout
 * Clears cookies and revokes sessions
 */
app.post('/api/auth/logout', authenticate, async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) {
    return res.status(400).json({ error: 'Missing deviceId' });
  }

  try {
    await revokeSession(deviceId, req.user!.id);

    // Evict THIS token from the in-memory auth cache immediately, so the
    // revoked access token is dead on the very next request (not up to 15s).
    const authHeader = req.headers['authorization'];
    const presentedToken =
      authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : req.cookies?.accessToken;
    if (presentedToken) authCache.delete(presentedToken);

    await logAudit(req.user!.id, req.user!.email, req.user!.role, 'LOGOUT_SUCCESS', req);

    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');

    return res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/auth/me
 * Retrieves current active user details
 */
app.get('/api/auth/me', authenticate, async (req, res) => {
  return res.json({ user: req.user });
});

// ==========================================
// TRANSPORTER ENDPOINTS
// ==========================================

/**
 * GET /api/transporters
 * Fetches all transporter accounts (Staff only)
 */
app.get('/api/transporters', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  // getAllTransporters excludes password_hash (the old full-table snapshot
  // shipped passwordHash to every staff member - fixed here).
  const transporters = await getAllTransporters();
  return res.json({ transporters });
});

/**
 * POST /api/transporters
 * Creates a transporter account (Staff only)
 */
app.post('/api/transporters', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  const { 
    companyName, 
    contactPerson, 
    email, 
    mobileNumber, 
    gstNumber, 
    panNumber, 
    operatingStates, 
    preferredRoutes,
    password
  } = req.body;

  if (!companyName || !contactPerson || !email || !mobileNumber || !gstNumber || !panNumber || !password) {
    return res.status(400).json({ error: 'All primary fields and a secure password are required to onboard a transporter' });
  }

  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  for (const list of [operatingStates, preferredRoutes]) {
    if (list !== undefined && (!Array.isArray(list) || list.some(i => typeof i !== 'string'))) {
      return res.status(400).json({ error: 'operatingStates and preferredRoutes must be arrays of strings.' });
    }
  }

  try {
    // Check duplication with a targeted query
    const dupEmail = await getTransporterByEmail(email);
    if (dupEmail) {
      return res.status(400).json({ error: 'A transporter with this email address already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const newTr: Transporter = {
      id: generateId('tr'),
      companyName,
      contactPerson,
      email,
      mobileNumber,
      gstNumber,
      panNumber,
      vehicleTypes: [],
      operatingStates: operatingStates || [],
      preferredRoutes: preferredRoutes || [],
      status: 'ACTIVE',
      passwordHash
    };

    await writeDB(dbStore => {
      dbStore.transporters.push(newTr);
    }, { tables: ['transporters'] });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `ONBOARD_TRANSPORTER: ${companyName}`, 
      req, 
      null, 
      JSON.stringify({ ...newTr, passwordHash: '[REDACTED]' })
    );

    return res.json({ success: true, transporter: stripSecrets(newTr) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to create transporter account' });
  }
});

/**
 * PUT /api/transporters/:id
 * Updates a transporter account (Staff only)
 */
app.put('/api/transporters/:id', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;

  try {
    const existing = await getTransporterById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Transporter not found' });
    }

    const oldVal = JSON.stringify(existing);
    const { newEmail, password, ...rest } = updateData;
    const updated: any = { ...existing, ...rest };

    // Mass-assignment hardening
    delete updated.id;
    delete updated.passwordHash;

    // Prevent changing registered mobile to block credential hijacking
    updated.mobileNumber = existing.mobileNumber;
    updated.email = existing.email;

    // Explicit, audited email rename (branding/migration use)
    if (newEmail) {
      if (typeof newEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return res.status(400).json({ error: 'A valid email address is required.' });
      }
      const dup = await getTransporterByEmail(newEmail);
      if (dup && dup.id !== id) {
        return res.status(400).json({ error: 'A transporter with this email address already exists.' });
      }
      updated.email = newEmail;
    }

    if (password) {
      if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
      }
      updated.passwordHash = await bcrypt.hash(password, 10);
    } else {
      updated.passwordHash = existing.passwordHash;
    }

    await writeDB(dbStore => {
      // ID-based lookup inside the fresh snapshot: the array order of the outer
      // read must never drive mutation of the fresh read.
      const freshIdx = dbStore.transporters.findIndex(t => t.id === id);
      if (freshIdx !== -1) dbStore.transporters[freshIdx] = updated;
    }, { tables: ['transporters'] });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `UPDATE_TRANSPORTER: ${updated.companyName}${newEmail ? ` (email changed to ${newEmail})` : ''}`, 
      req, 
      redactSecrets(oldVal), 
      redactSecrets(JSON.stringify(updated))
    );

    return res.json({ success: true, transporter: stripSecrets(updated) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update transporter account' });
  }
});

// ==========================================
// STAFF MANAGEMENT ENDPOINTS
// ==========================================

/**
 * GET /api/staff
 * Fetches all staff accounts (Admin only)
 */
app.get('/api/staff', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  // Never expose password hashes through the API
  const staff = (await getAllUsers()).map(u => stripSecrets(u));
  return res.json({ staff });
});

/**
 * POST /api/staff
 * Creates a staff account (Admin only)
 */
app.post('/api/staff', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  const { email, name, role, status, password } = req.body;

  if (!email || !name || !role || !status || !password) {
    return res.status(400).json({ error: 'All fields (email, name, role, status, password) are required to onboard staff.' });
  }

  const allowedRoles = ['SUPER_ADMIN', 'LOGISTICS'];
  const allowedStatuses = ['AUTHORIZED', 'APPROVED', 'BLOCKED', 'ACTIVE'];
  if (typeof role !== 'string' || !allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be SUPER_ADMIN or LOGISTICS.' });
  }
  if (typeof status !== 'string' || !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be AUTHORIZED, APPROVED, BLOCKED or ACTIVE.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  try {
    // Check duplication with a targeted query
    const dupEmail = await getUserByEmail(email);
    if (dupEmail) {
      return res.status(400).json({ error: 'A staff member with this email address already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const newStaff: User = {
      id: generateId('usr'),
      email,
      name,
      role: role as 'SUPER_ADMIN' | 'LOGISTICS',
      status,
      passwordHash
    };

    await writeDB(dbStore => {
      dbStore.users.push(newStaff);
    }, { tables: ['users'] });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `ONBOARD_STAFF: ${name} (${email})`, 
      req, 
      null, 
      JSON.stringify({ ...newStaff, passwordHash: '[REDACTED]' })
    );

    return res.json({ success: true, staff: newStaff });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to create staff account' });
  }
});

/**
 * PUT /api/staff/:id
 * Updates a staff account (Admin only)
 */
app.put('/api/staff/:id', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;

  try {
    const existing = await getUserById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const oldVal = JSON.stringify(existing);
    const { newEmail, password, ...rest } = updateData;
    const updated: any = { ...existing, ...rest };

    // Mass-assignment hardening: the primary key and the raw password hash are
    // NEVER settable through the API, no matter what the caller sends. The hash
    // is restored from the existing record unless a new password is provided.
    delete updated.id;
    delete updated.passwordHash;

    // Validate enum fields if provided (case-insensitive - the UI stores
    // lowercase statuses such as 'approved')
    if (updated.role !== undefined && !['SUPER_ADMIN', 'LOGISTICS'].includes(String(updated.role).toUpperCase())) {
      return res.status(400).json({ error: 'Invalid role. Must be SUPER_ADMIN or LOGISTICS.' });
    }
    if (updated.status !== undefined && !['AUTHORIZED', 'APPROVED', 'BLOCKED', 'ACTIVE'].includes(String(updated.status).toUpperCase())) {
      return res.status(400).json({ error: 'Invalid status. Must be AUTHORIZED, APPROVED, BLOCKED or ACTIVE.' });
    }

    // Prevent changing registered email of master admin to block hijack
    const isMasterAdmin = existing.email.toLowerCase() === 'aronkumar.logistics@gmail.com';
    if (isMasterAdmin) {
      updated.email = existing.email;
      updated.role = 'SUPER_ADMIN'; // Enforce role protection
    } else {
      updated.email = existing.email;
      // Explicit, audited email rename (used for branding/migration). Must be
      // a valid, non-duplicate address.
      if (newEmail) {
        if (typeof newEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
          return res.status(400).json({ error: 'A valid email address is required.' });
        }
        const dup = await getUserByEmail(newEmail);
        if (dup && dup.id !== id) {
          return res.status(400).json({ error: 'A staff member with this email address already exists.' });
        }
        updated.email = newEmail;
      }
    }

    if (password) {
      if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
      }
      updated.passwordHash = await bcrypt.hash(password, 10);
    } else {
      updated.passwordHash = existing.passwordHash;
    }

    await writeDB(dbStore => {
      const freshIdx = dbStore.users.findIndex(u => u.id === id);
      if (freshIdx !== -1) dbStore.users[freshIdx] = updated;
    }, { tables: ['users'] });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `UPDATE_STAFF: ${updated.name}${newEmail ? ` (email changed to ${newEmail})` : ''}`, 
      req, 
      redactSecrets(oldVal), 
      redactSecrets(JSON.stringify(updated))
    );

    return res.json({ success: true, staff: stripSecrets(updated) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update staff account' });
  }
});

// ==========================================
// TRANSPORT REQUIREMENTS ENDPOINTS
// ==========================================

/**
 * GET /api/requirements
 * Fetches requirements. Transporters only see requirements they are actively invited to!
 */
app.get('/api/requirements', authenticate, requirementsLimiter, async (req, res) => {
  maybeAutoCloseExpired().catch(console.error);
  // Hourly-throttled session garbage collection piggybacks on this hot path so
  // expired session rows are swept even on serverless (no reliable setInterval).
  maybeCleanupExpiredSessions().catch(console.error);
  const role = req.user!.role;

  const mapRequirementWithAward = (r: any, award: any) => {
    // Transporters must never learn who won unless they won it themselves
    const hideWinner = role === 'TRANSPORTER' && award && award.transporterId !== req.user!.id;
    return {
      ...r,
      awardedTransporterId: award && !hideWinner ? award.transporterId : null,
      awardedAmount: award ? award.amount : null
    };
  };

  if (role === 'SUPER_ADMIN' || role === 'LOGISTICS') {
    // Staff: every requirement joined with its award - one indexed query.
    const joined = await getRequirementsWithAwards();
    return res.json({ requirements: joined.map(({ requirement, award }) => mapRequirementWithAward(requirement, award)) });
  } else {
    // Transporter: the SQL filter mirrors the old in-memory visibility rule
    // (public/targeted loads, plus closed/draft auctions they were invited to,
    // bid on, or won). Award joined for winner display.
    const joined = await getVisibleRequirementsForTransporter(req.user!.id);
    return res.json({ requirements: joined.map(({ requirement, award }) => mapRequirementWithAward(requirement, award)) });
  }
});

/**
 * GET /api/requirements/:id
 * Fetches requirement detail. Restricts non-invited transporters.
 */
app.get('/api/requirements/:id', authenticate, requirementsLimiter, async (req, res) => {
  const { id } = req.params;
  
  const reqItem = await getRequirementById(id);
  if (!reqItem) {
    return res.status(404).json({ error: 'Requirement not found' });
  }

  // Transporter eligibility guard
  if (req.user!.role === 'TRANSPORTER') {
    const isPublic = !reqItem.targeted_transporter_ids || reqItem.targeted_transporter_ids.length === 0;
    const isTargeted = reqItem.targeted_transporter_ids && reqItem.targeted_transporter_ids.includes(req.user!.id);
    if (!isPublic && !isTargeted) {
      return res.status(403).json({ error: 'Access Denied: You are not authorized to participate in this bidding requirement.' });
    }

    const isInvited = await hasInvitation(id, req.user!.id);
    const isOpenLoad = reqItem.status === 'active' || reqItem.status === 'published' || reqItem.status === 'LIVE';
    const hasBid = !!(await getBidFor(id, req.user!.id));
    const award = await getAwardForRequirement(id);
    const hasAward = !!(award && award.transporterId === req.user!.id);

    if (!isInvited && !isOpenLoad && !hasBid && !hasAward) {
      return res.status(403).json({ error: 'Forbidden: You are not invited to participate in this auction' });
    }
  }

  // CONFIDENTIALITY: transporters must never see the list of competing
  // companies. Only staff receive the invited-transporter roster.
  let invitedTrs: any[] = [];
  if (req.user!.role !== 'TRANSPORTER') {
    const invitations = await getInvitationsForRequirement(id);
    const transIds = invitations.map(inv => inv.transporterId);
    const transports = await getTransportersByIds(transIds);
    const trById = new Map(transports.map(t => [t.id, t]));
    invitedTrs = invitations.map(inv => ({
      transporterId: inv.transporterId,
      companyName: trById.get(inv.transporterId)?.companyName || 'Unknown',
      status: inv.status,
      removedReason: inv.removedReason
    }));
  }

  const award = await getAwardForRequirement(id);
  const hideWinner = req.user!.role === 'TRANSPORTER' && award && award.transporterId !== req.user!.id;
  const requirementWithAward = {
    ...reqItem,
    awardedTransporterId: award && !hideWinner ? award.transporterId : null,
    awardedAmount: award ? award.amount : null
  };

  return res.json({ 
    requirement: requirementWithAward,
    invitedTransporters: invitedTrs
  });
});

/**
 * POST /api/requirements
 * Supports single and bulk creation of requirements (Staff only)
 */
app.post('/api/requirements', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  const { requirements } = req.body;
  
  if (!requirements || !Array.isArray(requirements) || requirements.length === 0) {
    return res.status(400).json({ error: 'Requirements array is required for creation' });
  }

  const created: Requirement[] = [];
  const errors: string[] = [];

  // Validate all items first
  requirements.forEach((r, idx) => {
    if (!r.pickupLocation || !r.deliveryLocation || !r.material || !r.weight || !r.vehicleType || !r.pickupDate || !r.bidClosingTime) {
      errors.push(`Row ${idx + 1}: Missing mandatory parameters.`);
    }
    if (r.vehicleType && !VEHICLE_TYPES.includes(r.vehicleType)) {
      errors.push(`Row ${idx + 1}: vehicleType must be one of the standardized types: ${VEHICLE_TYPES.join(', ')}.`);
    }
    const closing = new Date(r.bidClosingTime);
    if (isNaN(closing.getTime()) || closing <= new Date()) {
      errors.push(`Row ${idx + 1}: Bid Closing Time must be a valid future datetime.`);
    }
    const weightNum = Number(r.weight);
    if (isNaN(weightNum) || weightNum <= 0) {
      errors.push(`Row ${idx + 1}: Weight must be a positive number.`);
    }
  });

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', detail: errors });
  }

  try {
    // Validate targeted transporter IDs exist before persisting anything
    for (const r of requirements) {
      const targets = r.eligibleTransporters || r.targeted_transporter_ids || [];
      if (Array.isArray(targets) && targets.length > 0) {
        const existingIds = await transporterIdsExist(targets);
        if (targets.some((id: string) => !existingIds.has(id))) {
          return res.status(400).json({ error: 'One or more targeted transporter IDs do not exist.' });
        }
      }
    }

    await writeDB(dbStore => {
      requirements.forEach((r) => {
        // Find maximum existing serial to guarantee uniqueness
        let maxSerial = 0;
        dbStore.requirements.forEach(existing => {
          const match = existing.id.match(/^TR-2026-(\d+)$/);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxSerial) {
              maxSerial = num;
            }
          }
        });
        const reqId = `TR-2026-${String(maxSerial + 1).padStart(4, '0')}`;

        const targetedTransporters: string[] = r.eligibleTransporters || r.targeted_transporter_ids || [];

        const newReq: Requirement = {
          id: reqId,
          pickupLocation: r.pickupLocation,
          deliveryLocation: r.deliveryLocation,
          material: r.material,
          weight: Number(r.weight),
          vehicleType: r.vehicleType,
          numberOfVehicles: Number(r.numberOfVehicles || 1),
          pickupDate: r.pickupDate,
          expectedDelivery: r.expectedDelivery || '',
          specialInstructions: r.specialInstructions || '',
          vehicleSpecs: r.vehicleSpecs || '',
          documents: r.documents || [],
          bidOpeningTime: new Date().toISOString(),
          bidClosingTime: new Date(r.bidClosingTime).toISOString(),
          targetRate: r.targetRate ? Number(r.targetRate) : null,
          awardType: r.awardType || 'MANUAL',
          status: 'DRAFT', // Always created as draft first
          createdAt: new Date().toISOString(),
          targetedTransporterIds: targetedTransporters,
          targeted_transporter_ids: targetedTransporters
        };

        dbStore.requirements.push(newReq);
        created.push(newReq);

        // Snap active matches or specified eligible transporters
        let eligibleTransporters: string[] = targetedTransporters;
        if (eligibleTransporters.length === 0) {
          // Transporters no longer select vehicle categories - auto-invite all active carriers
          eligibleTransporters = dbStore.transporters
            .filter(t => t.status === 'ACTIVE')
            .map(t => t.id);
        }

        eligibleTransporters.forEach(trId => {
          dbStore.requirementInvitations.push({
            id: generateId('inv'),
            requirementId: reqId,
            transporterId: trId,
            status: 'INVITED',
            removedReason: null
          });
        });
      });
    }, {
      // Serial generation scans existing requirements for TR-2026-XXXX ids, and
      // auto-matching reads the active transporters - scope the snapshot to the
      // tables this write actually touches.
      tables: ['requirements', 'requirementInvitations', 'transporters']
    });

    const createdIds = created.map(c => c.id).join(', ');
    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `BULK_CREATE_REQUIREMENTS: [${createdIds}]`, 
      req
    );

    return res.json({ success: true, requirements: created });
  } catch (error) {
    console.error('Create reqs failed:', error);
    return res.status(500).json({ error: 'Failed to build requirements' });
  }
});

/**
 * PUT /api/requirements/:id
 * Edits draft requirement (Staff only)
 */
app.put('/api/requirements/:id', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;

  try {
    const existing = await getRequirementById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Requirement not found' });
    }

    if (existing.status !== 'DRAFT') {
      return res.status(400).json({ error: 'Can only edit requirements in DRAFT status' });
    }

    const oldVal = JSON.stringify(existing);

    // Field whitelist: only content fields may be edited on a draft. Status,
    // id, timestamps and targeting are managed through dedicated endpoints,
    // so a caller cannot self-escalate an auction by smuggling extra fields.
    if (updateData.vehicleType && !VEHICLE_TYPES.includes(updateData.vehicleType)) {
      return res.status(400).json({ error: `vehicleType must be one of the standardized types: ${VEHICLE_TYPES.join(', ')}.` });
    }

    const editableFields = [
      'pickupLocation', 'deliveryLocation', 'material', 'weight', 'vehicleType',
      'numberOfVehicles', 'pickupDate', 'expectedDelivery', 'specialInstructions',
      'vehicleSpecs', 'documents', 'bidClosingTime', 'targetRate', 'awardType', 'targetedTransporterIds'
    ];
    const updated: any = { ...existing };
    for (const field of editableFields) {
      if (field in updateData) {
        updated[field] = updateData[field];
      }
    }

    await writeDB(dbStore => {
      const freshIdx = dbStore.requirements.findIndex(r => r.id === id);
      if (freshIdx !== -1) dbStore.requirements[freshIdx] = updated;
    }, {
      lockKeys: [`auction:${id}`],
      lockRequirementIds: [id],
      requirementScope: [id],
      tables: ['requirements']
    });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `EDIT_REQUIREMENT: ${id}`, 
      req, 
      redactSecrets(oldVal), 
      redactSecrets(JSON.stringify(updated))
    );

    return res.json({ success: true, requirement: updated });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to edit requirement' });
  }
});

/**
 * PUT /api/requirements/:id/publish
 * Publishes requirement and notifies eligible transporters over SMS, WhatsApp, and Email
 */
app.put('/api/requirements/:id/publish', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  const { id } = req.params;

  try {
    const reqItem = await getRequirementById(id);
    if (!reqItem) return res.status(404).json({ error: 'Requirement not found' });

    if (reqItem.status !== 'DRAFT') {
      return res.status(400).json({ error: 'Requirement is already published' });
    }

    await writeDB(dbStore => {
      const target = dbStore.requirements.find(r => r.id === id);
      if (target) {
        target.status = 'LIVE';
        target.bidOpeningTime = new Date().toISOString();
      }
    }, {
      lockKeys: [`auction:${id}`],
      lockRequirementIds: [id],
      requirementScope: [id],
      tables: ['requirements']
    });

    // Notify all eligible transporters
    const invitations = (await getInvitationsForRequirement(id)).filter(i => i.status === 'INVITED');
    const transById = new Map((await getTransportersByIds(invitations.map(i => i.transporterId))).map(t => [t.id, t]));

    for (const inv of invitations) {
      const trans = transById.get(inv.transporterId);
      if (trans && trans.status === 'ACTIVE') {
        // Trigger multi-channel async notification
        notifyPublishedRequirement(reqItem, trans, APP_URL).catch(err => {
          console.error(`Failed to notify ${trans.companyName}:`, err);
        });
      }
    }

    await logAudit(req.user!.id, req.user!.email, req.user!.role, `PUBLISH_REQUIREMENT: ${id}`, req);
    io.emit('requirement_updated', { id, status: 'LIVE' });

    return res.json({ success: true, message: 'Requirement published successfully' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to publish requirement' });
  }
});

/**
 * PUT /api/requirements/:id/cancel
 * Cancels active requirement (Staff only)
 */
app.put('/api/requirements/:id/cancel', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  const { id } = req.params;

  try {
    const target = await getRequirementById(id);
    if (!target) return res.status(404).json({ error: 'Requirement not found' });

    await writeDB(dbStore => {
      const r = dbStore.requirements.find(x => x.id === id);
      if (r) r.status = 'CANCELLED';
    }, {
      lockKeys: [`auction:${id}`],
      lockRequirementIds: [id],
      requirementScope: [id],
      tables: ['requirements']
    });

    await logAudit(req.user!.id, req.user!.email, req.user!.role, `CANCEL_REQUIREMENT: ${id}`, req);
    io.emit('requirement_updated', { id, status: 'CANCELLED' });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to cancel requirement' });
  }
});

/**
 * PUT /api/requirements/:id/extend
 * Extends closing time for active requirement (Staff only)
 */
app.put('/api/requirements/:id/extend', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  const { id } = req.params;
  const { newClosingTime } = req.body;

  if (!newClosingTime || isNaN(new Date(newClosingTime).getTime()) || new Date(newClosingTime) <= new Date()) {
    return res.status(400).json({ error: 'Valid future closing time is required' });
  }

  try {
    const target = await getRequirementById(id);
    if (!target) return res.status(404).json({ error: 'Requirement not found' });

    // Never re-open auctions that were already awarded or cancelled
    if (target.status === 'AWARDED' || target.status === 'CANCELLED') {
      return res.status(400).json({ error: 'Cannot extend a requirement that has already been awarded or cancelled' });
    }

    const oldTime = target.bidClosingTime;

    await writeDB(dbStore => {
      const r = dbStore.requirements.find(x => x.id === id);
      // Fresh-state guard: never re-open an auction that was awarded or
      // cancelled by another request while we waited for the write lock.
      if (!r || r.status === 'AWARDED' || r.status === 'CANCELLED') return;
      r.status = 'LIVE'; // Ensure it becomes LIVE again if it was closed
      r.bidClosingTime = new Date(newClosingTime).toISOString();
    }, {
      lockKeys: [`auction:${id}`],
      lockRequirementIds: [id],
      requirementScope: [id],
      tables: ['requirements']
    });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `EXTEND_CLOSING_TIME: ${id}`, 
      req, 
      oldTime, 
      newClosingTime
    );
    
    io.to(`req_${id}`).emit('rank_updated', { requirementId: id });
    io.emit('requirement_updated', { id, status: 'LIVE', bidClosingTime: newClosingTime });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to extend closing time' });
  }
});

/**
 * PUT /api/requirements/:id/invitations
 * Updates eligible transporters mid-round (Staff only)
 * Unchecking a transporter requires a reason, logged in Audit Trail.
 */
app.put('/api/requirements/:id/invitations', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  const { id } = req.params;
  const { transporterId, active, removedReason } = req.body;

  if (!transporterId || active === undefined) {
    return res.status(400).json({ error: 'transporterId and active state are required' });
  }

  if (!active && !removedReason) {
    return res.status(400).json({ error: 'A reason note is required to exclude a transporter mid-round' });
  }

  try {
    const reqItem = await getRequirementById(id);
    if (!reqItem) return res.status(404).json({ error: 'Requirement not found' });

    await writeDB(dbStore => {
      const idx = dbStore.requirementInvitations.findIndex(
        i => i.requirementId === id && i.transporterId === transporterId
      );

      if (active) {
        if (idx !== -1) {
          dbStore.requirementInvitations[idx].status = 'INVITED';
          dbStore.requirementInvitations[idx].removedReason = null;
        } else {
          dbStore.requirementInvitations.push({
            id: generateId('inv'),
            requirementId: id,
            transporterId,
            status: 'INVITED',
            removedReason: null
          });
        }
      } else {
        if (idx !== -1) {
          dbStore.requirementInvitations[idx].status = 'REMOVED';
          dbStore.requirementInvitations[idx].removedReason = removedReason;
        }
      }
    }, {
      lockKeys: [`auction:${id}`],
      lockRequirementIds: [id],
      requirementScope: [id],
      tables: ['requirementInvitations']
    });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `MID_ROUND_INVITATION_UPDATE: Requirement ${id} | Transporter ${transporterId} | Active: ${active}`, 
      req, 
      null, 
      removedReason
    );

    // If added post-publish, notify immediately
    if (active && reqItem.status === 'LIVE') {
      const trans = await getTransporterById(transporterId);
      if (trans) {
        notifyPublishedRequirement(reqItem, trans, APP_URL).catch(console.error);
      }
    }

    io.to(`req_${id}`).emit('rank_updated', { requirementId: id });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update invitations' });
  }
});

// ==========================================
// BIDDING ENDPOINTS
// ==========================================

/**
 * GET /api/requirements/:id/ranks
 * Returns live ranking. Transporters NEVER see competitor names/rates!
 */
app.get('/api/requirements/:id/ranks', authenticate, requirementsLimiter, async (req, res) => {
  const { id } = req.params;
  const role = req.user!.role;

  try {
    maybeAutoCloseExpired().catch(console.error);
    const fullRanks = await calculateRanks(id);

    if (role === 'SUPER_ADMIN' || role === 'LOGISTICS') {
      // Staff see all rankings, bids, transporter names
      return res.json({ ranks: fullRanks });
    } else {
      // Transporter - filter to protect confidentiality!
      // ONLY return their own bid amount, own rank, and if they are L1
      let ownRank = fullRanks.find(r => r.transporterId === req.user!.id);
      
      if (!ownRank) {
        // If it's an open load, any transporter can participate and has a default pending rank
        const reqItem = await getRequirementById(id);
        if (reqItem && (reqItem.status === 'active' || reqItem.status === 'published' || reqItem.status === 'LIVE')) {
          ownRank = {
            transporterId: req.user!.id,
            companyName: 'My Company',
            amount: null,
            rank: null,
            isL1: false,
            status: 'PENDING',
            timestamp: null
          };
        } else {
          return res.status(403).json({ error: 'You are not invited to participate in this auction' });
        }
      }

      // Format output strictly as per Section 14
      return res.json({
        ranks: [{
          transporterId: ownRank.transporterId,
          companyName: 'My Company',
          amount: ownRank.amount,
          rank: ownRank.rank,
          isL1: ownRank.isL1,
          status: ownRank.status,
          timestamp: ownRank.timestamp
        }],
        l1Tied: fullRanks.filter(r => r.isL1 && r.amount !== null).length > 1
      });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Failed to calculate rankings' });
  }
});

/**
 * POST /api/requirements/:id/bid
 * Submits or reduces a bid (Transporters only)
 */
app.post('/api/requirements/:id/bid', authenticate, biddingLimiter, authorize(['TRANSPORTER']), async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;

  if (amount === undefined || isNaN(Number(amount)) || Number(amount) <= 0 || Number(amount) > MAX_BID_AMOUNT) {
    return res.status(400).json({ error: 'Valid positive bid amount is required' });
  }

  const bidAmount = Number(amount);

  try {
    const reqItem = await getRequirementById(id);
    if (!reqItem) {
      return res.status(404).json({ error: 'Requirement not found' });
    }

    const isOpenLoad = reqItem.status === 'active' || reqItem.status === 'published' || reqItem.status === 'LIVE';
    if (!isOpenLoad) {
      return res.status(400).json({ error: 'This bidding round is currently closed or inactive' });
    }

    // Enforce the auction window: no bids before opening or after closing time
    // (the old code only checked the status flag, so bids were accepted after
    // bidClosingTime until the 10s cron happened to run).
    const nowMs = Date.now();
    if (reqItem.bidOpeningTime && nowMs < new Date(reqItem.bidOpeningTime).getTime()) {
      return res.status(400).json({ error: 'Bidding has not opened yet for this requirement' });
    }
    if (reqItem.bidClosingTime && nowMs >= new Date(reqItem.bidClosingTime).getTime()) {
      maybeAutoCloseExpired().catch(console.error);
      return res.status(400).json({ error: 'Bidding has closed for this requirement' });
    }

    // Strict targeted transporters check
    const isPublic = !reqItem.targeted_transporter_ids || reqItem.targeted_transporter_ids.length === 0;
    const isTargeted = reqItem.targeted_transporter_ids && reqItem.targeted_transporter_ids.includes(req.user!.id);
    if (!isPublic && !isTargeted) {
      return res.status(403).json({ error: 'Access Denied: You are not authorized to participate in this bidding requirement.' });
    }

    // Is invited?
    const isInvited = await hasInvitation(id, req.user!.id);
    if (!isInvited && !isOpenLoad) {
      return res.status(403).json({ error: 'You are not invited to bid on this requirement' });
    }

    // Bid Reduction Rule Enforcement: Bids can only be reduced, never increased!
    const existingBid = await getBidFor(id, req.user!.id);
    if (existingBid && bidAmount >= existingBid.amount) {
      return res.status(400).json({ error: `You can only submit a lower quotation than your previous rate of ₹${existingBid.amount.toLocaleString()}` });
    }    const nowStr = new Date().toISOString();
    const bidId = generateId('bid');

    await writeDB(dbStore => {
      // Re-validate against the FRESH committed state inside the serialized
      // write: the auction may have closed or another instance may have placed
      // a bid while we were waiting for the advisory lock.
      const freshReq = dbStore.requirements.find(r => r.id === id);
      if (!freshReq) throw new BidValidationError('Requirement not found');
      const freshOpen = freshReq.status === 'active' || freshReq.status === 'published' || freshReq.status === 'LIVE';
      if (!freshOpen) throw new BidValidationError('This bidding round is currently closed or inactive');
      const freshNow = Date.now();
      if (freshReq.bidOpeningTime && freshNow < new Date(freshReq.bidOpeningTime).getTime()) {
        throw new BidValidationError('Bidding has not opened yet for this requirement');
      }
      if (freshReq.bidClosingTime && freshNow >= new Date(freshReq.bidClosingTime).getTime()) {
        throw new BidValidationError('Bidding has closed for this requirement');
      }
      const freshExisting = dbStore.bids.find(b => b.requirementId === id && b.transporterId === req.user!.id);
      if (freshExisting && bidAmount >= freshExisting.amount) {
        throw new BidValidationError(`You can only submit a lower quotation than your previous rate of ₹${freshExisting.amount.toLocaleString()}`);
      }

      // Record in history
      dbStore.bidHistory.push({
        id: generateId('bh'),
        requirementId: id,
        transporterId: req.user!.id,
        amount: bidAmount,
        timestamp: nowStr
      });

      // Update active bid
      const actIdx = dbStore.bids.findIndex(b => b.requirementId === id && b.transporterId === req.user!.id);
      if (actIdx !== -1) {
        dbStore.bids[actIdx].amount = bidAmount;
        dbStore.bids[actIdx].lastUpdated = nowStr;
      } else {
        dbStore.bids.push({
          id: bidId,
          requirementId: id,
          transporterId: req.user!.id,
          amount: bidAmount,
          timestamp: nowStr,

          lastUpdated: nowStr
        });
      }
    }, {
      // Phase 2: per-auction lock - only bids on THIS auction serialize against
      // each other; bids on other auctions proceed in parallel.
      lockKeys: [`auction:${id}`],
      lockRequirementIds: [id],
      requirementScope: [id],
      tables: ['requirements', 'bids', 'bidHistory']
    });

    await logAudit(req.user!.id, req.user!.email, req.user!.role, `SUBMIT_BID: ₹${bidAmount} for Requirement ${id}`, req);

    // Notify clients instantly via sockets
    io.to(`req_${id}`).emit('rank_updated', { requirementId: id });

    return res.json({ success: true, message: 'Your quotation was submitted successfully' });
  } catch (error: any) {
    if (error instanceof BidValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Submit bid failed:', error);
    return res.status(500).json({ error: 'Failed to submit bid' });
  }
});

// ==========================================
// AWARDING ENDPOINTS
// ==========================================

/**
 * POST /api/requirements/:id/award
 * Manually awards requirement (Staff only). Resolves ties.
 */
app.post('/api/requirements/:id/award', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  const { id } = req.params;
  const { transporterId, tieBreakLog } = req.body;

  if (!transporterId) {
    return res.status(400).json({ error: 'transporterId is required for award selection' });
  }

  try {
    const reqItem = await getRequirementById(id);
    if (!reqItem) return res.status(404).json({ error: 'Requirement not found' });

    // Ensure status is either CLOSED or TIE_RESOLUTION_REQUIRED
    if (reqItem.status !== 'CLOSED' && reqItem.status !== 'TIE_RESOLUTION_REQUIRED' && reqItem.status !== 'LIVE') {
      return res.status(400).json({ error: 'Requirement is not in a contractible state' });
    }

    // Check if selecting from a tie
    const ranks = await calculateRanks(id);
    const l1Bids = ranks.filter(r => r.isL1 && r.amount !== null);
    const isTie = l1Bids.length > 1;

    if (isTie && !tieBreakLog) {
      return res.status(400).json({ error: 'A manual resolution explanation is required to award a tied L1 bid' });
    }

    const selectedBid = await getBidFor(id, transporterId);
    if (!selectedBid) {
      return res.status(400).json({ error: 'No quotation found for selected transporter' });
    }

    const nowStr = new Date().toISOString();
    const awardId = generateId('award');

    await writeDB(dbStore => {
      // Find and update requirement status
      const target = dbStore.requirements.find(r => r.id === id);
      if (target) target.status = 'AWARDED';

      dbStore.awards.push({
        id: awardId,
        requirementId: id,
        transporterId,
        amount: selectedBid.amount,
        awardedAt: nowStr,
        awardedBy: req.user!.id,
        tieBreakLog: tieBreakLog || null
      });
    }, {
      lockKeys: [`auction:${id}`],
      lockRequirementIds: [id],
      requirementScope: [id],
      tables: ['requirements', 'bids', 'awards']
    });

    // Notify winner
    const winTrans = await getTransporterById(transporterId);
    if (winTrans) {
      notifyAwardedBid(reqItem, winTrans, selectedBid.amount, APP_URL).catch(console.error);
    }

    // Notify other participating bidders
    const participatingBidders = (await getBidsForRequirement(id)).filter(b => b.transporterId !== transporterId);
    const lostIds = participatingBidders.map(b => b.transporterId);
    const lostTransports = await getTransportersByIds(lostIds);
    for (const lostTrans of lostTransports) {
      notifyLostBid(reqItem, lostTrans).catch(console.error);
    }

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `AWARD_CONTRACT: Requirement ${id} awarded to Transporter ${transporterId}`, 
      req, 
      null, 
      tieBreakLog
    );

    io.to(`req_${id}`).emit('rank_updated', { requirementId: id });
    io.emit('requirement_updated', { id, status: 'AWARDED' });

    return res.json({ success: true, message: 'Contract awarded and notifications dispatched' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to award contract' });
  }
});

// ==========================================
// SYSTEM LOGS & AUDITS & SETTINGS
// ==========================================

/**
 * GET /api/settings/notifications
 * Fetches current provider configs. Masks sensitive tokens.
 */
app.get('/api/settings/notifications', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  const config = await getNotificationConfig();

  if (!config) {
    return res.status(404).json({ error: 'Configurations not initialized' });
  }

  // Deep copy to mask secrets safely
  const masked = { ...config };
  const mask = (str: string) => {
    if (!str) return '';
    return str.length > 8 ? `••••••••${str.slice(-4)}` : '••••••••';
  };

  masked.whatsappToken = mask(masked.whatsappToken);
  masked.smsAuthToken = mask(masked.smsAuthToken);
  masked.smsApiKey = mask(masked.smsApiKey);
  masked.emailApiKey = mask(masked.emailApiKey);

  return res.json({ config: masked });
});

/**
 * PUT /api/settings/notifications
 * Updates notification credentials. Protects from complete replacement leaks.
 */
app.put('/api/settings/notifications', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  const updates = req.body;

  try {
    const current = await getNotificationConfig();

    if (!current) {
      return res.status(404).json({ error: 'Configuration document not found' });
    }

    const updated = { ...current, ...updates };

    // If secrets are omitted or passed as masks, retain current values
    const checkMask = (newVal: string, oldVal: string) => {
      if (!newVal || newVal.includes('••••')) return oldVal;
      return newVal;
    };

    updated.whatsappToken = checkMask(updates.whatsappToken, current.whatsappToken);
    updated.smsAuthToken = checkMask(updates.smsAuthToken, current.smsAuthToken);
    updated.smsApiKey = checkMask(updates.smsApiKey, current.smsApiKey);
    updated.emailApiKey = checkMask(updates.emailApiKey, current.emailApiKey);

    updated.whatsappStatus = updated.whatsappToken ? 'CONNECTED' : 'NOT_CONNECTED';
    updated.smsStatus = updated.smsAuthToken ? 'CONNECTED' : 'NOT_CONNECTED';
    updated.emailStatus = updated.emailApiKey ? 'CONNECTED' : 'NOT_CONNECTED';

    await writeDB(dbStore => {
      const freshIdx = dbStore.notificationProviderConfigs.findIndex(c => c.id === 'default');
      if (freshIdx !== -1) dbStore.notificationProviderConfigs[freshIdx] = updated;
    }, { tables: ['notificationProviderConfigs'] });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `UPDATE_NOTIFICATION_SETTINGS`, 
      req
    );

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update notification settings' });
  }
});

/**
 * POST /api/settings/notifications/test
 * Test credentials live using Test Connection!
 */
app.post('/api/settings/notifications/test', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  const { channel, targetAddress, testMessage } = req.body;

  if (!channel || !targetAddress) {
    return res.status(400).json({ error: 'channel and targetAddress are required to run tests' });
  }

  const msg = testMessage || 'FleexBid: This is a secure notification configuration test message.';

  try {
    if (channel === 'sms') {
      const sent = await sendSms(targetAddress, msg);
      if (sent) return res.json({ success: true, message: 'Test SMS dispatched successfully' });
      throw new Error('SMS Gateway connection failed');
    } else if (channel === 'email') {
      const sent = await sendEmail(targetAddress, 'FleexBid Test Connection', `<h3>FleexBid Portal</h3><p>${msg}</p>`);
      if (sent) return res.json({ success: true, message: 'Test Email dispatched successfully' });
      throw new Error('Email Gateway connection failed');
    } else {
      return res.status(400).json({ error: 'Unsupported channel for testing' });
    }
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Connection test failed' });
  }
});

/**
 * GET /api/logs/notifications
 * Fetches logs of WhatsApp, SMS, and Email dispatches for visual delivery stats!
 */
app.get('/api/logs/notifications', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  // Paginated: newest-first, capped per channel. ?limit= overrides the default.
  const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500);
  const { smsLogs, emailLogs, whatsAppLogs } = await getNotificationLogs(limit);
  return res.json({ smsLogs, emailLogs, whatsAppLogs });
});

/**
 * GET /api/logs/audit
 * Fetches security audit logs
 */
app.get('/api/logs/audit', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  // Paginated: newest-first with LIMIT/OFFSET. Clients that previously received
  // the whole (ascending) array now get the most recent page - the UI shows
  // recent activity, which is what this endpoint powers.
  const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '100'), 10) || 100, 1), 500);
  const { rows, total } = await getAuditLogsPage(page, limit);
  return res.json({ logs: rows, total, page, limit });
});

/**
 * GET /api/sessions
 * List active transporter/user devices and active logins
 */
app.get('/api/sessions', authenticate, async (req, res) => {
  const sessions = await getSessionsForUser(req.user!.id, req.user!.role);
  // never leak refresh-token material
  const filtered = sessions.map(({ refreshToken, ...session }) => session);
  return res.json({ sessions: filtered });
});

/**
 * DELETE /api/sessions/:id
 * Let transporters/users revoke their sessions from specific devices!
 */
app.delete('/api/sessions/:id', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    if (req.user!.role === 'TRANSPORTER') {
      await queryPool('DELETE FROM sessions WHERE id = $1 AND transporter_id = $2', [id, req.user!.id]);
    } else {
      await queryPool('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
    }

    await logAudit(req.user!.id, req.user!.email, req.user!.role, `REVOKE_SESSION: Session ${id}`, req);
    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to revoke session', detail: error.message });
  }
});

/**
 * AI Advisory & Insights endpoints
 */
app.use('/api/ai', authenticate, aiLimiter, aiRouter);

// ==========================================
// API V1 LOGISTICS MARKETPLACE PIPELINES
// ==========================================

/**
 * POST /api/v1/requirements
 * API endpoint to publish new shipping requirements with status 'active' or 'published'.
 * Accessible by Admin and Staff.
 */
app.post('/api/v1/requirements', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  let reqsInput: any[] = [];
  if (Array.isArray(req.body)) {
    reqsInput = req.body;
  } else if (req.body.requirements && Array.isArray(req.body.requirements)) {
    reqsInput = req.body.requirements;
  } else if (typeof req.body === 'object' && req.body !== null) {
    reqsInput = [req.body];
  } else {
    return res.status(400).json({ error: 'Requirement details are required for creation' });
  }

  const errors: string[] = [];
  reqsInput.forEach((r, idx) => {
    if (!r.pickupLocation || !r.deliveryLocation || !r.material || !r.weight || !r.vehicleType) {
      errors.push(`Row ${idx + 1}: Missing mandatory transport specifications (pickupLocation, deliveryLocation, material, weight, vehicleType).`);
    }
    if (r.vehicleType && !VEHICLE_TYPES.includes(r.vehicleType)) {
      errors.push(`Row ${idx + 1}: vehicleType must be one of the standardized types: ${VEHICLE_TYPES.join(', ')}.`);
    }
  });

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', detail: errors });
  }

  try {
    const created: Requirement[] = [];

    await writeDB(dbStore => {
      reqsInput.forEach((r) => {
        // Find maximum existing serial to guarantee uniqueness
        let maxSerial = 0;
        dbStore.requirements.forEach(existing => {
          const match = existing.id.match(/^TR-2026-(\d+)$/);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxSerial) {
              maxSerial = num;
            }
          }
        });
        const reqId = `TR-2026-${String(maxSerial + 1).padStart(4, '0')}`;

        const closingDate = r.bidClosingTime 
          ? new Date(r.bidClosingTime).toISOString() 
          : new Date(Date.now() + 2 * 3600 * 1000).toISOString(); // 2 hours default

        const targetedTransporters: string[] = r.eligibleTransporters || r.targeted_transporter_ids || [];

        const newReq: Requirement = {
          id: reqId,
          pickupLocation: r.pickupLocation,
          deliveryLocation: r.deliveryLocation,
          material: r.material,
          weight: Number(r.weight),
          vehicleType: r.vehicleType,
          numberOfVehicles: Number(r.numberOfVehicles || 1),
          pickupDate: r.pickupDate || new Date().toISOString().split('T')[0],
          expectedDelivery: r.expectedDelivery || '',
          specialInstructions: r.specialInstructions || '',
          vehicleSpecs: r.vehicleSpecs || '',
          documents: r.documents || [],
          bidOpeningTime: new Date().toISOString(),
          bidClosingTime: closingDate,
          targetRate: r.targetRate ? Number(r.targetRate) : null,
          awardType: r.awardType || 'MANUAL',
          status: r.status || 'published', // default status to 'published'
          createdAt: new Date().toISOString(),
          targetedTransporterIds: targetedTransporters,
          targeted_transporter_ids: targetedTransporters
        };

        dbStore.requirements.push(newReq);
        created.push(newReq);

        // Auto-invite active transporters (vehicle category selection was removed)
        let eligibleTransporters = targetedTransporters;
        if (eligibleTransporters.length === 0) {
          eligibleTransporters = dbStore.transporters
            .filter(t => t.status === 'ACTIVE')
            .map(t => t.id);
        }

        eligibleTransporters.forEach(trId => {
          dbStore.requirementInvitations.push({
            id: generateId('inv'),
            requirementId: reqId,
            transporterId: trId,
            status: 'INVITED',
            removedReason: null
          });
        });
      });
    }, {
      tables: ['requirements', 'requirementInvitations', 'transporters']
    });

    // Notify matching active transporters dynamically via SMS/Email/WhatsApp
    for (const newReqItem of created) {
      const invitations = await getInvitationsForRequirement(newReqItem.id);
      const transById = new Map((await getTransportersByIds(invitations.map(i => i.transporterId))).map(t => [t.id, t]));
      for (const inv of invitations) {
        const trans = transById.get(inv.transporterId);
        if (trans && trans.status === 'ACTIVE') {
          notifyPublishedRequirement(newReqItem, trans, APP_URL).catch(err => {
            console.error(`Failed to dispatch publisher alert for ${trans.companyName}:`, err);
          });
        }
      }
      io.emit('requirement_updated', { id: newReqItem.id, status: newReqItem.status });
    }

    const createdIds = created.map(c => c.id).join(', ');
    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `CREATE_REQUIREMENTS_V1: [${createdIds}] with status active/published`, 
      req
    );

    return res.json({ success: true, requirements: created });
  } catch (error) {
    console.error('V1 Requirement push failed:', error);
    return res.status(500).json({ error: 'Failed to publish requirements' });
  }
});

/**
 * POST /api/v1/bids
 * Submit a bid rate for a requirement. Only accessible by Transporters.
 */
app.post('/api/v1/bids', authenticate, biddingLimiter, authorize(['TRANSPORTER']), async (req, res) => {
  const { requirementId, requirement_id, amount } = req.body;
  const reqId = requirementId || requirement_id;

  if (!reqId) {
    return res.status(400).json({ error: 'requirementId is required' });
  }
  if (amount === undefined || isNaN(Number(amount)) || Number(amount) <= 0 || Number(amount) > MAX_BID_AMOUNT) {
    return res.status(400).json({ error: 'Valid positive bid amount is required' });
  }

  const bidAmount = Number(amount);

  try {
    const reqItem = await getRequirementById(reqId);
    if (!reqItem) {
      return res.status(404).json({ error: 'Requirement not found' });
    }

    const isOpenLoad = reqItem.status === 'active' || reqItem.status === 'published' || reqItem.status === 'LIVE';
    if (!isOpenLoad) {
      return res.status(400).json({ error: 'This bidding round is currently closed or inactive' });
    }

    // Enforce the auction window
    const nowMs = Date.now();
    if (reqItem.bidOpeningTime && nowMs < new Date(reqItem.bidOpeningTime).getTime()) {
      return res.status(400).json({ error: 'Bidding has not opened yet for this requirement' });
    }
    if (reqItem.bidClosingTime && nowMs >= new Date(reqItem.bidClosingTime).getTime()) {
      maybeAutoCloseExpired().catch(console.error);
      return res.status(400).json({ error: 'Bidding has closed for this requirement' });
    }

    // Strict targeted transporters check
    const isPublic = !reqItem.targeted_transporter_ids || reqItem.targeted_transporter_ids.length === 0;
    const isTargeted = reqItem.targeted_transporter_ids && reqItem.targeted_transporter_ids.includes(req.user!.id);
    if (!isPublic && !isTargeted) {
      return res.status(403).json({ error: 'Access Denied: You are not authorized to participate in this bidding requirement.' });
    }

    const isInvited = await hasInvitation(reqId, req.user!.id);
    if (!isInvited && !isOpenLoad) {
      return res.status(403).json({ error: 'You are not invited to participate in this bidding round' });
    }

    // Bid Reduction Rule Enforcement: Bids can only be reduced, never increased!
    const existingBid = await getBidFor(reqId, req.user!.id);
    if (existingBid && bidAmount >= existingBid.amount) {
      return res.status(400).json({ 
        error: `Bid Reduction Rule: You can only submit a lower quotation than your previous rate of ₹${existingBid.amount.toLocaleString()}` 
      });
    }

    const nowStr = new Date().toISOString();
    const bidId = generateId('bid');

    await writeDB(dbStore => {
      // Re-validate against the FRESH committed state (see bid handler above)
      const freshReq = dbStore.requirements.find(r => r.id === reqId);
      if (!freshReq) throw new BidValidationError('Requirement not found');
      const freshOpen = freshReq.status === 'active' || freshReq.status === 'published' || freshReq.status === 'LIVE';
      if (!freshOpen) throw new BidValidationError('This bidding round is currently closed or inactive');
      const freshNow = Date.now();
      if (freshReq.bidOpeningTime && freshNow < new Date(freshReq.bidOpeningTime).getTime()) {
        throw new BidValidationError('Bidding has not opened yet for this requirement');
      }
      if (freshReq.bidClosingTime && freshNow >= new Date(freshReq.bidClosingTime).getTime()) {
        throw new BidValidationError('Bidding has closed for this requirement');
      }
      const freshExisting = dbStore.bids.find(b => b.requirementId === reqId && b.transporterId === req.user!.id);
      if (freshExisting && bidAmount >= freshExisting.amount) {
        throw new BidValidationError(`Bid Reduction Rule: You can only submit a lower quotation than your previous rate of ₹${freshExisting.amount.toLocaleString()}`);
      }

      // Record in history
      dbStore.bidHistory.push({
        id: generateId('bh'),
        requirementId: reqId,
        transporterId: req.user!.id,
        amount: bidAmount,
        timestamp: nowStr
      });

      // Update active bid
      const actIdx = dbStore.bids.findIndex(b => b.requirementId === reqId && b.transporterId === req.user!.id);
      if (actIdx !== -1) {
        dbStore.bids[actIdx].amount = bidAmount;
        dbStore.bids[actIdx].lastUpdated = nowStr;
      } else {
        dbStore.bids.push({
          id: bidId,
          requirementId: reqId,
          transporterId: req.user!.id,
          amount: bidAmount,
          timestamp: nowStr,
          lastUpdated: nowStr
        });
      }
    }, {
      lockKeys: [`auction:${reqId}`],
      lockRequirementIds: [reqId],
      requirementScope: [reqId],
      tables: ['requirements', 'bids', 'bidHistory']
    });

    await logAudit(req.user!.id, req.user!.email, req.user!.role, `SUBMIT_BID_V1: ₹${bidAmount} for Requirement ${reqId}`, req);

    // Notify clients instantly via sockets
    io.to(`req_${reqId}`).emit('rank_updated', { requirementId: reqId });

    return res.json({ success: true, message: 'Your quotation was submitted successfully', amount: bidAmount });
  } catch (error: any) {
    if (error instanceof BidValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Submit bid failed:', error);
    return res.status(500).json({ error: 'Failed to submit bid' });
  }
});

/**
 * PUT /api/v1/bids/:id
 * Update an existing bid rate for a requirement. Only accessible by Transporters.
 * :id can be the Bid ID or the Requirement ID.
 */
app.put('/api/v1/bids/:id', authenticate, biddingLimiter, authorize(['TRANSPORTER']), async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;

  if (amount === undefined || isNaN(Number(amount)) || Number(amount) <= 0 || Number(amount) > MAX_BID_AMOUNT) {
    return res.status(400).json({ error: 'Valid positive bid amount is required' });
  }

  const bidAmount = Number(amount);

  try {
    // Find bid by bid ID, or if not found, assume 'id' is requirement ID and find existing bid for this transporter/requirement
    let bidItem = await getBidById(id);
    let reqId = bidItem ? bidItem.requirementId : id;

    if (!bidItem) {
      bidItem = await getBidFor(reqId, req.user!.id);
    }

    if (!bidItem) {
      return res.status(404).json({ error: 'Bid not found. Please submit a new bid rate first.' });
    }

    // IDOR FIX: a bid looked up by its own ID must belong to the caller, otherwise
    // a transporter could overwrite another transporter's quotation.
    if (bidItem.transporterId !== req.user!.id) {
      return res.status(403).json({ error: 'Access Denied: You can only update your own bid quotation' });
    }

    reqId = bidItem.requirementId;

    const reqItem = await getRequirementById(reqId);
    if (!reqItem) {
      return res.status(404).json({ error: 'Requirement not found' });
    }

    const isOpenLoad = reqItem.status === 'active' || reqItem.status === 'published' || reqItem.status === 'LIVE';
    if (!isOpenLoad) {
      return res.status(400).json({ error: 'This bidding round is currently closed or inactive' });
    }

    // Enforce the auction window
    const nowMs = Date.now();
    if (reqItem.bidOpeningTime && nowMs < new Date(reqItem.bidOpeningTime).getTime()) {
      return res.status(400).json({ error: 'Bidding has not opened yet for this requirement' });
    }
    if (reqItem.bidClosingTime && nowMs >= new Date(reqItem.bidClosingTime).getTime()) {
      maybeAutoCloseExpired().catch(console.error);
      return res.status(400).json({ error: 'Bidding has closed for this requirement' });
    }

    // Bid Reduction Rule Enforcement: Bids can only be reduced, never increased!
    if (bidAmount >= bidItem.amount) {
      return res.status(400).json({ 
        error: `Bid Reduction Rule: You can only submit a lower quotation than your previous rate of ₹${bidItem.amount.toLocaleString()}` 
      });
    }

    const nowStr = new Date().toISOString();

    await writeDB(dbStore => {
      // Re-validate against the FRESH committed state (see bid handler above)
      const freshReq = dbStore.requirements.find(r => r.id === reqId);
      if (!freshReq) throw new BidValidationError('Requirement not found');
      const freshOpen = freshReq.status === 'active' || freshReq.status === 'published' || freshReq.status === 'LIVE';
      if (!freshOpen) throw new BidValidationError('This bidding round is currently closed or inactive');
      const freshNow = Date.now();
      if (freshReq.bidOpeningTime && freshNow < new Date(freshReq.bidOpeningTime).getTime()) {
        throw new BidValidationError('Bidding has not opened yet for this requirement');
      }
      if (freshReq.bidClosingTime && freshNow >= new Date(freshReq.bidClosingTime).getTime()) {
        throw new BidValidationError('Bidding has closed for this requirement');
      }
      const freshExisting = dbStore.bids.find(b => b.id === bidItem!.id || (b.requirementId === reqId && b.transporterId === req.user!.id));
      if (!freshExisting) throw new BidValidationError('Bid not found. Please submit a new bid rate first.');
      if (bidAmount >= freshExisting.amount) {
        throw new BidValidationError(`Bid Reduction Rule: You can only submit a lower quotation than your previous rate of ₹${freshExisting.amount.toLocaleString()}`);
      }

      // Record in history
      dbStore.bidHistory.push({
        id: generateId('bh'),
        requirementId: reqId,
        transporterId: req.user!.id,
        amount: bidAmount,
        timestamp: nowStr
      });

      // Update active bid
      const actIdx = dbStore.bids.findIndex(b => b.id === freshExisting.id);
      if (actIdx !== -1) {
        dbStore.bids[actIdx].amount = bidAmount;
        dbStore.bids[actIdx].lastUpdated = nowStr;
      }
    }, {
      lockKeys: [`auction:${reqId}`],
      lockRequirementIds: [reqId],
      requirementScope: [reqId],
      tables: ['requirements', 'bids', 'bidHistory']
    });

    await logAudit(req.user!.id, req.user!.email, req.user!.role, `UPDATE_BID_V1: ₹${bidAmount} for Requirement ${reqId}`, req);

    // Notify clients instantly via sockets
    io.to(`req_${reqId}`).emit('rank_updated', { requirementId: reqId });

    return res.json({ success: true, message: 'Your quotation was updated successfully', amount: bidAmount });
  } catch (error: any) {
    if (error instanceof BidValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Update bid failed:', error);
    return res.status(500).json({ error: 'Failed to update bid' });
  }
});

// ==========================================
// SECURE ADMINISTRATIVE DELETE ENDPOINTS
// ==========================================

/**
 * DELETE /api/v1/admin/staff/:id
 * Permanently deletes a Registered Corporate Staff member.
 * Restricted strictly to SUPER_ADMIN (Master Admin).
 */
app.delete('/api/v1/admin/staff/:id', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  const { id } = req.params;

  try {
    const staffUser = await getUserById(id);
    if (!staffUser) {
      return res.status(404).json({ error: 'Staff account not found' });
    }

    if (staffUser.email.toLowerCase() === 'aronkumar.logistics@gmail.com') {
      return res.status(400).json({ error: 'Access Denied: The primary Master Admin account cannot be deleted.' });
    }

    if (staffUser.id === req.user.id) {
      return res.status(400).json({ error: 'Access Denied: You cannot delete your own active administrator account.' });
    }

    // Soft delete (Phase 5 - data persistence): the staff row is flagged
    // is_deleted=TRUE, never physically removed - historical audit records that
    // reference this user stay intact. Sessions (auth tokens) are still revoked.
    await queryPool('DELETE FROM sessions WHERE user_id = $1', [id]);
    await queryPool('UPDATE users SET is_deleted = TRUE WHERE id = $1', [id]);

    await logAudit(
      req.user.id,
      req.user.email,
      req.user.role,
      `DELETE_STAFF: Soft-deleted staff ${staffUser.name} (${staffUser.email})`,
      req,
      redactSecrets(JSON.stringify(staffUser)),
      null
    );

    return res.json({ success: true, message: 'Staff member deleted successfully' });
  } catch (error) {
    console.error('Delete staff error:', error);
    return res.status(500).json({ error: 'Failed to delete staff account' });
  }
});

/**
 * DELETE /api/v1/admin/transporters/:id
 * Permanently deletes a Registered Transporter.
 * Restricted strictly to SUPER_ADMIN (Master Admin).
 */
app.delete('/api/v1/admin/transporters/:id', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  const { id } = req.params;

  try {
    const transporter = await getTransporterById(id);
    if (!transporter) {
      return res.status(404).json({ error: 'Transporter not found' });
    }

    // Soft delete (Phase 5 - data persistence): the transporter row is flagged
    // is_deleted=TRUE, never physically removed. Their bids, bid history,
    // invitations, and awards stay in the database as permanent historical
    // records (an auction's award must remain attributable even if the winner
    // later leaves the platform). Sessions (auth tokens) are still revoked.
    await queryPool('DELETE FROM sessions WHERE transporter_id = $1', [id]);
    await queryPool('UPDATE transporters SET is_deleted = TRUE WHERE id = $1', [id]);

    await logAudit(
      req.user.id,
      req.user.email,
      req.user.role,
      `DELETE_TRANSPORTER: Soft-deleted transporter ${transporter.companyName} (${transporter.email})`,
      req,
      redactSecrets(JSON.stringify(transporter)),
      null
    );

    return res.json({ success: true, message: 'Transporter deleted successfully' });
  } catch (error) {
    console.error('Delete transporter error:', error);
    return res.status(500).json({ error: 'Failed to delete transporter' });
  }
});

/**
 * DELETE /api/v1/admin/requirements/:id
 * Permanently deletes a Bidding Auction.
 * Restricted strictly to SUPER_ADMIN (Master Admin).
 */
app.delete('/api/v1/admin/requirements/:id', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  const { id } = req.params;

  try {
    const requirement = await getRequirementById(id);
    if (!requirement) {
      return res.status(404).json({ error: 'Requirement auction not found' });
    }

    // Soft delete (Phase 5 - data persistence): the auction row is flagged
    // is_deleted=TRUE, never physically removed. Its bids, bid history,
    // invitations, and award stay in the database as permanent historical
    // records - an audit trail must survive the auction's lifecycle.
    await queryPool('UPDATE requirements SET is_deleted = TRUE WHERE id = $1', [id]);

    await logAudit(
      req.user.id,
      req.user.email,
      req.user.role,
      `DELETE_REQUIREMENT: Soft-deleted requirement auction ${id}`,
      req,
      JSON.stringify(requirement),
      null
    );

    // Also emit socket event to any listening room
    io.to(`req_${id}`).emit('requirement_deleted', { requirementId: id });

    return res.json({ success: true, message: 'Bidding auction deleted successfully' });
  } catch (error) {
    console.error('Delete requirement error:', error);
    return res.status(500).json({ error: 'Failed to delete bidding auction' });
  }
});

// ==========================================
// STATIC ASSETS AND VITE MIDDLEWARE
// ==========================================

/**
 * DELETE /api/v1/admin/rate-limits
 * Clears rate-limit buckets (Super Admin only). Ops escape hatch for a legit
 * user locked out by a shared IP or a buggy client hammering one endpoint.
 * Optional ?key= filters to a single bucket prefix (e.g. ?key=login).
 */
app.delete('/api/v1/admin/rate-limits', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  try {
    const keyFilter = typeof req.query.key === 'string' && req.query.key.trim() ? req.query.key.trim() : null;
    const del = keyFilter
      ? await queryPool('DELETE FROM rate_limits WHERE key LIKE $1', [`${keyFilter}%`])
      : await queryPool('DELETE FROM rate_limits');
    await logAudit(
      req.user!.id,
      req.user!.email,
      req.user!.role,
      `CLEAR_RATE_LIMITS${keyFilter ? ` (key prefix: ${keyFilter})` : ' (all)'}`,
      req
    );
    return res.json({ success: true, cleared: del.rowCount || 0, key: keyFilter || 'all' });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to clear rate limits', detail: error.message });
  }
});

/**
 * GET /api/v1/admin/db-audit
 * Read-only database introspection for operations/super admins: row counts,
 * index coverage, and account inventory. No sensitive data is returned.
 */
app.get('/api/v1/admin/db-audit', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  try {
    const tables = ['users', 'transporters', 'requirements', 'requirement_invitations', 'bids', 'bid_history', 'awards', 'sessions', 'audit_logs', 'sms_logs', 'email_logs', 'whatsapp_logs', 'rate_limits'];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      try {
        const r = await queryPool(`SELECT count(*) FROM ${t}`);
        counts[t] = parseInt(r.rows[0].count, 10);
      } catch {
        counts[t] = -1;
      }
    }

    const idxRes = await queryPool(
      "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename, indexname",
      [tables]
    );

    const usersRes = await queryPool('SELECT id, email, role, status FROM users ORDER BY email');
    const transRes = await queryPool('SELECT id, company_name, email, status FROM transporters ORDER BY email');

    // Data-persistence proof (Phase 5): the OLDEST record timestamp per core
    // business table - read-only, so it only ever proves retention, never
    // touches data. Timestamps are ISO-8601 strings (VARCHAR) so MIN() is a
    // lexicographic (chronological) min.
    const oldest: Record<string, string | null> = {};
    const oldestQueries: [string, string][] = [
      ['bids', 'SELECT MIN(timestamp) AS t FROM bids'],
      ['requirements', 'SELECT MIN(created_at) AS t FROM requirements'],
      ['audit_logs', 'SELECT MIN(timestamp) AS t FROM audit_logs']
    ];
    for (const [name, sql] of oldestQueries) {
      try {
        const r = await queryPool(sql);
        oldest[name] = r.rows[0] && r.rows[0].t ? r.rows[0].t : null;
      } catch (e: any) {
        oldest[name] = null;
      }
    }

    // Soft-deleted (is_deleted = TRUE) counts - how many rows are hidden but
    // retained, proving deletes never physically erase records.
    const softDeleted: Record<string, number> = {};
    const softTables: [string, string][] = [
      ['users', 'users'],
      ['transporters', 'transporters'],
      ['requirements', 'requirements']
    ];
    for (const [name, table] of softTables) {
      try {
        const r = await queryPool(`SELECT count(*) FROM ${table} WHERE is_deleted = TRUE`);
        softDeleted[name] = parseInt(r.rows[0].count, 10);
      } catch (e: any) {
        softDeleted[name] = -1;
      }
    }

    return res.json({
      counts,
      indexes: idxRes.rows,
      users: usersRes.rows,
      transporters: transRes.rows,
      oldest,
      softDeleted
    });
  } catch (error: any) {
    return res.status(500).json({ error: 'DB audit failed', detail: error.message });
  }
});

app.get('/api/db-verify', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  try {
    const dbUrl = process.env.DATABASE_URL || '';
    const hasNeon = dbUrl.includes('neon.tech');
    const poolInfo = getPoolInfo();

    // Empirical pooled-endpoint detection (TWO independent signals):
    //  1. PIDs: PgBouncer (transaction mode) can route consecutive autocommit
    //     statements to different backend processes => distinct PIDs = pooled.
    //  2. Session persistence (conclusive): a direct connection keeps SET
    //     across statements; PgBouncer transaction mode drops it, because the
    //     connection returns to the pool at the end of each transaction.
    const backendPids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await queryPool('SELECT pg_backend_pid() AS pid');
      backendPids.push(parseInt(r.rows[0].pid, 10));
    }
    const pooledPids = new Set(backendPids).size > 1;

    await queryPool("SET application_name = 'fleexbid_pool_test'");
    const sess = await queryPool('SHOW application_name');
    const sessionPersists = sess.rows[0].application_name === 'fleexbid_pool_test';
    // The hostname is the ground truth: the connection string either points at
    // the PgBouncer endpoint (-pooler) or it doesn't. The empirical signals are
    // probabilistic - an idle pool reuses the same backend PID across all four
    // probes (pooledPids=false) and session state can leak between back-to-back
    // statements from the same client even in transaction mode - so treat the
    // connection as pooled if ANY signal says so.
    const pooled = poolInfo.pooledHostname || pooledPids || !sessionPersists;

    const maxConnsRes = await queryPool('SHOW max_connections').catch(() => null);
    const maxConnections = maxConnsRes ? parseInt(maxConnsRes.rows[0].max_connections, 10) : null;
    const meRes = await queryPool('SELECT current_user, current_database() AS db');

    const result = await queryPool('SELECT count(*) FROM users');
    const userCount = parseInt(result.rows[0].count, 10);

    return res.json({
      success: true,
      hasNeon,
      pooled,
      sessionPersists,
      pooledPids,
      pooledHostname: poolInfo.pooledHostname,
      host: poolInfo.host,
      port: poolInfo.port,
      backendPids,
      db: {
        userCount,
        maxConnections,
        user: meRes.rows[0].current_user,
        database: meRes.rows[0].db,
        // The pooled endpoint hostname for this project (add -pooler to the
        // endpoint id) - for use when switching DATABASE_URL in Vercel.
        pooledHostCandidate: poolInfo.host.replace(/^(ep-[^.]+)/, '$1-pooler')
      },
      pool: {
        ssl: poolInfo.ssl,
        max: poolInfo.max,
        connectionTimeoutMillis: poolInfo.connectionTimeoutMillis,
        idleTimeoutMillis: poolInfo.idleTimeoutMillis,
        total: poolInfo.totalCount,
        idle: poolInfo.idleCount,
        waiting: poolInfo.waitingCount
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// Unmatched API routes return JSON 404 instead of the SPA fallback HTML
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`FleexBid Server running securely on http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;

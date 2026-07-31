import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cookieParser from 'cookie-parser';
import path from 'path';
import bcrypt from 'bcryptjs';
import { createServer as createViteServer } from 'vite';

import { getDB, writeDB, generateId, onDBWrite, initDatabase } from './server/db';
import { queryPool } from './server/db_pool';
import { rateLimit } from 'express-rate-limit';
import { 
  createSession, 
  rotateSession, 
  revokeSession, 
  verifyToken, 
  otpStore, 
  generateOtp, 
  hashValue 
} from './server/auth';
import { 
  sendOtpSms, 
  sendOtpEmail,
  sendTransporterSmtpOtp,
  sendSms,
  sendEmail,
  notifyPublishedRequirement, 
  notifyAwardedBid, 
  notifyLostBid,
  EmailLog,
  SmsLog,
  WhatsAppLog
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
  UserRole
} from './src/types';
import aiRouter from './server/ai-router';

const app = express();
app.set('trust proxy', 1);

// Enforce strict environment validation at launch
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
if (isProduction) {
  if (!process.env.DATABASE_URL) {
    throw new Error('CRITICAL CONFIGURATION ERROR: DATABASE_URL environment variable is undefined at production runtime.');
  }
  if (!process.env.JWT_SECRET) {
    throw new Error('CRITICAL CONFIGURATION ERROR: JWT_SECRET environment variable is undefined at production runtime.');
  }
}

// Self-initializing database runner for serverless environments
let isDbInitialized = false;
async function ensureDbInitialized() {
  if (isDbInitialized) return;
  try {
    await initDatabase();
    isDbInitialized = true;
  } catch (err) {
    console.error('Database initialization failed:', err);
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

// Initialize Socket.io
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Custom CORS middleware allowing credentials and matching origins dynamically
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-refresh-token, x-device-id');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use(express.json());
app.use(cookieParser());

// Dynamic helper to get cookie options
function getCookieOptions(req: express.Request, maxAge: number) {
  const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  return {
    httpOnly: true,
    secure: isProd ? true : (req.secure || req.headers['x-forwarded-proto'] === 'https'),
    sameSite: isProd ? ('none' as const) : ('lax' as const),
    maxAge
  };
}

// Simple cache for app url
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Global Socket Io namespace
io.on('connection', (socket) => {
  socket.on('join_requirement', (requirementId) => {
    socket.join(`req_${requirementId}`);
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

  await writeDB(db => {
    db.auditLogs.push({
      id: generateId('audit'),
      userId,
      userEmail,
      role,
      action,
      timestamp: new Date().toISOString(),
      ipAddress,
      device,
      oldValue,
      newValue
    });
  });
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

// Rate limiters to protect critical services from brute force/rapid API spam
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' },
  validate: { trustProxy: false }
});

const biddingLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bidding requests. Please rate limit your API calls.' },
  validate: { trustProxy: false }
});

const requirementsLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests for requirement resources. Please slow down.' },
  validate: { trustProxy: false }
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
    const decoded = verifyToken(token) as { id: string; email: string; role: UserRole; name: string };
    const db = await getDB();

    let finalStatus = '';

    // Verify status from live database to enforce blocks/permissions immediately
    if (decoded.role !== 'TRANSPORTER') {
      const staffUser = db.users.find(u => u.id === decoded.id);
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
      const transporter = db.transporters.find(t => t.id === decoded.id);
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

    // Check sessions validity in database
    const activeSess = db.sessions.some(s => {
      const matchId = decoded.role === 'TRANSPORTER' ? s.transporterId === decoded.id : s.userId === decoded.id;
      return matchId && new Date(s.expiry) > new Date();
    });

    if (!activeSess) {
      return res.status(401).json({ error: 'Unauthorized: Session revoked or expired' });
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
 * Calculate standard competition ranking (1-2-2-4)
 */
export async function calculateRanks(requirementId: string): Promise<TransporterRank[]> {
  const db = await getDB();
  const req = db.requirements.find(r => r.id === requirementId);
  if (!req) return [];

  // Get invited transporters
  const invitations = db.requirementInvitations.filter(
    i => i.requirementId === requirementId && i.status === 'INVITED'
  );
  const invitedTransporterIds = invitations.map(i => i.transporterId);

  // Get active bids
  const reqBids = db.bids.filter(b => b.requirementId === requirementId);
  const biddingTransporterIds = reqBids.map(b => b.transporterId);

  // Combine invited and bidding transporters
  const allTransporterIds = Array.from(new Set([...invitedTransporterIds, ...biddingTransporterIds]));

  // Build ranking list for all participating/invited transporters
  const ranks: TransporterRank[] = allTransporterIds.map(transporterId => {
    const trans = db.transporters.find(t => t.id === transporterId);
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

  // Assign standard competition rank: rank = 1 + count of bids strictly cheaper
  submittedBids.forEach((curr) => {
    const countStrictlyLower = submittedBids.filter(other => other.amount < curr.amount).length;
    curr.rank = countStrictlyLower + 1;
    curr.isL1 = curr.rank === 1;
  });

  // Merge ranked bids back into invited list
  ranks.forEach(r => {
    const ranked = submittedBids.find(s => s.transporterId === r.transporterId);
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
 * Background loop to automatically close requirements on expiry,
 * and execute AUTOMATIC awarding if configured and no L1 tie is present!
 */
async function autoCloseAndAwardRequirements() {
  try {
    const db = await getDB();
    const now = new Date();
    
    const liveReqs = db.requirements.filter(r => r.status === 'LIVE');
    
    for (const req of liveReqs) {
      const closingDate = new Date(req.bidClosingTime);
      if (now >= closingDate) {
        console.log(`Auto-closing requirement ${req.id} due to expiry...`);
        
        // Recalculate ranks to determine winner
        const ranks = await calculateRanks(req.id);
        const l1Bids = ranks.filter(r => r.isL1 && r.amount !== null);

        let finalStatus: RequirementStatus = 'CLOSED';

        if (req.awardType === 'AUTOMATIC') {
          if (l1Bids.length === 1) {
            // Unambiguous L1 - Automatic award!
            const winner = l1Bids[0];
            finalStatus = 'AWARDED';
            
            await writeDB(async (dbStore) => {
              const awardId = generateId('award');
              dbStore.awards.push({
                id: awardId,
                requirementId: req.id,
                transporterId: winner.transporterId,
                amount: winner.amount!,
                awardedAt: now.toISOString(),
                awardedBy: 'SYSTEM_AUTO',
                tieBreakLog: null
              });
              
              // Find and update requirement status
              const targetReq = dbStore.requirements.find(r => r.id === req.id);
              if (targetReq) targetReq.status = 'AWARDED';
            });

            // Notify winner and losers
            const winTrans = db.transporters.find(t => t.id === winner.transporterId);
            if (winTrans) {
              await notifyAwardedBid(req, winTrans, winner.amount!, APP_URL);
            }
            // Notify losers
            for (const otherBid of ranks.filter(r => r.transporterId !== winner.transporterId && r.amount !== null)) {
              const loseTrans = db.transporters.find(t => t.id === otherBid.transporterId);
              if (loseTrans) {
                await notifyLostBid(req, loseTrans);
              }
            }

            io.to(`req_${req.id}`).emit('rank_updated', { requirementId: req.id });
            io.emit('requirement_updated', { id: req.id, status: 'AWARDED' });
          } else if (l1Bids.length > 1) {
            // L1 tie - Automatic award fails, manual tie resolution gate!
            finalStatus = 'TIE_RESOLUTION_REQUIRED';
            await writeDB(dbStore => {
              const targetReq = dbStore.requirements.find(r => r.id === req.id);
              if (targetReq) targetReq.status = 'TIE_RESOLUTION_REQUIRED';
            });
            
            // Log in audit log
            db.auditLogs.push({
              id: generateId('audit'),
              userId: 'SYSTEM',
              userEmail: 'system@logibid.com',
              role: null,
              action: `AUTO_AWARD_PAUSED_TIE_DETECTED`,
              timestamp: now.toISOString(),
              ipAddress: null,
              device: null,
              oldValue: 'LIVE',
              newValue: 'TIE_RESOLUTION_REQUIRED'
            });

            io.to(`req_${req.id}`).emit('rank_updated', { requirementId: req.id });
            io.emit('requirement_updated', { id: req.id, status: 'TIE_RESOLUTION_REQUIRED' });
          } else {
            // No bids received
            await writeDB(dbStore => {
              const targetReq = dbStore.requirements.find(r => r.id === req.id);
              if (targetReq) targetReq.status = 'CLOSED';
            });
            io.emit('requirement_updated', { id: req.id, status: 'CLOSED' });
          }
        } else {
          // MANUAL award
          await writeDB(dbStore => {
            const targetReq = dbStore.requirements.find(r => r.id === req.id);
            if (targetReq) targetReq.status = 'CLOSED';
          });
          io.emit('requirement_updated', { id: req.id, status: 'CLOSED' });
        }
      }
    }
  } catch (error) {
    console.error('Error in auto close check:', error);
  }
}
setInterval(autoCloseAndAwardRequirements, 10000); // Check every 10 seconds

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
    const db = await getDB();
    const user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());

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

    return res.json({
      success: true,
      accessToken,
      refreshToken,
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
    const db = await getDB();
    const transporter = db.transporters.find(t => t.email.toLowerCase() === normalizedEmail);

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

    return res.json({
      success: true,
      accessToken,
      refreshToken,
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

  return res.json({ 
    success: true,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken
  });
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
  const db = await getDB();
  return res.json({ transporters: db.transporters });
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
    vehicleTypes, 
    operatingStates, 
    preferredRoutes,
    password
  } = req.body;

  if (!companyName || !contactPerson || !email || !mobileNumber || !gstNumber || !panNumber || !password) {
    return res.status(400).json({ error: 'All primary fields and a secure password are required to onboard a transporter' });
  }

  try {
    const db = await getDB();
    
    // Check duplication
    const dupEmail = db.transporters.find(t => t.email.toLowerCase() === email.toLowerCase());
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
      vehicleTypes: vehicleTypes || [],
      operatingStates: operatingStates || [],
      preferredRoutes: preferredRoutes || [],
      status: 'ACTIVE',
      passwordHash
    };

    await writeDB(dbStore => {
      dbStore.transporters.push(newTr);
    });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `ONBOARD_TRANSPORTER: ${companyName}`, 
      req, 
      null, 
      JSON.stringify({ ...newTr, passwordHash: '[REDACTED]' })
    );

    return res.json({ success: true, transporter: newTr });
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
    const db = await getDB();
    const trIndex = db.transporters.findIndex(t => t.id === id);
    if (trIndex === -1) {
      return res.status(404).json({ error: 'Transporter not found' });
    }

    const oldVal = JSON.stringify(db.transporters[trIndex]);
    const updated = { ...db.transporters[trIndex], ...updateData };

    // Prevent changing registered mobile or email to block credential hijacking
    updated.email = db.transporters[trIndex].email;
    updated.mobileNumber = db.transporters[trIndex].mobileNumber;

    if (updateData.password) {
      updated.passwordHash = await bcrypt.hash(updateData.password, 10);
      delete updated.password;
    }

    await writeDB(dbStore => {
      dbStore.transporters[trIndex] = updated;
    });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `UPDATE_TRANSPORTER: ${updated.companyName}`, 
      req, 
      oldVal, 
      JSON.stringify(updated)
    );

    return res.json({ success: true, transporter: updated });
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
  const db = await getDB();
  return res.json({ staff: db.users });
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

  try {
    const db = await getDB();
    
    // Check duplication
    const dupEmail = db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (dupEmail) {
      return res.status(400).json({ error: 'A staff member with this email address already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const newStaff: User = {
      id: generateId('usr'),
      email,
      name,
      role,
      status,
      passwordHash
    };

    await writeDB(dbStore => {
      dbStore.users.push(newStaff);
    });

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
    const db = await getDB();
    const staffIndex = db.users.findIndex(u => u.id === id);
    if (staffIndex === -1) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const oldVal = JSON.stringify(db.users[staffIndex]);
    const updated = { ...db.users[staffIndex], ...updateData };

    // Prevent changing registered email of master admin to block hijack
    if (db.users[staffIndex].email.toLowerCase() === 'aronkumar.logistics@gmail.com') {
      updated.email = db.users[staffIndex].email;
      updated.role = 'SUPER_ADMIN'; // Enforce role protection
    } else {
      updated.email = db.users[staffIndex].email;
    }

    if (updateData.password) {
      updated.passwordHash = await bcrypt.hash(updateData.password, 10);
      delete updated.password;
    }

    await writeDB(dbStore => {
      dbStore.users[staffIndex] = updated;
    });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `UPDATE_STAFF: ${updated.name}`, 
      req, 
      oldVal, 
      JSON.stringify(updated)
    );

    return res.json({ success: true, staff: updated });
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
app.get('/api/requirements', authenticate, async (req, res) => {
  const db = await getDB();
  const role = req.user!.role;

  const mapRequirementWithAward = (r: any) => {
    const award = db.awards.find(a => a.requirementId === r.id);
    return {
      ...r,
      awardedTransporterId: award ? award.transporterId : null,
      awardedAmount: award ? award.amount : null
    };
  };

  if (role === 'SUPER_ADMIN' || role === 'LOGISTICS') {
    const mapped = db.requirements.map(mapRequirementWithAward);
    return res.json({ requirements: mapped });
  } else {
    // Transporter - filter only LIVE/active/published or invited or where they bid/won
    const invs = db.requirementInvitations.filter(
      i => i.transporterId === req.user!.id && i.status === 'INVITED'
    );
    const invIds = invs.map(i => i.requirementId);

    const bidIds = db.bids.filter(b => b.transporterId === req.user!.id).map(b => b.requirementId);
    const awardIds = db.awards.filter(a => a.transporterId === req.user!.id).map(a => a.requirementId);

    const filtered = db.requirements.filter(r => {
      // Must satisfy targeted transporter filter first!
      const isPublic = !r.targeted_transporter_ids || r.targeted_transporter_ids.length === 0;
      const isTargeted = r.targeted_transporter_ids && r.targeted_transporter_ids.includes(req.user!.id);
      if (!isPublic && !isTargeted) {
        return false;
      }

      const isOpenLoad = r.status === 'active' || r.status === 'published' || r.status === 'LIVE';
      if (isOpenLoad) return true;
      return (invIds.includes(r.id) || bidIds.includes(r.id) || awardIds.includes(r.id)) && r.status !== 'DRAFT';
    });

    const mapped = filtered.map(mapRequirementWithAward);
    return res.json({ requirements: mapped });
  }
});

/**
 * GET /api/requirements/:id
 * Fetches requirement detail. Restricts non-invited transporters.
 */
app.get('/api/requirements/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  const db = await getDB();
  
  const reqItem = db.requirements.find(r => r.id === id);
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

    const isInvited = db.requirementInvitations.some(
      i => i.requirementId === id && i.transporterId === req.user!.id && i.status === 'INVITED'
    );
    const isOpenLoad = reqItem.status === 'active' || reqItem.status === 'published' || reqItem.status === 'LIVE';
    const hasBid = db.bids.some(b => b.requirementId === id && b.transporterId === req.user!.id);
    const hasAward = db.awards.some(a => a.requirementId === id && a.transporterId === req.user!.id);

    if (!isInvited && !isOpenLoad && !hasBid && !hasAward) {
      return res.status(403).json({ error: 'Forbidden: You are not invited to participate in this auction' });
    }
  }

  // Find invited transporters with detail
  const invitations = db.requirementInvitations.filter(i => i.requirementId === id);
  const invitedTrs = invitations.map(inv => {
    const tr = db.transporters.find(t => t.id === inv.transporterId);
    return {
      transporterId: inv.transporterId,
      companyName: tr?.companyName || 'Unknown',
      status: inv.status,
      removedReason: inv.removedReason
    };
  });

  const award = db.awards.find(a => a.requirementId === id);
  const requirementWithAward = {
    ...reqItem,
    awardedTransporterId: award ? award.transporterId : null,
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

  const db = await getDB();
  const created: Requirement[] = [];
  const errors: string[] = [];

  // Validate all items first
  requirements.forEach((r, idx) => {
    if (!r.pickupLocation || !r.deliveryLocation || !r.material || !r.weight || !r.vehicleType || !r.pickupDate || !r.bidClosingTime) {
      errors.push(`Row ${idx + 1}: Missing mandatory parameters.`);
    }
    const closing = new Date(r.bidClosingTime);
    if (isNaN(closing.getTime()) || closing <= new Date()) {
      errors.push(`Row ${idx + 1}: Bid Closing Time must be a valid future datetime.`);
    }
  });

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', detail: errors });
  }

  try {
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
          // Fallback auto-matching by vehicle type
          eligibleTransporters = dbStore.transporters
            .filter(t => t.status === 'ACTIVE' && t.vehicleTypes.includes(r.vehicleType))
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
    const db = await getDB();
    const reqIndex = db.requirements.findIndex(r => r.id === id);
    if (reqIndex === -1) {
      return res.status(404).json({ error: 'Requirement not found' });
    }

    if (db.requirements[reqIndex].status !== 'DRAFT') {
      return res.status(400).json({ error: 'Can only edit requirements in DRAFT status' });
    }

    const oldVal = JSON.stringify(db.requirements[reqIndex]);
    const updated = { ...db.requirements[reqIndex], ...updateData };

    await writeDB(dbStore => {
      dbStore.requirements[reqIndex] = updated;
    });

    await logAudit(
      req.user!.id, 
      req.user!.email, 
      req.user!.role, 
      `EDIT_REQUIREMENT: ${id}`, 
      req, 
      oldVal, 
      JSON.stringify(updated)
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
    const db = await getDB();
    const reqItem = db.requirements.find(r => r.id === id);
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
    });

    // Notify all eligible transporters
    const invitations = db.requirementInvitations.filter(
      i => i.requirementId === id && i.status === 'INVITED'
    );

    for (const inv of invitations) {
      const trans = db.transporters.find(t => t.id === inv.transporterId);
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
    const db = await getDB();
    const target = db.requirements.find(r => r.id === id);
    if (!target) return res.status(404).json({ error: 'Requirement not found' });

    await writeDB(dbStore => {
      const r = dbStore.requirements.find(x => x.id === id);
      if (r) r.status = 'CANCELLED';
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

  if (!newClosingTime || isNaN(new Date(newClosingTime).getTime())) {
    return res.status(400).json({ error: 'Valid future closing time is required' });
  }

  try {
    const db = await getDB();
    const target = db.requirements.find(r => r.id === id);
    if (!target) return res.status(404).json({ error: 'Requirement not found' });

    const oldTime = target.bidClosingTime;

    await writeDB(dbStore => {
      const r = dbStore.requirements.find(x => x.id === id);
      if (r) r.status = 'LIVE'; // Ensure it becomes LIVE again if it was closed
      if (r) r.bidClosingTime = new Date(newClosingTime).toISOString();
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
    const db = await getDB();
    const reqItem = db.requirements.find(r => r.id === id);
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
      const trans = db.transporters.find(t => t.id === transporterId);
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
app.get('/api/requirements/:id/ranks', authenticate, async (req, res) => {
  const { id } = req.params;
  const role = req.user!.role;

  try {
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
        const db = await getDB();
        const reqItem = db.requirements.find(r => r.id === id);
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
app.post('/api/requirements/:id/bid', authenticate, authorize(['TRANSPORTER']), async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;

  if (amount === undefined || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Valid positive bid amount is required' });
  }

  const bidAmount = Number(amount);

  try {
    const db = await getDB();
    const reqItem = db.requirements.find(r => r.id === id);
    if (!reqItem) {
      return res.status(404).json({ error: 'Requirement not found' });
    }

    const isOpenLoad = reqItem.status === 'active' || reqItem.status === 'published' || reqItem.status === 'LIVE';
    if (!isOpenLoad) {
      return res.status(400).json({ error: 'This bidding round is currently closed or inactive' });
    }

    // Strict targeted transporters check
    const isPublic = !reqItem.targeted_transporter_ids || reqItem.targeted_transporter_ids.length === 0;
    const isTargeted = reqItem.targeted_transporter_ids && reqItem.targeted_transporter_ids.includes(req.user!.id);
    if (!isPublic && !isTargeted) {
      return res.status(403).json({ error: 'Access Denied: You are not authorized to participate in this bidding requirement.' });
    }

    // Is invited?
    const isInvited = db.requirementInvitations.some(
      i => i.requirementId === id && i.transporterId === req.user!.id && i.status === 'INVITED'
    );
    if (!isInvited && !isOpenLoad) {
      return res.status(403).json({ error: 'You are not invited to bid on this requirement' });
    }

    // Bid Reduction Rule Enforcement: Bids can only be reduced, never increased!
    const existingBid = db.bids.find(b => b.requirementId === id && b.transporterId === req.user!.id);
    if (existingBid && bidAmount >= existingBid.amount) {
      return res.status(400).json({ error: `You can only submit a lower quotation than your previous rate of ₹${existingBid.amount.toLocaleString()}` });
    }

    const nowStr = new Date().toISOString();
    const bidId = generateId('bid');

    await writeDB(dbStore => {
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
    });

    await logAudit(req.user!.id, req.user!.email, req.user!.role, `SUBMIT_BID: ₹${bidAmount} for Requirement ${id}`, req);

    // Notify clients instantly via sockets
    io.to(`req_${id}`).emit('rank_updated', { requirementId: id });

    return res.json({ success: true, message: 'Your quotation was submitted successfully' });
  } catch (error) {
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
    const db = await getDB();
    const reqItem = db.requirements.find(r => r.id === id);
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

    const selectedBid = db.bids.find(b => b.requirementId === id && b.transporterId === transporterId);
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
    });

    // Notify winner
    const winTrans = db.transporters.find(t => t.id === transporterId);
    if (winTrans) {
      notifyAwardedBid(reqItem, winTrans, selectedBid.amount, APP_URL).catch(console.error);
    }

    // Notify other participating bidders
    const participatingBidders = db.bids.filter(b => b.requirementId === id && b.transporterId !== transporterId);
    for (const b of participatingBidders) {
      const lostTrans = db.transporters.find(t => t.id === b.transporterId);
      if (lostTrans) {
        notifyLostBid(reqItem, lostTrans).catch(console.error);
      }
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
  const db = await getDB();
  const config = db.notificationProviderConfigs.find(c => c.id === 'default');

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
    const db = await getDB();
    const configIdx = db.notificationProviderConfigs.findIndex(c => c.id === 'default');

    if (configIdx === -1) {
      return res.status(404).json({ error: 'Configuration document not found' });
    }

    const current = db.notificationProviderConfigs[configIdx];
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
      dbStore.notificationProviderConfigs[configIdx] = updated;
    });

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

  const msg = testMessage || 'LogiBid: This is a secure notification configuration test message.';

  try {
    if (channel === 'sms') {
      const sent = await sendSms(targetAddress, msg);
      if (sent) return res.json({ success: true, message: 'Test SMS dispatched successfully' });
      throw new Error('SMS Gateway connection failed');
    } else if (channel === 'email') {
      const sent = await sendEmail(targetAddress, 'LogiBid Test Connection', `<h3>LogiBid Portal</h3><p>${msg}</p>`);
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
  const db = await getDB();
  return res.json({
    // @ts-ignore
    smsLogs: db.smsLogs || [],
    // @ts-ignore
    emailLogs: db.emailLogs || [],
    // @ts-ignore
    whatsAppLogs: db.whatsAppLogs || []
  });
});

/**
 * GET /api/logs/audit
 * Fetches security audit logs
 */
app.get('/api/logs/audit', authenticate, authorize(['SUPER_ADMIN', 'LOGISTICS']), async (req, res) => {
  const db = await getDB();
  return res.json({ logs: db.auditLogs });
});

/**
 * GET /api/sessions
 * List active transporter/user devices and active logins
 */
app.get('/api/sessions', authenticate, async (req, res) => {
  const db = await getDB();
  const filtered = db.sessions.filter(s => {
    return req.user!.role === 'TRANSPORTER' ? s.transporterId === req.user!.id : s.userId === req.user!.id;
  });
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
app.use('/api/ai', authenticate, aiRouter);

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
  });

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', detail: errors });
  }

  try {
    const db = await getDB();
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

        // Auto-invite active transporters matching vehicle types
        let eligibleTransporters = targetedTransporters;
        if (eligibleTransporters.length === 0) {
          eligibleTransporters = dbStore.transporters
            .filter(t => t.status === 'ACTIVE' && t.vehicleTypes.includes(r.vehicleType))
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
    });

    // Notify matching active transporters dynamically via SMS/Email/WhatsApp
    for (const newReqItem of created) {
      const invitations = db.requirementInvitations.filter(i => i.requirementId === newReqItem.id);
      for (const inv of invitations) {
        const trans = db.transporters.find(t => t.id === inv.transporterId);
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
app.post('/api/v1/bids', authenticate, authorize(['TRANSPORTER']), async (req, res) => {
  const { requirementId, requirement_id, amount } = req.body;
  const reqId = requirementId || requirement_id;

  if (!reqId) {
    return res.status(400).json({ error: 'requirementId is required' });
  }
  if (amount === undefined || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Valid positive bid amount is required' });
  }

  const bidAmount = Number(amount);

  try {
    const db = await getDB();
    const reqItem = db.requirements.find(r => r.id === reqId);
    if (!reqItem) {
      return res.status(404).json({ error: 'Requirement not found' });
    }

    const isOpenLoad = reqItem.status === 'active' || reqItem.status === 'published' || reqItem.status === 'LIVE';
    if (!isOpenLoad) {
      return res.status(400).json({ error: 'This bidding round is currently closed or inactive' });
    }

    // Strict targeted transporters check
    const isPublic = !reqItem.targeted_transporter_ids || reqItem.targeted_transporter_ids.length === 0;
    const isTargeted = reqItem.targeted_transporter_ids && reqItem.targeted_transporter_ids.includes(req.user!.id);
    if (!isPublic && !isTargeted) {
      return res.status(403).json({ error: 'Access Denied: You are not authorized to participate in this bidding requirement.' });
    }

    const isInvited = db.requirementInvitations.some(
      i => i.requirementId === reqId && i.transporterId === req.user!.id && i.status === 'INVITED'
    );
    if (!isInvited && !isOpenLoad) {
      return res.status(403).json({ error: 'You are not invited to participate in this bidding round' });
    }

    // Bid Reduction Rule Enforcement: Bids can only be reduced, never increased!
    const existingBid = db.bids.find(b => b.requirementId === reqId && b.transporterId === req.user!.id);
    if (existingBid && bidAmount >= existingBid.amount) {
      return res.status(400).json({ 
        error: `Bid Reduction Rule: You can only submit a lower quotation than your previous rate of ₹${existingBid.amount.toLocaleString()}` 
      });
    }

    const nowStr = new Date().toISOString();
    const bidId = generateId('bid');

    await writeDB(dbStore => {
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
    });

    await logAudit(req.user!.id, req.user!.email, req.user!.role, `SUBMIT_BID_V1: ₹${bidAmount} for Requirement ${reqId}`, req);

    // Notify clients instantly via sockets
    io.to(`req_${reqId}`).emit('rank_updated', { requirementId: reqId });

    return res.json({ success: true, message: 'Your quotation was submitted successfully', amount: bidAmount });
  } catch (error) {
    console.error('Submit bid failed:', error);
    return res.status(500).json({ error: 'Failed to submit bid' });
  }
});

/**
 * PUT /api/v1/bids/:id
 * Update an existing bid rate for a requirement. Only accessible by Transporters.
 * :id can be the Bid ID or the Requirement ID.
 */
app.put('/api/v1/bids/:id', authenticate, authorize(['TRANSPORTER']), async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;

  if (amount === undefined || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Valid positive bid amount is required' });
  }

  const bidAmount = Number(amount);

  try {
    const db = await getDB();
    
    // Find bid by bid ID, or if not found, assume 'id' is requirement ID and find existing bid for this transporter/requirement
    let bidItem = db.bids.find(b => b.id === id);
    let reqId = bidItem ? bidItem.requirementId : id;

    if (!bidItem) {
      bidItem = db.bids.find(b => b.requirementId === reqId && b.transporterId === req.user!.id);
    }

    if (!bidItem) {
      return res.status(404).json({ error: 'Bid not found. Please submit a new bid rate first.' });
    }

    reqId = bidItem.requirementId;

    const reqItem = db.requirements.find(r => r.id === reqId);
    if (!reqItem) {
      return res.status(404).json({ error: 'Requirement not found' });
    }

    const isOpenLoad = reqItem.status === 'active' || reqItem.status === 'published' || reqItem.status === 'LIVE';
    if (!isOpenLoad) {
      return res.status(400).json({ error: 'This bidding round is currently closed or inactive' });
    }

    // Bid Reduction Rule Enforcement: Bids can only be reduced, never increased!
    if (bidAmount >= bidItem.amount) {
      return res.status(400).json({ 
        error: `Bid Reduction Rule: You can only submit a lower quotation than your previous rate of ₹${bidItem.amount.toLocaleString()}` 
      });
    }

    const nowStr = new Date().toISOString();

    await writeDB(dbStore => {
      // Record in history
      dbStore.bidHistory.push({
        id: generateId('bh'),
        requirementId: reqId,
        transporterId: req.user!.id,
        amount: bidAmount,
        timestamp: nowStr
      });

      // Update active bid
      const actIdx = dbStore.bids.findIndex(b => b.id === bidItem!.id || (b.requirementId === reqId && b.transporterId === req.user!.id));
      if (actIdx !== -1) {
        dbStore.bids[actIdx].amount = bidAmount;
        dbStore.bids[actIdx].lastUpdated = nowStr;
      }
    });

    await logAudit(req.user!.id, req.user!.email, req.user!.role, `UPDATE_BID_V1: ₹${bidAmount} for Requirement ${reqId}`, req);

    // Notify clients instantly via sockets
    io.to(`req_${reqId}`).emit('rank_updated', { requirementId: reqId });

    return res.json({ success: true, message: 'Your quotation was updated successfully', amount: bidAmount });
  } catch (error) {
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
app.delete('/api/v1/admin/staff/:id', authenticate, async (req, res) => {
  if (!req.user || req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: "Access Denied: Only a Master Administrator can delete these records." });
  }

  const { id } = req.params;

  try {
    const db = await getDB();
    const staffUser = db.users.find(u => u.id === id);
    if (!staffUser) {
      return res.status(404).json({ error: 'Staff account not found' });
    }

    if (staffUser.email.toLowerCase() === 'aronkumar.logistics@gmail.com') {
      return res.status(400).json({ error: 'Access Denied: The primary Master Admin account cannot be deleted.' });
    }

    if (staffUser.id === req.user.id) {
      return res.status(400).json({ error: 'Access Denied: You cannot delete your own active administrator account.' });
    }

    await queryPool('DELETE FROM sessions WHERE user_id = $1', [id]);
    await writeDB(dbStore => {
      dbStore.users = dbStore.users.filter(u => u.id !== id);
    });

    await logAudit(
      req.user.id,
      req.user.email,
      req.user.role,
      `DELETE_STAFF: Deleted staff ${staffUser.name} (${staffUser.email})`,
      req,
      JSON.stringify(staffUser),
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
app.delete('/api/v1/admin/transporters/:id', authenticate, async (req, res) => {
  if (!req.user || req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: "Access Denied: Only a Master Administrator can delete these records." });
  }

  const { id } = req.params;

  try {
    const db = await getDB();
    const transporter = db.transporters.find(t => t.id === id);
    if (!transporter) {
      return res.status(404).json({ error: 'Transporter not found' });
    }

    await queryPool('DELETE FROM sessions WHERE transporter_id = $1', [id]);
    await writeDB(dbStore => {
      dbStore.transporters = dbStore.transporters.filter(t => t.id !== id);
      dbStore.bids = dbStore.bids.filter(b => b.transporterId !== id);
      dbStore.bidHistory = dbStore.bidHistory.filter(bh => bh.transporterId !== id);
      dbStore.requirementInvitations = dbStore.requirementInvitations.filter(ri => ri.transporterId !== id);
      dbStore.awards = dbStore.awards.filter(a => a.transporterId !== id);
    });

    await logAudit(
      req.user.id,
      req.user.email,
      req.user.role,
      `DELETE_TRANSPORTER: Deleted transporter ${transporter.companyName} (${transporter.email})`,
      req,
      JSON.stringify(transporter),
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
app.delete('/api/v1/admin/requirements/:id', authenticate, async (req, res) => {
  if (!req.user || req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: "Access Denied: Only a Master Administrator can delete these records." });
  }

  const { id } = req.params;

  try {
    const db = await getDB();
    const requirement = db.requirements.find(r => r.id === id);
    if (!requirement) {
      return res.status(404).json({ error: 'Requirement auction not found' });
    }

    await writeDB(dbStore => {
      dbStore.requirements = dbStore.requirements.filter(r => r.id !== id);
      dbStore.bids = dbStore.bids.filter(b => b.requirementId !== id);
      dbStore.bidHistory = dbStore.bidHistory.filter(bh => bh.requirementId !== id);
      dbStore.requirementInvitations = dbStore.requirementInvitations.filter(ri => ri.requirementId !== id);
      dbStore.awards = dbStore.awards.filter(a => a.requirementId !== id);
    });

    await logAudit(
      req.user.id,
      req.user.email,
      req.user.role,
      `DELETE_REQUIREMENT: Deleted requirement auction ${id}`,
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

app.get('/api/db-verify', async (req, res) => {
  try {
    const dbUrl = process.env.DATABASE_URL || '';
    const hasNeon = dbUrl.includes('neon.tech');
    
    let host = 'unknown';
    if (dbUrl) {
      const match = dbUrl.match(/@([^/?#]+)/);
      if (match) host = match[1];
    }
    
    const { queryPool } = await import('./server/db_pool.js');
    const result = await queryPool('SELECT count(*) FROM users');
    const userCount = parseInt(result.rows[0].count, 10);
    
    return res.json({
      success: true,
      hasNeon,
      host,
      userCount
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
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
    console.log(`LogiBid Server running securely on http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;

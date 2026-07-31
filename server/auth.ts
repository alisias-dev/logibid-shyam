import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { generateId } from './db';
import { queryPool } from './db_pool';
import { Session, UserRole } from '../src/types';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_logibid_key_2026_rfv_tgb';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 90;

// In-memory OTP store
interface OtpState {
  hashedOtp: string;
  expiry: number;
  attempts: number;
  requestCount: number;
  lastRequested: number;
}
export const otpStore = new Map<string, OtpState>();

// Periodically clean up expired OTPs
setInterval(() => {
  const now = Date.now();
  for (const [mobile, state] of otpStore.entries()) {
    if (state.expiry < now) {
      otpStore.delete(mobile);
    }
  }
}, 60000);

export interface TokenPayload {
  id: string;
  email: string;
  role: UserRole;
  name: string;
}

/**
 * Generate a cryptographically secure 6-digit OTP
 */
export function generateOtp(): string {
  const num = crypto.randomInt(100000, 999999);
  return num.toString();
}

/**
 * Hash utility for OTPs & Refresh Tokens
 */
export function hashValue(val: string): string {
  return crypto.createHash('sha256').update(val).digest('hex');
}

/**
 * JWT utilities
 */
export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export function signRefreshToken(payload: { id: string; role: UserRole; deviceId: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}d` });
}

export function verifyToken(token: string): any {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Session Lifecycle Operations
 */
export async function createSession(
  targetId: string,
  role: UserRole,
  deviceId: string,
  browser: string,
  os: string,
  ipAddress: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const payload: TokenPayload = {
    id: targetId,
    email: '',
    role,
    name: ''
  };

  // Get email and name from DB using database-native snake_case columns
  if (role === 'TRANSPORTER') {
    const res = await queryPool('SELECT email, company_name FROM transporters WHERE id = $1', [targetId]);
    if (res.rows.length > 0) {
      payload.email = res.rows[0].email;
      payload.name = res.rows[0].companyName; // Mapped back by key normalizer
    }
  } else {
    const res = await queryPool('SELECT email, name FROM users WHERE id = $1', [targetId]);
    if (res.rows.length > 0) {
      payload.email = res.rows[0].email;
      payload.name = res.rows[0].name;
    }
  }

  const rawRefreshToken = crypto.randomBytes(40).toString('hex');
  const hashedRefreshToken = hashValue(rawRefreshToken);
  const now = new Date();
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

  const accessToken = signAccessToken(payload);
  const refreshTokenJwt = signRefreshToken({ id: targetId, role, deviceId });

  const newSession: Session = {
    id: generateId('sess'),
    transporterId: role === 'TRANSPORTER' ? targetId : null,
    userId: role !== 'TRANSPORTER' ? targetId : null,
    userRole: role,
    deviceId,
    browser,
    os,
    ipAddress,
    loginTime: now.toISOString(),
    lastActivity: now.toISOString(),
    refreshToken: hashedRefreshToken,
    expiry: expiryDate.toISOString()
  };

  // Revoke any existing session for the SAME device to prevent duplicate leakage (using snake_case)
  await queryPool(
    'DELETE FROM sessions WHERE device_id = $1 AND (transporter_id = $2 OR user_id = $2)',
    [deviceId, targetId]
  );

  // Insert the new session (using snake_case)
  await queryPool(
    'INSERT INTO sessions (id, transporter_id, user_id, user_role, device_id, browser, os, ip_address, login_time, last_activity, refresh_token, expiry) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
    [
      newSession.id,
      newSession.transporterId,
      newSession.userId,
      newSession.userRole,
      newSession.deviceId,
      newSession.browser,
      newSession.os,
      newSession.ipAddress,
      newSession.loginTime,
      newSession.lastActivity,
      newSession.refreshToken,
      newSession.expiry
    ]
  );

  return {
    accessToken,
    refreshToken: refreshTokenJwt + '::' + rawRefreshToken
  };
}

/**
 * Session Rotation (OTP-less continuous refresh)
 * Includes replay attack detection!
 */
export async function rotateSession(
  refreshTokenComposite: string,
  deviceId: string,
  browser: string,
  os: string,
  ipAddress: string
): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const parts = refreshTokenComposite.split('::');
    if (parts.length !== 2) return null;
    const [jwtPart, rawToken] = parts;

    const payload = verifyToken(jwtPart) as { id: string; role: UserRole; deviceId: string };
    if (!payload || payload.deviceId !== deviceId) return null;

    const hashedToken = hashValue(rawToken);

    // Find the session in the database (using snake_case)
    const resSess = await queryPool(
      'SELECT * FROM sessions WHERE device_id = $1 AND refresh_token = $2',
      [deviceId, hashedToken]
    );

    if (resSess.rows.length === 0) {
      console.warn(`Potential session theft detected for device ${deviceId}. Revoking all sessions.`);
      await queryPool(
        'DELETE FROM sessions WHERE transporter_id = $1 OR user_id = $1',
        [payload.id]
      );
      return null;
    }

    const session = resSess.rows[0];

    // Check expiry
    if (new Date(session.expiry) < new Date()) {
      await queryPool('DELETE FROM sessions WHERE id = $1', [session.id]);
      return null;
    }

    // Prepare rotated credentials
    const rawNewRefreshToken = crypto.randomBytes(40).toString('hex');
    const hashedNewRefreshToken = hashValue(rawNewRefreshToken);
    const now = new Date();
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    const tokenPayload: TokenPayload = {
      id: payload.id,
      email: '',
      role: payload.role,
      name: ''
    };

    if (payload.role === 'TRANSPORTER') {
      const res = await queryPool('SELECT email, company_name FROM transporters WHERE id = $1', [payload.id]);
      if (res.rows.length > 0) {
        tokenPayload.email = res.rows[0].email;
        tokenPayload.name = res.rows[0].companyName;
      }
    } else {
      const res = await queryPool('SELECT email, name FROM users WHERE id = $1', [payload.id]);
      if (res.rows.length > 0) {
        tokenPayload.email = res.rows[0].email;
        tokenPayload.name = res.rows[0].name;
      }
    }

    const accessToken = signAccessToken(tokenPayload);
    const newRefreshTokenJwt = signRefreshToken({ id: payload.id, role: payload.role, deviceId });

    // Update the rotated details (using snake_case)
    await queryPool(
      'UPDATE sessions SET refresh_token = $1, last_activity = $2, expiry = $3, browser = $4, os = $5, ip_address = $6 WHERE id = $7',
      [hashedNewRefreshToken, now.toISOString(), expiryDate.toISOString(), browser, os, ipAddress, session.id]
    );

    return {
      accessToken,
      refreshToken: newRefreshTokenJwt + '::' + rawNewRefreshToken
    };
  } catch (error) {
    console.error('Failed to rotate refresh token:', error);
    return null;
  }
}

/**
 * Revoke session
 */
export async function revokeSession(deviceId: string, userIdOrTransporterId: string): Promise<void> {
  await queryPool(
    'DELETE FROM sessions WHERE device_id = $1 AND (transporter_id = $2 OR user_id = $2)',
    [deviceId, userIdOrTransporterId]
  );
}

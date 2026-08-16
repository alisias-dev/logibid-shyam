import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { generateId, invalidateReadCache } from './db';
import { queryPool } from './db_pool';
import { Session, UserRole } from '../src/types';

// Never fall back to a hardcoded secret: that would let anyone forge valid JWTs.
// In production the app refuses to boot without JWT_SECRET (enforced in app.ts).
// In development we generate an ephemeral random secret so tokens cannot be forged
// with a publicly known key (sessions simply invalidate on server restart).
const JWT_SECRET =
  process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set - using an ephemeral random secret. Sessions will not survive a restart. Set JWT_SECRET in production.');
}
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 90;

export interface TokenPayload {
  id: string;
  email: string;
  role: UserRole;
  name: string;
}

/**
 * Hash utility for Refresh Tokens (SHA-256 - a refresh token is high-entropy
 * random material, so a keyed HMAC is unnecessary; plain hashing is sufficient).
 */
export function hashValue(val: string): string {
  return crypto.createHash('sha256').update(val).digest('hex');
}

/**
 * JWT utilities
 *
 * Access tokens embed `jti` = the database session id they were issued for.
 * The authenticate middleware requires the session row to still exist, so a
 * token dies the instant its session is revoked (logout, device re-login,
 * admin block) instead of lingering for the full 15-minute expiry.
 */
export function signAccessToken(payload: TokenPayload, jti?: string): string {
  return jwt.sign({ ...payload, jti }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
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

  // The access token is bound to THIS session via jti (see signAccessToken).
  const accessToken = signAccessToken(payload, newSession.id);
  const refreshTokenJwt = signRefreshToken({ id: targetId, role, deviceId });

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

  // Session rows changed - flush the read cache so the new session id (and the
  // revoked old device session) are visible to authenticate() immediately.
  invalidateReadCache();

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

    // Keep the SAME session id in the rotated access token (jti binding), so
    // the token continues to die if this session is ever revoked.
    const accessToken = signAccessToken(tokenPayload, session.id);
    const newRefreshTokenJwt = signRefreshToken({ id: payload.id, role: payload.role, deviceId });

    // Update the rotated details (using snake_case)
    await queryPool(
      'UPDATE sessions SET refresh_token = $1, last_activity = $2, expiry = $3, browser = $4, os = $5, ip_address = $6 WHERE id = $7',
      [hashedNewRefreshToken, now.toISOString(), expiryDate.toISOString(), browser, os, ipAddress, session.id]
    );

    // Session row updated (rotated) - flush the read cache so authenticate()
    // sees the live session immediately.
    invalidateReadCache();

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
  // Session row deleted - flush the read cache so the revoked access token
  // (jti-bound to this session) is rejected on the very next request.
  invalidateReadCache();
}

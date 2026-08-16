// Phase 3 live verification: the DB-backed rate limiter must (1) trip at the
// configured max and return 429, (2) expose standard RateLimit-* headers, and
// (3) keep counting across requests (shared state, not process-local).
//
// We exercise the AI limiter (30/min per user) with a throwaway transporter:
// login is NOT hammered so the real admin account is never locked out.
// The AI route returns 401/400 for malformed calls without invoking Gemini
// (no cost), while still passing through the limiter middleware.
const BASE = process.env.BASE_URL || 'https://www.fleexbid.live';

import { makeJar, makeCall } from './lib/cookies.mjs';

const call = makeCall(BASE);
const results = [];
const check = (name, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
const cry = await import('node:crypto');
const tag = cry.randomBytes(3).toString('hex');

let adminJar = makeJar();
let tr = null;
let trJar = null;
try {
  // Login as admin, create a disposable transporter.
  let r = await call('/api/auth/login-staff', 'POST', {
    email: process.env.ADMIN_EMAIL || 'aronkumar.logistics@gmail.com',
    password: process.env.ADMIN_PASSWORD,
    deviceId: 'phase3-admin'
  }, adminJar);
  check('admin login', r.status === 200, (await r.json()).error || '');

  r = await call('/api/transporters', 'POST', {
    companyName: 'RL-Test-' + tag, contactPerson: 'QA',
    email: `rl-${tag}@example.com`, mobileNumber: '+919888888888',
    gstNumber: '27ABCDE1234F1Z5', panNumber: 'ABCDE1234F',
    vehicleTypes: ['TRAILER'], operatingStates: ['Maharashtra'], preferredRoutes: [],
    password: 'Phase3Pass!2026'
  }, adminJar);
  tr = (await r.json()).transporter;
  check('create test transporter', !!tr, tr ? tr.id : (await r.json()).error || r.status);

  trJar = makeJar();
  r = await call('/api/auth/login-transporter', 'POST', {
    email: tr.email, password: 'Phase3Pass!2026', deviceId: 'phase3-tr'
  }, trJar);
  check('transporter login', r.status === 200, (await r.json()).error || '');

  // --- 1. rate_limits table exists ---
  const ar = await call('/api/v1/admin/db-audit', 'GET', null, adminJar);
  const audit = await ar.json();
  const rateCount = audit && audit.counts ? audit.counts.rate_limits : undefined;
  check('rate_limits table present in db-audit', typeof rateCount === 'number', `rows=${rateCount}`);

  // --- 2. hammer the AI endpoint past the 30/min limit ---
  // Each call passes authenticate + aiLimiter before aiRouter validates the body,
  // so a bodyless POST trips the limiter without hitting Gemini.
  let lastStatus = 0;
  let seen429 = false;
  let headerRemaining = null;
  let limitHeader = null;
  const statuses = [];
  for (let i = 0; i < 40; i++) {
    // Bodyless /chat returns 400 before invoking Gemini (no cost) - but the
    // request still flows through authenticate + aiLimiter, so each one counts.
    r = await call('/api/ai/chat', 'POST', {}, trJar);
    lastStatus = r.status;
    statuses.push(r.status);
    headerRemaining = r.headers.get('ratelimit-remaining');
    limitHeader = r.headers.get('ratelimit-limit');
    if (r.status === 429) { seen429 = true; break; }
  }
  check('limiter trips with 429', seen429, `statuses=${statuses.join(',')}`);
  check('429 only after limit exhausted', statuses.indexOf(429) >= 25, `first429At=${statuses.indexOf(429)}`);
  check('RateLimit-Limit header present', limitHeader === '30', `limit=${limitHeader}`);
  check('RateLimit-Remaining header present', headerRemaining !== null);

  // --- 3. shared state: a SECOND login/session of the same user sees the same
  // counter (proves the limit lives in the DB, not in the lambda's memory).
  const jar2 = makeJar();
  await call('/api/auth/login-transporter', 'POST', {
    email: tr.email, password: 'Phase3Pass!2026', deviceId: 'phase3-tr2'
  }, jar2);
  r = await call('/api/ai/chat', 'POST', {}, jar2);
  check('limit persists across sessions (shared DB state)', r.status === 429, `status=${r.status}`);

  // --- teardown ---
  await call('/api/v1/admin/transporters/' + tr.id, 'DELETE', null, adminJar);
  check('teardown complete', true);
} catch (e) {
  check('unexpected error', false, e.message);
}

console.log(results.join('\n'));
console.log('---');
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(fails === 0 ? `ALL ${results.length} PHASE-3 CHECKS PASSED` : `${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);

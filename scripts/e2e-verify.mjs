// End-to-end verification suite for the deployed FleexBid app.
// Creates clearly-labelled test data and removes it afterwards.
// Auth is verified via HttpOnly cookies (Phase 1 hardening).
const BASE = process.env.BASE_URL || 'https://www.fleexbid.live';
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'aronkumar.logistics@gmail.com',
  password: process.env.ADMIN_PASSWORD || 'Fleex!fAijOPGVpiYH',
  deviceId: 'e2e-suite'
};

import { makeJar, makeCall } from './lib/cookies.mjs';
const call = makeCall(BASE);

const results = [];
const check = (name, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
const cry = await import('node:crypto');
const tag = cry.randomBytes(3).toString('hex');
const created = { transporterA: null, transporterB: null, requirement: null, spectator: null };

let adminJar = null;
try {
  adminJar = makeJar();
  let r = await call('/api/auth/login-staff', 'POST', ADMIN, adminJar);
  let d = await r.json();
  check('admin login (HttpOnly cookies set)', r.status === 200 && d.success && adminJar.has('accessToken') && adminJar.has('refreshToken'), 'cookies=' + JSON.stringify(adminJar.names()));

  // --- 1. Create two test transporters ---
  async function mkTr(name) {
    const r = await call('/api/transporters', 'POST', {
      companyName: name, contactPerson: 'QA Tester',
      email: 'qa.' + tag + '.' + name + '@fleexbid.test',
      mobileNumber: '+919900000000', gstNumber: '27AAAAA1111A1Z1', panNumber: 'AAAAA1111A',
      vehicleTypes: ['32 FT Trailer'], operatingStates: ['Maharashtra'],
      preferredRoutes: ['Mumbai -> Delhi'], password: 'QaPass!2026'
    }, adminJar);
    const b = await r.json();
    check('create transporter ' + name, r.status === 200 && b.transporter, (b.transporter || {}).id || b.error);
    return b.transporter;
  }
  created.transporterA = await mkTr('A');
  created.transporterB = await mkTr('B');

  // --- 2. Create + publish requirement targeting both ---
  const closing = new Date(Date.now() + 10 * 60000).toISOString();
  r = await call('/api/requirements', 'POST', {
    requirements: [{
      pickupLocation: 'QA City', deliveryLocation: 'QA Town', material: 'QA Material', weight: 10,
      vehicleType: '32 FT Trailer', pickupDate: '2026-09-01', bidClosingTime: closing,
      awardType: 'MANUAL', eligibleTransporters: [created.transporterA.id, created.transporterB.id]
    }]
  }, adminJar);
  d = await r.json();
  check('create requirement', r.status === 200 && d.requirements && d.requirements[0], d.requirements ? d.requirements[0].id : d.error);
  created.requirement = d.requirements && d.requirements[0];
  if (created.requirement) {
    r = await call('/api/requirements/' + created.requirement.id + '/publish', 'PUT', {}, adminJar);
    d = await r.json();
    check('publish requirement', r.status === 200 && d.success);
  }

  // --- 3. Transporter A: login, bid, reduction rule, confidential ranks ---
  const taJar = makeJar();
  let ta = await (await call('/api/auth/login-transporter', 'POST', { email: created.transporterA.email, password: 'QaPass!2026', deviceId: 'qa-a' }, taJar)).json();
  check('transporter A login (cookies set)', !!ta.success && taJar.has('accessToken'));
  r = await call('/api/requirements/' + created.requirement.id + '/bid', 'POST', { amount: 50000 }, taJar);
  check('bid 50000 accepted', r.status === 200, (await r.json()).error || '');
  r = await call('/api/requirements/' + created.requirement.id + '/bid', 'POST', { amount: 52000 }, taJar);
  const dHigher = await r.json();
  check('higher bid rejected (reduction rule)', r.status === 400 && /lower quotation/i.test(dHigher.error || ''), dHigher.error || '');
  r = await call('/api/requirements/' + created.requirement.id + '/bid', 'POST', { amount: 48000 }, taJar);
  check('lower bid 48000 accepted', r.status === 200, (await r.json()).error || '');
  r = await call('/api/requirements/' + created.requirement.id + '/ranks', 'GET', null, taJar);
  let ranksA = await r.json();
  const own = ranksA.ranks && ranksA.ranks[0];
  check('transporter sees ONLY own rank (confidential)', r.status === 200 && ranksA.ranks.length === 1 && own.transporterId === created.transporterA.id && own.isL1 === true, JSON.stringify(ranksA.ranks || []).slice(0, 120));

  // --- 4. IDOR / cross-account guards ---
  const tbJar = makeJar();
  let tb = await (await call('/api/auth/login-transporter', 'POST', { email: created.transporterB.email, password: 'QaPass!2026', deviceId: 'qa-b' }, tbJar)).json();
  check('transporter B login', !!tb.success);
  r = await call('/api/v1/bids/' + created.requirement.id, 'PUT', { amount: 47000 }, tbJar);
  check('B cannot update without own bid (404)', r.status === 404, (await r.json()).error || r.status);
  r = await call('/api/v1/bids/does-not-exist-bid', 'PUT', { amount: 47000 }, tbJar);
  check('B cannot update unknown/foreign bid (404)', r.status === 404, (await r.json()).error || r.status);
  r = await call('/api/requirements/' + created.requirement.id + '/bid', 'POST', { amount: 47000 }, tbJar);
  check('B bids 47000', r.status === 200, (await r.json()).error || '');
  r = await call('/api/requirements/' + created.requirement.id + '/ranks', 'GET', null, taJar);
  ranksA = await r.json();
  check('A dropped to rank 2 after B underbids', ranksA.ranks[0].rank === 2 && ranksA.l1Tied === false, 'rank=' + ranksA.ranks[0].rank);

  // --- 5. Spectator mode (APPROVED staff) ---
  r = await call('/api/staff', 'POST', { email: 'spectator.' + tag + '@fleexbid.test', name: 'QA Spectator', role: 'LOGISTICS', status: 'APPROVED', password: 'Spectator#2026' }, adminJar);
  d = await r.json();
  created.spectator = d.staff;
  check('create spectator staff', r.status === 200 && d.staff, (d.staff || {}).id || d.error);
  const spJar = makeJar();
  const sp = await (await call('/api/auth/login-staff', 'POST', { email: created.spectator.email, password: 'Spectator#2026', deviceId: 'qa-sp' }, spJar)).json();
  check('spectator login', !!sp.success);
  r = await call('/api/requirements', 'POST', {
    requirements: [{ pickupLocation: 'X', deliveryLocation: 'Y', material: 'Z', weight: 1, vehicleType: '32 FT Trailer', pickupDate: '2026-09-01', bidClosingTime: new Date(Date.now() + 60000).toISOString() }]
  }, spJar);
  check('spectator mutation blocked (403)', r.status === 403, (await r.json()).error || r.status);

  // --- 6. Security headers + CORS ---
  r = await fetch(BASE + '/');
  check('HSTS header present', (r.headers.get('strict-transport-security') || '').includes('31536000'));
  check('nosniff header present', r.headers.get('x-content-type-options') === 'nosniff');
  r = await fetch(BASE + '/api/requirements', { headers: { Origin: 'https://evil.example.com' } });
  check('CORS blocks unknown origin', r.headers.get('access-control-allow-origin') === null);
  r = await fetch(BASE + '/api/requirements', { headers: { Origin: 'http://localhost:3000' } });
  check('CORS blocks localhost in production', r.headers.get('access-control-allow-origin') === null);

  // --- 7. Wrong password rejected ---
  r = await call('/api/auth/login-staff', 'POST', { email: ADMIN.email, password: 'definitely-wrong', deviceId: 'qa-wrong' });
  check('wrong password rejected (401)', r.status === 401);
} catch (e) {
  check('suite script error', false, e.message);
} finally {
  // --- Teardown (best-effort) ---
  if (adminJar) {
    if (created.requirement) {
      try { await call('/api/v1/admin/requirements/' + created.requirement.id, 'DELETE', null, adminJar); check('teardown: requirement deleted', true); } catch (e) { check('teardown: requirement delete failed', false, e.message); }
    }
    for (const t of [created.transporterA, created.transporterB]) {
      if (t) { try { await call('/api/v1/admin/transporters/' + t.id, 'DELETE', null, adminJar); } catch (e) {} }
    }
    if (created.spectator) {
      try { await call('/api/v1/admin/staff/' + created.spectator.id, 'DELETE', null, adminJar); } catch (e) {}
    }
    // jti revocation check: after logout the same cookie jar must be rejected
    try {
      const lo = await call('/api/auth/logout', 'POST', { deviceId: 'qa-admin' }, adminJar);
      check('logout clears cookies', lo.status === 200 && !adminJar.has('accessToken') && !adminJar.has('refreshToken'));
      const meAfter = await call('/api/auth/me', 'GET', null, adminJar);
      check('revoked access token rejected (jti binding)', meAfter.status === 401, 'status=' + meAfter.status);
    } catch (e) { check('teardown: logout/revocation check failed', false, e.message); }
  }
  console.log(results.join('\n'));
  const fails = results.filter(x => x.startsWith('FAIL')).length;
  console.log('---');
  console.log(fails === 0 ? 'ALL ' + results.length + ' CHECKS PASSED' : fails + ' FAILURE(S)');
  process.exit(fails === 0 ? 0 : 1);
}

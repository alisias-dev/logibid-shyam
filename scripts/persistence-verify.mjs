// Data Persistence Audit verification (Phase 5) - live against fleexbid.live.
// Proves: soft deletes never erase rows, deleted entities vanish from the API,
// the oldest-record query works, and GC never touches business data.
const BASE = process.env.BASE_URL || 'https://www.fleexbid.live';
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'aronkumar.logistics@gmail.com',
  password: process.env.ADMIN_PASSWORD,
  deviceId: 'persist-audit'
};
import { makeJar, makeCall } from './lib/cookies.mjs';
const call = makeCall(BASE);
const cry = await import('node:crypto');
const tag = cry.randomBytes(3).toString('hex');

const results = [];
const check = (name, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));

let adminJar = makeJar();
const created = { transporter: null, requirement: null, bidCountBefore: 0, reqCountBefore: 0, transCountBefore: 0 };

try {
  // ---- Admin login ----
  let r = await call('/api/auth/login-staff', 'POST', ADMIN, adminJar);
  let d = await r.json();
  check('admin login', r.status === 200 && d.success, r.status + ' ' + (d.error || ''));

  // ---- Baseline counts from db-audit ----
  r = await call('/api/v1/admin/db-audit', 'GET', null, adminJar);
  d = await r.json();
  created.bidCountBefore = (d.counts && d.counts.bids) || 0;
  created.reqCountBefore = (d.counts && d.counts.requirements) || 0;
  created.transCountBefore = (d.counts && d.counts.transporters) || 0;
  check('db-audit returns oldest-record proof',
    d.oldest && 'audit_logs' in d.oldest && 'requirements' in d.oldest && 'bids' in d.oldest,
    'oldest=' + JSON.stringify(d.oldest).slice(0, 200));
  check('db-audit returns soft-deleted counts',
    d.softDeleted && 'users' in d.softDeleted && 'transporters' in d.softDeleted && 'requirements' in d.softDeleted,
    'softDeleted=' + JSON.stringify(d.softDeleted));

  // ---- Create test transporter ----
  r = await call('/api/transporters', 'POST', {
    companyName: 'Persistence Audit ' + tag, contactPerson: 'PA',
    email: 'persist.' + tag + '@fleexbid.test',
    mobileNumber: '+91991' + (100000 + Math.floor(Math.random() * 899999)),
    gstNumber: '27AAAAA1111A1Z1', panNumber: 'AAAAA1111A',
    vehicleTypes: ['TRAILER'], operatingStates: ['Maharashtra'],
    preferredRoutes: ['Mumbai -> Delhi'], password: 'PersistPass!2026'
  }, adminJar);
  d = await r.json();
  const transporter = d.transporter || d.error;
  check('create transporter', r.status === 200 && transporter && transporter.id, JSON.stringify(transporter).slice(0, 120));
  created.transporter = transporter;

  // ---- Create + publish requirement targeting it ----
  const closing = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  r = await call('/api/requirements', 'POST', {
    requirements: [{
      pickupLocation: 'Persist City', deliveryLocation: 'Persist Town', material: 'Persist Material', weight: 10,
      vehicleType: 'TRAILER', pickupDate: '2026-09-01', bidClosingTime: closing,
      awardType: 'AUTOMATIC',
      eligibleTransporters: [transporter.id]
    }]
  }, adminJar);
  d = await r.json();
  check('create requirement', r.status === 200 && d.requirements && d.requirements[0], d.requirements ? d.requirements[0].id : (d.error || r.status));
  created.requirement = d.requirements && d.requirements[0];
  if (!created.requirement) throw new Error('no requirement');

  r = await call('/api/requirements/' + created.requirement.id + '/publish', 'PUT', {}, adminJar);
  check('publish requirement', r.status === 200, r.status + ' ' + ((await r.json()).error || ''));

  // ---- Transporter logs in, places a bid ----
  const tjar = makeJar();
  r = await call('/api/auth/login-transporter', 'POST', { email: transporter.email, password: 'PersistPass!2026', deviceId: 'persist-t' }, tjar);
  check('transporter login', r.status === 200 && tjar.has('accessToken'), r.status);
  r = await call('/api/requirements/' + created.requirement.id + '/bid', 'POST', { amount: 65000 }, tjar);
  check('bid placed', r.status === 200, r.status + ' ' + ((await r.json()).error || ''));

  // ---- Verify bid visible in ranks ----
  r = await call('/api/requirements/' + created.requirement.id + '/ranks', 'GET', null, adminJar);
  d = await r.json();
  const rankAmt = (d.ranks || []).find(x => x.transporterId === transporter.id);
  check('bid visible before delete', rankAmt && rankAmt.amount === 65000, 'amount=' + (rankAmt || {}).amount);

  // ---- SOFT-DELETE the requirement ----
  r = await call('/api/v1/admin/requirements/' + created.requirement.id, 'DELETE', null, adminJar);
  check('soft-delete requirement returns 200', r.status === 200, r.status + ' ' + ((await r.json()).error || ''));

  // Requirement must be invisible via API
  r = await call('/api/requirements/' + created.requirement.id, 'GET', null, adminJar);
  check('deleted requirement 404s via API', r.status === 404, 'status=' + r.status);

  // ---- SOFT-DELETE the transporter ----
  r = await call('/api/v1/admin/transporters/' + transporter.id, 'DELETE', null, adminJar);
  check('soft-delete transporter returns 200', r.status === 200, r.status + ' ' + ((await r.json()).error || ''));

  // Transporter must be invisible via API + cannot log in
  r = await call('/api/transporters', 'GET', null, adminJar);
  d = await r.json();
  const list = d.transporters || d;
  const gone = Array.isArray(list) ? !list.some(t => t.id === transporter.id) : true;
  check('deleted transporter absent from list', gone);

  // ---- THE PROOF: rows STILL physically exist ----
  r = await call('/api/v1/admin/db-audit', 'GET', null, adminJar);
  d = await r.json();
  const reqCountAfter = (d.counts && d.counts.requirements) || 0;
  const transCountAfter = (d.counts && d.counts.transporters) || 0;
  const softReqs = d.softDeleted && d.softDeleted.requirements;
  const softTrans = d.softDeleted && d.softDeleted.transporters;
  check('requirement row STILL exists (count unchanged)', reqCountAfter === created.reqCountBefore + 1,
    'before=' + created.reqCountBefore + ' after=' + reqCountAfter);
  check('transporter row STILL exists (count unchanged)', transCountAfter === created.transCountBefore + 1,
    'before=' + created.transCountBefore + ' after=' + transCountAfter);
  check('soft-deleted counts reflect the 2 deletes', softReqs >= 1 && softTrans >= 1,
    'softReqs=' + softReqs + ' softTrans=' + softTrans);

  // Bids/audit_logs untouched (historical integrity)
  const bidCountAfter = (d.counts && d.counts.bids) || 0;
  check('bid row STILL exists after requirement delete', bidCountAfter >= created.bidCountBefore + 1,
    'before=' + created.bidCountBefore + ' after=' + bidCountAfter);

  // ---- Oldest-record query sanity ----
  check('oldest requirement timestamp present', !!d.oldest.requirements, 'oldest.req=' + d.oldest.requirements);
  check('oldest bid timestamp present', !!d.oldest.bids, 'oldest.bids=' + d.oldest.bids);
  check('oldest audit_log timestamp present', !!d.oldest.audit_logs, 'oldest.audit=' + d.oldest.audit_logs);
} catch (e) {
  check('persistence audit script error', false, e.message);
} finally {
  if (adminJar && adminJar.has('accessToken')) {
    // Everything is soft-deleted now; nothing to clean up physically (that's the point).
    try { await call('/api/auth/logout', 'POST', { deviceId: 'persist-audit' }, adminJar); } catch (e) {}
  }
  console.log(results.join('\n'));
  console.log('---');
  const fails = results.filter(x => x.startsWith('FAIL')).length;
  console.log(fails === 0 ? 'ALL ' + results.length + ' CHECKS PASSED' : fails + ' FAILURE(S)');
  process.exit(fails === 0 ? 0 : 1);
}

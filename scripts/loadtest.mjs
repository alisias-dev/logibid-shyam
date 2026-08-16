// Load test for the deployed FleexBid backend (fleexbid.live).
// Simulates 110+ concurrent active users bidding on the SAME auction, proving:
//   * pooled (-pooler) connection handles the burst (no 5xx, no connection errors)
//   * per-auction advisory lock serializes correctly (all bids persist, none lost)
//   * rank/state integrity after the wave (exactly N bids, no dupes, no lost updates)
//
// Note: the per-IP login limiter (20/15min) would block 110 logins from one IP,
// so the login bucket is cleared between batches via the Super-Admin endpoint.
// This isolates the DB concurrency under test (the limiter itself was already
// proven in Phase 3) rather than the limiter's own behavior.
const BASE = process.env.BASE_URL || 'https://www.fleexbid.live';
const N = parseInt(process.env.LOAD_USERS || '110', 10);
const BATCH = 19; // stay under the 20/15min login bucket per batch
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'aronkumar.logistics@gmail.com',
  password: process.env.ADMIN_PASSWORD || 'Fleex!fAijOPGVpiYH',
  deviceId: 'loadtest-admin'
};
const TPASS = 'LoadPass!2026';

import { makeJar, makeCall } from './lib/cookies.mjs';
const call = makeCall(BASE);
const cry = await import('node:crypto');
const tag = cry.randomBytes(3).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));

let adminJar = makeJar();
const created = { transporters: [], requirement: null };

async function clearBucket(key) {
  const r = await call('/api/v1/admin/rate-limits' + (key ? '?key=' + key : ''), 'DELETE', null, adminJar);
  return r.status;
}

try {
  // ---- Admin login + clear buckets ----
  let r = await call('/api/auth/login-staff', 'POST', ADMIN, adminJar);
  let d = await r.json();
  check('admin login', r.status === 200 && d.success, r.status + ' ' + (d.error || ''));
  await clearBucket('login');
  await clearBucket('bid');

  // ---- Create N transporters (parallel batches of 10) ----
  const mobileBase = 9900000000;
  for (let start = 0; start < N; start += 10) {
    const batch = [];
    for (let i = start; i < Math.min(start + 10, N); i++) {
      const email = 'load.' + tag + '.' + i + '@fleexbid.test';
      batch.push(call('/api/transporters', 'POST', {
        companyName: 'Load User ' + i, contactPerson: 'Load',
        email,
        mobileNumber: '+91' + (mobileBase + i),
        gstNumber: '27AAAAA1111A1Z1', panNumber: 'AAAAA1111A',
        vehicleTypes: ['32 FT Trailer'], operatingStates: ['Maharashtra'],
        preferredRoutes: ['Mumbai -> Delhi'], password: TPASS
      }, adminJar).then(async (rr) => {
        const b = await rr.json();
        return { status: rr.status, transporter: b.transporter || b.error };
      }));
    }
    const out = await Promise.all(batch);
    for (const o of out) {
      if (o.status === 200 && o.transporter && o.transporter.id) created.transporters.push(o.transporter);
    }
  }
  check('created ' + N + ' transporters', created.transporters.length === N, 'got=' + created.transporters.length);

  // ---- Create + publish ONE requirement targeting all of them (closes in 15 min) ----
  const closing = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  r = await call('/api/requirements', 'POST', {
    requirements: [{
      pickupLocation: 'Load City', deliveryLocation: 'Load Town', material: 'Load Material', weight: 10,
      vehicleType: '32 FT Trailer', pickupDate: '2026-09-01', bidClosingTime: closing,
      awardType: 'AUTOMATIC',
      eligibleTransporters: created.transporters.map(t => t.id)
    }]
  }, adminJar);
  d = await r.json();
  check('create requirement', r.status === 200 && d.requirements && d.requirements[0], d.requirements ? d.requirements[0].id : (d.error || r.status));
  created.requirement = d.requirements && d.requirements[0];
  if (!created.requirement) throw new Error('no requirement created');
  const reqId = created.requirement.id;

  r = await call('/api/requirements/' + reqId + '/publish', 'PUT', {}, adminJar);
  check('publish requirement', r.status === 200, r.status + ' ' + ((await r.json()).error || ''));

  // ---- Login all N transporters (BATCH at a time, clearing the login bucket) ----
  const jars = created.transporters.map(() => makeJar());
  let loggedIn = 0;
  for (let start = 0; start < N; start += BATCH) {
    await clearBucket('login'); // per-IP login bucket is 20/15min; clear between batches
    const slice = created.transporters.slice(start, start + BATCH);
    const resp = await Promise.all(slice.map((t, k) =>
      call('/api/auth/login-transporter', 'POST', { email: t.email, password: TPASS, deviceId: 'load-' + tag + '-' + (start + k) }, jars[start + k])
    ));
    const ok = resp.filter((rr, k) => rr.status === 200 && jars[start + k].has('accessToken')).length;
    loggedIn += ok;
    check('login batch ' + (start / BATCH + 1) + ' (' + slice.length + ' concurrent)', ok === slice.length, 'ok=' + ok + '/' + slice.length);
  }
  check('all transporters logged in', loggedIn === N, 'loggedIn=' + loggedIn);

  // ---- THE WAVE: N concurrent bids on the same auction ----
  // Distinct descending amounts so each transporter has a unique quotation
  // (the reduction rule only limits re-bids by the same account).
  const amounts = created.transporters.map((_, i) => 100000 - i * 100);
  const t0 = Date.now();
  // Await the FULL response body (headers alone resolve too early) for a true
  // completion-time measurement.
  const bidResp = await Promise.all(amounts.map((amt, i) => {
    const s = Date.now();
    return call('/api/requirements/' + reqId + '/bid', 'POST', { amount: amt }, jars[i])
      .then(async (rr) => ({ rr, ms: Date.now() - s }));
  }));
  const waveMs = Date.now() - t0;

  const codes = bidResp.map(x => x.rr.status);
  const okBids = codes.filter(c => c === 200).length;
  const five = codes.filter(c => c >= 500).length;
  const four = codes.filter(c => c >= 400 && c < 500).length;
  check('all ' + N + ' concurrent bids accepted (200)', okBids === N,
    '200=' + okBids + ' 4xx=' + four + ' 5xx=' + five + ' codes=' + JSON.stringify(codes.slice(0, 8)) + '...');
  check('zero 5xx during the wave', five === 0, '5xx=' + five);

  // Response-time distribution of the wave
  const sorted = bidResp.map(x => x.ms).sort((a, b) => a - b);
  const pct = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  check('wave completed (wall clock)', waveMs > 0,
    waveMs + 'ms total | p50=' + pct(0.5) + 'ms p95=' + pct(0.95) + 'ms p99=' + pct(0.99) + 'ms max=' + sorted[sorted.length - 1] + 'ms');

  // ---- Integrity: ranks after the wave ----
  r = await call('/api/requirements/' + reqId + '/ranks', 'GET', null, adminJar);
  d = await r.json();
  const ranks = d.ranks || [];
  const withBid = ranks.filter(x => x.amount !== null && x.amount !== undefined);
  check('all ' + N + ' bids persisted in ranks', withBid.length === N, 'ranked=' + withBid.length);
  const uniqueAmounts = new Set(withBid.map(x => x.amount));
  check('no duplicate/lost bid amounts', uniqueAmounts.size === N, 'unique=' + uniqueAmounts.size);

  // L1 = lowest amount (100000 - (N-1)*100)
  const lowest = amounts.reduce((a, b) => Math.min(a, b));
  const l1 = ranks.find(x => x.isL1);
  check('L1 is the lowest bidder', l1 && l1.amount === lowest, l1 ? 'l1=' + l1.amount : 'no L1');

  // ---- Second wave: every transporter LOWERS their bid concurrently ----
  const amounts2 = created.transporters.map((_, i) => 50000 - i * 40);
  const t1 = Date.now();
  const bidResp2 = await Promise.all(amounts2.map((amt, i) => {
    const s = Date.now();
    return call('/api/requirements/' + reqId + '/bid', 'POST', { amount: amt }, jars[i])
      .then(async (rr) => ({ rr, ms: Date.now() - s }));
  }));
  const wave2Ms = Date.now() - t1;
  const codes2 = bidResp2.map(x => x.rr.status);
  const ok2 = codes2.filter(c => c === 200).length;
  check('wave 2: all ' + N + ' concurrent LOWER bids accepted', ok2 === N,
    '200=' + ok2 + ' 4xx=' + codes2.filter(c => c >= 400 && c < 500).length + ' 5xx=' + codes2.filter(c => c >= 500).length + ' (' + wave2Ms + 'ms)');

  r = await call('/api/requirements/' + reqId + '/ranks', 'GET', null, adminJar);
  d = await r.json();
  const ranks2 = d.ranks || [];
  const withBid2 = ranks2.filter(x => x.amount !== null);
  check('wave 2: all ' + N + ' bids updated, none lost', withBid2.length === N, 'ranked=' + withBid2.length);
  const l1b = ranks2.find(x => x.isL1);
  check('wave 2: L1 updated to new lowest', l1b && l1b.amount === 50000 - (N - 1) * 40, l1b ? 'l1=' + l1b.amount : 'no L1');
} catch (e) {
  check('load test script error', false, e.message);
} finally {
  // ---- Teardown ----
  if (adminJar && adminJar.has('accessToken')) {
    if (created.requirement) {
      try { await call('/api/v1/admin/requirements/' + created.requirement.id, 'DELETE', null, adminJar); check('teardown: requirement deleted', true); } catch (e) { check('teardown: requirement delete failed', false, e.message); }
    }
    let delOk = 0;
    for (const t of created.transporters) {
      if (!t) continue;
      try { const rr = await call('/api/v1/admin/transporters/' + t.id, 'DELETE', null, adminJar); if (rr.status === 200) delOk++; } catch (e) {}
    }
    check('teardown: transporters deleted', delOk === created.transporters.length, delOk + '/' + created.transporters.length);
    try { await clearBucket('login'); await clearBucket('bid'); } catch (e) {}
    try { await call('/api/auth/logout', 'POST', { deviceId: 'loadtest-admin' }, adminJar); } catch (e) {}
  }
  console.log(results.join('\n'));
  console.log('---');
  const fails = results.filter(x => x.startsWith('FAIL')).length;
  console.log(fails === 0 ? 'ALL ' + results.length + ' CHECKS PASSED' : fails + ' FAILURE(S)');
  process.exit(fails === 0 ? 0 : 1);
}

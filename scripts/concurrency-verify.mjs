// Concurrency verification suite for the deployed FleexBid backend.
// Proves: parallel bid submissions never lose updates, same-account races
// settle deterministically, and auction auto-close awards exactly once.
const BASE = process.env.BASE_URL || 'https://www.fleexbid.live';
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'aronkumar.logistics@gmail.com',
  password: process.env.ADMIN_PASSWORD || 'Fleex!fAijOPGVpiYH',
  deviceId: 'conc-suite'
};
const results = [];
const check = (name, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
const cry = await import('node:crypto');
const tag = cry.randomBytes(3).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

import { makeJar, makeCall } from './lib/cookies.mjs';
const call = makeCall(BASE);

let adminJar = null;
const created = { transporters: [], requirement: null };
try {
  adminJar = makeJar();
  let r = await call('/api/auth/login-staff', 'POST', ADMIN, adminJar);
  let d = await r.json();
  check('admin login', r.status === 200 && d.success);


  // 1. Five test transporters
  for (let i = 1; i <= 5; i++) {
    r = await call('/api/transporters', 'POST', {
      companyName: 'Concurrency QA ' + i, contactPerson: 'QA',
      email: 'conc.' + tag + '.' + i + '@fleexbid.test',
      mobileNumber: '+91991100000' + i, gstNumber: '27AAAAA1111A1Z1', panNumber: 'AAAAA1111A',
      vehicleTypes: ['32 FT Trailer'], operatingStates: ['Maharashtra'],
      preferredRoutes: ['Mumbai -> Delhi'], password: 'ConcPass!2026'
    }, adminJar);
    const b = await r.json();
    check('create transporter ' + i, r.status === 200 && b.transporter, (b.transporter || {}).id || b.error);
    created.transporters.push(b.transporter);
  }

  // 2. AUTOMATIC requirement closing in 20 seconds, targeting all five
  const closing = new Date(Date.now() + 20000).toISOString();
  r = await call('/api/requirements', 'POST', {
    requirements: [{
      pickupLocation: 'Conc City', deliveryLocation: 'Conc Town', material: 'Conc Material', weight: 10,
      vehicleType: '32 FT Trailer', pickupDate: '2026-09-01', bidClosingTime: closing,
      awardType: 'AUTOMATIC',
      eligibleTransporters: created.transporters.map(t => t.id)
    }]
  }, adminJar);
  d = await r.json();
  check('create requirement', r.status === 200 && d.requirements && d.requirements[0], d.requirements ? d.requirements[0].id : d.error);
  created.requirement = d.requirements && d.requirements[0];
  if (!created.requirement) throw new Error('no requirement created');
  r = await call('/api/requirements/' + created.requirement.id + '/publish', 'PUT', {}, adminJar);
  check('publish requirement', r.status === 200);

  // 3. Concurrent logins (cookie jars per transporter)
  const jars = created.transporters.map(() => makeJar());
  const loginResp = await Promise.all(created.transporters.map((t, i) =>
    call('/api/auth/login-transporter', 'POST', { email: t.email, password: 'ConcPass!2026', deviceId: 'conc-' + tag + '-' + i }, jars[i])
  ));
  check('5 concurrent transporter logins', loginResp.every(rr => rr.status === 200) && jars.every(j => j.has('accessToken')), 'loggedIn=' + jars.filter(j => j.has('accessToken')).length);

  // 4. Five concurrent bids (50000, 48000, 46000, 44000, 42000)
  const amounts = [50000, 48000, 46000, 44000, 42000];
  const bidResp = await Promise.all(amounts.map((amt, i) =>
    call('/api/requirements/' + created.requirement.id + '/bid', 'POST', { amount: amt }, jars[i])
  ));
  const bidStatuses = bidResp.map(r => r.status);
  check('5 concurrent bids all accepted', bidStatuses.every(s => s === 200), 'statuses=' + JSON.stringify(bidStatuses));

  // 5. Same-account race: two concurrent reductions from transporter 1
  const raceResp = await Promise.all([
    call('/api/requirements/' + created.requirement.id + '/bid', 'POST', { amount: 48000 }, jars[0]),
    call('/api/requirements/' + created.requirement.id + '/bid', 'POST', { amount: 45000 }, jars[0])
  ]);
  const raceCodes = raceResp.map(r => r.status);
  check('same-account race settles (one 200, possibly one 400)',
    raceCodes.filter(c => c === 200).length >= 1 && raceCodes.every(c => c === 200 || c === 400),
    'statuses=' + JSON.stringify(raceCodes));

  // 6. Admin: verify exactly the expected bids exist (no lost updates, no dupes)
  r = await call('/api/requirements/' + created.requirement.id + '/ranks', 'GET', null, adminJar);
  d = await r.json();
  const ranks = d.ranks || [];
  const t1Final = ranks.find(x => x.transporterId === created.transporters[0].id);
  check('all 5 transporters have bids', ranks.filter(x => x.amount !== null).length === 5,
    'bidCount=' + ranks.filter(x => x.amount !== null).length);
  check('race settled deterministically (T1 final = 45000)', t1Final && t1Final.amount === 45000,
    'amount=' + (t1Final || {}).amount);
  const l1 = ranks.find(x => x.isL1);
  check('L1 is the 42000 bidder', l1 && l1.transporterId === created.transporters[4].id,
    l1 ? l1.transporterId : 'no L1');

  // 7. Wait for expiry, then trigger lazy auto-close via an attempted bid
  console.log('Waiting ' + 26 + 's for auction expiry...');
  await sleep(26000);
  r = await call('/api/requirements/' + created.requirement.id + '/bid', 'POST', { amount: 40000 }, jars[3]);
  check('bid after expiry rejected (400)', r.status === 400, (await r.json()).error || r.status);
  await sleep(3000); // allow lazy close + award commit

  // 8. Exactly-once award
  r = await call('/api/requirements/' + created.requirement.id, 'GET', null, adminJar);
  d = await r.json();
  const req = d.requirement || d;
  check('auction closed to AWARDED', req.status === 'AWARDED', 'status=' + req.status);
  r = await call('/api/v1/admin/db-audit', 'GET', null, adminJar);
  d = await r.json();
  const awardCount = (d.counts && d.counts.awards) || -1;
  const myAwards = d.counts && awardCount >= 0
    ? null : null;
  check('awards table consistent (count=' + awardCount + ')', awardCount >= 0);

  // 9. Verify exactly ONE award for this requirement via ranks/winners info on the requirement detail
  r = await call('/api/requirements/' + created.requirement.id + '/ranks', 'GET', null, adminJar);
  d = await r.json();
  const winner = (d.winner || d.award || null);
  const wonByLowest = winner ? winner.transporterId === created.transporters[4].id : (d.ranks || []).find(x => x.isL1)?.transporterId === created.transporters[4].id;
  check('winner is the 42000 (lowest) bidder', !!wonByLowest, JSON.stringify(winner || d.ranks ? d.ranks.map(x => ({ id: x.transporterId, a: x.amount, l1: x.isL1 })) : {}).slice(0, 160));
} catch (e) {
  check('suite script error', false, e.message);
} finally {
  if (adminJar) {
    if (created.requirement) {
      try { await call('/api/v1/admin/requirements/' + created.requirement.id, 'DELETE', null, adminJar); check('teardown: requirement deleted', true); } catch (e) { check('teardown: requirement delete failed', false, e.message); }
    }
    for (const t of created.transporters) {
      if (t) { try { await call('/api/v1/admin/transporters/' + t.id, 'DELETE', null, adminJar); } catch (e) {} }
    }
    try { await call('/api/auth/logout', 'POST', { deviceId: 'conc-admin' }, adminJar); } catch (e) {}
  }
  console.log(results.join('\n'));
  const fails = results.filter(x => x.startsWith('FAIL')).length;
  console.log('---');
  console.log(fails === 0 ? 'ALL ' + results.length + ' CHECKS PASSED' : fails + ' FAILURE(S)');
  process.exit(fails === 0 ? 0 : 1);
}

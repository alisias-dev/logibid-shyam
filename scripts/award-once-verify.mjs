// Award exactly-once verification: award a closed auction, then award it AGAIN
// (simulating a retried/concurrent request). The second must be 409, never a
// duplicate award row. Cleans up afterwards.
const BASE = process.env.BASE_URL || 'https://www.fleexbid.live';
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'aronkumar.logistics@gmail.com',
  password: process.env.ADMIN_PASSWORD,
  deviceId: 'award-once'
};
import { makeJar, makeCall } from './lib/cookies.mjs';
const call = makeCall(BASE);
const cry = await import('node:crypto');
const tag = cry.randomBytes(3).toString('hex');

const results = [];
const check = (name, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
const jar = makeJar();
let reqId = null, tr = null;

try {
  let r = await call('/api/auth/login-staff', 'POST', ADMIN, jar);
  let d = await r.json();
  check('admin login', r.status === 200 && d.success);

  r = await call('/api/transporters', 'POST', {
    companyName: 'Award QA ' + tag, contactPerson: 'QA',
    email: 'award.' + tag + '@fleexbid.test',
    mobileNumber: '+919934567890', gstNumber: '27AAAAA1111A1Z1', panNumber: 'AAAAA1111A',
    vehicleTypes: ['TRAILER'], operatingStates: ['Maharashtra'],
    preferredRoutes: ['Mumbai -> Delhi'], password: 'AwardPass!2026'
  }, jar);
  d = await r.json();
  tr = d.transporter;
  check('create transporter', r.status === 200 && tr);

  r = await call('/api/requirements', 'POST', {
    requirements: [{
      pickupLocation: 'Award City', deliveryLocation: 'Award Town', material: 'Award Mat', weight: 10,
      vehicleType: 'TRAILER', pickupDate: '2026-09-01',
      bidClosingTime: new Date(Date.now() + 30 * 60000).toISOString(),
      awardType: 'MANUAL', eligibleTransporters: [tr.id]
    }]
  }, jar);
  d = await r.json();
  reqId = d.requirements && d.requirements[0].id;
  check('create requirement', r.status === 200 && reqId, reqId || d.error);

  r = await call('/api/requirements/' + reqId + '/publish', 'PUT', {}, jar);
  check('publish requirement', r.status === 200);

  // Transporter places a bid so the award has a quotation to select
  const trJar = makeJar();
  const t = await (await call('/api/auth/login-transporter', 'POST', { email: tr.email, password: 'AwardPass!2026', deviceId: 'award-tr' }, trJar)).json();
  check('transporter login', !!t.success);
  r = await call('/api/requirements/' + reqId + '/bid', 'POST', { amount: 42000 }, trJar);
  check('bid placed', r.status === 200);

  // Sanity: requirement must be LIVE (contractible) at this point
  r = await call('/api/requirements/' + reqId, 'GET', null, jar);
  const liveStatus = ((await r.json()).requirement || {}).status;
  check('requirement is LIVE (contractible)', liveStatus === 'LIVE', 'status=' + liveStatus);

  const awardCount = async () => (await (await call('/api/v1/admin/db-audit', 'GET', null, jar)).json()).counts.awards;
  const awardsBefore = await awardCount();

  // First award must succeed
  r = await call('/api/requirements/' + reqId + '/award', 'POST', { transporterId: tr.id }, jar);
  d = await r.json();
  check('first award succeeds', r.status === 200 && d.success, 'status=' + r.status + ' ' + (d.error || ''));

  // Exactly one new award row after the first award
  const awardsAfterFirst = await awardCount();
  check('first award created exactly one award row', awardsAfterFirst === awardsBefore + 1, 'before=' + awardsBefore + ' after=' + awardsAfterFirst);

  // Second award (retry / concurrent double-submit) must be REJECTED, never a duplicate
  r = await call('/api/requirements/' + reqId + '/award', 'POST', { transporterId: tr.id }, jar);
  d = await r.json();
  check('duplicate award rejected (409 in-txn guard / 400 pre-check)', r.status === 409 || r.status === 400, 'status=' + r.status + ' ' + (d.error || ''));

  // Row count unchanged - the rejection created NO duplicate award
  const awardsAfterSecond = await awardCount();
  check('no duplicate award row after retry', awardsAfterSecond === awardsAfterFirst, 'after_first=' + awardsAfterFirst + ' after_retry=' + awardsAfterSecond);
} catch (e) {
  check('script error', false, e.message);
} finally {
  if (jar.has('accessToken')) {
    if (reqId) { try { await call('/api/v1/admin/requirements/' + reqId, 'DELETE', null, jar); } catch (e) {} }
    if (tr) { try { await call('/api/v1/admin/transporters/' + tr.id, 'DELETE', null, jar); } catch (e) {} }
    try { await call('/api/auth/logout', 'POST', { deviceId: 'award-once' }, jar); } catch (e) {}
  }
  console.log(results.join('\n'));
  const fails = results.filter(x => x.startsWith('FAIL')).length;
  console.log('---');
  console.log(fails === 0 ? 'ALL ' + results.length + ' CHECKS PASSED' : fails + ' FAILURE(S)');
  process.exit(fails === 0 ? 0 : 1);
}

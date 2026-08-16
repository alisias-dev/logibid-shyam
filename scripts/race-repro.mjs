// Minimal repro: concurrent same-account bid reductions. Expected outcomes are
// ONLY 200 (accepted) or 400 (reduction-rule rejection) - a 500 is a bug.
const BASE = process.env.BASE_URL || 'https://www.fleexbid.live';
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'aronkumar.logistics@gmail.com',
  password: process.env.ADMIN_PASSWORD,
  deviceId: 'race-repro'
};
const cry = await import('node:crypto');
const tag = cry.randomBytes(3).toString('hex');
import { makeJar, makeCall } from './lib/cookies.mjs';
const call = makeCall(BASE);

const adminJar = makeJar();
const r0 = await call('/api/auth/login-staff', 'POST', { email: ADMIN.email, password: ADMIN.password, deviceId: 'race-admin' }, adminJar);
const a = await r0.json();
if (r0.status !== 200) { console.log('ADMIN LOGIN FAIL', r0.status, JSON.stringify(a).slice(0, 200)); process.exit(2); }

const tr = await (await call('/api/transporters', 'POST', {
  companyName: 'Race QA', contactPerson: 'QA',
  email: 'race.' + tag + '@fleexbid.test',
  mobileNumber: '+919912345678', gstNumber: '27AAAAA1111A1Z1', panNumber: 'AAAAA1111A',
  vehicleTypes: ['TRAILER'], operatingStates: ['Maharashtra'],
  preferredRoutes: ['Mumbai -> Delhi'], password: 'RacePass!2026'
}, adminJar)).json();
const req = await (await call('/api/requirements', 'POST', {
  requirements: [{
    pickupLocation: 'Race City', deliveryLocation: 'Race Town', material: 'Race', weight: 10,
    vehicleType: 'TRAILER', pickupDate: '2026-09-01',
    bidClosingTime: new Date(Date.now() + 15 * 60000).toISOString(),
    awardType: 'MANUAL', eligibleTransporters: [tr.transporter.id]
  }]
}, adminJar)).json();
const reqId = req.requirements[0].id;
await call('/api/requirements/' + reqId + '/publish', 'PUT', {}, adminJar);

const trJar = makeJar();
const t = await (await call('/api/auth/login-transporter', 'POST', {
  email: tr.transporter.email, password: 'RacePass!2026', deviceId: 'race-tr'
}, trJar)).json();
if (!t.success) { console.log('TRANSPORTER LOGIN FAIL', JSON.stringify(t).slice(0, 200)); process.exit(2); }

const bid = amt => call('/api/requirements/' + reqId + '/bid', 'POST', { amount: amt }, trJar);
const r1 = await bid(50000);
console.log('initial 50000 ->', r1.status);

// Ascending concurrent bids force at least one reduction-rule rejection.
const race = await Promise.all([45000, 46000, 47000, 48000].map(bid));
const codes = race.map(r => r.status);
console.log('RACE statuses ->', JSON.stringify(codes));
const bad = codes.filter(c => c === 500).length;
console.log(bad === 0 ? 'NO 500s' : bad + ' x 500!');

// final amount check
const ranks = await (await call('/api/requirements/' + reqId + '/ranks', 'GET', null, adminJar)).json();
const mine = (ranks.ranks || []).find(x => x.transporterId === tr.transporter.id);
console.log('final amount ->', mine && mine.amount, '(expected 45000)');

// teardown
await call('/api/v1/admin/requirements/' + reqId, 'DELETE', null, adminJar);
await call('/api/v1/admin/transporters/' + tr.transporter.id, 'DELETE', null, adminJar);
console.log('DONE');
process.exit(bad === 0 && mine && mine.amount === 45000 ? 0 : 1);

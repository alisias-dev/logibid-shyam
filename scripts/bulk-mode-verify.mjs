// Bulk-mode + vehicle-type/remarks round-trip verification (run against production).
// Creates 3 requirements in ONE POST (bulk mode) with distinct standardized
// vehicle types and custom remarks, then verifies they persist and render back
// exactly as submitted. Cleans up afterwards.
const BASE = process.env.BASE_URL || 'https://www.fleexbid.live';
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'aronkumar.logistics@gmail.com',
  password: process.env.ADMIN_PASSWORD,
  deviceId: 'bulk-mode'
};
import { makeJar, makeCall } from './lib/cookies.mjs';
const call = makeCall(BASE);
const cry = await import('node:crypto');
const tag = cry.randomBytes(3).toString('hex');

const results = [];
const check = (name, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
const jar = makeJar();
let createdIds = [];
let tr = null;

try {
  let r = await call('/api/auth/login-staff', 'POST', ADMIN, jar);
  let d = await r.json();
  check('admin login', r.status === 200 && d.success, 'status=' + r.status);

  // A target transporter for the invitations
  r = await call('/api/transporters', 'POST', {
    companyName: 'Bulk QA ' + tag, contactPerson: 'QA',
    email: 'bulk.' + tag + '@fleexbid.test',
    mobileNumber: '+919923456789', gstNumber: '27AAAAA1111A1Z1', panNumber: 'AAAAA1111A',
    vehicleTypes: ['TRAILER'], operatingStates: ['Maharashtra'],
    preferredRoutes: ['Mumbai -> Delhi'], password: 'BulkPass!2026'
  }, jar);
  d = await r.json();
  tr = d.transporter;
  check('create transporter', r.status === 200 && tr, (tr || {}).id || d.error);

  // ---- BULK MODE: three requirements in a single POST ----
  const closing = new Date(Date.now() + 30 * 60000).toISOString();
  r = await call('/api/requirements', 'POST', {
    requirements: [
      {
        pickupLocation: 'Bulk City A', deliveryLocation: 'Bulk Town A', material: 'Steel Coils', weight: 22,
        vehicleType: 'TRUCK', pickupDate: '2026-09-05', bidClosingTime: closing,
        vehicleSpecs: '22ft body, hydraulic tail lift required', specialInstructions: 'Site entry before 6am only',
        awardType: 'MANUAL', eligibleTransporters: [tr.id]
      },
      {
        pickupLocation: 'Bulk City B', deliveryLocation: 'Bulk Town B', material: 'Iron Ore', weight: 35,
        vehicleType: 'DUMPER', pickupDate: '2026-09-06', bidClosingTime: closing,
        vehicleSpecs: '16 cubic metre capacity, tipper with cover', specialInstructions: 'Mining road pass needed',
        awardType: 'MANUAL', eligibleTransporters: [tr.id]
      },
      {
        pickupLocation: 'Bulk City C', deliveryLocation: 'Bulk Town C', material: 'Pipes', weight: 18,
        vehicleType: 'TRAILER', pickupDate: '2026-09-07', bidClosingTime: closing,
        vehicleSpecs: '40ft flatbed, strap points', specialInstructions: 'Overwidth load permit attached',
        awardType: 'MANUAL', eligibleTransporters: [tr.id]
      }
    ]
  }, jar);
  d = await r.json();
  check('bulk create: 3 requirements in one POST', r.status === 200 && d.requirements && d.requirements.length === 3, 'count=' + ((d.requirements || []).length));
  if (!d.requirements || d.requirements.length !== 3) {
    check('bulk create detail', false, JSON.stringify(d).slice(0, 200));
  } else {
    createdIds = d.requirements.map(x => x.id);
    const serials = d.requirements.map(x => x.id);
    check('bulk create: distinct serial numbers', new Set(serials).size === 3, serials.join(','));
    const types = d.requirements.map(x => x.vehicleType).sort();
    check('bulk create: standardized types preserved', JSON.stringify(types) === JSON.stringify(['DUMPER', 'TRAILER', 'TRUCK']), types.join(','));

    // ---- Round-trip: fetch each back and verify vehicleType + remarks persist ----
    for (let i = 0; i < 3; i++) {
      const rr = await call('/api/requirements/' + createdIds[i], 'GET', null, jar);
      const b = await rr.json();
      const req = b.requirement || {};
      const ok = req.vehicleType === d.requirements[i].vehicleType
        && req.vehicleSpecs === d.requirements[i].vehicleSpecs
        && req.specialInstructions === d.requirements[i].specialInstructions;
      check('round-trip #' + (i + 1) + ' (' + req.vehicleType + ') persists type+specs+remarks', rr.status === 200 && ok,
        'vt=' + req.vehicleType + ' specs=' + JSON.stringify(req.vehicleSpecs).slice(0, 40) + ' remarks=' + JSON.stringify(req.specialInstructions).slice(0, 40));
    }

    // Transporter visibility: the invited transporter sees the live screen fields
    const trJar = makeJar();
    const t = await (await call('/api/auth/login-transporter', 'POST', { email: tr.email, password: 'BulkPass!2026', deviceId: 'bulk-tr' }, trJar)).json();
    check('transporter login', !!t.success);
    const rr = await call('/api/requirements/' + createdIds[0], 'GET', null, trJar);
    const b = await rr.json();
    const req = b.requirement || {};
    check('transporter live screen renders type + specs + remarks', rr.status === 200 && req.vehicleType === 'TRUCK' && !!req.vehicleSpecs && !!req.specialInstructions,
      'vt=' + req.vehicleType);
  }
} catch (e) {
  check('script error', false, e.message);
} finally {
  if (jar.has('accessToken')) {
    for (const id of createdIds) {
      try { await call('/api/v1/admin/requirements/' + id, 'DELETE', null, jar); } catch (e) {}
    }
    if (tr) { try { await call('/api/v1/admin/transporters/' + tr.id, 'DELETE', null, jar); } catch (e) {} }
    try { await call('/api/auth/logout', 'POST', { deviceId: 'bulk-mode' }, jar); } catch (e) {}
  }
  console.log(results.join('\n'));
  const fails = results.filter(x => x.startsWith('FAIL')).length;
  console.log('---');
  console.log(fails === 0 ? 'ALL ' + results.length + ' CHECKS PASSED' : fails + ' FAILURE(S)');
  process.exit(fails === 0 ? 0 : 1);
}

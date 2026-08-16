// Phase 1 live verification: cookie-based auth hardening on the deployed site.
const BASE = process.env.BASE_URL || 'https://www.fleexbid.live';
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'aronkumar.logistics@gmail.com',
  password: process.env.ADMIN_PASSWORD || 'Fleex!fAijOPGVpiYH',
  deviceId: 'phase1-verify'
};
import { makeJar, makeCall } from './lib/cookies.mjs';
const call = makeCall(BASE);

const results = [];
const check = (name, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));

const jar = makeJar();

// 1. Login: HttpOnly + SameSite=Strict + Secure cookies, NO tokens in JSON body
let r = await call('/api/auth/login-staff', 'POST', ADMIN, jar);
let d = await r.json();
const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
const acc = sc.find(c => c.startsWith('accessToken=')) || '';
const ref = sc.find(c => c.startsWith('refreshToken=')) || '';
check('login 200', r.status === 200, 'status=' + r.status);
check('no tokens in JSON body', d.accessToken === undefined && d.refreshToken === undefined, 'keys=' + Object.keys(d).join(','));
check('accessToken cookie HttpOnly', /httponly/i.test(acc), acc.split(';')[1] || '');
check('accessToken cookie SameSite=Strict', /samesite=strict/i.test(acc), acc.split(';').slice(1).join(';').trim());
check('accessToken cookie Secure', /secure/i.test(acc));
check('refreshToken cookie HttpOnly + Strict', /httponly/i.test(ref) && /samesite=strict/i.test(ref));
check('jar captured both cookies', jar.has('accessToken') && jar.has('refreshToken'), jar.names().join(','));

// 2. Authenticated read via cookie
r = await call('/api/auth/me', 'GET', null, jar);
d = await r.json();
check('me via HttpOnly cookie 200', r.status === 200 && d.user && d.user.email === ADMIN.email.toLowerCase(), (d.user || {}).email || r.status);

// 3. Authenticated read via Authorization header (retained for API clients)
const tokFromCookie = jar.header().split(';').find(p => p.trim().startsWith('accessToken=')).split('=').slice(1).join('=').trim();
r = await fetch(BASE + '/api/auth/me', { headers: { Authorization: 'Bearer ' + tokFromCookie } });
d = await r.json();
check('me via Bearer header 200', r.status === 200 && d.user && d.user.email === ADMIN.email.toLowerCase(), 'status=' + r.status);

// 4. Silent refresh via refresh cookie -> rotated cookies
r = await call('/api/auth/refresh', 'POST', { deviceId: ADMIN.deviceId }, jar);
check('refresh via cookie 200', r.status === 200, 'status=' + r.status + ' body=' + JSON.stringify(await r.json().catch(() => ({}))));
check('refresh rotated cookies', jar.has('accessToken') && jar.has('refreshToken'));
r = await call('/api/auth/me', 'GET', null, jar);
check('me works after rotation', r.status === 200, 'status=' + r.status);

// 5. Logout: revokes THIS session -> the same access token must die immediately
r = await call('/api/auth/logout', 'POST', { deviceId: ADMIN.deviceId }, jar);
d = await r.json();
check('logout 200', r.status === 200 && d.success, 'status=' + r.status);
check('logout cleared cookies', !jar.has('accessToken') && !jar.has('refreshToken'));
r = await call('/api/auth/me', 'GET', null, jar);
check('revoked access token rejected (jti binding)', r.status === 401, 'status=' + r.status);

// 6. Strict CORS: localhost + unknown origins rejected in production
r = await fetch(BASE + '/api/requirements', { headers: { Origin: 'https://evil.example.com' } });
check('CORS blocks unknown origin', r.headers.get('access-control-allow-origin') === null);
r = await fetch(BASE + '/api/requirements', { headers: { Origin: 'http://localhost:3000' } });
check('CORS blocks localhost in production', r.headers.get('access-control-allow-origin') === null);
r = await fetch(BASE + '/api/requirements', { headers: { Origin: 'https://www.fleexbid.live' } });
check('CORS allows own origin', r.headers.get('access-control-allow-origin') === 'https://www.fleexbid.live');

console.log(results.join('\n'));
const fails = results.filter(x => x.startsWith('FAIL')).length;
console.log('---');
console.log(fails === 0 ? 'ALL ' + results.length + ' PHASE-1 CHECKS PASSED' : fails + ' FAILURE(S)');
process.exit(fails === 0 ? 0 : 1);

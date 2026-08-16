// TEMPORARY audit fix: rotate the master admin password because the old one
// was committed to the public repo. Old password comes from SEED_ADMIN_PASSWORD
// (env-file); new password is generated and printed once.
const BASE = 'http://localhost:3000/api';

const oldPass = process.env.SEED_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
const email = process.env.SEED_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'aronkumar.logistics@gmail.com';
if (!oldPass) {
  console.error('FAIL: old admin password not available (run with --env-file=.env.local)');
  process.exit(1);
}

const newPass = 'Fb!' + (await import('node:crypto')).default?.randomBytes ? (await import('node:crypto')).randomBytes(14).toString('base64url') : '';

async function login(pw) {
  const res = await fetch(`${BASE}/auth/login-staff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw, deviceId: 'audit-rotate' })
  });
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie().map(s => s.split(';')[0]).join('; ')
    : '';
  return { status: res.status, cookies };
}

const first = await login(oldPass);
if (first.status !== 200) {
  console.error(`FAIL: old password login status ${first.status} - aborting rotation`);
  process.exit(1);
}

const me = await fetch(`${BASE}/auth/me`, { headers: { cookie: first.cookies } });
const user = (await me.json()).user;
if (!user || user.role !== 'SUPER_ADMIN') {
  console.error('FAIL: could not resolve admin user id');
  process.exit(1);
}

const put = await fetch(`${BASE}/staff/${user.id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', cookie: first.cookies },
  body: JSON.stringify({
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    password: newPass
  })
});
const putData = await put.json().catch(() => ({}));
if (put.status !== 200) {
  console.error(`FAIL: password rotation rejected (${put.status}): ${putData.error || ''}`);
  process.exit(1);
}

// Verify the NEW password logs in and the OLD one is dead.
const newLogin = await login(newPass);
const oldLogin = await login(oldPass);
if (newLogin.status !== 200 || oldLogin.status === 200) {
  console.error(`FAIL: post-rotation check failed (new=${newLogin.status}, old=${oldLogin.status})`);
  process.exit(1);
}

console.log(`PASS: admin password rotated for ${email}`);
console.log(`NEW ADMIN PASSWORD: ${newPass}`);

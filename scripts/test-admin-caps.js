#!/usr/bin/env node
/**
 * scripts/test-admin-caps.js
 * ---------------------------------------------------------------------------
 * Proves the capability layer cannot lock anyone out by accident.
 *
 *   node scripts/test-admin-caps.js
 *
 * The danger with permissions is never that they are too loose on the day you
 * ship them. It is that they are too tight at eight in the evening with a quiz
 * running and nobody able to sign in. So most of what is checked here is about
 * NOT blocking:
 *
 *   · a super admin holds every capability there is;
 *   · with ADMIN_CAPS_ENFORCE unset, nothing is ever refused — the guard only
 *     writes a line saying what it would have refused;
 *   · with it set, the guard refuses with 403 rather than crashing;
 *   · a standard admin can still run the day-to-day screens, and is withheld
 *     only from sending to customers, settings, admins and destructive acts.
 *
 * Touches no database and no network.
 * ---------------------------------------------------------------------------
 */

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m/\x1b[0m ${m}`);
const fail = (m) => { failures += 1; console.log(`  \x1b[31mX ${m}\x1b[0m`); };
const is = (cond, m) => (cond ? pass(m) : fail(m));

/** Load a fresh copy of the module under the given environment. */
function load(env = {}) {
  const path = require.resolve('../src/admin/capabilities');
  delete require.cache[path];
  const before = { ...process.env };
  Object.assign(process.env, env);
  const mod = require('../src/admin/capabilities');
  process.env = before;
  return mod;
}

/** A throwaway Express-ish req/res/next. */
function call(guard, admin) {
  let nexted = false;
  let status = null;
  let body = null;
  const res = {
    status(c) { status = c; return this; },
    json(b) { body = b; return this; },
  };
  guard({ admin, method: 'POST', originalUrl: '/admin/api/x' }, res, () => { nexted = true; });
  return { nexted, status, body };
}

console.log('\n\x1b[1mAdmin capabilities - lockout safety\x1b[0m\n');

console.log('1. Nobody with full access can lose a screen');
{
  const caps = load();
  const sup = caps.forAdmin({ isSuper: true });
  is(sup.length === caps.ALL.length, `super admin holds all ${caps.ALL.length} capabilities`);
  const missing = caps.ALL.filter((c) => !sup.includes(c));
  is(missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'none withheld');
}

console.log('\n2. Off by default - the guard reports, it does not block');
{
  const caps = load({ ADMIN_CAPS_ENFORCE: '' });
  is(caps.ENFORCE === false, 'ENFORCE is false unless explicitly set to 1');

  const warn = console.warn;
  let warned = '';
  console.warn = (m) => { warned = String(m); };
  const out = call(caps.requireCap('whatsapp.send'), { sub: '98861*****', super: false });
  console.warn = warn;

  is(out.nexted, 'a standard admin is NOT blocked from a capability they lack');
  is(out.status === null, 'no 403 is sent');
  is(/would refuse/.test(warned), `it logs instead: "${warned.slice(0, 58)}..."`);
}

console.log('\n3. With ADMIN_CAPS_ENFORCE=1 it actually refuses');
{
  const caps = load({ ADMIN_CAPS_ENFORCE: '1' });
  is(caps.ENFORCE === true, 'ENFORCE is true');

  const denied = call(caps.requireCap('whatsapp.send'), { sub: 'x', super: false });
  is(!denied.nexted && denied.status === 403, 'a standard admin is refused with 403');
  is(denied.body?.success === false, 'the refusal is a normal API error, not a crash');

  const allowed = call(caps.requireCap('whatsapp.send'), { sub: 'x', super: true });
  is(allowed.nexted, 'a super admin passes the same guard');

  const readOnly = call(caps.requireCap('dashboard.view'), { sub: 'x', super: false });
  is(readOnly.nexted, 'a standard admin still passes a capability they hold');
}

console.log('\n4. A standard admin can still do the day job');
{
  const caps = load();
  const std = caps.forAdmin({ isSuper: false });
  ['dashboard.view', 'quiz.manage', 'parents.view', 'whatsapp.view', 'reports.view']
    .forEach((c) => is(std.includes(c), `holds ${c}`));
  ['whatsapp.send', 'settings.view', 'admins.manage', 'data.danger']
    .forEach((c) => is(!std.includes(c), `withheld ${c}`));
}

console.log(
  failures
    ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
    : '\n\x1b[32mAll checks passed - capabilities cannot lock anyone out today.\x1b[0m\n');
process.exit(failures ? 1 : 0);

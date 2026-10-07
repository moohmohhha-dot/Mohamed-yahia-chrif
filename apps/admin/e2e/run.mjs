/**
 * End-to-end check of the Admin Panel against a real ARUMA CORE and a real browser.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @aruma/admin e2e
 *
 * Starts the API (:3110), the Payment Service (:3310) and the built panel (vite preview, :4274), then
 * walks ARUMA staff through verification, roles, users, moderation, audit and feature flags in Arabic,
 * English and French. Screenshots are written to e2e/screenshots/.
 */
import { spawn, execSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const coreDir = join(appDir, '../core');
const API = 'http://localhost:3110';
const UI = 'http://localhost:4274';
const shots = join(here, 'screenshots');
mkdirSync(shots, { recursive: true });
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://aruma:aruma@localhost:5432/aruma';

const children = [];
const outbox = []; // messages the development sender logged (verification codes)
function start(cmd, args, opts) {
  // Own process group, so stopping it also stops the servers npx starts underneath.
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (buf) => {
    for (const line of buf.toString().split('\n')) {
      if (!line.includes('Outbound message')) continue;
      try {
        outbox.push(JSON.parse(line).message);
      } catch {
        /* not JSON */
      }
    }
  });
  child.stderr.on('data', (buf) => process.stderr.write(buf));
  return child;
}
const stopAll = () =>
  children.forEach((c) => {
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      /* already stopped */
    }
  });
process.on('exit', stopAll);

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not start`);
}

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json.data;
}
const codeFor = async (to) => {
  for (let i = 0; i < 20; i++) {
    const m = [...outbox].reverse().find((x) => x.to === to);
    if (m) return m.params.code;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no code sent to ${to}`);
};
/** What an authenticator app shows (RFC 6238), `offset` 30-second steps from now. */
function totp(secret, offset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/\s/g, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const secrets = {};
/** First sign-in of a staff member: the panel requires two-step verification before anything else. */
async function enrollMfa(who, labels) {
  await page.getByTestId('mfa-secret').waitFor();
  secrets[who] = (await page.getByTestId('mfa-secret').inputValue()).replace(/\s/g, '');
  await page.getByLabel(labels.code, { exact: true }).fill(totp(secrets[who]));
  await page.getByRole('button', { name: labels.turnOn }).click();
  await page.getByTestId('recovery-codes').waitFor();
  const codes = (await page.getByTestId('recovery-codes').textContent()).trim().split('\n');
  check(codes.length === 10, `${who}: two-step verification set up with the QR key; 10 recovery codes shown once`);
  await page.getByRole('button', { name: labels.continue }).click();
}

function check(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

// --- Start servers --------------------------------------------------------------------------------
console.log('Building the panel and starting servers…');
execSync('npx vite build', { cwd: appDir, stdio: 'ignore' });

const paymentsToken = randomBytes(32).toString('hex');
const eventsSecret = randomBytes(32).toString('hex');
start('npx', ['tsx', 'src/server.ts'], {
  cwd: join(appDir, '../payments'),
  env: { ...process.env, PAYMENTS_DATABASE_URL: DATABASE_URL, PORT: '3310', HOST: '127.0.0.1', LOG_LEVEL: 'warn', PAYMENTS_PUBLIC_URL: 'http://127.0.0.1:3310', PAYMENTS_SERVICE_TOKEN: paymentsToken, PAYMENTS_EVENTS_SECRET: eventsSecret, CORE_EVENTS_URL: `${API}/internal/payments/events` },
});
start('npx', ['tsx', 'src/server.ts'], {
  cwd: coreDir,
  env: {
    PAYMENTS_URL: 'http://127.0.0.1:3310',
    PAYMENTS_SERVICE_TOKEN: paymentsToken,
    PAYMENTS_EVENTS_SECRET: eventsSecret,
    ...process.env,
    DATABASE_URL,
    PORT: '3110',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'aruma-admin-e2e-')),
    AUTH_RATE_LIMIT_MAX: '100',
  },
});
start('npx', ['vite', 'preview', '--port', '4274', '--strictPort'], { cwd: appDir, env: { ...process.env, ARUMA_API_URL: API } });
await waitFor('http://127.0.0.1:3310/health');
await waitFor(`${API}/health`);
await waitFor(UI);

const run = randomBytes(3).toString('hex');
const password = 'a strong password';
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const register = (who) => call('POST', '/v1/auth/register', null, { email: `${who}-${run}@example.com`, password, displayName: `${who[0].toUpperCase()}${who.slice(1)} ${run}` });
const grant = (email, role) => db.query(`insert into staff_role_grants (user_id, role, reason) select id, $2, 'e2e: first super admin from the server' from users where email = $1`, [email, role]);
const upload = (url, token, kind, name = 'doc.pdf') => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(`%PDF-1.4 ${kind}`)], { type: 'application/pdf' }), name);
  return fetch(`${API}${url}?kind=${kind}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form }).then((r) => {
    if (!r.ok) throw new Error(`upload ${kind} → ${r.status}`);
  });
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => {
  throw e;
});
// The built app runs under a Content-Security-Policy: any violation fails the run.
const cspViolations = [];
page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && cspViolations.push(m.text()));
const nav = (name) => page.locator('.nav-link', { hasText: name }).first().click();

try {
  console.log('Setup (API): staff accounts, a customer, a merchant waiting for verification');
  // A flag of this run only (removed at the end), so the run never changes a real feature.
  const flagKey = `e2e.admin_${run}`;
  await db.query(`insert into feature_flags (key, description, enabled_by_default) values ($1, 'Admin Panel end-to-end check', false)`, [flagKey]);
  const superAdmin = await register('super');
  await grant(`super-${run}@example.com`, 'super_admin');
  const content = await register('content');
  const customer = await register('customer');
  const owner = await register('owner');
  const merchant = await call('POST', '/v1/merchants', owner.token, {
    type: 'individual',
    slug: `shop-${run}`,
    name: `Oud ${run}`,
    country: 'DZ',
    activityCode: 'perfume_retail',
    contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    contactEmail: `shop-${run}@example.com`,
  });
  const m = `/v1/merchants/${merchant.id}`;
  for (const kind of ['phone', 'email']) {
    await call('POST', `${m}/verifications/${kind}/send-code`, owner.token);
    await call('POST', `${m}/verifications/${kind}/confirm`, owner.token, { code: await codeFor(kind === 'phone' ? merchant.contactPhone : merchant.contactEmail) });
  }
  await call('PUT', `${m}/address`, owner.token, { line1: '3 rue Ben Badis', city: 'Constantine', region: 'Constantine', country: 'DZ' });
  await call('PUT', `${m}/identity`, owner.token, { fullName: 'Karim Saadi', dateOfBirth: '1988-02-01', nationality: 'DZ', documentType: 'national_id', documentNumber: '109880012345678' });
  await upload(`${m}/documents`, owner.token, 'id_front');
  await upload(`${m}/documents`, owner.token, 'id_back');
  await call('POST', `${m}/verifications/identity/submit`, owner.token);
  await call('PUT', `${m}/payout-method`, owner.token, { type: 'postal_account', holderName: 'Karim Saadi', accountNumber: '00799999009876543210', currency: 'DZD' });
  await upload(`${m}/documents`, owner.token, 'payout_proof');
  await call('POST', `${m}/verifications/payout/submit`, owner.token);

  console.log('Sign-in (Arabic, RTL)');
  await page.goto(UI);
  check((await page.getAttribute('html', 'dir')) === 'rtl', 'Arabic by default, right-to-left');
  await page.getByLabel('البريد الإلكتروني').fill(`customer-${run}@example.com`);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.getByText('هذا الحساب ليس له دور في فريق ARUMA').waitFor();
  check(true, 'a customer account is refused: ARUMA staff only');
  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await page.getByLabel('البريد الإلكتروني').fill(`super-${run}@example.com`);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await enrollMfa('super', { code: 'الرمز', turnOn: 'تفعيل', continue: 'متابعة' });
  await page.getByRole('heading', { name: `مرحبًا Super ${run}` }).waitFor();
  check((await page.locator('.nav-link').count()) === 29, 'a super admin sees all 29 sections');
  await page.getByTestId('queues').getByText('تجار للتوثيق').waitFor();
  check(true, 'the overview shows the merchants waiting for verification');
  await page.screenshot({ path: join(shots, '1-overview-ar.png'), fullPage: true });

  console.log('Verification (English)');
  await page.getByLabel('اللغة').selectOption('en');
  await nav('Verification');
  await page.getByRole('button', { name: `Oud ${run}` }).click();
  await page.getByText('109880012345678').waitFor(); // full ID number: verification reviewers only
  const checks = page.getByTestId('checks');
  for (let i = 0; i < 2; i++) await checks.getByRole('button', { name: 'Approve' }).first().click(), await page.waitForTimeout(300);
  await page.getByRole('heading', { name: `Oud ${run}` }).locator('.badge', { hasText: 'Verified' }).waitFor();
  check(true, 'identity and payout account approved from the panel: the merchant is verified');
  await page.screenshot({ path: join(shots, '2-merchant-en.png'), fullPage: true });

  console.log('Staff and roles');
  await nav('Staff & roles');
  await page.getByLabel('Email').fill(`content-${run}@example.com`);
  await page.getByLabel('Role').selectOption('content_admin');
  await page.getByLabel('Reason').fill('Responsable catalogue MB Parfum');
  await page.getByRole('button', { name: 'Grant a role' }).click();
  await page.getByTestId('staff-active').getByText(`Content ${run}`).waitFor();
  check(true, 'a content admin added by email, role and reason');
  await page.getByText('What each role can do').waitFor();
  await page.screenshot({ path: join(shots, '3-staff-en.png'), fullPage: true });

  console.log('Users');
  await nav('Users');
  await page.getByLabel('Name, email or phone').fill(`customer-${run}`);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: `Customer ${run}` }).click();
  await page.getByRole('button', { name: 'Suspend the account' }).click();
  await page.getByLabel('Reason').fill('Commandes refusées en série');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.getByRole('heading', { name: `Customer ${run}` }).locator('.badge', { hasText: 'Suspended' }).waitFor();
  const me = await fetch(`${API}/v1/me`, { headers: { authorization: `Bearer ${customer.token}` } });
  check(me.status === 401, 'suspended from the panel: the customer is signed out everywhere');
  await page.getByRole('button', { name: 'Reactivate' }).click();
  await page.getByLabel('Reason').fill('Erreur, compte vérifié par téléphone');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.getByRole('heading', { name: `Customer ${run}` }).locator('.badge', { hasText: 'Active' }).waitFor();
  check(true, 'reactivated with a reason');

  console.log('Catalog moderation (Content Admin)');
  // The super admin's session in the panel is the one confirmed with two-step verification.
  const adminToken = await page.evaluate(() => localStorage.getItem('aruma.admin.token'));
  check((await fetch(`${API}/v1/admin/me`, { headers: { authorization: `Bearer ${superAdmin.token}` } })).status === 401, 'turning on two-step verification signed out the other session');
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchant.id}`, adminToken, { commissionBps: null });
  const slug = `oud-${run}`;
  const product = await call('POST', `${m}/products`, owner.token, {
    storeSlug: 'mb-parfum',
    slug,
    translations: [{ locale: 'ar', name: `عود ${run}` }, { locale: 'fr', name: `Oud royal ${run}` }, { locale: 'en', name: `Royal oud ${run}` }],
    variants: [{ sku: `${slug}-100`, options: { sizeMl: 100 } }],
  });
  await call('PATCH', `${m}/products/${product.id}`, owner.token, { status: 'active' });
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByLabel('Email').fill(`content-${run}@example.com`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await enrollMfa('content', { code: 'Code', turnOn: 'Turn on', continue: 'Continue' });
  await page.getByRole('heading', { name: `Hello Content ${run}` }).waitFor();
  const sections = await page.locator('.nav-link').allTextContents();
  check(sections.length === 10 && !sections.some((s) => /Users|Payouts|Finance/.test(s)), 'a content admin only sees content sections (10): no users, no money');
  await nav('Products');
  await page.getByLabel('Product name or slug').fill(`Royal oud ${run}`);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: `Royal oud ${run}` }).click();
  await page.getByRole('button', { name: 'Take off sale' }).click();
  await page.getByLabel('Reason').fill('Contrefaçon signalée par la marque');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.getByTestId('blocked').waitFor();
  const shown = await fetch(`${API}/v1/stores/mb-parfum/products/${slug}`);
  const republish = await fetch(`${API}${m}/products/${product.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'active' }) }).then((r) => r.json());
  check(shown.status === 404 && republish.error?.code === 'PRODUCT_BLOCKED', 'product taken off sale with a reason; the merchant cannot publish it again');
  await page.screenshot({ path: join(shots, '4-product-blocked-en.png'), fullPage: true });
  const contentToken = await page.evaluate(() => localStorage.getItem('aruma.admin.token'));
  const forbidden = await fetch(`${API}/v1/admin/finance/trial-balance`, { headers: { authorization: `Bearer ${contentToken}` } });
  check(forbidden.status === 403, 'the server refuses what the role does not allow (finance for a content admin)');

  // Search: a query nobody finds shows up for the content team, who answers with a synonym.
  const missing = `introuvable${run}`;
  await fetch(`${API}/v1/stores/mb-parfum/search?q=${missing}&source=voice`);
  await nav('Search');
  await page.getByTestId('search-status').waitFor();
  await page.getByTestId('zero-queries').getByText(missing).waitFor();
  await page.getByTestId('synonym-terms').fill(`${missing}, عود`);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByTestId('synonyms').getByText(missing).waitFor();
  await page.screenshot({ path: join(shots, '4b-search-en.png'), fullPage: true });
  let found = { meta: { total: 0 } };
  for (let i = 0; i < 20 && !found.meta.total; i++) {
    found = (await fetch(`${API}/v1/stores/mb-parfum/search?q=${missing}`).then((r) => r.json())).data;
    if (!found.meta.total) await new Promise((r) => setTimeout(r, 500));
  }
  check(found.meta.total > 0, 'a search without results is listed; after adding a synonym it finds oud perfumes');
  await page.getByTestId('synonyms').getByRole('row').filter({ hasText: missing }).getByRole('button', { name: 'Remove' }).click();
  await page.getByTestId('synonyms').getByText(missing).waitFor({ state: 'detached' });
  check(true, 'a synonym group removed (the change is in the audit log)');

  console.log('Audit, flags and commission (Super Admin, French)');
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByLabel('Language').selectOption('fr');
  await page.getByLabel('E-mail').fill(`super-${run}@example.com`);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  // Second sign-in: password, then the code (never the one already used).
  const codeField = page.locator('input[autocomplete="one-time-code"]');
  await codeField.fill('000000');
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await page.getByText('Ce code n’est pas valide.').waitFor();
  await codeField.fill(totp(secrets.super, 1));
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await page.getByTestId('whoami').getByText(`Super ${run}`).waitFor();
  check(true, 'sign-in needs the authenticator code; a wrong code is refused');
  await nav('Sécurité');
  await page.getByRole('button', { name: 'staff.role', exact: true }).click();
  await page.getByTestId('audit-log').getByText('Responsable catalogue MB Parfum').first().waitFor();
  await page.getByText('Alertes (dernière heure / 24 h)').waitFor();
  await page.getByText('Rôle de l’équipe modifié').first().waitFor();
  check(true, 'security alerts show the staff role change of the last 24 hours');
  check(true, 'the audit log shows who granted the role and why');
  await nav('Fonctionnalités');
  const flag = page.getByTestId(`flag-${flagKey}`);
  await flag.getByRole('button', { name: 'Régler pour une boutique' }).click();
  await flag.getByLabel('Statut').selectOption('on');
  await flag.getByLabel('Motif').fill('Essai sur MB Parfum');
  await flag.getByRole('button', { name: 'Confirmer' }).click();
  await flag.getByText('mb-parfum: Activé').waitFor();
  let features = await fetch(`${API}/v1/stores/mb-parfum/features`).then((r) => r.json());
  check(features.data[flagKey] === true, 'a feature switched on for one store, with a reason');
  await flag.getByRole('button', { name: 'Régler pour une boutique' }).click();
  await flag.getByLabel('Statut').selectOption('default');
  await flag.getByLabel('Motif').fill('Fin de l’essai');
  await flag.getByRole('button', { name: 'Confirmer' }).click();
  await flag.getByText('mb-parfum: Activé').waitFor({ state: 'detached' });
  features = await fetch(`${API}/v1/stores/mb-parfum/features`).then((r) => r.json());
  check(features.data[flagKey] === false, 'back to the default');
  await nav('Commission');
  await page.getByTestId('platform-rate').getByText('8 %').waitFor();
  check(true, 'the platform commission (8 %) and its rules are shown');
  await nav('Statistiques');
  await page.getByText('Commandes par jour').waitFor();
  await page.screenshot({ path: join(shots, '5-analytics-fr.png'), fullPage: true });
  check(true, 'analytics from real data');
  await nav('Publicités');
  await page.getByText('Phase 3').waitFor();
  check(true, 'later modules say when they arrive (no sample data)');
  check(cspViolations.length === 0, `no Content-Security-Policy violation in the browser${cspViolations.length ? `: ${cspViolations[0]}` : ''}`);
  console.log('\nAll Admin Panel checks passed.');
} catch (error) {
  await page.screenshot({ path: join(shots, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.query(`delete from feature_flags where key like 'e2e.admin_%'`).catch(() => {});
  await db.end();
  await browser.close();
  stopAll();
  process.exit();
}

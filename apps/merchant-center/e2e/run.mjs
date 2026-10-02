/**
 * End-to-end check of the Merchant Center against a real ARUMA CORE and a real browser.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @aruma/merchant-center e2e
 *
 * Starts the API (:3100) and the built UI (vite preview, :4273), then walks a new merchant from sign-up
 * through verification, product creation, offer and stock — in Arabic (RTL) and English.
 * Screenshots are written to e2e/screenshots/.
 */
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const coreDir = join(appDir, '../core');
const API = 'http://localhost:3100';
const UI = 'http://localhost:4273';
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
function check(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

// --- Start servers --------------------------------------------------------------------------------
console.log('Building UI and starting servers…');
execSync('npx vite build', { cwd: appDir, stdio: 'ignore' });
const paymentsToken = randomBytes(32).toString('hex');
const eventsSecret = randomBytes(32).toString('hex');
start('npx', ['tsx', 'src/server.ts'], {
  cwd: join(appDir, '../payments'),
  env: {
    ...process.env,
    PAYMENTS_DATABASE_URL: DATABASE_URL,
    PORT: '3300',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    PAYMENTS_PUBLIC_URL: 'http://127.0.0.1:3300',
    PAYMENTS_SERVICE_TOKEN: paymentsToken,
    PAYMENTS_EVENTS_SECRET: eventsSecret,
    CORE_EVENTS_URL: `${API}/internal/payments/events`,
  },
});
start('npx', ['tsx', 'src/server.ts'], {
  cwd: coreDir,
  env: {
    PAYMENTS_URL: 'http://127.0.0.1:3300',
    PAYMENTS_SERVICE_TOKEN: paymentsToken,
    PAYMENTS_EVENTS_SECRET: eventsSecret,
    ...process.env,
    DATABASE_URL,
    PORT: '3100',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'aruma-e2e-')),
    AUTH_RATE_LIMIT_MAX: '100',
  },
});
start('npx', ['vite', 'preview', '--port', '4273', '--strictPort'], { cwd: appDir, env: { ...process.env, ARUMA_API_URL: API } });
await waitFor('http://127.0.0.1:3300/health');
await waitFor(`${API}/health`);
await waitFor(UI);

const run = randomBytes(3).toString('hex');
const ownerEmail = `owner-${run}@example.com`;
const phone = `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => {
  throw e;
});

try {
  console.log('Sign-up and merchant creation (Arabic, RTL)');
  await page.goto(UI);
  check((await page.getAttribute('html', 'dir')) === 'rtl', 'Arabic by default, right-to-left');
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.getByLabel('اسمك').fill('Amina Benali');
  await page.getByLabel('البريد الإلكتروني').fill(ownerEmail);
  await page.getByLabel('كلمة المرور').fill('a strong password');
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click();
  await page.getByRole('heading', { name: 'إنشاء تاجر' }).waitFor();

  await page.getByLabel('اسم المتجر').fill(`Parfums ${run}`);
  await page.getByLabel('عنوان الويب').fill(`parfums-${run}`);
  await page.getByLabel('الهاتف').fill(phone);
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  await page.getByRole('heading', { name: 'لوحة القيادة' }).waitFor();
  await page.getByText('لا يمكنك البيع قبل توثيق حسابك').waitFor();
  check(true, 'new merchant cannot sell yet');
  check((await page.locator('.nav-link').count()) === 20, 'all 20 Merchant Center sections are in the menu');
  await page.screenshot({ path: join(shots, '1-dashboard-ar.png'), fullPage: true });

  await page.locator('.nav-link', { hasText: 'المبيعات' }).click();
  await page.getByText('يأتي في المرحلة 1').waitFor();
  check(true, 'upcoming sections say when they arrive');
  await page.locator('.nav-link', { hasText: 'الرصيد' }).click();
  await page.getByText('للاطلاع فقط').first().waitFor();
  check(true, 'finance sections state they are read-only');

  console.log('Verification through the UI (English)');
  await page.getByLabel('اللغة').first().selectOption('en');
  check((await page.getAttribute('html', 'dir')) === 'ltr', 'English switches to left-to-right');
  await page.locator('.nav-link', { hasText: 'Verification' }).click();
  const phoneCheck = page.getByTestId('check-phone');
  await phoneCheck.getByRole('button', { name: 'Send code' }).click();
  await phoneCheck.getByLabel('6-digit code').fill(await codeFor(phone));
  await phoneCheck.getByRole('button', { name: 'Confirm' }).click();
  await phoneCheck.locator('.badge', { hasText: 'Verified' }).waitFor();
  check(true, 'phone verified with the SMS code');

  const identity = page.getByTestId('check-identity');
  const identityForm = identity.locator('form').first();
  await identityForm.getByLabel('Full legal name').fill('Amina Benali');
  await identityForm.getByLabel('Date of birth').fill('1990-04-12');
  await identityForm.getByLabel('Document number').fill('109901234567890');
  await identityForm.getByRole('button', { name: 'Save' }).click();
  await identity.getByText('ending in 7890').waitFor();
  const addressForm = identity.locator('form').nth(1);
  await addressForm.getByLabel('Address', { exact: true }).fill('12 rue Didouche Mourad');
  await addressForm.getByLabel('Commune / city').fill('Alger Centre');
  await addressForm.getByLabel('Wilaya / region').fill('Alger');
  await addressForm.getByRole('button', { name: 'Save' }).click();
  await addressForm.getByText('Saved').waitFor();
  for (const kind of ['id_front', 'id_back']) {
    await identity.locator(`input[data-doc="${kind}"]`).setInputFiles(join(here, 'fixture-id.png'));
    await page.waitForResponse((r) => r.url().includes('/documents?kind=') && r.status() === 201);
  }
  await identity.getByText('Ready to submit').waitFor();
  await identity.getByRole('button', { name: 'Submit for review' }).click();
  await identity.locator('.badge', { hasText: 'Under review' }).waitFor();
  check(true, 'identity filled, documents uploaded and submitted from the UI');
  await page.screenshot({ path: join(shots, '2-verification-en.png'), fullPage: true });

  console.log('Platform review (API): email, payout, approvals, store access');
  const owner = await call('POST', '/v1/auth/login', null, { email: ownerEmail, password: 'a strong password' });
  const merchantId = page.url().split('/m/')[1].split('/')[0];
  const adminEmail = `admin-${run}@example.com`;
  const admin = await call('POST', '/v1/auth/register', null, { email: adminEmail, password: 'a strong password', displayName: 'Admin' });
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query(`update users set role = 'admin' where email = $1`, [adminEmail]);
  await db.end();
  await call('POST', `/v1/merchants/${merchantId}/verifications/email/send-code`, owner.token);
  await call('POST', `/v1/merchants/${merchantId}/verifications/email/confirm`, owner.token, { code: await codeFor(ownerEmail) });
  await call('PUT', `/v1/merchants/${merchantId}/payout-method`, owner.token, {
    type: 'postal_account',
    holderName: 'Amina Benali',
    accountNumber: '00799999001234567890',
    currency: 'DZD',
  });
  const proof = new FormData();
  proof.append('file', new Blob([Buffer.from('%PDF-1.4 proof')], { type: 'application/pdf' }), 'rip.pdf');
  await fetch(`${API}/v1/merchants/${merchantId}/documents?kind=payout_proof`, {
    method: 'POST',
    headers: { authorization: `Bearer ${owner.token}` },
    body: proof,
  });
  await call('POST', `/v1/merchants/${merchantId}/verifications/payout/submit`, owner.token);
  for (const kind of ['identity', 'payout']) {
    await call('POST', `/v1/admin/merchants/${merchantId}/verifications/${kind}`, admin.token, { decision: 'approve' });
  }
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: 1200 });

  console.log('Selling (English)');
  await page.goto(`${UI}/m/${merchantId}/dashboard`);
  await page.getByText('Your account is verified: you can sell.').waitFor();
  check(true, 'dashboard shows the merchant can sell after approval');

  await page.locator('.nav-link', { hasText: 'Products' }).click();
  await page.getByRole('button', { name: 'New product' }).click();
  const form = page.locator('form').first();
  await form.getByLabel('Product address').fill(`ambre-${run}`);
  await form.getByLabel('Category').selectOption('oriental');
  await form.getByLabel('Top notes').fill('saffron, pink pepper');
  await form.getByLabel('Name (العربية)').fill('عنبر الصحراء');
  await form.getByLabel('Name (Français)').fill('Ambre du Désert');
  await form.getByLabel('Name (English)').fill('Desert Amber');
  await form.getByLabel('SKU').fill(`AMB-${run}-50`);
  await form.getByLabel('Size (ml)').fill('50');
  await form.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('heading', { name: 'Desert Amber' }).waitFor();
  await page.getByRole('button', { name: 'Publish' }).click();
  await page.locator('.card', { hasText: 'Desert Amber' }).locator('.badge', { hasText: 'Active' }).waitFor();
  check(true, 'product created as draft and published');

  await page.locator('.nav-link', { hasText: 'Offers' }).click();
  await page.getByRole('button', { name: 'Sell a product' }).click();
  await page.getByPlaceholder('Search').fill('Desert');
  await page.locator('tr', { hasText: `AMB-${run}-50`.toUpperCase() }).getByRole('button', { name: 'Add' }).click();
  await page.getByLabel('Price (DZD)', { exact: true }).fill('7200');
  await page.getByLabel('Opening stock (default warehouse)').fill('6');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('tr', { hasText: `AMB-${run}-50`.toUpperCase() }).getByText('Active').waitFor();
  check(true, 'offer created with a DZD price and stock');

  const sku = `AMB-${run}-50`.toUpperCase();
  const stock = page.getByTestId(`stock-${sku}`);
  await page.locator('.nav-link', { hasText: 'Inventory' }).click();
  await page.getByLabel('Code').fill('ORAN');
  await page.getByLabel('Name', { exact: true }).fill('Dépôt Oran');
  await page.getByRole('button', { name: 'Add a warehouse' }).click();
  await page.locator('tr', { hasText: 'Dépôt Oran' }).waitFor();
  check(true, 'second warehouse created');

  const card = page.locator('.card', { has: stock });
  await card.getByRole('button', { name: 'Edit' }).click();
  await card.getByLabel('Change (+ to add, − to remove)').fill('5');
  await card.locator('form').first().getByRole('button', { name: 'Save' }).click();
  await stock.filter({ hasText: 'Available: 11' }).waitFor();
  await card.getByLabel('Change (+ to add, − to remove)').fill('-50');
  await card.locator('form').first().getByRole('button', { name: 'Save' }).click();
  await card.getByText('Not enough stock for this change.').waitFor();
  check(true, 'stock adjusted with history; cannot go below zero');

  await card.getByLabel('To', { exact: true }).selectOption({ label: 'ORAN · Dépôt Oran' });
  await card.getByLabel('Quantity', { exact: true }).fill('4');
  await card.getByRole('button', { name: 'Transfer' }).click();
  await card.locator('tr', { hasText: 'ORAN' }).filter({ hasText: '4' }).first().waitFor();
  await stock.filter({ hasText: 'Available: 11' }).waitFor();
  check(true, 'stock transferred between warehouses, total unchanged');

  const csvPath = join(mkdtempSync(join(tmpdir(), 'aruma-csv-')), 'stock.csv');
  writeFileSync(csvPath, `sku;quantity;location\n${sku};10;ORAN\n`);
  await page.getByLabel('Import CSV / Excel').setInputFiles(csvPath);
  await page.getByRole('button', { name: 'Check file' }).click();
  await page.getByRole('button', { name: 'Import 1 rows' }).click();
  await page.getByText('Import saved.').waitFor();
  await stock.filter({ hasText: 'Available: 17' }).waitFor();
  check(true, 'CSV import checked first, then applied');
  await page.screenshot({ path: join(shots, '3-inventory-en.png'), fullPage: true });

  const storefront = await (await fetch(`${API}/v1/stores/mb-parfum/products/ambre-${run}?locale=fr`)).json();
  check(storefront.data.name === 'Ambre du Désert' && storefront.data.variants[0].price.amount === '7200.00', 'product is live in MB Parfum at 7200 DZD');

  await page.locator('.nav-link', { hasText: 'Settings' }).click();
  await page.getByTestId('commission-mb-parfum').getByText('12 %').waitFor();
  check((await page.getByTestId('commission-mb-parfum').locator('input').count()) === 0, 'ARUMA commission is shown read-only');

  console.log('Orders (English)');
  const shopper = await call('POST', '/v1/auth/register', null, { email: `shopper-${run}@example.com`, password: 'a strong password', displayName: 'Yacine' });
  const offerRow = (await call('GET', `/v1/merchants/${merchantId}/offers`, owner.token))[0];
  const placed = await fetch(`${API}/v1/stores/mb-parfum/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shopper.token}`, 'idempotency-key': `e2e-${run}-order` },
    body: JSON.stringify({
      lines: [{ offerId: offerRow.id, quantity: 2 }],
      paymentMethod: 'cash_on_delivery',
      shippingAddress: { fullName: 'Yacine Meziane', phone: '+213661234567', line1: '5 rue Larbi Ben Mhidi', city: 'Oran', region: 'Oran', country: 'DZ' },
    }),
  }).then((r) => r.json());
  const number = placed.data.orders[0].number;

  await page.locator('.nav-link', { hasText: 'Orders' }).click();
  await page.getByRole('button', { name: number }).click();
  await page.getByRole('heading', { name: number }).waitFor();
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await page.getByRole('button', { name: 'Start preparing' }).click();
  await page.getByRole('button', { name: 'Hand to carrier' }).click();
  await page.getByLabel('Note (e.g. tracking number)').fill('Yalidine 4512');
  await page.getByRole('button', { name: 'Confirm · Hand to carrier' }).click();
  await page.getByRole('button', { name: 'Mark delivered' }).click();
  await page.getByRole('button', { name: 'Record a return' }).click();
  await page.getByLabel('Reason (required)').fill('Refusé à la livraison');
  await page.getByRole('button', { name: 'Confirm · Record a return' }).click();
  await page.getByTestId('order-history').locator('tbody tr').nth(5).waitFor();
  const rows = await page.getByTestId('order-history').locator('tbody tr').count();
  check(rows === 6, 'order moved new → processing → preparing → shipping → delivered → returned, all recorded');
  check((await page.getByRole('button', { name: 'Refund' }).count()) === 0, 'merchant has no refund button');
  await page.getByText('Refusé à la livraison').waitFor();
  await page.getByText('Yalidine 4512').waitFor();
  check(true, 'history shows the reason and the tracking note');
  await page.screenshot({ path: join(shots, '5-order-en.png'), fullPage: true });

  await page.getByLabel('Language').first().selectOption('ar');
  await page.locator('.nav-link', { hasText: 'لوحة القيادة' }).click();
  await page.getByText('حسابك موثّق').waitFor();
  await page.screenshot({ path: join(shots, '4-dashboard-verified-ar.png'), fullPage: true });
  console.log('\nAll end-to-end checks passed.');
} catch (error) {
  await page.screenshot({ path: join(shots, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  stopAll();
  process.exit();
}

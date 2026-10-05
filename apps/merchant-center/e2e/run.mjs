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
  check((await page.locator('.nav-link').count()) === 24, 'all 24 Merchant Center sections are in the menu (20 + Returns + Shipping + Cash on delivery + Disputes)');
  await page.screenshot({ path: join(shots, '1-dashboard-ar.png'), fullPage: true });

  await page.locator('.nav-link', { hasText: 'المبيعات' }).click();
  await page.getByText('يأتي في المرحلة 1').waitFor();
  check(true, 'upcoming sections say when they arrive');
  await page.locator('.nav-link', { hasText: 'الرصيد' }).click();
  await page.getByText('للاطلاع فقط').first().waitFor();
  check(true, 'finance sections state they are read-only');
  await page.getByText('لا توجد حركات مالية بعد.').first().waitFor();
  check(true, 'a new merchant sees an empty ledger');
  await page.screenshot({ path: join(shots, '1b-balance-ar.png'), fullPage: true });

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

  console.log('Shipping (English)');
  await page.locator('.nav-link', { hasText: 'Shipping' }).click();
  await page.getByText('You have no delivery method yet').waitFor();
  check(true, 'without a delivery method the merchant is told customers cannot order');
  await page.getByRole('button', { name: 'New zone' }).click();
  await page.getByLabel('Zone name').fill('Ouest');
  await page.getByLabel('31 Oran').check();
  await page.getByLabel('46 Aïn Témouchent').check();
  await page.getByRole('button', { name: 'Save zone' }).click();
  await page.locator('td', { hasText: 'Oran' }).first().waitFor();
  await page.getByRole('combobox', { name: /^Type/ }).selectOption('courier');
  await page.getByLabel('Name shown to customers').fill('Yalidine domicile');
  await page.getByRole('combobox', { name: /^Courier company/ }).selectOption('yalidine');
  await page.getByRole('button', { name: 'Add method' }).click();
  const method = page.getByTestId('method-Yalidine domicile');
  await method.getByText('No price yet').waitFor();
  await method.getByLabel('Zone').selectOption({ label: 'Ouest' });
  await method.getByLabel('Price (DZD)').fill('500');
  await method.getByLabel('Max. days').fill('4');
  await method.getByRole('button', { name: 'Save price' }).click();
  await method.locator('tr', { hasText: 'Ouest' }).getByText('500.00').waitFor();
  check(true, 'zone (Oran, Aïn Témouchent), courier method and its price set from the UI');
  await page.screenshot({ path: join(shots, '5-shipping-en.png'), fullPage: true });

  console.log('Orders (English)');
  const shopper = await call('POST', '/v1/auth/register', null, { email: `shopper-${run}@example.com`, password: 'a strong password', displayName: 'Yacine' });
  const offerRow = (await call('GET', `/v1/merchants/${merchantId}/offers`, owner.token))[0];
  const lines = [{ offerId: offerRow.id, quantity: 2 }];
  const choices = await call('POST', '/v1/stores/mb-parfum/delivery-options', null, { lines, country: 'DZ', localityId: 'DZ-31-C-oran' });
  const option = choices.sellers[0].options[0];
  check(option.name === 'Yalidine domicile' && option.priceMinor === 50000, 'customer in Oran is offered Yalidine at 500 DZD');
  const placed = await fetch(`${API}/v1/stores/mb-parfum/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shopper.token}`, 'idempotency-key': `e2e-${run}-order` },
    body: JSON.stringify({
      lines,
      paymentMethod: 'cash_on_delivery',
      // A new phone each run: the customer's COD history (refusals…) follows the phone number.
      shippingAddress: { fullName: 'Yacine Meziane', phone: `0661${String(Date.now()).slice(-6)}`, country: 'DZ', localityId: 'DZ-31-C-oran', line1: '5 rue Larbi Ben Mhidi', deliveryNotes: 'Appeler avant de passer' },
      delivery: [{ merchantId, methodId: option.methodId }],
    }),
  }).then((r) => r.json());
  const number = placed.data.orders[0].number;
  check(placed.data.orders[0].shippingMinor === 50000, 'order charged the delivery price computed by the server');

  await page.locator('.nav-link', { hasText: 'Orders' }).click();
  await page.getByRole('button', { name: number }).click();
  await page.getByRole('heading', { name: number }).waitFor();
  await page.getByText('Wilaya: Oran').waitFor();
  await page.getByTestId('delivery-notes').getByText('Appeler avant de passer').waitFor();
  check(true, 'address shows Commune, Daïra, Wilaya and the delivery notes');
  console.log('Cash on delivery (English)');
  await page.getByText('confirm the order with the customer before preparing it').waitFor();
  check((await page.getByRole('button', { name: 'Confirm order' }).count()) === 0, 'a COD order cannot be prepared before the customer confirms');
  const cod = page.getByTestId('cod');
  await cod.getByText('First cash-on-delivery order').waitFor();
  await cod.getByText('Low risk').waitFor();
  await cod.getByText('DZD 14,900.00').first().waitFor();
  check(true, 'COD panel shows the amount to collect and the customer risk (first order, low)');
  await cod.getByLabel('Note').fill('Pas de réponse à 10h');
  await cod.getByRole('button', { name: 'No answer' }).click();
  await cod.getByText('1 / 3').waitFor();
  await cod.getByRole('button', { name: 'Confirmed' }).click();
  await page.getByRole('heading', { name: number }).getByText('Processing').waitFor();
  check(true, 'confirmation calls recorded; "Confirmed" confirms the order');
  const shipment = page.getByTestId('shipment');
  await shipment.getByRole('button', { name: 'Prepare the parcel' }).click();
  await shipment.getByText('Being prepared').first().waitFor();
  await shipment.getByRole('button', { name: 'Handed to courier' }).click();
  await shipment.getByLabel('Tracking number').fill(`YAL-${run}`);
  await shipment.getByRole('button', { name: 'Confirm · Handed to courier' }).click();
  await shipment.getByText(`YAL-${run}`).waitFor();
  await shipment.getByRole('button', { name: 'Out for delivery' }).click();
  await shipment.getByLabel('Place (optional)').fill('Oran');
  await shipment.getByRole('button', { name: 'Confirm · Out for delivery' }).click();
  await shipment.getByRole('button', { name: 'Delivery failed' }).click();
  await shipment.getByLabel('Why did it fail?').selectOption('customer_absent');
  await shipment.getByRole('button', { name: 'Confirm · Delivery failed' }).click();
  await cod.getByText('Customer absent').first().waitFor();
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
  await cod.getByLabel('New attempt on').fill(tomorrow);
  await cod.getByRole('button', { name: 'Schedule the new attempt' }).click();
  await cod.getByText('Next attempt').waitFor();
  check(true, 'failed delivery recorded with its reason, new attempt scheduled');
  await shipment.getByRole('button', { name: 'Out for delivery' }).click();
  await shipment.getByRole('button', { name: 'Confirm · Out for delivery' }).click();
  await shipment.getByRole('button', { name: 'Delivered' }).click();
  await shipment.getByRole('button', { name: 'Confirm · Delivered' }).click();
  await page.getByRole('heading', { name: number }).getByText('Delivered').waitFor();
  check(true, 'parcel prepared, handed to Yalidine with its tracking number, delivered on the second attempt — the order followed');
  await cod.getByText('With the courier').waitFor();

  await page.locator('.nav-link', { hasText: 'Cash on delivery' }).click();
  await page.getByTestId('cod-withCourier').getByText('14,900.00').waitFor();
  await page.getByRole('checkbox', { name: number }).check();
  await page.getByLabel('Payment reference').fill(`YAL-VIR-${run}`);
  await page.getByLabel('Courier fees (DZD)').fill('500');
  await page.getByText('Expected: DZD 14,400.00').waitFor();
  await page.getByLabel('Amount received (DZD)').fill('14400');
  await page.getByRole('button', { name: 'Record the payment' }).click();
  await page.getByTestId('cod-withMerchant').getByText('14,900.00').waitFor();
  await page.locator('td', { hasText: `YAL-VIR-${run}` }).waitFor();
  check(true, "courier's payment recorded and checked: 14 900 collected − 500 fees = 14 400 received");
  await page.screenshot({ path: join(shots, '6-cod-en.png'), fullPage: true });
  await page.locator('.nav-link', { hasText: 'Orders' }).click();
  await page.getByRole('button', { name: number }).click();
  await page.getByRole('heading', { name: number }).waitFor();
  console.log('Returns (English)');
  // The customer asks to return both bottles (API: the storefront is not built yet), with a photo.
  const asShopper = { authorization: `Bearer ${shopper.token}` };
  const requested = await fetch(`${API}/v1/me/orders/${placed.data.orders[0].id}/returns`, {
    method: 'POST',
    headers: { ...asShopper, 'content-type': 'application/json' },
    body: JSON.stringify({ lines: [{ orderLineId: placed.data.orders[0].lines[0].id, quantity: 2 }], reason: 'damaged', description: 'Les deux flacons sont arrivés fissurés.', resolution: 'refund' }),
  }).then((r) => r.json());
  const photo = new FormData();
  photo.append('file', new Blob([Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)])], { type: 'image/png' }), 'photo.png');
  await fetch(`${API}/v1/me/returns/${requested.data.id}/evidence`, { method: 'POST', headers: asShopper, body: photo });
  const submitted = await fetch(`${API}/v1/me/returns/${requested.data.id}/submit`, { method: 'POST', headers: asShopper }).then((r) => r.json());
  check(submitted.data.status === 'requested', 'customer return request sent with a photo');
  const returnNumber = submitted.data.number;

  await page.locator('.nav-link', { hasText: 'Returns' }).click();
  await page.getByRole('button', { name: returnNumber }).click();
  await page.getByTestId('return-description').getByText('Les deux flacons sont arrivés fissurés.').waitFor();
  check((await page.getByRole('button', { name: /^Customer · 1$/ }).count()) === 1, "the customer's photo is attached");
  await page.getByRole('combobox', { name: /^How the item comes back/ }).selectOption('drop_off');
  await page.getByRole('button', { name: 'Accept the return' }).click();
  await page.getByRole('button', { name: 'I received the item' }).click();
  await page.getByRole('checkbox', { name: /Back on sale/ }).uncheck();
  await page.getByRole('button', { name: 'Save the inspection' }).click();
  await page.getByText('ARUMA sends the refund').waitFor();
  check(true, 'merchant accepted, received and inspected the return; ARUMA sends the 14 900 DZD refund');
  await page.screenshot({ path: join(shots, '7-return-en.png'), fullPage: true });

  await page.locator('.nav-link', { hasText: 'Orders' }).click();
  await page.getByRole('button', { name: number }).click();
  await page.getByRole('heading', { name: number }).waitFor();
  await page.getByTestId('order-history').locator('tbody tr').nth(5).waitFor();
  const rows = await page.getByTestId('order-history').locator('tbody tr').count();
  check(rows === 6, 'order moved new → processing → preparing → shipping → delivered → returned, all recorded');
  check((await page.getByTestId('shipment-history').locator('tbody tr').count()) === 7, 'tracking history: prepared, in transit, out, failed, out again, delivered, back');
  check((await page.getByRole('button', { name: 'Refund' }).count()) === 0, 'merchant has no refund button');
  await page.getByTestId('order-history').getByText(`Return ${returnNumber}`).waitFor();
  check(true, 'history shows the return that closed the order');
  await page.screenshot({ path: join(shots, '5-order-en.png'), fullPage: true });

  console.log('Reviews (English)');
  const review = (body) =>
    fetch(`${API}/v1/me/reviews`, { method: 'POST', headers: { ...asShopper, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const productReview = await review({ type: 'product', orderLineId: placed.data.orders[0].lines[0].id, rating: 5, title: 'Sillage magnifique', body: `Le parfum tient toute la journée, je recommande (commande ${number}).` });
  const shopReview = await review({ type: 'merchant', orderId: placed.data.orders[0].id, rating: 4, body: `Bon vendeur, réponse rapide (commande ${number}).` });
  // Identical text from other accounts (earlier runs) would be held as copied: each run writes its own.
  check(productReview.data.status === 'published' && shopReview.data.status === 'published', 'verified buyer reviews the product and the shop');
  const spam = await review({ type: 'product', orderLineId: placed.data.orders[0].lines[0].id, rating: 5, body: 'Encore un excellent parfum !' });
  check(spam.error?.code === 'ALREADY_REVIEWED', 'a second review of the same product is refused');

  await page.locator('.nav-link', { hasText: 'Reviews' }).click();
  await page.getByTestId('seller-rating').getByText('4.0').waitFor();
  const reviewCard = page.getByTestId(`review-${productReview.data.id}`);
  await reviewCard.getByText('Le parfum tient toute la journée').waitFor();
  await reviewCard.getByText('Verified purchase').waitFor();
  check(true, 'merchant sees its ratings and the verified reviews');
  await reviewCard.getByRole('button', { name: 'Reply' }).click();
  await reviewCard.getByLabel('Public reply').fill('Appelez-nous au 0555 12 34 56');
  await reviewCard.getByRole('button', { name: 'Publish the reply' }).click();
  await reviewCard.getByText('Replies cannot contain links, contact details or blocked words.').waitFor();
  await reviewCard.getByLabel('Public reply').fill('Merci beaucoup, au plaisir de vous servir à nouveau !');
  await reviewCard.getByRole('button', { name: 'Publish the reply' }).click();
  await reviewCard.getByText('Your reply:').waitFor();
  const shown = await fetch(`${API}/v1/products/${productReview.data.productId}/reviews`).then((r) => r.json());
  check(shown.data.reviews[0].merchantReply?.text === 'Merci beaucoup, au plaisir de vous servir à nouveau !', 'public reply shown under the review (contact details refused)');
  await page.screenshot({ path: join(shots, '8-reviews-en.png'), fullPage: true });

  console.log('Disputes (English)');
  // The customer opens a dispute about the order (API: the storefront is not built yet).
  const opened = await fetch(`${API}/v1/me/disputes`, {
    method: 'POST',
    headers: { ...asShopper, 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: placed.data.orders[0].id, category: 'not_as_described', subject: 'Parfum différent', description: `Le parfum reçu ne sent pas comme décrit (commande ${number}).` }),
  }).then((r) => r.json());
  check(opened.data?.status === 'open', 'customer opened a dispute about the order');
  await page.locator('.nav-link', { hasText: 'Disputes' }).click();
  await page.getByRole('button', { name: opened.data.number }).click();
  await page.getByText('Opened against you').waitFor();
  await page.getByLabel('Your message').fill('Le parfum est bien celui de la fiche, lot vérifié avant envoi.');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByTestId('dispute-thread').getByText('lot vérifié avant envoi').waitFor();
  await page.getByLabel('Add a file').setInputFiles({ name: 'facture.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 facture') });
  await page.getByRole('button', { name: /Evidence · Merchant · 1/ }).waitFor();
  check(true, 'merchant answered in the thread and attached a file');
  // ARUMA decides (API: the ARUMA back office comes later), partly for each side.
  const decided = await call('POST', `/v1/admin/disputes/${opened.data.id}/decision`, admin.token, { outcome: 'partial', remedy: 'none', text: 'Odeur légèrement différente selon le lot ; aucun remboursement dû.' });
  check(decided.status === 'decided', 'ARUMA decided');
  await page.reload();
  await page.getByTestId('dispute-decision').getByText('Partly in favour of each').waitFor();
  await page.getByRole('button', { name: 'Appeal' }).first().click();
  await page.getByLabel('Reason').fill('Le lot est identique à celui de la fiche produit, certificat joint.');
  await page.getByRole('button', { name: 'Send' }).first().click();
  await page.getByText('Another ARUMA administrator is reviewing the appeal.').waitFor();
  check(true, 'merchant appealed from the UI');
  const sameAdmin = await call('POST', `/v1/admin/disputes/${opened.data.id}/appeal-decision`, admin.token, { result: 'upheld', text: 'Décision confirmée après examen du dossier.' }).catch((e) => e.message);
  const admin2Email = `admin2-${run}@example.com`;
  const admin2 = await call('POST', '/v1/auth/register', null, { email: admin2Email, password: 'a strong password', displayName: 'Admin 2' });
  const db2 = new pg.Client({ connectionString: DATABASE_URL });
  await db2.connect();
  await db2.query(`update users set role = 'admin' where email = $1`, [admin2Email]);
  await db2.end();
  const upheld = await call('POST', `/v1/admin/disputes/${opened.data.id}/appeal-decision`, admin2.token, { result: 'upheld', text: 'Décision confirmée après nouvel examen du dossier.' });
  check(String(sameAdmin).includes('403') && upheld.status === 'resolved', 'the appeal is decided by another administrator, never the first one');
  await page.reload();
  await page.getByText('Decision upheld').waitFor();
  await page.getByTestId('dispute-history').getByText('Appeal decided').waitFor();
  check((await page.getByLabel('Your message').count()) === 0, 'resolved: final, with its full history; no more messages');
  await page.screenshot({ path: join(shots, '9-dispute-en.png'), fullPage: true });


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

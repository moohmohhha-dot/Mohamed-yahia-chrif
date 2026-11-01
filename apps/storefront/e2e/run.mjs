/**
 * Storefront end-to-end check in a real browser: browse, search, product page, compare, gift ideas, cart,
 * account, Algerian address, delivery, cash on delivery with its code, order tracking.
 *
 *   node e2e/run.mjs demo   — the demo build (no server): builds dist-demo and serves it
 *   node e2e/run.mjs        — the real shop against a running ARUMA CORE (ARUMA_API_URL, default :3000)
 *                             with the MB Parfum seed data; stops at the SMS code (sent to the phone)
 */
import { execSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const demo = process.argv[2] === 'demo';
const shots = join(here, 'screenshots', demo ? 'demo' : 'live');
mkdirSync(shots, { recursive: true });
const PORT = demo ? 4181 : 4182;
const UI = `http://127.0.0.1:${PORT}`;

console.log(`Building the ${demo ? 'demo' : 'real'} storefront…`);
execSync(`npx vite build${demo ? ' --mode demo' : ''}`, { cwd: appDir, stdio: 'ignore' });
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1', ...(demo ? ['--mode', 'demo', '--outDir', 'dist-demo'] : [])], {
  cwd: appDir,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, ARUMA_API_URL: process.env.ARUMA_API_URL ?? 'http://127.0.0.1:3000' },
});
const stop = () => {
  try {
    process.kill(-server.pid);
  } catch {}
};
for (let i = 0; i < 60; i++) {
  if (await fetch(UI).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 500));
}

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures++;
};

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on('pageerror', (e) => errors.push(e.message));
try {
  const run = Math.random().toString(36).slice(2, 8);
  await page.goto(UI);
  await page.getByTestId('product-card').first().waitFor();
  check((await page.locator('html').getAttribute('dir')) === 'rtl', 'Arabic by default, right to left');
  if (demo) check(await page.getByTestId('demo-bar').isVisible(), 'the demo says it is a demo');
  await page.screenshot({ path: join(shots, '1-home-ar.png'), fullPage: true });

  console.log('Search');
  await page.locator('#site-search').fill(demo ? 'عطر رجالي أقل من 13000 دج' : 'عطر رجالي');
  await page.locator('#site-search').press('Enter');
  await page.getByTestId('understood').waitFor();
  check((await page.getByTestId('understood').textContent()).includes('رجالي'), 'a sentence is understood: “men’s perfume under 13 000 DA” becomes filters');
  if (demo) {
    await page.locator('#site-search').fill('jasmn');
    await page.locator('#site-search').press('Enter');
    await page.getByTestId('corrected').waitFor();
    check(true, 'a typo is corrected (jasmn → jasmin)');
  }
  await page.screenshot({ path: join(shots, '2-search-ar.png'), fullPage: true });

  console.log('Product, compare');
  await page.getByRole('link', { name: 'كل العطور' }).first().click();
  await page.getByTestId('product-card').first().waitFor();
  const first = page.getByTestId('product-card').first();
  await first.click();
  await page.getByTestId('add-to-cart').waitFor();
  await page.getByText('المقدمة').first().waitFor();
  check(true, 'product page: notes pyramid, sizes, price, seller');
  await page.getByRole('button', { name: '＋ قارن' }).click();
  await page.getByTestId('add-to-cart').click();
  await page.getByTestId('toast').waitFor();
  check((await page.getByTestId('cart-count').textContent()) === '1', 'added to the cart');
  await page.screenshot({ path: join(shots, '3-product-ar.png'), fullPage: true });
  await page.getByRole('link', { name: 'كل العطور' }).first().click();
  await page.getByTestId('product-card').nth(1).click();
  await page.getByTestId('add-to-cart').waitFor();
  await page.getByRole('button', { name: '＋ قارن' }).click();
  await page.getByRole('link', { name: 'المقارنة' }).click();
  await page.getByTestId('compare-table').waitFor();
  check((await page.getByTestId('compare-table').locator('thead th').count()) === 3, 'two perfumes compared side by side (price per 100 ml, notes, rating)');
  await page.screenshot({ path: join(shots, '4-compare-ar.png'), fullPage: true });

  console.log('Gift ideas');
  await page.getByRole('link', { name: 'أفكار الهدايا' }).first().click();
  await page.locator('#gift-text').fill('لأمي، تحب الفانيليا، أقل من 9000 دج');
  await page.getByTestId('find-gifts').click();
  await page.getByTestId('gift-results').getByTestId('product-card').first().waitFor();
  check((await page.getByTestId('gift-results').textContent()).includes('نسائي'), 'gift ideas from a sentence: for women, under 9 000 DA');
  await page.screenshot({ path: join(shots, '5-gifts-ar.png'), fullPage: true });

  console.log('Checkout');
  await page.getByRole('link', { name: 'السلة' }).click();
  await page.getByTestId('cart-lines').waitFor();
  await page.getByTestId('go-checkout').click();
  await page.locator('#auth-name').or(page.getByRole('tab', { name: 'حساب جديد' })).first().waitFor();
  if (!(await page.locator('#auth-name').isVisible())) await page.getByRole('tab', { name: 'حساب جديد' }).click();
  await page.locator('#auth-name').fill(`Yacine ${run}`);
  await page.locator('#auth-email').fill(`shop-${run}@example.com`);
  await page.locator('#auth-password').fill('a strong password');
  await page.getByRole('button', { name: 'حساب جديد' }).last().click();
  await page.getByText(`مرحبًا Yacine ${run}`).waitFor();
  await page.locator('#phone').fill('0661 23 45 67');
  await page.locator('#wilaya').selectOption('DZ-16');
  await page.locator('#daira option').nth(1).waitFor({ state: 'attached' });
  await page.locator('#daira').selectOption('DZ-16-D-sidi-m-hamed');
  await page.locator('#commune option').nth(1).waitFor({ state: 'attached' });
  await page.locator('#commune').selectOption('DZ-16-C-alger-centre');
  await page.locator('#street').fill('5 rue Larbi Ben M’hidi');
  await page.locator('.seller-box .option').first().waitFor();
  check(true, 'address with Wilaya → Daïra → Commune; delivery options and prices for Alger Centre');
  await page.screenshot({ path: join(shots, '6-checkout-ar.png'), fullPage: true });
  await page.getByTestId('place-order').click();
  await page.getByTestId('cod-confirm').waitFor();
  check(true, 'order placed with cash on delivery; a confirmation code is asked');
  await page.screenshot({ path: join(shots, '7-code-ar.png'), fullPage: true });
  // The real shop sends the code by SMS (in development, to the server log): the browser check stops here.
  if (demo) {
    await page.locator('#cod-code').fill('123456');
    await page.getByRole('button', { name: 'تأكيد', exact: true }).click();
    await page.getByTestId('order-success').waitFor();
    await page.getByTestId('timeline').waitFor();
    check(true, 'confirmed: the order page shows the progress (confirmed → preparing → out for delivery → delivered)');
    await page.screenshot({ path: join(shots, '8-order-ar.png'), fullPage: true });
    await page.getByRole('link', { name: 'كل طلباتي' }).click();
    await page.getByTestId('orders').waitFor();
    check(true, 'my orders list');
  }

  console.log('Languages, phone');
  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByLabel('اللغة').selectOption('fr');
  await page.getByText('Votre parfum parle de vous').waitFor();
  check((await page.locator('html').getAttribute('dir')) === 'ltr', 'French, left to right');
  await page.screenshot({ path: join(shots, '9-home-fr.png'), fullPage: true });
  await page.getByLabel('Langue').selectOption('ar');
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(UI);
  await phone.getByTestId('product-card').first().waitFor();
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!wide, 'phone: nothing wider than the screen');
  await phone.screenshot({ path: join(shots, '10-phone-ar.png'), fullPage: true });
  await phone.close();
  check(errors.length === 0, `no error in the page${errors.length ? `: ${errors[0]}` : ''}`);
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: join(shots, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  stop();
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll storefront checks passed.');
process.exit(failures ? 1 : 0);

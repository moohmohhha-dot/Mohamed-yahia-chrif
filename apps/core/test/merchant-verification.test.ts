import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import {
  bearer,
  buildTestApp,
  caller,
  lastCode,
  multipartFile,
  PNG,
  registerUser,
  testDatabaseUrl,
  uniqueSlug,
  verifyMerchantViaApi,
  type TestUser,
} from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const call = caller(app);

let admin: TestUser;
let support: TestUser;

beforeAll(async () => {
  await app.ready();
  [admin, support] = await Promise.all([registerUser(app), registerUser(app)]);
  await db.update(s.users).set({ role: 'admin' }).where(eq(s.users.id, admin.userId));
  await db.update(s.users).set({ role: 'support' }).where(eq(s.users.id, support.userId));
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function newMerchant(type: 'individual' | 'business', activityCode = 'perfume_retail') {
  const owner = await registerUser(app);
  const slug = uniqueSlug();
  const res = await call('POST', '/v1/merchants', owner.token, {
    type,
    slug,
    name: `Shop ${slug}`,
    country: 'DZ',
    activityCode,
    contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    contactEmail: `${slug}@example.com`,
  });
  expect(res.statusCode).toBe(201);
  return { owner, merchant: res.json().data as { id: string; contactPhone: string; contactEmail: string } };
}

const overview = async (merchantId: string, token: string) =>
  (await call('GET', `/v1/merchants/${merchantId}/verification`, token)).json().data;
const check = (o: { checks: { kind: string }[] }, kind: string) => o.checks.find((c) => c.kind === kind) as Record<string, any>;

async function upload(merchantId: string, token: string, kind: string, body = PNG) {
  const { payload, headers } = multipartFile(body);
  return app.inject({ method: 'POST', url: `/v1/merchants/${merchantId}/documents?kind=${kind}`, payload, headers: { ...headers, ...bearer(token) } });
}

describe('merchant types and required checks', () => {
  it('individual: phone, email, identity and payout — no business registration by default', async () => {
    const { owner, merchant } = await newMerchant('individual');
    const o = await overview(merchant.id, owner.token);
    expect(o).toMatchObject({ type: 'individual', status: 'unverified' });
    expect(o.checks.filter((c: { required: boolean }) => c.required).map((c: { kind: string }) => c.kind)).toEqual([
      'phone',
      'email',
      'identity',
      'payout',
    ]);
    expect(check(o, 'identity').missing).toEqual({ fields: ['identity', 'address'], documents: ['id_front', 'id_back'] });
  });

  it('individual: fully verified without any commercial register', async () => {
    const { owner, merchant } = await newMerchant('individual');
    const o = await verifyMerchantViaApi(app, owner, admin, merchant.id);
    expect(o.status).toBe('verified');
    expect(check(o, 'business')).toMatchObject({ required: false, status: 'unverified' });
  });

  it('business: all five checks, with company data and documents', async () => {
    const { owner, merchant } = await newMerchant('business');
    const o = await overview(merchant.id, owner.token);
    expect(o.checks.every((c: { required: boolean }) => c.required)).toBe(true);

    await call('PUT', `/v1/merchants/${merchant.id}/business`, owner.token, {
      registrationType: 'commercial_register',
      registrationNumber: '16/00-1234567B21',
    });
    const submit = await call('POST', `/v1/merchants/${merchant.id}/verifications/business/submit`, owner.token);
    expect(submit.statusCode).toBe(400);
    expect(submit.json().error.code).toBe('REQUIREMENTS_MISSING');
    const missing = check(await overview(merchant.id, owner.token), 'business').missing;
    expect(missing.fields).toEqual(['business.legalName', 'business.legalForm', 'business.taxId', 'address']);
    expect(missing.documents).toEqual(['commercial_register', 'tax_id_card']);

    expect((await verifyMerchantViaApi(app, owner, admin, merchant.id)).status).toBe('verified');
  });

  it('a legal rule can require registration for individuals in an activity, and re-derives existing merchants', async () => {
    const activity = `regulated_${Date.now()}`;
    const { owner, merchant } = await newMerchant('individual', activity);
    expect((await verifyMerchantViaApi(app, owner, admin, merchant.id)).status).toBe('verified');

    const rule = await call('PUT', `/v1/admin/merchant-activity-rules/DZ/${activity}`, admin.token, {
      individualRequiresRegistration: true,
      note: 'Registration required for this activity',
    });
    expect(rule.json().data.merchantsRecomputed).toBe(1);
    let o = await overview(merchant.id, owner.token);
    expect(o.status).toBe('unverified');
    expect(check(o, 'business')).toMatchObject({ required: true, missing: { fields: ['business'] } });

    // An individual registers as auto-entrepreneur: needs the auto-entrepreneur card, not a tax card.
    await call('PUT', `/v1/merchants/${merchant.id}/business`, owner.token, {
      registrationType: 'auto_entrepreneur',
      registrationNumber: 'AE-2024-000123',
    });
    expect(check(await overview(merchant.id, owner.token), 'business').missing.documents).toEqual(['auto_entrepreneur_card']);
    await upload(merchant.id, owner.token, 'auto_entrepreneur_card');
    await call('POST', `/v1/merchants/${merchant.id}/verifications/business/submit`, owner.token);
    o = await overview(merchant.id, owner.token);
    expect(o.status).toBe('under_review');
    await call('POST', `/v1/admin/merchants/${merchant.id}/verifications/business`, admin.token, { decision: 'approve' });
    expect((await overview(merchant.id, owner.token)).status).toBe('verified');
  });

  it('a passport needs no back side', async () => {
    const { owner, merchant } = await newMerchant('individual');
    await call('PUT', `/v1/merchants/${merchant.id}/identity`, owner.token, {
      fullName: 'Karim Haddad',
      dateOfBirth: '1985-01-30',
      nationality: 'DZ',
      documentType: 'passport',
      documentNumber: '198765432',
    });
    expect(check(await overview(merchant.id, owner.token), 'identity').missing.documents).toEqual(['id_front']);
  });
});

describe('phone and email verification (one-time codes)', () => {
  it('verifies the phone with an SMS code, limits attempts and resends', async () => {
    const { owner, merchant } = await newMerchant('individual');
    const base = `/v1/merchants/${merchant.id}/verifications/phone`;
    expect((await call('POST', `${base}/send-code`, owner.token)).statusCode).toBe(202);
    const sms = app.sentMessages.at(-1)!;
    expect(sms).toMatchObject({ channel: 'sms', to: merchant.contactPhone });
    expect((await call('POST', `${base}/send-code`, owner.token)).json().error.code).toBe('CODE_RECENTLY_SENT');

    const code = lastCode(app, merchant.contactPhone);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      expect((await call('POST', `${base}/confirm`, owner.token, { code: wrong })).json().error.code).toBe('INVALID_CODE');
    }
    // Attempts are exhausted: even the right code is refused now.
    expect((await call('POST', `${base}/confirm`, owner.token, { code })).json().error.code).toBe('INVALID_CODE');
    const stored = await db.select().from(s.verificationCodes).where(eq(s.verificationCodes.subjectId, merchant.id));
    expect(stored[0]!.attempts).toBe(5);
    expect(stored[0]!.codeHash).not.toContain(code);
  });

  it('keeps phone and email independent, and a changed contact must be verified again', async () => {
    const { owner, merchant } = await newMerchant('individual');
    const base = `/v1/merchants/${merchant.id}/verifications`;
    for (const kind of ['phone', 'email'] as const) {
      await call('POST', `${base}/${kind}/send-code`, owner.token);
      const to = kind === 'phone' ? merchant.contactPhone : merchant.contactEmail;
      await call('POST', `${base}/${kind}/confirm`, owner.token, { code: lastCode(app, to) });
    }
    expect(app.sentMessages.at(-1)!.channel).toBe('email');
    let o = await overview(merchant.id, owner.token);
    expect([check(o, 'phone').status, check(o, 'email').status]).toEqual(['verified', 'verified']);
    expect((await call('POST', `${base}/phone/send-code`, owner.token)).json().error.code).toBe('ALREADY_VERIFIED');

    await call('PATCH', `/v1/merchants/${merchant.id}`, owner.token, { contactPhone: '+213661000000' });
    o = await overview(merchant.id, owner.token);
    expect(check(o, 'phone')).toMatchObject({ status: 'unverified', note: 'Contact phone changed; please verify it again' });
    expect(check(o, 'email').status).toBe('verified');
  });

  it('phone and email cannot be approved by review', async () => {
    const { merchant } = await newMerchant('individual');
    const res = await call('POST', `/v1/admin/merchants/${merchant.id}/verifications/phone`, admin.token, { decision: 'approve' });
    expect(res.json().error.code).toBe('CODE_VERIFIED_CHECK');
  });
});

describe('review decisions and statuses', () => {
  it('rejection needs a reason, returns the check to unverified and shows the note', async () => {
    const { owner, merchant } = await newMerchant('individual');
    await verifyMerchantViaApi(app, owner, admin, merchant.id);
    // Re-upload the payout proof → payout goes back to unverified; resubmit, then reject.
    await upload(merchant.id, owner.token, 'payout_proof');
    await call('POST', `/v1/merchants/${merchant.id}/verifications/payout/submit`, owner.token);
    expect((await overview(merchant.id, owner.token)).status).toBe('under_review');

    const url = `/v1/admin/merchants/${merchant.id}/verifications/payout`;
    expect((await call('POST', url, admin.token, { decision: 'reject' })).json().error.code).toBe('NOTE_REQUIRED');
    expect((await call('POST', url, support.token, { decision: 'reject', note: 'x' })).statusCode).toBe(403);
    await call('POST', url, admin.token, { decision: 'reject', note: 'Le RIB ne correspond pas au titulaire' });
    const o = await overview(merchant.id, owner.token);
    expect(o.status).toBe('unverified');
    expect(check(o, 'payout')).toMatchObject({ status: 'unverified', note: 'Le RIB ne correspond pas au titulaire', ready: true });
  });

  it('suspending one check suspends the merchant until reinstated', async () => {
    const { owner, merchant } = await newMerchant('individual');
    await verifyMerchantViaApi(app, owner, admin, merchant.id);
    const url = `/v1/admin/merchants/${merchant.id}/verifications/payout`;
    await call('POST', url, admin.token, { decision: 'suspend', note: 'Suspicious payout account' });
    expect((await overview(merchant.id, owner.token)).status).toBe('suspended');
    // Editing data does not lift a suspension.
    await call('PUT', `/v1/merchants/${merchant.id}/payout-method`, owner.token, {
      type: 'postal_account',
      holderName: 'Amina Benali',
      accountNumber: '00799999000987654321',
      currency: 'DZD',
    });
    expect(check(await overview(merchant.id, owner.token), 'payout').status).toBe('suspended');

    await call('POST', url, admin.token, { decision: 'reinstate' });
    const o = await overview(merchant.id, owner.token);
    expect(check(o, 'payout').status).toBe('unverified');
    expect(o.status).toBe('unverified');
  });

  it('merchant-level suspension overrides verified checks', async () => {
    const { owner, merchant } = await newMerchant('individual');
    await verifyMerchantViaApi(app, owner, admin, merchant.id);
    const res = await call('POST', `/v1/admin/merchants/${merchant.id}/suspend`, admin.token, { reason: 'Counterfeit reports' });
    expect(res.json().data).toMatchObject({ status: 'suspended', suspended: { reason: 'Counterfeit reports' } });
    const [row] = await db.select().from(s.merchants).where(eq(s.merchants.id, merchant.id));
    expect(row!.verificationStatus).toBe('suspended');

    await call('POST', `/v1/admin/merchants/${merchant.id}/unsuspend`, admin.token);
    expect((await overview(merchant.id, owner.token)).status).toBe('verified');
  });

  it('changing verified identity data sends the check back for review', async () => {
    const { owner, merchant } = await newMerchant('individual');
    await verifyMerchantViaApi(app, owner, admin, merchant.id);
    await call('PUT', `/v1/merchants/${merchant.id}/identity`, owner.token, {
      fullName: 'Amina Benali-Saidi',
      dateOfBirth: '1990-04-12',
      nationality: 'DZ',
      documentType: 'national_id',
      documentNumber: '109901234567890',
    });
    const o = await overview(merchant.id, owner.token);
    expect(check(o, 'identity')).toMatchObject({ status: 'unverified', ready: true });
    expect(o.status).toBe('unverified');
  });

  it('lists the review queue for platform staff', async () => {
    const { owner, merchant } = await newMerchant('individual');
    await upload(merchant.id, owner.token, 'payout_proof');
    await call('PUT', `/v1/merchants/${merchant.id}/payout-method`, owner.token, {
      type: 'bank_account',
      holderName: 'Test',
      accountNumber: '00100123001234567890',
      currency: 'DZD',
    });
    await call('POST', `/v1/merchants/${merchant.id}/verifications/payout/submit`, owner.token);
    const queue = await call('GET', '/v1/admin/merchants?checkUnderReview=payout', support.token);
    expect(queue.json().data.map((m: { id: string }) => m.id)).toContain(merchant.id);
    expect((await call('GET', '/v1/admin/merchants', owner.token)).statusCode).toBe(403);
  });
});

describe('permissions and sensitive data', () => {
  it('only the owner submits checks and handles identity and payout data', async () => {
    const { owner, merchant } = await newMerchant('business');
    const manager = await registerUser(app);
    await call('PUT', `/v1/merchants/${merchant.id}/staff`, owner.token, { email: manager.email, role: 'manager' });

    expect((await call('POST', `/v1/merchants/${merchant.id}/verifications/identity/submit`, manager.token)).statusCode).toBe(403);
    expect((await upload(merchant.id, manager.token, 'id_front')).statusCode).toBe(403);
    expect((await upload(merchant.id, manager.token, 'commercial_register')).statusCode).toBe(201);
    const identity = await call('PUT', `/v1/merchants/${merchant.id}/identity`, manager.token, {
      fullName: 'X Y',
      dateOfBirth: '1990-01-01',
      nationality: 'DZ',
      documentType: 'passport',
      documentNumber: '12345678',
    });
    expect(identity.statusCode).toBe(403);
  });

  it('encrypts ID and account numbers; members see last 4 digits, reviewers see all and are audited', async () => {
    const { owner, merchant } = await newMerchant('individual');
    await verifyMerchantViaApi(app, owner, admin, merchant.id);

    const [identity] = await db.select().from(s.merchantIdentities).where(eq(s.merchantIdentities.merchantId, merchant.id));
    expect(identity!.documentNumberEncrypted).not.toContain('109901234567890');
    expect(identity!.documentNumberLast4).toBe('7890');

    const mine = (await call('GET', `/v1/merchants/${merchant.id}/profile`, owner.token)).json().data;
    expect(mine.identity).toMatchObject({ documentNumberLast4: '7890' });
    expect(mine.identity.documentNumber).toBeUndefined();
    expect(mine.payoutMethod.accountNumber).toBeUndefined();
    expect(JSON.stringify(mine)).not.toContain('Encrypted');

    const full = (await call('GET', `/v1/admin/merchants/${merchant.id}`, support.token)).json().data;
    expect(full.identity.documentNumber).toBe('109901234567890');
    expect(full.payoutMethod.accountNumber).toBe('00799999001234567890');
    const views = await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.entityId, merchant.id), eq(s.auditLogs.action, 'merchants.file.viewed')));
    expect(views).toHaveLength(1);
    expect(views[0]!.actorUserId).toBe(support.userId);
  });

  it('stores documents encrypted, checks the real file type, and serves them only to allowed people', async () => {
    const { owner, merchant } = await newMerchant('individual');
    const bad = await upload(merchant.id, owner.token, 'id_front', Buffer.from('<html>not an image</html>'));
    expect(bad.json().error.code).toBe('UNSUPPORTED_FILE_TYPE');

    const res = await upload(merchant.id, owner.token, 'id_front');
    const doc = res.json().data;
    expect(doc).toMatchObject({ kind: 'id_front', contentType: 'image/png', sizeBytes: PNG.length });
    expect(doc.storageKey).toBeUndefined();

    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    })(app.storageDir);
    const onDisk = files.find((f) => f.endsWith(doc.id))!;
    expect(readFileSync(onDisk).includes(PNG.subarray(8))).toBe(false);

    const url = `/v1/merchants/${merchant.id}/documents/${doc.id}/file`;
    const download = await app.inject({ method: 'GET', url, headers: bearer(owner.token) });
    expect(download.headers['content-type']).toBe('image/png');
    expect(download.headers['content-disposition']).toMatch(/^attachment/);
    expect(download.rawPayload.equals(PNG)).toBe(true);

    const manager = await registerUser(app);
    await call('PUT', `/v1/merchants/${merchant.id}/staff`, owner.token, { email: manager.email, role: 'manager' });
    expect((await app.inject({ method: 'GET', url, headers: bearer(manager.token) })).statusCode).toBe(403);

    const adminView = await app.inject({
      method: 'GET',
      url: `/v1/admin/merchants/${merchant.id}/documents/${doc.id}/file`,
      headers: bearer(admin.token),
    });
    expect(adminView.rawPayload.equals(PNG)).toBe(true);
  });

  it('rejects files over 10 MB', async () => {
    const { owner, merchant } = await newMerchant('individual');
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const res = await upload(merchant.id, owner.token, 'id_front', big);
    expect(res.statusCode).toBe(413);
  });
});

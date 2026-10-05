import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { bearer, buildTestApp, caller, dzAddress, multipartFile, PNG, registerUser, testDatabaseUrl, uniqueSlug, verifyMerchantViaApi, type TestUser } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const call = caller(app);

let admin: TestUser;
let support: TestUser;
let owner: TestUser;
let staff: TestUser;
let merchantId: string;
let merchantPhone: string;
let productId: string;
let productSlug: string;
let otherProductId: string;
let offerId: string;
let otherOfferId: string;
let methodId: string;
let storeId: string;

const ok = async (res: Awaited<ReturnType<typeof call>>, status = 200) => {
  expect(res.statusCode, res.body).toBe(status);
  return res.json().data;
};

/** A customer with a delivered order (one bottle of each offer given). */
async function buyer(opts: { user?: TestUser; offers?: string[]; phone?: string; deliver?: boolean } = {}) {
  const user = opts.user ?? (await registerUser(app));
  const res = await app.inject({
    method: 'POST',
    url: '/v1/stores/mb-parfum/orders',
    headers: { ...bearer(user.token), 'idempotency-key': randomUUID() },
    payload: {
      lines: (opts.offers ?? [offerId]).map((id) => ({ offerId: id, quantity: 1 })),
      paymentMethod: 'cash_on_delivery',
      shippingAddress: dzAddress('DZ-16-C-alger-centre', opts.phone ? { phone: opts.phone } : {}),
      delivery: [{ merchantId, methodId }],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const order = res.json().data.orders[0];
  if (opts.deliver !== false) {
    for (const to of ['processing', 'preparing', 'shipping', 'delivered']) await ok(await call('POST', `/v1/merchants/${merchantId}/orders/${order.id}/status`, owner.token, { to }));
  }
  return { user, order };
}

const write = (user: TestUser, body: object) => call('POST', '/v1/me/reviews', user.token, body);
const productReview = (user: TestUser, order: any, extra: object = {}) =>
  write(user, { type: 'product', orderLineId: order.lines[0].id, rating: 5, body: 'Tenue excellente, très bon sillage.', ...extra });
const moderate = (reviewId: string, action: string, note = 'Vérifié par la modération', user = support) => call('POST', `/v1/admin/reviews/${reviewId}/moderate`, user.token, { action, note });
const publicList = async (query = '') => ok(await call('GET', `/v1/products/${productId}/reviews${query}`));

beforeAll(async () => {
  await app.ready();
  [admin, support, owner, staff] = await Promise.all([registerUser(app), registerUser(app), registerUser(app), registerUser(app)]);
  await db.update(s.users).set({ role: 'admin' }).where(eq(s.users.id, admin.userId));
  await db.update(s.users).set({ role: 'support' }).where(eq(s.users.id, support.userId));
  const slug = uniqueSlug();
  merchantPhone = `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  merchantId = (
    await call('POST', '/v1/merchants', owner.token, { type: 'individual', slug, name: 'Reviews Test', country: 'DZ', activityCode: 'perfume_retail', contactPhone: merchantPhone, contactEmail: `${slug}@example.com` })
  ).json().data.id;
  await verifyMerchantViaApi(app, owner, admin, merchantId);
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: null });
  await call('PUT', `/v1/merchants/${merchantId}/staff`, owner.token, { email: staff.email, role: 'staff' });
  const create = async (name: string) => {
    const pslug = uniqueSlug('rev');
    const id = (
      await call('POST', `/v1/merchants/${merchantId}/products`, owner.token, {
        storeSlug: 'mb-parfum',
        slug: pslug,
        translations: [{ locale: 'ar', name }, { locale: 'fr', name }],
        variants: [{ sku: `${pslug}-50`, options: { sizeMl: 50 } }],
      })
    ).json().data.id;
    await call('PATCH', `/v1/merchants/${merchantId}/products/${id}`, owner.token, { status: 'active' });
    const variantId = (await call('GET', `/v1/merchants/${merchantId}/products`, owner.token)).json().data.find((p: any) => p.id === id).variants[0].id;
    const offer = (await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: 500, prices: [{ currency: 'DZD', amountMinor: 300000 }] })).json().data.id;
    return { id, offer, pslug };
  };
  const main = await create('Oud Noir');
  const other = await create('Musc Blanc');
  [productId, offerId, productSlug, otherProductId, otherOfferId] = [main.id, main.offer, main.pslug, other.id, other.offer];
  methodId = (await ok(await call('POST', `/v1/merchants/${merchantId}/shipping/methods`, owner.token, { type: 'merchant_delivery', name: 'Livreur' }), 201)).id;
  await ok(await call('PUT', `/v1/merchants/${merchantId}/shipping/methods/${methodId}/rates`, owner.token, { zoneId: null, currency: 'DZD', priceMinor: 0 }));
  storeId = (await db.select().from(s.stores).where(eq(s.stores.slug, 'mb-parfum')))[0]!.id;
});

afterAll(async () => {
  await db.delete(s.featureFlagOverrides).where(eq(s.featureFlagOverrides.storeId, storeId));
  await db.update(s.products).set({ status: 'archived' }).where(sql`${s.products.id} in (${productId}, ${otherProductId})`);
  await db.update(s.storeMerchants).set({ status: 'archived' }).where(eq(s.storeMerchants.merchantId, merchantId));
  await app.close();
  await pool.end();
});

describe('verified purchase', () => {
  let first: { user: TestUser; order: any };
  let reviewId: string;

  it('only after delivery, by the buyer, once per product and per seller', async () => {
    const pending = await buyer({ deliver: false });
    expect((await productReview(pending.user, pending.order)).json().error.code).toBe('NOT_DELIVERED');

    first = await buyer({ offers: [offerId, otherOfferId] });
    const stranger = await registerUser(app);
    expect((await productReview(stranger, first.order)).statusCode).toBe(404);
    expect((await productReview(first.user, first.order, { rating: 6 })).statusCode).toBe(400);

    const review = await ok(await productReview(first.user, first.order, { title: 'Superbe', rating: 4 }), 201);
    expect(review).toMatchObject({ type: 'product', productId, merchantId, status: 'published', verifiedPurchase: true, rating: 4, flags: [] });
    reviewId = review.id;
    expect((await productReview(first.user, first.order)).json().error).toMatchObject({ code: 'ALREADY_REVIEWED', details: { reviewId } });
    // Buying again does not give a second voice.
    const again = await buyer({ user: first.user });
    expect((await productReview(first.user, again.order)).json().error.code).toBe('ALREADY_REVIEWED');

    const seller = await ok(await write(first.user, { type: 'merchant', orderId: first.order.id, rating: 5, body: 'Livraison rapide et emballage soigné.' }), 201);
    expect(seller).toMatchObject({ type: 'merchant', productId: null, status: 'published' });
    expect((await write(first.user, { type: 'merchant', orderId: again.order.id, rating: 1 })).json().error.code).toBe('ALREADY_REVIEWED');

    const mine = await ok(await call('GET', '/v1/me/reviews', first.user.token));
    expect(mine.reviews).toHaveLength(2);
    expect(mine.toReview.products.map((p: any) => p.productId)).toEqual([otherProductId]); // bought, not reviewed yet
    expect(mine.toReview.merchants).toEqual([]);
  });

  it('never from the merchant’s own team', async () => {
    const { order } = await buyer({ user: staff });
    expect((await productReview(staff, order)).statusCode).toBe(403);
  });

  it('the author edits (history kept) or withdraws', async () => {
    const edited = await ok(await call('PATCH', `/v1/me/reviews/${reviewId}`, first.user.token, { rating: 5, title: 'Superbe', body: 'Après un mois : toujours excellent.' }));
    expect(edited).toMatchObject({ status: 'published', rating: 5 });
    const [history] = await db.select().from(s.reviewEvents).where(sql`${s.reviewEvents.reviewId} = ${reviewId} and ${s.reviewEvents.type} = 'edited'`);
    expect(history!.data).toMatchObject({ before: { rating: 4 } });
  });
});

describe('protection against spam and fake reviews', () => {
  it('holds reviews with links, contact details, copied text or blocked words for moderation', async () => {
    const cases: [object, string][] = [
      [{ body: 'Achetez moins cher sur www.parfums-pas-chers.com !' }, 'link'],
      [{ body: 'Contactez-moi au 0555 12 34 56 pour un prix.' }, 'contact_info'],
      [{ body: 'Superrrrrrrrrrrrrrr produit de qualité' }, 'spam_pattern'],
      [{ body: 'Écrivez-moi sur whatsapp pour des flacons.' }, 'blocked_term'],
    ];
    for (const [body, flag] of cases) {
      const { user, order } = await buyer();
      const review = await ok(await productReview(user, order, body), 201);
      expect(review.status).toBe('pending');
      expect(review.flags.map((f: any) => f.code)).toContain(flag);
    }
    // The same text as an existing review, from another buyer.
    const { user, order } = await buyer();
    const copy = await ok(await productReview(user, order, { body: 'Après un mois : toujours excellent.' }), 201);
    expect(copy.status).toBe('pending');
    expect(copy.flags.map((f: any) => f.code)).toContain('duplicate_text');
    // Nothing held is public.
    const list = await publicList();
    expect(list.reviews.every((r: any) => !/www|0555|whatsapp|rrrr/.test(r.body ?? ''))).toBe(true);
  });

  it('flags a "customer" who is the merchant (same phone), and a burst of reviews on one product', async () => {
    const self = await buyer({ offers: [otherOfferId], phone: merchantPhone });
    const review = await ok(await productReview(self.user, self.order, { body: 'Le meilleur parfum du monde, sans aucun doute.' }), 201);
    expect(review).toMatchObject({ status: 'pending', flags: [{ code: 'merchant_contact' }] });
    // Many reviews on the main product today (spam tests above included): the next ones are held.
    const late = await buyer();
    const burst = await ok(await productReview(late.user, late.order, { body: 'Très bonne surprise, je recommande.' }), 201);
    expect(burst.flags.map((f: any) => f.code)).toContain('burst');
  });
});

describe('ratings, helpful votes, reports and replies', () => {
  let target: any;

  it('public ratings count published reviews only; readers see a short name and the verified badge', async () => {
    const list = await publicList('?sort=rating_high');
    expect(list.summary.count).toBe(list.reviews.length);
    expect(list.reviews[0]).toMatchObject({ verifiedPurchase: true, author: 'Test U.', seller: 'Reviews Test' });
    target = list.reviews[0];
    const product = await ok(await call('GET', `/v1/stores/mb-parfum/products/${productSlug}`));
    expect(product.rating).toEqual(list.summary);
  });

  it('helpful: one vote per reader, not by the author nor by the merchant’s team', async () => {
    const reader = await registerUser(app);
    const url = `/v1/reviews/${target.id}/helpful`;
    expect(await ok(await call('POST', url, reader.token))).toEqual({ helpfulCount: 1, voted: true });
    expect((await ok(await call('POST', url, reader.token))).helpfulCount).toBe(1);
    expect((await call('POST', url, staff.token)).statusCode).toBe(403);
    expect((await ok(await call('GET', `/v1/products/${productId}/reviews`, reader.token))).reviews.find((r: any) => r.id === target.id).votedHelpful).toBe(true);
    expect((await ok(await call('DELETE', url, reader.token))).helpfulCount).toBe(0);
  });

  it('the merchant replies publicly (no links or phone numbers) and can report, but only ARUMA decides', async () => {
    const url = `/v1/merchants/${merchantId}/reviews/${target.id}`;
    expect((await call('POST', `${url}/reply`, staff.token, { text: 'Merci !' })).statusCode).toBe(403);
    expect((await call('POST', `${url}/reply`, owner.token, { text: 'Appelez-nous au 0555 11 22 33' })).json().error.code).toBe('REPLY_NOT_ALLOWED');
    await ok(await call('POST', `${url}/reply`, owner.token, { text: 'Merci pour votre retour, à bientôt !' }));
    expect((await publicList()).reviews.find((r: any) => r.id === target.id).merchantReply.text).toBe('Merci pour votre retour, à bientôt !');
    expect(await ok(await call('POST', `${url}/report`, owner.token, { reason: 'fake' }))).toEqual({ reported: true, held: false });
    const mine = await ok(await call('GET', `/v1/merchants/${merchantId}/reviews?type=product`, staff.token));
    expect(mine.reviews.find((r: any) => r.id === target.id)).toMatchObject({ reported: 'open', merchantReply: 'Merci pour votre retour, à bientôt !' });
    expect(mine.productRating.count).toBeGreaterThan(0);
  });

  it('reports from three different buyers hold the review; reports from accounts without purchases do not count', async () => {
    const report = (u: TestUser) => call('POST', `/v1/reviews/${target.id}/report`, u.token, { reason: 'spam' });
    for (const u of [await registerUser(app), await registerUser(app), await registerUser(app)]) expect((await ok(await report(u))).held).toBe(false);
    const reporters = [(await buyer()).user, (await buyer()).user];
    for (const u of reporters) expect((await ok(await report(u))).held).toBe(false);
    expect((await report(reporters[0]!)).json().error.code).toBe('ALREADY_REPORTED');
    expect((await ok(await report((await buyer()).user))).held).toBe(true);
    expect((await publicList()).reviews.some((r: any) => r.id === target.id)).toBe(false);
  });

  it('moderation: support staff publish, hide (reports upheld) or restore, always with a note', async () => {
    const customer = await registerUser(app);
    expect((await moderate(target.id, 'publish', 'x y z', customer)).statusCode).toBe(403);
    expect((await call('POST', `/v1/admin/reviews/${target.id}/moderate`, support.token, { action: 'publish' })).statusCode).toBe(400);
    expect((await moderate(target.id, 'restore')).json().error.code).toBe('INVALID_REVIEW_STATUS');
    await ok(await moderate(target.id, 'hide', 'Signalements fondés'));
    const detail = await ok(await call('GET', `/v1/admin/reviews/${target.id}`, admin.token));
    expect(detail).toMatchObject({ status: 'hidden', reportCount: 7 });
    expect(detail.reports.every((r: any) => r.status === 'upheld')).toBe(true);
    await ok(await moderate(target.id, 'restore', 'Erreur de modération'));
    expect((await publicList()).reviews.some((r: any) => r.id === target.id)).toBe(true);
  });

  it('a rejected review tells its author why; editing sends it back to moderation', async () => {
    const { user, order } = await buyer({ offers: [otherOfferId] });
    const held = await ok(await write(user, { type: 'merchant', orderId: order.id, rating: 1, body: 'Meilleurs prix sur www.autre-boutique.dz' }), 201);
    expect(held.status).toBe('pending');
    await ok(await moderate(held.id, 'reject', 'Les liens vers d’autres sites ne sont pas autorisés'));
    const mine = (await ok(await call('GET', '/v1/me/reviews', user.token))).reviews.find((r: any) => r.id === held.id);
    expect(mine).toMatchObject({ status: 'rejected', moderationNote: 'Les liens vers d’autres sites ne sont pas autorisés' });
    const edited = await ok(await call('PATCH', `/v1/me/reviews/${held.id}`, user.token, { rating: 2, body: 'Livraison lente, emballage abîmé.' }));
    expect(edited.status).toBe('pending'); // a moderator looks again
    expect((await ok(await call('DELETE', `/v1/me/reviews/${held.id}`, user.token))).status).toBe('withdrawn');
  });
});

describe('photos (prepared, off by default)', () => {
  it('are refused until switched on; then the review waits for a moderator before the photo is shown', async () => {
    const { user, order } = await buyer({ offers: [otherOfferId] });
    const review = await ok(await write(user, { type: 'product', orderLineId: order.lines[0].id, rating: 4, body: 'Joli flacon, odeur douce et agréable.' }), 201);
    const upload = () => {
      const { payload, headers } = multipartFile(PNG);
      return app.inject({ method: 'POST', url: `/v1/me/reviews/${review.id}/media`, payload, headers: { ...headers, ...bearer(user.token) } });
    };
    expect((await upload()).json().error.code).toBe('MEDIA_NOT_AVAILABLE');
    await db.insert(s.featureFlagOverrides).values({ flagKey: 'reviews.media', storeId, enabled: true });
    expect((await ok(await upload(), 201)).approved).toBe(false);
    expect((await db.select().from(s.reviews).where(eq(s.reviews.id, review.id)))[0]).toMatchObject({ status: 'pending', flags: [{ code: 'media' }] });
    await ok(await moderate(review.id, 'publish', 'Photo conforme'));
    const shown = (await ok(await call('GET', `/v1/products/${otherProductId}/reviews`))).reviews.find((r: any) => r.id === review.id);
    expect(shown.media).toHaveLength(1);
  });
});

describe('records', () => {
  it('reviews and their history cannot be deleted or reassigned', async () => {
    const [review] = await db.select().from(s.reviews).limit(1);
    await expect(db.execute(sql`delete from reviews where id = ${review!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update review_events set note = 'x' where review_id = ${review!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update reviews set customer_user_id = ${owner.userId} where id = ${review!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from review_reports`)).rejects.toThrow();
  });
});

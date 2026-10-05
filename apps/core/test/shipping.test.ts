import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, schema as s } from '@aruma/db';
import { sandboxSignature } from '../src/modules/shipping/index.js';
import { bearer, buildTestApp, caller, dzAddress, registerUser, testDatabaseUrl, uniqueSlug, verifyMerchantViaApi, type TestUser, makeStaff } from './helpers.js';

const { db, pool } = createDb(testDatabaseUrl);
const app = buildTestApp(db);
const call = caller(app);

let admin: TestUser;
let owner: TestUser;
let manager: TestUser;
let staff: TestUser;
let customer: TestUser;
let stranger: TestUser;
let merchantId: string;
let productId: string;
let offerId: string;
let storeId: string;

const DZD = (dinars: number) => dinars * 100;
const ALGER_CENTRE = 'DZ-16-C-alger-centre';
const BAB_EL_OUED = 'DZ-16-C-bab-el-oued';
const ORAN = 'DZ-31-C-oran';
const base = () => `/v1/merchants/${merchantId}/shipping`;
const ok = async (res: Awaited<ReturnType<typeof call>>, status = 200) => {
  expect(res.statusCode, res.body).toBe(status);
  return res.json().data;
};

const methods = {} as Record<'merchant' | 'courier' | 'pickup' | 'prepaidOnly' | 'api', string>;
let algiersZone: string;
let babElOuedZone: string;

const options = async (localityId: string, quantity = 1) =>
  (await ok(await app.inject({ method: 'POST', url: '/v1/stores/mb-parfum/delivery-options', payload: { lines: [{ offerId, quantity }], country: 'DZ', localityId } }))).sellers[0]
    .options as any[];

const placeOrder = (methodId: string, opts: { localityId?: string; quantity?: number; paymentMethod?: string; pickupPointId?: string; address?: object } = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/stores/mb-parfum/orders',
    headers: { ...bearer(customer.token), 'idempotency-key': randomUUID() },
    payload: {
      lines: [{ offerId, quantity: opts.quantity ?? 1 }],
      paymentMethod: opts.paymentMethod ?? 'cash_on_delivery',
      shippingAddress: opts.address ?? dzAddress(opts.localityId ?? ALGER_CENTRE, { deliveryNotes: 'Sonner deux fois, 2e étage' }),
      delivery: [{ merchantId, methodId, ...(opts.pickupPointId ? { pickupPointId: opts.pickupPointId } : {}) }],
    },
  });
const order = async (methodId: string, opts: Parameters<typeof placeOrder>[1] = {}) => (await ok(await placeOrder(methodId, opts), 201)).orders[0];

const mUrl = (orderId: string) => `/v1/merchants/${merchantId}/orders/${orderId}`;
const move = (orderId: string, body: object, user = staff) => call('POST', `${mUrl(orderId)}/status`, user.token, body);
const parcel = (orderId: string, body: object = {}, user = staff) => call('POST', `${mUrl(orderId)}/shipment`, user.token, body);
const parcelStatus = (orderId: string, body: object, user = staff) => call('POST', `${mUrl(orderId)}/shipment/status`, user.token, body);
const dbOrder = async (id: string) => (await db.select().from(s.orders).where(eq(s.orders.id, id)))[0]!;
const available = async () => (await db.select().from(s.offers).where(eq(s.offers.id, offerId)))[0]!.availableQuantity;

beforeAll(async () => {
  await app.ready();
  [admin, owner, manager, staff, customer, stranger] = await Promise.all([registerUser(app), registerUser(app), registerUser(app), registerUser(app), registerUser(app), registerUser(app)]);
  await makeStaff(db, admin.userId, 'super_admin');
  const slug = uniqueSlug();
  merchantId = (
    await call('POST', '/v1/merchants', owner.token, {
      type: 'individual',
      slug,
      name: 'Shipping Test',
      country: 'DZ',
      activityCode: 'perfume_retail',
      contactPhone: `+2135${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      contactEmail: `${slug}@example.com`,
    })
  ).json().data.id;
  await verifyMerchantViaApi(app, owner, admin, merchantId);
  await call('PUT', `/v1/admin/stores/mb-parfum/merchants/${merchantId}`, admin.token, { commissionBps: null });
  await call('PUT', `/v1/merchants/${merchantId}/staff`, owner.token, { email: manager.email, role: 'manager' });
  await call('PUT', `/v1/merchants/${merchantId}/staff`, owner.token, { email: staff.email, role: 'staff' });
  const pslug = uniqueSlug('ship');
  productId = (
    await call('POST', `/v1/merchants/${merchantId}/products`, owner.token, {
      storeSlug: 'mb-parfum',
      slug: pslug,
      translations: [{ locale: 'ar', name: 'عنبر' }, { locale: 'fr', name: 'Ambre' }],
      variants: [{ sku: `${pslug}-50`, options: { sizeMl: 50 } }],
    })
  ).json().data.id;
  await call('PATCH', `/v1/merchants/${merchantId}/products/${productId}`, owner.token, { status: 'active' });
  const variantId = (await call('GET', `/v1/merchants/${merchantId}/products`, owner.token)).json().data.find((p: any) => p.id === productId).variants[0].id;
  offerId = (await call('PUT', `/v1/merchants/${merchantId}/offers`, owner.token, { variantId, stockQuantity: 100, prices: [{ currency: 'DZD', amountMinor: DZD(5_000) }] })).json().data.id;
  storeId = (await db.select().from(s.stores).where(eq(s.stores.slug, 'mb-parfum')))[0]!.id;
  // The fake courier with an API, as a real integration would be registered.
  await db.insert(s.couriers).values({ code: 'sandbox', name: 'Sandbox Courier', country: 'DZ', integration: 'api' }).onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(s.featureFlagOverrides).where(eq(s.featureFlagOverrides.storeId, storeId));
  await db.update(s.products).set({ status: 'archived' }).where(eq(s.products.id, productId));
  await db.update(s.storeMerchants).set({ status: 'archived' }).where(eq(s.storeMerchants.merchantId, merchantId));
  await app.close();
  await pool.end();
});

describe('Algerian addresses', () => {
  it('lists the 58 Wilayas, their Daïras and their Communes, in Arabic and French', async () => {
    const wilayas = await ok(await call('GET', '/v1/geo/DZ/areas'));
    expect(wilayas).toHaveLength(58);
    expect(wilayas.find((w: any) => w.code === '16')).toMatchObject({ id: 'DZ-16', level: 'region', names: { ar: 'الجزائر', fr: 'Alger' } });
    const dairas = await ok(await call('GET', '/v1/geo/DZ/areas?parentId=DZ-16'));
    expect(dairas.every((d: any) => d.level === 'district')).toBe(true);
    const sidiMhamed = dairas.find((d: any) => d.names.fr === "Sidi M'hamed");
    const communes = await ok(await call('GET', `/v1/geo/DZ/areas?parentId=${sidiMhamed.id}`));
    expect(communes.map((c: any) => c.id)).toContain(ALGER_CENTRE);
  });

  it('fills the Daïra and Wilaya from the Commune, and accepts local phone numbers', async () => {
    const o = await order(await merchantDeliveryMethod());
    expect(o.shippingAddress).toEqual({
      fullName: 'Yacine Meziane',
      phone: '+213661234567', // typed as 0661 23 45 67
      country: 'DZ',
      regionId: 'DZ-16',
      region: 'Alger',
      districtId: expect.stringMatching(/^DZ-16-D-/),
      district: "Sidi M'hamed",
      cityId: ALGER_CENTRE,
      city: 'Alger Centre',
      line1: '5 rue Larbi Ben M’hidi',
      deliveryNotes: 'Sonner deux fois, 2e étage',
    });
    await move(o.id, { to: 'cancelled', reason: 'test' }, owner);
  });

  it('refuses a missing or unknown Commune and a wrong phone number', async () => {
    const methodId = await merchantDeliveryMethod();
    const { localityId: _l, ...noCommune } = dzAddress();
    expect((await placeOrder(methodId, { address: noCommune })).json().error.code).toBe('LOCALITY_REQUIRED');
    expect((await placeOrder(methodId, { address: dzAddress('DZ-16-C-nowhere') })).json().error.code).toBe('UNKNOWN_LOCALITY');
    expect((await placeOrder(methodId, { address: dzAddress('DZ-16') })).json().error.code).toBe('UNKNOWN_LOCALITY'); // a Wilaya, not a Commune
    expect((await placeOrder(methodId, { address: dzAddress(ALGER_CENTRE, { phone: '0123 45 67' }) })).json().error.code).toBe('INVALID_PHONE');
  });
});

/** A merchant delivery method in the Algiers zone (created once). */
async function merchantDeliveryMethod() {
  if (!methods.merchant) await setUpDelivery();
  return methods.merchant;
}

async function setUpDelivery() {
  algiersZone = (await ok(await call('POST', `${base()}/zones`, manager.token, { name: 'Alger', country: 'DZ', areaIds: ['DZ-16'] }), 201)).id;
  babElOuedZone = (await ok(await call('POST', `${base()}/zones`, manager.token, { name: 'Bab El Oued', country: 'DZ', areaIds: [BAB_EL_OUED] }), 201)).id;
  methods.merchant = (await ok(await call('POST', `${base()}/methods`, manager.token, { type: 'merchant_delivery', name: 'Notre livreur' }), 201)).id;
  methods.courier = (await ok(await call('POST', `${base()}/methods`, manager.token, { type: 'courier', name: 'Yalidine domicile', courierCode: 'yalidine' }), 201)).id;
  methods.pickup = (
    await ok(
      await call('POST', `${base()}/methods`, manager.token, {
        type: 'local_pickup',
        name: 'Retrait boutique',
        pickupLocation: { areaId: ALGER_CENTRE, address: '3 rue Didouche Mourad, Alger Centre', hours: '10:00–19:00' },
      }),
      201,
    )
  ).id;
  methods.prepaidOnly = (await ok(await call('POST', `${base()}/methods`, manager.token, { type: 'merchant_delivery', name: 'Express payé en ligne', cashOnDelivery: false }), 201)).id;
  const rate = (methodId: string, body: object) => call('PUT', `${base()}/methods/${methodId}/rates`, manager.token, { currency: 'DZD', ...body });
  await ok(await rate(methods.merchant, { zoneId: algiersZone, priceMinor: DZD(300), minDays: 0, maxDays: 1 }));
  await ok(await rate(methods.merchant, { zoneId: babElOuedZone, priceMinor: DZD(350), minDays: 0, maxDays: 1 })); // more specific, even if dearer
  await ok(await rate(methods.courier, { zoneId: algiersZone, priceMinor: DZD(400), freeAboveMinor: DZD(15_000), minDays: 1, maxDays: 2 }));
  await ok(await rate(methods.courier, { zoneId: null, priceMinor: DZD(700), freeAboveMinor: DZD(15_000), minDays: 2, maxDays: 5 }));
  await ok(await rate(methods.pickup, { zoneId: null, priceMinor: 0, minDays: 0, maxDays: 0 }));
  await ok(await rate(methods.prepaidOnly, { zoneId: null, priceMinor: DZD(900) }));
}

describe('delivery settings', () => {
  it('lets owners and managers set zones, methods and prices; staff only read; other merchants nothing', async () => {
    await merchantDeliveryMethod();
    const settings = await ok(await call('GET', base(), staff.token));
    expect(settings.methods.map((m: any) => m.type).sort()).toEqual(['courier', 'local_pickup', 'merchant_delivery', 'merchant_delivery']);
    expect(settings.zones.find((z: any) => z.id === algiersZone).areas).toEqual([expect.objectContaining({ id: 'DZ-16', level: 'region' })]);
    expect(settings.couriers.map((c: any) => c.code)).toEqual(expect.arrayContaining(['yalidine', 'zr_express', 'maystro']));

    expect((await call('POST', `${base()}/methods`, staff.token, { type: 'merchant_delivery', name: 'X' })).statusCode).toBe(403);
    expect((await call('PUT', `${base()}/methods/${methods.merchant}/rates`, staff.token, { zoneId: null, currency: 'DZD', priceMinor: 0 })).statusCode).toBe(403);
    expect((await call('GET', base(), stranger.token)).statusCode).toBe(404);
  });

  it('checks what it is given', async () => {
    const post = (body: object) => call('POST', `${base()}/methods`, owner.token, body);
    expect((await post({ type: 'courier', name: 'Sans transporteur' })).json().error.code).toBe('COURIER_REQUIRED');
    expect((await post({ type: 'courier', name: 'Inconnu', courierCode: 'nope' })).json().error.code).toBe('UNKNOWN_COURIER');
    expect((await post({ type: 'local_pickup', name: 'Retrait' })).json().error.code).toBe('PICKUP_LOCATION_REQUIRED');
    const zone = await call('POST', `${base()}/zones`, owner.token, { name: 'Faux', country: 'DZ', areaIds: ['DZ-99'] });
    expect(zone.json().error).toMatchObject({ code: 'UNKNOWN_AREA', details: { areaIds: ['DZ-99'] } });
    const negative = await call('PUT', `${base()}/methods/${methods.merchant}/rates`, owner.token, { zoneId: null, currency: 'DZD', priceMinor: -1 });
    expect(negative.statusCode).toBe(400);
  });

  it('prices each address with the most specific zone, and applies free delivery above the threshold', async () => {
    const byName = (list: any[]) => Object.fromEntries(list.map((o) => [o.name, o]));
    const algiers = byName(await options(ALGER_CENTRE));
    expect(algiers['Notre livreur']).toMatchObject({ priceMinor: DZD(300), minDays: 0, maxDays: 1, cashOnDelivery: true });
    expect(algiers['Yalidine domicile']).toMatchObject({ priceMinor: DZD(400), courierName: 'Yalidine Express', free: false });
    expect(algiers['Retrait boutique']).toMatchObject({ priceMinor: 0, pickupLocation: { address: '3 rue Didouche Mourad, Alger Centre' } });

    expect(byName(await options(BAB_EL_OUED))['Notre livreur'].priceMinor).toBe(DZD(350)); // the Commune beats its Wilaya

    const oran = byName(await options(ORAN));
    expect(oran['Notre livreur']).toBeUndefined(); // the merchant does not deliver itself to Oran
    expect(oran['Yalidine domicile'].priceMinor).toBe(DZD(700)); // anywhere-in-Algeria price

    const bigCart = byName(await options(ORAN, 3)); // 15 000 DZD
    expect(bigCart['Yalidine domicile']).toMatchObject({ priceMinor: 0, free: true });
  });
});

describe('checkout with delivery', () => {
  it('charges the server price, and the ARUMA commission applies to the goods only', async () => {
    const o = await order(methods.courier);
    expect(o).toMatchObject({ subtotalMinor: DZD(5_000), shippingMinor: DZD(400), totalMinor: DZD(5_400) });
    expect(o.delivery).toMatchObject({ type: 'courier', courierCode: 'yalidine', courierName: 'Yalidine Express', minDays: 1, maxDays: 2 });
    // Changing the price later does not change the order.
    await ok(await call('PUT', `${base()}/methods/${methods.courier}/rates`, owner.token, { zoneId: algiersZone, currency: 'DZD', priceMinor: DZD(450), freeAboveMinor: DZD(15_000), minDays: 1, maxDays: 2 }));
    expect((await dbOrder(o.id)).shippingMinor).toBe(BigInt(DZD(400)));

    for (const to of ['processing', 'preparing']) await ok(await move(o.id, { to }));
    await ok(await move(o.id, { to: 'shipping', trackingNumber: 'YAL-123456' }));
    await ok(await move(o.id, { to: 'delivered' }));
    const [entry] = await db
      .select()
      .from(s.journalEntries)
      .where(and(eq(s.journalEntries.kind, 'order_delivered'), eq(s.journalEntries.sourceId, o.id)));
    // 8 % of 5 000 DZD of goods = 400 DZD; the 400 DZD of delivery goes to the merchant.
    expect(entry!.metadata).toMatchObject({ base: DZD(5_400), shipping: DZD(400), commissionable: DZD(5_000), commission: DZD(400), due: DZD(5_000) });
  });

  it('refuses a missing, unavailable or incompatible delivery choice', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stores/mb-parfum/orders',
      headers: { ...bearer(customer.token), 'idempotency-key': randomUUID() },
      payload: { lines: [{ offerId, quantity: 1 }], paymentMethod: 'cash_on_delivery', shippingAddress: dzAddress(), delivery: [{ merchantId: randomUUID(), methodId: methods.merchant }] },
    });
    expect(res.json().error).toMatchObject({ code: 'DELIVERY_METHOD_REQUIRED', details: { merchantIds: [merchantId] } });
    expect((await placeOrder(methods.merchant, { localityId: ORAN })).json().error.code).toBe('DELIVERY_UNAVAILABLE');
    expect((await placeOrder(methods.prepaidOnly)).json().error.code).toBe('CASH_ON_DELIVERY_UNAVAILABLE');
    expect((await placeOrder(randomUUID())).json().error.code).toBe('DELIVERY_UNAVAILABLE');
  });
});

describe('parcels and tracking', () => {
  it('follows a courier parcel: tracking number, statuses, and the order kept in step', async () => {
    const o = await order(methods.courier, { localityId: ORAN });
    expect((await parcel(o.id)).json().error.code).toBe('ORDER_NOT_READY_TO_SHIP'); // not confirmed yet
    await ok(await move(o.id, { to: 'processing' }));
    const before = await available();

    const prepared = await ok(await parcel(o.id), 201);
    expect(prepared.status).toBe('preparing'); // creating the parcel means packing
    expect(prepared.shipment).toMatchObject({ status: 'pending', courierCode: 'yalidine', trackingNumber: null, codAmountMinor: DZD(5_700) });
    expect((await parcel(o.id)).json().error.code).toBe('SHIPMENT_EXISTS');

    expect((await parcelStatus(o.id, { status: 'in_transit' })).json().error.code).toBe('TRACKING_NUMBER_REQUIRED');
    const sent = await ok(await parcelStatus(o.id, { status: 'in_transit', trackingNumber: 'YAL-777001', location: 'Hub Alger' }));
    expect(sent).toMatchObject({ status: 'shipping', shipment: { status: 'in_transit', trackingNumber: 'YAL-777001' } });
    expect(await available()).toBe(before); // stock leaves the warehouse (reserved → consumed), availability unchanged

    await ok(await parcelStatus(o.id, { status: 'out_for_delivery', location: 'Oran' }));
    await ok(await parcelStatus(o.id, { status: 'delivery_failed', reason: 'customer_unreachable', note: 'Client injoignable' }));
    expect((await dbOrder(o.id)).status).toBe('shipping');
    await ok(await parcelStatus(o.id, { status: 'out_for_delivery' }));
    const done = await ok(await parcelStatus(o.id, { status: 'delivered' }));
    expect(done).toMatchObject({ status: 'delivered', paymentStatus: 'successful', shipment: { status: 'delivered' } });
    expect(done.history.map((h: any) => h.toStatus)).toEqual(['new', 'processing', 'preparing', 'shipping', 'delivered']);
    expect(done.shipment.events.map((e: any) => e.status)).toEqual(['pending', 'in_transit', 'out_for_delivery', 'delivery_failed', 'out_for_delivery', 'delivered']);

    expect((await parcelStatus(o.id, { status: 'in_transit' })).json().error.code).toBe('INVALID_SHIPMENT_TRANSITION');

    // The customer sees the tracking, not who did what inside the merchant.
    const mine = await ok(await call('GET', `/v1/me/orders/${o.id}`, customer.token));
    expect(mine.shipment).toMatchObject({ status: 'delivered', trackingNumber: 'YAL-777001', courierName: 'Yalidine Express' });
    expect(mine.shipment.events[1]).toEqual({ status: 'in_transit', description: null, location: 'Hub Alger', occurredAt: expect.any(String) });
    expect(mine.shipment.destination).toBeUndefined();
    expect(mine.shipment.events[1].actorName).toBeUndefined();
  });

  it('opens the parcel when the merchant moves the order directly, and closes it on delivery', async () => {
    const own = await order(methods.merchant);
    for (const to of ['processing', 'preparing', 'shipping']) await ok(await move(own.id, { to }));
    expect((await ok(await call('GET', mUrl(own.id), staff.token))).shipment).toMatchObject({ status: 'out_for_delivery', methodType: 'merchant_delivery' });
    expect((await ok(await move(own.id, { to: 'delivered' }))).shipment.status).toBe('delivered');

    const courier = await order(methods.courier);
    for (const to of ['processing', 'preparing']) await ok(await move(courier.id, { to }));
    expect((await move(courier.id, { to: 'shipping' })).json().error.code).toBe('TRACKING_NUMBER_REQUIRED');
    expect((await dbOrder(courier.id)).status).toBe('preparing'); // nothing changed
    expect((await move(courier.id, { to: 'shipping', trackingNumber: 'YAL-777001' })).json().error.code).toBe('TRACKING_NUMBER_IN_USE'); // another parcel's
    expect((await ok(await move(courier.id, { to: 'shipping', trackingNumber: 'YAL-777002' }))).shipment).toMatchObject({ status: 'in_transit', trackingNumber: 'YAL-777002' });
  });

  it('local pickup: ready for pickup, then collected', async () => {
    const o = await order(methods.pickup);
    expect(o.shippingMinor).toBe(0);
    await ok(await move(o.id, { to: 'processing' }));
    await ok(await parcel(o.id), 201);
    expect((await ok(await parcelStatus(o.id, { status: 'ready_for_pickup' }))).status).toBe('shipping');
    expect((await ok(await parcelStatus(o.id, { status: 'delivered', note: 'Retiré en boutique' }))).status).toBe('delivered');
  });

  it('a parcel coming back waits for the merchant to confirm the return; cancelling withdraws a parcel not sent', async () => {
    const back = await order(methods.merchant);
    for (const to of ['processing', 'preparing', 'shipping']) await ok(await move(back.id, { to }));
    await ok(await parcelStatus(back.id, { status: 'returning', note: 'Refusé par le client' }));
    expect((await ok(await parcelStatus(back.id, { status: 'returned' }))).status).toBe('shipping');
    const returned = await ok(await move(back.id, { to: 'returned', reason: 'Refusé à la livraison', restock: true }, owner));
    expect(returned).toMatchObject({ status: 'returned', shipment: { status: 'returned' } });

    const cancel = await order(methods.merchant);
    await ok(await move(cancel.id, { to: 'processing' }));
    await ok(await parcel(cancel.id), 201);
    expect((await ok(await move(cancel.id, { to: 'cancelled', reason: 'Rupture' }, owner))).shipment.status).toBe('cancelled');
  });

  it('keeps the tracking history and parcels at the database level', async () => {
    const [event] = await db.select().from(s.shipmentEvents).limit(1);
    await expect(db.execute(sql`update shipment_events set location = 'x' where id = ${event!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from shipment_events where id = ${event!.id}`)).rejects.toThrow();
    const [delivered] = await db.select().from(s.shipments).where(eq(s.shipments.status, 'delivered')).limit(1);
    await expect(db.execute(sql`delete from shipments where id = ${delivered!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update shipments set status = 'in_transit' where id = ${delivered!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update shipments set cod_amount_minor = 1 where id = ${delivered!.id}`)).rejects.toThrow();
  });
});

describe('courier API integration (sandbox courier)', () => {
  let accountId: string;
  const credentials = { apiKey: 'sbx-key', webhookSecret: 'sbx-webhook-secret-123' };
  const webhook = (events: object[], secret = credentials.webhookSecret) => {
    const body = JSON.stringify({ events });
    return app.inject({
      method: 'POST',
      url: `/webhooks/couriers/${accountId}`,
      payload: body,
      headers: { 'content-type': 'application/json', 'x-sandbox-signature': sandboxSignature(secret, body) },
    });
  };

  it('stores the courier credentials encrypted, for owners only, and only for couriers with an API', async () => {
    const connect = (user: TestUser, body: object) => call('POST', `${base()}/courier-accounts`, user.token, body);
    expect((await connect(manager, { courierCode: 'sandbox', label: 'Mon compte', credentials })).statusCode).toBe(403);
    expect((await connect(owner, { courierCode: 'yalidine', label: 'Yalidine', credentials: { a: 'b' } })).json().error.code).toBe('COURIER_HAS_NO_API');
    expect((await connect(owner, { courierCode: 'sandbox', label: 'Incomplet', credentials: { apiKey: 'x' } })).json().error).toMatchObject({
      code: 'CREDENTIALS_REQUIRED',
      details: { fields: ['webhookSecret'] },
    });
    const account = await ok(await connect(owner, { courierCode: 'sandbox', label: 'Mon compte sandbox', credentials }), 201);
    accountId = account.id;
    expect(JSON.stringify(account)).not.toContain('sbx-key');
    const [row] = await db.select().from(s.courierAccounts).where(eq(s.courierAccounts.id, accountId));
    expect(row!.credentialsEncrypted).not.toContain('sbx-key');
    expect(JSON.stringify(await ok(await call('GET', base(), owner.token)))).not.toContain('sbx-key');

    methods.api = (await ok(await call('POST', `${base()}/methods`, owner.token, { type: 'courier', name: 'Sandbox express', courierCode: 'sandbox', courierAccountId: accountId }), 201)).id;
    await ok(await call('PUT', `${base()}/methods/${methods.api}/rates`, owner.token, { zoneId: null, currency: 'DZD', priceMinor: DZD(500) }));
  });

  it('registers the parcel with the courier and follows its signed webhooks', async () => {
    const o = await order(methods.api, { localityId: ORAN });
    await ok(await move(o.id, { to: 'processing' }));
    const shipment = (await ok(await parcel(o.id), 201)).shipment;
    expect(shipment).toMatchObject({ status: 'pending', trackedByCourier: true, trackingNumber: expect.stringMatching(/^SBX\d{10}$/) });
    const sent = app.sandboxCourier.parcels.get(shipment.trackingNumber) as any;
    expect(sent).toMatchObject({ reference: o.number, codAmountMinor: DZD(5_500), destination: { type: 'address', address: { city: 'Oran', region: 'Oran', deliveryNotes: 'Sonner deux fois, 2e étage' } } });

    expect((await parcelStatus(o.id, { status: 'in_transit' })).json().error.code).toBe('SHIPMENT_TRACKED_BY_COURIER');
    expect((await move(o.id, { to: 'shipping' })).json().error.code).toBe('SHIPMENT_TRACKED_BY_COURIER');

    const pickedUp = { id: 'evt-1', tracking: shipment.trackingNumber, status: 'picked_up', at: new Date().toISOString(), location: 'Alger' };
    expect((await webhook([pickedUp], 'wrong-secret')).statusCode).toBe(401);
    expect((await ok(await webhook([pickedUp]))).applied).toBe(1);
    expect((await ok(await webhook([pickedUp]))).applied).toBe(0); // delivered twice, recorded once
    expect((await dbOrder(o.id)).status).toBe('shipping');

    const later = new Date(Date.now() + 60_000).toISOString();
    await ok(await webhook([{ id: 'evt-2', tracking: shipment.trackingNumber, status: 'delivered', at: later }]));
    // A late "at hub" report after delivery is kept in the history but does not move the parcel back.
    await ok(await webhook([{ id: 'evt-3', tracking: shipment.trackingNumber, status: 'at_hub', at: later }]));
    const done = await ok(await call('GET', mUrl(o.id), owner.token));
    expect(done).toMatchObject({ status: 'delivered', paymentStatus: 'successful', shipment: { status: 'delivered' } });
    expect(done.shipment.events.filter((e: any) => e.source === 'courier')).toHaveLength(3);
    expect(done.history.at(-1)).toMatchObject({ toStatus: 'delivered', actorType: 'system' });
  });

  it('withdraws the parcel from the courier when the order is cancelled before it leaves', async () => {
    const o = await order(methods.api);
    await ok(await move(o.id, { to: 'processing' }));
    const tracking = (await ok(await parcel(o.id), 201)).shipment.trackingNumber;
    expect(app.sandboxCourier.parcels.has(tracking)).toBe(true);
    await ok(await move(o.id, { to: 'cancelled', reason: 'Client a annulé' }, owner));
    expect(app.sandboxCourier.parcels.has(tracking)).toBe(false);
  });
});

describe('pickup points (prepared, behind a feature flag)', () => {
  it('lets customers choose a courier desk in their Wilaya once switched on', async () => {
    const created = await ok(
      await call('POST', '/v1/admin/pickup-points', admin.token, { courierCode: 'yalidine', areaId: 'DZ-16-C-hydra', name: 'Bureau Yalidine Hydra', address: '10 chemin Doudou Mokhtar, Hydra' }),
      201,
    );
    const far = await ok(await call('POST', '/v1/admin/pickup-points', admin.token, { courierCode: 'yalidine', areaId: ORAN, name: 'Bureau Yalidine Oran', address: '1 boulevard de la Soummam, Oran' }), 201);
    expect((await call('POST', '/v1/admin/pickup-points', owner.token, { areaId: ORAN, name: 'X', address: 'Nulle part 1' })).statusCode).toBe(403);
    expect((await ok(await call('GET', '/v1/pickup-points?regionId=DZ-16&courierCode=yalidine'))).map((p: any) => p.id)).toEqual([created.id]);

    const desk = (await ok(await call('POST', `${base()}/methods`, owner.token, { type: 'pickup_point', name: 'Yalidine Stop Desk', courierCode: 'yalidine' }), 201)).id;
    await ok(await call('PUT', `${base()}/methods/${desk}/rates`, owner.token, { zoneId: null, currency: 'DZD', priceMinor: DZD(250) }));
    expect((await options(ALGER_CENTRE)).some((o) => o.methodId === desk)).toBe(false);
    expect((await placeOrder(desk, { pickupPointId: created.id })).json().error.code).toBe('DELIVERY_UNAVAILABLE');

    await db.insert(s.featureFlagOverrides).values({ flagKey: 'shipping.pickup_points', storeId, enabled: true });
    expect((await placeOrder(desk)).json().error.code).toBe('PICKUP_POINT_REQUIRED');
    expect((await placeOrder(desk, { pickupPointId: far.id })).json().error.code).toBe('PICKUP_POINT_TOO_FAR');
    const o = await order(desk, { pickupPointId: created.id });
    expect(o).toMatchObject({ shippingMinor: DZD(250), delivery: { type: 'pickup_point', pickupPoint: { id: created.id, name: 'Bureau Yalidine Hydra' } } });
    await ok(await move(o.id, { to: 'processing' }));
    await ok(await parcel(o.id, { trackingNumber: 'YAL-DESK-1' }), 201);
    expect((await ok(await parcelStatus(o.id, { status: 'ready_for_pickup' }))).shipment).toMatchObject({
      status: 'ready_for_pickup',
      destination: { type: 'pickup_point', address: { name: 'Bureau Yalidine Hydra' } },
    });
  });
});

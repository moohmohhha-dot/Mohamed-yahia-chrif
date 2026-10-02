import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, requireAuth, requireRole } from '../identity/index.js';
import { verifyPaymentEvent } from '../payments/index.js';
import { placeOrders, previewDelivery } from './checkout.js';
import { createOrderShipment, handleCourierWebhook, updateOrderShipment } from './fulfillment.js';
import { getCheckoutPayment, handlePaymentEvent, refundOrder, retryCheckoutPayment, startCheckoutPayment } from './payments.js';
import { getOrder, listAllOrders, listCustomerOrders, listMerchantOrders, transitionOrder, type OrderActor } from './service.js';

const statuses = ['new', 'processing', 'preparing', 'shipping', 'delivered', 'cancelled', 'returned', 'refunded'] as const;
const orderParams = z.object({ orderId: z.uuid() });
const merchantParams = z.object({ merchantId: z.uuid() });
const listQuery = z.object({
  status: z.enum(statuses).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
const transitionBody = z.object({
  to: z.enum(statuses),
  reason: z.string().trim().max(500).optional(),
  note: z.string().trim().max(1000).optional(),
  restock: z.boolean().optional(),
  /** Courier orders: the tracking number, if no parcel was created before. */
  trackingNumber: z.string().trim().min(3).max(64).optional(),
});
const shipmentStatuses = ['pending', 'ready_for_pickup', 'in_transit', 'out_for_delivery', 'delivery_failed', 'delivered', 'returning', 'returned', 'cancelled'] as const;
const shipmentStatusBody = z.object({
  status: z.enum(shipmentStatuses),
  trackingNumber: z.string().trim().min(3).max(64).optional(),
  note: z.string().trim().max(500).optional(),
  location: z.string().trim().max(200).optional(),
});
const lineList = z
  .array(z.object({ offerId: z.uuid(), quantity: z.number().int().min(1).max(100) }))
  .min(1)
  .max(50);
/** Algerian address: Commune (which gives the Daïra and Wilaya), address, phone, delivery notes. */
const addressBody = z.object({
  fullName: z.string().trim().min(2).max(120),
  /** International (+213555123456) or, in Algeria, local format (0555 12 34 56). */
  phone: z.string().trim().min(6).max(24),
  country: z.string().length(2).toUpperCase(),
  /** Commune id from GET /v1/geo/DZ/areas (required in Algeria). */
  localityId: z.string().min(2).max(96).optional(),
  /** Only for countries without area data. */
  city: z.string().trim().min(1).max(100).optional(),
  region: z.string().trim().min(1).max(100).optional(),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional(),
  postalCode: z.string().trim().max(16).optional(),
  deliveryNotes: z.string().trim().max(500).optional(),
});
const checkoutBody = z.object({
  lines: lineList,
  currency: z.string().length(3).toUpperCase().optional(),
  paymentMethod: z.enum(['cash_on_delivery', 'online']),
  /** Online only: the card network (CIB or EDAHABIA); the provider's page may also let the customer choose. */
  onlinePaymentMethod: z.enum(['edahabia', 'cib']).optional(),
  locale: z.enum(['ar', 'fr', 'en']).optional(),
  shippingAddress: addressBody,
  /** How each seller in the cart delivers (see POST /v1/stores/:storeSlug/delivery-options). */
  delivery: z
    .array(z.object({ merchantId: z.uuid(), methodId: z.uuid(), pickupPointId: z.uuid().optional() }))
    .min(1)
    .max(50),
  customerNote: z.string().trim().max(1000).optional(),
});

export async function orderRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
  const deps = () => ({ payments: app.payments, couriers: app.couriers, secrets: app.secrets });
  // Customers always come back to the storefront (never to a URL taken from the request).
  const returnUrl = (checkoutId: string) => `${app.storefrontUrl}/checkout/${checkoutId}`;
  const as = (req: FastifyRequest, type: OrderActor['type'], merchantId?: string): OrderActor => ({
    ...actorFrom(req),
    userId: authOf(req).userId,
    type,
    merchantId,
  });

  // --- Customer -----------------------------------------------------------------------------------

  /** Requires an Idempotency-Key header (any unique string per checkout attempt, e.g. a UUID). */
  app.post('/v1/stores/:storeSlug/orders', auth, async (req, reply) => {
    const { storeSlug } = z.object({ storeSlug: z.string().max(64) }).parse(req.params);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
      throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key header (8-128 letters, digits, - or _)');
    }
    const body = checkoutBody.parse(req.body);
    const result = await placeOrders(app.db, { userId: authOf(req).userId, ip: req.ip ?? null }, storeSlug, key, body);
    let payment: Record<string, unknown> | null = null;
    if (body.paymentMethod === 'online') {
      // Start (or, on a retried request, fetch) the payment. If the Payment Service is down, the orders
      // exist and the customer can start the payment again from the retry endpoint.
      payment = await startCheckoutPayment(app.db, app.payments, result.checkoutId, {
        returnUrl: returnUrl(result.checkoutId),
        locale: body.locale,
        paymentMethod: body.onlinePaymentMethod,
      })
        .then((i) => ({ intentId: i.id, status: i.status, redirectUrl: i.redirectUrl, amountMinor: i.amountMinor, currency: i.currency }))
        .catch((e) => {
          if (e.code === 'PAYMENTS_UNAVAILABLE') return { intentId: null, status: 'unavailable', redirectUrl: null, retryable: true };
          throw e;
        });
    }
    const orders = await Promise.all(result.orderIds.map((id) => getOrder(app.db, as(req, 'customer'), id)));
    return reply.status(result.replayed ? 200 : 201).send({ data: { checkoutId: result.checkoutId, orders, payment } });
  });

  /** Before checkout: for each seller of the cart, the ways it delivers to this Commune and their price. */
  app.post('/v1/stores/:storeSlug/delivery-options', async (req) => {
    const { storeSlug } = z.object({ storeSlug: z.string().max(64) }).parse(req.params);
    const body = z
      .object({ lines: lineList, currency: z.string().length(3).toUpperCase().optional(), country: z.string().length(2).toUpperCase(), localityId: z.string().min(2).max(96).optional() })
      .parse(req.body);
    return { data: await previewDelivery(app.db, storeSlug, body) };
  });

  app.get('/v1/me/checkouts/:checkoutId/payment', auth, async (req) => {
    const { checkoutId } = z.object({ checkoutId: z.uuid() }).parse(req.params);
    const { verify } = z.object({ verify: z.enum(['true', 'false']).default('false') }).parse(req.query);
    return { data: await getCheckoutPayment(app.db, app.payments, authOf(req).userId, checkoutId, verify === 'true') };
  });

  app.post('/v1/me/checkouts/:checkoutId/payment/retry', auth, async (req) => {
    const { checkoutId } = z.object({ checkoutId: z.uuid() }).parse(req.params);
    const body = z.object({ onlinePaymentMethod: z.enum(['edahabia', 'cib']).optional(), locale: z.enum(['ar', 'fr', 'en']).optional() }).parse(req.body ?? {});
    return {
      data: await retryCheckoutPayment(app.db, app.payments, authOf(req).userId, checkoutId, {
        returnUrl: returnUrl(checkoutId),
        locale: body.locale,
        paymentMethod: body.onlinePaymentMethod,
      }),
    };
  });

  app.get('/v1/me/orders', auth, async (req) => ({
    data: await listCustomerOrders(app.db, authOf(req).userId, listQuery.parse(req.query)),
  }));

  app.get('/v1/me/orders/:orderId', auth, async (req) => {
    const { orderId } = orderParams.parse(req.params);
    return { data: await getOrder(app.db, as(req, 'customer'), orderId) };
  });

  app.post('/v1/me/orders/:orderId/cancel', auth, async (req) => {
    const { orderId } = orderParams.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    await transitionOrder(app.db, deps(), as(req, 'customer'), orderId, { to: 'cancelled', reason });
    return { data: await getOrder(app.db, as(req, 'customer'), orderId) };
  });

  // --- Merchant -----------------------------------------------------------------------------------

  app.get('/v1/merchants/:merchantId/orders', auth, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    return { data: await listMerchantOrders(app.db, authOf(req).userId, merchantId, listQuery.parse(req.query)) };
  });

  app.get('/v1/merchants/:merchantId/orders/:orderId', auth, async (req) => {
    const { merchantId, orderId } = merchantParams.extend({ orderId: z.uuid() }).parse(req.params);
    return { data: await getOrder(app.db, as(req, 'merchant', merchantId), orderId) };
  });

  app.post('/v1/merchants/:merchantId/orders/:orderId/status', auth, async (req) => {
    const { merchantId, orderId } = merchantParams.extend({ orderId: z.uuid() }).parse(req.params);
    const actor = as(req, 'merchant', merchantId);
    await transitionOrder(app.db, deps(), actor, orderId, transitionBody.parse(req.body));
    return { data: await getOrder(app.db, actor, orderId) };
  });

  /** Prepares the parcel (and registers it with the courier when the merchant has a courier API account). */
  app.post('/v1/merchants/:merchantId/orders/:orderId/shipment', auth, async (req, reply) => {
    const { merchantId, orderId } = merchantParams.extend({ orderId: z.uuid() }).parse(req.params);
    const body = z.object({ trackingNumber: z.string().trim().min(3).max(64).optional() }).parse(req.body ?? {});
    const actor = as(req, 'merchant', merchantId);
    await createOrderShipment(app.db, deps(), actor, orderId, body);
    return reply.status(201).send({ data: await getOrder(app.db, actor, orderId) });
  });

  app.post('/v1/merchants/:merchantId/orders/:orderId/shipment/status', auth, async (req) => {
    const { merchantId, orderId } = merchantParams.extend({ orderId: z.uuid() }).parse(req.params);
    const actor = as(req, 'merchant', merchantId);
    await updateOrderShipment(app.db, deps(), actor, orderId, shipmentStatusBody.parse(req.body));
    return { data: await getOrder(app.db, actor, orderId) };
  });

  // --- Platform -----------------------------------------------------------------------------------

  const staff = { preHandler: requireRole('admin', 'support') };

  app.get('/v1/admin/orders', staff, async (req) => {
    const filter = listQuery.extend({ merchantId: z.uuid().optional() }).parse(req.query);
    return { data: await listAllOrders(app.db, filter) };
  });

  app.get('/v1/admin/orders/:orderId', staff, async (req) => {
    const { orderId } = orderParams.parse(req.params);
    return { data: await getOrder(app.db, as(req, 'platform'), orderId) };
  });

  /** Refunds are for admins only (money); support staff handle the rest of the flow. */
  app.post('/v1/admin/orders/:orderId/status', staff, async (req) => {
    const { orderId } = orderParams.parse(req.params);
    const body = transitionBody.parse(req.body);
    const actor = as(req, 'platform');
    await transitionOrder(app.db, deps(), actor, orderId, body);
    return { data: await getOrder(app.db, actor, orderId) };
  });

  /** Support can correct a parcel's status, including one tracked by a courier API (e.g. when the courier is down). */
  app.post('/v1/admin/orders/:orderId/shipment/status', staff, async (req) => {
    const { orderId } = orderParams.parse(req.params);
    const actor = as(req, 'platform');
    const body = shipmentStatusBody.extend({ note: z.string().trim().min(3).max(500) }).parse(req.body);
    await updateOrderShipment(app.db, deps(), actor, orderId, body);
    return { data: await getOrder(app.db, actor, orderId) };
  });

  /** Refund or Partial Refund: administrators only, with an Idempotency-Key. */
  app.post('/v1/admin/orders/:orderId/refunds', { preHandler: requireRole('admin') }, async (req) => {
    const { orderId } = orderParams.parse(req.params);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header');
    const body = z
      .object({
        amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        reason: z.string().trim().min(3).max(500),
        /** Proof of a refund made outside ARUMA (cash, CCP / bank transfer), when the provider cannot refund by API. */
        externalReference: z.string().trim().min(1).max(128).optional(),
      })
      .parse(req.body);
    const actor = as(req, 'platform');
    await refundOrder(app.db, deps(), { ...actor, userId: authOf(req).userId }, orderId, key, body);
    return { data: await getOrder(app.db, actor, orderId) };
  });

  // --- Payment Service events (signed; not for browsers) ----------------------------------------------
  app.register(async (internal) => {
    internal.removeAllContentTypeParsers();
    internal.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));
    internal.post('/internal/payments/events', async (req, reply) => {
      const raw = String(req.body ?? '');
      if (!verifyPaymentEvent(app.paymentEventsSecret, raw, req.headers['x-aruma-timestamp'], req.headers['x-aruma-signature'])) {
        return reply.status(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid event signature' } });
      }
      const event = JSON.parse(raw);
      const handled = await handlePaymentEvent(app.db, deps(), event);
      return { data: { handled } };
    });

    /** Tracking updates pushed by a courier, one URL per courier account (given to the courier when connecting). */
    internal.post('/webhooks/couriers/:accountId', async (req) => {
      const { accountId } = z.object({ accountId: z.uuid() }).parse(req.params);
      return { data: await handleCourierWebhook(app.db, deps(), accountId, String(req.body ?? ''), req.headers) };
    });
  });
}

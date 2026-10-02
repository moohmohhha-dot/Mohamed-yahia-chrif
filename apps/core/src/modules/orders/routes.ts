import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, requireAuth, requireRole } from '../identity/index.js';
import { placeOrders } from './checkout.js';
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
});
const checkoutBody = z.object({
  lines: z
    .array(z.object({ offerId: z.uuid(), quantity: z.number().int().min(1).max(100) }))
    .min(1)
    .max(50),
  currency: z.string().length(3).toUpperCase().optional(),
  paymentMethod: z.literal('cash_on_delivery'),
  shippingAddress: z.object({
    fullName: z.string().trim().min(2).max(120),
    phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164 format, e.g. +213555000000'),
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().max(16).optional(),
    country: z.string().length(2).toUpperCase(),
  }),
  customerNote: z.string().trim().max(1000).optional(),
});

export async function orderRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
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
    const result = await placeOrders(app.db, { userId: authOf(req).userId, ip: req.ip ?? null }, storeSlug, key, checkoutBody.parse(req.body));
    const orders = await Promise.all(result.orderIds.map((id) => getOrder(app.db, as(req, 'customer'), id)));
    return reply.status(result.replayed ? 200 : 201).send({ data: { checkoutId: result.checkoutId, orders } });
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
    await transitionOrder(app.db, as(req, 'customer'), orderId, { to: 'cancelled', reason });
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
    await transitionOrder(app.db, actor, orderId, transitionBody.parse(req.body));
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
    if (body.to === 'refunded' && authOf(req).role !== 'admin') throw badRequest('ADMIN_ONLY', 'Only administrators can refund');
    const actor = as(req, 'platform');
    await transitionOrder(app.db, actor, orderId, body);
    return { data: await getOrder(app.db, actor, orderId) };
  });
}

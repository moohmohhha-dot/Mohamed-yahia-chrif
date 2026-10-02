import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@aruma/db';
import { notFound } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, requireAuth, requireRole } from '../identity/index.js';
import { requireMembership, type MerchantRole } from '../merchants/index.js';
import { audit } from '../platform/index.js';
import { listAreas } from './geo.js';
import {
  archiveZone,
  connectCourierAccount,
  deactivateCourierAccount,
  deleteRate,
  saveMethod,
  saveRate,
  saveZone,
  shippingSettings,
} from './settings.js';

const merchantParams = z.object({ merchantId: z.uuid() });
const country = z.string().length(2).toUpperCase();
const areaId = z.string().min(2).max(96);
const name = z.string().trim().min(2).max(120);
const amount = z.number().int().min(0).max(100_000_000_00);

const zoneBody = z.object({ name, country, areaIds: z.array(areaId).min(1).max(2000) });
const methodBody = z.object({
  type: z.enum(['merchant_delivery', 'courier', 'local_pickup', 'pickup_point']),
  name,
  courierCode: z.string().max(32).nullish(),
  courierAccountId: z.uuid().nullish(),
  pickupLocation: z
    .object({ areaId: areaId.optional(), address: z.string().trim().min(5).max(300), hours: z.string().trim().max(200).optional(), phone: z.string().trim().max(20).optional() })
    .nullish(),
  cashOnDelivery: z.boolean().default(true),
  active: z.boolean().default(true),
});
const rateBody = z.object({
  zoneId: z.uuid().nullable(),
  currency: z.string().length(3).toUpperCase(),
  priceMinor: amount,
  freeAboveMinor: amount.nullable().default(null),
  minDays: z.number().int().min(0).max(60).default(1),
  maxDays: z.number().int().min(0).max(90).default(3),
});

/** Areas, couriers and pickup points (public); merchants' delivery settings; courier and relay-point management (platform). */
export async function shippingRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
  const admin = { preHandler: requireRole('admin') };
  const actor = (req: FastifyRequest) => ({ ...actorFrom(req), userId: authOf(req).userId });
  /** Delivery settings decide prices: owners and managers only. Courier credentials: owners only. */
  const asMember = async (req: FastifyRequest, roles: MerchantRole[] = ['owner', 'manager']) => {
    const { merchantId } = merchantParams.parse(req.params);
    await requireMembership(app.db, merchantId, authOf(req).userId, roles);
    return merchantId;
  };

  // --- Public ------------------------------------------------------------------------------------------

  /** Wilayas (no parentId), then the Daïras of a Wilaya, then the Communes of a Daïra. */
  app.get('/v1/geo/:country/areas', async (req) => {
    const params = z.object({ country }).parse(req.params);
    const { parentId } = z.object({ parentId: areaId.optional() }).parse(req.query);
    return { data: await listAreas(app.db, params.country, parentId ?? null) };
  });

  app.get('/v1/couriers', async (req) => {
    const q = z.object({ country: country.default('DZ') }).parse(req.query);
    const rows = await app.db
      .select({ code: s.couriers.code, name: s.couriers.name, integration: s.couriers.integration })
      .from(s.couriers)
      .where(and(eq(s.couriers.country, q.country), eq(s.couriers.active, true)))
      .orderBy(asc(s.couriers.name));
    return { data: rows };
  });

  /** Active pickup points of a Wilaya (optionally of one courier). */
  app.get('/v1/pickup-points', async (req) => {
    const q = z.object({ regionId: areaId, courierCode: z.string().max(32).optional() }).parse(req.query);
    const districts = await app.db.select({ id: s.geoAreas.id }).from(s.geoAreas).where(eq(s.geoAreas.parentId, q.regionId));
    const parents = [q.regionId, ...districts.map((d) => d.id)];
    const communes = await app.db.select({ id: s.geoAreas.id }).from(s.geoAreas).where(inArray(s.geoAreas.parentId, parents));
    const where = [eq(s.pickupPoints.active, true), inArray(s.pickupPoints.areaId, [...parents, ...communes.map((c) => c.id)])];
    if (q.courierCode) where.push(eq(s.pickupPoints.courierCode, q.courierCode));
    const rows = await app.db
      .select({
        id: s.pickupPoints.id,
        courierCode: s.pickupPoints.courierCode,
        areaId: s.pickupPoints.areaId,
        name: s.pickupPoints.name,
        address: s.pickupPoints.address,
        phone: s.pickupPoints.phone,
        hours: s.pickupPoints.hours,
      })
      .from(s.pickupPoints)
      .where(and(...where))
      .orderBy(asc(s.pickupPoints.name));
    return { data: rows };
  });

  // --- Merchant ----------------------------------------------------------------------------------------

  app.get('/v1/merchants/:merchantId/shipping', auth, async (req) => {
    const merchantId = await asMember(req, ['owner', 'manager', 'staff']);
    return { data: await shippingSettings(app.db, merchantId) };
  });

  app.post('/v1/merchants/:merchantId/shipping/zones', auth, async (req, reply) => {
    const merchantId = await asMember(req);
    const id = await saveZone(app.db, actor(req), merchantId, null, zoneBody.parse(req.body));
    return reply.status(201).send({ data: { id } });
  });

  app.put('/v1/merchants/:merchantId/shipping/zones/:zoneId', auth, async (req) => {
    const merchantId = await asMember(req);
    const { zoneId } = z.object({ zoneId: z.uuid() }).parse(req.params);
    return { data: { id: await saveZone(app.db, actor(req), merchantId, zoneId, zoneBody.parse(req.body)) } };
  });

  app.delete('/v1/merchants/:merchantId/shipping/zones/:zoneId', auth, async (req) => {
    const merchantId = await asMember(req);
    const { zoneId } = z.object({ zoneId: z.uuid() }).parse(req.params);
    await archiveZone(app.db, actor(req), merchantId, zoneId);
    return { data: { archived: true } };
  });

  app.post('/v1/merchants/:merchantId/shipping/methods', auth, async (req, reply) => {
    const merchantId = await asMember(req);
    const id = await saveMethod(app.db, actor(req), merchantId, null, methodBody.parse(req.body));
    return reply.status(201).send({ data: { id } });
  });

  app.put('/v1/merchants/:merchantId/shipping/methods/:methodId', auth, async (req) => {
    const merchantId = await asMember(req);
    const { methodId } = z.object({ methodId: z.uuid() }).parse(req.params);
    return { data: { id: await saveMethod(app.db, actor(req), merchantId, methodId, methodBody.parse(req.body)) } };
  });

  /** Creates or replaces the price of a method for a zone (zoneId null = anywhere in the merchant's country). */
  app.put('/v1/merchants/:merchantId/shipping/methods/:methodId/rates', auth, async (req) => {
    const merchantId = await asMember(req);
    const { methodId } = z.object({ methodId: z.uuid() }).parse(req.params);
    return { data: await saveRate(app.db, actor(req), merchantId, methodId, rateBody.parse(req.body)) };
  });

  app.delete('/v1/merchants/:merchantId/shipping/methods/:methodId/rates/:rateId', auth, async (req) => {
    const merchantId = await asMember(req);
    const { methodId, rateId } = z.object({ methodId: z.uuid(), rateId: z.uuid() }).parse(req.params);
    await deleteRate(app.db, actor(req), merchantId, methodId, rateId);
    return { data: { deleted: true } };
  });

  app.post('/v1/merchants/:merchantId/shipping/courier-accounts', auth, async (req, reply) => {
    const merchantId = await asMember(req, ['owner']);
    const body = z
      .object({ courierCode: z.string().max(32), label: name, credentials: z.record(z.string().max(64), z.string().max(500)) })
      .parse(req.body);
    const account = await connectCourierAccount(app.db, { secrets: app.secrets, couriers: app.couriers }, actor(req), merchantId, body);
    return reply.status(201).send({ data: account });
  });

  app.delete('/v1/merchants/:merchantId/shipping/courier-accounts/:accountId', auth, async (req) => {
    const merchantId = await asMember(req, ['owner']);
    const { accountId } = z.object({ accountId: z.uuid() }).parse(req.params);
    await deactivateCourierAccount(app.db, actor(req), merchantId, accountId);
    return { data: { active: false } };
  });

  // --- Platform ----------------------------------------------------------------------------------------

  const courierBody = z.object({
    name,
    country,
    integration: z.enum(['manual', 'api']).default('manual'),
    trackingUrlTemplate: z.url().refine((v) => v.includes('{tracking}'), 'Must contain {tracking}').nullish(),
    active: z.boolean().default(true),
  });

  app.post('/v1/admin/couriers', admin, async (req, reply) => {
    const body = courierBody.extend({ code: z.string().regex(/^[a-z0-9_]{2,32}$/) }).parse(req.body);
    await app.db.transaction(async (tx) => {
      await tx.insert(s.couriers).values({ ...body, trackingUrlTemplate: body.trackingUrlTemplate ?? null });
      await audit(tx, actor(req), { action: 'shipping.courier.created', entityType: 'courier', entityId: body.code, metadata: body });
    });
    return reply.status(201).send({ data: { code: body.code } });
  });

  app.patch('/v1/admin/couriers/:code', admin, async (req) => {
    const { code } = z.object({ code: z.string().max(32) }).parse(req.params);
    const body = courierBody.partial().parse(req.body);
    await app.db.transaction(async (tx) => {
      const updated = await tx.update(s.couriers).set(body).where(eq(s.couriers.code, code)).returning();
      if (!updated.length) throw notFound('Courier');
      await audit(tx, actor(req), { action: 'shipping.courier.updated', entityType: 'courier', entityId: code, metadata: body });
    });
    return { data: { code } };
  });

  const pointBody = z.object({
    courierCode: z.string().max(32).nullish(),
    areaId,
    name,
    address: z.string().trim().min(5).max(300),
    phone: z.string().trim().max(20).nullish(),
    hours: z.string().trim().max(200).nullish(),
    externalId: z.string().trim().max(64).nullish(),
    active: z.boolean().default(true),
  });

  app.post('/v1/admin/pickup-points', admin, async (req, reply) => {
    const body = pointBody.parse(req.body);
    const [area] = await app.db
      .select()
      .from(s.geoAreas)
      .where(and(eq(s.geoAreas.id, body.areaId), or(eq(s.geoAreas.level, 'locality'), eq(s.geoAreas.level, 'district'))));
    if (!area) throw notFound('Commune');
    const point = await app.db.transaction(async (tx) => {
      const [row] = await tx.insert(s.pickupPoints).values(body).returning();
      await audit(tx, actor(req), { action: 'shipping.pickup_point.created', entityType: 'pickup_point', entityId: row!.id, metadata: { name: body.name } });
      return row!;
    });
    return reply.status(201).send({ data: point });
  });

  app.patch('/v1/admin/pickup-points/:pointId', admin, async (req) => {
    const { pointId } = z.object({ pointId: z.uuid() }).parse(req.params);
    const body = pointBody.partial().parse(req.body);
    const point = await app.db.transaction(async (tx) => {
      const [row] = await tx.update(s.pickupPoints).set(body).where(eq(s.pickupPoints.id, pointId)).returning();
      if (!row) throw notFound('Pickup point');
      await audit(tx, actor(req), { action: 'shipping.pickup_point.updated', entityType: 'pickup_point', entityId: pointId, metadata: body });
      return row;
    });
    return { data: point };
  });
}

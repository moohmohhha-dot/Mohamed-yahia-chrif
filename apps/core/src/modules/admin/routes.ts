import type { FastifyInstance, FastifyRequest } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@aruma/db';
import { forbidden } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, can, requireAuth, ROLE_PERMISSIONS, STAFF_ROLES } from '../identity/index.js';
import { blockProduct, describeProduct, listInventory, listOffers, listProducts, unblockProduct } from './catalog.js';
import { analytics, listPayments, overview } from './insights.js';
import { listAuditLog, listFlags, listSettlements, listStores, setFlagDefault, setFlagForStore } from './platform.js';
import { describeUser, endSessions, grantStaffRole, listStaff, listUsers, reactivateUser, revokeStaffRole, suspendUser } from './users.js';

const page = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) };
const reason = z.object({ reason: z.string().trim().min(5).max(1000) });
const userParams = z.object({ userId: z.uuid() });
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** The Admin Panel's own API. Every route checks a permission (identity/permissions.ts). */
export async function adminRoutes(app: FastifyInstance) {
  const staff = (req: FastifyRequest) => ({ ...authOf(req), ip: actorFrom(req).ip });

  /** Who am I in ARUMA: roles and permissions (the panel builds its menu from them). */
  app.get('/v1/admin/me', { preHandler: requireAuth }, async (req) => {
    const auth = authOf(req);
    if (!auth.staffRoles.length) throw forbidden('ARUMA staff only');
    const me = await describeUser(app.db, staff(req), auth.userId);
    return { data: { id: me.id, email: me.email, displayName: me.displayName, roles: auth.staffRoles, permissions: [...auth.permissions].sort() } };
  });

  app.get('/v1/admin/overview', can('overview.read'), async (req) => ({ data: await overview(app.db, authOf(req)) }));
  app.get('/v1/admin/analytics', can('analytics.read'), async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query);
    return { data: await analytics(app.db, days) };
  });

  // --- Users and staff --------------------------------------------------------------------------------

  app.get('/v1/admin/users', can('users.read'), async (req) => {
    const q = z.object({ q: z.string().trim().max(100).optional(), status: z.enum(['active', 'suspended', 'deleted']).optional(), staff: bool.optional(), ...page }).parse(req.query);
    return { data: await listUsers(app.db, q) };
  });
  app.get('/v1/admin/users/:userId', can('users.read'), async (req) => ({ data: await describeUser(app.db, staff(req), userParams.parse(req.params).userId) }));
  app.post('/v1/admin/users/:userId/suspend', can('users.manage'), async (req) => ({
    data: await suspendUser(app.db, staff(req), userParams.parse(req.params).userId, reason.parse(req.body).reason),
  }));
  app.post('/v1/admin/users/:userId/reactivate', can('users.manage'), async (req) => ({
    data: await reactivateUser(app.db, staff(req), userParams.parse(req.params).userId, reason.parse(req.body).reason),
  }));
  /** Signs the person out of every device. */
  app.post('/v1/admin/users/:userId/sessions/end', can('security.manage'), async (req) => ({
    data: await endSessions(app.db, staff(req), userParams.parse(req.params).userId, reason.parse(req.body).reason),
  }));

  app.get('/v1/admin/staff', can('staff.manage', 'security.read'), async () => ({ data: await listStaff(app.db) }));
  app.get('/v1/admin/staff/roles', can('overview.read'), async () => ({ data: { roles: STAFF_ROLES, permissions: ROLE_PERMISSIONS } }));
  app.post('/v1/admin/users/:userId/staff-roles', can('staff.manage'), async (req, reply) => {
    const body = reason.extend({ role: z.enum(STAFF_ROLES) }).parse(req.body);
    return reply.status(201).send({ data: await grantStaffRole(app.db, staff(req), userParams.parse(req.params).userId, body.role, body.reason) });
  });
  app.post('/v1/admin/users/:userId/staff-roles/:role/revoke', can('staff.manage'), async (req) => {
    const { userId, role } = userParams.extend({ role: z.enum(STAFF_ROLES) }).parse(req.params);
    return { data: await revokeStaffRole(app.db, staff(req), userId, role, reason.parse(req.body).reason) };
  });

  // --- Catalog --------------------------------------------------------------------------------------------

  const status = z.enum(['draft', 'active', 'archived']);
  app.get('/v1/admin/products', can('catalog.read'), async (req) => {
    const q = z.object({ q: z.string().trim().max(100).optional(), status: status.optional(), blocked: bool.optional(), merchantId: z.uuid().optional(), storeId: z.uuid().optional(), ...page }).parse(req.query);
    return { data: await listProducts(app.db, q) };
  });
  const productParams = z.object({ productId: z.uuid() });
  app.get('/v1/admin/products/:productId', can('catalog.read'), async (req) => ({ data: await describeProduct(app.db, productParams.parse(req.params).productId) }));
  app.post('/v1/admin/products/:productId/block', can('catalog.moderate'), async (req) => {
    const { productId } = productParams.parse(req.params);
    await blockProduct(app.db, staff(req), productId, reason.parse(req.body).reason);
    return { data: await describeProduct(app.db, productId) };
  });
  app.post('/v1/admin/products/:productId/unblock', can('catalog.moderate'), async (req) => {
    const { productId } = productParams.parse(req.params);
    await unblockProduct(app.db, staff(req), productId, reason.parse(req.body).reason);
    return { data: await describeProduct(app.db, productId) };
  });
  app.get('/v1/admin/offers', can('catalog.read'), async (req) => {
    const q = z.object({ q: z.string().trim().max(64).optional(), merchantId: z.uuid().optional(), productId: z.uuid().optional(), status: status.optional(), ...page }).parse(req.query);
    return { data: await listOffers(app.db, q) };
  });
  app.get('/v1/admin/inventory', can('inventory.read'), async (req) => {
    const q = z.object({ merchantId: z.uuid().optional(), low: bool.optional(), ...page }).parse(req.query);
    return { data: await listInventory(app.db, q) };
  });

  // --- Money --------------------------------------------------------------------------------------------

  app.get('/v1/admin/payments', can('payments.read'), async (req) => {
    const q = z
      .object({ status: z.enum(['pending', 'successful', 'failed', 'cancelled', 'refunded']).optional(), method: z.enum(['cash_on_delivery', 'online']).optional(), q: z.string().max(32).optional(), ...page })
      .parse(req.query);
    return { data: await listPayments(app.db, q) };
  });
  app.get('/v1/admin/finance/settlements', can('finance.read', 'payouts.manage'), async (req) => {
    const q = z.object({ merchantId: z.uuid().optional(), ...page }).parse(req.query);
    return { data: await listSettlements(app.db, q) };
  });

  // --- Platform -------------------------------------------------------------------------------------------

  app.get('/v1/admin/stores', can('overview.read'), async () => ({ data: await listStores(app.db) }));
  /** The stores a merchant sells in, with its own commission there (null = store / platform rules). */
  app.get('/v1/admin/merchants/:merchantId/stores', can('merchants.read'), async (req) => {
    const { merchantId } = z.object({ merchantId: z.uuid() }).parse(req.params);
    return {
      data: await app.db
        .select({ storeId: s.stores.id, slug: s.stores.slug, name: s.stores.name, status: s.storeMerchants.status, commissionBps: s.storeMerchants.commissionBps })
        .from(s.storeMerchants)
        .innerJoin(s.stores, eq(s.stores.id, s.storeMerchants.storeId))
        .where(eq(s.storeMerchants.merchantId, merchantId)),
    };
  });
  app.get('/v1/admin/couriers', can('shipping.manage', 'orders.manage'), async () => ({ data: await app.db.select().from(s.couriers).orderBy(asc(s.couriers.name)) }));
  app.get('/v1/admin/pickup-points', can('shipping.manage'), async () => ({ data: await app.db.select().from(s.pickupPoints).orderBy(asc(s.pickupPoints.name)).limit(500) }));

  app.get('/v1/admin/audit-log', can('security.read'), async (req) => {
    const q = z
      .object({
        action: z.string().trim().max(96).optional(),
        entityType: z.string().trim().max(48).optional(),
        entityId: z.string().trim().max(128).optional(),
        actorUserId: z.uuid().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        ...page,
      })
      .parse(req.query);
    return { data: await listAuditLog(app.db, q) };
  });

  app.get('/v1/admin/feature-flags', can('flags.read'), async () => ({ data: await listFlags(app.db) }));
  const flagParams = z.object({ key: z.string().max(96) });
  app.put('/v1/admin/feature-flags/:key', can('flags.manage'), async (req) => {
    const { key } = flagParams.parse(req.params);
    const body = reason.extend({ enabledByDefault: z.boolean() }).parse(req.body);
    await setFlagDefault(app.db, actorFrom(req), key, body.enabledByDefault, body.reason);
    return { data: await listFlags(app.db) };
  });
  /** A store's own setting; `enabled: null` makes it follow the default again. */
  app.put('/v1/admin/feature-flags/:key/stores/:storeId', can('flags.manage'), async (req) => {
    const { key, storeId } = flagParams.extend({ storeId: z.uuid() }).parse(req.params);
    const body = reason.extend({ enabled: z.boolean().nullable() }).parse(req.body);
    await setFlagForStore(app.db, actorFrom(req), key, storeId, body.enabled, body.reason);
    return { data: await listFlags(app.db) };
  });
}

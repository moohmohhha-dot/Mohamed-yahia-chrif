/**
 * Inventory API (v1). Merchant-scoped; every route checks membership. Reservations are created and
 * released by the orders module through the module's functions, never by merchants over HTTP.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../shared/errors.js';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, requireAuth } from '../identity/index.js';
import { requireMembership } from '../merchants/index.js';
import { exportInventory, importInventory, MAX_IMPORT_BYTES } from './bulk.js';
import { MANUAL_REASONS } from './levels.js';
import { createLocation, listLocations, updateLocation } from './locations.js';
import {
  adjustStock,
  countStock,
  inventoryHistory,
  listInventory,
  listReservations,
  setLowStockThreshold,
  transferStock,
} from './service.js';

const merchantParams = z.object({ merchantId: z.uuid() });
const offerParams = merchantParams.extend({ offerId: z.uuid() });
const quantity = z.number().int().min(1).max(1_000_000);
const locationBody = z.object({
  code: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/)),
  name: z.string().trim().min(1).max(120),
  type: z.enum(['warehouse', 'shop', 'fulfillment_center', 'dropship']).optional(),
  country: z.string().length(2).toUpperCase().optional(),
  region: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  addressLine: z.string().trim().max(200).optional(),
});

export async function inventoryRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireAuth };
  const actor = (req: FastifyRequest) => ({ ...actorFrom(req), userId: authOf(req).userId });
  const base = '/v1/merchants/:merchantId/inventory';

  app.get(base, auth, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const filter = z
      .object({
        lowStock: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
        q: z.string().trim().max(100).optional(),
        locationId: z.uuid().optional(),
      })
      .parse(req.query);
    return { data: await listInventory(app.db, authOf(req).userId, merchantId, filter) };
  });

  app.get(`${base}/locations`, auth, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    return { data: await listLocations(app.db, authOf(req).userId, merchantId) };
  });

  app.post(`${base}/locations`, auth, async (req, reply) => {
    const { merchantId } = merchantParams.parse(req.params);
    return reply.status(201).send({ data: await createLocation(app.db, actor(req), merchantId, locationBody.parse(req.body)) });
  });

  app.patch(`${base}/locations/:locationId`, auth, async (req) => {
    const { merchantId, locationId } = merchantParams.extend({ locationId: z.uuid() }).parse(req.params);
    const body = locationBody
      .omit({ code: true })
      .partial()
      .extend({ isDefault: z.literal(true).optional(), status: z.enum(['active', 'archived']).optional() })
      .parse(req.body);
    return { data: await updateLocation(app.db, actor(req), merchantId, locationId, body) };
  });

  app.post(`${base}/offers/:offerId/adjust`, auth, async (req) => {
    const { merchantId, offerId } = offerParams.parse(req.params);
    const body = z
      .object({
        locationId: z.uuid().optional(),
        delta: z.number().int().min(-1_000_000).max(1_000_000).refine((d) => d !== 0, 'delta must not be zero'),
        reason: z.enum(MANUAL_REASONS),
        note: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    return { data: await adjustStock(app.db, actor(req), merchantId, offerId, body) };
  });

  app.post(`${base}/offers/:offerId/count`, auth, async (req) => {
    const { merchantId, offerId } = offerParams.parse(req.params);
    const body = z
      .object({ locationId: z.uuid().optional(), quantity: z.number().int().min(0).max(1_000_000), note: z.string().trim().max(500).optional() })
      .parse(req.body);
    return { data: await countStock(app.db, actor(req), merchantId, offerId, body) };
  });

  app.put(`${base}/offers/:offerId/low-stock-threshold`, auth, async (req) => {
    const { merchantId, offerId } = offerParams.parse(req.params);
    const { threshold } = z.object({ threshold: z.number().int().min(0).max(100_000).nullable() }).parse(req.body);
    return { data: await setLowStockThreshold(app.db, actor(req), merchantId, offerId, threshold) };
  });

  app.get(`${base}/offers/:offerId/history`, auth, async (req) => {
    const { merchantId, offerId } = offerParams.parse(req.params);
    return { data: await inventoryHistory(app.db, authOf(req).userId, merchantId, offerId) };
  });

  app.post(`${base}/transfers`, auth, async (req, reply) => {
    const { merchantId } = merchantParams.parse(req.params);
    const body = z
      .object({ offerId: z.uuid(), fromLocationId: z.uuid(), toLocationId: z.uuid(), quantity, note: z.string().trim().max(500).optional() })
      .parse(req.body);
    return reply.status(201).send({ data: await transferStock(app.db, actor(req), merchantId, body) });
  });

  app.get(`${base}/reservations`, auth, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const { status } = z.object({ status: z.enum(['active', 'released', 'consumed', 'expired']).default('active') }).parse(req.query);
    return { data: await listReservations(app.db, authOf(req).userId, merchantId, status) };
  });

  /** multipart/form-data with one `file` (.csv or .xlsx). `?dryRun=true` checks without writing. */
  app.post(`${base}/import`, auth, async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    const { dryRun } = z.object({ dryRun: z.enum(['true', 'false']).default('false') }).parse(req.query);
    // Check access before accepting any upload.
    await requireMembership(app.db, merchantId, authOf(req).userId, ['owner', 'manager']);
    const file = await req.file({ limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } });
    if (!file) throw badRequest('FILE_REQUIRED', 'Send the file as multipart/form-data');
    const body = await file.toBuffer();
    return {
      data: await importInventory(app.db, actor(req), merchantId, { body, fileName: file.filename || null }, { dryRun: dryRun === 'true' }),
    };
  });

  app.get(`${base}/export`, auth, async (req, reply) => {
    const { merchantId } = merchantParams.parse(req.params);
    const { format, locale } = z
      .object({ format: z.enum(['csv', 'xlsx']).default('csv'), locale: z.string().max(16).default('fr') })
      .parse(req.query);
    const file = await exportInventory(app.db, authOf(req).userId, merchantId, format, locale);
    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="inventory.${format}"`)
      .header('cache-control', 'private, no-store')
      .send(file.body);
  });
}

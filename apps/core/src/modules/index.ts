/**
 * ARUMA CORE module registry. Each module owns its routes, services and tables, and exposes a
 * public API through its index.ts. Modules may only import each other through that index
 * (enforced by test/module-boundaries.test.ts), so any of them can later become a separate service.
 * The full map of planned modules is in docs/CORE.md.
 */
import type { FastifyInstance } from 'fastify';
import { catalogRoutes, merchantCatalogRoutes } from './catalog/index.js';
import { financeRoutes } from './finance/index.js';
import { identityRoutes } from './identity/index.js';
import { inventoryRoutes } from './inventory/index.js';
import { merchantCenterRoutes } from './merchant-center/index.js';
import { merchantAdminRoutes, merchantRoutes } from './merchants/index.js';
import { offerRoutes } from './offers/index.js';
import { orderRoutes } from './orders/index.js';
import { storeRoutes } from './stores/index.js';

export type ModuleOptions = { authRateLimitMax: number };

export async function registerModules(app: FastifyInstance, options: ModuleOptions) {
  await app.register(identityRoutes, options);
  await app.register(storeRoutes);
  await app.register(catalogRoutes);
  await app.register(merchantRoutes);
  await app.register(merchantAdminRoutes);
  await app.register(offerRoutes);
  await app.register(inventoryRoutes);
  await app.register(orderRoutes);
  await app.register(financeRoutes);
  await app.register(merchantCatalogRoutes);
  await app.register(merchantCenterRoutes);
}

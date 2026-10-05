import type { MessageKey } from './i18n';

export type SectionId =
  | 'dashboard' | 'products' | 'offers' | 'variants' | 'inventory'
  | 'orders' | 'returns' | 'shipping' | 'cod' | 'sales' | 'customers'
  | 'coupons' | 'promotions' | 'ads'
  | 'analytics' | 'reviews'
  | 'messages' | 'support'
  | 'balance' | 'settlements' | 'payouts'
  | 'verification' | 'settings';

/** Sidebar structure. `phase` marks a section whose module is not built yet (see docs/ROADMAP.md). */
export const NAV: { group: MessageKey; sections: { id: SectionId; phase?: number }[] }[] = [
  { group: 'group.overview', sections: [{ id: 'dashboard' }] },
  { group: 'group.catalog', sections: [{ id: 'products' }, { id: 'variants' }, { id: 'offers' }, { id: 'inventory' }] },
  { group: 'group.sales', sections: [{ id: 'orders' }, { id: 'returns' }, { id: 'shipping' }, { id: 'cod' }, { id: 'sales', phase: 1 }, { id: 'customers', phase: 1 }] },
  { group: 'group.marketing', sections: [{ id: 'coupons', phase: 2 }, { id: 'promotions', phase: 2 }, { id: 'ads', phase: 3 }] },
  { group: 'group.insights', sections: [{ id: 'analytics', phase: 2 }, { id: 'reviews' }] },
  { group: 'group.communication', sections: [{ id: 'messages', phase: 2 }, { id: 'support', phase: 2 }] },
  { group: 'group.finance', sections: [{ id: 'balance' }, { id: 'settlements' }, { id: 'payouts' }] },
  { group: 'group.account', sections: [{ id: 'verification' }, { id: 'settings' }] },
];

export const phaseOf = (id: SectionId) => NAV.flatMap((g) => g.sections).find((s) => s.id === id)?.phase;

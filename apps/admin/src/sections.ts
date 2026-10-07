import type { MessageKey } from './i18n';

/** Admin Panel menu. A section shows only to staff whose roles give one of its permissions. */
export type Section = { id: string; permissions: string[]; phase?: number };

export const NAV: { group: MessageKey; sections: Section[] }[] = [
  { group: 'group.overview', sections: [{ id: 'overview', permissions: ['overview.read'] }, { id: 'analytics', permissions: ['analytics.read'] }] },
  { group: 'group.people', sections: [{ id: 'users', permissions: ['users.read'] }, { id: 'staff', permissions: ['staff.manage', 'security.read'] }] },
  { group: 'group.merchants', sections: [{ id: 'merchants', permissions: ['merchants.read'] }, { id: 'verification', permissions: ['verification.review'] }] },
  {
    group: 'group.catalog',
    sections: [{ id: 'products', permissions: ['catalog.read'] }, { id: 'offers', permissions: ['catalog.read'] }, { id: 'inventory', permissions: ['inventory.read'] }, { id: 'search', permissions: ['search.manage', 'analytics.read'] }],
  },
  {
    group: 'group.commerce',
    sections: [
      { id: 'orders', permissions: ['orders.read'] },
      { id: 'payments', permissions: ['payments.read'] },
      { id: 'shipping', permissions: ['shipping.manage'] },
      { id: 'returns', permissions: ['returns.read'] },
      { id: 'disputes', permissions: ['disputes.read'] },
    ],
  },
  {
    group: 'group.finance',
    sections: [
      { id: 'finance', permissions: ['finance.read'] },
      { id: 'commission', permissions: ['commission.manage', 'finance.read'] },
      { id: 'settlements', permissions: ['finance.read', 'payouts.manage'] },
      { id: 'payouts', permissions: ['finance.read', 'payouts.manage'] },
    ],
  },
  {
    group: 'group.trust',
    sections: [{ id: 'reviews', permissions: ['reviews.moderate'] }, { id: 'fraud', permissions: ['fraud.manage', 'cod.policy'] }, { id: 'security', permissions: ['security.read'] }],
  },
  {
    group: 'group.growth',
    sections: [
      { id: 'ads', permissions: ['ads.manage'], phase: 3 },
      { id: 'coupons', permissions: ['coupons.manage'], phase: 2 },
      { id: 'rewards', permissions: ['rewards.manage'], phase: 2 },
    ],
  },
  {
    group: 'group.platform',
    sections: [
      { id: 'support', permissions: ['support.manage'], phase: 2 },
      { id: 'cms', permissions: ['cms.manage'], phase: 1 },
      { id: 'ai', permissions: ['ai.manage'] },
      { id: 'flags', permissions: ['flags.read'] },
    ],
  },
];

export const ALL_SECTIONS = NAV.flatMap((g) => g.sections);

/**
 * Order status rules: who may move an order from one status to another, and when a reason is needed.
 * The same transitions are enforced by a database trigger (migration 0006).
 *
 *   new ──► processing ──► preparing ──► shipping ──► delivered
 *    │          │              │            │             │
 *    └──────────┴──────► cancelled          └──► returned ◄┘
 *                            │                     │
 *                            └────► refunded ◄─────┘
 */
import type { schema } from '@aruma/db';

export type OrderStatus = (typeof schema.orderStatus.enumValues)[number];
/** 'system': automatic actions (e.g. an unpaid online checkout expires). */
export type OrderActorType = 'customer' | 'merchant' | 'platform' | 'system';

const ALL: OrderActorType[] = ['customer', 'merchant', 'platform', 'system'];
const STAFF: OrderActorType[] = ['merchant', 'platform'];
/** Refunds happen only through the refund flow (Payment Service), started by an administrator. */
const REFUND: OrderActorType[] = ['platform', 'system'];

export const TRANSITIONS: Record<OrderStatus, Partial<Record<OrderStatus, OrderActorType[]>>> = {
  new: { processing: STAFF, cancelled: ALL },
  processing: { preparing: STAFF, cancelled: ALL },
  preparing: { shipping: STAFF, cancelled: STAFF },
  shipping: { delivered: STAFF, returned: STAFF },
  delivered: { returned: STAFF },
  // Money movements belong to the platform: merchants can never mark an order refunded.
  returned: { refunded: REFUND },
  cancelled: { refunded: REFUND },
  refunded: {},
};

/** Statuses a given actor may move the order to from its current status. */
export function nextStatuses(from: OrderStatus, actor: OrderActorType): OrderStatus[] {
  return (Object.entries(TRANSITIONS[from]) as [OrderStatus, OrderActorType[]][])
    .filter(([, actors]) => actors.includes(actor))
    .map(([to]) => to);
}

/** A reason is mandatory for returns and refunds, and for cancellations not made by the customer. */
export function reasonRequired(to: OrderStatus, actor: OrderActorType): boolean {
  if (to === 'returned' || to === 'refunded') return true;
  return to === 'cancelled' && actor !== 'customer';
}

/** Within a merchant, cancelling is a decision for owners and managers; staff run the daily flow. */
export const MERCHANT_ROLES_FOR: Partial<Record<OrderStatus, ('owner' | 'manager' | 'staff')[]>> = {
  cancelled: ['owner', 'manager'],
  returned: ['owner', 'manager'],
};

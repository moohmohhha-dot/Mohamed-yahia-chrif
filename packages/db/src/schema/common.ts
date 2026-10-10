import { pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';

export const id = () => uuid('id').primaryKey().defaultRandom();

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const recordStatus = pgEnum('record_status', ['draft', 'active', 'archived']);

/** Who acted on an order (also used by COD and returns histories). */
export const orderActorType = pgEnum('order_actor_type', ['customer', 'merchant', 'platform', 'system']);

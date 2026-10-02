/**
 * Finance: a double-entry ledger. Every money event is a journal entry whose lines debit and credit
 * accounts for the same total (enforced by a database constraint at commit). Nothing is updated or
 * deleted: mistakes are corrected with new entries.
 *
 * IMPORTANT: ledger balances are ARUMA's records of who is owed what. They are not money. Real money
 * moves only through a payment provider or a bank/postal transfer, and is then recorded here with its
 * external reference (see docs/FINANCE.md).
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, char, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { id } from './common.js';
import { users } from './identity.js';
import { merchants } from './merchants.js';
import { orders } from './orders.js';
import { currencies } from './reference.js';
import { stores } from './tenancy.js';

export const accountType = pgEnum('ledger_account_type', ['asset', 'liability', 'revenue', 'expense']);
export const accountPurpose = pgEnum('ledger_account_purpose', [
  // Platform
  'provider_clearing', // asset: money held for ARUMA by the payment provider, not yet in ARUMA's bank
  'bank', // asset: ARUMA's bank account
  'order_funds_held', // liability: customers' payments for orders not delivered yet
  'payouts_in_transit', // liability: transfers to merchants sent but not confirmed
  'commission_revenue', // revenue: ARUMA's commission
  'fee_revenue', // revenue: fees charged to merchants
  'provider_fees_expense', // expense: fees charged by payment providers
  // Merchant (one set per merchant and currency)
  'merchant_pending', // liability: earned, still in the hold period (returns window)
  'merchant_available', // liability: can be settled
  'merchant_settled', // liability: settled, waiting for the payout
]);

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: id(),
    purpose: accountPurpose('purpose').notNull(),
    type: accountType('type').notNull(),
    merchantId: uuid('merchant_id').references(() => merchants.id, { onDelete: 'restrict' }),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ledger_accounts_merchant_uq').on(t.purpose, t.merchantId, t.currency).where(sql`${t.merchantId} is not null`),
    uniqueIndex('ledger_accounts_platform_uq').on(t.purpose, t.currency).where(sql`${t.merchantId} is null`),
  ],
);

export const entryKind = pgEnum('ledger_entry_kind', [
  'order_paid', // online payment received for an order
  'order_delivered', // sale recognized: merchant due, commission and fees
  'refund', // money returned to a customer
  'balance_release', // merchant pending → available after the hold period
  'settlement', // merchant available → settled (statement closed)
  'payout_sent', // transfer to the merchant sent
  'payout_paid', // transfer confirmed by the bank
  'payout_failed', // transfer returned: money back to the merchant's available balance
  'provider_settlement', // the provider paid ARUMA (minus its fees)
  'adjustment', // manual correction by finance, always with a reason
]);

/** A journal entry. (kind, source) is unique, so posting the same business event twice is impossible. */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: id(),
    kind: entryKind('kind').notNull(),
    sourceType: varchar('source_type', { length: 32 }).notNull(),
    sourceId: varchar('source_id', { length: 128 }).notNull(),
    merchantId: uuid('merchant_id').references(() => merchants.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    description: text('description').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('journal_entries_source_uq').on(t.kind, t.sourceType, t.sourceId),
    index('journal_entries_merchant_idx').on(t.merchantId, t.createdAt),
    index('journal_entries_order_idx').on(t.orderId),
  ],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: id(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: 'restrict' }),
    debitMinor: bigint('debit_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    creditMinor: bigint('credit_minor', { mode: 'bigint' }).notNull().default(sql`0`),
    /** Which order this line concerns (lets the hold period and reconciliation work per order). */
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('journal_lines_account_idx').on(t.accountId),
    index('journal_lines_entry_idx').on(t.entryId),
    index('journal_lines_order_idx').on(t.orderId),
    check('journal_lines_one_side', sql`(${t.debitMinor} > 0 and ${t.creditMinor} = 0) or (${t.creditMinor} > 0 and ${t.debitMinor} = 0)`),
  ],
);

/** Delivered orders whose merchant money is held until the returns window ends. */
export const balanceHolds = pgTable('balance_holds', {
  orderId: uuid('order_id')
    .primaryKey()
    .references(() => orders.id, { onDelete: 'restrict' }),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id, { onDelete: 'restrict' }),
  currency: char('currency', { length: 3 }).notNull(),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
});

export const commissionScope = pgEnum('commission_scope', ['platform', 'store']);

/**
 * Commission rates, versioned. The rate used for an order is the most specific rule in effect when the
 * order is placed: merchant override in the store (store_merchants.commission_bps) › store rule › platform rule.
 * Rules are never edited: a new rule with a later effective date replaces the previous one.
 */
export const commissionRules = pgTable(
  'commission_rules',
  {
    id: id(),
    scope: commissionScope('scope').notNull(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    bps: integer('bps').notNull(), // 800 = 8 %
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('commission_rules_lookup_idx').on(t.scope, t.storeId, t.effectiveFrom),
    check('commission_rules_bps_range', sql`${t.bps} >= 0 and ${t.bps} <= 10000`),
    check('commission_rules_store_scope', sql`(${t.scope} = 'store') = (${t.storeId} is not null)`),
  ],
);

/** Other finance parameters, versioned the same way (hold period, per-order fee). */
export const financeSettings = pgTable(
  'finance_settings',
  {
    id: id(),
    key: varchar('key', { length: 48 }).notNull(), // hold_days | order_fee_minor
    value: integer('value').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('finance_settings_lookup_idx').on(t.key, t.effectiveFrom), check('finance_settings_nonneg', sql`${t.value} >= 0`)],
);

/** A merchant statement: what was available at the cut-off, moved to "settled" for payout. */
export const settlements = pgTable(
  'settlements',
  {
    id: id(),
    number: varchar('number', { length: 32 }).notNull().unique(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    currency: char('currency', { length: 3 }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    /** Sales, commission, fees, refunds and releases since the previous settlement (for the statement). */
    breakdown: jsonb('breakdown').$type<Record<string, number>>().notNull(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('settlements_amount_positive', sql`${t.amountMinor} > 0`)],
);

export const payoutStatus = pgEnum('payout_status', ['requested', 'sent', 'paid', 'failed']);

/**
 * An instruction to transfer a settlement to the merchant. ARUMA does not move money itself:
 * the transfer is made in the bank / Algérie Poste (or later a payout provider), then recorded here.
 */
export const payouts = pgTable(
  'payouts',
  {
    id: id(),
    settlementId: uuid('settlement_id')
      .notNull()
      .unique()
      .references(() => settlements.id, { onDelete: 'restrict' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: payoutStatus('status').notNull().default('requested'),
    /** Masked destination at the time of the payout: type, holder, last 4 digits (never the full number). */
    destination: jsonb('destination').$type<Record<string, string>>().notNull(),
    method: varchar('method', { length: 32 }).notNull().default('manual_transfer'),
    externalReference: varchar('external_reference', { length: 128 }),
    failureReason: text('failure_reason'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('payouts_merchant_idx').on(t.merchantId, t.createdAt)],
);

export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: id(),
  balanced: boolean('balanced').notNull(),
  periodFrom: timestamp('period_from', { withTimezone: true }).notNull(),
  periodTo: timestamp('period_to', { withTimezone: true }).notNull(),
  summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
  discrepancies: jsonb('discrepancies').$type<Record<string, unknown>[]>().notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

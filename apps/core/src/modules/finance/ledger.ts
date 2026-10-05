/**
 * Double-entry posting. One business event = one journal entry, identified by (kind, source):
 * posting it again does nothing. Every entry balances (also enforced by the database at commit).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { schema as s } from '@aruma/db';
import type { Executor } from '../../shared/db.js';

export type Purpose = (typeof s.accountPurpose.enumValues)[number];
type EntryKind = (typeof s.entryKind.enumValues)[number];

const TYPE_OF: Record<Purpose, (typeof s.accountType.enumValues)[number]> = {
  provider_clearing: 'asset',
  bank: 'asset',
  order_funds_held: 'liability',
  payouts_in_transit: 'liability',
  commission_revenue: 'revenue',
  fee_revenue: 'revenue',
  provider_fees_expense: 'expense',
  store_credit: 'liability',
  compensation_expense: 'expense',
  merchant_pending: 'liability',
  merchant_available: 'liability',
  merchant_settled: 'liability',
};
export const MERCHANT_PURPOSES: Purpose[] = ['merchant_pending', 'merchant_available', 'merchant_settled'];

export async function ensureAccount(db: Executor, purpose: Purpose, currency: string, merchantId: string | null = null) {
  const scope = merchantId ? eq(s.ledgerAccounts.merchantId, merchantId) : isNull(s.ledgerAccounts.merchantId);
  const find = () =>
    db.select().from(s.ledgerAccounts).where(and(eq(s.ledgerAccounts.purpose, purpose), eq(s.ledgerAccounts.currency, currency), scope));
  const [existing] = await find();
  if (existing) return existing;
  await db.insert(s.ledgerAccounts).values({ purpose, type: TYPE_OF[purpose], currency, merchantId }).onConflictDoNothing();
  return (await find())[0]!;
}

export type Line = { purpose: Purpose; merchantId?: string | null; debit?: bigint; credit?: bigint; orderId?: string | null };

/** A movement of `amount` from one account to another (debit `from`, credit `to`); a negative amount reverses it. */
export function move(amount: bigint, from: Omit<Line, 'debit' | 'credit'>, to: Omit<Line, 'debit' | 'credit'>): Line[] {
  if (amount === 0n) return [];
  if (amount < 0n) return move(-amount, to, from);
  return [
    { ...from, debit: amount },
    { ...to, credit: amount },
  ];
}

export type EntryInput = {
  kind: EntryKind;
  sourceType: string;
  sourceId: string;
  currency: string;
  description: string;
  merchantId?: string | null;
  orderId?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
  lines: Line[];
};

/** Posts an entry once. Returns the entry (existing one if this event was already posted), or null if it moves nothing. */
export async function postEntry(db: Executor, input: EntryInput) {
  const lines = input.lines.filter((l) => (l.debit ?? 0n) > 0n || (l.credit ?? 0n) > 0n);
  if (lines.length === 0) return null;
  const debits = lines.reduce((sum, l) => sum + (l.debit ?? 0n), 0n);
  const credits = lines.reduce((sum, l) => sum + (l.credit ?? 0n), 0n);
  if (debits !== credits) throw new Error(`Unbalanced entry ${input.kind}/${input.sourceId}: ${debits} ≠ ${credits}`);

  const [entry] = await db
    .insert(s.journalEntries)
    .values({
      kind: input.kind,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      currency: input.currency,
      description: input.description,
      merchantId: input.merchantId ?? null,
      orderId: input.orderId ?? null,
      metadata: input.metadata ?? {},
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!entry) {
    const [existing] = await db
      .select()
      .from(s.journalEntries)
      .where(and(eq(s.journalEntries.kind, input.kind), eq(s.journalEntries.sourceType, input.sourceType), eq(s.journalEntries.sourceId, input.sourceId)));
    return existing!;
  }
  for (const line of lines) {
    const account = await ensureAccount(db, line.purpose, input.currency, line.merchantId ?? null);
    await db.insert(s.journalLines).values({
      entryId: entry.id,
      accountId: account.id,
      debitMinor: line.debit ?? 0n,
      creditMinor: line.credit ?? 0n,
      orderId: line.orderId ?? input.orderId ?? null,
    });
  }
  return entry;
}

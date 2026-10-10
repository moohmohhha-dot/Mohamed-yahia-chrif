/**
 * Balances, statements, settlements and payouts.
 *
 * A settlement moves a merchant's available balance to "settled" and creates a payout instruction.
 * ARUMA does not move money itself: finance staff make the transfer in the bank / Algérie Poste
 * (or, later, through a payout provider) and record its reference; only then is the payout "paid".
 */
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { audit, recordEvent } from '../platform/index.js';
import { ensureAccount, move, postEntry } from './ledger.js';

const toNumber = (v: string | bigint) => Number(v);

/** Balance of one account: credit-normal accounts (liabilities, revenue) count credits minus debits. */
async function balanceOf(db: Executor, accountId: string, creditNormal: boolean) {
  const [row] = await db
    .select({
      value: sql<string>`coalesce(sum(${creditNormal ? sql`${s.journalLines.creditMinor} - ${s.journalLines.debitMinor}` : sql`${s.journalLines.debitMinor} - ${s.journalLines.creditMinor}`}), 0)::text`,
    })
    .from(s.journalLines)
    .where(eq(s.journalLines.accountId, accountId));
  return BigInt(row!.value);
}

/** What ARUMA owes the merchant, per currency: pending (hold period), available, and settled (awaiting payout). */
export async function merchantBalances(db: Executor, merchantId: string) {
  const accounts = await db.select().from(s.ledgerAccounts).where(eq(s.ledgerAccounts.merchantId, merchantId));
  const currencies = [...new Set(accounts.map((a) => a.currency))];
  const result = [];
  for (const currency of currencies) {
    const get = async (purpose: 'merchant_pending' | 'merchant_available' | 'merchant_settled') => {
      const account = accounts.find((a) => a.purpose === purpose && a.currency === currency);
      return account ? balanceOf(db, account.id, true) : 0n;
    };
    const [pending, available, settled] = [await get('merchant_pending'), await get('merchant_available'), await get('merchant_settled')];
    const [totals] = await db
      .select({
        sales: sql<string>`coalesce(sum((${s.journalEntries.metadata}->>'base')::bigint) filter (where ${s.journalEntries.kind} = 'order_delivered'), 0)::text`,
        commission: sql<string>`coalesce(sum((${s.journalEntries.metadata}->>'commission')::bigint) filter (where ${s.journalEntries.kind} = 'order_delivered'), 0)::text`,
        fees: sql<string>`coalesce(sum((${s.journalEntries.metadata}->>'fee')::bigint) filter (where ${s.journalEntries.kind} = 'order_delivered'), 0)::text`,
        refunds: sql<string>`coalesce(sum((${s.journalEntries.metadata}->>'amount')::bigint) filter (where ${s.journalEntries.kind} = 'refund' and ${s.journalEntries.metadata}->>'beforeDelivery' is null), 0)::text`,
        commissionReturned: sql<string>`coalesce(sum((${s.journalEntries.metadata}->>'commissionShare')::bigint) filter (where ${s.journalEntries.kind} = 'refund'), 0)::text`,
        paidOut: sql<string>`coalesce(sum((${s.journalEntries.metadata}->>'amount')::bigint) filter (where ${s.journalEntries.kind} = 'payout_paid'), 0)::text`,
      })
      .from(s.journalEntries)
      .where(and(eq(s.journalEntries.merchantId, merchantId), eq(s.journalEntries.currency, currency)));
    result.push({
      currency,
      pendingMinor: toNumber(pending),
      availableMinor: toNumber(available),
      settledMinor: toNumber(settled),
      totalOwedMinor: toNumber(pending + available + settled),
      lifetime: {
        salesMinor: toNumber(totals!.sales),
        commissionMinor: toNumber(BigInt(totals!.commission) - BigInt(totals!.commissionReturned)),
        feesMinor: toNumber(totals!.fees),
        refundsMinor: toNumber(totals!.refunds),
        paidOutMinor: toNumber(totals!.paidOut),
      },
    });
  }
  return result;
}

/** The merchant's statement: every ledger line on its accounts, newest first, with the order number. */
export async function merchantStatement(db: Database, merchantId: string, limit = 200) {
  const rows = await db
    .select({
      entryId: s.journalEntries.id,
      kind: s.journalEntries.kind,
      description: s.journalEntries.description,
      metadata: s.journalEntries.metadata,
      createdAt: s.journalEntries.createdAt,
      account: s.ledgerAccounts.purpose,
      currency: s.ledgerAccounts.currency,
      debit: s.journalLines.debitMinor,
      credit: s.journalLines.creditMinor,
      orderNumber: s.orders.number,
    })
    .from(s.journalLines)
    .innerJoin(s.ledgerAccounts, eq(s.ledgerAccounts.id, s.journalLines.accountId))
    .innerJoin(s.journalEntries, eq(s.journalEntries.id, s.journalLines.entryId))
    .leftJoin(s.orders, eq(s.orders.id, s.journalLines.orderId))
    .where(eq(s.ledgerAccounts.merchantId, merchantId))
    .orderBy(desc(s.journalEntries.createdAt), asc(s.ledgerAccounts.purpose))
    .limit(limit);
  return rows.map((r) => ({
    entryId: r.entryId,
    kind: r.kind,
    description: r.description,
    account: r.account,
    currency: r.currency,
    /** Positive: ARUMA owes the merchant more. Negative: less. */
    amountMinor: toNumber(r.credit - r.debit),
    orderNumber: r.orderNumber,
    details: r.metadata,
    createdAt: r.createdAt,
  }));
}

async function nextSettlementNumber(db: Executor) {
  const { rows } = await db.execute<{ n: string }>(sql`select nextval('settlement_number_seq')::text as n`);
  return `ST-${new Date().getUTCFullYear()}-${rows[0]!.n.padStart(6, '0')}`;
}

/**
 * Settles the merchant's available balance (if positive) and creates the payout instruction.
 * Requires a verified payout account; the destination is stored masked (last 4 digits only).
 */
export async function createSettlement(db: Database, actor: Actor & { userId: string }, merchantId: string, currency: string) {
  return db.transaction(async (tx) => {
    const available = await ensureAccount(tx, 'merchant_available', currency, merchantId);
    // One settlement at a time per merchant and currency.
    await tx.select().from(s.ledgerAccounts).where(eq(s.ledgerAccounts.id, available.id)).for('update');
    const amount = await balanceOf(tx, available.id, true);
    if (amount <= 0n) throw new AppError(409, 'NOTHING_TO_SETTLE', 'The available balance is not positive', { availableMinor: Number(amount) });

    const [check] = await tx
      .select()
      .from(s.merchantVerifications)
      .where(and(eq(s.merchantVerifications.merchantId, merchantId), eq(s.merchantVerifications.kind, 'payout')));
    const [method] = await tx
      .select()
      .from(s.merchantPayoutMethods)
      .where(and(eq(s.merchantPayoutMethods.merchantId, merchantId), isNull(s.merchantPayoutMethods.archivedAt)));
    if (check?.status !== 'verified' || !method) {
      throw new AppError(409, 'PAYOUT_ACCOUNT_NOT_VERIFIED', 'The merchant has no verified payout account');
    }
    if (method.currency !== currency) throw new AppError(409, 'PAYOUT_CURRENCY_MISMATCH', `The payout account is in ${method.currency}`);

    const [previous] = await tx
      .select({ createdAt: s.settlements.createdAt })
      .from(s.settlements)
      .where(and(eq(s.settlements.merchantId, merchantId), eq(s.settlements.currency, currency)))
      .orderBy(desc(s.settlements.createdAt))
      .limit(1);
    const since = previous?.createdAt ?? new Date(0);
    const [b] = await tx
      .select({
        sales: sql<string>`coalesce(sum((${s.journalEntries.metadata}->>'base')::bigint) filter (where ${s.journalEntries.kind} = 'order_delivered'), 0)::text`,
        commission: sql<string>`coalesce(sum((${s.journalEntries.metadata}->>'commission')::bigint) filter (where ${s.journalEntries.kind} = 'order_delivered'), 0)::text`,
        fees: sql<string>`coalesce(sum((${s.journalEntries.metadata}->>'fee')::bigint) filter (where ${s.journalEntries.kind} = 'order_delivered'), 0)::text`,
        refunds: sql<string>`coalesce(sum((${s.journalEntries.metadata}->>'amount')::bigint) filter (where ${s.journalEntries.kind} = 'refund'), 0)::text`,
        released: sql<string>`coalesce(sum((${s.journalEntries.metadata}->>'amount')::bigint) filter (where ${s.journalEntries.kind} = 'balance_release'), 0)::text`,
      })
      .from(s.journalEntries)
      .where(and(eq(s.journalEntries.merchantId, merchantId), eq(s.journalEntries.currency, currency), gt(s.journalEntries.createdAt, since)));

    const settlementId = crypto.randomUUID();
    const entry = await postEntry(tx, {
      kind: 'settlement',
      sourceType: 'settlement',
      sourceId: settlementId,
      currency,
      merchantId,
      description: 'Settlement of the available balance',
      metadata: { amount: Number(amount) },
      createdBy: actor.userId,
      lines: move(amount, { purpose: 'merchant_available', merchantId }, { purpose: 'merchant_settled', merchantId }),
    });
    const [settlement] = await tx
      .insert(s.settlements)
      .values({
        id: settlementId,
        number: await nextSettlementNumber(tx),
        merchantId,
        currency,
        amountMinor: amount,
        periodEnd: new Date(),
        breakdown: Object.fromEntries(Object.entries(b!).map(([k, v]) => [`${k}Minor`, Number(v)])),
        entryId: entry!.id,
        createdBy: actor.userId,
      })
      .returning();
    const [payout] = await tx
      .insert(s.payouts)
      .values({
        settlementId,
        merchantId,
        amountMinor: amount,
        currency,
        destination: { type: method.type, holderName: method.holderName, institution: method.institutionName ?? '', last4: method.accountNumberLast4 },
        createdBy: actor.userId,
      })
      .returning();
    await audit(tx, actor, { action: 'finance.settlement.created', entityType: 'merchant', entityId: merchantId, metadata: { settlementId, amount: Number(amount), currency } });
    await recordEvent(tx, { type: 'finance.settlement.created', aggregateType: 'merchant', aggregateId: merchantId, payload: { settlementId, payoutId: payout!.id, amount: Number(amount), currency } });
    return { settlement: settlement!, payout: payout! };
  });
}

/**
 * Payout lifecycle, recorded after the real transfer happens elsewhere:
 *   sent   → the transfer was ordered in the bank (reference recommended)
 *   paid   → the bank confirmed it (reference required)
 *   failed → it bounced or was cancelled: the money returns to the merchant's available balance
 */
export async function updatePayout(
  db: Database,
  actor: Actor & { userId: string },
  payoutId: string,
  input: { status: 'sent' | 'paid' | 'failed'; externalReference?: string; reason?: string },
) {
  return db.transaction(async (tx) => {
    const [payout] = await tx.select().from(s.payouts).where(eq(s.payouts.id, payoutId)).for('update');
    if (!payout) throw notFound('Payout');
    const from = payout.status;
    const allowed: Record<string, string[]> = { requested: ['sent', 'failed'], sent: ['paid', 'failed'], paid: [], failed: [] };
    if (!allowed[from]!.includes(input.status)) throw new AppError(409, 'INVALID_PAYOUT_TRANSITION', `A ${from} payout cannot become ${input.status}`);
    if (input.status === 'paid' && !(input.externalReference ?? payout.externalReference)) {
      throw new AppError(400, 'EXTERNAL_REFERENCE_REQUIRED', 'Give the bank / CCP transfer reference');
    }
    if (input.status === 'failed' && !input.reason) throw new AppError(400, 'REASON_REQUIRED', 'Explain why the payout failed');

    const merchant = { merchantId: payout.merchantId };
    const common = { sourceType: 'payout', sourceId: payout.id, currency: payout.currency, merchantId: payout.merchantId, createdBy: actor.userId, metadata: { amount: Number(payout.amountMinor), reference: input.externalReference ?? null } };
    if (input.status === 'sent') {
      await postEntry(tx, { ...common, kind: 'payout_sent', description: 'Payout sent', lines: move(payout.amountMinor, { purpose: 'merchant_settled', ...merchant }, { purpose: 'payouts_in_transit' }) });
    } else if (input.status === 'paid') {
      await postEntry(tx, { ...common, kind: 'payout_paid', description: 'Payout confirmed by the bank', lines: move(payout.amountMinor, { purpose: 'payouts_in_transit' }, { purpose: 'bank' }) });
    } else {
      const fromPurpose = from === 'sent' ? ('payouts_in_transit' as const) : ('merchant_settled' as const);
      await postEntry(tx, {
        ...common,
        kind: 'payout_failed',
        description: `Payout failed: ${input.reason}`,
        lines: move(payout.amountMinor, fromPurpose === 'payouts_in_transit' ? { purpose: fromPurpose } : { purpose: fromPurpose, ...merchant }, { purpose: 'merchant_available', ...merchant }),
      });
    }
    const [updated] = await tx
      .update(s.payouts)
      .set({
        status: input.status,
        ...(input.externalReference ? { externalReference: input.externalReference } : {}),
        ...(input.status === 'sent' ? { sentAt: new Date() } : {}),
        ...(input.status === 'paid' ? { paidAt: new Date() } : {}),
        ...(input.status === 'failed' ? { failureReason: input.reason } : {}),
      })
      .where(eq(s.payouts.id, payoutId))
      .returning();
    await audit(tx, actor, { action: `finance.payout.${input.status}`, entityType: 'payout', entityId: payoutId, metadata: { from, ...input } });
    await recordEvent(tx, { type: `finance.payout.${input.status}`, aggregateType: 'payout', aggregateId: payoutId, payload: { merchantId: payout.merchantId, amount: Number(payout.amountMinor) } });
    return updated!;
  });
}

/** The payment provider transferred money to ARUMA's bank, minus its fees. */
export async function recordProviderSettlement(
  db: Database,
  actor: Actor & { userId: string },
  input: { provider: string; reference: string; currency: string; grossMinor: number; feesMinor: number },
) {
  if (input.feesMinor > input.grossMinor) throw new AppError(400, 'INVALID_AMOUNTS', 'Fees cannot exceed the gross amount');
  return db.transaction(async (tx) => {
    const entry = await postEntry(tx, {
      kind: 'provider_settlement',
      sourceType: 'provider_settlement',
      sourceId: `${input.provider}:${input.reference}`,
      currency: input.currency,
      description: `${input.provider} settlement ${input.reference}`,
      metadata: { ...input },
      createdBy: actor.userId,
      lines: [
        { purpose: 'bank', debit: BigInt(input.grossMinor - input.feesMinor) },
        { purpose: 'provider_fees_expense', debit: BigInt(input.feesMinor) },
        { purpose: 'provider_clearing', credit: BigInt(input.grossMinor) },
      ],
    });
    await audit(tx, actor, { action: 'finance.provider_settlement.recorded', entityType: 'journal_entry', entityId: entry!.id, metadata: { ...input } });
    return entry!;
  });
}

export async function listSettlements(db: Database, merchantId: string) {
  return db.select().from(s.settlements).where(eq(s.settlements.merchantId, merchantId)).orderBy(desc(s.settlements.createdAt));
}

export async function listPayouts(db: Database, filter: { merchantId?: string; status?: (typeof s.payoutStatus.enumValues)[number] }) {
  const conditions = [];
  if (filter.merchantId) conditions.push(eq(s.payouts.merchantId, filter.merchantId));
  if (filter.status) conditions.push(eq(s.payouts.status, filter.status));
  return db.select().from(s.payouts).where(and(...conditions)).orderBy(desc(s.payouts.createdAt)).limit(500);
}

/** Every account with its balance; debits and credits of the whole ledger must be equal. */
export async function trialBalance(db: Database) {
  const rows = await db
    .select({
      purpose: s.ledgerAccounts.purpose,
      type: s.ledgerAccounts.type,
      merchantId: s.ledgerAccounts.merchantId,
      currency: s.ledgerAccounts.currency,
      debits: sql<string>`coalesce(sum(${s.journalLines.debitMinor}), 0)::text`,
      credits: sql<string>`coalesce(sum(${s.journalLines.creditMinor}), 0)::text`,
    })
    .from(s.ledgerAccounts)
    .leftJoin(s.journalLines, eq(s.journalLines.accountId, s.ledgerAccounts.id))
    .groupBy(s.ledgerAccounts.id);
  const totals = new Map<string, { debits: bigint; credits: bigint }>();
  for (const r of rows) {
    const t = totals.get(r.currency) ?? { debits: 0n, credits: 0n };
    t.debits += BigInt(r.debits);
    t.credits += BigInt(r.credits);
    totals.set(r.currency, t);
  }
  const platform = rows.filter((r) => !r.merchantId);
  const merchantsByPurpose = new Map<string, bigint>();
  for (const r of rows.filter((x) => x.merchantId)) {
    const key = `${r.currency}:${r.purpose}`;
    merchantsByPurpose.set(key, (merchantsByPurpose.get(key) ?? 0n) + BigInt(r.credits) - BigInt(r.debits));
  }
  return {
    currencies: [...totals.entries()].map(([currency, t]) => ({ currency, debitsMinor: Number(t.debits), creditsMinor: Number(t.credits), balanced: t.debits === t.credits })),
    platformAccounts: platform.map((r) => ({
      purpose: r.purpose,
      type: r.type,
      currency: r.currency,
      balanceMinor: Number(r.type === 'asset' || r.type === 'expense' ? BigInt(r.debits) - BigInt(r.credits) : BigInt(r.credits) - BigInt(r.debits)),
    })),
    merchantTotals: [...merchantsByPurpose.entries()].map(([key, v]) => ({ currency: key.split(':')[0], purpose: key.split(':')[1], balanceMinor: Number(v) })),
  };
}


/**
 * Dispute Center.
 *
 *   open ─(the other party answers; either party asks ARUMA, or no answer in 72 h)─► under_review
 *     │                                                                                 │ ARUMA decides
 *     └─ claimant withdraws (e.g. settled) ─► withdrawn                                  ▼
 *                     resolved ◄─ appeal window ends, or the losing party accepts ── decided
 *                        ▲                                                              │ a party appeals (once, 7 days)
 *                        └──────────── another ARUMA administrator decides ──── appealed ◄┘
 *
 * The resolution is executed once final: refund (Payment Service; cash-on-delivery refunds are sent
 * by transfer and recorded with their reference), store credit, or compensation paid by ARUMA to the
 * merchant. Parties never move money themselves.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError, badRequest, forbidden, notFound } from '../../shared/errors.js';
import { issueStoreCredit, postMerchantCompensation } from '../finance/index.js';
import { requireMembership } from '../merchants/index.js';
import { markRefundedIfDone, refundOrder, type OrderDeps } from '../orders/index.js';
import { audit, detectContentType, recordEvent, type FileStorage, type SecretBox } from '../platform/index.js';

type Dispute = typeof s.disputes.$inferSelect;
export type Kind = Dispute['kind'];
type Status = Dispute['status'];
export type Remedy = NonNullable<Dispute['remedy']>;
export type Outcome = NonNullable<Dispute['outcome']>;
export type DisputeActor = { type: 'customer' | 'merchant' | 'platform' | 'system'; userId: string | null; ip: string | null; merchantId?: string };
type Side = 'claimant' | 'respondent' | 'aruma';

export const CATEGORIES: Record<Kind, readonly string[]> = {
  customer_merchant: ['item_not_received', 'not_as_described', 'damaged', 'wrong_item', 'refund_not_received', 'return_rejected', 'other'],
  merchant_customer: ['false_claim', 'item_not_returned', 'returned_damaged', 'cod_refusal_abuse', 'abusive_behavior', 'other'],
  merchant_aruma: ['commission', 'fees', 'payout', 'settlement', 'account_status', 'review_moderation', 'other'],
};
/** What the claimant may ask for, per kind. */
const REMEDIES: Record<Kind, Remedy[]> = {
  customer_merchant: ['none', 'refund', 'store_credit'],
  merchant_customer: ['none', 'merchant_compensation'],
  merchant_aruma: ['none', 'merchant_compensation'],
};
const RESPOND_HOURS = 72;
const APPEAL_DAYS = 7;
const OPEN_FOR_DAYS = 180; // disputes about orders placed in the last 6 months
const MAX_FILES = 20;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const LIVE: Status[] = ['open', 'under_review', 'decided', 'appealed'];

// --- Helpers --------------------------------------------------------------------------------------------

async function nextNumber(db: Executor) {
  const [row] = await db.execute<{ n: string }>(sql`select nextval('dispute_number_seq')::text as n`).then((r) => r.rows);
  return `DS-${new Date().getUTCFullYear()}-${row!.n.padStart(6, '0')}`;
}

async function event(db: Executor, d: Dispute, actor: DisputeActor, type: (typeof s.disputeEventType.enumValues)[number], input: { to?: Status; note?: string | null; data?: Record<string, unknown> } = {}) {
  await db.insert(s.disputeEvents).values({
    disputeId: d.id,
    type,
    fromStatus: input.to ? d.status : null,
    toStatus: input.to ?? null,
    actorType: actor.type,
    actorUserId: actor.userId,
    note: input.note?.trim() || null,
    data: input.data ?? {},
  });
}

async function move(db: Executor, d: Dispute, actor: DisputeActor, from: Status[], to: Status, type: (typeof s.disputeEventType.enumValues)[number], patch: Partial<typeof s.disputes.$inferInsert> = {}, note?: string | null, data?: Record<string, unknown>) {
  if (!from.includes(d.status)) throw new AppError(409, 'INVALID_DISPUTE_STATUS', `This dispute is ${d.status}`, { status: d.status });
  const [updated] = await db.update(s.disputes).set({ status: to, ...patch }).where(eq(s.disputes.id, d.id)).returning();
  await event(db, d, actor, type, { to, note, data });
  await recordEvent(db, { type: 'disputes.dispute.status_changed', aggregateType: 'dispute', aggregateId: d.id, payload: { number: d.number, from: d.status, to } });
  return updated!;
}

/** Which side of the dispute the actor is on. */
export function sideOf(d: Dispute, actor: DisputeActor): Side {
  if (actor.type === 'platform' || actor.type === 'system') return 'aruma';
  const claimantIsCustomer = d.kind === 'customer_merchant';
  if (actor.type === 'customer') return claimantIsCustomer ? 'claimant' : 'respondent';
  return claimantIsCustomer ? 'respondent' : 'claimant';
}

/** The dispute as this actor may see it; others get 404. Merchant disputes are for owners and managers. */
async function load(db: Executor, actor: DisputeActor, id: string, lock = false): Promise<Dispute> {
  const where: SQL[] = [eq(s.disputes.id, id)];
  if (actor.type === 'customer') where.push(eq(s.disputes.customerUserId, actor.userId!));
  if (actor.type === 'merchant') {
    await requireMembership(db, actor.merchantId!, actor.userId!, ['owner', 'manager']);
    where.push(eq(s.disputes.merchantId, actor.merchantId!));
  }
  const query = db.select().from(s.disputes).where(and(...where));
  const [d] = lock ? await query.for('update') : await query;
  if (!d) throw notFound('Dispute');
  return d;
}

export const assertDisputeAccess = (db: Executor, actor: DisputeActor, id: string) => load(db, actor, id).then(() => undefined);

// --- Opening ----------------------------------------------------------------------------------------------

export type OpenInput = {
  kind: Kind;
  category: string;
  orderId?: string;
  returnId?: string;
  references?: Record<string, string>;
  subject: string;
  description: string;
  requestedRemedy: Remedy;
  requestedAmountMinor?: number;
};

export async function openDispute(db: Database, actor: DisputeActor & { userId: string }, input: OpenInput) {
  const expected: Record<Kind, DisputeActor['type']> = { customer_merchant: 'customer', merchant_customer: 'merchant', merchant_aruma: 'merchant' };
  if (expected[input.kind] !== actor.type) throw forbidden('This kind of dispute is opened by the other party');
  if (!CATEGORIES[input.kind].includes(input.category)) throw badRequest('INVALID_CATEGORY', 'Unknown category for this kind of dispute');
  if (!REMEDIES[input.kind].includes(input.requestedRemedy)) throw badRequest('INVALID_REMEDY', 'This remedy cannot be asked in this kind of dispute');
  if (actor.type === 'merchant') await requireMembership(db, actor.merchantId!, actor.userId, ['owner', 'manager']);

  let order: typeof s.orders.$inferSelect | undefined;
  if (input.orderId) {
    [order] = await db.select().from(s.orders).where(eq(s.orders.id, input.orderId));
    const mine = order && (actor.type === 'customer' ? order.customerUserId === actor.userId : order.merchantId === actor.merchantId);
    if (!order || !mine) throw notFound('Order');
    if (order.status === 'new') throw new AppError(409, 'TOO_EARLY', 'The order has not been confirmed yet: cancel it instead');
    if (Date.now() - order.placedAt.getTime() > OPEN_FOR_DAYS * 24 * 3600_000) throw new AppError(409, 'TOO_LATE', `Disputes are opened within ${OPEN_FOR_DAYS} days of the order`);
  } else if (input.kind !== 'merchant_aruma') {
    throw badRequest('ORDER_REQUIRED', 'Say which order the dispute is about');
  }
  if (input.requestedRemedy !== 'none' && input.requestedRemedy !== 'merchant_compensation' && !input.requestedAmountMinor) {
    throw badRequest('AMOUNT_REQUIRED', 'Say how much you ask for');
  }
  if (order) {
    const [same] = await db
      .select({ number: s.disputes.number })
      .from(s.disputes)
      .where(and(eq(s.disputes.orderId, order.id), eq(s.disputes.kind, input.kind), inArray(s.disputes.status, LIVE)));
    if (same) throw new AppError(409, 'DISPUTE_EXISTS', 'A dispute about this order is already open', { number: same.number });
  }
  const merchantId = order?.merchantId ?? actor.merchantId!;
  const [merchant] = await db.select({ country: s.merchants.country }).from(s.merchants).where(eq(s.merchants.id, merchantId));
  const [country] = await db.select({ currency: s.countries.defaultCurrency }).from(s.countries).where(eq(s.countries.code, merchant!.country));

  return db.transaction(async (tx) => {
    const [d] = await tx
      .insert(s.disputes)
      .values({
        number: await nextNumber(tx),
        kind: input.kind,
        category: input.category,
        openedBy: actor.userId,
        merchantId,
        customerUserId: input.kind === 'merchant_aruma' ? null : order!.customerUserId,
        orderId: order?.id ?? null,
        returnId: input.returnId ?? null,
        references: input.references ?? {},
        subject: input.subject,
        description: input.description,
        requestedRemedy: input.requestedRemedy,
        requestedAmountMinor: input.requestedAmountMinor === undefined ? null : BigInt(input.requestedAmountMinor),
        currency: order?.currency ?? country!.currency,
        respondDueAt: new Date(Date.now() + RESPOND_HOURS * 3600_000),
      })
      .returning();
    await event(tx, d!, actor, 'opened', { data: { kind: input.kind, category: input.category, remedy: input.requestedRemedy } });
    await audit(tx, actor, { action: 'disputes.dispute.opened', entityType: 'dispute', entityId: d!.id, metadata: { kind: input.kind } });
    return d!;
  });
}

// --- Messages and files -------------------------------------------------------------------------------

export async function postMessage(db: Database, actor: DisputeActor, id: string, input: { body: string; internal?: boolean }) {
  return db.transaction(async (tx) => {
    const d = await load(tx, actor, id, true);
    if (!LIVE.includes(d.status)) throw new AppError(409, 'DISPUTE_CLOSED', 'This dispute is closed');
    const internal = Boolean(input.internal) && actor.type === 'platform';
    const [message] = await tx.insert(s.disputeMessages).values({ disputeId: d.id, authorType: actor.type, authorUserId: actor.userId, body: input.body.trim(), internal }).returning();
    await event(tx, d, actor, 'message', { data: { messageId: message!.id, internal } });
    // The respondent's first answer stops the response clock.
    const side = sideOf(d, actor);
    const respondentIsAruma = d.kind === 'merchant_aruma';
    if (!d.respondedAt && !internal && (side === 'respondent' || (respondentIsAruma && side === 'aruma'))) {
      await tx.update(s.disputes).set({ respondedAt: new Date() }).where(eq(s.disputes.id, d.id));
      await event(tx, d, actor, 'responded');
    }
    return message!;
  });
}

export async function addFile(
  db: Database,
  deps: { storage: FileStorage; secrets: SecretBox },
  actor: DisputeActor,
  id: string,
  input: { kind: 'evidence' | 'document'; messageId?: string; internal?: boolean; body: Buffer; fileName: string | null },
) {
  const d = await load(db, actor, id);
  if (!LIVE.includes(d.status)) throw new AppError(409, 'DISPUTE_CLOSED', 'This dispute is closed');
  const contentType = detectContentType(input.body);
  if (!contentType) throw badRequest('UNSUPPORTED_FILE_TYPE', 'Upload a JPEG, PNG, WebP or PDF file');
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(s.disputeFiles).where(eq(s.disputeFiles.disputeId, d.id))) as [{ n: number }];
  if (n >= MAX_FILES) throw new AppError(409, 'TOO_MANY_FILES', `At most ${MAX_FILES} files per dispute`);
  if (input.messageId) {
    const [m] = await db.select().from(s.disputeMessages).where(and(eq(s.disputeMessages.id, input.messageId), eq(s.disputeMessages.disputeId, d.id), eq(s.disputeMessages.authorUserId, actor.userId!)));
    if (!m) throw notFound('Message');
  }
  const fileId = randomUUID();
  const storageKey = `disputes/${d.id}/${fileId}`;
  await deps.storage.put(storageKey, deps.secrets.sealBytes(input.body)); // encrypted at rest
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(s.disputeFiles)
      .values({
        id: fileId,
        disputeId: d.id,
        messageId: input.messageId ?? null,
        kind: input.kind,
        uploaderType: actor.type,
        uploadedBy: actor.userId,
        internal: Boolean(input.internal) && actor.type === 'platform',
        storageKey,
        fileName: input.fileName?.slice(0, 200) ?? null,
        contentType,
        sizeBytes: input.body.length,
        sha256: createHash('sha256').update(input.body).digest('hex'),
      })
      .returning();
    await event(tx, d, actor, 'file_added', { data: { fileId, kind: input.kind, sha256: row!.sha256, internal: row!.internal } });
    const { storageKey: _k, ...visible } = row!;
    return visible;
  });
}

export async function readFile(db: Database, deps: { storage: FileStorage; secrets: SecretBox }, actor: DisputeActor, id: string, fileId: string) {
  const d = await load(db, actor, id);
  const [row] = await db.select().from(s.disputeFiles).where(and(eq(s.disputeFiles.id, fileId), eq(s.disputeFiles.disputeId, d.id)));
  if (!row || (row.internal && actor.type !== 'platform')) throw notFound('File');
  return { row, body: deps.secrets.openBytes(await deps.storage.get(row.storageKey)) };
}

// --- Steps --------------------------------------------------------------------------------------------

/** A party asks ARUMA to decide. */
export async function escalateDispute(db: Database, actor: DisputeActor, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const d = await load(tx, actor, id, true);
    return move(tx, d, actor, ['open'], 'under_review', 'escalated', { escalatedAt: new Date(), escalationReason: reason }, reason);
  });
}

export async function withdrawDispute(db: Database, actor: DisputeActor, id: string, note: string) {
  return db.transaction(async (tx) => {
    const d = await load(tx, actor, id, true);
    if (sideOf(d, actor) !== 'claimant') throw forbidden('Only the party who opened the dispute can withdraw it');
    return move(tx, d, actor, ['open', 'under_review'], 'withdrawn', 'withdrawn', { resolvedAt: new Date() }, note);
  });
}

export type DecisionInput = { outcome: Outcome; remedy: Remedy; amountMinor?: number; text: string };

async function checkRemedy(db: Executor, d: Dispute, input: { outcome: Outcome; remedy: Remedy; amountMinor?: number }) {
  if (input.outcome === 'respondent' && input.remedy !== 'none' && d.kind === 'customer_merchant') {
    throw badRequest('INVALID_REMEDY', 'A decision for the merchant gives the customer nothing');
  }
  if (input.remedy === 'none') return;
  const amount = BigInt(input.amountMinor ?? 0);
  if (amount <= 0n) throw badRequest('AMOUNT_REQUIRED', 'Give the amount of the remedy');
  if (input.remedy === 'merchant_compensation') {
    if (d.kind === 'customer_merchant') throw badRequest('INVALID_REMEDY', 'Compensation is for merchants');
    return;
  }
  if (!d.orderId || !d.customerUserId) throw badRequest('INVALID_REMEDY', 'Refunds and store credit need an order');
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, d.orderId));
  const valueLeft = order!.totalMinor - order!.refundedMinor - order!.creditReturnedMinor;
  const moneyLeft = order!.totalMinor - order!.creditAppliedMinor - order!.refundedMinor;
  const limit = input.remedy === 'refund' ? (moneyLeft < valueLeft ? moneyLeft : valueLeft) : valueLeft;
  if (amount > limit) throw new AppError(409, 'REMEDY_EXCEEDS_ORDER', 'More than what can still be given back for this order', { limitMinor: Number(limit) });
}

/** ARUMA's decision (administrators). The appeal window opens; when nobody can appeal, it is final at once. */
export async function decideDispute(db: Database, deps: OrderDeps, actor: DisputeActor & { userId: string }, id: string, input: DecisionInput) {
  const decided = await db.transaction(async (tx) => {
    const d = await load(tx, actor, id, true);
    await checkRemedy(tx, d, input);
    const now = new Date();
    return move(tx, d, actor, ['open', 'under_review'], 'decided', 'decided', {
      outcome: input.outcome,
      remedy: input.remedy,
      remedyAmountMinor: input.remedy === 'none' ? null : BigInt(input.amountMinor!),
      decisionText: input.text,
      decidedBy: actor.userId,
      decidedAt: now,
      appealDueAt: new Date(now.getTime() + APPEAL_DAYS * 24 * 3600_000),
    }, input.text, { outcome: input.outcome, remedy: input.remedy, amountMinor: input.amountMinor ?? null });
  });
  // e.g. a merchant who wins against ARUMA: ARUMA never appeals its own decision.
  if (appealable(decided).length === 0) return resolveDispute(db, deps, { type: 'system', userId: null, ip: null }, id, 'nobody can appeal');
  return decided;
}

/** Sides that may appeal: whoever did not fully win (ARUMA never appeals its own decision). */
function appealable(d: Dispute): Side[] {
  const sides: Side[] = d.outcome === 'claimant' ? ['respondent'] : d.outcome === 'respondent' ? ['claimant'] : ['claimant', 'respondent'];
  return d.kind === 'merchant_aruma' ? sides.filter((x) => x === 'claimant') : sides;
}

export async function appealDispute(db: Database, actor: DisputeActor, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const d = await load(tx, actor, id, true);
    if (d.appealedAt) throw new AppError(409, 'ALREADY_APPEALED', 'A dispute can be appealed once');
    if (d.status !== 'decided') throw new AppError(409, 'INVALID_DISPUTE_STATUS', `This dispute is ${d.status}`, { status: d.status });
    if (d.appealDueAt && Date.now() > d.appealDueAt.getTime()) throw new AppError(409, 'APPEAL_WINDOW_CLOSED', 'The appeal period has ended');
    if (!appealable(d).includes(sideOf(d, actor))) throw forbidden('Only a party who did not win can appeal');
    return move(tx, d, actor, ['decided'], 'appealed', 'appealed', { appealedBy: actor.userId, appealedAt: new Date(), appealReason: reason }, reason);
  });
}

/** A party who could appeal accepts the decision; once nobody can appeal any more, it is executed. */
export async function acceptDecision(db: Database, deps: OrderDeps, actor: DisputeActor, id: string) {
  const ready = await db.transaction(async (tx) => {
    const d = await load(tx, actor, id, true);
    if (d.status !== 'decided') throw new AppError(409, 'INVALID_DISPUTE_STATUS', `This dispute is ${d.status}`);
    const side = sideOf(d, actor);
    if (!appealable(d).includes(side)) throw forbidden('Only a party who could appeal accepts the decision');
    if ((await tx.select({ id: s.disputeEvents.id }).from(s.disputeEvents).where(and(eq(s.disputeEvents.disputeId, d.id), eq(s.disputeEvents.type, 'accepted'), sql`${s.disputeEvents.data}->>'side' = ${side}`))).length) {
      throw new AppError(409, 'ALREADY_ACCEPTED', 'You already accepted this decision');
    }
    await event(tx, d, actor, 'accepted', { data: { side } });
    const accepted = await tx
      .select({ data: s.disputeEvents.data })
      .from(s.disputeEvents)
      .where(and(eq(s.disputeEvents.disputeId, d.id), eq(s.disputeEvents.type, 'accepted')));
    return appealable(d).every((x) => accepted.some((a) => a.data.side === x));
  });
  if (ready) await resolveDispute(db, deps, { type: 'system', userId: null, ip: null }, id, 'decision');
  return load(db, actor, id);
}

/** The appeal is decided by another administrator: the decision is upheld, overturned or modified, then executed. */
export async function decideAppeal(db: Database, deps: OrderDeps, actor: DisputeActor & { userId: string }, id: string, input: { result: 'upheld' | 'overturned' | 'modified'; outcome?: Outcome; remedy?: Remedy; amountMinor?: number; text: string }) {
  await db.transaction(async (tx) => {
    const d = await load(tx, actor, id, true);
    if (d.status !== 'appealed') throw new AppError(409, 'INVALID_DISPUTE_STATUS', `This dispute is ${d.status}`);
    if (d.decidedBy === actor.userId) throw forbidden('An appeal is decided by another administrator');
    const changes = input.result === 'upheld' ? {} : { outcome: input.outcome, remedy: input.remedy, amountMinor: input.amountMinor };
    if (input.result !== 'upheld') {
      if (!input.outcome || !input.remedy) throw badRequest('DECISION_REQUIRED', 'Give the new outcome and remedy');
      await checkRemedy(tx, d, { outcome: input.outcome, remedy: input.remedy, amountMinor: input.amountMinor });
    }
    await tx
      .update(s.disputes)
      .set({
        appealOutcome: input.result,
        appealDecisionText: input.text,
        appealDecidedBy: actor.userId,
        appealDecidedAt: new Date(),
        ...(input.result === 'upheld'
          ? {}
          : { remedy: input.remedy, remedyAmountMinor: input.remedy === 'none' ? null : BigInt(input.amountMinor!) }),
        appealNewOutcome: input.result === 'upheld' ? d.outcome : input.outcome,
      })
      .where(eq(s.disputes.id, d.id));
    await event(tx, d, actor, 'appeal_decided', { note: input.text, data: { result: input.result, ...changes } });
  });
  return resolveDispute(db, deps, actor, id, 'appeal');
}

/** Decisions whose appeal window has ended become final. Run periodically. */
export async function finalizeDueDisputes(db: Database, deps: OrderDeps, now = new Date()) {
  const due = await db.select({ id: s.disputes.id }).from(s.disputes).where(and(eq(s.disputes.status, 'decided'), lt(s.disputes.appealDueAt, now)));
  for (const { id } of due) await resolveDispute(db, deps, { type: 'system', userId: null, ip: null }, id, 'appeal window ended');
  return due.length;
}

/** Disputes left unanswered go to ARUMA. Run periodically. */
export async function escalateUnanswered(db: Database, now = new Date()) {
  const due = await db
    .select({ id: s.disputes.id })
    .from(s.disputes)
    .where(and(eq(s.disputes.status, 'open'), lt(s.disputes.respondDueAt, now), sql`${s.disputes.respondedAt} is null`));
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [d] = await tx.select().from(s.disputes).where(eq(s.disputes.id, id)).for('update');
      if (d?.status !== 'open' || d.respondedAt) return;
      await move(tx, d, { type: 'system', userId: null, ip: null }, ['open'], 'under_review', 'escalated', { escalatedAt: now, escalationReason: 'No answer in time' }, 'No answer in time');
    });
  }
  return due.length;
}

// --- Resolution -------------------------------------------------------------------------------------------

/** Final: executes the remedy (once) and closes the dispute. */
async function resolveDispute(db: Database, deps: OrderDeps, actor: DisputeActor, id: string, because: string) {
  let d = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(s.disputes).where(eq(s.disputes.id, id)).for('update');
    if (!current) throw notFound('Dispute');
    const remedy = current.remedy ?? 'none';
    const amount = current.remedyAmountMinor ?? 0n;
    let execution: Dispute['executionStatus'] = 'none';
    if (remedy === 'store_credit') {
      const [order] = await tx.select().from(s.orders).where(eq(s.orders.id, current.orderId!)).for('update');
      await issueStoreCredit(tx, order!, { amountMinor: amount, sourceType: 'dispute', sourceId: current.id, reason: `Dispute ${current.number}`, actorUserId: actor.userId });
      execution = 'done';
    }
    if (remedy === 'merchant_compensation') {
      await postMerchantCompensation(tx, { merchantId: current.merchantId, currency: current.currency, amountMinor: amount, disputeId: current.id, reason: `Compensation, dispute ${current.number}`, createdBy: actor.userId });
      execution = 'done';
    }
    if (remedy === 'refund') execution = 'pending'; // sent just below (outside the transaction)
    const resolved = await move(tx, current, actor, ['decided', 'appealed'], 'resolved', 'resolved', { executionStatus: execution, resolvedAt: new Date() }, because, { remedy, amountMinor: Number(amount) });
    if (execution === 'done') await event(tx, resolved, actor, 'executed', { data: { remedy, amountMinor: Number(amount) } });
    return resolved;
  });
  if (d.remedy === 'refund') d = await sendDisputeRefund(db, deps, actor, id, {}).catch(() => d);
  if (d.orderId && (d.remedy === 'refund' || d.remedy === 'store_credit')) {
    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, d.orderId));
    await markRefundedIfDone(db, deps, { userId: null, ip: null }, order!, `Dispute ${d.number}`);
  }
  return d;
}

/** The refund of a resolved dispute: online through the provider; cash on delivery by transfer, recorded with its reference. */
export async function sendDisputeRefund(db: Database, deps: OrderDeps, actor: DisputeActor, id: string, input: { externalReference?: string }) {
  const [d] = await db.select().from(s.disputes).where(eq(s.disputes.id, id));
  if (!d) throw notFound('Dispute');
  if (d.status !== 'resolved' || d.remedy !== 'refund' || d.executionStatus !== 'pending') throw new AppError(409, 'NOTHING_TO_SEND', 'No refund is waiting for this dispute');
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, d.orderId!));
  if (order!.paymentMethod === 'cash_on_delivery' && !input.externalReference) {
    throw new AppError(409, 'MANUAL_REFUND_REQUIRED', 'Cash-on-delivery orders are refunded by transfer; record its reference');
  }
  const { refundId } = await refundOrder(db, deps, { userId: actor.userId, ip: actor.ip }, order!.id, `dispute-${d.id}`, {
    amountMinor: Number(d.remedyAmountMinor),
    reason: `Dispute ${d.number}`,
    externalReference: input.externalReference,
  });
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(s.disputes)
      .set({ executionStatus: 'done', paymentRefundId: refundId, executionReference: input.externalReference ?? null })
      .where(eq(s.disputes.id, d.id))
      .returning();
    await event(tx, d, actor, input.externalReference ? 'execution_recorded' : 'executed', { note: input.externalReference, data: { remedy: 'refund', refundId } });
    return updated!;
  });
}

// --- Reading ----------------------------------------------------------------------------------------------

export async function describeDispute(db: Database, actor: DisputeActor, id: string) {
  const d = await load(db, actor, id);
  const aruma = actor.type === 'platform';
  const [messages, files, events, order, merchant, customer] = [
    await db
      .select({ id: s.disputeMessages.id, authorType: s.disputeMessages.authorType, authorName: s.users.displayName, body: s.disputeMessages.body, internal: s.disputeMessages.internal, createdAt: s.disputeMessages.createdAt })
      .from(s.disputeMessages)
      .leftJoin(s.users, eq(s.users.id, s.disputeMessages.authorUserId))
      .where(and(eq(s.disputeMessages.disputeId, d.id), aruma ? undefined : eq(s.disputeMessages.internal, false)))
      .orderBy(asc(s.disputeMessages.createdAt)),
    await db
      .select({ id: s.disputeFiles.id, messageId: s.disputeFiles.messageId, kind: s.disputeFiles.kind, uploaderType: s.disputeFiles.uploaderType, fileName: s.disputeFiles.fileName, contentType: s.disputeFiles.contentType, sizeBytes: s.disputeFiles.sizeBytes, internal: s.disputeFiles.internal, createdAt: s.disputeFiles.createdAt })
      .from(s.disputeFiles)
      .where(and(eq(s.disputeFiles.disputeId, d.id), aruma ? undefined : eq(s.disputeFiles.internal, false)))
      .orderBy(asc(s.disputeFiles.createdAt)),
    await db
      .select({ type: s.disputeEvents.type, fromStatus: s.disputeEvents.fromStatus, toStatus: s.disputeEvents.toStatus, actorType: s.disputeEvents.actorType, actorName: s.users.displayName, note: s.disputeEvents.note, data: s.disputeEvents.data, createdAt: s.disputeEvents.createdAt })
      .from(s.disputeEvents)
      .leftJoin(s.users, eq(s.users.id, s.disputeEvents.actorUserId))
      .where(eq(s.disputeEvents.disputeId, d.id))
      .orderBy(asc(s.disputeEvents.createdAt)),
    d.orderId ? (await db.select({ number: s.orders.number, totalMinor: s.orders.totalMinor, status: s.orders.status }).from(s.orders).where(eq(s.orders.id, d.orderId)))[0] : undefined,
    (await db.select({ name: s.merchants.name }).from(s.merchants).where(eq(s.merchants.id, d.merchantId)))[0],
    d.customerUserId ? (await db.select({ name: s.users.displayName }).from(s.users).where(eq(s.users.id, d.customerUserId)))[0] : undefined,
  ];
  // ARUMA staff speak as "ARUMA" to the parties, and the merchant's team as the shop to customers;
  // internal notes and internal events stay inside ARUMA.
  const hideStaff = <T extends { authorType?: string; actorType?: string }>(row: T, nameKey: 'authorName' | 'actorName') => {
    const type = row.authorType ?? row.actorType;
    if (!aruma && type === 'platform') return { ...row, [nameKey]: null };
    if (actor.type === 'customer' && type === 'merchant') return { ...row, [nameKey]: merchant!.name };
    return row;
  };
  const money = (v: bigint | null) => (v === null ? null : Number(v));
  const side = sideOf(d, actor);
  return {
    id: d.id,
    number: d.number,
    kind: d.kind,
    category: d.category,
    status: d.status,
    side,
    merchant: merchant!.name,
    customer: customer?.name ?? null,
    order: order ? { id: d.orderId, number: order.number, totalMinor: Number(order.totalMinor), status: order.status } : null,
    returnId: d.returnId,
    references: d.references,
    subject: d.subject,
    description: d.description,
    requestedRemedy: d.requestedRemedy,
    requestedAmountMinor: money(d.requestedAmountMinor),
    currency: d.currency,
    respondDueAt: d.respondDueAt,
    respondedAt: d.respondedAt,
    escalationReason: d.escalationReason,
    decision: d.decidedAt ? { outcome: d.outcome, remedy: d.remedy, amountMinor: money(d.remedyAmountMinor), text: d.decisionText, decidedAt: d.decidedAt, appealDueAt: d.appealDueAt } : null,
    appeal: d.appealedAt ? { reason: d.appealReason, at: d.appealedAt, result: d.appealOutcome, outcome: d.appealNewOutcome, text: d.appealDecisionText, decidedAt: d.appealDecidedAt } : null,
    /** Final outcome and remedy (after the appeal, if any). */
    finalOutcome: d.appealNewOutcome ?? d.outcome,
    canAppeal: d.status === 'decided' && !d.appealedAt && appealable(d).includes(side) && Boolean(d.appealDueAt && d.appealDueAt.getTime() > Date.now()),
    execution: { status: d.executionStatus, reference: aruma ? d.executionReference : undefined },
    resolvedAt: d.resolvedAt,
    messages: messages.map((m) => hideStaff(m, 'authorName')),
    files,
    events: events.filter((e) => aruma || !(e.data as { internal?: boolean }).internal).map((e) => hideStaff(e, 'actorName')),
    createdAt: d.createdAt,
  };
}

export async function listDisputes(db: Database, actor: DisputeActor, q: { status?: Status; kind?: Kind; page: number; pageSize: number }) {
  const where: SQL[] = [];
  if (actor.type === 'customer') where.push(eq(s.disputes.customerUserId, actor.userId!));
  if (actor.type === 'merchant') {
    await requireMembership(db, actor.merchantId!, actor.userId!, ['owner', 'manager']);
    where.push(eq(s.disputes.merchantId, actor.merchantId!));
  }
  if (q.status) where.push(eq(s.disputes.status, q.status));
  if (q.kind) where.push(eq(s.disputes.kind, q.kind));
  const rows = await db
    .select()
    .from(s.disputes)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.disputes.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return rows.map((d) => ({
    id: d.id,
    number: d.number,
    kind: d.kind,
    category: d.category,
    status: d.status,
    side: sideOf(d, actor),
    subject: d.subject,
    requestedRemedy: d.requestedRemedy,
    outcome: d.appealNewOutcome ?? d.outcome,
    respondDueAt: d.respondDueAt,
    respondedAt: d.respondedAt,
    createdAt: d.createdAt,
  }));
}

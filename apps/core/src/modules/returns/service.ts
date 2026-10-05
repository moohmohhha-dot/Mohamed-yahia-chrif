/**
 * Returns, step by step:
 *
 *   draft ─submit─► requested ─merchant approves─► approved ─pickup / drop-off─► in_transit ─► received ─inspection─► completed
 *                       │                              │ (keep_item: resolved at once)                      │            (refund_pending
 *                       │                              │                                                  │             while money is sent)
 *                       ├─merchant rejects─► rejected ─customer escalates─┐                               └─failed─► inspection_failed
 *                       └─no answer in time─────────────────────────────► under_review ◄─customer escalates──────────┘
 *                                                                           └─ARUMA decides: approve (or resolve) / reject (final)
 *
 * Resolutions: refund (full or partial, through the Payment Service; what was paid with store credit
 * comes back as credit), replacement (a free new order), store credit.
 * The merchant decides on its returns; ARUMA arbitrates disputes; money only moves through ARUMA.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { schema as s, type Database, type ShipmentDestination } from '@aruma/db';
import type { Executor, Transaction } from '../../shared/db.js';
import { AppError, badRequest, notFound } from '../../shared/errors.js';
import { issueStoreCredit } from '../finance/index.js';
import { receiveReturn } from '../inventory/index.js';
import { requireMembership, type MerchantRole } from '../merchants/index.js';
import { markRefundedIfDone, placeReplacementOrder, refundOrder, transitionOrder, type OrderDeps } from '../orders/index.js';
import { audit, detectContentType, recordEvent, type FileStorage, type SecretBox } from '../platform/index.js';
import { activeReturnShipment, openReturnShipment, recordShipmentStatus, describeShipment, type ShipmentStatus } from '../shipping/index.js';
import { returnPolicy } from './policy.js';

type Return = typeof s.returnRequests.$inferSelect;
type Order = typeof s.orders.$inferSelect;
export type ReturnStatus = Return['status'];
export type Reason = Return['reason'];
export type Resolution = NonNullable<Return['resolution']>;
export type ReturnMethod = NonNullable<Return['returnMethod']>;
export type ReturnActor = { type: 'customer' | 'merchant' | 'platform' | 'system'; userId: string | null; ip: string | null; merchantId?: string };

/** Reasons where the merchant is at fault: evidence is required, and delivery is refunded when everything comes back. */
export const FAULT_REASONS: Reason[] = ['damaged', 'defective', 'wrong_item', 'not_as_described', 'missing_parts', 'counterfeit_suspected'];
const MAX_EVIDENCE = 10;
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
/** Returns that still hold their items (a new return for the same items is refused). */
const CLOSED: ReturnStatus[] = ['cancelled'];

// --- Helpers ----------------------------------------------------------------------------------------------

async function nextReturnNumber(tx: Executor) {
  const [row] = await tx.execute<{ n: string }>(sql`select nextval('return_number_seq')::text as n`).then((r) => r.rows);
  return `RT-${new Date().getUTCFullYear()}-${row!.n.padStart(6, '0')}`;
}

async function event(
  tx: Executor,
  ret: Return,
  actor: ReturnActor,
  input: { type: (typeof s.returnEventType.enumValues)[number]; to?: ReturnStatus; note?: string | null; data?: Record<string, unknown> },
) {
  await tx.insert(s.returnEvents).values({
    returnId: ret.id,
    type: input.type,
    fromStatus: input.to ? ret.status : null,
    toStatus: input.to ?? null,
    actorType: actor.type,
    actorUserId: actor.userId,
    note: input.note?.trim() || null,
    data: input.data ?? {},
  });
}

/** Changes the status (checking where it comes from) and records the event. */
async function move(
  tx: Executor,
  ret: Return,
  actor: ReturnActor,
  from: ReturnStatus[],
  to: ReturnStatus,
  type: (typeof s.returnEventType.enumValues)[number],
  patch: Partial<typeof s.returnRequests.$inferInsert> = {},
  note?: string | null,
  data?: Record<string, unknown>,
) {
  if (!from.includes(ret.status)) {
    throw new AppError(409, 'INVALID_RETURN_STATUS', `This return is ${ret.status}`, { status: ret.status, expected: from });
  }
  const [updated] = await tx.update(s.returnRequests).set({ status: to, ...patch }).where(eq(s.returnRequests.id, ret.id)).returning();
  await event(tx, ret, actor, { type, to, note, data });
  await recordEvent(tx, { type: 'returns.return.status_changed', aggregateType: 'return', aggregateId: ret.id, payload: { number: ret.number, from: ret.status, to } });
  return updated!;
}

/** The return as this actor may see it; anyone else gets 404. Merchant roles are checked here. */
async function load(db: Executor, actor: ReturnActor, returnId: string, lock = false, roles?: MerchantRole[]): Promise<Return> {
  const where: SQL[] = [eq(s.returnRequests.id, returnId)];
  if (actor.type === 'customer') where.push(eq(s.returnRequests.customerUserId, actor.userId!));
  if (actor.type === 'merchant') {
    await requireMembership(db, actor.merchantId!, actor.userId!, roles);
    // Drafts belong to the customer until submitted.
    where.push(eq(s.returnRequests.merchantId, actor.merchantId!), ne(s.returnRequests.status, 'draft'));
  }
  const query = db.select().from(s.returnRequests).where(and(...where));
  const [ret] = lock ? await query.for('update') : await query;
  if (!ret) throw notFound('Return');
  return ret;
}

/** Checks that the actor may act on this return (before reading an upload, for example). */
export const assertReturnAccess = (db: Executor, actor: ReturnActor, returnId: string) => load(db, actor, returnId).then(() => undefined);

const orderOf = async (db: Executor, orderId: string, lock = false) => {
  const query = db.select().from(s.orders).where(eq(s.orders.id, orderId));
  const [order] = lock ? await query.for('update') : await query;
  return order!;
};

/** What can still be given back on the order (money and credit together). */
const valueLeft = (o: Order) => o.totalMinor - o.refundedMinor - o.creditReturnedMinor;

/** Amount due if the items pass inspection: their value, minus the change-of-mind fee. */
function dueAmount(ret: Return, order: Order, fee: bigint) {
  let amount = ret.itemsValueMinor - (ret.reason === 'changed_mind' ? fee : 0n);
  if (amount < 0n) amount = 0n;
  const left = valueLeft(order);
  return amount > left ? left : amount;
}

// --- Customer ---------------------------------------------------------------------------------------------

export type CreateReturnInput = {
  lines: { orderLineId: string; quantity: number }[];
  reason: Reason;
  description: string;
  resolution: Resolution;
};

/** Starts a return (draft): checks the window, the items and the quantities not already returned. */
export async function createReturn(db: Database, actor: ReturnActor, orderId: string, input: CreateReturnInput) {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(s.orders)
      .where(and(eq(s.orders.id, orderId), eq(s.orders.customerUserId, actor.userId!)))
      .for('update');
    if (!order) throw notFound('Order');
    if (order.status !== 'delivered') throw new AppError(409, 'NOT_RETURNABLE', 'Only delivered orders can be returned', { status: order.status });
    if (order.totalMinor === 0n && input.resolution !== 'replacement') {
      throw new AppError(409, 'NOT_RETURNABLE', 'A free replacement can only be exchanged again');
    }
    const policy = await returnPolicy(tx, order.storeId);
    const [delivered] = await tx
      .select({ at: s.orderStatusHistory.createdAt })
      .from(s.orderStatusHistory)
      .where(and(eq(s.orderStatusHistory.orderId, order.id), eq(s.orderStatusHistory.toStatus, 'delivered')))
      .orderBy(desc(s.orderStatusHistory.createdAt))
      .limit(1);
    const closesAt = new Date(delivered!.at.getTime() + policy.windowDays * 24 * 3600_000);
    if (Date.now() > closesAt.getTime()) {
      throw new AppError(409, 'RETURN_WINDOW_CLOSED', `Returns are accepted for ${policy.windowDays} days after delivery`, { closedAt: closesAt.toISOString() });
    }
    if (input.reason === 'changed_mind' && !policy.allowChangeOfMind) {
      throw new AppError(409, 'CHANGE_OF_MIND_NOT_ACCEPTED', 'This store does not accept returns for a change of mind');
    }

    const orderLines = await tx.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
    const taken = await returnedQuantities(tx, order.id);
    const wanted = new Map<string, number>();
    for (const l of input.lines) wanted.set(l.orderLineId, (wanted.get(l.orderLineId) ?? 0) + l.quantity);
    let value = 0n;
    for (const [lineId, quantity] of wanted) {
      const line = orderLines.find((l) => l.id === lineId);
      if (!line) throw badRequest('UNKNOWN_LINE', 'This item is not in the order');
      const left = line.quantity - (taken.get(lineId) ?? 0);
      if (quantity > left) throw new AppError(409, 'QUANTITY_EXCEEDS_ORDER', 'More items than bought (or already in a return)', { orderLineId: lineId, available: left });
      value += line.unitPriceMinor * BigInt(quantity);
    }
    // Everything comes back because of the merchant: the delivery is refunded too.
    const everything = orderLines.every((l) => (taken.get(l.id) ?? 0) + (wanted.get(l.id) ?? 0) === l.quantity);
    if (everything && FAULT_REASONS.includes(input.reason)) value += order.shippingMinor;
    if (value <= 0n && input.resolution !== 'replacement') throw new AppError(409, 'NOT_RETURNABLE', 'Nothing to give back for these items');

    const [ret] = await tx
      .insert(s.returnRequests)
      .values({
        number: await nextReturnNumber(tx),
        orderId: order.id,
        storeId: order.storeId,
        merchantId: order.merchantId,
        customerUserId: order.customerUserId,
        reason: input.reason,
        description: input.description,
        requestedResolution: input.resolution,
        currency: order.currency,
        itemsValueMinor: value > 0n ? value : 1n, // a free replacement still records a symbolic value
      })
      .returning();
    await tx.insert(s.returnLines).values([...wanted].map(([orderLineId, quantity]) => ({ returnId: ret!.id, orderLineId, quantity })));
    await event(tx, ret!, actor, { type: 'created', data: { reason: input.reason, resolution: input.resolution } });
    await audit(tx, actor, { action: 'returns.return.created', entityType: 'return', entityId: ret!.id, metadata: { orderId } });
    return ret!;
  });
}

/** Quantities per order line already in a return that is not cancelled (or finally rejected). */
async function returnedQuantities(db: Executor, orderId: string) {
  const rows = await db
    .select({ orderLineId: s.returnLines.orderLineId, quantity: sql<number>`sum(${s.returnLines.quantity})::int` })
    .from(s.returnLines)
    .innerJoin(s.returnRequests, eq(s.returnRequests.id, s.returnLines.returnId))
    .where(
      and(
        eq(s.returnRequests.orderId, orderId),
        notInArray(s.returnRequests.status, CLOSED),
        sql`not (${s.returnRequests.status} = 'rejected' and ${s.returnRequests.finalDecision})`,
      ),
    )
    .groupBy(s.returnLines.orderLineId);
  return new Map(rows.map((r) => [r.orderLineId, r.quantity]));
}

/** Photos or documents. Customers add them while the return is open; merchants and ARUMA until it is completed. */
export async function addEvidence(
  db: Database,
  deps: { storage: FileStorage; secrets: SecretBox },
  actor: ReturnActor,
  returnId: string,
  file: { body: Buffer; fileName: string | null },
) {
  const ret = await load(db, actor, returnId);
  const open: ReturnStatus[] =
    actor.type === 'customer' ? ['draft', 'requested', 'under_review', 'rejected', 'inspection_failed'] : ['requested', 'under_review', 'approved', 'in_transit', 'received', 'rejected', 'inspection_failed', 'refund_pending'];
  if (!open.includes(ret.status)) throw new AppError(409, 'INVALID_RETURN_STATUS', 'Evidence can no longer be added to this return', { status: ret.status });
  const contentType = detectContentType(file.body);
  if (!contentType) throw badRequest('UNSUPPORTED_FILE_TYPE', 'Upload a JPEG, PNG, WebP or PDF file');
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(s.returnEvidence).where(eq(s.returnEvidence.returnId, ret.id))) as [{ n: number }];
  if (n >= MAX_EVIDENCE) throw new AppError(409, 'TOO_MANY_FILES', `At most ${MAX_EVIDENCE} files per return`);
  const id = randomUUID();
  const storageKey = `returns/${ret.id}/${id}`;
  await deps.storage.put(storageKey, deps.secrets.sealBytes(file.body)); // encrypted at rest
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(s.returnEvidence)
      .values({
        id,
        returnId: ret.id,
        role: actor.type === 'customer' ? 'customer' : actor.type === 'merchant' ? 'merchant' : 'platform',
        storageKey,
        fileName: file.fileName?.slice(0, 200) ?? null,
        contentType,
        sizeBytes: file.body.length,
        sha256: createHash('sha256').update(file.body).digest('hex'),
        uploadedBy: actor.userId,
      })
      .returning();
    await event(tx, ret, actor, { type: 'evidence_added', data: { evidenceId: id, contentType } });
    const { storageKey: _k, ...visible } = row!;
    return visible;
  });
}

export async function readEvidence(db: Database, deps: { storage: FileStorage; secrets: SecretBox }, actor: ReturnActor, returnId: string, evidenceId: string) {
  const ret = await load(db, actor, returnId);
  const [row] = await db.select().from(s.returnEvidence).where(and(eq(s.returnEvidence.id, evidenceId), eq(s.returnEvidence.returnId, ret.id)));
  if (!row) throw notFound('File');
  return { row, body: deps.secrets.openBytes(await deps.storage.get(row.storageKey)) };
}

/** Sends the request to the merchant; evidence is required when the merchant is said to be at fault. */
export async function submitReturn(db: Database, actor: ReturnActor, returnId: string) {
  return db.transaction(async (tx) => {
    const ret = await load(tx, actor, returnId, true);
    if (FAULT_REASONS.includes(ret.reason)) {
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.returnEvidence)
        .where(and(eq(s.returnEvidence.returnId, ret.id), eq(s.returnEvidence.role, 'customer')))) as [{ n: number }];
      if (n === 0) throw badRequest('EVIDENCE_REQUIRED', 'Add at least one photo of the problem');
    }
    const policy = await returnPolicy(tx, ret.storeId);
    const now = new Date();
    return move(tx, ret, actor, ['draft'], 'requested', 'submitted', {
      submittedAt: now,
      responseDueAt: new Date(now.getTime() + policy.merchantResponseHours * 3600_000),
    });
  });
}

export async function cancelReturn(db: Database, actor: ReturnActor, returnId: string, note?: string) {
  return db.transaction(async (tx) => {
    const ret = await load(tx, actor, returnId, true);
    if (ret.status === 'approved' && (await activeReturnShipment(tx, ret.id))) {
      throw new AppError(409, 'PICKUP_IN_PROGRESS', 'A pickup is already arranged for this return');
    }
    return move(tx, ret, actor, ['draft', 'requested', 'under_review', 'approved', 'rejected', 'inspection_failed'], 'cancelled', 'cancelled', {}, note);
  });
}

/** The customer asks ARUMA to look at a rejection or a failed inspection. */
export async function escalateReturn(db: Database, actor: ReturnActor, returnId: string, reason: string) {
  return db.transaction(async (tx) => {
    const ret = await load(tx, actor, returnId, true);
    if (ret.finalDecision) throw new AppError(409, 'FINAL_DECISION', 'ARUMA already decided on this return');
    if (ret.escalatedAt) throw new AppError(409, 'ALREADY_ESCALATED', 'This return was already escalated');
    const policy = await returnPolicy(tx, ret.storeId);
    const since = (ret.status === 'rejected' ? ret.merchantRespondedAt : ret.inspectedAt) ?? ret.updatedAt;
    if (Date.now() > since.getTime() + policy.escalationDays * 24 * 3600_000) {
      throw new AppError(409, 'ESCALATION_WINDOW_CLOSED', `Escalation is possible for ${policy.escalationDays} days`);
    }
    return move(tx, ret, actor, ['rejected', 'inspection_failed'], 'under_review', 'escalated', { escalatedAt: new Date(), escalationReason: reason }, reason);
  });
}

// --- Merchant -------------------------------------------------------------------------------------------

/** The merchant accepts (with the way the item comes back) or refuses, with a reason. */
export async function respondToReturn(
  db: Database,
  deps: OrderDeps,
  actor: ReturnActor,
  returnId: string,
  input: { decision: 'approve' | 'reject'; resolution?: Resolution; returnMethod?: ReturnMethod; note?: string },
) {
  const done = await db.transaction(async (tx) => {
    // Accepting or refusing a return is a decision for owners and managers.
    const ret = await load(tx, actor, returnId, true, ['owner', 'manager']);
    if (input.decision === 'reject') {
      if (!input.note?.trim()) throw badRequest('REASON_REQUIRED', 'Explain why the return is refused');
      return { ret: await move(tx, ret, actor, ['requested'], 'rejected', 'merchant_rejected', { merchantNote: input.note, merchantRespondedAt: new Date() }, input.note), settle: false };
    }
    const approved = await approve(tx, actor, ret, ['requested'], 'merchant_approved', input, { merchantNote: input.note ?? null, merchantRespondedAt: new Date() });
    return { ret: approved, settle: approved.returnMethod === 'keep_item' };
  });
  // The customer keeps the item (e.g. not worth sending back): resolved at once.
  if (done.settle) await settleReturn(db, deps, actor, returnId, {});
  return done.ret;
}

/** Accepted resolutions: what the customer asked for, or a refund (never less favourable for the customer). */
async function approve(
  tx: Executor,
  actor: ReturnActor,
  ret: Return,
  from: ReturnStatus[],
  type: 'merchant_approved' | 'admin_approved',
  input: { resolution?: Resolution; returnMethod?: ReturnMethod; note?: string },
  patch: Partial<typeof s.returnRequests.$inferInsert>,
) {
  const resolution = input.resolution ?? ret.requestedResolution;
  if (resolution !== ret.requestedResolution && resolution !== 'refund') {
    throw badRequest('RESOLUTION_NOT_ALLOWED', 'Approve what the customer asked for, or a refund');
  }
  if (!input.returnMethod) throw badRequest('RETURN_METHOD_REQUIRED', 'Say how the item comes back: pickup, drop-off, or the customer keeps it');
  const order = await orderOf(tx, ret.orderId);
  const policy = await returnPolicy(tx, ret.storeId);
  return move(tx, ret, actor, from, 'approved', type, { ...patch, resolution, returnMethod: input.returnMethod, approvedAmountMinor: dueAmount(ret, order, policy.changeOfMindFeeMinor) }, input.note, {
    resolution,
    returnMethod: input.returnMethod,
  });
}

/** Address the return goes back to: the merchant's return address, or its registered address. */
async function merchantDestination(db: Executor, merchantId: string): Promise<ShipmentDestination> {
  const [merchant] = await db.select().from(s.merchants).where(eq(s.merchants.id, merchantId));
  const addresses = await db.select().from(s.merchantAddresses).where(eq(s.merchantAddresses.merchantId, merchantId));
  const address = addresses.find((a) => a.kind === 'return') ?? addresses.find((a) => a.kind === 'pickup') ?? addresses.find((a) => a.kind === 'registered');
  return { type: 'merchant_location', fullName: merchant!.name, phone: merchant!.contactPhone ?? '', address: { ...address } };
}

/** The merchant (or its courier) collects the item at the customer's address. */
export async function arrangePickup(db: Database, actor: ReturnActor, returnId: string, input: { courierCode?: string; trackingNumber?: string }) {
  return db.transaction(async (tx) => {
    const ret = await load(tx, actor, returnId, true);
    if (ret.status !== 'approved' || ret.returnMethod !== 'pickup') throw new AppError(409, 'INVALID_RETURN_STATUS', 'A pickup is arranged for an approved return with pickup', { status: ret.status });
    const order = await orderOf(tx, ret.orderId);
    const a = order.shippingAddress;
    const shipment = await openReturnShipment(tx, {
      order,
      returnId: ret.id,
      courierCode: input.courierCode ?? null,
      trackingNumber: input.trackingNumber,
      origin: { type: 'address', fullName: a.fullName, phone: a.phone, address: { ...a } },
      destination: await merchantDestination(tx, ret.merchantId),
      source: actor.type === 'merchant' ? 'merchant' : 'platform',
      actorUserId: actor.userId,
    });
    await event(tx, ret, actor, { type: 'pickup_created', data: { shipmentId: shipment.id, courierCode: input.courierCode ?? null } });
    return shipment;
  });
}

/** Pickup progress: collected (in transit), back at the merchant (received), or failed attempts. */
export async function updatePickup(db: Database, actor: ReturnActor, returnId: string, input: { status: ShipmentStatus; trackingNumber?: string; note?: string; location?: string }) {
  return db.transaction(async (tx) => {
    let ret = await load(tx, actor, returnId, true);
    const shipment = await activeReturnShipment(tx, ret.id, true);
    if (!shipment) throw notFound('Pickup');
    const updated = await recordShipmentStatus(tx, shipment, {
      status: input.status,
      source: actor.type === 'merchant' ? 'merchant' : 'platform',
      actorUserId: actor.userId,
      trackingNumber: input.trackingNumber,
      description: input.note,
      location: input.location,
    });
    if (updated && ['in_transit', 'out_for_delivery'].includes(updated.status) && ret.status === 'approved') {
      ret = await move(tx, ret, actor, ['approved'], 'in_transit', 'shipped_back', {}, input.note);
    }
    if (updated?.status === 'delivered') ret = await move(tx, ret, actor, ['approved', 'in_transit'], 'received', 'received', { receivedAt: new Date() }, input.note);
    return ret;
  });
}

/** The item is back with the merchant (dropped off by the customer, or brought by the merchant's driver). */
export async function markReceived(db: Database, actor: ReturnActor, returnId: string, note?: string) {
  return db.transaction(async (tx) => {
    const ret = await load(tx, actor, returnId, true);
    if (ret.returnMethod === 'keep_item') throw new AppError(409, 'INVALID_RETURN_STATUS', 'The customer keeps the item');
    const shipment = await activeReturnShipment(tx, ret.id, true);
    if (shipment && shipment.status !== 'delivered') {
      await recordShipmentStatus(tx, shipment, { status: 'delivered', source: actor.type === 'merchant' ? 'merchant' : 'platform', actorUserId: actor.userId, description: note });
    }
    return move(tx, ret, actor, ['approved', 'in_transit'], 'received', 'received', { receivedAt: new Date() }, note);
  });
}

export type InspectionInput = {
  result: 'passed' | 'failed';
  /** Per returned line: back on sale or not. */
  lines: { returnLineId: string; restock: boolean }[];
  /** Lower than the approved amount = partial refund (with a reason). */
  amountMinor?: number;
  partialReason?: string;
  note?: string;
};

/** The merchant checks the item: passed resolves the return (fully or partially); failed lets the customer escalate. */
export async function inspectReturn(db: Database, deps: OrderDeps, actor: ReturnActor, returnId: string, input: InspectionInput) {
  const ret = await db.transaction(async (tx) => {
    const current = await load(tx, actor, returnId, true, ['owner', 'manager']);
    if (current.status !== 'received') throw new AppError(409, 'INVALID_RETURN_STATUS', 'Inspect a return once the item is back', { status: current.status });
    const lines = await tx.select().from(s.returnLines).where(eq(s.returnLines.returnId, current.id));
    if (lines.some((l) => !input.lines.find((i) => i.returnLineId === l.id))) throw badRequest('RESTOCK_REQUIRED', 'Say for each item whether it goes back on sale');
    // Stock: the goods that can be sold again go back into the warehouse.
    const orderLines = await tx.select().from(s.orderLines).where(inArray(s.orderLines.id, lines.map((l) => l.orderLineId)));
    for (const l of lines) await tx.update(s.returnLines).set({ restock: input.lines.find((i) => i.returnLineId === l.id)!.restock }).where(eq(s.returnLines.id, l.id));
    const restock = lines.filter((l) => input.lines.find((i) => i.returnLineId === l.id)!.restock);
    if (restock.length) {
      await receiveReturn(tx, {
        reference: { type: 'return', id: current.id },
        merchantId: current.merchantId,
        lines: restock.map((l) => ({ offerId: orderLines.find((o) => o.id === l.orderLineId)!.offerId, quantity: l.quantity })),
        actorUserId: actor.userId,
        note: `Return ${current.number}`,
      });
    }
    if (input.result === 'failed') {
      if (!input.note?.trim()) throw badRequest('REASON_REQUIRED', 'Explain what is wrong with the returned item');
      return move(tx, current, actor, ['received'], 'inspection_failed', 'inspected', { inspectedAt: new Date(), inspectionNote: input.note }, input.note, { result: 'failed' });
    }
    return move(tx, current, actor, ['received'], 'received', 'inspected', { inspectedAt: new Date(), inspectionNote: input.note ?? null }, input.note, { result: 'passed' });
  });
  if (input.result === 'passed') return settleReturn(db, deps, actor, ret.id, { amountMinor: input.amountMinor, partialReason: input.partialReason });
  return ret;
}

// --- ARUMA ------------------------------------------------------------------------------------------------

/** ARUMA's decision (final): reject, or approve — resolved at once when the item is already back or kept. */
export async function decideReturn(
  db: Database,
  deps: OrderDeps,
  actor: ReturnActor,
  returnId: string,
  input: { decision: 'approve' | 'reject'; resolution?: Resolution; returnMethod?: ReturnMethod; amountMinor?: number; partialReason?: string; note: string },
) {
  const from: ReturnStatus[] = ['requested', 'under_review', 'rejected', 'inspection_failed', 'received'];
  const { ret, settle } = await db.transaction(async (tx) => {
    const current = await load(tx, actor, returnId, true);
    if (current.finalDecision) throw new AppError(409, 'FINAL_DECISION', 'ARUMA already decided on this return');
    const patch = { adminNote: input.note, adminDecidedAt: new Date(), finalDecision: true };
    if (input.decision === 'reject') return { ret: await move(tx, current, actor, from, 'rejected', 'admin_rejected', patch, input.note), settle: false };
    if (current.receivedAt) {
      // The item is already with the merchant: approve and resolve now.
      const resolution = input.resolution ?? current.resolution ?? current.requestedResolution;
      if (resolution !== current.requestedResolution && resolution !== 'refund') throw badRequest('RESOLUTION_NOT_ALLOWED', 'Approve what the customer asked for, or a refund');
      const order = await orderOf(tx, current.orderId);
      const policy = await returnPolicy(tx, current.storeId);
      return {
        ret: await move(tx, current, actor, from, 'received', 'admin_approved', { ...patch, resolution, approvedAmountMinor: dueAmount(current, order, policy.changeOfMindFeeMinor) }, input.note, { resolution }),
        settle: true,
      };
    }
    const approved = await approve(tx, actor, current, from, 'admin_approved', { resolution: input.resolution, returnMethod: input.returnMethod ?? current.returnMethod ?? undefined, note: input.note }, patch);
    return { ret: approved, settle: approved.returnMethod === 'keep_item' };
  });
  if (settle) return settleReturn(db, deps, actor, ret.id, { amountMinor: input.amountMinor, partialReason: input.partialReason });
  return ret;
}

/** Requests the merchant did not answer in time go to ARUMA. Run periodically. */
export async function escalateOverdueReturns(db: Database, now = new Date()) {
  const due = await db
    .select({ id: s.returnRequests.id })
    .from(s.returnRequests)
    .where(and(eq(s.returnRequests.status, 'requested'), lt(s.returnRequests.responseDueAt, now)));
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [ret] = await tx.select().from(s.returnRequests).where(eq(s.returnRequests.id, id)).for('update');
      if (ret?.status !== 'requested') return;
      await move(tx, ret, { type: 'system', userId: null, ip: null }, ['requested'], 'under_review', 'escalated', { escalatedAt: now, escalationReason: 'The merchant did not answer in time' }, 'The merchant did not answer in time');
    });
  }
  return due.length;
}

// --- Resolution -----------------------------------------------------------------------------------------

/**
 * Gives the customer what was approved: store credit or a replacement at once; a refund through the
 * Payment Service (online: automatic; cash on delivery: sent by hand by ARUMA, recorded with its proof).
 * Value paid with store credit always comes back as store credit.
 */
export async function settleReturn(db: Database, deps: OrderDeps, actor: ReturnActor, returnId: string, input: { amountMinor?: number; partialReason?: string }) {
  let ret = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(s.returnRequests).where(eq(s.returnRequests.id, returnId)).for('update');
    if (!current) throw notFound('Return');
    const ready = current.status === 'received' || (current.status === 'approved' && current.returnMethod === 'keep_item');
    if (!ready) throw new AppError(409, 'INVALID_RETURN_STATUS', 'This return cannot be resolved now', { status: current.status });
    const order = await orderOf(tx, current.orderId, true);
    const approvedAmount = current.approvedAmountMinor ?? 0n;
    const amount = input.amountMinor === undefined ? approvedAmount : BigInt(input.amountMinor);
    if (amount > approvedAmount) throw new AppError(409, 'AMOUNT_EXCEEDS_APPROVED', 'More than the approved amount', { approvedMinor: Number(approvedAmount) });
    if (amount < 0n) throw badRequest('INVALID_AMOUNT', 'The amount cannot be negative');
    if (amount < approvedAmount && current.resolution !== 'replacement' && !input.partialReason?.trim()) {
      throw badRequest('PARTIAL_REASON_REQUIRED', 'Explain why only part is given back');
    }
    const partial = amount < approvedAmount && current.resolution !== 'replacement' ? { partialReason: input.partialReason!.trim() } : {};

    if (current.resolution === 'replacement') {
      const lines = await tx.select().from(s.returnLines).where(eq(s.returnLines.returnId, current.id));
      const replacement = await placeReplacementOrder(tx as Transaction, order, { returnId: current.id, returnNumber: current.number, lines });
      await event(tx, current, actor, { type: 'replacement_created', data: { orderId: replacement.id, number: replacement.number } });
      return move(tx, current, actor, ['received', 'approved'], 'completed', 'replacement_created', { replacementOrderId: replacement.id, finalAmountMinor: 0n, completedAt: new Date() });
    }
    if (current.resolution === 'store_credit') {
      if (amount > 0n) {
        await issueStoreCredit(tx, order, { amountMinor: amount, sourceType: 'return', sourceId: current.id, reason: `Return ${current.number}`, actorUserId: actor.userId });
      }
      return move(tx, current, actor, ['received', 'approved'], 'completed', 'credited', { finalAmountMinor: amount, completedAt: new Date(), ...partial }, partial.partialReason, { amountMinor: Number(amount) });
    }
    // Refund: what was paid with store credit comes back as credit, the rest as money.
    const moneyLeft = order.totalMinor - order.creditAppliedMinor - order.refundedMinor;
    const money = amount < moneyLeft ? amount : moneyLeft > 0n ? moneyLeft : 0n;
    const credit = amount - money;
    if (credit > 0n) {
      await issueStoreCredit(tx, order, { amountMinor: credit, sourceType: 'return', sourceId: current.id, reason: `Return ${current.number}`, actorUserId: actor.userId });
      await event(tx, current, actor, { type: 'credited', data: { amountMinor: Number(credit), paidWithCredit: true } });
    }
    return move(tx, current, actor, ['received', 'approved'], money > 0n ? 'refund_pending' : 'completed', money > 0n ? 'note' : 'credited', {
      finalAmountMinor: amount,
      ...partial,
      ...(money > 0n ? {} : { completedAt: new Date() }),
    }, partial.partialReason, { refundMinor: Number(money), creditMinor: Number(credit) });
  });
  if (ret.status === 'refund_pending') ret = await sendRefund(db, deps, actor, ret.id, {}).catch(() => ret);
  await afterResolution(db, deps, ret);
  return ret;
}

/**
 * Sends the money part of a refund. Online: through the provider, automatically. Cash on delivery: the
 * money is returned by hand (CCP / bank transfer / cash) and ARUMA records it with its reference.
 */
export async function sendRefund(db: Database, deps: OrderDeps, actor: ReturnActor, returnId: string, input: { externalReference?: string }) {
  const [ret] = await db.select().from(s.returnRequests).where(eq(s.returnRequests.id, returnId));
  if (!ret) throw notFound('Return');
  if (ret.status !== 'refund_pending') throw new AppError(409, 'INVALID_RETURN_STATUS', 'No refund is waiting for this return', { status: ret.status });
  const order = await orderOf(db, ret.orderId);
  const moneyLeft = order.totalMinor - order.creditAppliedMinor - order.refundedMinor;
  const credited = await db
    .select({ amount: s.storeCreditTransactions.amountMinor })
    .from(s.storeCreditTransactions)
    .where(and(eq(s.storeCreditTransactions.sourceType, 'return'), eq(s.storeCreditTransactions.sourceId, ret.id)));
  const money = (ret.finalAmountMinor ?? 0n) - credited.reduce((n, c) => n + c.amount, 0n);
  if (money > moneyLeft) throw new AppError(409, 'REFUND_EXCEEDS_ORDER', 'More than what was paid', { refundableMinor: Number(moneyLeft) });
  const byHand = order.paymentMethod === 'cash_on_delivery';
  if (byHand && !input.externalReference) {
    throw new AppError(409, 'MANUAL_REFUND_REQUIRED', 'Cash-on-delivery orders are refunded by transfer; record its reference');
  }
  const { refundId } = await refundOrder(db, deps, { userId: actor.userId, ip: actor.ip }, order.id, `return-${ret.id}`, {
    amountMinor: Number(money),
    reason: `Return ${ret.number}`,
    externalReference: input.externalReference,
  });
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(s.returnRequests).where(eq(s.returnRequests.id, ret.id)).for('update');
    return move(tx, current!, actor, ['refund_pending'], 'completed', byHand ? 'refund_recorded' : 'refunded', {
      paymentRefundId: refundId,
      refundReference: input.externalReference ?? null,
      completedAt: new Date(),
    }, input.externalReference, { amountMinor: Number(money) });
  });
}

/** When every item of the order came back, the order is "returned"; when all its value went back, "refunded". */
async function afterResolution(db: Database, deps: OrderDeps, ret: Return) {
  if (ret.status !== 'completed' && ret.status !== 'refund_pending') return;
  const order = await orderOf(db, ret.orderId);
  const system = { type: 'system' as const, userId: null, ip: null };
  if (order.status === 'delivered') {
    const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
    const back = await db
      .select({ orderLineId: s.returnLines.orderLineId, quantity: sql<number>`sum(${s.returnLines.quantity})::int` })
      .from(s.returnLines)
      .innerJoin(s.returnRequests, eq(s.returnRequests.id, s.returnLines.returnId))
      .where(and(eq(s.returnRequests.orderId, order.id), inArray(s.returnRequests.status, ['completed', 'refund_pending'])))
      .groupBy(s.returnLines.orderLineId);
    const all = lines.every((l) => back.find((b) => b.orderLineId === l.id)?.quantity === l.quantity);
    if (all) {
      // Stock was handled item by item at inspection.
      await transitionOrder(db, deps, system, order.id, { to: 'returned', reason: `Return ${ret.number}`, restock: false });
    }
  }
  await markRefundedIfDone(db, deps, system, await orderOf(db, ret.orderId), `Return ${ret.number}`);
}

// --- Reading --------------------------------------------------------------------------------------------

export async function describeReturn(db: Executor, ret: Return, view: 'customer' | 'merchant' | 'platform') {
  const [lines, evidence, events, order, shipment] = [
    await db
      .select({
        id: s.returnLines.id,
        orderLineId: s.returnLines.orderLineId,
        quantity: s.returnLines.quantity,
        restock: s.returnLines.restock,
        sku: s.orderLines.sku,
        productNames: s.orderLines.productNames,
        options: s.orderLines.options,
        unitPriceMinor: s.orderLines.unitPriceMinor,
      })
      .from(s.returnLines)
      .innerJoin(s.orderLines, eq(s.orderLines.id, s.returnLines.orderLineId))
      .where(eq(s.returnLines.returnId, ret.id)),
    await db
      .select({ id: s.returnEvidence.id, role: s.returnEvidence.role, fileName: s.returnEvidence.fileName, contentType: s.returnEvidence.contentType, sizeBytes: s.returnEvidence.sizeBytes, createdAt: s.returnEvidence.createdAt })
      .from(s.returnEvidence)
      .where(eq(s.returnEvidence.returnId, ret.id))
      .orderBy(asc(s.returnEvidence.createdAt)),
    await db
      .select({
        type: s.returnEvents.type,
        fromStatus: s.returnEvents.fromStatus,
        toStatus: s.returnEvents.toStatus,
        actorType: s.returnEvents.actorType,
        actorName: s.users.displayName,
        note: s.returnEvents.note,
        data: s.returnEvents.data,
        createdAt: s.returnEvents.createdAt,
      })
      .from(s.returnEvents)
      .leftJoin(s.users, eq(s.users.id, s.returnEvents.actorUserId))
      .where(eq(s.returnEvents.returnId, ret.id))
      .orderBy(asc(s.returnEvents.createdAt)),
    await orderOf(db, ret.orderId),
    await activeReturnShipment(db, ret.id),
  ];
  const [replacement] = ret.replacementOrderId ? await db.select({ number: s.orders.number, status: s.orders.status }).from(s.orders).where(eq(s.orders.id, ret.replacementOrderId)) : [];
  const money = (v: bigint | null) => (v === null ? null : Number(v));
  return {
    id: ret.id,
    number: ret.number,
    status: ret.status,
    orderId: ret.orderId,
    orderNumber: order.number,
    paymentMethod: order.paymentMethod,
    merchantId: ret.merchantId,
    reason: ret.reason,
    description: ret.description,
    requestedResolution: ret.requestedResolution,
    resolution: ret.resolution,
    returnMethod: ret.returnMethod,
    currency: ret.currency,
    itemsValueMinor: Number(ret.itemsValueMinor),
    approvedAmountMinor: money(ret.approvedAmountMinor),
    finalAmountMinor: money(ret.finalAmountMinor),
    partialReason: ret.partialReason,
    responseDueAt: ret.responseDueAt,
    merchantNote: ret.merchantNote,
    escalationReason: ret.escalationReason,
    adminNote: ret.adminNote,
    finalDecision: ret.finalDecision,
    inspectionNote: ret.inspectionNote,
    refundReference: view === 'customer' ? undefined : ret.refundReference,
    replacementOrder: ret.replacementOrderId ? { id: ret.replacementOrderId, ...replacement } : null,
    customer: view === 'customer' ? undefined : { name: order.shippingAddress.fullName, phone: order.shippingAddress.phone, city: order.shippingAddress.city, region: order.shippingAddress.region },
    lines: lines.map((l) => ({ ...l, unitPriceMinor: Number(l.unitPriceMinor) })),
    evidence,
    pickup: shipment ? await describeShipment(db, shipment, view) : null,
    // Customers see what happened, not the names of the merchant's staff.
    events: events.map((e) => (view === 'customer' && e.actorType !== 'customer' ? { ...e, actorName: null } : e)),
    createdAt: ret.createdAt,
    submittedAt: ret.submittedAt,
    completedAt: ret.completedAt,
  };
}

export async function getReturn(db: Database, actor: ReturnActor, returnId: string) {
  const ret = await load(db, actor, returnId);
  return describeReturn(db, ret, actor.type === 'customer' ? 'customer' : actor.type === 'merchant' ? 'merchant' : 'platform');
}

export async function listReturns(db: Database, actor: ReturnActor, filter: { status?: ReturnStatus; page: number; pageSize: number }) {
  const where: SQL[] = [];
  if (actor.type === 'customer') where.push(eq(s.returnRequests.customerUserId, actor.userId!));
  if (actor.type === 'merchant') {
    await requireMembership(db, actor.merchantId!, actor.userId!);
    // Drafts belong to the customer until submitted.
    where.push(eq(s.returnRequests.merchantId, actor.merchantId!), ne(s.returnRequests.status, 'draft'));
  }
  if (filter.status) where.push(eq(s.returnRequests.status, filter.status));
  const rows = await db
    .select({ ret: s.returnRequests, orderNumber: s.orders.number, customerName: sql<string>`${s.orders.shippingAddress}->>'fullName'` })
    .from(s.returnRequests)
    .innerJoin(s.orders, eq(s.orders.id, s.returnRequests.orderId))
    .where(and(...where))
    .orderBy(desc(s.returnRequests.createdAt))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);
  return rows.map(({ ret, orderNumber, customerName }) => ({
    id: ret.id,
    number: ret.number,
    status: ret.status,
    orderId: ret.orderId,
    orderNumber,
    customerName: actor.type === 'customer' ? undefined : customerName,
    reason: ret.reason,
    requestedResolution: ret.requestedResolution,
    resolution: ret.resolution,
    itemsValueMinor: Number(ret.itemsValueMinor),
    finalAmountMinor: ret.finalAmountMinor === null ? null : Number(ret.finalAmountMinor),
    currency: ret.currency,
    responseDueAt: ret.responseDueAt,
    createdAt: ret.createdAt,
  }));
}

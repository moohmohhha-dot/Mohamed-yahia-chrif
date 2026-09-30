import { and, eq, isNull } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { sequential, type Executor } from '../../shared/db.js';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import {
  audit,
  consumeVerificationCode,
  issueVerificationCode,
  recordEvent,
  type MessageSender,
} from '../platform/index.js';
import {
  ALL_CHECKS,
  missingFor,
  overallStatus,
  requiredChecks,
  type CheckKind,
  type DocumentKind,
  type MerchantSnapshot,
  type VerificationStatus,
} from './requirements.js';
import { requireMembership } from './service.js';

type Merchant = typeof s.merchants.$inferSelect;

async function getMerchantRow(db: Executor, merchantId: string): Promise<Merchant> {
  const [m] = await db.select().from(s.merchants).where(eq(s.merchants.id, merchantId));
  if (!m) throw notFound('Merchant');
  return m;
}

export async function individualRequiresRegistration(db: Executor, m: Pick<Merchant, 'country' | 'activityCode'>) {
  const [rule] = await db
    .select({ required: s.merchantActivityRules.individualRequiresRegistration })
    .from(s.merchantActivityRules)
    .where(and(eq(s.merchantActivityRules.country, m.country), eq(s.merchantActivityRules.activityCode, m.activityCode)));
  return rule?.required ?? false;
}

export async function loadSnapshot(db: Executor, m: Merchant): Promise<MerchantSnapshot> {
  const [[identity], [business], [address], [payout], docs] = await sequential([
    db.select().from(s.merchantIdentities).where(eq(s.merchantIdentities.merchantId, m.id)),
    db.select().from(s.merchantBusinessProfiles).where(eq(s.merchantBusinessProfiles.merchantId, m.id)),
    db
      .select({ kind: s.merchantAddresses.kind })
      .from(s.merchantAddresses)
      .where(and(eq(s.merchantAddresses.merchantId, m.id), eq(s.merchantAddresses.kind, 'registered'))),
    db
      .select({ id: s.merchantPayoutMethods.id })
      .from(s.merchantPayoutMethods)
      .where(and(eq(s.merchantPayoutMethods.merchantId, m.id), isNull(s.merchantPayoutMethods.archivedAt))),
    db
      .select({ kind: s.merchantDocuments.kind })
      .from(s.merchantDocuments)
      .where(and(eq(s.merchantDocuments.merchantId, m.id), isNull(s.merchantDocuments.archivedAt))),
  ]);
  return {
    type: m.type,
    contactEmail: m.contactEmail,
    contactPhone: m.contactPhone,
    hasAddress: Boolean(address),
    identity: identity ? { documentType: identity.documentType } : null,
    business: business
      ? {
          legalName: business.legalName,
          legalForm: business.legalForm,
          registrationType: business.registrationType,
          taxId: business.taxId,
        }
      : null,
    hasPayoutMethod: Boolean(payout),
    documents: new Set<DocumentKind>(docs.map((d) => d.kind)),
  };
}

async function loadChecks(db: Executor, merchantId: string) {
  return db.select().from(s.merchantVerifications).where(eq(s.merchantVerifications.merchantId, merchantId));
}

/** Re-derives the merchant's overall status from its checks. Call after any check or requirement change. */
export async function recomputeStatus(db: Executor, merchantId: string, actor: Actor | null): Promise<VerificationStatus> {
  const m = await getMerchantRow(db, merchantId);
  const required = requiredChecks(m.type, await individualRequiresRegistration(db, m));
  const checks = new Map((await loadChecks(db, merchantId)).map((c) => [c.kind, c.status]));
  const next = overallStatus(required, checks, m.suspendedAt !== null);
  if (next === m.verificationStatus) return next;

  await db
    .update(s.merchants)
    .set({ verificationStatus: next, ...(next === 'verified' && m.status === 'draft' ? { status: 'active' as const } : {}) })
    .where(eq(s.merchants.id, merchantId));
  await audit(db, actor, {
    action: 'merchants.verification_status.changed',
    entityType: 'merchant',
    entityId: merchantId,
    metadata: { from: m.verificationStatus, to: next },
  });
  await recordEvent(db, {
    type: 'merchants.verification_status.changed',
    aggregateType: 'merchant',
    aggregateId: merchantId,
    payload: { from: m.verificationStatus, to: next },
  });
  return next;
}

/**
 * The data behind a check changed: a verified or under-review check goes back to unverified and
 * must be resubmitted. A suspended check stays suspended (only platform staff can lift it).
 */
export async function invalidateCheck(db: Executor, merchantId: string, kind: CheckKind, reason: string) {
  const [check] = await db
    .select({ status: s.merchantVerifications.status })
    .from(s.merchantVerifications)
    .where(and(eq(s.merchantVerifications.merchantId, merchantId), eq(s.merchantVerifications.kind, kind)));
  if (!check || check.status === 'unverified' || check.status === 'suspended') return;
  await db
    .update(s.merchantVerifications)
    .set({ status: 'unverified', verifiedValue: null, note: reason, reviewedAt: null, reviewedBy: null })
    .where(and(eq(s.merchantVerifications.merchantId, merchantId), eq(s.merchantVerifications.kind, kind)));
}

export async function getVerificationOverview(db: Executor, merchantId: string) {
  const m = await getMerchantRow(db, merchantId);
  const required = requiredChecks(m.type, await individualRequiresRegistration(db, m));
  const snapshot = await loadSnapshot(db, m);
  const checks = await loadChecks(db, merchantId);
  const byKind = new Map(checks.map((c) => [c.kind, c]));
  return {
    merchantId,
    type: m.type,
    status: m.verificationStatus,
    suspended: m.suspendedAt ? { at: m.suspendedAt, reason: m.suspensionReason } : null,
    checks: ALL_CHECKS.map((kind) => {
      const c = byKind.get(kind);
      const missing = missingFor(kind, snapshot);
      const status = c?.status ?? 'unverified';
      return {
        kind,
        required: required.includes(kind),
        status,
        note: c?.note ?? null,
        submittedAt: c?.submittedAt ?? null,
        reviewedAt: c?.reviewedAt ?? null,
        missing,
        ready: status === 'unverified' && missing.fields.length === 0 && missing.documents.length === 0,
      };
    }),
  };
}

async function setCheck(
  db: Executor,
  merchantId: string,
  kind: CheckKind,
  values: Partial<typeof s.merchantVerifications.$inferInsert>,
) {
  await db
    .insert(s.merchantVerifications)
    .values({ merchantId, kind, ...values })
    .onConflictDoUpdate({ target: [s.merchantVerifications.merchantId, s.merchantVerifications.kind], set: values });
}

async function checkStatus(db: Executor, merchantId: string, kind: CheckKind): Promise<VerificationStatus> {
  const [c] = await db
    .select({ status: s.merchantVerifications.status })
    .from(s.merchantVerifications)
    .where(and(eq(s.merchantVerifications.merchantId, merchantId), eq(s.merchantVerifications.kind, kind)));
  return c?.status ?? 'unverified';
}

/** The owner submits identity, business or payout data for review. */
export async function submitCheck(
  db: Database,
  actor: Actor & { userId: string },
  merchantId: string,
  kind: 'identity' | 'business' | 'payout',
) {
  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId, ['owner']);
    const m = await getMerchantRow(tx, merchantId);
    const status = await checkStatus(tx, merchantId, kind);
    if (status !== 'unverified') throw conflict('INVALID_VERIFICATION_STATE', `This check is already ${status}`);

    const missing = missingFor(kind, await loadSnapshot(tx, m));
    if (missing.fields.length || missing.documents.length) {
      throw new AppError(400, 'REQUIREMENTS_MISSING', `Missing: ${[...missing.fields, ...missing.documents].join(', ')}`);
    }

    await setCheck(tx, merchantId, kind, { status: 'under_review', submittedAt: new Date(), note: null });
    await audit(tx, actor, { action: `merchants.verification.${kind}.submitted`, entityType: 'merchant', entityId: merchantId });
    await recordEvent(tx, {
      type: 'merchants.verification.submitted',
      aggregateType: 'merchant',
      aggregateId: merchantId,
      payload: { kind },
    });
    await recomputeStatus(tx, merchantId, actor);
    return getVerificationOverview(tx, merchantId);
  });
}

/**
 * Platform staff decide on a check.
 * approve / reject: only for an identity, business or payout check under review (reject needs a reason).
 * suspend: any check that is verified or under review (e.g. a payout account flagged for fraud).
 * reinstate: lifts a suspended check back to unverified, so the merchant must resubmit.
 */
export async function decideCheck(
  db: Database,
  actor: Actor,
  merchantId: string,
  kind: CheckKind,
  input: { decision: 'approve' | 'reject' | 'suspend' | 'reinstate'; note?: string },
) {
  return db.transaction(async (tx) => {
    await getMerchantRow(tx, merchantId);
    const status = await checkStatus(tx, merchantId, kind);
    const reviewed = { reviewedAt: new Date(), reviewedBy: actor.userId, note: input.note ?? null };

    switch (input.decision) {
      case 'approve':
      case 'reject':
        if (kind === 'phone' || kind === 'email') {
          throw badRequest('CODE_VERIFIED_CHECK', 'Phone and email are verified with a code, not by review');
        }
        if (status !== 'under_review') throw conflict('INVALID_VERIFICATION_STATE', 'This check is not under review');
        if (input.decision === 'reject' && !input.note) throw badRequest('NOTE_REQUIRED', 'Explain the rejection');
        await setCheck(tx, merchantId, kind, {
          status: input.decision === 'approve' ? 'verified' : 'unverified',
          ...reviewed,
        });
        break;
      case 'suspend':
        if (status !== 'verified' && status !== 'under_review') {
          throw conflict('INVALID_VERIFICATION_STATE', 'Only a verified or under-review check can be suspended');
        }
        if (!input.note) throw badRequest('NOTE_REQUIRED', 'Explain the suspension');
        await setCheck(tx, merchantId, kind, { status: 'suspended', ...reviewed });
        break;
      case 'reinstate':
        if (status !== 'suspended') throw conflict('INVALID_VERIFICATION_STATE', 'This check is not suspended');
        await setCheck(tx, merchantId, kind, { status: 'unverified', verifiedValue: null, ...reviewed });
        break;
    }

    const action = `merchants.verification.${kind}.${input.decision}`;
    await audit(tx, actor, { action, entityType: 'merchant', entityId: merchantId, metadata: { note: input.note ?? null } });
    await recordEvent(tx, {
      type: 'merchants.verification.decided',
      aggregateType: 'merchant',
      aggregateId: merchantId,
      payload: { kind, decision: input.decision },
    });
    await recomputeStatus(tx, merchantId, actor);
    return getVerificationOverview(tx, merchantId);
  });
}

const codePurpose = (kind: 'phone' | 'email') => `merchant.${kind}`;

async function contactTarget(db: Executor, merchantId: string, kind: 'phone' | 'email') {
  const m = await getMerchantRow(db, merchantId);
  const target = kind === 'phone' ? m.contactPhone : m.contactEmail;
  if (!target) throw badRequest('REQUIREMENTS_MISSING', `Missing: ${kind === 'phone' ? 'contactPhone' : 'contactEmail'}`);
  return target;
}

/** Sends a one-time code to the merchant's contact phone (SMS) or email. */
export async function sendContactCode(
  db: Database,
  messages: MessageSender,
  actor: Actor & { userId: string },
  merchantId: string,
  kind: 'phone' | 'email',
) {
  const { target, code } = await db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId, ['owner', 'manager']);
    const target = await contactTarget(tx, merchantId, kind);
    const status = await checkStatus(tx, merchantId, kind);
    if (status === 'verified') throw conflict('ALREADY_VERIFIED', `The ${kind} is already verified`);
    if (status === 'suspended') throw conflict('INVALID_VERIFICATION_STATE', `The ${kind} check is suspended`);
    const code = await issueVerificationCode(tx, { purpose: codePurpose(kind), subjectId: merchantId, target });
    await audit(tx, actor, { action: `merchants.verification.${kind}.code_sent`, entityType: 'merchant', entityId: merchantId });
    return { target, code };
  });
  await messages.send({
    channel: kind === 'phone' ? 'sms' : 'email',
    to: target,
    template: 'merchant_contact_verification',
    params: { code },
  });
}

/** Confirms the code; the check becomes verified for that exact phone number or email address. */
export async function confirmContactCode(
  db: Database,
  actor: Actor & { userId: string },
  merchantId: string,
  kind: 'phone' | 'email',
  code: string,
) {
  await requireMembership(db, merchantId, actor.userId, ['owner', 'manager']);
  const target = await contactTarget(db, merchantId, kind);
  if ((await checkStatus(db, merchantId, kind)) === 'suspended') {
    throw conflict('INVALID_VERIFICATION_STATE', `The ${kind} check is suspended`);
  }
  // Outside the transaction on purpose: failed attempts must be counted even though we throw.
  await consumeVerificationCode(db, { purpose: codePurpose(kind), subjectId: merchantId, target }, code);

  return db.transaction(async (tx) => {
    await setCheck(tx, merchantId, kind, {
      status: 'verified',
      verifiedValue: target,
      reviewedAt: new Date(),
      reviewedBy: null,
      note: null,
    });
    await audit(tx, actor, { action: `merchants.verification.${kind}.verified`, entityType: 'merchant', entityId: merchantId });
    await recomputeStatus(tx, merchantId, actor);
    return getVerificationOverview(tx, merchantId);
  });
}

export async function suspendMerchant(db: Database, actor: Actor, merchantId: string, reason: string) {
  return db.transaction(async (tx) => {
    const m = await getMerchantRow(tx, merchantId);
    if (m.suspendedAt) throw conflict('ALREADY_SUSPENDED', 'The merchant is already suspended');
    await tx.update(s.merchants).set({ suspendedAt: new Date(), suspensionReason: reason }).where(eq(s.merchants.id, merchantId));
    await audit(tx, actor, { action: 'merchants.merchant.suspended', entityType: 'merchant', entityId: merchantId, metadata: { reason } });
    await recomputeStatus(tx, merchantId, actor);
    return getVerificationOverview(tx, merchantId);
  });
}

export async function unsuspendMerchant(db: Database, actor: Actor, merchantId: string) {
  return db.transaction(async (tx) => {
    const m = await getMerchantRow(tx, merchantId);
    if (!m.suspendedAt) throw conflict('NOT_SUSPENDED', 'The merchant is not suspended');
    await tx.update(s.merchants).set({ suspendedAt: null, suspensionReason: null }).where(eq(s.merchants.id, merchantId));
    await audit(tx, actor, { action: 'merchants.merchant.unsuspended', entityType: 'merchant', entityId: merchantId });
    await recomputeStatus(tx, merchantId, actor);
    return getVerificationOverview(tx, merchantId);
  });
}

/** Sets whether individuals in this country and activity must register; re-derives affected merchants. */
export async function setActivityRule(
  db: Database,
  actor: Actor,
  input: { country: string; activityCode: string; individualRequiresRegistration: boolean; note?: string },
) {
  return db.transaction(async (tx) => {
    const values = { individualRequiresRegistration: input.individualRequiresRegistration, note: input.note ?? null };
    const [rule] = await tx
      .insert(s.merchantActivityRules)
      .values({ country: input.country, activityCode: input.activityCode, ...values })
      .onConflictDoUpdate({ target: [s.merchantActivityRules.country, s.merchantActivityRules.activityCode], set: values })
      .returning();
    await audit(tx, actor, {
      action: 'merchants.activity_rule.set',
      entityType: 'merchant_activity_rule',
      entityId: `${input.country}:${input.activityCode}`,
      metadata: values,
    });
    const affected = await tx
      .select({ id: s.merchants.id })
      .from(s.merchants)
      .where(
        and(
          eq(s.merchants.country, input.country),
          eq(s.merchants.activityCode, input.activityCode),
          eq(s.merchants.type, 'individual'),
        ),
      );
    for (const { id } of affected) await recomputeStatus(tx, id, actor);
    return { rule: rule!, merchantsRecomputed: affected.length };
  });
}

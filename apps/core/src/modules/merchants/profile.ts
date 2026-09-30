import { and, eq, isNull } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { audit, type SecretBox } from '../platform/index.js';
import { addressCheck, type RegistrationType } from './requirements.js';
import { requireMembership } from './service.js';
import { getVerificationOverview, invalidateCheck, recomputeStatus } from './verification.js';

type OwnerActor = Actor & { userId: string };
const last4 = (value: string) => value.slice(-4);
const DATA_CHANGED = 'Data changed after verification; please resubmit';

async function getMerchantRow(db: Executor, merchantId: string) {
  const [m] = await db.select().from(s.merchants).where(eq(s.merchants.id, merchantId));
  if (!m) throw notFound('Merchant');
  return m;
}

export type ProfileInput = {
  name?: string;
  activityCode?: string;
  activityDescription?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
};

/** Public profile and contacts. Changing a contact invalidates its phone/email check. */
export async function updateProfile(db: Database, actor: OwnerActor, merchantId: string, input: ProfileInput) {
  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId, ['owner', 'manager']);
    const before = await getMerchantRow(tx, merchantId);
    const [after] = await tx.update(s.merchants).set(input).where(eq(s.merchants.id, merchantId)).returning();

    if (input.contactEmail !== undefined && input.contactEmail !== before.contactEmail) {
      await invalidateCheck(tx, merchantId, 'email', 'Contact email changed; please verify it again');
    }
    if (input.contactPhone !== undefined && input.contactPhone !== before.contactPhone) {
      await invalidateCheck(tx, merchantId, 'phone', 'Contact phone changed; please verify it again');
    }
    await audit(tx, actor, {
      action: 'merchants.profile.updated',
      entityType: 'merchant',
      entityId: merchantId,
      metadata: { fields: Object.keys(input) },
    });
    await recomputeStatus(tx, merchantId, actor); // activity changes can change what is required
    return after!;
  });
}

export type AddressInput = {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode?: string;
  country: string;
};

export async function setAddress(db: Database, actor: OwnerActor, merchantId: string, input: AddressInput) {
  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId, ['owner', 'manager']);
    const m = await getMerchantRow(tx, merchantId);
    const values = { line2: null, postalCode: null, ...input };
    const [address] = await tx
      .insert(s.merchantAddresses)
      .values({ merchantId, kind: 'registered', ...values })
      .onConflictDoUpdate({ target: [s.merchantAddresses.merchantId, s.merchantAddresses.kind], set: values })
      .returning();
    await invalidateCheck(tx, merchantId, addressCheck(m.type), DATA_CHANGED);
    await audit(tx, actor, { action: 'merchants.address.set', entityType: 'merchant', entityId: merchantId });
    await recomputeStatus(tx, merchantId, actor);
    return address!;
  });
}

export type IdentityInput = {
  fullName: string;
  dateOfBirth: string;
  nationality: string;
  documentType: 'national_id' | 'passport' | 'driving_license';
  documentNumber: string;
  documentExpiry?: string;
};

/** The individual, or the legal representative of a business. Owner only; the ID number is encrypted. */
export async function setIdentity(db: Database, secrets: SecretBox, actor: OwnerActor, merchantId: string, input: IdentityInput) {
  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId, ['owner']);
    const { documentNumber, ...rest } = input;
    const values = {
      documentExpiry: null,
      ...rest,
      documentNumberEncrypted: secrets.seal(documentNumber),
      documentNumberLast4: last4(documentNumber),
    };
    await tx
      .insert(s.merchantIdentities)
      .values({ merchantId, ...values })
      .onConflictDoUpdate({ target: s.merchantIdentities.merchantId, set: values });
    await invalidateCheck(tx, merchantId, 'identity', DATA_CHANGED);
    await audit(tx, actor, { action: 'merchants.identity.set', entityType: 'merchant', entityId: merchantId });
    await recomputeStatus(tx, merchantId, actor);
  });
}

export type BusinessInput = {
  legalName?: string;
  legalForm?: string;
  registrationType: RegistrationType;
  registrationNumber: string;
  taxId?: string;
  statisticalId?: string;
  taxArticleNumber?: string;
  incorporationDate?: string;
};

/** Company data for businesses, or registration data for individuals who register (e.g. auto-entrepreneur). */
export async function setBusinessProfile(db: Database, actor: OwnerActor, merchantId: string, input: BusinessInput) {
  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId, ['owner']);
    const values = {
      legalName: null,
      legalForm: null,
      taxId: null,
      statisticalId: null,
      taxArticleNumber: null,
      incorporationDate: null,
      ...input,
    };
    const [profile] = await tx
      .insert(s.merchantBusinessProfiles)
      .values({ merchantId, ...values })
      .onConflictDoUpdate({ target: s.merchantBusinessProfiles.merchantId, set: values })
      .returning();
    await invalidateCheck(tx, merchantId, 'business', DATA_CHANGED);
    await audit(tx, actor, { action: 'merchants.business.set', entityType: 'merchant', entityId: merchantId });
    await recomputeStatus(tx, merchantId, actor);
    return profile!;
  });
}

export type PayoutInput = {
  type: 'bank_account' | 'postal_account';
  holderName: string;
  accountNumber: string;
  institutionName?: string;
  currency: string;
};

/** Replaces the payout method (the old one is archived, never deleted). Owner only; the number is encrypted. */
export async function setPayoutMethod(db: Database, secrets: SecretBox, actor: OwnerActor, merchantId: string, input: PayoutInput) {
  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId, ['owner']);
    await tx
      .update(s.merchantPayoutMethods)
      .set({ archivedAt: new Date() })
      .where(and(eq(s.merchantPayoutMethods.merchantId, merchantId), isNull(s.merchantPayoutMethods.archivedAt)));
    const { accountNumber, ...rest } = input;
    const [method] = await tx
      .insert(s.merchantPayoutMethods)
      .values({
        merchantId,
        institutionName: null,
        ...rest,
        accountNumberEncrypted: secrets.seal(accountNumber),
        accountNumberLast4: last4(accountNumber),
      })
      .returning();
    await invalidateCheck(tx, merchantId, 'payout', DATA_CHANGED);
    await audit(tx, actor, { action: 'merchants.payout_method.set', entityType: 'merchant', entityId: merchantId });
    await recomputeStatus(tx, merchantId, actor);
    return method!;
  });
}

/**
 * Full merchant file. Sensitive numbers are masked (last 4 digits) unless `reveal` is set,
 * which only platform staff reviewing the merchant may do (and which is audited by the caller).
 */
export async function getMerchantFile(db: Executor, secrets: SecretBox, merchantId: string, reveal: boolean) {
  const merchant = await getMerchantRow(db, merchantId);
  const [[identity], [business], addresses, [payout], documents, verification] = await Promise.all([
    db.select().from(s.merchantIdentities).where(eq(s.merchantIdentities.merchantId, merchantId)),
    db.select().from(s.merchantBusinessProfiles).where(eq(s.merchantBusinessProfiles.merchantId, merchantId)),
    db.select().from(s.merchantAddresses).where(eq(s.merchantAddresses.merchantId, merchantId)),
    db
      .select()
      .from(s.merchantPayoutMethods)
      .where(and(eq(s.merchantPayoutMethods.merchantId, merchantId), isNull(s.merchantPayoutMethods.archivedAt))),
    db
      .select({
        id: s.merchantDocuments.id,
        kind: s.merchantDocuments.kind,
        fileName: s.merchantDocuments.fileName,
        contentType: s.merchantDocuments.contentType,
        sizeBytes: s.merchantDocuments.sizeBytes,
        createdAt: s.merchantDocuments.createdAt,
      })
      .from(s.merchantDocuments)
      .where(and(eq(s.merchantDocuments.merchantId, merchantId), isNull(s.merchantDocuments.archivedAt))),
    getVerificationOverview(db, merchantId),
  ]);

  return {
    merchant,
    identity: identity && {
      fullName: identity.fullName,
      dateOfBirth: identity.dateOfBirth,
      nationality: identity.nationality,
      documentType: identity.documentType,
      documentNumberLast4: identity.documentNumberLast4,
      documentExpiry: identity.documentExpiry,
      ...(reveal ? { documentNumber: secrets.open(identity.documentNumberEncrypted) } : {}),
    },
    business: business ?? null,
    addresses,
    payoutMethod: payout && {
      id: payout.id,
      type: payout.type,
      holderName: payout.holderName,
      institutionName: payout.institutionName,
      currency: payout.currency,
      accountNumberLast4: payout.accountNumberLast4,
      ...(reveal ? { accountNumber: secrets.open(payout.accountNumberEncrypted) } : {}),
    },
    documents,
    verification,
  };
}

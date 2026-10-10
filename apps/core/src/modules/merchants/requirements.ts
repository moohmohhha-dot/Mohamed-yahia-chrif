/**
 * Verification rules for merchants. Pure functions: no database access.
 *
 * Checks (independent of each other):
 *   phone    — merchant controls the contact phone (SMS code)
 *   email    — merchant controls the contact email (email code)
 *   identity — the person (individual) or legal representative (business) is who they claim
 *   business — company or registration data is legally valid
 *   payout   — the payout account belongs to the merchant
 *
 * Required checks:
 *   individual → phone, email, identity, payout
 *                (+ business ONLY when a merchant_activity_rules row says registration is legally required)
 *   business   → phone, email, identity, business, payout
 */
import type { schema } from '@aruma/db';

export type CheckKind = (typeof schema.verificationKind.enumValues)[number];
export type VerificationStatus = (typeof schema.verificationStatus.enumValues)[number];
export type DocumentKind = (typeof schema.merchantDocumentKind.enumValues)[number];
export type MerchantType = (typeof schema.merchantType.enumValues)[number];
export type RegistrationType = (typeof schema.registrationType.enumValues)[number];

export const ALL_CHECKS: CheckKind[] = ['phone', 'email', 'identity', 'business', 'payout'];
/** Checks proven by a one-time code rather than reviewed by platform staff. */
export const CODE_CHECKS = ['phone', 'email'] as const;
/** Checks submitted by the merchant and reviewed by platform staff. */
export const REVIEWED_CHECKS = ['identity', 'business', 'payout'] as const;

export function requiredChecks(type: MerchantType, individualRequiresRegistration: boolean): CheckKind[] {
  if (type === 'business' || individualRequiresRegistration) return [...ALL_CHECKS];
  return ALL_CHECKS.filter((k) => k !== 'business');
}

/** Which check a document supports; replacing the document invalidates that check. */
export const DOCUMENT_CHECK: Record<DocumentKind, CheckKind> = {
  id_front: 'identity',
  id_back: 'identity',
  selfie: 'identity',
  commercial_register: 'business',
  auto_entrepreneur_card: 'business',
  craft_register_card: 'business',
  tax_id_card: 'business',
  articles_of_association: 'business',
  payout_proof: 'payout',
};

export const REGISTRATION_DOCUMENT: Record<RegistrationType, DocumentKind> = {
  commercial_register: 'commercial_register',
  auto_entrepreneur: 'auto_entrepreneur_card',
  craft_register: 'craft_register_card',
};

/** The registered address supports the identity check for individuals and the business check for companies. */
export const addressCheck = (type: MerchantType): CheckKind => (type === 'individual' ? 'identity' : 'business');

export type MerchantSnapshot = {
  type: MerchantType;
  contactEmail: string | null;
  contactPhone: string | null;
  hasAddress: boolean;
  identity: { documentType: 'national_id' | 'passport' | 'driving_license' } | null;
  business: {
    legalName: string | null;
    legalForm: string | null;
    registrationType: RegistrationType;
    taxId: string | null;
  } | null;
  hasPayoutMethod: boolean;
  documents: Set<DocumentKind>;
};

export type Missing = { fields: string[]; documents: DocumentKind[] };

/** What is still needed before a check can be submitted (or, for phone/email, before a code can be sent). */
export function missingFor(kind: CheckKind, m: MerchantSnapshot): Missing {
  const fields: string[] = [];
  const documents: DocumentKind[] = [];
  const needDoc = (d: DocumentKind) => !m.documents.has(d) && documents.push(d);

  switch (kind) {
    case 'phone':
      if (!m.contactPhone) fields.push('contactPhone');
      break;
    case 'email':
      if (!m.contactEmail) fields.push('contactEmail');
      break;
    case 'identity':
      if (!m.identity) fields.push('identity');
      if (addressCheck(m.type) === 'identity' && !m.hasAddress) fields.push('address');
      needDoc('id_front');
      if (m.identity?.documentType !== 'passport') needDoc('id_back');
      break;
    case 'business':
      if (!m.business) {
        fields.push('business');
      } else {
        needDoc(REGISTRATION_DOCUMENT[m.business.registrationType]);
        if (m.type === 'business') {
          if (!m.business.legalName) fields.push('business.legalName');
          if (!m.business.legalForm) fields.push('business.legalForm');
          if (!m.business.taxId) fields.push('business.taxId');
          needDoc('tax_id_card');
        }
      }
      if (addressCheck(m.type) === 'business' && !m.hasAddress) fields.push('address');
      break;
    case 'payout':
      if (!m.hasPayoutMethod) fields.push('payoutMethod');
      needDoc('payout_proof');
      break;
  }
  return { fields, documents };
}

/**
 * Overall merchant status:
 *   suspended     — suspended by the platform, or any required check suspended
 *   verified      — every required check verified
 *   under_review  — at least one required check awaiting review
 *   unverified    — otherwise
 */
export function overallStatus(
  required: CheckKind[],
  checks: Map<CheckKind, VerificationStatus>,
  merchantSuspended: boolean,
): VerificationStatus {
  const statuses = required.map((k) => checks.get(k) ?? 'unverified');
  if (merchantSuspended || statuses.includes('suspended')) return 'suspended';
  if (statuses.every((st) => st === 'verified')) return 'verified';
  if (statuses.includes('under_review')) return 'under_review';
  return 'unverified';
}

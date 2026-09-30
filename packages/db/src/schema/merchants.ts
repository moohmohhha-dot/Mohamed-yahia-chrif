/**
 * Merchants (sellers): individuals or businesses, their staff, their verification, and where they sell.
 *
 * Verification is split into independent checks (phone, email, identity, business, payout).
 * The merchant's overall `verification_status` is derived from the checks required for its type
 * and activity (see apps/core/src/modules/merchants/requirements.ts).
 * Sensitive values (ID and account numbers) are stored encrypted, with only the last 4 digits in clear.
 */
import {
  bigint,
  boolean,
  char,
  date,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
  index,
} from 'drizzle-orm/pg-core';
import { id, recordStatus, timestamps } from './common.js';
import { users } from './identity.js';
import { countries, currencies } from './reference.js';
import { stores } from './tenancy.js';

export const merchantType = pgEnum('merchant_type', ['individual', 'business']);
export const verificationStatus = pgEnum('verification_status', ['unverified', 'under_review', 'verified', 'suspended']);
export const verificationKind = pgEnum('verification_kind', ['phone', 'email', 'identity', 'business', 'payout']);
export const merchantRole = pgEnum('merchant_role', ['owner', 'manager', 'staff']);
export const identityDocumentType = pgEnum('identity_document_type', ['national_id', 'passport', 'driving_license']);
/** How a business or a registered individual is registered. */
export const registrationType = pgEnum('registration_type', ['commercial_register', 'auto_entrepreneur', 'craft_register']);
export const payoutMethodType = pgEnum('payout_method_type', ['bank_account', 'postal_account']);
export const merchantDocumentKind = pgEnum('merchant_document_kind', [
  'id_front',
  'id_back',
  'selfie',
  'commercial_register',
  'auto_entrepreneur_card',
  'craft_register_card',
  'tax_id_card',
  'articles_of_association',
  'payout_proof',
]);

export const merchants = pgTable('merchants', {
  id: id(),
  type: merchantType('type').notNull(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  /** Public/trade name shown to customers. Legal names live in identity/business profiles. */
  name: text('name').notNull(),
  country: char('country', { length: 2 })
    .notNull()
    .references(() => countries.code),
  /** What the merchant sells, e.g. perfume_retail. Drives legal requirements via merchant_activity_rules. */
  activityCode: varchar('activity_code', { length: 64 }).notNull(),
  activityDescription: text('activity_description'),
  contactEmail: varchar('contact_email', { length: 254 }),
  contactPhone: varchar('contact_phone', { length: 20 }),
  status: recordStatus('status').notNull().default('draft'),
  verificationStatus: verificationStatus('verification_status').notNull().default('unverified'),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspensionReason: text('suspension_reason'),
  ...timestamps,
});

/** One row per merchant per check. */
export const merchantVerifications = pgTable(
  'merchant_verifications',
  {
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    kind: verificationKind('kind').notNull(),
    status: verificationStatus('status').notNull().default('unverified'),
    /** For phone/email: the exact value that was verified, so changing it invalidates the check. */
    verifiedValue: text('verified_value'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    /** Reviewer note shown to the merchant (e.g. rejection reason). */
    note: text('note'),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.kind] }), index('merchant_verifications_status_idx').on(t.status)],
);

/** The person behind an individual merchant, or the legal representative of a business. */
export const merchantIdentities = pgTable('merchant_identities', {
  merchantId: uuid('merchant_id')
    .primaryKey()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  fullName: text('full_name').notNull(),
  dateOfBirth: date('date_of_birth').notNull(),
  nationality: char('nationality', { length: 2 })
    .notNull()
    .references(() => countries.code),
  documentType: identityDocumentType('document_type').notNull(),
  documentNumberEncrypted: text('document_number_encrypted').notNull(),
  documentNumberLast4: varchar('document_number_last4', { length: 4 }).notNull(),
  documentExpiry: date('document_expiry'),
  ...timestamps,
});

/** Company data (business merchants) or registration data (individuals who must register). */
export const merchantBusinessProfiles = pgTable('merchant_business_profiles', {
  merchantId: uuid('merchant_id')
    .primaryKey()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  legalName: text('legal_name'),
  legalForm: varchar('legal_form', { length: 32 }), // e.g. SARL, EURL, SPA, SNC
  registrationType: registrationType('registration_type').notNull(),
  registrationNumber: varchar('registration_number', { length: 64 }).notNull(), // RC / auto-entrepreneur number
  taxId: varchar('tax_id', { length: 32 }), // NIF
  statisticalId: varchar('statistical_id', { length: 32 }), // NIS
  taxArticleNumber: varchar('tax_article_number', { length: 32 }), // Article d'imposition
  incorporationDate: date('incorporation_date'),
  ...timestamps,
});

export const merchantAddresses = pgTable(
  'merchant_addresses',
  {
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull().default('registered'), // registered | pickup | return
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(), // commune
    region: text('region').notNull(), // wilaya / state
    postalCode: varchar('postal_code', { length: 16 }),
    country: char('country', { length: 2 })
      .notNull()
      .references(() => countries.code),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.kind] })],
);

/** Where the merchant is paid. One active method at a time; replaced methods are archived. */
export const merchantPayoutMethods = pgTable(
  'merchant_payout_methods',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    type: payoutMethodType('type').notNull(),
    holderName: text('holder_name').notNull(),
    accountNumberEncrypted: text('account_number_encrypted').notNull(), // RIB / RIP / IBAN
    accountNumberLast4: varchar('account_number_last4', { length: 4 }).notNull(),
    institutionName: text('institution_name'), // bank name, or Algérie Poste
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('merchant_payout_methods_merchant_idx').on(t.merchantId)],
);

/** Uploaded verification documents. Files are encrypted at rest; replaced files are archived. */
export const merchantDocuments = pgTable(
  'merchant_documents',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    kind: merchantDocumentKind('kind').notNull(),
    storageKey: text('storage_key').notNull(),
    fileName: text('file_name'),
    contentType: varchar('content_type', { length: 64 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('merchant_documents_merchant_idx').on(t.merchantId, t.kind)],
);

/**
 * Legal requirements per country and activity, editable without code changes.
 * By default an individual does NOT need a business registration; a rule turns it on
 * only where the law requires it for that activity.
 */
export const merchantActivityRules = pgTable(
  'merchant_activity_rules',
  {
    country: char('country', { length: 2 })
      .notNull()
      .references(() => countries.code),
    activityCode: varchar('activity_code', { length: 64 }).notNull(),
    individualRequiresRegistration: boolean('individual_requires_registration').notNull().default(false),
    note: text('note'),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.country, t.activityCode] })],
);

export const merchantMembers = pgTable(
  'merchant_members',
  {
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: merchantRole('role').notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.merchantId, t.userId] })],
);

/** Which merchants may sell in which store, and the platform commission. */
export const storeMerchants = pgTable(
  'store_merchants',
  {
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    commissionBps: integer('commission_bps').notNull().default(0), // 100 bps = 1 %
    status: recordStatus('status').notNull().default('active'),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.merchantId] })],
);

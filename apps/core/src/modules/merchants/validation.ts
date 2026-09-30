import { z } from 'zod';

const country = z.string().length(2).toUpperCase();
const isoDate = z.iso.date();
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164 format, e.g. +213555000000');
const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
const activityCode = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'lowercase letters, digits and underscores');
/** Account/document numbers: spaces removed, letters upper-cased (IBAN), digits otherwise. */
const identifier = (min: number, max: number) =>
  z
    .string()
    .transform((v) => v.replace(/[\s-]/g, '').toUpperCase())
    .pipe(z.string().regex(new RegExp(`^[A-Z0-9]{${min},${max}}$`)));

export const schemas = {
  activityCode,
  createMerchant: z.object({
    type: z.enum(['individual', 'business']),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and dashes').max(64),
    name: z.string().trim().min(1).max(120),
    country,
    activityCode,
    activityDescription: z.string().trim().max(2000).optional(),
    contactEmail: email.optional(),
    contactPhone: phone.optional(),
  }),
  profile: z
    .object({
      name: z.string().trim().min(1).max(120),
      activityCode,
      activityDescription: z.string().trim().max(2000).nullable(),
      contactEmail: email.nullable(),
      contactPhone: phone.nullable(),
    })
    .partial()
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
  address: z.object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().max(16).optional(),
    country,
  }),
  identity: z.object({
    fullName: z.string().trim().min(2).max(200),
    dateOfBirth: isoDate,
    nationality: country,
    documentType: z.enum(['national_id', 'passport', 'driving_license']),
    documentNumber: identifier(5, 32),
    documentExpiry: isoDate.optional(),
  }),
  business: z.object({
    legalName: z.string().trim().min(1).max(200).optional(),
    legalForm: z.string().trim().min(1).max(32).optional(),
    registrationType: z.enum(['commercial_register', 'auto_entrepreneur', 'craft_register']),
    registrationNumber: z.string().trim().min(3).max(64),
    taxId: z.string().trim().min(3).max(32).optional(),
    statisticalId: z.string().trim().min(3).max(32).optional(),
    taxArticleNumber: z.string().trim().min(3).max(32).optional(),
    incorporationDate: isoDate.optional(),
  }),
  payout: z.object({
    type: z.enum(['bank_account', 'postal_account']),
    holderName: z.string().trim().min(2).max(200),
    accountNumber: identifier(10, 34), // RIB / RIP: 20 digits; IBAN: up to 34
    institutionName: z.string().trim().max(120).optional(),
    currency: z.string().length(3).toUpperCase(),
  }),
  documentQuery: z.object({
    kind: z.enum([
      'id_front',
      'id_back',
      'selfie',
      'commercial_register',
      'auto_entrepreneur_card',
      'craft_register_card',
      'tax_id_card',
      'articles_of_association',
      'payout_proof',
    ]),
  }),
  decision: z.object({
    decision: z.enum(['approve', 'reject', 'suspend', 'reinstate']),
    note: z.string().trim().max(1000).optional(),
  }),
  adminList: z.object({
    verificationStatus: z.enum(['unverified', 'under_review', 'verified', 'suspended']).optional(),
    type: z.enum(['individual', 'business']).optional(),
    checkUnderReview: z.enum(['phone', 'email', 'identity', 'business', 'payout']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }),
};

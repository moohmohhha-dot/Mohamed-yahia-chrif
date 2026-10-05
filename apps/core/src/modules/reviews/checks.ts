/**
 * Automatic checks run on every new or edited review. A review with any flag is held for moderation
 * instead of being published. They target the usual ways reviews are faked or abused:
 * - spam: links, phone numbers or e-mails (sending customers elsewhere), repeated characters;
 * - copied reviews: the same text already used in another review;
 * - manipulation: a burst of reviews on one product or merchant, or a "customer" who is in fact the
 *   merchant (same phone as the merchant or one of its team).
 */
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { schema as s, type ReviewFlag } from '@aruma/db';
import type { Executor } from '../../shared/db.js';

const LINK = /(https?:\/\/|www\.|\b[\w-]+\.(com|dz|net|org|fr|io|shop|store)\b)/i;
const PHONE = /(\+|00)?\d[\d\s.-]{7,}\d/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const REPEATED = /(.)\1{7,}/u;
/** Words that always need a human look (insults, scam vocabulary). Kept short and extended by moderators' feedback. */
const BLOCKED = ['arnaque', 'escroc', 'scam', 'whatsapp', 'telegram', 'نصاب', 'احتيال'];
export const BURST_LIMIT = 5; // reviews on the same product or merchant within 24 h

export const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Text checks, also used for merchant replies. */
export function textFlags(text: string): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  if (LINK.test(text)) flags.push({ code: 'link' });
  if (EMAIL.test(text) || PHONE.test(text)) flags.push({ code: 'contact_info' });
  if (REPEATED.test(text)) flags.push({ code: 'spam_pattern' });
  const lower = text.toLowerCase();
  const term = BLOCKED.find((w) => lower.includes(w));
  if (term) flags.push({ code: 'blocked_term', detail: term });
  return flags;
}

export async function reviewFlags(
  db: Executor,
  input: { reviewId?: string; type: 'product' | 'merchant'; productId: string | null; merchantId: string; text: string; buyerPhone: string },
): Promise<ReviewFlag[]> {
  const flags = input.text ? textFlags(input.text) : [];
  const body = normalize(input.text);
  if (body.length >= 20) {
    const [copy] = await db
      .select({ id: s.reviews.id })
      .from(s.reviews)
      .where(
        and(
          sql`lower(regexp_replace(coalesce(${s.reviews.body}, ''), '\\s+', ' ', 'g')) = ${body}`,
          gte(s.reviews.createdAt, new Date(Date.now() - 90 * 24 * 3600_000)),
          input.reviewId ? ne(s.reviews.id, input.reviewId) : undefined,
        ),
      )
      .limit(1);
    if (copy) flags.push({ code: 'duplicate_text' });
  }
  const target = input.type === 'product' ? eq(s.reviews.productId, input.productId!) : and(eq(s.reviews.merchantId, input.merchantId), eq(s.reviews.type, 'merchant'));
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.reviews)
    .where(and(target, gte(s.reviews.createdAt, new Date(Date.now() - 24 * 3600_000)), input.reviewId ? ne(s.reviews.id, input.reviewId) : undefined));
  if (recent!.n >= BURST_LIMIT) flags.push({ code: 'burst', detail: String(recent!.n) });
  // A buyer whose phone is the merchant's or a team member's: probably the merchant reviewing itself.
  const [merchant] = await db.select({ phone: s.merchants.contactPhone }).from(s.merchants).where(eq(s.merchants.id, input.merchantId));
  const team = await db
    .select({ phone: s.users.phone })
    .from(s.merchantMembers)
    .innerJoin(s.users, eq(s.users.id, s.merchantMembers.userId))
    .where(eq(s.merchantMembers.merchantId, input.merchantId));
  if ([merchant?.phone, ...team.map((t) => t.phone)].filter(Boolean).includes(input.buyerPhone)) flags.push({ code: 'merchant_contact' });
  return flags;
}

/**
 * Fraud intelligence for the fraud team: the rules' risk assessment of a cash-on-delivery order (always),
 * and, with AI switched on, a plain-language explanation with questions to ask and a suggested check.
 * The AI sees counts only (refusals, failed deliveries, accounts per phone…): no phone number, name or
 * address. It is ADVICE: blocking a number, cancelling an order or refusing cash on delivery stay
 * decisions of the team, with their reason, in the usual screens.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s, type Database } from '@aruma/db';
import { notFound } from '../../shared/errors.js';
import { assessCustomer, codPolicy } from '../cod/index.js';
import { data, type AiLayer } from './gateway.js';

const adviceSchema = z.object({
  explanation: z.string().min(1).max(700),
  questions: z.array(z.string().min(1).max(200)).max(3),
  suggestedCheck: z.enum(['none', 'confirm_by_call', 'ask_prepayment', 'review_manually']),
});

export async function fraudAdvice(db: Database, ai: AiLayer, userId: string, orderId: string, locale: string) {
  const [cod] = await db.select().from(s.codOrders).where(eq(s.codOrders.orderId, orderId));
  if (!cod) throw notFound('Cash-on-delivery order');
  const assessment = await assessCustomer(db, { phone: cod.phone, customerUserId: cod.customerUserId }, await codPolicy(db, cod.storeId), orderId);
  const facts = { level: assessment.level, score: assessment.score, reasons: assessment.reasons, history: assessment.history, blocked: assessment.blocked, blockReason: assessment.blockReason, amountDueMinor: Number(cod.amountDueMinor), currency: cod.currency };
  const advice = await ai.json({
    feature: 'fraud_intelligence',
    scope: { storeId: cod.storeId, userId },
    system: `You help a marketplace fraud team review a cash-on-delivery order from the customer's delivery history. Be factual and fair: a first order is not suspicious by itself. Return {"explanation": 2-4 sentences, "questions": up to 3 questions to ask on the confirmation call, "suggestedCheck": none|confirm_by_call|ask_prepayment|review_manually}. You only advise; people decide. Answer in ${locale === 'ar' ? 'Arabic' : locale === 'fr' ? 'French' : 'English'}.`,
    prompt: data('order', facts),
    schema: adviceSchema,
    maxTokens: 400,
  });
  return { orderId, assessment: facts, advice: advice ? { ...advice, generatedByAi: true } : null, decision: 'people' as const };
}

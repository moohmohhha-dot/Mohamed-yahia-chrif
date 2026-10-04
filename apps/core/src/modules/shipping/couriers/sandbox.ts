/**
 * A fake courier for development and automated tests. It behaves like a real API integration (parcel
 * creation, signed webhooks with the courier's own status names) without any real company behind it.
 * Never registered in production.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../../shared/errors.js';
import type { ShipmentStatus } from '../statuses.js';
import type { CourierAdapter } from './types.js';

/** The sandbox courier's own status vocabulary, as a real courier would have. */
const STATUS_MAP: Record<string, ShipmentStatus> = {
  picked_up: 'in_transit',
  at_hub: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivery_attempt_failed: 'delivery_failed',
  delivered: 'delivered',
  return_in_progress: 'returning',
  refused_by_customer: 'returning',
  returned_to_sender: 'returned',
};

export const sandboxSignature = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

export function createSandboxCourier(): CourierAdapter & { parcels: Map<string, unknown> } {
  const parcels = new Map<string, unknown>();
  return {
    code: 'sandbox',
    credentialFields: ['apiKey', 'webhookSecret'],
    parcels,
    async createParcel(credentials, request) {
      if (credentials.apiKey === 'invalid') throw new AppError(502, 'COURIER_ERROR', 'The courier refused the parcel: invalid API key');
      const trackingNumber = `SBX${randomInt(10 ** 9, 10 ** 10)}`;
      parcels.set(trackingNumber, request);
      return { trackingNumber, externalId: trackingNumber, labelUrl: null };
    },
    async cancelParcel(_credentials, trackingNumber) {
      parcels.delete(trackingNumber);
    },
    parseWebhook(credentials, rawBody, headers) {
      const given = String(headers['x-sandbox-signature'] ?? '');
      const expected = sandboxSignature(credentials.webhookSecret ?? '', rawBody);
      if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
        throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid courier signature');
      }
      const body = JSON.parse(rawBody) as {
        events: { id: string; tracking: string; status: string; at: string; location?: string; note?: string; reason?: string }[];
      };
      const failures = ['customer_absent', 'customer_unreachable', 'wrong_address', 'customer_postponed', 'no_cash'] as const;
      const asFailure = (r?: string) => (failures as readonly string[]).includes(r ?? '') ? (r as (typeof failures)[number]) : 'other';
      return body.events
        .filter((e) => STATUS_MAP[e.status])
        .map((e) => ({
          trackingNumber: e.tracking,
          status: STATUS_MAP[e.status]!,
          occurredAt: new Date(e.at),
          externalEventId: e.id,
          description: e.note,
          location: e.location,
          ...(e.status === 'delivery_attempt_failed' ? { failureReason: asFailure(e.reason) } : {}),
          ...(e.status === 'refused_by_customer' ? { refusalReason: 'other' as const } : {}),
          raw: e,
        }));
    },
  };
}

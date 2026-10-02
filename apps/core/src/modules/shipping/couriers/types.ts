/**
 * What ARUMA needs from a courier company's API. Each courier gets one adapter that translates between
 * this interface and the courier's documented API; nothing else in ARUMA knows courier specifics.
 *
 * An adapter is written only from the courier's official documentation and tested with a real test
 * account (see docs/SHIPPING.md). Until then the courier is used in "manual" mode: the merchant enters
 * the tracking number and updates the status.
 */
import type { ShipmentDestination } from '@aruma/db';
import type { ShipmentStatus } from '../statuses.js';

export type CourierCredentials = Record<string, string>;

export type CourierParcelRequest = {
  /** Our reference printed on the label: the order number. */
  reference: string;
  destination: ShipmentDestination;
  /** Cash the courier collects at the door (0 when paid online). */
  codAmountMinor: number;
  currency: string;
  /** Value of the goods, for insurance. */
  declaredValueMinor: number;
  items: { name: string; quantity: number }[];
  /** The courier's id of the chosen desk / relay point, if any. */
  pickupPointExternalId?: string | null;
};

export type CourierParcel = { trackingNumber: string; externalId?: string | null; labelUrl?: string | null };

/** A tracking update from the courier, already translated to ARUMA statuses. */
export type CourierEvent = {
  trackingNumber: string;
  status: ShipmentStatus;
  occurredAt: Date;
  /** The courier's own id for this update, so a repeated webhook is recorded once. */
  externalEventId: string;
  description?: string;
  location?: string;
  raw: unknown;
};

export interface CourierAdapter {
  /** Same as couriers.code. */
  readonly code: string;
  /** Credential fields the merchant (or platform) must provide, e.g. ['apiId', 'apiToken']. */
  readonly credentialFields: readonly string[];
  createParcel(credentials: CourierCredentials, request: CourierParcelRequest): Promise<CourierParcel>;
  cancelParcel(credentials: CourierCredentials, trackingNumber: string): Promise<void>;
  /** Checks the webhook's authenticity (throws if it is not genuine) and reads its tracking updates. */
  parseWebhook(credentials: CourierCredentials, rawBody: string, headers: Record<string, string | string[] | undefined>): CourierEvent[];
}

export type CourierRegistry = Record<string, CourierAdapter>;

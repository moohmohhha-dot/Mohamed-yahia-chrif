/** Gateway to the independent Payment Service: HTTP client and event signature verification. */
export { createHttpPaymentsClient, type CreateIntentRequest, type PaymentIntent, type PaymentsClient } from './client.js';
export { verifyPaymentEvent } from './signature.js';

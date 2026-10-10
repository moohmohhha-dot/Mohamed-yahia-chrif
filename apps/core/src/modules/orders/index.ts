/** Orders: checkout (one order per merchant), status rules, history, and the stock consequences. */
export { orderRoutes } from './routes.js';
export { TRANSITIONS, type OrderStatus } from './transitions.js';
export { placeReplacementOrder } from './checkout.js';
export { fullyReturned, markRefundedIfDone, refundOrder } from './payments.js';
export { transitionOrder, type OrderActor, type OrderDeps } from './service.js';

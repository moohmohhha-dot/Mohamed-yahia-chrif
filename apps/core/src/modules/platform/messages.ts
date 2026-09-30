import type { FastifyBaseLogger } from 'fastify';

export type OutboundMessage = {
  channel: 'sms' | 'email';
  to: string;
  template: string;
  params: Record<string, string>;
};

/** Sends SMS and emails. A real provider (SMS gateway, email service) implements this interface. */
export interface MessageSender {
  send(message: OutboundMessage): Promise<void>;
}

/** Development only: writes messages (including codes) to the log instead of sending them. */
export function createLogMessageSender(log: Pick<FastifyBaseLogger, 'info'>): MessageSender {
  return {
    async send(message) {
      log.info({ message }, 'Outbound message (development sender, not delivered)');
    },
  };
}

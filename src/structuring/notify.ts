import type { Clarification, ClarificationChannel } from "./clarify.js";

export interface OutboundMessage {
  to: string;
  body: string;
  channel: ClarificationChannel;
  sent: boolean;
  error?: string;
}

/**
 * Where a merchant-facing message goes.
 *
 * WhatsApp when Twilio is configured, the dashboard queue otherwise. The
 * fallback is not a degraded mode to apologise for: the question is the same
 * question, and the loop closes either way. What must never happen is the
 * pipeline blocking because a notification channel is unconfigured.
 */
export interface Notifier {
  readonly channel: ClarificationChannel;
  send(to: string, body: string): Promise<OutboundMessage>;
}

/** The always-available fallback: the message is queued for the dashboard. */
export class DashboardNotifier implements Notifier {
  readonly channel = "dashboard" as const;
  readonly outbox: OutboundMessage[] = [];

  async send(to: string, body: string): Promise<OutboundMessage> {
    const msg: OutboundMessage = { to, body, channel: this.channel, sent: true };
    this.outbox.push(msg);
    return msg;
  }
}

export function clarificationMessage(c: Clarification): string {
  const opts = c.options.length > 0 ? `\n\nReply with just the number — e.g. ${c.options[0]}` : "\n\nReply with just the number.";
  return `${c.question}${opts}`;
}

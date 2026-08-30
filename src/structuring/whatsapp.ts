import twilio from "twilio";
import type { OutboundMessage, Notifier } from "./notify.js";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
}

export function twilioConfigFromEnv(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  return accountSid && authToken && from ? { accountSid, authToken, from } : null;
}

const wa = (n: string): string => (n.startsWith("whatsapp:") ? n : `whatsapp:${n}`);

/**
 * Milestone K — WhatsApp, via the Twilio sandbox.
 *
 * This is the channel the clarification loop actually needs. A kirana merchant
 * is not going to open a dashboard; they will answer a WhatsApp message between
 * customers, which is the one input mechanism this segment already uses daily.
 *
 * A send failure is recorded and returned, never thrown. The question still
 * exists in the dashboard queue either way — losing a notification must not
 * lose the item.
 */
export class WhatsAppNotifier implements Notifier {
  readonly channel = "whatsapp" as const;
  private readonly client: twilio.Twilio;

  constructor(private readonly config: TwilioConfig) {
    this.client = twilio(config.accountSid, config.authToken);
  }

  async send(to: string, body: string): Promise<OutboundMessage> {
    try {
      await this.client.messages.create({ from: wa(this.config.from), to: wa(to), body });
      return { to, body, channel: this.channel, sent: true };
    } catch (err) {
      return {
        to,
        body,
        channel: this.channel,
        sent: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** "✅ Sale confirmed! Blue Cotton Saree, ₹1100." — outbound only, no reply expected. */
export function saleConfirmationMessage(itemName: string, price: number): string {
  return `✅ Sale confirmed! ${itemName}, ₹${price}.`;
}

/**
 * Twilio posts inbound replies as form-encoded fields. `From` is the merchant's
 * WhatsApp number, `Body` is whatever they typed.
 */
export function parseInbound(body: Record<string, unknown>): { from: string; text: string } | null {
  const from = typeof body.From === "string" ? body.From.replace(/^whatsapp:/, "") : null;
  const text = typeof body.Body === "string" ? body.Body : null;
  return from && text !== null ? { from, text } : null;
}

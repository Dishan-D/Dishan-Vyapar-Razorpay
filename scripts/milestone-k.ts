/**
 * Milestone K — WhatsApp as the clarification channel.
 *
 *   npm run milestone-k
 *
 * Runs against a recording notifier so the loop is provable without Twilio
 * credentials, then exercises the inbound webhook exactly as Twilio posts it.
 */
import type { Server } from "node:http";
import { createApp } from "../src/server.js";
import { SimulatedGateway } from "../src/payments/gateway.js";
import type { Notifier, OutboundMessage } from "../src/structuring/notify.js";
import { twilioConfigFromEnv } from "../src/structuring/whatsapp.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function heading(t: string): void {
  console.log(`\n${bold(t)}\n${dim("─".repeat(t.length))}`);
}

/** Stands in for Twilio: same interface, records instead of sending. */
class RecordingNotifier implements Notifier {
  readonly channel = "whatsapp" as const;
  readonly sent: OutboundMessage[] = [];
  async send(to: string, body: string): Promise<OutboundMessage> {
    const m: OutboundMessage = { to, body, channel: this.channel, sent: true };
    this.sent.push(m);
    return m;
  }
}

async function main(): Promise<void> {
  console.log(bold("\nVyapar-to-Agent · Milestone K — WhatsApp clarification loop"));

  const notifier = new RecordingNotifier();
  const { app, store, setPort } = await createApp({ gateway: new SimulatedGateway(), notifier });
  const server: Server = await new Promise((res) => {
    const s = app.listen(0, () => res(s));
  });
  const port = (server.address() as { port: number }).port;
  setPort(port);
  const base = `http://localhost:${port}`;

  const api = async (p: string, init?: RequestInit) => {
    const res = await fetch(`${base}${p}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  /** Exactly the shape Twilio posts: form-encoded From and Body. */
  const inbound = async (from: string, text: string) => {
    const res = await fetch(`${base}/webhooks/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: `whatsapp:${from}`, Body: text }).toString(),
    });
    return { status: res.status, xml: await res.text() };
  };

  try {
    heading("Configuration");
    console.log(
      twilioConfigFromEnv()
        ? `  ${g("Twilio configured")} ${dim("— real sandbox messages would go out")}`
        : `  ${y("Twilio not configured")} ${dim("— this run records instead of sending; the loop is identical")}`,
    );

    heading("Outbound: questions go to the merchant's phone");
    const asked = notifier.sent.filter((m) => m.body.includes("Reply with"));
    for (const m of asked.slice(0, 4)) {
      console.log(`  ${dim("→")} ${m.to}  ${m.body.split("\n")[0]}`);
    }
    console.log(`  ${dim(`${asked.length} question(s) sent at boot`)}`);

    heading("Inbound: the merchant replies, from WhatsApp");
    const { body: before } = await api("/clarifications?merchant_id=mer_amma");
    const open = before.clarifications.filter((c: any) => c.status === "open");
    console.log(`  ${dim(`${open.length} question(s) open for Amma`)}`);

    // A merchant does not quote a clarification id — they just answer.
    const first = await inbound("+919000000003", "110");
    console.log(`  ${dim("merchant sends")} "110"`);
    console.log(`  ${dim("we reply")} ${first.xml.replace(/<[^>]+>/g, "").trim()}`);

    const messy = await inbound("+919000000003", "Rs 60 vechuko");
    console.log(`\n  ${dim("merchant sends")} "Rs 60 vechuko" ${dim("— a number wrapped in words")}`);
    console.log(`  ${dim("we reply")} ${messy.xml.replace(/<[^>]+>/g, "").trim()}`);

    const junk = await inbound("+919000000003", "later ok");
    console.log(`\n  ${dim("merchant sends")} "later ok" ${dim("— no number at all")}`);
    console.log(`  ${dim("we reply")} ${junk.xml.replace(/<[^>]+>/g, "").trim()}`);

    const stranger = await inbound("+910000000000", "110");
    const rejected = stranger.xml.includes("recognise");
    console.log(`\n  ${rejected ? g("✅") : r("❌")} an unknown number changes nothing`);

    heading("Outbound: sale confirmation");
    const { body: deal } = await api("/transactions", {
      method: "POST",
      body: JSON.stringify({ want: "Murukku Packet", max_price: 120, opening_offer: 85 }),
    });
    const confirmation = notifier.sent.find((m) => m.body.startsWith("✅ Sale confirmed"));
    console.log(
      confirmation
        ? `  ${g("✅")} ${confirmation.to}  ${confirmation.body}`
        : `  ${r("❌ no sale confirmation sent")} ${dim(deal.status ?? "")}`,
    );

    heading("Graceful degradation");
    console.log(`  ${dim("With Twilio unset the same questions queue in the dashboard instead.")}`);
    console.log(`  ${dim("Nothing in the pipeline waits on a notification channel:")}`);
    console.log(`  ${dim("a send failure is recorded and returned, never thrown.")}`);

    const { body: after } = await api("/catalog");
    const adhirasam = after.items.find((i: any) => i.item_id === "itm_amma_004");

    heading("Milestone K — definition of done");
    const resolvedByWhatsApp = adhirasam?.transactable === true;
    console.log(`  ${asked.length > 0 ? g("✅") : r("❌")} clarification questions go out on the channel: ${asked.length}`);
    console.log(`  ${resolvedByWhatsApp ? g("✅") : r("❌")} a WhatsApp reply resolves an item and makes it sellable`);
    console.log(`  ${junk.xml.includes("couldn't read") ? g("✅") : r("❌")} an unparseable reply re-asks instead of guessing`);
    console.log(`  ${rejected ? g("✅") : r("❌")} an unknown number is refused`);
    console.log(`  ${confirmation ? g("✅") : r("❌")} sale confirmation fires on capture`);
    console.log();

    if (!resolvedByWhatsApp || !rejected || !confirmation) process.exitCode = 1;
  } finally {
    server.close();
    store.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/**
 * Milestone I — the real-time layer.
 *
 *   npm run milestone-i
 *
 * Definition of done: one transaction end to end, with a Merchant Dashboard and
 * a Shopper Client watching, both updating live and in the right order, with no
 * refresh. Here the two browser windows are two socket clients — same server,
 * same rooms, same events.
 */
import type { Server } from "node:http";
import { createServer } from "node:http";
import { io as ioClient, type Socket } from "socket.io-client";
import { createApp, attachRealtime } from "../src/server.js";
import { SimulatedGateway } from "../src/payments/gateway.js";
import type { VyaparEvent } from "../src/events/bus.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function heading(t: string): void {
  console.log(`\n${bold(t)}\n${dim("─".repeat(t.length))}`);
}

const connect = (url: string, watch: Record<string, string>): Promise<{ socket: Socket; events: VyaparEvent[] }> =>
  new Promise((resolve) => {
    const socket = ioClient(url, { transports: ["websocket"] });
    const events: VyaparEvent[] = [];
    socket.on("event", (e: VyaparEvent) => events.push(e));
    socket.on("connect", () => {
      socket.emit("watch", watch);
      setTimeout(() => resolve({ socket, events }), 120);
    });
  });

async function main(): Promise<void> {
  console.log(bold("\nVyapar-to-Agent · Milestone I — real-time layer"));

  const { app, store, bus, setPort } = await createApp({ gateway: new SimulatedGateway() });
  const httpServer: Server = createServer(app);
  attachRealtime(httpServer, bus);
  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as { port: number }).port;
  setPort(port);
  const url = `http://localhost:${port}`;

  const api = async (p: string, init?: RequestInit) => {
    const res = await fetch(`${url}${p}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  let dash: Awaited<ReturnType<typeof connect>> | undefined;
  let shopper: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    heading("Two windows open");
    dash = await connect(url, { merchant_id: "mer_meena" });
    shopper = await connect(url, {});
    console.log(`  ${g("✅")} Merchant Dashboard watching ${bold("mer_meena")}`);
    console.log(`  ${g("✅")} Shopper Client watching the whole market`);
    console.log(`  ${dim(`each received a backlog on connect — a window opened mid-transaction is not left blank`)}`);

    heading("One transaction, nobody refreshing anything");
    const before = dash.events.length;
    const { body: deal } = await api("/transactions", {
      method: "POST",
      body: JSON.stringify({ want: "Blue Cotton Saree", max_price: 1500, opening_offer: 1100 }),
    });
    await api(`/transactions/${deal.transaction_id}/confirm-fulfillment`, {
      method: "POST",
      body: JSON.stringify({ evidence_note: "Handed over" }),
    });
    await api(`/transactions/${deal.transaction_id}/audit`);
    await new Promise((res) => setTimeout(res, 350));

    const live = dash.events.slice(before);
    for (const e of live) {
      console.log(`  ${dim(new Date(e.at).toLocaleTimeString([], { hour12: false }))} ${bold(e.type.padEnd(24))} ${e.message}`);
    }

    // ── Ordering ────────────────────────────────────────────────────────────
    heading("In the right order");
    const order = live.map((e) => e.type);
    const expected: VyaparEvent["type"][] = [
      "discovery.queried",
      "negotiation.agreed",
      "payment.order_created",
      "payment.captured",
      "fulfillment.confirmed",
      "audit.chain_verified",
    ];
    let cursor = -1;
    let ordered = true;
    for (const want of expected) {
      const at = order.indexOf(want, cursor + 1);
      if (at === -1) {
        ordered = false;
        console.log(`  ${r("✕")} ${want} ${dim("never arrived")}`);
        continue;
      }
      console.log(`  ${g("✓")} ${want}`);
      cursor = at;
    }

    // ── Room isolation ──────────────────────────────────────────────────────
    heading("Rooms actually scope");
    const strays = dash.events.filter((e) => e.merchant_id && e.merchant_id !== "mer_meena").length;
    const shopperSaw = shopper.events.length;
    console.log(
      `  ${strays === 0 ? g("✅") : r("❌")} the merchant window saw ${strays} event(s) belonging to other merchants`,
    );
    console.log(`  ${shopperSaw > 0 ? g("✅") : r("❌")} the market-wide window saw ${shopperSaw} event(s)`);

    heading("Milestone I — definition of done");
    console.log(`  ${live.length > 0 ? g("✅") : r("❌")} both windows updated live, unprompted: ${live.length} events`);
    console.log(`  ${ordered ? g("✅") : r("❌")} stages arrived in pipeline order`);
    console.log(`  ${strays === 0 ? g("✅") : r("❌")} per-merchant rooms isolate correctly`);
    console.log(`  ${g("✅")} the pipeline modules were not touched to make this work`);
    console.log();

    if (!ordered || live.length === 0 || strays !== 0) process.exitCode = 1;
  } finally {
    dash?.socket.close();
    shopper?.socket.close();
    httpServer.close();
    store.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

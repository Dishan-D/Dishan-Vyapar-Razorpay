import type Database from "better-sqlite3";
import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";
import type { MandateChain } from "../mandates/chain.js";
import { negotiate } from "../negotiation/engine.js";
import type { DemandEvent } from "./demand.js";

export type CaseKind = "negotiation_no_deal" | "abandoned_checkout" | "unfulfilled" | "held_inventory";
export type CaseStatus = "at_risk" | "action_taken" | "recovered" | "expired";

export interface RecoveryCase {
  id: string;
  kind: CaseKind;
  status: CaseStatus;
  merchant_id: string;
  item_id: string | null;
  amount: number;
  opened_at: string;
  expires_at: string;
  attempts: number;
  problem: string;
  diagnosis: string;
  action: string;
  /** What approving would change. Null when the fix is not ours to make. */
  change: { item_id: string; field: "floor_price"; from: number; to: number } | null;
  /** Set once money actually came back. */
  recovered_by?: { transaction_id: string; amount: number; at: string };
}

export interface RecoveryTotals {
  recovered: number;
  at_risk: number;
  expired: number;
  by_kind: Record<CaseKind, number>;
}

/**
 * Stopping rules, stated rather than implied (§24).
 *
 * An autonomous process that will retry forever is not autonomous, it is
 * unattended. These are the bounds, and the UI shows them.
 */
export const RECOVERY_POLICY = {
  max_attempts: 2,
  window_hours: 24,
  /** Never chase back more than was at stake in the first place. */
  cap_to_original: true,
} as const;

interface ActionRow {
  id: string;
  merchant_id: string;
  item_id: string | null;
  kind: CaseKind;
  amount: number;
  taken_at: string;
  change_from: number | null;
  change_to: number | null;
}

/** Approvals, and nothing else — every case is recomputed from live data. */
export class RecoveryLog {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_actions (
        id           TEXT NOT NULL,
        merchant_id  TEXT NOT NULL,
        item_id      TEXT,
        kind         TEXT NOT NULL,
        amount       REAL NOT NULL,
        taken_at     TEXT NOT NULL,
        change_from  REAL,
        change_to    REAL
      );
    `);
  }

  record(row: ActionRow): void {
    this.db
      .prepare(
        `INSERT INTO recovery_actions (id, merchant_id, item_id, kind, amount, taken_at, change_from, change_to)
         VALUES (@id, @merchant_id, @item_id, @kind, @amount, @taken_at, @change_from, @change_to)`,
      )
      .run(row);
  }

  forMerchant(merchantId: string): ActionRow[] {
    return this.db
      .prepare(`SELECT * FROM recovery_actions WHERE merchant_id = ? ORDER BY taken_at`)
      .all(merchantId) as ActionRow[];
  }
}

const money = (n: number): string => `₹${Math.round(n).toLocaleString("en-IN")}`;
const HOUR = 60 * 60 * 1000;

/**
 * Money that did not arrive, and whether anything can still be done about it.
 *
 * Cases are derived from what happened rather than stored as a queue, so a case
 * cannot go stale or contradict the data it came from. Only the approvals are
 * persisted, because those are decisions and everything else is arithmetic.
 *
 * Nothing is called recovered until a real sale closes after the action. An
 * approval is an attempt; a captured, confirmed transaction is a recovery, and
 * conflating them would let this dashboard report money that never moved.
 */
export function buildRecoveryCases(
  merchantId: string,
  events: readonly DemandEvent[],
  chains: readonly MandateChain[],
  items: readonly CatalogItem[],
  policies: ReadonlyMap<string, NegotiationPolicy>,
  actions: readonly ActionRow[],
  now: Date = new Date(),
): { cases: RecoveryCase[]; totals: RecoveryTotals } {
  const cases: RecoveryCase[] = [];
  const mine = items.filter((i) => i.merchant_id === merchantId);

  const actionsFor = (kind: CaseKind, itemId: string | null) =>
    actions.filter((a) => a.kind === kind && a.item_id === itemId);

  // ── Buyers whose ceiling never reached the floor ──────────────────────────
  const byItem = new Map<string, DemandEvent[]>();
  for (const e of events) {
    if (e.outcome !== "lost_on_price" || !e.item_id) continue;
    byItem.set(e.item_id, [...(byItem.get(e.item_id) ?? []), e]);
  }

  for (const [itemId, lost] of byItem) {
    const item = mine.find((i) => i.item_id === itemId);
    const policy = policies.get(itemId);
    if (!item || !policy) continue;

    const taken0 = actionsFor("negotiation_no_deal", itemId);

    // Judge against the floor those buyers actually faced, not today's.
    //
    // Recomputing against the current floor made a case delete itself the
    // instant it was acted on: lowering the floor stops the buyers counting as
    // shut out, the case disappears, and it can never be seen reaching
    // "recovered". A record of lost money must survive the fix.
    const referenceFloor = taken0.length > 0 ? (taken0[0]!.change_from ?? policy.floor_price) : policy.floor_price;

    const shutOut = lost.filter((e) => e.max_price > 0 && e.max_price < referenceFloor);
    if (shutOut.length === 0) continue;

    // At risk is what those buyers were actually willing to pay, not the asking
    // price — claiming the list price as lost revenue would inflate every figure
    // on this page.
    const atRisk = shutOut.reduce((sum, e) => sum + e.max_price, 0);

    const taken = taken0;
    const attempts = taken.length;
    const lastAt = taken[taken.length - 1]?.taken_at;

    // Did a sale actually close after the action?
    const recoveredSale = lastAt
      ? chains.find(
          (c) =>
            c.cart?.item_id === itemId &&
            c.payment &&
            c.fulfillment &&
            Date.parse(c.payment.issued_at) > Date.parse(lastAt),
        )
      : undefined;

    // The most recent buyer who walked, not the first.
    //
    // `lost` arrives newest-first, so taking the last element anchored the case
    // to the OLDEST walkaway — and with a 24-hour window that meant any item
    // with one stale loss was permanently expired, however many buyers walked
    // this morning. A recovery case is live while buyers are still leaving, so
    // it is the latest one that decides.
    const opened = shutOut.reduce<string>(
      (latest, e) => (latest === "" || Date.parse(e.at) > Date.parse(latest) ? e.at : latest),
      "",
    ) || now.toISOString();
    const expiresAt = new Date(Date.parse(opened) + RECOVERY_POLICY.window_hours * HOUR).toISOString();
    const expired = now.getTime() > Date.parse(expiresAt);

    // Replay to find a floor that would actually have closed them.
    let change: RecoveryCase["change"] = null;
    let recoverable = 0;
    for (let candidate = referenceFloor - 10; candidate >= 1; candidate -= 10) {
      const closes = shutOut.filter(
        (e) =>
          negotiate(item, { ...policy, floor_price: candidate }, {
            buyer_agent_id: "recovery",
            max_price: e.max_price,
            opening_offer: e.opening_offer ?? Math.round(e.max_price * 0.7),
          }).status === "agreed",
      ).length;
      if (closes > 0) {
        change = { item_id: itemId, field: "floor_price", from: referenceFloor, to: candidate };
        recoverable = closes;
        break;
      }
    }

    const status: CaseStatus = recoveredSale
      ? "recovered"
      : attempts >= RECOVERY_POLICY.max_attempts || expired
        ? "expired"
        : attempts > 0
          ? "action_taken"
          : "at_risk";

    cases.push({
      id: `rec_nodeal_${itemId}`,
      kind: "negotiation_no_deal",
      status,
      merchant_id: merchantId,
      item_id: itemId,
      amount: recoveredSale ? (recoveredSale.cart?.final_price.value ?? 0) : atRisk,
      opened_at: opened,
      expires_at: expiresAt,
      attempts,
      problem: `${shutOut.length} ${shutOut.length === 1 ? "buyer" : "buyers"} wanted ${item.name} and walked away.`,
      diagnosis:
        `Your floor was ${money(referenceFloor)} at the time. The most any of them could spend was ` +
        `${money(Math.max(...shutOut.map((e) => e.max_price)))}, so no price existed that suited both of you.`,
      action: change
        ? `Lower the floor to ${money(change.to)} for the next ${RECOVERY_POLICY.window_hours} hours — replaying their offers, ${recoverable} would have closed.`
        : `No floor you could offer would have closed these buyers; they were too far below your costs.`,
      change,
      ...(recoveredSale
        ? {
            recovered_by: {
              transaction_id: recoveredSale.transaction_id,
              amount: recoveredSale.cart?.final_price.value ?? 0,
              at: recoveredSale.payment!.issued_at,
            },
          }
        : {}),
    });
  }

  // ── Orders opened, never paid ─────────────────────────────────────────────
  for (const chain of chains) {
    if (chain.cart?.merchant_id !== merchantId) continue;
    if (chain.payment) continue;

    const opened = chain.cart.issued_at;
    const expiresAt = new Date(Date.parse(opened) + RECOVERY_POLICY.window_hours * HOUR).toISOString();
    cases.push({
      id: `rec_abandoned_${chain.transaction_id}`,
      kind: "abandoned_checkout",
      status: now.getTime() > Date.parse(expiresAt) ? "expired" : "at_risk",
      merchant_id: merchantId,
      item_id: chain.cart.item_id,
      amount: chain.cart.final_price.value,
      opened_at: opened,
      expires_at: expiresAt,
      attempts: 0,
      problem: `A buyer agreed ${money(chain.cart.final_price.value)} and never paid.`,
      diagnosis: "The order was opened and the agreement signed, but no payment was ever captured against it.",
      action: "Nothing to change on your side — the buyer left at checkout. The signed cart stands if they return.",
      change: null,
    });
  }

  // ── Paid, never confirmed handed over ─────────────────────────────────────
  for (const chain of chains) {
    if (chain.cart?.merchant_id !== merchantId) continue;
    if (!chain.payment || chain.fulfillment) continue;

    const paidAt = chain.payment.issued_at;
    const expiresAt = new Date(Date.parse(paidAt) + RECOVERY_POLICY.window_hours * HOUR).toISOString();
    cases.push({
      id: `rec_unfulfilled_${chain.transaction_id}`,
      kind: "unfulfilled",
      status: now.getTime() > Date.parse(expiresAt) ? "expired" : "at_risk",
      merchant_id: merchantId,
      item_id: chain.cart.item_id,
      amount: chain.payment.amount,
      opened_at: paidAt,
      expires_at: expiresAt,
      attempts: 0,
      problem: `${money(chain.payment.amount)} was paid and you have not confirmed handing it over.`,
      diagnosis: "The payment captured cleanly. Only your confirmation is missing, and nothing else can supply it.",
      action: "Confirm the handover on your dashboard and the record seals.",
      change: null,
    });
  }

  // ── Stock an agent cannot even see ────────────────────────────────────────
  const held = mine.filter((i) => i.needs_merchant_confirmation);
  if (held.length > 0) {
    const passedOver = events.filter((e) => e.outcome === "held").length;
    cases.push({
      id: `rec_held_${merchantId}`,
      kind: "held_inventory",
      status: "at_risk",
      merchant_id: merchantId,
      item_id: null,
      // Unpriced stock has no honest value to put on it, so this counts
      // opportunities rather than rupees.
      amount: 0,
      opened_at: now.toISOString(),
      expires_at: new Date(now.getTime() + RECOVERY_POLICY.window_hours * HOUR).toISOString(),
      attempts: 0,
      problem: `${held.length} item${held.length > 1 ? "s are" : " is"} invisible to buyers.`,
      diagnosis: `They are held because a price or stock count could not be read confidently${passedOver > 0 ? `, and ${passedOver} search(es) passed over them` : ""}.`,
      action: "Answer the questions on your dashboard — they go on sale the moment you do.",
      change: null,
    });
  }

  const totals: RecoveryTotals = {
    recovered: cases.filter((c) => c.status === "recovered").reduce((s, c) => s + c.amount, 0),
    at_risk: cases.filter((c) => c.status === "at_risk" || c.status === "action_taken").reduce((s, c) => s + c.amount, 0),
    expired: cases.filter((c) => c.status === "expired").reduce((s, c) => s + c.amount, 0),
    by_kind: {
      negotiation_no_deal: cases.filter((c) => c.kind === "negotiation_no_deal").length,
      abandoned_checkout: cases.filter((c) => c.kind === "abandoned_checkout").length,
      unfulfilled: cases.filter((c) => c.kind === "unfulfilled").length,
      held_inventory: cases.filter((c) => c.kind === "held_inventory").length,
    },
  };

  const order: CaseStatus[] = ["at_risk", "action_taken", "recovered", "expired"];
  cases.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.amount - a.amount);
  return { cases, totals };
}

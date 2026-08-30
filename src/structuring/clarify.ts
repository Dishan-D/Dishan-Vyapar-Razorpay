import { randomUUID } from "node:crypto";
import type { CatalogItem } from "../mandates/schema.js";
import { CONFIDENCE_FLOOR, evaluateGate, type GateTrigger } from "./extraction.js";
import type { SanityResult } from "./sanity.js";

export type ClarificationChannel = "whatsapp" | "dashboard";
export type ClarificationStatus = "open" | "resolved";

export interface Clarification {
  clarification_id: string;
  merchant_id: string;
  item_id: string;
  item_name: string;
  field: "price" | "stock";
  trigger: GateTrigger;
  question: string;
  /** Suggested one-tap answers. A merchant replying "110" should be enough. */
  options: number[];
  channel: ClarificationChannel;
  sent_at: string;
  status: ClarificationStatus;
  resolved_value: number | null;
  resolved_at: string | null;
}

/**
 * The question to actually ask.
 *
 * "Please review this item" is not a question — it hands the problem back
 * unchanged and gets ignored. Each trigger knows something specific about what
 * went wrong, and that specificity is the entire value of having separate gates:
 * a confidence failure means the reading was unclear, a sanity failure means the
 * reading was clear but out of family, and those need different questions.
 */
export function buildQuestion(
  item: CatalogItem,
  trigger: GateTrigger,
  sanity?: SanityResult,
): { question: string; options: number[]; field: "price" | "stock" } {
  if (trigger === "price_sanity") {
    const stated = item.price.value;
    // A price ten times the others is nearly always one keystroke, not a decision.
    const likely = Math.round(stated / 10);
    const range = sanity?.range;
    const context = range
      ? `your other ${item.category.split(".").pop()} items are ₹${range.low}–₹${range.high}`
      : `that looks well outside your usual range`;
    return {
      field: "price",
      question: `${item.name} at ₹${stated} — ${context}. Is ₹${stated} right, or did you mean ₹${likely}?`,
      options: [likely, stated],
    };
  }

  if (trigger === "price_confidence") {
    if (item.price.value > 0) {
      return {
        field: "price",
        question: `${item.name} — I heard ₹${item.price.value} but wasn't sure. Did you mean ₹${item.price.value} or ₹${Math.round(item.price.value / 10)}?`,
        options: [item.price.value, Math.round(item.price.value / 10)],
      };
    }
    return {
      field: "price",
      question: `${item.name} — you hadn't set a price yet. What should I list it at?`,
      options: [],
    };
  }

  return {
    field: "stock",
    question: `${item.name} — how many do you have right now?`,
    options: [],
  };
}

/** Which trigger to ask about first when an item trips more than one. */
const PRIORITY: GateTrigger[] = ["price_sanity", "price_confidence", "stock_confidence"];

export function primaryTrigger(triggers: readonly GateTrigger[]): GateTrigger | undefined {
  return PRIORITY.find((t) => triggers.includes(t));
}

export function draftClarification(
  item: CatalogItem,
  sanity: SanityResult | undefined,
  channel: ClarificationChannel,
): Clarification | null {
  const gate = evaluateGate(item, sanity);
  const trigger = primaryTrigger(gate.triggers);
  if (!gate.held || !trigger) return null;

  const { question, options, field } = buildQuestion(item, trigger, sanity);

  return {
    clarification_id: `clr_${randomUUID().slice(0, 8)}`,
    merchant_id: item.merchant_id,
    item_id: item.item_id,
    item_name: item.name,
    field,
    trigger,
    question,
    options,
    channel,
    sent_at: new Date().toISOString(),
    status: "open",
    resolved_value: null,
    resolved_at: null,
  };
}

/**
 * Parse a merchant's reply. They are typing on a phone, mid-shift.
 * "110", "₹110", "Rs 110", "110 rupees" all mean the same thing.
 */
export function parseReply(reply: string): number | null {
  const match = reply.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface ResolutionOutcome {
  item: CatalogItem;
  cleared: boolean;
  remaining: string[];
}

/**
 * Apply a merchant's answer and re-run the gate once (Addendum G.1.5).
 *
 * The corrected field is set to full confidence — the merchant said it directly,
 * which is a better source than the model's reading of a recording of them
 * saying it. The gate then runs again on the corrected item, and it runs *once*:
 * if it still does not pass, the item stays held rather than looping the
 * merchant round again in the same breath.
 */
export function applyResolution(
  item: CatalogItem,
  clarification: Clarification,
  value: number,
  recheckSanity: (updated: CatalogItem) => SanityResult | undefined,
): ResolutionOutcome {
  const updated: CatalogItem = {
    ...item,
    price:
      clarification.field === "price"
        ? { ...item.price, value, confidence: 1 }
        : item.price,
    stock:
      clarification.field === "stock"
        ? { ...item.stock, quantity: value, confidence: 1 }
        : item.stock,
  };

  const sanity = recheckSanity(updated);
  const gate = evaluateGate(updated, sanity);
  updated.needs_merchant_confirmation = gate.held;

  return { item: updated, cleared: !gate.held, remaining: gate.reasons };
}

export { CONFIDENCE_FLOOR };

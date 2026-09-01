/**
 * What the merchant's agent can actually do.
 *
 * Every tool reads or acts on real stored state — there is no separate
 * knowledge base for the agent to be confidently wrong from. The split that
 * matters is `writes`: a read tool runs the moment the agent asks for it, while
 * a write tool only ever returns a *proposal* that the merchant taps to apply.
 * An assistant that can quietly change a price floor or mark goods delivered is
 * not something a shopkeeper can leave running.
 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** True when running this would change something. Those are proposed, never done. */
  writes: boolean;
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_alerts",
    description: "Everything currently wanting the merchant's attention: payments to review, products awaiting confirmation, orders ready to hand over, plus today's takings.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
  },
  {
    name: "list_products",
    description: "The merchant's catalog: name, price, stock, whether an AI buyer can currently buy it, and why not when it cannot.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
  },
  {
    name: "get_orders",
    description: "Recent orders and their state: agreed, paid, awaiting handover, or delivered.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
  },
  {
    name: "explain_payment",
    description: "Why a specific payment was flagged or cleared: the signals, the evidence behind each, and the recommended action.",
    parameters: {
      type: "object",
      properties: { transaction_id: { type: "string", description: "The transaction to explain" } },
      required: ["transaction_id"],
      additionalProperties: false,
    },
    writes: false,
  },
  {
    name: "explain_readiness",
    description: "How the merchant's agent-readiness score is made up, and which part is holding it down.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
  },
  {
    name: "get_lost_sales",
    description: "Buyers who wanted something and did not buy: what stopped them, and any change that would have recovered them.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
  },
  {
    name: "get_commerce_history",
    description: "The signed record of completed sales: how many, total verified value, fulfillment rate, average negotiated discount.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
  },
  {
    name: "propose_confirm_handover",
    description: "Propose confirming that goods for a paid order were handed to the buyer. Returns a proposal for the merchant to approve; it does not confirm anything.",
    parameters: {
      type: "object",
      properties: { transaction_id: { type: "string", description: "The paid order to hand over" } },
      required: ["transaction_id"],
      additionalProperties: false,
    },
    writes: true,
  },
  {
    name: "propose_set_price",
    description: "Propose a price or stock count for a product the shop has not confirmed. Returns a proposal for the merchant to approve; it does not change the catalog.",
    parameters: {
      type: "object",
      properties: {
        item_id: { type: "string" },
        price: { type: "number", description: "Rupee price, or 0 to leave unchanged" },
        stock: { type: "number", description: "Units in stock, or -1 to leave unchanged" },
      },
      required: ["item_id", "price", "stock"],
      additionalProperties: false,
    },
    writes: true,
  },
];

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  args: Record<string, unknown>;
  /** One line a person can read, shown in the activity trail. */
  summary: string;
  /** The actual data, handed back to the model to answer from. */
  data: unknown;
  /** Present when the tool would change something: what the merchant must approve. */
  proposal?: { label: string; endpoint: string; method: string; body: Record<string, unknown> };
  error?: string;
}

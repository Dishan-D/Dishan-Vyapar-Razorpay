/**
 * Everything the merchant's assistant is allowed to do.
 *
 * One registry, because a capability that exists in two places eventually
 * disagrees with itself about whether it needs confirming. Each entry declares
 * what it is for, what it takes, whether it changes anything, and whether a
 * person has to press something first — and the executor reads those flags
 * rather than trusting the caller to remember them.
 *
 * The split that matters is `writes`. A read runs the moment it is asked for.
 * A write never runs from a model's decision at all: it returns a *proposal*,
 * and only a merchant pressing a button turns that into an action. An
 * assistant that can quietly issue a refund or mark goods delivered is not
 * something a shopkeeper can leave running.
 *
 * `domain` is what the spec calls a specialist agent. It is a label rather than
 * a separate process: routing a question to "the payments agent" and routing it
 * to the payments *tools* produce the same answer, and one of those has a
 * failure mode where two agents disagree about the same number.
 */

export type ToolDomain = "payments" | "sales" | "catalog" | "growth" | "operations" | "setup" | "customers";

export interface MerchantToolDef {
  name: string;
  /** Written for the model to choose from — says when to use it, not how it works. */
  description: string;
  domain: ToolDomain;
  parameters: Record<string, unknown>;
  /** Changes stored state. Always proposed, never executed from a model turn. */
  writes: boolean;
  /**
   * Needs an explicit press even after the merchant asked for it.
   *
   * Sending a message and issuing money are the two that cannot be taken back,
   * so they are confirmed separately from being requested. Everything a merchant
   * can undo by editing a field is not on this list.
   */
  confirm: boolean;
}

export const MERCHANT_TOOLS: MerchantToolDef[] = [
  /* ── money in ─────────────────────────────────────────────────────────── */
  {
    name: "get_today",
    description:
      "How the shop is doing right now: money taken, orders, how it compares with yesterday, and anything waiting on the shopkeeper. Use this for 'how did I do today', 'how's business', 'what needs my attention'.",
    domain: "sales",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },
  {
    name: "get_sales",
    description:
      "Money taken over a period, with the daily trend and how it compares with the period before. Use for 'sales this week', 'how much did I make yesterday', 'am I growing'.",
    domain: "sales",
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "yesterday", "week", "month", "all"], description: "Which stretch of time" },
      },
      required: ["period"],
      additionalProperties: false,
    },
    writes: false,
    confirm: false,
  },
  {
    name: "get_product_performance",
    description:
      "Which products earn the most and which are not moving: units sold, money taken, average selling price against the shelf price, and stock sitting idle. Use for 'best sellers', 'what isn't selling', 'which product makes me the most'.",
    domain: "sales",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },
  {
    name: "diagnose_sales",
    description:
      "Why takings moved. Looks at lost sales, products held back, stock that ran out, and what buyers asked for and did not get. Use for 'why are sales down', 'what went wrong', 'why was today quiet'.",
    domain: "sales",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },

  /* ── payments ─────────────────────────────────────────────────────────── */
  {
    name: "get_pending_payments",
    description:
      "Orders that were agreed but never paid for. Use for 'who owes me money', 'what hasn't been paid', 'any pending payments'.",
    domain: "payments",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },
  {
    name: "get_payment_status",
    description: "What happened to one specific order: whether it was paid, by which rail, and whether it has been handed over.",
    domain: "payments",
    parameters: {
      type: "object",
      properties: { transaction_id: { type: "string", description: "The order to look up" } },
      required: ["transaction_id"],
      additionalProperties: false,
    },
    writes: false,
    confirm: false,
  },
  {
    name: "get_reconciliation",
    description:
      "Money that arrived in the bank matched against what was sold: how much is explained, and which credits are not. Use for 'does my bank match my sales', 'what is this payment for', 'any money I cannot account for'.",
    domain: "payments",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },

  /* ── catalog ──────────────────────────────────────────────────────────── */
  {
    name: "list_products",
    description:
      "The shop's catalog: name, price, stock, and whether an AI buyer can currently buy it — with the reason when it cannot. Use for 'what am I selling', 'what can't agents buy', 'am I out of anything'.",
    domain: "catalog",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },
  {
    name: "get_orders",
    description: "Recent orders and where each one has got to: agreed, paid, waiting to be handed over, or delivered.",
    domain: "operations",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },

  /* ── growth ───────────────────────────────────────────────────────────── */
  {
    name: "get_opportunities",
    description:
      "What the Revenue Agent suggests doing to earn more: things to sell together, bigger versions worth offering, and stock worth promoting — each with the reasoning behind it. Use for 'how do I earn more', 'any suggestions', 'what should I do next'.",
    domain: "growth",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },
  {
    name: "get_lost_sales",
    description: "Buyers who wanted something and did not buy it: what stopped them, and what would have recovered them.",
    domain: "growth",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },

  /* ── who the shop sells to ────────────────────────────────────────────── */
  {
    name: "get_customers",
    description:
      "The shop's buyers ranked by what they have spent, with how often they come and how much of the takings each one is. Use for 'best customers', 'who spends the most', 'my regulars', 'repeat customers'.",
    domain: "customers",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },
  {
    name: "get_lapsed_customers",
    description:
      "Buyers who used to come regularly and have stopped — how long they have been quiet and what they used to spend. Use for 'who hasn't bought recently', 'lost customers', 'who stopped coming'.",
    domain: "customers",
    parameters: {
      type: "object",
      properties: { quiet_days: { type: "number", description: "How many days of silence counts as lapsed; 30 if unsure" } },
      required: ["quiet_days"],
      additionalProperties: false,
    },
    writes: false,
    confirm: false,
  },
  {
    name: "get_patterns",
    description:
      "When the shop actually trades — the busiest hour and the busiest day of the week, from real sales. Use for 'when do I sell most', 'which day is busiest', 'what time is my rush'.",
    domain: "sales",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },

  /* ── setup ────────────────────────────────────────────────────────────── */
  {
    name: "get_payment_setup",
    description: "How customers pay this shop: the UPI id on file and where it came from. Use for 'what is my UPI', 'how do people pay me', 'is my payment set up'.",
    domain: "setup",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: false,
    confirm: false,
  },

  /* ── the ones that change something ───────────────────────────────────── */
  {
    name: "propose_confirm_handover",
    description:
      "Prepare marking a paid order as handed to the buyer. Returns something for the shopkeeper to approve — it does not hand anything over.",
    domain: "operations",
    parameters: {
      type: "object",
      properties: { transaction_id: { type: "string", description: "The paid order being handed over" } },
      required: ["transaction_id"],
      additionalProperties: false,
    },
    writes: true,
    confirm: true,
  },
  {
    name: "propose_bulk_handover",
    description:
      "Prepare marking every paid order that is waiting as handed over, in one go. Use when the shopkeeper says something like 'hand these over', 'mark them all delivered', or 'yes, all of them' after being told how many are waiting.",
    domain: "operations",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    writes: true,
    confirm: true,
  },
  {
    name: "propose_set_price",
    description:
      "Prepare a price or stock count for a product. Returns something for the shopkeeper to approve — it does not change the catalog.",
    domain: "catalog",
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
    confirm: true,
  },
  {
    name: "propose_invoice",
    description:
      "Prepare a Razorpay invoice for an order that has already been paid for. Returns something for the shopkeeper to approve — it does not issue anything.",
    domain: "operations",
    parameters: {
      type: "object",
      properties: { transaction_id: { type: "string", description: "The paid order to invoice" } },
      required: ["transaction_id"],
      additionalProperties: false,
    },
    writes: true,
    confirm: true,
  },
  {
    name: "propose_payment_link",
    description:
      "Prepare a Razorpay payment link for an order that was agreed but never paid — something to send a buyer who could not finish. Returns it for approval; it does not create the link.",
    domain: "payments",
    parameters: {
      type: "object",
      properties: { transaction_id: { type: "string", description: "The unpaid order" } },
      required: ["transaction_id"],
      additionalProperties: false,
    },
    writes: true,
    confirm: true,
  },
  {
    name: "propose_promotion",
    description:
      "Prepare one of the Revenue Agent's suggestions to go live. Returns it for approval; nothing changes until the shopkeeper presses.",
    domain: "growth",
    parameters: {
      type: "object",
      properties: { opportunity_id: { type: "string", description: "The suggestion to act on" } },
      required: ["opportunity_id"],
      additionalProperties: false,
    },
    writes: true,
    confirm: true,
  },
  {
    name: "propose_upi",
    description:
      "Prepare saving a UPI id read from a QR the shopkeeper uploaded. Returns it for them to check before it is saved.",
    domain: "setup",
    parameters: {
      type: "object",
      properties: {
        upi_id: { type: "string" },
        merchant_name: { type: "string", description: "The payee name printed in the QR, or empty" },
      },
      required: ["upi_id", "merchant_name"],
      additionalProperties: false,
    },
    writes: true,
    confirm: true,
  },
];

export const toolByName = (name: string): MerchantToolDef | undefined =>
  MERCHANT_TOOLS.find((t) => t.name === name);

/**
 * What each lookup says while it runs.
 *
 * One line per tool rather than one per question, because a three-step answer
 * that repeats "Working out what changed" three times tells the merchant
 * nothing about what is being worked out. These are the steps that really ran,
 * in the order they ran, which is the only version worth showing — a progress
 * animation that is not tied to actual work is decoration.
 */
export const ACTIVITY: Record<string, string> = {
  get_customers: "Ranking your buyers by what they spent",
  get_lapsed_customers: "Looking for buyers who stopped coming",
  get_patterns: "Checking when you actually trade",
  get_trend: "Comparing this period with the last",
  get_today: "Checking today's takings",
  get_sales: "Adding up what was paid",
  get_product_performance: "Ranking products by what they earned",
  diagnose_sales: "Looking for what is holding sales back",
  get_pending_payments: "Checking unpaid orders",
  get_payment_status: "Looking up that payment",
  get_reconciliation: "Matching bank credits to sales",
  list_products: "Reading your catalog",
  get_orders: "Looking at recent orders",
  get_opportunities: "Reading the Revenue Agent's suggestions",
  get_lost_sales: "Checking who walked away",
  get_payment_setup: "Checking your payment details",
  propose_confirm_handover: "Getting the handover ready",
  propose_bulk_handover: "Counting what is waiting to go out",
  propose_set_price: "Preparing the change",
  propose_invoice: "Preparing an invoice",
  propose_payment_link: "Preparing a payment link",
  propose_promotion: "Preparing the promotion",
  propose_upi: "Checking those payment details",
};

export const activityFor = (tool: string): string => ACTIVITY[tool] ?? "Looking that up";

/** The OpenAI/Groq function-calling shape, derived so the two cannot drift. */
export const asFunctionSchemas = () =>
  MERCHANT_TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

/**
 * Things the shop genuinely cannot answer, and what it can answer instead.
 *
 * A shopkeeper will ask who their best customer is. This system has no customer:
 * its buyers are AI agents acting for people it never sees, and there is no name,
 * no phone number and no purchase history behind them. The useful response is to
 * say so and offer the nearest real thing — not to invent a Rahul, and not to
 * fail with "I don't understand", which sounds like a bug in the assistant
 * rather than a fact about the data.
 */
export const NOT_HELD: Array<{ match: RegExp; say: string; instead?: string }> = [
  {
    match: /\brefund\b|\breturn the money\b|\bmoney back\b/i,
    say: "Refunds are not wired up in this build, so I cannot start one — and I would rather say that than tell you a refund is on its way.",
  },
  {
    // Buyers can be named and ranked now — they cannot be contacted. An agent
    // acts for someone the shop never meets, so there is no phone number
    // behind the name, and offering to send a reminder would be a promise the
    // system cannot keep.
    match: /\b(send|message|whatsapp|sms|text|call|remind|reach out to)\b.{0,30}\b(customer|customers|buyer|buyers|him|her|them|rahul|priya)\b/i,
    say:
      "I can tell you who they are and what they spent, but not contact them — a buying agent acts for someone the shop never meets, so there is no number behind the name.",
    instead: "get_lapsed_customers",
  },
];

/** Does this question ask for something the data cannot support? */
export function unheld(question: string): (typeof NOT_HELD)[number] | null {
  return NOT_HELD.find((n) => n.match.test(question)) ?? null;
}

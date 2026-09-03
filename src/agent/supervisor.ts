import { MERCHANT_TOOLS, toolByName, unheld, type ToolDomain } from "./merchant-tools.js";

/**
 * What the merchant asked for, and who should answer it.
 *
 * The spec for this called for a supervisor agent delegating to payments,
 * sales, customer and growth agents. This is that, with one substitution: the
 * specialists are *tool domains* rather than separate model calls. Routing a
 * question to "the payments agent" and routing it to the payments tools reach
 * the same rows, and only one of those has a failure mode where two agents
 * answer the same question with different numbers because they looked a second
 * apart. The label survives — the panel says which specialist ran — because
 * that is genuinely useful to see. The extra round trips do not.
 *
 * The routing itself is deliberately deterministic first. "How much did I make
 * today" does not need a language model to work out that it means today's
 * takings, and on a free tier of 8,000 tokens a minute, spending a model call
 * on it is the difference between a demo that answers and one that apologises.
 * The model is for the questions that genuinely need reasoning — "why are sales
 * down" — where the answer is a judgement across four lookups rather than a
 * lookup.
 */

export type Route =
  | { kind: "unheld"; say: string; then: string[] }
  | { kind: "direct"; tools: string[]; domains: ToolDomain[]; why: string }
  | { kind: "reason"; seed: string[]; domains: ToolDomain[]; why: string }
  /**
   * The merchant asked for something to be done rather than looked up.
   *
   * `subject` is whatever they named — an order id, a product, a price — left
   * as text for the executor to resolve against real rows. The router's job is
   * to notice that this is an instruction, not to work out which cake.
   */
  | { kind: "act"; tool: string; subject: string; domains: ToolDomain[]; why: string };

interface Rule {
  match: RegExp;
  tools: string[];
  /** Shown in the activity trail while it runs. */
  why: string;
}

/**
 * Phrasings a shopkeeper actually uses, mapped to lookups.
 *
 * Written from how the question gets asked rather than from what the tool is
 * called: nobody types "get_pending_payments", they type "who hasn't paid me".
 * Order matters — the first match wins — so the specific sit above the general.
 */
const DIRECT: Rule[] = [
  {
    // Before the "who hasn't paid" rule: "which customers haven't bought
    // recently" contains "hasn't" and is not a payment question.
    match: /\b(hasn'?t|haven'?t|not|stopped|lost|lapsed|inactive|quiet|gone)\b.{0,24}\b(bought|buying|purchas|come|coming|back|visited|ordered)\b|\b(lapsed|inactive|lost)\s+(customer|customers|buyer|buyers)\b|\bwho stopped\b|\bused to (come|buy|shop)\b|\b(doesn'?t|don'?t|no longer)\b.{0,20}\b(anymore|any more|come|buy)\b/i,
    tools: ["get_lapsed_customers"],
    why: "Looking for buyers who stopped coming",
  },
  {
    match: /\b(best|top|loyal|repeat|regular|biggest|frequent|returning)\b.{0,16}\b(customer|customers|buyer|buyers|shopper|shoppers)\b|\bcustomer (list|contribution|breakdown)\b|\bwho (buys|spends|are my (customer|buyer|regular))|\bregulars\b/i,
    tools: ["get_customers"],
    why: "Ranking your buyers by what they spent",
  },
  {
    // "busiest" and "busy" are different words to a regex, and a shopkeeper
    // says the second half first as often as not — "which day is my busiest"
    // put the noun before the adjective and fell through to the generic path.
    match: /\b(when|what time|which day|which hour|busiest|busy|peak|rush|quiet(est)?)\b.{0,30}\b(sell|sales|sold|busy|busiest|trade|trading|day|days|hour|hours|time|most|crowd|rush)\b|\bbusiest\b|\bmy rush\b|\bpeak (time|hour|day)\b/i,
    tools: ["get_patterns"],
    why: "Checking when you actually trade",
  },
  {
    match: /\b(who|what|anything|any).{0,24}\b(owes?|owed|unpaid|not paid|hasn'?t paid|haven'?t paid|pending payment|outstanding|due)\b|\bpending payments?\b|\b(am i|are we) owed\b|\bowes? me\b|\bstill to (be paid|come in)\b/i,
    tools: ["get_pending_payments"],
    why: "Checking unpaid orders",
  },
  {
    match: /\b(reconcil|bank|settle|credit|money (in|arrived)|account for|unexplained)\b/i,
    tools: ["get_reconciliation"],
    why: "Matching bank credits to sales",
  },
  {
    // "explain" and "what happened" ask the same question as "why" and were
    // falling through to the generic path, which answered with today's takings
    // rather than a reason.
    match: /\b(why|explain|what happened)\b.{0,40}\b(down|low|lower|dropped|drop|fell|falling|slow|quiet|bad|worse|less)\b|\bwhat went wrong\b|\bexplain (the|this) (drop|dip|fall|decline)\b/i,
    tools: ["diagnose_sales", "get_lost_sales", "get_product_performance"],
    why: "Working out what changed",
  },
  {
    match: /\b(best|top|worst|slow)[- ]?(selling|seller|sellers|moving|product|products|item|items)\b|\bwhich products?\b|\b(not|never|havent|haven'?t|hasnt|hasn'?t|didnt|didn'?t)\b.{0,12}\b(sold|selling|sell|moving|move)\b|\bsells (best|most|well|badly)\b|\b(anything|what'?s|whats)\b.{0,12}\bnot (moving|selling)\b/i,
    tools: ["get_product_performance"],
    why: "Ranking products by what they earned",
  },
  {
    match: /\b(how much|what).{0,24}\b(sell|sold|make|made|earn|earned|take|took|revenue|sales)\b|\bhow (did|are|is|was).{0,20}\b(i|we|business|shop|today|yesterday)\b|\bhow'?s business\b|\b(tell me about|give me|show me)\b.{0,16}\b(today|yesterday|this week|this month|numbers|figures)\b|\btoday'?s (numbers|figures|takings|sales)\b|\bis business (good|ok|okay|fine|bad|slow)\b|\bhow are (things|we)\b/i,
    tools: ["get_sales"],
    why: "Adding up what was actually paid",
  },
  {
    match: /\b(what needs|needs my|attention|anything (for me|to do|waiting)|to.?do|what should i do)\b|\banything i should (look at|see|know|check)\b|\banything (waiting|pending) for me\b/i,
    tools: ["get_today"],
    why: "Checking what is waiting on you",
  },
  {
    // No trailing \b: "suggestion\b" cannot match "suggestions", which is how
    // the word is actually typed. Prefix matching is right here — every stem
    // below is unambiguous.
    match: /\b(grow|earn more|suggestion|suggest|opportunit|promot|offer|upsell|cross.?sell|dead stock|idle stock)|\b(make|earn) more (money|sales)?\b|\bincrease (my )?(sales|revenue|takings)\b/i,
    tools: ["get_opportunities"],
    why: "Reading the Revenue Agent's suggestions",
  },
  {
    match: /\b(order|orders|handover|hand over|deliver|delivered|delivery)\b/i,
    tools: ["get_orders"],
    why: "Looking at recent orders",
  },
  {
    // "can't buy" is almost never adjacent — it is "what can't agents buy",
    // "what can a buyer not buy" — so the subject is allowed to sit between.
    match: /\b(catalog|catalogue|product list|my products|stock|inventory|out of stock|what am i selling|held)\b|\b(can'?t|cannot|can.{0,14}not)\b.{0,16}\bbuy\b|\bnot on sale\b|\bon sale yet\b|\bwaiting (on|for) me to (price|confirm)\b/i,
    tools: ["list_products"],
    why: "Reading your catalog",
  },
  {
    match: /\b(upi|qr|payment (id|details|setup)|how do (people|customers) pay|vpa)\b/i,
    tools: ["get_payment_setup"],
    why: "Checking your payment details",
  },
];

/** Questions that are a judgement across several lookups, not one lookup. */
const NEEDS_REASONING = /\bwhy\b|\bexplain\b|\bcompare\b|\bshould i\b|\bwhat if\b|\bhow can i\b|\breason\b|\bcause\b/i;

/**
 * Instructions, as opposed to questions.
 *
 * Checked before the read rules because "send an invoice for that order" also
 * contains the word "order", and answering it with a list of orders is the
 * kind of near-miss that makes an assistant feel deaf. Every one of these ends
 * in a proposal the merchant has to press — recognising an instruction is not
 * the same as carrying it out.
 */
const ACTIONS: Array<{ match: RegExp; tool: string; why: string }> = [
  {
    /**
     * "Hand these over" — all of them, meaning the ones just counted.
     *
     * A shopkeeper who has been told 48 are waiting says this, not a
     * transaction id. Checked before the single-order rule because both
     * contain the word "hand", and answering a bulk instruction by asking
     * which one of forty-eight is how an assistant feels deaf.
     */
    match: /\b(hand|mark|confirm|deliver)\w*\b.{0,20}\b(these|those|them|all|everything|the lot)\b|\b(all|everything)\b.{0,16}\b(handed|delivered|over)\b|\bhand (them|these|those) over\b|\bmark (them|these|those) (all )?(as )?(delivered|handed|done)\b/i,
    tool: "propose_bulk_handover",
    why: "Counting what is waiting to go out",
  },
  {
    match: /\b(hand(ed)? ?over|handover|mark.{0,16}(delivered|handed|given|collected)|confirm.{0,16}(handover|delivery|deliver))\b/i,
    tool: "propose_confirm_handover",
    why: "Getting the handover ready",
  },
  {
    match: /\b(invoice|bill)\b/i,
    tool: "propose_invoice",
    why: "Preparing an invoice",
  },
  {
    match: /\b(payment link|pay link|link to pay|send.{0,20}link)\b/i,
    tool: "propose_payment_link",
    why: "Preparing a payment link",
  },
  {
    match: /\b(set|change|update|make|put)\b.{0,30}\b(price|stock|rate|cost|count)\b|\bprice.{0,12}\bto\b/i,
    tool: "propose_set_price",
    why: "Preparing the change",
  },
  {
    match: /\b(run|start|approve|apply|do|go ahead with|put live)\b.{0,24}\b(promotion|offer|suggestion|discount)\b/i,
    tool: "propose_promotion",
    why: "Preparing the promotion",
  },
];

export function route(question: string): Route {
  const q = String(question ?? "").trim();

  // Asked for something the shop does not hold. Say so, and offer the nearest
  // real thing — see NOT_HELD for why this is a first-class outcome and not a
  // parse failure.
  const gap = unheld(q);
  if (gap) return { kind: "unheld", say: gap.say, then: gap.instead ? [gap.instead] : [] };

  const doing = ACTIONS.find((r) => r.match.test(q));
  if (doing) {
    return { kind: "act", tool: doing.tool, subject: q, domains: domainsOf([doing.tool]), why: doing.why };
  }

  const hit = DIRECT.find((r) => r.match.test(q));

  if (hit) {
    const domains = domainsOf(hit.tools);
    // A "why" that also matched a lookup still wants the reasoning pass — the
    // lookup is the evidence, not the answer.
    return NEEDS_REASONING.test(q) && hit.tools.length > 1
      ? { kind: "reason", seed: hit.tools, domains, why: hit.why }
      : { kind: "direct", tools: hit.tools, domains, why: hit.why };
  }

  return {
    kind: "reason",
    seed: ["get_today"],
    domains: ["sales"],
    why: NEEDS_REASONING.test(q) ? "Thinking it through" : "Looking that up",
  };
}

export function domainsOf(tools: string[]): ToolDomain[] {
  const seen = new Set<ToolDomain>();
  for (const t of tools) {
    const def = toolByName(t);
    if (def) seen.add(def.domain);
  }
  return [...seen];
}

/** What the merchant sees while it works — one line per specialist, in order. */
export const DOMAIN_LABEL: Record<ToolDomain, string> = {
  payments: "Payments",
  sales: "Sales",
  catalog: "Catalog",
  growth: "Growth",
  operations: "Orders",
  customers: "Buyers",
  setup: "Setup",
};

/**
 * Openers built from the shop's own state.
 *
 * "How can I help you?" tells a shopkeeper nothing about what is possible.
 * These name things that are true right now — an order waiting to be handed
 * over, money that has not arrived — so the first tap already does something
 * useful, and a shop with none of those problems is not offered them.
 */
export function suggestions(state: {
  pendingPayments: number;
  awaitingHandover: number;
  heldProducts: number;
  opportunities: number;
  lapsed: number;
}): string[] {
  const out: string[] = ["How did I do today?"];
  if (state.pendingPayments > 0) out.push("Who hasn't paid me?");
  if (state.awaitingHandover > 0) out.push("What needs my attention?");
  out.push("Who are my best customers?");
  out.push("What are my best sellers?");
  if (state.opportunities > 0) out.push("How do I earn more?");
  if (state.lapsed > 0) out.push("Which buyers stopped coming?");
  if (state.heldProducts > 0) out.push("What can't agents buy yet?");
  out.push("Why are sales down?");
  return out.slice(0, 6);
}

/** Every tool the model is allowed to reach for, minus the writes it may not run. */
export const readableTools = () => MERCHANT_TOOLS.filter((t) => !t.writes).map((t) => t.name);

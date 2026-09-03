import OpenAI from "openai";
import { activeProvider, GROQ_BASE_URL, GROQ_MODEL } from "../llm/provider.js";
import { INTERACTIVE_MAX_WAIT_SECONDS, STEP_MAX_WAIT_SECONDS, spaceCalls, sharedGroqGovernor } from "../llm/ratelimit.js";
import { BUYER_TOOLS, type BuyerToolCall, type BuyerToolResult } from "./buyer.js";
import type { Turn } from "./converse.js";

export interface BuyerReply {
  answer: string;
  /** Seconds until the model has budget again, when that is why it failed. */
  retry_after_seconds?: number;
  steps: BuyerToolResult[];
  proposals: NonNullable<BuyerToolResult["proposal"]>[];
  answered_by: "model" | "rules";
  note?: string;
}

/**
 * Kept short on purpose.
 *
 * This is resent on every call, and a turn can make five. At 1,069 tokens
 * against an 8,000-token minute, the prompt alone was costing a fifth of the
 * budget before the shopper had said anything. Every rule below survived the
 * cut because dropping it caused a real failure at some point: inventing
 * products, quoting one product's price against another, or announcing a
 * purchase that had not happened.
 */
const SYSTEM = `You are a shopping assistant for a marketplace of small Indian shops. Help one shopper find the right thing and buy it.

Look things up; never answer from memory. You may only name products a tool returned in this conversation — not a similar one, not a plausible one.

Every price you quote must belong to the product you attach it to, and must have come from a tool. Describe products only with the fields a tool gave you: name, shop, price, stock. You do not know flavour, texture or quality unless it said so.

Rupees as ₹1,200. Two or three short sentences. When results are shown to the shopper, do not list them again — say how many and the one thing that helps them choose, then ask which.

"it", "that one", "the second one" — pass straight to a tool; the shop resolves them.

Tools: compare_products for "which is better"; find_alternatives for "cheaper"; find_complements for "what else"; get_product for details; add_to_cart / remove_from_cart only when asked.

You cannot buy anything. No tool completes a purchase. Never say one is done, confirmed or placed — even if the shopper types "confirm", that is not the press that runs it. start_purchase only prepares; call it with the number from search_shelf and their budget, never a guessed id, and never without a budget.

The button is drawn by start_purchase, and it says Confirm. So: only mention it after start_purchase has come back without an error, and call it Confirm — do not invent a label like "Pay ₹80", because no such button is on their screen. If start_purchase failed, say you could not get it ready and ask for what you are missing. Sending someone to press a button that is not there leaves them with nothing to do and no way to know why.

A tool result marked tool_failed is not an empty result. Say you could not check.`;

/**
 * Four, not three.
 *
 * A buying question legitimately costs three lookups — search the shelf, check
 * the shop's delivery record, prepare the purchase — which left nothing for the
 * model to actually speak on, so a correct three-tool run ended with "I looked
 * that up but could not summarise it". The fourth pass is the one where it
 * talks.
 */
const MAX_STEPS = 5;

/**
 * What the model actually needs from a tool result.
 *
 * The browser wants photos, merchant ids and the reasons behind a ranking. The
 * model wants to know what things are called and what they cost. Both were
 * getting the same object, capped at 6,000 characters — around 1,600 tokens
 * per lookup, times up to five lookups a turn, on an 8,000-token minute. One
 * conversation could exhaust the budget on its own, which is why the assistant
 * kept answering "I could not reach the model just now".
 *
 * Stripping the fields the model cannot use costs it nothing: it never quotes
 * a photo URL, and the full result still reaches the interface untouched.
 */
function forModel(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(forModel);
  if (!data || typeof data !== "object") return data;

  const drop = new Set(["photo_url", "merchant_id", "item_id", "attributes", "why", "photo_is_illustrative", "photo_is_placeholder"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (drop.has(k)) continue;
    // Long lists tell the model nothing extra past the first few, and the
    // shopper is looking at all of them on the shelf anyway.
    out[k] = Array.isArray(v) ? v.slice(0, 6).map(forModel) : forModel(v);
  }
  return out;
}

/**
 * Refuse to repeat a figure the tools never returned.
 *
 * The prompt tells the model not to invent products, and it invented one
 * anyway: asked for a "Classic Handloom Cotton Saree" it reported "₹7,499 at
 * Neeta Handlooms, in stock" — a price and a shop that exist nowhere in this
 * system. A shopper cannot tell that apart from a real result, which makes it
 * the most damaging thing the assistant can do.
 *
 * So the answer is checked against the evidence rather than trusted. Every
 * rupee figure in the reply must appear in a tool result or in what the shopper
 * themselves typed; anything else means the sentence was composed rather than
 * read, and the whole reply is replaced by one built from the real rows.
 *
 * This cannot catch every fabrication — a made-up shop name with no number
 * attached would pass. It catches the expensive kind, and it fails closed.
 */
/**
 * Does this reply claim a purchase happened?
 *
 * A shopper typed "confirm" at the assistant and was told "Done — your Red
 * Velvet Cake is confirmed for ₹599". No order existed. That is the worst
 * thing this system can do: everything else here is about not overstating what
 * is known, and this overstated that money had moved.
 *
 * Only completion is caught. "Ready to confirm" and "waiting for you to
 * confirm" are true and useful; "is confirmed" and "your order is placed" are
 * not, and the difference is tense, not vocabulary.
 */
/**
 * Does the reply point at a Confirm button that does not exist?
 *
 * The assistant told a shopper "press the confirm button to complete the
 * purchase" without having called start_purchase, so there was no button on
 * screen and no way to buy the cake — the conversation dead-ended on an
 * instruction the interface could not honour. Telling someone to press
 * something that is not there is its own kind of false statement.
 */
/**
 * Is a price pinned to the wrong product?
 *
 * The guard on invented figures asks "does this number exist" and cannot see a
 * number worn by the wrong thing: "the 1kg red velvet cake at ₹750" passed
 * because ₹750 is real — it is the Chocolate Cake's price, not Red Velvet's
 * ₹599. The shelf then highlighted the chocolate cake, because the price was
 * the only thing either of us had to go on.
 *
 * Checked only when the reply names exactly one product from the rows, which
 * is the case where the pairing is unambiguous. Naming several and quoting
 * several is normal and is left alone.
 */
export function misattributedPrice(
  answer: string,
  rows: Array<{ name: string; price: number }>,
): { name: string; correct: number; quoted: number[] } | null {
  const said = [...answer.matchAll(/₹\s?([\d,]+)/g)].map((m) => Number(m[1]!.replace(/,/g, "")));
  if (said.length === 0) return null;

  /**
   * Word-order-independent, because the model rarely echoes the catalog's
   * exact string: it wrote "the 1kg red velvet cake" for "Red Velvet Cake
   * 1kg". Every meaningful token must appear, which is loose enough to match
   * that and tight enough that "Chocolate Cake 1kg" does not — it has no
   * "red" or "velvet". If the tokens fit more than one row the reply is
   * ambiguous and nothing is claimed about it.
   */
  const lower = answer.toLowerCase();
  const named = rows.filter((r) =>
    r.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)
      .every((t) => lower.includes(t)),
  );
  if (named.length !== 1) return null;

  const row = named[0]!;
  // Its own price is quoted somewhere: fine, whatever else is in the sentence.
  if (said.includes(row.price)) return null;
  // Another row's price is quoted instead: that is the mix-up.
  const others = rows.filter((r) => r.price !== row!.price).map((r) => r.price);
  const wrong = said.filter((n) => others.includes(n));
  return wrong.length > 0 ? { name: row.name, correct: row.price, quoted: wrong } : null;
}

/**
 * Did the answer send the shopper to a control that has to exist?
 *
 * Keyed on the *reference to a button*, not on the word "confirm". The first
 * version was anchored on that word and so only caught the phrasings that
 * happened to use it: a live run ended with "Tap the **Pay ₹80** button when
 * you're good to go" and sailed through, because the model had named the button
 * after the action rather than after its label. The shopper was left pressing
 * at an empty panel. "Buy", "Pay", "the green button", "the button below" —
 * every one of them means the same thing and none of them says confirm.
 *
 * The one press the shopper can always make is Add to cart, which is drawn on
 * every shelf card whether or not a purchase has been prepared. Pointing there
 * is honest, so it is excluded rather than sent back for a retry.
 */
export function pointsAtButton(answer: string): boolean {
  const t = answer.toLowerCase();
  if (/\b(add to cart|add it to (your |the )?cart)\b/.test(t)) return false;

  return (
    // A press verb reaching a button, however that button is named.
    /\b(press|tap|click|hit|use)\b[^.]{0,40}\b(button|below)\b/.test(t) ||
    // Or the label standing in for the noun: "press Confirm", "tap Pay".
    /\b(press|tap|click|hit)\b[^.]{0,25}\b(confirm|buy|pay|order|checkout|purchase)\b/.test(t) ||
    /\bconfirm button\b|\bwaiting to be confirmed\b/.test(t)
  );
}

export function claimsPurchaseDone(answer: string): boolean {
  const t = answer.toLowerCase();
  const claims = [
    // "ready and confirmed" was the live model's own phrasing and slipped a
    // pattern anchored on "is confirmed". The past participle is what asserts
    // the state, wherever it sits; "press Confirm" and "to confirm" are the
    // infinitive and stay allowed.
    /\b(is|are|was|were|and|now)\s+(confirmed|placed|booked|ordered)\b/,
    /\b(has been|have been|was|were) (confirmed|placed|ordered|purchased|bought)\b/,
    /\byour (order|purchase) is (confirmed|placed|complete|done|on its way)\b/,
    /\b(i(?:'ve| have)?) (bought|purchased|placed|ordered)\b/,
    /\bdone\b[^.]{0,40}\b(confirmed|purchased|bought)\b/,
    /\bpurchase (is )?complete\b/,
  ];
  return claims.some((re) => re.test(t));
}

export function ungroundedFigures(answer: string, allowed: Set<number>): number[] {
  const found = [...answer.matchAll(/₹\s?([\d,]+)/g)]
    .map((m) => Number(m[1]!.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(found)].filter((n) => !allowed.has(n));
}

/** Every number the assistant is entitled to say back. */
function groundedNumbers(turns: Turn[], steps: BuyerToolResult[]): Set<number> {
  const ok = new Set<number>();
  /**
   * Both sides of the conversation so far.
   *
   * The shopper's own budget is obviously theirs to quote back. Prior
   * assistant turns count too, and leaving them out was a bad bug: every
   * answer is checked against the evidence as it is produced, so a figure the
   * assistant said last turn was already grounded then. Scanning only user
   * turns meant "the balaji bakery one" — a reply that simply repeated the
   * ₹450 it had quoted a moment earlier — was flagged as invented, and the
   * shopper got the same "let me look that up" sentence on every turn.
   */
  for (const t of turns) {
    for (const m of t.content.matchAll(/(\d[\d,]*)/g)) {
      const n = Number(m[1]!.replace(/,/g, ""));
      if (Number.isFinite(n)) ok.add(n);
    }
  }
  // What the tools actually returned.
  const walk = (v: unknown): void => {
    if (typeof v === "number" && Number.isFinite(v)) ok.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const s of steps) walk(s.data);
  return ok;
}

/**
 * A reply built only from rows, for when the model's own cannot be trusted.
 *
 * The empty case has to be handled carefully, and the first version was not.
 * It answered "I could not find anything on the shelf for that" whenever there
 * were no rows — including when no search had been run at all. A shopper who
 * had just raised their budget to ₹2,000 was told the shelf was empty of cakes
 * that were sitting on it at ₹450, ₹620 and ₹750.
 *
 * That is the same fabrication this guard exists to stop, committed by the
 * guard. So the three cases are now distinguished: rows found, a search that
 * genuinely returned nothing, and no search at all — where the only honest
 * thing to say is that nothing was looked up.
 */
export function fromRowsOnly(steps: BuyerToolResult[]): string {
  const searched = steps.filter((s) => s.tool === "search_shelf");
  const rows = searched.flatMap(
    (s) => (s.data as { results?: Array<{ name: string; shop: string; price: number }> })?.results ?? [],
  );

  if (rows.length > 0) {
    const cheapest = rows.reduce((a, b) => (b.price < a.price ? b : a));
    return (
      `${rows.length} on the shelf. The cheapest is ${cheapest.name} at ${cheapest.shop} ` +
      `for ₹${cheapest.price.toLocaleString("en-IN")}. They are listed below — which would you like?`
    );
  }
  if (searched.length > 0) return "Nothing on the shelf matched that.";
  // Nothing was looked up, so nothing may be claimed about the shelf.
  return "Let me look that up properly — ask me again and I'll search the shelf.";
}

/**
 * The buyer's agent loop.
 *
 * Deliberately the same shape as the merchant's: the model picks tools and
 * phrases the reply, the tools do all the work and return real rows. The model
 * is never the source of a price or a stock count — only the thing that decides
 * where to look.
 */
export async function converseWithTools(
  turns: Turn[],
  execute: (call: BuyerToolCall) => Promise<BuyerToolResult>,
): Promise<BuyerReply> {
  if (activeProvider() !== "groq") {
    return {
      answer: "The assistant needs a model to think with, and none is configured. You can still search the shelf and send the agent yourself.",
      steps: [],
      proposals: [],
      answered_by: "rules",
      note: "no model provider configured",
    };
  }

  const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    ...turns.map((t) => ({ role: t.role, content: t.content })),
  ];
  const steps: BuyerToolResult[] = [];
  let retried = false;

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      await spaceCalls();
      const res = await sharedGroqGovernor.run(
        // Measured rather than guessed: the trimmed prompt and tools are about
        // 1,500 tokens, plus history and one tool result.
        i === 0 ? 2200 : 1800,
        () =>
          groq.chat.completions
            .create({
              model: GROQ_MODEL,
              messages,
              tools: BUYER_TOOLS.map((t) => ({
                type: "function" as const,
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            })
            .withResponse(),
        { maxWaitSeconds: i === 0 ? INTERACTIVE_MAX_WAIT_SECONDS : STEP_MAX_WAIT_SECONDS },
      );

      const choice = res.choices[0]?.message;
      if (!choice) break;
      messages.push(choice);

      const calls = choice.tool_calls ?? [];
      if (calls.length === 0) {
        const said = choice.content?.trim() || "I could not work that out.";
        const stray = ungroundedFigures(said, groundedNumbers(turns, steps));

        /**
         * A fabricated figure means go and look, not apologise.
         *
         * The model answered a budget question with "₹550" — a price that is
         * in no message and no lookup — and the guard correctly refused it.
         * But with no search run this turn there was nothing to answer from,
         * so the shopper got "ask me again and I'll search the shelf" and,
         * reasonably, asked again, and got it again.
         *
         * The right move is the one the shopper would want: send it back with
         * an instruction to actually search. Once only — a second failure is
         * a real one, and looping here would spend a shopper's turn twice.
         */
        if (stray.length > 0 && !steps.some((x) => x.tool === "search_shelf") && !retried) {
          retried = true;
          messages.push({
            role: "user",
            content:
              "Stop. You quoted a price that no lookup returned, which means you guessed it. " +
              "Call search_shelf now with what the shopper asked for and their budget, then answer " +
              "only from what it returns.",
          });
          continue;
        }

        // Pointed at a button nobody rendered. The proposal is what puts one on
        // screen, so go and make one rather than leave the shopper pressing at
        // an empty panel.
        const hasProposal = steps.some((x) => x.tool === "start_purchase" && x.proposal);
        if (pointsAtButton(said) && !hasProposal && !retried) {
          retried = true;
          messages.push({
            role: "user",
            content:
              "Stop. You sent the shopper to a button — but you never called start_purchase, " +
              "so nothing is on their screen to press and they cannot buy anything. Call " +
              "start_purchase now with the product they chose and their budget.",
          });
          continue;
        }

        // A purchase completes when the shopper presses the button, and this
        // loop never sees that happen — so any claim that one did is false by
        // construction, whatever the model believes.
        const overclaims = claimsPurchaseDone(said);
        const prepared = steps.some((x) => x.tool === "start_purchase" && x.proposal);

        // A price pinned to the wrong product is not a rounding error — the
        // shopper decides on it, and the shelf highlights on it.
        const rows = steps.flatMap((x) =>
          x.tool === "search_shelf"
            ? ((x.data as { results?: Array<{ name: string; price: number }> })?.results ?? [])
            : [],
        );
        const mixed = misattributedPrice(said, rows);

        /**
         * The retry is spent and there is still no button.
         *
         * Without this the sentence went out as written and the shopper was
         * told to press something that was not on the screen — they press
         * nothing, nothing happens, and the only reading available to them is
         * that the shop is broken. Saying plainly that it is not ready is worse
         * news and better information.
         */
        const phantomButton = pointsAtButton(said) && !prepared;

        return {
          answer: stray.length > 0
            ? fromRowsOnly(steps)
            : mixed
              ? `The ${mixed.name} is ₹${mixed.correct.toLocaleString("en-IN")}. ` +
                `Tell me your budget and I will get it ready for you to confirm.`
              : overclaims
              ? prepared
                ? "It is ready and waiting for you — press Confirm below and I will send the agent."
                : "Nothing has been bought yet. Tell me what you want and your budget, and I will get it ready for you to confirm."
              : phantomButton
                ? "I could not get that ready, so there is no button to press yet. " +
                  "Tell me which one you want and the most you will pay, and I will set it up."
                : said,
          steps,
          proposals: steps.map((s) => s.proposal).filter((p): p is NonNullable<typeof p> => Boolean(p)),
          answered_by: "model",
          ...(stray.length > 0
            ? { note: `replaced an answer that quoted figures no lookup returned (${stray.map((n) => "₹" + n).join(", ")})` }
            : mixed
              ? { note: `replaced an answer that priced ${mixed.name} at ₹${mixed.quoted.join(", ₹")} when it is ₹${mixed.correct}` }
              : overclaims
                ? { note: "replaced an answer that said a purchase was complete; nothing has been bought" }
                : phantomButton
                  ? { note: "replaced an answer that pointed at a button no proposal had rendered" }
                  : {}),
        };
      }

      for (const call of calls) {
        if (call.type !== "function") continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await execute({ tool: call.function.name, args });
        steps.push(result);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          // A failure and an empty result are different facts, and the model
          // will treat an unlabelled `{error: ...}` as "nothing found" — it
          // answered "your order list is empty" off a lookup that had actually
          // crashed. So a failure says, in words, that it is not an answer.
          content: JSON.stringify(
            result.error
              ? {
                  tool_failed: true,
                  error: result.error,
                  instruction:
                    "This lookup FAILED. It is not an empty result. Do not state or imply anything about what it would have returned. Tell the shopper you could not check, and stop.",
                }
              : forModel(result.data),
          ).slice(0, 1400),
        });
      }
    }

    // Out of steps with no closing sentence. Say that, rather than inventing one.
    return {
      answer:
        steps.length > 0
          ? "I looked that up but could not summarise it. What I found is below."
          : "I could not work that out.",
      steps,
      proposals: steps.map((s) => s.proposal).filter((p): p is NonNullable<typeof p> => Boolean(p)),
      answered_by: "model",
      note: "ran out of lookups",
    };
  } catch (err) {
    // A model that is rate limited or down must not look like a shop that has
    // nothing. Say which it was — and if it is a wait, say how long, because
    // "try again" with no number invites trying again immediately.
    const waitSeconds = Math.ceil((err as { waitSeconds?: number })?.waitSeconds ?? 0);
    return {
      answer: waitSeconds
        // Naming a control that is not on the screen is the thing this file
        // exists to stop, and this line was doing it: there is no Buy button on
        // a card. Add to cart is on every one of them, and a card the agent has
        // narrowed to can be clicked outright.
        ? `The shop's assistant is at its limit for the minute — about ${waitSeconds}s left. Everything else works: search the shelf and use Add to cart, or click a product the agent already found.`
        : "I could not reach the assistant just now. Search the shelf and use Add to cart, or click a product the agent already found — neither needs it.",
      steps,
      proposals: [],
      answered_by: "rules",
      // Machine-readable, so the interface can wait exactly as long as it must
      // rather than guessing or asking the shopper to keep trying.
      ...(waitSeconds ? { retry_after_seconds: waitSeconds } : {}),
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

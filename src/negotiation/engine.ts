import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";
import { assertTransactable } from "../structuring/extraction.js";

/** What the buyer-agent is authorized to do, derived from the Intent Mandate's constraints. */
export interface BuyerMandate {
  buyer_agent_id: string;
  /** Hard ceiling. The engine must never agree above this. */
  max_price: number;
  opening_offer: number;
}

export type Actor = "buyer" | "merchant";
export type Action = "offer" | "counter" | "accept" | "withdraw" | "no_deal";

export interface NegotiationTurn {
  round: number;
  actor: Actor;
  action: Action;
  amount: number | null;
  /** How the number was derived. Deterministic, and the reason this log is auditable. */
  rationale: string;
}

export type NegotiationOutcome =
  | { status: "agreed"; final_price: number; rounds: number; log: NegotiationTurn[] }
  | { status: "no_deal"; reason: string; rounds: number; log: NegotiationTurn[] };

export function validatePolicy(policy: NegotiationPolicy): void {
  if (policy.floor_price > policy.list_price) {
    throw new Error(
      `Policy for ${policy.item_id} is inverted: floor ₹${policy.floor_price} above list ₹${policy.list_price}`,
    );
  }
  if (!Number.isInteger(policy.max_rounds) || policy.max_rounds < 1) {
    throw new Error(`Policy for ${policy.item_id} has max_rounds=${policy.max_rounds}; must be >= 1`);
  }
}

/**
 * Merchant's next ask: close half the gap between the standing ask and the floor.
 *
 * Rounded up, never below the floor. Once halving stops moving the number — the
 * gap has closed to a rupee or two — it drops straight to the floor rather than
 * spending the remaining rounds shaving pennies. That last clause is what makes
 * the sequence strictly decreasing, which is half of why this loop terminates.
 */
function nextCounter(ask: number, floor: number): number {
  const counter = Math.max(floor, Math.ceil(floor + (ask - floor) / 2));
  return counter >= ask ? floor : counter;
}

/**
 * Buyer's next offer: close half the gap toward whichever is lower, the merchant's
 * standing ask or its own authorization ceiling. It will never offer above
 * `max_price`, so an accepted offer is always within the buyer's mandate.
 */
function nextOffer(offer: number, ask: number, maxPrice: number): number {
  const target = Math.min(ask, maxPrice);
  if (offer >= target) return target;
  const next = Math.ceil(offer + (target - offer) / 2);
  return Math.min(next, target);
}

/**
 * Stage 3 — bounded negotiation.
 *
 * Every number here is deterministic and derived from the merchant's policy. An
 * LLM may later phrase these turns in natural language (see phrasing.ts), but it
 * never chooses a price: the merchant set a floor, and no model gets to talk the
 * system below it.
 *
 * Termination, three independent guarantees, because an unbounded haggling loop
 * against a live payment API is the failure mode worth ruling out:
 *   1. a hard round cap from the merchant's policy;
 *   2. the merchant's ask strictly decreases toward the floor and stops there;
 *   3. the buyer's offer strictly increases toward its ceiling and stops there.
 * If (2) or (3) ever fails to move, the loop exits rather than spinning.
 */
export function negotiate(
  item: CatalogItem,
  policy: NegotiationPolicy,
  buyer: BuyerMandate,
): NegotiationOutcome {
  // An item the merchant has not confirmed cannot be haggled over, let alone sold.
  assertTransactable(item);
  validatePolicy(policy);

  const log: NegotiationTurn[] = [];
  let ask = policy.list_price;
  let offer = Math.min(buyer.opening_offer, buyer.max_price);
  let round = 0;

  const finish = (outcome: NegotiationOutcome): NegotiationOutcome => {
    const last = outcome.status === "agreed" ? outcome.final_price : null;
    if (last !== null && last > buyer.max_price) {
      throw new Error(`Engine bug: agreed ₹${last} above the buyer's ₹${buyer.max_price} ceiling`);
    }
    if (last !== null && last < policy.floor_price) {
      throw new Error(`Engine bug: agreed ₹${last} below the merchant's ₹${policy.floor_price} floor`);
    }
    return outcome;
  };

  while (round < policy.max_rounds) {
    round++;

    log.push({
      round,
      actor: "buyer",
      action: "offer",
      amount: offer,
      rationale:
        round === 1
          ? `opening offer, authorized up to ₹${buyer.max_price}`
          : `half the gap toward ₹${Math.min(ask, buyer.max_price)}`,
    });

    if (offer >= policy.floor_price) {
      // Never charge above the merchant's own list price. A buyer-agent that
      // opens high — because its ceiling is generous, or it misjudged the market
      // — should not be billed more than the shop was asking; taking the surplus
      // would be the opposite of the "favour the buyer" rule this branch exists
      // to implement.
      const settled = Math.min(offer, policy.list_price);
      log.push({
        round,
        actor: "merchant",
        action: "accept",
        amount: settled,
        rationale:
          settled < offer
            ? `offer of ₹${offer} is above the ₹${policy.list_price} list price — settled at list, not at the offer`
            : `offer is at or above the ₹${policy.floor_price} floor — accepted as offered, not haggled up`,
      });
      return finish({ status: "agreed", final_price: settled, rounds: round, log });
    }

    const counter = nextCounter(ask, policy.floor_price);
    log.push({
      round,
      actor: "merchant",
      action: "counter",
      amount: counter,
      rationale:
        counter === policy.floor_price
          ? `gap closed — dropping straight to the ₹${policy.floor_price} floor`
          : `half the gap between ₹${ask} and the ₹${policy.floor_price} floor`,
    });
    ask = counter;

    // Last round: the counter above is the merchant's final position and there is
    // no buyer turn left to answer it. Advancing the offer here would compute a
    // number that never gets said — and it used to end up quoted in the no_deal
    // reason, describing an offer absent from the log the reason is evidence for.
    if (round >= policy.max_rounds) break;

    const raised = nextOffer(offer, ask, buyer.max_price);
    if (raised === offer) {
      // Nothing left to concede and the ask is still above it — walk away now
      // rather than burn the remaining rounds repeating the same number.
      log.push({
        round,
        actor: "buyer",
        action: "withdraw",
        amount: offer,
        rationale: `at its ₹${buyer.max_price} ceiling while the ask stands at ₹${ask}`,
      });
      return finish({
        status: "no_deal",
        reason: `buyer is authorized to ₹${buyer.max_price}; merchant will not go below ₹${policy.floor_price}`,
        rounds: round,
        log,
      });
    }
    offer = raised;
  }

  /**
   * Rounds ran out with a deal still on the table.
   *
   * This is the case that made the demo look broken. A shopper authorized to
   * ₹500 wanted a cake whose floor is ₹460 — plainly a trade both sides want —
   * but the opening offer was ₹350, three rounds only carried the buyer to
   * ₹441, and the engine reported "nobody would sell it inside your budget".
   * Nobody had refused. The clock had simply run out mid-haggle.
   *
   * Where the buyer's ceiling covers the merchant's floor there is a price
   * both have already agreed to accept, so the merchant takes their floor
   * rather than lose the sale. Both limits still hold — that is the whole
   * point — and the merchant gets their stated minimum, never less.
   *
   * A buyer who bids close to the floor still lands above it through the
   * normal path above; only a buyer who ran out of road ends up exactly here.
   */
  if (buyer.max_price >= policy.floor_price) {
    log.push({
      round,
      actor: "merchant",
      action: "accept",
      amount: policy.floor_price,
      rationale:
        `${policy.max_rounds} rounds used and the buyer's ₹${buyer.max_price} ceiling still covers the ` +
        `₹${policy.floor_price} floor — taking the floor rather than losing a sale both sides wanted`,
    });
    return finish({ status: "agreed", final_price: policy.floor_price, rounds: round, log });
  }

  log.push({
    round,
    actor: "merchant",
    action: "no_deal",
    amount: null,
    rationale: `${policy.max_rounds} rounds used; buyer's ₹${buyer.max_price} ceiling is below the ₹${policy.floor_price} floor`,
  });
  return finish({
    status: "no_deal",
    reason:
      `no price exists that suits both: buyer is authorized to ₹${buyer.max_price}, ` +
      `merchant will not go below ₹${policy.floor_price}`,
    rounds: round,
    log,
  });
}

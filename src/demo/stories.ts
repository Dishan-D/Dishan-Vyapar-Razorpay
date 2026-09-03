/**
 * Six shops, six different six-month stories.
 *
 * The point of this file is that a merchant assistant is only worth
 * demonstrating if there is something in the data to find. A dataset where
 * every shop grows smoothly makes "why are sales down?" unanswerable, and an
 * assistant that cannot answer it looks broken rather than honest.
 *
 * So each shop is given a shape — growing, declining, carried by repeat
 * buyers, carried by one product, healthy but not collecting its money — and
 * the generator plays that shape out through the ordinary machinery: real
 * negotiations, real signed chains, real stock. **Nothing here writes an
 * insight.** The shape produces transactions; the analytics read the
 * transactions; whatever the assistant then says about them is derived. If a
 * story fails to show up in the numbers, the story is what is wrong.
 */

export type StoryKind =
  | "growing"
  | "repeat_driven"
  | "declining"
  | "product_driven"
  | "collection_problem"
  | "opportunity";

export interface Story {
  merchant_id: string;
  kind: StoryKind;
  /** One line, for the seed script's output and for the docs. */
  headline: string;
  /**
   * Relative volume for each of the six months, oldest first.
   *
   * A multiplier rather than a rupee target: the actual money depends on what
   * the shop sells and what the negotiation engine agrees to, neither of which
   * this file is entitled to decide.
   */
  monthly: readonly [number, number, number, number, number, number];
  /** Baseline orders on an ordinary day, before every other multiplier. */
  perDay: number;
  /** How much of the shop's trade comes from people who have bought before. */
  repeatShare: number;
  /** Share of agreed orders that never get paid for. */
  unpaidShare: number;
  /** Share of paid orders the shopkeeper has not confirmed handover on. */
  unconfirmedShare: number;
  /** Monday…Sunday. A shop's week is not flat and its buyers know it. */
  week: readonly [number, number, number, number, number, number, number];
  /** Hour of day → weight. Only the hours a shop actually trades. */
  hours: Readonly<Record<number, number>>;
  /** Products whose fortunes change over the window, by position in the shop. */
  arcs?: Readonly<Record<string, readonly number[]>>;
  /** A run of days with a multiplier — a promotion, a bad fortnight. */
  events?: ReadonlyArray<{ from: number; to: number; factor: number; note: string }>;
}

/** A bakery's day: morning rush, evening rush, quiet middle. */
const BAKERY_HOURS = { 7: 0.6, 8: 1.2, 9: 1.4, 10: 1.0, 11: 0.8, 12: 0.9, 13: 0.7, 14: 0.5, 15: 0.6, 16: 1.1, 17: 1.6, 18: 1.8, 19: 1.5, 20: 0.9 };
/** A tea shop trades early and late and barely at midday. */
const TEA_HOURS = { 6: 0.9, 7: 1.6, 8: 1.8, 9: 1.3, 10: 0.8, 11: 0.6, 12: 0.5, 13: 0.5, 14: 0.4, 15: 0.7, 16: 1.4, 17: 1.7, 18: 1.5, 19: 1.0, 20: 0.6 };
/** Clothes are bought in the afternoon and on weekends. */
const CLOTH_HOURS = { 10: 0.7, 11: 1.0, 12: 1.1, 13: 0.8, 14: 0.9, 15: 1.2, 16: 1.4, 17: 1.6, 18: 1.7, 19: 1.3, 20: 0.8 };
/** Homeware: steady daytime, no rush. */
const HOME_HOURS = { 10: 0.9, 11: 1.1, 12: 1.0, 13: 0.7, 14: 0.8, 15: 1.0, 16: 1.2, 17: 1.3, 18: 1.2, 19: 0.9 };

export const STORIES: readonly Story[] = [
  {
    /**
     * The shop the whole merchant demo runs on.
     *
     * Every other story here proves one thing. This one has to prove all of
     * them from a single screen, because switching shops mid-demo costs more
     * attention than the point being made is worth.
     *
     * So it grows over six months **and dips in the last ten days** — which is
     * not a compromise, it is the shape most real shops actually have. "How did
     * I do this month?" answers strongly; "why are sales down?" answers about
     * the dip; and both are true at once, which is a better demonstration than
     * either alone. A shopkeeper whose month is up and whose week is down is
     * exactly the person who needs to be able to ask.
     *
     * The other numbers are tuned so there is always something waiting: unpaid
     * orders to chase, handovers to confirm, buyers who stopped coming.
     */
    merchant_id: "mer_hazel", // Sri Balaji Bakery
    kind: "growing",
    headline: "Grew for six months, then dipped this week — everything demonstrable on one shop",
    monthly: [1.0, 1.12, 1.24, 1.38, 1.52, 1.58],
    perDay: 12,
    repeatShare: 0.44,
    // Enough that "who hasn't paid me?" always has an answer worth reading,
    // without making a bakery look like it runs on credit.
    unpaidShare: 0.075,
    // Enough that a couple of dozen handovers are always waiting on arrival —
    // the demo's opening "what needs my attention" depends on there being some.
    unconfirmedShare: 0.2,
    week: [0.85, 0.95, 1.0, 1.05, 1.25, 1.4, 0.8],
    hours: BAKERY_HOURS,
    events: [
      { from: 96, to: 110, factor: 1.28, note: "festival fortnight" },
      // The dip. Steepening into today so it is visible week-over-week rather
      // than only in a monthly chart — see the declining shop's entry for why
      // a gentle slope is invisible at that range.
      // A dip a shopkeeper would notice and ask about — not a collapse. The
      // first pass fell 59%, which reads as a shop in trouble rather than one
      // having a slow week, and the demo is about being able to *ask*.
      { from: 172, to: 181, factor: 0.78, note: "a quiet last week" },
      { from: 177, to: 181, factor: 0.86, note: "quieter still in the last few days" },
    ],
  },
  {
    merchant_id: "mer_atelier", // New Krishna Sweets
    kind: "repeat_driven",
    headline: "Carried by people who come back — repeat buyers are most of the trade",
    monthly: [1.0, 1.06, 1.12, 1.17, 1.24, 1.3],
    perDay: 9,
    // The story: three in four orders come from someone who has bought before.
    repeatShare: 0.74,
    unpaidShare: 0.04,
    unconfirmedShare: 0.04,
    week: [0.9, 0.95, 1.0, 1.0, 1.15, 1.45, 1.1],
    hours: BAKERY_HOURS,
  },
  {
    merchant_id: "mer_ovenroom", // Anand Bake House
    kind: "declining",
    headline: "Declining — fewer buyers each month, and the recent weeks are the weakest",
    // Falls throughout, and falls hardest at the end, so "why are sales down"
    // has a real answer in the most recent window.
    monthly: [1.45, 1.34, 1.18, 1.02, 0.86, 0.68],
    perDay: 10,
    repeatShare: 0.28,
    unpaidShare: 0.09,
    unconfirmedShare: 0.06,
    week: [0.9, 0.95, 1.0, 1.0, 1.1, 1.2, 0.75],
    hours: BAKERY_HOURS,
    /**
     * The decline has to be visible in the window the question asks about.
     *
     * A monthly slope is invisible week-over-week: ordinary day-to-day
     * variation is larger than one week's worth of a six-month trend, and the
     * first version of this store answered "why are sales down?" with "up 30%".
     * Correct arithmetic, useless demo. So the fall steepens as it approaches
     * today — a shop losing customers loses them faster once the regulars
     * start going elsewhere, which is also how it actually happens.
     */
    events: [
      { from: 150, to: 181, factor: 0.78, note: "a bad last month" },
      { from: 168, to: 181, factor: 0.72, note: "worse over the last fortnight" },
      { from: 175, to: 181, factor: 0.66, note: "worst in the last week" },
    ],
  },
  {
    merchant_id: "mer_northstar", // Ganesh Tea & Coffee
    kind: "product_driven",
    headline: "One product took off — most of the growth is a single line",
    monthly: [1.0, 1.05, 1.12, 1.24, 1.38, 1.52],
    perDay: 14,
    repeatShare: 0.5,
    unpaidShare: 0.05,
    unconfirmedShare: 0.04,
    week: [1.0, 1.0, 1.0, 1.05, 1.15, 1.1, 0.85],
    hours: TEA_HOURS,
    // Position in the shop's own catalog → month-by-month weight. The third
    // product climbs; the fourth fades. Both are visible in product analytics
    // without anything being asserted about them.
    arcs: {
      "2": [0.4, 0.6, 1.1, 1.9, 2.8, 3.6],
      "3": [1.6, 1.4, 1.1, 0.8, 0.55, 0.35],
    },
  },
  {
    merchant_id: "mer_urbanloom", // Lakshmi Cloth Store
    kind: "collection_problem",
    headline: "Selling well, collecting badly — agreed orders that never got paid",
    monthly: [1.0, 1.05, 1.08, 1.12, 1.15, 1.18],
    perDay: 7,
    repeatShare: 0.35,
    // The story. Roughly a quarter of agreed orders are never paid for, and it
    // worsens — see `unpaidDrift` in the generator.
    unpaidShare: 0.26,
    unconfirmedShare: 0.12,
    week: [0.8, 0.85, 0.95, 1.05, 1.3, 1.5, 0.95],
    hours: CLOTH_HOURS,
  },
  {
    merchant_id: "mer_studioscent", // Deepa Home Needs
    kind: "opportunity",
    headline: "Flat, with room in it — quiet hours, lapsed buyers, one product doing nothing",
    monthly: [1.05, 1.0, 1.02, 0.98, 1.03, 1.0],
    perDay: 8,
    repeatShare: 0.46,
    unpaidShare: 0.07,
    unconfirmedShare: 0.05,
    week: [0.9, 0.9, 0.95, 1.0, 1.2, 1.35, 0.85],
    hours: HOME_HOURS,
    arcs: { "4": [0.25, 0.2, 0.22, 0.18, 0.2, 0.15] },
    // A recent softening, small enough that the cause is worth finding rather
    // than obvious — which is the point of the "opportunity" shop.
    events: [{ from: 170, to: 181, factor: 0.86, note: "a slightly quiet fortnight" }],
  },
];

export const storyFor = (merchantId: string): Story | undefined =>
  STORIES.find((s) => s.merchant_id === merchantId);

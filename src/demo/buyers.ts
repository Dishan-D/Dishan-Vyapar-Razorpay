import { rngFor, intBetween, pick, weighted } from "./rng.js";

/**
 * The people the buying agents act for.
 *
 * This system's shoppers are AI agents, and until now that meant a shop could
 * see *that* it sold something and never *who* to. That is faithful to the
 * architecture and useless to a shopkeeper: "who are my regulars" is the first
 * question any of them ask, and the honest answer was that there was nobody to
 * name.
 *
 * An agent acts on behalf of a person — that is what the intent mandate is for
 * — so the person is what the agent id now carries. `agent_priya_k_04` rides
 * inside the signed intent, which means "who are my best customers" is derived
 * from the same signed chains as everything else rather than from a table
 * beside them.
 *
 * Everything here is synthetic and labelled as such. These names belong to
 * nobody; they exist so the demo has someone to have been loyal.
 */

export type Segment = "loyal" | "regular" | "occasional" | "new" | "lapsed" | "passing";

export interface DemoBuyer {
  /** What goes in the mandate — and what the analytics group by. */
  agent_id: string;
  name: string;
  segment: Segment;
  /** Day index within the window when they first bought. */
  firstDay: number;
  /** Day index after which they stop appearing. Infinity for still-active. */
  lastDay: number;
  /** Relative likelihood of being the buyer on any eligible day. */
  weight: number;
}

const FIRST = [
  "Priya", "Rahul", "Anita", "Vikram", "Meena", "Suresh", "Kavya", "Arjun", "Divya", "Ganesh",
  "Lakshmi", "Ramesh", "Sunita", "Manoj", "Deepa", "Aravind", "Shalini", "Karthik", "Nandini", "Prakash",
  "Rekha", "Sanjay", "Bhavana", "Naveen", "Usha", "Girish", "Pooja", "Harish", "Latha", "Mohan",
];
const LAST = ["K", "R", "S", "M", "N", "P", "B", "V", "G", "D"];

const slug = (name: string, n: number) =>
  `agent_${name.toLowerCase().replace(/[^a-z]/g, "")}_${String(n).padStart(2, "0")}`;

/**
 * A shop's customers, with the mix the story needs.
 *
 * Deliberately unequal. A handful of people are most of the trade and a long
 * tail buys once — which is what a shop actually looks like, and what makes
 * "your top five are 40% of revenue" a finding rather than an arithmetic
 * artefact of everyone buying the same amount.
 */
export function buyersFor(merchantId: string, windowDays: number, opts: { count?: number } = {}): DemoBuyer[] {
  const r = rngFor(`buyers:${merchantId}`);
  // A shop of this size knows far more people than it has regulars. The tail of
  // one-time buyers is most of the list and almost none of the money, which is
  // exactly what makes "your top five are half your revenue" a finding.
  const count = opts.count ?? intBetween(r, 90, 130);
  const out: DemoBuyer[] = [];
  const used = new Set<string>();

  for (let i = 0; i < count; i++) {
    let name = `${pick(r, FIRST)} ${pick(r, LAST)}`;
    let guard = 0;
    while (used.has(name) && guard++ < 40) name = `${pick(r, FIRST)} ${pick(r, LAST)}`;
    used.add(name);

    const segment = weighted<Segment>(r, [
      ["loyal", 7],        // few, and most of the money
      ["regular", 13],
      ["occasional", 30],
      ["new", 14],         // arrived recently
      ["lapsed", 12],      // were regular, then stopped — the recoverable ones
      ["passing", 34],     // bought once and never again; most of the list
    ]);

    // When they first appear, and when they stop. A "new" buyer cannot have a
    // six-month history, and a "lapsed" one must have a gap long enough to
    // actually count as lapsed rather than as someone who bought last week.
    const firstDay =
      segment === "new" ? intBetween(r, windowDays - 38, windowDays - 4)
        : segment === "lapsed" ? intBetween(r, 0, Math.floor(windowDays * 0.35))
          : intBetween(r, 0, Math.floor(windowDays * 0.5));

    // Someone passing through is around for a day or two, not six months.
    const lastDay =
      segment === "passing" ? firstDay + intBetween(r, 0, 2)
        : segment === "lapsed" ? intBetween(r, windowDays - 95, windowDays - 34)
          : Number.POSITIVE_INFINITY;

    const weight =
      segment === "loyal" ? intBetween(r, 14, 22)
        : segment === "regular" ? intBetween(r, 7, 12)
          : segment === "occasional" ? intBetween(r, 2, 5)
            : segment === "new" ? intBetween(r, 3, 7)
              : segment === "passing" ? 1
                : intBetween(r, 4, 9); // lapsed were busy while they lasted

    out.push({ agent_id: slug(name.split(" ")[0]!, i), name, segment, firstDay, lastDay, weight });
  }
  return out;
}

/** Who bought, on this day, given who was around. */
export function buyerOn(
  r: () => number,
  buyers: readonly DemoBuyer[],
  day: number,
  repeatShare: number,
  seenBefore: ReadonlySet<string>,
): DemoBuyer | null {
  const around = buyers.filter((b) => day >= b.firstDay && day <= b.lastDay);
  if (around.length === 0) return null;

  // The story's repeat share decides whether this order goes to somebody who
  // has bought here before or to somebody who has not — which is the whole
  // difference between the repeat-driven shop and the declining one.
  const returning = around.filter((b) => seenBefore.has(b.agent_id));
  const fresh = around.filter((b) => !seenBefore.has(b.agent_id));
  const pool = returning.length > 0 && fresh.length > 0
    ? (r() < repeatShare ? returning : fresh)
    : returning.length > 0 ? returning : fresh;

  if (pool.length === 0) return null;
  return weighted(r, pool.map((b) => [b, b.weight] as const));
}

/** Look a buyer up by the id stored in a mandate. */
export function nameOf(agentId: string, buyers: readonly DemoBuyer[]): string | null {
  return buyers.find((b) => b.agent_id === agentId)?.name ?? null;
}

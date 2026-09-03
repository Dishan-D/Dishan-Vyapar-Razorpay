/**
 * A token-per-minute governor for Groq.
 *
 * The free (`on_demand`) tier allows 8,000 tokens per minute on the vision
 * model, and a single product photo costs about 2,074 of them regardless of how
 * large the image is — Groq bills images at a flat rate, so compressing them
 * saves bandwidth and nothing else. That budget is exhausted after roughly four
 * photos, and a fifteen-item catalog needs about 19,400 tokens.
 *
 * So the run has to be paced rather than fired off. Every response carries the
 * remaining budget and when it resets; this reads those, waits when the next
 * call would not fit, and honours `retry-after` when it misjudges.
 */

export interface RateState {
  remainingTokens: number | null;
  resetSeconds: number | null;
  observedAt: number;
}

/** "59.827s", "2m52.8s", "134ms" — Groq's reset headers come in all three. */
export function parseDuration(value: string | null): number | null {
  if (!value) return null;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;

  let total = 0;
  let matched = false;
  for (const [, amount, unit] of value.matchAll(/([\d.]+)(ms|s|m|h)/g)) {
    const n = Number(amount);
    if (!Number.isFinite(n)) continue;
    matched = true;
    total += unit === "ms" ? n / 1000 : unit === "s" ? n : unit === "m" ? n * 60 : n * 3600;
  }
  return matched ? total : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export interface GovernorOptions {
  /** Called before a wait, so a long run can say why it is pausing. */
  onWait?: (seconds: number, reason: string) => void;
  maxRetries?: number;
}

export interface RunOptions {
  /**
   * Give up rather than spend longer than this waiting, in total.
   *
   * A ceiling on the whole call — every wait before every attempt added
   * together — not on each one separately. A batch catalog build is happy to
   * sit out a minute. An interactive call — parsing what a shopper just typed,
   * phrasing a haggle — is not: a demo that freezes for sixty seconds reads as
   * broken, and both of those callers have a deterministic fallback that is
   * instant and honest about being used.
   */
  maxWaitSeconds?: number;
}

/** Thrown when waiting for budget would take longer than the caller will accept. */
export class RateBudgetExceeded extends Error {
  constructor(readonly waitSeconds: number) {
    super(`token budget exhausted; would need to wait ${waitSeconds.toFixed(0)}s`);
    this.name = "RateBudgetExceeded";
  }
}

export class RateGovernor {
  private state: RateState = { remainingTokens: null, resetSeconds: null, observedAt: Date.now() };

  /** Settable so a batch caller can attach progress reporting to the shared budget. */
  onWait?: (seconds: number, reason: string) => void;

  constructor(private readonly opts: GovernorOptions = {}) {
    this.onWait = opts.onWait;
  }

  /** Fold a response's rate-limit headers into what we know. */
  observe(headers: Headers | { get(name: string): string | null }): void {
    const remaining = Number(headers.get("x-ratelimit-remaining-tokens"));
    this.state = {
      remainingTokens: Number.isFinite(remaining) ? remaining : null,
      resetSeconds: parseDuration(headers.get("x-ratelimit-reset-tokens")),
      observedAt: Date.now(),
    };
  }

  /**
   * Wait if the next call would not fit in what is left of this minute.
   *
   * `deadline` is absolute, not a per-wait allowance — see `run`.
   */
  private async waitIfShort(estimatedTokens: number, deadline: number | null): Promise<void> {
    const { remainingTokens, resetSeconds, observedAt } = this.state;
    if (remainingTokens === null || resetSeconds === null) return;
    if (remainingTokens >= estimatedTokens) return;

    const elapsed = (Date.now() - observedAt) / 1000;
    const wait = Math.max(0, resetSeconds - elapsed) + 0.5;
    if (wait <= 0) return;
    if (deadline !== null && Date.now() + wait * 1000 > deadline) {
      throw new RateBudgetExceeded(wait);
    }

    this.onWait?.(wait, `${remainingTokens} tokens left, need ~${estimatedTokens}`);
    await sleep(wait * 1000);
    this.state.remainingTokens = null; // budget is fresh; re-learn from the next response
  }

  /**
   * Run one API call inside the budget.
   *
   * `call` must hand back the response headers alongside its result — pacing
   * without reading the headers is guesswork, and guesswork is what produced
   * the 429s in the first place.
   */
  async run<T>(
    estimatedTokens: number,
    call: () => Promise<{ data: T; response: { headers: Headers | { get(n: string): string | null }; status?: number } }>,
    runOpts: RunOptions = {},
  ): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 4;

    /**
     * One deadline for the whole call, not a fresh allowance per attempt.
     *
     * `maxWaitSeconds` used to cap each individual sleep, so a caller asking to
     * wait at most 25 seconds could sit through five of them: a shopper's
     * question was observed taking **218 seconds** to come back, against a
     * setting whose own comment says a demo that freezes for sixty reads as
     * broken. Nobody waits out a 429 storm — they reload, and then it looks
     * like the page is broken as well as slow.
     *
     * Every caller that passes this has a deterministic fallback that answers
     * instantly and says it is being used, so giving up early is strictly
     * better than arriving late.
     */
    const deadline =
      runOpts.maxWaitSeconds === undefined ? null : Date.now() + runOpts.maxWaitSeconds * 1000;

    for (let attempt = 0; ; attempt++) {
      await this.waitIfShort(estimatedTokens, deadline);
      try {
        const { data, response } = await call();
        this.observe(response.headers);
        return data;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 429 || attempt >= maxRetries) throw err;

        const headers = (err as { headers?: { get(n: string): string | null } }).headers;
        const retryAfter = parseDuration(headers?.get("retry-after") ?? null) ?? 20;
        if (deadline !== null && Date.now() + retryAfter * 1000 > deadline) {
          throw new RateBudgetExceeded(retryAfter);
        }
        this.onWait?.(retryAfter, "rate limited, honouring retry-after");
        await sleep((retryAfter + 0.5) * 1000);
        this.state.remainingTokens = null;
      }
    }
  }
}

/** Rough cost of one extraction call. Images dominate and are billed flat. */
export const estimateTokens = (hasImage: boolean): number => (hasImage ? 2200 : 1000);

/**
 * One budget per process.
 *
 * Extraction, negotiation phrasing and the agent's intent parsing all draw on
 * the same tokens-per-minute allowance. Separate governors would each have to
 * rediscover the limit by hitting it, which is how the 429s happened.
 */
export const sharedGroqGovernor = new RateGovernor();

/** How long an interactive call will wait before falling back. */
/**
 * How long a call may wait for budget while someone is watching.
 *
 * Three seconds was too impatient. The per-minute window resets inside sixty,
 * so a burst that overshot by a little failed outright when waiting eight
 * seconds would have answered — and the shopper saw "I could not reach the
 * model just now" for something that was merely busy. Twenty-five is long
 * enough to ride out an ordinary overshoot and short enough that nobody
 * wonders whether the page has hung.
 */
export const INTERACTIVE_MAX_WAIT_SECONDS = 25;

/**
 * A step inside a multi-call turn. Shorter, because a turn can make five of
 * them and the shopper is waiting for all of them, not one.
 */
export const STEP_MAX_WAIT_SECONDS = 10;

/**
 * The smallest gap between consecutive calls.
 *
 * The governor reacts to what the last response reported, which is a beat
 * behind: five calls fired back to back all believe there is budget, and the
 * fifth learns otherwise. A short spacer keeps a single turn from lapping its
 * own accounting.
 */
export const MIN_CALL_SPACING_MS = 350;

let lastCallAt = 0;
export async function spaceCalls(): Promise<void> {
  const since = Date.now() - lastCallAt;
  if (since < MIN_CALL_SPACING_MS) await sleep(MIN_CALL_SPACING_MS - since);
  lastCallAt = Date.now();
}

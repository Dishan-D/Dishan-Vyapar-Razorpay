/**
 * A deterministic random number generator.
 *
 * The demo dataset has to be the same every time the database is reset. Not for
 * tidiness — because a merchant screen whose numbers move on every reload is
 * indistinguishable from one that is making them up, and because a rehearsed
 * demo where "sales are down 14%" becomes "up 9%" between the practice run and
 * the real one is worse than no demo.
 *
 * mulberry32: small, fast, and good enough for synthetic sales. Seeded from a
 * string so each shop's history is independent — regenerating one does not
 * shift another, which matters when tuning one store's story.
 */
export function rngFor(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [lo, hi]. */
export const intBetween = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));

/** One of these, uniformly. */
export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** One of these, by weight. Weights need not sum to anything in particular. */
export function weighted<T>(r: () => number, xs: ReadonlyArray<readonly [T, number]>): T {
  const total = xs.reduce((s, [, w]) => s + w, 0);
  let n = r() * total;
  for (const [x, w] of xs) {
    n -= w;
    if (n <= 0) return x;
  }
  return xs[xs.length - 1]![0];
}

/**
 * A bell-ish number around `mid`, clamped.
 *
 * Three samples averaged: enough to stop the flat look of uniform noise —
 * real baskets cluster around a typical size — without pulling in a statistics
 * library for a demo fixture.
 */
export function around(r: () => number, mid: number, spread: number, lo: number, hi: number): number {
  const n = (r() + r() + r()) / 3;
  return Math.max(lo, Math.min(hi, Math.round(mid + (n - 0.5) * 2 * spread)));
}

/** True with probability p. */
export const chance = (r: () => number, p: number): boolean => r() < p;

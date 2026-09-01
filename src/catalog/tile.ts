/**
 * A generated tile for a product with no photograph.
 *
 * Deliberately not a photograph, and deliberately not one fetched from the web.
 *
 * A picture in this catalog carries a claim: *this is the thing this shop has*.
 * A stock image found by searching the product's name makes that claim without
 * any of it being true — the shop has never seen the item in the picture, and
 * a buyer comparing two shops would be comparing two strangers' photography.
 * The whole product is an argument that a merchant's data should be checkable,
 * and quietly borrowing someone else's picture of a cake would undercut it more
 * than an empty square ever could.
 *
 * So this draws something honest instead: the product's own name, its category,
 * and a colour derived from its id. It is obviously a graphic rather than a
 * photo, it is stable across reloads, it costs nothing, and it disappears the
 * moment the shopkeeper uploads a real picture of their own stock.
 */

/**
 * A stable hue per product, so the same item is always the same colour.
 *
 * Spread by the golden angle rather than taken modulo 360 directly. Ids from
 * one shop differ by a character or two and hash close together, so the plain
 * modulo gave adjacent products near-identical colours — itm_hazel_001 and
 * itm_hazel_003 came out at 302° and 300°, which on a shelf reads as one
 * product photographed twice. Multiplying by 137.5° sends neighbours to
 * opposite sides of the wheel.
 */
function hueOf(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.round((Math.abs(h) % 1000) * 137.508) % 360;
}

/** One glyph per family. Enough to tell a cake from a shirt at a glance. */
const GLYPH: Record<string, string> = {
  "food.snack": "🍰",
  "apparel.saree": "🥻",
  "apparel.kurta": "👕",
  "apparel.dupatta": "🧣",
  "apparel.other": "👖",
  "home.bedsheet": "🛏",
  "home.towel": "🧺",
  "home.other": "🕯",
  "mobile.case": "📱",
  "mobile.charger": "🔌",
  "mobile.audio": "🎧",
  "mobile.screenguard": "🛡",
  "electronics.laptop": "💻",
  "electronics.tv": "📺",
  "electronics.appliance": "🍳",
  "stationery.pen": "🖊",
  "stationery.paper": "📓",
  "general.other": "🎁",
};

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Break a product name over at most three lines that fit the tile. */
function wrap(name: string, perLine = 18, maxLines = 3): string[] {
  const words = name.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > perLine && line) {
      lines.push(line.trim());
      line = w;
      if (lines.length === maxLines - 1) break;
    } else {
      line = `${line} ${w}`.trim();
    }
  }
  if (line && lines.length < maxLines) lines.push(line.trim());
  return lines.slice(0, maxLines);
}

export function productTile(itemId: string, name: string, category: string): string {
  const hue = hueOf(itemId);
  const glyph = GLYPH[category] ?? GLYPH[`${category.split(".")[0]}.other`] ?? "📦";
  const lines = wrap(name);
  const startY = 150 - (lines.length - 1) * 13;

  // oklch keeps the tints even across hues; two stops give it a little depth
  // without turning into the kind of gradient that makes text hard to read.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="320" height="240" role="img" aria-label="${esc(name)}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="oklch(0.95 0.045 ${hue})"/>
      <stop offset="1" stop-color="oklch(0.90 0.075 ${(hue + 28) % 360})"/>
    </linearGradient>
  </defs>
  <rect width="320" height="240" fill="url(#g)"/>
  <text x="160" y="98" font-size="46" text-anchor="middle" dominant-baseline="middle">${glyph}</text>
  ${lines
    .map(
      (l, i) =>
        `<text x="160" y="${startY + i * 21}" font-family="Inter, system-ui, sans-serif" font-size="15" font-weight="600" fill="oklch(0.32 0.05 ${hue})" text-anchor="middle">${esc(l)}</text>`,
    )
    .join("\n  ")}
  <text x="160" y="222" font-family="ui-monospace, SFMono-Regular, monospace" font-size="9.5" letter-spacing="1.6" fill="oklch(0.52 0.04 ${hue})" text-anchor="middle">NO PHOTO YET</text>
</svg>`;
}

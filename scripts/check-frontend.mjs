/**
 * Static checks for the page modules that `node --check` cannot make.
 *
 * A syntax check passes on code that dies the moment it runs. The one that bit
 * us: a top-level `let` declared below the boot code that reads it. `let` is
 * hoisted but not initialised, so the read throws a ReferenceError, the module
 * stops, and the page loses everything after that point — products,
 * navigation, the lot. It looks like a server problem and is not.
 */
import { readFileSync, readdirSync } from "node:fs";

const pages = readdirSync("frontend").filter((f) => f.endsWith(".html"));
let problems = 0;

for (const page of pages) {
  const src = readFileSync(`frontend/${page}`, "utf8");

  /**
   * The document has to start where a document starts.
   *
   * Twice now a scripted edit has prepended a block of JavaScript above
   * `<!doctype html>` instead of replacing it in place. The browser then
   * renders the code as text at the top of the page — which looks like a
   * styling fault, not a broken edit — and every other check passes, because
   * the script block it extracts still parses perfectly.
   */
  if (!src.startsWith("<!doctype html>")) {
    const stray = src.slice(0, src.indexOf("<!doctype html>")).trim().split("\n")[0] ?? "";
    console.log(`  ✗ ${page}: content before <!doctype html> — it will render as text`);
    console.log(`      ${stray.slice(0, 74)}`);
    problems++;
  }
  if (src.split("</body>").length - 1 !== 1) {
    console.log(`  ✗ ${page}: expected exactly one </body>, found ${src.split("</body>").length - 1}`);
    problems++;
  }
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(src);
  if (!m) continue;
  const js = m[1];
  const lines = js.split("\n");

  // Top-level bindings only: no leading whitespace means column zero.
  const declared = new Map();
  lines.forEach((line, i) => {
    const d = /^(?:let|const|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (d && !declared.has(d[1])) declared.set(d[1], i + 1);
  });

  for (const [name, declLine] of declared) {
    // Where the identifier is first mentioned at column zero — i.e. in code
    // that runs during module evaluation rather than inside a function body.
    const use = lines.findIndex(
      (line, i) =>
        i + 1 < declLine &&
        /^[A-Za-z$_(]/.test(line) &&
        new RegExp(`\\b${name}\\b`).test(line) &&
        !/^\s*(\/\/|\*|\/\*)/.test(line),
    );
    if (use !== -1) {
      console.log(`  ✗ ${page}: "${name}" is used at line ${use + 1} but declared at ${declLine}`);
      console.log(`      ${lines[use].trim().slice(0, 74)}`);
      problems++;
    }
  }

  /**
   * The stylesheet has to close every rule it opens.
   *
   * An unbalanced brace does not fail loudly — the browser swallows the rest of
   * the block and the page renders with a handful of rules silently missing,
   * which looks like a layout bug in whatever happened to be next. It has
   * happened here from deleting a multi-line rule by its first line and leaving
   * the closing brace behind.
   */
  for (const [, css] of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    let line = 1;
    let firstExtra = 0;
    for (const ch of clean) {
      if (ch === "\n") line++;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth < 0 && !firstExtra) { firstExtra = line; depth = 0; }
    }
    if (depth !== 0 || firstExtra) {
      console.log(
        `  ✗ ${page}: <style> braces do not balance` +
          (firstExtra ? ` — first stray "}" at style line ${firstExtra}` : ` — ${depth} rule(s) left open`),
      );
      problems++;
    }
  }

  // Every id the module reaches for must exist in the markup.
  const html = src.slice(0, src.indexOf('<script type="module">'));
  const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((x) => x[1]));
  // Created by a render and used immediately after, so they are never in the
  // static markup. Each is read through a null-guard at its use site.
  const runtime = new Set(["twinapply", "twincancel", "retry", "pay", "paynote", "clearfilter", "cbgo", "reconrows", "noticedwhy", "noticedwho"]);
  for (const [, id] of js.matchAll(/\$\("([\w-]+)"\)/g)) {
    if (!ids.has(id) && !runtime.has(id)) {
      console.log(`  ✗ ${page}: $("${id}") has no element in the markup`);
      problems++;
    }
  }
}

/**
 * The shelf highlight, checked against sentences the assistant really produced.
 *
 * Pulled out of the page and run rather than read, because the failure it had
 * was invisible in the source: reading "6 cakes under ₹800, ranging ₹450–₹750"
 * as four product mentions is only obviously wrong once you see which cards
 * light up.
 */
{
  const src = readFileSync(new URL("../frontend/store.html", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function pricesNaming"), src.indexOf("function clearHighlights"));
  const pricesNaming = new Function(`${fn}; return pricesNaming;`)();

  const cases = [
    ["a summary with a ceiling and a range",
     "I found 6 cakes under ₹800, ranging for ₹450–₹750. The most affordable is the Chocolate Cake 500g at ₹450, while you get more size with Red Velvet Cake 1kg (₹599) or Chocolate Cake 1kg (₹750).",
     [450, 599, 750]],
    ["two products named plainly", "The 500g Chocolate Cake is ₹450 and the Truffle is ₹490.", [450, 490]],
    ["a ceiling and nothing else", "I found 6 cakes under ₹800. Which would you like?", []],
    ["a range and nothing else", "They run from ₹450 to ₹750.", []],
    ["\"up to\" is a ceiling too", "Nothing up to ₹300, but the Butter Puff is ₹95.", [95]],
  ];

  for (const [name, answer, want] of cases) {
    const got = [...pricesNaming(answer)].sort((a, b) => a - b);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.log(`  ✗ store.html: highlight — ${name}: got [${got}], wanted [${want}]`);
      problems++;
    }
  }
}

{
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const depth = css.split("{").length - css.split("}").length;
  if (depth !== 0) {
    console.log(`  ✗ app.css: braces do not balance (${depth > 0 ? `${depth} left open` : `${-depth} extra`})`);
    problems++;
  }
}

console.log(problems === 0 ? `\n  ${pages.length} pages clean, css balanced, highlight checks pass` : `\n  ${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);

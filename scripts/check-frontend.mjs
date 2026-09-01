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

  // Every id the module reaches for must exist in the markup.
  const html = src.slice(0, src.indexOf('<script type="module">'));
  const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((x) => x[1]));
  // Created by a render and used immediately after, so they are never in the
  // static markup. Each is read through a null-guard at its use site.
  const runtime = new Set(["twinapply", "twincancel", "retry", "pay", "paynote", "clearfilter", "cbgo"]);
  for (const [, id] of js.matchAll(/\$\("([\w-]+)"\)/g)) {
    if (!ids.has(id) && !runtime.has(id)) {
      console.log(`  ✗ ${page}: $("${id}") has no element in the markup`);
      problems++;
    }
  }
}

console.log(problems === 0 ? `\n  ${pages.length} pages clean` : `\n  ${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);

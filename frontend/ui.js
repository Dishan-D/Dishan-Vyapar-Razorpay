/* Shared front-end plumbing: nav, status pills, socket wiring, formatting.
   Every page loads this so the header behaves identically everywhere. */

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
export const rupee = (n) => "₹" + Number(n).toLocaleString("en-IN");
export const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const note = (kind, html) => `<div class="note ${kind}">${html}</div>`;

export async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

const NAV = [
  ["/", "Home"],
  ["/onboard.html", "Set up a store"],
  ["/store.html", "Storefront"],
  ["/shop.html", "Agent log"],
  ["/merchant.html", "Merchant"],
  ["/market.html", "Live market"],
];

function renderNav() {
  const here = location.pathname === "/index.html" ? "/" : location.pathname;
  const host = document.getElementById("nav");
  if (!host) return;
  host.outerHTML = `<header>
    <span class="brand"><span class="mark">V</span>Vyapar</span>
    <nav class="tabs">${NAV.map(([href,label]) =>
      `<a href="${href}"${href === here ? ' class="on"' : ""}>${label}</a>`).join("")}</nav>
    <span class="spacer"></span>
    <div class="status">
      <div class="stat"><span class="k">Catalog</span><span class="v" id="src">—</span></div>
      <div class="stat"><span class="k">Gateway</span><span class="v" id="gw">—</span></div>
      <span class="livedot" id="conn"><i></i>connecting</span>
    </div>
  </header>`;
}

/**
 * Render the chrome, fill the honesty pills, open the socket.
 * Returns the server config so a page can decide about Checkout.
 */
export async function boot({ watch, onEvent, onBacklog } = {}) {
  renderNav();

  const [{ body: config }, { body: health }] = await Promise.all([api("/config"), api("/health")]);

  const src = $("src");
  if (src) {
    const live = health.catalog_provider && health.catalog_provider !== "fixture";
    src.textContent = live ? "Extracted live" : "Fixtures";
    src.classList.toggle("on", Boolean(live));
  }

  const gw = $("gw");
  if (gw) gw.textContent = config.gateway === "razorpay"
    ? (config.requires_checkout ? "Razorpay · Checkout" : "Razorpay")
    : "Simulated";
  if (gw) gw.classList.toggle("on", config.gateway === "razorpay");

  if (typeof io === "function") {
    const socket = io();
    const conn = $("conn");
    socket.on("connect", () => {
      if (conn) { conn.className = "livedot on"; conn.innerHTML = "<i></i>Live"; }
      if (watch) socket.emit("watch", watch);
    });
    socket.on("disconnect", () => { if (conn) { conn.className = "livedot"; conn.innerHTML = "<i></i>Offline"; } });
    if (onBacklog) socket.on("backlog", onBacklog);
    if (onEvent) socket.on("event", onEvent);
    config.socket = socket;
  }

  return config;
}

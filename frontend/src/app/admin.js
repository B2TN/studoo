// Pages réservées à l'administrateur : /admin (comptes, messages, quotas) et /analytics.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { relativeDate } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { confirmDialog, errorToast } from "../lib/ui.js";

const LABELS = { transcription: "Transcriptions", fiche: "Fiches", podcast: "Podcasts", video: "Vidéos", scan: "Numérisations" };

function stat(label, value) {
  return h("div", { class: "stat card sketch" }, h("span", { class: "n" }, String(value)), h("span", { class: "small muted" }, label));
}

/** Petit graphique en barres SVG (dessiné à la main, sans bibliothèque). */
function barChart(series, key, label) {
  const W = 720, H = 200, pad = 28;
  const max = Math.max(1, ...series.map((d) => d[key]));
  const bw = (W - pad * 2) / series.length;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${label} sur ${series.length} jours, maximum ${max}`);
  series.forEach((d, i) => {
    const bh = ((H - pad * 2) * d[key]) / max;
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", String(pad + i * bw + 2));
    r.setAttribute("y", String(H - pad - bh));
    r.setAttribute("width", String(Math.max(2, bw - 4)));
    r.setAttribute("height", String(bh));
    r.setAttribute("rx", "3");
    r.setAttribute("fill", "var(--fluo-blue)");
    r.setAttribute("stroke", "var(--ink)");
    r.setAttribute("stroke-width", "1.5");
    const t = document.createElementNS(ns, "title");
    t.textContent = `${d.day} : ${d[key]}`;
    r.append(t);
    svg.append(r);
  });
  const axis = document.createElementNS(ns, "line");
  Object.entries({ x1: pad, x2: W - pad, y1: H - pad, y2: H - pad, stroke: "var(--ink)", "stroke-width": 2 }).forEach(([k, v]) => axis.setAttribute(k, String(v)));
  svg.append(axis);
  for (const [i, d] of [[0, series[0]], [series.length - 1, series[series.length - 1]]]) {
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", String(pad + i * bw));
    t.setAttribute("y", String(H - 6));
    t.setAttribute("fill", "var(--ink-soft)");
    t.setAttribute("font-size", "14");
    t.textContent = new Date(d.day).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    svg.append(t);
  }
  return h("figure", { style: { margin: 0 } }, svg, h("figcaption", { class: "small muted" }, label));
}

async function renderAdmin(view, go) {
  const [ov, users, msgs] = await Promise.all([api("/api/admin/overview"), api("/api/admin/users"), api("/api/admin/messages")]);
  const q = ov.quota;
  mount(view,
    h("h1", { class: "view-title" }, h("span", { class: "hl pink" }, "Admin")),
    h("div", { class: "stats" },
      stat("Comptes", ov.users), stat("Actifs (7 j)", ov.activeUsers7d), stat("Messages non lus", ov.unreadMessages),
      ...Object.entries(LABELS).map(([k, l]) => stat(l, ov.generations[k] || 0))),
    h("h2", { class: "section" }, "Quotas IA du jour"),
    h("div", { class: "stats" }, ["lite", "flash", "tts"].map((t) => h("div", { class: "stat card sketch" },
      h("strong", {}, { lite: "Flash-Lite", flash: "Flash", tts: "Voix (TTS)" }[t]),
      h("div", { class: "bar", style: { margin: "8px 0" } }, h("span", { style: { width: `${Math.min(100, (100 * q[t].used) / Math.max(1, q[t].limit))}%` } })),
      h("span", { class: "small" }, `${q[t].used} / ${q[t].limit} requêtes`)))),
    h("h2", { class: "section" }, "Messages"),
    h("section", { class: "card sketch" }, msgs.messages.length ? h("ul", { class: "files" }, msgs.messages.map((m) => h("li", { style: { alignItems: "flex-start" } },
      h("span", { class: `kind ${m.handled ? "c-green" : "c-pink"}` }, icon("mail")),
      h("span", {}, h("strong", {}, m.subject), h("br"), h("span", { class: "small muted" }, `${m.email} · ${relativeDate(m.createdAt)}`), h("p", { class: "small", style: { whiteSpace: "pre-wrap", margin: "6px 0 0" } }, m.body)),
      m.handled ? h("span", { class: "meta" }, "traité") : h("span", { class: "meta" }, h("button", { class: "btn small", onclick: async () => { await api(`/api/admin/messages/${m.id}/handled`, { method: "POST" }); go("/admin", { replace: true }); } }, icon("check"), "Traité")))))
      : h("p", { class: "empty" }, "Aucun message.")),
    h("h2", { class: "section" }, "Comptes"),
    h("section", { class: "card sketch table-wrap" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Nom"), h("th", { scope: "col" }, "E-mail"), h("th", { scope: "col" }, "Inscription"), h("th", { scope: "col" }, "Dernière visite"), h("th", { scope: "col" }, h("span", { class: "sr-only" }, "Actions")))),
      h("tbody", {}, users.users.map((u) => h("tr", {}, h("td", {}, u.name), h("td", {}, u.email), h("td", {}, relativeDate(u.createdAt)), h("td", {}, relativeDate(u.lastSeenAt)),
        h("td", {}, h("button", { class: "btn small danger", "aria-label": `Supprimer le compte ${u.email}`, onclick: async () => {
          if (!(await confirmDialog("Supprimer ce compte ?", `${u.email} sera effacé de la base (ses fichiers Drive restent chez lui).`, { ok: "Supprimer", danger: true }))) return;
          await api(`/api/admin/users/${encodeURIComponent(u.sub)}`, { method: "DELETE" }).catch(errorToast);
          go("/admin", { replace: true });
        } }, icon("trash")))))))));
}

async function renderAnalytics(view, query, go) {
  const days = Number(query.get("jours") || 30);
  const data = await api(`/api/admin/analytics?days=${days}`);
  const s = data.series;
  const total = (k) => s.reduce((a, d) => a + d[k], 0);
  const gens = s.map((d) => ({ day: d.day, total: Object.values(d.generations).reduce((a, b) => a + b, 0) }));
  mount(view,
    h("h1", { class: "view-title" }, h("span", { class: "hl blue" }, "Analytics")),
    h("p", { class: "muted small" }, "Mesure maison, sans cookie : pages vues et visiteurs uniques (empreinte anonyme qui change chaque jour). Seuls les visiteurs ayant accepté les statistiques sont comptés."),
    h("div", { class: "row", style: { margin: "10px 0 18px" } }, [7, 30, 90].map((d) =>
      h("a", { class: `btn small${d === days ? " primary" : ""}`, href: `/analytics?jours=${d}`, "data-link": "1" }, `${d} jours`))),
    h("div", { class: "stats" }, stat("Pages vues", total("views")), stat("Visiteurs uniques (somme/jour)", total("visitors")), stat("Générations IA", gens.reduce((a, g) => a + g.total, 0))),
    h("section", { class: "card sketch", style: { marginTop: "20px" } }, barChart(s, "views", "Pages vues par jour")),
    h("section", { class: "card sketch", style: { marginTop: "20px" } }, barChart(s, "visitors", "Visiteurs uniques par jour")),
    h("section", { class: "card sketch", style: { marginTop: "20px" } }, barChart(gens, "total", "Générations IA par jour")),
    h("h2", { class: "section" }, "Pages les plus vues"),
    h("section", { class: "card sketch table-wrap" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Page"), h("th", { scope: "col" }, "Vues"))),
      h("tbody", {}, data.topPaths.map((p) => h("tr", {}, h("td", {}, p.path), h("td", {}, String(p.views))))))));
}

export async function render({ view, route, query, go }) {
  if (route.path === "/analytics") return renderAnalytics(view, query, go);
  return renderAdmin(view, go);
}

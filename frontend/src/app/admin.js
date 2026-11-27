// Pages réservées à l'administrateur : /admin (comptes, messages, quotas) et /analytics.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { relativeDate } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { FLOW, SERVICES } from "../lib/services.js";
import { confirmDialog, errorToast, openDialog, toast } from "../lib/ui.js";

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

// ---------- Corbeille d'un compte : supprimer ou bannir (itération 7, C3) ----------
const KIND_LABELS = { account: "compte Google", email: "adresse e-mail", ip: "adresse IP", device: "appareil" };
const ACTION_LABELS = { delete_user: "Compte supprimé", ban: "Compte banni", unban: "Bannissement levé" };

function removeDialog(u, go) {
  openDialog(`Que faire du compte ${u.email} ?`, (close) => {
    const mode = (v) => h("input", { type: "radio", name: "rm-mode", value: v, checked: v === "delete" });
    const del = mode("delete");
    const ban = mode("ban");
    const days = h("select", { class: "input", id: "rm-days" },
      [["7", "7 jours"], ["30", "30 jours (conseillé)"], ["90", "90 jours"], ["", "Définitif"]].map(([v, l]) => h("option", { value: v, selected: v === "30" }, l)));
    const reason = h("textarea", { class: "input", id: "rm-reason", maxlength: "300", rows: "2", placeholder: "Ex. : spam répété dans le formulaire de contact" });
    const banOptions = h("div", { class: "stack", hidden: true },
      h("div", { class: "field" }, h("label", { for: "rm-days" }, "Durée du bannissement"), days),
      h("p", { class: "small notice warn" }, h("strong", {}, "Limites à connaître. "),
        "Une adresse IP est souvent partagée (lycée, université, wifi public, réseau mobile) : la bloquer peut gêner des innocents, "
        + "elle n'est donc jamais bloquée plus de 30 jours, même en « définitif ». L'appareil est reconnu par un identifiant gardé dans "
        + "le navigateur : vider les données du site ou changer de navigateur suffit à le contourner. Le plus solide est le blocage du "
        + "compte Google et de l'adresse e-mail (empêche de se réinscrire). Tu pourras lever le bannissement à tout moment."));
    const err = h("p", { class: "error", role: "alert" });
    const sync = () => { banOptions.hidden = !ban.checked; };
    del.addEventListener("change", sync);
    ban.addEventListener("change", sync);
    const confirm = h("button", { class: "btn danger", type: "submit" }, icon("trash"), "Confirmer");
    return h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      confirm.disabled = true;
      try {
        await api(`/api/admin/users/${encodeURIComponent(u.sub)}/remove`, { method: "POST", json: {
          mode: ban.checked ? "ban" : "delete", days: ban.checked && days.value ? Number(days.value) : (ban.checked ? null : 30),
          reason: reason.value.trim() } });
        close();
        toast(ban.checked ? "Compte supprimé et banni" : "Compte supprimé", "success");
        go("/admin", { replace: true });
      } catch (e2) { err.textContent = e2.message; confirm.disabled = false; }
    } },
      h("label", { class: "check-row" }, del, h("span", {}, h("strong", {}, "Supprimer le compte"), h("br"),
        h("small", { class: "muted" }, "Efface tout ce que Studoo garde sur ce compte (compte, tâches, compteurs, clé Gemini, notifications) "
          + "et ferme sa session. Il pourra revenir plus tard avec le même compte Google."))),
      h("label", { class: "check-row" }, ban, h("span", {}, h("strong", {}, "Bannir"), h("br"),
        h("small", { class: "muted" }, "Supprime le compte ET bloque son compte Google, son adresse e-mail, sa dernière adresse IP et son appareil. "
          + "Studoo ne garde que des empreintes chiffrées, jamais les valeurs."))),
      banOptions,
      h("div", { class: "field" }, h("label", { for: "rm-reason" }, "Motif (facultatif, gardé dans le journal)"), reason),
      h("p", { class: "small muted" }, icon("info"), " Dans tous les cas, les fichiers de son Google Drive ne sont jamais touchés."),
      err,
      h("div", { class: "row" }, confirm, h("button", { class: "btn ghost", type: "button", onclick: () => close() }, "Annuler")));
  });
}

function bansSection(bans, go) {
  return h("section", { class: "card sketch" }, bans.length ? h("ul", { class: "files" }, bans.map((b) => h("li", { style: { alignItems: "flex-start" } },
    h("span", { class: "kind c-pink" }, icon("lock")),
    h("span", {}, h("strong", {}, b.label), h("br"),
      h("span", { class: "small muted" }, b.items.map((i) => `${KIND_LABELS[i.kind] || i.kind} ${i.until ? `jusqu'au ${new Date(i.until).toLocaleDateString("fr-FR")}` : "(définitif)"}`).join(" · ")),
      b.reason ? h("p", { class: "small", style: { margin: "4px 0 0" } }, `Motif : ${b.reason}`) : null),
    h("span", { class: "meta" }, h("button", { class: "btn small", type: "button", onclick: async () => {
      if (!(await confirmDialog("Lever ce bannissement ?", `${b.label} pourra de nouveau se connecter (compte, e-mail, IP et appareil débloqués).`, { ok: "Lever" }))) return;
      try { await api(`/api/admin/bans/${b.id}/lift`, { method: "POST", json: { reason: "" } }); toast("Bannissement levé", "success"); go("/admin", { replace: true }); }
      catch (e) { errorToast(e); }
    } }, icon("refresh"), "Lever")))))
    : h("p", { class: "empty" }, "Aucun bannissement en cours."));
}

function logSection(log) {
  return h("section", { class: "card sketch table-wrap" }, log.length ? h("table", { class: "data" },
    h("thead", {}, h("tr", {}, ["Quand", "Qui", "Quoi", "Compte", "Détails", "Pourquoi"].map((t) => h("th", { scope: "col" }, t)))),
    h("tbody", {}, log.map((e) => h("tr", {}, h("td", { class: "small" }, relativeDate(e.at)), h("td", { class: "small" }, e.admin),
      h("td", {}, ACTION_LABELS[e.action] || e.action), h("td", {}, e.target), h("td", { class: "small" }, e.details), h("td", { class: "small" }, e.reason || "—")))))
    : h("p", { class: "empty" }, "Aucune action pour l'instant."));
}

// ---------- Services utilisés (itération 7, C5) ----------
const ext = { target: "_blank", rel: "noopener noreferrer" };

function serviceInfo(svc) {
  openDialog(svc.name, () => h("div", { class: "stack service-info" },
    h("p", {}, h("strong", {}, "À quoi ça sert : "), svc.role, "."),
    h("p", {}, h("strong", {}, "Comment ça marche dans Studoo : "), svc.how),
    h("p", {}, h("strong", {}, "Offre gratuite et limites : "), svc.free),
    h("p", {}, h("strong", {}, "Où sont la configuration et les clés : "), svc.config),
    h("div", {}, h("strong", {}, "Où trouver quoi :"),
      h("ul", {}, svc.where.map(([label, url]) => h("li", {}, h("a", { href: url, ...ext }, label), " ", icon("external-link"))))),
    h("p", { class: "notice warn" }, h("strong", {}, "En cas de panne : "), svc.outage)));
}

function howItWorks() {
  openDialog("Comment tout le site fonctionne", () => h("div", { class: "stack" },
    h("ol", { class: "flow" }, FLOW.map(([title, text], i) => h("li", { class: `flow-step c-${["yellow", "blue", "green", "lilac", "orange", "pink"][i % 6]}` },
      h("strong", {}, title), h("span", { class: "small" }, text)))),
    h("p", { class: "small muted" }, "Règles qui tiennent l'ensemble : aucune clé dans le navigateur, cours jamais stockés chez nous, ",
      "mots de passe des robots jamais enregistrés, tâches chiffrées puis effacées, IA sur Azure (Gemini seulement avec la clé d'un élève). ",
      "Détails : docs/SERVICES.md et docs/ARCHITECTURE.md dans le dépôt GitHub.")));
}

function servicesSection() {
  return h("section", { class: "services-grid" }, SERVICES.map((svc) => h("article", { class: "card sketch service" },
    h("div", { class: "row", style: { alignItems: "flex-start", flexWrap: "nowrap" } },
      h("span", { style: { flex: 1, minWidth: 0 } }, h("strong", {}, svc.name), h("br"), h("span", { class: "small muted" }, svc.role)),
      h("button", { class: "btn small icon-btn", type: "button", "aria-label": `Comment marche ${svc.name}`, title: "Comment ça marche", onclick: () => serviceInfo(svc) }, "i")),
    h("a", { class: "btn small", href: svc.url, ...ext }, icon("external-link"), "Tableau de bord"))));
}

async function renderAdmin(view, go) {
  const [ov, users, msgs, reports, bans, log] = await Promise.all([api("/api/admin/overview"), api("/api/admin/users"), api("/api/admin/messages"),
    api("/api/admin/school-reports").catch(() => ({ reports: [] })), api("/api/admin/bans").catch(() => ({ bans: [] })),
    api("/api/admin/log").catch(() => ({ log: [] }))]);
  const SOFT = { ade: "ADE", celcat: "Celcat", hyperplanning: "HyperPlanning", aurion: "Aurion", pronote: "Pronote", ent: "ENT", autre: "Autre", inconnu: "Inconnu" };
  const ERR = { not_recognized: "non reconnu", bad_credentials: "identifiants", two_factor: "double auth.", page_changed: "page changée",
    timeout: "délai", blocked: "bloqué", unavailable: "indisponible", ade_native_refused: "ADE refusé", other: "autre" };
  const q = ov.quota;
  mount(view,
    h("h1", { class: "view-title" }, h("span", { class: "hl pink" }, "Admin")),
    h("div", { class: "stats" },
      stat("Comptes", ov.users), stat("Actifs (7 j)", ov.activeUsers7d), stat("Messages non lus", ov.unreadMessages),
      ...Object.entries(LABELS).map(([k, l]) => stat(l, ov.generations[k] || 0))),
    h("h2", { class: "section" }, "Quotas IA du jour (Azure OpenAI)"),
    h("div", { class: "stats" }, ["lite", "flash"].map((t) => h("div", { class: "stat card sketch" },
      h("strong", {}, { lite: "Petites demandes (rangement, PDF)", flash: "Fiches" }[t]),
      h("div", { class: "bar", style: { margin: "8px 0" } }, h("span", { style: { width: `${Math.min(100, (100 * q[t].used) / Math.max(1, q[t].limit))}%` } })),
      h("span", { class: "small" }, `${q[t].used} / ${q[t].limit} requêtes`)))),
    h("h2", { class: "section" }, "Messages"),
    h("section", { class: "card sketch" }, msgs.messages.length ? h("ul", { class: "files" }, msgs.messages.map((m) => h("li", { style: { alignItems: "flex-start" } },
      h("span", { class: `kind ${m.handled ? "c-green" : "c-pink"}` }, icon("mail")),
      h("span", {}, h("strong", {}, m.subject), h("br"), h("span", { class: "small muted" }, `${m.email} · ${relativeDate(m.createdAt)}`), h("p", { class: "small", style: { whiteSpace: "pre-wrap", margin: "6px 0 0" } }, m.body)),
      m.handled ? h("span", { class: "meta" }, "traité") : h("span", { class: "meta" }, h("button", { class: "btn small", onclick: async () => { await api(`/api/admin/messages/${m.id}/handled`, { method: "POST" }); go("/admin", { replace: true }); } }, icon("check"), "Traité")))))
      : h("p", { class: "empty" }, "Aucun message.")),
    h("div", { class: "row", style: { alignItems: "baseline", marginTop: "28px" } },
      h("h2", { class: "section", style: { margin: 0 } }, "Services"),
      h("button", { class: "btn small", type: "button", onclick: howItWorks }, icon("info"), "Comment tout le site fonctionne")),
    h("p", { class: "small muted" }, "Tout ce qui fait tourner Studoo. « Tableau de bord » ouvre la console du service ; « i » explique où trouver les journaux, la facturation, les quotas, les clés et quoi faire en cas de panne."),
    servicesSection(),
    h("h2", { class: "section" }, "Établissements signalés"),
    h("p", { class: "small muted" }, "Envoyés après une erreur du robot ou un établissement non reconnu. Les plus demandés en premier : ce sont eux à prendre en charge."),
    h("section", { class: "card sketch table-wrap" }, reports.reports.length ? h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Établissement"), h("th", { scope: "col" }, "Logiciel"),
        h("th", { scope: "col" }, "Demandes"), h("th", { scope: "col" }, "Élèves"), h("th", { scope: "col" }, "Erreurs"), h("th", { scope: "col" }, "Dernière"))),
      h("tbody", {}, reports.reports.map((r) => h("tr", {}, h("td", {}, r.establishment), h("td", {}, SOFT[r.software] || r.software),
        h("td", {}, h("strong", {}, String(r.count))), h("td", {}, String(r.people)),
        h("td", { class: "small" }, Object.entries(r.errors).map(([k, n]) => `${ERR[k] || k} ×${n}`).join(", ")),
        h("td", { class: "small" }, r.last ? relativeDate(r.last) : "")))))
      : h("p", { class: "empty" }, "Aucun signalement pour l'instant.")),
    h("h2", { class: "section" }, "Comptes"),
    h("section", { class: "card sketch table-wrap" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Nom"), h("th", { scope: "col" }, "E-mail"), h("th", { scope: "col" }, "Inscription"), h("th", { scope: "col" }, "Dernière visite"), h("th", { scope: "col" }, h("span", { class: "sr-only" }, "Actions")))),
      h("tbody", {}, users.users.map((u) => h("tr", {}, h("td", {}, u.name), h("td", {}, u.email), h("td", {}, relativeDate(u.createdAt)), h("td", {}, relativeDate(u.lastSeenAt)),
        h("td", {}, h("button", { class: "btn small danger", "aria-label": `Supprimer ou bannir le compte ${u.email}`,
          onclick: () => removeDialog(u, go) }, icon("trash")))))))),
    h("h2", { class: "section" }, "Bannissements en cours"),
    bansSection(bans.bans, go),
    h("h2", { class: "section" }, "Journal des actions admin"),
    h("p", { class: "small muted" }, "Qui, quand, quoi et pourquoi. Gardé 12 mois."),
    logSection(log.log));
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

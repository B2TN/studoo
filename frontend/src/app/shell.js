// Coquille de l'application : barre du haut, menu, zone de contenu, navigation.
import { wakeLogos } from "../lib/logo-eyes.js";
import { handleChunkError, newerBuildOnline } from "../lib/stale.js";
import { api } from "../lib/api.js";
import { signOut } from "../lib/auth.js";
import { $, h, mount } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { createRouter } from "../lib/router.js";
import { setCacheScope } from "../lib/cache.js";
import { initStorage } from "../lib/storage.js";
import { errorToast, themeButtons, trackPage } from "../lib/ui.js";

// Chaque page est chargée seulement quand on y va (site plus rapide).
const ROUTES = [
  { path: "/", title: "Tableau de bord", nav: "/", load: () => import("./dashboard.js") },
  { path: "/cours", title: "Mes cours", nav: "/cours", load: () => import("./explorer.js") },
  { path: "/cours/:courseId", title: "Cours", nav: "/cours", load: () => import("./explorer.js") },
  { path: "/cours/:courseId/:chapterId", title: "Chapitre", nav: "/cours", load: () => import("./explorer.js") },
  { path: "/fichier/:id", title: "Fichier", nav: "/cours", load: () => import("./viewer.js") },
  { path: "/enregistrer", title: "Enregistrer un cours", nav: "/enregistrer", load: () => import("./record.js") },
  { path: "/numeriser", title: "Numériser", nav: "/numeriser", load: () => import("./scan.js") },
  { path: "/importer", title: "Importer un PDF", nav: "/cours", load: () => import("./importer.js") },
  { path: "/confirmer", title: "Ranger le document", nav: "/cours", load: () => import("./confirm.js") },
  { path: "/creer/:type", title: "Créer", nav: "/cours", load: () => import("./create.js") },
  { path: "/emploi-du-temps", title: "Emploi du temps", nav: "/emploi-du-temps", load: () => import("./timetable.js") },
  { path: "/generations", title: "Mes générations", nav: "/", load: () => import("./jobs-panel.js") },
  { path: "/reglages", title: "Réglages", nav: "/reglages", load: () => import("./settings.js") },
  { path: "/admin", title: "Admin", nav: "/admin", admin: true, load: () => import("./admin.js") },
  { path: "/analytics", title: "Analytics", nav: "/analytics", admin: true, load: () => import("./admin.js") },
];

const NAV = [
  ["/", "layout-dashboard", "Tableau de bord"],
  ["/cours", "folders", "Mes cours"],
  ["/emploi-du-temps", "calendar-week", "Emploi du temps"],
  ["/enregistrer", "microphone", "Enregistrer"],
  ["/numeriser", "camera", "Numériser"],
];
const TABS = [["/", "layout-dashboard", "Accueil"], ["/cours", "folders", "Cours"], ["/numeriser", "camera", "Scanner"], ["/emploi-du-temps", "calendar-week", "EDT"], ["/reglages", "user", "Moi"]];

export const ctx = { user: null, router: null };

function mascot(size = 46) {
  const img = h("img", { src: "/favicon.svg", alt: "", width: size, height: size, class: "doodle" });
  return img;
}

function navLink([href, ic, label], cls = "") {
  return h("a", { href, "data-link": "1", class: cls, dataset: { nav: href } }, icon(ic, { doodle: true }), h("span", {}, label));
}

export async function startShell(user) {
  ctx.user = user;
  setCacheScope(user.sub);
  // Le stockage se prépare pendant qu'on dessine l'interface (pas d'attente à l'écran).
  const storageReady = initStorage(user);

  const view = h("main", { class: "view", id: "contenu", tabindex: "-1" });
  const quotaBar = h("div", { class: "bar", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": "Quota d'IA restant aujourd'hui" }, h("span"));
  const quotaText = h("small", { class: "quota-text muted" });
  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();
  const avatar = h("a", { class: "avatar", href: "/reglages", "data-link": "1", "aria-label": `Compte de ${user.name || user.email}` },
    user.picture ? h("img", { src: user.picture, alt: "", referrerpolicy: "no-referrer" }) : initial);

  const searchInput = h("input", { class: "input", type: "search", placeholder: "Chercher un cours, une fiche…", "aria-label": "Rechercher dans mes fichiers" });
  const searchForm = h("form", { class: "search", role: "search", onsubmit: (e) => { e.preventDefault(); const t = searchInput.value.trim(); if (t) router.go(`/cours?q=${encodeURIComponent(t)}`); } },
    icon("search"), searchInput);

  const adminLinks = user.isAdmin ? [navLink(["/admin", "shield-lock", "Admin"]), navLink(["/analytics", "chart-bar", "Analytics"])] : [];

  const layout = h("div", { class: "layout" },
    h("header", { class: "topbar" },
      h("a", { class: "logo", href: "/", "data-link": "1", "aria-label": "Studoo, tableau de bord" }, mascot(), h("span", {}, "Studoo")),
      searchForm, h("span", { class: "spacer" }), ...themeButtons(), avatar),
    h("aside", { class: "sidebar" },
      h("nav", { class: "nav", "aria-label": "Navigation principale" }, NAV.map((n) => navLink(n))),
      h("div", { class: "bottom" },
        h("div", { class: "quota" }, "IA disponible aujourd'hui", quotaBar, quotaText),
        h("nav", { class: "nav", "aria-label": "Compte" },
          ...adminLinks,
          navLink(["/reglages", "settings", "Réglages"]),
          h("a", { href: "/", onclick: (e) => { e.preventDefault(); signOut(); } }, icon("logout", { doodle: true }), "Se déconnecter")))),
    view);

  const fab = h("a", { class: "fab", href: "/enregistrer", "data-link": "1", "aria-label": "Enregistrer un cours" }, icon("microphone"));
  const tabbar = h("nav", { class: "tabbar sketch", "aria-label": "Navigation mobile" }, TABS.map((t) => navLink(t)));

  mount($("#app"), layout, fab, tabbar);
  wakeLogos(layout); // les yeux du logo suivent la souris (PC seulement)

  let cleanup = null; // fonction fournie par une page pour s'arrêter proprement (micro, lecture…)
  const router = createRouter(ROUTES, async (found, { query, data }) => {
    if (typeof cleanup === "function") { try { cleanup(); } catch { /* ignoré */ } }
    cleanup = null;
    if (!found || (found.route.admin && !user.isAdmin)) {
      mount(view, h("div", { class: "empty" }, h("h1", { class: "view-title" }, "Page introuvable"),
        h("p", {}, "Cette page n'existe pas (ou plus)."), h("a", { class: "btn primary", href: "/", "data-link": "1" }, "Retour au tableau de bord")));
      return;
    }
    const { route, params } = found;
    document.title = `${route.title} · Studoo`;
    for (const a of document.querySelectorAll("[data-nav]")) {
      if (a.dataset.nav === route.nav) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    mount(view, skeletonPage());
    // Nouvelle version en ligne ? On charge la page en entier plutôt que des morceaux qui n'existent plus.
    if (await newerBuildOnline()) { location.assign(location.href); return; }
    try {
      const [mod] = await Promise.all([route.load(), storageReady]);
      cleanup = await mod.render({ view, params, query, data, route, user, go: router.go, refreshQuota });
      wakeLogos(view);
      // Entrée de page : fondu + léger glissement (désactivé si le système réduit les animations)
      view.classList.remove("page-in");
      void view.offsetWidth;
      view.classList.add("page-in");
    } catch (err) {
      if (handleChunkError(err)) { // ancienne version de la page : rechargement propre, pas d'erreur brute
        mount(view, h("div", { class: "loading" }, h("div", { class: "spinner" }), "Nouvelle version disponible, rechargement…"));
        return;
      }
      errorToast(err);
      mount(view, h("div", { class: "empty" }, h("p", {}, "Oups, cette page n'a pas pu se charger."),
        h("button", { class: "btn", onclick: () => router.run() }, icon("refresh"), "Réessayer")));
    }
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    trackPage(location.pathname);
  });
  ctx.router = router;

  async function refreshQuota() {
    try {
      const q = await api("/api/ai/quota");
      const pct = Math.round(100 * Math.min(q.lite.remaining / q.lite.limit, q.user.remaining / q.user.limit));
      quotaBar.firstChild.style.width = `${pct}%`;
      quotaBar.classList.toggle("warn", pct < 25);
      quotaBar.setAttribute("aria-valuenow", String(pct));
      quotaBar.title = `${pct} % restant`;
      // Chiffres réels (lus sur le serveur) : demandes en direct + générations, et remise à zéro.
      mount(quotaText, `${q.user.remaining}/${q.user.limit} demandes`, q.jobs ? ` · ${q.jobs.remaining}/${q.jobs.limit} générations` : "",
        h("br"), `Remise à zéro ${q.reset ? q.reset.replace("chaque jour ", "") : "à minuit"}. `,
        h("a", { href: "/rgpd#limites" }, "Détail"));
    } catch { /* pas grave */ }
  }
  // La jauge d'IA n'est pas urgente : on la charge après l'affichage de la page.
  setTimeout(refreshQuota, 1500);
  await router.run();
}

/** Squelette générique affiché pendant le chargement d'une page. */
export function skeletonPage() {
  return h("div", { class: "skeleton-page", "aria-busy": "true", "aria-label": "Chargement" },
    h("div", { class: "sk sk-title" }),
    h("div", { class: "sk sk-line" }),
    h("div", { class: "sk-grid" }, h("div", { class: "sk sk-card" }), h("div", { class: "sk sk-card" }), h("div", { class: "sk sk-card" })));
}

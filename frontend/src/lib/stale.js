// Nouvelle version du site pendant qu'un onglet est ouvert (itération 7, C2).
//
// Cause de l'erreur « Failed to fetch dynamically imported module » : à chaque déploiement, les fichiers
// JavaScript changent de nom (empreinte dans le nom, ex. admin-M9QLww8X.js). Un onglet resté sur l'ancienne
// version demande un fichier qui n'existe plus → 404 → la page ne se charge pas.
// Trois protections :
// 1. avant chaque changement de page, on regarde (au plus une fois par minute) si une nouvelle version est en
//    ligne (/version.json) : si oui, on charge la page normalement (rechargement complet) au lieu de la charger
//    morceau par morceau ;
// 2. si un module ne se charge quand même pas : message « Nouvelle version disponible, rechargement… » puis
//    UN rechargement propre (jamais de boucle : au plus un par minute, mémorisé pour l'onglet) ;
// 3. si le rechargement ne suffit pas : message clair avec un bouton, jamais l'erreur brute.

/* global __BUILD_ID__ */
const BUILD = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
const RELOAD_KEY = "studoo-reload-at";
const CHECK_EVERY = 60_000;
let lastCheck = 0;

/** L'erreur vient-elle d'un fichier JavaScript/CSS introuvable (ancienne version) ? */
export function isStaleChunkError(err) {
  const text = String(err?.message || err || "");
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading chunk .* failed|ChunkLoadError/i
    .test(text);
}

function banner(text) {
  let el = document.getElementById("stale-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "stale-banner";
    el.className = "stale-banner";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = text;
  return el;
}

/** Recharge la page UNE fois (au plus une fois par minute). Renvoie false si on vient déjà de recharger. */
export function reloadOnce(now = Date.now()) {
  let last = 0;
  try { last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0; } catch { return false; } // pas de mémoire : pas de risque de boucle
  if (now - last < CHECK_EVERY) return false;
  try { sessionStorage.setItem(RELOAD_KEY, String(now)); } catch { return false; }
  banner("Nouvelle version de Studoo disponible, rechargement…");
  setTimeout(() => location.reload(), 700);
  return true;
}

/** Échec définitif (le rechargement n'a pas suffi) : un message et un bouton, pas une erreur brute. */
export function staleFailure() {
  const el = banner("Studoo vient d'être mis à jour et cette page n'a pas pu se charger. ");
  const btn = document.createElement("button");
  btn.className = "btn small";
  btn.type = "button";
  btn.textContent = "Recharger";
  btn.onclick = () => location.reload();
  el.append(btn);
}

/** À appeler quand un import() échoue : true si l'erreur est traitée (rechargement ou message). */
export function handleChunkError(err) {
  if (!isStaleChunkError(err)) return false;
  if (!reloadOnce()) staleFailure();
  return true;
}

/** Une version plus récente est-elle en ligne ? (au plus une requête par minute ; jamais d'erreur levée) */
export async function newerBuildOnline(now = Date.now()) {
  if (BUILD === "dev" || now - lastCheck < CHECK_EVERY) return false;
  lastCheck = now;
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return false;
    const { build } = await res.json();
    return Boolean(build) && build !== BUILD;
  } catch {
    return false;
  }
}

/** Écouteurs globaux : préchargements de Vite et import() non rattrapés ailleurs. */
export function installStaleGuard() {
  addEventListener("vite:preloadError", (event) => {
    event.preventDefault?.();
    handleChunkError(event.payload || new Error("Unable to preload CSS"));
  });
  addEventListener("unhandledrejection", (event) => {
    if (handleChunkError(event.reason)) event.preventDefault();
  });
}

export const currentBuild = () => BUILD;

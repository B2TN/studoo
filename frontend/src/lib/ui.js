// Éléments d'interface partagés : thème, police lisible, toasts, dialogues,
// bannière cookies et mesure d'audience (avec consentement).
import { api } from "./api.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";

// ---------- Stockage local protégé (peut être bloqué en navigation privée) ----------
export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignoré */ }
  },
};

// ---------- Thème clair / sombre et police lisible ----------
export function applyPreferences() {
  const theme = store.get("studoo-theme");
  if (theme) document.documentElement.dataset.theme = theme;
  if (store.get("studoo-font") === "lisible") document.documentElement.dataset.font = "lisible";
}

export function isDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function toggleTheme() {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("studoo-theme", next);
  return next;
}

export function toggleFont() {
  const on = document.documentElement.dataset.font !== "lisible";
  if (on) document.documentElement.dataset.font = "lisible";
  else delete document.documentElement.dataset.font;
  store.set("studoo-font", on ? "lisible" : "");
  return on;
}

export function themeButtons() {
  const themeBtn = h("button", { class: "btn icon-btn", type: "button" });
  const paintTheme = () => {
    themeBtn.replaceChildren(icon(isDark() ? "sun" : "moon"));
    themeBtn.setAttribute("aria-label", isDark() ? "Passer en mode clair" : "Passer en mode sombre");
    themeBtn.title = themeBtn.getAttribute("aria-label");
  };
  themeBtn.addEventListener("click", () => { toggleTheme(); paintTheme(); });
  paintTheme();
  const fontBtn = h("button", {
    class: "btn icon-btn", type: "button", title: "Police plus lisible",
    "aria-label": "Police plus lisible", "aria-pressed": String(document.documentElement.dataset.font === "lisible"),
  }, icon("text-size"));
  fontBtn.addEventListener("click", () => fontBtn.setAttribute("aria-pressed", String(toggleFont())));
  return [fontBtn, themeBtn];
}

// ---------- Toasts ----------
let toastBox;
export function toast(message, type = "info", ms = 4500) {
  toastBox ||= document.body.appendChild(h("div", { class: "toasts", role: "status", "aria-live": "polite" }));
  const el = h("div", { class: `toast ${type}` },
    icon(type === "error" ? "alert-triangle" : type === "success" ? "check" : "bulb"), h("span", {}, message));
  toastBox.append(el);
  setTimeout(() => el.remove(), ms);
}

export function errorToast(err) {
  console.error(err);
  toast(err?.message || "Une erreur est survenue.", "error", 7000);
}

// ---------- Dialogue (fenêtre) ----------
/** Ouvre une fenêtre modale. `build(close)` renvoie son contenu. */
export function openDialog(title, build, { onClose } = {}) {
  const dlg = h("dialog", { class: "sheet", "aria-labelledby": "dlg-title" });
  const close = (value) => { dlg.close(); dlg.remove(); onClose?.(value); };
  const card = h("div", { class: "card sketch" },
    h("div", { class: "row" },
      h("h2", { id: "dlg-title" }, title), h("span", { class: "spacer" }),
      h("button", { class: "btn icon-btn ghost", type: "button", "aria-label": "Fermer", onclick: () => close(null) }, icon("x"))),
    build(close));
  dlg.append(card);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(null); });
  document.body.append(dlg);
  dlg.showModal();
  return close;
}

export function confirmDialog(title, message, { ok = "Confirmer", danger = false } = {}) {
  return new Promise((resolve) => {
    openDialog(title, (close) => h("div", { class: "stack" },
      h("p", {}, message),
      h("div", { class: "row", style: { justifyContent: "flex-end" } },
        h("button", { class: "btn", type: "button", onclick: () => close(false) }, "Annuler"),
        h("button", { class: `btn ${danger ? "danger" : "primary"}`, type: "button", onclick: () => close(true) }, ok))),
    { onClose: (v) => resolve(Boolean(v)) });
  });
}

// ---------- Cookies et mesure d'audience ----------
// Studoo n'utilise AUCUN cookie publicitaire. Le seul choix proposé concerne
// les statistiques de visite anonymes (sans cookie, sans IP stockée).
const CONSENT_KEY = "studoo-consent";
export const consent = () => store.get(CONSENT_KEY);

export function cookieBanner() {
  if (consent()) return;
  const choose = (value) => { store.set(CONSENT_KEY, { stats: value, date: new Date().toISOString() }); banner.remove(); if (value) trackPage(); };
  const banner = h("section", { class: "consent card sketch", role: "region", "aria-label": "Cookies et statistiques" },
    h("p", {}, h("strong", {}, "Ta vie privée d'abord. "),
      "Studoo n'utilise qu'un cookie indispensable (ta connexion). On aimerait aussi compter les visites de façon anonyme (sans cookie, sans pub). ",
      h("a", { href: "/rgpd" }, "En savoir plus")),
    h("div", { class: "row" },
      h("button", { class: "btn", type: "button", onclick: () => choose(false) }, "Refuser"),
      h("button", { class: "btn primary", type: "button", onclick: () => choose(true) }, "Accepter")));
  document.body.append(banner);
}

export function trackPage(path = location.pathname) {
  if (!consent()?.stats) return;
  const data = JSON.stringify({ path });
  const blob = new Blob([data], { type: "application/json" });
  // sendBeacon ne permet pas d'ajouter l'en-tête anti-CSRF : on utilise fetch keepalive.
  fetch("/api/events", { method: "POST", body: blob, keepalive: true, headers: { "X-Studoo": "1", "Content-Type": "application/json" } }).catch(() => {});
}

export function wobbleFilter() {
  if (document.getElementById("wobble")) return;
  const tpl = document.createElement("template");
  tpl.innerHTML = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="wobble"><feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="4"/><feDisplacementMap in="SourceGraphic" scale="2.2"/></filter></svg>';
  document.body.prepend(tpl.content.firstChild);
}

export { api };

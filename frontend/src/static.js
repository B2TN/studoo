// Script des pages statiques (RGPD, CGU, contact, 404).
import "./styles/fonts.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles/base.css";
import "./styles/landing.css";

import { api } from "./lib/api.js";
import { $, h } from "./lib/dom.js";
import { wakeLogos } from "./lib/logo-eyes.js";
import { applyPreferences, cookieBanner, themeButtons, toast, trackPage, wobbleFilter } from "./lib/ui.js";

applyPreferences();
wobbleFilter();
wakeLogos(); // les yeux du logo suivent la souris (PC seulement)
$(".theme-slot")?.replaceChildren(...themeButtons());
cookieBanner();
trackPage(document.body.dataset.page === "404" ? "/404" : location.pathname);

// ---------- Formulaire de contact ----------
const form = $("#contact-form");
if (form) {
  const openedAt = Date.now();
  const fields = ["email", "subject", "message"];
  const rules = {
    email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? "" : "Indique une adresse e-mail valide."),
    subject: (v) => (v.trim().length >= 3 ? "" : "Le sujet doit faire au moins 3 caractères."),
    message: (v) => (v.trim().length >= 10 ? "" : "Ton message doit faire au moins 10 caractères."),
  };
  const showError = (name, msg) => {
    const input = form.elements[name];
    const err = $(`#err-${name}`);
    err.textContent = msg;
    if (msg) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };
  for (const name of fields) form.elements[name].addEventListener("input", (e) => showError(name, rules[name](e.target.value) && e.target.getAttribute("aria-invalid") ? rules[name](e.target.value) : ""));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let first = null;
    for (const name of fields) {
      const msg = rules[name](form.elements[name].value);
      showError(name, msg);
      if (msg && !first) first = form.elements[name];
    }
    if (first) { first.focus(); return; }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api("/api/contact", { method: "POST", json: {
        email: form.elements.email.value.trim(), subject: form.elements.subject.value.trim(), message: form.elements.message.value.trim(),
        website: form.elements.website.value, elapsed_ms: Date.now() - openedAt,
      } });
      form.replaceWith(h("div", { class: "card sketch", role: "status" }, h("h2", {}, "Message envoyé !"), h("p", {}, "Merci, je te réponds dès que possible.")));
    } catch (err) {
      const fieldErr = err.errors?.[0];
      if (fieldErr && fields.includes(fieldErr.field)) showError(fieldErr.field, fieldErr.message);
      toast(err.message, "error");
      btn.disabled = false;
    }
  });
}

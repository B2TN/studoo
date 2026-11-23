// Point d'entrée de la page principale.
// Visiteur → page d'accueil. Connecté → le tableau de bord remplace l'accueil.
import "@fontsource/patrick-hand/400.css";
import "@fontsource/gochi-hand/400.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles/base.css";
import "./styles/landing.css";
import "./styles/app.css";
import "./styles/fiche.css";

import { restore, signIn } from "./lib/auth.js";
import { $, $$ } from "./lib/dom.js";
import { applyPreferences, cookieBanner, errorToast, themeButtons, trackPage, wobbleFilter } from "./lib/ui.js";

applyPreferences();

async function startApp(user) {
  document.documentElement.classList.add("is-app");
  $("#landing")?.remove(); // la page d'accueil n'existe plus une fois connecté
  const { startShell } = await import("./app/shell.js");
  await startShell(user);
}

function showLanding() {
  document.documentElement.classList.remove("is-app");
  if (location.pathname !== "/") history.replaceState(null, "", "/");
  $(".theme-slot")?.replaceChildren(...themeButtons());
  for (const btn of $$(".google-cta")) {
    btn.addEventListener("click", async () => {
      btn.setAttribute("aria-busy", "true");
      try {
        const user = await signIn();
        await startApp(user);
      } catch (err) {
        errorToast(err);
      } finally {
        btn.removeAttribute("aria-busy");
      }
    });
  }
  trackPage("/");
}

async function boot() {
  wobbleFilter();
  cookieBanner();
  const user = await restore();
  if (user) await startApp(user);
  else showLanding();
}

boot().catch(errorToast);

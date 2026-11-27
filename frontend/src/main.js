// Point d'entrée de la page principale.
// Visiteur → page d'accueil. Connecté → le tableau de bord remplace l'accueil.
import "./styles/fonts.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles/base.css";
import "./styles/landing.css";
import "./styles/app.css";
import "./styles/fiche.css";

import { cachedUser, isLoggedFlag, restore, signIn } from "./lib/auth.js";
import { $, $$ } from "./lib/dom.js";
import { wakeLogos } from "./lib/logo-eyes.js";
import { handleChunkError, installStaleGuard } from "./lib/stale.js";
import { applyPreferences, cookieBanner, errorToast, themeButtons, trackPage, wobbleFilter } from "./lib/ui.js";

applyPreferences();
installStaleGuard(); // nouvelle version du site pendant que l'onglet est ouvert : rechargement propre

// Le code de l'application est téléchargé dès que possible, en parallèle.
const shellModule = isLoggedFlag() ? import("./app/shell.js") : null;

async function startApp(user) {
  document.documentElement.classList.add("is-app");
  $("#landing")?.remove(); // la page d'accueil n'existe plus une fois connecté
  let startShell;
  try {
    ({ startShell } = await (shellModule || import("./app/shell.js")));
  } catch (err) {
    if (handleChunkError(err)) return;
    throw err;
  }
  await startShell(user);
}

function showLanding() {
  document.documentElement.classList.remove("is-app");
  wakeLogos(); // les yeux du logo suivent la souris (PC seulement)
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
  performance.mark("studoo:demarrage");
  // Visiteur jamais connecté : aucune requête au serveur, la page d'accueil est déjà là.
  if (!isLoggedFlag()) { showLanding(); return; }

  // Connecté sur cet appareil : on affiche l'appli tout de suite avec le dernier
  // profil connu, et on vérifie la session en arrière-plan.
  const known = cachedUser();
  const check = restore();
  if (known) {
    check.then((user) => {
      if (!user) location.replace("/"); // session expirée : retour à l'accueil
    });
    await startApp(known);
    return;
  }
  const user = await check;
  if (user) await startApp(user);
  else showLanding();
}

boot().catch(errorToast);

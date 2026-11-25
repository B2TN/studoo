// Réglages : compte, voix des podcasts, confidentialité, suppression du compte.
import { api } from "../lib/api.js";
import { deleteAccount, signOut } from "../lib/auth.js";
import { h, mount } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { enablePush, disablePush, needsHomeScreen, pushStatus } from "../lib/jobs.js";
import { drive, getSettings } from "../lib/storage.js";
import { confirmDialog, consent, errorToast, store, themeButtons, toast } from "../lib/ui.js";

/** Notifications de fin de génération (PWA) ; sinon e-mail de secours. */
function notifySection() {
  const state = h("p", { class: "small" }, "…");
  const btn = h("button", { class: "btn", type: "button" });
  const paint = async () => {
    const st = await pushStatus().catch(() => "unsupported");
    const labels = {
      on: "Activées sur cet appareil.", off: "Désactivées sur cet appareil : tu recevras un e-mail à la place.",
      denied: "Bloquées par le navigateur : tu recevras un e-mail à la place.", unsupported: "Non disponibles dans ce navigateur : tu recevras un e-mail à la place.",
    };
    state.textContent = labels[st];
    btn.hidden = st === "unsupported" || st === "denied";
    btn.replaceChildren(st === "on" ? "Désactiver" : "Activer les notifications");
    btn.onclick = async () => {
      try { await (st === "on" ? disablePush() : enablePush()); } catch (e) { toast(e.message, "info", 9000); }
      paint();
    };
  };
  paint();
  return h("section", { class: "card sketch stack", style: { marginTop: "22px" } },
    h("h2", {}, "Être prévenu quand c'est prêt"),
    h("p", { class: "small muted" }, "Podcasts, vidéos et lectures de copies sont fabriqués sur le serveur : tu peux fermer la page, Studoo te prévient à la fin."),
    state, h("div", {}, btn),
    needsHomeScreen() ? h("p", { class: "small muted" }, "Sur iPhone et iPad : ajoute d'abord Studoo à l'écran d'accueil (Partager → « Sur l'écran d'accueil »), puis ouvre-le depuis l'icône.") : null);
}

/**
 * Clé Gemini personnelle (facultative) : sert seulement de SECOURS pour les podcasts et vidéos,
 * quand l'IA ou les voix de Studoo sont indisponibles ou épuisées.
 */
function geminiKeySection(user) {
  const box = h("div", { class: "stack" });
  const paint = (st) => {
    if (st.set) {
      mount(box,
        h("p", {}, icon("check"), " Clé enregistrée (se termine par « ", h("strong", { class: "mono" }, st.hint), " »)."),
        h("div", {}, h("button", { class: "btn small danger", type: "button", onclick: async () => {
          try { paint(await api("/api/me/gemini-key", { method: "DELETE" })); toast("Clé supprimée", "success"); } catch (e) { errorToast(e); }
        } }, icon("trash"), "Supprimer ma clé")));
      return;
    }
    const input = h("input", { class: "input", id: "gemini-key", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "AIza…" });
    const save = h("button", { class: "btn primary", type: "submit" }, icon("key"), "Enregistrer");
    mount(box, h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      save.disabled = true;
      try { paint(await api("/api/me/gemini-key", { method: "PUT", json: { key: input.value.trim() } })); toast("Clé vérifiée et enregistrée", "success"); }
      catch (err) { errorToast(err); save.disabled = false; }
    } },
      h("div", { class: "field" }, h("label", { for: "gemini-key" }, "Ta clé Gemini"), input),
      h("div", {}, save)));
  };
  if (user.dev) mount(box, h("p", { class: "small muted" }, "Indisponible en mode démo."));
  else api("/api/me/gemini-key").then(paint).catch(() => mount(box, h("p", { class: "small muted" }, "Impossible de vérifier ta clé pour l'instant.")));
  return h("section", { class: "card sketch stack", style: { marginTop: "22px" } },
    h("h2", {}, "Clé Gemini de secours (facultatif)"),
    h("p", { class: "small" }, "Studoo écrit et lit tes podcasts et vidéos avec ses propres services gratuits. S'ils sont saturés ou épuisés, ",
      "il peut utiliser ", h("strong", {}, "ta"), " clé Gemini à la place : tes générations ne s'arrêtent pas."),
    h("details", { class: "small" }, h("summary", {}, "Comment obtenir une clé gratuite (1 minute, sans carte) ?"),
      h("ol", {},
        h("li", {}, "Va sur ", h("a", { href: "https://aistudio.google.com/apikey", target: "_blank", rel: "noopener" }, "aistudio.google.com/apikey"), " avec ton compte Google."),
        h("li", {}, "Clique sur « Create API key » (Créer une clé), puis copie-la."),
        h("li", {}, "Colle-la ci-dessous : Studoo la vérifie auprès de Google puis la garde chiffrée."))),
    h("p", { class: "small muted" }, "Elle n'est utilisée qu'en secours, ne t'est jamais réaffichée et est effacée si tu supprimes ton compte. ",
      "Avec l'offre gratuite de Google, les textes envoyés peuvent servir à améliorer ses services."),
    box);
}

export async function render({ view, user, go }) {
  const settings = await getSettings();
  const stats = consent()?.stats;
  const root = await drive.init();

  mount(view,
    h("h1", { class: "view-title" }, "Réglages"),
    h("section", { class: "card sketch stack" },
      h("h2", {}, "Mon compte"),
      h("p", {}, h("strong", {}, user.name || "Sans nom"), h("br"), h("span", { class: "muted" }, user.email)),
      h("p", { class: "small" }, "Tes cours sont rangés dans le dossier « Studoo » de ton Google Drive. ",
        drive.kind === "google" ? h("a", { href: `https://drive.google.com/drive/folders/${root}`, target: "_blank", rel: "noopener" }, "Ouvrir dans Google Drive") : "(mode démo : rien n'est enregistré)"),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: () => signOut() }, icon("logout"), "Se déconnecter"))),

    h("section", { class: "card sketch stack", style: { marginTop: "22px" } },
      h("h2", {}, "Affichage"),
      h("div", { class: "row" }, ...themeButtons(), h("span", { class: "small muted" }, "Mode sombre · police plus lisible (Atkinson Hyperlegible)"))),

    notifySection(),
    geminiKeySection(user),

    h("section", { class: "card sketch stack", style: { marginTop: "22px" } },
      h("h2", {}, "Confidentialité"),
      h("p", {}, "Engagement d'enregistrement : ", settings.recordingConsent ? `accepté le ${new Date(settings.recordingConsent).toLocaleDateString("fr-FR")}` : "pas encore accepté"),
      h("p", {}, "Statistiques de visite anonymes : ", stats ? "acceptées" : "refusées", " ",
        h("button", { class: "btn small", onclick: () => { store.set("studoo-consent", { stats: !stats, date: new Date().toISOString() }); go("/reglages", { replace: true }); } }, stats ? "Refuser" : "Accepter")),
      h("p", { class: "small" }, h("a", { href: "/rgpd" }, "Lire la politique de confidentialité"))),

    h("section", { class: "card sketch stack", style: { marginTop: "22px", borderColor: "var(--danger)" } },
      h("h2", {}, "Supprimer mon compte"),
      h("p", { class: "small" }, "Studoo efface ton compte (e-mail, dates) et retire son accès à ton Google Drive. Tes fichiers restent dans ton Drive : ils t'appartiennent."),
      h("div", {}, h("button", { class: "btn danger", onclick: async () => {
        if (!(await confirmDialog("Supprimer ton compte Studoo ?", "Cette action est définitive. Tes fichiers resteront dans ton Google Drive.", { ok: "Supprimer mon compte", danger: true }))) return;
        try { await deleteAccount(); location.href = "/"; } catch (err) { errorToast(err); }
      } }, icon("trash"), "Supprimer mon compte"))));
}

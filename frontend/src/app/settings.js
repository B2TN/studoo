// Réglages : compte, voix des podcasts, confidentialité, suppression du compte.
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

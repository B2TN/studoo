// Réglages : compte, voix des podcasts, confidentialité, suppression du compte.
import { deleteAccount, signOut } from "../lib/auth.js";
import { h, mount } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { drive, getSettings, saveSettings } from "../lib/storage.js";
import { confirmDialog, consent, errorToast, store, themeButtons, toast } from "../lib/ui.js";

const VOICES = [["Kore", "Kore (posée)"], ["Puck", "Puck (enjouée)"], ["Aoede", "Aoede (douce)"], ["Charon", "Charon (grave)"], ["Leda", "Leda (jeune)"], ["Orus", "Orus (assurée)"], ["Zephyr", "Zephyr (claire)"], ["Fenrir", "Fenrir (énergique)"]];

export async function render({ view, user, go }) {
  const settings = await getSettings();
  const voiceSelect = (key, id) => h("select", { class: "input", id, onchange: async (e) => {
    await saveSettings({ voices: { ...settings.voices, [key]: e.target.value } }).catch(errorToast);
    toast("Voix enregistrée", "success");
  } }, VOICES.map(([v, label]) => h("option", { value: v, selected: settings.voices?.[key] === v }, label)));
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

    h("section", { class: "card sketch stack", style: { marginTop: "22px" } },
      h("h2", {}, "Voix des podcasts et vidéos"),
      h("div", { class: "field" }, h("label", { for: "voice-a" }, "Voix A (et narration des vidéos)"), voiceSelect("A", "voice-a")),
      h("div", { class: "field" }, h("label", { for: "voice-b" }, "Voix B"), voiceSelect("B", "voice-b"))),

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

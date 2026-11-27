// Réglages : compte, affichage, notifications, Gemini (clé personnelle facultative), confidentialité, suppression du compte.
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

/** Ce qui part chez Google, fonctionnalité par fonctionnalité, si l'élève coche Gemini. */
export const GEMINI_DATA = {
  transcription: "le son de tes enregistrements de cours",
  classement: "un extrait du document et les noms de tes cours et chapitres",
  fiche: "le texte des cours que tu choisis",
  exercices: "le texte des cours choisis et, pour une correction, les photos de ta copie",
  photos: "les photos et pages scannées à lire",
  podcast: "le texte des cours choisis (et le script à lire, si les voix de Studoo sont indisponibles)",
  video: "le texte des cours choisis (et le texte à lire, si les voix de Studoo sont indisponibles)",
};

/**
 * Gemini, option personnelle (itération 6) : par défaut, Studoo n'envoie RIEN à Google. L'élève peut enregistrer
 * SA clé Gemini, puis cocher les fonctionnalités où il la préfère aux outils de Studoo (tout est décoché au départ).
 * La clé est vérifiée, chiffrée sur le serveur, jamais réaffichée, et supprimable en un clic.
 */
/** Quota d'IA restant aujourd'hui (itération 7, C4) : chiffres lus sur le serveur. */
function quotaSection() {
  const box = h("div", { class: "stack" }, h("p", { class: "small muted" }, "…"));
  api("/api/ai/quota").then((q) => {
    const line = (label, x) => h("div", {}, h("div", { class: "row", style: { justifyContent: "space-between" } }, h("span", {}, label),
      h("strong", {}, `${x.remaining} / ${x.limit} restant${x.remaining > 1 ? "s" : ""}`)),
    h("div", { class: "bar", role: "meter", "aria-valuemin": "0", "aria-valuemax": String(x.limit), "aria-valuenow": String(x.remaining),
      "aria-label": label }, h("span", { style: { width: `${Math.round(100 * x.remaining / Math.max(1, x.limit))}%` } })));
    mount(box, line("Demandes d'IA (transcription, rangement, fiches, PDF)", q.user),
      q.jobs ? line("Générations (podcasts, vidéos, exercices, corrections)", q.jobs) : null,
      h("p", { class: "small muted" }, `Remise à zéro ${q.reset || "chaque jour à minuit (heure de Paris)"}. `,
        h("a", { href: "/rgpd#limites" }, "Toutes les limites")));
  }).catch(() => mount(box, h("p", { class: "small muted" }, "Quota momentanément indisponible.")));
  return h("section", { class: "card sketch stack", style: { marginTop: "22px" } }, h("h2", {}, "Ton utilisation de l'IA aujourd'hui"), box);
}

function geminiKeySection() {
  const box = h("div", { class: "stack" });
  const prefsBox = (st) => {
    const boxes = Object.entries(st.features).map(([f, label]) => {
      const input = h("input", { type: "checkbox", checked: Boolean(st.prefs[f]), onchange: async () => {
        const prefs = { ...st.prefs, [f]: input.checked };
        try { st = await api("/api/me/gemini-key/prefs", { method: "PUT", json: { prefs } }); toast(input.checked ? `Gemini utilisé pour : ${label.toLowerCase()}` : "Retour aux outils de Studoo", "success"); }
        catch (e) { input.checked = !input.checked; errorToast(e); }
      } });
      return h("label", { class: "check-row" }, input, h("span", {}, h("strong", {}, label), h("br"),
        h("small", { class: "muted" }, "Envoyé à Google : ", GEMINI_DATA[f] || "les données de cette fonctionnalité", ".")));
    });
    return h("fieldset", { class: "stack gemini-prefs" }, h("legend", {}, "Utiliser ma clé Gemini pour…"), ...boxes,
      h("div", {}, h("button", { class: "btn small", type: "button", onclick: async () => {
        try { paint(await api("/api/me/gemini-key/prefs", { method: "PUT", json: { prefs: {} } })); toast("Tout repasse sur les outils de Studoo", "success"); } catch (e) { errorToast(e); }
      } }, icon("refresh"), "Tout repasser sur Studoo")));
  };
  const paint = (st) => {
    if (st.set) {
      mount(box,
        h("p", {}, icon("check"), " Clé enregistrée (se termine par « ", h("strong", { class: "mono" }, st.hint), " »). ",
          Object.values(st.prefs).some(Boolean) ? "" : h("span", { class: "muted" }, "Rien n'est coché : elle ne sert à rien pour l'instant.")),
        prefsBox(st),
        h("div", {}, h("button", { class: "btn small danger", type: "button", onclick: async () => {
          try { paint(await api("/api/me/gemini-key", { method: "DELETE" })); toast("Clé supprimée : tout repasse sur Studoo", "success"); } catch (e) { errorToast(e); }
        } }, icon("trash"), "Supprimer ma clé")));
      return;
    }
    const input = h("input", { class: "input", id: "gemini-key", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "AIza…" });
    const save = h("button", { class: "btn primary", type: "submit" }, icon("key"), "Vérifier et enregistrer");
    mount(box, h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      save.disabled = true;
      try { paint(await api("/api/me/gemini-key", { method: "PUT", json: { key: input.value.trim() } })); input.value = ""; toast("Clé vérifiée et enregistrée. Choisis maintenant où l'utiliser.", "success"); }
      catch (err) { errorToast(err); save.disabled = false; }
    } },
      h("div", { class: "field" }, h("label", { for: "gemini-key" }, "Ta clé Gemini"), input),
      h("div", {}, save)));
  };
  api("/api/me/gemini-key").then(paint).catch(() => mount(box, h("p", { class: "small muted" }, "Impossible de vérifier ta clé pour l'instant.")));
  return h("section", { class: "card sketch stack", style: { marginTop: "22px" } },
    h("h2", {}, "Gemini avec ta propre clé (facultatif)"),
    h("p", { class: "small" }, "Par défaut, Studoo fait tout avec ses propres outils, hébergés chez Microsoft Azure (données stockées en Europe) : ",
      h("strong", {}, "rien n'est envoyé à Google"), ". Si tu préfères Gemini pour certaines fonctionnalités, tu peux ajouter ta clé, puis choisir lesquelles."),
    h("details", { class: "small" }, h("summary", {}, "Ce qui part chez Google si tu l'utilises"),
      h("p", {}, "Seulement pour les fonctionnalités que tu coches, Studoo envoie à l'API Gemini de Google, avec ta clé :"),
      h("ul", {}, Object.entries(GEMINI_DATA).map(([, d]) => h("li", {}, d))),
      h("p", {}, "Google traite alors ces données selon ses propres conditions. Avec l'offre gratuite de Gemini, Google indique qu'elles peuvent servir à améliorer ses services ",
        "et être relues par des personnes : n'envoie pas d'informations sensibles. Ton nom, ton e-mail et tes identifiants ne sont jamais transmis.")),
    h("details", { class: "small" }, h("summary", {}, "Comment obtenir une clé gratuite (1 minute, sans carte) ?"),
      h("ol", {},
        h("li", {}, "Va sur ", h("a", { href: "https://aistudio.google.com/apikey", target: "_blank", rel: "noopener" }, "aistudio.google.com/apikey"), " avec ton compte Google."),
        h("li", {}, "Clique sur « Create API key » (Créer une clé), puis copie-la."),
        h("li", {}, "Colle-la ci-dessous : Studoo la vérifie auprès de Google puis la garde chiffrée."))),
    h("p", { class: "small muted" }, "Ta clé est gardée chiffrée sur le serveur de Studoo et n'est utilisée que par lui, pour tes propres demandes : ",
      "elle n'est jamais renvoyée à ton navigateur, jamais réaffichée, jamais écrite dans un journal. Supprime-la en un clic quand tu veux ; elle est aussi effacée avec ton compte."),
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
    quotaSection(),
    geminiKeySection(),

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

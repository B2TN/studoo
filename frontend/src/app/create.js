// Création d'une fiche, d'un podcast ou d'une vidéo à partir des cours choisis.
import { api } from "../lib/api.js";
import { createJob, enablePush, needsHomeScreen, pushStatus } from "../lib/jobs.js";
import { h, mount } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { drive, gatherSources, KINDS, kindOf, safeName, SOURCE_KINDS } from "../lib/storage.js";
import { errorToast, toast } from "../lib/ui.js";

const TYPES = {
  fiche: { title: "Créer une fiche", noun: "fiche", color: "green", icon: "notes" },
  podcast: { title: "Faire un podcast", noun: "podcast", color: "blue", icon: "headphones" },
  video: { title: "Faire une vidéo", noun: "vidéo", color: "orange", icon: "movie" },
};
const PODCAST = [[10, "Court", "10 minutes"], [20, "Moyen", "20 minutes"], [30, "Long", "30 minutes"]];
const VIDEO = [["short", "Court", "≈ 2 min · format TikTok (vertical)"], ["medium", "Moyen", "≈ 10 min · format YouTube"], ["long", "Long", "≈ 30 min · révision complète"]];

function progressList(steps) {
  const items = steps.map((s) => h("li", { class: "todo" }, icon("chevron-right"), s));
  const el = h("ol", { class: "progress-list", "aria-live": "polite" }, items);
  return {
    el,
    step(i, text) {
      items.forEach((li, j) => {
        li.className = j < i ? "done" : j === i ? "" : "todo";
        li.firstChild.replaceWith(icon(j < i ? "check" : "chevron-right"));
      });
      if (text) items[i].lastChild.textContent = text;
    },
    done() { this.step(items.length); },
  };
}

function choiceGroup(name, options, checked) {
  return h("div", { class: "choices", role: "radiogroup" }, options.map(([value, title, sub]) => {
    const id = `${name}-${value}`;
    return h("div", { class: "choice" },
      h("input", { type: "radio", name, id, value: String(value), checked: String(value) === String(checked) }),
      h("label", { for: id }, h("strong", {}, title), h("span", { class: "small" }, sub)));
  }));
}

/** Arborescence des cours avec cases à cocher (ordre de sélection mémorisé). */
function sourcePicker(tree, files, preselected) {
  const order = [...preselected];
  const byParent = new Map();
  for (const f of files.filter((f) => SOURCE_KINDS.has(kindOf(f)) && kindOf(f) !== "scan-text")) {
    const p = f.parents?.[0];
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(f);
  }
  const box = (f) => h("label", { class: "check", style: { margin: "4px 0" } },
    h("input", { type: "checkbox", value: f.id, checked: order.includes(f.id), onchange: (e) => {
      const i = order.indexOf(f.id);
      if (e.target.checked && i < 0) order.push(f.id);
      if (!e.target.checked && i >= 0) order.splice(i, 1);
    } }),
    h("span", {}, f.name.replace(/\.(md|pdf|json)$/i, ""), " ", h("span", { class: "badge" }, KINDS[kindOf(f)]?.label || "Fichier")));
  const sections = tree.map((c) => {
    const chapters = c.chapters.filter((ch) => byParent.has(ch.id));
    const root = byParent.get(c.id) || [];
    if (!chapters.length && !root.length) return null;
    const open = [...chapters.flatMap((ch) => byParent.get(ch.id)), ...root].some((f) => order.includes(f.id));
    return h("details", { class: "card sketch", open, style: { marginBottom: "12px" } },
      h("summary", { style: { fontSize: "22px", cursor: "pointer" } }, h("span", { class: `hl ${c.color === "yellow" ? "" : c.color}` }, c.name)),
      root.map(box),
      chapters.map((ch) => h("div", { style: { marginTop: "8px" } }, h("strong", {}, ch.name), byParent.get(ch.id).map(box))));
  }).filter(Boolean);
  return { el: sections.length ? h("div", {}, sections) : h("p", { class: "empty card sketch" }, "Aucun cours à utiliser pour l'instant : enregistre, numérise ou importe d'abord un cours."), order };
}

async function generateFiche({ sources, course, chapter }) {
  return api("/api/ai/fiche", { method: "POST", json: { sources, course, chapter } });
}

async function runGeneration(type, { sourcesFiles, dest, option, tree, out, go }) {
  const course = tree.find((c) => c.id === dest.courseId);
  const chapter = course?.chapters.find((ch) => ch.id === dest.chapterId);
  const steps = ["Lecture de tes cours", "Écriture de la fiche par l'IA", "Rangement dans ton Drive"];
  const prog = progressList(steps);
  const bar = h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, h("span"));
  mount(out, h("section", { class: "card sketch stack" }, h("h2", {}, "C'est parti !"), prog.el, bar,
    h("p", { class: "small muted" }, "Garde cette page ouverte jusqu'à la fin.")));
  const setBar = (p) => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; bar.setAttribute("aria-valuenow", String(Math.round(p * 100))); };

  prog.step(0);
  const sources = await gatherSources(sourcesFiles);
  if (!sources.length) throw new Error("Les fichiers choisis ne contiennent pas de texte utilisable.");
  const payload = { sources, course: course?.name || "", chapter: chapter?.name || "" };
  const folderId = dest.chapterId || dest.courseId;

  if (type === "fiche") {
    prog.step(1); setBar(0.3);
    const fiche = await generateFiche(payload);
    prog.step(2); setBar(0.9);
    const file = await drive.save({
      parentId: folderId, name: `Fiche — ${safeName(fiche.title, 70)}.json`, mimeType: "application/json", kind: "fiche",
      blob: new Blob([JSON.stringify(fiche, null, 2)], { type: "application/json" }),
    });
    prog.done(); setBar(1);
    return file;
  }

  return null; // podcasts et vidéos : voir launchServerJob
}

/**
 * Podcasts et vidéos : le travail lourd part sur le serveur de tâches.
 * On lit les cours ici (ils sont dans ton Drive), on les envoie chiffrés, et c'est tout :
 * tu peux fermer la page, tu seras prévenu à la fin.
 */
async function launchServerJob(type, { sourcesFiles, dest, option, voice, tree, out }) {
  const course = tree.find((c) => c.id === dest.courseId);
  const chapter = course?.chapters.find((ch) => ch.id === dest.chapterId);
  mount(out, h("section", { class: "card sketch" }, h("div", { class: "loading" }, h("div", { class: "spinner" }), "Lecture de tes cours…")));
  const sources = await gatherSources(sourcesFiles);
  if (!sources.length) throw new Error("Les fichiers choisis ne contiennent pas de texte utilisable.");
  const title = sourcesFiles.length === 1 ? sourcesFiles[0].name.replace(/\.(md|pdf|json)$/i, "") : `${course?.name || "Cours"} — ${chapter?.name || "révision"}`;
  const job = await createJob({
    kind: type, title: `${type === "podcast" ? "Podcast" : "Vidéo"} — ${title}`.slice(0, 160),
    sources, options: type === "podcast" ? { minutes: option, voice } : { format: option, voice },
    folder_id: dest.chapterId || dest.courseId, course: course?.name || "", chapter: chapter?.name || "",
  });
  return job;
}

function launchedCard(job, go) {
  const notifyArea = h("div", { class: "stack" });
  const paint = async () => {
    const status = await pushStatus().catch(() => "unsupported");
    if (status === "on") { mount(notifyArea, h("p", { class: "small" }, icon("check"), " Tu recevras une notification sur cet appareil.")); return; }
    if (status === "unsupported" || status === "denied") { mount(notifyArea, h("p", { class: "small muted" }, "Tu recevras un e-mail et une pastille sur le tableau de bord à la fin.")); return; }
    mount(notifyArea, h("button", { class: "btn", type: "button", onclick: async () => {
      try { await enablePush(); toast("Notifications activées", "success"); } catch (e) { toast(e.message, "info", 9000); }
      paint();
    } }, icon("bulb"), "Me prévenir sur cet appareil"),
    needsHomeScreen() ? h("p", { class: "small muted" }, "Sur iPhone : ajoute d'abord Studoo à l'écran d'accueil (Partager → « Sur l'écran d'accueil »).") : null);
  };
  paint();
  return h("section", { class: "card sketch stack" },
    h("span", { class: "tape" }),
    h("h2", {}, "C'est lancé !"),
    h("p", {}, `« ${job.title} » est en préparation sur le serveur de Studoo. `,
      h("strong", {}, "Tu peux fermer la page ou éteindre ton téléphone"), " : le fichier arrivera dans ton Drive, dans le dossier choisi."),
    h("p", { class: "small muted" }, "Compte en général 2 à 5 minutes (un peu plus pour 30 minutes de contenu)."),
    notifyArea,
    h("div", { class: "row" }, h("a", { class: "btn primary", href: "/", "data-link": "1" }, "Suivre sur le tableau de bord")));
}

export async function render({ view, params, data, go, refreshQuota }) {
  const type = params.type;
  const meta = TYPES[type];
  if (!meta) throw new Error("Type inconnu.");
  const [tree, files] = await Promise.all([drive.tree(), drive.allFiles()]);
  const picker = sourcePicker(tree, files, data?.fileIds || []);

  const options = type === "podcast" ? choiceGroup("duree", PODCAST, 10) : type === "video" ? choiceGroup("format", VIDEO, "short") : null;
  const voices = type === "fiche" ? null : choiceGroup("voix", type === "podcast"
    ? [["vivienne-remy", "Vivienne et Rémy", "Voix vivantes et chaleureuses"], ["denise-henri", "Denise et Henri", "Voix plus posées"]]
    : [["vivienne-remy", "Vivienne", "Voix vivante et chaleureuse"], ["denise-henri", "Denise", "Voix plus posée"]], "vivienne-remy");
  const destSel = h("select", { class: "input", id: "dest" }, tree.flatMap((c) => [
    h("option", { value: `${c.id}|`, }, `${c.name} (racine)`),
    ...c.chapters.map((ch) => h("option", { value: `${c.id}|${ch.id}` }, `${c.name} › ${ch.name}`)),
  ]));
  const fileById = new Map(files.map((f) => [f.id, f]));
  const syncDest = () => {
    // Règle : on range dans le chapitre du DERNIER fichier sélectionné.
    const last = fileById.get(picker.order[picker.order.length - 1]);
    const parent = last?.parents?.[0];
    const course = tree.find((c) => c.id === parent || c.chapters.some((ch) => ch.id === parent));
    if (course) destSel.value = course.id === parent ? `${course.id}|` : `${course.id}|${parent}`;
  };
  picker.el.addEventListener("change", syncDest);
  syncDest();
  if (data?.chapterId && data?.courseId && !picker.order.length) destSel.value = `${data.courseId}|${data.chapterId}`;

  const err = h("p", { class: "error", role: "alert" });
  const out = h("div");
  const submit = h("button", { class: `btn primary big`, type: "submit" }, icon("sparkles"), `Créer ${type === "video" ? "la" : "le"} ${meta.noun}`.replace("le fiche", "la fiche"));
  const form = h("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    const chosen = picker.order.map((id) => fileById.get(id)).filter(Boolean);
    if (!chosen.length) { err.textContent = "Coche au moins un cours."; return; }
    if (!destSel.value) { err.textContent = "Choisis où ranger le résultat."; return; }
    const [courseId, chapterId] = destSel.value.split("|");
    const option = type === "podcast" ? Number(form.querySelector("input[name=duree]:checked").value)
      : type === "video" ? form.querySelector("input[name=format]:checked").value : null;
    form.hidden = true;
    if (type !== "fiche") {
      try {
        const voice = form.querySelector("input[name=voix]:checked").value;
        const job = await launchServerJob(type, { sourcesFiles: chosen, dest: { courseId, chapterId }, option, voice, tree, out });
        mount(out, launchedCard(job, go));
      } catch (e2) {
        errorToast(e2);
        mount(out);
        form.hidden = false;
      }
      return;
    }
    try {
      const file = await runGeneration(type, { sourcesFiles: chosen, dest: { courseId, chapterId }, option, tree, out, go });
      toast(`${meta.noun.charAt(0).toUpperCase() + meta.noun.slice(1)} prêt${type === "video" || type === "fiche" ? "e" : ""} !`, "success");
      go(`/fichier/${file.id}`, { replace: true });
    } catch (e2) {
      errorToast(e2);
      mount(out);
      form.hidden = false;
    } finally {
      refreshQuota?.();
    }
  } },
    h("h2", { class: "section" }, "1. Choisis tes cours"),
    h("p", { class: "small muted" }, "L'IA utilise uniquement le contenu de ces documents."),
    picker.el,
    options ? [h("h2", { class: "section" }, type === "podcast" ? "2. Durée" : "2. Format"), options] : null,
    voices ? [h("h2", { class: "section" }, "3. Voix"), voices] : null,
    h("h2", { class: "section" }, `${options ? 4 : 2}. Où le ranger ?`),
    h("div", { class: "field" }, h("label", { for: "dest" }, "Dossier (par défaut : le chapitre du dernier cours coché)"), destSel),
    err,
    h("div", {}, submit),
    type !== "fiche" ? h("p", { class: "small muted" }, "Fabriqué sur le serveur de Studoo en quelques minutes : tu pourras fermer la page.") : null);

  mount(view,
    h("h1", { class: "view-title" }, h("span", { class: `hl ${meta.color}` }, meta.title)),
    tree.length ? form : h("p", { class: "empty card sketch" }, "Crée d'abord un cours dans « Mes cours »."),
    out);
}

// Création d'une fiche, d'un podcast ou d'une vidéo à partir des cours choisis.
import { api, ApiError } from "../lib/api.js";
import { concatPcm, encodeMp3, splitLines, tts } from "../lib/audio.js";
import { h, mount } from "../lib/dom.js";
import { duration } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { drive, gatherSources, getSettings, KINDS, kindOf, safeName, SOURCE_KINDS } from "../lib/storage.js";
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

async function makePodcastAudio(script, voices, progress) {
  const lines = script.lines.map((l) => ({ speaker: l.speaker, text: l.text }));
  const segments = splitLines(lines);
  const quota = await api("/api/ai/quota").catch(() => null);
  if (quota && (quota.tts.remaining < segments.length || quota.user.remaining < segments.length)) {
    return { fallback: `il faudrait ${segments.length} requêtes de voix et il en reste ${Math.min(quota.tts.remaining, quota.user.remaining)} aujourd'hui` };
  }
  const parts = [];
  let rate = 24000;
  for (const [i, seg] of segments.entries()) {
    progress(`Voix : segment ${i + 1} / ${segments.length}`);
    try {
      const res = await tts(seg, voices);
      parts.push(res.pcm);
      rate = res.rate;
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) return { fallback: err.message };
      throw err;
    }
  }
  return { pcm: concatPcm(parts, Math.round(rate * 0.35)), rate };
}

async function runGeneration(type, { sourcesFiles, dest, option, tree, out, go }) {
  const course = tree.find((c) => c.id === dest.courseId);
  const chapter = course?.chapters.find((ch) => ch.id === dest.chapterId);
  const steps = {
    fiche: ["Lecture de tes cours", "Écriture de la fiche par l'IA", "Rangement dans ton Drive"],
    podcast: ["Lecture de tes cours", "Écriture du script à deux voix", "Enregistrement des voix", "Fabrication du MP3", "Rangement dans ton Drive"],
    video: ["Lecture de tes cours", "Écriture du script et des diapos", "Enregistrement de la voix", "Fabrication de la vidéo", "Rangement dans ton Drive"],
  }[type];
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
  const settings = await getSettings();

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

  if (type === "podcast") {
    prog.step(1); setBar(0.1);
    const script = await api("/api/ai/podcast", { method: "POST", json: { ...payload, minutes: option } });
    prog.step(2); setBar(0.25);
    const audio = await makePodcastAudio(script, settings.voices, (t) => prog.step(2, t));
    if (audio.fallback) {
      toast(`Voix Gemini indisponible (${audio.fallback}) : le podcast sera lu par la voix de ton appareil.`, "info", 9000);
      prog.step(4); setBar(0.9);
      const file = await drive.save({
        parentId: folderId, name: `Podcast — ${safeName(script.title, 70)}.json`, mimeType: "application/json", kind: "podcast-script",
        props: { minutes: String(option) },
        blob: new Blob([JSON.stringify(script, null, 2)], { type: "application/json" }),
      });
      prog.done(); setBar(1);
      return file;
    }
    prog.step(3); setBar(0.7);
    const mp3 = await encodeMp3(audio.pcm, audio.rate, 64, (p) => setBar(0.7 + p * 0.2));
    prog.step(4); setBar(0.92);
    const file = await drive.save({
      parentId: folderId, name: `Podcast — ${safeName(script.title, 70)}.mp3`, mimeType: "audio/mpeg", kind: "podcast",
      props: { minutes: String(Math.round(audio.pcm.length / audio.rate / 60)), hosts: `${script.host_a} & ${script.host_b}`.slice(0, 100) },
      blob: mp3,
    });
    prog.done(); setBar(1);
    return file;
  }

  // ----- Vidéo -----
  const { renderMp4, slideDurations, supportsWebCodecs } = await import("../lib/video-render.js");
  if (!supportsWebCodecs()) throw new Error("La fabrication de vidéos nécessite un navigateur récent (Chrome, Edge, Firefox 130+, Safari 17+).");
  prog.step(1); setBar(0.05);
  const script = await api("/api/ai/video", { method: "POST", json: { ...payload, format: option } });
  prog.step(2); setBar(0.15);
  const narration = script.slides.map((s) => ({ speaker: "N", text: s.narration }));
  const audio = await makePodcastAudio({ lines: narration }, settings.voices, (t) => prog.step(2, t));
  if (audio.fallback) toast(`Voix indisponible (${audio.fallback}) : vidéo sous-titrée, sans voix.`, "info", 9000);
  const pcm = audio.fallback ? null : audio.pcm;
  const durations = slideDurations(script.slides, pcm ? pcm.length / audio.rate : null);
  prog.step(3, `Fabrication de la vidéo (${duration(durations.reduce((a, b) => a + b, 0))})`);
  const mp4 = await renderMp4({ script, format: option, durations, pcm, rate: audio.rate || 24000, onProgress: (p) => setBar(0.3 + p * 0.6) });
  prog.step(4); setBar(0.92);
  const file = await drive.save({
    parentId: folderId, name: `Vidéo — ${safeName(script.title, 70)}.mp4`, mimeType: "video/mp4", kind: "video",
    props: { format: option, voice: pcm ? "gemini" : "none" }, blob: mp4,
  });
  prog.done(); setBar(1);
  return file;
}

export async function render({ view, params, data, go, refreshQuota }) {
  const type = params.type;
  const meta = TYPES[type];
  if (!meta) throw new Error("Type inconnu.");
  const [tree, files] = await Promise.all([drive.tree(), drive.allFiles()]);
  const picker = sourcePicker(tree, files, data?.fileIds || []);

  const options = type === "podcast" ? choiceGroup("duree", PODCAST, 10) : type === "video" ? choiceGroup("format", VIDEO, "short") : null;
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
    h("h2", { class: "section" }, `${options ? 3 : 2}. Où le ranger ?`),
    h("div", { class: "field" }, h("label", { for: "dest" }, "Dossier (par défaut : le chapitre du dernier cours coché)"), destSel),
    err,
    h("div", {}, submit),
    type !== "fiche" ? h("p", { class: "small muted" }, "Offre gratuite : si le quota de voix Gemini du jour est épuisé, ",
      type === "podcast" ? "le podcast sera lu par la voix de ton appareil." : "la vidéo sera sous-titrée sans voix.") : null);

  mount(view,
    h("h1", { class: "view-title" }, h("span", { class: `hl ${meta.color}` }, meta.title)),
    tree.length ? form : h("p", { class: "empty card sketch" }, "Crée d'abord un cours dans « Mes cours »."),
    out);
}

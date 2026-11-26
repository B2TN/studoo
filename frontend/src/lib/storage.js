// Couche « métier » au-dessus du Drive : réglages, types de fichiers,
// récupération du texte des cours pour l'IA.
import { readCache, writeCache } from "./cache.js";
import { createGoogleDrive } from "./drive.js";
import { createMemoryDrive } from "./memory-drive.js";

export let drive = null;

export async function initStorage(user) {
  if (user?.dev) {
    drive = createMemoryDrive({ seed: true });
    await drive.ready;
  } else {
    // L'identifiant du dossier « Studoo » est mémorisé : pas besoin de le chercher à chaque visite.
    drive = createGoogleDrive({
      rootId: readCache("root")?.value || null,
      onRoot: (id) => writeCache("root", id),
    });
  }
  await drive.init();
  drive.checkRoot?.().catch(() => {});
  memoizeTree(drive);
  return drive;
}

/**
 * La liste des cours est demandée par presque toutes les pages : on la garde
 * 60 s en mémoire, et on l'oublie dès qu'un dossier ou un fichier est modifié.
 */
function memoizeTree(d) {
  const original = d.tree.bind(d);
  let memo = null;
  d.tree = () => {
    if (!memo || Date.now() - memo.at > 60e3) memo = { at: Date.now(), promise: original().catch((e) => { memo = null; throw e; }) };
    return memo.promise;
  };
  for (const name of ["createCourse", "createChapter", "rename", "trash", "move", "save", "setProps"]) {
    const fn = d[name]?.bind(d);
    if (!fn) continue;
    d[name] = async (...args) => {
      const out = await fn(...args);
      memo = null;
      return out;
    };
  }
}

/** Pour les tests : remplace le stockage. */
export function setDrive(d) {
  drive = d;
}

// ---------- Types de fichiers ----------
export const KINDS = {
  transcript: { label: "Transcription", icon: "microphone", color: "pink" },
  scan: { label: "Cours numérisé", icon: "camera", color: "yellow" },
  "scan-text": { label: "Texte extrait", icon: "file-text", color: "yellow" },
  pdf: { label: "PDF", icon: "file-type-pdf", color: "lilac" },
  fiche: { label: "Fiche", icon: "notes", color: "green" },
  podcast: { label: "Podcast", icon: "headphones", color: "blue" },
  "podcast-script": { label: "Podcast (voix du navigateur)", icon: "headphones", color: "blue" },
  video: { label: "Vidéo", icon: "movie", color: "orange" },
  "video-anim": { label: "Vidéo", icon: "movie", color: "orange" },
  exercices: { label: "Exercices", icon: "pencil", color: "pink" },
  correction: { label: "Correction", icon: "list-check", color: "green" },
  settings: { label: "Réglages", icon: "settings", color: "yellow" },
  timetable: { label: "Emploi du temps", icon: "calendar-week", color: "lilac" },
};
export const kindOf = (file) => file?.appProperties?.kind || (file?.mimeType === "application/pdf" ? "pdf" : "file");
export const isFolder = (file) => file?.mimeType === "application/vnd.google-apps.folder";
export const COLORS = ["yellow", "pink", "green", "blue", "orange", "lilac"];

// ---------- Réglages (fichier JSON dans le dossier Studoo du Drive) ----------
const DEFAULT_SETTINGS = { version: 1, recordingConsent: null, timetable: { sources: [] }, voices: { A: "Kore", B: "Puck" } };
let settingsCache = null;
let settingsFileId = null;

export async function getSettings() {
  if (settingsCache) return settingsCache;
  // L'identifiant du fichier de réglages est mémorisé : une seule requête au lieu de deux.
  const knownId = drive.kind === "google" ? readCache("settingsId")?.value : null;
  if (knownId) {
    try {
      settingsFileId = knownId;
      settingsCache = { ...DEFAULT_SETTINGS, ...(await drive.readJson(knownId)) };
      return settingsCache;
    } catch {
      settingsFileId = null; // fichier supprimé ou illisible : on le recherche
    }
  }
  const file = await drive.findSettings();
  if (file) {
    settingsFileId = file.id;
    writeCache("settingsId", file.id);
    try {
      settingsCache = { ...DEFAULT_SETTINGS, ...(await drive.readJson(file.id)) };
    } catch {
      settingsCache = { ...DEFAULT_SETTINGS };
    }
  } else {
    settingsCache = { ...DEFAULT_SETTINGS };
  }
  return settingsCache;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  const blob = new Blob([JSON.stringify(next, null, 2)], { type: "application/json" });
  if (settingsFileId) {
    await drive.updateContent(settingsFileId, blob, "application/json");
  } else {
    const root = await drive.init();
    settingsFileId = (await drive.save({ parentId: root, name: "studoo-reglages.json", mimeType: "application/json", blob, kind: "settings" })).id;
    writeCache("settingsId", settingsFileId);
  }
  settingsCache = next;
  return next;
}

export function resetSettingsCache() {
  settingsCache = null;
  settingsFileId = null;
}

// ---------- Texte des cours (pour fiches, podcasts, vidéos) ----------
/** Extrait le texte d'un PDF avec pdf.js (chargé seulement si besoin). */
export async function pdfText(blob) {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => it.str).join(" "));
  }
  return pages.join("\n\n").trim();
}

/** Renvoie { title, text, id, chapter_id } pour chaque fichier sélectionné utilisable comme source. */
export async function gatherSources(files) {
  const out = [];
  for (const f of files) {
    const before = out.length;
    const kind = kindOf(f);
    const title = f.name.replace(/\.(md|pdf|json)$/i, "");
    if (kind === "transcript" || kind === "scan-text") {
      out.push({ title, text: await drive.readText(f.id) });
    } else if (kind === "fiche") {
      out.push({ title, text: ficheToText(await drive.readJson(f.id)) });
    } else if (kind === "scan" && f.appProperties?.textId) {
      out.push({ title, text: await drive.readText(f.appProperties.textId) });
    } else if (kind === "pdf" || kind === "scan") {
      const text = await pdfText(await drive.readBlob(f.id));
      if (text.length > 40) out.push({ title, text });
      else throw new Error(`« ${title} » ne contient pas de texte lisible. Numérise-le avec l'outil « Numériser » pour que l'IA le lise.`);
    }
    if (out.length > before) Object.assign(out[out.length - 1], { id: f.id, chapter_id: f.parents?.[0] || "" });
  }
  return out;
}

export function ficheToText(fiche) {
  const lines = [`# ${fiche.title}`];
  for (const s of fiche.sections || []) {
    lines.push(`## ${s.heading}`);
    for (const b of s.blocks || []) lines.push([b.title, b.text, ...(b.items || [])].filter(Boolean).join(" — "));
  }
  if (fiche.key_points?.length) lines.push("## À retenir", ...fiche.key_points);
  return lines.join("\n");
}

export const HIDDEN_KINDS = new Set(["settings", "timetable", "scan-text", "video-audio"]); // voix d'une vidéo : ouverte via la vidéo
export const SOURCE_KINDS = new Set(["transcript", "scan", "scan-text", "pdf", "fiche"]);

/**
 * Un seul fichier par contenu dans « Mes cours » (les doublons restent dans le Drive, simplement masqués).
 * - fichiers techniques cachés (voix d'une vidéo, texte lu d'un scan, réglages) ;
 * - même tâche de génération (appProperties.jobId) → un seul fichier ;
 * - anciens fichiers sans jobId : même type + même nom + même dossier → un seul.
 * On garde le plus récent COMPLET (taille non nulle), sinon le plus récent.
 */
export function dedupe(files) {
  const groups = new Map();
  const out = [];
  for (const f of files) {
    if (f.mimeType === "application/vnd.google-apps.folder") { out.push(f); continue; }
    const kind = kindOf(f);
    if (HIDDEN_KINDS.has(kind)) continue;
    const key = f.appProperties?.jobId ? `job:${f.appProperties.jobId}`
      : ["podcast", "video", "video-anim", "fiche"].includes(kind)
        ? `name:${kind}|${(f.parents || [])[0] || ""}|${String(f.name).trim().toLowerCase()}` : `id:${f.id}`;
    if (!groups.has(key)) { groups.set(key, f); out.push(f); continue; }
    const kept = groups.get(key);
    const complete = (x) => x.size === undefined || Number(x.size) > 0;
    const better = (complete(f) && !complete(kept)) || (complete(f) === complete(kept) && String(f.modifiedTime) > String(kept.modifiedTime));
    if (better) { out[out.indexOf(kept)] = f; groups.set(key, f); }
  }
  return out;
}

/** Nettoie un nom de fichier pour Drive. */
export function safeName(name, max = 90) {
  return String(name).replace(/[\\/:*?"<>|\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "Sans titre";
}

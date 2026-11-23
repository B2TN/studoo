// Couche « métier » au-dessus du Drive : réglages, types de fichiers,
// récupération du texte des cours pour l'IA.
import { createGoogleDrive } from "./drive.js";
import { createMemoryDrive } from "./memory-drive.js";

export let drive = null;

export async function initStorage(user) {
  drive = user?.dev ? createMemoryDrive({ seed: true }) : createGoogleDrive();
  await drive.ready;
  await drive.init();
  return drive;
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
  const file = await drive.findSettings();
  if (file) {
    settingsFileId = file.id;
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

/** Renvoie { title, text } pour chaque fichier sélectionné utilisable comme source. */
export async function gatherSources(files) {
  const out = [];
  for (const f of files) {
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

export const HIDDEN_KINDS = new Set(["settings", "timetable", "scan-text"]);
export const SOURCE_KINDS = new Set(["transcript", "scan", "scan-text", "pdf", "fiche"]);

/** Nettoie un nom de fichier pour Drive. */
export function safeName(name, max = 90) {
  return String(name).replace(/[\\/:*?"<>|\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "Sans titre";
}

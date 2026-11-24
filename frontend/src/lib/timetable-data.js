// Récupération des cours de l'emploi du temps, quelle que soit la source.
import { api } from "./api.js";
import { drive, getSettings, saveSettings } from "./storage.js";

const CACHE_KEY = "studoo-edt-cache";
const CACHE_MS = 15 * 60 * 1000;

function readCache() {
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE_KEY));
    if (c && Date.now() - c.at < CACHE_MS) return c.events;
  } catch { /* ignoré */ }
  return null;
}
function writeCache(events) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), events })); } catch { /* ignoré */ }
}
export function clearTimetableCache() {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* ignoré */ }
}

/** Connexion Pronote (QR code, identifiants Pronote ou ENT). Renvoie la source scellée. */
export function pronoteLogin(body) {
  return api("/api/timetable/pronote", { method: "POST", json: body });
}

/** Emploi du temps fictif (mode démo local uniquement). */
export function demoEvents(now = new Date()) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const plan = [
    [["Anglais", 8, 9, "B12"], ["Mathématiques", 10, 12, "A03"], ["Histoire-Géographie", 14, 15, "C21"]],
    [["Physique-Chimie", 8, 10, "Labo 2"], ["Mathématiques", 13, 14, "A03"]],
    [["Histoire-Géographie", 9, 11, "C21"], ["Anglais", 11, 12, "B12"]],
    [["Mathématiques", 8, 10, "A03"], ["Physique-Chimie", 14, 16, "Labo 2"]],
    [["Anglais", 10, 11, "B12"], ["Histoire-Géographie", 13, 15, "C21"]],
  ];
  const iso = (d, hh) => { const x = new Date(d); x.setHours(hh, 0, 0, 0); return x.toISOString(); };
  return plan.flatMap((day, i) => day.map(([subject, a, b, room]) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return { uid: `demo-${i}-${a}`, title: subject, subject, start: iso(d, a), end: iso(d, b), location: room, description: "", cancelled: false };
  }));
}

async function fromSource(src) {
  if (src.type === "demo") {
    // Démo locale : simule l'aller-retour serveur + ENT (≈ 4 × la latence choisie).
    let ms = 0;
    try { ms = Number(localStorage.getItem("studoo-latence") || 0) * 4; } catch { /* indisponible */ }
    if (ms) await new Promise((r) => setTimeout(r, ms));
    return demoEvents();
  }
  if (src.type === "sealed") {
    // Source chiffrée : seul le serveur sait la lire.
    const res = await api("/api/timetable/sync", { method: "POST", json: { sealed: src.sealed } });
    if (res.sealed) await updateSource(src.id, { sealed: res.sealed }); // Pronote renouvelle son jeton à chaque connexion
    return res.events;
  }
  if (src.type === "ics-url" || (src.type === "pronote" && src.icalUrl)) {
    // Ancien format (lien en clair) : on le remplace par sa version scellée.
    const res = await api("/api/timetable/ics-url", { method: "POST", json: { url: src.url || src.icalUrl } });
    await updateSource(src.id, { type: "sealed", sealed: res.sealed, url: undefined, icalUrl: undefined });
    return res.events;
  }
  if (src.type === "pronote" && src.blob) {
    throw new Error("Ta connexion Pronote doit être refaite (nouvelle méthode plus sûre). Va dans « Emploi du temps ».");
  }
  if (src.type === "ics-file" && src.fileId) {
    const content = await drive.readText(src.fileId);
    return (await api("/api/timetable/ics-file", { method: "POST", json: { content } })).events;
  }
  return [];
}

/** Tous les cours connus (toutes sources), triés. */
export async function loadEvents({ force = false } = {}) {
  if (!force) {
    const cached = readCache();
    if (cached) return cached;
  }
  const settings = await getSettings();
  const sources = settings.timetable?.sources || [];
  const results = await Promise.allSettled(sources.map(fromSource));
  const events = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason);
  events.sort((a, b) => a.start.localeCompare(b.start));
  writeCache(events);
  if (errors.length && !events.length) throw errors[0];
  return events;
}

export async function addSource(source) {
  const settings = await getSettings();
  const sources = (settings.timetable?.sources || []).filter((s) => s.id !== source.id);
  sources.push({ id: crypto.randomUUID(), addedAt: new Date().toISOString(), ...source });
  await saveSettings({ timetable: { ...settings.timetable, sources } });
  clearTimetableCache();
}

async function updateSource(id, patch) {
  const settings = await getSettings();
  const sources = (settings.timetable?.sources || []).map((s) => {
    if (s.id !== id) return s;
    const next = { ...s, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    return next;
  });
  await saveSettings({ timetable: { ...settings.timetable, sources } });
}

/** Retirer une source = révoquer son jeton : il est supprimé du Drive et n'est plus utilisable. */
export async function removeSource(id) {
  const settings = await getSettings();
  await saveSettings({ timetable: { ...settings.timetable, sources: (settings.timetable?.sources || []).filter((s) => s.id !== id) } });
  clearTimetableCache();
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function eventsOfDay(events, day = new Date()) {
  return events.filter((e) => sameDay(new Date(e.start), day));
}

/** Le cours en cours (ou qui vient de finir il y a moins de 20 min) à l'instant `at`. */
export function lessonAt(events, at = new Date()) {
  const t = at.getTime();
  return events.find((e) => !e.cancelled && new Date(e.start).getTime() - 10 * 60e3 <= t && t <= new Date(e.end).getTime() + 20 * 60e3) || null;
}

export function nextLesson(events, at = new Date()) {
  return events.find((e) => !e.cancelled && new Date(e.start) > at) || null;
}

export function subjectsOf(events) {
  return [...new Set(events.map((e) => e.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
}

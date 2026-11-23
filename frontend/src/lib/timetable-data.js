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

export async function pronoteCall(body) {
  const { token } = await api("/api/auth/service-token");
  return api("/api/pronote", { method: "POST", json: body, headers: { Authorization: `Bearer ${token}` } });
}

async function fromSource(src) {
  if (src.type === "ics-url" || (src.type === "pronote" && src.icalUrl)) {
    return (await api("/api/timetable/ics-url", { method: "POST", json: { url: src.url || src.icalUrl } })).events;
  }
  if (src.type === "pronote" && src.blob) {
    const res = await pronoteCall({ action: "sync", blob: src.blob, deviceUUID: src.deviceUUID });
    return res.events;
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

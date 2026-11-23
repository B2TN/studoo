// Emploi du temps : semaine en cours + ajout de sources (Pronote, université, .ics).
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { time } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { drive, getSettings } from "../lib/storage.js";
import { addSource, clearTimetableCache, loadEvents, pronoteCall, removeSource } from "../lib/timetable-data.js";
import {
  detectSoftware, HIGH_SCHOOL_SERVICES, ICAL_STEPS_PRONOTE, ICAL_STEPS_UNIVERSITY, QR_STEPS_PRONOTE, UNIVERSITIES,
} from "../lib/establishments.js";
import { openDialog, store, toast } from "../lib/ui.js";

const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];
const COLORS = ["yellow", "pink", "green", "blue", "orange", "lilac"];

function mondayOf(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function colorFor(subject, palette) {
  if (!palette.has(subject)) palette.set(subject, COLORS[palette.size % COLORS.length]);
  return palette.get(subject);
}

function weekView(events, monday) {
  const palette = new Map();
  const today = new Date().toDateString();
  return h("div", { class: "week" }, DAYS.map((name, i) => {
    const day = new Date(monday);
    day.setDate(day.getDate() + i);
    const list = events.filter((e) => new Date(e.start).toDateString() === day.toDateString());
    return h("section", { class: `day card sketch${day.toDateString() === today ? " today" : ""}`, "aria-label": `${name} ${day.getDate()}` },
      h("h3", {}, day.toDateString() === today ? h("span", { class: "hl" }, name) : name, " ", h("span", { class: "small muted" }, day.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }))),
      list.length ? list.map((e) => h("div", { class: `lesson c-${colorFor(e.subject, palette)}${e.cancelled ? " cancelled" : ""}` },
        h("time", { datetime: e.start }, `${time(e.start)} – ${time(e.end)}`), h("strong", {}, e.subject),
        e.location ? h("span", { class: "small" }, ` · ${e.location}`) : null, e.cancelled ? h("span", { class: "small" }, " (annulé)") : null))
        : h("p", { class: "small muted" }, "—"));
  }));
}

// ---------- Ajout d'un lien / fichier .ics ----------
function icsForm({ steps, label = "Lien de ton emploi du temps", onDone, sourceType = "ics-url", extra = {} }) {
  const input = h("input", { class: "input", id: "ics-url", type: "url", inputmode: "url", placeholder: "https://…/calendar.ics", autocomplete: "off" });
  const hint = h("span", { class: "hint", "aria-live": "polite" });
  const err = h("p", { class: "error", role: "alert" });
  input.addEventListener("input", () => { const s = detectSoftware(input.value); hint.textContent = s ? `Reconnu : ${s}` : ""; });
  const btn = h("button", { class: "btn primary", type: "submit" }, icon("link"), "Ajouter ce lien");
  return h("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    const url = input.value.trim();
    if (!/^(https?|webcal):\/\/\S+$/i.test(url)) { err.textContent = "Colle un lien qui commence par https:// ou webcal://"; input.setAttribute("aria-invalid", "true"); input.focus(); return; }
    btn.disabled = true;
    try {
      const res = await api("/api/timetable/ics-url", { method: "POST", json: { url } });
      await addSource({ type: sourceType, url: res.url, label: detectSoftware(url) || "Lien iCal", ...extra });
      toast(`${res.events.length} cours trouvés !`, "success");
      onDone(res.subjects);
    } catch (e2) {
      err.textContent = e2.message;
    } finally {
      btn.disabled = false;
    }
  } },
    steps ? h("ol", { class: "steps-list" }, steps.map((s) => h("li", {}, s))) : null,
    h("div", { class: "field" }, h("label", { for: "ics-url" }, label), input, hint),
    err, h("div", {}, btn));
}

function icsFileForm(onDone) {
  const input = h("input", { type: "file", accept: ".ics,text/calendar", id: "ics-file", class: "input" });
  const err = h("p", { class: "error", role: "alert" });
  return h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    const file = input.files[0];
    if (!file) { err.textContent = "Choisis un fichier .ics."; return; }
    if (file.size > 3 * 1024 * 1024) { err.textContent = "Fichier trop gros (3 Mo max)."; return; }
    try {
      const content = await file.text();
      const res = await api("/api/timetable/ics-file", { method: "POST", json: { content } });
      const root = await drive.init();
      const saved = await drive.save({ parentId: root, name: `Emploi du temps — ${file.name}`, mimeType: "text/calendar", kind: "timetable", blob: new Blob([content], { type: "text/calendar" }) });
      await addSource({ type: "ics-file", fileId: saved.id, label: file.name });
      toast(`${res.events.length} cours importés`, "success");
      onDone(res.subjects);
    } catch (e2) { err.textContent = e2.message; }
  } },
    h("div", { class: "field" }, h("label", { for: "ics-file" }, "Fichier .ics (copié dans ton Drive)"), input), err,
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, icon("upload"), "Importer le fichier")));
}

// ---------- Connecteur Pronote ----------
function deviceId() {
  let id = store.get("studoo-device");
  if (!id) { id = crypto.randomUUID(); store.set("studoo-device", id); }
  return id;
}

async function decodeQrFromImage(source) {
  const { default: jsQR } = await import("jsqr");
  const c = document.createElement("canvas");
  c.width = source.videoWidth || source.width;
  c.height = source.videoHeight || source.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const res = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  return res?.data || null;
}

function pronoteQrForm(onDone) {
  let qrData = null;
  let stream = null;
  const video = h("video", { playsinline: true, muted: true, style: { width: "100%", maxWidth: "360px", border: "2px solid var(--ink)", borderRadius: "12px" }, hidden: true });
  const qrState = h("p", { role: "status", class: "muted" }, "Aucun QR code lu pour l'instant.");
  const pin = h("input", { class: "input", id: "pin", inputmode: "numeric", pattern: "[0-9]{4}", maxlength: 4, autocomplete: "off", style: { maxWidth: "140px" } });
  const err = h("p", { class: "error", role: "alert" });
  const shot = h("input", { type: "file", accept: "image/*", class: "sr-only", id: "qr-shot" });
  const stop = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; video.hidden = true; };
  const found = (data) => { qrData = data; stop(); qrState.textContent = "QR code lu ✓ Tape maintenant ton code à 4 chiffres."; pin.focus(); };

  const scanBtn = h("button", { class: "btn", type: "button", onclick: async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      const loop = async () => {
        if (!stream) return;
        const data = await decodeQrFromImage(video);
        if (data) found(data); else setTimeout(loop, 300);
      };
      loop();
    } catch { toast("Caméra indisponible : importe plutôt une capture d'écran du QR code.", "info"); }
  } }, icon("qrcode"), "Scanner avec la caméra");
  shot.addEventListener("change", async () => {
    const f = shot.files[0];
    if (!f) return;
    const bmp = await createImageBitmap(f);
    const data = await decodeQrFromImage(bmp);
    if (data) found(data); else toast("Aucun QR code trouvé dans cette image.", "error");
  });

  const submit = h("button", { class: "btn primary", type: "submit" }, icon("check"), "Connecter Pronote");
  const form = h("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    if (!qrData) { err.textContent = "Scanne d'abord le QR code."; return; }
    if (!/^\d{4}$/.test(pin.value)) { err.textContent = "Le code doit contenir 4 chiffres."; pin.focus(); return; }
    submit.disabled = true;
    try {
      const res = await pronoteCall({ action: "qr", qr: qrData, pin: pin.value, deviceUUID: deviceId() });
      await addSource(res.icalUrl ? { type: "pronote", icalUrl: res.icalUrl, label: "Pronote (lien iCal)" } : { type: "pronote", blob: res.blob, deviceUUID: deviceId(), label: "Pronote" });
      toast(`Pronote connecté : ${res.events.length} cours trouvés.`, "success");
      stop();
      onDone(res.subjects);
    } catch (e2) {
      err.textContent = e2.message;
    } finally {
      submit.disabled = false;
      pin.value = "";
    }
  } },
    h("ol", { class: "steps-list" }, QR_STEPS_PRONOTE.map((s) => h("li", {}, s))),
    h("div", { class: "row" }, scanBtn, h("button", { class: "btn", type: "button", onclick: () => shot.click() }, icon("photo"), "Importer une capture"), shot),
    video, qrState,
    h("div", { class: "field" }, h("label", { for: "pin" }, "Code à 4 chiffres choisi dans Pronote"), pin),
    err, h("div", {}, submit),
    h("p", { class: "small muted" }, icon("shield-lock"), " Ton mot de passe n'est jamais demandé. Si Pronote fournit un lien iCal, Studoo ne garde que ce lien ; sinon, un jeton de reconnexion chiffré est rangé dans ton Drive. Connecteur non officiel : il peut cesser de fonctionner après une mise à jour de Pronote."));
  return { el: form, stop };
}

function afterImport(go) {
  return (subjects) => {
    clearTimetableCache();
    if (subjects?.length) toast("Astuce : dans « Mes cours », crée tous tes dossiers de matières d'un clic.", "info", 8000);
    go("/emploi-du-temps", { replace: true });
  };
}

function addPanel(go) {
  const done = afterImport(go);
  const tabs = [
    ["Je suis au lycée", () => h("div", { class: "stack" },
      h("p", {}, "Choisis ton service :"),
      h("div", { class: "establishments" }, HIGH_SCHOOL_SERVICES.map((s) => h("button", { class: "btn", type: "button", onclick: () => {
        let qr = null;
        openDialog(s.name, (close) => {
          if (s.connector === "ics") return h("div", { class: "stack" }, h("p", {}, s.note), icsFileForm((x) => { close(); done(x); }));
          qr = pronoteQrForm((x) => { close(); done(x); });
          return h("div", { class: "stack" }, h("p", { class: "small" }, s.note),
            h("details", { open: true }, h("summary", {}, h("strong", {}, "Méthode 1 : QR code (recommandée)")), qr.el),
            h("details", {}, h("summary", {}, h("strong", {}, "Méthode 2 : lien iCal Pronote")),
              icsForm({ steps: ICAL_STEPS_PRONOTE, sourceType: "ics-url", onDone: (x) => { close(); done(x); } })));
        }, { onClose: () => qr?.stop() });
      } }, icon("school"), h("span", {}, h("strong", {}, s.name)))))),
    ],
    ["Je suis étudiant·e", () => h("div", { class: "stack" },
      h("p", {}, "Choisis ton établissement (20 plus grands en France), ou « Autre » :"),
      h("div", { class: "establishments" }, [...UNIVERSITIES, { name: "Autre établissement", city: "", url: "" }].map((u) =>
        h("button", { class: "btn", type: "button", onclick: () => openDialog(u.name, (close) => h("div", { class: "stack" },
          u.url ? h("p", {}, "Site de l'établissement : ", h("a", { href: u.url, target: "_blank", rel: "noopener" }, u.url.replace("https://", ""))) : null,
          icsForm({ steps: ICAL_STEPS_UNIVERSITY, onDone: (x) => { close(); done(x); }, extra: { establishment: u.name } }),
          h("p", { class: "small muted" }, "Les liens ADE sont automatiquement prolongés : ton emploi du temps reste à jour toute l'année."))) },
          icon("school"), h("span", {}, h("strong", {}, u.name), u.city ? h("span", { class: "small muted" }, ` · ${u.city}`) : null))))),
    ],
    ["Lien ou fichier .ics", () => h("div", { class: "stack" },
      icsForm({ onDone: done }), h("hr"), icsFileForm(done))],
  ];
  const panel = h("div", { style: { marginTop: "14px" } });
  const buttons = tabs.map(([label, build], i) => h("button", { class: "btn", type: "button", role: "tab", "aria-selected": "false", onclick: () => select(i) }, label));
  function select(i) {
    buttons.forEach((b, j) => { b.setAttribute("aria-selected", String(i === j)); b.classList.toggle("primary", i === j); });
    mount(panel, tabs[i][1]());
  }
  select(0);
  return h("section", { class: "card sketch", style: { marginTop: "26px" } }, h("span", { class: "tape" }),
    h("h2", { style: { fontSize: "30px", marginBottom: "10px" } }, "Ajouter un emploi du temps"),
    h("div", { class: "row", role: "tablist" }, buttons), panel);
}

export async function render({ view, query, go }) {
  const settings = await getSettings();
  const sources = settings.timetable?.sources || [];
  const offset = Number(query.get("semaine") || 0);
  const monday = mondayOf(new Date());
  monday.setDate(monday.getDate() + offset * 7);
  let events = [];
  let error = null;
  if (sources.length) {
    try { events = await loadEvents(); } catch (e) { error = e; }
  }

  mount(view,
    h("h1", { class: "view-title" }, "Emploi du ", h("span", { class: "hl" }, "temps")),
    sources.length ? [
      h("div", { class: "row", style: { margin: "10px 0 16px" } },
        h("a", { class: "btn small", href: `/emploi-du-temps?semaine=${offset - 1}`, "data-link": "1", "aria-label": "Semaine précédente" }, icon("arrow-left")),
        h("strong", {}, `Semaine du ${monday.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}`),
        h("a", { class: "btn small", href: `/emploi-du-temps?semaine=${offset + 1}`, "data-link": "1", "aria-label": "Semaine suivante" }, icon("arrow-right")),
        h("span", { class: "spacer" }),
        h("button", { class: "btn small", onclick: async () => { clearTimetableCache(); go(location.pathname + location.search, { replace: true }); } }, icon("refresh"), "Actualiser")),
      error ? h("p", { class: "card sketch error" }, `Synchronisation impossible : ${error.message}`) : null,
      weekView(events, monday),
      h("h2", { class: "section" }, "Sources connectées"),
      h("ul", { class: "files card sketch" }, sources.map((s) => h("li", {},
        h("span", { class: "kind c-lilac" }, icon(s.type === "pronote" ? "school" : "link")),
        h("span", {}, h("strong", {}, s.label || s.type), s.establishment ? h("span", { class: "small muted" }, ` · ${s.establishment}`) : null),
        h("span", { class: "meta" }, h("button", { class: "btn small danger", onclick: async () => { await removeSource(s.id); go(location.pathname, { replace: true }); } }, icon("trash"), "Retirer"))))),
    ] : h("p", { class: "muted" }, "Connecte ton emploi du temps : Studoo saura quel cours tu enregistres et créera tes dossiers de matières."),
    addPanel(go));
}

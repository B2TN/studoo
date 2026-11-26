// Enregistrement d'un cours au micro, transcrit au fil de l'eau.
//
// Fonctionnement : l'audio est découpé en tranches de 5 minutes. Chaque
// tranche est envoyée à l'API, transcrite par Gemini avec les rôles
// (« Professeur », « Élève »…), puis OUBLIÉE : aucun fichier audio n'est gardé.
import { api, ApiError } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { duration, transcriptToMarkdown } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { addPending } from "../lib/pending.js";
import { drive, getSettings, saveSettings } from "../lib/storage.js";
import { errorToast, store, toast } from "../lib/ui.js";

const CHUNK_MS = 5 * 60 * 1000;
const MAX_MS = 2 * 60 * 60 * 1000;

function pickMime() {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return options.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
}

function consentCard(onAccept) {
  const box = h("input", { type: "checkbox", id: "consent" });
  const err = h("p", { class: "error", "aria-live": "polite" });
  return h("section", { class: "card sketch stack", style: { maxWidth: "720px" } },
    h("span", { class: "tape" }),
    h("h2", {}, "Avant ton premier enregistrement"),
    h("p", {}, "Enregistrer quelqu'un sans son accord est interdit, et les cours appartiennent à leurs auteurs. Avec Studoo :"),
    h("ul", {},
      h("li", {}, "tu demandes l'accord de ton enseignant (et des personnes qui parlent) ;"),
      h("li", {}, "la transcription sert uniquement à TES révisions, tu ne la publies pas ;"),
      h("li", {}, "l'audio est envoyé à Google Gemini par tranches de 5 min pour être transcrit, puis effacé : aucun fichier audio n'est conservé ;"),
      h("li", {}, "avec l'offre gratuite de Gemini, Google peut utiliser ces extraits pour améliorer ses services (voir la page ", h("a", { href: "/rgpd" }, "RGPD"), ").")),
    h("label", { class: "check", for: "consent" }, box, h("span", {}, "Je m'engage à demander l'accord des personnes enregistrées et à garder les transcriptions pour mon usage personnel.")),
    err,
    h("button", { class: "btn primary", type: "button", onclick: () => {
      if (!box.checked) { err.textContent = "Coche la case pour continuer."; box.focus(); return; }
      onAccept();
    } }, "J'ai compris, continuer"));
}

export async function render({ view, go, refreshQuota }) {
  const settings = await getSettings();
  if (!settings.recordingConsent) {
    mount(view, h("h1", { class: "view-title" }, "Enregistrer un cours"),
      consentCard(async () => {
        await saveSettings({ recordingConsent: new Date().toISOString() });
        render({ view, go, refreshQuota });
      }));
    return null;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    mount(view, h("h1", { class: "view-title" }, "Enregistrer un cours"),
      h("p", { class: "card sketch" }, "Ton navigateur ne permet pas d'enregistrer le micro. Essaie avec Chrome, Edge, Firefox ou Safari récent."));
    return null;
  }

  // ----- État -----
  let stream = null, recorder = null, audioCtx = null, raf = 0, wakeLock = null;
  let startedAt = null, elapsedBefore = 0, segmentStart = 0, rotateTimer = 0, tickTimer = 0;
  let running = false, paused = false, stopping = false, aborted = false;
  const segments = [];
  const queue = [];
  let busy = false, chunkIndex = 0, failed = 0;
  const mime = pickMime();

  // ----- Interface -----
  const timeEl = h("p", { class: "rec-time", "aria-live": "off" }, "0:00");
  const status = h("p", { class: "muted", role: "status" }, "Appuie sur le micro pour commencer.");
  const level = h("div", { class: "bar level", "aria-hidden": "true" }, h("span"));
  const recBtn = h("button", { class: "rec-button", type: "button", "aria-label": "Démarrer l'enregistrement" }, icon("microphone"));
  const pauseBtn = h("button", { class: "btn", type: "button", hidden: true }, icon("player-pause"), "Pause");
  const stopBtn = h("button", { class: "btn pink", type: "button", hidden: true }, icon("player-stop"), "Terminer");
  const live = h("div", { class: "live-transcript card sketch", "aria-live": "polite", hidden: true });

  const elapsed = () => elapsedBefore + (running && !paused ? Date.now() - segmentStart : 0);

  function showSegments(list) {
    live.hidden = false;
    for (const s of list) live.append(h("p", {}, h("span", { class: "who" }, `${s.speaker} :`), " ", s.text));
    live.scrollTop = live.scrollHeight;
  }

  // Temps réel de transcription d'une tranche, mesuré sur cet appareil (pour le temps d'attente estimé).
  const timings = store.get("studoo-transcribe-secs", []);
  function remainingText() {
    const left = queue.length + (busy ? 1 : 0);
    if (!left) return "";
    const sorted = [...timings].sort((a, b) => a - b);
    const lo = sorted.length >= 3 ? sorted[Math.floor(sorted.length * 0.2)] : 15;
    const hi = sorted.length >= 3 ? sorted[Math.floor(sorted.length * 0.85)] * 1.3 : 60;
    const [a, b] = [Math.round((left * lo) / 60), Math.max(1, Math.round((left * hi) / 60))];
    return left * hi < 60 ? " Encore moins d'une minute." : ` Encore environ ${a < 1 ? "moins de " + b : a + " à " + Math.max(b, a + 1)} min.`;
  }

  async function transcribeNext() {
    if (busy || !queue.length) return;
    busy = true;
    const t0 = performance.now();
    const { blob, index } = queue.shift();
    const prev = segments.slice(-3).map((s) => `${s.speaker} : ${s.text}`).join("\n").slice(-580);
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      try {
        const res = await api(`/api/ai/transcribe?index=${index}&prev=${encodeURIComponent(prev)}`, {
          method: "POST", body: blob, headers: { "Content-Type": blob.type.split(";")[0] || "audio/webm" },
        });
        segments.push(...res.segments);
        showSegments(res.segments);
        done = true;
      } catch (err) {
        const quota = err instanceof ApiError && ["site_quota", "user_quota"].includes(err.code);
        if (quota || attempt === 3) {
          failed++;
          const marker = { speaker: "Studoo", text: `[passage de ${duration(CHUNK_MS / 1000)} non transcrit : ${err.message}]` };
          segments.push(marker);
          showSegments([marker]);
          break;
        }
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      }
    }
    // L'audio de cette tranche n'est plus référencé nulle part : le navigateur l'efface.
    if (done) {
      timings.push(Math.round((performance.now() - t0) / 1000));
      store.set("studoo-transcribe-secs", timings.slice(-20));
    }
    busy = false;
    refreshQuota?.();
    updateStatus();
    transcribeNext();
  }

  function updateStatus() {
    if (stopping) status.textContent = queue.length || busy ? `Transcription des dernières minutes…${remainingText()}` : "C'est prêt !";
    else if (paused) status.textContent = "En pause.";
    else if (running) status.textContent = `Enregistrement en cours. ${busy ? "Transcription d'une tranche…" : "Le texte apparaît toutes les 5 minutes."}`;
  }

  function newRecorder() {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    const parts = [];
    recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    recorder.onstop = () => {
      if (parts.length && !aborted) {
        queue.push({ blob: new Blob(parts, { type: recorder.mimeType || mime || "audio/webm" }), index: chunkIndex++ });
        transcribeNext();
      }
    };
    recorder.start();
  }

  function rotate() {
    // Termine la tranche en cours (fichier audio complet) et en démarre une nouvelle.
    if (!running || paused || stopping) return;
    const old = recorder;
    newRecorder();
    old.stop();
  }

  function tick() {
    const ms = elapsed();
    timeEl.textContent = duration(ms / 1000);
    if (ms >= MAX_MS) { toast("Durée maximale atteinte (2 h) : l'enregistrement s'arrête.", "info"); stop(); }
  }

  function meter() {
    audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      level.firstChild.style.width = `${Math.min(100, (peak / 64) * 100)}%`;
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      toast("Accès au micro refusé. Autorise le micro dans les réglages du navigateur.", "error", 8000);
      return;
    }
    startedAt = new Date().toISOString();
    running = true;
    segmentStart = Date.now();
    newRecorder();
    meter();
    rotateTimer = setInterval(rotate, CHUNK_MS);
    tickTimer = setInterval(tick, 500);
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* facultatif */ }
    recBtn.classList.add("on");
    recBtn.setAttribute("aria-label", "Enregistrement en cours");
    recBtn.disabled = true;
    pauseBtn.hidden = false;
    stopBtn.hidden = false;
    window.addEventListener("beforeunload", warn);
    updateStatus();
  }

  function togglePause() {
    if (!running) return;
    if (!paused) {
      recorder.pause();
      elapsedBefore += Date.now() - segmentStart;
      paused = true;
      pauseBtn.replaceChildren(icon("player-play"), "Reprendre");
    } else {
      recorder.resume();
      segmentStart = Date.now();
      paused = false;
      pauseBtn.replaceChildren(icon("player-pause"), "Pause");
    }
    updateStatus();
  }

  function release() {
    clearInterval(rotateTimer);
    clearInterval(tickTimer);
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    audioCtx?.close().catch(() => {});
    wakeLock?.release?.().catch(() => {});
    window.removeEventListener("beforeunload", warn);
  }

  async function stop() {
    if (!running || stopping) return;
    stopping = true;
    if (!paused) elapsedBefore += Date.now() - segmentStart;
    recorder.stop();
    release();
    recBtn.classList.remove("on");
    pauseBtn.hidden = true;
    stopBtn.disabled = true;
    updateStatus();
    // Attend la fin des transcriptions
    await new Promise((resolve) => {
      const wait = () => (queue.length || busy ? setTimeout(wait, 500) : resolve());
      wait();
    });
    running = false;
    const real = segments.filter((s) => s.speaker !== "Studoo");
    if (!real.length) {
      toast(failed ? "La transcription a échoué. Réessaie plus tard." : "Aucune parole détectée.", "error", 8000);
      stopBtn.disabled = false;
      return;
    }
    const excerpt = real.map((s) => `${s.speaker} : ${s.text}`).join("\n");
    const id = addPending({
      kind: "transcript", excerpt, startedAt,
      save: (folderId, title) => drive.save({
        parentId: folderId, name: `${title}.md`, mimeType: "text/markdown", kind: "transcript",
        props: { recordedAt: startedAt, minutes: String(Math.round(elapsedBefore / 60000)) },
        blob: new Blob([transcriptToMarkdown(title, segments)], { type: "text/markdown" }),
      }),
    });
    go(`/confirmer?id=${id}`);
  }

  function warn(e) {
    e.preventDefault();
    e.returnValue = "";
  }

  recBtn.addEventListener("click", () => start().catch(errorToast));
  pauseBtn.addEventListener("click", togglePause);
  stopBtn.addEventListener("click", () => stop().catch(errorToast));

  mount(view,
    h("h1", { class: "view-title" }, "Enregistrer un ", h("span", { class: "hl pink" }, "cours")),
    h("p", { class: "small muted" }, icon("shield-lock"), " Rappel : accord des personnes enregistrées · usage personnel · audio effacé après transcription."),
    h("section", { class: "recorder card sketch" },
      recBtn, timeEl, level, status,
      h("div", { class: "row", style: { justifyContent: "center", marginTop: "14px" } }, pauseBtn, stopBtn),
      h("p", { class: "small muted", style: { marginTop: "12px" } }, "Pose ton téléphone près du prof, écran allumé. Durée maximale : 2 h.")),
    live);

  // Si l'élève quitte la page : on arrête tout (micro coupé, audio oublié).
  return () => {
    if (running && !stopping) {
      aborted = true;
      try { recorder.stop(); } catch { /* ignoré */ }
      queue.length = 0;
      release();
      toast("Enregistrement interrompu.", "info");
    }
  };
}

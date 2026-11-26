// Enregistrement d'un cours au micro, transcrit au fil de l'eau.
//
// Fonctionnement : l'audio est découpé en tranches de 5 minutes. Chaque
// tranche est envoyée à l'API, transcrite (Azure AI Speech) avec les rôles
// (« Professeur », « Élève »…), puis OUBLIÉE : aucun fichier audio n'est gardé,
// même en cas d'échec.
//
// Itération 5 : « Terminer » attend que le navigateur ait livré la dernière tranche
// (avant, la page concluait trop tôt « Aucune parole détectée »), et chaque cas
// d'erreur a son message : micro inaccessible, enregistrement vide, erreur du
// service de transcription, ou vraiment aucune parole.
import { api, ApiError } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { duration, transcriptToMarkdown } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { addPending } from "../lib/pending.js";
import { drive, getSettings, saveSettings } from "../lib/storage.js";
import { errorToast, store, toast } from "../lib/ui.js";

const CHUNK_MS = 5 * 60 * 1000;
const MAX_MS = 2 * 60 * 60 * 1000;
const MIN_BYTES = 800;          // en dessous : tranche vide (en-tête seul)
const VOICE_LEVEL = 0.06;       // niveau (0 à 1) au-delà duquel on considère que le micro capte un son
// Erreurs qu'un nouvel essai ne corrigera pas : on n'insiste pas.
const FINAL_CODES = new Set(["empty_audio", "bad_audio", "bad_audio_type", "stt_unconfigured", "too_big", "site_quota", "user_quota"]);
const debug = (...a) => { try { if (localStorage.getItem("studoo-debug")) console.info("[transcription]", ...a); } catch { /* ignoré */ } };

/** Message clair selon la raison pour laquelle le micro n'est pas accessible. */
export function micErrorMessage(err) {
  switch (err?.name) {
    case "NotAllowedError": case "SecurityError":
      return "Accès au micro refusé. Autorise le micro (icône du cadenas à gauche de l'adresse du site), puis réessaie.";
    case "NotFoundError": case "OverconstrainedError":
      return "Aucun micro détecté. Branche un micro ou vérifie les réglages son de ton appareil.";
    case "NotReadableError": case "AbortError":
      return "Le micro est déjà utilisé par une autre application (visio, dictaphone…). Ferme-la puis réessaie.";
    default:
      return "Impossible d'ouvrir le micro. Vérifie qu'il est branché et autorisé, puis réessaie.";
  }
}

/**
 * Bilan d'un enregistrement terminé → message pour l'élève (null si tout va bien).
 * stats : { chunks, empty, ok, errors: [messages], segments, maxLevel, seconds }
 */
export function outcomeMessage(stats) {
  if (stats.segments > 0) return null;
  if (stats.chunks === 0 || stats.empty === stats.chunks) {
    return { kind: "empty", title: "L'enregistrement est vide",
      text: "Ton navigateur n'a enregistré aucun son. Vérifie que le bon micro est choisi et autorisé, puis recommence." };
  }
  if (stats.errors.length) {
    return { kind: "service", title: "La transcription n'a pas pu se faire",
      text: `${stats.errors[stats.errors.length - 1]} Ton enregistrement n'a pas été gardé : recommence dans un moment.` };
  }
  if (stats.maxLevel < VOICE_LEVEL) {
    return { kind: "silent-mic", title: "Le micro n'a capté aucun son",
      text: "Le niveau sonore est resté à zéro pendant tout l'enregistrement : le micro est peut-être coupé ou ce n'est pas le bon. Vérifie-le, puis recommence." };
  }
  return { kind: "no-speech", title: "Aucune parole reconnue",
    text: "Le son a bien été reçu et analysé, mais aucune phrase n'a été reconnue. Parle plus près du micro, sans bruit de fond fort, puis recommence." };
}

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
  const pendingStops = new Set(); // tranches arrêtées dont le navigateur n'a pas encore livré le son
  const stats = { chunks: 0, empty: 0, ok: 0, errors: [], segments: 0, maxLevel: 0, seconds: 0 };
  let lastVoiceAt = 0;
  const mime = pickMime();

  // ----- Interface -----
  const timeEl = h("p", { class: "rec-time", "aria-live": "off" }, "0:00");
  const status = h("p", { class: "muted", role: "status" }, "Appuie sur le micro pour commencer.");
  const level = h("div", { class: "bar level", role: "meter", "aria-label": "Niveau sonore du micro", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, h("span"));
  const levelHint = h("p", { class: "small level-hint", "aria-live": "polite" }, "");
  const result = h("div");
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
    const item = queue.shift();
    const { index } = item;
    let blob = item.blob;
    item.blob = null;
    const prev = segments.slice(-3).map((s) => `${s.speaker} : ${s.text}`).join("\n").slice(-580);
    let done = false;
    debug("tranche", index, blob.size, "octets", blob.type);
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      try {
        const res = await api(`/api/ai/transcribe?index=${index}&prev=${encodeURIComponent(prev)}`, {
          method: "POST", body: blob, headers: { "Content-Type": blob.type.split(";")[0] || "audio/webm" },
        });
        debug("tranche", index, "→", res.segments.length, "segments, son reçu :", res.duration, "s");
        segments.push(...res.segments);
        showSegments(res.segments);
        stats.ok++;
        stats.segments += res.segments.length;
        done = true;
      } catch (err) {
        debug("tranche", index, "erreur", err.status, err.code);
        const final = err instanceof ApiError && (FINAL_CODES.has(err.code) || (err.status >= 400 && err.status < 500 && err.status !== 429));
        if (final || attempt === 3) {
          failed++;
          if (err.code === "empty_audio") stats.empty++;
          else stats.errors.push(err.message);
          const marker = { speaker: "Studoo", text: `[passage non transcrit : ${err.message}]` };
          segments.push(marker);
          showSegments([marker]);
          break;
        }
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
    // L'audio de cette tranche n'est plus référencé nulle part (même en cas d'échec) : le navigateur l'efface.
    blob = null;
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
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    recorder = rec;
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    // La dernière tranche n'arrive qu'APRÈS rec.stop() (événements dataavailable puis stop) : on garde une promesse
    // pour que « Terminer » l'attende au lieu de conclure sur une file vide.
    const delivered = new Promise((resolve) => {
      rec.onstop = () => {
        if (!aborted) {
          stats.chunks++;
          const blob = new Blob(parts, { type: rec.mimeType || mime || "audio/webm" });
          parts.length = 0;
          if (blob.size < MIN_BYTES) {
            stats.empty++;
            debug("tranche vide ignorée", blob.size, "octets");
          } else {
            queue.push({ blob, index: chunkIndex++ });
            transcribeNext();
          }
        }
        resolve();
      };
    });
    pendingStops.add(delivered);
    delivered.then(() => pendingStops.delete(delivered));
    rec.start();
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
    const startedLevel = Date.now();
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      const value = Math.min(1, peak / 64);
      if (!paused) stats.maxLevel = Math.max(stats.maxLevel, value);
      if (value >= VOICE_LEVEL) lastVoiceAt = Date.now();
      level.firstChild.style.width = `${Math.round(value * 100)}%`;
      level.setAttribute("aria-valuenow", String(Math.round(value * 100)));
      level.classList.toggle("hearing", Date.now() - lastVoiceAt < 600);
      const quietFor = Date.now() - Math.max(lastVoiceAt, startedLevel);
      const hint = paused ? "" : quietFor > 4000
        ? "Je n'entends rien : vérifie que le micro est branché, autorisé et pas coupé."
        : lastVoiceAt ? "Le micro capte bien le son ✓" : "";
      if (levelHint.textContent !== hint) levelHint.textContent = hint;
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  async function start() {
    try {
      // Réduction de bruit et annulation d'écho : faites pour les appels, elles peuvent couper la voix d'un
      // professeur éloigné. On les désactive ; le gain automatique reste (voix faibles).
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    } catch (err) {
      showResult({ kind: "mic", title: "Micro inaccessible", text: micErrorMessage(err) });
      return;
    }
    mount(result);
    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (running && !stopping) toast("Le micro s'est déconnecté : l'enregistrement s'arrête.", "error", 8000), stop();
    });
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

  function showResult(msg) {
    mount(result, h("section", { class: "card sketch stack rec-result", role: "alert" },
      h("h2", {}, icon("alert-triangle"), " ", msg.title),
      h("p", {}, msg.text),
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", onclick: () => go(location.pathname, { replace: true }) }, icon("refresh"), "Recommencer"),
        msg.kind === "service" ? null : h("a", { class: "btn", href: "https://support.google.com/chrome/answer/2693767", target: "_blank", rel: "noopener" }, icon("microphone"), "Vérifier le micro"))));
  }

  async function stop() {
    if (!running || stopping) return;
    stopping = true;
    if (!paused) elapsedBefore += Date.now() - segmentStart;
    stats.seconds = Math.round(elapsedBefore / 1000);
    recorder.stop();
    // Attend que TOUTES les tranches arrêtées soient livrées (sinon : « aucune parole » sur un enregistrement court)
    await Promise.all([...pendingStops]);
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
    debug("bilan", JSON.stringify(stats));
    if (!real.length) {
      showResult(outcomeMessage(stats));
      status.textContent = "";
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
      recBtn, timeEl, level, levelHint, status,
      h("div", { class: "row", style: { justifyContent: "center", marginTop: "14px" } }, pauseBtn, stopBtn),
      h("p", { class: "small muted", style: { marginTop: "12px" } }, "Pose ton téléphone près du prof, écran allumé. Durée maximale : 2 h.")),
    result,
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

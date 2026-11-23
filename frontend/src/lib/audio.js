// Audio : découpage des textes pour la synthèse vocale, appels TTS, encodage MP3.
import { api } from "./api.js";

const SEGMENT_CHARS = 1300;

/** Regroupe des répliques en segments d'environ une minute de parole. */
export function splitLines(lines, maxChars = SEGMENT_CHARS, maxLines = 20) {
  const segments = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    const text = line.text.length > maxChars ? line.text.slice(0, maxChars) : line.text;
    if (current.length && (size + text.length > maxChars || current.length >= maxLines)) {
      segments.push(current);
      current = [];
      size = 0;
    }
    current.push({ ...line, text });
    size += text.length;
  }
  if (current.length) segments.push(current);
  return segments;
}

/** Appelle la synthèse vocale Gemini : renvoie un Int16Array (PCM mono) et la fréquence. */
export async function tts(lines, voices) {
  const res = await api("/api/ai/tts", { method: "POST", json: { lines, voices }, raw: true });
  const rate = Number(res.headers.get("X-Sample-Rate") || 24000);
  const buf = await res.arrayBuffer();
  return { pcm: new Int16Array(buf, 0, Math.floor(buf.byteLength / 2)), rate };
}

export function concatPcm(parts, gapSamples = 0) {
  const total = parts.reduce((n, p) => n + p.length + gapSamples, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length + gapSamples;
  }
  return out;
}

/** Encode du PCM 16 bits mono en MP3 (bibliothèque lamejs, 100 % dans le navigateur). */
export async function encodeMp3(pcm, rate, kbps = 64, onProgress) {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const enc = new Mp3Encoder(1, rate, kbps);
  const chunks = [];
  const block = 1152 * 20;
  for (let i = 0; i < pcm.length; i += block) {
    const out = enc.encodeBuffer(pcm.subarray(i, i + block));
    if (out.length) chunks.push(new Uint8Array(out));
    if (i % (block * 50) === 0) {
      onProgress?.(i / pcm.length);
      await new Promise((r) => setTimeout(r)); // laisse respirer l'interface
    }
  }
  const end = enc.flush();
  if (end.length) chunks.push(new Uint8Array(end));
  return new Blob(chunks, { type: "audio/mpeg" });
}

/** Convertit du PCM Int16 en Float32 (pour WebAudio / WebCodecs). */
export function toFloat32(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

// ---------- Voix du navigateur (repli gratuit et illimité) ----------
export function browserVoices(lang = "fr") {
  const all = window.speechSynthesis?.getVoices() || [];
  const local = all.filter((v) => v.lang?.toLowerCase().startsWith(lang));
  return local.length ? local : all;
}

/** Lit une liste de répliques avec deux voix du navigateur. Renvoie un contrôleur. */
export function speakLines(lines, { lang = "fr-FR", onLine } = {}) {
  const synth = window.speechSynthesis;
  let index = 0;
  let stopped = false;
  const voices = browserVoices(lang.slice(0, 2));
  const voiceFor = (speaker) => voices.length ? voices[speaker === "B" ? Math.min(1, voices.length - 1) : 0] : null;
  const next = () => {
    if (stopped || index >= lines.length) { onLine?.(-1); return; }
    const line = lines[index];
    const u = new SpeechSynthesisUtterance(line.text);
    u.lang = lang;
    const v = voiceFor(line.speaker);
    if (v) u.voice = v;
    u.pitch = line.speaker === "B" ? 0.9 : 1.1;
    u.rate = 1.02;
    u.onend = () => { index++; next(); };
    onLine?.(index);
    synth.speak(u);
  };
  return {
    play() { stopped = false; if (synth.paused) synth.resume(); else if (!synth.speaking) next(); },
    pause() { synth.pause(); },
    stop() { stopped = true; synth.cancel(); },
    seek(i) { synth.cancel(); index = Math.max(0, Math.min(lines.length - 1, i)); stopped = false; setTimeout(next, 50); },
    get index() { return index; },
  };
}

// Audio : découpage des textes et lecture par la voix du navigateur (anciens podcasts « script »).

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

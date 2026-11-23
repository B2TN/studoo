// Formatage des dates, durées et tailles en français.

const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });

export function relativeDate(iso, now = new Date()) {
  const d = new Date(iso);
  const diff = (d - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "à l'instant";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export const time = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
export const longDate = (d = new Date()) => {
  const s = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function bytes(n) {
  const v = Number(n || 0);
  if (v < 1024) return `${v} o`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(0)} Ko`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1).replace(".", ",")} Mo`;
  return `${(v / 1024 ** 3).toFixed(1).replace(".", ",")} Go`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n > 1 ? many : one}`;
}

/** Transcription → Markdown : « **Professeur :** texte ». */
export function transcriptToMarkdown(title, segments) {
  const lines = [`# ${title}`, ""];
  let last = null;
  for (const seg of segments) {
    if (seg.speaker === last && lines.length) {
      lines[lines.length - 2] += ` ${seg.text}`;
      continue;
    }
    lines.push(`**${seg.speaker} :** ${seg.text}`, "");
    last = seg.speaker;
  }
  return lines.join("\n");
}

/** Mini-rendu Markdown sûr (titres, gras, italique, listes, paragraphes) en éléments DOM. */
export function renderMarkdown(md, h) {
  const out = [];
  let list = null;
  const inline = (text) => {
    const parts = [];
    const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      parts.push(m[1] ? h("strong", {}, m[1]) : h("em", {}, m[2]));
      last = re.lastIndex;
    }
    parts.push(text.slice(last));
    return parts;
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { list ||= h("ul", {}); list.append(h("li", {}, inline(li[1]))); continue; }
    if (list) { out.push(list); list = null; }
    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    if (head) out.push(h(`h${Math.min(4, head[1].length + 1)}`, {}, inline(head[2])));
    else if (line.trim()) out.push(h("p", {}, inline(line)));
  }
  if (list) out.push(list);
  return out;
}

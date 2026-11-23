// Cœur du connecteur Pronote (Node.js), séparé de la fonction Vercel pour être testable.
//
// Principe de sécurité :
//  - le mot de passe (ou le code PIN du QR code) n'est utilisé qu'une fois puis oublié ;
//  - si Pronote fournit un lien iCal personnel, on renvoie ce lien : plus besoin
//    de se reconnecter, la synchro passe par le lien (rien d'autre n'est gardé) ;
//  - sinon on renvoie un « jeton de reconnexion » CHIFFRÉ (AES-256-GCM) que le
//    navigateur range dans le Drive de l'élève. Seul notre serveur peut le lire.
import crypto from "node:crypto";

const enc = (s) => Buffer.from(s, "utf8");

function derive(label) {
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 32) throw new Error("SESSION_SECRET manquant");
  return crypto.createHmac("sha256", enc(secret)).update(enc(label)).digest();
}

/** Vérifie le jeton de service signé par l'API Python ; renvoie l'id utilisateur. */
export function verifyServiceToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".", 2);
  const expected = crypto.createHmac("sha256", derive("service-token")).update(enc(payload)).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data.exp || data.exp < Date.now() / 1000) return null;
  return data.sub || null;
}

/** Chiffre les infos de reconnexion, liées à l'utilisateur (impossible à réutiliser par un autre). */
export function sealRefresh(info, sub) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", derive("pronote-blob"), iv);
  cipher.setAAD(enc(sub));
  const body = Buffer.concat([cipher.update(enc(JSON.stringify(info))), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function openRefresh(blob, sub) {
  const raw = Buffer.from(String(blob), "base64url");
  if (raw.length < 29) throw new Error("bad_blob");
  const decipher = crypto.createDecipheriv("aes-256-gcm", derive("pronote-blob"), raw.subarray(0, 12));
  decipher.setAAD(enc(sub));
  decipher.setAuthTag(raw.subarray(12, 28));
  const out = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  return JSON.parse(out.toString("utf8"));
}

/** Convertit les cours Pronote dans le même format que nos événements .ics. */
export function toEvents(classes) {
  return classes
    .filter((c) => c.is === "lesson" || c.is === "activity")
    .map((c) => {
      const subject = c.is === "lesson" ? (c.subject?.name || "Cours") : (c.title || "Activité");
      const teachers = c.teacherNames?.join(", ") || "";
      return {
        uid: `pronote-${c.id}`,
        title: teachers ? `${subject} - ${teachers}` : subject,
        subject: prettySubject(subject),
        start: new Date(c.startDate).toISOString(),
        end: new Date(c.endDate).toISOString(),
        location: (c.classrooms || []).join(", "),
        description: c.status || "",
        cancelled: Boolean(c.canceled),
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function prettySubject(name) {
  const s = String(name).trim();
  if (s.length <= 4) return s.toUpperCase();
  const lower = s.toLowerCase();
  const fixes = {
    "mathematiques": "Mathématiques", "francais": "Français", "histoire-geographie": "Histoire-Géographie",
    "physique-chimie": "Physique-Chimie", "anglais lv1": "Anglais", "espagnol lv2": "Espagnol",
  };
  if (fixes[lower]) return fixes[lower];
  return s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s;
}

/** Valide le contenu d'un QR code Pronote (JSON avec url, jeton, login). */
export function parseQr(raw) {
  let qr = raw;
  if (typeof raw === "string") {
    try { qr = JSON.parse(raw); } catch { return null; }
  }
  if (!qr || typeof qr !== "object") return null;
  const { url, jeton, login } = qr;
  if (typeof url !== "string" || !/^https:\/\/[^/]+\//.test(url)) return null;
  if (typeof jeton !== "string" || typeof login !== "string") return null;
  return { ...qr };
}

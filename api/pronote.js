// Fonction Vercel (Node) : connecteur Pronote non officiel, basé sur Pawnote.
// POST /api/pronote  { action: "qr" | "credentials" | "sync", ... }
import crypto from "node:crypto";
import * as pronote from "pawnote";
import { openRefresh, parseQr, sealRefresh, toEvents, verifyServiceToken } from "../lib/pronote-core.js";

const WEEKS_AHEAD = 5;

function fail(res, status, code, message) {
  res.status(status).json({ detail: { code, message } });
}

async function readTimetable(session) {
  const start = new Date();
  start.setDate(start.getDate() - 7);
  const end = new Date();
  end.setDate(end.getDate() + WEEKS_AHEAD * 7);
  const timetable = await pronote.timetableFromIntervals(session, start, end);
  pronote.parseTimetable(session, timetable, { withCanceledClasses: true, withPlannedClasses: true, withSuperposedCanceledClasses: false });
  return toEvents(timetable.classes);
}

async function icalUrl(session) {
  try {
    const acc = await pronote.account(session);
    if (acc?.iCalToken) return pronote.timetableICalURL(session, acc.iCalToken, "studoo");
  } catch {
    // instance trop ancienne ou fonction iCal désactivée : on passe au plan B
  }
  return null;
}

function explain(err) {
  const name = err?.constructor?.name || "";
  if (name === "BadCredentialsError") return [401, "bad_credentials", "Identifiants ou code PIN incorrects."];
  if (name === "SuspendedIPError" || name === "RateLimitedError") return [429, "pronote_limited", "Pronote bloque temporairement les connexions. Réessaie plus tard."];
  if (name === "AccountDisabledError") return [403, "account_disabled", "Ce compte Pronote est désactivé."];
  if (name === "SessionExpiredError") return [401, "token_expired", "La connexion Pronote a expiré : reconnecte-toi avec un nouveau QR code."];
  return [502, "pronote_error", "Pronote n'a pas répondu comme prévu. Utilise plutôt le lien iCal (tutoriel dans la page)."];
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") return fail(res, 405, "method", "Méthode non autorisée.");
  if (req.headers["x-studoo"] !== "1") return fail(res, 403, "csrf", "Requête refusée.");
  const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const sub = verifyServiceToken(auth);
  if (!sub) return fail(res, 401, "not_logged_in", "Connecte-toi pour continuer.");

  const body = typeof req.body === "object" && req.body ? req.body : {};
  const session = pronote.createSessionHandle();

  try {
    let refresh;
    const deviceUUID = typeof body.deviceUUID === "string" && /^[\w-]{8,64}$/.test(body.deviceUUID)
      ? body.deviceUUID : crypto.randomUUID();

    if (body.action === "qr") {
      const qr = parseQr(body.qr);
      if (!qr || !/^\d{4}$/.test(String(body.pin || ""))) return fail(res, 422, "bad_qr", "QR code ou code PIN invalide.");
      refresh = await pronote.loginQrCode(session, { deviceUUID, pin: String(body.pin), qr });
    } else if (body.action === "credentials") {
      const { url, username, password } = body;
      if (typeof url !== "string" || !/^https:\/\//.test(url) || !username || !password) {
        return fail(res, 422, "invalid", "Adresse Pronote, identifiant et mot de passe requis.");
      }
      refresh = await pronote.loginCredentials(session, {
        url: pronote.cleanURL(url), kind: pronote.AccountKind.STUDENT,
        username: String(username).slice(0, 120), password: String(password).slice(0, 200), deviceUUID,
      });
    } else if (body.action === "sync") {
      let info;
      try { info = openRefresh(body.blob, sub); } catch { return fail(res, 422, "bad_blob", "Connexion Pronote à refaire."); }
      refresh = await pronote.loginToken(session, { ...info.refresh, deviceUUID: info.deviceUUID });
    } else {
      return fail(res, 422, "invalid", "Action inconnue.");
    }

    const url = await icalUrl(session);
    const events = await readTimetable(session);
    // Si on a un lien iCal, aucune donnée de reconnexion n'est renvoyée.
    const blob = url ? null : sealRefresh({ refresh: { url: refresh.url, username: refresh.username, token: refresh.token, kind: refresh.kind }, deviceUUID }, sub);
    return res.status(200).json({ icalUrl: url, blob, events, subjects: [...new Set(events.map((e) => e.subject))].sort() });
  } catch (err) {
    const [status, code, message] = explain(err);
    return fail(res, status, code, message);
  }
}

// Appels à notre API (même domaine). Ajoute l'en-tête anti-CSRF et
// transforme les erreurs du serveur en messages lisibles.

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail?.message || "Une erreur est survenue. Réessaie.");
    this.status = status;
    this.code = detail?.code || "error";
    this.errors = detail?.errors || [];
  }
}

/** Mesures en local uniquement : simule l'aller-retour vers le serveur en ligne. */
async function simulatedLatency() {
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return;
  let ms = 0;
  try { ms = Number(localStorage.getItem("studoo-latence") || 0); } catch { /* indisponible */ }
  if (ms) await new Promise((r) => setTimeout(r, ms));
}

/**
 * Identifiant au hasard de ce navigateur (itération 7) : le serveur n'en garde qu'une empreinte chiffrée,
 * utilisée seulement pour bloquer un appareil en cas d'abus. Il ne permet pas de suivre quelqu'un sur d'autres
 * sites, et il disparaît si l'on vide les données du site.
 */
export function deviceId() {
  try {
    let id = localStorage.getItem("studoo-device");
    if (!id) {
      id = (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/[^a-z0-9-]/gi, "");
      localStorage.setItem("studoo-device", id);
    }
    return id;
  } catch {
    return "";
  }
}

/** Compte supprimé ou banni pendant que la page est ouverte : on ferme la session proprement, avec un message. */
let ending = false;
function endSession(detail) {
  if (ending || typeof document === "undefined") return;
  ending = true;
  const box = document.createElement("div");
  box.className = "stale-banner";
  box.setAttribute("role", "alert");
  box.textContent = detail?.message || "Ta session est terminée.";
  document.body.append(box);
  fetch("/api/auth/logout", { method: "POST", headers: { "X-Studoo": "1" }, credentials: "same-origin" })
    .catch(() => {}).finally(() => setTimeout(() => location.assign("/"), 4000));
}

export async function api(path, { method = "GET", json, body, headers = {}, raw = false, signal } = {}) {
  const device = deviceId();
  const init = { method, headers: { "X-Studoo": "1", ...(device ? { "X-Studoo-Device": device } : {}), ...headers },
    credentials: "same-origin", signal };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    init.body = body;
  }
  let res;
  try {
    await simulatedLatency();
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError(0, { code: "offline", message: "Pas de connexion Internet." });
  }
  if (!res.ok) {
    let detail = null;
    try { detail = (await res.json()).detail; } catch { /* réponse non JSON */ }
    if (typeof detail === "string") detail = { message: detail };
    if (detail?.code === "banned" || detail?.code === "account_deleted") endSession(detail);
    throw new ApiError(res.status, detail || { message: `Erreur ${res.status}` });
  }
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
}

let configPromise;
export function getConfig() {
  configPromise ||= api("/api/config").catch(() => ({ appName: "Studoo", googleClientId: "", devLogin: false, aiFake: false }));
  return configPromise;
}

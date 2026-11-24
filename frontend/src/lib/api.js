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

export async function api(path, { method = "GET", json, body, headers = {}, raw = false, signal } = {}) {
  const init = { method, headers: { "X-Studoo": "1", ...headers }, credentials: "same-origin", signal };
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

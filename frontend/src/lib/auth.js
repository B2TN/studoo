// Connexion Google et jetons d'accès Drive.
//
// On utilise « Google Identity Services » en mode *code* : Google donne un
// code à usage unique que notre serveur échange (avec son secret) contre les
// jetons. Le navigateur ne voit jamais le secret ni le refresh token.
import { api, ApiError, getConfig } from "./api.js";
import { clearAllCaches } from "./cache.js";

export const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"].join(" ");

let currentUser = null;
let token = readToken(); // { value, expiresAt } — gardé le temps de l'onglet (sessionStorage)
let tokenPromise = null;

function readToken() {
  try { return JSON.parse(sessionStorage.getItem("studoo-token")); } catch { return null; }
}
function saveToken(t) {
  token = t;
  try {
    if (t) sessionStorage.setItem("studoo-token", JSON.stringify(t));
    else sessionStorage.removeItem("studoo-token");
  } catch { /* ignoré */ }
}

/** Dernier utilisateur connu sur cet appareil (pour afficher l'appli sans attendre le serveur). */
export function cachedUser() {
  try { return JSON.parse(localStorage.getItem("studoo-user")); } catch { return null; }
}
function saveUser(user) {
  try {
    if (user) localStorage.setItem("studoo-user", JSON.stringify(user));
    else localStorage.removeItem("studoo-user");
  } catch { /* ignoré */ }
}

export const getUser = () => currentUser;
export const isLoggedFlag = () => document.cookie.split("; ").includes("studoo_in=1");

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Impossible de charger Google. Vérifie ta connexion ou ton bloqueur de pubs."));
    document.head.append(s);
  });
}

function askCode(clientId, prompt) {
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: SCOPES,
      ux_mode: "popup",
      select_account: prompt !== "consent",
      prompt: prompt || "",
      callback: (resp) => (resp.error ? reject(new Error(resp.error)) : resolve(resp.code)),
      error_callback: (err) => reject(new Error(err?.type === "popup_closed" ? "Fenêtre Google fermée." : "Connexion annulée.")),
    });
    client.requestCode();
  });
}

function remember(result) {
  currentUser = result.user;
  saveUser(currentUser);
  if (result.accessToken) saveToken({ value: result.accessToken, expiresAt: Date.now() + (result.expiresIn - 60) * 1000 });
  return currentUser;
}

/** Ouvre la fenêtre Google et crée la session. */
export async function signIn() {
  const cfg = await getConfig();
  if (!cfg.googleClientId && cfg.devLogin) return remember(await api("/api/auth/dev-login", { method: "POST" }));
  if (!cfg.googleClientId) throw new Error("La connexion Google n'est pas encore configurée sur ce site.");
  await loadGis();
  let code = await askCode(cfg.googleClientId);
  try {
    return remember(await api("/api/auth/google", { method: "POST", json: { code } }));
  } catch (err) {
    if (err instanceof ApiError && err.code === "need_consent") {
      code = await askCode(cfg.googleClientId, "consent");
      return remember(await api("/api/auth/google", { method: "POST", json: { code } }));
    }
    throw err;
  }
}

/** Vérifie la session existante (au chargement de la page). */
export async function restore() {
  try {
    const { user } = await api("/api/auth/me");
    currentUser = user || null;
    saveUser(currentUser);
    if (!currentUser) clearAllCaches();
    return currentUser;
  } catch (err) {
    // Hors ligne : on garde la dernière session connue plutôt que de déconnecter.
    if (err instanceof ApiError && err.code === "offline") return cachedUser();
    currentUser = null;
    return null;
  }
}

/** Jeton d'accès Drive valide (rafraîchi automatiquement). */
export async function accessToken() {
  if (token && token.expiresAt > Date.now()) return token.value;
  // Un seul appel même si plusieurs parties de la page demandent un jeton en même temps.
  tokenPromise ||= api("/api/auth/token", { method: "POST" })
    .then((data) => {
      saveToken({ value: data.accessToken, expiresAt: Date.now() + (data.expiresIn - 60) * 1000 });
      return token.value;
    })
    .finally(() => { tokenPromise = null; });
  return tokenPromise;
}

export function invalidateToken() {
  saveToken(null);
}

export async function signOut() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  currentUser = null;
  saveToken(null);
  clearAllCaches();
  location.href = "/";
}

export async function deleteAccount() {
  await api("/api/auth/account", { method: "DELETE" });
  currentUser = null;
  saveToken(null);
  clearAllCaches();
}

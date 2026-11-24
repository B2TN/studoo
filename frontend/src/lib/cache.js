// Petit cache local « affiche d'abord, rafraîchis ensuite » (stale-while-revalidate).
//
// Idée : à la visite suivante, on montre tout de suite les dernières données
// connues (cours, fichiers récents, emploi du temps), puis on les met à jour
// en arrière-plan. La page paraît instantanée même si Google Drive est lent.
// Tout est rangé dans le navigateur de l'élève et effacé à la déconnexion.

const PREFIX = "studoo-cache:";
let scope = "anon"; // identifiant de l'utilisateur (un cache par compte)

export function setCacheScope(sub) {
  scope = sub || "anon";
}

const fullKey = (key) => `${PREFIX}${scope}:${key}`;

export function readCache(key, maxAgeMs = Infinity) {
  try {
    const raw = localStorage.getItem(fullKey(key));
    if (!raw) return null;
    const { at, value } = JSON.parse(raw);
    return Date.now() - at <= maxAgeMs ? { value, at } : null;
  } catch {
    return null;
  }
}

export function writeCache(key, value) {
  try {
    localStorage.setItem(fullKey(key), JSON.stringify({ at: Date.now(), value }));
  } catch { /* stockage plein ou bloqué : tant pis, on fera sans cache */ }
}

export function dropCache(key) {
  try { localStorage.removeItem(fullKey(key)); } catch { /* ignoré */ }
}

/** Efface tout ce que Studoo a mis en cache (déconnexion, suppression du compte). */
export function clearAllCaches() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX) || k === "studoo-user") localStorage.removeItem(k);
    for (const k of Object.keys(sessionStorage)) if (k.startsWith("studoo-")) sessionStorage.removeItem(k);
  } catch { /* ignoré */ }
}

/**
 * Renvoie tout de suite la valeur en cache (ou null) et lance `fetcher` en arrière-plan.
 * `onFresh(value)` est appelé quand la valeur fraîche arrive ET qu'elle a changé.
 */
export function swr(key, fetcher, onFresh, { maxAgeMs = 7 * 86400e3 } = {}) {
  const cached = readCache(key, maxAgeMs);
  const fresh = Promise.resolve()
    .then(fetcher)
    .then((value) => {
      const changed = !cached || JSON.stringify(cached.value) !== JSON.stringify(value);
      writeCache(key, value);
      if (changed) onFresh?.(value);
      return value;
    });
  return { cached: cached ? cached.value : null, fresh };
}

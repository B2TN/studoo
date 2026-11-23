// Documents « en attente de rangement » (entre l'enregistrement/la numérisation
// et la page de confirmation). Gardés en mémoire seulement.
const items = new Map();

/**
 * @param {object} doc
 * @param {"transcript"|"scan"|"pdf"} doc.kind
 * @param {string} doc.excerpt  texte pour deviner le cours
 * @param {string} [doc.startedAt]  date ISO (pour l'emploi du temps)
 * @param {(folderId: string, title: string) => Promise<object>} doc.save  enregistre dans le Drive
 */
export function addPending(doc) {
  const id = crypto.randomUUID();
  items.set(id, { ...doc, id });
  return id;
}
export const getPending = (id) => items.get(id) || null;
export const dropPending = (id) => items.delete(id);

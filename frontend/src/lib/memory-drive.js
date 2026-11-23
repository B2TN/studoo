// Faux Google Drive en mémoire : même interface que drive.js.
// Sert aux tests automatiques et à la démo locale (connexion « dev »).
// Tout disparaît quand on recharge la page.

let seq = 0;
const newId = () => `mem${Date.now().toString(36)}${(seq++).toString(36)}xxxxxxxxxxxx`.slice(0, 24);

export function createMemoryDrive({ seed = false } = {}) {
  const items = new Map(); // id → { meta, blob }
  const now = () => new Date().toISOString();

  function put(meta, blob = null) {
    const id = meta.id || newId();
    const full = { id, createdTime: now(), modifiedTime: now(), appProperties: {}, ...meta, size: blob ? String(blob.size) : undefined };
    items.set(id, { meta: full, blob });
    return { ...full };
  }
  const metas = () => [...items.values()].map((i) => i.meta).filter((m) => !m.trashed);
  const must = (id) => {
    const item = items.get(id);
    if (!item || item.meta.trashed) throw new Error("Fichier introuvable");
    return item;
  };
  let rootId = null;

  const api = {
    kind: "memory",
    async init() {
      rootId ||= put({ name: "Studoo", mimeType: "application/vnd.google-apps.folder", appProperties: { studoo: "root" } }).id;
      return rootId;
    },
    async tree() {
      const all = metas();
      return all.filter((m) => m.appProperties.studoo === "course").sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({
        id: c.id, name: c.name, color: c.appProperties.color || "yellow",
        chapters: all.filter((m) => m.appProperties.studoo === "chapter" && m.parents[0] === c.id)
          .sort((a, b) => a.name.localeCompare(b.name)).map((ch) => ({ id: ch.id, name: ch.name, courseId: c.id })),
      }));
    },
    async createCourse(name, color = "yellow") {
      const root = await api.init();
      const f = put({ name, mimeType: "application/vnd.google-apps.folder", parents: [root], appProperties: { studoo: "course", color } });
      return { id: f.id, name, color, chapters: [] };
    },
    async createChapter(courseId, name) {
      const f = put({ name, mimeType: "application/vnd.google-apps.folder", parents: [courseId], appProperties: { studoo: "chapter" } });
      return { id: f.id, name, courseId };
    },
    async listFiles(folderId) {
      return metas().filter((m) => m.parents?.[0] === folderId)
        .sort((a, b) => (a.mimeType.endsWith("folder") === b.mimeType.endsWith("folder") ? a.name.localeCompare(b.name) : a.mimeType.endsWith("folder") ? -1 : 1));
    },
    async recent(limit = 8) {
      return metas().filter((m) => m.appProperties.studoo === "file").sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime)).slice(0, limit);
    },
    async allFiles() {
      return metas().filter((m) => m.appProperties.studoo === "file").sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
    },
    async search(text) {
      const t = text.toLowerCase();
      return metas().filter((m) => m.appProperties.studoo === "file" && m.name.toLowerCase().includes(t));
    },
    async get(id) { return { ...must(id).meta }; },
    async save({ parentId, name, mimeType, blob, kind, props = {} }) {
      return put({ name, mimeType, parents: [parentId], appProperties: { studoo: "file", kind, ...props } }, blob);
    },
    async updateContent(id, blob) {
      const item = must(id);
      item.blob = blob;
      item.meta.modifiedTime = now();
      item.meta.size = String(blob.size);
      return { ...item.meta };
    },
    async readBlob(id) { return must(id).blob; },
    async readText(id) { return must(id).blob.text(); },
    async readJson(id) { return JSON.parse(await api.readText(id)); },
    async rename(id, name) { const i = must(id); i.meta.name = name; i.meta.modifiedTime = now(); return { ...i.meta }; },
    async setProps(id, props) { const i = must(id); Object.assign(i.meta.appProperties, props); return { ...i.meta }; },
    async move(id, fromId, toId) { const i = must(id); i.meta.parents = [toId]; return { ...i.meta }; },
    async trash(id) { must(id).meta.trashed = true; },
    async findSettings() { return metas().find((m) => m.appProperties.kind === "settings") || null; },
    openUrl: () => "#",
  };

  api.ready = seed ? seedDemo(api) : Promise.resolve();
  return api;
}

const md = (s) => new Blob([s], { type: "text/markdown" });

async function seedDemo(d) {
  const root = await d.init();
  await d.save({
    parentId: root, name: "studoo-reglages.json", mimeType: "application/json", kind: "settings",
    blob: new Blob([JSON.stringify({ version: 1, recordingConsent: null, timetable: { sources: [{ id: "demo", type: "demo", label: "Emploi du temps de démonstration" }] }, voices: { A: "Kore", B: "Puck" } })], { type: "application/json" }),
  });
  const maths = await d.createCourse("Mathématiques", "pink");
  const suites = await d.createChapter(maths.id, "Ch. 3 — Suites");
  await d.createChapter(maths.id, "Ch. 4 — Fonction exponentielle");
  const hist = await d.createCourse("Histoire-Géographie", "green");
  const gf = await d.createChapter(hist.id, "Ch. 2 — La guerre froide");
  const ang = await d.createCourse("Anglais", "blue");
  await d.createChapter(ang.id, "Ch. 1 — Grammar");
  const phys = await d.createCourse("Physique-Chimie", "orange");
  await d.createChapter(phys.id, "Ch. 1 — Électricité");

  await d.save({
    parentId: suites.id, name: "Introduction aux suites géométriques.md", mimeType: "text/markdown", kind: "transcript",
    blob: md("# Introduction aux suites géométriques\n\n**Professeur :** Aujourd'hui on commence les suites géométriques. Une suite est géométrique si on passe d'un terme au suivant en multipliant toujours par le même nombre, la raison q.\n\n**Élève :** Donc u(n+1) = q × u(n) ?\n\n**Professeur :** Exactement. Et le terme général s'écrit u(n) = u(0) × q^n. Attention à ne pas confondre avec les suites arithmétiques où l'on ajoute la raison.\n\n**Élève 2 :** Et si q est entre 0 et 1, la suite diminue ?\n\n**Professeur :** Si u(0) est positif, oui : elle est décroissante et tend vers 0.\n"),
  });
  await d.save({
    parentId: gf.id, name: "La guerre froide (1947-1991).md", mimeType: "text/markdown", kind: "transcript",
    blob: md("# La guerre froide (1947-1991)\n\n**Professeur :** La guerre froide oppose les États-Unis et l'URSS de 1947 à 1991, sans affrontement direct entre eux.\n\n**Élève :** Pourquoi « froide » ?\n\n**Professeur :** Parce que les deux superpuissances ne se font jamais la guerre directement : elles s'affrontent par alliés interposés, comme en Corée, et par la course aux armements.\n"),
  });
}

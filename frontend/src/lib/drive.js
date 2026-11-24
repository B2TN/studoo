// Stockage dans le Google Drive de l'utilisateur (API REST v3).
//
// Avec l'autorisation « drive.file », Studoo ne voit QUE les fichiers qu'il a
// créés. Chaque fichier porte des « appProperties » (étiquettes invisibles)
// qui disent ce qu'il est : cours, chapitre, transcription, fiche…
import { accessToken, invalidateToken } from "./auth.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,modifiedTime,createdTime,size,appProperties,parents";

export class DriveError extends Error {}

async function call(url, init = {}, retry = true) {
  const token = await accessToken();
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (res.status === 401 && retry) {
    invalidateToken();
    return call(url, init, false);
  }
  if (!res.ok) {
    let msg = `Google Drive a répondu ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch { /* ignoré */ }
    if (res.status === 403 && /quota|storage/i.test(msg)) msg = "Ton Google Drive est plein.";
    throw new DriveError(msg);
  }
  return res;
}

const q = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function list(query, { orderBy = "folder,name", pageSize = 200 } = {}) {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ q: query, fields: `nextPageToken,files(${FIELDS})`, orderBy, pageSize: String(pageSize), spaces: "drive" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await call(`${API}/files?${params}`)).json();
    files.push(...data.files);
    pageToken = data.nextPageToken || "";
  } while (pageToken && files.length < 2000);
  return files;
}

const byProp = (key, value) => `appProperties has { key='${key}' and value='${q(value)}' } and trashed = false`;

export function createGoogleDrive({ rootId: knownRoot = null, onRoot } = {}) {
  let rootId = knownRoot;

  async function createFolder(name, parentId, props) {
    const res = await call(`${API}/files?fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: parentId ? [parentId] : undefined, appProperties: props }),
    });
    return res.json();
  }

  async function upload({ parentId, name, mimeType, blob, props }) {
    const metadata = { name, mimeType, parents: [parentId], appProperties: props };
    if (blob.size > 4 * 1024 * 1024) {
      // Gros fichier (vidéo, podcast) : envoi « reprenable » en deux temps.
      const start = await call(`${UPLOAD}/files?uploadType=resumable&fields=${FIELDS}`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mimeType },
        body: JSON.stringify(metadata),
      });
      const location = start.headers.get("Location");
      const res = await fetch(location, { method: "PUT", body: blob });
      if (!res.ok) throw new DriveError("L'envoi vers Google Drive a échoué.");
      return res.json();
    }
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", blob);
    return (await call(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, { method: "POST", body: form })).json();
  }

  return {
    kind: "google",

    async init() {
      if (rootId) return rootId;
      const found = await list(byProp("studoo", "root"));
      rootId = found[0]?.id || (await createFolder("Studoo", null, { studoo: "root" })).id;
      onRoot?.(rootId);
      return rootId;
    },

    /** Vérifie (en arrière-plan) que le dossier mémorisé existe toujours ; sinon on le recrée. */
    async checkRoot() {
      if (!rootId) return;
      try {
        const meta = await (await call(`${API}/files/${rootId}?fields=id,trashed`)).json();
        if (!meta.trashed) return;
      } catch { /* dossier introuvable */ }
      rootId = null;
      await this.init();
    },

    async tree() {
      const [courses, chapters] = await Promise.all([list(byProp("studoo", "course")), list(byProp("studoo", "chapter"))]);
      return courses.map((c) => ({
        id: c.id, name: c.name, color: c.appProperties?.color || "yellow",
        chapters: chapters.filter((ch) => ch.parents?.includes(c.id)).map((ch) => ({ id: ch.id, name: ch.name, courseId: c.id })),
      }));
    },

    async createCourse(name, color = "yellow") {
      const root = await this.init();
      const f = await createFolder(name, root, { studoo: "course", color });
      return { id: f.id, name: f.name, color, chapters: [] };
    },

    async createChapter(courseId, name) {
      const f = await createFolder(name, courseId, { studoo: "chapter" });
      return { id: f.id, name: f.name, courseId };
    },

    async listFiles(folderId) {
      return list(`'${q(folderId)}' in parents and trashed = false`);
    },

    async recent(limit = 8) {
      const params = new URLSearchParams({
        q: byProp("studoo", "file"), orderBy: "modifiedTime desc", pageSize: String(limit), fields: `files(${FIELDS})`,
      });
      return (await (await call(`${API}/files?${params}`)).json()).files;
    },

    async allFiles() {
      return list(byProp("studoo", "file"), { orderBy: "modifiedTime desc", pageSize: 500 });
    },

    async search(text) {
      return list(`name contains '${q(text)}' and ${byProp("studoo", "file")}`, { orderBy: "modifiedTime desc", pageSize: 50 });
    },

    async get(id) {
      return (await call(`${API}/files/${id}?fields=${FIELDS}`)).json();
    },

    async save({ parentId, name, mimeType, blob, kind, props = {} }) {
      return upload({ parentId, name, mimeType, blob, props: { studoo: "file", kind, ...props } });
    },

    async updateContent(id, blob, mimeType) {
      return (await call(`${UPLOAD}/files/${id}?uploadType=media&fields=${FIELDS}`, {
        method: "PATCH", headers: { "Content-Type": mimeType }, body: blob,
      })).json();
    },

    async readBlob(id) {
      return (await call(`${API}/files/${id}?alt=media`)).blob();
    },
    async readText(id) {
      return (await call(`${API}/files/${id}?alt=media`)).text();
    },
    async readJson(id) {
      return JSON.parse(await this.readText(id));
    },

    async rename(id, name) {
      return (await call(`${API}/files/${id}?fields=${FIELDS}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      })).json();
    },

    async setProps(id, props) {
      return (await call(`${API}/files/${id}?fields=${FIELDS}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appProperties: props }),
      })).json();
    },

    async move(id, fromId, toId) {
      return (await call(`${API}/files/${id}?addParents=${toId}&removeParents=${fromId}&fields=${FIELDS}`, { method: "PATCH" })).json();
    },

    async trash(id) {
      await call(`${API}/files/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
    },

    async findSettings() {
      return (await list(byProp("kind", "settings")))[0] || null;
    },

    openUrl: (id) => `https://drive.google.com/file/d/${id}/view`,
  };
}

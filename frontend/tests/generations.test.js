// Itération 5 (C2) : « Mes générations » limitée à 5 et synchronisée avec « Mes cours » / le Drive.
import { describe, expect, it, vi } from "vitest";

const forgotten = [];
vi.mock("../src/lib/api.js", () => ({
  api: vi.fn(async (path, init) => {
    if (path === "/api/jobs/forget-file") forgotten.push(init.json.file_id);
    return {};
  }),
  getConfig: vi.fn(),
}));
const { visibleJobs, withExistingFiles } = await import("../src/lib/jobs.js");

const job = (id, status, minutesAgo, file = "") => ({
  id, status, result_file_id: file, created_at: new Date(Date.parse("2026-11-26T12:00:00Z") - minutesAgo * 60e3).toISOString(),
});

describe("limite de 5 sur l'accueil", () => {
  it("garde les 5 plus récentes, le reste dans « Voir tout »", () => {
    const jobs = Array.from({ length: 8 }, (_, i) => job(`d${i}`, "done", i));
    const { shown, hidden } = visibleJobs(jobs);
    expect(shown.map((j) => j.id)).toEqual(["d0", "d1", "d2", "d3", "d4"]);
    expect(hidden).toBe(3);
  });

  it("les générations en cours ne sont jamais cachées, même au-delà de 5", () => {
    const jobs = [...Array.from({ length: 6 }, (_, i) => job(`r${i}`, i % 2 ? "queued" : "running", 100 + i)),
      ...Array.from({ length: 4 }, (_, i) => job(`d${i}`, "done", i))];
    const { shown, hidden } = visibleJobs(jobs);
    expect(shown).toHaveLength(6);
    expect(shown.every((j) => j.status !== "done")).toBe(true);
    expect(hidden).toBe(4);
  });

  it("en cours + terminées : les terminées complètent jusqu'à 5", () => {
    const jobs = [job("r", "running", 30), job("a", "done", 1), job("b", "failed", 2), job("c", "done", 3), job("d", "done", 4), job("e", "done", 5)];
    expect(visibleJobs(jobs).shown.map((j) => j.id)).toEqual(["a", "b", "c", "d", "r"]);
  });
});

describe("une seule vérité : le fichier", () => {
  it("une génération dont le fichier a disparu du Drive n'est plus affichée et le serveur l'oublie", async () => {
    const jobs = [job("ok", "done", 1, "f-ok"), job("gone", "done", 2, "f-gone"), job("run", "running", 3), job("fail", "failed", 4)];
    const exists = vi.fn(async (id) => id !== "f-gone");
    const left = await withExistingFiles(jobs, exists);
    expect(left.map((j) => j.id)).toEqual(["ok", "run", "fail"]);
    expect(exists).toHaveBeenCalledTimes(2); // seulement les générations terminées avec un fichier
    expect(forgotten).toEqual(["f-gone"]);
    await withExistingFiles(jobs, exists);
    expect(exists).toHaveBeenCalledTimes(2); // vérifié il y a moins d'une minute : pas de nouvel appel au Drive
  });
});

describe("corbeille du faux Drive", () => {
  it("exists() suit la corbeille", async () => {
    const { createMemoryDrive } = await import("../src/lib/memory-drive.js");
    const d = createMemoryDrive();
    const root = await d.init();
    const f = await d.save({ parentId: root, name: "Podcast.mp3", mimeType: "audio/mpeg", kind: "podcast", blob: new Blob(["x"]) });
    expect(await d.exists(f.id)).toBe(true);
    await d.trash(f.id);
    expect(await d.exists(f.id)).toBe(false);
    expect(await d.exists("inconnu")).toBe(false);
  });
});

describe("Google Drive : seules les preuves définitives comptent", () => {
  it("404 ou corbeille = supprimé ; 403 (limite de requêtes) ou réseau = on garde", async () => {
    vi.resetModules();
    vi.doMock("../src/lib/auth.js", () => ({ accessToken: async () => "jeton", invalidateToken: () => {} }));
    const { createGoogleDrive } = await import("../src/lib/drive.js");
    const d = createGoogleDrive({});
    const answers = {
      a: new Response(JSON.stringify({ id: "a", trashed: false }), { status: 200 }),
      b: new Response(JSON.stringify({ id: "b", trashed: true }), { status: 200 }),
      c: new Response(JSON.stringify({ error: { message: "File not found" } }), { status: 404 }),
      e: new Response(JSON.stringify({ error: { message: "User rate limit exceeded" } }), { status: 403 }),
    };
    globalThis.fetch = vi.fn(async (url) => {
      const id = String(url).split("/files/")[1].split("?")[0];
      if (id === "net") throw new TypeError("Failed to fetch");
      return answers[id];
    });
    expect(await d.exists("a")).toBe(true);
    expect(await d.exists("b")).toBe(false);
    expect(await d.exists("c")).toBe(false);
    expect(await d.exists("e")).toBe(true);
    expect(await d.exists("net")).toBe(true);
  });
});

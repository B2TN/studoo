import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/api.js", () => ({ api: vi.fn(), getConfig: vi.fn() }));
const { etaText } = await import("../src/lib/jobs.js");
const { dedupe } = await import("../src/lib/storage.js");

const file = (id, kind, name, extra = {}) => ({
  id, name, mimeType: "audio/mpeg", parents: ["chap"], size: "1000", modifiedTime: `2026-11-2${id.length}T10:00:00Z`,
  appProperties: { studoo: "file", kind, ...extra },
});

describe("C3 : un seul fichier par contenu dans « Mes cours »", () => {
  it("cache la voix d'une vidéo et garde un seul fichier par tâche", () => {
    const list = [
      file("v", "video-anim", "Vidéo — Photo.json", { jobId: "j1", audioId: "a" }),
      file("a", "video-audio", "Vidéo — Photo (voix).mp3", { jobId: "j1" }),
      file("p1", "podcast", "Podcast — Photo.mp3", { jobId: "j2" }),
      file("p22", "podcast", "Podcast — Photo.mp3", { jobId: "j2" }), // même tâche envoyée deux fois
    ];
    const shown = dedupe(list);
    expect(shown.map((f) => f.id)).toEqual(["v", "p22"]); // le plus récent
  });

  it("dédoublonne les anciens fichiers sans identifiant de tâche, en gardant le plus récent complet", () => {
    const old = file("o1", "podcast", "Podcast — Maths.mp3");
    const empty = { ...file("o222", "podcast", "Podcast — Maths.mp3"), size: "0" }; // envoi interrompu
    const other = file("o3", "podcast", "Podcast — Physique.mp3");
    expect(dedupe([old, empty, other]).map((f) => f.id)).toEqual(["o1", "o3"]);
  });

  it("ne touche pas aux cours ordinaires de même nom", () => {
    const a = file("t1", "transcript", "Cours.md");
    const b = file("t2", "transcript", "Cours.md");
    expect(dedupe([a, b])).toHaveLength(2);
  });
});

describe("C4 : temps d'attente estimé", () => {
  it("donne une fourchette honnête", () => {
    expect(etaText({ low: 90, high: 240, ahead: 0, late: false })).toBe("Encore environ 2 à 4 min");
    expect(etaText({ low: 20, high: 50, ahead: 0, late: false })).toBe("Encore moins d'une minute");
    expect(etaText({ low: 20, high: 150, ahead: 0, late: false })).toBe("Encore moins de 3 min");
    expect(etaText({ low: 700, high: 1000, ahead: 0, late: false })).toBe("Encore environ 10 à 15 min");
  });

  it("indique la file d'attente et le retard", () => {
    expect(etaText({ low: 120, high: 300, ahead: 2, late: false })).toBe("Encore environ 2 à 5 min (2 générations avant la tienne)");
    expect(etaText({ low: 60, high: 180, ahead: 0, late: true })).toMatch(/^Un peu plus long que prévu : encore environ 1 à 3 min/);
  });
});

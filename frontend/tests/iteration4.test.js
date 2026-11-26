import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/api.js", () => ({ api: vi.fn(), getConfig: vi.fn() }));
const { etaText } = await import("../src/lib/jobs.js");
const { dedupe } = await import("../src/lib/storage.js");
const { math } = await import("../src/lib/exercise-render.js");

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

describe("C5 : formules lisibles", () => {
  it("met les indices et exposants en forme sans HTML injecté", () => {
    const html = (parts) => parts.map((p) => (typeof p === "string" ? p : p.outerHTML)).join("");
    expect(html(math("u_{n+1} = q × u_n et 2^n, q^(n+1)"))).toBe("u<sub>n+1</sub> = q × u<sub>n</sub> et 2<sup>n</sup>, q<sup>n+1</sup>");
    expect(html(math("<b>x</b>_1"))).toBe("<b>x</b><sub>1</sub>"); // texte brut : les balises restent du texte
  });
});

describe("C2 : rappel de reconnexion", () => {
  it("rappelle de se reconnecter au bout de 14 jours, seulement pour les copies sans lien durable", async () => {
    const { staleSources, RECONNECT_DAYS } = await import("../src/lib/timetable-data.js");
    const now = Date.parse("2026-12-20T10:00:00Z");
    const old = { type: "snapshot", syncedAt: "2026-12-01T10:00:00Z" };
    const fresh = { type: "snapshot", syncedAt: "2026-12-15T10:00:00Z" };
    const durable = { type: "sealed", addedAt: "2026-01-01T10:00:00Z" };
    expect(RECONNECT_DAYS).toBe(14);
    expect(staleSources([old, fresh, durable], now)).toEqual([old]);
  });
});

describe("C2 : robot ADE des universités", () => {
  it("coche l'année scolaire en cours, pas les copies de travail", async () => {
    const { guessProject } = await import("../src/lib/timetable-data.js");
    const projects = [
      { id: 5, name: "1737557597291_1_HS_Suppression_impossible" }, { id: 4, name: "UPCité 2026-2027 restauré" },
      { id: 3, name: "UPCité avec salles pour futur" }, { id: 2, name: "UPCité 2027-2028" },
      { id: 1, name: "UPCité 2026-2027 planté" }, { id: 0, name: "UPCité 2025-2026" },
    ]; // vraie liste de l'ADE de Paris Cité (26/11/2026)
    expect(guessProject(projects, new Date("2026-11-26")).id).toBe(4);
    expect(guessProject(projects, new Date("2027-09-15")).id).toBe(2);
  });
});

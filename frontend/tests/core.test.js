import { describe, expect, it } from "vitest";
import { splitLines } from "../src/lib/audio.js";
import { detectSoftware } from "../src/lib/establishments.js";
import { renderFiche } from "../src/lib/fiche-render.js";
import { duration, renderMarkdown, transcriptToMarkdown } from "../src/lib/format.js";
import { h } from "../src/lib/dom.js";
import { createMemoryDrive } from "../src/lib/memory-drive.js";
import { match } from "../src/lib/router.js";
import { applyH, detectCorners, enhance, homography, otsu, outputSize, warp } from "../src/lib/scan-core.js";
import { ficheToText, safeName } from "../src/lib/storage.js";
import { eventsOfDay, lessonAt, subjectsOf } from "../src/lib/timetable-data.js";
import { captionAt, slideDurations } from "../src/lib/video-render.js";
import { findChapter, findCourse } from "../src/app/confirm.js";

describe("scanner", () => {
  it("Otsu sépare deux niveaux", () => {
    const g = new Uint8ClampedArray([...Array(50).fill(30), ...Array(50).fill(220)]);
    const t = otsu(g);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
  });

  it("l'homographie envoie les coins au bon endroit", () => {
    const from = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const to = [[10, 5], [90, 12], [95, 98], [3, 90]];
    const H = homography(from, to);
    from.forEach((p, i) => {
      const [x, y] = applyH(H, ...p);
      expect(x).toBeCloseTo(to[i][0], 6);
      expect(y).toBeCloseTo(to[i][1], 6);
    });
  });

  it("détecte une feuille claire sur fond sombre", () => {
    const w = 100, hgt = 140;
    const data = new Uint8ClampedArray(w * hgt * 4);
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
      const inside = x >= 20 && x < 80 && y >= 30 && y < 110;
      const v = inside ? 235 : 40;
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
    const [tl, , br] = detectCorners(data, w, hgt);
    expect(tl[0] * (w - 1)).toBeCloseTo(20, 0);
    expect(tl[1] * (hgt - 1)).toBeCloseTo(30, 0);
    expect(br[0] * (w - 1)).toBeCloseTo(79, 0);
    expect(br[1] * (hgt - 1)).toBeCloseTo(109, 0);
  });

  it("redresse et blanchit le papier", () => {
    const w = 40, hgt = 40;
    const src = new Uint8ClampedArray(w * hgt * 4).fill(200);
    const corners = [[0, 0], [39, 0], [39, 39], [0, 39]];
    const { width, height } = outputSize(corners, 20);
    expect(width).toBe(20);
    expect(height).toBe(20);
    const flat = warp(src, w, hgt, corners, width, height);
    expect(flat[0]).toBe(200);
    const clean = enhance(flat, width, height, "bw");
    expect(clean[0]).toBe(255); // papier → blanc pur
  });
});

describe("format", () => {
  it("met en forme la transcription en Markdown", () => {
    const md = transcriptToMarkdown("Titre", [
      { speaker: "Professeur", text: "Bonjour." }, { speaker: "Professeur", text: "On commence." }, { speaker: "Élève", text: "Oui !" },
    ]);
    expect(md).toContain("**Professeur :** Bonjour. On commence.");
    expect(md).toContain("**Élève :** Oui !");
  });
  it("affiche les durées", () => {
    expect(duration(65)).toBe("1:05");
    expect(duration(3725)).toBe("1:02:05");
  });
  it("rend un Markdown sûr (pas d'injection HTML)", () => {
    const nodes = renderMarkdown("# Titre\n**gras** <img src=x onerror=alert(1)>\n- point", h);
    const div = h("div", {}, nodes);
    expect(div.querySelector("img")).toBeNull();
    expect(div.querySelector("strong").textContent).toBe("gras");
    expect(div.querySelectorAll("li")).toHaveLength(1);
  });
  it("nettoie les noms de fichiers", () => {
    expect(safeName('a/b:c*?"<>|d')).toBe("a b c d");
    expect(safeName("   ")).toBe("Sans titre");
  });
});

describe("audio", () => {
  it("découpe les répliques en segments ≤ 1300 caractères", () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ speaker: i % 2 ? "A" : "B", text: "x".repeat(200) }));
    const segs = splitLines(lines);
    for (const s of segs) expect(s.reduce((n, l) => n + l.text.length, 0)).toBeLessThanOrEqual(1300);
    expect(segs.flat()).toHaveLength(30);
  });
});

describe("vidéo", () => {
  it("sous-titres et durées", () => {
    const text = Array.from({ length: 30 }, (_, i) => `mot${i}`).join(" ");
    expect(captionAt(text, 0)).toMatch(/^mot0 /);
    expect(captionAt(text, 0.99)).toMatch(/mot29$/);
    const d = slideDurations([{ narration: "a".repeat(100) }, { narration: "a".repeat(300) }], 40);
    expect(d[0] + d[1]).toBeCloseTo(40);
    expect(d[1]).toBeGreaterThan(d[0]);
  });
});

describe("routeur", () => {
  it("associe les adresses aux pages", () => {
    const routes = [{ path: "/" }, { path: "/cours/:courseId/:chapterId" }, { path: "/cours/:courseId" }];
    expect(match(routes, "/cours/abc/def").params).toEqual({ courseId: "abc", chapterId: "def" });
    expect(match(routes, "/cours/abc").params).toEqual({ courseId: "abc" });
    expect(match(routes, "/inconnu")).toBeNull();
  });
});

describe("emploi du temps", () => {
  const ev = (subject, start, end, extra = {}) => ({ subject, start, end, cancelled: false, ...extra });
  const events = [
    ev("Maths", "2026-11-24T08:00:00", "2026-11-24T09:00:00"),
    ev("SVT", "2026-11-24T10:00:00", "2026-11-24T11:00:00", { cancelled: true }),
    ev("Anglais", "2026-11-25T08:00:00", "2026-11-25T09:00:00"),
  ];
  it("trouve le cours en cours (avec marge)", () => {
    expect(lessonAt(events, new Date("2026-11-24T08:30:00")).subject).toBe("Maths");
    expect(lessonAt(events, new Date("2026-11-24T09:15:00")).subject).toBe("Maths");
    expect(lessonAt(events, new Date("2026-11-24T10:30:00"))).toBeNull(); // annulé
    expect(eventsOfDay(events, new Date("2026-11-24T12:00:00"))).toHaveLength(2);
    expect(subjectsOf(events)).toEqual(["Anglais", "Maths", "SVT"]);
  });
  it("reconnaît le logiciel d'emploi du temps", () => {
    expect(detectSoftware("https://ade.univ.fr/jsp/custom/modules/plannings/anonymous_cal.jsp?x=1")).toBe("ADE Campus");
    expect(detectSoftware("webcal://edt.univ.fr/x.ics")).toBe("iCal");
    expect(detectSoftware("https://exemple.fr")).toBeNull();
  });
  it("rapproche les noms de cours", () => {
    const tree = [{ name: "Mathématiques" }, { name: "Histoire-Géographie" }];
    expect(findCourse(tree, "mathematiques").name).toBe("Mathématiques");
    expect(findCourse(tree, "Histoire")?.name).toBe("Histoire-Géographie");
    expect(findCourse(tree, "")).toBeNull();
    const chapters = [{ name: "Ch. 3 — Suites" }, { name: "Ch. 4 — Exponentielle" }];
    expect(findChapter(chapters, "Suites").name).toBe("Ch. 3 — Suites");
    expect(findChapter(chapters, "Probabilités")).toBeNull();
  });
});

describe("faux Drive", () => {
  it("crée cours, chapitres et fichiers", async () => {
    const d = createMemoryDrive();
    const c = await d.createCourse("Maths", "pink");
    const ch = await d.createChapter(c.id, "Suites");
    const f = await d.save({ parentId: ch.id, name: "t.md", mimeType: "text/markdown", kind: "transcript", blob: new Blob(["salut"]) });
    const tree = await d.tree();
    expect(tree[0].chapters[0].name).toBe("Suites");
    expect(await d.readText(f.id)).toBe("salut");
    await d.trash(f.id);
    expect(await d.listFiles(ch.id)).toHaveLength(0);
  });
});

describe("fiche", () => {
  const fiche = {
    title: "Les suites", subtitle: "Maths",
    sections: [{ heading: "Définition", color: "pink", blocks: [{ type: "definition", title: "Suite", text: "<b>pas du HTML</b>", items: [] }] }],
    key_points: ["Point 1"], mnemonic: "", quiz: [{ question: "Q ?", answer: "R" }],
  };
  it("s'affiche sans interpréter de HTML", () => {
    const el = renderFiche(fiche);
    expect(el.querySelector("h1").textContent).toBe("Les suites");
    expect(el.querySelector("b")).toBeNull();
    expect(el.textContent).toContain("<b>pas du HTML</b>");
  });
  it("se convertit en texte pour l'IA", () => {
    expect(ficheToText(fiche)).toContain("## Définition");
  });
});

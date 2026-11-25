import { describe, expect, it } from "vitest";
import { bulletTimes, captionAt, slideAt, wordTimes } from "../src/lib/video-anim.js";

const doc = {
  format: "medium",
  duration: 21,
  slides: [
    { title: "A", bullets: [], narration: "Un deux trois.", start: 0, end: 5 },
    { title: "B", bullets: ["Photosynthèse végétale", "Oxygène rejeté"], start: 5.7, end: 15,
      narration: "Les plantes font la photosynthèse grâce à la lumière. Ensuite, elles rejettent de l'oxygène dans l'air." },
    { title: "C", bullets: [], narration: "Fin.", start: 15.7, end: 20.3 },
  ],
};

describe("calage des diapos sur la voix", () => {
  it("trouve la diapo affichée à chaque instant (pause comprise)", () => {
    expect(slideAt(doc, 0)).toBe(0);
    expect(slideAt(doc, 5.2)).toBe(0); // silence entre deux diapos : on reste sur la précédente
    expect(slideAt(doc, 5.7)).toBe(1);
    expect(slideAt(doc, 99)).toBe(2);
  });

  it("répartit les mots sur la durée de la diapo, sans trou ni chevauchement", () => {
    const words = wordTimes(doc.slides[1]);
    expect(words[0].t0).toBe(0);
    expect(words[words.length - 1].t1).toBeCloseTo(15 - 5.7, 5);
    words.slice(1).forEach((w, i) => expect(w.t0).toBeCloseTo(words[i].t1, 5));
  });

  it("surligne le mot prononcé dans le sous-titre", () => {
    const start = captionAt(doc.slides[1], 0);
    expect(start.words[0]).toBe("Les");
    expect(start.active).toBe(0);
    const end = captionAt(doc.slides[1], 9.2);
    expect(end.words.join(" ")).toMatch(/oxygène/);
    expect(end.words.length).toBeLessThanOrEqual(9);
  });

  it("fait apparaître chaque puce quand la voix prononce son mot clé, dans l'ordre", () => {
    const words = wordTimes(doc.slides[1]);
    const [b1, b2] = bulletTimes(doc.slides[1]);
    const photo = words.find((w) => w.w.startsWith("photosynth")).t0;
    const rejet = words.find((w) => w.w.startsWith("rejet")).t0; // 1er mot clé de « Oxygène rejeté » prononcé
    expect(b1).toBeCloseTo(Math.max(0.6, photo), 5);
    expect(b2).toBeCloseTo(rejet, 5);
    const elided = bulletTimes({ ...doc.slides[1], _words: undefined, _bullets: undefined, bullets: ["Oxygène"] })[0];
    expect(elided).toBeCloseTo(words.find((w) => w.w.includes("oxyg")).t0, 5); // « l'oxygène » est bien reconnu
    expect(b2).toBeGreaterThan(b1);
  });
});

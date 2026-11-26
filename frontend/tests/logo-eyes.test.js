// Itération 6 (C1) : les yeux du logo suivent la souris, seulement sur PC et sans « réduire les animations ».
import { afterEach, describe, expect, it, vi } from "vitest";
import { eyesAllowed, gaze, logoSvg, wakeLogos } from "../src/lib/logo-eyes.js";

const media = (matches) => vi.fn((q) => ({ matches: matches(q), media: q, addEventListener() {}, removeEventListener() {} }));

afterEach(() => { delete window.matchMedia; document.body.innerHTML = ""; });

describe("regard", () => {
  it("la pupille va vers le pointeur sans sortir de l'œil", () => {
    const far = gaze({ x: 100, y: 100 }, { x: 1000, y: 100 }, 1);
    expect(far.x).toBeCloseTo(4.2);
    expect(far.y).toBeCloseTo(0);
    const near = gaze({ x: 100, y: 100 }, { x: 106, y: 108 }, 1);
    expect(Math.hypot(near.x, near.y)).toBeLessThan(2); // tout près : petit mouvement
    expect(gaze({ x: 5, y: 5 }, { x: 5, y: 5 }, 1)).toEqual({ x: 0, y: 0 });
  });

  it("le logo dessiné a deux pupilles et n'est pas lu par les lecteurs d'écran", () => {
    const svg = logoSvg(46, "doodle");
    expect(svg.querySelectorAll(".pupil")).toHaveLength(2);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("class")).toContain("studoo-eyes");
  });
});

describe("seulement sur PC", () => {
  it("souris + animations autorisées : le logo est remplacé par le dessin animé", () => {
    window.matchMedia = media((q) => q.includes("pointer: fine"));
    expect(eyesAllowed()).toBe(true);
    document.body.innerHTML = '<a class="logo"><img src="/favicon.svg" width="46" height="46"></a>';
    wakeLogos();
    expect(document.querySelector("svg.studoo-eyes")).not.toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("écran tactile : l'image reste telle quelle", () => {
    window.matchMedia = media(() => false);
    document.body.innerHTML = '<img src="/favicon.svg" width="46" height="46">';
    wakeLogos();
    expect(document.querySelector("img")).not.toBeNull();
  });

  it("« réduire les animations » : rien ne bouge", () => {
    window.matchMedia = media(() => true); // souris ET réduction demandée
    expect(eyesAllowed()).toBe(false);
  });
});

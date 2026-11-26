// Le logo de Studoo suit la souris des yeux (itération 6).
//
// Seulement sur un appareil avec une vraie souris (pas d'écran tactile seul), et jamais si le système
// demande de réduire les animations. Le dessin du logo est inséré dans la page (au lieu de l'image
// /favicon.svg) pour pouvoir bouger les pupilles ; un seul écouteur pour toute la page, au plus une mise à
// jour par image affichée (requestAnimationFrame), et uniquement des « transform » : rien ne ralentit.
const SVG_NS = "http://www.w3.org/2000/svg";
const EYES = [{ cx: 22, cy: 33 }, { cx: 43, cy: 33 }]; // centres des « o » dans le dessin (64 × 64)
const REST = { x: 3, y: 2 }; // regard au repos (vers le bas à droite, comme le logo d'origine)
const MAX = 4.2; // déplacement maximal de la pupille (en unités du dessin)

export function eyesAllowed() {
  const mq = (q) => window.matchMedia?.(q).matches;
  return Boolean(mq("(hover: hover) and (pointer: fine)")) && !mq("(prefers-reduced-motion: reduce)");
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Le logo dessiné, avec des pupilles mobiles. */
export function logoSvg(size, className = "") {
  const root = svg("svg", { viewBox: "0 0 64 64", width: size, height: size, class: `studoo-eyes ${className}`.trim(), "aria-hidden": "true", focusable: "false" });
  root.append(
    svg("path", { d: "M6 9 L58 6 L59 57 L7 59 Z", fill: "#FF9CCB", stroke: "#B0437A", "stroke-width": "2", "stroke-linejoin": "round" }),
    svg("path", { d: "M23 3 L42 2 L42.5 10 L23.5 11 Z", fill: "#FFF7C2", opacity: ".9" }),
  );
  for (const e of EYES) {
    root.append(svg("circle", { cx: e.cx, cy: e.cy, r: "10", fill: "#fff", stroke: "#16296E", "stroke-width": "3" }));
    const pupil = svg("circle", { class: "pupil", cx: e.cx, cy: e.cy, r: "4", fill: "#16296E" });
    pupil.style.transform = `translate(${REST.x}px, ${REST.y}px)`;
    root.append(pupil);
  }
  root.append(svg("path", { d: "M24 49 C29 52 36 52 41 49", fill: "none", stroke: "#16296E", "stroke-width": "2.5", "stroke-linecap": "round" }));
  return root;
}

/** Où regarder : vecteur (en unités du dessin) d'un œil vers le pointeur, limité au bord de l'œil. */
export function gaze(eye, pointer, scale) {
  const dx = (pointer.x - eye.x) / scale;
  const dy = (pointer.y - eye.y) / scale;
  const dist = Math.hypot(dx, dy);
  if (!dist) return { x: 0, y: 0 };
  const reach = Math.min(MAX, dist / 6); // de près, la pupille bouge moins : regard naturel
  return { x: (dx / dist) * reach, y: (dy / dist) * reach };
}

let pointer = null;
let frame = 0;
let listening = false;

function update() {
  frame = 0;
  if (!pointer) return;
  for (const logo of document.querySelectorAll("svg.studoo-eyes")) {
    const box = logo.getBoundingClientRect();
    if (!box.width || box.bottom < 0 || box.top > innerHeight) continue; // invisible : rien à faire
    const scale = box.width / 64;
    logo.querySelectorAll(".pupil").forEach((p, i) => {
      const eye = { x: box.left + EYES[i].cx * scale, y: box.top + EYES[i].cy * scale };
      const g = gaze(eye, pointer, scale);
      p.style.transform = `translate(${g.x.toFixed(2)}px, ${g.y.toFixed(2)}px)`;
    });
  }
}

function listen() {
  if (listening) return;
  listening = true;
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    pointer = { x: e.clientX, y: e.clientY };
    if (!frame) frame = requestAnimationFrame(update);
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => { // la souris quitte la page : regard au repos
    pointer = null;
    for (const p of document.querySelectorAll("svg.studoo-eyes .pupil")) p.style.transform = `translate(${REST.x}px, ${REST.y}px)`;
  });
}

/**
 * Remplace les images du logo (/favicon.svg) par le dessin animé, dans `root`. Sans effet sur un écran
 * tactile ou si les animations sont réduites : l'image d'origine reste.
 */
export function wakeLogos(root = document) {
  if (!eyesAllowed()) return;
  for (const img of root.querySelectorAll('img[src="/favicon.svg"]')) {
    const size = Number(img.getAttribute("width")) || img.width || 46;
    const live = logoSvg(size, img.className);
    for (const k of ["style"]) if (img.getAttribute(k)) live.setAttribute(k, img.getAttribute(k));
    img.replaceWith(live);
  }
  listen();
}

// Itération 7 (C2) : « Failed to fetch dynamically imported module » après un déploiement.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChunkError, isStaleChunkError, reloadOnce } from "../src/lib/stale.js";

const reload = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  vi.useFakeTimers();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
  reload.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("reconnaître l'erreur", () => {
  it("messages des navigateurs (Chrome, Firefox, Safari) et préchargement CSS", () => {
    for (const msg of [
      "Failed to fetch dynamically imported module: https://studoo-app.vercel.app/assets/admin-M9QLww8X.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/app-1a2b3c.css",
    ]) expect(isStaleChunkError(new Error(msg))).toBe(true);
    expect(isStaleChunkError(new Error("Google Drive a répondu 500"))).toBe(false);
  });
});

describe("récupération sans boucle", () => {
  it("un seul rechargement, précédé d'un message clair", () => {
    expect(handleChunkError(new Error("Failed to fetch dynamically imported module: x.js"))).toBe(true);
    expect(document.getElementById("stale-banner").textContent).toContain("Nouvelle version de Studoo disponible");
    vi.advanceTimersByTime(800);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("si l'erreur revient juste après le rechargement : bouton, pas de nouveau rechargement automatique", () => {
    const now = Date.now();
    expect(reloadOnce(now)).toBe(true);
    expect(reloadOnce(now + 5_000)).toBe(false); // même onglet, 5 s après : on ne boucle pas
    handleChunkError(new Error("Importing a module script failed."));
    vi.advanceTimersByTime(2000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(document.querySelector("#stale-banner button").textContent).toBe("Recharger");
  });

  it("une autre erreur n'est pas avalée", () => {
    expect(handleChunkError(new Error("Réseau indisponible"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});


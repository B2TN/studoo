// Itération 5 (C1) : « Aucune parole détectée » sur un enregistrement court.
// Cause trouvée : le vrai MediaRecorder livre le son (dataavailable puis stop) APRÈS l'appel à stop() ; la page
// concluait sur une file vide. Ce faux MediaRecorder reproduit ce délai.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = [];
vi.mock("../src/lib/api.js", () => {
  class ApiError extends Error {
    constructor(status, detail) { super(detail?.message || "Erreur"); this.status = status; this.code = detail?.code || "error"; }
  }
  return {
    ApiError,
    api: vi.fn(async (path, init) => {
      calls.push({ path, size: init.body.size, type: init.headers["Content-Type"] });
      if (globalThis.__apiError) throw globalThis.__apiError;
      return { language: "fr", duration: 20, segments: globalThis.__segments ?? [{ speaker: "Professeur", text: "Bonjour à tous." }] };
    }),
  };
});
vi.mock("../src/lib/storage.js", () => ({
  drive: { save: vi.fn() },
  getSettings: vi.fn(async () => ({ recordingConsent: "2026-11-26" })),
  saveSettings: vi.fn(),
}));
vi.mock("../src/lib/pending.js", () => ({ addPending: vi.fn(() => "p1") }));

class FakeRecorder {
  static isTypeSupported(m) { return m.startsWith("audio/webm"); }
  constructor(stream, opts) { this.mimeType = opts?.mimeType || "audio/webm"; this.state = "inactive"; }
  start() { this.state = "recording"; }
  pause() {}
  resume() {}
  stop() {
    // comme Chrome : rien n'est livré pendant l'appel ; le son arrive un instant plus tard
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(globalThis.__bytes ?? 20000)], { type: this.mimeType }) });
      this.onstop?.();
    }, 5);
  }
}

beforeEach(() => {
  calls.length = 0;
  globalThis.__segments = undefined;
  globalThis.__apiError = undefined;
  globalThis.__bytes = undefined;
  globalThis.MediaRecorder = FakeRecorder;
  window.MediaRecorder = FakeRecorder;
  globalThis.AudioContext = class {
    createAnalyser() { return { fftSize: 512, getByteTimeDomainData(d) { d.fill(globalThis.__silent ? 128 : 200); } }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { return Promise.resolve(); }
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ addEventListener() {} }] })) } });
});
afterEach(() => { globalThis.__silent = false; });

async function record({ seconds = 25 } = {}) {
  const { render } = await import("../src/app/record.js");
  const view = document.createElement("div");
  document.body.append(view);
  const go = vi.fn();
  await render({ view, go, refreshQuota: () => {} });
  view.querySelector(".rec-button").click();
  await new Promise((r) => setTimeout(r, 30));
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + seconds * 1000);
  [...view.querySelectorAll("button")].find((b) => b.textContent.includes("Terminer")).click();
  await vi.waitFor(() => expect(go.mock.calls.length + view.querySelectorAll(".rec-result").length).toBeGreaterThan(0), { timeout: 3000 });
  vi.restoreAllMocks();
  return { view, go };
}

describe("enregistrement court (≈ 25 s)", () => {
  it("attend la dernière tranche et l'envoie à la transcription", async () => {
    const { go } = await record();
    expect(calls).toHaveLength(1);
    expect(calls[0].size).toBe(20000);
    expect(calls[0].type).toBe("audio/webm");
    expect(go).toHaveBeenCalledWith("/confirmer?id=p1");
  });

  it("vraiment aucune parole : message propre, distinct d'une panne", async () => {
    globalThis.__segments = [];
    const { view } = await record();
    expect(view.querySelector(".rec-result").textContent).toContain("Aucune parole reconnue");
  });

  it("erreur du service : son message, pas « aucune parole »", async () => {
    const { ApiError } = await import("../src/lib/api.js");
    globalThis.__apiError = new ApiError(503, { code: "stt_unconfigured", message: "La transcription n'est pas encore configurée sur ce site." });
    const { view } = await record();
    const text = view.querySelector(".rec-result").textContent;
    expect(text).toContain("La transcription n'a pas pu se faire");
    expect(text).toContain("pas encore configurée");
    expect(calls).toHaveLength(1); // erreur définitive : pas d'essais inutiles
  });

  it("enregistrement vide : rien n'est envoyé, message dédié", async () => {
    globalThis.__bytes = 100;
    const { view } = await record();
    expect(calls).toHaveLength(0);
    expect(view.querySelector(".rec-result").textContent).toContain("L'enregistrement est vide");
  });
});

describe("messages", () => {
  it("micro inaccessible : un message par cause", async () => {
    const { micErrorMessage } = await import("../src/app/record.js");
    expect(micErrorMessage({ name: "NotAllowedError" })).toMatch(/refusé/);
    expect(micErrorMessage({ name: "NotFoundError" })).toMatch(/Aucun micro/);
    expect(micErrorMessage({ name: "NotReadableError" })).toMatch(/déjà utilisé/);
  });

  it("micro muet (niveau nul) ≠ parole non reconnue", async () => {
    const { outcomeMessage } = await import("../src/app/record.js");
    const base = { chunks: 1, empty: 0, ok: 1, errors: [], segments: 0, seconds: 20 };
    expect(outcomeMessage({ ...base, maxLevel: 0 }).kind).toBe("silent-mic");
    expect(outcomeMessage({ ...base, maxLevel: 0.5 }).kind).toBe("no-speech");
    expect(outcomeMessage({ ...base, segments: 3, maxLevel: 0.5 })).toBeNull();
  });
});

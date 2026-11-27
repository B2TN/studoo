// Itération 7 (C5) : inventaire des services (admin + docs/SERVICES.md).
import { describe, expect, it } from "vitest";

describe("inventaire des services (itération 7, C5)", () => {
  it("docs/SERVICES.md est à jour avec la liste de l'admin", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { servicesMarkdown } = await import("../scripts/services-doc.mjs");
    const doc = readFileSync(resolve(process.cwd(), "../docs/SERVICES.md"), "utf8");
    expect(doc).toBe(servicesMarkdown()); // sinon : node scripts/services-doc.mjs
  });

  it("aucun secret dans l'inventaire", async () => {
    const { SERVICES } = await import("../src/lib/services.js");
    const text = JSON.stringify(SERVICES);
    expect(text).not.toMatch(/AIza[0-9A-Za-z_-]{20}|sk-[A-Za-z0-9]{20}|GOCSPX-|postgres(ql)?:\/\/[^"]*@|[A-Za-z0-9]{70,}/);
    for (const s of SERVICES) expect(s.url).toMatch(/^https:\/\//);
  });
});

// Itération 7 (L3) : pages publiques indexables, sitemap, llms.txt et règles des robots.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { llms, sitemap, toolPage, TOOLS } from "../scripts/seo-pages.mjs";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const PAGES = ["index.html", "rgpd.html", "cgu.html", "contact.html", ...TOOLS.map((t) => `outils/${t.slug}.html`)];

describe("fichiers générés à jour", () => {
  it("pages outils, sitemap et llms.txt (sinon : node scripts/seo-pages.mjs)", () => {
    for (const t of TOOLS) expect(read(`outils/${t.slug}.html`)).toBe(toolPage(t));
    expect(read("public/sitemap.xml")).toBe(sitemap());
    expect(read("public/llms.txt")).toBe(llms());
  });
});

describe("chaque page publique", () => {
  it("a un titre, une description et une adresse canonique uniques, en français", () => {
    const seen = { title: new Set(), description: new Set(), canonical: new Set() };
    for (const p of PAGES) {
      const html = read(p);
      expect(html).toMatch(/<html lang="fr">/);
      const title = html.match(/<title>([^<]+)<\/title>/)[1];
      const description = html.match(/<meta name="description" content="([^"]+)"/)[1];
      const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)[1];
      for (const [k, v] of Object.entries({ title, description, canonical })) {
        expect(seen[k].has(v), `${k} en double : ${p}`).toBe(false);
        seen[k].add(v);
      }
      expect(description.length).toBeLessThanOrEqual(200);
      expect(html).toContain('property="og:image"');
    }
  });

  it("toutes les pages publiques sont dans le sitemap", () => {
    const map = read("public/sitemap.xml");
    for (const t of TOOLS) expect(map).toContain(`/outils/${t.slug}</loc>`);
    for (const p of ["/rgpd", "/cgu", "/contact"]) expect(map).toContain(`${p}</loc>`);
  });

  it("données structurées valides (JSON-LD)", () => {
    for (const p of PAGES.filter((x) => x !== "contact.html")) {
      for (const [, json] of read(p).matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)) {
        expect(() => JSON.parse(json), p).not.toThrow();
      }
    }
    expect(read("index.html")).toContain('"@type": "FAQPage"');
  });
});

describe("robots", () => {
  const robots = read("public/robots.txt").replace(/\r\n/g, "\n");
  it("moteurs et assistants qui citent leurs sources : autorisés ; entraînement : refusé", () => {
    const group = (agent) => robots.split(/\n\n/).find((g) => g.includes(`User-agent: ${agent}\n`)) || "";
    for (const bot of ["OAI-SearchBot", "PerplexityBot", "Claude-SearchBot"]) expect(group(bot)).toMatch(/Allow: \//);
    for (const bot of ["GPTBot", "ClaudeBot", "Google-Extended", "CCBot"]) expect(group(bot)).toMatch(/Disallow: \/(\r?\n|$)/);
    expect(robots).toContain("Sitemap: https://studoo-app.vercel.app/sitemap.xml");
    expect(robots).toContain("Disallow: /api/");
  });
});

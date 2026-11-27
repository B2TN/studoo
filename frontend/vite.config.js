import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Identifiant de cette version du site (commit déployé par Vercel, sinon l'heure du build).
// Il est écrit dans le code ET dans /version.json : un onglet ouvert compare les deux pour savoir
// qu'une nouvelle version est en ligne (voir src/lib/stale.js).
const BUILD_ID = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 12) || `local-${Date.now()}`;

const versionFile = {
  name: "studoo-version",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) });
  },
};

// Site multi-pages : l'accueil/tableau de bord + les pages statiques (SEO).
export default defineConfig(({ command }) => ({
  define: { __BUILD_ID__: JSON.stringify(command === "build" ? BUILD_ID : "dev") },
  plugins: [versionFile],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        rgpd: resolve(import.meta.dirname, "rgpd.html"),
        cgu: resolve(import.meta.dirname, "cgu.html"),
        contact: resolve(import.meta.dirname, "contact.html"),
        notFound: resolve(import.meta.dirname, "404.html"),
        // Pages de contenu pré-générées (scripts/seo-pages.mjs)
        ...Object.fromEntries(readdirSync(resolve(import.meta.dirname, "outils")).filter((f) => f.endsWith(".html"))
          .map((f) => [`outil-${f.replace(".html", "")}`, resolve(import.meta.dirname, "outils", f)])),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // En local : /api → FastAPI (uvicorn sur le port 8000)
      "/api": "http://127.0.0.1:8000",
    },
  },
  test: {
    environment: "jsdom",
  },
}));

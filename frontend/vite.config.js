import { resolve } from "node:path";
import { defineConfig } from "vite";

// Site multi-pages : l'accueil/tableau de bord + les pages statiques (SEO).
export default defineConfig({
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        rgpd: resolve(import.meta.dirname, "rgpd.html"),
        cgu: resolve(import.meta.dirname, "cgu.html"),
        contact: resolve(import.meta.dirname, "contact.html"),
        notFound: resolve(import.meta.dirname, "404.html"),
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
});

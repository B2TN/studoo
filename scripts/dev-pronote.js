// Serveur de développement : fait tourner la fonction Vercel /api/pronote en local.
// Usage : node scripts/dev-pronote.js   (port 8001, utilisé par le proxy Vite)
import http from "node:http";
import handler from "../api/pronote.js";

process.env.SESSION_SECRET ||= "dev-secret-change-me-dev-secret-change-me";

http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
  await handler(req, res);
}).listen(8001, "127.0.0.1", () => console.log("Pronote (dev) sur http://127.0.0.1:8001"));

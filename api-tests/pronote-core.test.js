import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

process.env.SESSION_SECRET = "x".repeat(40);
const core = await import("../lib/pronote-core.js");

// Reproduit la signature faite par l'API Python (security.sign_service_token)
function pySign(sub, exp) {
  const key = crypto.createHmac("sha256", process.env.SESSION_SECRET).update("service-token").digest();
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

test("jeton de service valide / expiré / falsifié", () => {
  const ok = pySign("user-1", Math.floor(Date.now() / 1000) + 60);
  assert.equal(core.verifyServiceToken(ok), "user-1");
  assert.equal(core.verifyServiceToken(pySign("user-1", 1)), null);
  assert.equal(core.verifyServiceToken(ok.slice(0, -2) + "xx"), null);
  assert.equal(core.verifyServiceToken("n'importe quoi"), null);
});

test("le jeton Pronote chiffré est lié à l'utilisateur", () => {
  const blob = core.sealRefresh({ refresh: { token: "secret" } }, "user-1");
  assert.ok(!blob.includes("secret"));
  assert.deepEqual(core.openRefresh(blob, "user-1"), { refresh: { token: "secret" } });
  assert.throws(() => core.openRefresh(blob, "user-2"));
});

test("conversion des cours Pronote", () => {
  const events = core.toEvents([
    { is: "lesson", id: "1", subject: { name: "MATHEMATIQUES" }, teacherNames: ["M. Dupont"], classrooms: ["101"],
      startDate: new Date("2026-11-24T08:00:00Z"), endDate: new Date("2026-11-24T09:00:00Z"), canceled: false },
    { is: "detention", id: "2", startDate: new Date(), endDate: new Date() },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].subject, "Mathématiques");
  assert.equal(events[0].location, "101");
});

test("validation du QR code", () => {
  assert.equal(core.parseQr("pas du json"), null);
  assert.equal(core.parseQr({ url: "http://x/", jeton: "a", login: "b" }), null);
  assert.ok(core.parseQr(JSON.stringify({ url: "https://0123.index-education.net/pronote/", jeton: "a", login: "b" })));
});

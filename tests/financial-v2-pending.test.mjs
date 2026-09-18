import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/financial-v2-pending.ts", import.meta.url), "utf8")
  .replace(/import type \{ ContributionRequest \} from "\.\/financial-v2-write";\n/, "");
const mod = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`);

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key) => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
}
function pending(userId = "u1", overrides = {}) {
  return { userId, requestId: "r1", positionId: "p1", amount: 10, occurredAt: "2026-09-18T12:00:00.000Z", createdAt: "2026-09-18T12:00:00.000Z", operation: "contribution", status: "pending", ...overrides };
}
const now = Date.parse("2026-09-18T13:00:00.000Z");

test("persiste y recupera un pendiente del mismo usuario tras una recarga simulada", () => {
  const local = storage();
  mod.savePendingContribution(local, pending(), now);
  const recovered = mod.findPendingContribution(local, "u1", "p1", 10, now);
  assert.equal(recovered.requestId, "r1");
  assert.equal(recovered.occurredAt, "2026-09-18T12:00:00.000Z");
});

test("un usuario no puede leer ni reutilizar pendientes de otro", () => {
  const local = storage();
  mod.savePendingContribution(local, pending("u1"), now);
  assert.deepEqual(mod.readPendingContributions(local, "u2", now), []);
  assert.equal(mod.findPendingContribution(local, "u2", "p1", 10, now), null);
});

test("el mismo payload reutiliza request_id y otro payload necesita uno nuevo", () => {
  const local = storage();
  mod.savePendingContribution(local, pending(), now);
  assert.equal(mod.findPendingContribution(local, "u1", "p1", 10, now).requestId, "r1");
  assert.equal(mod.findPendingContribution(local, "u1", "p1", 11, now), null);
});

test("éxito elimina el pendiente y un error incierto lo conserva", () => {
  const local = storage();
  mod.savePendingContribution(local, pending(), now);
  assert.equal(mod.isDefinitiveContributionError(new Error("Failed to fetch")), false);
  assert.equal(mod.readPendingContributions(local, "u1", now).length, 1);
  mod.removePendingContribution(local, "u1", "r1", now);
  assert.deepEqual(mod.readPendingContributions(local, "u1", now), []);
});

test("los errores definitivos eliminan el pendiente y los vencidos no se reutilizan", () => {
  const local = storage();
  mod.savePendingContribution(local, pending(), now);
  assert.equal(mod.isDefinitiveContributionError(new Error("IDEMPOTENCY_PAYLOAD_MISMATCH")), true);
  mod.removePendingContribution(local, "u1", "r1", now);
  assert.deepEqual(mod.readPendingContributions(local, "u1", now), []);
  mod.savePendingContribution(local, pending("u1", { requestId: "expired", createdAt: "2026-09-10T12:00:00.000Z" }), now);
  assert.equal(mod.findPendingContribution(local, "u1", "p1", 10, now), null);
});

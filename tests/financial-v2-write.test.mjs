import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/financial-v2-write.ts", import.meta.url), "utf8");
const mod = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`);

function rpcClient() {
  const requests = new Map();
  let inserted = 0;
  return {
    get inserted() { return inserted; },
    rpc(_name, payload) {
      const fingerprint = JSON.stringify([payload.p_position_id, payload.p_amount, payload.p_occurred_at]);
      const previous = requests.get(payload.p_request_id);
      if (previous && previous.fingerprint !== fingerprint) return Promise.resolve({ data: null, error: { message: "IDEMPOTENCY_PAYLOAD_MISMATCH" } });
      if (previous) return Promise.resolve({ data: previous.response, error: null });
      const response = { movement: { id: `m-${++inserted}`, position_id: payload.p_position_id, amount: payload.p_amount }, snapshot: { position_id: payload.p_position_id, current_value: payload.p_amount } };
      requests.set(payload.p_request_id, { fingerprint, response });
      return Promise.resolve({ data: response, error: null });
    },
  };
}

test("un aporte exitoso llama sólo a la RPC con el snapshot devuelto", async () => {
  const client = rpcClient();
  const request = mod.createContributionRequest("position-1", 123.45, "2026-09-17T12:00:00.000Z", "request-1");
  const result = await mod.recordContribution(client, request);
  assert.equal(client.inserted, 1);
  assert.equal(result.snapshot.current_value, 123.45);
});

test("un reintento con el mismo request_id no duplica el aporte", async () => {
  const client = rpcClient();
  const request = mod.createContributionRequest("position-1", 50, "2026-09-17T12:00:00.000Z", "request-2");
  const first = await mod.recordContribution(client, request);
  const retry = await mod.recordContribution(client, request);
  assert.equal(client.inserted, 1);
  assert.deepEqual(retry, first);
});

test("un doble envío lógico reutiliza el request_id y sólo registra un aporte", async () => {
  const client = rpcClient();
  const request = mod.createContributionRequest("position-1", 75, "2026-09-17T12:00:00.000Z", "request-double-click");
  const [first, second] = await Promise.all([mod.recordContribution(client, request), mod.recordContribution(client, request)]);
  assert.equal(client.inserted, 1);
  assert.deepEqual(first, second);
});

test("reutilizar un request_id con otro payload falla", async () => {
  const client = rpcClient();
  await mod.recordContribution(client, mod.createContributionRequest("position-1", 50, "2026-09-17T12:00:00.000Z", "request-3"));
  await assert.rejects(() => mod.recordContribution(client, mod.createContributionRequest("position-1", 51, "2026-09-17T12:00:00.000Z", "request-3")), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  assert.equal(client.inserted, 1);
});

test("un fallo de RPC y un importe inválido se comunican sin crear aportes", async () => {
  await assert.rejects(() => mod.recordContribution({ rpc: async () => ({ data: null, error: { message: "RPC_UNAVAILABLE" } }) }, mod.createContributionRequest("position-1", 10, "2026-09-17T12:00:00.000Z", "request-4")), /RPC_UNAVAILABLE/);
  assert.throws(() => mod.createContributionRequest("position-1", 10.001, "2026-09-17T12:00:00.000Z", "request-5"), /dos decimales/);
});

test("un resultado tardío sólo se aplica a la sesión que inició el aporte", () => {
  const sessionA = { userId: "user-a" };
  const sessionB = { userId: "user-b" };
  assert.equal(mod.canApplyContributionResult(sessionA, sessionA), true);
  assert.equal(mod.canApplyContributionResult(sessionA, sessionB), false);
  assert.equal(mod.canApplyContributionResult(sessionA, { userId: null }), false);
});

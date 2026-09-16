import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/domain/financial-v2.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const domain = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const position = (id = "position-1", overrides = {}) => ({
  id, userId: "user-1", envelopeId: "envelope-1", investmentId: "investment-1",
  accountId: "account-1", currency: "ARS", ...overrides,
});
const contribution = (id, amount, occurredAt, positionId = "position-1") =>
  ({ id, positionId, kind: "contribution", amount, occurredAt });
const withdrawal = (id, amount, occurredAt, positionId = "position-1") =>
  ({ id, positionId, kind: "withdrawal", amount, occurredAt });
const valuation = (id, value, valuedAt, positionId = "position-1") =>
  ({ id, positionId, value, valuedAt });

test("un aporte conserva capital, valor y rendimiento nulo", () => {
  const result = domain.calculatePositionSnapshot(position(), [contribution("c1", 100, "2026-01-01T10:00:00Z")], []);
  assert.deepEqual({
    contributions: result.historicalContributions, withdrawals: result.historicalWithdrawals,
    capital: result.remainingCapital, value: result.currentValue,
    realized: result.realizedPerformance, unrealized: result.unrealizedPerformance,
    historical: result.historicalPerformance,
  }, { contributions: 100, withdrawals: 0, capital: 100, value: 100, realized: 0, unrealized: 0, historical: 0 });
});

test("varios aportes aumentan siempre el capital histórico", () => {
  const result = domain.calculatePositionSnapshot(position(), [
    contribution("c1", 100, "2026-01-01T10:00:00Z"),
    contribution("c2", 50, "2026-01-02T10:00:00Z"),
  ], []);
  assert.equal(result.historicalContributions, 150);
  assert.equal(result.remainingCapital, 150);
  assert.equal(result.currentValue, 150);
});

test("una valuación positiva crea rendimiento no realizado", () => {
  const result = domain.calculatePositionSnapshot(position(), [contribution("c1", 100, "2026-01-01T10:00:00Z")], [
    valuation("v1", 130, "2026-01-02T10:00:00Z"),
  ]);
  assert.equal(result.currentValue, 130);
  assert.equal(result.unrealizedPerformance, 30);
  assert.equal(result.realizedPerformance, 0);
  assert.equal(result.historicalPerformance, 30);
});

test("un retiro menor que la ganancia realiza sólo ganancia", () => {
  const result = domain.calculatePositionSnapshot(position(), [
    contribution("c1", 100, "2026-01-01T10:00:00Z"),
    withdrawal("w1", 15, "2026-01-03T10:00:00Z"),
  ], [valuation("v1", 130, "2026-01-02T10:00:00Z")]);
  assert.deepEqual(result.withdrawalBreakdowns[0], {
    withdrawalId: "w1", amount: 15, fromGain: 15, fromCapital: 0,
    realizedLoss: 0, capitalBasisReduction: 0,
  });
  assert.equal(result.remainingCapital, 100);
  assert.equal(result.currentValue, 115);
  assert.equal(result.realizedGain, 15);
  assert.equal(result.unrealizedPerformance, 15);
  assert.equal(result.historicalPerformance, 30);
});

test("un retiro mayor que la ganancia consume primero ganancia y luego capital", () => {
  const result = domain.calculatePositionSnapshot(position(), [
    contribution("c1", 100, "2026-01-01T10:00:00Z"),
    withdrawal("w1", 50, "2026-01-03T10:00:00Z"),
  ], [valuation("v1", 130, "2026-01-02T10:00:00Z")]);
  assert.deepEqual(result.withdrawalBreakdowns[0], {
    withdrawalId: "w1", amount: 50, fromGain: 30, fromCapital: 20,
    realizedLoss: 0, capitalBasisReduction: 20,
  });
  assert.equal(result.currentValue, 80);
  assert.equal(result.remainingCapital, 80);
  assert.equal(result.realizedPerformance, 30);
  assert.equal(result.unrealizedPerformance, 0);
  assert.equal(result.historicalPerformance, 30);
});

test("una pérdida se mantiene en el rendimiento histórico", () => {
  const result = domain.calculatePositionSnapshot(position(), [
    contribution("c1", 100, "2026-01-01T10:00:00Z"),
  ], [valuation("v1", 80, "2026-01-02T10:00:00Z")]);
  assert.equal(result.currentValue, 80);
  assert.equal(result.remainingCapital, 100);
  assert.equal(result.realizedPerformance, 0);
  assert.equal(result.unrealizedPerformance, -20);
  assert.equal(result.historicalPerformance, -20);
});

test("un retiro parcial en pérdida realiza pérdida proporcional y la conserva", () => {
  const result = domain.calculatePositionSnapshot(position(), [
    contribution("c1", 100, "2026-01-01T10:00:00Z"),
    withdrawal("w1", 40, "2026-01-03T10:00:00Z"),
  ], [valuation("v1", 80, "2026-01-02T10:00:00Z")]);
  assert.deepEqual(result.withdrawalBreakdowns[0], {
    withdrawalId: "w1", amount: 40, fromGain: 0, fromCapital: 40,
    realizedLoss: -10, capitalBasisReduction: 50,
  });
  assert.equal(result.currentValue, 40);
  assert.equal(result.remainingCapital, 50);
  assert.equal(result.realizedLoss, -10);
  assert.equal(result.unrealizedPerformance, -10);
  assert.equal(result.historicalPerformance, -20);
});

test("la pérdida proporcional realizada más la no realizada conserva exactamente la pérdida histórica", () => {
  const result = domain.calculatePositionSnapshot(position(), [
    contribution("c1", 100000, "2026-01-01T10:00:00Z"),
    withdrawal("w1", 30000, "2026-01-03T10:00:00Z"),
  ], [valuation("v1", 80000, "2026-01-02T10:00:00Z")]);
  assert.equal(result.realizedLoss, -7500);
  assert.equal(result.unrealizedPerformance, -12500);
  assert.equal(result.realizedPerformance + result.unrealizedPerformance, -20000);
  assert.equal(result.historicalPerformance, -20000);
});

test("el cierre completo de una posición en pérdida conserva la pérdida realizada", () => {
  const result = domain.calculatePositionSnapshot(position(), [
    contribution("c1", 100, "2026-01-01T10:00:00Z"),
    withdrawal("w1", 80, "2026-01-03T10:00:00Z"),
  ], [valuation("v1", 80, "2026-01-02T10:00:00Z")]);
  assert.equal(result.currentValue, 0);
  assert.equal(result.remainingCapital, 0);
  assert.equal(result.realizedLoss, -20);
  assert.equal(result.unrealizedPerformance, 0);
  assert.equal(result.historicalPerformance, -20);
});

test("un nuevo aporte posterior a retiros agrega capital nuevo y conserva rendimiento pasado", () => {
  const result = domain.calculatePositionSnapshot(position(), [
    contribution("c1", 100, "2026-01-01T10:00:00Z"),
    withdrawal("w1", 30, "2026-01-03T10:00:00Z"),
    contribution("c2", 50, "2026-01-04T10:00:00Z"),
  ], [valuation("v1", 120, "2026-01-02T10:00:00Z")]);
  assert.equal(result.historicalContributions, 150);
  assert.equal(result.historicalWithdrawals, 30);
  assert.equal(result.capitalWithdrawn, 10);
  assert.equal(result.remainingCapital, 140);
  assert.equal(result.currentValue, 140);
  assert.equal(result.realizedGain, 20);
  assert.equal(result.historicalPerformance, 20);
});

test("no se permite retirar más que el valor disponible ni dejar valor negativo", () => {
  const snapshot = domain.calculatePositionSnapshot(position(), [contribution("c1", 100, "2026-01-01T10:00:00Z")], []);
  assert.throws(() => domain.validateWithdrawal(snapshot, 100.01), /no puede superar/);
  assert.throws(() => domain.calculatePositionSnapshot(position(), [
    contribution("c1", 100, "2026-01-01T10:00:00Z"), withdrawal("w1", 101, "2026-01-02T10:00:00Z"),
  ], []), /no puede superar/);
});

test("una valuación entre movimientos actualiza el valor y los movimientos posteriores la ajustan", () => {
  const result = domain.calculatePositionSnapshot(position(), [
    contribution("c1", 100, "2026-01-01T10:00:00Z"),
    contribution("c2", 25, "2026-01-03T10:00:00Z"),
    withdrawal("w1", 10, "2026-01-04T10:00:00Z"),
  ], [valuation("v1", 120, "2026-01-02T10:00:00Z")]);
  assert.equal(result.currentValue, 135);
  assert.equal(result.remainingCapital, 125);
  assert.equal(result.realizedGain, 10);
  assert.equal(result.unrealizedPerformance, 10);
  assert.equal(result.historicalPerformance, 20);
});

test("un movimiento se procesa antes que una valuación con la misma fecha y hora", () => {
  const atSameInstant = "2026-01-02T10:00:00Z";
  const result = domain.calculatePositionSnapshot(position(), [
    contribution("c1", 100, "2026-01-01T10:00:00Z"),
    withdrawal("w1", 20, atSameInstant),
  ], [valuation("v1", 150, atSameInstant)]);
  assert.equal(result.withdrawalBreakdowns[0].fromGain, 0);
  assert.equal(result.withdrawalBreakdowns[0].fromCapital, 20);
  assert.equal(result.remainingCapital, 80);
  assert.equal(result.currentValue, 150);
  assert.equal(result.historicalPerformance, 70);
});

test("una valuación retroactiva recalcula cronológicamente los retiros posteriores", () => {
  const movements = [
    contribution("c1", 100, "2026-01-01T10:00:00Z"),
    withdrawal("w1", 50, "2026-01-03T10:00:00Z"),
  ];
  const withoutRetroactiveValuation = domain.calculatePositionSnapshot(position(), movements, [
    valuation("v-later", 60, "2026-01-04T10:00:00Z"),
  ]);
  const withRetroactiveValuation = domain.calculatePositionSnapshot(position(), movements, [
    // The array is intentionally unsorted: this valuation was entered later
    // but describes the position before the withdrawal.
    valuation("v-later", 60, "2026-01-04T10:00:00Z"),
    valuation("v-retroactive", 130, "2026-01-02T10:00:00Z"),
  ]);
  assert.equal(withoutRetroactiveValuation.remainingCapital, 50);
  assert.equal(withoutRetroactiveValuation.realizedGain, 0);
  assert.equal(withRetroactiveValuation.remainingCapital, 80);
  assert.equal(withRetroactiveValuation.realizedGain, 30);
  assert.equal(withRetroactiveValuation.unrealizedPerformance, -20);
  assert.equal(withRetroactiveValuation.historicalPerformance, 10);
  assert.equal(withRetroactiveValuation.currentValue, withoutRetroactiveValuation.currentValue);
});

test("la agregación por sobre conserva monedas separadas si no hay cotización", () => {
  const ars = position("ars", { envelopeId: "shared", currency: "ARS" });
  const usd = position("usd", { envelopeId: "shared", currency: "USD", accountId: "account-2" });
  const snapshots = [
    domain.calculatePositionSnapshot(ars, [contribution("ca", 1000, "2026-01-01T10:00:00Z", "ars")], []),
    domain.calculatePositionSnapshot(usd, [contribution("cu", 10, "2026-01-01T10:00:00Z", "usd")], []),
  ];
  const [group] = domain.aggregateByEnvelope([ars, usd], snapshots);
  assert.equal(group.native.ARS.currentValue, 1000);
  assert.equal(group.native.USD.currentValue, 10);
  assert.equal(group.converted, undefined);
});

test("la conversión exige una cotización explícita y agrega el sobre en ARS", () => {
  const ars = position("ars", { envelopeId: "shared", currency: "ARS" });
  const usd = position("usd", { envelopeId: "shared", currency: "USD", accountId: "account-2" });
  const snapshots = [
    domain.calculatePositionSnapshot(ars, [contribution("ca", 1000, "2026-01-01T10:00:00Z", "ars")], []),
    domain.calculatePositionSnapshot(usd, [contribution("cu", 10, "2026-01-01T10:00:00Z", "usd")], []),
  ];
  const [group] = domain.aggregateByEnvelope([ars, usd], snapshots, { baseCurrency: "ARS", ratesToBase: { USD: 1200 } });
  assert.equal(group.baseCurrency, "ARS");
  assert.equal(group.converted.currentValue, 13000);
  assert.throws(() => domain.convertToBase(1, "USD", { baseCurrency: "ARS", ratesToBase: {} }), /Falta una cotización/);
});

test("la misma inversión se agrega por separado por moneda y plataforma hasta convertir", () => {
  const ars = position("ars", { investmentId: "fci", accountId: "galicia", currency: "ARS" });
  const usd = position("usd", { investmentId: "fci", accountId: "balanz", currency: "USD" });
  const snapshots = [
    domain.calculatePositionSnapshot(ars, [contribution("ca", 1000, "2026-01-01T10:00:00Z", "ars")], []),
    domain.calculatePositionSnapshot(usd, [contribution("cu", 10, "2026-01-01T10:00:00Z", "usd")], []),
  ];
  const [investment] = domain.aggregateByInvestment([ars, usd], snapshots);
  assert.equal(investment.groupId, "fci");
  assert.deepEqual(Object.keys(investment.native).sort(), ["ARS", "USD"]);
  const byAccount = domain.aggregateByAccount([ars, usd], snapshots, { baseCurrency: "ARS", ratesToBase: { USD: 1200 } });
  assert.equal(byAccount.find((group) => group.groupId === "galicia").converted.currentValue, 1000);
  assert.equal(byAccount.find((group) => group.groupId === "balanz").converted.currentValue, 12000);
});

test("una posición con ID ajeno o moneda incompatible no puede agregarse silenciosamente", () => {
  const snapshot = domain.calculatePositionSnapshot(position(), [contribution("c1", 10, "2026-01-01T10:00:00Z")], []);
  assert.throws(() => domain.aggregateByEnvelope([], [snapshot]), /No existe la posición/);
  assert.throws(() => domain.aggregateByEnvelope([position()], [{ ...snapshot, currency: "USD" }]), /no coincide/);
});

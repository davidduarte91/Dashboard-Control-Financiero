import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
const domain = readFileSync(new URL("../src/domain/financial-v2.ts", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/lib/financial-v2-read.ts", import.meta.url), "utf8").replace(/import[\s\S]*?from "@\/domain\/financial-v2";\n/, domain);
const mod = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString("base64")}`);
const base = { envelopes:[{id:"e",userId:"u",name:"Sobre"}], investments:[{id:"i",userId:"u",name:"SBS RTA PESOS"}], accounts:[{id:"a",userId:"u",name:"Brubank"}], positions:[{id:"p",userId:"u",envelopeId:"e",investmentId:"i",accountId:"a",currency:"ARS"}], movements:[], valuations:[], snapshots:[{positionId:"p",currency:"ARS",currentValue:120,availableToWithdraw:120,historicalContributions:100,historicalWithdrawals:0,capitalWithdrawn:0,remainingCapital:100,realizedGain:0,realizedLoss:0,realizedPerformance:0,unrealizedPerformance:20,historicalPerformance:20,withdrawalBreakdowns:[]}] };
test("agrupa snapshots por sobre e inversión sin mezclar monedas", () => { const d=mod.buildV2Dashboard(base); assert.equal(d.envelopeGroups[0].native.ARS.currentValue,120); assert.equal(d.investmentGroups[0].native.ARS.historicalPerformance,20); assert.equal(d.hasPendingSbsReconciliation,true); });
test("marca datos incompletos cuando falta un snapshot", () => assert.equal(mod.buildV2Dashboard({...base,snapshots:[]}).complete,false));
test("la lectura adapta los snapshots con la moneda de su posición", async () => {
  const rows = {
    financial_envelopes: [{ id: "e", user_id: "u", name: "Sobre", archived_at: null }],
    financial_investments: [{ id: "i", user_id: "u", name: "Inversión", archived_at: null }],
    financial_accounts: [{ id: "a", user_id: "u", name: "Cuenta", archived_at: null }],
    financial_positions: [{ id: "p", user_id: "u", envelope_id: "e", investment_id: "i", account_id: "a", currency: "USD", archived_at: null }],
    financial_position_movements: [], financial_position_valuations: [],
    financial_position_snapshots: [{ position_id: "p", current_value: "25.50", historical_contributions: "20", historical_withdrawals: "0", capital_withdrawn: "0", remaining_capital: "20", realized_gain: "0", realized_loss: "0", realized_performance: "0", unrealized_performance: "5.5", historical_performance: "5.5", last_valuation_at: null }],
  };
  const client = { from: (table) => ({ select: () => ({ eq: async () => ({ data: rows[table], error: null }) }) }) };
  const result = await mod.readFinancialV2(client, "u");
  assert.equal(result.snapshots[0].currency, "USD");
  assert.equal(result.snapshots[0].currentValue, 25.5);
});
test("falla de forma segura si una consulta v2 devuelve un error", async () => {
  const client = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: "RLS" } }) }) }) };
  await assert.rejects(() => mod.readFinancialV2(client, "u"), /RLS/);
});

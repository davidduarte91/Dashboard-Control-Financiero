/* Read-only v1 -> v2 migration preview. It never calls an RPC or mutation. */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";

const root = process.cwd();
const outputJson = path.join(root, "migration-preview-data.json");
const outputReport = path.join(root, "migration-preview-report.md");
const localEnv = Object.fromEntries(fs.readFileSync(path.join(root, ".env.local"), "utf8")
  .split(/\r?\n/).filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
  .map((line) => { const index = line.indexOf("="); return [line.slice(0, index).trim(), line.slice(index + 1).trim()]; }));
const client = createClient(localEnv.NEXT_PUBLIC_SUPABASE_URL, localEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const prompt = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const readPassword = () => new Promise((resolve, reject) => {
  if (!process.stdin.isTTY) reject(new Error("El ingreso de contraseña requiere una terminal interactiva."));
  let value = "";
  const cleanup = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener("data", onData); };
  const onData = (chunk) => {
    const key = chunk.toString("utf8");
    if (key === "\u0003") { cleanup(); reject(new Error("Inicio de sesión cancelado.")); return; }
    if (key === "\r" || key === "\n") { cleanup(); process.stdout.write("\n"); resolve(value); return; }
    if (key === "\u007f" || key === "\b") { value = value.slice(0, -1); return; }
    value += key;
  };
  process.stdout.write("Contraseña: ");
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
});
if (!process.stdin.isTTY) throw new Error("Ejecutá este script en una terminal interactiva; no acepta credenciales por archivo ni variables de entorno.");
const email = (await prompt.question("Email: ")).trim();
let password = await readPassword();
prompt.close();
const { data: signInData, error: signInError } = await client.auth.signInWithPassword({ email, password });
password = "";
if (signInError || !signInData.user) throw new Error(`No se pudo iniciar sesión: ${signInError?.message || "usuario no disponible"}`);
const { data: userData, error: userError } = await client.auth.getUser();
if (userError || !userData.user) throw new Error(`No se pudo verificar la sesión: ${userError?.message || "sesión no disponible"}`);
const authenticatedUser = { id: userData.user.id, email: userData.user.email || "identificador no disponible" };
console.log(`Usuario autenticado: ${authenticatedUser.email}`);
try {
const readAll = async (table, columns) => {
  const rows = []; const pageSize = 1000;
  for (let from = 0;; from += pageSize) {
    const { data, error } = await client.from(table).select(columns).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message || error.code || "lectura rechazada"}`);
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
};
const clean = (value) => typeof value === "string" ? value.trim() : "";
const currencySet = new Set(["ARS", "USD", "USDT"]);
const typeSet = new Set(["aporte", "retiro", "valuacion"]);
const confirmedValuationRules = new Map([
  ["d86b3a8a-4042-4962-ad39-0c894c08263c", { type: "resolved_envelope", envelope: "Ahorro David" }],
  ["577a29e7-52f2-4f59-a260-df73f19ed793", { type: "resolved_envelope", envelope: "Ahorro David" }],
  ["0233822a-83ac-4048-aa7b-92f290ae8688", { type: "resolved_envelope", envelope: "Ahorro David" }],
  ["102bd81b-d7c4-45e8-86a8-c56305cdf03e", { type: "aggregate_multi_envelope_valuation", scope: "SBS RTA PESOS | Brubank | ARS" }],
]);
const confirmedEnvelopeFor = (entry) => {
  if (entry.account === "Lemon" && entry.currency === "USD") return "Ahorro David";
  if (entry.account === "Brubank" && ["SBS RTA FIJA", "Cedears", "Acciones argentinas"].includes(entry.investment)) return "Ahorro David";
  return clean(entry.envelope);
};
const positionKey = (entry) => [entry.user_id, clean(entry.envelope), clean(entry.investment), clean(entry.account), entry.currency].join("|");

const entries = await readAll("financial_entries", "id,user_id,envelope,investment,account,currency,kind,amount,current_value,entry_date,created_at");
const lists = await readAll("financial_lists", "user_id,envelopes,investments,accounts,updated_at");
const sameDay = new Map();
for (const entry of entries) {
  const key = `${positionKey(entry)}|${entry.entry_date}`;
  sameDay.set(key, [...(sameDay.get(key) || []), entry]);
}
const classified = entries.map((entry) => {
  const issues = [];
  const valuationRule = confirmedValuationRules.get(entry.id);
  const resolvedEnvelope = valuationRule?.type === "resolved_envelope" ? valuationRule.envelope : confirmedEnvelopeFor(entry);
  const effectiveEntry = { ...entry, envelope: resolvedEnvelope };
  if (!clean(effectiveEntry.envelope) || !clean(entry.investment) || !clean(entry.account)) issues.push("dimensión faltante");
  if (!currencySet.has(entry.currency)) issues.push("moneda inválida");
  if (!typeSet.has(entry.kind)) issues.push("tipo inválido");
  if (!entry.entry_date) issues.push("fecha faltante");
  if (["aporte", "retiro"].includes(entry.kind) && !(Number(entry.amount) > 0)) issues.push("importe de movimiento inválido");
  if (entry.kind === "valuacion" && Number(entry.current_value) < 0) issues.push("valuación negativa");
  // Confirmed v1 rule: current_value equal to amount is legacy redundancy, never
  // an implicit valuation. A different nonzero value still needs manual review.
  if (["aporte", "retiro"].includes(entry.kind) && Number(entry.current_value) !== Number(entry.amount)) issues.push("current_value distinto de amount");
  if (entry.kind === "valuacion" && Number(entry.amount) !== 0) issues.push("amount ambiguo");
  const sameDayEvents = sameDay.get(`${positionKey(entry)}|${entry.entry_date}`) || [];
  const orderingManual = sameDayEvents.length > 1;
  const orderingSafeByCreatedAt = orderingManual && sameDayEvents.every((event) => event.kind === "aporte");
  // Confirmed rule applies only to same-day groups made exclusively of contributions.
  if (orderingManual && !orderingSafeByCreatedAt) issues.push("orden del mismo día requiere revisión manual");
  const status = valuationRule?.type === "aggregate_multi_envelope_valuation" ? "aggregate_multi_envelope_valuation"
    : valuationRule?.type === "resolved_envelope" ? "resolved_by_manual_rule"
    : issues.some((issue) => /faltante|inválid/.test(issue)) ? "invalid_or_incomplete"
    : issues.length ? "manual_review" : "automatic";
  return { ...entry, normalized: { envelope: resolvedEnvelope, investment: clean(entry.investment), account: clean(entry.account) },
    confirmed_valuation_rule: valuationRule || null,
    v2_position_key: status !== "aggregate_multi_envelope_valuation" && !issues.some((issue) => /dimensión|moneda/.test(issue)) ? positionKey(effectiveEntry) : null,
    valuation_unambiguous: entry.kind === "valuacion" && ["automatic", "resolved_by_manual_rule"].includes(status),
    status, issues, ordering_manual: orderingManual && !orderingSafeByCreatedAt,
    ordering_technical_by_created_at: orderingSafeByCreatedAt };
});
const automatic = classified.filter((entry) => entry.status === "automatic");
const resolvedByManualRule = classified.filter((entry) => entry.status === "resolved_by_manual_rule");
const migratable = classified.filter((entry) => ["automatic", "resolved_by_manual_rule"].includes(entry.status));
const positionEligible = migratable.filter((entry) => entry.v2_position_key && entry.kind !== "valuacion");
const inferredPositions = Object.values(positionEligible.reduce((all, entry) => {
  const item = all[entry.v2_position_key] ||= { key: entry.v2_position_key, user_id: entry.user_id, envelope: entry.normalized.envelope, investment: entry.normalized.investment, account: entry.normalized.account, currency: entry.currency, movements: 0, valuations: 0, legacy_entry_ids: [] };
  if (entry.kind === "valuacion") item.valuations++; else item.movements++;
  item.legacy_entry_ids.push(entry.id); return all;
}, {}));
const sum = (rows, kind) => rows.filter((row) => row.kind === kind).reduce((total, row) => total + Number(row.amount || 0), 0);
const reconciliation = [...new Set(entries.map((entry) => `${entry.user_id}|${entry.currency}`))].map((key) => {
  const [user_id, currency] = key.split("|"); const all = entries.filter((entry) => entry.user_id === user_id && entry.currency === currency);
  const projected = migratable.filter((entry) => entry.user_id === user_id && entry.currency === currency);
  return { user_id, currency, v1: { contributions: sum(all, "aporte"), withdrawals: sum(all, "retiro"), movements: all.filter((x) => x.kind !== "valuacion").length, valuations: all.filter((x) => x.kind === "valuacion").length }, projected: { contributions: sum(projected, "aporte"), withdrawals: sum(projected, "retiro"), movements: projected.filter((x) => x.kind !== "valuacion").length, valuations: projected.filter((x) => x.kind === "valuacion").length } };
});
const listAudit = lists.map((list) => {
  const used = classified.filter((entry) => entry.user_id === list.user_id);
  const audit = (field, label) => { const listed = (list[field] || []).map(clean); const usedNames = new Set(used.map((entry) => entry.normalized[label]).filter(Boolean)); return { blank: listed.filter((x) => !x), duplicates: [...new Set(listed.filter((x, i) => x && listed.indexOf(x) !== i))], listed_not_used: listed.filter((x) => x && !usedNames.has(x)), used_not_listed: [...usedNames].filter((x) => !listed.includes(x)) }; };
  return { user_id: list.user_id, envelopes: audit("envelopes", "envelope"), investments: audit("investments", "investment"), accounts: audit("accounts", "account") };
});
const summary = {
  analyzed_entries: entries.length,
  automatic: automatic.length,
  resolved_by_manual_rule: resolvedByManualRule.length,
  invalid_or_incomplete: classified.filter((x) => x.status === "invalid_or_incomplete").length,
  aggregate_multi_envelope_valuations: classified.filter((x) => x.status === "aggregate_multi_envelope_valuation").length,
  inferred_positions: inferredPositions.length,
  technical_created_at_order_groups: [...sameDay.values()].filter((group) => group.length > 1 && group.every((event) => event.kind === "aporte")).length,
  applicable_valuations: migratable.filter((x) => x.kind === "valuacion").length,
  legacy_valuations_not_applied: classified.filter((x) => x.kind === "valuacion" && x.status === "aggregate_multi_envelope_valuation").length,
  ambiguous_valuations: classified.filter((x) => x.kind === "valuacion" && ["manual_review", "invalid_or_incomplete"].includes(x.status)).length,
};
const payload = { generated_at: new Date().toISOString(), analyzed_user: authenticatedUser, summary, entries: classified, inferred_positions: inferredPositions, reconciliation, list_audit: listAudit };
fs.writeFileSync(outputJson, JSON.stringify(payload, null, 2));
fs.writeFileSync(outputReport, `# Vista previa de migración v1 → v2\n\n- Usuario analizado: ${authenticatedUser.email}\n- Entradas analizadas: ${summary.analyzed_entries}\n- Migrables automáticamente: ${summary.automatic}\n- Resueltas por regla manual: ${summary.resolved_by_manual_rule}\n- Inválidas/incompletas: ${summary.invalid_or_incomplete}\n- Valuaciones agregadas multi-sobre no aplicadas: ${summary.aggregate_multi_envelope_valuations}\n- Posiciones v2 inferidas: ${summary.inferred_positions}\n- Grupos con secuencia técnica por created_at: ${summary.technical_created_at_order_groups}\n- Valuaciones aplicables: ${summary.applicable_valuations}\n- Valuaciones legacy no aplicadas: ${summary.legacy_valuations_not_applied}\n- Valuaciones ambiguas: ${summary.ambiguous_valuations}\n\nLos detalles, conciliación por usuario/moneda y auditoría de listas están en \`migration-preview-data.json\`.\n`);
console.log(`Reporte generado: ${path.basename(outputReport)}; datos: ${path.basename(outputJson)}; entradas: ${summary.analyzed_entries}`);
} finally {
  await client.auth.signOut();
}

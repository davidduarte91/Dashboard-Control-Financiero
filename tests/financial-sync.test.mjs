import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Compile in memory: no application startup, environment files or live client.
const source = readFileSync(new URL("../src/lib/financial-sync.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const sync = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const cacheSource = readFileSync(new URL("../src/lib/financial-cache.ts", import.meta.url), "utf8");
const cacheCompiled = ts.transpileModule(cacheSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const cache = await import(`data:text/javascript;base64,${Buffer.from(cacheCompiled).toString("base64")}`);
const pageSource = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
const pageAst = ts.createSourceFile("page.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const home = pageAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "Home");

function entry(id, overrides = {}) {
  return {
    id, envelope: "Origen", investment: "FCI", account: "Banco", currency: "ARS",
    amount: 100.5, currentValue: 110.25, exchangeRate: 1,
    date: "2026-09-16", createdAt: "2026-09-16T12:00:00.000Z", kind: "aporte",
    ...overrides,
  };
}

function row(id, user = "u1", overrides = {}) {
  return {
    id, user_id: user, envelope: "Origen", investment: "FCI", account: "Banco",
    currency: "ARS", amount: 100.5, current_value: 110.25, exchange_rate: 1,
    entry_date: "2026-09-16", created_at: "2026-09-16T12:00:00.000Z", kind: "aporte",
    ...overrides,
  };
}

function fakeClient(initial = {}) {
  const tables = {
    financial_entries: structuredClone(initial.entries || []),
    financial_lists: structuredClone(initial.lists || []),
  };
  const calls = [];
  const failures = [];
  const delays = [];
  return {
    tables, calls, failures, delays,
    from(table) {
      let kind = "select", payload, single = false;
      const filters = [];
      const query = {
        insert(value) { kind = "insert"; payload = value; return query; },
        update(value) { kind = "update"; payload = value; return query; },
        delete() { kind = "delete"; return query; },
        upsert(value) {
          assert.equal(table, "financial_lists", "Entries must never be bulk-upserted");
          kind = "upsert"; payload = value; return query;
        },
        eq(key, value) { filters.push([key, value]); return query; },
        select() { return query; },
        order() { return query; },
        maybeSingle() { single = true; return query; },
        then(resolve, reject) {
          return Promise.resolve().then(async () => {
            calls.push(structuredClone({ table, kind, payload, filters }));
            const delayIndex = delays.findIndex((item) => item.table === table && item.kind === kind);
            if (delayIndex >= 0) await delays.splice(delayIndex, 1)[0].wait;
            const failureIndex = failures.findIndex((item) => item.table === table && item.kind === kind);
            const failure = failureIndex < 0 ? null : failures.splice(failureIndex, 1)[0];
            if (failure && !failure.afterCommit) return { data: null, error: { message: failure.message } };
            const matches = (item) => filters.every(([key, value]) => item[key] === value);
            let data = tables[table].filter(matches);
            if (kind === "insert") {
              const inserted = Array.isArray(payload) ? payload : [payload];
              if (inserted.some((value) => tables[table].some((item) => item.id === value.id))) {
                return { data: null, error: { code: "23505", message: "Duplicate ID" } };
              }
              tables[table].push(...structuredClone(inserted));
              data = inserted;
            } else if (kind === "update") {
              data.forEach((item) => Object.assign(item, structuredClone(payload)));
            } else if (kind === "delete") {
              tables[table] = tables[table].filter((item) => !matches(item));
            } else if (kind === "upsert") {
              const existing = tables[table].find((item) => item.user_id === payload.user_id);
              if (existing) Object.assign(existing, structuredClone(payload));
              else tables[table].push(structuredClone(payload));
            }
            if (failure?.afterCommit) throw new Error(failure.message);
            return { data: structuredClone(single ? data[0] || null : data), error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test("a stale device creates one entry without changing the other device's entries", async () => {
  const otherDevice = row("b", "u1", { amount: 800, current_value: 950 });
  const client = fakeClient({ entries: [row("a"), otherDevice, row("private", "u2")] });
  await sync.saveFinancialEntry(client, "u1", entry("c"), "create");
  assert.deepEqual(client.tables.financial_entries.slice(0, 3), [row("a"), otherDevice, row("private", "u2")]);
  assert.equal(client.tables.financial_entries.length, 4);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].kind, "insert");
});

test("editing changes only the selected owner/ID and preserves its creation date", async () => {
  const client = fakeClient({ entries: [row("a"), row("b"), row("private", "u2")] });
  await sync.saveFinancialEntry(client, "u1", entry("a", { amount: 0.25, createdAt: "2099-01-01" }), "edit");
  assert.equal(client.tables.financial_entries[0].amount, 0.25);
  assert.equal(client.tables.financial_entries[0].created_at, row("a").created_at);
  assert.deepEqual(client.tables.financial_entries.slice(1), [row("b"), row("private", "u2")]);
  assert.deepEqual(client.calls[0].filters, [["user_id", "u1"], ["id", "a"]]);
});

test("editing a remotely deleted or inaccessible entry never recreates it", async () => {
  const client = fakeClient({ entries: [row("private", "u2")] });
  for (const id of ["deleted", "private"]) {
    await assert.rejects(sync.saveFinancialEntry(client, "u1", entry(id), "edit"), /ya no existe/);
  }
  assert.deepEqual(client.tables.financial_entries, [row("private", "u2")]);
});

test("deletion is explicit, user-scoped and safe to repeat", async () => {
  const client = fakeClient({ entries: [row("a"), row("b"), row("private", "u2")] });
  await sync.deleteFinancialEntry(client, "u1", "a");
  await sync.deleteFinancialEntry(client, "u1", "a");
  await sync.deleteFinancialEntry(client, "u1", "private");
  assert.deepEqual(client.tables.financial_entries, [row("b"), row("private", "u2")]);
  assert.deepEqual(client.calls[0].filters, [["user_id", "u1"], ["id", "a"]]);
});

test("renaming a whole envelope preserves newer amounts and includes unknown remote entries", async () => {
  const initial = [row("a", "u1", { amount: 900 }), row("b"), row("c", "u1", { envelope: "Otro" }), row("private", "u2")];
  const client = fakeClient({ entries: initial });
  await sync.changeFinancialEnvelope(client, "u1", "Origen", "Destino");
  assert.deepEqual(client.tables.financial_entries, initial.map((item) =>
    item.user_id === "u1" && item.envelope === "Origen" ? { ...item, envelope: "Destino" } : item));
  assert.deepEqual(client.calls[0].payload, { envelope: "Destino" });
});

test("removing an envelope clears its association without deleting money or entries", async () => {
  const client = fakeClient({ entries: [row("a"), row("private", "u2")] });
  await sync.changeFinancialEnvelope(client, "u1", "Origen", "");
  assert.deepEqual(client.tables.financial_entries, [row("a", "u1", { envelope: "" }), row("private", "u2")]);
});

test("list changes preserve names added by another device and do not restore stale names", async () => {
  const client = fakeClient({ lists: [{ user_id: "u1", envelopes: ["Origen", "Remoto"], investments: ["FCI", "Cedears"], accounts: ["Banco", "Otro"] }] });
  const fallback = { envelopes: ["Origen", "Borrado"], investments: ["FCI"], accounts: ["Banco"] };
  const next = await sync.saveFinancialLists(client, "u1", fallback, { accounts: ["Nueva"] }, { oldName: "Origen", newName: "Destino" });
  assert.deepEqual(next, { envelopes: ["Remoto", "Destino"], investments: ["FCI", "Cedears"], accounts: ["Banco", "Otro", "Nueva"] });
});

test("all mutation and list failures are propagated instead of treated as success", async () => {
  const cases = [
    ["financial_entries", "insert", (c) => sync.saveFinancialEntry(c, "u1", entry("b"), "create")],
    ["financial_entries", "update", (c) => sync.saveFinancialEntry(c, "u1", entry("a"), "edit")],
    ["financial_entries", "delete", (c) => sync.deleteFinancialEntry(c, "u1", "a")],
    ["financial_entries", "update", (c) => sync.changeFinancialEnvelope(c, "u1", "Origen", "Destino")],
    ["financial_lists", "select", (c) => sync.saveFinancialLists(c, "u1", { envelopes: [], investments: [], accounts: [] })],
    ["financial_lists", "upsert", (c) => sync.saveFinancialLists(c, "u1", { envelopes: [], investments: [], accounts: [] })],
  ];
  for (const [table, kind, operation] of cases) {
    const client = fakeClient({ entries: [row("a")] });
    client.failures.push({ table, kind, message: "Simulated network failure" });
    await assert.rejects(operation(client), /Simulated network failure/);
    assert.deepEqual(client.tables.financial_entries, [row("a")]);
  }
});

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data, reads: [], writes: [],
    getItem(key) { this.reads.push(key); return data.get(key) ?? null; },
    setItem(key, value) { this.writes.push(key); data.set(key, value); },
  };
}

function formHarness(client) {
  const names = new Set(["assertSession", "cacheEntries", "cacheLists", "runMutation", "saveEntry", "saveValuation", "renameEnvelope", "removeEnvelope"]);
  const declarations = home.body.statements.filter((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((decl) => names.has(decl.name.getText(pageAst))));
  const context = vm.createContext({
    ...sync, ...cache, Error, user: { id: "u1" }, supabase: client, entries: [],
    envelopes: ["Origen"], investments: ["FCI"], accounts: ["Banco"],
    envelopeMode: "existing", investmentMode: "existing", accountMode: "existing",
    editing: null, movementKind: "aporte", valuation: "FCI",
    savingRef: { current: false }, draftId: { current: null },
    sessionRef: { current: { userId: "u1", ready: true } },
    snapshotRef: { current: { entries: [], lists: { envelopes: ["Origen"], investments: ["FCI"], accounts: ["Banco"] } } },
    syncStatus: "local", authError: "", isSaving: false, isModalOpen: true, uuidCount: 0,
    FormData: class { constructor(form) { this.data = form; } get(name) { return this.data[name] ?? null; } },
    parseAmount: (value) => Number(value.replaceAll(".", "").replace(",", ".")),
    localStorage: memoryStorage(), window: { alert() {}, prompt: () => "Destino", confirm: () => true },
  });
  context.crypto = { randomUUID: () => `draft-${++context.uuidCount}` };
  for (const [setter, key] of Object.entries({ setEntries: "entries", setEnvelopes: "envelopes", setInvestments: "investments", setAccounts: "accounts", setSaving: "isSaving", setSyncStatus: "syncStatus", setAuthError: "authError", setModalOpen: "isModalOpen", setEditing: "editing", setValuation: "valuation" })) {
    context[setter] = (value) => { context[key] = value; };
  }
  const text = declarations.map((node) => node.getText(pageAst)).join("\n") + `\nglobalThis.handlers = { ${[...names].join(",")} };`;
  vm.runInContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.event = {
    preventDefault() {},
    currentTarget: { amount: "100,50", currentValue: "110,25", exchangeRate: "1,00", envelope: "Origen", investment: "FCI", account: "Banco", currency: "ARS", date: "2026-09-16", reset() {} },
  };
  return context;
}

test("rapid form submissions create only one movement and unlock after completion", async () => {
  const client = fakeClient();
  const ui = formHarness(client);
  const first = ui.handlers.saveEntry(ui.event);
  const second = ui.handlers.saveEntry(ui.event);
  assert.equal(ui.savingRef.current, true);
  await Promise.all([first, second]);
  assert.equal(client.tables.financial_entries.length, 1);
  assert.equal(client.tables.financial_entries[0].amount, 100.5);
  assert.equal(ui.uuidCount, 1);
  assert.equal(ui.syncStatus, "synced");
  assert.equal(ui.isModalOpen, false);
  assert.equal(ui.savingRef.current, false);
});

test("a failed entry after successful lists remains an error and retains the draft for retry", async () => {
  const client = fakeClient();
  client.failures.push({ table: "financial_entries", kind: "insert", message: "Offline" });
  const ui = formHarness(client);
  await ui.handlers.saveEntry(ui.event);
  assert.equal(ui.syncStatus, "error");
  assert.match(ui.authError, /Offline/);
  assert.equal(ui.isModalOpen, true);
  assert.equal(ui.entries.length, 0);
  assert.equal(ui.savingRef.current, false);
  await ui.handlers.saveEntry(ui.event);
  assert.equal(ui.uuidCount, 1);
  assert.equal(client.tables.financial_entries.length, 1);
  assert.equal(ui.syncStatus, "synced");
});

test("a lost creation response cannot duplicate a movement on retry", async () => {
  const client = fakeClient();
  client.failures.push({ table: "financial_entries", kind: "insert", message: "Response lost", afterCommit: true });
  const ui = formHarness(client);
  await ui.handlers.saveEntry(ui.event);
  await ui.handlers.saveEntry(ui.event);
  assert.equal(client.tables.financial_entries.length, 1);
  assert.equal(ui.uuidCount, 1);
  assert.equal(ui.syncStatus, "error");
  assert.match(ui.authError, /ya existe/);
  assert.equal(ui.isModalOpen, true);
});

test("valuation retries also reuse their ID", async () => {
  const client = fakeClient();
  client.failures.push({ table: "financial_entries", kind: "insert", message: "Offline" });
  const ui = formHarness(client);
  await ui.handlers.saveValuation(ui.event);
  await ui.handlers.saveValuation(ui.event);
  assert.equal(ui.uuidCount, 1);
  assert.equal(client.tables.financial_entries.length, 1);
  assert.equal(client.tables.financial_entries[0].kind, "valuacion");
});

test("partial envelope failure is reported and can be retried without touching amounts", async () => {
  const client = fakeClient({ entries: [row("a", "u1", { amount: 950 })] });
  client.failures.push({ table: "financial_lists", kind: "upsert", message: "Offline" });
  const ui = formHarness(client);
  ui.entries = [entry("a")];
  await ui.handlers.renameEnvelope("Origen");
  assert.equal(ui.syncStatus, "error");
  assert.match(ui.authError, /Los movimientos cambiaron de sobre/);
  assert.equal(client.tables.financial_entries[0].amount, 950);
  await ui.handlers.renameEnvelope("Origen");
  assert.equal(ui.syncStatus, "synced");
  assert.equal(client.tables.financial_entries[0].amount, 950);
  assert.deepEqual(client.tables.financial_lists[0].envelopes, ["Destino"]);
});

function sessionHarness(client, options = {}) {
  const ui = formHarness(client);
  let listener;
  let unsubscribed = false;
  client.auth = {
    getSession: () => options.initial || Promise.resolve({ data: { session: options.userId === null ? null : { user: { id: options.userId || "u1" } } }, error: null }),
    onAuthStateChange(callback) {
      listener = callback;
      return { data: { subscription: { unsubscribe() { unsubscribed = true; } } } };
    },
  };
  ui.defaults = ["FCI"];
  ui.localStorage = options.storage || memoryStorage();
  ui.v2Dashboard = null;
  ui.v2ReadError = false;
  ui.setV2Dashboard = (value) => { ui.v2Dashboard = value; };
  ui.setV2ReadError = (value) => { ui.v2ReadError = value; };
  ui.setV2ContributionOpen = (value) => { ui.v2ContributionOpen = value; };
  ui.setV2ContributionPositionId = (value) => { ui.v2ContributionPositionId = value; };
  ui.setV2ContributionAmount = (value) => { ui.v2ContributionAmount = value; };
  ui.setV2ContributionError = (value) => { ui.v2ContributionError = value; };
  ui.setV2ContributionMessage = (value) => { ui.v2ContributionMessage = value; };
  ui.setV2ContributionSaving = (value) => { ui.isV2ContributionSaving = value; };
  ui.setV2PendingContributions = (value) => { ui.v2PendingContributions = value; };
  ui.v2ContributionSavingRef = { current: false };
  ui.readPendingContributions = () => [];
  ui.buildV2Dashboard = (value) => value;
  ui.readFinancialV2 = options.readFinancialV2 || (async () => ({ positions: [], snapshots: [] }));
  for (const [setter, key] of Object.entries({ setUser: "user", setDark: "isDark", setToday: "today", setHydrated: "hydrated", setAuthLoading: "authLoading", setHistoryOpen: "historyOpen", setAuthEmail: "authEmail", setAuthPassword: "authPassword" })) {
    ui[setter] = (value) => { ui[key] = value; };
  }
  const timers = new Map();
  let nextTimer = 0;
  ui.setTimeout = (callback) => { timers.set(++nextTimer, callback); return nextTimer; };
  ui.clearTimeout = (id) => timers.delete(id);
  const effect = home.body.statements.find((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(pageAst) === "useEffect");
  vm.runInContext(ts.transpileModule(`globalThis.cleanup = (${effect.expression.arguments[0].getText(pageAst)})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, ui);
  ui.emit = (userId, event = "SIGNED_IN") => { if (!unsubscribed) listener(event, userId ? { user: { id: userId } } : null); };
  ui.flush = async () => {
    for (let i = 0; i < 40; i++) {
      for (const [id, callback] of timers) { timers.delete(id); callback(); }
      await Promise.resolve();
    }
  };
  return ui;
}

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

const snapshot = (id) => ({ entries: [entry(id)], lists: { envelopes: [id], investments: ["FCI"], accounts: [id] } });

test("caches are scoped to their owner and legacy data is never read, changed or imported", async () => {
  const legacy = { "finanzas-entries": JSON.stringify([entry("legacy")]), "finanzas-envelopes": '["Legacy"]', "finanzas-investments": '["Legacy"]', "finanzas-accounts": '["Legacy"]' };
  const storage = memoryStorage(legacy);
  cache.writeFinancialCache(storage, "u1", snapshot("a"));
  cache.writeFinancialCache(storage, "u2", snapshot("b"));
  assert.equal(cache.readFinancialCache(storage, "u1").entries[0].id, "a");
  assert.equal(cache.readFinancialCache(storage, "u2").entries[0].id, "b");
  assert.equal(cache.readFinancialCache(storage, "new"), null);
  const client = fakeClient();
  const ui = sessionHarness(client, { storage, userId: "new" });
  await ui.flush();
  assert.equal(ui.entries.length, 0);
  assert.equal(client.calls.some((call) => call.kind !== "select"), false);
  for (const [key, value] of Object.entries(legacy)) {
    assert.equal(storage.data.get(key), value);
    assert.equal(storage.reads.includes(key), false);
    assert.equal(storage.writes.includes(key), false);
  }
});

test("un fallo de lectura v2 conserva la vista v1 como respaldo", async () => {
  const client = fakeClient({ entries: [row("a", "u1")], lists: [{ user_id: "u1", envelopes: ["Origen"], investments: ["FCI"], accounts: ["Banco"] }] });
  const ui = sessionHarness(client, { userId: "u1", readFinancialV2: async () => { throw new Error("RLS"); } });
  await ui.flush();
  assert.equal(ui.entries[0].id, "a");
  assert.equal(ui.v2Dashboard, null);
  assert.equal(ui.v2ReadError, true);
});

test("invalid, foreign-owner and unavailable caches fail closed", () => {
  const storage = memoryStorage();
  for (const raw of ['{broken', JSON.stringify({ version: 1, userId: "u2", ...snapshot("b") }), JSON.stringify({ version: 1, userId: "u1", ...snapshot("a"), entries: [{ id: "bad" }] })]) {
    storage.data.set("finanzas-cache:v1:u1", raw);
    assert.equal(cache.readFinancialCache(storage, "u1"), null);
  }
  assert.equal(cache.readFinancialCache({ getItem() { throw new Error("Denied"); } }, "u1"), null);
  assert.throws(() => cache.writeFinancialCache(storage, "", snapshot("a")), /usuario identificado/);
});

test("successful cloud loads refresh only the current account's cache", async () => {
  const storage = memoryStorage();
  cache.writeFinancialCache(storage, "u2", snapshot("b"));
  const client = fakeClient({ entries: [row("fresh"), row("private", "u2")] });
  const ui = sessionHarness(client, { storage });
  await ui.flush();
  assert.equal(ui.entries[0].id, "fresh");
  assert.equal(cache.readFinancialCache(storage, "u1").entries[0].id, "fresh");
  assert.equal(cache.readFinancialCache(storage, "u2").entries[0].id, "b");
  assert.equal(ui.syncStatus, "synced");
});

test("connection errors use only the same user's validated cache", async () => {
  const storage = memoryStorage();
  cache.writeFinancialCache(storage, "u1", snapshot("a"));
  cache.writeFinancialCache(storage, "u2", snapshot("b"));
  const client = fakeClient();
  client.failures.push({ table: "financial_entries", kind: "select", message: "Offline" });
  const ui = sessionHarness(client, { storage });
  await ui.flush();
  assert.equal(ui.entries[0].id, "a");
  assert.equal(ui.syncStatus, "error");
  client.failures.push({ table: "financial_entries", kind: "select", message: "Offline" });
  ui.emit("u2");
  assert.equal(ui.entries.length, 0);
  await ui.flush();
  assert.equal(ui.entries[0].id, "b");
  assert.equal(ui.authLoading, false);
});

test("a new user offline cannot inherit another user's cache or legacy data", async () => {
  const storage = memoryStorage({ "finanzas-entries": JSON.stringify([entry("legacy")]) });
  cache.writeFinancialCache(storage, "u1", snapshot("a"));
  const client = fakeClient();
  client.failures.push({ table: "financial_entries", kind: "select", message: "Offline" });
  const ui = sessionHarness(client, { storage, userId: "u2" });
  await ui.flush();
  assert.equal(ui.entries.length, 0);
  assert.equal(ui.accounts.length, 0);
  assert.equal(ui.envelopes.length, 0);
  assert.match(ui.authError, /no hay una copia local válida/);
});

test("sign-out clears the visible data and drafts while preserving scoped stored copies", async () => {
  const client = fakeClient({ entries: [row("a")] });
  const ui = sessionHarness(client);
  await ui.flush();
  ui.editing = entry("a"); ui.valuation = "FCI"; ui.historyOpen = true; ui.isModalOpen = true; ui.draftId.current = "pending";
  ui.emit(null, "SIGNED_OUT");
  assert.equal(ui.user, null);
  assert.equal(ui.entries.length, 0);
  assert.equal(ui.snapshotRef.current.entries.length, 0);
  assert.equal(ui.editing, null);
  assert.equal(ui.valuation, "");
  assert.equal(ui.historyOpen, false);
  assert.equal(ui.isModalOpen, false);
  assert.equal(ui.draftId.current, null);
  assert.equal(cache.readFinancialCache(ui.localStorage, "u1").entries[0].id, "a");
});

test("a late response from A cannot replace B's display or cache", async () => {
  const delayed = deferred();
  const client = fakeClient({ entries: [row("a"), row("b", "u2")] });
  client.delays.push({ table: "financial_entries", kind: "select", wait: delayed.promise });
  const ui = sessionHarness(client);
  await ui.flush();
  ui.emit("u2");
  await ui.flush();
  assert.equal(ui.entries[0].id, "b");
  const writes = ui.localStorage.writes.length;
  delayed.resolve();
  await ui.flush();
  assert.equal(ui.entries[0].id, "b");
  assert.equal(ui.localStorage.writes.length, writes);
  assert.equal(cache.readFinancialCache(ui.localStorage, "u1"), null);
});

test("sign-out invalidates a pending load and returning to A does not revive the older load", async () => {
  const delayed = deferred();
  const client = fakeClient({ entries: [row("a")] });
  client.delays.push({ table: "financial_entries", kind: "select", wait: delayed.promise });
  const ui = sessionHarness(client);
  await ui.flush();
  ui.emit(null, "SIGNED_OUT");
  ui.emit("u1");
  await ui.flush();
  const writes = ui.localStorage.writes.length;
  delayed.resolve();
  await ui.flush();
  assert.equal(ui.localStorage.writes.length, writes);
  assert.equal(ui.entries[0].id, "a");
});

test("a stale getSession result cannot override a newer auth event", async () => {
  const initial = deferred();
  const client = fakeClient({ entries: [row("a"), row("b", "u2")] });
  const ui = sessionHarness(client, { initial: initial.promise });
  ui.emit("u2");
  await ui.flush();
  initial.resolve({ data: { session: { user: { id: "u1" } } }, error: null });
  await ui.flush();
  assert.equal(ui.user.id, "u2");
  assert.equal(ui.entries[0].id, "b");
});

test("same-user token refresh does not reset drafts or reload the history", async () => {
  const client = fakeClient({ entries: [row("a")] });
  const ui = sessionHarness(client);
  await ui.flush();
  ui.editing = entry("a"); ui.isModalOpen = true;
  const before = client.calls.length;
  ui.emit("u1", "TOKEN_REFRESHED");
  await ui.flush();
  assert.equal(ui.editing.id, "a");
  assert.equal(ui.isModalOpen, true);
  assert.equal(client.calls.length, before);
});

test("session changes stop a save after its list read, before any further writes", async () => {
  const client = fakeClient({ entries: [row("b", "u2")] });
  const ui = sessionHarness(client);
  await ui.flush();
  const delayed = deferred();
  client.delays.push({ table: "financial_lists", kind: "select", wait: delayed.promise });
  const save = ui.handlers.saveEntry(ui.event);
  await ui.flush();
  ui.emit("u2");
  await ui.flush();
  delayed.resolve();
  await save;
  assert.equal(client.calls.some((call) => call.kind === "upsert" || call.kind === "insert"), false);
  assert.equal(ui.entries[0].id, "b");
  assert.equal(ui.authError, "");
});

test("a completed old save cannot overwrite B's cache, close its form or release its saving lock", async () => {
  const client = fakeClient({ entries: [row("b", "u2")] });
  const ui = sessionHarness(client);
  await ui.flush();
  const delayed = deferred();
  client.delays.push({ table: "financial_entries", kind: "insert", wait: delayed.promise });
  const saveA = ui.handlers.saveEntry(ui.event);
  await ui.flush();
  ui.emit("u2");
  await ui.flush();
  ui.isModalOpen = true;
  const pendingB = deferred();
  const saveB = ui.handlers.runMutation(() => pendingB.promise);
  const writes = ui.localStorage.writes.length;
  delayed.resolve();
  await saveA;
  assert.equal(ui.entries[0].id, "b");
  assert.equal(ui.isModalOpen, true);
  assert.equal(ui.savingRef.current, true);
  assert.equal(ui.localStorage.writes.length, writes);
  pendingB.resolve();
  await saveB;
});

test("unmount discards pending load results and unsubscribes", async () => {
  const delayed = deferred();
  const client = fakeClient({ entries: [row("a")] });
  client.delays.push({ table: "financial_entries", kind: "select", wait: delayed.promise });
  const ui = sessionHarness(client);
  await ui.flush();
  ui.cleanup();
  const writes = ui.localStorage.writes.length;
  delayed.resolve();
  await ui.flush();
  assert.equal(ui.entries.length, 0);
  assert.equal(ui.localStorage.writes.length, writes);
  ui.emit("u2");
  assert.equal(ui.sessionRef.current.userId, null);
});

test("storage failure does not hide fresh cloud data or leave loading stuck", async () => {
  const storage = { getItem() { throw new Error("Denied"); }, setItem() { throw new Error("Denied"); } };
  const ui = sessionHarness(fakeClient({ entries: [row("a")] }), { storage });
  await ui.flush();
  assert.equal(ui.entries[0].id, "a");
  assert.equal(ui.authLoading, false);
  assert.match(ui.authError, /no se pudo guardar una copia local/);
});

test("decimal edit fields and USDT formatting retain the previous fix", () => {
  const helpers = pageSource.slice(pageSource.indexOf("const formatMoneyValue ="), pageSource.indexOf("export default function Home"));
  const context = vm.createContext({ Intl });
  vm.runInContext(ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const fields = new Map();
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(pageAst) === "input") {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const name = attrs.find((attr) => attr.name.getText(pageAst) === "name")?.initializer;
      const value = attrs.find((attr) => attr.name.getText(pageAst) === "defaultValue")?.initializer;
      if (name && ts.isStringLiteral(name) && value && ts.isJsxExpression(value) && value.expression) fields.set(name.text, value.expression.getText(pageAst));
    }
    ts.forEachChild(node, visit);
  }
  visit(pageAst);
  for (const value of [0, 0.25, 100.5, 1234.56, 1450.75]) {
    context.editing = { amount: value, currentValue: value, exchangeRate: value };
    for (const name of ["amount", "currentValue", "exchangeRate"]) {
      assert.ok(fields.has(name));
      const code = ts.transpileModule(`parseAmount(${fields.get(name)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      assert.equal(vm.runInContext(code, context), value);
    }
  }
  assert.equal(vm.runInContext('money(1234.56, "USDT")', context), "1.234,56 USDT");
  assert.equal(vm.runInContext('money(-0.25, "USDT")', context), "-0,25 USDT");
  for (const currency of ["ARS", "USD"]) {
    assert.equal(vm.runInContext(`money(1234.56, "${currency}")`, context), new Intl.NumberFormat("es-AR", { style: "currency", currency }).format(1234.56));
  }
});

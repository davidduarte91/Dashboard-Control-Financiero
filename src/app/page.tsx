"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import {
  changeFinancialEnvelope,
  deleteFinancialEntry,
  saveFinancialEntry,
  saveFinancialLists,
  type Currency,
  type Entry,
  type FinancialLists,
} from "@/lib/financial-sync";
import {
  readFinancialCache,
  writeFinancialCache,
  type FinancialSession,
  type FinancialSnapshot,
} from "@/lib/financial-cache";
const defaults = ["FCI", "Cedears", "Acciones argentinas", "Criptomonedas"];
const descriptions: Record<string, string> = {
  FCI: "Fondos comunes de inversión",
  Cedears: "Posiciones agrupadas",
  "Acciones argentinas": "Acciones locales agrupadas",
  Criptomonedas: "Lemon, Nexo y otros exchanges",
};
const formatMoneyValue = (value: number) =>
  new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
const money = (value: number, currency: Currency = "ARS") =>
  currency === "USDT"
    ? `${formatMoneyValue(value)} USDT`
    : new Intl.NumberFormat("es-AR", { style: "currency", currency }).format(value);
const toARS = (value: number, entry: Entry) =>
  entry.currency === "ARS" ? value : value * (entry.exchangeRate || 1);
const parseAmount = (value: string) =>
  Number(value.replace(/\./g, "").replace(",", "."));
const formatMoneyInput = (value: string) => {
  const sanitized = value.replace(/[^\d,]/g, "");
  if (!sanitized) return "";

  const [integerPart, decimalPart] = sanitized.split(",");
  const digits = integerPart.replace(/\./g, "");
  const formattedInteger = digits
    ? Number(digits).toLocaleString("es-AR", { maximumFractionDigits: 0 })
    : "";

  if (decimalPart !== undefined) {
    return `${formattedInteger},${decimalPart.slice(0, 2)}`;
  }

  return formattedInteger;
};

export default function Home() {
  const [entries, setEntries] = useState<Entry[]>([]),
    [envelopes, setEnvelopes] = useState<string[]>([]),
    [investments, setInvestments] = useState(defaults),
    [accounts, setAccounts] = useState<string[]>([]);
  const [isModalOpen, setModalOpen] = useState(false),
    [isDark, setDark] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [hydrated, setHydrated] = useState(false),
    [today, setToday] = useState("");
  const [envelopeMode, setEnvelopeMode] = useState("existing"),
    [investmentMode, setInvestmentMode] = useState("existing"),
    [accountMode, setAccountMode] = useState("existing"),
    [editing, setEditing] = useState<Entry | null>(null),
    [valuation, setValuation] = useState(""),
    [movementKind, setMovementKind] = useState<"aporte" | "retiro">("aporte");
  const [user, setUser] = useState<User | null>(null),
    [authLoading, setAuthLoading] = useState(true),
    [authMode, setAuthMode] = useState<"login" | "signup">("login"),
    [authEmail, setAuthEmail] = useState(""),
    [authPassword, setAuthPassword] = useState(""),
    [authError, setAuthError] = useState(""),
    [syncStatus, setSyncStatus] = useState<"local" | "synced" | "error">("local");
  const [isSaving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const draftId = useRef<string | null>(null);
  const sessionRef = useRef<FinancialSession>({ userId: null, ready: false });
  const snapshotRef = useRef<FinancialSnapshot>({
    entries: [], lists: { envelopes: [], investments: defaults, accounts: [] },
  });
  useEffect(() => {
    let disposed = false;
    let initialized = false;
    let receivedAuthEvent = false;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = (session: FinancialSession) => !disposed && sessionRef.current === session;
    const showSnapshot = (snapshot: FinancialSnapshot) => {
      snapshotRef.current = snapshot;
      setEntries(snapshot.entries);
      setEnvelopes(snapshot.lists.envelopes);
      setInvestments(snapshot.lists.investments);
      setAccounts(snapshot.lists.accounts);
    };
    const load = async (session: FinancialSession) => {
      if (!session.userId || !isCurrent(session)) return;
      try {
        const [entryResult, listResult] = await Promise.all([
          supabase
            .from("financial_entries")
            .select("id, envelope, investment, account, currency, amount, current_value, exchange_rate, entry_date, kind, created_at")
            .eq("user_id", session.userId)
            .order("created_at", { ascending: false }),
          supabase.from("financial_lists").select("envelopes, investments, accounts").eq("user_id", session.userId).maybeSingle(),
        ]);
        if (!isCurrent(session)) return;
        if (entryResult.error || listResult.error) {
          throw new Error(entryResult.error?.message || listResult.error?.message);
        }
        const snapshot: FinancialSnapshot = {
          entries: (entryResult.data || []).map((row) => ({
            id: row.id,
            envelope: row.envelope,
            investment: row.investment,
            account: row.account,
            currency: row.currency as Currency,
            amount: Number(row.amount),
            currentValue:
              Number(row.current_value) ||
              (row.kind === "aporte" ? Number(row.amount) : 0),
            date: row.entry_date,
            createdAt: row.created_at,
            exchangeRate: Number(row.exchange_rate) || 1,
            kind: row.kind as Entry["kind"],
          })),
          lists: listResult.data || { envelopes: [], investments: defaults, accounts: [] },
        };
        showSnapshot(snapshot);
        setSyncStatus("synced");
        try {
          writeFinancialCache(localStorage, session.userId, snapshot);
        } catch {
          setAuthError("Datos cargados desde la nube; no se pudo guardar una copia local en este navegador.");
        }
      } catch {
        if (!isCurrent(session)) return;
        let cached: FinancialSnapshot | null = null;
        try {
          cached = readFinancialCache(localStorage, session.userId);
        } catch {
          // Some browsers deny access to the storage object itself.
        }
        if (cached) showSnapshot(cached);
        setSyncStatus("error");
        setAuthError(cached
          ? "No se pudo actualizar desde la nube. Se muestra la última copia local de esta cuenta."
          : "No se pudo cargar la información y no hay una copia local válida de esta cuenta. Recargá para reintentar.");
      } finally {
        if (isCurrent(session)) {
          session.ready = true;
          setAuthLoading(false);
        }
      }
    };
    const switchUser = (nextUser: User | null) => {
      if (disposed) return;
      const userId = nextUser?.id ?? null;
      if (initialized && sessionRef.current.userId === userId) {
        setUser(nextUser);
        return;
      }
      if (!initialized) {
        try { setDark(localStorage.getItem("finanzas-theme") === "dark"); } catch { /* Optional preference. */ }
        setToday(new Date().toISOString().slice(0, 10));
        setHydrated(true);
      }
      initialized = true;
      if (loadTimer !== undefined) clearTimeout(loadTimer);
      const session: FinancialSession = { userId, ready: false };
      sessionRef.current = session;
      savingRef.current = false;
      draftId.current = null;
      showSnapshot({ entries: [], lists: { envelopes: [], investments: defaults, accounts: [] } });
      setSaving(false);
      setModalOpen(false);
      setEditing(null);
      setValuation("");
      setHistoryOpen(false);
      setAuthEmail("");
      setAuthPassword("");
      setAuthError("");
      setSyncStatus("local");
      setUser(nextUser);
      setAuthLoading(Boolean(userId));
      // Supabase work runs after the synchronous auth callback has returned.
      if (userId) loadTimer = setTimeout(() => { void load(session); }, 0);
    };
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      receivedAuthEvent = true;
      switchUser(session?.user ?? null);
    });
    void supabase.auth.getSession().then(({ data, error }) => {
      if (disposed || receivedAuthEvent) return;
      if (error) throw error;
      switchUser(data.session?.user ?? null);
    }).catch(() => {
      if (disposed || receivedAuthEvent) return;
      switchUser(null);
      setAuthError("No se pudo recuperar la sesión. Volvé a iniciar sesión.");
    });
    return () => {
      disposed = true;
      if (loadTimer !== undefined) clearTimeout(loadTimer);
      sessionRef.current = { userId: null, ready: false };
      listener.subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    try { localStorage.setItem("finanzas-theme", isDark ? "dark" : "light"); } catch { /* Optional preference. */ }
  }, [isDark, hydrated]);
  const assertSession = (session: FinancialSession) => {
    if (sessionRef.current !== session || !session.userId) {
      throw new Error("La sesión cambió. La operación anterior no puede continuar.");
    }
  };
  const cacheEntries = (next: Entry[], session: FinancialSession) => {
    assertSession(session);
    snapshotRef.current = { ...snapshotRef.current, entries: next };
    setEntries(next);
    writeFinancialCache(localStorage, session.userId!, snapshotRef.current);
  };
  const cacheLists = (next: FinancialLists, session: FinancialSession) => {
    assertSession(session);
    snapshotRef.current = { ...snapshotRef.current, lists: next };
    setEnvelopes(next.envelopes);
    setInvestments(next.investments);
    setAccounts(next.accounts);
    writeFinancialCache(localStorage, session.userId!, snapshotRef.current);
  };
  const runMutation = async (operation: (userId: string, session: FinancialSession) => Promise<void>) => {
    // A ref also blocks a second submission before React has re-rendered.
    if (savingRef.current) return false;
    const session = sessionRef.current;
    if (!user || session.userId !== user.id || !session.ready) {
      setSyncStatus("error");
      setAuthError("Iniciá sesión antes de guardar cambios.");
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setAuthError("");
    try {
      await operation(user.id, session);
      assertSession(session);
      setSyncStatus("synced");
      return true;
    } catch (error) {
      if (sessionRef.current !== session) return false;
      setSyncStatus("error");
      const detail = error instanceof Error ? error.message : "Error desconocido";
      setAuthError(`No se pudo completar la operación: ${detail}`);
      return false;
    } finally {
      if (sessionRef.current === session) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };
  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError("");
    const result = authMode === "login"
      ? await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword })
      : await supabase.auth.signUp({ email: authEmail, password: authPassword });
    if (result.error) setAuthError(result.error.message);
    else if (authMode === "signup" && !result.data.session) setAuthError("Revisa tu correo para confirmar la cuenta.");
    else window.location.reload();
  };
  const summary = useMemo(() => {
    const contributions = entries.filter(
      (entry) => (entry.kind || "aporte") === "aporte",
    );
    const withdrawals = entries.filter((entry) => entry.kind === "retiro");
    const capital =
      contributions.reduce((sum, entry) => sum + toARS(entry.amount, entry), 0) -
      withdrawals.reduce((sum, entry) => sum + toARS(entry.amount, entry), 0);
    const available =
      contributions
        .filter((entry) => !entry.investment)
        .reduce((sum, entry) => sum + toARS(entry.currentValue, entry), 0) -
      withdrawals
        .filter((entry) => !entry.investment)
        .reduce((sum, entry) => sum + toARS(entry.currentValue, entry), 0);
    const invested = investments.reduce((sum, name) => {
      const vals = entries
        .filter(
          (entry) => entry.investment === name && entry.kind === "valuacion",
        )
        .sort((a, b) =>
          (b.createdAt || b.date).localeCompare(a.createdAt || a.date),
        );
      const latestValuation = vals[0];
      const valuationTime = latestValuation?.createdAt;
      const afterValuation = (entry: Entry) =>
        !valuationTime || (entry.createdAt || entry.date) > valuationTime;
      const investmentContributions = contributions.filter(
        (entry) => entry.investment === name,
      );
      const investmentWithdrawals = withdrawals.filter(
        (entry) => entry.investment === name,
      );
      const current = latestValuation
        ? toARS(latestValuation.currentValue, latestValuation) +
          investmentContributions
            .filter(afterValuation)
            .reduce((total, entry) => total + toARS(entry.currentValue, entry), 0) -
          investmentWithdrawals
            .filter(afterValuation)
            .reduce((total, entry) => total + toARS(entry.currentValue, entry), 0)
        : investmentContributions.reduce(
            (total, entry) => total + toARS(entry.currentValue, entry),
            0,
          ) -
          investmentWithdrawals.reduce(
            (total, entry) => total + toARS(entry.currentValue, entry),
            0,
          );
      return sum + current;
    }, 0);
    return { capital, available, current: available + invested };
  }, [entries, investments]);
  const gain = summary.current - summary.capital;
  const envelopeTotals = envelopes.map((name) => {
    const items = entries.filter((entry) => entry.envelope === name);
    const contributions = items
      .filter((entry) => (entry.kind || "aporte") === "aporte")
      .reduce((sum, entry) => sum + toARS(entry.currentValue, entry), 0);
    const withdrawals = items
      .filter((entry) => entry.kind === "retiro")
      .reduce((sum, entry) => sum + toARS(entry.currentValue, entry), 0);
    return { name, total: contributions - withdrawals };
  });
  const openNew = () => {
    if (savingRef.current) return;
    draftId.current = null;
    setEditing(null);
    setValuation("");
    setMovementKind("aporte");
    setEnvelopeMode(envelopes.length ? "existing" : "new");
    setInvestmentMode("existing");
    setAccountMode(accounts.length ? "existing" : "new");
    setModalOpen(true);
  };
  const openEdit = (entry: Entry) => {
    if (savingRef.current) return;
    draftId.current = null;
    setEditing(entry);
    setValuation("");
    setMovementKind(entry.kind === "retiro" ? "retiro" : "aporte");
    setEnvelopeMode("existing");
    setInvestmentMode("existing");
    setAccountMode("existing");
    setModalOpen(true);
  };
  const openWithdrawal = (
    sourceType?: "envelope" | "investment",
    sourceName?: string,
  ) => {
    if (savingRef.current) return;
    draftId.current = null;
    setEditing(null);
    setValuation("");
    setMovementKind("retiro");
    setEnvelopeMode("existing");
    setInvestmentMode("existing");
    setAccountMode(accounts.length ? "existing" : "new");
    setModalOpen(true);
    window.setTimeout(() => {
      if (sourceType === "envelope") {
        const select = document.querySelector(
          'select[name="envelope"]',
        ) as HTMLSelectElement | null;
        if (select) select.value = sourceName || "";
      }
      if (sourceType === "investment") {
        const select = document.querySelector(
          'select[name="investment"]',
        ) as HTMLSelectElement | null;
        if (select) select.value = sourceName || "";
      }
    }, 0);
  };
  const saveEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const amount = parseAmount(String(form.get("amount")));
    const currentText = String(form.get("currentValue") || "");
    const envelope = String(
      form.get(envelopeMode === "new" ? "newEnvelope" : "envelope") || "",
    );
    const investment = String(
      form.get(investmentMode === "new" ? "newInvestment" : "investment") || "",
    );
    if (movementKind === "retiro" && !envelope && !investment) {
      window.alert("Elegí el sobre o la inversión de donde sale el dinero.");
      return;
    }
    const entry: Entry = {
      id: editing?.id || (draftId.current ??= crypto.randomUUID()),
      envelope,
      investment,
      account: String(
        form.get(accountMode === "new" ? "newAccount" : "account") || "",
      ),
      currency: form.get("currency") as Currency,
      amount,
      currentValue:
        movementKind === "retiro"
          ? amount
          : currentText
            ? parseAmount(currentText)
            : amount,
      date: String(form.get("date")),
      createdAt: editing?.createdAt || new Date().toISOString(),
      exchangeRate: parseAmount(String(form.get("exchangeRate") || "1")) || 1,
      kind: editing ? editing.kind || "aporte" : movementKind,
    };
    const next = editing
      ? entries.map((item) => (item.id === entry.id ? entry : item))
      : [entry, ...entries];
    const saved = await runMutation(async (userId, session) => {
      const lists = await saveFinancialLists(
        supabase, userId, { envelopes, investments, accounts },
        { envelopes: [entry.envelope], investments: [entry.investment], accounts: [entry.account] },
        undefined, () => assertSession(session),
      );
      cacheLists(lists, session);
      await saveFinancialEntry(supabase, userId, entry, editing ? "edit" : "create");
      cacheEntries(next, session);
    });
    if (!saved) return;
    draftId.current = null;
    setModalOpen(false);
    setEditing(null);
    formElement.reset();
  };
  const saveValuation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current) return;
    const form = new FormData(event.currentTarget);
    const entry: Entry = {
      id: draftId.current ??= crypto.randomUUID(),
      envelope: "",
      investment: valuation,
      account: String(form.get("account")),
      currency: form.get("currency") as Currency,
      amount: 0,
      currentValue: parseAmount(String(form.get("currentValue"))),
      date: String(form.get("date")),
      createdAt: new Date().toISOString(),
      exchangeRate: parseAmount(String(form.get("exchangeRate") || "1")) || 1,
      kind: "valuacion",
    };
    const next = [entry, ...entries];
    const saved = await runMutation(async (userId, session) => {
      const lists = await saveFinancialLists(
        supabase, userId, { envelopes, investments, accounts },
        { investments: [entry.investment], accounts: [entry.account] },
        undefined, () => assertSession(session),
      );
      cacheLists(lists, session);
      await saveFinancialEntry(supabase, userId, entry, "create");
      cacheEntries(next, session);
    });
    if (!saved) return;
    draftId.current = null;
    setModalOpen(false);
    setValuation("");
  };
  const deleteEntry = async (id: string) => {
    const next = entries.filter((entry) => entry.id !== id);
    await runMutation(async (userId, session) => {
      await deleteFinancialEntry(supabase, userId, id);
      cacheEntries(next, session);
    });
  };
  const renameEnvelope = async (oldName: string) => {
    if (savingRef.current) return;
    const newName = window.prompt("Nuevo nombre del sobre", oldName)?.trim();
    if (!newName || newName === oldName || envelopes.includes(newName)) return;
    const nextEntries = entries.map((entry) =>
      entry.envelope === oldName ? { ...entry, envelope: newName } : entry,
    );
    await runMutation(async (userId, session) => {
      await changeFinancialEnvelope(supabase, userId, oldName, newName);
      cacheEntries(nextEntries, session);
      try {
        cacheLists(await saveFinancialLists(
          supabase, userId, { envelopes, investments, accounts }, {}, { oldName, newName },
          () => assertSession(session),
        ), session);
      } catch {
        throw new Error("Los movimientos cambiaron de sobre, pero no se pudo actualizar su lista local o remota. Reintentá renombrar el sobre para completar la operación.");
      }
    });
  };
  const removeEnvelope = async (name: string) => {
    if (savingRef.current) return;
    if (
      !window.confirm(
        `¿Eliminar el sobre "${name}"? Sus cargas quedarán sin sobre.`,
      )
    )
      return;
    const nextEntries = entries.map((entry) =>
      entry.envelope === name ? { ...entry, envelope: "" } : entry,
    );
    await runMutation(async (userId, session) => {
      await changeFinancialEnvelope(supabase, userId, name, "");
      cacheEntries(nextEntries, session);
      try {
        cacheLists(await saveFinancialLists(
          supabase, userId, { envelopes, investments, accounts }, {}, { oldName: name, newName: "" },
          () => assertSession(session),
        ), session);
      } catch {
        throw new Error("Los movimientos quedaron sin sobre, pero no se pudo actualizar su lista local o remota. Reintentá quitar el sobre para completar la operación.");
      }
    });
  };

  if (authLoading) {
    return <main className="auth-shell">Cargando tu espacio financiero...</main>;
  }

  if (!user) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div className="brand-mark">
            <span>F</span>
            <div>
              finanzas<small>PERSONALES</small>
            </div>
          </div>
          <p className="eyebrow">ESPACIO FINANCIERO PRIVADO</p>
          <h1>{authMode === "login" ? "Ingresá a tu cuenta" : "Crear tu cuenta"}</h1>
          <p className="auth-copy">Tus registros quedarán sincronizados entre tu computadora y tu celular.</p>
          <form className="auth-form" onSubmit={submitAuth}>
            <label>
              Correo electrónico
              <input type="email" required value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} />
            </label>
            <label>
              Contraseña
              <input type="password" required minLength={6} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} />
            </label>
            {authError && <p className="auth-error">{authError}</p>}
            <button className="primary-button">{authMode === "login" ? "Ingresar" : "Registrarme"}</button>
          </form>
          <button className="text-button" onClick={() => { setAuthMode(authMode === "login" ? "signup" : "login"); setAuthError(""); }}>
            {authMode === "login" ? "Todavía no tengo una cuenta" : "Ya tengo una cuenta"}
          </button>
        </section>
      </main>
    );
  }

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand-mark">
          <span>F</span>
          <div>
            finanzas<small>PERSONALES</small>
          </div>
        </div>
        <p className="nav-label">ESPACIO PERSONAL</p>
        <nav className="main-nav" aria-label="Navegación principal">
          <a className="active" href="#resumen">
            <b>⌂</b> Resumen
          </a>
          <a href="#sobres">
            <b>▣</b> Sobres virtuales
          </a>
          <a href="#inversiones">
            <b>◈</b> Inversiones
          </a>
          <a href="#actividad">
            <b>=</b> Historial
          </a>
        </nav>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">MI ESPACIO FINANCIERO</p>
            <h1>Resumen general</h1>
          </div>
          <button
            className="icon-button"
            aria-label="Cambiar tema"
            onClick={() => setDark(!isDark)}
          >
            {isDark ? "☀" : "☾"}
          </button>
          <button className="text-button" disabled={isSaving} onClick={() => void supabase.auth.signOut()}>
            Cerrar sesión
          </button>
        </header>
        <div className={`sync-status ${syncStatus}`} role="status">
          {isSaving ? "Guardando cambios..." : authError || (syncStatus === "synced" ? "Sincronizado con la nube" : "Guardado localmente")}
        </div>
        <section className="welcome-row" id="resumen">
          <div>
            <h2>Tu patrimonio, en perspectiva.</h2>
            <p>Estos son tus números al día de hoy.</p>
          </div>
          <button className="primary-button" disabled={isSaving} onClick={openNew}>
            + Registrar actualización
          </button>
        </section>
        <section className="kpi-grid">
          <article className="kpi-card featured">
            <div className="card-heading">
              <span>Patrimonio total</span>
              <i>ARS</i>
            </div>
            <strong>{money(summary.current)}</strong>
            <p className="muted">{entries.length} cargas registradas</p>
          </article>
          <article className="kpi-card">
            <div className="card-heading">
              <span>Dinero disponible</span>
              <i className="soft-green">ARS</i>
            </div>
            <strong>{money(summary.available)}</strong>
            <p className="positive">En sobres virtuales</p>
          </article>
          <article className="kpi-card">
            <div className="card-heading">
              <span>Capital invertido</span>
              <i className="soft-blue">ARS</i>
            </div>
            <strong>{money(summary.capital - summary.available)}</strong>
            <p className="muted">En inversiones</p>
          </article>
          <article className="kpi-card">
            <div className="card-heading">
              <span>Rendimiento acumulado</span>
              <i className="soft-orange">ARS</i>
            </div>
            <strong>{money(gain)}</strong>
            <p className="muted">
              {summary.capital
                ? `${((gain / summary.capital) * 100).toFixed(2)}% acumulado`
                : "Esperando tu primera carga"}
            </p>
          </article>
        </section>
        <section className="content-grid">
          <article className="panel envelopes-panel" id="sobres">
            <div className="panel-header">
              <div>
                <h3>Tus sobres</h3>
                <p>Saldos acumulados por objetivo</p>
              </div>
              <button className="text-button" disabled={isSaving} onClick={openNew}>
                Nuevo sobre
              </button>
            </div>
            {envelopeTotals.length ? (
              <div className="envelope-list">
                {envelopeTotals.map((item) => (
                  <div className="envelope-item" key={item.name}>
                    <span className="envelope-icon">▣</span>
                    <div className="envelope-details">
                      <strong>{item.name}</strong>
                      <div className="envelope-balance-line">
                        <small>Saldo acumulado</small>
                        <b>{money(item.total)}</b>
                      </div>
                    </div>
                    <div className="envelope-actions">
                      <button
                        type="button"
                        className="action-button"
                        disabled={isSaving}
                        onClick={() => openWithdrawal("envelope", item.name)}
                      >
                        Extraer
                      </button>
                      <button
                        type="button"
                        className="edit-button"
                        disabled={isSaving}
                        aria-label={`Renombrar ${item.name}`}
                        onClick={() => renameEnvelope(item.name)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="delete-button"
                        disabled={isSaving}
                        aria-label={`Eliminar ${item.name}`}
                        onClick={() => removeEnvelope(item.name)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state compact-empty">
                <strong>Todavía no tenés sobres</strong>
                <p>Creá uno desde “Registrar actualización”.</p>
              </div>
            )}
          </article>
          <article className="panel activity-panel" id="actividad">
            <div className="panel-header">
              <div>
                <h3>Actividad reciente</h3>
                <p>Tu registro de cargas</p>
              </div>
              <button
                className="text-button"
                onClick={() => setHistoryOpen(!historyOpen)}
              >
                {historyOpen ? "Ocultar historial" : "Ver historial"}
              </button>
            </div>
            {entries.length ? (
              <div className="activity-list">
                {(historyOpen ? entries : entries.slice(0, 3)).map((entry) => {
                  const isWithdrawal = entry.kind === "retiro";
                  const label =
                    entry.kind === "valuacion"
                      ? "Valuación"
                      : isWithdrawal
                        ? "Retiro"
                        : "Aporte";
                  const amount =
                    isWithdrawal ? -entry.currentValue : entry.currentValue;
                  return (
                    <div className="activity-item" key={entry.id}>
                      <span className="activity-dot" />
                      <div>
                        <strong>{entry.envelope || entry.investment}</strong>
                        <small>
                          {label} · {entry.account} · {entry.date}
                        </small>
                      </div>
                      <b className={isWithdrawal ? "negative" : ""}>
                        {money(amount, entry.currency)}
                      </b>
                      <button
                        className="edit-button"
                        disabled={isSaving}
                        onClick={() => openEdit(entry)}
                        aria-label="Editar carga"
                      >
                        ✎
                      </button>
                      <button
                        className="delete-button"
                        disabled={isSaving}
                        onClick={() => deleteEntry(entry.id)}
                        aria-label="Borrar carga"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">
                <strong>Aún no hay cargas</strong>
              </div>
            )}
          </article>
        </section>
        <section className="panel investments-panel" id="inversiones">
          <div className="panel-header">
            <div>
              <h3>Inversiones</h3>
              <p>Capital y rendimiento por categoría</p>
            </div>
          </div>
          {investments.map((name) => {
            const items = entries.filter(
              (entry) =>
                entry.investment === name &&
                (entry.kind || "aporte") === "aporte",
            );
            const withdrawalItems = entries.filter(
              (entry) => entry.investment === name && entry.kind === "retiro",
            );
            const capital =
              items.reduce((sum, entry) => sum + entry.amount, 0) -
              withdrawalItems.reduce((sum, entry) => sum + entry.amount, 0);
            const valuationItems = entries
              .filter(
                (entry) =>
                  entry.investment === name && entry.kind === "valuacion",
              )
              .sort((a, b) =>
                (b.createdAt || b.date).localeCompare(a.createdAt || a.date),
              );
            const latestValuation = valuationItems[0];
            const displayCurrency = latestValuation?.currency || items[0]?.currency || "ARS";
            const valuationTime = latestValuation?.createdAt;
            const entriesAfterValuation = (entry: Entry) =>
              !valuationTime || (entry.createdAt || entry.date) > valuationTime;
            const current = latestValuation
              ? latestValuation.currentValue +
                items
                  .filter(entriesAfterValuation)
                  .reduce((sum, entry) => sum + entry.currentValue, 0) -
                withdrawalItems
                  .filter(entriesAfterValuation)
                  .reduce((sum, entry) => sum + entry.currentValue, 0)
              : items.reduce((sum, entry) => sum + entry.currentValue, 0) -
                withdrawalItems.reduce(
                  (sum, entry) => sum + entry.currentValue,
                  0,
                );
            return (
              <div className="investment-row" key={name}>
                <div className="investment-name">
                  <span className="investment-icon">◈</span>
                  <div>
                    <strong>{name}</strong>
                    <small>
                      {descriptions[name] || "Categoría personalizada"}
                    </small>
                  </div>
                </div>
                <div>
                  <small>Capital</small>
                  <strong>{money(capital, displayCurrency)}</strong>
                </div>
                <div>
                  <small>Valor actual</small>
                  <strong>{money(current, displayCurrency)}</strong>
                </div>
                <div>
                  <small>Rendimiento</small>
                  <strong
                    className={current - capital >= 0 ? "positive" : "negative"}
                  >
                    {money(current - capital, displayCurrency)}
                  </strong>
                </div>
                <div className="investment-actions">
                  <button
                    className="text-button"
                    disabled={isSaving}
                    onClick={() => {
                      if (savingRef.current) return;
                      draftId.current = null;
                      setValuation(name);
                      setEditing(null);
                      setModalOpen(true);
                    }}
                  >
                    {items.length ? "Actualizar" : "Sin datos"}
                  </button>
                  <button
                    type="button"
                    className="action-button"
                    disabled={isSaving}
                    onClick={() => openWithdrawal("investment", name)}
                  >
                    Extraer
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      </main>
      {isModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) =>
            !savingRef.current && event.target === event.currentTarget && setModalOpen(false)
          }
        >
          <section className="modal" role="dialog" aria-modal="true">
            <div className="modal-header">
              <div>
                <p className="eyebrow">
                  {valuation ? "VALUACIÓN" : "CARGA MANUAL"}
                </p>
                <h2>
                  {valuation
                    ? `Actualizar ${valuation}`
                    : editing
                      ? "Editar actualización"
                      : "Registrar actualización"}
                </h2>
              </div>
              <button
                className="close-button"
                disabled={isSaving}
                onClick={() => {
                  setModalOpen(false);
                  setValuation("");
                }}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            {authError && <p className="auth-error" role="alert">{authError}</p>}
            {valuation ? (
              <form onSubmit={saveValuation}>
                <fieldset className="form-grid" disabled={isSaving}>
                  <label>
                    Valor actual
                    <input
                      name="currentValue"
                      required
                      inputMode="decimal"
                      placeholder="310.000,50"
                      onChange={(event) => {
                        event.target.value = formatMoneyInput(event.target.value);
                      }}
                    />
                  </label>
                  <label>
                    Cuenta o plataforma
                    <input
                      name="account"
                      required
                      placeholder="Brubank, Lemon o Nexo"
                    />
                  </label>
                  <label>
                    Moneda
                    <select name="currency" defaultValue="ARS">
                      <option>ARS</option>
                      <option>USD</option>
                      <option>USDT</option>
                    </select>
                  </label>
                  <label>
                    Tipo de cambio a ARS
                    <input
                      name="exchangeRate"
                      required
                      inputMode="decimal"
                      defaultValue="1"
                      placeholder="Ej. 1.450"
                      onChange={(event) => {
                        event.target.value = formatMoneyInput(event.target.value);
                      }}
                    />
                  </label>
                  <label>
                    Fecha
                    <input
                      name="date"
                      required
                      type="date"
                      value={today}
                      readOnly
                    />
                  </label>
                </fieldset>
                <p className="form-hint">
                  Esta valuación no modifica el capital aportado.
                </p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={isSaving}
                    onClick={() => setValuation("")}
                  >
                    Cancelar
                  </button>
                  <button className="primary-button" disabled={isSaving}>{isSaving ? "Guardando..." : "Guardar valuación"}</button>
                </div>
              </form>
            ) : (
              <form onSubmit={saveEntry}>
                <fieldset className="form-grid" disabled={isSaving}>
                  <label>
                    Tipo de movimiento
                    <select
                      value={movementKind}
                      onChange={(event) =>
                        setMovementKind(
                          event.target.value as "aporte" | "retiro",
                        )
                      }
                      disabled={Boolean(editing)}
                    >
                      <option value="aporte">Ingreso de dinero</option>
                      <option value="retiro">Retiro de dinero</option>
                    </select>
                  </label>
                  <label>
                    {movementKind === "retiro" ? "Sobre de origen" : "Sobre"}
                    <select
                      name="envelope"
                      defaultValue={editing?.envelope || ""}
                      disabled={envelopeMode === "new"}
                      onChange={(event) =>
                        setEnvelopeMode(
                          event.target.value === "__new__" ? "new" : "existing",
                        )
                      }
                    >
                      <option value="">Elegir sobre</option>
                      {envelopes.map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                      <option value="__new__">+ Crear nuevo sobre...</option>
                    </select>
                  </label>
                  <label>
                    Nombre del sobre nuevo{" "}
                    <span className="optional-label">(opcional)</span>
                    <input
                      name="newEnvelope"
                      disabled={envelopeMode !== "new"}
                      placeholder="Ej. Tarjeta crédito Septiembre"
                    />
                  </label>
                  <label>
                    Inversión
                    <select
                      name="investment"
                      defaultValue={editing?.investment || ""}
                      disabled={investmentMode === "new"}
                      onChange={(event) =>
                        setInvestmentMode(
                          event.target.value === "__new__" ? "new" : "existing",
                        )
                      }
                    >
                      <option value="">Elegir inversión</option>
                      {investments.map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                      <option value="__new__">
                        + Crear nueva categoría...
                      </option>
                    </select>
                  </label>
                  <label>
                    Nombre de categoría nueva{" "}
                    <span className="optional-label">(opcional)</span>
                    <input
                      name="newInvestment"
                      disabled={investmentMode !== "new"}
                      placeholder="Ej. FCI Galicia"
                    />
                  </label>
                  <label>
                    Cuenta o plataforma
                    <select
                      name="account"
                      defaultValue={editing?.account || ""}
                      disabled={accountMode === "new"}
                      onChange={(event) =>
                        setAccountMode(
                          event.target.value === "__new__" ? "new" : "existing",
                        )
                      }
                    >
                      <option value="">Elegir plataforma</option>
                      {accounts.map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                      <option value="__new__">
                        + Agregar nueva plataforma...
                      </option>
                    </select>
                  </label>
                  <label>
                    Nombre de plataforma nueva{" "}
                    <span className="optional-label">(opcional)</span>
                    <input
                      name="newAccount"
                      disabled={accountMode !== "new"}
                      placeholder="Ej. Brubank, Lemon o Nexo"
                    />
                  </label>
                  <label>
                    Moneda
                    <select
                      name="currency"
                      defaultValue={editing?.currency || "ARS"}
                    >
                      <option>ARS</option>
                      <option>USD</option>
                      <option>USDT</option>
                    </select>
                  </label>
                  <label>
                    Tipo de cambio a ARS
                    <input
                      name="exchangeRate"
                      required
                      inputMode="decimal"
                      defaultValue={formatMoneyValue(editing?.exchangeRate ?? 1)}
                      placeholder="Ej. 1.450"
                      onChange={(event) => {
                        event.target.value = formatMoneyInput(event.target.value);
                      }}
                    />
                  </label>
                  <label>
                    {movementKind === "retiro"
                      ? "Cantidad a retirar"
                      : "Capital aportado"}
                    <input
                      name="amount"
                      required
                      inputMode="decimal"
                      defaultValue={
                        editing ? formatMoneyValue(editing.amount) : ""
                      }
                      placeholder="10.000,50"
                      onChange={(event) => {
                        event.target.value = formatMoneyInput(event.target.value);
                      }}
                    />
                  </label>
                  {movementKind !== "retiro" && (
                    <label>
                      Valor actual{" "}
                      <span className="optional-label">(opcional)</span>
                      <input
                        name="currentValue"
                        inputMode="decimal"
                        defaultValue={
                          editing
                            ? formatMoneyValue(editing.currentValue)
                            : ""
                        }
                        placeholder="Si lo dejás vacío, usamos el capital"
                        onChange={(event) => {
                          event.target.value = formatMoneyInput(event.target.value);
                        }}
                      />
                    </label>
                  )}
                  <label>
                    Fecha
                    <input
                      name="date"
                      required
                      type="date"
                      value={editing?.date || today}
                      readOnly
                    />
                  </label>
                </fieldset>
                <p className="form-hint">
                  Elegí una opción existente o seleccioná “crear nuevo”. Nunca
                  se guardan ambas opciones juntas.
                </p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={isSaving}
                    onClick={() => setModalOpen(false)}
                  >
                    Cancelar
                  </button>
                  <button className="primary-button" disabled={isSaving}>
                    {isSaving ? "Guardando..." : editing ? "Guardar cambios" : "Guardar actualización"}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

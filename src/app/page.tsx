"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Currency = "ARS" | "USD" | "USDT";
type EntryType = "Sobre" | "Inversión";

type Entry = {
  id: string;
  type: EntryType;
  name: string;
  account: string;
  currency: Currency;
  amount: number;
  currentValue: number;
  date: string;
};

const categories = [
  ["FCI", "Fondos comunes de inversión", "◈", ""],
  ["Bolsa", "Cedears y acciones argentinas", "◒", "blue-bg"],
  ["Criptomonedas", "Lemon y Nexo", "₿", "orange-bg"],
];

const initialEntries: Entry[] = [];
const money = (value: number, currency: Currency = "ARS") =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency }).format(value);

export default function Home() {
  const [entries, setEntries] = useState<Entry[]>(() => {
    if (typeof window === "undefined") return initialEntries;
    const savedEntries = localStorage.getItem("finanzas-entries");
    return savedEntries ? JSON.parse(savedEntries) : initialEntries;
  });
  const [isModalOpen, setModalOpen] = useState(false);
  const [isDark, setDark] = useState(() =>
    typeof window !== "undefined" && localStorage.getItem("finanzas-theme") === "dark",
  );
  const [type, setType] = useState<EntryType>("Sobre");

  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    localStorage.setItem("finanzas-theme", isDark ? "dark" : "light");
  }, [isDark]);

  const summary = useMemo(() => entries.reduce((result, entry) => {
    result.capital += entry.amount;
    result.current += entry.currentValue;
    if (entry.type === "Sobre") result.available += entry.currentValue;
    return result;
  }, { capital: 0, current: 0, available: 0 }), [entries]);
  const gain = summary.current - summary.capital;

  function addEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = Number(form.get("amount"));
    const currentValue = Number(form.get("currentValue"));
    const newEntry: Entry = {
      id: crypto.randomUUID(), type, name: String(form.get("name")),
      account: String(form.get("account")), currency: form.get("currency") as Currency,
      amount, currentValue, date: String(form.get("date")),
    };
    const nextEntries = [newEntry, ...entries];
    setEntries(nextEntries);
    localStorage.setItem("finanzas-entries", JSON.stringify(nextEntries));
    setModalOpen(false);
    event.currentTarget.reset();
  }

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand-mark"><span>F</span><div>finanzas<small>PERSONALES</small></div></div>
        <p className="nav-label">ESPACIO PERSONAL</p>
        <nav className="main-nav" aria-label="Navegación principal">
          <a className="active" href="#resumen"><b>◈</b> Resumen</a>
          <a href="#sobres"><b>▣</b> Sobres virtuales</a>
          <a href="#inversiones"><b>◒</b> Inversiones</a>
          <a href="#actividad"><b>≡</b> Historial</a>
        </nav>
        <div className="sidebar-bottom"><a href="#configuracion"><b>⚙</b> Configuración</a><div className="profile"><span>DD</span><div><strong>David Duarte</strong><small>Cuenta personal</small></div></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div><p className="eyebrow">MI ESPACIO FINANCIERO</p><h1>Resumen general</h1></div><div className="top-actions"><button className="icon-button" aria-label="Cambiar tema" onClick={() => setDark(!isDark)}>{isDark ? "☀" : "☾"}</button><button className="avatar">DD</button></div></header>
        <section className="welcome-row" id="resumen"><div><h2>Tu patrimonio, en perspectiva.</h2><p>Estos son tus números al día de hoy.</p></div><button className="primary-button" onClick={() => setModalOpen(true)}>+ Registrar actualización</button></section>
        <section className="kpi-grid" aria-label="Métricas principales">
          <article className="kpi-card featured"><div className="card-heading"><span>Patrimonio total</span><i>ARS</i></div><strong>{money(summary.current)}</strong><p className="muted">{entries.length ? `${entries.length} carga${entries.length === 1 ? "" : "s"} registrada${entries.length === 1 ? "" : "s"}` : "Sin variación registrada"}</p><div className="mini-bars"><span /><span /><span /><span /><span /><span /><span /><span /></div></article>
          <article className="kpi-card"><div className="card-heading"><span>Dinero disponible</span><i className="soft-green">ARS</i></div><strong>{money(summary.available)}</strong><p className="positive">● En sobres virtuales</p><div className="line-chart green"><span /></div></article>
          <article className="kpi-card"><div className="card-heading"><span>Capital invertido</span><i className="soft-blue">ARS</i></div><strong>{money(summary.capital - summary.available)}</strong><p className="muted">En {entries.filter((entry) => entry.type === "Inversión").length} posiciones</p><div className="line-chart blue"><span /></div></article>
          <article className="kpi-card"><div className="card-heading"><span>Rendimiento acumulado</span><i className="soft-orange">ARS</i></div><strong>{money(gain)}</strong><p className="muted">{summary.capital ? `${((gain / summary.capital) * 100).toFixed(2)}% acumulado` : "Esperando tu primera carga"}</p><div className="line-chart orange"><span /></div></article>
        </section>
        <section className="content-grid">
          <article className="panel allocation-panel" id="sobres"><div className="panel-header"><div><h3>Distribución de tu dinero</h3><p>Por sobres y tipo de activo</p></div><button className="text-button" onClick={() => setModalOpen(true)}>Agregar carga →</button></div><div className="empty-allocation"><div className="donut"><span>{summary.current ? "100%" : "0%"}</span></div><div className="legend"><div><span className="dot mint" /><div><strong>Sobres virtuales</strong><small>{money(summary.available)}</small></div></div><div><span className="dot blue-dot" /><div><strong>Inversiones</strong><small>{money(summary.current - summary.available)}</small></div></div><div><span className="dot grey-dot" /><div><strong>Rendimiento</strong><small>{money(gain)}</small></div></div></div></div></article>
          <article className="panel activity-panel" id="actividad"><div className="panel-header"><div><h3>Actividad reciente</h3><p>Tu registro de movimientos</p></div><a className="text-button" href="#historial">Ver historial →</a></div>{entries.length ? <div className="activity-list">{entries.slice(0, 3).map((entry) => <div className="activity-item" key={entry.id}><span className="activity-dot" /><div><strong>{entry.name}</strong><small>{entry.type} · {entry.date}</small></div><b>{money(entry.currentValue, entry.currency)}</b></div>)}</div> : <div className="empty-state"><div className="empty-icon">＋</div><strong>Aún no hay movimientos</strong><p>Tu historial aparecerá aquí cuando registres tu primera actualización.</p></div>}</article>
        </section>
        <section className="panel investments-panel" id="inversiones"><div className="panel-header"><div><h3>Inversiones</h3><p>Capital y rendimiento por categoría</p></div><button className="text-button" onClick={() => { setType("Inversión"); setModalOpen(true); }}>Gestionar →</button></div>{categories.map(([name, description, icon, className]) => <div className="investment-row" key={name}><div className="investment-name"><span className={`investment-icon ${className}`}>{icon}</span><div><strong>{name}</strong><small>{description}</small></div></div><div><small>Capital</small><strong>{money(entries.filter((entry) => entry.type === "Inversión").reduce((sum, entry) => sum + entry.amount, 0))}</strong></div><div><small>Rendimiento</small><strong className={gain >= 0 ? "positive" : "negative"}>{money(gain)}</strong></div><div><small>Actualizado</small><strong className="muted">{entries[0]?.date || "Sin datos"}</strong></div></div>)}</section>
        <p className="footer-note">{entries[0] ? `Última actualización: ${entries[0].date} · Los importes se muestran en ARS` : "Última actualización: todavía no registraste datos · Los importes se mostrarán en ARS"}</p>
      </main>
      {isModalOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setModalOpen(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><div><p className="eyebrow">CARGA MANUAL</p><h2 id="modal-title">Registrar actualización</h2></div><button className="close-button" onClick={() => setModalOpen(false)} aria-label="Cerrar">×</button></div><form onSubmit={addEntry}><div className="form-grid"><label>Tipo<select value={type} onChange={(event) => setType(event.target.value as EntryType)}><option>Sobre</option><option>Inversión</option></select></label><label>Nombre<input name="name" required placeholder="Ej. Ahorro mensual" /></label><label>Cuenta o plataforma<input name="account" required placeholder="Ej. Brubank, Lemon o Nexo" /></label><label>Moneda<select name="currency" defaultValue="ARS"><option>ARS</option><option>USD</option><option>USDT</option></select></label><label>Capital aportado<input name="amount" required type="number" min="0" step="0.01" placeholder="0,00" /></label><label>Valor actual<input name="currentValue" required type="number" min="0" step="0.01" placeholder="0,00" /></label><label>Fecha de la carga<input name="date" required type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></label></div><p className="form-hint">El rendimiento se calcula automáticamente como valor actual menos capital aportado. Las comisiones deben estar incluidas en el capital.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setModalOpen(false)}>Cancelar</button><button type="submit" className="primary-button">Guardar actualización</button></div></form></section></div>}
    </div>
  );
}

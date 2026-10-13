// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yong Cong Sin <yongcong.sin@gmail.com>
// UI for the StashAway statement → CSV converter. Everything runs in the browser.
(function () {
  "use strict";
  const P = window.StashParser;
  const $ = (sel) => document.querySelector(sel);

  // pdf.js worker: the worker source is embedded in the page, so it works from file://.
  const workerSrc = document.getElementById("pdf-worker-src");
  if (workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerSrc.textContent], { type: "text/javascript" }));
  }

  // Export mode for investment portfolios: "balance" (one transactions file with
  // month-end adjustments, the default), "tradelog" (the same plus every buy/sell
  // as a zero-amount line) or "holdings" (trades + transactions + month-end
  // balances). Cash-like portfolios always use "balance".
  const MODE_KEY = "stashaway-csv-mode";
  const CONFIG_KEY = "stashaway-csv-portfolios";
  // statements keyed by name+size; config: per portfolio id { name, kind, mergeInto, exclude }
  const state = { statements: new Map(), failed: [], result: null, mode: loadMode(), config: loadConfig() };

  function loadConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; } catch { return {}; }
  }
  function saveConfig() {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config)); } catch { /* storage unavailable */ }
  }

  function loadMode() {
    try { const m = localStorage.getItem(MODE_KEY); return ["tradelog", "holdings"].includes(m) ? m : "balance"; } catch { return "balance"; }
  }
  function setMode(mode) {
    state.mode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage unavailable */ }
    for (const b of document.querySelectorAll("#mode button")) {
      b.classList.toggle("on", b.dataset.mode === mode);
      b.setAttribute("aria-checked", String(b.dataset.mode === mode));
    }
    render();
  }
  const modeOf = (name) => (state.result.accounts[name].kind === "cash" ? "balance" : state.mode);
  const label = (name) => name;

  // ---------- PDF reading ----------
  async function readStatement(file) {
    // isEvalSupported: false closes CVE-2024-4367 (code execution from a crafted
    // font in pdf.js < 4.2.67); the page's CSP also forbids eval. Text extraction
    // doesn't need it.
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(P.itemsToPageText(content.items.map((it) => ({
        str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.abs(it.transform[3]),
      }))));
    }
    await doc.destroy();
    return { id: file.name, pages };
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    if (!files.length) return;
    setBusy(`Reading ${files.length} statement${files.length > 1 ? "s" : ""}…`);
    let done = 0;
    for (const f of files) {
      const key = `${f.name}:${f.size}`;
      if (state.statements.has(key)) { done++; continue; }
      try {
        state.statements.set(key, await readStatement(f));
      } catch (e) {
        state.failed.push({ id: f.name, error: e && e.message ? e.message : String(e) });
      }
      setBusy(`Reading statements… ${++done}/${files.length}`);
    }
    recompute();
    setBusy(null);
  }

  function recompute() {
    state.result = state.statements.size ? P.parseStatements([...state.statements.values()], state.config) : null;
    fillRange(state.result ? state.result.months.map((m) => m.month) : []);
    render();
  }

  // ---------- range ----------
  function fillRange(months) {
    for (const [sel, pick] of [[$("#from"), months[0]], [$("#to"), months[months.length - 1]]]) {
      const prev = sel.value;
      sel.innerHTML = months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join("");
      sel.value = months.includes(prev) ? prev : pick || "";
      sel.disabled = !months.length;
    }
  }
  const range = () => {
    let from = $("#from").value, to = $("#to").value;
    if (from && to && from > to) [from, to] = [to, from];
    return { from, to };
  };
  const earliest = () => (state.result && state.result.months.length ? state.result.months[0].month : null);
  const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" });

  // ---------- what each account exports ----------
  function exportsFor(name) {
    const a = state.result.accounts[name];
    const { from, to } = range();
    const vals = a.valuations.filter(([d]) => P.inRange(d, from, to));
    const mode = modeOf(name);
    if (mode !== "holdings") {
      const { entries, problems } = P.adjustedEntries(a, from, to, earliest(), mode === "tradelog");
      const n = (kind) => entries.filter((e) => e.kind === kind).length;
      return { vals, problems, adjustments: n("adjustment"), tradeLines: n("trade"),
               files: entries.length ? [{ kind: "transactions", label: "Transactions CSV", count: entries.length - n("trade") },
                                       { kind: "qif", label: "QIF", count: entries.length - n("trade") }] : [] };
    }
    const trades = a.trades.filter((t) => P.inRange(t.date, from, to));
    const cash = a.cash.filter((c) => P.inRange(c.date, from, to));
    const files = [];
    if (trades.length) files.push({ kind: "trades", label: "Trades CSV", count: trades.length });
    if (cash.length) files.push({ kind: "transactions", label: "Transactions CSV", count: cash.length });
    if (vals.length) files.push({ kind: "valuations", label: "Month-end balances CSV", count: vals.length });
    return { vals, problems: [], files, balancing: cash.filter((c) => c.balancing).length };
  }

  function fileFor(name, kind) {
    const a = state.result.accounts[name];
    const { from, to } = range();
    const mode = modeOf(name);
    if (kind === "qif") {
      // One QIF per account, with the starting balance as its "Opening Balance" record.
      const { entries } = P.adjustedEntries(a, from, to, earliest());
      const start = P.openingBalance(a, from, to, earliest(), entries);
      const span = from === to ? from : `${from}_to_${to}`;
      return { name: `StashAway ${label(name)} - ${span}.qif`, text: P.qif(entries, start, `StashAway ${label(name)}`) };
    }
    const text = mode !== "holdings" ? P.adjustedCsv(a, from, to, earliest(), mode === "tradelog")
      : kind === "trades" ? P.tradesCsv(a.trades, from, to)
      : kind === "transactions" ? P.transactionsCsv(a.cash, from, to)
      : P.valuationsCsv(a.valuations, from, to, a.currency);
    const span = from === to ? from : `${from}_to_${to}`;
    return { name: `StashAway ${label(name)} - ${kind} - ${span}.csv`, text };
  }

  // One row per exported portfolio: account type and its starting balance just
  // before the first exported entry.
  function accountsFile() {
    const { from, to } = range();
    const rows = [];
    for (const [name, a] of Object.entries(state.result.accounts)) {
      if (!exportsFor(name).files.length) continue;
      const mode = modeOf(name);
      const entries = mode === "holdings"
        ? [...a.trades, ...a.cash].filter((e) => P.inRange(e.date, from, to))
        : P.adjustedEntries(a, from, to, earliest(), mode === "tradelog").entries;
      const start = P.openingBalance(a, from, to, earliest(), entries);
      if (start) rows.push({ type: a.kind === "investment" ? "Investment" : "Savings", name: `StashAway ${label(name)}`, currency: a.currency, ...start });
    }
    const span = from === to ? from : `${from}_to_${to}`;
    return { name: `StashAway accounts - ${span}.csv`, text: P.accountsCsv(rows), count: rows.length };
  }

  // All portfolios in one file per kind, with an account column named like the
  // Accounts CSV, for multi-account imports.
  function combinedFiles() {
    const { from, to } = range();
    const trades = [], cash = [];
    for (const [name, a] of Object.entries(state.result.accounts)) {
      if (!exportsFor(name).files.length) continue;
      const account = `StashAway ${label(name)}`;
      const mode = modeOf(name);
      if (mode === "holdings") {
        trades.push({ account, rows: a.trades.filter((t) => P.inRange(t.date, from, to)) });
        cash.push({ account, rows: a.cash.filter((c) => P.inRange(c.date, from, to)) });
      } else {
        cash.push({ account, rows: P.adjustedEntries(a, from, to, earliest(), mode === "tradelog").entries });
      }
    }
    const span = from === to ? from : `${from}_to_${to}`;
    const files = [{ name: `StashAway all portfolios - transactions - ${span}.csv`, text: P.combinedTransactionsCsv(cash) }];
    if (trades.some((g) => g.rows.length)) files.unshift({ name: `StashAway all portfolios - trades - ${span}.csv`, text: P.combinedTradesCsv(trades) });
    return files;
  }

  // ---------- rendering ----------
  function render() {
    const r = state.result;
    $("#empty").hidden = !!r;
    $("#results").hidden = !r;
    renderStatus(r);
    if (!r) return;
    const cards = [];
    for (const [name, a] of Object.entries(r.accounts)) {
      const ex = exportsFor(name);
      if (!ex.files.length && !ex.vals.length) continue;
      const mode = modeOf(name);
      const last = ex.vals[ex.vals.length - 1];
      const count = (kind) => (ex.files.find((f) => f.kind === kind) || { count: 0 }).count;
      const stats = mode === "holdings"
        ? [["Trades", count("trades")], ["Transactions", count("transactions")], ["Month-ends", ex.vals.length]]
        : mode === "tradelog"
        ? [["Trade lines", ex.tradeLines], ["Transactions", count("transactions")], ["Monthly adjustments", ex.adjustments]]
        : [["Transactions", count("transactions")], ["Monthly adjustments", ex.adjustments]];
      stats.push([`Balance ${last ? monthLabel(last[0].slice(0, 7)) : ""}`, last ? `${a.currency} ${fmtMoney(last[1])}` : "–"]);
      cards.push(`
        <article class="card">
          <header>
            <h3>${esc(label(name))}</h3>
            <span class="tag ${a.kind}">${a.kind === "investment" ? "Investment" : "Cash-like"}</span>
          </header>
          <dl>${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${typeof v === "number" ? fmtInt(v) : v}</dd></div>`).join("")}</dl>
          <p class="note">${{
              balance: "One file. A monthly returns adjustment puts the running balance on each statement's closing value.",
              tradelog: "One file, as Balance only, plus every buy and sell as a zero-amount line with units and price.",
              holdings: "Trades and cash in separate files; month-end balances to record as balance updates.",
            }[mode]}
            ${ex.balancing ? ` ${ex.balancing} balancing deposit/withdrawal entr${ex.balancing > 1 ? "ies" : "y"} where the statement omitted rows.` : ""}</p>
          ${ex.problems.map((p) => `<p class="warn">${esc(p)}</p>`).join("")}
          <div class="buttons">
            ${ex.files.map((f) => `<button class="dl" data-account="${esc(name)}" data-kind="${f.kind}">${f.label}</button>`).join("")}
          </div>
        </article>`);
    }
    $("#cards").innerHTML = cards.join("") || `<p class="muted">No activity in the selected months.</p>`;
    $("#zip").disabled = !cards.length;
    $("#accounts").disabled = !cards.length;
    $("#combined").disabled = !cards.length;
    renderDiagnostics(r);
    renderPortfolios(r);
  }

  // Portfolio configurator: rename, change type, merge into another portfolio, or
  // exclude. Detection is automatic; this only overrides it.
  function renderPortfolios(r) {
    const ps = r.portfolios;
    const changed = ps.filter((p) => Object.keys(state.config[p.id] || {}).length).length;
    $("#portfolios-count").textContent = `${ps.length} detected${changed ? `, ${changed} adjusted` : ""}`;
    const opt = (v, t, sel) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(t)}</option>`;
    $("#portfolios").innerHTML = ps.map((p) => {
      const c = state.config[p.id] || {};
      const earlier = p.names.slice(0, -1);
      const history = !earlier.length ? ""
        : earlier.length <= 3 ? `formerly ${earlier.map(esc).join(", ")}`
        : `<span title="${esc(earlier.join(" → "))}">formerly ${earlier.slice(0, 2).map(esc).join(", ")} and ${earlier.length - 2} more</span>`;
      const others = ps.filter((o) => o.id !== p.id && (state.config[o.id] || {}).mergeInto !== p.id);
      return `
        <div class="portfolio${c.exclude ? " excluded" : ""}" data-id="${esc(p.id)}">
          <div class="p-head">
            <strong>${esc(p.label)}</strong>
            <span class="muted">${[history, `${monthLabel(p.firstMonth)} – ${monthLabel(p.lastMonth)}`, p.currency].filter(Boolean).join(" · ")}</span>
          </div>
          <div class="p-controls">
            <label>Export as <input data-field="name" value="${esc(c.name || "")}" placeholder="${esc(p.label)}"></label>
            <label>Type <select data-field="kind">
              ${opt("", `Auto (${p.kind === "investment" ? "Investment" : "Cash-like"})`, !c.kind)}
              ${opt("investment", "Investment", c.kind === "investment")}${opt("cash", "Cash-like", c.kind === "cash")}
            </select></label>
            <label>Merge into <select data-field="mergeInto">
              ${opt("", "—", !c.mergeInto)}${others.map((o) => opt(o.id, o.label, c.mergeInto === o.id)).join("")}
            </select></label>
            <label class="check"><input type="checkbox" data-field="include"${c.exclude ? "" : " checked"}> Export</label>
          </div>
        </div>`;
    }).join("");
  }

  $("#portfolios").addEventListener("change", (e) => {
    const el = e.target.closest("[data-field]");
    const row = e.target.closest(".portfolio");
    if (!el || !row) return;
    const c = { ...(state.config[row.dataset.id] || {}) };
    const field = el.dataset.field;
    if (field === "include") { if (el.checked) delete c.exclude; else c.exclude = true; }
    else if (el.value.trim()) c[field] = el.value.trim();
    else delete c[field];
    if (Object.keys(c).length) state.config[row.dataset.id] = c;
    else delete state.config[row.dataset.id];
    saveConfig();
    recompute();
  });
  $("#portfolios-reset").addEventListener("click", () => { state.config = {}; saveConfig(); recompute(); });

  function renderStatus(r) {
    const el = $("#status");
    if (!r && !state.failed.length) { el.innerHTML = ""; return; }
    const months = r ? r.months.map((m) => m.month) : [];
    const parts = [];
    if (months.length) parts.push(`<strong>${months.length}</strong> statement${months.length > 1 ? "s" : ""}, ${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}`);
    const warn = [];
    if (r && r.gaps.length) warn.push(`Missing statement${r.gaps.length > 1 ? "s" : ""}: ${r.gaps.map(monthLabel).join(", ")}. `
      + "Balance-only files bridge the gap with one “not covered by statements” entry, so later balances stay right, but that month’s individual transactions are missing. "
      + "With holdings, its trades are missing too, so unit counts stay off from then on. Add the missing PDF to fix this.");
    if (r && r.firstOpenings.length) warn.push(`Your earliest statement (${monthLabel(r.firstOpenings[0].month)}) opens with existing balances: `
      + r.firstOpenings.map((o) => `${esc(label(o.account))} ${r.baseCurrency} ${fmtMoney(o.opening)}`).join(", ")
      + ". Start those accounts at these balances in your app, or add earlier statements.");
    for (const e of [...(r ? r.errors : []), ...state.failed]) warn.push(`${esc(e.id)}: ${esc(e.error)}`);
    if (r && Object.keys(r.unmapped).length) warn.push(`Unrecognised portfolio${Object.keys(r.unmapped).length > 1 ? "s" : ""} (not exported): ${Object.keys(r.unmapped).map(esc).join(", ")}`);
    el.innerHTML = `<p>${parts.join("")}</p>${warn.map((w) => `<p class="warn">${w}</p>`).join("")}`;
  }

  function renderDiagnostics(r) {
    const { from, to } = range();
    const rec = r.reconciled.filter((x) => P.inRange(x.month + "-01", from, to));
    // Skipped rows in the selected months, by category. Categories where the
    // description matters (unrecognised types, rows without an amount) list each
    // distinct description with its count and portfolios.
    const DETAILED = new Set(["unknown", "no amount"]);
    const LABELS = {
      "fx conversion (internal)": "Currency conversions inside a portfolio",
      "fixed-deposit placement (internal)": "Fixed-term placements and redemptions inside a portfolio",
      "no amount": "Rows the statement printed without an amount",
      "trade in cash-like account": "Fund switches in cash-like portfolios",
      "trade without qty/price": "Buys/sells without units or price",
      "unknown": "Unrecognised transaction types (not exported; please report)",
    };
    const groups = {};
    for (const row of r.skippedRows.filter((x) => P.inRange(x.date, from, to))) (groups[row.category] = groups[row.category] || []).push(row);
    const skipped = Object.entries(groups).sort(([a], [b]) => (a === "unknown") - (b === "unknown") || a.localeCompare(b)).map(([cat, rows]) => {
      let sub = "";
      if (DETAILED.has(cat)) {
        const byDetail = {};
        for (const x of rows) {
          const d = (byDetail[x.detail || "(no description)"] = byDetail[x.detail || "(no description)"] || { n: 0, where: new Set(), months: new Set() });
          d.n++; if (x.portfolio) d.where.add(x.portfolio); d.months.add(x.date.slice(0, 7));
        }
        sub = `<ul>${Object.entries(byDetail).sort(([, a], [, b]) => b.n - a.n).map(([detail, d]) =>
          `<li>${esc(detail)} ×${fmtInt(d.n)} <span class="muted">(${[...d.where].map(esc).join(", ")}; ${[...d.months].sort().map(monthLabel).join(", ")})</span></li>`).join("")}</ul>`;
      }
      return `<li${cat === "unknown" ? ' class="warn-item"' : ""}>${esc(LABELS[cat] || cat)}: ${fmtInt(rows.length)}${sub}</li>`;
    }).join("");
    $("#diagnostics").innerHTML = `
      <details>
        <summary>What was skipped or adjusted</summary>
        <p>Rows not exported in the selected months:</p>
        <ul>${skipped || "<li>none</li>"}</ul>
        <p>Balancing entries, added where a statement's Cashflow figure differs from its itemised deposits and withdrawals:</p>
        <ul>${rec.map((x) => `<li>${monthLabel(x.month)} · ${esc(label(x.account))} · ${x.diff > 0 ? "+" : ""}${fmtMoney(x.diff)} ${r.baseCurrency}</li>`).join("") || "<li>none</li>"}</ul>
      </details>`;
  }

  // ---------- downloads ----------
  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $("#cards").addEventListener("click", (e) => {
    const b = e.target.closest("button.dl");
    if (!b) return;
    const f = fileFor(b.dataset.account, b.dataset.kind);
    download(f.name, new Blob([f.text], { type: "text/csv" }));
  });

  $("#accounts").addEventListener("click", () => {
    const f = accountsFile();
    download(f.name, new Blob([f.text], { type: "text/csv" }));
  });

  $("#combined").addEventListener("click", () => {
    const files = combinedFiles();
    if (files.length === 1) return download(files[0].name, new Blob([files[0].text], { type: "text/csv" }));
    const { from, to } = range();
    download(`stashaway-combined-${from}_to_${to}.zip`, zip(files));
  });

  $("#zip").addEventListener("click", () => {
    const files = [accountsFile()];
    for (const b of document.querySelectorAll("#cards button.dl")) files.push(fileFor(b.dataset.account, b.dataset.kind));
    const { from, to } = range();
    download(`stashaway-csv-${from}_to_${to}.zip`, zip(files));
  });

  // Minimal store-only ZIP writer.
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const put = (view, fields) => fields.forEach(([o, v, s]) => (s === 4 ? view.setUint32(o, v, true) : view.setUint16(o, v, true)));
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      put(local, [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, dosTime, 2], [12, dosDate, 2], [14, crc, 4],
        [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]);
      const cen = new DataView(new ArrayBuffer(46));
      put(cen, [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, dosTime, 2], [14, dosDate, 2], [16, crc, 4],
        [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]);
      chunks.push(local, name, data);
      central.push(cen, name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((s, c) => s + c.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    put(end, [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, offset, 4], [20, 0, 2]]);
    return new Blob([...chunks, ...central, end], { type: "application/zip" });
  }

  // ---------- input ----------
  const drop = $("#drop"), picker = $("#picker");
  drop.addEventListener("click", () => picker.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } });
  picker.addEventListener("change", () => { addFiles(picker.files); picker.value = ""; });
  for (const ev of ["dragenter", "dragover"]) document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || e.target === document.documentElement) drop.classList.remove("over"); });
  document.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
  $("#mode").addEventListener("click", (e) => { const b = e.target.closest("button[data-mode]"); if (b) setMode(b.dataset.mode); });
  $("#from").addEventListener("change", render);
  $("#to").addEventListener("change", render);
  $("#clear").addEventListener("click", () => { state.statements.clear(); state.failed = []; recompute(); });

  // ---------- helpers ----------
  function setBusy(msg) { $("#busy").textContent = msg || ""; $("#busy").hidden = !msg; }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
  const fmtInt = (n) => n.toLocaleString();
  const fmtMoney = (n) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  setMode(state.mode);
})();

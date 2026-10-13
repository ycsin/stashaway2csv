// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yong Cong Sin <yongcong.sin@gmail.com>
// StashAway monthly statement parser; works in the browser
// (window.StashParser) and in Node (module.exports) so it can be tested headless.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.StashParser = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const DATE_RE = /^\s*(\d{2}) (\w{3}) (\d{4})\s{2,}(.*)$/;
  // Amounts: "$1,234.56", "-$0.18", "RM 4,998.82", "-RM 2.07" (prefix depends on the country).
  const MONEY_RE = /^-?(?:[A-Z]{0,3}\$|[A-Z]{2,3} ?)[\d,]+(\.\d+)?$/;
  const NUM_RE = /^-?[\d,]+(\.\d+)?$/;
  const PERIOD_RE = /(\d{2}) (\w{3}) (\d{4}) - (\d{2}) (\w{3}) (\d{4})/;

  const round2 = (n) => Math.round(n * 100) / 100;
  const pad = (n) => String(n).padStart(2, "0");

  function money(tok) {
    if (tok == null || tok === "-" || tok === "") return null;
    const n = parseFloat(tok.replace(/[^\d.]/g, ""));
    return tok.trim().startsWith("-") ? -n : n;
  }

  function isoDate(d, mon, y) {
    const m = MONTHS[mon.slice(0, 3).charAt(0).toUpperCase() + mon.slice(1, 3).toLowerCase()];
    if (!m) throw new Error(`bad month ${mon}`);
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  const splitCols = (s) => s.split(/\s{2,}/);

  // ---- PDF text layout -----------------------------------------------------
  // pdf.js returns positioned text fragments. Rebuild each page as lines of text
  // with table columns separated by 2+ spaces, the layout the parser expects.
  function itemsToPageText(items) {
    // Icon glyphs (e.g. before "Income" from 2024) come through as control characters.
    const frags = items
      .map((it) => ({ str: (it.str || "").replace(/[\u0000-\u001f\u007f]/g, ""), x: it.x, y: it.y, w: it.w, h: Math.max(it.h, 1) }))
      .filter((it) => it.str.trim() !== "");
    if (!frags.length) return "";
    frags.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const f of frags) {
      const line = lines.find((l) => Math.abs(l.y - f.y) <= Math.min(l.h, f.h) * 0.45);
      if (line) line.frags.push(f);
      else lines.push({ y: f.y, h: f.h, frags: [f] });
    }
    lines.sort((a, b) => b.y - a.y);
    const minX = Math.min(...frags.map((f) => f.x));
    return lines
      .map((l) => {
        l.frags.sort((a, b) => a.x - b.x);
        let out = l.frags[0].x - minX > 3 ? " " : "";
        let prevEnd = null;
        for (const f of l.frags) {
          if (prevEnd !== null) {
            const charW = f.w / Math.max(f.str.length, 1) || f.h * 0.5;
            const gap = f.x - prevEnd;
            out += gap > Math.max(charW * 1.2, f.h * 0.6) ? "  " : gap > charW * 0.15 ? " " : "";
          }
          out += f.str;
          prevEnd = f.x + f.w;
        }
        return out.replace(/\s+$/, "");
      })
      .join("\n");
  }

  // ---- portfolio identity ----------------------------------------------------
  // Portfolios are tracked month to month from the statements themselves, with
  // no built-in list of names. Portfolio names can be changed by the user, so a
  // name is only trusted as-is (ignoring StashAway's own "™" and "StashAway "
  // prefix): same name and reporting currency as before, else a rename (its
  // opening balance equals the closing balance of a portfolio that disappeared
  // that month), else a new portfolio. Fixed-term (Guaranteed) placements are all
  // grouped into one portfolio.
  const FIXED_TERM = "fixed-term";
  const ZERO = 0.005;

  function normName(name) {
    return name.replace(/™/g, "").replace(/\s+/g, " ").trim().replace(/^StashAway /i, "").trim();
  }
  const isFixedTerm = (name, section) => section === "guaranteed" || /maturity|guaranteed/i.test(name);

  // ---- statement sections ---------------------------------------------------
  function parseSummary(pages) {
    const rows = [];
    let section = null;
    for (const page of pages) {
      if (!page.includes("PORTFOLIO SUMMARY")) continue;
      for (const line of page.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        if (s.startsWith("Investment Portfolios")) { section = "investment"; continue; }
        if (s.startsWith("Cash Management")) { section = "cash"; continue; }
        // Section heading, e.g. "StashAway Simple™ Guaranteed". Wrapped portfolio
        // names ("Guaranteed (6 / months - 3.6%, ...") are indented; headings aren't.
        if (s.includes("Guaranteed") && !s.includes("$") && !line.startsWith(" ")) { section = "guaranteed"; continue; }
        const parts = splitCols(s);
        const tail = parts.slice(-5);
        if (parts.length >= 6 && tail.every((t) => MONEY_RE.test(t) || t === "-")) {
          rows.push({
            section,
            name: parts.slice(0, -5).join(" "),
            opening: money(tail[0]) || 0,
            // Guaranteed tables have "Maturity Value" (paid out) where others have Fees.
            cashflow: (money(tail[1]) || 0) - (section === "guaranteed" ? money(tail[3]) || 0 : 0),
            closing: money(tail[4]) || 0,
          });
        } else if (rows.length && !s.includes("$") && !/^(Opening|\(|Reporting|PORTFOLIO|Closing|Total|ETF)/.test(s)
                   && !/^\d+$/.test(s) && line.startsWith(" ")) {
          rows[rows.length - 1].name += " " + s; // wrapped portfolio name
        }
      }
    }
    return rows;
  }

  function parseDetailsCurrencies(pages) {
    const out = [];
    for (const page of pages) {
      const m = page.match(/PORTFOLIO DETAILS \/ \w+ \d{4}\s*\n\s*(.+?)\s*\n\s*Reporting Currency: (\w{3})/);
      if (m) out.push([m[1].trim(), m[2]]);
    }
    return out;
  }

  function parseTransactions(pages) {
    const sections = [];
    let current = null;
    for (const page of pages) {
      const lines = page.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*TRANSACTIONS \/ \w+ \d{4}/.test(line)) {
          const name = lines.slice(i + 1).find((l) => l.trim()).trim();
          current = { name, currency: null, twoCols: false, rows: [] };
          sections.push(current);
          continue;
        }
        if (!current) continue;
        if (/^\s*Date\s+Transaction/.test(line)) {
          current.twoCols = (line.match(/Total Value/g) || []).length === 2;
          const m = (lines[i + 1] || "").match(/\((\w{3})\)/) || line.match(/\((\w{3})\)/);
          if (m) current.currency = m[1];
          continue;
        }
        const m = line.match(DATE_RE);
        if (m) {
          const parts = splitCols(m[4].trim());
          current.rows.push({ date: isoDate(m[1], m[2], m[3]), desc: parts[0], tokens: parts.slice(1) });
        }
      }
      if (page.includes("PORTFOLIO DETAILS") || page.includes("FEE CALCULATIONS") || page.includes("APPENDIX")) current = null;
    }
    return sections;
  }

  function classify(row, section, base) {
    const { desc, tokens } = row;
    const ccy = section.currency || base;
    const vals = tokens.filter((t) => MONEY_RE.test(t) || t === "-");
    const nums = tokens.filter((t) => NUM_RE.test(t));
    // Two-column tables: total in the portfolio's currency, then in the base currency.
    let totalCcy, totalBase;
    if (section.twoCols && vals.length >= 2) [totalCcy, totalBase] = [money(vals[vals.length - 2]), money(vals[vals.length - 1])];
    else [totalCcy, totalBase] = [vals.length ? money(vals[vals.length - 1]) : null, null];
    let amount = null, amountCcy = ccy;
    if (totalCcy != null) [amount, amountCcy] = [totalCcy, ccy];
    else if (totalBase != null) [amount, amountCcy] = [totalBase, base];

    const t = desc.match(/^(Buy|Sell) (\S+)$/);
    if (t) {
      const qty = nums.length ? parseFloat(nums[0].replace(/,/g, "")) : null;
      const price = vals.length ? money(vals[0]) : null;
      if (qty == null || price == null) return ["skip", "trade without qty/price"];
      return ["trade", { date: row.date, ticker: t[2], qty: t[1] === "Buy" ? qty : -qty, price, currency: ccy, name: desc }];
    }
    if (desc.startsWith("Currency Conversion")) return ["skip", "fx conversion (internal)"];
    // Guaranteed portfolios: cash moving into/out of the fixed deposit inside the
    // same portfolio. The money itself arrives/leaves as Deposit/Withdrawal.
    if (desc.startsWith("Portfolio investment") || desc.startsWith("Portfolio redemption")) return ["skip", "fixed-deposit placement (internal)"];
    if (amount == null || amount === 0) return ["skip", `no amount: ${desc}`];

    let sign, kind;
    if (desc.startsWith("Deposit")) [sign, kind] = [1, "transfer"];
    else if (desc.startsWith("Withdrawal")) [sign, kind] = [-1, "transfer"];
    else if (desc.startsWith("Dividend")) [sign, kind] = [1, "income"];
    else if (desc.startsWith("Management fee")) [sign, kind] = [-1, "fee"];
    else return ["skip", `unknown: ${desc}`];
    // Internal sign convention: inflow negative, outflow positive (CSV output flips it).
    return ["cash", { date: row.date, amount: round2(-sign * amount), currency: amountCcy, name: desc, kind }];
  }

  // ---- whole statements -----------------------------------------------------
  // Each statement: { id, pages: [text, ...] }; any order. config (optional), per
  // portfolio id: { name, kind: "investment"|"cash", mergeInto: <portfolio id>,
  // exclude: true }. Returns per-account data, the detected portfolios, and
  // diagnostics.
  function parseStatements(statements, config = {}) {
    const skipped = {};
    const unmapped = {};
    const reconciled = [];
    const months = [];
    const errors = [];
    // Every row not exported, so the page can show them for the selected months:
    // { date, category, detail, portfolio }.
    const skippedRows = [];
    const skip = (date, reason, portfolio) => {
      const i = reason.indexOf(": ");
      const category = i < 0 ? reason : reason.slice(0, i);
      skipped[category] = (skipped[category] || 0) + 1;
      skippedRows.push({ date, category, detail: i < 0 ? null : reason.slice(i + 2), portfolio });
    };

    const dated = [];
    for (const st of statements) {
      const period = st.pages.join("\n").match(PERIOD_RE);
      if (!period) { errors.push({ id: st.id, error: "not a StashAway monthly statement (no statement period found)" }); continue; }
      const flat = st.pages.join("\n").replace(/\s+/g, " ");
      const baseMatch = flat.match(/ACCOUNT SUMMARY.*?Reporting Currency: ([A-Z]{3})/) || flat.match(/\(1 USD = [\d.]+ ([A-Z]{3})\)/);
      dated.push({ ...st, flat, base: baseMatch ? baseMatch[1] : "SGD", monthEnd: isoDate(period[4], period[5], period[6]) });
    }
    // One StashAway account (one country, one reporting currency) at a time.
    const byBase = {};
    for (const st of dated) byBase[st.base] = (byBase[st.base] || 0) + 1;
    const baseCurrency = Object.keys(byBase).sort((x, y) => byBase[y] - byBase[x])[0] || "SGD";
    for (const st of dated.filter((d) => d.base !== baseCurrency)) {
      errors.push({ id: st.id, error: `reports in ${st.base} while the other statements report in ${baseCurrency}; load one StashAway account at a time (ignored)` });
    }
    dated.splice(0, dated.length, ...dated.filter((d) => d.base === baseCurrency));
    dated.sort((a, b) => a.monthEnd.localeCompare(b.monthEnd));

    // Pass 1: track portfolios and collect their monthly figures and entries.
    const lineages = {}; // id -> { id, names, firstMonth, lastMonth, section, currency, months, trades, cash }
    const newLineage = (id, row, month) => {
      let key = id, n = 2;
      while (lineages[key]) key = `${id}#${n++}`;
      return (lineages[key] = { id: key, names: [], firstMonth: month, lastMonth: month, section: row.section, currency: row.ccy, months: {}, trades: [], cash: [] });
    };
    const seen = new Set();
    let prevRows = [];
    for (const st of dated) {
      const month = st.monthEnd.slice(0, 7);
      if (seen.has(month)) { errors.push({ id: st.id, error: `duplicate statement for ${month}, ignored` }); continue; }
      seen.add(month);
      months.push({ id: st.id, month });
      const pages = st.pages;
      const base = st.base;
      // "... closing rates ... as of 31 Jan 2025 (1 USD = 1.3500 SGD)"
      const fxMatch = st.flat.match(/Closing balance is based on closing rates.*?\(1 USD = ([\d.]+) ([A-Z]{3})\)/);
      const fx = fxMatch && fxMatch[2] === base ? parseFloat(fxMatch[1]) : null;

      // Reporting currency per summary row: the k-th row with a name matches the
      // k-th PORTFOLIO DETAILS section with that name.
      const details = parseDetailsCurrencies(pages);
      const nth = {};
      const rows = parseSummary(pages).map((r) => {
        const norm = normName(r.name);
        const k = (nth[norm] = (nth[norm] || 0) + 1);
        const d = details.filter(([dn]) => normName(dn) === norm)[k - 1];
        return { ...r, norm, ccy: d ? d[1] : null, id: null };
      });

      const used = new Set();
      const sameKey = {}; // norm|ccy -> id: same-named rows in one month are one portfolio
      for (const r of rows) {
        if (isFixedTerm(r.name, r.section)) { r.id = FIXED_TERM; continue; }
        const key = `${r.norm}|${r.ccy || ""}`;
        if (sameKey[key]) { r.id = sameKey[key]; continue; }
        let cands = Object.values(lineages).filter((l) => l.id !== FIXED_TERM && !used.has(l.id) && normName(l.names[l.names.length - 1]) === r.norm
          && (!r.ccy || !l.currency || l.currency === r.ccy));
        if (cands.length > 1) {
          const byBalance = cands.filter((l) => prevRows.some((p) => p.id === l.id && Math.abs(p.closing - r.opening) < ZERO));
          cands = byBalance.length === 1 ? byBalance : cands.sort((a, b) => b.lastMonth.localeCompare(a.lastMonth)).slice(0, 1);
        }
        if (cands.length) { r.id = cands[0].id; used.add(r.id); sameKey[key] = r.id; }
      }
      for (const r of rows) { // renames
        if (r.id || Math.abs(r.opening) < ZERO) continue;
        const gone = prevRows.filter((p) => p.id !== FIXED_TERM && !used.has(p.id) && !rows.some((x) => x.id === p.id)
          && Math.abs(p.closing - r.opening) < ZERO);
        const ids = [...new Set(gone.map((p) => p.id))];
        if (ids.length === 1) { r.id = ids[0]; used.add(r.id); sameKey[`${r.norm}|${r.ccy || ""}`] = r.id; }
      }
      for (const r of rows) {
        if (r.id === FIXED_TERM && !lineages[FIXED_TERM]) lineages[FIXED_TERM] = { ...newLineage("tmp", r, month), id: FIXED_TERM };
        if (!r.id) { r.id = newLineage(`${month}:${r.norm}${r.ccy ? ":" + r.ccy : ""}`, r, month).id; sameKey[`${r.norm}|${r.ccy || ""}`] = r.id; }
        const l = lineages[r.id];
        if (r.id !== FIXED_TERM && l.names[l.names.length - 1] !== r.norm) l.names.push(r.norm);
        l.lastMonth = month;
        l.section = r.section;
        if (r.ccy) l.currency = r.ccy;
        const m = (l.months[month] = l.months[month] || { monthEnd: st.monthEnd, opening: 0, closing: 0, cashflow: 0, fx });
        m.opening += r.opening; m.closing += r.closing; m.cashflow += r.cashflow;
      }
      delete lineages.tmp;
      prevRows = rows;

      // Transactions: match each section to this month's portfolio.
      for (const section of parseTransactions(pages)) {
        const norm = normName(section.name);
        let id = isFixedTerm(section.name) ? FIXED_TERM : null;
        if (!id) {
          const byName = rows.filter((r) => r.id !== FIXED_TERM && r.norm === norm);
          const byCcy = byName.filter((r) => section.currency && r.ccy === section.currency);
          const loose = rows.filter((r) => r.id !== FIXED_TERM && (norm.startsWith(r.norm) || r.norm.startsWith(norm)));
          id = (byCcy[0] || byName[0] || (loose.length === 1 ? loose[0] : null) || {}).id || null;
        }
        if (!id || !lineages[id]) { const k = section.name; (unmapped[k] = unmapped[k] || new Set()).add(month); continue; }
        for (const row of section.rows) {
          const [kind, payload] = classify(row, section, base);
          if (kind === "skip") { skip(row.date, payload, id); continue; }
          lineages[id][kind === "trade" ? "trades" : "cash"].push(payload);
        }
      }
    }

    // Labels: latest name, made unique with the currency (then the first month).
    const portfolios = Object.values(lineages).sort((a, b) => a.firstMonth.localeCompare(b.firstMonth) || a.id.localeCompare(b.id));
    for (const l of portfolios) {
      l.label = l.id === FIXED_TERM ? "Guaranteed" : l.names[l.names.length - 1];
      l.kind = l.id === FIXED_TERM || l.section !== "investment" ? "cash" : "investment";
    }
    for (const l of portfolios) {
      const twins = portfolios.filter((o) => o.label === l.label);
      if (twins.length > 1) for (const t of twins) t.label = t.currency ? `${t.names[t.names.length - 1]} (${t.currency})` : t.label;
    }
    for (const l of portfolios) {
      const twins = portfolios.filter((o) => o.label === l.label);
      if (twins.length > 1) for (const t of twins) t.label = `${t.label} from ${t.firstMonth}`;
    }

    // Pass 2: apply config (rename, type, merge, exclude) and build accounts.
    const rootOf = (id) => {
      const path = new Set();
      while (config[id] && config[id].mergeInto && lineages[config[id].mergeInto] && !path.has(id)) { path.add(id); id = config[id].mergeInto; }
      return id;
    };
    const accounts = {};
    for (const l of portfolios) {
      const root = lineages[rootOf(l.id)];
      if ((config[root.id] || {}).exclude || (config[l.id] || {}).exclude) { l.account = null; continue; }
      const name = ((config[root.id] || {}).name || "").trim() || root.label;
      l.account = name;
      const a = (accounts[name] = accounts[name] || { kind: (config[root.id] || {}).kind || root.kind, valuations: [], trades: [], cash: [], months: {}, portfolios: [], currency: baseCurrency });
      a.portfolios.push(l.id);
      a.trades.push(...l.trades);
      a.cash.push(...l.cash);
      for (const [month, m] of Object.entries(l.months)) {
        const t = (a.months[month] = a.months[month] || { monthEnd: m.monthEnd, opening: 0, closing: 0, cashflow: 0, fx: m.fx });
        t.opening += m.opening; t.closing += m.closing; t.cashflow += m.cashflow;
      }
    }
    for (const [name, a] of Object.entries(accounts)) {
      if (a.kind === "cash" && a.trades.length) {
        for (const t of a.trades) skip(t.date, `trade in cash-like account: ${t.name}`, name);
        a.trades = [];
      }
      a.trades.sort((x, y) => x.date.localeCompare(y.date));
      a.cash.sort((x, y) => x.date.localeCompare(y.date));
      for (const m of Object.values(a.months)) { m.opening = round2(m.opening); m.closing = round2(m.closing); m.cashflow = round2(m.cashflow); }

      // Older statements sometimes omit Deposit/Withdrawal rows (only the FX
      // conversion appears), and some rows carry no amount. Balance each account's
      // net deposits against the summary's Cashflow column with one entry on the
      // last day of the month. Months with non-SGD transfer rows are left alone:
      // the statement's SGD column for those copies the USD figure.
      const monthKeys = new Set([...Object.keys(a.months), ...a.cash.map((c) => c.date.slice(0, 7))]);
      for (const month of [...monthKeys].sort()) {
        const transfers = a.cash.filter((c) => c.kind === "transfer" && c.date.startsWith(month));
        if (transfers.some((c) => c.currency !== baseCurrency)) continue;
        const parsed = transfers.reduce((sum, c) => sum - c.amount, 0);
        const diff = round2(((a.months[month] || {}).cashflow || 0) - parsed);
        if (Math.abs(diff) >= 0.01 && a.months[month]) {
          a.cash.push({ date: a.months[month].monthEnd, amount: -diff, currency: baseCurrency,
            name: diff > 0 ? "Net deposits (statement summary)" : "Net withdrawals (statement summary)", kind: "transfer", balancing: true });
          reconciled.push({ month, account: name, diff });
        }
      }
      a.cash.sort((x, y) => x.date.localeCompare(y.date));
      a.valuations = Object.values(a.months).map((m) => [m.monthEnd, m.closing]).sort(([x], [y]) => x.localeCompare(y));
    }
    reconciled.sort((x, y) => x.month.localeCompare(y.month));
    for (const r of skippedRows) if (lineages[r.portfolio]) r.portfolio = lineages[r.portfolio].account || lineages[r.portfolio].label;
    skippedRows.sort((x, y) => x.date.localeCompare(y.date));

    const gaps = monthGaps(months.map((m) => m.month));
    const first = months.length ? months[0].month : null;
    const firstOpenings = first ? Object.entries(accounts).filter(([, a]) => a.months[first] && Math.abs(a.months[first].opening) >= ZERO)
      .map(([name, a]) => ({ account: name, month: first, opening: a.months[first].opening })) : [];
    return {
      accounts, months, skipped, skippedRows, reconciled, errors, gaps, firstOpenings, baseCurrency,
      portfolios: portfolios.map((l) => ({ id: l.id, label: l.label, names: l.id === FIXED_TERM ? ["fixed-term placements"] : l.names,
        firstMonth: l.firstMonth, lastMonth: l.lastMonth, kind: l.kind, currency: l.currency, account: l.account })),
      unmapped: Object.fromEntries(Object.entries(unmapped).map(([k, v]) => [k, [...v].sort()])),
    };
  }

  function monthGaps(sortedMonths) {
    const gaps = [];
    for (let i = 1; i < sortedMonths.length; i++) {
      let [y, m] = sortedMonths[i - 1].split("-").map(Number);
      for (;;) {
        m += 1; if (m > 12) { m = 1; y += 1; }
        const k = `${y}-${pad(m)}`;
        if (k >= sortedMonths[i]) break;
        gaps.push(k);
      }
    }
    return gaps;
  }

  // ---- CSV output ----
  // Text copied from a statement must not be read as a spreadsheet formula, so
  // text cells starting with = + - @ get a leading apostrophe (numbers are left alone).
  const csvCell = (v) => {
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?[\d.]+$/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  const num = (n, dp) => n.toFixed(dp).replace(/\.?0+$/, "");
  const inRange = (date, from, to) => (!from || date.slice(0, 7) >= from) && (!to || date.slice(0, 7) <= to);

  // Combined files for multi-account imports: one CSV for all portfolios with a
  // leading "account" column. groups: [{ account, rows }] (rows already filtered).
  function combinedTradesCsv(groups) {
    return csv(["account", "date", "ticker", "qty", "price", "currency", "name"],
      groups.flatMap((g) => g.rows.map((t) => [g.account, t.date, t.ticker, num(t.qty, 6), num(t.price, 6), t.currency, t.name])));
  }

  // Entries in the internal sign convention; written with inflows positive.
  function combinedTransactionsCsv(groups) {
    return csv(["account", "date", "amount", "currency", "name"],
      groups.flatMap((g) => g.rows.slice().sort((a, b) => a.date.localeCompare(b.date))
        .map((c) => [g.account, c.date, (-c.amount).toFixed(2), c.currency, c.name])));
  }

  function tradesCsv(trades, from, to) {
    return csv(["date", "ticker", "qty", "price", "currency", "name"],
      trades.filter((t) => inRange(t.date, from, to)).map((t) => [t.date, t.ticker, num(t.qty, 6), num(t.price, 6), t.currency, t.name]));
  }

  // Amounts written with inflows positive (deposits/dividends +, fees/withdrawals -).
  function transactionsCsv(cash, from, to) {
    return csv(["date", "amount", "currency", "name"],
      cash.filter((c) => inRange(c.date, from, to)).slice().sort((a, b) => a.date.localeCompare(b.date))
        .map((c) => [c.date, (-c.amount).toFixed(2), c.currency, c.name]));
  }

  function valuationsCsv(valuations, from, to, currency) {
    return csv(["date", "balance", "currency"], valuations.filter(([d]) => inRange(d, from, to)).map(([d, v]) => [d, v.toFixed(2), currency]));
  }

  // Balance-only export: the account's cash entries in SGD plus one
  // "Returns (month-end adjustment)" entry per month, so that this one CSV puts
  // the running balance exactly on each statement's closing value, with no
  // trades or separate balance records needed. Each month builds on the previous
  // month's closing balance when that statement is loaded, otherwise on the
  // statement's own opening balance (StashAway's opening occasionally differs
  // from the prior closing by a few dollars). If earlier statements are loaded
  // but the previous month is missing, or the portfolio first appears after the
  // earliest loaded statement (it started in a missing month), one "Balance
  // change not covered by statements" entry bridges the gap so later balances
  // stay exact; the missing month's individual entries are unknown. Non-SGD entries are converted at
  // the statement's closing USD/SGD rate. Entries use the internal sign
  // convention (inflow negative), sorted by date.
  // earliestMonth: the first statement month loaded at all ("YYYY-MM").
  // withTrades: also list each buy/sell as a zero-amount line ("trade log"); a
  // trade swaps cash for units inside the portfolio, so the value doesn't change.
  function adjustedEntries(account, from, to, earliestMonth, withTrades = false) {
    const out = [];
    const problems = [];
    const baseCcy = account.currency;
    let last = null; // last loaded month before this one: [month, data]
    for (const [month, m] of Object.entries(account.months).sort(([x], [y]) => x.localeCompare(y))) {
      const prior = account.months[prevMonth(month)];
      const lastBefore = last;
      last = [month, m];
      if (!inRange(m.monthEnd, from, to)) continue;
      const base = prior ? prior.closing : m.opening;
      if (!prior && (lastBefore || (earliestMonth && month > earliestMonth))) {
        const bridge = round2(m.opening - (lastBefore ? lastBefore[1].closing : 0));
        if (Math.abs(bridge) >= 0.005) {
          const missing = [];
          const stop = lastBefore ? lastBefore[0] : prevMonth(earliestMonth);
          for (let k = prevMonth(month); k > stop && missing.length < 12; k = prevMonth(k)) missing.unshift(k);
          out.push({ date: lastDayOf(prevMonth(month)), amount: -bridge, currency: baseCcy, kind: "gap",
                     name: `Balance change not covered by statements (${missing.join(", ")})` });
        }
      }
      let flows = 0; // SGD, inflow positive
      for (const c of account.cash.filter((c) => c.date.startsWith(month))) {
        let entry = c;
        if (c.currency !== baseCcy) {
          if (c.currency !== "USD" || !m.fx) { problems.push(`${month}: cannot convert ${c.currency} entry "${c.name}"`); continue; }
          const usd = -c.amount;
          entry = { ...c, amount: round2(c.amount * m.fx), currency: baseCcy,
                    name: `${c.name} (USD ${usd.toFixed(2)} @ ${m.fx})` };
        }
        flows += -entry.amount;
        out.push(entry);
      }
      if (withTrades) {
        for (const t of account.trades.filter((t) => t.date.startsWith(month))) {
          const value = Math.abs(t.qty) * t.price;
          out.push({ date: t.date, amount: 0, currency: baseCcy, kind: "trade",
                     name: `${t.qty > 0 ? "Buy" : "Sell"} ${num(Math.abs(t.qty), 6)} ${t.ticker} @ ${t.currency} ${num(t.price, 6)} (${t.currency} ${value.toFixed(2)})` });
        }
      }
      const adj = round2(m.closing - base - flows);
      if (Math.abs(adj) >= 0.005) {
        out.push({ date: m.monthEnd, amount: -adj, currency: baseCcy, kind: "adjustment",
                   name: `Returns (month-end adjustment, ${month})` });
      }
    }
    // Stable sort: by date, keeping statement order within a day; adjustments last.
    out.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === "adjustment") - (b.kind === "adjustment"));
    return { entries: out, problems };
  }

  function prevMonth(month) {
    let [y, m] = month.split("-").map(Number);
    m -= 1;
    if (!m) { m = 12; y -= 1; }
    return `${y}-${pad(m)}`;
  }

  function lastDayOf(month) {
    const [y, m] = month.split("-").map(Number);
    return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  }

  // Starting point for an account import: the balance just before the first
  // exported entry, and that date. Matches the base adjustedEntries builds on:
  // the previous month's closing, else the last loaded closing before a gap,
  // else 0 for a portfolio that started in a missing month, else the earliest
  // statement's opening. Null if the account has no months in range.
  function openingBalance(account, from, to, earliestMonth, entries) {
    const months = Object.keys(account.months).sort();
    const first = months.find((m) => inRange(account.months[m].monthEnd, from, to));
    if (!first) return null;
    const earlier = months.filter((m) => m < first);
    const lastBefore = earlier.length ? account.months[earlier[earlier.length - 1]] : null;
    const prior = account.months[prevMonth(first)];
    let balance;
    if (prior) balance = prior.closing;
    else if (lastBefore) balance = lastBefore.closing;
    else if (earliestMonth && first > earliestMonth) balance = 0;
    else balance = account.months[first].opening;
    let date = lastDayOf(prevMonth(first));
    const firstEntry = (entries || []).map((e) => e.date).sort()[0];
    if (firstEntry && firstEntry <= date) date = dayBefore(firstEntry);
    return { balance: round2(balance), date };
  }

  function dayBefore(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // rows: [{ type, name, balance, date }]. Header follows the common
  // "Account type, Name, Balance, Currency, Balance Date" account-import layout.
  function accountsCsv(rows) {
    return csv(["Account type", "Name", "Balance", "Currency", "Balance Date"],
      rows.map((r) => [r.type, r.name, r.balance.toFixed(2), r.currency, r.date]));
  }

  function adjustedCsv(account, from, to, earliestMonth, withTrades = false) {
    return csv(["date", "amount", "currency", "name"],
      adjustedEntries(account, from, to, earliestMonth, withTrades).entries.map((c) => [c.date, (-c.amount).toFixed(2), c.currency, c.name]));
  }

  // QIF (Quicken Interchange Format) for one account: an "Opening Balance" record
  // (balance just before the first entry), then every entry. QIF has no currency
  // field; import each file into an account of the right currency. Dates are ISO
  // (YYYY-MM-DD) so they can't be misread as month/day. P = name, M = notes.
  // start: { balance, date } or null.
  function qif(entries, start, accountName, type = "Bank") {
    const clean = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();
    const out = [`!Type:${type}`];
    if (start) out.push(`D${start.date}`, `T${start.balance.toFixed(2)}`, "POpening Balance", `L[${clean(accountName)}]`, "^");
    for (const e of entries.slice().sort((a, b) => a.date.localeCompare(b.date))) {
      out.push(`D${e.date}`, `T${(-e.amount).toFixed(2)}`, `P${clean(e.name)}`);
      if (e.notes) out.push(`M${clean(e.notes)}`);
      out.push("^");
    }
    return out.join("\n") + "\n";
  }

  return { qif, itemsToPageText, parseStatements, normName, tradesCsv, transactionsCsv, valuationsCsv,
           adjustedEntries, adjustedCsv, openingBalance, accountsCsv, combinedTradesCsv, combinedTransactionsCsv, inRange };
});

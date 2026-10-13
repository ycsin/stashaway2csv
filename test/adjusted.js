// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yong Cong Sin <yongcong.sin@gmail.com>
// Balance-only export check: importing an account's adjusted CSV from its first
// month must put the running balance exactly on every statement closing balance.
//   node adjusted.js <statements dump json>   (dump written by compare.js with DUMP=...)
const fs = require("fs");
const P = require("../src/parser.js");

const statements = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const r = P.parseStatements(statements);
let bad = 0;
for (const [name, a] of Object.entries(r.accounts)) {
  const { entries, problems } = P.adjustedEntries(a, null, null, r.months[0].month, process.env.TRADES === "1");
  const tradeLines = entries.filter((e) => e.kind === "trade");
  if (process.env.TRADES === "1" && (tradeLines.length !== a.trades.length || tradeLines.some((e) => e.amount !== 0))) {
    console.log(`BAD ${name}: ${tradeLines.length} trade lines for ${a.trades.length} trades`); bad++;
  }
  const covered = new Set(Object.keys(a.months));
  const orphans = a.cash.filter((c) => !covered.has(c.date.slice(0, 7)));
  let bal = 0, worst = 0, checked = 0, gaps = [];
  const byMonth = {};
  for (const e of entries) (byMonth[e.date.slice(0, 7)] = byMonth[e.date.slice(0, 7)] || []).push(e);
  const months = Object.keys(a.months).sort();
  let prevClose = 0;
  for (const m of months) {
    if (Math.abs(a.months[m].opening - prevClose) >= 0.005) gaps.push(`${m} opens ${a.months[m].opening} after ${prevClose}`);
    for (const e of byMonth[m] || []) bal = Math.round((bal - e.amount) * 100) / 100;
    worst = Math.max(worst, Math.abs(bal - a.months[m].closing));
    checked++;
    prevClose = a.months[m].closing;
  }
  const adj = entries.filter((e) => e.kind === "adjustment").length;
  const ok = worst < 0.005 && !problems.length && !orphans.length;
  bad += !ok;
  console.log(`${ok ? "OK " : "BAD"} ${name}: ${checked} month-ends, ${entries.length} rows (${adj} adjustments), max diff ${worst.toFixed(2)}`
    + (problems.length ? ` problems=${problems}` : "") + (orphans.length ? ` ORPHAN entries: ${orphans.map((o) => o.date + " " + o.name).join("; ")}` : "")
    + (gaps.length ? `\n      opening != previous closing: ${gaps.join("; ")}` : ""));
}
console.log(bad ? `${bad} accounts failed` : "every month-end matches the statement");
process.exit(bad ? 1 : 0);

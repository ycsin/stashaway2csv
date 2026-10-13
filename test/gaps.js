// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yong Cong Sin <yongcong.sin@gmail.com>
// Missing-statement check: drop statements, export balance-only, and confirm the
// running balance (all entries up to each date) still equals every loaded
// statement's closing balance.
//   node gaps.js <statements dump json>
const fs = require("fs");
const P = require("../src/parser.js");
const all = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let failed = 0;
// Months come from the statements given: a middle month, two in a row, the
// month a portfolio first appears in, the first month and the last month.
const months = P.parseStatements(all).months.map((m) => m.month);
const mid = Math.floor(months.length / 2);
const starts = Object.values(P.parseStatements(all).accounts)
  .map((a) => Object.keys(a.months).sort()[0]).filter((m) => m && m > months[0]).sort();
const firstAppearance = starts.length ? starts[0] : null;
const cases = [[months[mid]], [months[mid], months[mid + 1]], firstAppearance ? [firstAppearance] : null, [months[0]], [months[months.length - 1]]]
  .filter((c) => c && c.every(Boolean) && months.length > 2);
for (const drop of cases) {
  const r = P.parseStatements(all.filter((s) => !drop.some((d) => s.id.startsWith(d))));
  const earliest = r.months[0].month;
  let worst = 0;
  const bridges = [];
  for (const [name, a] of Object.entries(r.accounts)) {
    const { entries } = P.adjustedEntries(a, null, null, earliest);
    const start = (r.firstOpenings.find((o) => o.account === name) || { opening: 0 }).opening;
    bridges.push(...entries.filter((e) => e.kind === "gap").map((e) => `${name.replace("Stashaway ", "")} ${e.date} ${(-e.amount).toFixed(2)}`));
    for (const [d, v] of a.valuations) {
      const bal = start + entries.filter((e) => e.date <= d).reduce((s, e) => s - e.amount, 0);
      worst = Math.max(worst, Math.abs(Math.round(bal * 100) / 100 - v));
    }
  }
  const ok = worst < 0.005;
  failed += !ok;
  console.log(`${ok ? "OK " : "BAD"} without ${drop}: gaps ${JSON.stringify(r.gaps)}, first openings ${r.firstOpenings.length}, max diff ${worst.toFixed(2)}`
    + `\n      bridges: ${bridges.join("; ") || "none"}`);
}
process.exit(failed ? 1 : 0);

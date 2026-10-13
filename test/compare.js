// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yong Cong Sin <yongcong.sin@gmail.com>
// Parse StashAway PDFs with pdf.js + ../src/parser.js (the same code the web page
// runs) and compare against a reference parse checked by hand against the same
// statements (JSON: { accounts: { <name>: { valuations, trades, cash } } }).
// The optional map file translates account names ({ names: { <ours>: <reference> } })
// and passes a portfolio config ({ config: { <portfolio id>: {...} } }).
//   node compare.js <pdf dir> <reference.json> [map.json]
const fs = require("fs");
const path = require("path");
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const P = require("../src/parser.js");

async function pdfPages(file) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(P.itemsToPageText(content.items.map((it) => ({
      str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.abs(it.transform[3]),
    }))));
  }
  return pages;
}

const key = (o, fields) => fields.map((f) => (typeof o[f] === "number" ? o[f].toFixed(6) : o[f])).join("|");

function diffMultiset(name, a, b) {
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const ca = count(a), cb = count(b);
  const onlyA = [], onlyB = [];
  for (const [k, n] of ca) for (let i = 0; i < n - (cb.get(k) || 0); i++) onlyA.push(k);
  for (const [k, n] of cb) for (let i = 0; i < n - (ca.get(k) || 0); i++) onlyB.push(k);
  if (onlyA.length || onlyB.length) {
    console.log(`  ${name}: ${onlyA.length} only in JS, ${onlyB.length} only in reference`);
    onlyA.slice(0, 5).forEach((k) => console.log(`    JS : ${k}`));
    onlyB.slice(0, 5).forEach((k) => console.log(`    REF: ${k}`));
    return false;
  }
  return true;
}

(async () => {
  const [dir, pyJson, mapJson] = process.argv.slice(2);
  const map = mapJson ? JSON.parse(fs.readFileSync(mapJson, "utf8")) : { names: {}, config: {} };
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  const statements = [];
  for (const f of files) statements.push({ id: f, pages: await pdfPages(path.join(dir, f)) });
  if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(statements, null, 1));
  const js = P.parseStatements(statements, map.config || {});
  const py = JSON.parse(fs.readFileSync(pyJson, "utf8")).accounts;

  console.log(`statements: ${js.months.length}, errors: ${JSON.stringify(js.errors)}, gaps: ${JSON.stringify(js.gaps)}`);
  let ok = true;
  console.log(`unmapped: ${JSON.stringify(js.unmapped)}  skipped: ${JSON.stringify(js.skipped)}  balancing: ${js.reconciled.length}`);
  const ours = Object.keys(js.accounts);
  const toRef = (n) => (map.names || {})[n] || n;
  const missing = Object.keys(py).filter((n) => !ours.some((o) => toRef(o) === n));
  if (missing.length) { console.log(`reference accounts with no match: ${missing}`); ok = false; }
  for (const name of ours) {
    const a = js.accounts[name], b = py[toRef(name)];
    if (!b) { console.log(`${name}: not in reference`); ok = false; continue; }
    console.log(`${name}: trades ${a.trades.length}/${b.trades.length} cash ${a.cash.length}/${b.cash.length} vals ${a.valuations.length}/${b.valuations.length}  (JS/reference)`);
    ok = diffMultiset("valuations", a.valuations.map((v) => v.join("|")), b.valuations.map((v) => v.join("|"))) && ok;
    ok = diffMultiset("trades", a.trades.map((t) => key(t, ["date", "ticker", "qty", "price", "currency"])),
      b.trades.map((t) => key(t, ["date", "ticker", "qty", "price", "currency"]))) && ok;
    ok = diffMultiset("cash", a.cash.map((c) => key(c, ["date", "amount", "currency", "name"])),
      b.cash.map((c) => key(c, ["date", "amount", "currency", "name"]))) && ok;
  }
  console.log(ok ? "IDENTICAL to the reference" : "DIFFERENCES found");
  process.exit(ok ? 0 : 1);
})();

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yong Cong Sin <yongcong.sin@gmail.com>
// Drive the Portfolios configurator: merge, rename, exclude, reload, reset.
//   CHROME=<path> node config-e2e.js <pdf dir> <out dir>
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const P = require("../src/parser.js");

(async () => {
  const [pdfDir, outDir] = process.argv.slice(2);
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.goto("file://" + path.resolve(__dirname, "../index.html"));
  const files = fs.readdirSync(pdfDir).filter((f) => /\.pdf$/i.test(f)).map((f) => path.join(pdfDir, f));
  const load = async () => {
    await page.setInputFiles("#picker", files);
    await page.waitForSelector("#cards .card", { timeout: 180000 });
    await page.waitForFunction(() => document.querySelector("#busy").hidden, null, { timeout: 180000 });
  };
  await load();
  const cards = () => page.$$eval("#cards .card h3", (h) => h.map((x) => x.textContent));
  const balanceOf = (name) => page.$$eval("#cards .card", (cs, n) => {
    const c = cs.find((x) => x.querySelector("h3").textContent === n);
    return c ? [...c.querySelectorAll("dd")].pop().textContent : null;
  }, name);
  const portfolios = await page.$$eval("#portfolios .portfolio", (rows) => rows.map((r) => [r.dataset.id, r.querySelector("strong").textContent]));
  console.log("detected:", portfolios.map(([, l]) => l).join(", "));
  const idOf = (label) => portfolios.find(([, l]) => l === label)[0];

  // Pick test subjects from whatever was detected: merge the two investment
  // portfolios with the most months (same currency if possible), rename a
  // cash-like one, exclude the shortest-lived remaining one.
  const auto = P.parseStatements(JSON.parse(fs.readFileSync(process.env.DUMP, "utf8")));
  const info = (label) => auto.accounts[label];
  const months = (label) => info(label).valuations.length;
  const inv = portfolios.map(([, l]) => l).filter((l) => info(l).kind === "investment").sort((a, b) => months(b) - months(a));
  const target = inv[0];
  const ccyOf = (l) => auto.portfolios.find((p) => p.label === l).currency;
  const source = inv.slice(1).find((l) => ccyOf(l) === ccyOf(target)) || inv[1];
  const renamed = portfolios.map(([, l]) => l).find((l) => info(l).kind === "cash" && l !== target && l !== source);
  const excluded = portfolios.map(([, l]) => l).filter((l) => ![target, source, renamed].includes(l)).sort((a, b) => months(a) - months(b))[0];
  console.log(`merge "${source}" into "${target}", rename "${renamed}" to "Renamed", exclude "${excluded}"`);

  await page.click(".config > summary");
  await page.selectOption(`.portfolio[data-id="${idOf(source)}"] select[data-field="mergeInto"]`, idOf(target));
  await page.fill(`.portfolio[data-id="${idOf(renamed)}"] input[data-field="name"]`, "Renamed");
  await page.press(`.portfolio[data-id="${idOf(renamed)}"] input[data-field="name"]`, "Enter");
  await page.uncheck(`.portfolio[data-id="${idOf(excluded)}"] input[data-field="include"]`);
  const after = await cards();
  console.log("cards after merge/rename/exclude:", after.join(", "));
  console.log("count text:", await page.textContent("#portfolios-count"));
  await page.screenshot({ path: path.join(outDir, "config.png"), fullPage: true });

  // Merged balances must equal the sum of the two portfolios (parser, same config).
  const stmts = JSON.parse(fs.readFileSync(process.env.DUMP, "utf8"));
  const cfg = await page.evaluate(() => JSON.parse(localStorage.getItem("stashaway-csv-portfolios")));
  const merged = P.parseStatements(stmts, cfg);
  const sum = {};
  for (const n of [target, source]) for (const [d, v] of auto.accounts[n].valuations) sum[d] = Math.round(((sum[d] || 0) + v) * 100) / 100;
  const okMerge = merged.accounts[target].valuations.every(([d, v]) => Math.abs(sum[d] - v) < 0.005)
    && Object.keys(sum).length === merged.accounts[target].valuations.length;
  const okTrades = merged.accounts[target].trades.length === auto.accounts[target].trades.length + auto.accounts[source].trades.length;
  console.log("merge sums valuations:", okMerge, " merge combines trades:", okTrades,
    " renamed:", !!merged.accounts["Renamed"], " excluded gone:", !merged.accounts[excluded]);

  await page.reload();
  await load();
  console.log("after reload:", (await cards()).join(", ") === after.join(", ") ? "settings kept" : "SETTINGS LOST");
  await page.click(".config > summary");
  await page.click("#portfolios-reset");
  console.log("after reset:", (await cards()).join(", "));
  console.log("errors:", problems.length ? problems : "none");
  await browser.close();
})();

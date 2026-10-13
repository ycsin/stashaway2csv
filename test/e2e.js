// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yong Cong Sin <yongcong.sin@gmail.com>
// Drive web/index.html in headless Chromium: load all PDFs through the file
// picker, download the zip for the full range and for one month, screenshot.
//   CHROME=<path> node e2e.js <pdf dir> <out dir>
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

(async () => {
  const [pdfDir, outDir] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.goto("file://" + path.resolve(__dirname, "../index.html"));
  await page.screenshot({ path: path.join(outDir, "empty.png") });

  const files = fs.readdirSync(pdfDir).filter((f) => /\.pdf$/i.test(f)).map((f) => path.join(pdfDir, f));
  const t0 = Date.now();
  await page.setInputFiles("#picker", files);
  await page.waitForSelector("#cards .card", { timeout: 180000 });
  await page.waitForFunction(() => document.querySelector("#busy").hidden, null, { timeout: 180000 });
  console.log(`parsed ${files.length} PDFs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("status:", (await page.textContent("#status")).trim());
  console.log("cards:", await page.$$eval("#cards .card h3", (h) => h.map((x) => x.textContent)));
  await page.screenshot({ path: path.join(outDir, "loaded.png"), fullPage: true });

  const grab = async (name) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#zip")]);
    const p = path.join(outDir, name);
    await dl.saveAs(p);
    console.log(`saved ${p} (${dl.suggestedFilename()})`);
  };
  console.log("default mode:", await page.$eval("#mode button.on", (b) => b.dataset.mode));
  await grab("all.zip");
  const [cdl] = await Promise.all([page.waitForEvent("download"), page.click("#combined")]);
  await cdl.saveAs(path.join(outDir, "combined-balance.csv"));
  console.log("combined (balance):", cdl.suggestedFilename());
  await page.click('#mode button[data-mode="tradelog"]');
  await grab("tradelog.zip");
  await page.screenshot({ path: path.join(outDir, "tradelog-mode.png") });
  await page.click('#mode button[data-mode="holdings"]');
  console.log("first investment portfolio, buttons with holdings:", await page.$$eval('#cards .card', (cs) => cs.filter((c) => c.querySelector(".tag.investment"))
    .map((c) => [...c.querySelectorAll("button.dl")].map((b) => b.textContent))[0]));
  await grab("holdings.zip");
  await page.screenshot({ path: path.join(outDir, "holdings-mode.png") });
  const [hdl] = await Promise.all([page.waitForEvent("download"), page.click("#combined")]);
  await hdl.saveAs(path.join(outDir, "combined-holdings.zip"));
  console.log("combined (holdings):", hdl.suggestedFilename());
  await page.reload();
  console.log("mode after reload:", await page.$eval("#mode button.on", (b) => b.dataset.mode));
  await page.setInputFiles("#picker", files);
  await page.waitForSelector("#cards .card", { timeout: 180000 });
  await page.waitForFunction(() => document.querySelector("#busy").hidden, null, { timeout: 180000 });
  await page.click('#mode button[data-mode="balance"]');
  const lastMonth = await page.$eval("#to option:last-child", (o) => o.value);
  await page.selectOption("#from", lastMonth);
  await page.selectOption("#to", lastMonth);
  console.log(`${lastMonth} cards:`, await page.$$eval("#cards .card h3", (h) => h.map((x) => x.textContent)));
  await grab("last-month.zip");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(outDir, "mobile.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.screenshot({ path: path.join(outDir, "dark.png") });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log("horizontal overflow:", overflow, " console errors:", problems.length ? problems : "none");
  await browser.close();
})();

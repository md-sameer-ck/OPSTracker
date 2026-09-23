// scripts/smoke.mjs — drive the real UI in a real browser.
//
//   npm run dev &                       # for the live target
//   node scripts/smoke.mjs local
//   node scripts/smoke.mjs artifact path/to/opstracker.html
//
// The unit tests in lib.test.js cover the maths; this covers the half they
// cannot — that every tab renders, the charts actually draw, and the controls
// do what they claim. Several bugs here were invisible to unit tests and
// obvious within seconds of loading the page: a 404'd chart CDN, a grid that
// scrolled sideways on a phone, a refresh button that silently did nothing.
//
// Needs a Chromium to drive: `npm i -D playwright-core` and a local Chrome.

import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";

const target = process.argv[2] || "local";
const artifactPath = process.argv[3];
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let url = "http://localhost:8888/";
if (target === "artifact") {
  if (!artifactPath) {
    console.error("usage: node scripts/smoke.mjs artifact <built-artifact.html>");
    process.exit(1);
  }
  // Wrap it the way the Artifact platform does, so the test sees what a viewer sees.
  const body = readFileSync(artifactPath, "utf8");
  const preview = artifactPath.replace(/\.html$/, "") + ".preview.html";
  writeFileSync(
    preview,
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0;font:14px system-ui;background:#fafaf9}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`
  );
  url = "file://" + preview;
}

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1650, height: 1080 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => m.type() === "error" && errors.push("CONSOLE: " + m.text()));

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  ok ? passed++ : failed++;
  console.log((ok ? "  ✓ " : "  ✗ FAIL ") + label + (detail ? "  — " + detail : ""));
};

if (target === "artifact") {
  // Stand in for the platform capabilities so the paths that use them are exercised.
  await page.addInitScript(() => {
    window.__prompts = [];
    window.claude = {
      use: async (name) => {
        if (name === "downloads") return { save: async ({ filename }) => ((window.__saved = filename), { status: "saved" }) };
        if (name === "sample")
          return Object.assign(
            async (prompt, opts) => {
              window.__prompts.push(prompt);
              opts?.onText?.({ text: "…" });
              return { text: "CLAUDE SUMMARY (" + prompt.length + " chars)" };
            },
            { limits: async () => ({ images: false }) }
          );
        if (name === "mcp") return { callTool: async () => ({ payload: { issues: { nodes: [] } } }) };
        return null;
      },
    };
  });
}

console.log(`\n══ ${target.toUpperCase()} ══`);
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => { try { localStorage.clear(); } catch {} });
await page.reload({ waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelectorAll(".loan-row").length > 0, { timeout: 90000 });
console.log("  " + (await page.textContent("#brand-tag")));

for (const [tab, selector] of [
  ["loans", ".loan-row"],
  ["tickets", "#ticket-body tr"],
  ["queues", ".queue-row"],
  ["people", "#people-body tr"],
  ["raised", "#raised-body tr"],
  ["report", ".report-body table"],
  ["insights", ".chart-panel"],
]) {
  await page.click("#tab-" + tab);
  await page.waitForTimeout(1100);
  const n = (await page.$$("#view-" + tab + " " + selector)).length;
  check(tab.padEnd(8), n > 0, n + " items");
}

const canvases = await page.$$eval("canvas", (ns) => ({ n: ns.length, drawn: ns.filter((c) => c.width > 0).length }));
check("all charts drawn", canvases.n > 0 && canvases.n === canvases.drawn, `${canvases.drawn}/${canvases.n}`);

await page.click("#home");
await page.waitForTimeout(600);

// Refresh must always say what it did and must never shrink the dataset.
// Both failed in the field: a stale cache let a delta replace the whole
// base, and a silent return left the button looking broken.
const before = await page.textContent("#brand-tag");
await page.click("#refresh");
await page.waitForFunction(() => !document.getElementById("warning")?.hidden, { timeout: 60000 }).catch(() => {});
check("refresh reports an outcome", !(await page.getAttribute("#warn-banner", "hidden")),
  (await page.textContent("#warn-banner")).slice(0, 80));
check("refresh keeps the whole dataset", (await page.textContent("#brand-tag")) === before, await page.textContent("#brand-tag"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelectorAll(".loan-row").length > 0, { timeout: 90000 });
check("dataset survives a reopen", (await page.textContent("#brand-tag")) === before, await page.textContent("#brand-tag"));

const kpis = await page.$$(".kpi-link");
await kpis[1].click();
await page.waitForTimeout(700);
check("a KPI opens the tickets behind it", (await page.inputValue("#filter-state")) === "withus", await page.textContent("#ticket-count"));
check(
  "User and Reporter columns",
  (await page.$$eval("#ticket-table thead th", (ns) => ns.map((n) => n.textContent))).join("|").includes("Reporter|User")
);
await page.click("#filters-clear");
await page.waitForTimeout(500);

await page.click("#tab-tickets");
await page.waitForTimeout(700);
await page.fill("#ticket-search", "OPS-847");
await page.waitForTimeout(800);
await page.click("#ticket-body tr");
await page.waitForSelector(".lifeline", { timeout: 25000 });
await page.waitForTimeout(500);
check("ticket panel is complete", (await page.$$eval(".section > h3", (ns) => ns.length)) >= 6,
  (await page.$$eval(".section > h3", (ns) => ns.map((n) => n.textContent))).join(" / "));
check("thread with comment permalinks", (await page.$$(".comment")).length > 0 && (await page.$$(".comment a.when")).length > 0);
await page.keyboard.press("Escape");

await page.click("#tab-report");
await page.waitForTimeout(1300);
check("year-on-year charts", (await page.$$("#report-charts canvas")).length === 3);
await page.click("#report-all-years");
await page.waitForTimeout(900);
check("all-years mode", /year-by-year/.test(await page.textContent(".report-body h2")));
await page.click("#report-all-years");
await page.waitForTimeout(700);

await page.click("#tab-insights");
await page.waitForTimeout(1200);
await page.click("#view-insights .chart-box");
await page.waitForTimeout(700);
check("a chart opens enlarged", (await page.getAttribute("#chart-modal", "hidden")) === null);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

await page.setViewportSize({ width: 400, height: 900 });
await page.waitForTimeout(800);
check("no sideways scroll at phone width", (await page.evaluate(() => document.documentElement.scrollWidth)) <= 401);

console.log(`  ${passed} passed, ${failed} failed`);
console.log("  ERRORS: " + (errors.length ? "\n    " + errors.join("\n    ") : "none"));
await browser.close();
process.exit(failed ? 1 : 0);

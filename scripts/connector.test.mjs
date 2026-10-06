// scripts/connector.test.mjs — the published page against a fake "Atlassian MCP".
//
//   node scripts/connector.test.mjs <built-artifact.html>
//
// The payloads below are real replies from that connector, trimmed. It reshapes
// what Jira returns — custom fields keyed by display name, status with no
// category, bodies as HTML — and the page has to put it back before the shared
// normaliser sees it. Nothing about that is checkable from the unit tests,
// which only ever see Jira's native shape.

import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";

const artifact = process.argv[2];
if (!artifact) {
  console.error("usage: node scripts/connector.test.mjs <built-artifact.html>");
  process.exit(1);
}
const preview = artifact.replace(/\.html$/, "") + ".conn.html";
writeFileSync(preview, `<!doctype html><html><head><meta charset="utf-8"></head><body>${readFileSync(artifact, "utf8")}</body></html>`);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));

await page.addInitScript(() => {
  window.__calls = [];
  const NEW_KEY = "OPS-9001";
  window.claude = {
    use: async (name) => {
      if (name !== "mcp") return null;
      return {
        callTool: async (server, tool, args) => {
          window.__calls.push({ server, tool, name: args?.name, cloudId: args?.cloudId });
          const op = args?.name;
          if (op === "searchJiraIssuesUsingJql") {
            return { payload: { data: { issues: [{ id: "99001", key: NEW_KEY, fields: { summary: "LAI-1799 redemption statement wrong" } }] } } };
          }
          if (op === "getJiraIssue") {
            return {
              payload: {
                data: {
                  id: "99001",
                  key: NEW_KEY,
                  fields: {
                    summary: "LAI-1799 redemption statement wrong",
                    // HTML, as this connector returns whenever a body holds media.
                    description: "<p>The redemption statement for LAI 1799 shows the wrong interest.</p><p>Please investigate.</p>",
                    status: { name: "In Progress" },
                    priority: { name: "High" },
                    issuetype: { name: "Submit a request or incident" },
                    assignee: { displayName: "FOLK2FOLK CK DESK", accountId: "712020:095ed9eb" },
                    reporter: { displayName: "Lynda Statton", accountId: "600fdcad" },
                    created: "2026-10-06T09:00:00.000+0100",
                    updated: "2026-10-06T10:00:00.000+0100",
                    customFields: {
                      "CK User": { id: "customfield_10067", value: { displayName: "Md Sameer", accountId: "712020:2e4e2671", emailAddress: "md.sameer@cloudkaptan.com" } },
                      "Request Type": { id: "customfield_10010", value: { requestType: { name: "Salesforce Issues & Service Requests" } } },
                      Type: { id: "customfield_10070", value: { value: "Issue" } },
                    },
                  },
                },
              },
            };
          }
          if (op === "listJiraIssueChangelogs") {
            return {
              payload: {
                data: {
                  values: [
                    { id: "1", created: "2026-10-06T09:30:00.000+0100", author: { displayName: "Md Sameer" }, items: [{ field: "status", fieldId: "status", fromString: "To Do", toString: "Acknowledged" }] },
                    { id: "2", created: "2026-10-06T09:45:00.000+0100", author: { displayName: "Md Sameer" }, items: [{ field: "status", fieldId: "status", fromString: "Acknowledged", toString: "In Progress" }] },
                  ],
                },
              },
            };
          }
          if (op === "listJiraIssueComments") {
            return {
              payload: {
                data: {
                  comments: [
                    { id: "50001", author: { displayName: "Md Sameer" }, body: "<p>Corrected the interest calculation on the contract.</p>", created: "2026-10-06T09:50:00.000+0100", jsdPublic: true },
                  ],
                },
              },
            };
          }
          return { payload: { data: {} } };
        },
      };
    },
  };
});

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log((ok ? "  ✓ " : "  ✗ FAIL ") + label + (detail ? "  — " + detail : ""));
  if (!ok) failed++;
};

await page.goto("file://" + preview, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelectorAll(".loan-row").length > 0, { timeout: 90000 });
const before = await page.textContent("#brand-tag");

await page.click("#refresh");
await page.waitForFunction(() => !document.getElementById("warn-banner")?.hidden, { timeout: 60000 });
console.log("  banner:", (await page.textContent("#warn-banner")).trim());

const calls = await page.evaluate(() => window.__calls);
check("the connector was actually called", calls.length > 0, calls.length + " calls");
check("routes through executeRead on 'Atlassian MCP'", calls.length > 0 && calls.every((c) => c.server === "Atlassian MCP" && c.tool === "executeRead"), calls.map((c) => c.name).join(" → "));
check("sends the cloudId, not the hostname", calls.every((c) => /^[0-9a-f-]{36}$/.test(c.cloudId || "")), calls[0]?.cloudId);
check("search first, then the ticket in full", calls[0]?.name === "searchJiraIssuesUsingJql" && calls.some((c) => c.name === "getJiraIssue"));
// A refresh may only ADD. Shrinking is the failure that started all this.
const count = (text) => Number((text.match(/(\d+) production issues/) || [])[1] || 0);
const after = await page.textContent("#brand-tag");
check("refresh only ever adds", count(after) === count(before) + 1, `${count(before)} → ${count(after)}`);

// The reshaping: find the new ticket and read what the page made of it.
const got = await page.evaluate(() => {
  const all = window.__opsDelta?.issues || {};
  return all["OPS-9001"] || null;
});
check("new ticket merged into the delta", !!got, got ? got.key : "absent");
check("status category restored from the snapshot", got?.statusCategory === "indeterminate", `${got?.status} / ${got?.statusCategory}`);
check("CK User read from the renamed custom field", got?.ckUser?.name === "Md Sameer", JSON.stringify(got?.ckUser || null));
check("request type read from the renamed custom field", got?.requestType === "Salesforce Issues & Service Requests", String(got?.requestType));
check("loan reference extracted from an HTML description", (got?.loans || []).includes("LAI-1799"), JSON.stringify(got?.loans || []));
check("HTML stripped out of the text", !/[<>]/.test(got?.preview || ""), (got?.preview || "").slice(0, 60));

// The drawer path: comments + changelog, which the old connector could not do.
await page.click("#tab-tickets");
await page.waitForTimeout(600);
await page.fill("#ticket-search", "OPS-9001");
await page.waitForTimeout(900);
const rows = await page.$$("#ticket-body tr");
check("new ticket is findable in the UI", rows.length > 0, rows.length + " rows");
if (rows.length) {
  await rows[0].click();
  await page.waitForSelector(".drawer .section", { timeout: 25000 });
  await page.waitForTimeout(1200);
  const drawer = await page.textContent(".drawer");
  check("thread rendered from the comments call", /Corrected the interest calculation/.test(drawer));
  check("no raw HTML in the drawer", !/<p>|<\/p>/.test(drawer));
  check("status history used (work time present)", /Where the time went/.test(drawer));
}

console.log(`  ${failed ? failed + " FAILED" : "all passed"}`);
console.log("  errors: " + (errors.length ? "\n    " + errors.join("\n    ") : "none"));
await browser.close();
process.exit(failed || errors.length ? 1 : 0);

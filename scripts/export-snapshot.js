// scripts/export-snapshot.js — freeze the whole dashboard into one JSON file.
//
//   node scripts/export-snapshot.js > snapshot.json
//
// An Artifact on claude.ai is a static page: no server, so no place to keep a
// Jira token, and the browser could not call Jira even with one. Everything the
// dashboard would otherwise fetch on demand therefore has to be fetched up
// front — the index, and every ticket's thread and digest — so that clicking a
// ticket reads from memory instead of the network.

import { readFileSync, existsSync } from "node:fs";
import { handler as indexHandler } from "../netlify/functions/ops-issues.js";
import { handler as issueHandler } from "../netlify/functions/ops-issue.js";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const log = (...args) => console.error(...args);
const scope = process.argv[2] || "production";

log(`building the ${scope} index…`);
const indexResponse = await indexHandler({
  httpMethod: "GET",
  queryStringParameters: { refresh: "1", ...(scope === "production" ? {} : { scope }) },
  headers: {},
});
const index = JSON.parse(indexResponse.body);
if (index.error) {
  log("failed:", index.error);
  process.exit(1);
}
log(`  ${index.total} tickets`);

// Jira is rate limited and this is ~600 requests, so they go out a few at a
// time rather than all at once. Failures are recorded rather than fatal: one
// unreadable ticket should not cost the whole export.
const CONCURRENCY = 6;
const details = {};
const failures = [];
const queue = index.issues.map((issue) => issue.key);
let done = 0;

async function worker() {
  while (queue.length) {
    const key = queue.shift();
    try {
      const response = await issueHandler({ httpMethod: "GET", queryStringParameters: { key }, headers: {} });
      const detail = JSON.parse(response.body);
      if (detail.error) failures.push([key, detail.error]);
      else details[key] = detail;
    } catch (error) {
      failures.push([key, error.message]);
    }
    done += 1;
    if (done % 50 === 0) log(`  ${done}/${index.total} tickets`);
  }
}

log("fetching every ticket's thread…");
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
log(`  ${Object.keys(details).length} fetched, ${failures.length} failed`);
if (failures.length) log("  failures:", failures.slice(0, 5));

process.stdout.write(
  JSON.stringify({
    index,
    details,
    exportedAt: new Date().toISOString(),
    ticketCount: index.total,
    detailCount: Object.keys(details).length,
  })
);

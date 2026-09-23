// scripts/build-artifact.js — fold the whole app into one self-contained page.
//
//   node scripts/build-artifact.js <snapshot.json> > artifact.html
//
// An Artifact is a single static file: no server, no module graph, no local
// assets. So the ES modules are concatenated in dependency order with their
// import/export keywords stripped, the stylesheet is inlined, Chart.js comes
// from the one CDN the sandbox allows, and the data the Netlify functions would
// have served is embedded as a constant.

import { readFileSync } from "node:fs";

const snapshotPath = process.argv[2];
if (!snapshotPath) {
  console.error("usage: node scripts/build-artifact.js <snapshot.json> > artifact.html");
  process.exit(1);
}

const read = (path) => readFileSync(path, "utf8");
const snapshot = JSON.parse(read(snapshotPath));

/**
 * Trim the snapshot before it is embedded.
 *
 * Two kinds of waste, both worth removing when the whole thing ships inside one
 * HTML file: the API returns the comment thread twice — once inside `digest`
 * and once at the top level — and every detail record repeats the fields the
 * index already carries. Together that is roughly 2 MB of the 5.3 MB.
 *
 * The page merges each detail over its index record at runtime, so the trimmed
 * form is indistinguishable from what the live API returns.
 */
function trim(data) {
  const indexFields = new Set(Object.keys(data.index.issues[0] || {}));
  indexFields.delete("key");
  // Fields whose SHAPE differs between the index and the detail must come from
  // the detail, or the merge hands the page the wrong form. The index stores
  // secondaryTopics as bare ids and refs as bare strings; the detail stores
  // both as objects, and the drawer reads `.label` off them.
  for (const keep of ["loans", "refs", "links", "mentions", "secondaryTopics", "sla"]) {
    indexFields.delete(keep);
  }

  let saved = 0;
  const details = {};
  for (const [key, detail] of Object.entries(data.details)) {
    const slim = {};
    for (const [field, value] of Object.entries(detail)) {
      if (indexFields.has(field)) continue;
      if (field === "digest") {
        // digest.thread is the same array as detail.thread; only one is read.
        const { thread, ...rest } = value || {};
        slim.digest = rest;
        continue;
      }
      slim[field] = value;
    }
    saved += JSON.stringify(detail).length - JSON.stringify(slim).length;
    details[key] = slim;
  }
  console.error(`  trimmed ${(saved / 1048576).toFixed(2)} MB of duplication from the details`);
  return { ...data, details };
}

const trimmed = trim(snapshot);

// Dependency order: each file may use the ones before it, none after.
const LIB_ORDER = ["refs.js", "text.js", "taxonomy.js", "digest.js", "stats.js", "jira.js"];

/** Strip the module syntax so the files can share one scope. */
function flatten(source) {
  return source
    // import { a, b } from "./x.js";  — including the multi-line form
    .replace(/^import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^export\s+(?=(const|let|var|function|class|async))/gm, "")
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, "");
}

const libs = LIB_ORDER.map((name) => `// ── lib/${name} ──\n${flatten(read(`site/lib/${name}`))}`).join("\n");
const app = flatten(read("site/app.js"));
const css = read("site/styles.css");

// The page markup, minus the parts the Artifact skeleton supplies or the CSP
// blocks: the document wrapper, the local stylesheet, the vendored Chart.js and
// the module script.
const html = read("site/index.html");
const body = html
  .slice(html.indexOf("<body>") + "<body>".length, html.lastIndexOf("</body>"))
  .replace(/<script[^>]*><\/script>/g, "")
  .trim();

process.stdout.write(`<title>OPS Tracker</title>
<meta name="description" content="Every OPS ticket grouped by the loan it touches, with the issue, the fix, and the errors that keep coming back.">

<!-- Chart.js from the one CDN the artifact sandbox allows, pinned.
     It must be the .umd. build: cdnjs also ships chart.min.js, which is an ES
     module and leaves window.Chart undefined. And cdnjs carries no 4.4.7 at
     all, so the version has to be one it actually serves. -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js"></script>

<style>
${css}
</style>

${body}

<script type="module">
// A frozen copy of what the Jira-backed API would return. Everything the live
// dashboard fetches — the index and every ticket's thread — is already here, so
// opening a ticket reads from memory rather than the network.
const SNAPSHOT = ${JSON.stringify(trimmed)};

${libs}

// ── standing in for the Netlify functions ─────────────────────────────
//
// The live app fetches four endpoints. Here there is no server, so each is
// answered from the embedded snapshot instead. The shapes match what the API
// returns, so the application code below is unmodified.

// A download the page starts itself never reaches an artifact viewer, so if the
// downloads capability is unavailable the app goes straight to showing the text.
window.__downloadsBlocked = true;

// ── refreshing a frozen page ──────────────────────────────────────────
//
// The snapshot cannot call Jira: there is no server and no token. But the
// viewer may have the Atlassian connector, and an artifact can call a viewer's
// own connectors with their credentials — nothing secret is in this page.
//
// So Refresh asks Jira for everything CHANGED since the snapshot was taken and
// merges it in. That is a few dozen tickets rather than nine hundred, so it is
// one request, and it is the case that matters: a ticket raised after the
// export is otherwise invisible here for good.
const JIRA_HOST = (SNAPSHOT.index.jiraBase || "").replace(/^https?:\\/\\//, "");
// Viewers resolve connectors by their DISPLAY name, which is not the tool-name
// segment: mcp__claude_ai_Atlassian_Rovo__* is shown to viewers as
// "Atlassian Rovo". Passing anything else silently matches no connector.
const CONNECTOR = "Atlassian Rovo";
const REFRESH_TOOL = "searchJiraIssuesUsingJql";
const DETAIL_TOOL = "getJiraIssue";

/** The connector, or null when this viewer has not connected it. */
async function jiraConnector() {
  try {
    return (await window.claude?.use?.("mcp")) || null;
  } catch {
    return null;
  }
}

/** Unwrap whatever shape the connector returns. */
function toolPayload(result) {
  const payload = result?.payload ?? result;
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

window.__refreshFromJira = async function refreshFromJira(sinceIso) {
  const mcp = await jiraConnector();
  if (!mcp || !JIRA_HOST) return null;

  const since = (sinceIso || SNAPSHOT.index.fetchedAt || "").slice(0, 10);
  const result = await mcp.callTool(CONNECTOR, REFRESH_TOOL, {
    cloudId: JIRA_HOST,
    jql: \`project = \${SNAPSHOT.index.project || "OPS"} AND updated >= "\${since}" ORDER BY updated DESC\`,
    fields: BASE_FIELDS,
    maxResults: 100,
  });

  const nodes = toolPayload(result)?.issues?.nodes || [];
  // Shaped by exactly the same code the server uses, so a refreshed ticket is
  // indistinguishable from an exported one — minus its status history, which
  // this endpoint cannot expand.
  return nodes.map((issue) => normaliseIssue(issue));
};

/** One ticket's thread, for a ticket raised after the snapshot was taken. */
window.__fetchTicketFromJira = async function fetchTicketFromJira(key) {
  const mcp = await jiraConnector();
  if (!mcp || !JIRA_HOST) return null;
  const result = await mcp.callTool(CONNECTOR, DETAIL_TOOL, {
    cloudId: JIRA_HOST,
    issueIdOrKey: key,
    fields: [...BASE_FIELDS, "comment"],
  });
  const issue = toolPayload(result)?.issues?.nodes?.[0];
  if (!issue) return null;

  const record = normaliseIssue(issue, { full: true });
  const comments = (issue.fields?.comment?.comments || []).map((c) => ({
    id: c.id,
    author: c.author?.displayName || "Unknown",
    authorId: c.author?.accountId || null,
    body: fieldToText(c.body),
    created: c.created,
  }));
  const digest = buildDigest({
    summary: record.summary,
    description: record.description,
    resolutionComments: record.resolutionComments,
    comments,
    assigneeId: record.assignee?.accountId || null,
    reporterId: record.reporter?.accountId || null,
  });
  return { ...record, url: \`\${SNAPSHOT.index.jiraBase}/browse/\${issue.key}\`, digest, thread: digest.thread };
};

const SNAPSHOT_INDEX_BY_KEY = new Map(SNAPSHOT.index.issues.map((issue) => [issue.key, issue]));

/** The scopes the live server computes, applied here to the one exported set. */
function scopedIndex(scope) {
  // state.snapshotIssues holds the exported set plus anything merged in by a
  // refresh; it falls back to the export on first load.
  const all = window.__state?.snapshotIssues || SNAPSHOT.index.issues;
  const isFeature = (i) => i.requestType === SNAPSHOT.index.featureRequestType;
  const isServiceRequest = (i) => i.opsType === "Service Request";

  const issues =
    scope === "features" ? all.filter(isFeature)
    : scope === "all" ? all
    : all.filter((i) => !isFeature(i) && !isServiceRequest(i));

  return {
    ...SNAPSHOT.index,
    scope,
    issues,
    total: issues.length,
    excludedFeatureRequests: scope === "production" ? all.filter(isFeature).length : 0,
    excludedServiceRequests: scope === "production" ? all.filter(isServiceRequest).length : 0,
    snapshot: true,
    allIssues: all,
    fetchedAt: SNAPSHOT.index.fetchedAt,
  };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
});

// Every fetch the app makes goes to the same API prefix, so one shim covers all.
window.fetch = async (input, init) => {
  const url = String(input);

  if (url.includes("/ops-issues")) {
    const scope = new URL(url, location.href).searchParams.get("scope") || "production";
    return jsonResponse(200, scopedIndex(scope));
  }

  if (url.includes("/ops-issue?")) {
    const key = new URL(url, location.href).searchParams.get("key");
    const detail = SNAPSHOT.details[key];
    if (!detail) {
      // Raised after the export: fetch it live if the viewer's connector allows.
      const live = await window.__fetchTicketFromJira(key).catch(() => null);
      if (live) return jsonResponse(200, live);
      return jsonResponse(404, { error: key + ' was raised after this snapshot was taken, and your Atlassian connector is not available to load it.' });
    }
    // Detail records were trimmed of everything the index already holds.
    return jsonResponse(200, { ...(SNAPSHOT_INDEX_BY_KEY.get(key) || {}), ...detail });
  }

  // Writing a summary back needs Jira credentials, which a static page cannot
  // hold. Say so rather than failing silently.
  if (url.includes("/ops-note")) {
    return jsonResponse(501, {
      error: "This is a read-only snapshot — summaries can only be saved from the live dashboard.",
    });
  }

  if (url.includes("/ops-advise")) return jsonResponse(200, { available: false });

  return jsonResponse(404, { error: "Not available in the snapshot." });
};

${app}
</script>
`);

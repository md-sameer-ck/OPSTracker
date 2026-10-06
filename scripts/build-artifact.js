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
const JIRA_CLOUD_ID = SNAPSHOT.index.cloudId || (SNAPSHOT.index.jiraBase || "").replace(/^https?:\\/\\//, "");
// Viewers resolve connectors by their DISPLAY name, which is not the tool-name
// segment: mcp__claude_ai_Atlassian_MCP__* is shown to viewers as
// "Atlassian MCP". Passing anything else silently matches no connector.
//
// Not "Atlassian Rovo": that connector answers 403 "the app is not installed on
// this instance" for this site, and enabling it needs an org admin. This one
// works with the same account and no admin involvement.
const CONNECTOR = "Atlassian MCP";

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


// This connector exposes almost nothing as a named tool; operations go through
// executeRead({name, cloudId, inputs}). It also reshapes the reply — custom
// fields come back keyed by their display name, and status loses its category.
// toNative() undoes both, so the shared normaliser (the same code the server
// runs) sees the payload shape it already understands.
async function jiraCall(mcp, name, inputs) {
  const result = await mcp.callTool(CONNECTOR, "executeRead", { name, cloudId: JIRA_CLOUD_ID, inputs });
  return toolPayload(result)?.data ?? null;
}

// Status category is never returned. The export covers every status this
// project uses, so it is read from there; a status invented since then falls
// back to the middle category rather than being mistaken for done, which is
// the one guess that would silently drop a ticket out of the open queues.
const STATUS_CATEGORY = new Map(SNAPSHOT.index.issues.map((issue) => [issue.status, issue.statusCategory]));

// Bodies arrive as HTML whenever they hold media or panels, whatever format is
// requested, and the page renders them as text.
function htmlToText(value) {
  if (typeof value !== "string" || !/<[a-z!\\/]/i.test(value)) return value;
  return value
    .replace(/<br\\s*\\/?>/gi, "\\n")
    .replace(/<\\/(p|div|li|h[1-6])>/gi, "\\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \\t]+/g, " ")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
}

function toNative(raw, histories) {
  const fields = { ...(raw?.fields || {}) };
  for (const entry of Object.values(fields.customFields || {})) {
    if (entry?.id) fields[entry.id] = entry.value ?? null;
  }
  delete fields.customFields;
  if (fields.status?.name) {
    fields.status = {
      ...fields.status,
      statusCategory: { key: STATUS_CATEGORY.get(fields.status.name) || "indeterminate" },
    };
  }
  if (typeof fields.description === "string") fields.description = htmlToText(fields.description);
  const native = { key: raw.key, id: raw.id, fields };
  if (histories) native.changelog = { histories };
  return native;
}

/** One ticket in full, in the shape the normaliser expects. */
async function fetchNative(mcp, key, { withHistory = false } = {}) {
  const [raw, changelog] = await Promise.all([
    jiraCall(mcp, "getJiraIssue", { issueIdOrKey: key, fields: BASE_FIELDS, view: "full" }),
    withHistory
      ? jiraCall(mcp, "listJiraIssueChangelogs", { issueIdOrKey: key, maxResults: 100 }).catch(() => null)
      : null,
  ]);
  return raw?.key ? toNative(raw, changelog?.values || null) : null;
}

// Search returns a thin projection whatever fields are asked for — no
// description, no updated, no resolution date — so it is used only to find
// WHICH tickets moved, and each is then read in full. A refresh is normally a
// handful; the cap stops a long-neglected page firing hundreds of calls on the
// viewer's account.
const REFRESH_LIMIT = 40;

window.__refreshFromJira = async function refreshFromJira(sinceIso) {
  const mcp = await jiraConnector();
  if (!mcp || !JIRA_CLOUD_ID) return null;

  const since = (sinceIso || SNAPSHOT.index.fetchedAt || "").slice(0, 10);
  const found = await jiraCall(mcp, "searchJiraIssuesUsingJql", {
    jql: \`project = \${SNAPSHOT.index.project || "OPS"} AND updated >= "\${since}" ORDER BY updated DESC\`,
    fields: ["summary"],
    maxResults: REFRESH_LIMIT,
  });

  const keys = (found?.issues || []).map((issue) => issue.key).filter(Boolean);
  if (!keys.length) return [];

  // A few at a time: enough to not take a minute, not so many that a viewer's
  // connector starts refusing. Status history is left to the drawer, where it
  // is actually read, rather than doubling every refresh.
  const issues = [];
  for (let i = 0; i < keys.length; i += 4) {
    const batch = await Promise.all(keys.slice(i, i + 4).map((key) => fetchNative(mcp, key).catch(() => null)));
    for (const native of batch) if (native) issues.push(normaliseIssue(native));
  }
  return issues;
};

/** One ticket's thread, for a ticket raised after the snapshot was taken. */
window.__fetchTicketFromJira = async function fetchTicketFromJira(key) {
  const mcp = await jiraConnector();
  if (!mcp || !JIRA_CLOUD_ID) return null;

  const [native, commentPage] = await Promise.all([
    fetchNative(mcp, key, { withHistory: true }),
    jiraCall(mcp, "listJiraIssueComments", { issueIdOrKey: key, maxResults: 100, orderBy: "created" }).catch(
      () => null
    ),
  ]);
  if (!native) return null;

  const record = normaliseIssue(native, { full: true });
  const comments = (commentPage?.comments || []).map((c) => ({
    id: c.id,
    author: c.author?.displayName || "Unknown",
    authorId: c.author?.accountId || null,
    body: htmlToText(fieldToText(c.body)),
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
  return { ...record, url: \`\${SNAPSHOT.index.jiraBase}/browse/\${key}\`, digest, thread: digest.thread };
};

const SNAPSHOT_INDEX_BY_KEY = new Map(SNAPSHOT.index.issues.map((issue) => [issue.key, issue]));

/** The scopes the live server computes, applied here to the one exported set. */
// ── the refresh delta ─────────────────────────────────────────────────
//
// Refreshed tickets are kept SEPARATELY from the embedded snapshot, in their
// own localStorage entry, and layered over it on every read.
//
// The earlier design merged into one mutable list and cached that. A cached
// payload written by an older build lacked the unfiltered set, so the merge
// ran against the production-scoped 604 instead of all 879 — and the result,
// 614 tickets with six feature requests, was then cached as if it were the
// whole project. A frozen base plus a delta cannot lose tickets that way: the
// snapshot is never written to, so the worst a bad delta can do is add noise.
const DELTA_KEY = "opstracker-delta-v3";

function readDelta() {
  try {
    const raw = JSON.parse(localStorage.getItem(DELTA_KEY) || "null");
    if (raw && typeof raw === "object" && raw.issues) return raw;
  } catch {
    /* storage blocked or corrupt — start clean */
  }
  return { issues: {}, at: null };
}

window.__opsDelta = readDelta();

window.__saveDelta = function saveDelta(issues, at) {
  for (const issue of issues) window.__opsDelta.issues[issue.key] = issue;
  window.__opsDelta.at = at;
  try {
    localStorage.setItem(DELTA_KEY, JSON.stringify(window.__opsDelta));
  } catch {
    /* over quota: the refresh still applies for this view */
  }
};

/** The snapshot with any refreshed tickets layered over it. */
function allKnownIssues() {
  const byKey = new Map(SNAPSHOT.index.issues.map((issue) => [issue.key, issue]));
  for (const issue of Object.values(window.__opsDelta.issues || {})) {
    const previous = byKey.get(issue.key);
    // A refreshed ticket keeps the status history it was exported with: the
    // connector's search cannot expand a changelog.
    byKey.set(issue.key, { ...issue, history: issue.history ?? previous?.history ?? null });
  }
  return [...byKey.values()];
}

function scopedIndex(scope) {
  const all = allKnownIssues();
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
    // Survives a reload, so the page can say it holds refreshed data rather
    // than reverting to "snapshot" and looking as though Refresh did nothing.
    refreshedAt: window.__opsDelta.at || null,
    deltaCount: Object.keys(window.__opsDelta.issues || {}).length,
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

// scripts/make-fixture.js — build a demo index from saved Jira search results.
//
//   node scripts/make-fixture.js <jira-search-response.json>... > demo-index.json
//
// Why this exists: the dashboard is worth looking at before anyone has a Jira
// token in hand, and the reduction logic is worth testing against real ticket
// text rather than invented text. Point DEMO_INDEX at the output and
// `npm run dev` serves it instead of calling Jira (see scripts/dev-server.js).
//
// The output holds real ticket text, so it is deliberately not committed —
// data/ is gitignored. Generate your own when you need one.

import { readFileSync } from "node:fs";
import { extractRefs } from "../site/lib/refs.js";
import { classify } from "../site/lib/taxonomy.js";
import { fieldToText, truncate } from "../site/lib/text.js";
import { buildDigest } from "../site/lib/digest.js";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node scripts/make-fixture.js <search-response.json>...");
  process.exit(1);
}

const byKey = new Map();
const details = {};

for (const file of files) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  // Accepts either a raw Jira /search response or the MCP-wrapped shape.
  const nodes = parsed.issues?.nodes || parsed.issues || [];
  for (const issue of nodes) {
    const fields = issue.fields || {};
    const summary = fields.summary || "";
    const description = fieldToText(fields.description);
    const components = (fields.components || []).map((c) => c.name).filter(Boolean);
    const refs = extractRefs(`${summary}\n${description}`);
    const { primary, secondary } = classify({ summary, description, components });

    // Several exports of the same ticket may cover different fields (a search
    // that asked for comments but not dates, say). Merging rather than
    // overwriting stops a sparse record from blanking a complete one.
    const existing = byKey.get(issue.key) || {};
    const merge = (record) => {
      const out = { ...existing };
      for (const [field, value] of Object.entries(record)) {
        const isEmpty = value == null || (Array.isArray(value) && !value.length) || value === "";
        if (!isEmpty || out[field] == null) out[field] = value;
      }
      return out;
    };

    // Where the export included the comment thread, build the full detail
    // record too — that is the only way the demo can show the issue-and-fix
    // digest, which is the part most worth looking at before you commit a token.
    if (fields.comment?.comments) {
      const comments = fields.comment.comments.map((c) => ({
        id: c.id,
        author: c.author?.displayName || "Unknown",
        authorId: c.author?.accountId || null,
        body: fieldToText(c.body),
        created: c.created,
        updated: c.updated !== c.created ? c.updated : null,
      }));
      const digest = buildDigest({
        summary,
        description,
        comments,
        assigneeId: fields.assignee?.accountId || null,
        reporterId: fields.reporter?.accountId || null,
      });
      const allRefs = extractRefs([summary, description, ...comments.map((c) => c.body)].join("\n"));
      // Fall back to what the index already knows about this ticket. Only one
      // export tends to carry the comment thread, and it is usually not the one
      // that asked for the dates — so without this every detail record in the
      // fixture would show a blank "Raised".
      const priorDetail = { ...(byKey.get(issue.key) || {}), ...(details[issue.key] || {}) };
      details[issue.key] = {
        ...priorDetail,
        key: issue.key,
        url: `https://example.atlassian.net/browse/${issue.key}`,
        summary,
        description,
        status: fields.status?.name || "Unknown",
        statusCategory: fields.status?.statusCategory?.key || "undefined",
        priority: fields.priority?.name || "None",
        type: fields.issuetype?.name || "",
        components,
        labels: fields.labels || [],
        assignee: fields.assignee?.displayName || null,
        reporter: fields.reporter?.displayName || null,
        // Dates fall back to a previous export of the same ticket: the search
        // that carried the comments may not have asked for them.
        created: fields.created || priorDetail.created || null,
        updated: fields.updated || priorDetail.updated || null,
        resolved: fields.resolutiondate || priorDetail.resolved || null,
        topic: primary.id,
        topicLabel: primary.label,
        secondaryTopics: secondary.map((t) => ({ id: t.id, label: t.label })),
        loans: allRefs.filter((r) => r.type === "LAI").map((r) => r.canonical),
        refs: allRefs.filter((r) => r.type !== "LAI").map((r) => ({ type: r.type, canonical: r.canonical })),
        digest,
        thread: digest.thread,
      };
    }

    byKey.set(issue.key, merge({
      key: issue.key,
      summary,
      preview: truncate(description, 300),
      status: fields.status?.name || "Unknown",
      statusCategory: fields.status?.statusCategory?.key || "undefined",
      priority: fields.priority?.name || "None",
      type: fields.issuetype?.name || "",
      components,
      labels: fields.labels || [],
      assignee: fields.assignee?.displayName || null,
      reporter: fields.reporter?.displayName || null,
      created: fields.created || null,
      updated: fields.updated || null,
      resolved: fields.resolutiondate || null,
      topic: primary.id,
      topicLabel: primary.label,
      secondaryTopics: secondary.map((t) => t.id),
      loans: refs.filter((r) => r.type === "LAI").map((r) => r.canonical),
      refs: refs.filter((r) => r.type !== "LAI").map((r) => r.canonical),
    }));
  }
}

const issues = [...byKey.values()].sort((a, b) => new Date(b.created) - new Date(a.created));

process.stdout.write(
  JSON.stringify(
    {
      project: "OPS",
      jiraBase: "https://example.atlassian.net",
      jql: "project = OPS ORDER BY created DESC",
      total: issues.length,
      truncated: false,
      demo: true,
      fetchedAt: new Date().toISOString(),
      coverage: "summary and description only; comment text is not indexed",
      issues,
      details,
    },
    null,
    0
  )
);

console.error(`${issues.length} issues (${Object.keys(details).length} with threads) -> fixture`);

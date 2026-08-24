// netlify/functions/ops-issues.js
//
// The index the whole dashboard is built from: every ticket in the project,
// reduced to the fields a list, a timeline and a chart actually need.
//
// There is no database behind this by design, so the shape of this endpoint is
// what makes that workable. Two things keep it quick:
//
//  1. Comments are NOT fetched here. Asking for them across the whole project
//     pulls several megabytes out of Jira and takes long enough to feel broken.
//     A ticket's thread is fetched by ops-issue.js when someone opens it.
//  2. The reduction happens here, not in the browser. Jira's own payload for
//     ~850 issues is a few MB of mostly-unused rendering metadata; what goes
//     over the wire to the browser is around a tenth of that.
//
// The cost of (1) is honest and worth stating: a loan mentioned *only* in a
// comment is not in this index. The UI's "search Jira for this loan" button
// exists for exactly that case, and asks Jira directly.

import { getCredentials, json, preflight, scopedJql, searchAll, PROJECT_KEY } from "./_jira.js";
import { extractRefs } from "../../site/lib/refs.js";
import { classify } from "../../site/lib/taxonomy.js";
import { fieldToText, truncate } from "../../site/lib/text.js";

const INDEX_FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "priority",
  "labels",
  "components",
  "assignee",
  "reporter",
  "created",
  "updated",
  "resolutiondate",
];

// A warm function container keeps this between invocations, which turns the
// common case (someone clicking around the dashboard) into a memory read. Five
// minutes is short enough that a ticket raised this morning shows up without
// anyone thinking about it, and the UI has an explicit refresh for when it must.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { key: null, at: 0, payload: null };

/** One Jira issue -> the compact record the UI works with. */
function toIndexRecord(issue) {
  const fields = issue.fields || {};
  const summary = fields.summary || "";
  const description = fieldToText(fields.description);
  const components = (fields.components || []).map((c) => c.name).filter(Boolean);

  // Both fields are searched for references, because reporters put the loan
  // number in whichever one they were looking at.
  const refs = extractRefs(`${summary}\n${description}`);
  const { primary, secondary } = classify({ summary, description, components });

  return {
    key: issue.key,
    summary,
    // Enough description to show a useful preview line, not enough to bloat the
    // index. The full text comes back with the thread when the ticket is opened.
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
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();

  const credentials = getCredentials();
  if (credentials.error) return json(500, { error: credentials.error });

  const params = event.queryStringParameters || {};
  const wantsRefresh = params.refresh === "1";

  let jql;
  try {
    // `filter` lets the UI push a search down to Jira (used by deep loan
    // search, which needs comment text this index does not hold).
    jql = `${scopedJql(params.filter)} ORDER BY created DESC`;
  } catch (error) {
    return json(error.statusCode || 400, { error: error.message });
  }

  if (!wantsRefresh && cache.payload && cache.key === jql && Date.now() - cache.at < CACHE_TTL_MS) {
    return json(200, { ...cache.payload, cached: true, cacheAgeMs: Date.now() - cache.at });
  }

  const issues = [];
  try {
    const { truncated, total } = await searchAll({
      jql,
      fields: INDEX_FIELDS,
      credentials,
      onPage: (page) => {
        for (const issue of page) issues.push(toIndexRecord(issue));
      },
    });

    const payload = {
      project: PROJECT_KEY,
      // So the browser can build "open this loan in Jira" links without the
      // Jira host being hard-coded into the front end.
      jiraBase: `https://${credentials.domain}`,
      jql,
      total,
      truncated,
      fetchedAt: new Date().toISOString(),
      // Stated so the UI can be straight with the user about what it does and
      // does not know, rather than implying the index is the whole truth.
      coverage: "summary and description only; comment text is not indexed",
      issues,
    };

    cache = { key: jql, at: Date.now(), payload };
    return json(200, { ...payload, cached: false });
  } catch (error) {
    // A stale answer beats a dead dashboard, so long as it says it's stale.
    if (cache.payload && cache.key === jql) {
      return json(200, { ...cache.payload, cached: true, stale: true, cacheAgeMs: Date.now() - cache.at, warning: error.message });
    }
    return json(error.statusCode || 502, { error: `Could not reach Jira: ${error.message}` });
  }
};

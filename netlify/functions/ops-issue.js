// netlify/functions/ops-issue.js
//
// One ticket, in full, with its comment thread — fetched when somebody opens it
// rather than up front for all 850. This is where the issue-and-fix digest is
// built, because the fix only exists inside the thread.

import { getCredentials, json, jiraFetch, preflight, PROJECT_KEY } from "./_jira.js";
import { extractRefs } from "../../site/lib/refs.js";
import { classify } from "../../site/lib/taxonomy.js";
import { fieldToText } from "../../site/lib/text.js";
import { buildDigest } from "../../site/lib/digest.js";

const ISSUE_FIELDS = [
  "summary", "description", "status", "issuetype", "priority", "labels",
  "components", "assignee", "reporter", "created", "updated", "resolutiondate", "comment",
];

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();

  const key = (event.queryStringParameters || {}).key || "";
  // Only ever a ticket in this project — the key is going straight into a URL
  // path, so it is matched against a strict shape rather than escaped.
  if (!new RegExp(`^${PROJECT_KEY}-\\d{1,7}$`, "i").test(key)) {
    return json(400, { error: `Expected a ${PROJECT_KEY} issue key, e.g. ${PROJECT_KEY}-884.` });
  }

  const credentials = getCredentials();
  if (credentials.error) return json(500, { error: credentials.error });

  try {
    const issue = await jiraFetch(
      `/rest/api/3/issue/${key.toUpperCase()}?fields=${ISSUE_FIELDS.join(",")}`,
      { credentials }
    );
    const fields = issue.fields || {};
    const summary = fields.summary || "";
    const description = fieldToText(fields.description);
    const components = (fields.components || []).map((c) => c.name).filter(Boolean);

    const comments = (fields.comment?.comments || []).map((c) => ({
      id: c.id,
      author: c.author?.displayName || "Unknown",
      authorId: c.author?.accountId || null,
      body: fieldToText(c.body),
      created: c.created,
      updated: c.updated !== c.created ? c.updated : null,
    }));

    const normalised = {
      summary,
      description,
      comments,
      assigneeId: fields.assignee?.accountId || null,
      reporterId: fields.reporter?.accountId || null,
    };

    const digest = buildDigest(normalised);
    const { primary, secondary } = classify({ summary, description, components });

    // Comments are in scope here, so this ticket's reference list can be more
    // complete than the index's — a loan mentioned only in the thread shows up.
    const refs = extractRefs([summary, description, ...comments.map((c) => c.body)].join("\n"));

    return json(200, {
      key: issue.key,
      url: `https://${credentials.domain}/browse/${issue.key}`,
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
      created: fields.created || null,
      updated: fields.updated || null,
      resolved: fields.resolutiondate || null,
      topic: primary.id,
      topicLabel: primary.label,
      secondaryTopics: secondary.map((t) => ({ id: t.id, label: t.label })),
      loans: refs.filter((r) => r.type === "LAI").map((r) => r.canonical),
      refs: refs.filter((r) => r.type !== "LAI").map((r) => ({ type: r.type, canonical: r.canonical })),
      digest,
      thread: digest.thread,
    });
  } catch (error) {
    if (error.statusCode === 404) return json(404, { error: `${key} does not exist, or the account cannot see it.` });
    return json(error.statusCode || 502, { error: `Could not load ${key}: ${error.message}` });
  }
};

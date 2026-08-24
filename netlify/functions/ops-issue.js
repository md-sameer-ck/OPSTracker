// netlify/functions/ops-issue.js
//
// One ticket, in full, with its comment thread — fetched when somebody opens it
// rather than up front for all 850. This is where the issue-and-fix digest is
// built, because the fix only exists inside the thread.

import { getCredentials, json, jiraFetch, preflight, PROJECT_KEY } from "./_jira.js";
import { BASE_FIELDS, normaliseIssue } from "./_fields.js";
import { extractIssueKeys, extractRefs } from "../../site/lib/refs.js";
import { fieldToText } from "../../site/lib/text.js";
import { buildDigest } from "../../site/lib/digest.js";

const ISSUE_FIELDS = [...BASE_FIELDS, "comment"];

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
    const record = normaliseIssue(issue, { full: true });

    const comments = (fields.comment?.comments || []).map((c) => ({
      id: c.id,
      author: c.author?.displayName || "Unknown",
      authorId: c.author?.accountId || null,
      body: fieldToText(c.body),
      created: c.created,
      updated: c.updated !== c.created ? c.updated : null,
    }));

    const digest = buildDigest({
      summary: record.summary,
      description: record.description,
      // Jira's own "Resolution Comments" field, when someone filled it in, is a
      // fix a person wrote deliberately — it outranks anything scraped out of
      // the thread. See buildDigest.
      resolutionComments: record.resolutionComments,
      comments,
      assigneeId: record.assignee?.accountId || null,
      reporterId: record.reporter?.accountId || null,
    });

    // Comments are in scope here, so this ticket's reference list can be more
    // complete than the index's — a loan mentioned only in the thread shows up.
    const refs = extractRefs(
      [record.summary, record.description, record.resolutionComments, ...comments.map((c) => c.body)].join("\n")
    );

    // Cross-references buried in the thread — "as a part of OPS - 806" — which
    // the index cannot see because it never loads comments.
    const threadMentions = extractIssueKeys(
      comments.map((c) => c.body).join("\n"),
      PROJECT_KEY,
      issue.key
    ).filter((key) => !record.mentions.includes(key));

    return json(200, {
      ...record,
      threadMentions,
      url: `https://${credentials.domain}/browse/${issue.key}`,
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

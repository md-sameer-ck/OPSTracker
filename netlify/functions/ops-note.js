// netlify/functions/ops-note.js
//
// Saving a hand-written issue or fix summary.
//
// The tracker has no database, which normally means an edit lives in one
// person's browser and helps nobody. So an edit is written back to Jira as a
// comment carrying a marker:
//
//   [OPSTracker] Fix summary: Two loans were created from one application…
//
// ops-issue.js recognises that marker and treats the note as authoritative over
// its own extracted guess. That makes Jira the single store for this app too —
// the note is visible on the ticket to people who never open the dashboard, it
// survives with the ticket, and there is nothing to back up.
//
// The trade-off worth knowing: editing means posting a newer note, so a ticket
// re-summarised three times carries three comments and the newest wins. That is
// deliberate — an audit trail of who said what, rather than a silent overwrite.

import { getCredentials, json, jiraFetch, preflight, PROJECT_KEY } from "./_jira.js";
import { FIX_NOTE_MARKER, ISSUE_NOTE_MARKER } from "../../site/lib/digest.js";

const MARKERS = { fix: FIX_NOTE_MARKER, issue: ISSUE_NOTE_MARKER };
const MAX_NOTE_LENGTH = 2000;

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Body must be JSON." });
  }

  const { key, kind = "fix", text } = body;

  if (!new RegExp(`^${PROJECT_KEY}-\\d{1,7}$`, "i").test(String(key || ""))) {
    return json(400, { error: `Expected a ${PROJECT_KEY} issue key.` });
  }
  const marker = MARKERS[kind];
  if (!marker) return json(400, { error: `kind must be one of: ${Object.keys(MARKERS).join(", ")}.` });

  const note = String(text || "").trim();
  if (!note) return json(400, { error: "The note is empty." });
  if (note.length > MAX_NOTE_LENGTH) {
    return json(400, { error: `Keep the note under ${MAX_NOTE_LENGTH} characters — it is a summary, not a transcript.` });
  }

  const credentials = getCredentials();
  if (credentials.error) return json(500, { error: credentials.error });

  try {
    // Plain-text ADF: a summary is prose, and rendering user input as anything
    // richer invites the marker itself being formatted into something the
    // reader side no longer matches.
    const posted = await jiraFetch(`/rest/api/3/issue/${String(key).toUpperCase()}/comment`, {
      method: "POST",
      credentials,
      body: {
        body: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: `${marker} ${note}` }] }],
        },
      },
    });

    return json(200, {
      ok: true,
      key: String(key).toUpperCase(),
      kind,
      commentId: posted?.id || null,
      author: posted?.author?.displayName || null,
      created: posted?.created || null,
      text: note,
    });
  } catch (error) {
    if (error.statusCode === 403 || error.statusCode === 401) {
      return json(error.statusCode, { error: "The Jira account cannot comment on this ticket. A read-only token cannot save notes." });
    }
    return json(error.statusCode || 502, { error: `Could not save the note: ${error.message}` });
  }
};

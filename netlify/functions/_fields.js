// netlify/functions/_fields.js
//
// The custom fields this Jira instance keeps the interesting things in, and the
// one function that turns a raw Jira issue into the record the app works with.
//
// Both endpoints normalise through here so the index and the ticket detail can
// never disagree about what a ticket's CK User or SLA is.
//
// Field ids were read off the live instance (`expand=names`); the labels in the
// comments are what they are called in the Jira UI.

import { extractIssueKeys, extractRefs } from "../../site/lib/refs.js";
import { classify } from "../../site/lib/taxonomy.js";
import { fieldToText, truncate } from "../../site/lib/text.js";

export const FIELD = {
  CK_USER: "customfield_10067",          // "CK User"  — user picker
  CK_TIME_SPENT: "customfield_10069",    // "CK Time Spent"
  F2F_TIME_SPENT: "customfield_10073",   // "F2F Time Spent"
  REQUEST_TYPE: "customfield_10010",     // "Request Type" (JSM)
  OPS_TYPE: "customfield_10070",         // "Type" — Issue | Service Request
  RESOLUTION_COMMENTS: "customfield_10140", // "Resolution Comments" — the fix, written by a person
  RESOLVED_DATE: "customfield_10071",    // "Resolved Date"
  REPORTER_NAME: "customfield_10072",    // "Reporter Name" (free text)
  FOCUS_AREAS: "customfield_10074",      // "Focus Areas"
  URGENCY: "customfield_10056",          // "Urgency"
  SEVERITY: "customfield_10059",         // "Severity"
  SLA_RESOLUTION: "customfield_10052",   // "Time to resolution"
  SLA_FIRST_RESPONSE: "customfield_10053", // "Time to first response"
  FIRST_RESPONSE_AT: "customfield_10024", // "[CHART] Date of First Response"
};

// The request type this desk uses for production work. Feature requests come in
// under a different one and are excluded by default — they are planned work, and
// mixing them into "how long does a production issue take" makes the number lie.
export const PRODUCTION_REQUEST_TYPE = "Salesforce Issues & Service Requests";
export const FEATURE_REQUEST_TYPE = "Salesforce Feature Request";

/** Fields every endpoint asks Jira for. */
export const BASE_FIELDS = [
  "summary", "description", "status", "issuetype", "priority", "labels",
  "components", "assignee", "reporter", "created", "updated", "resolutiondate",
  // Jira's own "is blocked by" / "relates to" links. Typed and deliberate, so
  // they rank above a key someone happened to type into a comment.
  "issuelinks",
  ...Object.values(FIELD),
];

const person = (value) =>
  value
    ? { name: value.displayName || null, email: value.emailAddress || null, accountId: value.accountId || null }
    : null;

/**
 * An SLA field down to the numbers worth charting.
 *
 * Jira reports SLA time in *working* hours against the desk's calendar, which is
 * the whole reason to prefer it over created→resolved: OPS-878 shows 18 minutes
 * of elapsed SLA against 14 calendar days, because it sat over a fortnight of
 * weekends and waiting. For "how long did this actually take someone", the SLA
 * number is the honest one; calendar age answers a different question and the UI
 * shows both.
 *
 * A ticket can hold both a completed cycle and an ongoing one (reopened work);
 * the completed one is what counts as delivered.
 */
function sla(raw, { full = false } = {}) {
  if (!raw) return null;
  const completed = raw.completedCycles?.[raw.completedCycles.length - 1];
  const cycle = completed || raw.ongoingCycle;
  if (!cycle) return null;
  // The index carries only what the lists and charts read. These four fields
  // times two SLAs times ~770 tickets is the difference between a ~600 KB
  // payload and a ~1.3 MB one, and the index is what gets cached in the
  // browser — so the rest is kept for the detail view only.
  const core = {
    elapsedMs: cycle.elapsedTime?.millis ?? null,
    goalMs: cycle.goalDuration?.millis ?? null,
    breached: Boolean(cycle.breached),
    ongoing: !completed,
  };
  if (!full) return core;
  return {
    ...core,
    remainingMs: cycle.remainingTime?.millis ?? null,
    paused: Boolean(cycle.paused),
    startedAt: cycle.startTime?.jira || null,
    stoppedAt: cycle.stopTime?.jira || null,
  };
}

const optionValue = (value) =>
  value == null ? null : typeof value === "object" ? value.value ?? value.name ?? null : String(value);

/**
 * Raw Jira issue -> the app's record.
 *
 * `withComments` controls how much text comes back: the index wants a short
 * preview per ticket (850 of them go over the wire at once), the detail endpoint
 * wants the whole description.
 */
export function normaliseIssue(issue, { full = false } = {}) {
  const fields = issue.fields || {};
  const summary = fields.summary || "";
  const description = fieldToText(fields.description);
  const components = (fields.components || []).map((c) => c.name).filter(Boolean);
  const resolutionComments = fieldToText(fields[FIELD.RESOLUTION_COMMENTS]);

  const refs = extractRefs(`${summary}\n${description}`);
  const { primary, secondary } = classify({ summary, description, components });

  // Two kinds of relationship between tickets, kept apart because they carry
  // different weight. A Jira link is a deliberate, typed statement; a key typed
  // into prose is a hint that still turns out to be how this team actually
  // records "same root cause as that one".
  const links = (fields.issuelinks || [])
    .map((link) => {
      const other = link.outwardIssue || link.inwardIssue;
      if (!other) return null;
      return {
        key: other.key,
        relation: link.outwardIssue ? link.type?.outward || "relates to" : link.type?.inward || "relates to",
        status: other.fields?.status?.name || null,
        summary: other.fields?.summary || null,
      };
    })
    .filter(Boolean);

  const projectKey = issue.key?.split("-")[0] || "OPS";
  const mentions = extractIssueKeys(`${summary}\n${description}`, projectKey, issue.key);

  return {
    key: issue.key,
    summary,
    ...(full ? { description } : { preview: truncate(description, 300) }),

    status: fields.status?.name || "Unknown",
    statusCategory: fields.status?.statusCategory?.key || "undefined",
    priority: fields.priority?.name || "None",
    issueType: fields.issuetype?.name || "",
    components,
    labels: fields.labels || [],

    assignee: person(fields.assignee),
    reporter: person(fields.reporter),
    // The one that actually matters for "who did this": the Jira assignee is
    // often the Folk2Folk-side owner, while CK User names the person on the
    // CloudKaptan side who picked the ticket up.
    ckUser: person(fields[FIELD.CK_USER]),

    requestType: fields[FIELD.REQUEST_TYPE]?.requestType?.name || null,
    opsType: optionValue(fields[FIELD.OPS_TYPE]),
    urgency: optionValue(fields[FIELD.URGENCY]),
    severity: optionValue(fields[FIELD.SEVERITY]),
    focusAreas: optionValue(fields[FIELD.FOCUS_AREAS]),
    ckTimeSpent: fields[FIELD.CK_TIME_SPENT] ?? null,
    f2fTimeSpent: fields[FIELD.F2F_TIME_SPENT] ?? null,

    created: fields.created || null,
    updated: fields.updated || null,
    resolved: fields.resolutiondate || fields[FIELD.RESOLVED_DATE] || null,
    firstResponseAt: fields[FIELD.FIRST_RESPONSE_AT] || null,

    sla: {
      resolution: sla(fields[FIELD.SLA_RESOLUTION], { full }),
      // Only the elapsed number is ever shown for first response, so the index
      // carries just that.
      firstResponse: full
        ? sla(fields[FIELD.SLA_FIRST_RESPONSE], { full })
        : (() => {
            const parsed = sla(fields[FIELD.SLA_FIRST_RESPONSE]);
            return parsed ? { elapsedMs: parsed.elapsedMs, breached: parsed.breached } : null;
          })(),
    },

    // Carried on the index too (as a boolean) so the ticket list can show which
    // tickets already have a written fix without loading every thread.
    ...(full ? { resolutionComments } : { hasResolutionComments: Boolean(resolutionComments) }),

    links,
    mentions,

    topic: primary.id,
    topicLabel: primary.label,
    secondaryTopics: full ? secondary.map((t) => ({ id: t.id, label: t.label })) : secondary.map((t) => t.id),
    loans: refs.filter((r) => r.type === "LAI").map((r) => r.canonical),
    refs: full
      ? refs.filter((r) => r.type !== "LAI").map((r) => ({ type: r.type, canonical: r.canonical }))
      : refs.filter((r) => r.type !== "LAI").map((r) => r.canonical),
  };
}

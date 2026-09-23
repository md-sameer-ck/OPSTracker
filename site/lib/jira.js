import { extractIssueKeys, extractRefs } from "./refs.js";
import { classify } from "./taxonomy.js";
import { fieldToText, truncate } from "./text.js";
import { isSharedDesk } from "./stats.js";

// site/lib/jira.js
//
// Turning a raw Jira issue into the record this app works with.
//
// This lives in site/lib, not in the functions, because three places need it
// and they must not drift: the Netlify functions, the snapshot exporter, and
// the published page itself, which refreshes straight from the viewer's own
// Atlassian connector and therefore has to shape the response exactly the way
// the server would have.

// What the status history tells us that the current fields cannot.
//
// The workflow this desk runs:
//
//   To Do          raised, nobody has picked it up
//   Acknowledged   triage — read, analysed, commented on
//   In Progress    the actual work
//   Pending        work remaining, parked for now
//   Waiting on Customer   our work is done, awaiting client sign-off
//   Q2             escalated to the product help desk; we could not fix it
//   Done / Declined / Moved to Backlog   closed
//
// A ticket bounces: In Progress → Pending → In Progress → Waiting on Customer.
// So "how long did this take" is the *sum of every visit* to a working status,
// not the gap between two dates — which is why Jira's SLA clock overstates it
// so badly (it keeps running through Pending, Waiting and Q2 alike).

// The shared CK login: when it holds a ticket, the individual is the CK User.
// The test itself lives in stats.js so there is one definition of it.
const ownerFrom = (assignee, ckUser) =>
  (isSharedDesk({ name: assignee }) ? ckUser : assignee) || null;

/** Statuses whose category is done, matched by name since the changelog has no category. */
const CLOSED_STATUSES = new Set(["done", "declined", "moved to backlog"]);
const FIELD_CK_USER = "customfield_10067";
const isClosedStatus = (name) => CLOSED_STATUSES.has(String(name || "").trim().toLowerCase());

/**
 * Time spent in each status, plus the things only a history can answer.
 *
 * Returns durations keyed by status name, summed across every visit, with the
 * final open-ended stretch running to `now` (or to the resolution date, so a
 * closed ticket does not keep accruing time in whatever status it ended in).
 */
export function deriveHistory(issue, { now = Date.now() } = {}) {
  const fields = issue.fields || {};
  const createdMs = fields.created ? new Date(fields.created).getTime() : null;

  // Jira returns histories newest first; a timeline has to run the other way.
  const histories = [...(issue.changelog?.histories || [])].sort(
    (a, b) => new Date(a.created) - new Date(b.created)
  );

  const statusMoves = [];
  const ownerMoves = [];
  let reportedPriority = null;
  for (const history of histories) {
    const at = new Date(history.created).getTime();
    for (const item of history.items || []) {
      if (item.field === "status") statusMoves.push({ at, from: item.fromString, to: item.toString });
      else if (item.field === "assignee") ownerMoves.push({ at, field: "assignee", from: item.fromString, to: item.toString });
      else if (item.fieldId === FIELD_CK_USER) ownerMoves.push({ at, field: "ckUser", from: item.fromString, to: item.toString });
      // The first priority change reveals what it was raised as; if it was
      // never changed, the current value is also the reported one.
      else if (item.field === "priority" && reportedPriority === null) reportedPriority = item.fromString;
    }
  }

  const statusMs = {};
  const add = (status, ms) => {
    if (!status || !(ms > 0)) return;
    statusMs[status] = (statusMs[status] || 0) + ms;
  };

  // The status it was raised in: whatever the first move came *from*. With no
  // moves at all it has sat in its current status since it was created.
  const openingStatus = statusMoves[0]?.from || fields.status?.name || null;

  // A closed ticket stops accruing; an open one accrues up to now.
  const endMs = fields.resolutiondate ? new Date(fields.resolutiondate).getTime() : now;

  let cursor = createdMs;
  let current = openingStatus;
  for (const move of statusMoves) {
    if (cursor != null) add(current, move.at - cursor);
    cursor = move.at;
    current = move.to;
  }
  if (cursor != null) add(current, Math.max(0, endMs - cursor));

  // Work time split by who actually held the ticket at the time.
  //
  // A ticket picked up after somebody else already worked it should credit each
  // person with their own stretch only — otherwise whoever happens to close it
  // inherits all the effort, and whoever did the first half gets none. Both the
  // assignee and the CK User can change, so the owner timeline is replayed
  // alongside the status timeline and the two are intersected.
  const workByOwner = {};
  if (statusMoves.length || ownerMoves.length) {
    // Rewind to the values held at creation: the earliest change's "from".
    const firstOf = (field) => ownerMoves.find((move) => move.field === field);
    let assignee = firstOf("assignee") ? firstOf("assignee").from : fields.assignee?.displayName || null;
    let ckUser = firstOf("ckUser") ? firstOf("ckUser").from : fields[FIELD_CK_USER]?.displayName || null;

    // One merged timeline of "what changed when", walked once.
    const events = [...statusMoves.map((m) => ({ ...m, kind: "status" })), ...ownerMoves.map((m) => ({ ...m, kind: "owner" }))]
      .sort((a, b) => a.at - b.at);

    let cursorAt = createdMs;
    let status = openingStatus;
    const credit = (until) => {
      if (status !== "In Progress" || cursorAt == null) return;
      const owner = ownerFrom(assignee, ckUser);
      const ms = until - cursorAt;
      if (owner && ms > 0) workByOwner[owner] = (workByOwner[owner] || 0) + ms;
    };

    for (const event of events) {
      credit(event.at);
      cursorAt = event.at;
      if (event.kind === "status") status = event.to;
      else if (event.field === "assignee") assignee = event.to;
      else ckUser = event.to;
    }
    credit(endMs);
  }

  // Every departure from a closed status is a reopen. This is the cheapest
  // quality signal in the whole dataset and is invisible in the current fields.
  const reopens = statusMoves.filter((move) => isClosedStatus(move.from) && !isClosedStatus(move.to)).length;

  // How long it sat before anyone moved it at all — "time to first touch".
  const firstMoveAt = statusMoves[0]?.at ?? null;
  const timeToFirstTouchMs = createdMs != null && firstMoveAt != null ? firstMoveAt - createdMs : null;

  return {
    statusMs,
    workByOwner,
    reopens,
    timeToFirstTouchMs,
    // Null when it was never changed — the caller falls back to the current value.
    reportedPriority,
    transitions: statusMoves.length,
    // Set when Jira truncated the history, so a number known to be partial is
    // never presented as exact.
    historyTruncated: (issue.changelog?.total ?? 0) > histories.length,
  };
}


// The custom fields this Jira instance keeps the interesting things in, and the
// one function that turns a raw Jira issue into the record the app works with.
//
// Both endpoints normalise through here so the index and the ticket detail can
// never disagree about what a ticket's CK User or SLA is.
//
// Field ids were read off the live instance (`expand=names`); the labels in the
// comments are what they are called in the Jira UI.


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

// The "Type" field sub-classifies a ticket as an Issue or a Service Request —
// something broke, versus somebody asked for something. Only faults are wanted,
// so Service Requests are excluded.
//
// Tickets where Type was never set are KEPT, deliberately. The field is filled
// in about as reliably as CK User: 168 of 769 are blank, and they are not just
// old ones — the newest ticket in the project is blank, and the blanks include
// plainly production faults ("Duplicate LAI for Snowball", "error uploading the
// bank interest file"). Treating blank as "not an issue" would silently drop
// those, which is worse than including the occasional unlabelled request.
export const SERVICE_REQUEST_TYPE = "Service Request";
export const ISSUE_TYPE = "Issue";

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

  // Only available when the caller asked Jira to expand changelog. Without it
  // the ticket still renders; the time-in-status figures are simply absent.
  const history = issue.changelog ? deriveHistory(issue) : null;

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

    history,
    reportedPriority: history?.reportedPriority || fields.priority?.name || null,

    topic: primary.id,
    topicLabel: primary.label,
    secondaryTopics: full ? secondary.map((t) => ({ id: t.id, label: t.label })) : secondary.map((t) => t.id),
    loans: refs.filter((r) => r.type === "LAI").map((r) => r.canonical),
    refs: full
      ? refs.filter((r) => r.type !== "LAI").map((r) => ({ type: r.type, canonical: r.canonical }))
      : refs.filter((r) => r.type !== "LAI").map((r) => r.canonical),
  };
}

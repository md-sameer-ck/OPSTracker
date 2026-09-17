// netlify/functions/_changelog.js
//
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

/** The shared CK login: when it holds a ticket, the individual is the CK User. */
const SHARED_DESK = /\bCK\s*(DESK|HELP\s*DESK)\b/i;
const ownerFrom = (assignee, ckUser) =>
  (SHARED_DESK.test(assignee || "") ? ckUser : assignee) || null;

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

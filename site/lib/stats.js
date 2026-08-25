// site/lib/stats.js
//
// The numbers behind the throughput view: who is completing how much, and how
// long it takes them.
//
// One decision runs through all of it. There are two ways to measure "how long
// did this ticket take", and they disagree wildly:
//
//   OPS-878   SLA elapsed: 18 minutes     calendar age: 14 days
//   OPS-882   SLA elapsed: 17 minutes     calendar age:  6 days
//   OPS-884   SLA elapsed: 24h 53m        calendar age:  3 days
//
// Calendar age counts weekends, overnight, and every hour a ticket sat waiting
// on somebody else. Jira's SLA clock counts only the desk's working hours. For
// "how much work was this" and "who is getting through more", the SLA number is
// the honest one — so it leads, and calendar age is reported beside it as the
// answer to the different question of "how long did the reporter wait".
//
// Medians, not means, throughout: one ticket left open over Christmas otherwise
// rewrites a person's whole record.

export const HOUR_MS = 3600000;
export const DAY_MS = 86400000;

export function median(numbers) {
  const values = numbers.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/** The p'th percentile, for showing the tail a median hides. */
export function percentile(numbers, p) {
  const values = numbers.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1));
  return values[index];
}

// ── what state a ticket is really in ──────────────────────────────────
//
// Jira's status categories only know "new / in progress / done", which lumps
// together two situations that mean opposite things for this team:
//
//   With us      To Do, Acknowledged, In Progress   — we still owe work
//   Waiting      Q2, Pending, Waiting on Customer   — our work is done; the
//                                                     ball is with Q2 support
//                                                     or with the client
//
// Treating "waiting" as open badly misreports the desk. On the live project 26
// of the 38 outstanding production issues are waiting on somebody else, and 24
// of those are breaching SLA purely because the clock keeps running while we
// wait. Counting that as our backlog, or our breach, is simply wrong.

const WAITING_STATUSES = new Set([
  "q2",
  "pending",
  "waiting on customer",
  "waiting for customer",
  "waiting on client",
  "waiting for client",
  "waiting for support",
  "on hold",
  "blocked",
]);

/**
 * Whether a status means "parked with somebody outside the team". Matched on a
 * known list first, then loosely, so a status added in Jira later ("Waiting on
 * Vendor") lands in the right bucket without a code change.
 */
export function isWaitingStatus(status) {
  const name = String(status || "").trim().toLowerCase();
  if (!name) return false;
  if (WAITING_STATUSES.has(name)) return true;
  return /^(waiting\b|pending\b|blocked\b|on hold\b)/.test(name) || /\bq2\b/.test(name);
}

/** "done" | "waiting" | "active" */
export function ticketState(issue) {
  if (issue?.statusCategory === "done") return "done";
  if (isWaitingStatus(issue?.status)) return "waiting";
  return "active";
}

/** Still owed work by us. This is what "open" should mean on a dashboard. */
export const isWithUs = (issue) => ticketState(issue) === "active";
/** Parked with Q2 or the client — our part is finished. */
export const isWaiting = (issue) => ticketState(issue) === "waiting";
/** Our work is finished, whether the ticket is closed or parked elsewhere. */
export const isDelivered = (issue) => ticketState(issue) !== "active";

export const isResolved = (issue) => issue?.statusCategory === "done";
// Kept for the places that genuinely mean "not closed in Jira".
export const isOpen = (issue) => issue?.statusCategory !== "done";

/**
 * Whether this ticket's SLA clock has stopped — the only case where its elapsed
 * time is a finished measurement rather than a number still going up. Every
 * median and breach rate is computed over these alone, so a ticket sitting in
 * Q2 for a year cannot drag a person's figures around.
 */
export const hasSettledSla = (issue) =>
  issue?.sla?.resolution?.elapsedMs != null && !issue.sla.resolution.ongoing;

/** Working time on the SLA clock, in ms. Null when Jira has no cycle for it. */
export const slaElapsedMs = (issue) => issue?.sla?.resolution?.elapsedMs ?? null;
export const slaBreached = (issue) => Boolean(issue?.sla?.resolution?.breached);
export const firstResponseMs = (issue) => issue?.sla?.firstResponse?.elapsedMs ?? null;

/** Wall-clock from raised to resolved (or to now, if still open), in ms. */
export function calendarMs(issue, now = Date.now()) {
  if (!issue?.created) return null;
  const from = new Date(issue.created).getTime();
  const to = issue.resolved ? new Date(issue.resolved).getTime() : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, to - from);
}

/**
 * "1h 54m", "24h 53m", "3d", "18m".
 *
 * `style: "hours"` never rolls over into days, which is how Jira prints SLA time
 * and how the desk's goals are written ("80h"). Printing 24h 53m of working time
 * as "1d" would invite reading it as a calendar day, which it is not — so SLA
 * durations use the hours style and calendar ages use the default.
 */
export function formatDuration(ms, { compact = false, style = "days" } = {}) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 60000) return "<1m";
  const minutes = Math.floor(ms / 60000) % 60;

  if (style === "hours") {
    const hours = Math.floor(ms / HOUR_MS);
    if (!hours) return `${minutes}m`;
    return compact || !minutes ? `${hours}h` : `${hours}h ${minutes}m`;
  }

  const hours = Math.floor(ms / HOUR_MS) % 24;
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return compact || !hours ? `${days}d` : `${days}d ${hours}h`;
  if (hours >= 1) return compact || !minutes ? `${hours}h` : `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** SLA/working time — the style used everywhere a Jira SLA number is shown. */
export const formatWorkTime = (ms, options = {}) => formatDuration(ms, { ...options, style: "hours" });

/** Working hours, as a number, for charting. */
export const toHours = (ms) => (ms == null ? null : Math.round((ms / HOUR_MS) * 10) / 10);

/**
 * Who a ticket belongs to, for throughput purposes.
 *
 * This is the point of the whole view. The Jira login is a single shared desk
 * account, so `assignee` does not say which of the team picked a ticket up —
 * the CK User field does. A ticket with no CK User set is genuinely unattributed
 * rather than nobody's, so it is grouped under a named bucket instead of being
 * dropped: hiding it would flatter every individual's numbers.
 */
export const UNASSIGNED = "— not set —";
export const ckUserName = (issue) => issue.ckUser?.name || UNASSIGNED;
export const assigneeName = (issue) => issue.assignee?.name || UNASSIGNED;

/**
 * Per-person throughput. `keyOf` picks the axis — CK User or assignee — so the
 * same table serves both without a second implementation.
 */
export function throughputBy(issues, keyOf, { now = Date.now() } = {}) {
  const groups = new Map();

  for (const issue of issues) {
    const key = keyOf(issue);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        total: 0,
        delivered: 0,
        closed: 0,
        waiting: 0,
        withUs: 0,
        breached: 0,
        breachingNow: 0,
        slaTimes: [],
        calendarTimes: [],
        firstResponses: [],
        topics: new Map(),
        loans: new Set(),
        lastActivity: null,
        email: null,
      };
      groups.set(key, group);
    }

    group.total += 1;
    group.email = group.email || issue.ckUser?.email || issue.assignee?.email || null;
    group.topics.set(issue.topic, (group.topics.get(issue.topic) || 0) + 1);
    for (const loan of issue.loans || []) group.loans.add(loan);

    const activity = issue.resolved || issue.updated || issue.created;
    if (activity && (!group.lastActivity || activity > group.lastActivity)) group.lastActivity = activity;

    const firstResponse = firstResponseMs(issue);
    if (firstResponse != null) group.firstResponses.push(firstResponse);

    const state = ticketState(issue);
    if (state === "done") group.closed += 1;
    else if (state === "waiting") group.waiting += 1;
    else group.withUs += 1;
    // Our work is finished on anything not still active — a ticket parked with
    // Q2 was delivered by this person just as much as a closed one.
    if (state !== "active") group.delivered += 1;

    // Timings and breaches come only from settled SLA clocks. A ticket sitting
    // in Q2 has a number that is still climbing; folding it in would make the
    // person who handled it look slower every day nobody touches it.
    if (hasSettledSla(issue)) {
      group.slaTimes.push(slaElapsedMs(issue));
      if (slaBreached(issue)) group.breached += 1;
    } else if (slaBreached(issue)) {
      // Breaching right now, on a clock still running. Reported separately
      // rather than folded into a rate, because it is not a closed measurement.
      group.breachingNow += 1;
    }

    if (state === "done") {
      const calendar = calendarMs(issue, now);
      if (calendar != null) group.calendarTimes.push(calendar);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      email: group.email,
      total: group.total,
      delivered: group.delivered,
      closed: group.closed,
      waiting: group.waiting,
      withUs: group.withUs,
      breached: group.breached,
      breachingNow: group.breachingNow,
      breachRate: group.slaTimes.length ? group.breached / group.slaTimes.length : null,
      medianSlaMs: median(group.slaTimes),
      p90SlaMs: percentile(group.slaTimes, 90),
      medianCalendarMs: median(group.calendarTimes),
      medianFirstResponseMs: median(group.firstResponses),
      distinctLoans: group.loans.size,
      topTopic: [...group.topics.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      lastActivity: group.lastActivity,
      // How many tickets the timing figures are actually based on.
      measuredOn: group.slaTimes.length,
    }))
    .sort((a, b) => b.delivered - a.delivered || b.total - a.total);
}

/** Headline numbers for a set of tickets. */
export function summarise(issues, { now = Date.now() } = {}) {
  const closed = issues.filter((i) => ticketState(i) === "done");
  const waiting = issues.filter((i) => ticketState(i) === "waiting");
  const withUs = issues.filter((i) => ticketState(i) === "active");

  // Every rate below is computed over settled SLA clocks only — see
  // hasSettledSla. Mixing in still-running clocks would make the numbers drift
  // upward on their own with nobody doing anything.
  const settled = issues.filter(hasSettledSla);
  const slaTimes = settled.map(slaElapsedMs);
  const breached = settled.filter(slaBreached).length;

  return {
    total: issues.length,
    closed: closed.length,
    waiting: waiting.length,
    withUs: withUs.length,
    delivered: closed.length + waiting.length,
    // Retained under the old name so nothing that still asks for "resolved"
    // silently changes meaning: it has always meant closed in Jira.
    resolved: closed.length,
    open: withUs.length,
    medianSlaMs: median(slaTimes),
    p90SlaMs: percentile(slaTimes, 90),
    medianCalendarMs: median(closed.map((i) => calendarMs(i, now)).filter((v) => v != null)),
    medianFirstResponseMs: median(issues.map(firstResponseMs).filter((v) => v != null)),
    breached,
    breachRate: settled.length ? breached / settled.length : null,
    breachingNow: issues.filter((i) => !hasSettledSla(i) && slaBreached(i)).length,
    measuredOn: settled.length,
    oldestWithUs: withUs.map((i) => i.created).filter(Boolean).sort()[0] || null,
    oldestOpen: withUs.map((i) => i.created).filter(Boolean).sort()[0] || null,
    withResolutionComments: issues.filter((i) => i.hasResolutionComments || i.resolutionComments).length,
  };
}

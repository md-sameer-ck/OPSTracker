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

export const isOpen = (issue) => issue.statusCategory !== "done";
export const isResolved = (issue) => !isOpen(issue);

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
        resolved: 0,
        open: 0,
        breached: 0,
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

    if (isResolved(issue)) {
      group.resolved += 1;
      if (slaBreached(issue)) group.breached += 1;
      // Only resolved tickets contribute to "how long it takes": an open
      // ticket's clock is still running, and folding it in would drag every
      // median toward however long the current backlog happens to be.
      const elapsed = slaElapsedMs(issue);
      if (elapsed != null) group.slaTimes.push(elapsed);
      const calendar = calendarMs(issue, now);
      if (calendar != null) group.calendarTimes.push(calendar);
    } else {
      group.open += 1;
    }
  }

  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      email: group.email,
      total: group.total,
      resolved: group.resolved,
      open: group.open,
      breached: group.breached,
      breachRate: group.resolved ? group.breached / group.resolved : null,
      medianSlaMs: median(group.slaTimes),
      p90SlaMs: percentile(group.slaTimes, 90),
      medianCalendarMs: median(group.calendarTimes),
      medianFirstResponseMs: median(group.firstResponses),
      distinctLoans: group.loans.size,
      topTopic: [...group.topics.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      lastActivity: group.lastActivity,
      // Kept so a row can be clicked through to the tickets behind it.
      measuredOn: group.slaTimes.length,
    }))
    .sort((a, b) => b.resolved - a.resolved || b.total - a.total);
}

/** Headline numbers for a set of tickets. */
export function summarise(issues, { now = Date.now() } = {}) {
  const resolved = issues.filter(isResolved);
  const open = issues.filter(isOpen);
  const slaTimes = resolved.map(slaElapsedMs).filter((v) => v != null);
  const breached = resolved.filter(slaBreached).length;

  return {
    total: issues.length,
    resolved: resolved.length,
    open: open.length,
    medianSlaMs: median(slaTimes),
    p90SlaMs: percentile(slaTimes, 90),
    medianCalendarMs: median(resolved.map((i) => calendarMs(i, now)).filter((v) => v != null)),
    medianFirstResponseMs: median(issues.map(firstResponseMs).filter((v) => v != null)),
    breached,
    breachRate: resolved.length ? breached / resolved.length : null,
    measuredOn: slaTimes.length,
    oldestOpen: open.map((i) => i.created).filter(Boolean).sort()[0] || null,
    withResolutionComments: issues.filter((i) => i.hasResolutionComments || i.resolutionComments).length,
  };
}

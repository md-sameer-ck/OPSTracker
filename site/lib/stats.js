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
// The desk's workflow, as the team runs it:
//
//   queued     To Do                 raised, nobody has picked it up
//   triage     Acknowledged          read and analysed, work not started
//   active     In Progress           the actual work
//   onhold     Pending               work remaining, parked for now
//   signoff    Waiting on Customer   our work is done, awaiting client sign-off
//   escalated  Q2                    escalated to the product help desk
//   closed     Done / Declined / Moved to Backlog
//
// Jira's own status categories collapse all of this into new/indeterminate/done,
// which is why the dashboard classifies by name instead.

export const WORK_STATUS = "In Progress";
export const TRIAGE_STATUS = "Acknowledged";

export function outcome(issue) {
  if (issue?.statusCategory === "done") return "closed";
  const name = String(issue?.status || "").trim().toLowerCase();
  if (/\bq2\b/.test(name)) return "escalated";
  if (/^waiting\b/.test(name)) return "signoff";
  if (/^(pending|on hold|blocked)\b/.test(name)) return "onhold";
  if (/^in progress\b/.test(name)) return "active";
  if (/^acknowledged\b/.test(name)) return "triage";
  return "queued";
}

export const OUTCOME_LABEL = {
  closed: "Closed",
  signoff: "Awaiting sign-off",
  escalated: "Escalated to Q2",
  onhold: "On hold",
  active: "In progress",
  triage: "Triage",
  queued: "Not picked up",
};

/**
 * Our work is finished: closed, or with the client for sign-off.
 *
 * Q2 is deliberately NOT delivered — escalating to the product help desk means
 * we could not fix it, and counting it as delivered would flatter the numbers
 * in exactly the case worth seeing. On hold is not delivered either: there is
 * work remaining on it.
 */
export const isDelivered = (issue) => ["closed", "signoff"].includes(outcome(issue));
export const isEscalated = (issue) => outcome(issue) === "escalated";
/** Sitting on our side of the fence, waiting on us. */
export const isWithUs = (issue) => ["queued", "triage", "active", "onhold"].includes(outcome(issue));
/** Parked with somebody else — the client, or Q2. */
export const isWaiting = (issue) => ["signoff", "escalated"].includes(outcome(issue));
export const isResolved = (issue) => issue?.statusCategory === "done";
export const isOpen = (issue) => issue?.statusCategory !== "done";
/** Currently being worked, for a work-in-progress count. */
export const isInProgress = (issue) => outcome(issue) === "active";

// Kept so older call sites keep meaning what they meant.
export const ticketState = (issue) => {
  const state = outcome(issue);
  if (state === "closed") return "done";
  return isWaiting(issue) ? "waiting" : "active";
};

// ── time actually spent ───────────────────────────────────────────────
//
// Summed across every visit to a status, because tickets bounce
// In Progress → Pending → In Progress before they finish.
//
// ponytail: these are elapsed hours in a status, not working hours — a ticket
// left In Progress over a weekend counts the weekend. Jira's SLA clock applies
// the desk's working calendar but to the wrong scope (it keeps running through
// Pending and Q2), so neither number is both right. Upgrade path if it matters:
// intersect the In Progress intervals with a Europe/London 9–5 Mon–Fri calendar.

const statusTime = (issue, status) => issue?.history?.statusMs?.[status] ?? null;

/** Time in In Progress — the closest thing to effort this data supports. */
export const workMs = (issue) => statusTime(issue, WORK_STATUS);
/** Time in Acknowledged — read and analysed, but not yet worked. */
export const triageMs = (issue) => statusTime(issue, TRIAGE_STATUS);

/** Time parked with somebody else, or on hold. Not our work. */
export function stoppedMs(issue) {
  const durations = issue?.history?.statusMs;
  if (!durations) return null;
  let total = 0;
  for (const [status, ms] of Object.entries(durations)) {
    if (/^(pending|waiting|q2|on hold|blocked)/i.test(status)) total += ms;
  }
  return total;
}

/** Time before anyone moved it at all. */
export const firstTouchMs = (issue) => issue?.history?.timeToFirstTouchMs ?? null;
export const reopenCount = (issue) => issue?.history?.reopens ?? 0;

/**
 * This person's own share of the work on a ticket.
 *
 * A ticket handed over mid-flight should credit each person with their own
 * stretch. Without this, whoever closes it inherits every hour spent on it and
 * whoever did the first half gets none.
 */
export const workByOwnerMs = (issue, owner) => issue?.history?.workByOwner?.[owner] ?? null;
export const workOwners = (issue) => Object.keys(issue?.history?.workByOwner || {});

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
export const ckUserName = (issue) => (isCkAccount(issue?.ckUser) ? issue?.ckUser?.name : null) || UNASSIGNED;
export const assigneeName = (issue) => issue.assignee?.name || UNASSIGNED;

/**
 * Per-person throughput. `keyOf` picks the axis — CK User or assignee — so the
 * same table serves both without a second implementation.
 */
function blankGroup(key) {
  return {
    key,
    total: 0,
    delivered: 0,
    closed: 0,
    waiting: 0,
    withUs: 0,
    breached: 0,
    breachingNow: 0,
    escalated: 0,
    contributed: 0,
    reopens: 0,
    wip: 0,
    workTimes: [],
    triageTimes: [],
    slaTimes: [],
    calendarTimes: [],
    firstResponses: [],
    topics: new Map(),
    loans: new Set(),
    lastActivity: null,
    email: null,
  };
}

export function throughputBy(issues, keyOf, { now = Date.now(), splitWork = false } = {}) {
  const groups = new Map();
  const ensure = (key) => {
    let group = groups.get(key);
    if (!group) {
      group = blankGroup(key);
      groups.set(key, group);
    }
    return group;
  };

  for (const issue of issues) {
    const key = keyOf(issue);
    const group = ensure(key);

    group.total += 1;
    group.email = group.email || issue.ckUser?.email || issue.assignee?.email || null;
    group.topics.set(issue.topic, (group.topics.get(issue.topic) || 0) + 1);
    for (const loan of issue.loans || []) group.loans.add(loan);

    const activity = issue.resolved || issue.updated || issue.created;
    if (activity && (!group.lastActivity || activity > group.lastActivity)) group.lastActivity = activity;

    const firstResponse = firstResponseMs(issue);
    if (firstResponse != null) group.firstResponses.push(firstResponse);

    const state = outcome(issue);
    if (state === "closed") group.closed += 1;
    else if (state === "signoff") group.waiting += 1;
    else if (state === "escalated") group.escalated += 1;
    else group.withUs += 1;
    if (isDelivered(issue)) group.delivered += 1;

    // Work time comes from the status history, and only from finished tickets:
    // a ticket still In Progress has a figure that is still climbing.
    if (isDelivered(issue)) {
      const triage = triageMs(issue);
      if (triage != null) group.triageTimes.push(triage);

      if (splitWork) {
        // Each person is credited with the stretches they personally held. A
        // handover therefore shows up as time for both, not all of it for
        // whoever happened to close the ticket.
        for (const [owner, ms] of Object.entries(issue.history?.workByOwner || {})) {
          if (!(ms > 0)) continue;
          const target = ensure(owner);
          target.workTimes.push(ms);
          if (owner !== key) target.contributed += 1;
        }
      } else {
        const work = workMs(issue);
        if (work != null) group.workTimes.push(work);
      }
    }
    group.reopens += reopenCount(issue);
    if (isInProgress(issue)) group.wip += 1;

    if (hasSettledSla(issue)) {
      group.slaTimes.push(slaElapsedMs(issue));
      if (slaBreached(issue)) group.breached += 1;
    } else if (slaBreached(issue)) {
      // Breaching right now, on a clock still running. Reported separately
      // rather than folded into a rate, because it is not a closed measurement.
      group.breachingNow += 1;
    }

    if (state === "closed") {
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
      escalated: group.escalated,
      contributed: group.contributed,
      totalWorkMs: group.workTimes.reduce((a, b) => a + b, 0),
      meanWorkMs: group.workTimes.length ? group.workTimes.reduce((a, b) => a + b, 0) / group.workTimes.length : null,
      withUs: group.withUs,
      wip: group.wip,
      reopens: group.reopens,
      medianWorkMs: median(group.workTimes),
      p90WorkMs: percentile(group.workTimes, 90),
      medianTriageMs: median(group.triageTimes),
      workMeasuredOn: group.workTimes.length,
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
  const closed = issues.filter((i) => outcome(i) === "closed");
  const signoff = issues.filter((i) => outcome(i) === "signoff");
  const escalated = issues.filter(isEscalated);
  const withUs = issues.filter(isWithUs);
  const delivered = issues.filter(isDelivered);

  const workTimes = delivered.map(workMs).filter((v) => v != null);
  const settled = issues.filter(hasSettledSla);
  const breached = settled.filter(slaBreached).length;

  return {
    total: issues.length,
    closed: closed.length,
    signoff: signoff.length,
    escalated: escalated.length,
    waiting: signoff.length + escalated.length,
    withUs: withUs.length,
    wip: issues.filter(isInProgress).length,
    delivered: delivered.length,
    resolved: closed.length,
    open: withUs.length,
    reopened: issues.filter((i) => reopenCount(i) > 0).length,
    medianWorkMs: median(workTimes),
    p90WorkMs: percentile(workTimes, 90),
    medianTriageMs: median(issues.map(triageMs).filter((v) => v != null)),
    medianFirstTouchMs: median(issues.map(firstTouchMs).filter((v) => v != null)),
    workMeasuredOn: workTimes.length,
    medianSlaMs: median(settled.map(slaElapsedMs)),
    p90SlaMs: percentile(settled.map(slaElapsedMs), 90),
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

// ── reporters, and who counts as a CK user ────────────────────────────

export const reporterName = (issue) => issue?.reporter?.name || UNASSIGNED;

// The CK User field occasionally holds a Folk2Folk person (Danny Learmont,
// daniellearmont@folk2folk.com). They are not on the CloudKaptan side, so they
// skew the throughput table — one ticket, a 1492h median, 100% breach. Matched
// on the email domain rather than a name list so nobody has to maintain it.
// A null email means an older CK account with no address on it, so those stay.
const isCkAccount = (person) => !person?.email || person.email.endsWith("@cloudkaptan.com");

/**
 * Tickets raised per year, with a like-for-like year-to-date cut.
 *
 * Comparing a full year against a part year is the easy way to report a made-up
 * drop, so each year carries both: `total` for the whole year and `ytd` counted
 * only up to the same month and day as `asOf`.
 */
export function yearOnYear(issues, { asOf = new Date(), reporters = null } = {}) {
  const wanted = reporters?.length ? new Set(reporters) : null;
  const cutoffMonth = asOf.getMonth();
  const cutoffDay = asOf.getDate();
  const years = new Map();
  const byReporter = new Map();

  for (const issue of issues) {
    if (!issue.created) continue;
    const name = reporterName(issue);
    if (wanted && !wanted.has(name)) continue;

    const raised = new Date(issue.created);
    const year = raised.getFullYear();
    const inYtd =
      raised.getMonth() < cutoffMonth ||
      (raised.getMonth() === cutoffMonth && raised.getDate() <= cutoffDay);

    if (!years.has(year)) {
      years.set(year, { year, total: 0, ytd: 0, done: 0, open: 0, months: Array(12).fill(0), priority: new Map() });
    }
    const bucket = years.get(year);
    bucket.total += 1;
    if (inYtd) bucket.ytd += 1;
    bucket.months[raised.getMonth()] += 1;
    if (isResolved(issue)) bucket.done += 1;
    else bucket.open += 1;
    bucket.priority.set(issue.priority, (bucket.priority.get(issue.priority) || 0) + 1);

    if (!byReporter.has(name)) byReporter.set(name, { name, years: new Map() });
    const person = byReporter.get(name);
    if (!person.years.has(year)) person.years.set(year, { total: 0, ytd: 0 });
    const slot = person.years.get(year);
    slot.total += 1;
    if (inYtd) slot.ytd += 1;
  }

  return {
    asOf,
    years: [...years.values()].sort((a, b) => a.year - b.year),
    reporters: [...byReporter.values()],
  };
}

// ── who actually worked a ticket ──────────────────────────────────────
//
// Two fields are needed, not one. Atlassian seats are expensive, so the CK team
// shares a single login — FOLK2FOLK CK DESK — and records the individual in the
// CK User field. Folk2Folk's own staff (Danny Learmont, Andy Marsh, Stephanie
// Skinner…) are assigned normally and have no CK User.
//
// Measured on the live project:
//   assignee = shared desk   313 tickets, 288 with a CK User  (92%)
//   assignee = named person  237 tickets,  10 with a CK User   (4%)
//
// So neither field alone answers "who worked this": grouping by assignee buries
// the whole CK team under one row, and grouping by CK User drops every
// Folk2Folk-handled ticket into "not set".

const SHARED_DESK = /\bCK\s*(DESK|HELP\s*DESK)\b/i;
export const isSharedDesk = (person) => SHARED_DESK.test(person?.name || "");

/** The person who did the work: the assignee, unless that is the shared desk. */
export function workedBy(issue) {
  if (isSharedDesk(issue?.assignee)) {
    const ck = ckUserName(issue);
    // On the shared account with nobody named, the individual is unrecoverable;
    // say that rather than crediting it to the desk as if it were a person.
    return ck === UNASSIGNED ? "CK desk (no CK user set)" : ck;
  }
  return issue?.assignee?.name || UNASSIGNED;
}

/** Permalink to one comment, so a screenshot in a thread is one click away. */
export const commentUrl = (jiraBase, issueKey, commentId) =>
  jiraBase && issueKey && commentId
    ? `${jiraBase}/browse/${issueKey}?focusedCommentId=${commentId}`
    : null;

// ── did the fix hold? ─────────────────────────────────────────────────

/**
 * How often a loan comes back after a ticket against it was closed.
 *
 * This is the question a fix is really judged on: a loan that returns a week
 * after being "fixed" was not fixed. A return with the *same topic* is the
 * strong signal — the same thing broke again, rather than the loan simply
 * having another unrelated problem.
 *
 * Counting rule: for each closed ticket, look for a later ticket raised on the
 * same loan. `withinDays` bounds it so a loan generating a new problem two
 * years on is not read as a failed fix.
 */
export function loanRecurrence(issues, { withinDays = 90 } = {}) {
  const windowMs = withinDays * DAY_MS;
  const byLoan = new Map();

  for (const issue of issues) {
    for (const loan of issue.loans || []) {
      if (!byLoan.has(loan)) byLoan.set(loan, []);
      byLoan.get(loan).push(issue);
    }
  }

  const loans = [];
  let closedWithFollowUp = 0;
  let closedSameTopic = 0;
  let closedTotal = 0;

  for (const [loan, tickets] of byLoan) {
    const ordered = [...tickets].sort((a, b) => new Date(a.created) - new Date(b.created));
    let returns = 0;
    let sameTopicReturns = 0;
    let closedHere = 0;

    for (const ticket of ordered) {
      if (!isResolved(ticket) || !ticket.resolved) continue;
      closedHere += 1;
      closedTotal += 1;
      const closedAt = new Date(ticket.resolved).getTime();

      const followUp = ordered.find((other) => {
        if (other === ticket || !other.created) return false;
        const raised = new Date(other.created).getTime();
        return raised > closedAt && raised - closedAt <= windowMs;
      });
      if (!followUp) continue;

      returns += 1;
      closedWithFollowUp += 1;
      if (followUp.topic === ticket.topic) {
        sameTopicReturns += 1;
        closedSameTopic += 1;
      }
    }

    if (closedHere) {
      loans.push({
        loan,
        tickets: ordered.length,
        closed: closedHere,
        returns,
        sameTopicReturns,
        returnRate: returns / closedHere,
        lastRaised: ordered[ordered.length - 1]?.created || null,
        topic: ordered[ordered.length - 1]?.topic || null,
      });
    }
  }

  return {
    withinDays,
    loans: loans.sort((a, b) => b.returns - a.returns || b.tickets - a.tickets),
    closedTotal,
    closedWithFollowUp,
    closedSameTopic,
    returnRate: closedTotal ? closedWithFollowUp / closedTotal : null,
    sameTopicRate: closedTotal ? closedSameTopic / closedTotal : null,
  };
}

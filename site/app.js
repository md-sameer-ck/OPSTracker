// site/app.js — the dashboard.
//
// Shape of the thing: one fetch of the whole project index on load, everything
// derived from that in memory, and a second fetch per ticket when someone opens
// one (that is the only place the comment thread — and therefore the fix — is
// available). No framework; the data is a flat array and the views are three
// pure render functions over it.

import { normaliseLoanQuery, refNumber } from "./lib/refs.js";
import { TOPICS, UNCATEGORISED, getTopic } from "./lib/taxonomy.js";
import { truncate } from "./lib/text.js";
import { FIX_NOTE_MARKER, ISSUE_NOTE_MARKER } from "./lib/digest.js";
import {
  assigneeName, calendarMs, ckUserName, firstResponseMs, formatDuration, formatWorkTime,
  hasSettledSla, isDelivered, isResolved, isWaiting, isWithUs, median, slaBreached,
  slaElapsedMs, summarise, throughputBy, ticketState, toHours, UNASSIGNED,
  reporterName, yearOnYear, workedBy, isSharedDesk, commentUrl,
  outcome, OUTCOME_LABEL, isEscalated, isInProgress, workMs, triageMs, stoppedMs,
  firstTouchMs, reopenCount, WORK_STATUS, TRIAGE_STATUS, workByOwnerMs, loanRecurrence,
} from "./lib/stats.js";

const API = "/api";

const state = {
  issues: [],
  loans: new Map(),      // canonical loan key -> { key, issues[], open, last, topics:Map }
  meta: null,
  selectedLoan: null,
  openTicket: null,
  ticketSort: { column: "created", direction: -1 },
  peopleSort: { column: "delivered", direction: -1 },
  raisedSort: { column: "total", direction: -1 },
  reportAllYears: false,
  onlyMine: false,
  scope: "production",
  charts: {},
  chartConfigs: {},
  zoomChart: null,
  detailCache: new Map(),
  adviceAvailable: false,
  adviceCache: new Map(),
};

// Bump when the index record shape changes, so a cached copy from an older
// build is discarded rather than rendered with missing fields.
const CACHE_VERSION = "v2";
const cacheKeyFor = (scope) => `opstracker-index-${CACHE_VERSION}-${scope}`;
const etagKeyFor = (scope) => `opstracker-etag-${CACHE_VERSION}-${scope}`;
// How long a browser copy is served without asking Jira at all. Building the
// index costs ~5 seconds and one full pass over the project, so re-fetching it
// on every reload is exactly the pattern that runs into rate limits.
const CACHE_TTL_MS = 10 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// ── glossary ──────────────────────────────────────────────────────────
//
// The dashboard is full of terms that are obvious once but not on sight: SLA,
// p90, "work time" versus "waiting". Rather than crowd the labels, each one
// carries its full form on hover, defined here once so the wording cannot drift
// between the KPI card, the table header and the ticket panel.

const GLOSSARY = {
  sla: "SLA — Service Level Agreement. The response and resolution targets agreed for this service desk. Jira runs a clock against each one.",
  workTime:
    "Work time — elapsed time the ticket spent In Progress, summed across every visit (tickets bounce In Progress → Pending → In Progress). It excludes To Do, Acknowledged, Pending, Waiting on Customer and Q2, so it measures the work window rather than how long the ticket existed. Note: elapsed hours, so a ticket left In Progress overnight counts the night.",
  triageTime:
    "Queue wait — elapsed time in Acknowledged: read and accepted, but work not yet started. On this project it is often far longer than the work itself.",
  escalated:
    "Escalated to Q2 — we could not fix it and it went to the product help desk. Counted as its own outcome rather than as delivered, because reaching Q2 means the work did not finish here.",
  reopens:
    "Reopened — the ticket left a closed status and went back into the workflow. Read from the status history; invisible in the ticket's current fields.",
  contributed:
    "Helped on — tickets this person worked on but somebody else finished. Their own hours still count toward their work time; the ticket counts as delivered by whoever closed it.",
  firstTouch:
    "First touch — how long the ticket sat after being raised before anyone moved it out of To Do.",
  calendarAge:
    "Calendar age — plain wall-clock time from raised to resolved, counting nights and weekends. This is how long the reporter waited, which is usually far longer than the work time.",
  firstResponse:
    "First response — SLA working hours from the ticket being raised to somebody on the desk replying to it for the first time.",
  p90: "p90 — the 90th percentile. Nine out of ten tickets were faster than this. It shows the slow tail that a median hides.",
  median: "Median — the middle value. Half the tickets were faster, half slower. Used instead of an average so one very old ticket cannot distort the figure.",
  breached:
    "SLA breached — the resolution clock passed its target before the ticket was settled. Counted only over tickets whose clock has stopped, so a figure cannot creep up on its own.",
  breachingNow:
    "Breaching now — past target on a clock that is still running. Shown separately from the breach rate because it is not a finished measurement yet.",
  ckUser:
    "CK User — the Jira field naming which of the CloudKaptan team picked the ticket up. The Jira login for this desk is a single shared account, so the assignee does not tell you this.",
  assignee: "Assignee — the Jira assignee, usually the Folk2Folk-side owner of the ticket rather than the person who did the work.",
  withUs:
    "With us — To Do, Acknowledged or In Progress. Work we still owe: these are the only tickets genuinely outstanding on our side.",
  waiting:
    "Waiting on others — Q2, Pending or Waiting on Customer. Our work is finished and the ticket is parked with Q2 support or with the client, so it is not our backlog.",
  delivered: "Delivered — our part is done: the ticket is either closed in Jira or parked waiting on Q2 or the client.",
  closed: "Closed — resolved in Jira (Done, Declined or Moved to Backlog).",
  measuredOn: "Measured on — how many tickets the timing figures are based on. Only tickets whose SLA clock has stopped can contribute.",
  topic:
    "Topic — derived from the ticket's own words, with its Jira component as a hint. Jira's components alone cannot answer this: 28% of tickets have none, and 'Data Correction' covers 44% of the rest.",
  loans: "Loans — distinct loan accounts named in these tickets, normalised so LAI-00001797, LAI 1797 and LAI1797 count once.",
};

/** Attach a term's full form to an element and mark it as hoverable. */
function tip(node, term) {
  const text = GLOSSARY[term];
  if (!text) return node;
  node.title = text;
  node.classList.add("has-tip");
  return node;
}

// ── formatting ────────────────────────────────────────────────────────

const DATE_FMT = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const DATETIME_FMT = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const asDate = (value) => (value ? new Date(value) : null);
const fmtDate = (value) => (value ? DATE_FMT.format(new Date(value)) : "—");
const fmtDateTime = (value) => (value ? DATETIME_FMT.format(new Date(value)) : "—");

/** "3 days ago" — the useful unit for an ops queue is days, not seconds. */
function relative(value) {
  if (!value) return "";
  const days = Math.floor((Date.now() - new Date(value)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = (days / 365).toFixed(days < 730 ? 1 : 0);
  return `${years} years ago`;
}

const isOpen = (issue) => issue.statusCategory !== "done";

/** Calendar days a ticket took, or has been open so far. */
function ageDays(issue) {
  const ms = calendarMs(issue);
  return ms == null ? null : Math.round(ms / 86400000);
}

const topicLabel = (id) => getTopic(id)?.label || UNCATEGORISED.label;

// ── loading ───────────────────────────────────────────────────────────

function showError(message) {
  const banner = $("error-banner");
  banner.textContent = message;
  banner.hidden = !message;
}

function showWarning(message) {
  const banner = $("warn-banner");
  banner.textContent = message;
  banner.hidden = !message;
}

/**
 * The browser-side copy of the index.
 *
 * Building the index server-side means paging the whole project out of Jira —
 * about five seconds and one full pass — so a reload that re-fetches it is both
 * slow for the user and the surest way to meet a rate limit. A copy is kept in
 * localStorage and served immediately; the network call after it is conditional
 * on the ETag, so an unchanged project answers 304 with no body and no Jira
 * traffic beyond the check.
 *
 * localStorage rather than sessionStorage because the point is to survive a
 * reload and a new tab. ~600 KB against a ~5 MB budget; a quota failure just
 * means no cache, never a broken page.
 */
function readCachedIndex() {
  try {
    const raw = localStorage.getItem(cacheKeyFor(state.scope));
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached?.payload?.issues) return null;
    return { ...cached, ageMs: Date.now() - (cached.storedAt || 0) };
  } catch {
    return null;
  }
}

function writeCachedIndex(payload, etag) {
  try {
    localStorage.setItem(cacheKeyFor(state.scope), JSON.stringify({ storedAt: Date.now(), payload }));
    if (etag) localStorage.setItem(etagKeyFor(state.scope), etag);
  } catch {
    // Over quota, or storage blocked. The app is fully functional without it.
  }
}

function clearCachedIndex() {
  try {
    localStorage.removeItem(cacheKeyFor(state.scope));
    localStorage.removeItem(etagKeyFor(state.scope));
  } catch {
    /* ignore */
  }
}

function applyIndex(data, { fromCache = false, ageMs = 0 } = {}) {
  state.issues = data.issues || [];
  state.meta = data;
  buildLoanIndex();

  const SCOPE_LABEL = { production: "production issues", features: "feature requests", all: "tickets" };
  const excludedNote =
    data.scope === "features"
      ? "Product Owner / Scrum Master backlog"
      : data.scope === "all"
      ? "every request type"
      : [
          data.excludedFeatureRequests ? `${data.excludedFeatureRequests} feature requests` : null,
          data.excludedServiceRequests ? `${data.excludedServiceRequests} service requests` : null,
        ].filter(Boolean).join(" and ") && `excludes ${[
          data.excludedFeatureRequests ? `${data.excludedFeatureRequests} feature requests` : null,
          data.excludedServiceRequests ? `${data.excludedServiceRequests} service requests` : null,
        ].filter(Boolean).join(" and ")}`;
  showWarning(
    data.stale
      ? `Jira could not be reached, so this is the last good copy from ${fmtDateTime(data.fetchedAt)}. ${data.warning || ""}`
      : data.truncated
      ? "The project is larger than this page fetches in one go — some older tickets are missing."
      : ""
  );

  // Always say what was filtered out, so this count can be reconciled against
  // Jira's own rather than quietly disagreeing with it.
  $("brand-tag").textContent =
    `${data.project} · ${state.issues.length} ${SCOPE_LABEL[data.scope] || "tickets"} · ${state.loans.size} loans` +
    (excludedNote ? ` · ${excludedNote}` : "");
  $("scope-select").value = data.scope || "production";

  const stamp = fromCache
    ? `from this browser, ${relative(data.fetchedAt)}`
    : data.cached
    ? `cached ${relative(data.fetchedAt)}`
    : `updated ${fmtDateTime(data.fetchedAt)}`;
  $("freshness").textContent = stamp;
  $("freshness").classList.toggle("stale", Boolean(data.stale));

  // "Only mine" is only meaningful once we know who "mine" is.
  const mineToggle = $("mine-toggle");
  if (data.me) {
    mineToggle.hidden = false;
    mineToggle.textContent = `Only mine`;
    mineToggle.title = `Show only tickets where CK User is ${data.me}`;
  } else {
    mineToggle.hidden = true;
    state.onlyMine = false;
  }

  renderAll();
}

async function loadIndex({ refresh = false } = {}) {
  const button = $("refresh");
  button.disabled = true;
  showError("");

  const SCOPE_NAME = { production: "production issues", features: "feature requests", all: "every ticket" };
  const setBusy = (busy, message) => {
    document.body.classList.toggle("is-loading", busy);
    const banner = $("loading-banner");
    banner.hidden = !busy;
    if (busy) banner.innerHTML = `<span class="spinner"></span> ${message}`;
  };

  // Paint from the local copy first so the page is usable immediately, then
  // reconcile with the server behind it.
  const cached = !refresh && readCachedIndex();
  if (cached) {
    applyIndex(cached.payload, { fromCache: true, ageMs: cached.ageMs });
    if (cached.ageMs < CACHE_TTL_MS) {
      // Fresh enough to trust outright: no request at all.
      $("freshness").textContent = `from this browser, ${relative(cached.payload.fetchedAt)}`;
      button.disabled = false;
      return;
    }
  } else {
    // A cold build pages the whole project out of Jira and takes ~15 seconds.
    // An unexplained spinner that long reads as broken.
    // Nothing to paint from, so say plainly what is happening and roughly how
    // long it takes. A blank or stale page with only a small spinner for fifteen
    // seconds is indistinguishable from one that has ignored the click.
    setBusy(true, `Fetching ${SCOPE_NAME[state.scope] || "tickets"} from Jira — about 15 seconds`);
    $("freshness").innerHTML = '<span class="spinner"></span> loading…';
  }

  try {
    const etag = (() => {
      try {
        return refresh ? null : localStorage.getItem(etagKeyFor(state.scope));
      } catch {
        return null;
      }
    })();

    const query = new URLSearchParams();
    if (refresh) query.set("refresh", "1");
    if (state.scope !== "production") query.set("scope", state.scope);
    const response = await fetch(`${API}/ops-issues${query.toString() ? `?${query}` : ""}`, {
      headers: etag ? { "If-None-Match": etag } : {},
    });

    if (response.status === 304 && cached) {
      // Nothing changed — keep what we have and just re-stamp it.
      writeCachedIndex(cached.payload, etag);
      $("freshness").textContent = `checked just now · unchanged since ${relative(cached.payload.fetchedAt)}`;
      return;
    }

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);

    writeCachedIndex(data, response.headers.get("ETag"));
    applyIndex(data);
  } catch (error) {
    if (cached) {
      // We already showed a usable page; say the refresh failed and leave it.
      showWarning(`Could not reach Jira just now, so this is the copy stored in this browser. ${error.message}`);
      return;
    }
    $("freshness").textContent = "";
    showError(
      /missing ATLASSIAN/i.test(error.message)
        ? `${error.message} On Netlify these go in Site settings → Environment variables; locally, in a .env file.`
        : `Could not load tickets: ${error.message}`
    );
    $("loan-list").innerHTML = "";
    $("loan-detail").innerHTML = '<div class="empty-state">Nothing loaded.</div>';
  } finally {
    button.disabled = false;
    setBusy(false);
  }
}

/**
 * Group the flat ticket list by loan. A ticket naming two loans belongs to both
 * — "Duplicate LAI for Snowball - LAI-1951 and LAI-1952" is genuinely part of
 * each loan's story, so it is counted under each rather than assigned to one.
 */
function buildLoanIndex() {
  const loans = new Map();
  for (const issue of visibleIssues()) {
    for (const loanKey of issue.loans || []) {
      let loan = loans.get(loanKey);
      if (!loan) {
        loan = { key: loanKey, issues: [], open: 0, waiting: 0, last: null, first: null, topics: new Map() };
        loans.set(loanKey, loan);
      }
      loan.issues.push(issue);
      if (isWithUs(issue)) loan.open += 1;
      if (isWaiting(issue)) loan.waiting += 1;
      const created = asDate(issue.created);
      if (created) {
        if (!loan.last || created > loan.last) loan.last = created;
        if (!loan.first || created < loan.first) loan.first = created;
      }
      loan.topics.set(issue.topic, (loan.topics.get(issue.topic) || 0) + 1);
    }
  }
  // Oldest first inside a loan: the timeline reads as the loan's history.
  for (const loan of loans.values()) {
    loan.issues.sort((a, b) => new Date(a.created) - new Date(b.created));
    loan.dominantTopic = [...loan.topics.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "other";
  }
  state.loans = loans;
  buildRelatedGraph();
}

/**
 * Which tickets point at which.
 *
 * A ticket's own record only knows what *it* mentions. The interesting half is
 * usually the other direction — "what later tickets came back to this one" — and
 * that can only be assembled by looking across the whole index, which is
 * exactly what this page already holds. So both directions get indexed once per
 * load and every drawer reads from the result.
 */
function buildRelatedGraph() {
  const inbound = new Map();
  const byKey = new Map();

  for (const issue of state.issues) {
    byKey.set(issue.key, issue);
    for (const mentioned of issue.mentions || []) {
      if (!inbound.has(mentioned)) inbound.set(mentioned, new Set());
      inbound.get(mentioned).add(issue.key);
    }
    // A Jira link is symmetric by nature, so record the reverse side too.
    for (const link of issue.links || []) {
      if (!inbound.has(link.key)) inbound.set(link.key, new Set());
      inbound.get(link.key).add(issue.key);
    }
  }

  state.inboundMentions = inbound;
  state.issuesByKey = byKey;
}

/**
 * Everything related to one ticket, de-duplicated across the three ways a
 * relationship can show up, strongest first.
 */
function relatedTo(detail) {
  const seen = new Map();
  const add = (key, relation, weight) => {
    if (!key || key === detail.key) return;
    const existing = seen.get(key);
    if (existing && existing.weight >= weight) return;
    seen.set(key, { key, relation, weight, issue: state.issuesByKey?.get(key) || null });
  };

  for (const link of detail.links || []) add(link.key, link.relation, 3);
  for (const key of detail.mentions || []) add(key, "mentioned in this ticket", 2);
  // Mentions found in the comment thread, which the index cannot see.
  for (const key of detail.threadMentions || []) add(key, "mentioned in a comment here", 2);
  for (const key of state.inboundMentions?.get(detail.key) || []) add(key, "mentions this ticket", 1);

  return [...seen.values()].sort(
    (a, b) => b.weight - a.weight || String(b.issue?.created || "").localeCompare(String(a.issue?.created || ""))
  );
}



// ── KPIs ──────────────────────────────────────────────────────────────

function renderKpis() {
  const issues = visibleIssues();
  const stats = summarise(issues);
  const repeatLoans = [...state.loans.values()].filter((l) => l.issues.length >= 3);
  const withLoan = issues.filter((i) => (i.loans || []).length).length;
  const mine = state.meta?.me
    ? issues.filter((i) => i.ckUser?.email && i.ckUser.email === state.meta.me)
    : [];

  const kpis = [
    { value: stats.total, label: "Production issues", filter: {}, note: `${withLoan} name a loan (${pct(withLoan, stats.total)})` },
    {
      // The number that actually means "our backlog". It used to include
      // tickets parked with Q2 or the client, which made it three times bigger
      // than the work we owe.
      value: stats.withUs,
      label: "Still with us",
      term: "withUs",
      filter: { state: "withus" },
      note: stats.oldestWithUs ? `oldest raised ${relative(stats.oldestWithUs)}` : "nothing outstanding",
    },
    {
      value: stats.escalated,
      label: "Escalated to Q2",
      term: "escalated",
      filter: { state: "escalated" },
      note: stats.signoff ? `plus ${stats.signoff} awaiting client sign-off` : "with the product help desk",
    },
    {
      value: formatDuration(stats.medianWorkMs),
      label: "Median work time",
      term: "workTime",
      note: `p90 ${formatDuration(stats.p90WorkMs)} · from ${stats.workMeasuredOn} tickets`,
      small: true,
    },
    {
      value: formatDuration(stats.medianTriageMs),
      label: "Median queue wait",
      term: "triageTime",
      note: `time in ${TRIAGE_STATUS} before work starts`,
      small: true,
    },
    {
      value: stats.reopened,
      label: "Reopened",
      term: "reopens",
      filter: { reopened: "1" },
      note: "closed, then moved back",
      small: true,
    },
    {
      value: stats.breachRate == null ? "—" : pct(stats.breached, stats.measuredOn),
      label: "SLA breached",
      term: "breached",
      note: `${stats.breached} of ${stats.measuredOn} settled` + (stats.breachingNow ? ` · ${stats.breachingNow} breaching now` : ""),
      small: true,
    },
    { value: state.loans.size, label: "Loans affected", note: `${repeatLoans.length} with 3 or more tickets` },
  ];

  if (state.meta?.me) {
    const myStats = summarise(mine);
    kpis.push({
      value: `${myStats.delivered}/${myStats.total}`,
      label: "Mine, delivered / total",
      term: "delivered",
      note: myStats.measuredOn ? `median ${formatWorkTime(myStats.medianSlaMs)}` : "nothing settled yet",
      small: true,
    });
  }

  const container = $("kpis");
  container.innerHTML = "";
  for (const kpi of kpis) {
    // A number you cannot open is a dead end; every headline that maps to a
    // set of tickets opens that set.
    const card = el(kpi.filter ? "button" : "div", `kpi${kpi.filter ? " kpi-link" : ""}`);
    if (kpi.filter) {
      card.type = "button";
      card.title = "Show these tickets";
      card.onclick = () => showTickets(kpi.filter);
    }
    const value = el("div", "value", String(kpi.value));
    if (kpi.small) value.style.fontSize = "17px";
    const label = el("div", "label", kpi.label);
    if (kpi.term) tip(label, kpi.term);
    card.append(value, label, el("div", "note", kpi.note));
    container.append(card);
  }
}

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

/**
 * The ticket set every view works from. "Only mine" is a global lens rather than
 * a filter on one table, so turning it on narrows the KPIs, the loan list, the
 * charts and the throughput table together — otherwise the headline numbers
 * would describe a different population than the list underneath them.
 */
function visibleIssues() {
  if (!state.onlyMine || !state.meta?.me) return state.issues;
  return state.issues.filter((issue) => issue.ckUser?.email === state.meta.me);
}

// ── loans view ────────────────────────────────────────────────────────

function sortedLoans() {
  const mode = $("loan-sort").value;
  const query = $("loan-search").value.trim();
  let loans = [...state.loans.values()];

  if (query) {
    // A number typed on its own means the loan number, so "1122" finds
    // LAI-1122 rather than every loan with 1122 anywhere in it.
    const exact = normaliseLoanQuery(query);
    loans = exact
      ? loans.filter((loan) => loan.key === exact)
      : loans.filter((loan) => loan.key.toLowerCase().includes(query.toLowerCase()));
  }

  const comparators = {
    count: (a, b) => b.issues.length - a.issues.length || (b.last || 0) - (a.last || 0),
    recent: (a, b) => (b.last || 0) - (a.last || 0),
    open: (a, b) => b.open - a.open || b.issues.length - a.issues.length,
    key: (a, b) => Number(refNumber(a.key)) - Number(refNumber(b.key)),
  };
  return loans.sort(comparators[mode] || comparators.count);
}

function renderLoanList() {
  const list = $("loan-list");
  const loans = sortedLoans();
  list.innerHTML = "";

  if (!loans.length) {
    const query = $("loan-search").value.trim();
    const empty = el("div", "empty-state");
    empty.append(el("div", "big", query ? `No indexed ticket names ${normaliseLoanQuery(query) || query}` : "No loans found"));
    if (query) {
      empty.append(document.createTextNode("The index only reads summaries and descriptions. "));
      const deep = el("button", "icon-button", "Search Jira comments too");
      deep.style.marginTop = "10px";
      deep.onclick = () => deepSearch(query);
      empty.append(document.createElement("br"), deep);
    }
    list.append(empty);
    return;
  }

  for (const loan of loans) {
    const row = el("button", "loan-row");
    row.type = "button";
    if (state.selectedLoan === loan.key) row.setAttribute("aria-current", "true");

    const top = el("div", "top");
    top.append(el("span", "key", loan.key));
    if (loan.open) top.append(tip(el("span", "chip status-new", `${loan.open} with us`), "withUs"));
    if (loan.waiting) top.append(tip(el("span", "chip status-waiting", `${loan.waiting} waiting`), "waiting"));
    top.append(el("span", "count", `${loan.issues.length} ticket${loan.issues.length === 1 ? "" : "s"}`));

    const meta = el("div", "meta");
    meta.append(el("span", null, topicLabel(loan.dominantTopic)));
    meta.append(el("span", null, `· last ${relative(loan.last)}`));

    row.append(top, meta);
    row.onclick = () => selectLoan(loan.key);
    list.append(row);
  }
}

function selectLoan(key) {
  state.selectedLoan = key;
  renderLoanList();
  renderLoanDetail();
  if (window.matchMedia("(max-width: 900px)").matches) {
    $("loan-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderLoanDetail() {
  const panel = $("loan-detail");
  const loan = state.loans.get(state.selectedLoan);
  panel.innerHTML = "";

  if (!loan) {
    const empty = el("div", "empty-state");
    empty.append(el("div", "big", "Pick a loan to see its history"));
    empty.append(document.createTextNode("Every OPS ticket that names the loan, oldest to newest."));
    panel.append(empty);
    return;
  }

  const resolvedDays = loan.issues.filter((i) => i.resolved).map(ageDays).filter((d) => d != null);

  const header = el("div", "loan-header");
  const title = el("div", "title");
  title.append(el("h2", null, loan.key));
  const stateChip = loan.open
    ? tip(el("span", "chip status-new", `${loan.open} still with us`), "withUs")
    : loan.waiting
    ? tip(el("span", "chip status-waiting", `${loan.waiting} waiting on others`), "waiting")
    : el("span", "chip status-done", "all resolved");
  title.append(stateChip);
  const jiraLink = el("a", "icon-button", "Open in Jira ↗");
  jiraLink.href = jiraSearchUrl(loan.key);
  jiraLink.target = "_blank";
  jiraLink.rel = "noopener";
  jiraLink.style.marginLeft = "auto";
  title.append(jiraLink);
  header.append(title);

  const stats = el("div", "stats");
  const addStat = (label, value) => {
    const stat = el("span");
    stat.append(el("b", null, String(value)), document.createTextNode(` ${label}`));
    stats.append(stat);
  };
  addStat("tickets", loan.issues.length);
  addStat("distinct topics", loan.topics.size);
  if (resolvedDays.length) addStat("median days to resolve", median(resolvedDays));
  stats.append(el("span", null, `first raised ${fmtDate(loan.first)} · last ${fmtDate(loan.last)}`));
  header.append(stats);

  // A topic hitting the same loan repeatedly is the useful warning here.
  const repeats = [...loan.topics.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  if (repeats.length) {
    const warn = el("div", "stats");
    warn.style.marginTop = "6px";
    warn.append(el("span", null, "Recurring:"));
    for (const [topic, count] of repeats) warn.append(el("span", "chip topic", `${topicLabel(topic)} ×${count}`));
    header.append(warn);
  }

  panel.append(header);

  const timeline = el("div", "timeline");
  for (const issue of loan.issues) timeline.append(timelineItem(issue));
  panel.append(timeline);
}

/** A status chip that says which of the three states the ticket is in. */
function statusChip(issue) {
  const state = ticketState(issue);
  const chip = el("span", `chip status-${state === "waiting" ? "waiting" : issue.statusCategory}`, issue.status);
  if (state === "waiting") tip(chip, "waiting");
  else if (state === "active") tip(chip, "withUs");
  return chip;
}

function timelineItem(issue) {
  const item = el("button", "tl-item");
  item.type = "button";
  // The dot colour distinguishes "still ours" from "parked elsewhere".
  item.dataset.cat = ticketState(issue) === "waiting" ? "waiting" : issue.statusCategory;

  const card = el("div", "tl-card");

  const date = el("div", "tl-date");
  date.append(el("span", null, `Raised ${fmtDate(issue.created)}`));
  date.append(el("span", null, `· ${relative(issue.created)}`));
  if (issue.resolved) {
    const days = ageDays(issue);
    date.append(el("span", null, `· closed after ${days} day${days === 1 ? "" : "s"}`));
  }
  card.append(date);

  const top = el("div", "tl-top");
  top.append(el("span", "tl-key", issue.key));
  top.append(el("span", "tl-summary", issue.summary));
  card.append(top);

  if (issue.preview) card.append(el("div", "tl-preview", truncate(issue.preview, 150)));

  const chips = el("div", "tl-chips");
  chips.append(statusChip(issue));
  if (issue.priority && issue.priority !== "None") chips.append(el("span", `chip prio-${issue.priority}`, issue.priority));
  chips.append(el("span", "chip topic", issue.topicLabel));
  if (issue.ckUser?.name) chips.append(ckUserNode(issue));
  const work = slaElapsedMs(issue);
  if (work != null) {
    const workChip = el("span", "chip", `⏱ ${formatWorkTime(work, { compact: true })}`);
    if (slaBreached(issue)) workChip.classList.add("breached");
    workChip.title = workTimeText(issue);
    chips.append(workChip);
  }
  for (const component of issue.components || []) chips.append(el("span", "chip", component));
  for (const ref of issue.refs || []) chips.append(el("span", "chip mono", ref));
  card.append(chips);

  item.append(card);
  item.onclick = () => openTicket(issue.key);
  return item;
}

function jiraSearchUrl(loanKey) {
  const number = refNumber(loanKey);
  // Both spellings, because the tickets use both and Jira's text search will
  // not match "LAI-1122" against "LAI 1122".
  const jql = `project = ${state.meta?.project || "OPS"} AND (text ~ "${loanKey}" OR text ~ "LAI ${number}") ORDER BY created DESC`;
  const base = state.meta?.jiraBase;
  // The site never hard-codes the Jira host — it comes back with the index, so
  // pointing this at a different Jira is an environment-variable change only.
  return base ? `${base}/issues?jql=${encodeURIComponent(jql)}` : "";
}

/**
 * Ask Jira directly for a loan, including comment text the index cannot see.
 * This is the escape hatch for "I know this loan has tickets but the list is
 * empty" — usually because the number only ever appeared in a comment.
 */
async function deepSearch(query) {
  const loanKey = normaliseLoanQuery(query) || query;
  const number = refNumber(loanKey);
  showWarning(`Searching Jira comments for ${loanKey}…`);
  try {
    const filter = `text ~ "${loanKey}" OR text ~ "LAI ${number}"`;
    const response = await fetch(`${API}/ops-issues?filter=${encodeURIComponent(filter)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "search failed");

    const found = data.issues || [];
    if (!found.length) {
      showWarning(`Jira has no ticket mentioning ${loanKey}, in text or comments.`);
      return;
    }
    // Fold the results into the index under this loan so the timeline can show
    // them, marking the ones the summary/description scan would have missed.
    for (const issue of found) {
      const existing = state.issues.find((i) => i.key === issue.key);
      const target = existing || issue;
      if (!existing) state.issues.push(issue);
      if (!(target.loans || []).includes(loanKey)) {
        target.loans = [...(target.loans || []), loanKey];
        target.viaComment = true;
      }
    }
    buildLoanIndex();
    renderAll();
    selectLoan(loanKey);
    const extra = found.filter((f) => f.viaComment).length;
    showWarning(`Found ${found.length} ticket${found.length === 1 ? "" : "s"} for ${loanKey} in Jira${extra ? `, including mentions only in comments` : ""}.`);
  } catch (error) {
    showWarning(`Deep search failed: ${error.message}`);
  }
}

// ── tickets view ──────────────────────────────────────────────────────

/**
 * Fill the filter picklists from the loaded tickets.
 *
 * This used to bail out early if the topic select already had options, which
 * looked safe and was not: init() switches to the tab named in the URL hash
 * *before* the index finishes loading, so a reload landing on #tickets ran this
 * against an empty array, appended nothing but the "Any …" placeholders, and
 * then the guard blocked it from ever filling in again. Every picklist stayed
 * permanently blank, and only for people who had visited that tab before —
 * because that is what puts the hash in the URL.
 *
 * So it is now driven by the data instead: nothing to do until tickets exist,
 * and once they do the options are rebuilt from scratch. Rebuilding is cheap and
 * idempotent, and it keeps the lists honest when the ticket set changes (a
 * refresh, or the "Only mine" lens).
 */
function populateFilters() {
  if (!state.issues.length) return;

  // Ordered by how many tickets each holds rather than alphabetically — a short
  // list of names is easier to scan by weight.
  const byVolume = (valueOf) => {
    const counts = new Map();
    for (const issue of state.issues) {
      const value = valueOf(issue);
      if (value == null) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };

  /** Replace a select's options, keeping the current choice if still offered. */
  const fill = (id, placeholder, entries) => {
    const select = $(id);
    if (!select) return;
    const previous = select.value;
    select.innerHTML = "";
    select.append(new Option(placeholder, ""));
    for (const [value, label] of entries) select.append(new Option(label, value));
    select.value = [...select.options].some((o) => o.value === previous) ? previous : "";
  };

  const present = new Set(state.issues.map((i) => i.topic));
  fill(
    "filter-topic",
    "Any topic",
    [...TOPICS, UNCATEGORISED].filter((t) => present.has(t.id)).map((t) => [t.id, t.label])
  );

  fill(
    "filter-priority",
    "Any priority",
    byVolume((i) => i.priority).map(([name, count]) => [name, `${name} (${count})`])
  );

  fill(
    "filter-ck",
    "Any CK user",
    byVolume(ckUserName).map(([name, count]) => [name, `${name} (${count})`])
  );

  fill(
    "filter-assignee",
    "Any assignee",
    byVolume(assigneeName).map(([name, count]) => [name, `${name} (${count})`])
  );
}

function filteredTickets() {
  const query = $("ticket-search").value.trim().toLowerCase();
  const stateFilter = $("filter-state").value;
  const topic = $("filter-topic").value;
  const priority = $("filter-priority").value;
  const loanFilter = $("filter-loan").value;
  const ckFilter = $("filter-ck").value;
  const assigneeFilter = $("filter-assignee").value;
  const reopenedFilter = $("filter-reopened").value;

  return visibleIssues().filter((issue) => {
    if (stateFilter === "withus" && !isWithUs(issue)) return false;
    if (stateFilter === "escalated" && !isEscalated(issue)) return false;
    if (reopenedFilter && !reopenCount(issue)) return false;
    if (stateFilter === "waiting" && !isWaiting(issue)) return false;
    if (stateFilter === "done" && !isResolved(issue)) return false;
    if (stateFilter === "delivered" && !isDelivered(issue)) return false;
    if (topic && issue.topic !== topic) return false;
    if (priority && issue.priority !== priority) return false;
    if (ckFilter && ckUserName(issue) !== ckFilter) return false;
    if (assigneeFilter && assigneeName(issue) !== assigneeFilter) return false;
    if (loanFilter === "with" && !(issue.loans || []).length) return false;
    if (loanFilter === "without" && (issue.loans || []).length) return false;
    if (query) {
      const haystack = `${issue.key} ${issue.summary} ${issue.preview} ${(issue.loans || []).join(" ")} ${(issue.components || []).join(" ")} ${ckUserName(issue)} ${assigneeName(issue)}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function renderTickets() {
  populateFilters();
  const rows = filteredTickets();
  const { column, direction } = state.ticketSort;

  const value = (issue) => {
    if (column === "days") return ageDays(issue) ?? -1;
    if (column === "work") return slaElapsedMs(issue) ?? -1;
    if (column === "ck") return ckUserName(issue).toLowerCase();
    if (column === "created") return new Date(issue.created || 0).getTime();
    if (column === "key") return Number(issue.key.split("-")[1]) || 0;
    return String(issue[column] ?? "").toLowerCase();
  };
  rows.sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    return (x < y ? -1 : x > y ? 1 : 0) * direction;
  });

  $("ticket-count").textContent = `${rows.length} of ${state.issues.length} tickets`;

  const body = $("ticket-body");
  body.innerHTML = "";
  // Long lists are chunked in so a wide filter does not lock the page up.
  const LIMIT = 300;
  for (const issue of rows.slice(0, LIMIT)) {
    const tr = document.createElement("tr");
    tr.onclick = () => openTicket(issue.key);

    tr.append(cell("key", issue.key));
    tr.append(cell("date", fmtDate(issue.created)));

    const summary = document.createElement("td");
    summary.append(el("div", null, issue.summary));
    if (issue.preview) {
      const preview = el("div", null, truncate(issue.preview, 110));
      preview.style.cssText = "font-size:12px;color:var(--text-muted);margin-top:2px";
      summary.append(preview);
    }
    tr.append(summary);

    const topicCell = document.createElement("td");
    topicCell.append(el("span", "chip topic", issue.topicLabel));
    tr.append(topicCell);

    tr.append(cell("loans", (issue.loans || []).join(", ") || "—"));

    const ckCell = document.createElement("td");
    const ck = issue.ckUser?.name;
    if (ck) {
      const chip = el("span", "chip person", ck);
      if (state.meta?.me && issue.ckUser?.email === state.meta.me) chip.classList.add("is-me");
      ckCell.append(chip);
    } else {
      ckCell.className = "date";
      ckCell.textContent = "—";
    }
    tr.append(ckCell);

    const statusCell = document.createElement("td");
    statusCell.append(statusChip(issue));
    tr.append(statusCell);

    const priorityCell = document.createElement("td");
    priorityCell.append(el("span", `chip prio-${issue.priority}`, issue.priority));
    tr.append(priorityCell);

    // Work time is the SLA clock; waiting is calendar. Both, because they answer
    // different questions and differ by an order of magnitude on this project.
    const workCell = cell("date", formatWorkTime(slaElapsedMs(issue)));
    if (slaBreached(issue)) {
      workCell.textContent += " ⚠";
      workCell.title = "SLA breached";
      workCell.style.color = "var(--urgent)";
    }
    tr.append(workCell);

    const days = ageDays(issue);
    tr.append(cell("date", days == null ? "—" : isResolved(issue) ? `${days}d` : `${days}d so far`));

    body.append(tr);
  }

  if (rows.length > LIMIT) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 10;
    td.style.cssText = "text-align:center;color:var(--text-muted);font-size:12.5px";
    td.textContent = `Showing the first ${LIMIT} of ${rows.length}. Narrow the filters to see the rest.`;
    tr.append(td);
    body.append(tr);
  }

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 10;
    td.className = "empty-state";
    td.textContent = "No ticket matches these filters.";
    tr.append(td);
    body.append(tr);
  }
}

function cell(className, text) {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

// ── who's completing what ─────────────────────────────────────────────

/** The window selector, as a ticket predicate. */
function peopleWindowFilter() {
  const days = Number($("people-window").value) || 0;
  if (!days) return () => true;
  const cutoff = Date.now() - days * 86400000;
  // Windowed on when the work finished, not when it was raised: the question is
  // "what did this person get through recently", and an old ticket closed last
  // week is part of last week's throughput.
  return (issue) => {
    const stamp = issue.resolved || issue.updated || issue.created;
    return stamp ? new Date(stamp).getTime() >= cutoff : false;
  };
}

const TICKET_FILTER_IDS = ["filter-state", "filter-topic", "filter-priority", "filter-loan", "filter-ck", "filter-assignee", "filter-reopened"];
const AXIS_LABEL = { worked: "person", ck: "CK user", assignee: "assignee", reporter: "reporter" };
const peopleKeyOf = (axis) =>
  axis === "assignee" ? assigneeName : axis === "reporter" ? reporterName : axis === "ck" ? ckUserName : workedBy;

function peopleRows() {
  const axis = $("people-axis").value;
  const keyOf = peopleKeyOf(axis);
  const scoped = visibleIssues().filter(peopleWindowFilter());
    // Split the work time per owner on the axes where the owner is a person who
  // actually holds tickets. Reporters do not do the work, so splitting there
  // would be meaningless.
  const rows = throughputBy(scoped, keyOf, { splitWork: axis === "worked" || axis === "ck" });

  const { column, direction } = state.peopleSort;
  return rows.sort((a, b) => {
    const [x, y] = [a[column], b[column]];
    // Nulls last regardless of direction — a person with no measurable time
    // should not top a "fastest" sort by virtue of having no data.
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * direction;
  });
}

function renderPeople() {
  const axis = $("people-axis").value;
  const rows = peopleRows();
  const body = $("people-body");
  body.innerHTML = "";

  const scoped = visibleIssues().filter(peopleWindowFilter());
  const unattributed = scoped.filter((i) => peopleKeyOf(axis)(i) === UNASSIGNED).length;
  const measured = scoped.filter((i) => workMs(i) != null).length;
  $("people-note").textContent =
    `${scoped.length} tickets · ${rows.length} ${AXIS_LABEL[axis]}s` +
    (unattributed ? ` · ${unattributed} with no ${AXIS_LABEL[axis]} set` : "") +
    ` · work time is elapsed time in ${WORK_STATUS}, summed across visits, from ${measured} tickets`;

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 13;
    td.className = "empty-state";
    td.textContent = "No tickets in this window.";
    tr.append(td);
    body.append(tr);
    return;
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    const isMe = state.meta?.me && row.email === state.meta.me;
    const isUnset = row.key === UNASSIGNED;
    if (isMe) tr.classList.add("is-me-row");

    const personCell = document.createElement("td");
    const chip = el("span", `chip person${isMe ? " is-me" : ""}${isUnset ? " muted" : ""}`, row.key);
    personCell.append(chip);
    if (isMe) personCell.append(el("span", "tag-me", "you"));
    tr.append(personCell);

    tr.append(numCell(row.delivered, "strong"));
    tr.append(numCell(row.closed));
    const signoffCell = numCell(row.waiting);
    if (row.waiting) signoffCell.style.color = "var(--progress)";
    tr.append(signoffCell);
    // Escalations are shown on their own: reaching Q2 means we could not fix
    // it, which is the opposite of delivering it.
    const escCell = numCell(row.escalated);
    if (row.escalated) escCell.style.cssText += ";color:var(--urgent);font-weight:600";
    tr.append(escCell);
    const wipCell = numCell(row.wip);
    if (row.wip) wipCell.style.cssText += ";color:var(--todo);font-weight:600";
    tr.append(wipCell);

    // This person's own stretches only — a ticket handed over credits each
    // person with the time they personally held it.
    tr.append(cell("date", formatDuration(row.medianWorkMs)));
    tr.append(cell("date", formatDuration(row.meanWorkMs)));
    const contributedCell = numCell(row.contributed);
    if (row.contributed) contributedCell.title = `${row.contributed} tickets they worked on but someone else finished`;
    tr.append(contributedCell);
    tr.append(cell("date", formatDuration(row.medianTriageMs)));

    const reopenCell = numCell(row.reopens);
    if (row.reopens) reopenCell.style.color = "var(--urgent)";
    tr.append(reopenCell);

    const breachCell = cell("date", row.breachRate == null ? "—" : `${Math.round(row.breachRate * 100)}%`);
    if (row.breachRate != null && row.breachRate > 0.25) breachCell.style.color = "var(--urgent)";
    breachCell.title = `${row.breached} of ${row.measuredOn} settled tickets breached SLA` +
      (row.breachingNow ? `. ${row.breachingNow} more are past target on a clock that is still running.` : "");
    tr.append(breachCell);

    tr.append(cell("date", row.medianCalendarMs == null ? "—" : formatDuration(row.medianCalendarMs)));
    tr.append(numCell(row.distinctLoans));

    // Clicking a person filters the ticket list to them, which is the obvious
    // next question after reading a row.
    // Every filter is cleared first — changing only the name while an old
    // state or priority filter is still set shows a subset while looking like
    // the whole person's work.
    tr.onclick = () =>
      showTickets(
        axis === "ck" ? { ck: row.key }
        : axis === "assignee" ? { assignee: row.key }
        : { search: row.key }
      );
    body.append(tr);
  }

  renderPeopleCharts(rows, axis);
}

function numCell(value, className) {
  const td = cell("date", String(value ?? "—"));
  if (className === "strong") td.style.cssText += ";color:var(--text);font-weight:600";
  return td;
}

function renderPeopleCharts(rows, axis) {
  // Charts read better with the unattributed bucket left out — it is not a
  // person, and it is usually the largest bar, which flattens everyone else.
  const named = rows.filter((r) => r.key !== UNASSIGNED);

  drawChart("chart-completed", {
    type: "bar",
    data: {
      labels: named.map((r) => r.key),
      datasets: [{
        data: named.map((r) => r.delivered),
        backgroundColor: named.map((r, i) => (state.meta?.me && r.email === state.meta.me ? "#17875b" : PALETTE[i % PALETTE.length])),
        borderRadius: 3,
      }],
    },
    options: { indexAxis: "y", scales: { x: { beginAtZero: true }, y: { ticks: { font: { size: 11 } } } } },
  });

  // A median over one or two tickets is not a rate, it is an anecdote — and a
  // single 1492-hour ticket rendered next to everyone else flattens the whole
  // chart to invisible slivers. Same minimum used for the topic cycle chart.
  const MIN_SAMPLE = 3;
  const timed = named.filter((r) => r.medianWorkMs != null && r.workMeasuredOn >= MIN_SAMPLE);
  const omitted = named.filter((r) => r.medianWorkMs != null && r.workMeasuredOn < MIN_SAMPLE);
  // Say what was left out rather than silently dropping people.
  const worktimeNote = $("worktime-note");
  if (worktimeNote) {
    worktimeNote.textContent = omitted.length
      ? `${omitted.map((r) => `${r.key} (${r.workMeasuredOn})`).join(", ")} left out — fewer than ${MIN_SAMPLE} measured tickets.`
      : "";
  }

  drawChart("chart-worktime", {
    type: "bar",
    data: {
      labels: timed.map((r) => `${r.key} (n=${r.workMeasuredOn})`),
      datasets: [{
        data: timed.map((r) => toHours(r.medianWorkMs)),
        backgroundColor: timed.map((r, i) => (state.meta?.me && r.email === state.meta.me ? "#17875b" : PALETTE[(i + 4) % PALETTE.length])),
        borderRadius: 3,
      }],
    },
    options: {
      indexAxis: "y",
      plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.x}h median in ${WORK_STATUS}` } } },
      scales: { x: { beginAtZero: true, title: { display: true, text: `median hours in ${WORK_STATUS}`, color: chartTextColor() } }, y: { ticks: { font: { size: 11 } } } },
    },
  });

  // Completed per month, stacked per person.
  const keyOf = peopleKeyOf(axis);
  const months = new Map();
  const people = new Set();
  for (const issue of visibleIssues()) {
    if (!isResolved(issue) || !issue.resolved) continue;
    const name = keyOf(issue);
    if (name === UNASSIGNED) continue;
    people.add(name);
    const month = issue.resolved.slice(0, 7);
    if (!months.has(month)) months.set(month, new Map());
    const bucket = months.get(month);
    bucket.set(name, (bucket.get(name) || 0) + 1);
  }
  const monthKeys = [...months.keys()].sort();
  const peopleList = [...people];
  drawChart("chart-people-trend", {
    type: "bar",
    data: {
      labels: monthKeys,
      datasets: peopleList.map((name, i) => ({
        label: name,
        data: monthKeys.map((m) => months.get(m).get(name) || 0),
        backgroundColor: state.meta?.me && rows.find((r) => r.key === name)?.email === state.meta.me ? "#17875b" : PALETTE[i % PALETTE.length],
        borderRadius: 2,
      })),
    },
    options: {
      plugins: { legend: { display: true, position: "bottom", labels: { color: chartTextColor(), boxWidth: 10, font: { size: 11 } } } },
      scales: { x: { stacked: true, ticks: { maxRotation: 60, font: { size: 10 } } }, y: { stacked: true, beginAtZero: true } },
    },
  });
}

// ── insights view ─────────────────────────────────────────────────────

// A categorical palette that holds up in both themes — mid-tone hues rather
// than pastels, so nothing washes out on white or vanishes on near-black.
const PALETTE = [
  "#3b5bdb", "#17875b", "#c0392b", "#b07000", "#7048a8",
  "#0b7285", "#c2255c", "#5c7cfa", "#2b8a3e", "#e8590c",
  "#495057", "#1098ad", "#9c36b5", "#f08c00", "#4263eb",
  "#087f5b", "#a61e4d",
];

function chartTextColor() {
  return getComputedStyle(document.body).getPropertyValue("--text-muted").trim() || "#666";
}
function chartGridColor() {
  return getComputedStyle(document.body).getPropertyValue("--border").trim() || "#ddd";
}

// Topic names run long ("Automated emails & templates"), and on a horizontal bar
// chart Chart.js will happily clip them at the canvas edge rather than reserve
// more room. Truncating in the tick callback keeps every label whole-looking;
// the tooltip still carries the full name.
const MAX_TICK_CHARS = 26;
function tickTruncator() {
  return function (value) {
    const label = String(this.getLabelForValue ? this.getLabelForValue(value) : value);
    return label.length > MAX_TICK_CHARS ? `${label.slice(0, MAX_TICK_CHARS - 1)}…` : label;
  };
}

/**
 * The option merging both the inline charts and the zoomed copy go through, so a
 * chart in the modal is styled identically to the one on the card.
 */
function mergedChartOptions(config) {
  const text = chartTextColor();
  const grid = chartGridColor();
  return {
    responsive: true,
    maintainAspectRatio: false,
    ...config.options,
    plugins: { legend: { display: false }, ...(config.options?.plugins || {}) },
    scales: config.options?.scales
      ? Object.fromEntries(
          Object.entries(config.options.scales).map(([axis, spec]) => {
            // The category axis is y on a horizontal bar chart, x otherwise.
            const isCategoryAxis = config.options?.indexAxis === "y" ? axis === "y" : axis === "x";
            return [
              axis,
              {
                ...spec,
                ticks: {
                  color: text,
                  ...(isCategoryAxis ? { callback: tickTruncator() } : {}),
                  ...(spec.ticks || {}),
                },
                grid: { color: grid, ...(spec.grid || {}) },
              },
            ];
          })
        )
      : undefined,
  };
}

/** The untruncated label, for the zoomed view where it fits. */
function fullTickLabel(value) {
  return this.getLabelForValue ? this.getLabelForValue(value) : value;
}

function drawChart(id, config) {
  if (typeof window.Chart === "undefined") return;
  state.charts[id]?.destroy();
  const canvas = $(id);
  if (!canvas) return;
  // Kept so the zoom modal can rebuild the same chart at a readable size.
  state.chartConfigs[id] = config;
  state.charts[id] = new window.Chart(canvas, { ...config, options: mergedChartOptions(config) });
}

function renderInsights() {
  if (typeof window.Chart === "undefined") {
    for (const id of ["chart-topics", "chart-volume", "chart-cycle", "chart-components"]) {
      const canvas = $(id);
      if (canvas?.parentElement) canvas.parentElement.innerHTML = '<div class="empty-state">Charts need site/vendor/chart.umd.js, which did not load.</div>';
    }
  }

  // What goes wrong most.
  const topicCounts = new Map();
  for (const issue of state.issues) topicCounts.set(issue.topic, (topicCounts.get(issue.topic) || 0) + 1);
  const topics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]);
  drawChart("chart-topics", {
    type: "bar",
    data: {
      labels: topics.map(([id]) => topicLabel(id)),
      datasets: [{ data: topics.map(([, n]) => n), backgroundColor: topics.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius: 3 }],
    },
    options: {
      indexAxis: "y",
      scales: { x: { beginAtZero: true }, y: { ticks: { autoSkip: false, font: { size: 11 } } } },
    },
  });

  // Loans that keep coming back.
  const rankedLoans = [...state.loans.values()].sort((a, b) => b.issues.length - a.issues.length).slice(0, 12);
  renderRankList("rank-loans", rankedLoans.map((loan) => ({
    key: loan.key,
    count: loan.issues.length,
    detail: `${topicLabel(loan.dominantTopic)}${loan.open ? ` · ${loan.open} open` : ""}`,
    onClick: () => { switchTab("loans"); selectLoan(loan.key); },
  })), "No loan has more than one ticket.");

  // Volume by month.
  const months = new Map();
  for (const issue of state.issues) {
    if (!issue.created) continue;
    const month = issue.created.slice(0, 7);
    const bucket = months.get(month) || { withLoan: 0, withoutLoan: 0 };
    if ((issue.loans || []).length) bucket.withLoan += 1;
    else bucket.withoutLoan += 1;
    months.set(month, bucket);
  }
  const monthKeys = [...months.keys()].sort();
  drawChart("chart-volume", {
    type: "bar",
    data: {
      labels: monthKeys,
      datasets: [
        { label: "Names a loan", data: monthKeys.map((m) => months.get(m).withLoan), backgroundColor: PALETTE[0], borderRadius: 2 },
        { label: "No loan named", data: monthKeys.map((m) => months.get(m).withoutLoan), backgroundColor: PALETTE[10], borderRadius: 2 },
      ],
    },
    options: {
      plugins: { legend: { display: true, position: "bottom", labels: { color: chartTextColor(), boxWidth: 10, font: { size: 11 } } } },
      scales: { x: { stacked: true, ticks: { maxRotation: 60, font: { size: 10 } } }, y: { stacked: true, beginAtZero: true } },
    },
  });

  // Median days to resolve, by topic.
  const byTopic = new Map();
  for (const issue of state.issues) {
    if (!issue.resolved) continue;
    const days = ageDays(issue);
    if (days == null) continue;
    if (!byTopic.has(issue.topic)) byTopic.set(issue.topic, []);
    byTopic.get(issue.topic).push(days);
  }
  const cycle = [...byTopic.entries()]
    .filter(([, values]) => values.length >= 3)
    .map(([id, values]) => ({ id, median: median(values), n: values.length }))
    .sort((a, b) => b.median - a.median);
  drawChart("chart-cycle", {
    type: "bar",
    data: {
      labels: cycle.map((c) => `${topicLabel(c.id)} (n=${c.n})`),
      datasets: [{ data: cycle.map((c) => c.median), backgroundColor: cycle.map((_, i) => PALETTE[(i + 3) % PALETTE.length]), borderRadius: 3 }],
    },
    options: { indexAxis: "y", scales: { x: { beginAtZero: true, title: { display: true, text: "median days", color: chartTextColor() } }, y: { ticks: { font: { size: 11 } } } } },
  });

  // Repeat topics on the same loan.
  const repeats = [];
  for (const loan of state.loans.values()) {
    for (const [topic, count] of loan.topics) {
      if (count > 1) repeats.push({ loan: loan.key, topic, count });
    }
  }
  repeats.sort((a, b) => b.count - a.count);
  renderRankList("rank-repeats", repeats.slice(0, 12).map((r) => ({
    key: r.loan,
    count: r.count,
    detail: topicLabel(r.topic),
    onClick: () => { switchTab("loans"); selectLoan(r.loan); },
  })), "No loan has the same kind of problem twice.");

  renderHeatmap();
  renderReporterQuality();
  renderRecurrence();

  // Jira components, for comparison.
  const componentCounts = new Map();
  let noComponent = 0;
  for (const issue of state.issues) {
    if (!(issue.components || []).length) noComponent += 1;
    for (const component of issue.components || []) {
      componentCounts.set(component, (componentCounts.get(component) || 0) + 1);
    }
  }
  const components = [...componentCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  if (noComponent) components.push(["(no component set)", noComponent]);
  drawChart("chart-components", {
    type: "bar",
    data: {
      labels: components.map(([name]) => name),
      datasets: [{ data: components.map(([, n]) => n), backgroundColor: components.map(([name], i) => (name.startsWith("(no") ? "#8b93a1" : PALETTE[(i + 6) % PALETTE.length])), borderRadius: 3 }],
    },
    options: { indexAxis: "y", scales: { x: { beginAtZero: true }, y: { ticks: { autoSkip: false, font: { size: 11 } } } } },
  });
}

/**
 * Components against priority. A table rather than a chart: the useful question
 * is "which component is generating the criticals", and a coloured grid answers
 * it faster than a stacked bar with sixteen segments.
 */
function renderHeatmap() {
  const container = $("heatmap");
  if (!container) return;
  container.innerHTML = "";

  const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];
  const counts = new Map();
  for (const issue of visibleIssues()) {
    for (const component of issue.components?.length ? issue.components : ["(none)"]) {
      if (!counts.has(component)) counts.set(component, new Map());
      const row = counts.get(component);
      row.set(issue.priority, (row.get(issue.priority) || 0) + 1);
    }
  }

  const present = PRIORITIES.filter((p) => [...counts.values()].some((row) => row.get(p)));
  // Weighted by severity so the ordering answers "where does the serious work
  // land", not merely "where is the volume".
  const weight = { Highest: 4, High: 3, Medium: 1, Low: 0.5, Lowest: 0.25 };
  const rows = [...counts.entries()]
    .map(([name, row]) => ({
      name,
      row,
      total: [...row.values()].reduce((a, b) => a + b, 0),
      severity: present.reduce((sum, p) => sum + (row.get(p) || 0) * (weight[p] || 1), 0),
    }))
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 14);

  const max = Math.max(...rows.flatMap((r) => present.map((p) => r.row.get(p) || 0)), 1);
  const table = document.createElement("table");
  table.className = "heatmap";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(el("th", null, "Component"));
  for (const p of present) headRow.append(el("th", "num", p));
  headRow.append(el("th", "num", "All"));
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const entry of rows) {
    const tr = document.createElement("tr");
    tr.append(el("td", null, entry.name));
    for (const p of present) {
      const count = entry.row.get(p) || 0;
      const td = el("td", "num heat", count ? String(count) : "");
      if (count) {
        // Opacity carries the magnitude; hue carries the severity.
        td.style.background = /Highest|High/.test(p) ? `rgba(192,57,43,${0.12 + (count / max) * 0.7})` : `rgba(59,91,219,${0.08 + (count / max) * 0.45})`;
        if (count / max > 0.55) td.style.color = "#fff";
      }
      tr.append(td);
    }
    tr.append(el("td", "num", String(entry.total)));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  container.append(table);
}

/**
 * Which reporters' tickets cost the most to handle. Measured as time before
 * anyone could act on it, not as a judgement of the person — a long first touch
 * usually means the ticket arrived without enough detail to start.
 */
function renderReporterQuality() {
  const body = $("reporter-quality-body");
  if (!body) return;
  body.innerHTML = "";

  const groups = new Map();
  for (const issue of visibleIssues()) {
    const name = reporterName(issue);
    if (!groups.has(name)) groups.set(name, { name, total: 0, firstTouch: [], queue: [], reopened: 0, escalated: 0 });
    const group = groups.get(name);
    group.total += 1;
    const touch = firstTouchMs(issue);
    if (touch != null) group.firstTouch.push(touch);
    const queue = triageMs(issue);
    if (queue != null) group.queue.push(queue);
    if (reopenCount(issue)) group.reopened += 1;
    if (isEscalated(issue)) group.escalated += 1;
  }

  const rows = [...groups.values()]
    .filter((group) => group.total >= 3)
    .sort((a, b) => (median(b.firstTouch) ?? 0) - (median(a.firstTouch) ?? 0))
    .slice(0, 15);

  for (const group of rows) {
    const tr = document.createElement("tr");
    tr.append(el("td", null, group.name));
    tr.append(el("td", "num", String(group.total)));
    tr.append(el("td", "num", formatDuration(median(group.firstTouch))));
    tr.append(el("td", "num", formatDuration(median(group.queue))));
    const reopened = el("td", "num", String(group.reopened));
    if (group.reopened) reopened.style.color = "var(--urgent)";
    tr.append(reopened);
    tr.append(el("td", "num", String(group.escalated)));
    tr.onclick = () => showTickets({ search: group.name });
    tr.style.cursor = "pointer";
    body.append(tr);
  }
}

/**
 * Did the fix hold?
 *
 * A loan that comes back weeks after being closed was not fixed. A return with
 * the *same topic* is the strong signal — the same thing broke again, rather
 * than the loan simply having a different problem next month.
 */
function renderRecurrence() {
  const container = $("recurrence");
  if (!container) return;
  const data = loanRecurrence(visibleIssues());
  container.innerHTML = "";

  const summary = el("div", "sub");
  summary.style.marginBottom = "10px";
  summary.textContent = data.closedTotal
    ? `${data.closedWithFollowUp} of ${data.closedTotal} closed loan tickets (${Math.round(data.returnRate * 100)}%) saw that loan come back within ${data.withinDays} days — ${Math.round(data.sameTopicRate * 100)}% with the same topic.`
    : "No closed tickets against a loan yet.";
  container.append(summary);

  const rows = data.loans.filter((loan) => loan.returns > 0).slice(0, 12);
  if (!rows.length) {
    container.append(el("div", "empty-state", "No loan came back inside the window."));
    return;
  }
  renderRankListInto(
    container,
    rows.map((loan) => ({
      key: loan.loan,
      count: loan.returns,
      detail: `${loan.returns} of ${loan.closed} fixes followed by another ticket${loan.sameTopicReturns ? ` · ${loan.sameTopicReturns} same topic` : ""}`,
      onClick: () => { switchTab("loans"); selectLoan(loan.loan); },
    }))
  );
}

function renderRankListInto(container, rows) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  const list = el("div", "rank-list");
  for (const row of rows) {
    const button = el("button", "rank-row");
    button.type = "button";
    button.append(el("span", "rk", row.key));
    const barWrap = el("div");
    const bar = el("div", "bar");
    bar.style.width = `${Math.max(2, (row.count / max) * 100)}%`;
    bar.style.background = "var(--urgent)";
    barWrap.append(bar);
    if (row.detail) {
      const detail = el("div", null, row.detail);
      detail.style.cssText = "font-size:11.5px;color:var(--text-faint);margin-top:3px";
      barWrap.append(detail);
    }
    button.append(barWrap, el("span", "n", String(row.count)));
    button.onclick = row.onClick;
    list.append(button);
  }
  container.append(list);
}

function renderRankList(containerId, rows, emptyMessage) {
  const container = $(containerId);
  container.innerHTML = "";
  if (!rows.length) {
    container.append(el("div", "empty-state", emptyMessage));
    return;
  }
  const max = Math.max(...rows.map((r) => r.count));
  for (const row of rows) {
    const button = el("button", "rank-row");
    button.type = "button";
    button.append(el("span", "rk", row.key));

    const barWrap = el("div");
    const bar = el("div", "bar");
    bar.style.width = `${Math.max(2, (row.count / max) * 100)}%`;
    barWrap.append(bar);
    if (row.detail) {
      const detail = el("div", null, row.detail);
      detail.style.cssText = "font-size:11.5px;color:var(--text-faint);margin-top:3px";
      barWrap.append(detail);
    }
    button.append(barWrap, el("span", "n", String(row.count)));
    button.onclick = row.onClick;
    container.append(button);
  }
}

/**
 * The optional Claude read of this ticket against its nearest neighbours.
 *
 * Deliberately: off unless a key is configured, never run without a click, and
 * labelled as model-written wherever it appears — everything else in this panel
 * is either a person's words or a quoted comment, and that has to stay legible.
 */
function adviceSection(detail) {
  const section = el("div", "section advice");
  section.append(el("h3", null, "What should I check?"));

  const cached = state.adviceCache.get(detail.key);
  const render = (payload) => {
    section.querySelector(".advice-body")?.remove();
    section.querySelector(".provenance")?.remove();
    const box = el("div", "advice-body summary-box");
    box.textContent = payload.refused ? "The model declined to answer this one." : payload.text;
    section.append(box);
    const note = el("div", "provenance extracted");
    note.append(el("span", "dot"));
    note.append(el("span", null, `Written by ${payload.model} from this ticket and the similar ones above — not by a person, and not checked against the system.`));
    section.append(note);
  };

  if (cached) {
    render(cached);
    return section;
  }

  const button = el("button", "icon-button", "Ask Claude what to check");
  const hint = el("div", "hint", "Sends this ticket and its nearest earlier tickets to Claude. Nothing is sent until you click.");
  section.append(hint, button);

  button.onclick = async () => {
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> thinking…';
    try {
      const response = await fetch(`${API}/ops-advise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket: {
            key: detail.key,
            summary: detail.summary,
            status: detail.status,
            topic: detail.topicLabel,
            components: detail.components,
            loans: detail.loans,
            description: detail.description,
            fix: detail.digest?.fix?.text || "",
          },
          // The similar tickets are already in memory, so the server does not
          // need to go back to Jira for them.
          similar: similarTo(detail).map((match) => ({
            key: match.issue.key,
            summary: match.issue.summary,
            status: match.issue.status,
            fix: match.issue.preview || "",
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "failed");
      state.adviceCache.set(detail.key, payload);
      button.remove();
      hint.remove();
      render(payload);
    } catch (error) {
      button.disabled = false;
      button.textContent = "Ask Claude what to check";
      const failure = el("div", "banner error", error.message);
      failure.style.marginTop = "8px";
      section.append(failure);
    }
  };

  return section;
}

/**
 * A bar showing where the ticket's life went, status by status.
 *
 * This is the thing that makes a single "work time" number trustworthy or not:
 * a ticket showing three weeks in Acknowledged and four minutes In Progress is
 * telling you the status was flipped at the end, not that it took four minutes.
 */
function statusLifeline(detail) {
  const durations = detail?.history?.statusMs;
  if (!durations || !Object.keys(durations).length) return null;

  const entries = Object.entries(durations).filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, ms]) => sum + ms, 0);
  if (!total) return null;

  const TONE = {
    "In Progress": "var(--accent)",
    Acknowledged: "var(--todo)",
    "To Do": "var(--text-faint)",
    Pending: "var(--progress)",
    "Waiting on Customer": "var(--done)",
    Q2: "var(--urgent)",
  };

  const section = el("div", "section");
  const heading = el("h3", null, "Where the time went");
  if (detail.history.historyTruncated) heading.append(el("span", "chip", "history truncated"));
  section.append(heading);

  const bar = el("div", "lifeline");
  for (const [status, ms] of entries) {
    const segment = el("div", "lifeline-seg");
    segment.style.width = `${(ms / total) * 100}%`;
    segment.style.background = TONE[status] || "var(--border-strong)";
    segment.title = `${status}: ${formatDuration(ms)}`;
    bar.append(segment);
  }
  section.append(bar);

  const legend = el("div", "lifeline-legend");
  for (const [status, ms] of entries) {
    const item = el("span", "lifeline-key");
    const swatch = el("span", "swatch");
    swatch.style.background = TONE[status] || "var(--border-strong)";
    item.append(swatch, document.createTextNode(`${status} ${formatDuration(ms)}`));
    legend.append(item);
  }
  section.append(legend);

  const summary = el("div", "hint");
  const work = workMs(detail);
  const queue = triageMs(detail);
  summary.textContent =
    `${formatDuration(work)} in ${WORK_STATUS}` +
    (queue != null ? `, after ${formatDuration(queue)} waiting in ${TRIAGE_STATUS}` : "") +
    (reopenCount(detail) ? ` · reopened ${reopenCount(detail)}×` : "");
  section.append(summary);
  return section;
}

/**
 * The most similar earlier tickets, scored on what this project actually
 * repeats: the same loan first, then the same topic, then the same component.
 */
function similarTo(detail) {
  const loans = new Set(detail.loans || []);
  const components = new Set(detail.components || []);
  const linked = new Set([...(detail.links || []).map((l) => l.key), ...(detail.mentions || [])]);

  return state.issues
    .filter((issue) => issue.key !== detail.key && !linked.has(issue.key))
    .map((issue) => {
      let score = 0;
      const reasons = [];
      if ((issue.loans || []).some((loan) => loans.has(loan))) {
        score += 5;
        reasons.push("same loan");
      }
      if (issue.topic === detail.topic) {
        score += 3;
        reasons.push("same topic");
      }
      if ((issue.components || []).some((component) => components.has(component))) {
        score += 2;
        reasons.push("same component");
      }
      // A ticket with a written fix is the one worth reading, so it wins ties.
      if (issue.hasResolutionComments) score += 1;
      return { issue, score, why: reasons.join(" · ") };
    })
    .filter((match) => match.score >= 5)
    .sort((a, b) => b.score - a.score || new Date(b.issue.created) - new Date(a.issue.created))
    .slice(0, 5);
}

/** The CK user as a chip, highlighted when it is the person using the app. */
function ckUserNode(issue) {
  const name = issue.ckUser?.name;
  if (!name) return el("span", null, "— not set —");
  const chip = el("span", "chip person", name);
  if (state.meta?.me && issue.ckUser?.email === state.meta.me) {
    chip.classList.add("is-me");
    chip.title = "That's you";
  }
  return chip;
}

/** Work time with its goal and breach state, as one readable line. */
function workTimeText(issue) {
  const sla = issue?.sla?.resolution;
  if (!sla || sla.elapsedMs == null) return "—";
  const parts = [formatWorkTime(sla.elapsedMs)];
  if (sla.goalMs) parts.push(`of ${formatWorkTime(sla.goalMs)} goal`);
  if (sla.breached) parts.push("· breached");
  else if (sla.ongoing) parts.push("· still running");
  return parts.join(" ");
}

// ── ticket drawer ─────────────────────────────────────────────────────

async function openTicket(key) {
  state.openTicket = key;
  const drawer = $("drawer");
  $("scrim").hidden = false;
  drawer.hidden = false;
  drawer.innerHTML = `
    <div class="drawer-head">
      <div class="row"><span class="key">${key}</span><button class="icon-button" style="margin-left:auto" id="drawer-close">Close</button></div>
      <h2 id="drawer-title">Loading…</h2>
    </div>
    <div class="drawer-body">
      <div class="skeleton" style="width:70%;margin-bottom:8px"></div>
      <div class="skeleton" style="width:90%;margin-bottom:8px"></div>
      <div class="skeleton" style="width:50%"></div>
    </div>`;
  $("drawer-close").onclick = closeDrawer;

  try {
    let detail = state.detailCache.get(key);
    if (!detail) {
      const response = await fetch(`${API}/ops-issue?key=${encodeURIComponent(key)}`);
      detail = await response.json();
      if (!response.ok) throw new Error(detail.error || `Request failed (${response.status})`);
      state.detailCache.set(key, detail);
    }
    if (state.openTicket === key) renderDrawer(detail);
  } catch (error) {
    if (state.openTicket !== key) return;
    drawer.querySelector(".drawer-body").innerHTML = "";
    drawer.querySelector("#drawer-title").textContent = "Could not load this ticket";
    drawer.querySelector(".drawer-body").append(el("div", "banner error", error.message));
  }
}

function closeDrawer() {
  state.openTicket = null;
  $("drawer").hidden = true;
  $("scrim").hidden = true;
}

function renderDrawer(detail) {
  const drawer = $("drawer");
  drawer.innerHTML = "";

  // Head
  const head = el("div", "drawer-head");
  const row = el("div", "row");
  row.append(el("span", "key", detail.key));
  const link = el("a", "icon-button", "Jira ↗");
  link.href = detail.url;
  link.target = "_blank";
  link.rel = "noopener";
  row.append(link);
  const close = el("button", "icon-button", "Close");
  close.style.marginLeft = "auto";
  close.onclick = closeDrawer;
  row.append(close);
  head.append(row);

  const title = el("h2", null, detail.summary);
  title.id = "drawer-title";
  head.append(title);

  const chips = el("div", "chips");
  chips.append(statusChip(detail));
  if (detail.priority && detail.priority !== "None") chips.append(el("span", `chip prio-${detail.priority}`, detail.priority));
  chips.append(el("span", "chip topic", detail.topicLabel));
  for (const secondary of detail.secondaryTopics || []) chips.append(el("span", "chip", `also ${secondary.label.toLowerCase()}`));
  for (const component of detail.components || []) chips.append(el("span", "chip", component));
  head.append(chips);
  drawer.append(head);

  const body = el("div", "drawer-body");

  // The two summaries — the reason the drawer exists.
  body.append(summarySection("The issue", detail.digest.issue, detail, "issue"));
  body.append(summarySection("The fix", detail.digest.fix, detail, "fix"));

  // Loans and other references.
  if ((detail.loans || []).length || (detail.refs || []).length) {
    const section = el("div", "section");
    section.append(el("h3", null, "Touches"));
    const chipRow = el("div", "tl-chips");
    for (const loan of detail.loans || []) {
      const chip = el("button", "chip topic mono", loan);
      chip.type = "button";
      chip.style.cursor = "pointer";
      chip.title = `Show every ticket for ${loan}`;
      chip.onclick = () => { closeDrawer(); switchTab("loans"); selectLoan(loan); };
      chipRow.append(chip);
    }
    for (const ref of detail.refs || []) chipRow.append(el("span", "chip mono", ref.canonical));
    section.append(chipRow);
    body.append(section);
  }

  // Related tickets — the same problem coming back, or a follow-up.
  const related = relatedTo(detail);
  if (related.length) {
    const section = el("div", "section");
    section.append(el("h3", null, `Related tickets (${related.length})`));
    const list = el("div", "related-list");
    for (const item of related) {
      const button = el("button", "related-row");
      button.type = "button";

      const top = el("div", "top");
      top.append(el("span", "tl-key", item.key));
      if (item.issue) {
        top.append(el("span", `chip status-${item.issue.statusCategory}`, item.issue.status));
        if (item.issue.ckUser?.name) top.append(el("span", "chip person", item.issue.ckUser.name));
      }
      top.append(el("span", "relation", item.relation));
      button.append(top);

      // A related ticket outside the current filter (a feature request, say)
      // has no index record, so say so rather than rendering a bare key.
      button.append(
        el("div", "related-summary", item.issue?.summary || "not in the current view — open it to load from Jira")
      );
      if (item.issue?.created) {
        button.append(el("div", "related-meta", `raised ${fmtDate(item.issue.created)} · ${relative(item.issue.created)}`));
      }

      button.onclick = () => openTicket(item.key);
      list.append(button);
    }
    section.append(list);
    body.append(section);
  }

  if (state.adviceAvailable) body.append(adviceSection(detail));

  // Where the ticket's life actually went.
  const lifeline = statusLifeline(detail);
  if (lifeline) body.append(lifeline);

  // Nearest prior tickets: same loan, same topic, same component. Distinct from
  // "Related tickets" above, which is only what Jira or a human linked.
  const neighbours = similarTo(detail);
  if (neighbours.length) {
    const section = el("div", "section");
    section.append(el("h3", null, "Seen this before"));
    section.append(el("div", "hint", "Closest earlier tickets by loan, topic and component — with whatever was recorded as the fix."));
    const list = el("div", "related-list");
    for (const item of neighbours) {
      const row = el("button", "related-row");
      row.type = "button";
      const top = el("div", "top");
      top.append(el("span", "tl-key", item.issue.key));
      top.append(el("span", `chip status-${item.issue.statusCategory}`, item.issue.status));
      if (item.issue.hasResolutionComments) top.append(el("span", "chip", "has a written fix"));
      top.append(el("span", "relation", item.why));
      row.append(top);
      row.append(el("div", "related-summary", item.issue.summary));
      row.append(el("div", "related-meta", `${fmtDate(item.issue.created)} · ${workedBy(item.issue)}`));
      row.onclick = () => openTicket(item.issue.key);
      list.append(row);
    }
    section.append(list);
    body.append(section);
  }

  // Facts.
  const facts = el("div", "section");
  facts.append(el("h3", null, "Detail"));
  const grid = el("div", "facts");
  const addFact = (label, value) => {
    const fact = el("div", "fact");
    fact.append(el("div", "k", label), el("div", "v", value || "—"));
    grid.append(fact);
  };
  const addFactNode = (label, node) => {
    const fact = el("div", "fact");
    const value = el("div", "v");
    value.append(node);
    fact.append(el("div", "k", label), value);
    grid.append(fact);
  };
  addFact("Raised", `${fmtDate(detail.created)} · ${relative(detail.created)}`);
  addFact(
    detail.resolved ? "Resolved" : "Last updated",
    detail.resolved
      ? `${fmtDate(detail.resolved)} · ${ageDays(detail)} days later`
      : `${fmtDate(detail.updated)} · open ${ageDays(detail)} days`
  );
  addFact("Reported by", detail.reporter?.name);
  addFact("Assignee (F2F)", detail.assignee?.name);
  // The field that says which of the CK team actually picked this up. The Jira
  // login is a shared desk account, so this — not the assignee — is who worked it.
  addFactNode("CK user", ckUserNode(detail));
  addFact("Work time (SLA)", workTimeText(detail));
  addFact("First response", formatWorkTime(firstResponseMs(detail)));
  addFact("Request type", detail.requestType);
  addFact("Issue or request", detail.opsType);
  if (detail.severity) addFact("Severity", detail.severity);
  if (detail.urgency) addFact("Urgency", detail.urgency);
  if (detail.ckTimeSpent) addFact("CK time logged", String(detail.ckTimeSpent));
  if (detail.f2fTimeSpent) addFact("F2F time logged", String(detail.f2fTimeSpent));
  if ((detail.labels || []).length) addFact("Labels", detail.labels.join(", "));
  facts.append(grid);
  body.append(facts);

  // The reporter's own words, in full — but only when that is actually more
  // than "The issue" box already showed. When the description is two sentences
  // long the digest *is* the description, and printing it twice just pushes the
  // thread further down the panel.
  const issueDigestIsWholeDescription =
    detail.digest.issue.source === "description" &&
    detail.description.length <= detail.digest.issue.text.length + 4;
  if (detail.description && !issueDigestIsWholeDescription) {
    const section = el("div", "section");
    section.append(el("h3", null, "As reported, in full"));
    section.append(el("div", "summary-box", detail.description));
    body.append(section);
  }

  // Thread.
  const threadSection = el("div", "section");
  const threadHead = el("h3", null, `Thread (${(detail.thread || []).length})`);
  threadSection.append(threadHead);
  if (!(detail.thread || []).length) {
    threadSection.append(el("div", "empty-state", "No comments on this ticket."));
  } else {
    const thread = el("div", "thread");
    for (const comment of detail.thread) {
      const isFixSource = detail.digest.fix.commentId === comment.id && detail.digest.fix.source === "extracted";
      const card = el("div", `comment${isFixSource ? " is-fix" : ""}`);
      const commentHead = el("div", "head");
      commentHead.append(el("span", "who", comment.author));
      // Deep link to this comment in Jira. Screenshots are pasted into comments
      // constantly here and the tracker only renders them as "[image]", so this
      // is the way to actually see one.
      const permalink = commentUrl(state.meta?.jiraBase, detail.key, comment.id);
      if (permalink) {
        const when = el("a", "when", fmtDateTime(comment.created));
        when.href = permalink;
        when.target = "_blank";
        when.rel = "noopener";
        when.title = "Open this comment in Jira";
        commentHead.append(when);
      } else {
        commentHead.append(el("span", "when", fmtDateTime(comment.created)));
      }
      if (isFixSource) commentHead.append(el("span", "flag", "read as the fix"));
      card.append(commentHead, el("div", "body", comment.body));
      thread.append(card);
    }
    threadSection.append(thread);
  }
  body.append(threadSection);

  drawer.append(body);
}

/**
 * The issue box and the fix box. Provenance is rendered as prominently as the
 * text itself: a summary the app guessed and a summary a person wrote must
 * never be mistaken for each other, or nobody can trust either.
 */
function summarySection(heading, summary, detail, kind) {
  const section = el("div", "section");
  const title = el("h3", null, heading);
  section.append(title);

  const source = summary.source;
  const deliberate = source === "authored" || source === "resolution-field";
  const box = el("div", `summary-box ${deliberate ? "authored" : source === "none" ? "empty" : "extracted"}`);
  box.textContent =
    summary.text ||
    (kind === "fix"
      ? "Nothing in this thread reads like a resolution. If you know what fixed it, write it here — it saves the next person the read."
      : "No description was given.");
  section.append(box);

  const provenance = el("div", `provenance ${deliberate ? "authored" : source === "none" ? "none" : "extracted"}`);
  provenance.append(el("span", "dot"));
  const describe = {
    authored: `Written by ${summary.author || "someone"}${summary.created ? ` · ${fmtDate(summary.created)}` : ""}`,
    extracted: `Pulled from ${summary.author ? `${summary.author}'s ` : "a "}comment${summary.created ? ` of ${fmtDate(summary.created)}` : ""} — not written for this purpose${summary.confidence === "low" ? ", and a weak match" : ""}`,
    // Jira's own field, filled in by a person on purpose. Ranks with an
    // authored note rather than with a scraped comment.
    "resolution-field": "From the ticket's Resolution Comments field in Jira",
    description: "Taken from the reporter's own description",
    summary: "Taken from the ticket title",
    none: "Not recorded",
  };
  provenance.append(el("span", null, describe[source] || source));
  const sourceLink = commentUrl(state.meta?.jiraBase, detail.key, summary.commentId);
  if (sourceLink) {
    const open = el("a", null, "open in Jira ↗");
    open.href = sourceLink;
    open.target = "_blank";
    open.rel = "noopener";
    provenance.append(open);
  }
  section.append(provenance);

  const editLabel =
    deliberate
      ? "Rewrite"
      : kind === "fix"
      ? "Write the fix in your own words"
      : "Summarise it yourself";
  // If Jira's Resolution Comments field was filled in but only with a sign-off,
  // say so. Otherwise the field looks untouched and somebody fills it in twice.
  if (kind === "fix" && summary.fieldNote) {
    const note = el("div", "field-note");
    note.append(el("span", "k", "Resolution Comments in Jira says:"));
    note.append(el("span", "v", `“${summary.fieldNote}”`));
    note.append(el("span", "why", "read as a status update rather than a fix"));
    section.append(note);
  }

  const editButton = el("button", "icon-button", editLabel);
  editButton.style.marginTop = "8px";
  editButton.onclick = () => showNoteEditor(section, editButton, detail, kind, summary);
  section.append(editButton);

  return section;
}

function showNoteEditor(section, trigger, detail, kind, summary) {
  trigger.hidden = true;
  const editor = el("div", "note-editor");

  const textarea = document.createElement("textarea");
  textarea.value = summary.source === "authored" ? summary.text : "";
  textarea.placeholder =
    kind === "fix"
      ? "What actually fixed it — in the words you'd use telling a colleague."
      : "What went wrong, in one or two sentences.";
  editor.append(textarea);

  const actions = el("div", "actions");
  const save = el("button", "primary-button", "Save to Jira");
  const cancel = el("button", "icon-button", "Cancel");
  const hint = el("span", "hint", `Posted on ${detail.key} as a comment tagged ${kind === "fix" ? FIX_NOTE_MARKER : ISSUE_NOTE_MARKER}`);
  actions.append(save, cancel, hint);
  editor.append(actions);
  section.append(editor);
  textarea.focus();

  cancel.onclick = () => { editor.remove(); trigger.hidden = false; };

  save.onclick = async () => {
    const text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const response = await fetch(`${API}/ops-note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: detail.key, kind, text }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "save failed");

      // Reflect it locally rather than re-fetching: the note is now the
      // authoritative summary, exactly as ops-issue.js would report it.
      const fresh = { text: result.text, source: "authored", author: result.author || "you", created: result.created };
      detail.digest[kind === "fix" ? "fix" : "issue"] = fresh;
      state.detailCache.set(detail.key, detail);
      renderDrawer(detail);
    } catch (error) {
      save.disabled = false;
      save.textContent = "Save to Jira";
      const failure = el("div", "banner error", error.message);
      failure.style.marginTop = "8px";
      editor.append(failure);
    }
  };
}

// ── queues ────────────────────────────────────────────────────────────
//
// The four lists somebody actually acts on, rather than another way to slice
// history: what needs assigning, what has gone quiet, what is stuck with Q2,
// and what came back after being closed.

const AGEING_DAYS = 7;

function queueDefinitions() {
  // Queues are working lists, so they hold only tickets that still need
  // something doing. A reopened ticket that has since been closed again is
  // history, not a job — its count still appears in the blurb so the quality
  // signal is not lost.
  const open = visibleIssues().filter((i) => !isResolved(i));
  const allIssues = visibleIssues();
  const ageOf = (issue) => ageDays(issue) ?? 0;
  const everReopened = allIssues.filter((i) => reopenCount(i) > 0).length;
  const everUnowned = allIssues.filter((i) => isSharedDesk(i.assignee) && !i.ckUser).length;

  return [
    {
      id: "triage",
      title: "Needs picking up",
      blurb: "Raised and not yet worked. Oldest first — this is the assign-next list.",
      tone: "todo",
      rows: open.filter((i) => ["queued", "triage"].includes(outcome(i))).sort((x, y) => new Date(x.created) - new Date(y.created)),
      meta: (i) => `waiting ${formatDuration(firstTouchMs(i) ?? calendarMs(i))}`,
    },
    {
      id: "ageing",
      title: "Ageing work in progress",
      blurb: `In Progress or on hold for more than ${AGEING_DAYS} days. Either it is stuck, or the status is stale.`,
      tone: "progress",
      rows: open.filter((i) => ["active", "onhold"].includes(outcome(i)) && ageOf(i) > AGEING_DAYS).sort((x, y) => ageOf(y) - ageOf(x)),
      meta: (i) => `${ageOf(i)}d old · ${formatDuration(workMs(i))} worked`,
    },
    {
      id: "escalated",
      title: "Escalated to Q2",
      blurb: "With the product help desk. We could not fix these — worth chasing, and worth counting.",
      tone: "urgent",
      rows: open.filter(isEscalated).sort((x, y) => ageOf(y) - ageOf(x)),
      meta: (i) => `open ${ageOf(i)}d · raised ${fmtDate(i.created)}`,
    },
    {
      id: "reopened",
      title: "Reopened and still open",
      blurb: `Closed, moved back, and not yet closed again. ${everReopened} tickets have been reopened at some point — see Recurring errors for the rest.`,
      tone: "urgent",
      rows: open.filter((i) => reopenCount(i) > 0).sort((x, y) => reopenCount(y) - reopenCount(x)),
      meta: (i) => `${reopenCount(i)}× reopened · ${ageOf(i)}d old`,
    },
    {
      id: "signoff",
      title: "Awaiting client sign-off",
      blurb: "Our work is done. These close themselves once the client confirms — chase if they linger.",
      tone: "done",
      rows: open.filter((i) => outcome(i) === "signoff").sort((x, y) => ageOf(y) - ageOf(x)),
      meta: (i) => `waiting ${ageOf(i)}d`,
    },
    {
      id: "unowned",
      title: "Open, with no owner recorded",
      blurb: `On the shared CK login with no CK User set, so nobody can be credited or chased. ${everUnowned} in total including closed ones.`,
      tone: "todo",
      rows: open.filter((i) => isSharedDesk(i.assignee) && !i.ckUser).sort((x, y) => new Date(y.created) - new Date(x.created)),
      meta: (i) => `raised ${fmtDate(i.created)}`,
    },
  ];
}

function renderQueues() {
  const grid = $("queue-grid");
  grid.innerHTML = "";

  for (const queue of queueDefinitions()) {
    const panel = el("div", `panel queue tone-${queue.tone}`);
    const head = el("div", "panel-head");
    head.append(el("h2", null, queue.title));
    head.append(el("span", "queue-count", String(queue.rows.length)));
    panel.append(head);
    panel.append(el("div", "queue-blurb", queue.blurb));

    if (!queue.rows.length) {
      panel.append(el("div", "empty-state", "Nothing here — good."));
      grid.append(panel);
      continue;
    }

    const list = el("div", "queue-list");
    // Capped: these are working lists, not reports. The count in the header is
    // the real total.
    for (const issue of queue.rows.slice(0, 25)) {
      const row = el("button", "queue-row");
      row.type = "button";
      const top = el("div", "top");
      top.append(el("span", "tl-key", issue.key));
      // The current status, since "what state is this in" is the first thing
      // asked of any of these lists.
      top.append(statusChip(issue));
      if (issue.priority && /High|Highest/.test(issue.priority)) {
        top.append(el("span", `chip prio-${issue.priority}`, issue.priority));
      }
      const who = workedBy(issue);
      if (who !== UNASSIGNED) top.append(el("span", "chip person", who));
      row.append(top);
      row.append(el("div", "queue-summary", issue.summary));
      row.append(el("div", "queue-meta", queue.meta(issue)));
      row.onclick = () => openTicket(issue.key);
      list.append(row);
    }
    panel.append(list);
    if (queue.rows.length > 25) {
      panel.append(el("div", "queue-meta", `…and ${queue.rows.length - 25} more`));
    }
    grid.append(panel);
  }
}

// ── who raised what ───────────────────────────────────────────────────
//
// The demand side. Throughput answers "who cleared the work"; this answers
// "where the work comes from" — which part of the business is generating
// operational load, and what kind.

function raisedRows() {
  const groups = new Map();
  for (const issue of visibleIssues()) {
    const name = reporterName(issue);
    if (!groups.has(name)) {
      groups.set(name, { name, total: 0, open: 0, highest: 0, reopened: 0, escalated: 0, firstTouch: [], work: [], topics: new Map() });
    }
    const group = groups.get(name);
    group.total += 1;
    if (!isResolved(issue)) group.open += 1;
    if (/^(Highest|High)$/.test(issue.priority)) group.highest += 1;
    if (reopenCount(issue)) group.reopened += 1;
    if (isEscalated(issue)) group.escalated += 1;
    const touch = firstTouchMs(issue);
    if (touch != null) group.firstTouch.push(touch);
    const work = workMs(issue);
    if (work != null && isDelivered(issue)) group.work.push(work);
    group.topics.set(issue.topic, (group.topics.get(issue.topic) || 0) + 1);
  }

  const rows = [...groups.values()].map((group) => ({
    ...group,
    medianFirstTouch: median(group.firstTouch),
    medianWork: median(group.work),
    topTopic: [...group.topics.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
  }));

  const { column, direction } = state.raisedSort;
  return rows.sort((a, b) => {
    const [x, y] = [a[column], b[column]];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * direction;
  });
}

function renderRaised() {
  const rows = raisedRows();
  const body = $("raised-body");
  body.innerHTML = "";
  $("raised-note").textContent = `${visibleIssues().length} tickets from ${rows.length} reporters`;

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.append(el("td", null, row.name));
    tr.append(el("td", "num", String(row.total)));
    const openCell = el("td", "num", String(row.open));
    if (row.open) openCell.style.color = "var(--todo)";
    tr.append(openCell);
    tr.append(el("td", "num", String(row.highest)));
    tr.append(el("td", "num", formatDuration(row.medianFirstTouch)));
    tr.append(el("td", "num", formatDuration(row.medianWork)));
    const reopenCell = el("td", "num", String(row.reopened));
    if (row.reopened) reopenCell.style.color = "var(--urgent)";
    tr.append(reopenCell);
    tr.append(el("td", "num", String(row.escalated)));
    tr.append(el("td", "num", row.topTopic ? topicLabel(row.topTopic) : "—"));
    tr.style.cursor = "pointer";
    tr.onclick = () => showTickets({ search: row.name });
    body.append(tr);
  }

  const top = rows.slice().sort((a, b) => b.total - a.total).slice(0, 12);
  drawChart("chart-raised", {
    type: "bar",
    data: { labels: top.map((r) => r.name), datasets: [{ data: top.map((r) => r.total), backgroundColor: top.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius: 3 }] },
    options: { indexAxis: "y", scales: { x: { beginAtZero: true }, y: { ticks: { font: { size: 11 } } } } },
  });

  // Topic mix per reporter, stacked — the "what kind of pain" view.
  const busiest = top.slice(0, 8);
  const topicIds = [...new Set(busiest.flatMap((r) => [...r.topics.keys()]))]
    .sort((a, b) => busiest.reduce((s, r) => s + (r.topics.get(b) || 0), 0) - busiest.reduce((s, r) => s + (r.topics.get(a) || 0), 0))
    .slice(0, 8);
  drawChart("chart-raised-topics", {
    type: "bar",
    data: {
      labels: busiest.map((r) => r.name),
      datasets: topicIds.map((id, i) => ({
        label: topicLabel(id),
        data: busiest.map((r) => r.topics.get(id) || 0),
        backgroundColor: PALETTE[i % PALETTE.length],
        borderRadius: 2,
      })),
    },
    options: {
      indexAxis: "y",
      plugins: { legend: { display: true, position: "bottom", labels: { color: chartTextColor(), boxWidth: 10, font: { size: 10 } } } },
      scales: { x: { stacked: true, beginAtZero: true }, y: { stacked: true, ticks: { font: { size: 11 } } } },
    },
  });

  const months = new Map();
  for (const issue of visibleIssues()) {
    if (!issue.created) continue;
    const name = reporterName(issue);
    if (!top.slice(0, 6).some((r) => r.name === name)) continue;
    const month = issue.created.slice(0, 7);
    if (!months.has(month)) months.set(month, new Map());
    months.get(month).set(name, (months.get(month).get(name) || 0) + 1);
  }
  const monthKeys = [...months.keys()].sort();
  drawChart("chart-raised-trend", {
    type: "bar",
    data: {
      labels: monthKeys,
      datasets: top.slice(0, 6).map((r, i) => ({
        label: r.name,
        data: monthKeys.map((m) => months.get(m).get(r.name) || 0),
        backgroundColor: PALETTE[i % PALETTE.length],
        borderRadius: 2,
      })),
    },
    options: {
      plugins: { legend: { display: true, position: "bottom", labels: { color: chartTextColor(), boxWidth: 10, font: { size: 10 } } } },
      scales: { x: { stacked: true, ticks: { maxRotation: 60, font: { size: 9 } } }, y: { stacked: true, beginAtZero: true } },
    },
  });
}

// ── year-on-year report ───────────────────────────────────────────────
//
// A printable comparison of tickets *raised*, not resolved: the question it
// answers is whether the operation is generating fewer problems than last year.
// Everything comes from the index already in memory, so changing the filters is
// instant and costs Jira nothing.

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function reportFills() {
  const yearsPresent = [...new Set(state.issues.map((i) => i.created?.slice(0, 4)).filter(Boolean))].sort();
  for (const id of ["report-year-a", "report-year-b"]) {
    const select = $(id);
    if (select.options.length) continue;
    for (const year of yearsPresent) select.append(new Option(year, year));
    // Default to the two most recent years: last full year versus this one.
    select.value = id === "report-year-b" ? yearsPresent[yearsPresent.length - 1] : yearsPresent[yearsPresent.length - 2] || yearsPresent[0];
  }

  const list = $("report-reporters");
  if (!list.options.length) {
    const counts = new Map();
    for (const issue of state.issues) {
      const name = reporterName(issue);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      list.append(new Option(`${name} (${count})`, name));
    }
  }
}

/** A signed change, coloured so that fewer tickets raised reads as good. */
function deltaChip(value, { suffix = "" } = {}) {
  if (value == null || !Number.isFinite(value)) return el("span", "delta flat", "—");
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  // Fewer tickets raised is the good direction throughout this report.
  return el("span", `delta ${rounded === 0 ? "flat" : rounded < 0 ? "down" : "up"}`, `${sign}${rounded}${suffix}`);
}

const share = (part, whole) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : "—");

function renderReport() {
  reportFills();

  const allYears = state.reportAllYears;
  const yearA = Number($("report-year-a").value);
  const yearB = Number($("report-year-b").value);
  for (const id of ["report-year-a", "report-year-b"]) $(id).disabled = allYears;
  const chosen = [...$("report-reporters").selectedOptions].map((o) => o.value);
  const asOf = new Date();

  const data = yearOnYear(visibleIssues(), { asOf, reporters: chosen });
  const a = data.years.find((y) => y.year === yearA);
  const b = data.years.find((y) => y.year === yearB);

  const body = $("report-body");
  body.innerHTML = "";
  state.reportData = data;

  if (allYears) {
    renderAllYearsReport(body, data, asOf);
    renderReportCharts(data, allYears ? data.years.map((y) => y.year) : [yearA, yearB]);
    return;
  }

  if (!a || !b) {
    body.append(el("div", "empty-state", "Not enough history for those two years."));
    return;
  }

  const asOfLabel = `${asOf.getDate()} ${MONTH_NAMES[asOf.getMonth()].slice(0, 3)}`;
  body.append(el("h2", null, "OPS Year-on-Year Comparison"));
  body.append(el("div", "lede", `Full year ${yearA} vs ${yearB} year-to-date (as of ${asOfLabel} ${asOf.getFullYear()})`));

  const scope = el("div", "scope");
  const scopeLine = (label, value) => {
    const line = el("div");
    line.append(el("b", null, `${label}: `), document.createTextNode(value));
    scope.append(line);
  };
  scopeLine("Project", `${state.meta?.project || "OPS"} (Salesforce Operational Issues)`);
  scopeLine("Scope", "Production issues only — feature requests and service requests excluded");
  scopeLine("Reporters", chosen.length ? chosen.join(", ") : "All reporters");
  scopeLine("Compared", `Full year ${yearA} · ${yearA} YTD to ${asOfLabel} · ${yearB} YTD to ${asOfLabel}`);
  body.append(scope);

  // ── executive summary ──
  // Written from the numbers directly below it, so the prose and the tables
  // cannot drift apart the way a hand-written summary does.
  const ytdChange = a.ytd ? ((b.ytd - a.ytd) / a.ytd) * 100 : null;
  const scoped = visibleIssues().filter((i) => !chosen.length || chosen.includes(reporterName(i)));
  const inYearB = scoped.filter((i) => i.created?.slice(0, 4) === String(yearB));
  const statsB = summarise(inYearB);
  const recurrence = loanRecurrence(inYearB);
  const topTopicB = [...inYearB.reduce((map, i) => map.set(i.topic, (map.get(i.topic) || 0) + 1), new Map())]
    .sort((x, y) => y[1] - x[1])[0];

  body.append(el("h3", null, "Executive summary"));
  const bullets = el("ul");
  const bullet = (label, text) => {
    const item = el("li");
    item.append(el("b", null, `${label}: `), document.createTextNode(text));
    bullets.append(item);
  };
  bullet(
    "Volume",
    ytdChange == null
      ? `${b.ytd} tickets raised to ${asOfLabel}.`
      : `${b.ytd} tickets raised to ${asOfLabel}, against ${a.ytd} in the same period of ${yearA} — ${ytdChange >= 0 ? "up" : "down"} ${Math.abs(Math.round(ytdChange * 10) / 10)}%.`
  );
  bullet("Closure", `${share(b.done, b.total)} of ${yearB} tickets are closed, against ${share(a.done, a.total)} for ${yearA}.`);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (statsB.escalated) {
    bullet("Escalations", `${plural(statsB.escalated, "ticket", "tickets")} went to Q2 — work the desk could not resolve.`);
  }
  if (statsB.reopened) {
    bullet("Reopened", `${plural(statsB.reopened, "ticket was", "tickets were")} closed and came back, ${share(statsB.reopened, b.total)} of the year.`);
  }
  if (recurrence.closedTotal) {
    bullet(
      "Did the fixes hold",
      `${recurrence.closedWithFollowUp} of ${recurrence.closedTotal} closed loan tickets (${Math.round(recurrence.returnRate * 100)}%) saw that loan raise another ticket within ${recurrence.withinDays} days; ${Math.round(recurrence.sameTopicRate * 100)}% with the same topic.`
    );
  }
  if (statsB.medianWorkMs != null) {
    bullet(
      "Effort",
      `Median ${formatDuration(statsB.medianWorkMs)} in ${WORK_STATUS} per ticket, after a median ${formatDuration(statsB.medianTriageMs)} waiting in ${TRIAGE_STATUS}.`
    );
  }
  if (topTopicB) bullet("Most common problem", `${topicLabel(topTopicB[0])} — ${topTopicB[1]} tickets.`);
  body.append(bullets);

  // ── 1. key metrics ──
  body.append(el("h3", null, "1. Key metrics"));
  const months = asOf.getMonth() + 1;
  const rows = [
    ["Tickets raised", a.total, a.ytd, b.ytd],
    ["Monthly run rate", Math.round((a.total / 12) * 10) / 10, Math.round((a.ytd / months) * 10) / 10, Math.round((b.ytd / months) * 10) / 10],
    ["Completed", `${a.done} (${share(a.done, a.total)})`, null, `${b.done} (${share(b.done, b.total)})`],
    ["Still open", `${a.open} (${share(a.open, a.total)})`, null, `${b.open} (${share(b.open, b.total)})`],
  ];
  body.append(
    reportTable(
      ["Metric", `Full year ${yearA}`, `${yearA} YTD`, `${yearB} YTD`, "YoY (YTD vs YTD)"],
      rows.map(([label, full, ytdA, ytdB]) => {
        const change =
          typeof ytdA === "number" && typeof ytdB === "number" && ytdA
            ? ((ytdB - ytdA) / ytdA) * 100
            : null;
        return [
          label,
          { num: full },
          { num: ytdA ?? "—" },
          { num: ytdB },
          { node: change == null ? el("span", "delta flat", "—") : deltaChip(change, { suffix: "%" }) },
        ];
      })
    )
  );

  // ── 2. monthly trend ──
  body.append(el("h3", null, "2. Monthly trend"));
  const monthRows = MONTH_NAMES.map((name, index) => {
    const countA = a.months[index];
    const countB = b.months[index];
    // A month this year has not happened yet: showing 0 would read as a
    // collapse in volume rather than a month that has not arrived.
    const future = yearB === asOf.getFullYear() && index > asOf.getMonth();
    // The month in progress is not a like-for-like month, so say so rather than
    // letting a part-month read as a collapse in volume.
    const partial = yearB === asOf.getFullYear() && index === asOf.getMonth();
    return [
      partial ? `${name} (to ${asOfLabel})` : name,
      { num: countA },
      { num: future ? "—" : countB },
      { node: future ? el("span", "delta flat", "—") : deltaChip(countB - countA) },
    ];
  });
  // Column sums, so both are full-year figures. No variance here on purpose:
  // subtracting a part year from a full one is the misleading number this
  // report exists to avoid — the like-for-like comparison is in table 1.
  monthRows.push([
    "Total raised",
    { num: a.total },
    { num: b.total },
    { node: el("span", "delta flat", "—") },
  ]);
  const monthTable = reportTable([`Month`, `${yearA}`, `${yearB}`, "Variance"], monthRows);
  monthTable.querySelector("tbody").lastElementChild.classList.add("total-row");
  body.append(monthTable);

  // ── 3. reporter breakdown ──
  body.append(el("h3", null, "3. Reporter breakdown"));
  const people = data.reporters
    .map((person) => ({
      name: person.name,
      fullA: person.years.get(yearA)?.total || 0,
      ytdA: person.years.get(yearA)?.ytd || 0,
      ytdB: person.years.get(yearB)?.ytd || 0,
    }))
    .filter((person) => person.fullA || person.ytdB)
    .sort((x, y) => y.ytdB - x.ytdB || y.fullA - x.fullA);

  const reporterRows = people.map((person) => [
    person.name,
    { num: person.fullA },
    { num: person.ytdA },
    { num: person.ytdB },
    { num: share(person.ytdB, b.ytd) },
    { node: deltaChip(person.ytdB - person.ytdA) },
  ]);
  reporterRows.push([
    "Total",
    { num: a.total },
    { num: a.ytd },
    { num: b.ytd },
    { num: "100%" },
    { node: deltaChip(b.ytd - a.ytd) },
  ]);
  const reporterTable = reportTable(
    ["Reporter", `Full year ${yearA}`, `${yearA} YTD`, `${yearB} YTD`, `Share of ${yearB}`, "Change"],
    reporterRows
  );
  reporterTable.querySelector("tbody").lastElementChild.classList.add("total-row");
  body.append(reporterTable);

  // ── 4. priority mix ──
  body.append(el("h3", null, "4. Priority mix"));
  const priorities = [...new Set([...a.priority.keys(), ...b.priority.keys()])].sort();
  body.append(
    reportTable(
      ["Priority", `${yearA} (full year)`, `${yearB} (YTD)`, "Shift in share"],
      priorities.map((name) => {
        const countA = a.priority.get(name) || 0;
        const countB = b.priority.get(name) || 0;
        const shiftPoints = (countB / (b.total || 1)) * 100 - (countA / (a.total || 1)) * 100;
        return [
          name,
          { num: `${countA} (${share(countA, a.total)})` },
          { num: `${countB} (${share(countB, b.total)})` },
          // Deliberately uncoloured: whether a shift is good depends on the row
          // — more Highest is bad, more Low is fine — so a single colour rule
          // would be wrong half the time.
          { node: el("span", "delta flat", `${shiftPoints > 0 ? "+" : ""}${Math.round(shiftPoints * 10) / 10} pts`) },
        ];
      })
    )
  );

  // ── 5. delivery and quality ──
  body.append(el("h3", null, `5. Delivery and quality, ${yearB}`));
  body.append(
    reportTable(
      ["Measure", `${yearB}`, "Note"],
      [
        ["Closed", { num: statsB.closed }, { num: share(statsB.closed, statsB.total) }],
        ["Escalated to Q2", { num: statsB.escalated }, { num: "could not be fixed here" }],
        ["Awaiting client sign-off", { num: statsB.signoff }, { num: "work done, with the client" }],
        ["Still with us", { num: statsB.withUs }, { num: "outstanding on our side" }],
        ["Reopened", { num: statsB.reopened }, { num: "closed, then moved back" }],
        ["Median work time", { num: formatDuration(statsB.medianWorkMs) }, { num: `in ${WORK_STATUS}, elapsed` }],
        ["Median queue wait", { num: formatDuration(statsB.medianTriageMs) }, { num: `in ${TRIAGE_STATUS}` }],
      ]
    )
  );

  // ── 6. who did the work ──
  const workers = throughputBy(inYearB, workedBy, { splitWork: true }).filter((r) => r.key !== UNASSIGNED).slice(0, 10);
  if (workers.length) {
    body.append(el("h3", null, `6. Who did the work, ${yearB}`));
    body.append(
      reportTable(
        ["Person", "Delivered", "Q2", "Median work", "Avg work", "Reopens"],
        workers.map((person) => [
          person.key,
          { num: person.delivered },
          { num: person.escalated },
          { num: formatDuration(person.medianWorkMs) },
          { num: formatDuration(person.meanWorkMs) },
          { num: person.reopens },
        ])
      )
    );
    body.append(
      el("div", "hint", `Work time counts only the stretches each person personally held the ticket, so a handover credits both. "Delivered" is counted against whoever closed it.`)
    );
  }

  // ── 7. loans that came back ──
  const repeatLoans = recurrence.loans.filter((loan) => loan.returns > 0).slice(0, 10);
  if (repeatLoans.length) {
    body.append(el("h3", null, `7. Loans that came back after a fix`));
    body.append(
      reportTable(
        ["Loan", "Tickets", "Closed", "Came back", "Same topic"],
        repeatLoans.map((loan) => [
          loan.loan,
          { num: loan.tickets },
          { num: loan.closed },
          { num: loan.returns },
          { num: loan.sameTopicReturns },
        ])
      )
    );
  }

  // ── 8. what the tickets were about ──
  body.append(el("h3", null, `8. What ${yearB} tickets were about`));
  const topicCounts = new Map();
  for (const issue of visibleIssues()) {
    if (issue.created?.slice(0, 4) !== String(yearB)) continue;
    if (chosen.length && !chosen.includes(reporterName(issue))) continue;
    topicCounts.set(issue.topic, (topicCounts.get(issue.topic) || 0) + 1);
  }
  const topTopics = [...topicCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6);
  if (topTopics.length) {
    const list = el("ul");
    for (const [topicId, count] of topTopics) {
      const item = el("li");
      item.append(el("b", null, topicLabel(topicId)), document.createTextNode(` — ${count} tickets. ${getTopic(topicId)?.blurb || ""}`));
      list.append(item);
    }
    body.append(list);
  } else {
    body.append(el("div", "empty-state", "No tickets in this selection."));
  }

  const footer = el("div", "lede");
  footer.style.marginTop = "24px";
  footer.textContent = `Generated ${asOf.toLocaleDateString()} from Jira ${state.meta?.project || "OPS"}. Counts are tickets raised in each period.`;
  body.append(footer);

  renderReportCharts(data, [yearA, yearB]);
}

/**
 * Every year side by side, rather than a pair.
 *
 * Each year still carries a year-to-date column cut at today's month and day,
 * because the current year is the only partial one and comparing its part-year
 * against everyone else's full year is the mistake this whole view guards
 * against.
 */
function renderAllYearsReport(body, data, asOf) {
  const years = data.years;
  const asOfLabel = `${asOf.getDate()} ${MONTH_NAMES[asOf.getMonth()].slice(0, 3)}`;

  body.append(el("h2", null, "OPS year-by-year"));
  body.append(el("div", "lede", `Every year side by side. "YTD" columns are cut at ${asOfLabel} in each year, so they compare like for like.`));

  body.append(el("h3", null, "1. Volume by year"));
  body.append(
    reportTable(
      ["Metric", ...years.map((y) => String(y.year))],
      [
        ["Tickets raised (full year)", ...years.map((y) => ({ num: y.total }))],
        [`Raised to ${asOfLabel}`, ...years.map((y) => ({ num: y.ytd }))],
        ["Closed", ...years.map((y) => ({ num: `${y.done} (${share(y.done, y.total)})` }))],
        ["Still open", ...years.map((y) => ({ num: y.open }))],
        [
          "YTD change on previous year",
          ...years.map((y, index) => {
            const previous = years[index - 1];
            if (!previous?.ytd) return { node: el("span", "delta flat", "—") };
            return { node: deltaChip(((y.ytd - previous.ytd) / previous.ytd) * 100, { suffix: "%" }) };
          }),
        ],
      ]
    )
  );

  body.append(el("h3", null, "2. Monthly, by year"));
  body.append(
    reportTable(
      ["Month", ...years.map((y) => String(y.year))],
      MONTH_NAMES.map((name, index) => [
        name,
        ...years.map((y) => {
          const future = y.year === asOf.getFullYear() && index > asOf.getMonth();
          return { num: future ? "—" : y.months[index] };
        }),
      ])
    )
  );

  body.append(el("h3", null, "3. Reporters, by year"));
  const people = data.reporters
    .map((person) => ({ name: person.name, counts: years.map((y) => person.years.get(y.year)?.total || 0) }))
    .filter((person) => person.counts.some(Boolean))
    .sort((x, y) => y.counts[y.counts.length - 1] - x.counts[x.counts.length - 1] || y.counts.reduce((a, b) => a + b, 0) - x.counts.reduce((a, b) => a + b, 0));

  const rows = people.map((person) => [person.name, ...person.counts.map((n) => ({ num: n }))]);
  rows.push(["Total", ...years.map((y) => ({ num: y.total }))]);
  const table = reportTable(["Reporter", ...years.map((y) => String(y.year))], rows);
  table.querySelector("tbody").lastElementChild.classList.add("total-row");
  body.append(table);

  const footer = el("div", "lede");
  footer.style.marginTop = "24px";
  footer.textContent = `Generated ${asOf.toLocaleDateString()} from Jira ${state.meta?.project || "OPS"}. Counts are tickets raised in each period.`;
  body.append(footer);
}

/** The same comparison as pictures — a table of 40 numbers hides its own shape. */
function renderReportCharts(data, years) {
  const host = $("report-charts");
  if (!host) return;
  host.innerHTML = "";

  const panel = (title, sub, canvasId, tall) => {
    const wrap = el("div", "chart-panel");
    wrap.append(el("h3", null, title), el("div", "sub", sub));
    const box = el("div", `chart-box${tall ? " tall" : ""}`);
    const canvas = document.createElement("canvas");
    canvas.id = canvasId;
    box.append(canvas);
    wrap.append(box);
    host.append(wrap);
  };

  panel("Tickets raised by month", "Each year as its own line — the shape of the year, not just its total.", "chart-yoy-months");
  panel("Tickets raised per year", "Full year, with the year-to-date cut alongside for a like-for-like read.", "chart-yoy-total");
  panel("Reporters by year", "Who is generating the load, and how that has shifted.", "chart-yoy-reporters", true);
  wireChartZoom();

  const shown = data.years.filter((y) => years.includes(y.year));

  drawChart("chart-yoy-months", {
    type: "line",
    data: {
      labels: MONTH_NAMES.map((m) => m.slice(0, 3)),
      datasets: shown.map((y, i) => ({
        label: String(y.year),
        data: y.months.map((count, index) =>
          y.year === new Date().getFullYear() && index > new Date().getMonth() ? null : count
        ),
        borderColor: PALETTE[i % PALETTE.length],
        backgroundColor: PALETTE[i % PALETTE.length],
        tension: 0.3,
        spanGaps: false,
      })),
    },
    options: {
      plugins: { legend: { display: true, position: "bottom", labels: { color: chartTextColor(), boxWidth: 10 } } },
      scales: { x: {}, y: { beginAtZero: true } },
    },
  });

  drawChart("chart-yoy-total", {
    type: "bar",
    data: {
      labels: shown.map((y) => String(y.year)),
      datasets: [
        { label: "Full year", data: shown.map((y) => y.total), backgroundColor: PALETTE[0], borderRadius: 3 },
        { label: "To date", data: shown.map((y) => y.ytd), backgroundColor: PALETTE[1], borderRadius: 3 },
      ],
    },
    options: {
      plugins: { legend: { display: true, position: "bottom", labels: { color: chartTextColor(), boxWidth: 10 } } },
      scales: { x: {}, y: { beginAtZero: true } },
    },
  });

  const topReporters = data.reporters
    .map((person) => ({ name: person.name, counts: shown.map((y) => person.years.get(y.year)?.total || 0) }))
    .sort((a, b) => b.counts.reduce((x, y) => x + y, 0) - a.counts.reduce((x, y) => x + y, 0))
    .slice(0, 8);
  drawChart("chart-yoy-reporters", {
    type: "bar",
    data: {
      labels: topReporters.map((r) => r.name),
      datasets: shown.map((y, i) => ({
        label: String(y.year),
        data: topReporters.map((r) => r.counts[i]),
        backgroundColor: PALETTE[i % PALETTE.length],
        borderRadius: 2,
      })),
    },
    options: {
      indexAxis: "y",
      plugins: { legend: { display: true, position: "bottom", labels: { color: chartTextColor(), boxWidth: 10 } } },
      scales: { x: { beginAtZero: true }, y: { ticks: { font: { size: 11 } } } },
    },
  });
}

/** The report as a spreadsheet, for anyone who wants to take the numbers away. */
function exportReportCsv() {
  const data = state.reportData;
  if (!data?.years?.length) return;
  const years = data.years;
  const rows = [
    ["OPS year-on-year", `generated ${new Date().toISOString().slice(0, 10)}`],
    [],
    ["Metric", ...years.map((y) => y.year)],
    ["Raised (full year)", ...years.map((y) => y.total)],
    ["Raised (year to date)", ...years.map((y) => y.ytd)],
    ["Closed", ...years.map((y) => y.done)],
    ["Still open", ...years.map((y) => y.open)],
    [],
    ["Month", ...years.map((y) => y.year)],
    ...MONTH_NAMES.map((name, index) => [name, ...years.map((y) => y.months[index])]),
    [],
    ["Reporter", ...years.map((y) => y.year)],
    ...data.reporters
      .map((person) => [person.name, ...years.map((y) => person.years.get(y.year)?.total || 0)])
      .sort((a, b) => b.slice(1).reduce((x, y) => x + y, 0) - a.slice(1).reduce((x, y) => x + y, 0)),
  ];

  // Quote every field: reporter names contain commas, and one unquoted comma
  // silently shifts an entire row.
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `ops-year-on-year-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** Small table builder: cells are a string, {num}, or {node}. */
function reportTable(headers, rows) {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((label, index) => {
    const th = document.createElement("th");
    th.textContent = label;
    if (index) th.className = "num";
    headRow.append(th);
  });
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const cells of rows) {
    const tr = document.createElement("tr");
    cells.forEach((cellValue, index) => {
      const td = document.createElement("td");
      if (index) td.className = "num";
      if (cellValue && typeof cellValue === "object" && cellValue.node) td.append(cellValue.node);
      else if (cellValue && typeof cellValue === "object") td.textContent = String(cellValue.num);
      else td.textContent = String(cellValue);
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

// ── chart zoom ────────────────────────────────────────────────────────

/**
 * Open a panel's chart big, in a modal. Clicking the backdrop or pressing
 * Escape closes it.
 *
 * The chart is rebuilt rather than moved: a Chart.js instance is bound to its
 * canvas, so relocating the original would leave a hole in the card and a chart
 * sized for a box a third as wide. The data is deep-copied (plain numbers and
 * colour strings) while the options go back through the same merge as the
 * inline version, so the two are consistent and neither mutates the other's
 * state.
 *
 * Rank lists are not charts, but a panel whose title looks clickable and then
 * does nothing is worse than one that opens — so those clone their list, and
 * show it in full rather than the top dozen the card is limited to.
 */
function openChartZoom(panel) {
  const heading = panel.querySelector("h3");
  const sub = panel.querySelector(".sub");
  const canvas = panel.querySelector("canvas");
  const rankList = panel.querySelector(".rank-list");

  const modal = $("chart-modal");
  modal.innerHTML = "";

  const head = el("div", "chart-modal-head");
  const titles = el("div");
  titles.append(el("h2", null, heading?.textContent || "Chart"));
  if (sub?.textContent.trim()) titles.append(el("div", "sub", sub.textContent.trim()));
  head.append(titles);
  const close = el("button", "icon-button close-x", "✕");
  close.title = "Close (Esc)";
  close.setAttribute("aria-label", "Close");
  close.style.marginLeft = "auto";
  close.onclick = closeChartZoom;
  head.append(close);
  modal.append(head);

  const body = el("div", "chart-modal-body");

  if (canvas && state.chartConfigs[canvas.id] && typeof window.Chart !== "undefined") {
    const config = state.chartConfigs[canvas.id];
    const zoomCanvas = document.createElement("canvas");
    body.append(zoomCanvas);
    modal.append(body);
    $("chart-scrim").hidden = false;
    modal.hidden = false;

    state.zoomChart?.destroy();
    state.zoomChart = new window.Chart(zoomCanvas, {
      type: config.type,
      data: JSON.parse(JSON.stringify(config.data)),
      options: {
        ...mergedChartOptions(config),
        // Room to breathe at this size: show every label in full, and put the
        // legend back for multi-series charts.
        plugins: {
          ...mergedChartOptions(config).plugins,
          legend: config.data.datasets.length > 1
            ? { display: true, position: "bottom", labels: { color: chartTextColor(), boxWidth: 12 } }
            : { display: false },
        },
        scales: config.options?.scales
          ? Object.fromEntries(
              Object.entries(mergedChartOptions(config).scales).map(([axis, spec]) => [
                axis,
                {
                  ...spec,
                  ticks: {
                    ...spec.ticks,
                    // There is room for the whole label here, so the truncating
                    // callback is replaced with one that returns it in full.
                    // Note it must be *replaced*, not deleted: setting callback
                    // to undefined does not restore Chart.js's default
                    // formatter, it falls through to printing the raw category
                    // index — which rendered every axis as 0,1,2,3…
                    callback: fullTickLabel,
                    autoSkip: false,
                    font: { size: 12 },
                  },
                },
              ])
            )
          : undefined,
      },
    });
    return;
  }

  if (rankList) {
    body.append(rankList.cloneNode(true));
    modal.append(body);
    $("chart-scrim").hidden = false;
    modal.hidden = false;
    // The clone's buttons lost their handlers, so wire them to the same jump.
    const keys = [...rankList.querySelectorAll(".rank-row .rk")].map((n) => n.textContent);
    body.querySelectorAll(".rank-row").forEach((row, index) => {
      const key = keys[index];
      row.onclick = () => {
        closeChartZoom();
        switchTab("loans");
        selectLoan(key);
      };
    });
  }
}

function closeChartZoom() {
  state.zoomChart?.destroy();
  state.zoomChart = null;
  $("chart-modal").hidden = true;
  $("chart-scrim").hidden = true;
}

/** Every chart panel's title becomes the control that opens it. */
function wireChartZoom() {
  for (const panel of document.querySelectorAll(".chart-panel")) {
    if (panel.dataset.zoomWired) continue;
    panel.dataset.zoomWired = "1";

    const heading = panel.querySelector("h3");
    if (heading) {
      heading.classList.add("zoomable");
      heading.title = "Click to open this bigger";
      heading.tabIndex = 0;
      heading.setAttribute("role", "button");
      heading.onclick = () => openChartZoom(panel);
      heading.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openChartZoom(panel);
        }
      };
    }

    // The chart itself is the obvious thing to click, so it opens too. Ranked
    // lists are excluded — their rows already navigate somewhere.
    const box = panel.querySelector(".chart-box");
    if (box) {
      box.classList.add("zoomable-box");
      box.title = "Click to open this bigger";
      box.onclick = () => openChartZoom(panel);
    }
  }
}

// ── tabs, theme, wiring ───────────────────────────────────────────────

const TABS = ["loans", "tickets", "queues", "people", "raised", "report", "insights"];

function switchTab(name) {
  for (const tab of TABS) {
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
    $(`view-${tab}`).hidden = tab !== name;
  }
  if (name === "insights") renderInsights();
  if (name === "tickets") renderTickets();
  if (name === "queues") renderQueues();
  if (name === "people") renderPeople();
  if (name === "raised") renderRaised();
  if (name === "report") renderReport();
  history.replaceState(null, "", `#${name}`);
}

/** Counts on the tabs that hold work, so you can see where it is without looking. */
function renderTabBadges() {
  const badge = (tabId, count, tone) => {
    const tab = $(tabId);
    if (!tab) return;
    tab.querySelector(".tab-badge")?.remove();
    if (!count) return;
    const chip = el("span", `tab-badge${tone ? ` ${tone}` : ""}`, String(count));
    tab.append(chip);
  };
  const issues = visibleIssues();
  // Only what needs doing: the queues hold open tickets, so the badge does too.
  badge("tab-queues", issues.filter((i) => !isResolved(i) && (isWithUs(i) || isEscalated(i))).length, "urgent");
}

function renderAll() {
  renderKpis();
  renderTabBadges();
  renderLoanList();
  renderLoanDetail();
  if (!$("view-tickets").hidden) renderTickets();
  if (!$("view-queues").hidden) renderQueues();
  if (!$("view-people").hidden) renderPeople();
  if (!$("view-raised").hidden) renderRaised();
  if (!$("view-report").hidden) renderReport();
  if (!$("view-insights").hidden) renderInsights();
}

/**
 * Back to the start, as though the page had just been opened: every filter
 * cleared, nothing selected, first tab, scrolled to the top. Deliberately does
 * NOT re-fetch — the data is already correct, and clicking home should feel
 * instant rather than costing another pass over the project. Refresh is the
 * control for "get me new data".
 */
function goHome() {
  closeDrawer();
  state.selectedLoan = null;
  state.onlyMine = false;
  state.ticketSort = { column: "created", direction: -1 };
  state.peopleSort = { column: "delivered", direction: -1 };

  $("mine-toggle").setAttribute("aria-pressed", "false");
  $("loan-search").value = "";
  $("loan-sort").value = "count";
  resetTicketFilters();
  $("people-axis").value = "worked";
  $("report-all-years").setAttribute("aria-pressed", "false");
  state.reportAllYears = false;
  $("people-window").value = "0";

  showWarning("");
  buildLoanIndex();
  switchTab("loans");
  renderAll();
  history.replaceState(null, "", location.pathname);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * Open the ticket list showing exactly one set.
 *
 * Every filter is reset first and only the named ones re-applied. Leaving the
 * others as they were is how you end up looking at "Md Sameer's escalated
 * tickets" while believing you are looking at all escalations — the bug this
 * exists to prevent.
 */
function showTickets(filter = {}) {
  switchTab("tickets");
  resetTicketFilters();
  if (filter.state) $("filter-state").value = filter.state;
  if (filter.topic) $("filter-topic").value = filter.topic;
  if (filter.priority) $("filter-priority").value = filter.priority;
  if (filter.ck) $("filter-ck").value = filter.ck;
  if (filter.assignee) $("filter-assignee").value = filter.assignee;
  if (filter.loan) $("filter-loan").value = filter.loan;
  if (filter.reopened) $("filter-reopened").value = filter.reopened;
  if (filter.search) $("ticket-search").value = filter.search;
  renderTickets();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetTicketFilters() {
  $("ticket-search").value = "";
  for (const id of TICKET_FILTER_IDS) {
    const field = $(id);
    if (field) field.value = "";
  }
}

function clearTicketFilters() {
  resetTicketFilters();
  renderTickets();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    if (theme) localStorage.setItem("opstracker-theme", theme);
    else localStorage.removeItem("opstracker-theme");
  } catch {
    /* Private windows and locked-down browsers throw here; the theme still applies. */
  }
  // Chart.js bakes tick colours in at construction, so they are rebuilt.
  if (!$("view-insights").hidden) renderInsights();
  if (!$("view-people").hidden) renderPeople();
  // A chart open in the modal would otherwise keep the old theme's axis colours.
  if (!$("chart-modal").hidden) closeChartZoom();
}

function init() {
  try {
    const saved = localStorage.getItem("opstracker-theme");
    if (saved) document.documentElement.dataset.theme = saved;
  } catch { /* ignore */ }

  for (const tab of TABS) $(`tab-${tab}`).onclick = () => switchTab(tab);
  const fromHash = location.hash.slice(1);
  if (TABS.includes(fromHash)) switchTab(fromHash);

  $("home").onclick = goHome;

  $("refresh").onclick = () => {
    state.detailCache.clear();
    clearCachedIndex();
    loadIndex({ refresh: true });
  };

  $("scope-select").onchange = () => {
    state.scope = $("scope-select").value;
    state.detailCache.clear();
    state.selectedLoan = null;
    // The picklists are rebuilt from whatever loads, so they are emptied first
    // — otherwise a name from the previous scope lingers in the list.
    for (const id of ["filter-topic", "filter-priority", "filter-ck", "filter-assignee"]) $(id).innerHTML = "";
    $("report-year-a").innerHTML = "";
    $("report-year-b").innerHTML = "";
    $("report-reporters").innerHTML = "";
    loadIndex();
  };

  $("mine-toggle").onclick = () => {
    state.onlyMine = !state.onlyMine;
    $("mine-toggle").setAttribute("aria-pressed", String(state.onlyMine));
    buildLoanIndex();
    state.selectedLoan = null;
    renderAll();
  };

  $("filters-clear").onclick = clearTicketFilters;
  $("people-axis").onchange = renderPeople;
  for (const id of ["report-year-a", "report-year-b", "report-reporters"]) $(id).onchange = renderReport;
  $("report-reporters-clear").onclick = () => {
    $("report-reporters").selectedIndex = -1;
    renderReport();
  };
  // The browser's own print-to-PDF: no dependency, and it already knows how to
  // paginate. The print stylesheet drops everything but the report.
  $("report-print").onclick = () => window.print();
  $("report-csv").onclick = exportReportCsv;
  $("report-all-years").onclick = () => {
    state.reportAllYears = !state.reportAllYears;
    $("report-all-years").setAttribute("aria-pressed", String(state.reportAllYears));
    renderReport();
  };

  for (const th of document.querySelectorAll("#raised-table th[data-raised-sort]")) {
    th.onclick = () => {
      const column = th.dataset.raisedSort;
      const sort = state.raisedSort;
      sort.direction = sort.column === column ? -sort.direction : -1;
      sort.column = column;
      renderRaised();
    };
  }
  $("people-window").onchange = renderPeople;

  for (const th of document.querySelectorAll("#people-table th[data-people-sort]")) {
    th.onclick = () => {
      const column = th.dataset.peopleSort;
      const sort = state.peopleSort;
      // Counts and loans read best high-first; durations and breach rates read
      // best low-first, since "fast" is the interesting end.
      const defaultDirection = ["delivered", "closed", "waiting", "escalated", "wip", "reopens", "distinctLoans"].includes(column) ? -1 : 1;
      sort.direction = sort.column === column ? -sort.direction : defaultDirection;
      sort.column = column;
      renderPeople();
    };
  }

  $("theme-toggle").onclick = () => {
    const current = document.documentElement.dataset.theme;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(current === "dark" ? "light" : current === "light" ? "dark" : prefersDark ? "light" : "dark");
  };

  $("loan-search").oninput = debounce(renderLoanList, 140);
  $("loan-sort").onchange = renderLoanList;

  $("ticket-search").oninput = debounce(renderTickets, 140);
  for (const id of TICKET_FILTER_IDS) $(id).onchange = renderTickets;

  // Scoped away from the people table: those headers are also .sortable, and
  // assigning onclick twice to one element silently keeps only the last
  // handler — which had the ticket sorter swallowing every people-table click.
  for (const th of document.querySelectorAll("#ticket-table th.sortable")) {
    th.onclick = () => {
      const column = th.dataset.sort;
      const sort = state.ticketSort;
      // Dates and durations are most useful newest/largest first.
      const defaultDirection = ["created", "days"].includes(column) ? -1 : 1;
      sort.direction = sort.column === column ? -sort.direction : defaultDirection;
      sort.column = column;
      renderTickets();
    };
  }

  // Table headers carry their full form from the same glossary the cards use.
  for (const node of document.querySelectorAll("[data-term]")) tip(node, node.dataset.term);

  $("scrim").onclick = closeDrawer;
  $("chart-scrim").onclick = closeChartZoom;
  wireChartZoom();

  document.addEventListener("keydown", (event) => {
    // "/" jumps to the search box of whichever tab is open — the shortcut
    // people already expect from every other list-and-filter tool.
    if (event.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
      const box = $("view-loans").hidden ? $("ticket-search") : $("loan-search");
      if (box && !box.closest(".view").hidden) {
        event.preventDefault();
        box.focus();
        box.select();
      }
      return;
    }
    if (event.key !== "Escape") return;
    // Innermost first: a zoomed chart opened from a panel should close before
    // the drawer that may still be open behind it.
    if (!$("chart-modal").hidden) closeChartZoom();
    else if (state.openTicket) closeDrawer();
    else if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) && document.activeElement.value) {
      document.activeElement.value = "";
      document.activeElement.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  // Ask once whether the optional analysis is switched on; the button only
  // exists if a key is configured server-side.
  fetch(`${API}/ops-advise`)
    .then((r) => r.json())
    .then((d) => { state.adviceAvailable = Boolean(d.available); })
    .catch(() => { state.adviceAvailable = false; });

  loadIndex();
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

init();

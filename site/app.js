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
  isOpen as ticketIsOpen, isResolved, median, slaBreached, slaElapsedMs, summarise,
  throughputBy, toHours, UNASSIGNED,
} from "./lib/stats.js";

const API = "/api";

const state = {
  issues: [],
  loans: new Map(),      // canonical loan key -> { key, issues[], open, last, topics:Map }
  meta: null,
  selectedLoan: null,
  openTicket: null,
  ticketSort: { column: "created", direction: -1 },
  peopleSort: { column: "resolved", direction: -1 },
  onlyMine: false,
  charts: {},
  chartConfigs: {},
  zoomChart: null,
  detailCache: new Map(),
};

// Bump when the index record shape changes, so a cached copy from an older
// build is discarded rather than rendered with missing fields.
const CACHE_VERSION = "v2";
const CACHE_KEY = `opstracker-index-${CACHE_VERSION}`;
const CACHE_ETAG_KEY = `opstracker-etag-${CACHE_VERSION}`;
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

const isOpen = ticketIsOpen;

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
    const raw = localStorage.getItem(CACHE_KEY);
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
    localStorage.setItem(CACHE_KEY, JSON.stringify({ storedAt: Date.now(), payload }));
    if (etag) localStorage.setItem(CACHE_ETAG_KEY, etag);
  } catch {
    // Over quota, or storage blocked. The app is fully functional without it.
  }
}

function clearCachedIndex() {
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_ETAG_KEY);
  } catch {
    /* ignore */
  }
}

function applyIndex(data, { fromCache = false, ageMs = 0 } = {}) {
  state.issues = data.issues || [];
  state.meta = data;
  buildLoanIndex();

  const excludedNote = [
    data.excludedFeatureRequests ? `${data.excludedFeatureRequests} feature requests` : null,
    data.excludedServiceRequests ? `${data.excludedServiceRequests} service requests` : null,
  ].filter(Boolean).join(" and ");
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
    `${data.project} · ${state.issues.length} production issues · ${state.loans.size} loans` +
    (excludedNote ? ` · excludes ${excludedNote}` : "");

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
    $("freshness").innerHTML = '<span class="spinner"></span> loading…';
  }

  try {
    const etag = (() => {
      try {
        return refresh ? null : localStorage.getItem(CACHE_ETAG_KEY);
      } catch {
        return null;
      }
    })();

    const response = await fetch(`${API}/ops-issues${refresh ? "?refresh=1" : ""}`, {
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
        loan = { key: loanKey, issues: [], open: 0, last: null, first: null, topics: new Map() };
        loans.set(loanKey, loan);
      }
      loan.issues.push(issue);
      if (isOpen(issue)) loan.open += 1;
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
    {
      value: stats.total,
      label: "Production tickets",
      note: `${withLoan} name a loan (${pct(withLoan, stats.total)})`,
    },
    {
      value: stats.open,
      label: "Still open",
      note: stats.oldestOpen ? `oldest raised ${relative(stats.oldestOpen)}` : "nothing outstanding",
    },
    {
      // The headline "how long does a ticket take" number. Working hours, not
      // calendar days — see the note at the top of stats.js.
      value: formatWorkTime(stats.medianSlaMs),
      label: "Median work time",
      note: `p90 ${formatWorkTime(stats.p90SlaMs)} · across ${stats.measuredOn} resolved`,
      small: true,
    },
    {
      value: formatWorkTime(stats.medianFirstResponseMs),
      label: "Median 1st response",
      note: "SLA clock, working hours",
      small: true,
    },
    {
      value: stats.breachRate == null ? "—" : pct(stats.breached, stats.resolved),
      label: "SLA breached",
      note: `${stats.breached} of ${stats.resolved} resolved`,
      small: true,
    },
    {
      value: state.loans.size,
      label: "Loans affected",
      note: `${repeatLoans.length} with 3 or more tickets`,
    },
  ];

  if (state.meta?.me) {
    const myStats = summarise(mine);
    kpis.push({
      value: `${myStats.resolved}/${myStats.total}`,
      label: "Mine, done / total",
      note: myStats.measuredOn ? `median ${formatWorkTime(myStats.medianSlaMs)}` : "no resolved tickets yet",
      small: true,
    });
  }

  const container = $("kpis");
  container.innerHTML = "";
  for (const kpi of kpis) {
    const card = el("div", "kpi");
    const value = el("div", "value", String(kpi.value));
    if (kpi.small) value.style.fontSize = "17px";
    card.append(value, el("div", "label", kpi.label), el("div", "note", kpi.note));
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
    if (loan.open) top.append(el("span", "chip status-new", `${loan.open} open`));
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
  const openChip = el("span", loan.open ? "chip status-new" : "chip status-done", loan.open ? `${loan.open} open` : "all resolved");
  title.append(openChip);
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

function timelineItem(issue) {
  const item = el("button", "tl-item");
  item.type = "button";
  item.dataset.cat = issue.statusCategory;

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
  chips.append(el("span", `chip status-${issue.statusCategory}`, issue.status));
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

  return visibleIssues().filter((issue) => {
    if (stateFilter === "open" && !isOpen(issue)) return false;
    if (stateFilter === "done" && isOpen(issue)) return false;
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
    statusCell.append(el("span", `chip status-${issue.statusCategory}`, issue.status));
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
    tr.append(cell("date", days == null ? "—" : isOpen(issue) ? `${days}d open` : `${days}d`));

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

function peopleRows() {
  const axis = $("people-axis").value;
  const keyOf = axis === "assignee" ? assigneeName : ckUserName;
  const scoped = visibleIssues().filter(peopleWindowFilter());
  const rows = throughputBy(scoped, keyOf);

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
  const unattributed = scoped.filter((i) => (axis === "assignee" ? !i.assignee : !i.ckUser)).length;
  $("people-note").textContent =
    `${scoped.length} tickets · ${rows.length} ${axis === "assignee" ? "assignees" : "CK users"}` +
    (unattributed ? ` · ${unattributed} with no ${axis === "assignee" ? "assignee" : "CK user"} set` : "") +
    " · work time is Jira SLA working hours, not calendar time";

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 9;
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

    tr.append(numCell(row.resolved, "strong"));
    tr.append(numCell(row.open));
    tr.append(cell("date", formatWorkTime(row.medianSlaMs)));
    tr.append(cell("date", formatWorkTime(row.p90SlaMs)));
    tr.append(cell("date", formatWorkTime(row.medianFirstResponseMs)));

    const breachCell = cell("date", row.breachRate == null ? "—" : `${Math.round(row.breachRate * 100)}%`);
    if (row.breachRate != null && row.breachRate > 0.25) breachCell.style.color = "var(--urgent)";
    if (row.breached) breachCell.title = `${row.breached} of ${row.resolved} resolved tickets breached SLA`;
    tr.append(breachCell);

    tr.append(cell("date", row.medianCalendarMs == null ? "—" : formatDuration(row.medianCalendarMs)));
    tr.append(numCell(row.distinctLoans));

    // Clicking a person filters the ticket list to them, which is the obvious
    // next question after reading a row.
    tr.onclick = () => {
      switchTab("tickets");
      $(axis === "assignee" ? "filter-assignee" : "filter-ck").value = row.key;
      $(axis === "assignee" ? "filter-ck" : "filter-assignee").value = "";
      renderTickets();
    };
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
        data: named.map((r) => r.resolved),
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
  const timed = named.filter((r) => r.medianSlaMs != null && r.measuredOn >= MIN_SAMPLE);
  const omitted = named.filter((r) => r.medianSlaMs != null && r.measuredOn < MIN_SAMPLE);
  // Say what was left out rather than silently dropping people.
  const worktimeNote = $("worktime-note");
  if (worktimeNote) {
    worktimeNote.textContent = omitted.length
      ? `${omitted.map((r) => `${r.key} (${r.measuredOn})`).join(", ")} left out — fewer than ${MIN_SAMPLE} resolved tickets.`
      : "";
  }

  drawChart("chart-worktime", {
    type: "bar",
    data: {
      labels: timed.map((r) => `${r.key} (n=${r.measuredOn})`),
      datasets: [{
        data: timed.map((r) => toHours(r.medianSlaMs)),
        backgroundColor: timed.map((r, i) => (state.meta?.me && r.email === state.meta.me ? "#17875b" : PALETTE[(i + 4) % PALETTE.length])),
        borderRadius: 3,
      }],
    },
    options: {
      indexAxis: "y",
      plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.x} working hours (median)` } } },
      scales: { x: { beginAtZero: true, title: { display: true, text: "median working hours", color: chartTextColor() } }, y: { ticks: { font: { size: 11 } } } },
    },
  });

  // Completed per month, stacked per person.
  const keyOf = axis === "assignee" ? assigneeName : ckUserName;
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
  chips.append(el("span", `chip status-${detail.statusCategory}`, detail.status));
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
      commentHead.append(el("span", "when", fmtDateTime(comment.created)));
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
  const close = el("button", "icon-button", "Close");
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
    const heading = panel.querySelector("h3");
    if (!heading || heading.dataset.zoomWired) continue;
    heading.dataset.zoomWired = "1";
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
}

// ── tabs, theme, wiring ───────────────────────────────────────────────

const TABS = ["loans", "tickets", "people", "insights"];

function switchTab(name) {
  for (const tab of TABS) {
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
    $(`view-${tab}`).hidden = tab !== name;
  }
  if (name === "insights") renderInsights();
  if (name === "tickets") renderTickets();
  if (name === "people") renderPeople();
  history.replaceState(null, "", `#${name}`);
}

function renderAll() {
  renderKpis();
  renderLoanList();
  renderLoanDetail();
  if (!$("view-tickets").hidden) renderTickets();
  if (!$("view-people").hidden) renderPeople();
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
  state.peopleSort = { column: "resolved", direction: -1 };

  $("mine-toggle").setAttribute("aria-pressed", "false");
  $("loan-search").value = "";
  $("loan-sort").value = "count";
  $("ticket-search").value = "";
  for (const id of ["filter-state", "filter-topic", "filter-priority", "filter-loan", "filter-ck", "filter-assignee"]) {
    const field = $(id);
    if (field) field.value = "";
  }
  $("people-axis").value = "ck";
  $("people-window").value = "0";

  showWarning("");
  buildLoanIndex();
  switchTab("loans");
  renderAll();
  history.replaceState(null, "", location.pathname);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function clearTicketFilters() {
  $("ticket-search").value = "";
  for (const id of ["filter-state", "filter-topic", "filter-priority", "filter-loan", "filter-ck", "filter-assignee"]) {
    const field = $(id);
    if (field) field.value = "";
  }
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

  $("mine-toggle").onclick = () => {
    state.onlyMine = !state.onlyMine;
    $("mine-toggle").setAttribute("aria-pressed", String(state.onlyMine));
    buildLoanIndex();
    state.selectedLoan = null;
    renderAll();
  };

  $("filters-clear").onclick = clearTicketFilters;
  $("people-axis").onchange = renderPeople;
  $("people-window").onchange = renderPeople;

  for (const th of document.querySelectorAll("#people-table th[data-people-sort]")) {
    th.onclick = () => {
      const column = th.dataset.peopleSort;
      const sort = state.peopleSort;
      // Counts and loans read best high-first; durations and breach rates read
      // best low-first, since "fast" is the interesting end.
      const defaultDirection = ["resolved", "open", "distinctLoans"].includes(column) ? -1 : 1;
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
  for (const id of ["filter-state", "filter-topic", "filter-priority", "filter-loan", "filter-ck", "filter-assignee"]) {
    $(id).onchange = renderTickets;
  }

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

  $("scrim").onclick = closeDrawer;
  $("chart-scrim").onclick = closeChartZoom;
  wireChartZoom();

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Innermost first: a zoomed chart opened from a panel should close before
    // the drawer that may still be open behind it.
    if (!$("chart-modal").hidden) closeChartZoom();
    else if (state.openTicket) closeDrawer();
  });

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

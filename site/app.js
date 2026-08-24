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

const API = "/api";

const state = {
  issues: [],
  loans: new Map(),      // canonical loan key -> { key, issues[], open, last, topics:Map }
  meta: null,
  selectedLoan: null,
  openTicket: null,
  ticketSort: { column: "created", direction: -1 },
  charts: {},
  detailCache: new Map(),
};

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

const isOpen = (issue) => issue.statusCategory !== "done";

/** Days a ticket took, or has been open so far. */
function ageDays(issue) {
  const from = asDate(issue.created);
  if (!from) return null;
  const to = asDate(issue.resolved) || new Date();
  return Math.max(0, Math.round((to - from) / 86400000));
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
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

async function loadIndex({ refresh = false } = {}) {
  const button = $("refresh");
  button.disabled = true;
  $("freshness").innerHTML = '<span class="spinner"></span> loading…';
  showError("");

  try {
    const response = await fetch(`${API}/ops-issues${refresh ? "?refresh=1" : ""}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);

    state.issues = data.issues || [];
    state.meta = data;
    buildLoanIndex();

    showWarning(
      data.stale
        ? `Jira could not be reached, so this is the last good copy from ${fmtDateTime(data.fetchedAt)}. ${data.warning || ""}`
        : data.truncated
        ? "The project is larger than this page fetches in one go — some older tickets are missing."
        : ""
    );

    $("brand-tag").textContent = `${data.project} · ${state.issues.length} tickets · ${state.loans.size} loans`;
    $("freshness").textContent = data.cached
      ? `cached ${relative(data.fetchedAt)}`
      : `updated ${fmtDateTime(data.fetchedAt)}`;
    $("freshness").classList.toggle("stale", Boolean(data.stale));

    renderAll();
  } catch (error) {
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
  for (const issue of state.issues) {
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
}

// ── KPIs ──────────────────────────────────────────────────────────────

function renderKpis() {
  const issues = state.issues;
  const open = issues.filter(isOpen);
  const resolvedDurations = issues.filter((i) => i.resolved).map(ageDays).filter((d) => d != null);
  const repeatLoans = [...state.loans.values()].filter((l) => l.issues.length >= 3);
  const withLoan = issues.filter((i) => (i.loans || []).length).length;

  const kpis = [
    { value: issues.length, label: "OPS tickets", note: `${withLoan} name a loan (${Math.round((withLoan / (issues.length || 1)) * 100)}%)` },
    { value: state.loans.size, label: "Loans affected", note: `${repeatLoans.length} with 3 or more tickets` },
    { value: open.length, label: "Still open", note: open.length ? `oldest raised ${relative(open.map((i) => i.created).sort()[0])}` : "nothing outstanding" },
    { value: median(resolvedDurations) ?? "—", label: "Median days to resolve", note: `across ${resolvedDurations.length} resolved` },
    { value: topKTopic(), label: "Most common issue", note: "by derived topic", small: true },
  ];

  const container = $("kpis");
  container.innerHTML = "";
  for (const kpi of kpis) {
    const card = el("div", "kpi");
    const value = el("div", "value", String(kpi.value));
    if (kpi.small) value.style.fontSize = "15px";
    card.append(value, el("div", "label", kpi.label), el("div", "note", kpi.note));
    container.append(card);
  }
}

function topKTopic() {
  const counts = new Map();
  for (const issue of state.issues) counts.set(issue.topic, (counts.get(issue.topic) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? `${topicLabel(top[0])} (${top[1]})` : "—";
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
    date.append(el("span", null, `· resolved in ${days} day${days === 1 ? "" : "s"}`));
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

function populateFilters() {
  const topicSelect = $("filter-topic");
  if (topicSelect.options.length) return;

  topicSelect.append(new Option("Any topic", ""));
  const present = new Set(state.issues.map((i) => i.topic));
  for (const topic of [...TOPICS, UNCATEGORISED]) {
    if (present.has(topic.id)) topicSelect.append(new Option(topic.label, topic.id));
  }

  const prioritySelect = $("filter-priority");
  prioritySelect.append(new Option("Any priority", ""));
  for (const priority of [...new Set(state.issues.map((i) => i.priority))].sort()) {
    prioritySelect.append(new Option(priority, priority));
  }
}

function filteredTickets() {
  const query = $("ticket-search").value.trim().toLowerCase();
  const stateFilter = $("filter-state").value;
  const topic = $("filter-topic").value;
  const priority = $("filter-priority").value;
  const loanFilter = $("filter-loan").value;

  return state.issues.filter((issue) => {
    if (stateFilter === "open" && !isOpen(issue)) return false;
    if (stateFilter === "done" && isOpen(issue)) return false;
    if (topic && issue.topic !== topic) return false;
    if (priority && issue.priority !== priority) return false;
    if (loanFilter === "with" && !(issue.loans || []).length) return false;
    if (loanFilter === "without" && (issue.loans || []).length) return false;
    if (query) {
      const haystack = `${issue.key} ${issue.summary} ${issue.preview} ${(issue.loans || []).join(" ")} ${(issue.components || []).join(" ")}`.toLowerCase();
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

    const statusCell = document.createElement("td");
    statusCell.append(el("span", `chip status-${issue.statusCategory}`, issue.status));
    tr.append(statusCell);

    const priorityCell = document.createElement("td");
    priorityCell.append(el("span", `chip prio-${issue.priority}`, issue.priority));
    tr.append(priorityCell);

    const days = ageDays(issue);
    tr.append(cell("date", days == null ? "—" : isOpen(issue) ? `${days} open` : String(days)));

    body.append(tr);
  }

  if (rows.length > LIMIT) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.style.cssText = "text-align:center;color:var(--text-muted);font-size:12.5px";
    td.textContent = `Showing the first ${LIMIT} of ${rows.length}. Narrow the filters to see the rest.`;
    tr.append(td);
    body.append(tr);
  }

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
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

function drawChart(id, config) {
  if (typeof window.Chart === "undefined") return;
  state.charts[id]?.destroy();
  const canvas = $(id);
  if (!canvas) return;
  const text = chartTextColor();
  const grid = chartGridColor();
  state.charts[id] = new window.Chart(canvas, {
    ...config,
    options: {
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
    },
  });
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

  // Facts.
  const facts = el("div", "section");
  facts.append(el("h3", null, "Detail"));
  const grid = el("div", "facts");
  const addFact = (label, value) => {
    const fact = el("div", "fact");
    fact.append(el("div", "k", label), el("div", "v", value || "—"));
    grid.append(fact);
  };
  addFact("Raised", `${fmtDate(detail.created)} · ${relative(detail.created)}`);
  addFact(detail.resolved ? "Resolved" : "Last updated", detail.resolved ? `${fmtDate(detail.resolved)} · took ${ageDays(detail)} days` : `${fmtDate(detail.updated)} · open ${ageDays(detail)} days`);
  addFact("Reported by", detail.reporter);
  addFact("Assigned to", detail.assignee);
  addFact("Type", detail.type);
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
  const box = el("div", `summary-box ${source === "authored" ? "authored" : source === "none" ? "empty" : "extracted"}`);
  box.textContent =
    summary.text ||
    (kind === "fix"
      ? "Nothing in this thread reads like a resolution. If you know what fixed it, write it here — it saves the next person the read."
      : "No description was given.");
  section.append(box);

  const provenance = el("div", `provenance ${source === "authored" ? "authored" : source === "none" ? "none" : "extracted"}`);
  provenance.append(el("span", "dot"));
  const describe = {
    authored: `Written by ${summary.author || "someone"}${summary.created ? ` · ${fmtDate(summary.created)}` : ""}`,
    extracted: `Pulled from ${summary.author ? `${summary.author}'s ` : "a "}comment${summary.created ? ` of ${fmtDate(summary.created)}` : ""} — not written for this purpose${summary.confidence === "low" ? ", and a weak match" : ""}`,
    description: "Taken from the reporter's own description",
    summary: "Taken from the ticket title",
    none: "Not recorded",
  };
  provenance.append(el("span", null, describe[source] || source));
  section.append(provenance);

  const editLabel =
    summary.source === "authored"
      ? "Rewrite"
      : kind === "fix"
      ? "Write the fix in your own words"
      : "Summarise it yourself";
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

// ── tabs, theme, wiring ───────────────────────────────────────────────

const TABS = ["loans", "tickets", "insights"];

function switchTab(name) {
  for (const tab of TABS) {
    $(`tab-${tab}`).setAttribute("aria-selected", String(tab === name));
    $(`view-${tab}`).hidden = tab !== name;
  }
  if (name === "insights") renderInsights();
  if (name === "tickets") renderTickets();
  history.replaceState(null, "", `#${name}`);
}

function renderAll() {
  renderKpis();
  renderLoanList();
  renderLoanDetail();
  if (!$("view-tickets").hidden) renderTickets();
  if (!$("view-insights").hidden) renderInsights();
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
}

function init() {
  try {
    const saved = localStorage.getItem("opstracker-theme");
    if (saved) document.documentElement.dataset.theme = saved;
  } catch { /* ignore */ }

  for (const tab of TABS) $(`tab-${tab}`).onclick = () => switchTab(tab);
  const fromHash = location.hash.slice(1);
  if (TABS.includes(fromHash)) switchTab(fromHash);

  $("refresh").onclick = () => {
    state.detailCache.clear();
    loadIndex({ refresh: true });
  };

  $("theme-toggle").onclick = () => {
    const current = document.documentElement.dataset.theme;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(current === "dark" ? "light" : current === "light" ? "dark" : prefersDark ? "light" : "dark");
  };

  $("loan-search").oninput = debounce(renderLoanList, 140);
  $("loan-sort").onchange = renderLoanList;

  $("ticket-search").oninput = debounce(renderTickets, 140);
  for (const id of ["filter-state", "filter-topic", "filter-priority", "filter-loan"]) $(id).onchange = renderTickets;

  for (const th of document.querySelectorAll("th.sortable")) {
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
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.openTicket) closeDrawer();
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

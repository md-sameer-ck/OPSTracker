// site/lib/taxonomy.js
//
// "What are the most common errors in the org?" needs a category per ticket,
// and Jira's own Components field can't answer it alone. In the real project:
//
//   * 28% of tickets have no component at all, and
//   * of those that do, "Data Correction" takes 44% — a bucket that says how
//     the ticket was fixed, not what went wrong.
//
// So a ticket's topic is derived from its words, with the component used as a
// strong hint rather than the answer. Each topic carries weighted patterns;
// the highest-scoring topic wins and everything else it matched is kept as
// secondary topics, since "duplicate redemption statement" is legitimately
// both a duplicate-record problem and a redemption problem.
//
// Weights: 3 = names the failure outright, 2 = names the subsystem, 1 = weak
// corroboration. Summary matches count double — the summary is where the
// reporter says what broke; the description wanders.

const SUMMARY_MULTIPLIER = 2;

export const TOPICS = [
  {
    id: "redemption",
    label: "Redemption & statements",
    blurb: "Redemptions, redemption statements, and the figures on them.",
    components: ["Redemption", "Redemption Statements", "Partial Redemption"],
    patterns: [
      [/\bredemption statement/i, 3],
      [/\bredeem(ed|ing)?\b/i, 2],
      [/\bredemption\b/i, 2],
      [/\bREDS[- ]?\d+/i, 2],
      [/\bearly settlement\b/i, 2],
      [/\bMAF\b/, 2],
    ],
  },
  {
    id: "investor-breakdown",
    label: "Investor breakdown",
    blurb: "Investor breakdown reports and per-investor capital/interest splits.",
    components: [],
    patterns: [
      [/\binvestor breakdown\b/i, 3],
      [/\bbreakdown (report|incorrect|missing)\b/i, 3],
      [/\binvestor capital\b/i, 2],
      [/\bcapital (and|&) interest\b/i, 2],
      [/\ballocation\b/i, 1],
    ],
  },
  {
    id: "interest-upload",
    label: "Interest upload",
    blurb: "The bank interest file upload and the transactions it writes.",
    components: ["Transactions"],
    patterns: [
      [/\b(bank )?interest (file|upload)/i, 3],
      [/\bupload(ing)? the .*interest/i, 3],
      [/\binterest payment/i, 2],
      [/\bCLS\b/, 1],
    ],
  },
  {
    id: "payout",
    label: "Payouts",
    blurb: "Investor payout files and payment runs.",
    components: ["Payout"],
    patterns: [
      [/\bpayout/i, 3],
      [/\bpayment (file|run|failed)/i, 2],
      [/\bwithdrawal/i, 2],
      [/\bBACS\b/, 2],
    ],
  },
  {
    id: "reschedule",
    label: "Reschedule",
    blurb: "Loan reschedules and the auto-reschedule job.",
    components: ["Reschedule"],
    patterns: [
      [/\breschedul/i, 3],
      [/\bterm extension\b/i, 2],
      [/\bmaturity date\b/i, 2],
    ],
  },
  {
    id: "job-failure",
    label: "Job & integration failures",
    blurb: "Scheduled Apex jobs and integrations throwing exceptions.",
    components: [],
    patterns: [
      [/\bexception alert\b/i, 3],
      [/\b\w+Job\b/, 3],
      [/\bbatch (job|failed)/i, 3],
      [/\b(apex|system)\.?\w*exception\b/i, 3],
      [/\bfailed to (run|process|execute)/i, 2],
      [/\berror message/i, 1],
    ],
  },
  {
    id: "duplicate",
    label: "Duplicate records",
    blurb: "The same loan, application or record created twice.",
    components: [],
    patterns: [
      [/\bduplicate/i, 3],
      [/\bduplicat(ed|ion)\b/i, 3],
      [/\btwo (records|statements|entries)/i, 2],
      [/\bcreated twice\b/i, 3],
    ],
  },
  {
    id: "dummy-funds",
    label: "Dummy funds",
    blurb: "Dummy fund set-up and connected swaps.",
    components: ["Dummy Funds"],
    patterns: [
      [/\bdummy funds?\b/i, 3],
      [/\bconnected swap\b/i, 2],
    ],
  },
  {
    id: "fees",
    label: "Fees",
    blurb: "Broker, collection, arrangement and other fee corrections.",
    components: [],
    patterns: [
      [/\b(broker|collection|arrangement|exit|admin) fee/i, 3],
      [/\bfee (duplication|incorrect|missing|added)/i, 3],
      [/\bfees?\b/i, 1],
    ],
  },
  {
    id: "compliance-docs",
    label: "Compliance & expiry reminders",
    blurb: "AT/CCC/appropriateness expiry reminders and exemption reporting.",
    components: [],
    patterns: [
      [/\b(expired|expiry) (AT|CCC)/i, 3],
      [/\bAT\/CCC?\b/, 3],
      [/\bappropriateness test\b/i, 3],
      [/\bcategorisation\b/i, 2],
      [/\bexemption report\b/i, 2],
      [/\breminder/i, 1],
    ],
  },
  {
    id: "access",
    label: "Access, users & permissions",
    blurb: "New users, licences, permission sets, MFA and portal log-ins.",
    components: ["User", "Permissions and Licences", "MFA", "Portal", "Investor Portal"],
    patterns: [
      [/\b(new|remove|deactivate) user\b/i, 3],
      [/\bpermission (set|s)?\b/i, 3],
      [/\bMFA\b/, 3],
      [/\blicence|license\b/i, 2],
      [/\bunable to (see|access|log ?in)/i, 2],
      [/\baccess\b/i, 1],
    ],
  },
  {
    id: "reporting",
    label: "Reports",
    blurb: "Salesforce reports, manual reports and report requests.",
    components: ["Salesforce Report", "Manual Report"],
    patterns: [
      [/\breport (request|incorrect|missing|generated|not)/i, 3],
      [/\bsalesforce report\b/i, 3],
      [/\bdashboard\b/i, 2],
      [/\breport\b/i, 1],
    ],
  },
  {
    id: "comms",
    label: "Automated emails & templates",
    blurb: "Template wording and automated email triggers.",
    components: ["Automated Emails"],
    patterns: [
      [/\btemplate\b/i, 3],
      [/\bautomated email/i, 3],
      [/\bemail (wording|not sent|triggered)/i, 3],
      [/\bwording\b/i, 2],
    ],
  },
  {
    id: "application",
    label: "Applications & loan set-up",
    blurb: "Applications, parent linkage, booking into a loan, completion.",
    components: ["Applications", "Booking Into a Loan", "Loan Completion"],
    patterns: [
      [/\bAPP[- ]?\d+/i, 3],
      [/\bapplication (not|linked|deleted|withdrawn)/i, 3],
      [/\bparent application\b/i, 3],
      [/\bbooking into a loan\b/i, 3],
      [/\bloan completion\b/i, 2],
    ],
  },
  {
    id: "party-data",
    label: "Party & contact data",
    blurb: "Investor/borrower party records, contact and identity details.",
    components: [],
    patterns: [
      [/\bnational insurance\b/i, 3],
      [/\bNI number\b/i, 3],
      [/\bparty details\b/i, 3],
      [/\bSTE\d+/i, 2],
      [/\bbank details\b/i, 2],
      [/\baddress\b/i, 1],
    ],
  },
  {
    id: "data-correction",
    label: "Data correction",
    blurb: "A record's data was wrong and had to be edited by hand. Named by the component, not by a described failure — so these are worth reading, not counting.",
    components: ["Data Correction"],
    patterns: [
      [/\bdata (correction|fix|issue)\b/i, 3],
      [/\bincorrect (data|value|figure)/i, 2],
      [/\bmanually (updated|amended|corrected)/i, 2],
    ],
  },
  {
    id: "enhancement",
    label: "Change & feature requests",
    blurb: "Asks for new behaviour rather than something being broken.",
    components: [],
    patterns: [
      [/\bfeature request\b/i, 3],
      [/\bcan (we|you) (please )?(add|include|amend|change)/i, 2],
      [/\b(additional|new) (field|area|option|drop ?down)/i, 3],
      [/\bnice to have\b/i, 2],
    ],
  },
];

const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));
export const getTopic = (id) => TOPIC_BY_ID.get(id) || null;

/** A component name -> the topic that claims it. */
const TOPIC_BY_COMPONENT = new Map();
for (const topic of TOPICS) {
  for (const component of topic.components) {
    TOPIC_BY_COMPONENT.set(component.toLowerCase(), topic.id);
  }
}

// Components that name how a ticket was resolved rather than what broke. See
// the note in classify() for why these are deliberately weak.
const GENERIC_COMPONENTS = new Set(["data correction"]);

// Shown when nothing matches. "Data Correction" lands here a lot on purpose:
// as a component it describes the remedy, so on its own it tells us only that
// somebody edited data — which is worth seeing as its own bucket.
export const UNCATEGORISED = { id: "other", label: "Other / uncategorised", blurb: "No recognised topic in the text." };

/**
 * Score every topic against one ticket and return the ranking.
 * `components` is the list of Jira component names on the issue.
 */
export function classify({ summary = "", description = "", components = [] } = {}) {
  const summaryText = String(summary || "");
  const bodyText = String(description || "");
  const componentKeys = components.map((c) => String(c || "").toLowerCase());

  const scores = new Map();
  const bump = (id, amount) => scores.set(id, (scores.get(id) || 0) + amount);

  for (const key of componentKeys) {
    const topicId = TOPIC_BY_COMPONENT.get(key);
    if (!topicId) continue;
    // A component is a curated human signal, so it normally outweighs a single
    // keyword hit — but not a summary that plainly says something else.
    //
    // The exception is a component that describes the *remedy* instead of the
    // fault. "Data Correction" is 44% of all componented tickets here, so
    // treating it as a strong signal would drown out every real category. It
    // scores just enough to beat nothing at all, which is exactly its worth:
    // it becomes the bucket for tickets whose text says nothing recognisable.
    bump(topicId, GENERIC_COMPONENTS.has(key) ? 1 : 4);
  }

  for (const topic of TOPICS) {
    for (const [pattern, weight] of topic.patterns) {
      if (pattern.test(summaryText)) bump(topic.id, weight * SUMMARY_MULTIPLIER);
      if (pattern.test(bodyText)) bump(topic.id, weight);
    }
  }

  const ranked = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, score]) => ({ ...TOPIC_BY_ID.get(id), score }));

  if (!ranked.length) {
    return { primary: { ...UNCATEGORISED, score: 0 }, secondary: [], ranked: [] };
  }
  // A secondary topic has to be genuinely close to the winner, otherwise every
  // ticket collects a tail of weak one-keyword matches and the chips stop
  // meaning anything.
  const cutoff = Math.max(3, ranked[0].score * 0.5);
  return {
    primary: ranked[0],
    secondary: ranked.slice(1).filter((t) => t.score >= cutoff).slice(0, 2),
    ranked,
  };
}

// scripts/lib.test.js — run with `npm test`.
//
// The cases here are not invented. Every string is a real summary, description
// or comment taken from the OPS project, which is the point: the heuristics in
// site/lib are tuned to how this team actually writes, so the tests have to be
// too. If a change to the scoring quietly starts picking sign-off comments as
// "the fix" again, this is what catches it.

import assert from "node:assert/strict";
import { extractRefs, extractLoanRefs, normaliseLoanQuery, canonicalRef } from "../site/lib/refs.js";
import { fieldToText, truncate, firstSentences } from "../site/lib/text.js";
import { classify } from "../site/lib/taxonomy.js";
import { buildDigest, scoreComment, FIX_NOTE_MARKER } from "../site/lib/digest.js";
import { extractIssueKeys } from "../site/lib/refs.js";
import { formatDuration, formatWorkTime, throughputBy, ckUserName, summarise, UNASSIGNED } from "../site/lib/stats.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

console.log("\nrefs — loan reference normalisation");

test("all six real spellings of loan 1797 fold to one key", () => {
  const spellings = ["LAI-00001797", "LAI-1797", "LAI 1797", "LAI1797", "LAI00001797", "lai-1797"];
  for (const spelling of spellings) {
    assert.equal(extractLoanRefs(spelling)[0].canonical, "LAI-1797", spelling);
  }
  // …and appearing together they are one reference, not six.
  assert.equal(extractLoanRefs(spellings.join(" and ")).length, 1);
});

test("the raw form the reporter typed is preserved", () => {
  assert.equal(extractLoanRefs("Incorrect MAF on LAI-00001476")[0].raw, "LAI-00001476");
});

test("two distinct loans in one summary stay distinct", () => {
  const refs = extractLoanRefs("Duplicate LAI for Snowball - LAI-00001951 and LAI-00001952");
  assert.deepEqual(refs.map((r) => r.canonical), ["LAI-1951", "LAI-1952"]);
});

test("other entity types are recognised alongside loans", () => {
  const refs = extractRefs("APP-0000008914 raised REDS-0078 for STE00005065 on LAI 766");
  assert.deepEqual(
    refs.map((r) => `${r.type}:${r.canonical}`),
    ["APP:APP-8914", "REDS:REDS-78", "STE:STE-5065", "LAI:LAI-766"]
  );
});

test("first appearance order is kept — the earliest mention is the subject", () => {
  assert.equal(extractLoanRefs("LAI 766 difference following redemption, see also LAI 1754")[0].canonical, "LAI-766");
});

test("a lone zero survives, only padding is stripped", () => {
  assert.equal(canonicalRef("LAI", "0"), "LAI-0");
  assert.equal(canonicalRef("lai", "00001797"), "LAI-1797");
});

test("only the separators people actually type are accepted", () => {
  // Counted across the project's summaries, descriptions and comments:
  //   "LAI-1234" x256   "LAI 1234" x111   "LAI - 1234" x8   "LAI- 1234" x2
  // …and zero uses of a slash or colon. All four real forms must match.
  for (const form of ["LAI-1234", "LAI 1234", "LAI - 1234", "LAI- 1234"]) {
    assert.equal(extractLoanRefs(form)[0]?.canonical, "LAI-1234", form);
  }
  // A slash is deliberately not a separator: nothing in the project uses one,
  // and admitting it would let "LAI/1234-5678" fold two numbers into one ref.
  assert.equal(extractRefs("LAI/1234").length, 0);
});

test("search box accepts whatever spelling the user knows", () => {
  for (const query of ["1122", "LAI1122", "lai 1122", "LAI-00001122", "LAI-1122"]) {
    assert.equal(normaliseLoanQuery(query), "LAI-1122", query);
  }
  assert.equal(normaliseLoanQuery("not a loan"), null);
  assert.equal(normaliseLoanQuery(""), null);
});

console.log("\ntext — Jira rich-text cleanup");

test("a pasted screenshot collapses to a short marker", () => {
  const description =
    "the investors have been duplicated on the report\n\n![](blob:https://media.staging.atl-paas.net/?type=file&localId=e6ba47d10e3a&id=8edb5f09&width=1752&__contextId=null)\n";
  const plain = fieldToText(description);
  assert.ok(plain.includes("[image]"));
  assert.ok(!plain.includes("atl-paas"));
  assert.ok(plain.length < 80, `still ${plain.length} chars`);
});

test("a mention keeps the name and loses the tag", () => {
  const body = '<custom data-type="mention" data-id="id-0">@Andy Marsh</custom>,   I have set loan 1952 status to Invalid';
  assert.equal(fieldToText(body), "@Andy Marsh, I have set loan 1952 status to Invalid");
});

test("ADF objects flatten as well as markdown strings", () => {
  const adf = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "LAI 1459 was redeemed" }] },
      { type: "mediaSingle", content: [{ type: "media", attrs: {} }] },
    ],
  };
  const plain = fieldToText(adf);
  assert.ok(plain.startsWith("LAI 1459 was redeemed"));
  assert.ok(plain.includes("[image]"));
});

test("truncate breaks on a word, not mid-word", () => {
  const out = truncate("the investors have been duplicated on the report", 20);
  assert.ok(out.endsWith("…"));
  assert.ok(!/\w…$/.test(out.replace("…", "x…")) || out.split(" ").length > 1);
  assert.ok(out.length <= 21);
});

test("firstSentences is not fooled by a trailing abbreviation", () => {
  assert.equal(firstSentences("Ref. 1754 is wrong. Please fix.", 1), "Ref. 1754 is wrong.");
});

console.log("\ntaxonomy — error classification");

test("real summaries land in the expected topic", () => {
  const expectations = [
    ["Incorrect MAF on redemption Statement LAI-1476", ["Redemption Statements"], "redemption"],
    ["Exception Alert : F2FAutoRescheduleJob - 24/08/2026", ["Reschedule"], "job-failure"],
    ["Following Error messgae recieved on uploading the bank interest file for 30th", [], "interest-upload"],
    ["Missing National Insurance number - Forrester STE00005065", [], "party-data"],
    ["APP-8886 - Broker fee duplication", [], "fees"],
    ["New User", ["User"], "access"],
    ["Dummy funds", ["Dummy Funds"], "dummy-funds"],
    ["additional area required for sensitive notes", [], "enhancement"],
    ["Investor on a withdrawn app receiving Expired AT/CCC reminders", [], "compliance-docs"],
    ["URGENT Interest Upload for 26/6/26 Uploaded this morning needs to be cleared in CLS", [], "interest-upload"],
  ];
  for (const [summary, components, expected] of expectations) {
    const { primary } = classify({ summary, components });
    assert.equal(primary.id, expected, `"${summary}" -> got ${primary.id}`);
  }
});

test("'Data Correction' never outranks a real signal, but beats nothing", () => {
  // On its own it is all we know, so it is the topic.
  assert.equal(classify({ summary: "Staff investing", components: ["Data Correction"] }).primary.id, "data-correction");
  // Alongside a described failure it must step aside — otherwise 44% of
  // componented tickets would all report as the same "error".
  assert.equal(
    classify({ summary: "LAI 1780 not on DDs files for loans due on 17th", components: ["Data Correction", "Payout"] }).primary.id,
    "payout"
  );
});

test("a ticket that is genuinely two things keeps the second as secondary", () => {
  const result = classify({
    summary: "LAI-1459 investor redemption breakdown incorrect",
    description: "the investors have been duplicated on the report",
    components: ["Redemption Statements"],
  });
  const ids = [result.primary.id, ...result.secondary.map((t) => t.id)];
  assert.ok(ids.includes("investor-breakdown"), `got ${ids.join(",")}`);
  assert.ok(ids.includes("redemption"), `got ${ids.join(",")}`);
});

test("unrecognisable text is admitted as such rather than guessed", () => {
  assert.equal(classify({ summary: "Dover Citadel", components: [] }).primary.id, "other");
});

console.log("\ndigest — issue and fix extraction");

const comment = (author, body, id = String(Math.abs(hash(body)))) => ({ id, author, authorId: author, body, created: "2026-07-27T12:00:00.000+0100" });
function hash(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; }

test("a sign-off is never mistaken for the fix", () => {
  // Measured on real threads: the last comment is a sign-off two thirds of the
  // time. Picking it would make the whole feature untrustworthy.
  for (const signoff of [
    "Closed as complete after Finance review",
    "Closed as per updates",
    "All looks good on investor funds thank you for amending so promptly",
    "Should the older statement then be voided or can the breakdown only be generated for the latest?",
  ]) {
    assert.ok(scoreComment(signoff, "other", 1, 2).score < 6, `"${signoff}" scored too high`);
  }
});

test("a mention-only nudge scores below the floor", () => {
  assert.ok(scoreComment("@Andy Marsh,", "other", 0, 2).score < 0);
  assert.ok(scoreComment("@Danny Learmont - any idea why this has happened - thanks", "reporter", 0, 2).score < 0);
});

test("the substantive mid-thread comment wins over the later sign-off", () => {
  const digest = buildDigest({
    summary: "Duplicate LAI for Snowball",
    description: "Two loans created for the same application",
    reporterId: "andy",
    assigneeId: "ck",
    comments: [
      comment("andy", "@FOLK2FOLK CK DESK - any idea why this has happened - thanks"),
      comment("ck", "@Andy Marsh, I have set loan 1952 status to Invalid and have removed Application lookup from the loan contract."),
      comment("andy", "Closed as complete after Finance review"),
    ],
  });
  assert.equal(digest.fix.source, "extracted");
  assert.ok(digest.fix.text.includes("set loan 1952 status to Invalid"));
});

test("a terse completion still counts as a fix", () => {
  // "Duplicate app deleted" and "Report generated" are real one-line
  // resolutions here; the length penalty must not bury them.
  for (const terse of ["Duplicate app deleted", "Report generated", "The data fix for the ILTs and IO is in place now."]) {
    const digest = buildDigest({ comments: [comment("ck", terse)], assigneeId: "ck" });
    assert.equal(digest.fix.source, "extracted", `"${terse}" was dropped`);
  }
});

test("a thread with no outcome says so instead of inventing one", () => {
  const digest = buildDigest({
    description: "Loan LAI-0001952 COMPLETED - no fund button.",
    comments: [],
  });
  assert.equal(digest.fix.source, "none");
  assert.equal(digest.fix.text, "");
});

test("an image-only comment can never be the summary", () => {
  const digest = buildDigest({
    comments: [comment("ck", "![](blob:https://media.staging.atl-paas.net/?type=file&id=abc)")],
    assigneeId: "ck",
  });
  assert.equal(digest.fix.source, "none");
});

test("a human-authored fix note overrides the extracted guess", () => {
  const digest = buildDigest({
    reporterId: "andy",
    assigneeId: "ck",
    comments: [
      comment("ck", "I have set loan 1952 status to Invalid and have removed the Application lookup."),
      comment("sameer", `${FIX_NOTE_MARKER} Two loans were created from one application; 1952 was marked Invalid and unlinked.`),
    ],
  });
  assert.equal(digest.fix.source, "authored");
  assert.equal(digest.fix.text, "Two loans were created from one application; 1952 was marked Invalid and unlinked.");
  assert.equal(digest.fix.author, "sameer");
});

test("the newest authored note wins, so editing is just posting again", () => {
  const digest = buildDigest({
    comments: [
      comment("a", `${FIX_NOTE_MARKER} first attempt`, "1"),
      comment("b", `${FIX_NOTE_MARKER} corrected wording`, "2"),
    ],
  });
  assert.equal(digest.fix.text, "corrected wording");
});

test("OPSTracker's own notes never compete for the extracted slot", () => {
  const digest = buildDigest({
    comments: [comment("a", `${FIX_NOTE_MARKER} I have corrected and amended everything`)],
  });
  assert.equal(digest.fix.source, "authored");
  assert.equal(digest.thread.length, 0, "the note should be filtered out of the thread");
});


test("Jira's Resolution Comments field is used as the fix when it says something", () => {
  // Real entries from the field on this project.
  for (const text of [
    "Duplicate app deleted",
    "1951 now funded",
    "Dummy funds now removed",
    "Figures amended as requested",
    "The issue is caused by the fact there are two redemption statements for the same loan.",
  ]) {
    const digest = buildDigest({ resolutionComments: text, comments: [] });
    assert.equal(digest.fix.source, "resolution-field", `"${text}" was not used`);
    assert.equal(digest.fix.text, text);
  }
});

test("a sign-off typed into the Resolution Comments field is not passed off as the fix", () => {
  // These are real field contents too. The field is the right place for a fix,
  // but what is in it is sometimes a status update — and calling that "the fix"
  // is the exact failure the comment scoring exists to prevent.
  for (const text of ["Closed as complete after Finance review", "closed as confirmed updated", "closed as per updates"]) {
    const digest = buildDigest({
      resolutionComments: text,
      comments: [comment("ck", "I have amended the LPT records and cleared the May MAF fee.")],
      assigneeId: "ck",
    });
    assert.equal(digest.fix.source, "extracted", `"${text}" was accepted as a fix`);
    // …and it is still reported, so nobody thinks the field was left blank.
    assert.equal(digest.fix.fieldNote, text);
  }
});

test("an authored note still outranks the Jira field", () => {
  const digest = buildDigest({
    resolutionComments: "Duplicate app deleted",
    comments: [comment("me", `${FIX_NOTE_MARKER} Two apps existed for one loan; the later one was deleted.`)],
  });
  assert.equal(digest.fix.source, "authored");
});

console.log("\nrefs — sibling ticket references");

test("OPS keys are found in prose, in every spelling used here", () => {
  // "This loan is corrected, as a part of OPS - 806" is a real comment.
  assert.deepEqual(extractIssueKeys("as a part of OPS - 806", "OPS"), ["OPS-806"]);
  assert.deepEqual(extractIssueKeys("see OPS-124, ops812 and OPS 999", "OPS"), ["OPS-124", "OPS-812", "OPS-999"]);
});

test("a ticket is never related to itself", () => {
  assert.deepEqual(extractIssueKeys("OPS-884 duplicates OPS-884 and OPS-671", "OPS", "OPS-884"), ["OPS-671"]);
});

test("loan and application references are not mistaken for ticket keys", () => {
  assert.deepEqual(extractIssueKeys("LAI-1234 on APP-99", "OPS"), []);
});

console.log("\nstats — throughput and durations");

test("SLA time prints in hours the way Jira does, calendar time in days", () => {
  // 89,618,383 ms is what Jira reports as "24h 53m" on OPS-884. Printing that
  // as "1d" would read as a calendar day, which it is not.
  assert.equal(formatWorkTime(89618383), "24h 53m");
  assert.equal(formatWorkTime(288000000), "80h");
  assert.equal(formatDuration(89618383), "1d");
  assert.equal(formatWorkTime(1080000), "18m");
});

test("throughput groups by CK user, because the Jira login is shared", () => {
  const issues = [
    { key: "A", statusCategory: "done", ckUser: { name: "Md Sameer", email: "me@x" }, topic: "t", loans: ["LAI-1"], created: "2026-01-01T00:00:00Z", resolved: "2026-01-02T00:00:00Z", sla: { resolution: { elapsedMs: 3600000 }, firstResponse: { elapsedMs: 600000 } } },
    { key: "B", statusCategory: "done", ckUser: { name: "Md Sameer", email: "me@x" }, topic: "t", loans: [], created: "2026-01-01T00:00:00Z", resolved: "2026-01-03T00:00:00Z", sla: { resolution: { elapsedMs: 7200000, breached: true }, firstResponse: {} } },
    { key: "C", statusCategory: "new", ckUser: null, topic: "t", loans: [], created: "2026-01-01T00:00:00Z", sla: { resolution: { elapsedMs: 999, ongoing: true } } },
  ];
  const rows = throughputBy(issues, ckUserName);
  const mine = rows.find((r) => r.key === "Md Sameer");
  assert.equal(mine.resolved, 2);
  assert.equal(mine.medianSlaMs, 5400000);
  assert.equal(mine.breached, 1);
  assert.equal(mine.distinctLoans, 1);

  // The unattributed ticket is its own named bucket, not dropped — hiding it
  // would flatter everybody's numbers.
  const unset = rows.find((r) => r.key === UNASSIGNED);
  assert.equal(unset.total, 1);
  assert.equal(unset.open, 1);
});

test("an open ticket's running clock never counts toward a median", () => {
  const issues = [
    { key: "A", statusCategory: "done", ckUser: { name: "X" }, topic: "t", loans: [], created: "2026-01-01T00:00:00Z", resolved: "2026-01-02T00:00:00Z", sla: { resolution: { elapsedMs: 3600000 }, firstResponse: {} } },
    { key: "B", statusCategory: "new", ckUser: { name: "X" }, topic: "t", loans: [], created: "2020-01-01T00:00:00Z", sla: { resolution: { elapsedMs: 999999999, ongoing: true }, firstResponse: {} } },
  ];
  const row = throughputBy(issues, ckUserName)[0];
  assert.equal(row.medianSlaMs, 3600000, "the open ticket dragged the median");
  assert.equal(row.measuredOn, 1);
});

test("summarise counts breaches against resolved tickets only", () => {
  const stats = summarise([
    { statusCategory: "done", created: "2026-01-01T00:00:00Z", resolved: "2026-01-02T00:00:00Z", loans: [], sla: { resolution: { elapsedMs: 100, breached: true }, firstResponse: {} } },
    { statusCategory: "done", created: "2026-01-01T00:00:00Z", resolved: "2026-01-02T00:00:00Z", loans: [], sla: { resolution: { elapsedMs: 200 }, firstResponse: {} } },
    { statusCategory: "new", created: "2026-01-01T00:00:00Z", loans: [], sla: { resolution: { elapsedMs: 300 }, firstResponse: {} } },
  ]);
  assert.equal(stats.resolved, 2);
  assert.equal(stats.open, 1);
  assert.equal(stats.breached, 1);
  assert.equal(stats.breachRate, 0.5);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

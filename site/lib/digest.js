// site/lib/digest.js
//
// Turning a ticket into the two lines somebody actually wants: what broke, and
// what fixed it.
//
// The OPS project has no resolution-notes field, so the fix is somewhere in the
// comment thread — and it is reliably *not* the last comment. Measured across
// the resolved LAI tickets in this project, the final comment is a sign-off
// two thirds of the time ("Closed as complete after Finance review", "thank you
// for amending so promptly", median length 44 characters). The real answer sits
// mid-thread and reads like this:
//
//   "I have set loan 1952 status to Invalid and have removed the Application
//    lookup from the loan contract."
//
// So each comment is scored on how much it sounds like an explanation or an
// action taken, minus how much it sounds like a pleasantry, and the winner is
// offered as the *suggested* fix — clearly labelled as extracted, never as
// authored. Anyone can overwrite it, and that authored version always wins.

import { fieldToText, firstSentences, truncate } from "./text.js";

// A fix summary that a human wrote is stored back on the Jira issue as a
// comment carrying this marker, so the tracker needs no database of its own and
// the whole team sees the same text. Read side and write side share the string.
export const FIX_NOTE_MARKER = "[OPSTracker] Fix summary:";
export const ISSUE_NOTE_MARKER = "[OPSTracker] Issue summary:";

/** Someone did something concrete. The strongest evidence of a fix. */
const ACTION_PATTERNS = [
  [/\b(?:i|we)(?:'ve| have)? (?:now )?(?:set|removed|amended|corrected|updated|deleted|voided|cleared|reprocessed|regenerated|re-?run|reverted|restored|added|created|uploaded|fixed|resolved)\b/i, 6],
  [/\bhas (?:now )?been (?:set|removed|amended|corrected|updated|deleted|voided|cleared|reprocessed|regenerated|generated|processed|fixed|resolved|added)\b/i, 6],
  [/\b(?:have|has) been (?:actioned|completed|applied|deployed)\b/i, 5],
  [/\b(?:voided|deleted|amended|corrected|reprocessed|regenerated)\b/i, 3],
  [/\bdeployed to (?:prod|production|uat)\b/i, 4],
  [/\bimmediate fix\b/i, 5],
  [/\bworkaround\b/i, 4],
  [/\bdata fix\b/i, 5],
  [/\b(?:is|are) (?:now )?(?:in place|complete|completed|done|sorted|fixed|resolved|corrected)\b/i, 6],
  // A terse completion is still a fix. This project is full of them — "Duplicate
  // app deleted", "Report generated" — and they lose the substance bonus badly
  // for being short, so they need their own way of clearing the floor.
  [/^(?!\s*(?:closed?|thanks?|thank you|noted|fyi)\b)(?:\w+[ ,]+){0,5}(?:deleted|generated|created|removed|added|amended|corrected|updated|voided|cleared|fixed|resolved|reversed|completed|actioned|processed|funded|restored|cancelled|done)\b[^?]{0,40}$/i, 10],
];

/** Someone explained the cause. Almost as valuable as the action itself. */
const EXPLANATION_PATTERNS = [
  [/\b(?:root cause|caused by|the cause)\b/i, 6],
  [/\bthis (?:has )?happened because\b/i, 6],
  [/\bthe reason (?:for |is |being )/i, 5],
  [/\bbecause\b/i, 2],
  [/\bwhich (?:means|is why)\b/i, 2],
  [/\bas (?:this|the) (?:report|record|loan|statement)\b/i, 3],
  [/\bin theory\b/i, 2],
  [/\b(?:2|3|two|three) .{0,30}(?:have been|were) created\b/i, 4],
];

/** Sign-offs, chasers and questions — the things that are not a fix. */
const NOISE_PATTERNS = [
  // Any "closed as …" is a status sign-off, whatever follows it. Narrowing this
  // to a list of endings let "closed as confirmed updated" through, because the
  // trailing verb then matched the terse-completion rule.
  [/\bclosed? as\b/i, -10],
  [/\bticket can be closed\b/i, -8],
  [/\bcan (?:this|it) be closed\b/i, -8],
  [/\b(?:many )?thanks?\b/i, -4],
  [/\bthank you\b/i, -5],
  [/\ball looks good\b/i, -6],
  [/\bany (?:idea|update|news)\b/i, -6],
  [/\bplease can (?:this|you|we)\b/i, -5],
  [/\bcould you (?:please )?(?:look|check|confirm)\b/i, -5],
  [/\bchasing\b/i, -5],
  [/\bnoted\b/i, -3],
  [/\bfyi\b/i, -3],
  // A comment that is nothing but a mention — "@Andy Marsh," — is a nudge, not
  // an answer. The @ is required: without it this also matched short plain
  // sentences like "Duplicate app deleted", which are exactly the terse fixes
  // worth keeping.
  [/^\s*@[\w ]{1,30}[,:-]?\s*$/i, -8],
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Score one comment on how much it reads like the resolution.
 * `role` is "assignee" | "other" | "reporter" — the reporter is the one asking,
 * so anybody else in the thread is more likely to be the one answering.
 */
export function scoreComment(text, role = "other", position = 0, total = 1) {
  const clean = fieldToText(text);
  if (!clean) return { score: -100, clean };

  // A comment that is only a screenshot may well *be* the answer, but there is
  // no text to show, so it can never win the summary slot.
  const withoutImages = clean.replace(/\[image\]/g, "").trim();
  if (!withoutImages) return { score: -50, clean };

  let score = 0;
  for (const [pattern, weight] of ACTION_PATTERNS) if (pattern.test(clean)) score += weight;
  for (const [pattern, weight] of EXPLANATION_PATTERNS) if (pattern.test(clean)) score += weight;
  for (const [pattern, weight] of NOISE_PATTERNS) if (pattern.test(clean)) score += weight;

  // Substance, with diminishing returns. A 40-character comment is a remark; a
  // 250-character one is an explanation; a 2000-character one is a whole thread
  // pasted in and no better than the 250.
  score += clamp(Math.log2(withoutImages.length / 40) * 2.5, -3, 6);

  // A question is a request, not a resolution — unless it also reports an
  // action, which does happen ("I've voided it, shall I regenerate?").
  const isQuestion = /\?\s*$/.test(withoutImages);
  if (isQuestion && score < 8) score -= 5;

  if (role === "assignee") score += 3;
  else if (role === "reporter") score -= 2;

  // Later comments are likelier to be the outcome, but only mildly — the noise
  // patterns are what actually keep sign-offs from winning.
  if (total > 1) score += (position / (total - 1)) * 1.5;

  return { score, clean };
}

/**
 * The issue-and-fix digest for one fully-loaded issue.
 *
 * `issue` is the normalised shape from ops-issue.js: { summary, description,
 * comments: [{ id, author, authorId, body, created }], assigneeId, reporterId }.
 */
export function buildDigest(issue) {
  const comments = Array.isArray(issue?.comments) ? issue.comments : [];

  // An authored summary always beats an extracted one. Later authored notes win
  // over earlier ones, so editing is just "post a new one".
  const authored = (marker) =>
    comments
      .filter((c) => fieldToText(c.body).startsWith(marker))
      .map((c) => ({
        text: fieldToText(c.body).slice(marker.length).trim(),
        author: c.author,
        created: c.created,
        commentId: c.id,
      }))
      .filter((c) => c.text)
      .pop() || null;

  const authoredFix = authored(FIX_NOTE_MARKER);
  const authoredIssue = authored(ISSUE_NOTE_MARKER);

  // Jira's own "Resolution Comments" field. When somebody filled it in, that is
  // a fix written on purpose, by a person, in the place meant for it — it beats
  // anything this file could score out of a comment thread. It sits just below
  // an OPSTracker note, which is the more recent deliberate act.
  const resolutionField = String(issue?.resolutionComments || "").trim();

  // Comments that are OPSTracker's own notes must not compete for the
  // extracted-fix slot, or the app starts quoting itself.
  const threadComments = comments.filter((c) => {
    const text = fieldToText(c.body);
    return !text.startsWith(FIX_NOTE_MARKER) && !text.startsWith(ISSUE_NOTE_MARKER);
  });

  const descriptionText = fieldToText(issue?.description);
  const issueSummary = authoredIssue
    ? { text: authoredIssue.text, source: "authored", author: authoredIssue.author, created: authoredIssue.created }
    : {
        text: truncate(firstSentences(descriptionText, 2) || fieldToText(issue?.summary), 320),
        source: descriptionText ? "description" : "summary",
      };

  if (authoredFix) {
    return {
      issue: issueSummary,
      fix: { text: authoredFix.text, source: "authored", author: authoredFix.author, created: authoredFix.created, commentId: authoredFix.commentId },
      thread: threadComments,
    };
  }

  // The field is the place meant for the fix, so it gets the benefit of the
  // doubt: it is used unless it reads as *nothing but* a sign-off. That
  // inversion matters — a terse entry like "1951 now funded" scores neutrally
  // and is still the answer, while "Closed as complete after Finance review"
  // is a status update someone typed into the wrong box, and presenting it as
  // the fix would be exactly the failure this file exists to avoid.
  //
  // A rejected field is not hidden. It is handed back as `fieldNote` so the UI
  // can say the field was filled in and what it says, rather than implying the
  // team left it empty.
  const SIGN_OFF_FLOOR = -3;
  const fieldScore = resolutionField ? scoreComment(resolutionField, "assignee", 0, 1).score : null;
  const fieldIsSignOff = resolutionField && fieldScore <= SIGN_OFF_FLOOR;

  if (resolutionField && !fieldIsSignOff) {
    return {
      issue: issueSummary,
      fix: {
        text: resolutionField,
        source: "resolution-field",
        confidence: fieldScore >= 6 ? "high" : "low",
        score: Math.round(fieldScore * 10) / 10,
      },
      thread: threadComments,
    };
  }

  const scored = threadComments.map((comment, index) => {
    const role =
      comment.authorId && comment.authorId === issue?.assigneeId
        ? "assignee"
        : comment.authorId && comment.authorId === issue?.reporterId
        ? "reporter"
        : "other";
    const { score, clean } = scoreComment(comment.body, role, index, threadComments.length);
    return { ...comment, role, score, clean };
  });

  const best = scored.slice().sort((a, b) => b.score - a.score)[0];

  // Below this, the winner is just the least-bad sign-off in a thread that
  // never recorded an outcome. Claiming that as "the fix" would be worse than
  // admitting the thread doesn't say — so the UI gets an explicit blank to fill.
  const CONFIDENCE_FLOOR = 6;
  if (!best || best.score < CONFIDENCE_FLOOR) {
    return {
      issue: issueSummary,
      fix: {
        text: "",
        source: "none",
        confidence: "none",
        candidate: best ? truncate(best.clean, 200) : "",
        ...(fieldIsSignOff ? { fieldNote: resolutionField } : {}),
      },
      thread: threadComments,
    };
  }

  return {
    issue: issueSummary,
    fix: {
      // Generous, and deliberately so. These comments build to their point —
      // context first, then "but as an immediate fix, …" last — so a tight cap
      // reliably severs the one sentence somebody opened the ticket to read.
      text: truncate(best.clean, 900),
      source: "extracted",
      confidence: best.score >= 12 ? "high" : "low",
      author: best.author,
      created: best.created,
      commentId: best.id,
      score: Math.round(best.score * 10) / 10,
      ...(fieldIsSignOff ? { fieldNote: resolutionField } : {}),
    },
    thread: threadComments,
  };
}

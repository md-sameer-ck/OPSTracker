// site/lib/text.js
//
// Jira hands back rich text, and the markdown rendering of it carries artefacts
// that are noise in a dashboard. Two show up constantly in this project:
//
//   <custom data-type="mention" data-id="id-0">@Danny Learmont</custom>
//   ![](blob:https://media.staging.atl-paas.net/?type=file&localId=...&width=1752...)
//
// The blob one is the worse offender: a single pasted screenshot expands into
// ~300 characters of query string, which will happily eat a whole preview line
// and skew any "is this comment substantial?" length check. So both get folded
// down before anything else looks at the text.

/** A mention tag, with the @Name kept. */
const MENTION_TAG = /<custom[^>]*data-type="mention"[^>]*>(@?[^<]*)<\/custom>/gi;
/** Any other stray inline custom/HTML tag Jira's markdown leaves behind. */
const STRAY_TAG = /<\/?(?:custom|span|div|p|br|em|strong)\b[^>]*>/gi;
/** An embedded image: markdown image whose target is a blob/media URL. */
const BLOB_IMAGE = /!\[[^\]]*\]\((?:blob:)?https?:\/\/[^)]*\)/gi;
/** A bare media URL left on its own. */
const BARE_MEDIA_URL = /(?:blob:)?https?:\/\/media[^\s)]*/gi;
/** Jira's smart-link/emoji leftovers and zero-width joiners. */
const INVISIBLES = /[​-‏⁠﻿]/g;

/**
 * Rich text -> a clean single-spaced plain string safe to measure, search and
 * preview. Images become a visible "[image]" marker rather than vanishing,
 * because "the answer was a screenshot" is itself useful to see in the UI.
 */
export function toPlainText(input) {
  if (!input) return "";
  return String(input)
    .replace(MENTION_TAG, (_m, name) => name.trim() || "@someone")
    .replace(BLOB_IMAGE, " [image] ")
    .replace(BARE_MEDIA_URL, " [image] ")
    .replace(STRAY_TAG, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(INVISIBLES, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*\n\s*/g, "\n")
    .trim();
}

/**
 * Atlassian Document Format (the JSON shape) flattened to text. The bulk search
 * is asked for markdown, so this is the fallback for anything that arrives as
 * ADF anyway — it walks the node tree and keeps text, mentions and line breaks.
 */
export function adfToPlainText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToPlainText).join("");
  switch (node.type) {
    case "text":
      return node.text || "";
    case "mention":
      return node.attrs?.text || "@someone";
    case "hardBreak":
      return "\n";
    case "media":
    case "mediaSingle":
    case "mediaGroup":
      return " [image] ";
    case "paragraph":
    case "heading":
    case "listItem":
    case "blockquote":
      return adfToPlainText(node.content) + "\n";
    default:
      return adfToPlainText(node.content);
  }
}

/** Whatever Jira gave us (markdown string or ADF object) as clean text. */
export function fieldToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return toPlainText(value);
  if (typeof value === "object") return toPlainText(adfToPlainText(value));
  return toPlainText(String(value));
}

/**
 * Trim to a whole-word boundary with an ellipsis, for card previews. Cutting
 * mid-word looks like a bug; cutting mid-sentence reads as deliberate.
 */
export function truncate(text, max = 220) {
  const clean = String(text || "").trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

// Words that end in a period without ending a sentence. "Ref." is the one that
// matters here — "Ref. 1754 is wrong." is a single sentence, and splitting it
// would leave a preview reading just "Ref.".
const ABBREVIATIONS = /(?:\b(?:[Rr]ef|[Nn]o|[Mm]r|[Mm]rs|[Mm]s|[Dr]r|approx|etc|vs|inc|Ltd|acc|a\.m|p\.m|e\.g|i\.e)\.)$/;

/**
 * The first sentence or two — used as the one-line "what was this about" on a
 * timeline row. A sentence boundary is punctuation followed by whitespace and
 * something that starts a new sentence, with two guards: a known abbreviation
 * before the period does not end a sentence, and a following digit does not
 * begin one (that is nearly always a reference number, as in "Ref. 1754").
 */
export function firstSentences(text, count = 2) {
  const clean = toPlainText(text);
  if (!clean) return "";

  const sentences = [];
  let current = "";
  // Split on candidate boundaries, then re-join the ones that fail the guards.
  for (const piece of clean.split(/(?<=[.!?])(\s+)/)) {
    if (/^\s+$/.test(piece)) {
      current += piece;
      continue;
    }
    if (current && !ABBREVIATIONS.test(current.trimEnd()) && /^["'“(]?[A-Z]/.test(piece)) {
      sentences.push(current.trim());
      current = piece;
    } else {
      current += piece;
    }
    if (sentences.length >= count) break;
  }
  if (sentences.length < count && current.trim()) sentences.push(current.trim());
  return sentences.slice(0, count).join(" ").trim();
}

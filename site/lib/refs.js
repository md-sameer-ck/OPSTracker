// site/lib/refs.js
//
// Pulling entity references out of free text written by humans in a hurry.
//
// The OPS project is a service desk: people type the loan account into the
// summary, the description, or a comment, in whatever shape they had to hand.
// Every one of these appears in the real project and all six mean loan 1797:
//
//   LAI-00001797   LAI-1797   LAI 1797   LAI1797   LAI00001797   lai-1797
//
// So a reference has two forms. The *raw* form is what the person actually
// typed (kept, so the UI can show the ticket the way it reads in Jira), and
// the *canonical* form is "LAI-1797" — prefix, hyphen, no padding zeros. Every
// grouping, counting and lookup in the app keys off the canonical form only.

// Entity prefixes worth indexing. Loans are the point of the app; the others
// are recognised so a ticket's "what does this touch" line is complete, and so
// a loan-less ticket can still say what it *was* about.
export const ENTITY_TYPES = {
  LAI: { label: "Loan", plural: "Loans", primary: true },
  APP: { label: "Application", plural: "Applications", primary: false },
  REDS: { label: "Redemption statement", plural: "Redemption statements", primary: false },
  STE: { label: "Party", plural: "Parties", primary: false },
};

// Longest prefix first: without that, "REDS-0078" would match an "RED" rule and
// strand the S. Kept as one alternation so a single pass over the text finds
// every type.
const PREFIX_ALTERNATION = Object.keys(ENTITY_TYPES)
  .sort((a, b) => b.length - a.length)
  .join("|");

// The separator class is deliberately narrow — a hyphen, an en/em dash, a
// space, or nothing. It must NOT swallow "/" or ":", or "LAI/1234-5678" style
// text would fold two different numbers into one reference.
const REF_PATTERN = new RegExp(
  String.raw`\b(${PREFIX_ALTERNATION})\s?[-–—]?\s?(\d{1,10})\b`,
  "gi"
);

/**
 * Canonical key for one prefix + digit string, e.g. ("lai", "00001797")
 * -> "LAI-1797". Padding zeros are dropped because Jira's own users drop them
 * inconsistently; "LAI-0" would be a real (if odd) loan so a lone zero stays.
 */
export function canonicalRef(prefix, digits) {
  const stripped = digits.replace(/^0+(?=\d)/, "");
  return `${prefix.toUpperCase()}-${stripped}`;
}

/**
 * Every entity reference in a blob of text, de-duplicated by canonical key.
 * Returns [{ canonical, type, number, raw }] in first-appearance order —
 * first appearance matters because the earliest mention in a summary is
 * almost always the ticket's actual subject.
 */
export function extractRefs(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  for (const match of String(text).matchAll(REF_PATTERN)) {
    const [raw, prefix, digits] = match;
    const canonical = canonicalRef(prefix, digits);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({
      canonical,
      type: prefix.toUpperCase(),
      number: Number(digits),
      raw: raw.trim(),
    });
  }
  return out;
}

/** Just the loan references — the app's primary axis. */
export function extractLoanRefs(text) {
  return extractRefs(text).filter((ref) => ref.type === "LAI");
}

/**
 * What a user typed into the loan search box, turned into a canonical key.
 * Accepts "1122", "LAI1122", "lai 1122", "LAI-00001122" — all -> "LAI-1122",
 * so nobody has to know which spelling the tickets happen to use.
 */
export function normaliseLoanQuery(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (/^\d{1,10}$/.test(trimmed)) return canonicalRef("LAI", trimmed);
  const match = trimmed.match(new RegExp(String.raw`^(${PREFIX_ALTERNATION})\s?[-–—]?\s?(\d{1,10})$`, "i"));
  return match ? canonicalRef(match[1], match[2]) : null;
}

/** "LAI-1797" -> "1797", for compact display next to a label. */
export function refNumber(canonical) {
  const idx = canonical.indexOf("-");
  return idx === -1 ? canonical : canonical.slice(idx + 1);
}

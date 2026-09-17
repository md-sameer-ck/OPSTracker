// netlify/functions/ops-advise.js
//
// Optional. Asks Claude to read a ticket alongside the most similar earlier
// ones and suggest what to check first.
//
// Three deliberate constraints:
//
//  * Off unless ANTHROPIC_API_KEY is set. The dashboard hides the button, so
//    nothing here runs — or costs anything — by default.
//  * The browser sends the tickets it already has. The index is in memory on
//    the client, so asking Jira again would be a second full pass for nothing.
//  * Output is labelled as model-generated wherever it appears. The fix
//    summaries elsewhere in this app are deliberately never AI-written — that
//    distinction is the reason they can be trusted, and it must not blur.

import { json, preflight, PROJECT_KEY } from "./_jira.js";

// A short analysis, not an essay. Low effort keeps it inside a function's
// execution window; Netlify's default is 10 seconds.
const MODEL = "claude-opus-5";
const MAX_TOKENS = 2000;

const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Trim anything the browser sends before it reaches a prompt or a token bill. */
const clip = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

function buildPrompt({ ticket, similar }) {
  const lines = [
    `Ticket ${ticket.key}: ${clip(ticket.summary, 300)}`,
    `Status: ${clip(ticket.status, 40)} · Topic: ${clip(ticket.topic, 60)} · Components: ${clip((ticket.components || []).join(", "), 200) || "none"}`,
    `Loans: ${clip((ticket.loans || []).join(", "), 200) || "none"}`,
    "",
    "What was reported:",
    clip(ticket.description, 2000) || "(no description)",
  ];

  if (ticket.fix) lines.push("", "What is recorded as the fix:", clip(ticket.fix, 1500));

  if (similar?.length) {
    lines.push("", "Earlier tickets that look related:");
    for (const other of similar.slice(0, 6)) {
      lines.push(
        `- ${other.key} (${clip(other.status, 30)}): ${clip(other.summary, 200)}`,
        `  fix: ${clip(other.fix, 600) || "(none recorded)"}`
      );
    }
  }

  return lines.join("\n");
}

const SYSTEM = `You are helping a Salesforce support desk that handles production issues for a peer-to-peer lending platform. Tickets concern loans (LAI-####), redemptions, investor payouts, Direct Debit files and interest uploads.

You will be given one ticket and the earlier tickets most similar to it.

Answer in three short sections, using plain prose and no preamble:

**What this looks like** — one or two sentences on what is probably going on, grounded in the ticket text.
**Check first** — two to four concrete things to look at, most likely first. Prefer specific records, fields, files or jobs named in the tickets.
**From the history** — what the earlier tickets suggest, and whether this looks like a repeat of one of them. Name the ticket keys you mean. If the earlier tickets do not actually help, say so plainly.

Be concise and specific. Do not invent record IDs, field names or fixes that are not in the material given. If the material is too thin to be useful, say that instead of guessing.`;

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();

  // A GET is the capability probe the UI uses to decide whether to show the
  // button at all.
  if (event.httpMethod === "GET") {
    return json(200, { available: Boolean(process.env.ANTHROPIC_API_KEY), model: MODEL });
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(501, { error: "Analysis is off. Set ANTHROPIC_API_KEY to enable it." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Body must be JSON." });
  }

  // Two callers: the ticket panel sends a structured ticket, and the newer
  // summarise buttons send a prompt they have already assembled from what the
  // page holds. Both end up as one string here.
  const ticket = body.ticket;
  const rawPrompt = typeof body.prompt === "string" ? body.prompt.slice(0, 40000).trim() : "";
  if (!rawPrompt && !ticket?.key) return json(400, { error: "Send either a prompt or a ticket." });
  if (ticket?.key && !new RegExp(`^${PROJECT_KEY}-\\d{1,7}$`, "i").test(ticket.key)) {
    return json(400, { error: `Expected a ${PROJECT_KEY} ticket.` });
  }

  const cacheKey = rawPrompt ? `p:${rawPrompt.length}:${rawPrompt.slice(0, 120)}` : ticket.key;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && !body.refresh) {
    return json(200, { ...cached.payload, cached: true });
  }

  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    // Imported lazily so the rest of the project keeps working with no
    // node_modules at all — which is how `npm run dev` is documented.
    return json(501, {
      error: "The Anthropic SDK is not installed. Run `npm install @anthropic-ai/sdk` to enable analysis.",
    });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      // Adaptive thinking, held at low effort: this is a short read of a small
      // amount of text, and the function has seconds, not minutes.
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: rawPrompt || buildPrompt({ ticket, similar: body.similar }) }],
    });

    if (response.stop_reason === "refusal") {
      return json(200, { key: cacheKey, text: "", refused: true, model: MODEL });
    }

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    const payload = {
      key: cacheKey,
      text,
      model: MODEL,
      usage: { input: response.usage?.input_tokens ?? null, output: response.usage?.output_tokens ?? null },
      generatedAt: new Date().toISOString(),
    };
    cache.set(cacheKey, { at: Date.now(), payload });
    return json(200, payload);
  } catch (error) {
    const status = error?.status || 502;
    return json(status, {
      error:
        status === 401
          ? "The Anthropic API key was rejected."
          : status === 429
          ? "Rate limited by the Anthropic API — try again shortly."
          : `Analysis failed: ${error.message}`,
    });
  }
};

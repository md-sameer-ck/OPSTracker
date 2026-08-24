// netlify/functions/_jira.js
//
// Everything that touches Jira, in one place. The site is served as static
// files and holds no credentials — these functions are the only thing that
// knows the API token, which is why even the trivial passthroughs go through
// here rather than being called from the browser.

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export const PROJECT_KEY = process.env.OPS_PROJECT_KEY || "OPS";

export const json = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: { ...JSON_HEADERS, ...extraHeaders },
  body: JSON.stringify(body),
});

export const preflight = () => ({ statusCode: 204, headers: JSON_HEADERS, body: "" });

/**
 * Credentials, or a description of what's missing. Returning the *names* of the
 * absent variables is worth it: the alternative is a generic 500 and somebody
 * guessing which of the three they forgot in the Netlify UI.
 */
export function getCredentials() {
  const domain = (process.env.ATLASSIAN_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const email = process.env.ATLASSIAN_EMAIL;
  const token = process.env.ATLASSIAN_TOKEN;

  const missing = [
    !domain && "ATLASSIAN_DOMAIN",
    !email && "ATLASSIAN_EMAIL",
    !token && "ATLASSIAN_TOKEN",
  ].filter(Boolean);

  if (missing.length) return { error: `Server is missing ${missing.join(", ")}. See .env.example.` };
  return { domain, email, token };
}

/**
 * One authenticated Jira REST call. Jira answers errors as JSON with useful
 * `errorMessages`, so those are surfaced verbatim rather than flattened into
 * "request failed" — a 400 from a bad JQL is something the user can act on.
 */
export async function jiraFetch(path, { method = "GET", body, credentials } = {}) {
  const creds = credentials || getCredentials();
  if (creds.error) throw Object.assign(new Error(creds.error), { statusCode: 500 });

  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
  const response = await fetch(`https://${creds.domain}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    /* Jira occasionally answers HTML — an auth redirect, or a maintenance page. */
  }

  if (!response.ok) {
    const detail =
      parsed?.errorMessages?.join(" ") ||
      parsed?.errors?.[Object.keys(parsed.errors || {})[0]] ||
      (response.status === 401 ? "Jira rejected the credentials (401)." : "") ||
      (response.status === 403 ? "The Jira account lacks permission for this (403)." : "") ||
      raw.slice(0, 200);
    throw Object.assign(new Error(detail || `Jira returned ${response.status}`), { statusCode: response.status });
  }
  return parsed;
}

/**
 * Guard for anything that accepts JQL from the browser. The site only ever
 * needs to read one project, so a caller-supplied clause is *added* to a fixed
 * project filter rather than replacing it, and the shapes that would let it
 * escape that scope are refused.
 */
export function scopedJql(extraClause) {
  const base = `project = ${PROJECT_KEY}`;
  if (!extraClause) return base;
  const clause = String(extraClause).trim();
  if (!clause) return base;
  if (clause.length > 400) throw Object.assign(new Error("Filter is too long."), { statusCode: 400 });
  // No statement separators, no comment syntax, and no second ORDER BY.
  if (/[;]|--|\/\*|\bORDER\s+BY\b/i.test(clause)) {
    throw Object.assign(new Error("Filter contains disallowed syntax."), { statusCode: 400 });
  }
  return `${base} AND (${clause})`;
}

/**
 * Page through a JQL search until Jira stops handing back a token.
 *
 * `onPage` is called with each batch so a caller can trim as it goes — the full
 * project with comments attached is several megabytes from Jira, and holding
 * all of it before reducing would be the expensive way to do this.
 */
export async function searchAll({ jql, fields, onPage, pageSize = 100, maxPages = 40, credentials }) {
  let nextPageToken;
  let pages = 0;
  let total = 0;

  do {
    const body = { jql, fields, maxResults: pageSize, ...(nextPageToken ? { nextPageToken } : {}) };
    const page = await jiraFetch("/rest/api/3/search/jql", { method: "POST", body, credentials });
    const issues = page?.issues || [];
    total += issues.length;
    if (issues.length) onPage(issues);
    nextPageToken = page?.nextPageToken;
    pages += 1;
    // A safety stop, not an expected exit. If it ever trips, the project has
    // outgrown pageSize * maxPages and the caller should know rather than
    // silently show a truncated org.
    if (pages >= maxPages && nextPageToken) {
      return { total, truncated: true, pages };
    }
  } while (nextPageToken);

  return { total, truncated: false, pages };
}

// netlify/functions/ops-issues.js
//
// The index the whole dashboard is built from: every ticket in the project,
// reduced to the fields a list, a timeline, a person's throughput and a chart
// actually need.
//
// There is no database behind this by design, so the shape of this endpoint is
// what makes that workable. Three things keep it quick:
//
//  1. Comments are NOT fetched here. Asking for them across the whole project
//     pulls several megabytes out of Jira and takes long enough to feel broken.
//     A ticket's thread is fetched by ops-issue.js when someone opens it.
//  2. The reduction happens here. Jira's payload for ~850 issues is a few MB of
//     mostly-unused rendering metadata; what reaches the browser is ~600 KB, and
//     ~136 KB over the wire once gzipped.
//  3. Two caches. A warm-container cache here (5 minutes), and an ETag so a
//     browser that already has the current copy gets a 304 and re-uses it.
//     Against live Jira a cold build is ~5 seconds; neither the user nor the
//     rate limiter should pay that on every page load.
//
// The cost of (1) is honest and worth stating: a loan mentioned *only* in a
// comment is not in this index. The UI's "search Jira comments too" button
// exists for exactly that case, and asks Jira directly.

import { getCredentials, json, preflight, scopedJql, searchAll, PROJECT_KEY } from "./_jira.js";
import { BASE_FIELDS, FEATURE_REQUEST_TYPE, PRODUCTION_REQUEST_TYPE, SERVICE_REQUEST_TYPE, normaliseIssue } from "./_fields.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { key: null, at: 0, payload: null, etag: null };

/** A cheap, stable ETag: the project state that would change what we returned. */
function makeEtag(issues) {
  let newest = "";
  for (const issue of issues) if (issue.updated && issue.updated > newest) newest = issue.updated;
  return `W/"${issues.length}-${newest}"`;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();

  const credentials = getCredentials();
  if (credentials.error) return json(500, { error: credentials.error });

  const params = event.queryStringParameters || {};
  const wantsRefresh = params.refresh === "1";
  // Feature requests are planned work, not production incidents, and are left
  // out unless asked for — see PRODUCTION_REQUEST_TYPE in _fields.js.
  const includeFeatureRequests = params.featureRequests === "1";
  // Service requests are asks, not faults — see SERVICE_REQUEST_TYPE.
  const includeServiceRequests = params.serviceRequests === "1";

  let jql;
  try {
    jql = `${scopedJql(params.filter)} ORDER BY created DESC`;
  } catch (error) {
    return json(error.statusCode || 400, { error: error.message });
  }

  const cacheKey = `${jql}::${includeFeatureRequests}::${includeServiceRequests}`;
  const ifNoneMatch = event.headers?.["if-none-match"] || event.headers?.["If-None-Match"];

  if (!wantsRefresh && cache.payload && cache.key === cacheKey && Date.now() - cache.at < CACHE_TTL_MS) {
    if (ifNoneMatch && ifNoneMatch === cache.etag) {
      return { statusCode: 304, headers: { ETag: cache.etag, "Access-Control-Allow-Origin": "*" }, body: "" };
    }
    return json(200, { ...cache.payload, cached: true, cacheAgeMs: Date.now() - cache.at }, { ETag: cache.etag });
  }

  const issues = [];
  const requestTypeCounts = {};
  const opsTypeCounts = {};
  let excludedFeatures = 0;
  let excludedServiceRequests = 0;

  try {
    const { truncated, total } = await searchAll({
      jql,
      fields: BASE_FIELDS,
      credentials,
      onPage: (page) => {
        for (const raw of page) {
          const record = normaliseIssue(raw);
          const type = record.requestType || "(none)";
          requestTypeCounts[type] = (requestTypeCounts[type] || 0) + 1;
          const opsType = record.opsType || "(not set)";
          opsTypeCounts[opsType] = (opsTypeCounts[opsType] || 0) + 1;

          if (!includeFeatureRequests && record.requestType === FEATURE_REQUEST_TYPE) {
            excludedFeatures += 1;
            continue;
          }
          if (!includeServiceRequests && record.opsType === SERVICE_REQUEST_TYPE) {
            excludedServiceRequests += 1;
            continue;
          }
          issues.push(record);
        }
      },
    });

    const payload = {
      project: PROJECT_KEY,
      jiraBase: `https://${credentials.domain}`,
      jql,
      total: issues.length,
      fetchedFromJira: total,
      excludedFeatureRequests: excludedFeatures,
      excludedServiceRequests,
      requestTypeCounts,
      opsTypeCounts,
      productionRequestType: PRODUCTION_REQUEST_TYPE,
      featureRequestType: FEATURE_REQUEST_TYPE,
      includeFeatureRequests,
      includeServiceRequests,
      // Who "mine" means. The Jira login is a shared desk account, so the person
      // using the dashboard has to be named separately — see CK_ME_EMAIL.
      me: process.env.CK_ME_EMAIL || null,
      truncated,
      fetchedAt: new Date().toISOString(),
      coverage: "summary and description only; comment text is not indexed",
      issues,
    };

    const etag = makeEtag(issues);
    cache = { key: cacheKey, at: Date.now(), payload, etag };

    if (ifNoneMatch && ifNoneMatch === etag) {
      return { statusCode: 304, headers: { ETag: etag, "Access-Control-Allow-Origin": "*" }, body: "" };
    }
    return json(200, { ...payload, cached: false }, { ETag: etag });
  } catch (error) {
    // A stale answer beats a dead dashboard, so long as it says it's stale.
    if (cache.payload && cache.key === cacheKey) {
      return json(200, {
        ...cache.payload,
        cached: true,
        stale: true,
        cacheAgeMs: Date.now() - cache.at,
        warning: error.message,
      });
    }
    return json(error.statusCode || 502, { error: `Could not reach Jira: ${error.message}` });
  }
};

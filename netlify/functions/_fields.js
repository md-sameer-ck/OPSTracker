// netlify/functions/_fields.js
//
// The field map and issue normaliser moved to site/lib/jira.js so the published
// snapshot page can shape a live Jira response the same way this server does.
// Re-exported here so the function modules keep their existing imports.

export {
  FIELD,
  BASE_FIELDS,
  PRODUCTION_REQUEST_TYPE,
  FEATURE_REQUEST_TYPE,
  SERVICE_REQUEST_TYPE,
  ISSUE_TYPE,
  normaliseIssue,
} from "../../site/lib/jira.js";

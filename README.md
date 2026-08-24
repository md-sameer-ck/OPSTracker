# OPSTracker

Every ticket in the Jira **OPS** project (*Salesforce Operational Issues*),
grouped by the **loan account** it touches — so you can pick a loan, see each
OPS ticket raised against it in date order, click one, and read what went wrong
and what fixed it. Plus a view of which errors keep coming back across the org,
and which loan accounts keep generating them.

Built on the same free-tier shape as its two sibling projects: a static page on
Netlify, a handful of Netlify Functions holding the credentials, no build step.

```
        browser (site/)
            │
            │  /api/*
            ▼
    Netlify Functions ──────────────► Jira Cloud REST API
    ops-issues  the whole project, reduced to an index
    ops-issue   one ticket + its comment thread, on click
    ops-note    saves a hand-written summary back onto the ticket
```

There is **no database**. Jira is the only store, including for the summaries
people write in this app — see [Writing a summary](#writing-a-summary).

## What it gives you

**Loans.** A searchable list of every loan account named in an OPS ticket, and
for the one you pick, a dated timeline of its tickets — status, priority, topic
and a preview each. A loan whose history shows *"Redemption & statements ×4"*
has a problem nobody has finished fixing.

**A ticket, on click.** Two things first, before the noise: **The issue** and
**The fix**, each labelled with where it came from. Then the references it
touches, the dates and people, and the full thread with the comment the fix was
read out of highlighted.

**Recurring errors.** What goes wrong most often, which loans come back most,
which topics take longest to resolve, volume over time, and the same view built
from Jira's own Components for comparison.

## Setup

```bash
cp .env.example .env      # then fill in the three ATLASSIAN_* values
npm run dev               # http://localhost:8888
```

No dependencies to install — the only third-party code is Chart.js, vendored at
`site/vendor/chart.umd.js` (MIT). `npm test` runs the logic tests.

On Netlify: point it at this repo, set the same variables under **Site settings
→ Environment variables**, and deploy. `netlify.toml` already publishes `site/`
and maps `/api/*` to the functions.

| Variable | |
|---|---|
| `ATLASSIAN_DOMAIN` | `your-team.atlassian.net` — host only, no `https://` |
| `ATLASSIAN_EMAIL` | the account the API token belongs to |
| `ATLASSIAN_TOKEN` | from [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `OPS_PROJECT_KEY` | optional, defaults to `OPS` |

A read-only token is enough for everything except saving summaries, which needs
permission to comment.

## How a loan gets found

Reporters write the loan number however it came to hand. All six of these appear
in the real project, and all six mean loan 1797:

```
LAI-00001797    LAI-1797    LAI 1797    LAI1797    LAI00001797    lai-1797
```

So each mention is normalised to one canonical key — `LAI-1797` — and that is
what everything groups by. The form the reporter actually typed is kept for
display. Counted across the project: `LAI-1234` ×256, `LAI 1234` ×111,
`LAI - 1234` ×8, `LAI- 1234` ×2, and no other separator at all.

The search box takes any of them, including a bare `1797`.

`APP`, `REDS` and `STE` references are recognised the same way and shown on a
ticket, so you can see what else it touched.

### The one gap worth knowing

The index reads **summaries and descriptions only** — not comment text. Pulling
every comment for the whole project takes long enough to feel broken, so a
ticket that mentions a loan *only* in a comment will not be listed under it.

Two things cover that: opening any ticket scans its full thread (so the loan
shows up in that ticket's references), and searching for a loan with no indexed
tickets offers **"Search Jira comments too"**, which asks Jira directly and
folds the results in.

## Where the issue and the fix come from

The OPS project has no resolution-notes field, so the fix is somewhere in the
comment thread — and it is reliably **not** the last comment. Measured across
the resolved loan tickets here, the final comment is a sign-off about two thirds
of the time (*"Closed as complete after Finance review"*, *"thank you for
amending so promptly"* — median length 44 characters).

So every comment is scored on how much it reads like an explanation or an action
taken, minus how much it reads like a pleasantry, a chaser or a question. The
best-scoring one is offered as the fix. On the real threads that finds a genuine
fix line for **88%** of them and picks a sign-off for none.

Each summary says where it came from, and that label matters more than the text:

| Label | Meaning |
|---|---|
| **Written by *name*** | A person wrote this summary deliberately. Trust it. |
| **Pulled from *name*'s comment** | Extracted by scoring. It is a real comment, but nobody wrote it to be a summary. |
| **Taken from the reporter's own description** | The opening of the description, verbatim. |
| **Not recorded** | Nothing in the thread reads like a resolution. Said plainly rather than guessed. |

**Nothing here is AI-generated.** No model reads a ticket and writes a summary.
Extraction picks a comment somebody already wrote, quotes it, and says whose it
is; anything else is typed by a person.

### Writing a summary

Where the extracted guess is wrong or missing, **Write the fix in your own
words** replaces it. With no database, that gets saved back onto the Jira ticket
as a comment:

```
[OPSTracker] Fix summary: Two loans were created from one application; 1952 was
marked Invalid and unlinked.
```

The app recognises that marker and treats the note as authoritative over its own
guess. Which means: the whole team sees the same summary, it is visible on the
ticket to people who never open this dashboard, it survives with the ticket, and
there is nothing to back up. Editing posts a newer note and the newest wins — so
a re-summarised ticket carries an audit trail rather than a silent overwrite.

## How errors get categorised

Jira's Components field cannot answer "what goes wrong most" on its own here:
28% of tickets have no component, and of those that do, **"Data Correction"
takes 44%** — a label describing how a ticket was resolved, not what broke.

So a ticket's topic is derived from its words, with the component as a strong
hint. 17 topics — Redemption & statements, Interest upload, Investor breakdown,
Payouts, Job & integration failures, Duplicate records, and so on — each with
weighted patterns; the highest score wins, close runners-up are kept as
secondary topics, and a ticket matching nothing is reported as uncategorised
rather than guessed at. "Data Correction" scores just enough to beat nothing, so
it becomes the bucket for tickets whose text says nothing recognisable instead
of drowning out every real category.

Topics are defined in [`site/lib/taxonomy.js`](site/lib/taxonomy.js) and are
meant to be edited — add a pattern when a new class of problem starts recurring.

## Layout

```
site/
  index.html        the page
  app.js            all UI behaviour; three views over one in-memory index
  styles.css        light and dark from one token set
  lib/
    refs.js         loan/entity reference extraction and normalisation
    taxonomy.js     the 17 topics and the classifier
    digest.js       issue/fix extraction, comment scoring, note markers
    text.js         Jira rich-text cleanup (mentions, pasted screenshots, ADF)
netlify/functions/
  _jira.js          auth, paging, JQL scoping — the only place the token lives
  ops-issues.js     the project index (no comments; 5-minute warm cache)
  ops-issue.js      one ticket with its thread, and the digest
  ops-note.js       writes a summary back to Jira as a marked comment
scripts/
  dev-server.js     local server; no netlify-cli needed
  lib.test.js       npm test
  make-fixture.js   build a demo index from saved Jira exports
```

`site/lib/` is imported by both the browser and the functions, so extraction and
classification cannot drift between what the index says and what a ticket says.

### Tests

`npm test` — 26 cases over reference normalisation, text cleanup,
classification and fix extraction. Every string in them is real text from the
OPS project, which is the point: the heuristics are tuned to how this team
actually writes, so the tests have to be too. The one that matters most asserts
that a sign-off is never mistaken for a fix.

### Looking at it without a Jira token

```bash
node scripts/make-fixture.js path/to/jira-search-export.json > data/demo-index.json
DEMO_INDEX=data/demo-index.json npm run dev
```

`data/` is gitignored — fixtures hold real ticket text, so generate your own
rather than committing one.

## Things it does not do

- **Comment text is not indexed.** Covered by deep search; see above.
- **Loan numbers are only as good as what people typed.** A ticket that never
  names its loan cannot be grouped under it. Nothing here infers one.
- **A 5-minute cache** sits in front of Jira. **Refresh** bypasses it.
- **Around 850 tickets** is fetched in one pass. Far beyond that, the index
  endpoint would want a real store behind it rather than a warm-memory cache.

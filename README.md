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
for the one you pick, a dated timeline of its tickets — status, priority, topic,
who picked it up and how long it took. A loan whose history reads *"Redemption &
statements ×4"* has a problem nobody has finished fixing.

**A ticket, on click.** Two things first, before the noise: **The issue** and
**The fix**, each labelled with where it came from. Then **related tickets** —
the same problem coming back, or the follow-up — the loans and records it
touches, who worked it, its SLA clock, and the full thread with the comment the
fix was read out of highlighted.

**Who's completing what.** Per person: how many tickets they closed, how long
they take (median and p90), how fast they first respond, how often they breach
SLA, and how many distinct loans they have touched. Grouped by **CK User**, not
by Jira assignee — see [Who actually worked it](#who-actually-worked-it). Any
row clicks through to the tickets behind it.

**Recurring errors.** What goes wrong most often, which loans come back most,
which topics take longest, volume over time, and the same view built from Jira's
own Components for comparison.

**Only mine.** One toggle narrows every number on every tab to your tickets.

Clicking **OPSTracker** at the top left returns the page to how it looks on a
fresh load — every filter cleared, nothing selected, back on Loans. It does not
re-fetch: the data is already right, and going home should be instant. Refresh
is the control for new data.

## Only production issues

This desk takes two kinds of request, and the dashboard only ever counts one:

| Request type | Tickets | Included |
|---|---|---|
| Salesforce Issues & Service Requests | 769 | yes |
| Salesforce Feature Request | 84 | no |

Feature requests are planned work. Mixing them into "how long does a ticket
take" or "how many are still open" makes both numbers lie — a feature request
parked open for two years is not an outstanding production incident. They are
filtered out of everything: the KPIs, the loan timelines, the throughput table
and every chart. The masthead says how many were excluded so the number is never
silently different from Jira's own count.

The server accepts `?featureRequests=1` if you ever need them, but nothing in
the UI turns it on.

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
| `CK_ME_EMAIL` | optional; who "Only mine" means, since the Jira login is shared |

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

## Who actually worked it

The Jira login for this desk is a **single shared account**. So `assignee` does
not answer "which of us picked this up" — it is usually the Folk2Folk-side owner,
and on plenty of tickets it is the shared desk account itself. The field that
answers it is **CK User** (`customfield_10067`), a user picker naming the
CloudKaptan person who took the ticket.

Everything about throughput therefore groups by CK User, and the ticket list
shows it as its own column and filter. Jira assignee is still available as an
alternative grouping in the throughput view, because "which F2F owner does this
sit with" is a real question too — just a different one.

CK User is set on 307 of 769 production tickets. The rest are grouped under a
named **"— not set —"** bucket rather than dropped: it is the largest single
group, and hiding it would flatter everyone's individual numbers.

**Only mine** needs to know who you are, which the shared token cannot tell it.
Set `CK_ME_EMAIL` to the email on your Jira account — the same one the CK User
field holds.

## Two different clocks

There are two honest answers to "how long did this ticket take", and on this
project they disagree by an order of magnitude:

| Ticket | Work time (SLA) | Calendar wait |
|---|---|---|
| OPS-878 | 18 minutes | 14 days |
| OPS-882 | 17 minutes | 6 days |
| OPS-884 | 24h 53m | 3 days |

**Work time** is Jira's SLA clock: working hours only, against the desk's
calendar, excluding nights, weekends and time the SLA was paused. It answers
*how much work was this*, and it is the number the throughput view leads with.

**Calendar wait** is raised-to-resolved wall-clock. It answers *how long did the
reporter wait*, which matters to the business but says nothing about effort.

Both are shown, always labelled, never mixed into one figure. Work time prints
in hours and never rolls into days (`24h 53m`, not `1d`) because that is how
Jira prints it and how the desk's goals are written (`80h`) — showing working
time as "1d" invites reading it as a calendar day.

Medians and p90 throughout, never means: one ticket left open over a holiday
otherwise rewrites a person's whole record. A person with fewer than three
resolved tickets is left out of the work-time chart, and the chart says who was
left out.

## Related tickets

Tickets here reference each other constantly, in two different ways, and both
are indexed:

- **Jira issue links** — "relates to", "is blocked by". Typed and deliberate;
  84 tickets have them.
- **Keys typed into prose** — *"This loan is corrected, as a part of OPS - 806"*.
  Picked up in the same forgiving spellings as loan numbers (`OPS-806`,
  `OPS 806`, `OPS - 806`), from summaries, descriptions and comments.

Both directions are shown. A ticket's own record only knows what *it* points at;
the more useful half is often "what later tickets came back to this one", and
that is assembled by indexing mentions across the whole project once per load.
A ticket is never related to itself, and loan or application references are
never mistaken for ticket keys.

This surfaces real clusters. OPS-671, 747, 791, 796, 827 and 847 are all linked
to each other — and all six are LAI-766, the loan with the most tickets against
it. That is one unfixed root cause, visible as a cluster.

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
| **Written by *name*** | Somebody wrote this summary in OPSTracker deliberately. Trust it. |
| **From the ticket's Resolution Comments field** | Jira's own field for the fix, filled in by a person. Trust it. |
| **Pulled from *name*'s comment** | Extracted by scoring. It is a real comment, but nobody wrote it to be a summary. |
| **Taken from the reporter's own description** | The opening of the description, verbatim. |
| **Not recorded** | Nothing in the thread reads like a resolution. Said plainly rather than guessed. |

### The Resolution Comments field

Jira has a **Resolution Comments** field (`customfield_10140`) and this team uses
it — 70 tickets have one. When it says something, it *is* the fix and outranks
anything scraped from a thread:

> The issue is caused by the fact there are two redemption statements for the
> same loan, which both have investor breakdowns. The immediate resolution is to
> set the redundant statement to void.

But a minority of entries are status updates typed into the wrong box —
*"Closed as complete after Finance review"*, *"closed as confirmed updated"*.
Presenting one of those as "the fix" is the exact failure the comment scoring
exists to prevent, so the field is put through the same noise test. Because it is
the field *meant* for the fix, the test is inverted: it is used unless it reads as
nothing but a sign-off. So `1951 now funded` is kept and `closed as per updates`
is not.

A rejected entry is not hidden. The ticket says the field was filled in and
quotes it, so nobody concludes the team left it blank and fills it in twice.
OPS-847 is the live example: the field holds a sign-off, so the panel shows the
real fix from the thread *and* what the field says.

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
    stats.js        throughput, medians, the two clocks, duration formatting
netlify/functions/
  _jira.js          auth, paging, JQL scoping — the only place the token lives
  _fields.js        the custom-field map, and one issue -> record normaliser
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

`npm test` — 36 cases over reference normalisation, text cleanup,
classification, fix extraction, ticket cross-references and throughput maths. Every string in them is real text from the
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

## Caching, and not hammering Jira

Building the index means paging the whole project out of Jira — about five
seconds and one full pass — so re-fetching it on every page load is both slow and
the surest way to meet a rate limit. Three layers stop that:

1. **In the browser.** The index is stored in `localStorage` (~1 MB of a ~5 MB
   budget) and painted immediately on load. Inside 10 minutes it is served with
   **no request at all** — a reload costs ~0.6 seconds and zero Jira traffic.
2. **Conditional requests.** Past that, the browser asks with `If-None-Match`.
   An unchanged project answers **304, no body**, in about 10 ms.
3. **On the server.** A five-minute in-memory cache in the warm function
   container, so several people clicking around share one build.

**Refresh** bypasses all three. If Jira is unreachable but a cached copy exists,
the page renders from it and says so rather than showing nothing. A quota failure
in `localStorage` just means no browser cache — never a broken page.

The freshness line under the header always says which of these you are looking
at: *updated 19:15*, *from this browser, today*, or *checked just now ·
unchanged*.

## Things it does not do

- **Comment text is not indexed.** Covered by deep search; see above.
- **Loan numbers are only as good as what people typed.** A ticket that never
  names its loan cannot be grouped under it. Nothing here infers one.
- **A 5-minute cache** sits in front of Jira. **Refresh** bypasses it.
- **Around 850 tickets** is fetched in one pass. Far beyond that, the index
  endpoint would want a real store behind it rather than a warm-memory cache.
- **CK User is only set on 40% of tickets**, so the "— not set —" row is the
  biggest one in the throughput table. That is a data-entry gap, not a bug, and
  it is shown rather than hidden.
- **Throughput measures closure, not effort.** It counts tickets a person closed
  and the SLA time those took. The CK Time Spent and F2F Time Spent fields exist
  in Jira but are empty across the project, so nothing here uses them; if the
  team starts filling them in, the ticket panel already displays them.

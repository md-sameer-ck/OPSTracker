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

**Year on year.** Tickets *raised* this year against last, with a like-for-like
year-to-date cut so a full year is never compared against a part year. Filter to
any set of reporters — the finance team, or anyone — and **Save as PDF** prints
it through the browser. Sections: key metrics, monthly trend, reporter
breakdown, priority mix, and what this year's tickets were about.

**Queues.** Six working lists of *open* tickets only, with a count on the tab so
you can see there is work without opening it rather than another slice of history: what needs
picking up, work that has gone stale, escalations sitting with Q2, tickets that
came back after being closed, work awaiting client sign-off, and tickets on the
shared login with nobody named.

**Reopens.** Read from the status history and invisible in a ticket's current
fields — 63 of them here. The cheapest quality signal in the project.

**Ask Claude what to check** *(optional, off by default)*. On a ticket, sends it
and its nearest earlier tickets to Claude and asks what to look at first.
Requires `ANTHROPIC_API_KEY`; without one the button does not appear and nothing
is ever sent. Output is labelled as model-written — everything else in the panel
is a person's words or a quoted comment, and that distinction is the point.

**Who raised what.** The demand side: which part of the business generates the
load, what kind of problem each reporter brings, and how long their tickets take
before anyone can act.

**Did the fix hold?** Loans that came back after a ticket against them was
closed — 23% within 90 days here, 9% with the same topic. The strongest evidence
a root cause is still in place.

**Keyboard.** `/` jumps to the search box on whichever tab is open; `Esc` clears
it, closes an enlarged chart, or closes the ticket panel, innermost first.

**Hover anything abbreviated.** SLA, p90, work time, "with us", "delivered" —
every term with a dotted underline carries its full form on hover, defined once
so the wording cannot drift between a card, a table header and a ticket panel.

**Any chart, bigger.** Click a chart's title to open it full-screen with every
label spelled out — click outside or press Escape to come back. The ranked lists
open the same way, showing the whole list rather than the top dozen the card has
room for.

Clicking **OPSTracker** at the top left returns the page to how it looks on a
fresh load — every filter cleared, nothing selected, back on Loans. It does not
re-fetch: the data is already right, and going home should be instant. Refresh
is the control for new data.

## Three scopes, one dashboard

The queue serves two different jobs, so the scope selector in the header picks
which one you are looking at:

| Scope | Tickets | For |
|---|---|---|
| **Production issues** (default) | 604 | The developers — faults only |
| **Feature requests** | 86 | The Product Owner / Scrum Master backlog |
| **Everything** | 879 | The whole queue |

These are mutually exclusive. An earlier version had a "+ Feature requests"
toggle that *added* them to the production set, which read as "show me the
backlog" and delivered "show me both" — a control that looked like it had done
nothing. Switching scope rebuilds the index from Jira and takes about fifteen
seconds, so it shows an explicit loading banner rather than leaving the previous
scope's numbers on screen looking current.

## What "production issues" excludes

Two fields decide what counts, and the dashboard applies both everywhere — KPIs,
loan timelines, throughput and every chart:

**Request type** — which portal form was used.

| Request type | Tickets | Included |
|---|---|---|
| Salesforce Issues & Service Requests | 769 | yes |
| Salesforce Feature Request | 84 | no |

Feature requests are planned work. Mixing them into "how long does a ticket
take" or "how many are still open" makes both numbers lie — a feature request
parked open for two years is not an outstanding production incident.

**Type** — whether something broke, or somebody asked for something.

| Type | Tickets | Included |
|---|---|---|
| Issue | 416 | yes |
| *(not set)* | 168 | yes — see below |
| Service Request | 185 | no |

Service requests are asks, not faults: *"Mary Allen Access to CLS"*, *"CLS report
needed for FCA reporting"*, *"ISA application form"*. They are excluded.

Tickets where Type was never filled in are **kept**, deliberately. That field is
about as reliably populated as CK User, and the blanks are not simply old ones —
the newest ticket in the project is blank, and the blanks include plainly
production faults (*"Duplicate LAI for Snowball"*, *"error uploading the bank
interest file"*). Treating blank as "not an issue" would silently drop 168 real
issues, which is worse than including the occasional unlabelled request.

That leaves **584 production issues**. The masthead always names what was
excluded, so this figure can be reconciled against Jira's own rather than
quietly disagreeing with it.

Both exclusions have a server-side escape hatch — `?featureRequests=1` and
`?serviceRequests=1` — and neither is exposed in the UI.

## Running it locally

### What you need

**Node 18 or newer**, and nothing else. There is no build step, no bundler and
no `npm install` — the project has no runtime dependencies, and the only
third-party code is Chart.js, vendored at `site/vendor/chart.umd.js` (MIT).

```bash
node --version    # v18.0.0 or newer
```

### 1. Get a Jira API token

The dashboard reads Jira as you, over the REST API.

1. Go to **[id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)**
2. **Create API token**, give it a label like `opstracker`
3. Copy it now — Atlassian will not show it again

A **read-only** account is enough for everything except saving a fix summary,
which posts a comment and so needs permission to comment on the project.

### 2. Configure

```bash
git clone https://github.com/md-sameer-ck/OPSTracker.git
cd OPSTracker
cp .env.example .env
```

Then edit `.env`:

```ini
ATLASSIAN_DOMAIN=your-team.atlassian.net
ATLASSIAN_EMAIL=you@yourcompany.com
ATLASSIAN_TOKEN=ATATT3xFfGF0...
OPS_PROJECT_KEY=OPS
CK_ME_EMAIL=you@yourcompany.com
```

| Variable | Required | |
|---|---|---|
| `ATLASSIAN_DOMAIN` | yes | Host only — **no** `https://`, no trailing slash. It is the host in the URL when you browse Jira: `https://`**`your-team.atlassian.net`**`/browse/OPS-884`. |
| `ATLASSIAN_EMAIL` | yes | The account the token belongs to. Not a display name. |
| `ATLASSIAN_TOKEN` | yes | From step 1. |
| `OPS_PROJECT_KEY` | no | Defaults to `OPS`. |
| `CK_ME_EMAIL` | no | Who **Only mine** means. Needed because the Jira login is a shared desk account, so the app cannot work out who you are from the token — see [Who actually worked it](#who-actually-worked-it). Match the email on your Jira account, which is what the CK User field holds. |

`.env` is gitignored. Never commit it.

### 3. Run

```bash
npm run dev
```

```
loaded .env
OPSTracker dev server: http://localhost:8888
```

Open **http://localhost:8888**. The first load pages the whole project out of
Jira — around **ten seconds** for ~850 tickets, since each one carries its SLA
cycles, custom fields and issue links. That cost is paid once: it is cached
server-side, then in your browser, so every load after it comes back in well
under a second. See [Caching](#caching-and-not-hammering-jira).

**If 8888 is already taken** — usually another copy of this server still running
from an earlier session — it steps up to the next free port instead of failing,
and says so:

```
port 8888 is in use — trying 8889

  ⚠  8888 was busy — this server is on 8889, not 8888.

OPSTracker dev server: http://localhost:8889
```

Read that line rather than assuming 8888: the usual way to lose ten minutes here
is to keep reloading a stale tab on the old port. It tries ten ports before
giving up. To pin one yourself, `PORT=9000 npm run dev` — which also falls
forward if 9000 is busy.

### 4. Run the tests

```bash
npm test
```

41 cases over reference normalisation, text cleanup, classification, fix
extraction, ticket cross-references, ticket state and throughput maths. No
network and no credentials — they run against fixed strings taken from real
tickets.

## While you are working on it

**Editing a Netlify function** (`netlify/functions/*.js`) takes effect on the
next request — the dev server re-imports a function module whenever its file
changes on disk, so there is no restart.

**Editing the site** (`site/*`) just needs a browser reload.

**But the browser caches the index for 10 minutes**, which is exactly what you
want in use and occasionally not what you want mid-change. If you have altered
what `ops-issues.js` returns and the page still shows the old shape, click
**Refresh** in the header — it clears the browser copy and re-fetches. Changing
`CACHE_VERSION` in `site/app.js` also invalidates every stored copy, which is
what to do if you change the record shape for real.

### Looking at the UI without a Jira token

Useful for working on the front end, or for showing someone the dashboard
before they have credentials.

```bash
# once, with credentials available, save a Jira search response to a file
node scripts/make-fixture.js path/to/jira-search-export.json > data/demo-index.json

# then, with no .env needed at all
DEMO_INDEX=data/demo-index.json npm run dev
```

The index is served from the fixture. Opening a ticket still calls Jira, so in
demo mode a ticket panel will report the missing credentials unless the fixture
also carries that ticket's thread — which is deliberate, since inventing a
thread would be worse than saying so.

`data/` is gitignored: fixtures hold real ticket text, so generate your own
rather than committing one.

### Optional: the real Netlify runtime

The included dev server exists so that nothing has to be installed globally. If
you would rather run the actual Netlify environment:

```bash
npm install -g netlify-cli
netlify dev
```

`netlify.toml` already publishes `site/` and maps `/api/*` to the functions, so
both routes behave identically.

## When it will not start

| What you see | What it means |
|---|---|
| `no .env found` on startup | The page loads but shows a red banner naming the missing variables. Copy `.env.example` to `.env`. |
| `Server is missing ATLASSIAN_DOMAIN, …` | Those variables are absent or empty. In `.env`, check there are no quotes or trailing spaces. |
| `Jira rejected the credentials (401)` | Wrong email, or a revoked/mistyped token. The email must be the account the token was created under. |
| `The Jira account lacks permission for this (403)` | The account cannot see the project. Check it has access to `OPS` in Jira. |
| `Could not reach Jira: {"errorMessage": "Site temporarily unavailable"}` | Almost always a wrong `ATLASSIAN_DOMAIN`. Atlassian answers *any* unclaimed `*.atlassian.net` name this way rather than refusing the connection, so a typo in the tenant looks like an outage. Check the host against the URL in your browser. |
| `Could not reach Jira: fetch failed` | The host does not resolve at all. `ATLASSIAN_DOMAIN` must be the bare host — no `https://`, no path, no trailing slash. |
| `does not exist, or the account cannot see it` on a ticket | Correct credentials, but that issue key is not visible to this account. |
| `port 8888 is in use — trying 8889` | Not an error. Another server is already on 8888, so this one moved up. Open the port it prints. |
| `Ports 8888–8897 are all in use` | Ten consecutive ports are occupied, which usually means a pile of servers left running. `pkill -f dev-server.js`, or pick a free one with `PORT=9000 npm run dev`. |
| Empty dashboard, no error | The project has no tickets matching the filters — everything was excluded as a feature or service request. See [Only production issues](#what-production-issues-excludes). |
| A read-only token, and saving a summary fails | Expected: writing a note posts a Jira comment. Use an account that can comment. |

## Deploying

On Netlify: point a site at this repo and set the same variables under **Site
settings → Environment variables**. `netlify.toml` handles the rest — it
publishes `site/` and maps `/api/*` to `netlify/functions/`. There is no build
command to configure.

The five-minute server-side cache lives in the warm function container, so
several people clicking around share one build of the index rather than each
paying for their own.

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

## The workflow, and what "open" means

Jira's status categories collapse everything into new / in progress / done. The
desk's actual workflow has seven meanings:

| Status | Means | Counts as |
|---|---|---|
| To Do | Raised, nobody has picked it up | Our queue |
| Acknowledged | Read and analysed; work not started | Our queue |
| In Progress | The actual work | **The only status that counts as work time** |
| Pending | Work remaining, parked for now | Our queue — not delivered |
| Waiting on Customer | Our work is done, awaiting client sign-off | **Delivered** |
| Q2 | Escalated to the product help desk | **Its own outcome** — not delivered |
| Done / Declined / Moved to Backlog | Closed | Delivered |

Two of these earn their own treatment:

**Q2 is not a delivery.** Reaching Q2 means we could not fix it. Counting it as
delivered would flatter exactly the case worth seeing — and on the live project
those 24 tickets have been open up to **751 days**.

**Pending is still ours.** There is work remaining on it, so it stays in the
queue rather than joining the delivered pile.

## Time actually spent

Work time is **elapsed time in In Progress, summed across every visit**. Tickets
bounce — In Progress → Pending → In Progress → Waiting on Customer — so the gap
between two dates is not the work; each visit has to be added up. That comes
from the status history, which rides along with the same Jira request the index
already makes, so it costs no extra round trips.

Acknowledged is measured separately as **queue wait**: read and accepted, but
not yet started.

### Two caveats worth knowing before quoting a number

**In Progress is often flipped late.** Across delivered tickets the median time
in In Progress is **8 minutes**, while the median in Acknowledged is **56
minutes** — and 48% of tickets spend longer in Acknowledged than In Progress.
OPS-847 sat 18 days in Acknowledged and under a minute In Progress. That is a
workflow-hygiene signal, not a measurement of eight-minute fixes. The ticket
panel draws the full status breakdown for exactly this reason: a single number
is only as good as when the status was set.

**These are elapsed hours, not working hours.** A ticket left In Progress over a
weekend counts the weekend. Jira's SLA clock applies the desk's working calendar
but to the wrong scope — it keeps running through Pending, Waiting and Q2 alike
— so neither figure is both right. Both are shown, labelled. Intersecting the In
Progress intervals with a working calendar is the upgrade if it matters.

### Credit for the work

A ticket handed over mid-flight credits each person with the stretches they
personally held — replayed from the CK User and assignee history against the
In Progress intervals. Without that, whoever closes a ticket inherits every hour
spent on it and whoever did the first half gets none. 42 tickets here changed
hands while being worked. The **Helped on** column counts tickets a person
worked but somebody else finished; **Delivered** is always credited to whoever
closed it.

### Who worked it

Atlassian seats are expensive, so the CK team shares one login — FOLK2FOLK CK
DESK — and records the individual in the **CK User** field. Folk2Folk's own
staff are assigned normally and have no CK User:

| | Tickets | With a CK User |
|---|---|---|
| assignee = shared desk | 313 | 288 (92%) |
| assignee = named person | 237 | 10 (4%) |

So neither field alone answers "who worked this". The default grouping is the
**assignee, unless it is the shared desk, in which case the CK User** — which
turns a 304-ticket "not set" bucket into named people. Credit goes to whoever
holds the ticket at the end, which is who finished it. Assignee, CK User and
reporter are all still available as separate groupings.

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

### About the tests

Running them is covered in [Run the tests](#4-run-the-tests). What matters about
them is that every string in them is real text from the OPS project — the
heuristics are tuned to how this team actually writes, so the tests have to be
too. The ones carrying the most weight assert that a sign-off is never mistaken
for a fix, and that a ticket parked with Q2 is never counted as our backlog.

## The year-on-year report

Answers "are we generating fewer problems than last year", so it counts tickets
**raised** in a period rather than resolved.

Two things it is careful about, because both are easy ways to report a change
that did not happen:

- **Like-for-like.** Each year carries a full-year total *and* a year-to-date
  count cut at the same month and day as today. The headline percentage always
  compares YTD against YTD. The monthly table's total row deliberately shows no
  variance, because subtracting a part year from a full one is exactly the
  number this avoids.
- **The month in progress** is labelled *(to 17 Sep)* and months that have not
  happened yet show `—` rather than `0`.

Priority shifts are shown uncoloured on purpose: more *Highest* is bad, more
*Low* is fine, so one colour rule would be wrong half the time.

**Save as PDF** is the browser's own print-to-PDF — no dependency, and it
already knows how to paginate. A print stylesheet drops the header, tabs and
every other view so only the report prints.

### Reporter names

Jira holds whatever the account has, so a couple differ from how people refer to
them — `GillAlford@folk2folk.com` has no display name set, and `Siobhan Parson`
has no trailing "s". Reporters are listed exactly as Jira has them rather than
being mapped to tidier names, so the list can be reconciled against Jira.

## Caching, and not hammering Jira

Building the index means paging the whole project out of Jira — roughly ten
seconds and one full pass over ~850 tickets — so re-fetching it on every page
load is both slow and the surest way to meet a rate limit. Three layers stop
that:

1. **In the browser.** The index is stored in `localStorage` (~1 MB of a ~5 MB
   budget) and painted immediately on load. Inside 10 minutes it is served with
   **no request at all** — a reload costs ~0.6 seconds and makes zero requests.
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
- **CK User occasionally holds a Folk2Folk person** rather than a CloudKaptan
  one. Those are excluded from the CK-user axis by email domain, so they land on
  the assignee axis where they belong.
- **CK User is only set on 40% of tickets**, so the "— not set —" row is the
  biggest one in the throughput table. That is a data-entry gap, not a bug, and
  it is shown rather than hidden.
- **Type is unset on 168 tickets**, which are kept as issues. If a service
  request is sitting in that group it is being counted as a production issue;
  filling the field in on new tickets is the only fix.
- **Throughput measures closure, not effort.** It counts tickets a person closed
  and the SLA time those took. The CK Time Spent and F2F Time Spent fields exist
  in Jira but are empty across the project, so nothing here uses them; if the
  team starts filling them in, the ticket panel already displays them.

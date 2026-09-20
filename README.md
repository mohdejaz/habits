# Habit Budget

A phone-first PWA for keeping habits inside a **weekly budget** — an amount of
time, a number of things, an amount of money, or simply whether you did it.

The week is a grid: the days down the side, the habits across. The day column is
frozen and the habits scroll sideways under it, so a week stays labelled however
many habits there are. Tap any cell to log an amount for that habit on that day,
so recording Tuesday's coffees on Thursday is the same gesture as recording
today's. The whole week is one picture — where the budget has gone, and which
days it went on.

Below the grid, a strip of bars per habit shows the last twelve weeks against
budget — the one thing a week view cannot tell you, which is whether anything is
getting better.

Everything runs offline: SQLite is compiled to WebAssembly and the database file
lives in the browser, so there is no server and no account.

<!-- screens: the week grid, a day sheet, habit editor -->

## Running it

```bash
npm install        # only sql.js (app) and puppeteer-core (tests)
npm start          # http://localhost:4173
```

The server prints a LAN address too, so you can open it on your phone over Wi-Fi.

## Installing it on a phone

Open the site in Safari or Chrome and use **Add to Home Screen**. It then launches
full-screen, works with no network, and keeps a running timer alive across launches.

One caveat: service workers only register on `https://` or `localhost`. Over a plain
LAN address (`http://192.168.x.x`) the app still runs, but it will not install or work
offline. To get the real thing on your phone, publish it over HTTPS — see below.

## Publishing to GitHub Pages

`.github/workflows/pages.yml` deploys `public/` on every push to `main`. Enable it once:

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

Then push. The app lands at `https://<user>.github.io/<repo>/` — every path in the app
is relative, so serving from a subdirectory needs no configuration.

Two details the workflow handles:

- Before uploading, it rewrites `CACHE` in `sw.js` to the commit SHA. The service worker
  is cache-first, so without a new cache name a returning visitor would keep the old
  shell forever; changing the name makes the worker reinstall and drop the previous one.
- `public/.nojekyll` keeps Jekyll off the files (it only matters if you switch Pages back
  to deploying from a branch — the Actions path never runs Jekyll).

Nothing here is Pages-specific beyond the workflow: `public/` is a plain static
directory, so Netlify, Cloudflare Pages, or a folder on your own server work the same.

## How it works

- **Budgets are weekly.** A week starts on Monday by default (changeable in Settings).
  Usage is the sum of entries whose timestamp falls in that week, so the budget resets
  on its own — nothing needs to run in the background.
- **Tapping a cell** opens the day sheet: the habit and the date are already
  decided by the cell, so it only has to answer *how much*. That is the whole of
  logging, and it is why backdating no longer needs a date picker — the grid is
  the date picker. Days that have not happened yet are inert, because logging
  into one is a mis-tap rather than an intention.
- **The day sheet lists that day's own entries, each removable.** Adding was
  never the hard part; taking a mistake back off was. A count habit had its
  stepper, but a stopwatch session or a logged spend could only be undone from
  the habit sheet's week-wide list — the wrong place to look for one day's
  mistake, and easy to miss entirely. Removing deletes the entry rather than
  writing a negative, so the log stays honest, and listing them individually
  means you can take off the 45m session and keep the 20m one.
- **Time habits** store minutes. The day sheet for the day still in progress
  offers the stopwatch; while it runs, today's cell ticks with a pulsing dot and
  the weekly budget counts down live. The running timer is a row in the `timers`
  table, not a JS variable, which is why closing the app does not lose it.
- **Count habits** store whole units. The day sheet keeps a `−  3  +` stepper
  that writes on the tap, so one more coffee is two taps rather than a form.
  `−` removes the most recent entry *of that day* rather than writing a negative
  number, so the log stays honest — and it removes the whole entry, so undoing a
  "3" takes all three.
- **Yes/no habits** store a tick a day and nothing else. Tapping a cell
  toggles it — asking "how much" in a sheet would be a tap of ceremony for a
  question with no answer — and the week is counted in days. They are the one
  kind that can point either way: a habit can be **at most** 2 days ("no
  booze") or **at least** 5 days ("meditate"), chosen in the editor. Reaching a
  target turns the column green rather than red, which is the whole reason the
  direction exists: built as a plain cap, "meditate 5 days" would go red for
  succeeding. Everything else is a cap, and the `at_least` column defaults to
  0, so nothing that already existed changed meaning.
- **Money habits** store amounts in the currency set in Settings — one currency for
  the whole app, since mixing them would mean exchange rates and those need a network.
  The amounts you have used before appear as chips in the day sheet and log again on
  a single tap. A negative amount is accepted, which is how you record a refund.
- **Cells are tinted with the habit's own colour**, so a week reads as a pattern
  before any of the numbers do. Because the columns scroll rather than being
  squeezed onto one screen, they are wide enough for the real formatting —
  `$12.50` and `1h 30m`, not an abbreviation of them — and for type you can
  read at arm's length. A count drops its unit, since the column is already
  headed with the habit's name.
- **Daily limits** are what the grid is best at. Set one in the habit editor and
  any day over it goes amber — every day, not just today, and on any week you
  scroll back to. The day runs local midnight to local midnight, so it resets
  with your day and not with UTC. Nothing is blocked: the log that crosses the
  limit says so in a toast, and later logs stay quiet rather than nagging.
  Leaving the field blank (or zero) means no daily limit.
- **Over budget** turns the habit's column header red and reports how far past
  you are instead of clamping at zero. Passing a daily limit is a separate,
  softer state: the cell goes amber and the column is left alone.
- **Tap a habit's name** for this week's entries, editing, hiding and deletion.
- `‹` / `›` move between weeks, and the header names the one you are on —
  "This week", "Last week", then "6 weeks ago". It deliberately does not fall
  through to the date range: that is what the line underneath already says, and
  printing both put the same dates on screen twice.
- **Tapping any date goes back to this week**, and while you are away the
  otherwise-empty corner above the day column carries a `Today` chip saying so.
  Tapping a trend bar can drop you eleven weeks back, so there has to be a way
  home that is not eleven presses of `‹`.
- An earlier week has no "today", so every one of its days is editable and none
  of them is marked.
- **Reordering** is a press and hold on the habit's *name*, then a drag
  sideways. The cells are targets in their own right, so only the name is a
  handle. Holding for 300ms is what separates a reorder from a scroll — moving
  before that cancels it, on either axis, since the habits scroll horizontally
  and the page scrolls vertically — and dragging to the edge of the strip
  scrolls it. `touch-action: pan-y` on the handle is load-bearing: without it
  the compositor claims the sideways gesture, ignores `preventDefault`, and
  fires `pointercancel` mid-drag. A synthesised mouse never reproduces that,
  so no browser test will catch it — only a finger will. The order is stored in `habits.sort_order`, which is why hiding
  and unhiding a habit puts it back where it was rather than on the end.
- **Hiding** a habit keeps every entry and only drops its column out of the week;
  Settings lists what is hidden and puts it back. A running timer is stopped and
  logged on the way out, so nothing keeps ticking where you cannot see it. This is
  `habits.archived`, and it is the honest alternative to deleting a habit you have
  stopped tracking but do not want to erase.
- **Compact** (Settings → Cards) narrows the columns and the day labels without
  dropping a day, so more habits fit before anything has to be scrolled to.

## Seeing more than one week

Budgets reset every week and the grid can only ever show one, so on its own the
app has no memory. The strip underneath is where that is answered: one row per
habit, one bar per week, twelve weeks of them.

It fills the space transposing left behind. Seven rows is seven rows however many
habits there are — they grow sideways now — so the gap below the grid is
permanent rather than an empty-state artefact.

- **Bars are scaled against the budget or the worst week, whichever is larger**,
  and the budget is drawn across as a dashed line. A week can then be read
  against what it was meant to be, not only against the other weeks. Over budget
  goes red, the same as everywhere else.
- **Weeks before the habit existed are not zero weeks, they are nothing.** They
  show as faint stubs and are left out of the average — otherwise every habit
  created recently would be libelled by the weeks before it existed.
- **The current week is excluded from the average too**, since it is still being
  filled in. A Monday would otherwise drag every habit down.
- `over 3×` counts the complete weeks that went past budget. It is the number
  that says whether a budget is a budget or a wish.
- **Tapping a bar takes the grid to that week**, and the bar for whichever week
  the grid is showing is ticked underneath. That is a much faster way back
  through history than pressing `‹` eleven times.

One trap worth recording, since it cost an hour to find: the bar modifier
classes are `zero`, `before`, `now` and `viewing`, and the obvious name for the
first of those — `empty` — silently breaks the layout. A bare
`.empty { padding: 12vh 32px }` already dresses the no-habits-yet screen, so
`.tbar.empty` inherits 101px of padding, blows the flex row out and collapses
the remaining bars to zero width. Nothing about the DOM looks wrong; only the
geometry gives it away. Compound modifiers in this stylesheet are safe, bare
ones are not.

## Your data

The database is a real SQLite file kept as bytes in IndexedDB under this origin. That
means it is fast and completely private — and also that it is tied to this browser on
this device. **Export a copy from Settings now and then**; a cleared cache, a new
phone, or an aggressive storage sweep takes the history with it otherwise. The exported
`.db` opens in any SQLite tool, and Import restores it.

Schema (`public/js/db.js`):

| table | purpose |
|---|---|
| `habits` | name, `kind` (`time`\|`count`\|`money`\|`bool`), `weekly_budget`, `daily_limit` (nullable), `at_least` (0 = a cap, 1 = a target), unit label, colour, `sort_order`, `archived` |
| `entries` | one row per logged session or tap: `amount`, `started_at`, `ended_at` |
| `timers` | at most one row per habit — a timer that is currently running |
| `meta` | settings: week start day, currency, compact cards |

`weekly_budget`, `daily_limit` and `amount` share one unit per kind — minutes, whole units, or major
currency units (`12.5` is £12.50) — so a budget can be compared to a sum directly.

Entries carry a timestamp, not a day number, so which column an entry lands in
is worked out at render time from the local calendar. `store.weekDays()` builds
the seven local midnight-to-midnight boundaries by date arithmetic rather than
by adding 24 hours seven times — the week containing a DST change has a 23- and
a 25-hour day in it, and flooring by 86400000 would file them under the wrong
column. An entry logged into a day that is not today lands at midday, far enough
from both edges that a DST shift cannot slide it into a neighbouring day.

Whether a week went well is decided in exactly one place — `standing()` in
`app.js` — which is what keeps the two directions from leaking into the cells,
the bar, the header and the trend strip separately.

Migrations are a list of SQL strings gated on `PRAGMA user_version`; append one to
`MIGRATIONS` and bump `SCHEMA_VERSION` to change the schema. Rebuilding a table
(as the `money` and `bool` migrations both do, since SQLite cannot alter a CHECK
constraint) has to disable foreign keys around the `DROP`, or the cascade takes
every entry with it.

## Layout

```
public/            the entire app — deploy this directory
  index.html       shell + dialogs
  css/app.css
  js/db.js         SQLite over IndexedDB: open, save, migrate, import/export
  js/store.js      habits, entries, timers, week and day maths
  js/app.js        the grid, the day sheet, and the rest of the interaction
                   (the frozen day column is one element, each habit another —
                    which is what makes a column draggable as a unit)
  sw.js            precaches the shell for offline use
  vendor/          sql.js wasm build (npm run sync-sqljs to refresh)
tools/serve.mjs    dev server
tools/make-icons.mjs  draws the PNG icons
tools/e2e.mjs      browser test suite
.github/workflows/pages.yml   deploys public/ to GitHub Pages
```

## Tests

```bash
npm start          # in one terminal
node tools/e2e.mjs # drives real Chrome: budgets for all three kinds, logging
                   # into any day of the week (including an earlier one), daily
                   # limits colouring the day and not the week, the day column
                   # staying frozen while the habits scroll, timer persistence,
                   # sideways drag-to-reorder by the name, that holding a cell
                   # never drags its column, the twelve-week trend (including
                   # that every bar gets its share of the width, which is how a
                   # colliding class name shows up), yes/no habits in both
                   # directions and that a day never holds two ticks, compact
                   # columns, offline load,
                   # export/import round-trip, and upgrading a database written
                   # before money existed
```

Needs Google Chrome installed at the usual macOS path.
# habits

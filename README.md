# Habit Budget

A phone-first PWA for keeping habits inside a **weekly budget** — an amount of time
(with a stopwatch), a number of things (with + / − buttons), or an amount of money
(logged from a sheet). Everything runs offline: SQLite is compiled to WebAssembly
and the database file lives in the browser, so there is no server and no account.

<!-- screens: week view, running timer, habit editor -->

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
- **Time habits** store minutes. Start the stopwatch and the card shows elapsed time
  alongside the remaining budget counting down live. The running timer is a row in the
  `timers` table, not a JS variable, which is why closing the app does not lose it.
- **Count habits** store whole units. `+` appends an entry; `−` removes the most recent
  entry of the week rather than writing a negative number, so the log stays honest.
- **Money habits** store amounts in the currency set in Settings — one currency for
  the whole app, since mixing them would mean exchange rates and those need a network.
  There is no natural increment for money, so **Log spend** opens a sheet; the amounts
  you have used before appear as chips there and log again on a single tap. A negative
  amount is accepted, which is how you record a refund.
- **Over budget** turns the card red and reports how far past you are instead of
  clamping at zero.
- Tap `⋯` on a card for this week's entries, manual logging, editing, hiding, and
  deletion.
- `‹` / `›` move between weeks. Past weeks are read-only for timers but still editable
  by hand.
- **Reordering** is a press and hold on a card, then a drag. Holding for 300ms is what
  separates a reorder from a scroll — moving before that cancels it — and dragging to
  the edge of the screen scrolls the list. The order is stored in `habits.sort_order`.
- **Hiding** a habit (`⋯` → Hide) keeps every entry and only drops it out of the week
  view; Settings lists what is hidden and puts it back. A running timer is stopped and
  logged on the way out, so nothing keeps ticking where you cannot see it. This is
  `habits.archived`, and it is the honest alternative to deleting a habit you have
  stopped tracking but do not want to erase.
- **Compact** (Settings → Cards) tightens padding and type without dropping anything,
  so a habit can still be logged from the list rather than through a sheet.

## Your data

The database is a real SQLite file kept as bytes in IndexedDB under this origin. That
means it is fast and completely private — and also that it is tied to this browser on
this device. **Export a copy from Settings now and then**; a cleared cache, a new
phone, or an aggressive storage sweep takes the history with it otherwise. The exported
`.db` opens in any SQLite tool, and Import restores it.

Schema (`public/js/db.js`):

| table | purpose |
|---|---|
| `habits` | name, `kind` (`time`\|`count`\|`money`), `weekly_budget`, unit label, colour, `sort_order`, `archived` |
| `entries` | one row per logged session or tap: `amount`, `started_at`, `ended_at` |
| `timers` | at most one row per habit — a timer that is currently running |
| `meta` | settings: week start day, currency, compact cards |

`weekly_budget` and `amount` share one unit per kind — minutes, whole units, or major
currency units (`12.5` is £12.50) — so a budget can be compared to a sum directly.

Migrations are a list of SQL strings gated on `PRAGMA user_version`; append one to
`MIGRATIONS` and bump `SCHEMA_VERSION` to change the schema. Rebuilding a table (as
the `money` migration does, since SQLite cannot alter a CHECK constraint) has to
disable foreign keys around the `DROP`, or the cascade takes every entry with it.

## Layout

```
public/            the entire app — deploy this directory
  index.html       shell + dialogs
  css/app.css
  js/db.js         SQLite over IndexedDB: open, save, migrate, import/export
  js/store.js      habits, entries, timers, week maths
  js/app.js        rendering and interaction
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
node tools/e2e.mjs # drives real Chrome: budgets for all three kinds, timer
                   # persistence, drag-to-reorder, hide/unhide, compact cards,
                   # offline load, export/import round-trip, and upgrading a
                   # database written before money existed
```

Needs Google Chrome installed at the usual macOS path.
# habits

# Habit Budget

A phone-first PWA for keeping habits inside a **weekly budget** — either an amount
of time (with a stopwatch) or a number of things (with + / − buttons). Everything
runs offline: SQLite is compiled to WebAssembly and the database file lives in the
browser, so there is no server and no account.

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
offline. To get the real thing on your phone, publish `public/` to any static host —
GitHub Pages, Netlify, Cloudflare Pages, a folder on your own server. There is nothing
to build; the directory is the app.

## How it works

- **Budgets are weekly.** A week starts on Monday by default (changeable in Settings).
  Usage is the sum of entries whose timestamp falls in that week, so the budget resets
  on its own — nothing needs to run in the background.
- **Time habits** store minutes. Start the stopwatch and the card shows elapsed time
  alongside the remaining budget counting down live. The running timer is a row in the
  `timers` table, not a JS variable, which is why closing the app does not lose it.
- **Count habits** store whole units. `+` appends an entry; `−` removes the most recent
  entry of the week rather than writing a negative number, so the log stays honest.
- **Over budget** turns the card red and reports how far past you are instead of
  clamping at zero.
- Tap `⋯` on a card for this week's entries, manual logging, editing, and deletion.
- `‹` / `›` move between weeks. Past weeks are read-only for timers but still editable
  by hand.

## Your data

The database is a real SQLite file kept as bytes in IndexedDB under this origin. That
means it is fast and completely private — and also that it is tied to this browser on
this device. **Export a copy from Settings now and then**; a cleared cache, a new
phone, or an aggressive storage sweep takes the history with it otherwise. The exported
`.db` opens in any SQLite tool, and Import restores it.

Schema (`public/js/db.js`):

| table | purpose |
|---|---|
| `habits` | name, `kind` (`time`\|`count`), `weekly_budget`, unit label, colour |
| `entries` | one row per logged session or tap: `amount`, `started_at`, `ended_at` |
| `timers` | at most one row per habit — a timer that is currently running |
| `meta` | settings, e.g. which day the week starts on |

Migrations are a list of SQL strings gated on `PRAGMA user_version`; append one to
`MIGRATIONS` and bump `SCHEMA_VERSION` to change the schema.

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
```

## Tests

```bash
npm start          # in one terminal
node tools/e2e.mjs # drives real Chrome: budgets, timer persistence,
                   # offline load, export/import round-trip
```

Needs Google Chrome installed at the usual macOS path.
# habits

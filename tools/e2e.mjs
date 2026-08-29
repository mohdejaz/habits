import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SP = process.env.OUT || new URL('../.e2e/', import.meta.url).pathname;
const fsp = await import('node:fs/promises');
// The profile carries IndexedDB, so a leftover one from the last run starts
// the suite with habits already in it. Every test below assumes empty.
await fsp.rm(`${SP}/chrome-profile`, { recursive: true, force: true });
await fsp.mkdir(SP, { recursive: true });
const HOLD = 300; // must match HOLD_MS in app.js
const ok = [], bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' — ' + extra : ''}`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  userDataDir: `${SP}/chrome-profile`,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle0' });
await page.waitForSelector('#empty:not([hidden])', { timeout: 10000 });
check('boots to empty state', true);

// --- create a time habit ---
await page.click('[data-action="add-habit"]');
await page.waitForSelector('#habit-dialog[open]');
await page.type('input[name=name]', 'Reading');
await page.type('input[name=budget]', '180');
await page.click('#habit-form button[type=submit]');
await page.waitForSelector('.card');

// --- create a count habit ---
await page.click('#fab');
await page.waitForSelector('#habit-dialog[open]');
await page.type('input[name=name]', 'Coffee');
await page.click('input[name=kind][value=count]');
await page.type('input[name=budget]', '10');
await page.type('input[name=unit]', 'cups');
await page.click('#swatches label:nth-child(3) input');
await page.click('#habit-form button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
check('creates time + count habits', true);

const read = () => page.$$eval('.card', (cards) => cards.map((c) => ({
  name: c.querySelector('.card-name').textContent,
  remaining: c.querySelector('[data-remaining]').textContent,
  label: c.querySelector('[data-remaining-label]').textContent,
  tally: c.querySelector('.tally')?.firstChild.textContent,
  spent: c.querySelector('[data-spent]')?.textContent,
  running: c.classList.contains('running'),
  over: c.classList.contains('over'),
  bar: c.querySelector('[data-bar]').style.width,
})));

let cards = await read();
check('time budget shows 3h left', cards[0].remaining === '3h' && cards[0].label === 'left of 3h', JSON.stringify(cards[0]));
check('count budget shows 10 cups left', cards[1].remaining === '10 cups', JSON.stringify(cards[1]));

// --- count: + and - ---
for (let i = 0; i < 3; i++) await page.click('.card:nth-child(2) [data-act=inc]');
cards = await read();
check('three taps of + log 3', cards[1].tally === '3' && cards[1].remaining === '7 cups', JSON.stringify(cards[1]));
check('progress bar tracks usage', cards[1].bar === '30%', cards[1].bar);

await page.click('.card:nth-child(2) [data-act=dec]');
cards = await read();
check('minus undoes one', cards[1].tally === '2' && cards[1].remaining === '8 cups', JSON.stringify(cards[1]));

// --- money: currency setting, spend sheet, quick repeat, overage ---
await page.click('#open-settings');
await page.waitForSelector('#settings-dialog[open]');
await page.select('#currency-select', 'GBP');
await page.evaluate(() => document.querySelector('#settings-dialog').close());

await page.click('#fab');
await page.waitForSelector('#habit-dialog[open]');
await page.type('input[name=name]', 'Takeaway');
await page.click('input[name=kind][value=money]');
const budgetLabel = await page.$eval('#budget-label', (e) => e.textContent);
check('budget label follows the currency', budgetLabel === 'Weekly budget (£)', budgetLabel);
const unitShown = await page.$eval('#unit-field', (e) => e.getBoundingClientRect().height > 0);
check('money habits hide the unit field', !unitShown);
await page.click('input[name=kind][value=count]');
const unitShownForCount = await page.$eval('#unit-field', (e) => e.getBoundingClientRect().height > 0);
check('count habits still show the unit field', unitShownForCount);
await page.click('input[name=kind][value=money]');
await page.type('input[name=budget]', '40');
await page.click('#habit-form button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('.card').length === 3);

cards = await read();
check('money budget renders as currency', cards[2].remaining === '£40.00' && cards[2].label === 'left of £40.00', JSON.stringify(cards[2]));

const logSpend = async (value) => {
  await page.click('.card:nth-child(3) [data-act=spend]');
  await page.waitForSelector('#amount-dialog[open]');
  await page.type('#amount-form input[name=amount]', value);
  await page.click('#amount-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#amount-dialog').open);
};

await logSpend('12.50');
cards = await read();
check(
  'logging a spend updates the card',
  cards[2].spent === '£12.50' && cards[2].remaining === '£27.50' && cards[2].bar === '31.25%',
  JSON.stringify(cards[2])
);

// the sheet offers the last amount back as a one-tap repeat
await page.click('.card:nth-child(3) [data-act=spend]');
await page.waitForSelector('#amount-dialog[open]');
const chips = await page.$$eval('#amount-quick .chip', (c) => c.map((x) => x.textContent));
check('recent amount offered as a chip', chips.length === 1 && chips[0] === '£12.50', JSON.stringify(chips));
await page.click('#amount-quick .chip');
await page.waitForFunction(() => !document.querySelector('#amount-dialog').open);
cards = await read();
check('tapping a chip logs it again', cards[2].spent === '£25.00' && cards[2].remaining === '£15.00', JSON.stringify(cards[2]));
await page.screenshot({ path: `${SP}/shot-money.png` });

await logSpend('20');
cards = await read();
check(
  'money over budget reports the overage',
  cards[2].over && cards[2].remaining === '£5.00' && /over your £40\.00 budget/.test(cards[2].label),
  JSON.stringify(cards[2])
);

// entries survive as ordinary rows, so history and delete work as elsewhere
await page.click('.card:nth-child(3) [data-act=detail]');
await page.waitForSelector('#detail-dialog[open]');
const moneySummary = await page.$eval('#detail-summary', (e) => e.textContent);
check('money detail summarises in currency', /^£45\.00 of £40\.00 used/.test(moneySummary), moneySummary);
const moneyEntries = await page.$$eval('#detail-entries li .amt', (l) => l.map((x) => x.textContent));
check('money entries listed individually', moneyEntries.join(',') === '£20.00,£12.50,£12.50', JSON.stringify(moneyEntries));
await page.evaluate(() => document.querySelector('#detail-dialog').close());

// changing the currency relabels without converting
await page.click('#open-settings');
await page.waitForSelector('#settings-dialog[open]');
await page.select('#currency-select', 'USD');
await page.evaluate(() => document.querySelector('#settings-dialog').close());
cards = await read();
check('currency change relabels amounts', cards[2].spent === '$45.00' && cards[2].remaining === '$5.00', JSON.stringify(cards[2]));

// editing must not offer to change the kind — past entries are in the old unit
await page.click('.card:nth-child(3) [data-act=detail]');
await page.waitForSelector('#detail-dialog[open]');
await page.click('[data-action="edit-habit"]');
await page.waitForSelector('#habit-dialog[open]');
const kindShown = await page.$eval('#kind-field', (e) => e.getBoundingClientRect().height > 0);
check('editing hides the kind picker', !kindShown);
await page.$eval('input[name=budget]', (e) => { e.value = ''; });
await page.type('input[name=budget]', '50');
await page.click('#habit-form button[type=submit]');
await page.waitForFunction(() => !document.querySelector('#habit-dialog').open);
cards = await read();
check(
  'editing a money habit keeps its kind and history',
  cards[2].spent === '$45.00' && cards[2].remaining === '$5.00'
    && cards[2].label === 'left of $50.00' && !cards[2].over,
  JSON.stringify(cards[2])
);

// put the app back to two habits so the rest of the suite is unaffected
await page.evaluate(async () => {
  const store = await import('./js/store.js');
  const takeaway = store.listHabits().find((h) => h.name === 'Takeaway');
  store.deleteHabit(takeaway.id);
});
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);

// --- reorder by long-press and drag ---
const cardNames = () => page.$$eval('.card-name', (n) => n.map((x) => x.textContent));
// Grip the card by its title: the middle of a card is a button.
const grip = (i) => page.$eval(`.card:nth-child(${i})`, (e) => {
  const r = e.getBoundingClientRect();
  return { x: r.x + 40, y: r.y + 16, mid: r.y + r.height / 2 };
});

const dragCard = async (fromIndex, toIndex) => {
  const from = await grip(fromIndex);
  const to = await grip(toIndex);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, HOLD + 120)); // hold still to lift it
  // Land past the target's midpoint, not exactly on it: the midpoint is the
  // swap boundary and sitting on it is ambiguous by definition.
  const dy = to.mid - from.mid + (toIndex < fromIndex ? -12 : 12);
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x, from.y + (dy * i) / 8);
  await new Promise((r) => setTimeout(r, 120));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 120));
};

check('starts in creation order', (await cardNames()).join(',') === 'Reading,Coffee', JSON.stringify(await cardNames()));

// a press that moves straight away is a scroll, not a drag
const beforeSlop = await cardNames();
{
  const from = await grip(1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(from.x, from.y + i * 20);
  await page.mouse.up();
}
check('a quick swipe does not reorder', (await cardNames()).join(',') === beforeSlop.join(','), JSON.stringify(await cardNames()));

await dragCard(1, 2);
check('dragging down reorders', (await cardNames()).join(',') === 'Coffee,Reading', JSON.stringify(await cardNames()));

await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.card');
check('the new order survives a reload', (await cardNames()).join(',') === 'Coffee,Reading', JSON.stringify(await cardNames()));

await dragCard(2, 1);
check('dragging up reorders back', (await cardNames()).join(',') === 'Reading,Coffee', JSON.stringify(await cardNames()));

// Two cards can't tell "one slot too far" from "correct": with a third card
// in play, an insertion has somewhere to overshoot to.
await page.click('#fab');
await page.waitForSelector('#habit-dialog[open]');
await page.type('input[name=name]', 'Stretching');
await page.type('input[name=budget]', '60');
await page.click('#habit-form button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('.card').length === 3);

await dragCard(1, 2);
check(
  'dragging into the middle lands in the middle',
  (await cardNames()).join(',') === 'Coffee,Reading,Stretching',
  JSON.stringify(await cardNames())
);

await page.evaluate(async () => {
  const store = await import('./js/store.js');
  store.deleteHabit(store.listHabits().find((h) => h.name === 'Stretching').id);
});
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
await dragCard(2, 1);
check('back to the starting order', (await cardNames()).join(',') === 'Reading,Coffee', JSON.stringify(await cardNames()));

// --- hide and unhide ---
await page.click('.card:nth-child(2) [data-act=detail]');
await page.waitForSelector('#detail-dialog[open]');
await page.click('[data-action="hide-habit"]');
await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
check('hiding takes the card out of the week', (await cardNames()).join(',') === 'Reading', JSON.stringify(await cardNames()));

await page.click('#open-settings');
await page.waitForSelector('#settings-dialog[open]');
const hiddenShown = await page.$eval('#hidden-field', (e) => e.getBoundingClientRect().height > 0);
const hiddenNames = await page.$$eval('.hidden-name', (n) => n.map((x) => x.textContent));
check('hidden habits are listed in settings', hiddenShown && hiddenNames.join(',') === 'Coffee', JSON.stringify(hiddenNames));
await page.click('#hidden-list [data-unhide]');
await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
const hiddenGone = await page.$eval('#hidden-field', (e) => e.getBoundingClientRect().height > 0);
cards = await read();
check(
  'unhiding restores the habit with its history',
  !hiddenGone && cards[1].name === 'Coffee' && cards[1].tally === '2',
  JSON.stringify(cards[1])
);

// --- compact cards ---
const cardHeight = () => page.$eval('.card:nth-child(2)', (e) => Math.round(e.getBoundingClientRect().height));
const roomy = await cardHeight();
await page.click('#density input[value=compact]');
const dense = await cardHeight();
check('compact shrinks the card', dense < roomy * 0.8, `${roomy}px -> ${dense}px`);
const keepsControls = await page.$$eval('.card:nth-child(2) [data-act]', (b) => b.length);
check('compact keeps the logging controls', keepsControls === 3, `buttons=${keepsControls}`);
await page.evaluate(() => document.querySelector('#settings-dialog').close());
await page.screenshot({ path: `${SP}/shot-compact.png` });

await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.card');
check('compact survives a reload', (await cardHeight()) === dense, `${await cardHeight()}px`);

// back to comfortable for the rest of the suite
await page.click('#open-settings');
await page.waitForSelector('#settings-dialog[open]');
await page.click('#density input[value=comfortable]');
await page.evaluate(() => document.querySelector('#settings-dialog').close());
check('comfortable restores the card', (await cardHeight()) === roomy, `${await cardHeight()}px`);

// --- timer ---
await page.click('.card:nth-child(1) [data-act=toggle-timer]');
await new Promise((r) => setTimeout(r, 2500));
cards = await read();
const elapsed = await page.$eval('.card [data-elapsed]', (e) => e.textContent.trim());
check('timer runs and ticks', cards[0].running && /^0:0[23]$/.test(elapsed), `elapsed=${elapsed}`);
await page.screenshot({ path: `${SP}/shot-running.png` });

// --- timer survives a reload (persisted in SQLite) ---
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.card');
await new Promise((r) => setTimeout(r, 1200));
cards = await read();
const elapsed2 = await page.$eval('.card [data-elapsed]', (e) => e.textContent.trim());
check('running timer survives reload', cards[0].running && parseInt(elapsed2.split(':')[1]) >= 3, `elapsed=${elapsed2}`);
check('logged counts survive reload', cards[1].tally === '2', JSON.stringify(cards[1]));

// --- stop the timer, entry is recorded ---
await page.click('.card:nth-child(1) [data-act=toggle-timer]');
await page.waitForFunction(() => !document.querySelector('.card').classList.contains('running'));
cards = await read();
check('stopping logs elapsed time', cards[0].remaining === '3h' && !cards[0].running, JSON.stringify(cards[0]));

// --- over budget ---
await page.evaluate(async () => {
  const store = await import('./js/store.js');
  store.addManualEntry(1, 200);
});
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.card');
cards = await read();
check('over budget flips to overage', cards[0].over && /over your 3h budget/.test(cards[0].label), JSON.stringify(cards[0]));

// --- week navigation ---
await page.click('#week-prev');
await page.waitForFunction(() => document.querySelector('#week-title').textContent === 'Last week');
cards = await read();
check('previous week is empty', cards[0].remaining === '3h' && cards[1].tally === '0', JSON.stringify(cards));
check('next-week button re-enables', !(await page.$eval('#week-next', (b) => b.disabled)));
await page.click('#week-next');
await page.waitForFunction(() => document.querySelector('#week-title').textContent === 'This week');
check('cannot navigate past this week', await page.$eval('#week-next', (b) => b.disabled));

// --- detail sheet + delete ---
await page.click('.card:nth-child(2) [data-act=detail]');
await page.waitForSelector('#detail-dialog[open]');
const entryCount = await page.$$eval('#detail-entries li', (l) => l.length);
check('detail lists this week\'s entries', entryCount === 2, `entries=${entryCount}`);
await page.screenshot({ path: `${SP}/shot-detail.png` });
page.on('dialog', (d) => d.accept());
await page.click('[data-action="delete-habit"]');
await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
check('deletes a habit', true);

// --- persistence across a full restart ---
await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
await page.close();
const page2 = await browser.newPage();
await page2.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
await page2.goto('http://localhost:4173/', { waitUntil: 'networkidle0' });
await page2.waitForSelector('.card');
const names = await page2.$$eval('.card-name', (n) => n.map((x) => x.textContent));
check('data survives a fresh session', names.length === 1 && names[0] === 'Reading', JSON.stringify(names));

// --- service worker / offline ---
const swReady = await page2.evaluate(() => navigator.serviceWorker.ready.then((r) => Boolean(r.active)));
check('service worker active', swReady);
await page2.setOfflineMode(true);
await page2.reload({ waitUntil: 'domcontentloaded' });
await page2.waitForSelector('.card', { timeout: 10000 });
check('loads fully offline', (await page2.$$('.card')).length === 1);
await page2.setOfflineMode(false);
await page2.screenshot({ path: `${SP}/shot-home.png` });

// --- export / import backup round-trip ---
const { DatabaseSync } = await import('node:sqlite');
const fs = fsp;
const downloads = `${SP}/downloads`;
await fs.rm(downloads, { recursive: true, force: true });
await fs.mkdir(downloads, { recursive: true });
await page2.createCDPSession().then((cdp) =>
  cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
);

page2.on('dialog', (d) => d.accept());
await page2.click('#open-settings');
await page2.waitForSelector('#settings-dialog[open]');
await page2.click('#export-db');

const exported = await (async () => {
  for (let i = 0; i < 50; i++) {
    const files = (await fs.readdir(downloads)).filter((f) => f.endsWith('.db'));
    if (files.length) return `${downloads}/${files[0]}`;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
})();
check('export writes a .db file', Boolean(exported), String(exported));

// The export must be a genuine SQLite file, readable outside the browser.
let external = 'unreadable';
if (exported) {
  const file = new DatabaseSync(exported, { readOnly: true });
  const habits = file.prepare('SELECT name, kind, weekly_budget FROM habits').all();
  const entries = file.prepare('SELECT COUNT(*) AS n FROM entries').get();
  external = JSON.stringify({ habits, entries });
  check(
    'exported file opens in a real SQLite client',
    habits.length === 1 && habits[0].name === 'Reading' && habits[0].kind === 'time' && entries.n > 0,
    external
  );
  file.close();
}

// Wipe the app, then restore from the exported file.
await page2.evaluate(async () => {
  const store = await import('./js/store.js');
  for (const h of store.listHabits()) store.deleteHabit(h.id);
});
await page2.reload({ waitUntil: 'networkidle0' });
await page2.waitForSelector('#empty:not([hidden])');
check('wiped back to empty state', true);

await page2.click('#open-settings');
await page2.waitForSelector('#settings-dialog[open]');
await (await page2.$('#import-file')).uploadFile(exported);
await page2.waitForSelector('.card', { timeout: 10000 });
const restored = await page2.$$eval('.card', (cards) => cards.map((c) => ({
  name: c.querySelector('.card-name').textContent,
  label: c.querySelector('[data-remaining-label]').textContent,
})));
check(
  'import restores habits and history',
  restored.length === 1 && restored[0].name === 'Reading' && /over your 3h budget/.test(restored[0].label),
  JSON.stringify(restored)
);

// A file that isn't one of ours must be rejected without destroying anything.
const junk = `${downloads}/junk.db`;
await fs.writeFile(junk, Buffer.from('this is definitely not a database'));
await page2.click('#open-settings');
await page2.waitForSelector('#settings-dialog[open]');
await (await page2.$('#import-file')).uploadFile(junk);
await new Promise((r) => setTimeout(r, 600));
const toastText = await page2.$eval('#toast', (t) => t.textContent);
const survived = await page2.$$eval('.card-name', (n) => n.map((x) => x.textContent));
check(
  'rejects a junk file and keeps existing data',
  /not a Habit Budget database/.test(toastText) && survived.length === 1,
  `toast="${toastText}" cards=${JSON.stringify(survived)}`
);
await page2.evaluate(() => document.querySelector('#settings-dialog').close());

// --- a database written before money existed must upgrade in place ---
// The v1 schema is frozen here on purpose: it is what real installs contain,
// and its CHECK constraint accepts only 'time' and 'count'.
const legacy = `${downloads}/legacy-v1.db`;
{
  const old = new DatabaseSync(legacy);
  old.exec(`
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('time','count')),
      weekly_budget REAL NOT NULL, unit TEXT,
      color TEXT NOT NULL DEFAULT '#5b8def',
      sort_order INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL);
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
      amount REAL NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, note TEXT);
    CREATE INDEX entries_habit_started ON entries(habit_id, started_at);
    CREATE TABLE timers (
      habit_id INTEGER PRIMARY KEY REFERENCES habits(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const now = Date.now();
  old.exec(`INSERT INTO habits (name, kind, weekly_budget, color, sort_order, created_at)
            VALUES ('Walking','time',150,'#3ec98a',0,${now})`);
  old.exec(`INSERT INTO entries (habit_id, amount, started_at) VALUES (1, 30, ${now}), (1, 20, ${now})`);
  old.exec('PRAGMA user_version = 1');
  old.close();
}

await page2.click('#open-settings');
await page2.waitForSelector('#settings-dialog[open]');
await (await page2.$('#import-file')).uploadFile(legacy);
await page2.waitForFunction(
  () => [...document.querySelectorAll('.card-name')].some((n) => n.textContent === 'Walking'),
  { timeout: 10000 }
);
const upgraded = await page2.$$eval('.card', (cards) => cards.map((c) => ({
  name: c.querySelector('.card-name').textContent,
  remaining: c.querySelector('[data-remaining]').textContent,
})));
check(
  'a v1 database opens with its history intact',
  upgraded.length === 1 && upgraded[0].name === 'Walking' && upgraded[0].remaining === '1h 40m',
  JSON.stringify(upgraded)
);

// The point of the migration: the widened CHECK now accepts money.
await page2.click('#open-settings');
await page2.waitForSelector('#settings-dialog[open]');
await page2.select('#currency-select', 'EUR');
await page2.evaluate(() => document.querySelector('#settings-dialog').close());
await page2.click('#fab');
await page2.waitForSelector('#habit-dialog[open]');
await page2.type('input[name=name]', 'Groceries');
await page2.click('input[name=kind][value=money]');
await page2.type('input[name=budget]', '60');
await page2.click('#habit-form button[type=submit]');
await page2.waitForFunction(() => document.querySelectorAll('.card').length === 2);
const added = await page2.$eval('.card:nth-child(2) [data-remaining]', (e) => e.textContent);
check('money habits can be added to an upgraded database', added === '€60.00', added);

console.log('\nPASS:');
ok.forEach((s) => console.log('  ✓ ' + s));
if (bad.length) { console.log('\nFAIL:'); bad.forEach((s) => console.log('  ✗ ' + s)); }
if (errors.length) { console.log('\nPAGE ERRORS:'); errors.forEach((e) => console.log('  ! ' + e)); }
await browser.close();
process.exit(bad.length || errors.length ? 1 : 0);

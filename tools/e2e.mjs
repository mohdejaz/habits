// e2e.mjs — drives real Chrome against the real app.
//
// The app is a grid: the days down the side, habits across in a horizontally
// scrolling strip under a frozen day column. Almost every test goes through a
// cell, because that is how everything is logged now.

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

// A thrown step would otherwise take the whole report with it, leaving a stack
// trace and no idea how far the suite got.
function report() {
  console.log('\nPASS:');
  ok.forEach((s) => console.log('  ✓ ' + s));
  if (bad.length) { console.log('\nFAIL:'); bad.forEach((s) => console.log('  ✗ ' + s)); }
  if (errors.length) { console.log('\nPAGE ERRORS:'); errors.forEach((e) => console.log('  ! ' + e)); }
}
process.on('uncaughtException', (err) => {
  console.log(`\nCRASHED: ${err?.message || err}`);
  report();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.log(`\nCRASHED: ${err?.message || err}`);
  report();
  process.exit(1);
});

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle0' });
await page.waitForSelector('#empty:not([hidden])', { timeout: 10000 });
check('boots to empty state', true);

/* ---------- helpers ---------- */

const colState = (n) => page.$eval(`.hcol:nth-child(${n})`, (el) => ({
  name: el.querySelector('.hcol-name').textContent,
  left: el.querySelector('[data-left]').textContent,
  bar: el.querySelector('[data-bar]').style.width,
  over: el.classList.contains('over'),
  running: el.classList.contains('running'),
  cells: [...el.querySelectorAll('[data-cell]')].map((c) => ({
    text: c.textContent,
    over: c.classList.contains('over'),
    logged: c.classList.contains('logged'),
    future: c.hasAttribute('disabled'),
    ticking: c.classList.contains('ticking'),
  })),
}));

const colNames = () => page.$$eval('.hcol-name', (n) => n.map((x) => x.textContent));

// Which column is today, so the timer and "future" tests know where to look.
const todayIndex = () => page.evaluate(async () => {
  const store = await import('./js/store.js');
  return store.dayIndexOf(Date.now(), store.weekDays(store.weekRange(0)));
});

const openCell = async (col, day) => {
  // Scroll it into the strip first: a column past the fold is not clickable.
  await page.$eval(`.hcol:nth-child(${col})`, (e) => e.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  await page.click(`.hcol:nth-child(${col}) .cell[data-day="${day}"]`);
  await page.waitForSelector('#day-dialog[open]');
};
const closeSheet = async (id = '#day-dialog') => {
  await page.evaluate((sel) => document.querySelector(sel).close(), id);
  await page.waitForFunction((sel) => !document.querySelector(sel).open, {}, id);
};

const addHabit = async ({ name, kind = 'time', budget, daily, unit }) => {
  await page.click('#fab');
  await page.waitForSelector('#habit-dialog[open]');
  await page.type('input[name=name]', name);
  if (kind !== 'time') await page.click(`input[name=kind][value=${kind}]`);
  await page.type('input[name=budget]', String(budget));
  if (daily !== undefined) await page.type('input[name=daily]', String(daily));
  if (unit) await page.type('input[name=unit]', unit);
  await page.click('#habit-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#habit-dialog').open);
};

/* ---------- the grid itself ---------- */

await page.click('[data-action="add-habit"]');
await page.waitForSelector('#habit-dialog[open]');
await page.type('input[name=name]', 'Reading');
await page.type('input[name=budget]', '180');
await page.click('#habit-form button[type=submit]');
await page.waitForSelector('.hcol');

await addHabit({ name: 'Coffee', kind: 'count', budget: 14, daily: 2, unit: 'cups' });
await page.waitForFunction(() => document.querySelectorAll('.hcol').length === 2);
check('habits become columns', (await colNames()).join(',') === 'Reading,Coffee', JSON.stringify(await colNames()));

check('every habit column has seven days', (await colState(1)).cells.length === 7);
check('the frozen column names the week\'s days', await page.evaluate(async () => {
  const store = await import('./js/store.js');
  const days = store.weekDays(store.weekRange(0));
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const labels = [...document.querySelectorAll('.dlabel')];
  return labels.length === 7 && labels.every((el, i) =>
    el.querySelector('.dow').textContent === names[days[i].start.getDay()]
    && el.querySelector('.dom').textContent === String(days[i].start.getDate()));
}));

const today = await todayIndex();
check('today\'s row is marked', await page.evaluate((i) =>
  document.querySelectorAll('.dlabel')[i].classList.contains('today'), today));

// The point of the layout: the days stay put while the habits scroll past.
check('the day column is frozen and the habits scroll', await page.evaluate(() => {
  const grid = document.querySelector('#grid');
  const col = document.querySelector('.daycol');
  return getComputedStyle(col).position === 'sticky'
    && getComputedStyle(grid).overflowX === 'auto';
}));
check('days that have not happened are inert', await page.evaluate((i) => {
  const cells = [...document.querySelectorAll('.hcol:nth-child(1) [data-cell]')];
  return cells.every((c, n) => c.hasAttribute('disabled') === (n > i));
}, today));

check('a fresh habit shows its whole budget', (await colState(1)).left === '3h left', (await colState(1)).left);
check('a count habit reads in its own unit', (await colState(2)).left === '14 cups left', (await colState(2)).left);

/* ---------- logging into a day ---------- */

// Monday, whatever day it is today: backdating is a tap now, not a date picker.
await openCell(2, 0);
check('the sheet names the habit and the day', await page.evaluate(async () => {
  const store = await import('./js/store.js');
  const day = store.weekDays(store.weekRange(0))[0].start;
  const when = day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  return document.querySelector('#day-title').textContent === 'Coffee'
    && document.querySelector('#day-sub').textContent === `${when} · 0 cups logged · limit 2 cups`;
}), await page.$eval('#day-sub', (e) => e.textContent));

await page.click('[data-act="day-inc"]');
await page.click('[data-act="day-inc"]');
await page.waitForFunction(() => document.querySelector('#day-tally').textContent === '2');
check('the stepper writes on the tap', (await colState(2)).cells[0].text === '2', JSON.stringify((await colState(2)).cells[0]));
check('the grid keeps up behind the sheet', (await colState(2)).left === '12 cups left', (await colState(2)).left);

await page.click('[data-act="day-dec"]');
await page.waitForFunction(() => document.querySelector('#day-tally').textContent === '1');
check('minus takes one back off', (await colState(2)).cells[0].text === '1', JSON.stringify((await colState(2)).cells[0]));

// Typing an amount adds that many at once, for the days you log in arrears.
await page.type('#day-form input[name=amount]', '4');
await page.click('#day-form button[type=submit]');
await page.waitForFunction(() => !document.querySelector('#day-dialog').open);
check('an amount can be typed instead', (await colState(2)).cells[0].text === '5', JSON.stringify((await colState(2)).cells[0]));
check('the week total follows the days', (await colState(2)).left === '9 cups left', (await colState(2)).left);
// The browser rounds the width it stores, so this compares numerically.
check('the bar tracks usage',
  Math.abs(parseFloat((await colState(2)).bar) - (5 / 14) * 100) < 0.01, (await colState(2)).bar);

/* ---------- daily limits ---------- */

const mondayCell = async () => (await colState(2)).cells[0];
check('a day past its limit goes amber', (await mondayCell()).over, JSON.stringify(await mondayCell()));
check('a day past its limit leaves the week alone', !(await colState(2)).over);

await openCell(2, 1);
await page.click('[data-act="day-inc"]');
await page.click('[data-act="day-inc"]');
await page.click('[data-act="day-inc"]');
await page.waitForFunction(() => document.querySelector('#day-tally').textContent === '3');
const limitToast = await page.$eval('#toast', (t) => t.textContent);
check('crossing the limit says so once', /Past that day's 2 cups limit/.test(limitToast), limitToast);
check('the sheet flags the day it is over', await page.$eval('#day-sub', (e) => e.classList.contains('over')));
await closeSheet();

check('a day inside its limit stays plain', !(await colState(2)).cells[2].over);

/* ---------- money ---------- */

await addHabit({ name: 'Takeaway', kind: 'money', budget: 40 });
await page.waitForFunction(() => document.querySelectorAll('.hcol').length === 3);
check('money shows the currency in the row', (await colState(3)).left === '$40.00 left', (await colState(3)).left);

await openCell(3, 1);
check('money has no stepper', await page.$eval('#day-step', (e) => e.hidden));
await page.type('#day-form input[name=amount]', '12.5');
await page.click('#day-form button[type=submit]');
await page.waitForFunction(() => !document.querySelector('#day-dialog').open);
// The wider column has room for the real formatting, symbol and all.
check('a money cell is written in full', (await colState(3)).cells[1].text === '$12.50', JSON.stringify((await colState(3)).cells[1]));
check('the row still spells the currency out', (await colState(3)).left === '$27.50 left', (await colState(3)).left);

await openCell(3, 2);
const chips = await page.$$eval('#day-quick .chip', (c) => c.map((x) => x.textContent));
check('a used amount is offered again as a chip', chips.join(',') === '$12.50', JSON.stringify(chips));
await page.click('#day-quick .chip');
await page.waitForFunction(() => !document.querySelector('#day-dialog').open);
check('tapping a chip logs it', (await colState(3)).cells[2].text === '$12.50', JSON.stringify((await colState(3)).cells[2]));

await openCell(3, 3);
await page.type('#day-form input[name=amount]', '20');
await page.click('#day-form button[type=submit]');
await page.waitForFunction(() => !document.querySelector('#day-dialog').open);
const over = await colState(3);
check('over budget turns the row red and reports the overage',
  over.over && over.left === '$5.00 over', JSON.stringify(over));

/* ---------- the stopwatch ---------- */

await openCell(1, today);
check('the stopwatch is offered on the day still happening', !(await page.$eval('#day-timer', (e) => e.hidden)));
await page.click('#day-timer');
await page.waitForFunction(() => document.querySelector('.hcol:nth-child(1)').classList.contains('running'));
await closeSheet();
// Long enough to clear the few-second floor under which a session is treated
// as a misfire and dropped.
await new Promise((r) => setTimeout(r, 4200));
// Under a minute the cell counts in seconds, which is the honest reading of
// a stopwatch that has only just been started.
check('the running timer ticks in today\'s cell', (await colState(1)).cells[today].ticking
  && /^\d+[sm]$/.test((await colState(1)).cells[today].text), JSON.stringify((await colState(1)).cells[today]));

await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.hcol');
check('a running timer survives a reload', (await colState(1)).running);

await openCell(1, today);
check('the sheet offers to stop it', /Stop timer/.test(await page.$eval('#day-timer', (e) => e.textContent)));
await page.click('#day-timer');
await page.waitForFunction(() => !document.querySelector('.hcol:nth-child(1)').classList.contains('running'));
await closeSheet();
check('stopping logs the elapsed minutes into that day', await page.evaluate(async () => {
  const store = await import('./js/store.js');
  const id = store.listHabits().find((h) => h.name === 'Reading').id;
  return !store.runningTimers().has(id) && store.usedInWeek(id, store.weekRange(0)) > 0;
}), JSON.stringify((await colState(1)).cells[today]));

// Earlier days cannot be timed — there is nothing still running about them.
await openCell(1, 0);
check('an earlier day has no stopwatch', await page.$eval('#day-timer', (e) => e.hidden));
await closeSheet();

/* ---------- a past day on an earlier week ---------- */

await page.click('#week-prev');
await page.waitForFunction(() => document.querySelector('#week-title').textContent === 'Last week');
check('an earlier week starts empty',
  (await colState(2)).cells.every((c) => c.text === ''), JSON.stringify((await colState(2)).cells));
check('no column is today on an earlier week',
  (await colState(2)).cells.every((c) => !c.future));

await openCell(2, 2);
await page.type('#day-form input[name=amount]', '3');
await page.click('#day-form button[type=submit]');
await page.waitForFunction(() => !document.querySelector('#day-dialog').open);
check('an earlier week logs into its own days', (await colState(2)).cells[2].text === '3', JSON.stringify((await colState(2)).cells[2]));
check('it lands in that week\'s total', (await colState(2)).left === '11 cups left', (await colState(2)).left);

await page.click('#week-next');
await page.waitForFunction(() => document.querySelector('#week-title').textContent === 'This week');
check('this week is untouched by it', (await colState(2)).left === '6 cups left', (await colState(2)).left);
check('cannot navigate past this week', await page.$eval('#week-next', (b) => b.disabled));

await page.screenshot({ path: `${SP}/shot-week.png` });

/* ---------- the detail sheet, opened from the name ---------- */

await page.click('.hcol:nth-child(2) .hcol-head');
await page.waitForSelector('#detail-dialog[open]');
check('the name opens the habit', await page.$eval('#detail-title', (e) => e.textContent) === 'Coffee');
const entryCount = await page.$$eval('#detail-entries li:not(.none)', (l) => l.length);
check('it lists this week\'s entries', entryCount === 5, String(entryCount));

await page.click('#detail-entries .del');
await page.waitForFunction(() => document.querySelectorAll('#detail-entries li:not(.none)').length === 4);
await closeSheet('#detail-dialog');
check('an entry can be deleted from it', (await colState(2)).left === '7 cups left', (await colState(2)).left);

/* ---------- editing, hiding ---------- */

await page.click('.hcol:nth-child(2) .hcol-head');
await page.waitForSelector('#detail-dialog[open]');
await page.click('[data-action="edit-habit"]');
await page.waitForSelector('#habit-dialog[open]');
check('editing hides the kind picker', await page.$eval('#kind-field', (e) => e.hidden));
check('the editor reopens with the stored limit',
  (await page.$eval('input[name=daily]', (e) => e.value)) === '2');
await page.$eval('input[name=budget]', (e) => { e.value = ''; });
await page.type('input[name=budget]', '20');
await page.click('#habit-form button[type=submit]');
await page.waitForFunction(() => !document.querySelector('#habit-dialog').open);
check('editing keeps the history', (await colState(2)).left === '13 cups left', (await colState(2)).left);

await page.click('.hcol:nth-child(2) .hcol-head');
await page.waitForSelector('#detail-dialog[open]');
await page.click('[data-action="hide-habit"]');
await page.waitForFunction(() => document.querySelectorAll('.hcol').length === 2);
check('hiding takes the column out of the week', (await colNames()).join(',') === 'Reading,Takeaway', JSON.stringify(await colNames()));

await page.click('#open-settings');
await page.waitForSelector('#settings-dialog[open]');
await page.click('#hidden-list [data-unhide]');
await page.waitForFunction(() => document.querySelectorAll('.hcol').length === 3);
await closeSheet('#settings-dialog');
// sort_order survives hiding, so it comes back where it was, not on the end.
check('unhiding restores it in place, with its history',
  (await colState(2)).name === 'Coffee' && (await colState(2)).left === '13 cups left',
  JSON.stringify(await colState(2)));

/* ---------- reordering by the name ---------- */

// Grip the name: the cells are targets in their own right, so a hold on one
// must not start a drag. Columns move sideways, so this drags on X.
const grip = (i) => page.$eval(`.hcol:nth-child(${i}) .hcol-head`, (e) => {
  e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, mid: r.x + r.width / 2 };
});

const dragCol = async (fromIndex, toIndex) => {
  const from = await grip(fromIndex);
  const to = await grip(toIndex);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, HOLD + 120)); // hold still to lift it
  // Land past the target's midpoint, not exactly on it: the midpoint is the
  // swap boundary and sitting on it is ambiguous by definition.
  const dx = to.mid - from.mid + (toIndex < fromIndex ? -12 : 12);
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (dx * i) / 8, from.y);
  await new Promise((r) => setTimeout(r, 120));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 150));
};

check('starts in creation order', (await colNames()).join(',') === 'Reading,Coffee,Takeaway', JSON.stringify(await colNames()));

// a press that moves straight away is a scroll, not a drag
{
  const from = await grip(1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(from.x + i * 20, from.y);
  await page.mouse.up();
}
check('a quick swipe does not reorder', (await colNames()).join(',') === 'Reading,Coffee,Takeaway', JSON.stringify(await colNames()));

await dragCol(1, 2);
check('dragging right reorders', (await colNames()).join(',') === 'Coffee,Reading,Takeaway', JSON.stringify(await colNames()));
check('a finished drag does not also open the habit',
  !(await page.$eval('#detail-dialog', (e) => e.open)));

await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.hcol');
check('the new order survives a reload', (await colNames()).join(',') === 'Coffee,Reading,Takeaway', JSON.stringify(await colNames()));

await dragCol(3, 1);
check('dragging left reorders', (await colNames()).join(',') === 'Takeaway,Coffee,Reading', JSON.stringify(await colNames()));

// A hold on a cell is a tap on that cell, not a drag of its column.
{
  const cell = await page.$eval('.hcol:nth-child(1) .cell[data-day="0"]', (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(cell.x, cell.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, HOLD + 150));
  await page.mouse.move(cell.x + 80, cell.y);
  await page.mouse.up();
}
check('holding a cell never drags its column', (await colNames()).join(',') === 'Takeaway,Coffee,Reading', JSON.stringify(await colNames()));
await page.evaluate(() => document.querySelector('#day-dialog')?.close());

/* ---------- compact ---------- */

const colWidth = () => page.$eval('.hcol:nth-child(1)', (e) => Math.round(e.getBoundingClientRect().width));
const comfortable = await colWidth();
await page.click('#open-settings');
await page.waitForSelector('#settings-dialog[open]');
await page.click('#density input[value=compact]');
await page.waitForFunction(() => document.querySelector('#grid').classList.contains('compact'));
await closeSheet('#settings-dialog');
const compact = await colWidth();
check('compact narrows the column', compact < comfortable, `${comfortable}px -> ${compact}px`);
check('compact keeps every day tappable', (await colState(1)).cells.length === 7);
check('the frozen column shrinks with it',
  (await page.$eval('.dlabel', (e) => Math.round(e.getBoundingClientRect().height))) < 50);
await page.screenshot({ path: `${SP}/shot-compact.png` });

await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.hcol');
check('compact survives a reload', (await colWidth()) === compact);
await page.click('#open-settings');
await page.waitForSelector('#settings-dialog[open]');
await page.click('#density input[value=comfortable]');
await closeSheet('#settings-dialog');
check('comfortable restores the column', (await colWidth()) === comfortable);

/* ---------- deleting, and persistence ---------- */

page.on('dialog', (d) => d.accept());
await page.click('.hcol:nth-child(2) .hcol-head');
await page.waitForSelector('#detail-dialog[open]');
await page.click('[data-action="delete-habit"]');
await page.waitForFunction(() => document.querySelectorAll('.hcol').length === 2);
check('deletes a habit', (await colNames()).join(',') === 'Takeaway,Reading', JSON.stringify(await colNames()));

await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
await page.close();
const page2 = await browser.newPage();
await page2.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
page2.on('pageerror', (e) => errors.push('pageerror(2): ' + e.message));
page2.on('console', (m) => m.type() === 'error' && errors.push('console(2): ' + m.text()));
page2.on('dialog', (d) => d.accept());
await page2.goto('http://localhost:4173/', { waitUntil: 'networkidle0' });
await page2.waitForSelector('.hcol');
const survived = await page2.$$eval('.hcol-name', (n) => n.map((x) => x.textContent));
check('data survives a fresh session', survived.join(',') === 'Takeaway,Reading', JSON.stringify(survived));

/* ---------- service worker / offline ---------- */

const swReady = await page2.evaluate(() => navigator.serviceWorker.ready.then((r) => Boolean(r.active)));
check('service worker active', swReady);
await page2.setOfflineMode(true);
await page2.reload({ waitUntil: 'domcontentloaded' });
await page2.waitForSelector('.hcol', { timeout: 10000 });
check('loads fully offline', (await page2.$$('.hcol')).length === 2);
await page2.setOfflineMode(false);
await page2.screenshot({ path: `${SP}/shot-home.png` });

/* ---------- export / import backup round-trip ---------- */

const { DatabaseSync } = await import('node:sqlite');
const fs = fsp;
const downloads = `${SP}/downloads`;
await fs.rm(downloads, { recursive: true, force: true });
await fs.mkdir(downloads, { recursive: true });
await page2.createCDPSession().then((cdp) =>
  cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
);

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
if (exported) {
  const file = new DatabaseSync(exported, { readOnly: true });
  const habits = file.prepare('SELECT name, kind, weekly_budget FROM habits ORDER BY sort_order').all();
  const entries = file.prepare('SELECT COUNT(*) AS n FROM entries').get();
  check('exported file opens in a real SQLite client',
    habits.length === 2 && habits[0].name === 'Takeaway' && entries.n > 0,
    JSON.stringify({ habits, entries }));
  file.close();
}

// Wipe the app, then restore from the exported file.
await page2.evaluate(() => document.querySelector('#settings-dialog').close());
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
await page2.waitForSelector('.hcol', { timeout: 10000 });
const restored = await page2.$$eval('.hcol', (rows) => rows.map((r) => ({
  name: r.querySelector('.hcol-name').textContent,
  left: r.querySelector('[data-left]').textContent,
  days: [...r.querySelectorAll('[data-cell]')].map((c) => c.textContent).join('|'),
})));
check('import restores habits, history and the days they fell on',
  restored.length === 2
  && restored[0].name === 'Takeaway' && restored[0].days.split('|').filter(Boolean).length === 3
  && restored.every((r) => /\d/.test(r.days)),
  JSON.stringify(restored));

// A file that isn't one of ours must be rejected without destroying anything.
const junk = `${downloads}/junk.db`;
await fs.writeFile(junk, Buffer.from('this is definitely not a database'));
await page2.click('#open-settings');
await page2.waitForSelector('#settings-dialog[open]');
await (await page2.$('#import-file')).uploadFile(junk);
await new Promise((r) => setTimeout(r, 600));
const toastText = await page2.$eval('#toast', (t) => t.textContent);
check('rejects a junk file and keeps existing data',
  /not a Habit Budget database/.test(toastText) && (await page2.$$('.hcol')).length === 2,
  `toast="${toastText}"`);
await page2.evaluate(() => document.querySelector('#settings-dialog').close());

/* ---------- a database written before money existed ---------- */

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
  () => [...document.querySelectorAll('.hcol-name')].some((n) => n.textContent === 'Walking'),
  { timeout: 10000 }
);
const upgraded = await page2.$eval('.hcol:nth-child(1) [data-left]', (e) => e.textContent);
check('a v1 database opens with its history intact', upgraded === '1h 40m left', upgraded);

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
await page2.waitForFunction(() => document.querySelectorAll('.hcol').length === 2);
const added = await page2.$eval('.hcol:nth-child(2) [data-left]', (e) => e.textContent);
check('money habits can be added to an upgraded database', added === '€60.00 left', added);

report();
await browser.close();
process.exit(bad.length || errors.length ? 1 : 0);

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

const rowState = (n) => page.$eval(`.hrow:nth-child(${n})`, (el) => ({
  name: el.querySelector('.hrow-name').textContent,
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

const rowNames = () => page.$$eval('.hrow-name', (n) => n.map((x) => x.textContent));

// Which column is today, so the timer and "future" tests know where to look.
const todayIndex = () => page.evaluate(async () => {
  const store = await import('./js/store.js');
  return store.dayIndexOf(Date.now(), store.weekDays(store.weekRange(0)));
});

// Scrolls one day into the region the frozen pane leaves over. A plain
// scrollIntoView centres the cell in the whole grid, which on a phone puts it
// *under* the pane — the click then lands on the name and opens the wrong
// sheet. This is the same sum scrollToDay() does in the app.
const showCell = (tab, row, day) => tab.evaluate((r, d) => {
  const grid = document.querySelector('#grid');
  const rowEl = document.querySelectorAll('.hrow')[r - 1];
  const cell = rowEl.querySelectorAll('[data-cell]')[d];
  const head = rowEl.querySelector('.hrow-head').getBoundingClientRect();
  const box = cell.getBoundingClientRect();
  const view = grid.clientWidth - head.width;
  grid.scrollLeft += (box.left - grid.getBoundingClientRect().left) - head.width
    - (view - box.width) / 2;
}, row, day);

const openCell = async (row, day) => {
  await showCell(page, row, day);
  await page.click(`.hrow:nth-child(${row}) .cell[data-day="${day}"]`);
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
await page.waitForSelector('.hrow');

await addHabit({ name: 'Coffee', kind: 'count', budget: 14, daily: 2, unit: 'cups' });
await page.waitForFunction(() => document.querySelectorAll('.hrow').length === 2);
check('habits become rows', (await rowNames()).join(',') === 'Reading,Coffee', JSON.stringify(await rowNames()));

check('every habit row has seven days', (await rowState(1)).cells.length === 7);
check('the day header names the week\'s days', await page.evaluate(async () => {
  const store = await import('./js/store.js');
  const days = store.weekDays(store.weekRange(0));
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const labels = [...document.querySelectorAll('.dlabel')];
  return labels.length === 7 && labels.every((el, i) =>
    el.querySelector('.dow').textContent === names[days[i].start.getDay()]
    && el.querySelector('.dom').textContent === String(days[i].start.getDate()));
}));

const today = await todayIndex();
check('today\'s column is marked', await page.evaluate((i) =>
  document.querySelectorAll('.dlabel')[i].classList.contains('today'), today));

// The point of the layout: the name and the balance stay put while the days
// scroll past. The head is sticky inside its own row rather than living in a
// separate pane, which is what keeps a habit one draggable element.
check('the name and balance are frozen and the days scroll', await page.evaluate(() => {
  const grid = document.querySelector('#grid');
  const head = document.querySelector('.hrow-head');
  const corner = document.querySelector('.dayhead-corner');
  return getComputedStyle(head).position === 'sticky'
    && getComputedStyle(corner).position === 'sticky'
    && head.closest('.hrow') !== null
    && getComputedStyle(grid).overflowX === 'auto';
}));
// Declaring `position: sticky` is not the same as sticking: an ancestor
// narrower than the row leaves the head resolving against the wrong box, and
// the pane slides away with the days. Scroll it and measure.
check('every frozen pane holds its place while the days scroll', await page.evaluate(async () => {
  const grid = document.querySelector('#grid');
  const was = grid.scrollLeft;
  grid.scrollLeft = grid.scrollWidth;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const edge = grid.getBoundingClientRect().left;
  const heads = [...document.querySelectorAll('.hrow-head'), document.querySelector('.dayhead-corner')];
  const stuck = grid.scrollLeft > 0 && heads.every((h) =>
    Math.abs(h.getBoundingClientRect().left - edge) < 1);
  grid.scrollLeft = was;
  return stuck;
}));
// Rows must all end together, or the shortest one runs out of containing block
// and its head comes unstuck before the others do.
check('every row is the same width as the scroller', await page.evaluate(() => {
  const grid = document.querySelector('#grid');
  const rows = [...document.querySelectorAll('.hrow'), document.querySelector('.dayhead')];
  return rows.every((r) => Math.abs(r.getBoundingClientRect().width - grid.scrollWidth) < 1);
}));

// The frozen pane is wide enough that portrait only shows a couple of days.
// That is the trade: rotating the phone is what buys the whole week, and the
// cells grow to fill it rather than leaving a gap at the right.
const daysInView = () => page.evaluate(() => {
  const grid = document.querySelector('#grid');
  const right = grid.getBoundingClientRect().right;
  const head = document.querySelector('.hrow-head').getBoundingClientRect();
  return [...document.querySelectorAll('.hrow:nth-child(1) [data-cell]')].filter((c) => {
    const b = c.getBoundingClientRect();
    return b.left >= head.right - 1 && b.right <= right + 1;
  }).length;
});
check('portrait shows at least one whole day beside the pane', (await daysInView()) >= 1,
  String(await daysInView()));

await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await new Promise((r) => setTimeout(r, 250));
check('landscape shows the whole week', (await daysInView()) === 7, String(await daysInView()));
check('landscape needs no sideways scrolling at all', await page.evaluate(() => {
  const grid = document.querySelector('#grid');
  return grid.scrollWidth <= grid.clientWidth + 1;
}));
check('landscape cells grow to fill the width rather than leaving a gap',
  await page.evaluate(() => {
    const cell = document.querySelector('[data-cell]').getBoundingClientRect().width;
    const declared = parseFloat(getComputedStyle(document.querySelector('#grid')).getPropertyValue('--cellw'));
    return cell > declared + 1;
  }));
check('nothing in the frozen pane clips in either orientation', await page.evaluate(() =>
  [...document.querySelectorAll('.hrow-name, .hrow-left')].every((e) => e.scrollWidth <= e.clientWidth)));
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await new Promise((r) => setTimeout(r, 250));
// Three and a half days is the whole budget, so today has to be one of them.
check('the day strip opens on today', await page.evaluate((i) => {
  const grid = document.querySelector('#grid');
  const cell = document.querySelectorAll('.hrow:nth-child(1) [data-cell]')[i];
  const head = document.querySelector('.hrow-head').getBoundingClientRect();
  const box = cell.getBoundingClientRect();
  const view = grid.getBoundingClientRect();
  // Visible means clear of the frozen pane, which overlays the left of it.
  return box.left >= head.right - 1 && box.right <= view.right + 1;
}, today), 'today is off-screen in the day strip');
check('days that have not happened are inert', await page.evaluate((i) => {
  const cells = [...document.querySelectorAll('.hrow:nth-child(1) [data-cell]')];
  return cells.every((c, n) => c.hasAttribute('disabled') === (n > i));
}, today));

check('a fresh habit shows its whole budget', (await rowState(1)).left === '3h left', (await rowState(1)).left);
check('a count habit reads in its own unit', (await rowState(2)).left === '14 cups left', (await rowState(2)).left);

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
check('the stepper writes on the tap', (await rowState(2)).cells[0].text === '2', JSON.stringify((await rowState(2)).cells[0]));
check('the grid keeps up behind the sheet', (await rowState(2)).left === '12 cups left', (await rowState(2)).left);

await page.click('[data-act="day-dec"]');
await page.waitForFunction(() => document.querySelector('#day-tally').textContent === '1');
check('minus takes one back off', (await rowState(2)).cells[0].text === '1', JSON.stringify((await rowState(2)).cells[0]));

// Typing an amount adds that many at once, for the days you log in arrears.
await page.type('#day-form input[name=amount]', '4');
await page.click('#day-form button[type=submit]');
await page.waitForFunction(() => !document.querySelector('#day-dialog').open);
check('an amount can be typed instead', (await rowState(2)).cells[0].text === '5', JSON.stringify((await rowState(2)).cells[0]));
check('the week total follows the days', (await rowState(2)).left === '9 cups left', (await rowState(2)).left);
// The browser rounds the width it stores, so this compares numerically.
check('the bar tracks usage',
  Math.abs(parseFloat((await rowState(2)).bar) - (5 / 14) * 100) < 0.01, (await rowState(2)).bar);

/* ---------- daily limits ---------- */

const mondayCell = async () => (await rowState(2)).cells[0];
check('a day past its limit goes amber', (await mondayCell()).over, JSON.stringify(await mondayCell()));
check('a day past its limit leaves the week alone', !(await rowState(2)).over);

await openCell(2, 1);
await page.click('[data-act="day-inc"]');
await page.click('[data-act="day-inc"]');
await page.click('[data-act="day-inc"]');
await page.waitForFunction(() => document.querySelector('#day-tally').textContent === '3');
const limitToast = await page.$eval('#toast', (t) => t.textContent);
check('crossing the limit says so once', /Past that day's 2 cups limit/.test(limitToast), limitToast);
check('the sheet flags the day it is over', await page.$eval('#day-sub', (e) => e.classList.contains('over')));
await closeSheet();

check('a day inside its limit stays plain', !(await rowState(2)).cells[2].over);

/* ---------- money ---------- */

await addHabit({ name: 'Takeaway', kind: 'money', budget: 40 });
await page.waitForFunction(() => document.querySelectorAll('.hrow').length === 3);
check('money shows the currency in the row', (await rowState(3)).left === '$40.00 left', (await rowState(3)).left);

await openCell(3, 1);
check('money has no stepper', await page.$eval('#day-step', (e) => e.hidden));
await page.type('#day-form input[name=amount]', '12.5');
await page.click('#day-form button[type=submit]');
await page.waitForFunction(() => !document.querySelector('#day-dialog').open);
// The wider column has room for the real formatting, symbol and all.
check('a money cell is written in full', (await rowState(3)).cells[1].text === '$12.50', JSON.stringify((await rowState(3)).cells[1]));
check('the row still spells the currency out', (await rowState(3)).left === '$27.50 left', (await rowState(3)).left);

await openCell(3, 2);
const chips = await page.$$eval('#day-quick .chip', (c) => c.map((x) => x.textContent));
check('a used amount is offered again as a chip', chips.join(',') === '$12.50', JSON.stringify(chips));
await page.click('#day-quick .chip');
await page.waitForFunction(() => !document.querySelector('#day-dialog').open);
check('tapping a chip logs it', (await rowState(3)).cells[2].text === '$12.50', JSON.stringify((await rowState(3)).cells[2]));

await openCell(3, 3);
await page.type('#day-form input[name=amount]', '20');
await page.click('#day-form button[type=submit]');
await page.waitForFunction(() => !document.querySelector('#day-dialog').open);
const over = await rowState(3);
check('over budget turns the row red and reports the overage',
  over.over && over.left === '$5.00 over', JSON.stringify(over));

/* ---------- the stopwatch ---------- */

await openCell(1, today);
check('the stopwatch is offered on the day still happening', !(await page.$eval('#day-timer', (e) => e.hidden)));
await page.click('#day-timer');
await page.waitForFunction(() => document.querySelector('.hrow:nth-child(1)').classList.contains('running'));
await closeSheet();
// Long enough to clear the few-second floor under which a session is treated
// as a misfire and dropped.
await new Promise((r) => setTimeout(r, 4200));
// Under a minute the cell counts in seconds, which is the honest reading of
// a stopwatch that has only just been started.
check('the running timer ticks in today\'s cell', (await rowState(1)).cells[today].ticking
  && /^\d+[sm]$/.test((await rowState(1)).cells[today].text), JSON.stringify((await rowState(1)).cells[today]));

await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.hrow');
check('a running timer survives a reload', (await rowState(1)).running);

await openCell(1, today);
check('the sheet offers to stop it', /Stop timer/.test(await page.$eval('#day-timer', (e) => e.textContent)));
await page.click('#day-timer');
await page.waitForFunction(() => !document.querySelector('.hrow:nth-child(1)').classList.contains('running'));
await closeSheet();
check('stopping logs the elapsed minutes into that day', await page.evaluate(async () => {
  const store = await import('./js/store.js');
  const id = store.listHabits().find((h) => h.name === 'Reading').id;
  return !store.runningTimers().has(id) && store.usedInWeek(id, store.weekRange(0)) > 0;
}), JSON.stringify((await rowState(1)).cells[today]));

// Adding was never the hard part. Taking a mistake back off was: before the
// day sheet listed the day's own entries, a time or money habit had no minus
// at all, and the only way back was the week-wide list in the habit sheet.
await openCell(1, today);
const dayEntries = () => page.$$eval('#day-entries li', (ls) => ls.map((l) => l.querySelector('.amt').textContent));
const logged = (await dayEntries()).length;
check('the day sheet lists what is already on that day', logged === 1, JSON.stringify(await dayEntries()));

await page.type('#day-form input[name=amount]', '30');
await page.click('#day-form button[type=submit]');
await page.waitForFunction(() => !document.querySelector('#day-dialog').open);
const withExtra = await rowState(1);
await openCell(1, today);
check('a second session appears alongside the first',
  (await dayEntries()).length === 2 && (await dayEntries()).includes('30m'),
  JSON.stringify(await dayEntries()));

await page.evaluate(() => {
  const li = [...document.querySelectorAll('#day-entries li')].find((l) => l.querySelector('.amt').textContent === '30m');
  li.querySelector('.del').click();
});
await page.waitForFunction(() => document.querySelectorAll('#day-entries li').length === 1);
check('removing one takes it off the day, not the week',
  (await dayEntries()).length === 1 && !(await dayEntries()).includes('30m'),
  JSON.stringify(await dayEntries()));
await closeSheet();
check('and the row goes back to what it was',
  (await rowState(1)).left !== withExtra.left,
  `${withExtra.left} -> ${(await rowState(1)).left}`);

// Money has no stepper either, so it needed the same way back.
await openCell(3, 1);
check('a money day lists its entries too', (await dayEntries()).length === 1, JSON.stringify(await dayEntries()));
await closeSheet();

// Earlier days cannot be timed — there is nothing still running about them.
await openCell(1, 0);
check('an earlier day has no stopwatch', await page.$eval('#day-timer', (e) => e.hidden));
await closeSheet();

/* ---------- a past day on an earlier week ---------- */

await page.click('#week-prev');
await page.waitForFunction(() => document.querySelector('#week-title').textContent === 'Last week');
check('an earlier week starts empty',
  (await rowState(2)).cells.every((c) => c.text === ''), JSON.stringify((await rowState(2)).cells));
check('no day is today on an earlier week',
  (await rowState(2)).cells.every((c) => !c.future));

await openCell(2, 2);
await page.type('#day-form input[name=amount]', '3');
await page.click('#day-form button[type=submit]');
await page.waitForFunction(() => !document.querySelector('#day-dialog').open);
check('an earlier week logs into its own days', (await rowState(2)).cells[2].text === '3', JSON.stringify((await rowState(2)).cells[2]));
check('it lands in that week\'s total', (await rowState(2)).left === '11 cups left', (await rowState(2)).left);

await page.click('#week-next');
await page.waitForFunction(() => document.querySelector('#week-title').textContent === 'This week');
check('this week is untouched by it', (await rowState(2)).left === '6 cups left', (await rowState(2)).left);
check('cannot navigate past this week', await page.$eval('#week-next', (b) => b.disabled));

// Further back than "last week" used to fall through to the range, printing
// the same dates the line underneath already carries.
await page.click('#week-prev');
await page.click('#week-prev');
await page.click('#week-prev');
await page.waitForFunction(() => document.querySelector('#week-title').textContent === '3 weeks ago');
check('an older week is named, not printed twice', await page.evaluate(() => {
  const title = document.querySelector('#week-title').textContent;
  const range = document.querySelector('#week-range').textContent;
  return title === '3 weeks ago' && /\d/.test(range) && title !== range;
}), await page.$eval('#week-range', (e) => e.textContent));

// Every date is a way back, and the corner says so.
check('the corner offers the way back', await page.$eval('#dayhead', (e) => Boolean(e.querySelector('[data-today]'))));
await page.click('.dlabel');
await page.waitForFunction(() => document.querySelector('#week-title').textContent === 'This week');
check('tapping a date returns to this week', true);
check('and the corner stops offering it', await page.$eval('#dayhead', (e) => !e.querySelector('[data-today]')));
check('a date on this week does nothing', await (async () => {
  await page.click('.dlabel');
  await new Promise((r) => setTimeout(r, 120));
  return (await page.$eval('#week-title', (e) => e.textContent)) === 'This week';
})());

await page.screenshot({ path: `${SP}/shot-week.png` });

/* ---------- the detail sheet, opened from the name ---------- */

await page.click('.hrow:nth-child(2) .hrow-head');
await page.waitForSelector('#detail-dialog[open]');
check('the name opens the habit', await page.$eval('#detail-title', (e) => e.textContent) === 'Coffee');
const entryCount = await page.$$eval('#detail-entries li:not(.none)', (l) => l.length);
check('it lists this week\'s entries', entryCount === 5, String(entryCount));

await page.click('#detail-entries .del');
await page.waitForFunction(() => document.querySelectorAll('#detail-entries li:not(.none)').length === 4);
await closeSheet('#detail-dialog');
check('an entry can be deleted from it', (await rowState(2)).left === '7 cups left', (await rowState(2)).left);

/* ---------- editing, hiding ---------- */

await page.click('.hrow:nth-child(2) .hrow-head');
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
check('editing keeps the history', (await rowState(2)).left === '13 cups left', (await rowState(2)).left);

await page.click('.hrow:nth-child(2) .hrow-head');
await page.waitForSelector('#detail-dialog[open]');
await page.click('[data-action="hide-habit"]');
await page.waitForFunction(() => document.querySelectorAll('.hrow').length === 2);
check('hiding takes the row out of the week', (await rowNames()).join(',') === 'Reading,Takeaway', JSON.stringify(await rowNames()));

await page.click('#open-settings');
await page.waitForSelector('#settings-dialog[open]');
await page.click('#hidden-list [data-unhide]');
await page.waitForFunction(() => document.querySelectorAll('.hrow').length === 3);
await closeSheet('#settings-dialog');
// sort_order survives hiding, so it comes back where it was, not on the end.
check('unhiding restores it in place, with its history',
  (await rowState(2)).name === 'Coffee' && (await rowState(2)).left === '13 cups left',
  JSON.stringify(await rowState(2)));

/* ---------- reordering by the name ---------- */

// Grip the head: the cells are targets in their own right, so a hold on one
// must not start a drag. Rows move up and down, so this drags on Y.
const grip = (i) => page.$eval(`.hrow:nth-child(${i}) .hrow-head`, (e) => {
  e.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, mid: r.y + r.height / 2 };
});

const dragRow = async (fromIndex, toIndex) => {
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
  await new Promise((r) => setTimeout(r, 150));
};

check('starts in creation order', (await rowNames()).join(',') === 'Reading,Coffee,Takeaway', JSON.stringify(await rowNames()));

// a press that moves straight away is a scroll, not a drag
{
  const from = await grip(1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(from.x, from.y + i * 20);
  await page.mouse.up();
}
check('a quick swipe does not reorder', (await rowNames()).join(',') === 'Reading,Coffee,Takeaway', JSON.stringify(await rowNames()));

await dragRow(1, 2);
check('dragging down reorders', (await rowNames()).join(',') === 'Coffee,Reading,Takeaway', JSON.stringify(await rowNames()));
check('a finished drag does not also open the habit',
  !(await page.$eval('#detail-dialog', (e) => e.open)));

await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.hrow');
check('the new order survives a reload', (await rowNames()).join(',') === 'Coffee,Reading,Takeaway', JSON.stringify(await rowNames()));

await dragRow(3, 1);
check('dragging up reorders', (await rowNames()).join(',') === 'Takeaway,Coffee,Reading', JSON.stringify(await rowNames()));

// A hold on a cell is a tap on that cell, not a drag of its column.
{
  await showCell(page, 1, 0);
  const cell = await page.$eval('.hrow:nth-child(1) .cell[data-day="0"]', (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(cell.x, cell.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, HOLD + 150));
  await page.mouse.move(cell.x + 80, cell.y);
  await page.mouse.up();
}
check('holding a cell never drags its row', (await rowNames()).join(',') === 'Takeaway,Coffee,Reading', JSON.stringify(await rowNames()));
await page.evaluate(() => document.querySelector('#day-dialog')?.close());

// The click a drag leaves behind is swallowed by a time window, not a flag: on
// touch that click may never arrive, and a flag left standing would eat the
// next real tap instead of its own.
await dragRow(1, 2);
await new Promise((r) => setTimeout(r, 450));
await openCell(1, 0);
check('a cell still opens on the first tap after a reorder',
  await page.$eval('#day-dialog', (e) => e.open));
await closeSheet();
check('the reorder itself stuck', (await rowNames()).join(',') === 'Coffee,Takeaway,Reading', JSON.stringify(await rowNames()));
// Put it back, so what follows starts from the order it expects.
await dragRow(2, 1);
check('restored for the rest of the suite', (await rowNames()).join(',') === 'Takeaway,Coffee,Reading', JSON.stringify(await rowNames()));

// The handle must not offer itself to the compositor for up-and-down panning,
// or a real finger scrolls the page instead of dragging the row.
check('the row handle reserves vertical gestures for the drag',
  (await page.$eval('.hrow-head', (e) => getComputedStyle(e).touchAction)) === 'pan-x',
  await page.$eval('.hrow-head', (e) => getComputedStyle(e).touchAction));

/* ---------- compact ---------- */

const rowHeight = () => page.$eval('.hrow:nth-child(1)', (e) => Math.round(e.getBoundingClientRect().height));
const paneWidth = () => page.$eval('.hrow-head', (e) => Math.round(e.getBoundingClientRect().width));
const comfortable = await rowHeight();
const comfortablePane = await paneWidth();
await page.click('#open-settings');
await page.waitForSelector('#settings-dialog[open]');
await page.click('#density input[value=compact]');
await page.waitForFunction(() => document.querySelector('#grid').classList.contains('compact'));
await closeSheet('#settings-dialog');
const compact = await rowHeight();
check('compact shortens the row', compact < comfortable, `${comfortable}px -> ${compact}px`);
check('compact keeps every day tappable', (await rowState(1)).cells.length === 7);
check('the frozen pane shrinks with it', (await paneWidth()) < comfortablePane,
  `${comfortablePane}px -> ${await paneWidth()}px`);
check('compact buys back a day', (await daysInView()) > 2, String(await daysInView()));
// A day column narrower than its own label spills sideways under the cells.
check('compact still fits the longest day label', await page.evaluate(() =>
  [...document.querySelectorAll('.dlabel')].every((e) => e.scrollWidth <= e.clientWidth)));
// The reason the days scroll instead of sharing the width: a cell has to hold
// its real formatting rather than an abbreviation of it.
check('a cell still fits its longest value', await page.evaluate(() =>
  [...document.querySelectorAll('[data-cell]')].every((e) => e.scrollWidth <= e.clientWidth)));
await page.screenshot({ path: `${SP}/shot-compact.png` });

await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.hrow');
check('compact survives a reload', (await rowHeight()) === compact);
await page.click('#open-settings');
await page.waitForSelector('#settings-dialog[open]');
await page.click('#density input[value=comfortable]');
await closeSheet('#settings-dialog');
check('comfortable restores the row', (await rowHeight()) === comfortable);

/* ---------- deleting, and persistence ---------- */

page.on('dialog', (d) => d.accept());
await page.click('.hrow:nth-child(2) .hrow-head');
await page.waitForSelector('#detail-dialog[open]');
await page.click('[data-action="delete-habit"]');
await page.waitForFunction(() => document.querySelectorAll('.hrow').length === 2);
check('deletes a habit', (await rowNames()).join(',') === 'Takeaway,Reading', JSON.stringify(await rowNames()));

await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
await page.close();
const page2 = await browser.newPage();
await page2.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
page2.on('pageerror', (e) => errors.push('pageerror(2): ' + e.message));
page2.on('console', (m) => m.type() === 'error' && errors.push('console(2): ' + m.text()));
page2.on('dialog', (d) => d.accept());
await page2.goto('http://localhost:4173/', { waitUntil: 'networkidle0' });
await page2.waitForSelector('.hrow');
const survived = await page2.$$eval('.hrow-name', (n) => n.map((x) => x.textContent));
check('data survives a fresh session', survived.join(',') === 'Takeaway,Reading', JSON.stringify(survived));

/* ---------- service worker / offline ---------- */

const swReady = await page2.evaluate(() => navigator.serviceWorker.ready.then((r) => Boolean(r.active)));
check('service worker active', swReady);
await page2.setOfflineMode(true);
await page2.reload({ waitUntil: 'domcontentloaded' });
await page2.waitForSelector('.hrow', { timeout: 10000 });
check('loads fully offline', (await page2.$$('.hrow')).length === 2);
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
await page2.waitForSelector('.hrow', { timeout: 10000 });
const restored = await page2.$$eval('.hrow', (rows) => rows.map((r) => ({
  name: r.querySelector('.hrow-name').textContent,
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
  /not a Habit Budget database/.test(toastText) && (await page2.$$('.hrow')).length === 2,
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
  () => [...document.querySelectorAll('.hrow-name')].some((n) => n.textContent === 'Walking'),
  { timeout: 10000 }
);
const upgraded = await page2.$eval('.hrow:nth-child(1) [data-left]', (e) => e.textContent);
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
await page2.waitForFunction(() => document.querySelectorAll('.hrow').length === 2);
const added = await page2.$eval('.hrow:nth-child(2) [data-left]', (e) => e.textContent);
check('money habits can be added to an upgraded database', added === '€60.00 left', added);

/* ---------- yes/no habits ---------- */

const boolHabit = async (name, budget, atLeast) => {
  await page2.click('#fab');
  await page2.waitForSelector('#habit-dialog[open]');
  await page2.type('input[name=name]', name);
  await page2.click('input[name=kind][value=bool]');
  await new Promise((r) => setTimeout(r, 80));
  if (atLeast) await page2.click('#goal input[value="1"]');
  await page2.type('input[name=budget]', String(budget));
  await page2.click('#habit-form button[type=submit]');
  await page2.waitForFunction(() => !document.querySelector('#habit-dialog').open);
};

await page2.click('#fab');
await page2.waitForSelector('#habit-dialog[open]');
await page2.click('input[name=kind][value=bool]');
await new Promise((r) => setTimeout(r, 80));
const editor = await page2.evaluate(() => ({
  budget: document.querySelector('#budget-label').textContent,
  daily: document.querySelector('#daily-field').hidden,
  unit: document.querySelector('#unit-field').hidden,
  goal: !document.querySelector('#goal-field').hidden,
}));
check('a yes/no habit is measured in days a week', editor.budget === 'Days a week', editor.budget);
check('it has no daily limit or unit to set', editor.daily && editor.unit, JSON.stringify(editor));
check('it can aim at a target instead of a cap', editor.goal);
await page2.evaluate(() => document.querySelector('#habit-dialog').close());

// The migration chain reaches a database written before any of this existed.
await boolHabit('Meditate', 5, true);
await page2.waitForFunction(() => document.querySelectorAll('.hrow').length === 3);
check('a v1 database upgrades far enough to hold a yes/no habit', true);

const med = 3;
const medHead = () => page2.$eval(`.hrow:nth-child(${med})`, (e) => ({
  left: e.querySelector('[data-left]').textContent,
  met: e.classList.contains('met'),
  over: e.classList.contains('over'),
  ticks: [...e.querySelectorAll('[data-cell]')].map((c) => c.textContent).join(''),
}));
check('a target counts down to itself', (await medHead()).left === '5 days to go', JSON.stringify(await medHead()));

const tick = async (row, day) => {
  await showCell(page2, row, day);
  await page2.click(`.hrow:nth-child(${row}) .cell[data-day="${day}"]`);
  await new Promise((r) => setTimeout(r, 90));
};
for (const d of [0, 1, 2]) await tick(med, d);
check('a tap ticks the day', (await medHead()).ticks === '✓✓✓', JSON.stringify(await medHead()));
check('and the target counts down', (await medHead()).left === '2 days to go', (await medHead()).left);

for (const d of [3, 4]) await tick(med, d);
const reached = await medHead();
check('reaching a target is the good end of the week, not the bad one',
  reached.met && !reached.over && reached.left === '5 of 5 days', JSON.stringify(reached));

await tick(med, 0);
check('tapping again unticks it',
  (await medHead()).ticks === '✓✓✓✓' && !(await medHead()).met, JSON.stringify(await medHead()));

// Ticking is a state, not a tally: a day can never hold two of them.
await tick(med, 0);
await tick(med, 0);
await tick(med, 0);
check('a day never ends up holding two ticks', await page2.evaluate(async () => {
  const store = await import('./js/store.js');
  const h = store.listHabits().find((x) => x.name === 'Meditate');
  const day = store.weekDays(store.weekRange(0))[0];
  return store.usedInDay(h.id, day) === 1;
}));

// The other direction still behaves like every other kind.
await boolHabit('No booze', 1, false);
await page2.waitForFunction(() => document.querySelectorAll('.hrow').length === 4);
const booze = 4;
const boozeHead = () => page2.$eval(`.hrow:nth-child(${booze})`, (e) => ({
  left: e.querySelector('[data-left]').textContent,
  met: e.classList.contains('met'),
  over: e.classList.contains('over'),
}));
check('a cap still reads as a cap', (await boozeHead()).left === '1 day left', JSON.stringify(await boozeHead()));
await tick(booze, 0);
check('using it up is not yet over', (await boozeHead()).left === '0 days left' && !(await boozeHead()).over,
  JSON.stringify(await boozeHead()));
await tick(booze, 1);
const gone = await boozeHead();
check('passing it is', gone.over && !gone.met && gone.left === '1 day over', JSON.stringify(gone));

await page2.screenshot({ path: `${SP}/shot-bool.png` });

report();
await browser.close();
process.exit(bad.length || errors.length ? 1 : 0);

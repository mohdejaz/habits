// store.js — habit domain logic on top of the SQLite layer.
// Budgets and amounts share one unit per kind, so a budget can always be
// compared to a sum directly: minutes for 'time', whole units for 'count',
// and major currency units (12.5 = £12.50) for 'money'.

import * as db from './db.js';

export const DEFAULT_WEEK_START = 1; // Monday
export const KINDS = ['time', 'count', 'money', 'bool'];

/* ---------- currency ---------- */

// One currency for the whole app rather than one per habit: this is a personal
// budget, and mixing currencies would mean exchange rates, which need a network.
// Intl exposes no locale -> currency mapping, so a small table covers the
// common cases and anything else falls back to USD (changeable in Settings).
const REGION_CURRENCY = {
  US: 'USD', GB: 'GBP', IN: 'INR', AU: 'AUD', CA: 'CAD', NZ: 'NZD', SG: 'SGD',
  HK: 'HKD', JP: 'JPY', CN: 'CNY', KR: 'KRW', TW: 'TWD', CH: 'CHF', SE: 'SEK',
  NO: 'NOK', DK: 'DKK', IS: 'ISK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON',
  BG: 'BGN', UA: 'UAH', RU: 'RUB', TR: 'TRY', IL: 'ILS', AE: 'AED', SA: 'SAR',
  QA: 'QAR', KW: 'KWD', BH: 'BHD', OM: 'OMR', PK: 'PKR', BD: 'BDT', LK: 'LKR',
  NP: 'NPR', ID: 'IDR', MY: 'MYR', TH: 'THB', PH: 'PHP', VN: 'VND', ZA: 'ZAR',
  NG: 'NGN', KE: 'KES', GH: 'GHS', EG: 'EGP', MA: 'MAD', BR: 'BRL', MX: 'MXN',
  AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR',
  IE: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR', SK: 'EUR', SI: 'EUR', LT: 'EUR',
  LV: 'EUR', EE: 'EUR', LU: 'EUR', CY: 'EUR', MT: 'EUR', HR: 'EUR',
};

export const DEFAULT_CURRENCY = (() => {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return REGION_CURRENCY[region] || 'USD';
  } catch {
    return 'USD';
  }
})();

export function currency() {
  return getSetting('currency', DEFAULT_CURRENCY);
}

export function setCurrency(code) {
  setSetting('currency', code);
}

/* ---------- settings ---------- */

export function getSetting(key, fallback = null) {
  const row = db.one('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}

export function weekStartDay() {
  return Number(getSetting('week_start', DEFAULT_WEEK_START));
}

/* ---------- weeks ---------- */

// Local midnight of the week containing `date`, `offset` weeks away.
export function weekStart(date = new Date(), offset = 0) {
  const startDay = weekStartDay();
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = (d.getDay() - startDay + 7) % 7;
  d.setDate(d.getDate() - diff + offset * 7);
  return d;
}

export function weekRange(offset = 0) {
  const start = weekStart(new Date(), offset);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end, startMs: start.getTime(), endMs: end.getTime() };
}

export function formatWeekRange({ start, end }) {
  const last = new Date(end.getTime() - 1);
  const sameMonth = start.getMonth() === last.getMonth();
  const fmtStart = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const fmtEnd = last.toLocaleDateString(
    undefined,
    sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' }
  );
  return `${fmtStart} – ${fmtEnd}`;
}

/* ---------- days ---------- */

// Local midnight to local midnight, so a daily limit resets when the user's
// day does rather than at UTC midnight.
export function dayRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end, startMs: start.getTime(), endMs: end.getTime() };
}

// The seven local midnight-to-midnight days of a week. Built by calendar
// arithmetic rather than by adding 86400000 seven times, because the week
// containing a DST change has a 23- and a 25-hour day in it.
export function weekDays(range) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const start = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() + i);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    days.push({ index: i, start, end, startMs: start.getTime(), endMs: end.getTime() });
  }
  return days;
}

// Which of those days holds `ms`, or -1 if it falls outside the week.
export function dayIndexOf(ms, days) {
  return days.findIndex((d) => ms >= d.startMs && ms < d.endMs);
}

/* ---------- habits ---------- */

export function listHabits() {
  return db.all(
    'SELECT * FROM habits WHERE archived = 0 ORDER BY sort_order, id'
  );
}

export function getHabit(id) {
  return db.one('SELECT * FROM habits WHERE id = ?', [id]);
}

// `dailyLimit` is optional: null means the habit is only capped by the week.
// `atLeast` is the direction: 0 for a budget to stay under, 1 for a target to
// reach. Only yes/no habits offer the choice; everything else is a cap.
export function createHabit({ name, kind, weeklyBudget, dailyLimit = null, unit, color, atLeast = 0 }) {
  const next = db.one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM habits');
  db.run(
    `INSERT INTO habits (name, kind, weekly_budget, daily_limit, unit, color, at_least, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name.trim(), kind, weeklyBudget, dailyLimit, unit || null, color, atLeast ? 1 : 0, next.n, Date.now()]
  );
  return db.lastInsertId();
}

export function updateHabit(id, { name, weeklyBudget, dailyLimit = null, unit, color, atLeast = 0 }) {
  db.run(
    'UPDATE habits SET name = ?, weekly_budget = ?, daily_limit = ?, unit = ?, color = ?, at_least = ? WHERE id = ?',
    [name.trim(), weeklyBudget, dailyLimit, unit || null, color, atLeast ? 1 : 0, id]
  );
}

// Writes the whole order in one statement so the database is exported once
// rather than once per card.
export function reorderHabits(ids) {
  if (!ids.length) return;
  const cases = ids.map((_, i) => `WHEN ? THEN ${i}`).join(' ');
  const holes = ids.map(() => '?').join(',');
  db.run(
    `UPDATE habits SET sort_order = CASE id ${cases} ELSE sort_order END WHERE id IN (${holes})`,
    [...ids, ...ids]
  );
}

// Hiding keeps every entry and only drops the habit out of the week view, so
// unhiding restores the full history. A timer left running on a hidden card
// would tick away unseen, so it is stopped (and its session logged) first.
export function hideHabit(id) {
  stopTimer(id);
  db.run('UPDATE habits SET archived = 1 WHERE id = ?', [id]);
}

export function unhideHabit(id) {
  db.run('UPDATE habits SET archived = 0 WHERE id = ?', [id]);
}

export function listHidden() {
  return db.all('SELECT * FROM habits WHERE archived = 1 ORDER BY sort_order, id');
}

export function deleteHabit(id) {
  db.run('DELETE FROM entries WHERE habit_id = ?', [id]);
  db.run('DELETE FROM timers WHERE habit_id = ?', [id]);
  db.run('DELETE FROM habits WHERE id = ?', [id]);
}

/* ---------- usage ---------- */

// Total recorded for a habit inside one week (excludes any running timer).
export function usedInWeek(habitId, { startMs, endMs }) {
  const row = db.one(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM entries WHERE habit_id = ? AND started_at >= ? AND started_at < ?',
    [habitId, startMs, endMs]
  );
  return row.total;
}

// The same sum over one day, for habits that also carry a daily limit.
export function usedInDay(habitId, range = dayRange()) {
  return usedInWeek(habitId, range);
}

// The whole grid in one query: habit id -> seven daily totals. Bucketing is
// done here rather than in SQL because SQLite would have to be told about the
// local timezone to group by calendar day, and it is not.
export function usageByDay(range) {
  const days = weekDays(range);
  const rows = db.all(
    'SELECT habit_id, amount, started_at FROM entries WHERE started_at >= ? AND started_at < ?',
    [range.startMs, range.endMs]
  );
  const grid = new Map();
  for (const r of rows) {
    const day = dayIndexOf(r.started_at, days);
    if (day < 0) continue;
    if (!grid.has(r.habit_id)) grid.set(r.habit_id, new Array(7).fill(0));
    grid.get(r.habit_id)[day] += r.amount;
  }
  return grid;
}

// The most recent entry of one day, which is what taking a count back down
// removes — the same honesty as the old minus button, one day at a time.
export function decrementDay(habitId, day) {
  const last = db.one(
    `SELECT id FROM entries
      WHERE habit_id = ? AND started_at >= ? AND started_at < ?
      ORDER BY started_at DESC, id DESC LIMIT 1`,
    [habitId, day.startMs, day.endMs]
  );
  if (!last) return false;
  db.run('DELETE FROM entries WHERE id = ?', [last.id]);
  return true;
}

/* ---------- history ---------- */

// The last `count` weeks, oldest first, each one a range like weekRange gives.
export function recentWeeks(count) {
  const weeks = [];
  for (let i = count - 1; i >= 0; i--) weeks.push({ offset: -i, ...weekRange(-i) });
  return weeks;
}

// habit id -> one total per week, in the same order. Budgets reset every week,
// so this is the only way to see whether a habit is going anywhere: the grid
// itself can only ever show one week.
export function weeklyTotals(weeks) {
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  const rows = db.all(
    'SELECT habit_id, amount, started_at FROM entries WHERE started_at >= ? AND started_at < ?',
    [first.startMs, last.endMs]
  );
  const totals = new Map();
  for (const r of rows) {
    const i = weeks.findIndex((w) => r.started_at >= w.startMs && r.started_at < w.endMs);
    if (i < 0) continue;
    if (!totals.has(r.habit_id)) totals.set(r.habit_id, new Array(weeks.length).fill(0));
    totals.get(r.habit_id)[i] += r.amount;
  }
  return totals;
}

/* ---------- yes/no habits ---------- */

// A tick, not a number: a day either holds one entry or none. Toggling off
// deletes whatever is there rather than writing a negative, so a day can never
// end up holding two ticks — and an imported database that somehow does is
// cleaned up the first time the day is tapped.
export function toggleDay(habitId, day, when) {
  if (usedInDay(habitId, day) > 0) {
    db.run(
      'DELETE FROM entries WHERE habit_id = ? AND started_at >= ? AND started_at < ?',
      [habitId, day.startMs, day.endMs]
    );
    return false;
  }
  db.run(
    'INSERT INTO entries (habit_id, amount, started_at, ended_at, note) VALUES (?, 1, ?, ?, ?)',
    [habitId, when, when, 'tick']
  );
  return true;
}

export function entriesForWeek(habitId, range) {
  return db.all(
    `SELECT * FROM entries
      WHERE habit_id = ? AND started_at >= ? AND started_at < ?
      ORDER BY started_at DESC`,
    [habitId, range.startMs, range.endMs]
  );
}

// The same list over one day: a day is a range like any other.
export function entriesForDay(habitId, day) {
  return entriesForWeek(habitId, day);
}

export function deleteEntry(id) {
  db.run('DELETE FROM entries WHERE id = ?', [id]);
}

/* ---------- money habits ---------- */

// The amounts most recently used for this habit, so the log sheet can offer
// them as one-tap repeats — a flat white costs the same every time.
export function recentAmounts(habitId, limit = 4) {
  return db
    .all(
      `SELECT amount FROM entries
        WHERE habit_id = ? AND amount > 0
        GROUP BY amount
        ORDER BY MAX(started_at) DESC
        LIMIT ?`,
      [habitId, limit]
    )
    .map((r) => r.amount);
}

/* ---------- timers ---------- */

export function runningTimers() {
  const rows = db.all('SELECT habit_id, started_at FROM timers');
  return new Map(rows.map((r) => [r.habit_id, r.started_at]));
}

export function startTimer(habitId) {
  db.run(
    'INSERT INTO timers (habit_id, started_at) VALUES (?, ?) ON CONFLICT(habit_id) DO NOTHING',
    [habitId, Date.now()]
  );
}

// Stops the timer and records the elapsed minutes. Sessions shorter than a
// few seconds are treated as a misfire and dropped.
export function stopTimer(habitId) {
  const timer = db.one('SELECT started_at FROM timers WHERE habit_id = ?', [habitId]);
  if (!timer) return null;
  const now = Date.now();
  const minutes = (now - timer.started_at) / 60000;
  db.run('DELETE FROM timers WHERE habit_id = ?', [habitId]);
  if (minutes < 0.05) return null;
  db.run(
    'INSERT INTO entries (habit_id, amount, started_at, ended_at) VALUES (?, ?, ?, ?)',
    [habitId, minutes, timer.started_at, now]
  );
  return minutes;
}

/* ---------- manual adjustments ---------- */

export function addManualEntry(habitId, amount, when = Date.now()) {
  db.run(
    'INSERT INTO entries (habit_id, amount, started_at, ended_at, note) VALUES (?, ?, ?, ?, ?)',
    [habitId, amount, when, when, 'manual']
  );
}

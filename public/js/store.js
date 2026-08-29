// store.js — habit domain logic on top of the SQLite layer.
// Budgets and amounts share one unit per kind, so a budget can always be
// compared to a sum directly: minutes for 'time', whole units for 'count',
// and major currency units (12.5 = £12.50) for 'money'.

import * as db from './db.js';

export const DEFAULT_WEEK_START = 1; // Monday
export const KINDS = ['time', 'count', 'money'];

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

/* ---------- habits ---------- */

export function listHabits() {
  return db.all(
    'SELECT * FROM habits WHERE archived = 0 ORDER BY sort_order, id'
  );
}

export function getHabit(id) {
  return db.one('SELECT * FROM habits WHERE id = ?', [id]);
}

export function createHabit({ name, kind, weeklyBudget, unit, color }) {
  const next = db.one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM habits');
  db.run(
    `INSERT INTO habits (name, kind, weekly_budget, unit, color, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name.trim(), kind, weeklyBudget, unit || null, color, next.n, Date.now()]
  );
  return db.lastInsertId();
}

export function updateHabit(id, { name, weeklyBudget, unit, color }) {
  db.run(
    'UPDATE habits SET name = ?, weekly_budget = ?, unit = ?, color = ? WHERE id = ?',
    [name.trim(), weeklyBudget, unit || null, color, id]
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

export function usageForWeek(range) {
  const rows = db.all(
    `SELECT habit_id, COALESCE(SUM(amount), 0) AS total
       FROM entries
      WHERE started_at >= ? AND started_at < ?
      GROUP BY habit_id`,
    [range.startMs, range.endMs]
  );
  return new Map(rows.map((r) => [r.habit_id, r.total]));
}

export function entriesForWeek(habitId, range) {
  return db.all(
    `SELECT * FROM entries
      WHERE habit_id = ? AND started_at >= ? AND started_at < ?
      ORDER BY started_at DESC`,
    [habitId, range.startMs, range.endMs]
  );
}

export function deleteEntry(id) {
  db.run('DELETE FROM entries WHERE id = ?', [id]);
}

/* ---------- count habits ---------- */

export function increment(habitId, by = 1) {
  const now = Date.now();
  db.run(
    'INSERT INTO entries (habit_id, amount, started_at, ended_at) VALUES (?, ?, ?, ?)',
    [habitId, by, now, now]
  );
}

// The minus button undoes the most recent tally in the week being viewed
// rather than recording a negative amount, so the log stays honest.
export function decrement(habitId, range) {
  const last = db.one(
    `SELECT id FROM entries
      WHERE habit_id = ? AND started_at >= ? AND started_at < ?
      ORDER BY started_at DESC, id DESC LIMIT 1`,
    [habitId, range.startMs, range.endMs]
  );
  if (!last) return false;
  db.run('DELETE FROM entries WHERE id = ?', [last.id]);
  return true;
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

// app.js — UI controller.

import * as db from './db.js';
import * as store from './store.js';

const COLORS = ['#5b8def', '#3ec98a', '#f2a33c', '#f2555a', '#a878f0', '#3ec2c9', '#e46bb0', '#8a94a6'];

const $ = (sel, root = document) => root.querySelector(sel);
const list = $('#habit-list');
// The habits scroll sideways under a frozen day column, so "the thing that
// scrolls" during a drag is this element and not the window.
const grid = $('#grid');
const daycol = $('#daycol');
const trend = $('#trend');
const emptyState = $('#empty');
const habitDialog = $('#habit-dialog');
const habitForm = $('#habit-form');
const detailDialog = $('#detail-dialog');
const settingsDialog = $('#settings-dialog');
const dayDialog = $('#day-dialog');
const dayForm = $('#day-form');

let weekOffset = 0;      // 0 = current week, -1 = last week, …
let editingId = null;    // habit being edited in the sheet
let detailId = null;     // habit shown in the detail sheet
let timers = new Map();  // habit_id -> started_at, for live ticking
let days = [];           // the seven columns of the week on screen
let todayIndex = -1;     // which column is today, or -1 on an earlier week
let daySheet = null;     // { habitId, dayIndex } while the day sheet is open
let suppressClick = false; // set by a finished drag, so it cannot also open a sheet
let scrollLeft = 0;      // how far the habits are scrolled, kept across renders

/* ---------- formatting ---------- */

function formatMinutes(min) {
  const m = Math.abs(min);
  if (m > 0 && m < 1) return `${Math.max(1, Math.round(m * 60))}s`;
  // Round to whole minutes *before* splitting, or 179.9 renders as "2h 60m".
  const total = Math.round(m);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const rem = total % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

// Rebuilt only when the currency setting changes; tick() formats on every
// frame and constructing an Intl.NumberFormat is not free.
let moneyFmt = null;
let moneyFmtFor = null;

function moneyFormat() {
  const code = store.currency();
  if (moneyFmtFor !== code) {
    moneyFmtFor = code;
    moneyFmt = buildMoneyFormat(code);
  }
  return moneyFmt;
}

function buildMoneyFormat(code) {
  try {
    // narrowSymbol keeps it as "$12.50" rather than "US$12.50" outside the US.
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' });
  } catch {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
    } catch {
      // An engine that doesn't know the code at all — show a bare number
      // rather than failing to render the card.
      return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
  }
}

function formatMoney(value) {
  return moneyFormat().format(value);
}

function currencySymbol() {
  const part = moneyFormat().formatToParts(0).find((p) => p.type === 'currency');
  return part ? part.value : store.currency();
}

function formatAmount(habit, value) {
  if (habit.kind === 'time') return formatMinutes(value);
  if (habit.kind === 'money') return formatMoney(value);
  const n = Math.round(value * 10) / 10;
  if (!habit.unit) return String(n);
  // "1 cups" reads badly; drop a plural 's' for exactly one.
  const unit = n === 1 && habit.unit.endsWith('s') ? habit.unit.slice(0, -1) : habit.unit;
  return `${n} ${unit}`;
}

// The "N of M" forms name the unit once, on the limit, so a count habit
// reads "2 of 3 cups" rather than "2 cups of 3 cups".
function formatBare(habit, value) {
  if (habit.kind === 'count') return String(Math.round(value * 10) / 10);
  return formatAmount(habit, value);
}

function formatBudget(habit) {
  if (habit.kind === 'time') return formatMinutes(habit.weekly_budget);
  if (habit.kind === 'money') return formatMoney(habit.weekly_budget);
  return `${habit.weekly_budget}${habit.unit ? ' ' + habit.unit : ''}`;
}

function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1900);
}

/* ---------- rendering ---------- */

// Sunday-first, indexed by getDay(); the week itself may start on any of them.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function render() {
  // Columns are about to be replaced, so a drag in flight is holding nodes
  // that are on their way out. Drop it rather than move detached elements.
  if (drag) cleanupDrag();

  const range = store.weekRange(weekOffset);
  const habits = store.listHabits();
  const usage = store.usageByDay(range);
  days = store.weekDays(range);
  timers = weekOffset === 0 ? store.runningTimers() : new Map();
  // Which row is today — and so also the edge past which the days have not
  // happened yet. An earlier week has neither.
  todayIndex = weekOffset === 0 ? store.dayIndexOf(Date.now(), days) : -1;

  $('#week-title').textContent =
    weekOffset === 0 ? 'This week' : weekOffset === -1 ? 'Last week' : store.formatWeekRange(range);
  $('#week-range').textContent = store.formatWeekRange(range);
  $('#week-next').disabled = weekOffset >= 0;

  emptyState.hidden = habits.length > 0;
  $('#fab').hidden = habits.length === 0;
  grid.hidden = habits.length === 0;
  grid.classList.toggle('compact', store.getSetting('compact', '0') === '1');

  renderDayColumn();
  list.replaceChildren(...habits.map((h) => column(h, usage.get(h.id) || new Array(7).fill(0))));
  renderTrend(habits);
  // A re-render resets the scroll, which would hide whichever habit the user
  // had scrolled to. Keeping it is cheap and much less jarring.
  grid.scrollLeft = scrollLeft;
  tick();
}

// The frozen column: a blank corner to clear the habit headers, then a label
// per day.
function renderDayColumn() {
  const corner = document.createElement('div');
  corner.className = 'corner';
  daycol.replaceChildren(corner, ...days.map((day) => {
    const el = document.createElement('div');
    el.className = 'dlabel';
    if (day.index === todayIndex) el.classList.add('today');
    if (todayIndex >= 0 && day.index > todayIndex) el.classList.add('future');
    el.innerHTML =
      `<span class="dow">${DAY_NAMES[day.start.getDay()]}</span>` +
      `<span class="dom">${day.start.getDate()}</span>`;
    return el;
  }));
}

// `daily` is the seven totals for this habit, in day order. The column keeps
// them on the element so a tick can recompute without touching the database.
function column(habit, daily) {
  const el = document.createElement('div');
  el.className = 'hcol';
  el.dataset.id = habit.id;
  el.style.setProperty('--habit-color', habit.color);

  const cells = days
    .map((day) => {
      // Logging into a day that has not happened yet is a mis-tap, not an
      // intention, so those cells are inert.
      const future = todayIndex >= 0 && day.index > todayIndex;
      const classes = ['cell', future ? 'future' : '', day.index === todayIndex ? 'today' : ''];
      return `<button type="button" class="${classes.filter(Boolean).join(' ')}"
        data-cell data-day="${day.index}"${future ? ' disabled' : ''}></button>`;
    })
    .join('');

  el.innerHTML = `
    <button type="button" class="hcol-head" data-head>
      <span class="hcol-name">${escapeHtml(habit.name)}</span>
      <span class="hcol-left" data-left></span>
      <span class="hcol-bar"><i data-bar></i></span>
    </button>
    ${cells}`;

  el._habit = habit;
  el._days = daily;
  return el;
}

// Refreshes only the numbers that move, so a running stopwatch can update
// every second without rebuilding the grid.
function tick() {
  const now = Date.now();
  for (const el of list.children) {
    const habit = el._habit;
    const startedAt = timers.get(habit.id);
    const live = startedAt && habit.kind === 'time' ? (now - startedAt) / 60000 : 0;
    el.classList.toggle('running', Boolean(startedAt));

    const used = el._days.reduce((a, b) => a + b, 0) + live;
    const remaining = habit.weekly_budget - used;
    // Summing floats leaves dust, and a column must not go red over a
    // hundredth of a penny.
    const over = habit.kind === 'money' ? remaining < -0.005 : remaining < 0;
    el.classList.toggle('over', over);

    $('[data-left]', el).textContent = over
      ? `${formatAmount(habit, -remaining)} over`
      : `${formatAmount(habit, remaining)} left`;
    const pct = habit.weekly_budget > 0 ? Math.min(100, (used / habit.weekly_budget) * 100) : 0;
    $('[data-bar]', el).style.width = `${pct}%`;

    for (const cell of el.querySelectorAll('[data-cell]')) {
      const i = Number(cell.dataset.day);
      // A running stopwatch belongs to today's row and nowhere else.
      const value = el._days[i] + (i === todayIndex ? live : 0);
      const limit = habit.daily_limit;
      const dayOver = Boolean(limit) &&
        (habit.kind === 'money' ? value - limit > 0.005 : value > limit);

      cell.classList.toggle('logged', value > 0);
      cell.classList.toggle('over', dayOver);
      cell.classList.toggle('ticking', Boolean(startedAt) && i === todayIndex);
      // The column is headed with the habit's name, so a count needs only its
      // number; time and money carry their own unit and keep it.
      cell.textContent = value > 0 ? formatBare(habit, value) : '';
      cell.setAttribute('aria-label', cellLabel(habit, i, value));
    }
  }
}

function cellLabel(habit, index, value) {
  const when = days[index].start.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  return `${habit.name}, ${when}, ${value > 0 ? formatAmount(habit, value) : 'nothing'} logged`;
}

/* ---------- the trend strip ---------- */

const TREND_WEEKS = 12;

function renderTrend(habits) {
  trend.hidden = habits.length === 0;
  if (trend.hidden) return;

  const weeks = store.recentWeeks(TREND_WEEKS);
  const totals = store.weeklyTotals(weeks);
  $('#trend-head').textContent = `Last ${TREND_WEEKS} weeks`;
  $('#trend-from').textContent = `${TREND_WEEKS} weeks ago`;
  $('#trend-lines').replaceChildren(
    ...habits.map((h) => trendLine(h, totals.get(h.id) || new Array(weeks.length).fill(0), weeks))
  );
}

function trendLine(habit, series, weeks) {
  const el = document.createElement('div');
  el.className = 'tline';
  el.style.setProperty('--habit-color', habit.color);

  // Scaled against the budget or the worst week, whichever is larger, so the
  // budget line always lands somewhere on the chart and bars stay comparable
  // to it rather than only to each other.
  const peak = Math.max(habit.weekly_budget, ...series) || 1;

  // Weeks before the habit existed are not zero weeks, they are nothing, and
  // averaging them in would libel every habit created recently. The current
  // week is still being filled in, so it is left out too.
  const born = weeks.findIndex((w) => w.endMs > habit.created_at);
  const firstReal = born < 0 ? weeks.length : born;
  const complete = series.slice(firstReal, series.length - 1);
  const slack = habit.kind === 'money' ? 0.005 : 0;
  const overWeeks = complete.filter((v) => v - habit.weekly_budget > slack).length;
  const average = complete.length
    ? complete.reduce((a, b) => a + b, 0) / complete.length
    : null;

  const bars = weeks
    .map((week, i) => {
      const value = series[i];
      const before = i < firstReal;
      const classes = [
        'tbar',
        before ? 'before' : '',
        value <= 0 ? 'zero' : '',
        !before && value - habit.weekly_budget > slack ? 'over' : '',
        week.offset === 0 ? 'now' : '',
        week.offset === weekOffset ? 'viewing' : '',
      ];
      const height = Math.max(2, Math.round((value / peak) * 100));
      const label = `${habit.name}, ${store.formatWeekRange(week)}, ${
        before ? 'before this habit existed' : formatAmount(habit, value)}`;
      return `<button type="button" class="${classes.filter(Boolean).join(' ')}"
        data-offset="${week.offset}" aria-label="${escapeHtml(label)}"
        ><i style="height:${value > 0 ? height : 2}%"></i></button>`;
    })
    .join('');

  el.innerHTML = `
    <div class="tline-head">
      <span class="tline-name">${escapeHtml(habit.name)}</span>
      <span class="tline-stat">${average === null
        ? 'no full week yet'
        : `avg ${escapeHtml(formatAmount(habit, average))}${overWeeks ? ` · over ${overWeeks}×` : ''}`}</span>
    </div>
    <div class="tbars" style="--budget:${Math.min(100, (habit.weekly_budget / peak) * 100)}%">${bars}</div>`;
  return el;
}

// A bar is the week it stands for, so tapping one takes the grid there.
trend.addEventListener('click', (event) => {
  const bar = event.target.closest('[data-offset]');
  if (!bar) return;
  weekOffset = Number(bar.dataset.offset);
  render();
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- grid interactions ---------- */

grid.addEventListener('scroll', () => {
  if (!drag) scrollLeft = grid.scrollLeft;
}, { passive: true });

list.addEventListener('click', (event) => {
  // A finished drag ends in a click on a row that has just been replaced. It
  // must not also open a sheet.
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const el = event.target.closest('.hcol');
  if (!el) return;

  const cell = event.target.closest('[data-cell]');
  if (cell) return openDaySheet(el._habit, Number(cell.dataset.day));
  if (event.target.closest('[data-head]')) openDetail(el._habit.id);
});

function buzz(ms) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

/* ---------- daily limits ---------- */

// The day's total before a log, so the crossing can be spotted afterwards.
// Zero for habits without a limit: nothing reads it in that case.
function dayTotal(habit, day) {
  return habit.daily_limit ? store.usedInDay(habit.id, day) : 0;
}

// True when *this* log is what took the day past its limit. Only the crossing
// is worth a word — warning on every later tap would just be nagging.
function crossedDailyLimit(habit, day, usedBefore) {
  if (!habit.daily_limit) return false;
  const slack = habit.kind === 'money' ? 0.005 : 0;
  return usedBefore - habit.daily_limit <= slack
    && store.usedInDay(habit.id, day) - habit.daily_limit > slack;
}

/* ---------- drag to reorder ---------- */

const HOLD_MS = 300;  // press-and-hold before a column lifts
const SLOP = 8;       // travel before the hold counts as a scroll instead
const EDGE = 56;      // auto-scroll zone at the left and right of the grid

let drag = null;

// Only the name is a handle. Every cell is a target in its own right, so a
// hold on one must not drag the column out from under the finger.
//
// Everything below works in the grid's own scrolled coordinates, on the X
// axis: the habits scroll sideways, and a drag and the scroll underneath it
// have to agree about where a column is.
const gridX = (event) => event.clientX + grid.scrollLeft;

list.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const head = event.target.closest('.hcol-head');
  const el = head && head.closest('.hcol');
  if (!el) return;
  if (list.children.length < 2) return;

  cancelDrag();
  drag = {
    el,
    pointerId: event.pointerId,
    startX: gridX(event),
    startY: event.clientY,
    x: gridX(event),
    active: false,
    raf: 0,
    scrollBy: 0,
    timer: setTimeout(beginDrag, HOLD_MS),
  };
});

function beginDrag() {
  const cols = [...list.children];
  const scroll = grid.scrollLeft;
  drag.cols = cols;
  drag.rects = cols.map((c) => {
    const box = c.getBoundingClientRect();
    return { left: box.left + scroll, width: box.width, centre: box.left + scroll + box.width / 2 };
  });
  drag.from = cols.indexOf(drag.el);
  drag.to = drag.from;

  const gap = parseFloat(getComputedStyle(list).columnGap);
  drag.gap = Number.isFinite(gap) ? gap : 5;
  drag.shift = drag.rects[drag.from].width + drag.gap;
  drag.active = true;

  list.classList.add('reordering');
  drag.el.classList.add('dragging');
  drag.el.setPointerCapture?.(drag.pointerId);
  buzz(12);
}

list.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    // A finger that travels before the hold expires was trying to scroll —
    // sideways through the habits, or down the page. Either cancels.
    if (Math.abs(gridX(event) - drag.startX) > SLOP
      || Math.abs(event.clientY - drag.startY) > SLOP) cancelDrag();
    return;
  }
  drag.x = gridX(event);
  updateDrag();
  autoScroll(event.clientX);
});

function updateDrag() {
  const dx = drag.x - drag.startX;
  drag.el.style.transform = `translateX(${dx}px)`;

  const to = slotFor(drag.rects[drag.from].centre + dx);
  if (to === drag.to) return;
  drag.to = to;

  // Columns between the old slot and the new one slide by exactly the space
  // the dragged column vacated, so uneven widths would still line up.
  drag.cols.forEach((c, i) => {
    if (i === drag.from) return;
    let move = 0;
    if (to > drag.from && i > drag.from && i <= to) move = -drag.shift;
    else if (to < drag.from && i >= to && i < drag.from) move = drag.shift;
    c.style.transform = move ? `translateX(${move}px)` : '';
  });
}

// Which slot the column would land in. The comparison has to be against the
// layout with the column *removed* — once it lifts, everything to its right
// closes the gap, so measuring against the original centres lands it a slot
// too far.
function slotFor(centre) {
  const { rects, from, gap } = drag;
  const width = rects[from].width;
  const others = rects.filter((_, i) => i !== from);

  let left = rects[0].left;
  let best = 0;
  let bestDistance = Infinity;

  for (let slot = 0; slot < rects.length; slot++) {
    const distance = Math.abs(left + width / 2 - centre);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
    if (slot < others.length) left += others[slot].width + gap;
  }
  return best;
}

// Dragging to the edge of the grid scrolls it, which is the only way to move
// a column past the fold on a phone.
function autoScroll(clientX) {
  const box = grid.getBoundingClientRect();
  const before = clientX - (box.left + EDGE);
  const after = clientX - (box.right - EDGE);
  drag.scrollBy = before < 0 ? Math.max(before, -24) / 3 : after > 0 ? Math.min(after, 24) / 3 : 0;
  if (drag.scrollBy && !drag.raf) stepScroll();
}

function stepScroll() {
  drag.raf = requestAnimationFrame(() => {
    if (!drag || !drag.active) return;
    drag.raf = 0;
    if (!drag.scrollBy) return;
    const before = grid.scrollLeft;
    grid.scrollLeft += drag.scrollBy;
    const moved = grid.scrollLeft - before;
    if (moved) {
      // A still finger over a scrolling grid has still moved across the
      // habits, and the drag works in the grid's scrolled coordinates.
      drag.x += moved;
      updateDrag();
      stepScroll();
    }
  });
}

// Touch scrolling is only cancellable from a non-passive touchmove; by the
// time a hold has completed, no scroll has started, so this takes effect.
list.addEventListener('touchmove', (event) => {
  if (drag?.active) event.preventDefault();
}, { passive: false });

list.addEventListener('contextmenu', (event) => {
  if (drag) event.preventDefault();
});

list.addEventListener('pointerup', endDrag);
list.addEventListener('pointercancel', endDrag);

function endDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    cancelDrag();
    return;
  }
  const { cols, from, to } = drag;
  const order = cols.map((c) => c._habit.id);
  order.splice(to, 0, ...order.splice(from, 1));

  // The pointerup is followed by a click on a column this render is about to
  // replace; without this it would also open the detail sheet.
  suppressClick = true;
  // Where the grid is scrolled to is now the truth, not what the drag started
  // with: auto-scroll may have moved it.
  scrollLeft = grid.scrollLeft;
  cleanupDrag();
  if (to !== from) {
    store.reorderHabits(order);
    buzz(8);
  }
  render();
}

function cancelDrag() {
  if (!drag) return;
  const wasActive = drag.active;
  cleanupDrag();
  if (wasActive) render();
}

function cleanupDrag() {
  clearTimeout(drag.timer);
  if (drag.raf) cancelAnimationFrame(drag.raf);
  if (drag.active) {
    list.classList.remove('reordering');
    drag.el.classList.remove('dragging');
    try {
      drag.el.releasePointerCapture?.(drag.pointerId);
    } catch {
      // the pointer is already gone, which is the state we wanted anyway
    }
    for (const c of drag.cols) c.style.transform = '';
  }
  drag = null;
}

/* ---------- week navigation ---------- */

$('#week-prev').addEventListener('click', () => { weekOffset -= 1; render(); });
$('#week-next').addEventListener('click', () => { if (weekOffset < 0) { weekOffset += 1; render(); } });

/* ---------- habit editor ---------- */

function buildSwatches() {
  $('#swatches').innerHTML = COLORS.map(
    (c, i) => `<label><input type="radio" name="color" value="${c}"${i === 0 ? ' checked' : ''}>
      <span style="background:${c}"></span></label>`
  ).join('');
}

function syncKindFields() {
  const kind = habitForm.kind.value;
  $('#budget-label').textContent =
    kind === 'time' ? 'Weekly budget (minutes)'
      : kind === 'money' ? `Weekly budget (${currencySymbol()})`
        : 'Weekly budget (how many)';
  habitForm.budget.placeholder = kind === 'time' ? '180' : kind === 'money' ? '50' : '10';
  $('#daily-label').innerHTML =
    (kind === 'time' ? 'Daily limit (minutes)'
      : kind === 'money' ? `Daily limit (${escapeHtml(currencySymbol())})`
        : 'Daily limit (how many)') + ' <em>(optional)</em>';
  habitForm.daily.placeholder = kind === 'time' ? '30' : kind === 'money' ? '10' : '2';
  // Only counts get a free-text unit; money is labelled by the currency.
  $('#unit-field').hidden = kind !== 'count';
}

habitForm.addEventListener('change', (e) => { if (e.target.name === 'kind') syncKindFields(); });

function openHabitEditor(habit = null) {
  editingId = habit ? habit.id : null;
  habitForm.reset();
  $('#habit-dialog-title').textContent = habit ? 'Edit habit' : 'New habit';
  $('#kind-field').hidden = Boolean(habit); // changing kind would orphan past entries

  if (habit) {
    habitForm.name.value = habit.name;
    habitForm.kind.value = habit.kind;
    habitForm.budget.value = habit.weekly_budget;
    habitForm.daily.value = habit.daily_limit ?? '';
    habitForm.unit.value = habit.unit || '';
    const swatch = habitForm.querySelector(`input[name=color][value="${habit.color}"]`);
    if (swatch) swatch.checked = true;
  }
  syncKindFields();
  habitDialog.showModal();
  if (!habit) setTimeout(() => habitForm.name.focus(), 60);
}

habitForm.addEventListener('submit', () => {
  const data = new FormData(habitForm);
  const values = {
    name: String(data.get('name') || '').trim(),
    kind: String(data.get('kind')),
    weeklyBudget: Math.max(0, Number(data.get('budget')) || 0),
    // Blank or zero means no daily limit rather than a limit of nothing.
    dailyLimit: Number(data.get('daily')) > 0 ? Number(data.get('daily')) : null,
    unit: String(data.get('unit') || '').trim(),
    color: String(data.get('color') || COLORS[0]),
  };
  if (!values.name) return;

  if (editingId) store.updateHabit(editingId, values);
  else store.createHabit(values);
  editingId = null;
  render();
});

/* ---------- logging one day ---------- */

// The cell that was tapped decides the habit and the day, so the sheet only
// has to answer "how much". Every kind shares it, which is why manual logging
// stopped needing a date picker: the grid is the date picker.
function openDaySheet(habit, dayIndex) {
  daySheet = { habitId: habit.id, dayIndex };
  dayForm.reset();

  $('#day-title').textContent = habit.name;
  $('#day-amount-label').textContent =
    habit.kind === 'time' ? 'Minutes'
      : habit.kind === 'money' ? `Amount (${currencySymbol()})`
        : `How many${habit.unit ? ` (${habit.unit})` : ''}`;
  dayForm.amount.placeholder =
    habit.kind === 'time' ? '30' : habit.kind === 'money' ? '0.00' : '1';

  // A tally that writes on the tap, because "one more coffee" should not be a
  // form. Money has no natural increment, and time has a stopwatch instead.
  $('#day-step').hidden = habit.kind !== 'count';
  // A stopwatch only makes sense on the day that is still happening.
  $('#day-timer').hidden = !(habit.kind === 'time' && dayIndex === todayIndex);

  const recent = habit.kind === 'money' ? store.recentAmounts(habit.id) : [];
  $('#day-quick').innerHTML = recent
    .map((a) => `<button type="button" class="chip" data-amount="${a}">${escapeHtml(formatAmount(habit, a))}</button>`)
    .join('');

  paintDaySheet();
  dayDialog.showModal();
  if (habit.kind !== 'count') setTimeout(() => dayForm.amount.focus(), 60);
}

// Re-read rather than remembered: the stepper and the stopwatch both write
// while the sheet is open.
function paintDaySheet() {
  if (!daySheet) return;
  const habit = store.getHabit(daySheet.habitId);
  const day = days[daySheet.dayIndex];
  if (!habit || !day) return;

  const startedAt = store.runningTimers().get(habit.id);
  const live = startedAt && habit.kind === 'time' && daySheet.dayIndex === todayIndex
    ? (Date.now() - startedAt) / 60000
    : 0;
  const used = store.usedInDay(habit.id, day) + live;

  const when = day.start.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'short',
  });
  const limit = habit.daily_limit
    ? ` · limit ${formatAmount(habit, habit.daily_limit)}`
    : '';
  const sub = $('#day-sub');
  sub.textContent = `${when} · ${formatAmount(habit, used)} logged${limit}`;
  const slack = habit.kind === 'money' ? 0.005 : 0;
  sub.classList.toggle('over', Boolean(habit.daily_limit) && used - habit.daily_limit > slack);

  $('#day-tally').textContent = String(Math.round(used * 10) / 10);
  $('[data-act="day-dec"]', dayDialog).disabled = used <= 0;

  const timerBtn = $('#day-timer');
  timerBtn.textContent = startedAt ? `Stop timer · ${formatClock(Date.now() - startedAt)}` : 'Start timer';
  timerBtn.classList.toggle('running', Boolean(startedAt));
}

// Today keeps the real clock time; any other day lands at midday, far enough
// from both edges that a DST shift cannot slide it into a neighbouring day.
function logToDay(habit, dayIndex, amount) {
  const day = days[dayIndex];
  const d = day.start;
  const when = dayIndex === todayIndex
    ? Date.now()
    : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();

  const before = dayTotal(habit, day);
  store.addManualEntry(habit.id, amount, when);
  if (crossedDailyLimit(habit, day, before)) {
    const whose = dayIndex === todayIndex ? "today's" : "that day's";
    toast(`Past ${whose} ${formatAmount(habit, habit.daily_limit)} limit`);
  }
}

dayDialog.addEventListener('click', (event) => {
  const button = event.target.closest('[data-act], [data-amount]');
  if (!button || !daySheet) return;
  const habit = store.getHabit(daySheet.habitId);
  const day = days[daySheet.dayIndex];

  // A chip is a repeat of a known amount, so it commits on one tap.
  if (button.dataset.amount) {
    logToDay(habit, daySheet.dayIndex, Number(button.dataset.amount));
    dayDialog.close();
    render();
    if (detailDialog.open) openDetail(habit.id);
    return;
  }

  switch (button.dataset.act) {
    case 'day-inc':
      logToDay(habit, daySheet.dayIndex, 1);
      buzz(10);
      break;
    case 'day-dec':
      if (!store.decrementDay(habit.id, day)) return toast('Nothing logged that day');
      buzz(10);
      break;
    case 'day-timer':
      if (timers.has(habit.id)) {
        const before = dayTotal(habit, day);
        const minutes = store.stopTimer(habit.id);
        toast(minutes ? `Logged ${formatMinutes(minutes)} of ${habit.name}` : 'Too short to log');
        if (crossedDailyLimit(habit, day, before)) {
          toast(`Past today's ${formatAmount(habit, habit.daily_limit)} limit`);
        }
      } else {
        store.startTimer(habit.id);
      }
      break;
    default:
      return;
  }
  // The grid behind the sheet is the point of all this, so it keeps up.
  render();
  paintDaySheet();
  if (detailDialog.open) openDetail(habit.id);
});

// Cancel and Escape both close without submitting; drop the pending day so it
// cannot leak into a later sheet.
dayDialog.addEventListener('close', () => { daySheet = null; });

dayForm.addEventListener('submit', () => {
  if (!daySheet) return;
  const habit = store.getHabit(daySheet.habitId);
  const dayIndex = daySheet.dayIndex;

  const amount = Number(new FormData(dayForm).get('amount'));
  // An empty box means the sheet was used as a stepper and is just closing.
  if (!Number.isFinite(amount) || amount === 0) return;

  logToDay(habit, dayIndex, amount);
  buzz(10);
  render();
  if (detailDialog.open) openDetail(habit.id);
});

/* ---------- detail sheet ---------- */

function openDetail(id) {
  detailId = id;
  const habit = store.getHabit(id);
  const range = store.weekRange(weekOffset);
  const used = store.usedInWeek(id, range);

  $('#detail-title').textContent = habit.name;
  // The daily line is only true of the current week, where "today" is in view.
  const daily = habit.daily_limit && weekOffset === 0
    ? ` · today ${formatBare(habit, store.usedInDay(habit.id))} of ${formatAmount(habit, habit.daily_limit)}`
    : '';
  $('#detail-summary').textContent =
    `${formatAmount(habit, used)} of ${formatBudget(habit)} used · ${store.formatWeekRange(range)}${daily}`;

  const entries = store.entriesForWeek(id, range);
  $('#detail-entries').innerHTML = entries.length
    ? entries
        .map(
          (e) => `<li data-entry="${e.id}">
            <span class="amt">${formatAmount(habit, e.amount)}</span>
            <span class="when">${new Date(e.started_at).toLocaleString(undefined, {
              weekday: 'short', hour: 'numeric', minute: '2-digit',
            })}</span>
            <button class="del" data-act="del-entry" aria-label="Delete entry">✕</button>
          </li>`
        )
        .join('')
    : '<li class="none">Nothing logged this week.</li>';

  detailDialog.showModal();
}

detailDialog.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action], [data-act]');
  if (!button) return;
  const habit = store.getHabit(detailId);

  switch (button.dataset.action || button.dataset.act) {
    case 'edit-habit':
      detailDialog.close();
      openHabitEditor(habit);
      break;
    case 'hide-habit':
      store.hideHabit(habit.id);
      detailDialog.close();
      render();
      toast(`${habit.name} hidden — restore it in Settings`);
      break;
    case 'delete-habit':
      if (confirm(`Delete “${habit.name}” and all of its history?`)) {
        store.deleteHabit(habit.id);
        detailDialog.close();
        render();
        toast('Habit deleted');
      }
      break;
    case 'del-entry': {
      const id = Number(button.closest('[data-entry]').dataset.entry);
      store.deleteEntry(id);
      openDetail(detailId);
      render();
      break;
    }
  }
});

/* ---------- settings ---------- */

// A short list of widely used currencies; whatever is already stored is
// folded in so an imported database never shows a blank picker.
const CURRENCIES = [
  'AED', 'ARS', 'AUD', 'BDT', 'BGN', 'BHD', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY',
  'COP', 'CZK', 'DKK', 'EGP', 'EUR', 'GBP', 'GHS', 'HKD', 'HUF', 'IDR', 'ILS',
  'INR', 'ISK', 'JPY', 'KES', 'KRW', 'KWD', 'LKR', 'MAD', 'MXN', 'MYR', 'NGN',
  'NOK', 'NPR', 'NZD', 'OMR', 'PEN', 'PHP', 'PKR', 'PLN', 'QAR', 'RON', 'RUB',
  'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'UAH', 'USD', 'VND', 'ZAR',
];

function buildCurrencyOptions() {
  const current = store.currency();
  const codes = [...new Set([...CURRENCIES, current])].sort();
  let names = null;
  try {
    names = new Intl.DisplayNames(undefined, { type: 'currency' });
  } catch {
    // Older engine — the codes alone still identify the currency.
  }
  $('#currency-select').innerHTML = codes
    .map((c) => {
      const name = names ? names.of(c) : null;
      const label = name && name !== c ? `${c} — ${name}` : c;
      return `<option value="${c}"${c === current ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('');
}

function buildHiddenList() {
  const hidden = store.listHidden();
  $('#hidden-field').hidden = hidden.length === 0;
  $('#hidden-list').innerHTML = hidden
    .map(
      (h) => `<li>
        <span class="hidden-name">${escapeHtml(h.name)}</span>
        <button class="btn ghost" data-unhide="${h.id}">Unhide</button>
      </li>`
    )
    .join('');
}

$('#hidden-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-unhide]');
  if (!button) return;
  store.unhideHabit(Number(button.dataset.unhide));
  buildHiddenList();
  render();
  toast('Habit restored');
});

$('#density').addEventListener('change', (event) => {
  store.setSetting('compact', event.target.value === 'compact' ? '1' : '0');
  render();
});

$('#currency-select').addEventListener('change', (event) => {
  store.setCurrency(event.target.value);
  render(); // relabels every money card behind the sheet
});

$('#open-settings').addEventListener('click', async () => {
  $('#week-start-select').value = String(store.weekStartDay());
  const compact = store.getSetting('compact', '0') === '1';
  $(`#density input[value="${compact ? 'compact' : 'comfortable'}"]`).checked = true;
  buildCurrencyOptions();
  buildHiddenList();
  const note = $('#storage-note');
  if (navigator.storage?.persisted) {
    note.textContent = (await navigator.storage.persisted())
      ? 'Storage is marked persistent on this device.'
      : 'This browser may evict the data under storage pressure — keep an export handy.';
  }
  settingsDialog.showModal();
});

$('#week-start-select').addEventListener('change', (e) => {
  store.setSetting('week_start', e.target.value);
  render();
});

$('#export-db').addEventListener('click', async () => {
  await db.saveNow();
  const blob = new Blob([db.exportBytes()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `habits-${new Date().toISOString().slice(0, 10)}.db`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('#import-db').addEventListener('click', () => $('#import-file').click());

$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  if (!confirm('Replace everything currently stored with this file?')) return;
  try {
    await db.importBytes(await file.arrayBuffer());
    render();
    settingsDialog.close(); // get out of the way so the restored data is visible
    toast('Database imported');
  } catch {
    toast('That file is not a Habit Budget database');
  }
});

/* ---------- dialog plumbing ---------- */

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) dialog.close();
    // Clicking the backdrop reports coordinates outside the dialog box.
    if (event.target === dialog) {
      const box = dialog.getBoundingClientRect();
      const outside =
        event.clientY < box.top || event.clientY > box.bottom ||
        event.clientX < box.left || event.clientX > box.right;
      if (outside) dialog.close();
    }
  });
}

$('#fab').addEventListener('click', () => openHabitEditor());
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="add-habit"]')) openHabitEditor();
});

/* ---------- boot ---------- */

async function boot() {
  buildSwatches();
  await db.open();
  render();

  setInterval(() => {
    tick();
    // The sheet shows the same running clock, and it is open over the grid.
    if (dayDialog.open) paintDaySheet();
  }, 1000);

  // A running timer must survive the app being backgrounded or killed, so the
  // database is flushed whenever the page goes away and re-read on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) db.saveNow();
    else render();
  });
  window.addEventListener('pagehide', () => db.saveNow());

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

boot().catch((err) => {
  document.body.innerHTML =
    `<p style="padding:24px;color:#f2555a">Could not open the database: ${escapeHtml(String(err))}</p>`;
});

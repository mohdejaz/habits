// app.js — UI controller.

import * as db from './db.js';
import * as store from './store.js';

const COLORS = ['#5b8def', '#3ec98a', '#f2a33c', '#f2555a', '#a878f0', '#3ec2c9', '#e46bb0', '#8a94a6'];

const $ = (sel, root = document) => root.querySelector(sel);
const list = $('#habit-list');
const emptyState = $('#empty');
const habitDialog = $('#habit-dialog');
const habitForm = $('#habit-form');
const detailDialog = $('#detail-dialog');
const settingsDialog = $('#settings-dialog');
const amountDialog = $('#amount-dialog');
const amountForm = $('#amount-form');

let weekOffset = 0;      // 0 = current week, -1 = last week, …
let editingId = null;    // habit being edited in the sheet
let detailId = null;     // habit shown in the detail sheet
let timers = new Map();  // habit_id -> started_at, for live ticking
let amountId = null;     // habit being logged in the amount sheet

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

function render() {
  // Cards are about to be replaced, so a drag in flight is holding nodes that
  // are on their way out. Drop it rather than let it move detached elements.
  if (drag) cleanupDrag();

  const range = store.weekRange(weekOffset);
  const habits = store.listHabits();
  const usage = store.usageForWeek(range);
  timers = weekOffset === 0 ? store.runningTimers() : new Map();

  $('#week-title').textContent =
    weekOffset === 0 ? 'This week' : weekOffset === -1 ? 'Last week' : store.formatWeekRange(range);
  $('#week-range').textContent = store.formatWeekRange(range);
  $('#week-next').disabled = weekOffset >= 0;

  emptyState.hidden = habits.length > 0;
  $('#fab').hidden = habits.length === 0;
  list.classList.toggle('compact', store.getSetting('compact', '0') === '1');

  list.replaceChildren(...habits.map((h) => card(h, usage.get(h.id) || 0)));
  tick();
}

function card(habit, used) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = habit.id;
  el.style.setProperty('--habit-color', habit.color);

  const running = timers.has(habit.id);
  if (running) el.classList.add('running');

  // Money has no natural increment the way a coffee does, so instead of a
  // stepper it opens a sheet and shows the running total for the week.
  const controls =
    habit.kind === 'time'
      ? `<div class="controls">
           <div class="elapsed" data-elapsed></div>
           <button class="btn timer-btn" data-act="toggle-timer">${running ? 'Stop' : 'Start'}</button>
         </div>`
      : habit.kind === 'money'
      ? `<div class="controls">
           <div class="spent"><span data-spent></span><small>spent</small></div>
           <button class="btn spend-btn" data-act="spend">Log spend</button>
         </div>`
      : `<div class="stepper">
           <button class="step-btn" data-act="dec" aria-label="Remove one"${used <= 0 ? ' disabled' : ''}>−</button>
           <div class="tally">${Math.round(used * 10) / 10}<small>logged</small></div>
           <button class="step-btn plus" data-act="inc" aria-label="Add one">+</button>
         </div>`;

  el.innerHTML = `
    <div class="card-head">
      <h2 class="card-name">${escapeHtml(habit.name)}</h2>
      <button class="card-more" data-act="detail" aria-label="Options for ${escapeHtml(habit.name)}">⋯</button>
    </div>
    <div class="remaining">
      <span class="big" data-remaining></span>
      <span class="label" data-remaining-label></span>
    </div>
    <div class="bar"><i data-bar></i></div>
    ${controls}`;

  el._habit = habit;
  el._used = used;
  return el;
}

// Refreshes only the numbers that move, so a running timer can update every
// second without rebuilding cards (and losing button state) each time.
function tick() {
  const now = Date.now();
  for (const el of list.children) {
    const habit = el._habit;
    const startedAt = timers.get(habit.id);
    const live = startedAt ? (now - startedAt) / 60000 : 0;
    const used = el._used + (habit.kind === 'time' ? live : 0);
    const remaining = habit.weekly_budget - used;
    // Summing floats leaves dust, and a card must not go red over a
    // hundredth of a penny.
    const over = habit.kind === 'money' ? remaining < -0.005 : remaining < 0;

    el.classList.toggle('over', over);
    $('[data-remaining]', el).textContent = over
      ? formatAmount(habit, -remaining)
      : formatAmount(habit, remaining);
    $('[data-remaining-label]', el).textContent = over
      ? `over your ${formatBudget(habit)} budget`
      : `left of ${formatBudget(habit)}`;

    const pct = habit.weekly_budget > 0 ? Math.min(100, (used / habit.weekly_budget) * 100) : 0;
    $('[data-bar]', el).style.width = `${pct}%`;

    const spentEl = $('[data-spent]', el);
    if (spentEl) spentEl.textContent = formatAmount(habit, used);

    const elapsedEl = $('[data-elapsed]', el);
    if (elapsedEl) {
      elapsedEl.classList.toggle('idle', !startedAt);
      elapsedEl.innerHTML = startedAt
        ? `<span class="dot"></span>${formatClock(now - startedAt)}`
        : '0:00';
    }
  }
}

// Re-reads one card's usage from the database and updates it in place. Used
// by the +/- buttons: a full re-render would replace the button mid-tap.
function refreshCard(el) {
  const habit = el._habit;
  el._used = store.usedInWeek(habit.id, store.weekRange(weekOffset));
  if (habit.kind === 'count') {
    $('.tally', el).firstChild.textContent = String(Math.round(el._used * 10) / 10);
    $('[data-act=dec]', el).disabled = el._used <= 0;
  }
  tick();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- habit list interactions ---------- */

list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const el = button.closest('.card');
  const habit = el._habit;
  const range = store.weekRange(weekOffset);

  switch (button.dataset.act) {
    case 'toggle-timer': {
      if (weekOffset !== 0) return toast('Timers only run in the current week');
      if (timers.has(habit.id)) {
        const minutes = store.stopTimer(habit.id);
        toast(minutes ? `Logged ${formatMinutes(minutes)} of ${habit.name}` : 'Too short to log');
      } else {
        store.startTimer(habit.id);
      }
      render();
      break;
    }
    case 'inc':
      if (weekOffset !== 0) return toast('Switch to this week to log');
      store.increment(habit.id);
      buzz(10);
      refreshCard(el);
      break;
    case 'dec':
      if (!store.decrement(habit.id, range)) return toast('Nothing logged this week');
      buzz(10);
      refreshCard(el);
      break;
    case 'spend':
      openAmountSheet(habit);
      break;
    case 'detail':
      openDetail(habit.id);
      break;
  }
});

function buzz(ms) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

/* ---------- drag to reorder ---------- */

const HOLD_MS = 300;  // press-and-hold before a card lifts
const SLOP = 8;       // travel before the hold counts as a scroll instead
const EDGE = 72;      // auto-scroll zone at the top and bottom of the viewport

let drag = null;

// The whole card is the handle except its buttons, which keep working as
// buttons. Everything below measures in page coordinates so that auto-scroll
// and the drag maths agree while the document moves underneath.
list.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const el = event.target.closest('.card');
  if (!el || event.target.closest('[data-act]')) return;
  if (list.children.length < 2) return;

  cancelDrag();
  drag = {
    el,
    pointerId: event.pointerId,
    startY: event.pageY,
    pageY: event.pageY,
    active: false,
    raf: 0,
    scrollBy: 0,
    timer: setTimeout(beginDrag, HOLD_MS),
  };
});

function beginDrag() {
  const cards = [...list.children];
  const scroll = window.scrollY;
  drag.cards = cards;
  drag.rects = cards.map((c) => {
    const box = c.getBoundingClientRect();
    return { top: box.top + scroll, height: box.height, centre: box.top + scroll + box.height / 2 };
  });
  drag.from = cards.indexOf(drag.el);
  drag.to = drag.from;

  const gap = parseFloat(getComputedStyle(list).rowGap);
  drag.gap = Number.isFinite(gap) ? gap : 12;
  drag.shift = drag.rects[drag.from].height + drag.gap;
  drag.active = true;

  list.classList.add('reordering');
  drag.el.classList.add('dragging');
  drag.el.setPointerCapture?.(drag.pointerId);
  buzz(12);
}

list.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    // A finger that travels before the hold expires was trying to scroll.
    if (Math.abs(event.pageY - drag.startY) > SLOP) cancelDrag();
    return;
  }
  drag.pageY = event.pageY;
  updateDrag();
  autoScroll(event.clientY);
});

function updateDrag() {
  const dy = drag.pageY - drag.startY;
  drag.el.style.transform = `translateY(${dy}px)`;

  const to = slotFor(drag.rects[drag.from].centre + dy);
  if (to === drag.to) return;
  drag.to = to;

  // Cards between the old slot and the new one slide by exactly the space the
  // dragged card vacated, so a list of uneven card heights still lines up.
  drag.cards.forEach((c, i) => {
    if (i === drag.from) return;
    let move = 0;
    if (to > drag.from && i > drag.from && i <= to) move = -drag.shift;
    else if (to < drag.from && i >= to && i < drag.from) move = drag.shift;
    c.style.transform = move ? `translateY(${move}px)` : '';
  });
}

// Which slot the card would land in. The comparison has to be against the
// layout with the card *removed* — once it lifts, everything below closes the
// gap, so measuring against the original centres lands it a slot too far.
function slotFor(centre) {
  const { rects, from, gap } = drag;
  const height = rects[from].height;
  const others = rects.filter((_, i) => i !== from);

  let top = rects[0].top;
  let best = 0;
  let bestDistance = Infinity;

  for (let slot = 0; slot < rects.length; slot++) {
    const distance = Math.abs(top + height / 2 - centre);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
    if (slot < others.length) top += others[slot].height + gap;
  }
  return best;
}

// Dragging to the edge of the screen scrolls the list, which is the only way
// to move a card past the fold on a phone.
function autoScroll(clientY) {
  const above = clientY - EDGE;
  const below = clientY - (window.innerHeight - EDGE);
  drag.scrollBy = above < 0 ? Math.max(above, -24) / 3 : below > 0 ? Math.min(below, 24) / 3 : 0;
  if (drag.scrollBy && !drag.raf) stepScroll();
}

function stepScroll() {
  drag.raf = requestAnimationFrame(() => {
    if (!drag || !drag.active) return;
    drag.raf = 0;
    if (!drag.scrollBy) return;
    const before = window.scrollY;
    window.scrollBy(0, drag.scrollBy);
    const moved = window.scrollY - before;
    if (moved) {
      // A still finger over a scrolling page has still moved down the
      // document, and the drag works in document coordinates.
      drag.pageY += moved;
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
  const { cards, from, to } = drag;
  const order = cards.map((c) => c._habit.id);
  order.splice(to, 0, ...order.splice(from, 1));

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
    for (const c of drag.cards) c.style.transform = '';
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
    unit: String(data.get('unit') || '').trim(),
    color: String(data.get('color') || COLORS[0]),
  };
  if (!values.name) return;

  if (editingId) store.updateHabit(editingId, values);
  else store.createHabit(values);
  editingId = null;
  render();
});

/* ---------- amount sheet (money habits) ---------- */

function openAmountSheet(habit) {
  amountId = habit.id;
  amountForm.reset();
  $('#amount-title').textContent = habit.name;
  $('#amount-label').textContent = `Amount (${currencySymbol()})`;

  const recent = store.recentAmounts(habit.id);
  $('#amount-quick').innerHTML = recent
    .map((a) => `<button type="button" class="chip" data-amount="${a}">${escapeHtml(formatMoney(a))}</button>`)
    .join('');

  // Logging while looking at an earlier week lands the entry in that week,
  // matching what the card above is showing.
  $('#amount-hint').textContent =
    weekOffset === 0 ? '' : `Logs into ${store.formatWeekRange(store.weekRange(weekOffset))}.`;

  amountDialog.showModal();
  setTimeout(() => amountForm.amount.focus(), 60);
}

// A chip is a repeat of a known amount, so it commits on one tap rather than
// just filling the box.
$('#amount-quick').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-amount]');
  if (!chip) return;
  amountForm.amount.value = chip.dataset.amount;
  amountForm.requestSubmit();
});

// Cancel and Escape both close without submitting; drop the pending habit so
// it cannot leak into a later sheet.
amountDialog.addEventListener('close', () => { amountId = null; });

amountForm.addEventListener('submit', () => {
  const habit = amountId ? store.getHabit(amountId) : null;
  amountId = null;
  if (!habit) return;

  const amount = Number(new FormData(amountForm).get('amount'));
  if (!Number.isFinite(amount) || amount === 0) return;

  const range = store.weekRange(weekOffset);
  store.addManualEntry(habit.id, amount, weekOffset === 0 ? Date.now() : range.endMs - 1);
  buzz(10);
  render();
  if (detailDialog.open) openDetail(habit.id);
  toast(`Logged ${formatAmount(habit, amount)}`);
});

/* ---------- detail sheet ---------- */

function openDetail(id) {
  detailId = id;
  const habit = store.getHabit(id);
  const range = store.weekRange(weekOffset);
  const used = store.usedInWeek(id, range);

  $('#detail-title').textContent = habit.name;
  $('#detail-summary').textContent =
    `${formatAmount(habit, used)} of ${formatBudget(habit)} used · ${store.formatWeekRange(range)}`;

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
    case 'log-manual': {
      if (habit.kind === 'money') {
        openAmountSheet(habit);
        return;
      }
      const label = habit.kind === 'time' ? 'How many minutes?' : 'How many to add?';
      const input = prompt(label, habit.kind === 'time' ? '30' : '1');
      const amount = Number(input);
      if (!input || !Number.isFinite(amount) || amount === 0) return;
      // Land the entry inside whichever week is on screen.
      const range = store.weekRange(weekOffset);
      const when = weekOffset === 0 ? Date.now() : range.endMs - 1;
      store.addManualEntry(habit.id, amount, when);
      openDetail(habit.id);
      render();
      break;
    }
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

  setInterval(tick, 1000);

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

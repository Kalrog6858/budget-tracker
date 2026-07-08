const STORAGE_KEY = 'moneyRoadMapV4';
const MIN_BUFFER = 200; // keep at least this much in the bank

// ---------- date helpers ----------

function todayISO() {
  const d = new Date();
  return toISO(d);
}

function toISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function fmtRange(start, end) {
  const opts = { month: 'short', day: 'numeric' };
  return start.toLocaleDateString('en-US', opts) + ' – ' + end.toLocaleDateString('en-US', opts);
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatMoney(n) {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
}

// ---------- state ----------

function defaultState() {
  return {
    version: 4,
    settings: {
      planStart: '2026-06-22', // Monday, week 1 of the road map
      goalAmount: 16000,
      goalDate: '2027-06-27',  // Sunday ending week 53 — ~11 months out
      ekubWeekly: 300,
      salaryAmount: 1800,
      uberRate: 30,
      living: { food: 200, entertainment: 100, gas: 100 },
      bills: [
        { name: 'Rent', amount: 1200, rule: 'monthday', day: 1 },
        { name: 'Student loan', amount: 110, rule: 'monthday', day: 1 },
        { name: 'Wi-Fi', amount: 50, rule: 'monthday', day: 1 },
        { name: 'Subscriptions', amount: 30, rule: 'monthday', day: 7 },
        { name: 'Insurance', amount: 240, rule: 'monthday', day: 10 },
        { name: 'Phone bill', amount: 90, rule: 'monthday', day: 13 },
        { name: 'Loan payment', amount: 400, rule: 'monthday', day: 15 },
        { name: 'Gym', amount: 60, rule: 'monthday', day: 18 },
        { name: 'Car payment', amount: 320, rule: 'salary' },
      ],
    },
    balances: { bank: 250, ekub: 600, receivable: 0 },
    events: [
      { id: 'ev1', name: 'Summer vacation', amount: 1500, deadline: '2026-08-22', saved: 200, spent: 0 },
      { id: 'ev2', name: 'Holiday gifts', amount: 800, deadline: '2026-12-18', saved: 0, spent: 0 },
    ],
    checkins: [], // { week, uber, hours, salary, other, spend, ekub, event, eventSpentId, eventSpentAmt, note }
    dailyLogs: [], // { id, date, uber, hours, spend, note }
  };
}

let state = loadState();

function loadState() {
  try {
    const def = defaultState();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw);
    return {
      version: 4,
      settings: Object.assign({}, def.settings, parsed.settings || {}),
      balances: Object.assign({}, def.balances, parsed.balances || {}),
      events: parsed.events || def.events,
      checkins: parsed.checkins || [],
      dailyLogs: parsed.dailyLogs || [],
    };
  } catch (e) {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- week engine ----------

function weekIndexOf(date) {
  const start = parseDate(state.settings.planStart);
  return Math.floor((date - start) / (7 * 24 * 3600 * 1000)) + 1;
}

function weekStart(i) {
  return addDays(parseDate(state.settings.planStart), (i - 1) * 7);
}

function weekEnd(i) {
  return addDays(weekStart(i), 6);
}

function isSalaryWeek(i) {
  return i % 2 === 1; // salary lands in odd weeks (week 3 = Jul 6–12, paid Jul 14, etc.)
}

function weekContainsDay(i, dayOfMonth) {
  const s = weekStart(i);
  for (let d = 0; d < 7; d++) {
    if (addDays(s, d).getDate() === dayOfMonth) return true;
  }
  return false;
}

function billsForWeek(i) {
  return state.settings.bills.filter(b => {
    if (b.rule === 'salary') return isSalaryWeek(i);
    if (b.rule === 'monthday') return weekContainsDay(i, b.day);
    return false;
  });
}

function livingTotal() {
  const l = state.settings.living;
  return (l.food || 0) + (l.entertainment || 0) + (l.gas || 0);
}

function goalWeekIndex() {
  return weekIndexOf(parseDate(state.settings.goalDate));
}

function currentWeekIndex() {
  return weekIndexOf(new Date());
}

// the week the user should check in for: first week after the last completed check-in,
// but never later than the current week
function pendingWeekIndex() {
  const done = state.checkins.map(c => c.week);
  const cur = currentWeekIndex();
  let w = done.length ? Math.max(...done) + 1 : cur;
  return Math.min(w, cur);
}

// the first week the plan should simulate: the week after the last check-in,
// or the current week if the user is up to date / behind. Prevents counting a
// checked-in week twice (once in balances, once in projection).
function planningWeekIndex() {
  const done = state.checkins.map(c => c.week);
  const cur = currentWeekIndex();
  const last = done.length ? Math.max(...done) : 0;
  return last >= cur ? last + 1 : cur;
}

// The rate used everywhere to turn a dollar target into an hours estimate.
// The value you set in Settings is authoritative — change it and the whole
// app (dashboard, daily plan) updates immediately.
function uberRate() {
  return state.settings.uberRate > 0 ? state.settings.uberRate : 30;
}

// What you're actually averaging on your logged trips, for an optional hint.
// Returns null until you've logged at least one trip with hours.
function actualUberRate() {
  const sources = [
    ...state.checkins.filter(c => c.hours > 0 && c.uber > 0),
    ...state.dailyLogs.filter(d => d.hours > 0 && d.uber > 0),
  ];
  const inc = sources.reduce((s, c) => s + c.uber, 0);
  const hrs = sources.reduce((s, c) => s + c.hours, 0);
  return hrs > 0 ? inc / hrs : null;
}

// ---------- daily log helpers ----------

function logsForWeek(w) {
  const s = toISO(weekStart(w));
  const e = toISO(weekEnd(w));
  return state.dailyLogs.filter(d => d.date >= s && d.date <= e);
}

function weekUberSoFar(w) {
  return logsForWeek(w).reduce((s, d) => s + (d.uber || 0), 0);
}

function weekHoursSoFar(w) {
  return logsForWeek(w).reduce((s, d) => s + (d.hours || 0), 0);
}

function weekSpendSoFar(w) {
  return logsForWeek(w).reduce((s, d) => s + (d.spend || 0), 0);
}

function weekWorkSoFar(w) {
  return logsForWeek(w).reduce((s, d) => s + (d.work || 0), 0);
}

// all work expenses not yet folded into a check-in are "pending";
// state.balances.receivable tracks what the boss still owes overall
function unreimbursedTotal() {
  return state.balances.receivable || 0;
}

// days of week w still available for driving; counts today as available
// unless today already has an uber entry
function driveDaysLeft(w) {
  const today = todayISO();
  const end = toISO(weekEnd(w));
  if (today > end) return 0;
  const start = toISO(weekStart(w));
  const from = today < start ? start : today;
  let days = daysBetweenISO(from, end) + 1;
  const todayHasUber = state.dailyLogs.some(d => d.date === today && d.uber > 0);
  if (todayHasUber && days > 0) days -= 1;
  return days;
}

function spendDaysLeft(w) {
  const today = todayISO();
  const end = toISO(weekEnd(w));
  if (today > end) return 0;
  const start = toISO(weekStart(w));
  const from = today < start ? start : today;
  return daysBetweenISO(from, end) + 1;
}

function daysBetweenISO(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / (24 * 3600 * 1000));
}

// ---------- day-level money calendar ----------
// Rent group lands on the 1st, insurance on the 10th, debt plan + phone on the
// 15th, car payment on salary Tuesdays, salary every other Tuesday.

function salaryDateOfWeek(w) {
  return addDays(weekStart(w), 4); // Salary lands Friday; Uber pays Tuesday
}

function isSalaryDay(date) {
  const w = weekIndexOf(date);
  return isSalaryWeek(w) && toISO(date) === toISO(salaryDateOfWeek(w));
}

function billsForDate(date) {
  const dom = date.getDate();
  return state.settings.bills.filter(b => {
    if (b.rule === 'salary') return isSalaryDay(date);
    if (b.rule === 'monthday') return dom === b.day;
    return false;
  });
}

// money events for the next `days` days starting tomorrow
function upcomingMoneyEvents(days) {
  const out = [];
  const today = new Date();
  for (let i = 1; i <= days; i++) {
    const d = addDays(today, i);
    const bills = billsForDate(d);
    const salary = isSalaryDay(d);
    const events = state.events.filter(ev => ev.spent < ev.amount && ev.deadline === toISO(d));
    if (bills.length || salary || events.length) {
      out.push({ date: d, bills, salary, events });
    }
  }
  return out;
}

// events still coming up (not fully spent), sorted by deadline
function upcomingEvents(fromWeek) {
  return state.events
    .filter(ev => ev.spent < ev.amount && weekIndexOf(parseDate(ev.deadline)) >= fromWeek)
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
}

// weekly contribution needed per event, from the perspective of week `fromWeek`
function eventWeeklyNeeds(fromWeek) {
  return upcomingEvents(fromWeek).map(ev => {
    const deadlineWeek = weekIndexOf(parseDate(ev.deadline));
    const weeksLeft = Math.max(deadlineWeek - fromWeek + 1, 1);
    const remaining = Math.max(ev.amount - ev.saved, 0);
    return { ev, deadlineWeek, weekly: remaining / weeksLeft };
  });
}

// Extra weekly savings (on top of the fixed Ekub) needed to actually reach
// the goal amount by the goal date. This is what makes the goal number in
// Settings drive the whole plan: raise the goal and every weekly target
// restructures to cover it.
function goalTopUpWeekly(fromWeek) {
  const endWeek = goalWeekIndex();
  const weeksLeft = Math.max(endWeek - fromWeek + 1, 1);
  const projected = state.balances.ekub + state.settings.ekubWeekly * weeksLeft;
  const shortfall = Math.max(state.settings.goalAmount - projected, 0);
  return shortfall / weeksLeft;
}

// each bill due in week w, with the exact calendar date it lands on
function billDatesForWeek(w) {
  return billsForWeek(w).map(b => {
    let date;
    if (b.rule === 'salary') {
      date = salaryDateOfWeek(w);
    } else {
      const s = weekStart(w);
      for (let d = 0; d < 7; d++) {
        const dd = addDays(s, d);
        if (dd.getDate() === b.day) { date = dd; break; }
      }
    }
    return { bill: b, date: date || weekStart(w) };
  }).sort((a, b) => a.date - b.date);
}

function fmtDay(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Simulate a stretch of weeks with a fixed weekly Uber target.
// Mutates nothing; returns rows plus final balances and the lowest bank point.
function runSim(fromWeek, toWeek, target, startBank, startEkub, evStateIn, topUp = 0) {
  let bank = startBank;
  let ekub = startEkub;
  const evSaved = {}, evSpent = {};
  state.events.forEach(ev => {
    evSaved[ev.id] = evStateIn ? evStateIn.saved[ev.id] : ev.saved;
    evSpent[ev.id] = evStateIn ? evStateIn.spent[ev.id] : ev.spent;
  });

  const rows = [];
  let minBank = bank;
  let minBankWeek = fromWeek;

  for (let w = fromWeek; w <= toWeek; w++) {
    const bills = billsForWeek(w);
    const billTotal = bills.reduce((s, b) => s + b.amount, 0);
    const salary = isSalaryWeek(w) ? state.settings.salaryAmount : 0;

    // event contributions this week: spread each event's remaining need over its remaining weeks
    let eventContrib = 0;
    state.events.forEach(ev => {
      const dw = weekIndexOf(parseDate(ev.deadline));
      if (evSpent[ev.id] >= ev.amount || dw < w) return;
      const weeksLeft = Math.max(dw - w + 1, 1);
      const weekly = Math.max(ev.amount - evSaved[ev.id], 0) / weeksLeft;
      evSaved[ev.id] += weekly;
      eventContrib += weekly;
    });

    // event payouts this week
    const eventNotes = [];
    state.events.forEach(ev => {
      const dw = weekIndexOf(parseDate(ev.deadline));
      if (dw === w && evSpent[ev.id] < ev.amount) {
        const cost = ev.amount - evSpent[ev.id];
        const fromFund = Math.min(evSaved[ev.id], cost);
        evSaved[ev.id] -= fromFund;
        bank -= (cost - fromFund);
        evSpent[ev.id] = ev.amount;
        eventNotes.push(ev.name + ' — ' + formatMoney(cost) + ' from fund');
      }
    });

    ekub += state.settings.ekubWeekly + topUp;
    bank += salary + target - livingTotal() - billTotal - state.settings.ekubWeekly - topUp - eventContrib;

    if (bank < minBank) { minBank = bank; minBankWeek = w; }

    rows.push({
      week: w, start: weekStart(w), end: weekEnd(w),
      salary, bills, billTotal, target, eventNotes,
      eventContrib, savings: state.settings.ekubWeekly + topUp,
      bank, ekub,
      eventFund: Object.keys(evSaved).reduce((s, k) => s + evSaved[k], 0),
    });
  }

  return {
    rows, minBank, minBankWeek,
    bank, ekub,
    evState: { saved: evSaved, spent: evSpent },
  };
}

// Smallest weekly target (rounded up to $10) that keeps the bank above the floor
// for the whole stretch and ends at or above the floor.
function solveTarget(fromWeek, toWeek, startBank, startEkub, evStateIn, floor, topUp) {
  if (fromWeek > toWeek) return 0;
  let lo = 0, hi = 5000;
  const ok = t => {
    const sim = runSim(fromWeek, toWeek, t, startBank, startEkub, evStateIn, topUp);
    return sim.minBank >= floor;
  };
  if (ok(0)) return 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid; else lo = mid;
  }
  return Math.ceil(hi / 10) * 10;
}

// Multi-phase plan: one segment per upcoming event deadline, then a final
// segment to the goal date. Each segment gets the smallest flat Uber target
// that keeps the bank above the floor — so effort naturally steps down as
// events pass.
function computePlan(fromWeek) {
  const endWeek = goalWeekIndex();
  if (fromWeek > endWeek) {
    return { rows: [], segments: [], currentTarget: 0, topUp: 0, minBank: state.balances.bank, minBankWeek: fromWeek, finalEkub: state.balances.ekub, finalBank: state.balances.bank };
  }

  const floor = MIN_BUFFER / 2;
  const topUp = goalTopUpWeekly(fromWeek);
  const boundaries = [...new Set(
    upcomingEvents(fromWeek)
      .map(ev => weekIndexOf(parseDate(ev.deadline)))
      .filter(w => w >= fromWeek && w < endWeek)
  )].sort((a, b) => a - b);
  boundaries.push(endWeek);

  let rows = [], segments = [];
  let minBank = state.balances.bank, minBankWeek = fromWeek;
  let bank = state.balances.bank, ekub = state.balances.ekub, evState = null;
  let segStart = fromWeek;

  boundaries.forEach(segEnd => {
    if (segStart > segEnd) return;
    const target = solveTarget(segStart, segEnd, bank, ekub, evState, floor, topUp);
    const sim = runSim(segStart, segEnd, target, bank, ekub, evState, topUp);
    rows = rows.concat(sim.rows);
    segments.push({ from: segStart, to: segEnd, target });
    if (sim.minBank < minBank) { minBank = sim.minBank; minBankWeek = sim.minBankWeek; }
    bank = sim.bank; ekub = sim.ekub; evState = sim.evState;
    segStart = segEnd + 1;
  });

  return {
    rows, segments, topUp,
    currentTarget: segments.length ? segments[0].target : 0,
    minBank, minBankWeek,
    finalEkub: ekub, finalBank: bank,
  };
}

// ---------- advice ----------

function buildAdvice() {
  const fromWeek = planningWeekIndex();
  const plan = computePlan(fromWeek);
  const rate = uberRate();
  const hours = plan.currentTarget / rate;

  let text = '';

  const weeklySave = state.settings.ekubWeekly + plan.topUp;
  const saveLabel = plan.topUp > 0.5
    ? `${formatMoney(weeklySave)} weekly savings (${formatMoney(state.settings.ekubWeekly)} Ekub + ${formatMoney(plan.topUp)} goal top-up)`
    : `${formatMoney(state.settings.ekubWeekly)} Ekub`;
  text += `Your number this week is ${formatMoney(plan.currentTarget)} on Uber (about ${hours.toFixed(0)} hours at ${formatMoney(rate)}/hr) — remember, what you drive this week lands in your account Tuesday and carries next week. That covers everything — bills, food, your ${saveLabel}, and every event on the calendar. `;

  if (plan.segments.length > 1) {
    const steps = plan.segments.map(s => {
      const evHere = state.events.filter(ev => ev.spent < ev.amount && weekIndexOf(parseDate(ev.deadline)) === s.to);
      const label = evHere.length ? evHere.map(e => e.name).join(' + ') : 'the finish line';
      return `${formatMoney(s.target)}/wk until ${fmtDate(weekEnd(s.to))} (${label})`;
    });
    text += `The full picture: ${steps.join(' → ')}. Each time an event passes, your target drops — it gets easier, not harder. `;
  }

  if (plan.minBank < 0) {
    text += `⚠ Watch out: the week of ${fmtDate(weekStart(plan.minBankWeek))} your bank balance dips to ${formatMoney(plan.minBank)}. Push a little extra Uber before then or shift an event contribution later. `;
  } else if (plan.minBank < MIN_BUFFER) {
    text += `Your tightest week is ${fmtDate(weekStart(plan.minBankWeek))} when the bank drops to ${formatMoney(plan.minBank)} — doable, just don't overspend that week. `;
  } else {
    text += `Your cash never gets dangerously low on this plan — the tightest week still leaves ${formatMoney(plan.minBank)} in the bank. `;
  }

  text += `Projected by ${fmtDate(parseDate(state.settings.goalDate))}: ${formatMoney(plan.finalEkub)} in Ekub plus ${formatMoney(Math.max(plan.finalBank, 0))} in the bank. You've got this — one week at a time.`;

  return { text, plan, rate, hours };
}

// ---------- rendering ----------

function renderDashboard() {
  const goalPct = Math.min(state.balances.ekub / state.settings.goalAmount * 100, 100);
  document.getElementById('goalSaved').textContent = formatMoney(state.balances.ekub);
  document.getElementById('goalTarget').textContent = formatMoney(state.settings.goalAmount);
  document.getElementById('goalDeadline').textContent = parseDate(state.settings.goalDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  document.getElementById('goalPercent').textContent = Math.round(goalPct) + '%';

  const circumference = 2 * Math.PI * 60;
  const ring = document.getElementById('goalRingFg');
  ring.style.strokeDasharray = circumference;
  ring.style.strokeDashoffset = circumference * (1 - goalPct / 100);

  // this week's plan (or next week's, if this week is already checked in)
  const cur = planningWeekIndex();
  const advice = buildAdvice();
  const salary = isSalaryWeek(cur) ? state.settings.salaryAmount : 0;
  const evNeeds = eventWeeklyNeeds(cur);
  const evTotal = evNeeds.reduce((s, n) => s + n.weekly, 0);
  const weeklySave = state.settings.ekubWeekly + advice.plan.topUp;

  document.getElementById('goalCardTitle').textContent = formatMoney(state.settings.goalAmount) + ' Goal (Ekub)';

  let planHtml = `<div class="plan-line"><span>Week ${cur}</span><strong>${fmtRange(weekStart(cur), weekEnd(cur))}</strong></div>`;
  planHtml += `<div class="plan-line"><span>Uber target</span><strong>${formatMoney(advice.plan.currentTarget)}</strong></div>`;
  planHtml += `<div class="plan-line"><span>Salary</span><strong>${salary ? formatMoney(salary) + ' — ' + fmtDay(salaryDateOfWeek(cur)) : 'not this week'}</strong></div>`;
  planHtml += `<div class="plan-line"><span>Savings (goal)</span><strong>${formatMoney(weeklySave)}${advice.plan.topUp > 0.5 ? ' (' + formatMoney(state.settings.ekubWeekly) + ' Ekub + ' + formatMoney(advice.plan.topUp) + ' top-up)' : ''}</strong></div>`;
  planHtml += `<div class="plan-line"><span>Event fund</span><strong>${formatMoney(evTotal)}</strong></div>`;

  // every bill this week, each with its exact date
  const billDates = billDatesForWeek(cur);
  planHtml += `<div class="plan-divider">Bills this week — pay on these days:</div>`;
  if (billDates.length === 0) {
    planHtml += `<div class="plan-line"><span>No bills this week</span><strong>🎉</strong></div>`;
  } else {
    billDates.forEach(bd => {
      planHtml += `<div class="plan-line"><span>${fmtDay(bd.date)}</span><strong>${bd.bill.name} — ${formatMoney(bd.bill.amount)}</strong></div>`;
    });
  }

  // what this week's driving is paying for: Uber money lands next Tuesday
  const nxt = cur + 1;
  const nxtBillDates = billDatesForWeek(nxt);
  const nxtSalary = isSalaryWeek(nxt);
  planHtml += `<div class="plan-divider">This week's driving pays for next week (lands Tuesday):</div>`;
  planHtml += `<div class="plan-line"><span>Next week's bills</span><strong>${nxtBillDates.length ? nxtBillDates.map(bd => bd.bill.name + ' (' + fmtDay(bd.date) + ')').join(', ') : 'none'}</strong></div>`;
  planHtml += `<div class="plan-line"><span>Next week's salary</span><strong>${nxtSalary ? formatMoney(state.settings.salaryAmount) + ' — ' + fmtDay(salaryDateOfWeek(nxt)) : 'none — Uber carries the week'}</strong></div>`;
  document.getElementById('weekPlanBox').innerHTML = planHtml;

  // bank account outlook: what goes in, what comes out, what's left
  const rows = advice.plan.rows;
  let outHtml = `<div class="plan-line"><span>Bank today</span><strong>${formatMoney(state.balances.bank)}</strong></div>`;
  [rows[0], rows[1]].forEach(r => {
    if (!r) return;
    const moneyIn = r.salary + r.target;
    const moneyOut = r.billTotal + livingTotal() + r.savings + r.eventContrib;
    outHtml += `<div class="plan-divider">Week of ${fmtRange(r.start, r.end)}:</div>`;
    outHtml += `<div class="plan-line"><span>Money in</span><strong>${r.salary ? 'Salary ' + formatMoney(r.salary) + ' + ' : ''}Uber ${formatMoney(r.target)} = ${formatMoney(moneyIn)}</strong></div>`;
    outHtml += `<div class="plan-line"><span>Money out</span><strong>Bills ${formatMoney(r.billTotal)} + Living ${formatMoney(livingTotal())} + Savings ${formatMoney(r.savings)} + Events ${formatMoney(r.eventContrib)} = ${formatMoney(moneyOut)}</strong></div>`;
    r.eventNotes.forEach(n => { outHtml += `<div class="plan-line event-due"><span>🎉 Planned spend</span><strong>${n}</strong></div>`; });
    outHtml += `<div class="plan-line highlight"><span>Bank on ${fmtDay(r.end)}</span><strong>${formatMoney(r.bank)}</strong></div>`;
  });
  outHtml += `<div class="plan-divider">To stay on your ${formatMoney(state.settings.goalAmount)} plan, put aside each week:</div>`;
  outHtml += `<div class="plan-line"><span>Into Ekub / savings</span><strong>${formatMoney(weeklySave)}</strong></div>`;
  if (evTotal > 0) {
    outHtml += `<div class="plan-line"><span>Into event fund</span><strong>${formatMoney(evTotal)} (${evNeeds.map(n => n.ev.name + ' ' + formatMoney(n.weekly)).join(', ')})</strong></div>`;
  }
  if (advice.plan.minBank < 0) {
    outHtml += `<p class="warn-note">⚠ On the current plan your bank would dip below zero the week of ${fmtDate(weekStart(advice.plan.minBankWeek))} — raise the Uber target or trim an expense.</p>`;
  }
  document.getElementById('bankOutlookBox').innerHTML = outHtml;

  // event funds
  let evHtml = '';
  if (state.events.length === 0) evHtml = '<div class="empty-note">No events.</div>';
  state.events.forEach(ev => {
    const done = ev.spent >= ev.amount;
    const pct = done ? 100 : Math.min(ev.saved / ev.amount * 100, 100);
    evHtml += `
      <div class="event-fund ${done ? 'event-done' : ''}">
        <div class="event-fund-top">
          <span>${ev.name}${done ? ' ✓ done' : ''}</span>
          <span>${done ? formatMoney(ev.amount) : formatMoney(ev.saved) + ' / ' + formatMoney(ev.amount)}</span>
        </div>
        <div class="fund-bar"><div class="fund-bar-fill" style="width:${pct}%"></div></div>
        <small class="muted">${done ? 'paid' : 'needed by ' + fmtDate(parseDate(ev.deadline))}</small>
      </div>`;
  });
  document.getElementById('eventFundsBox').innerHTML = evHtml;

  document.getElementById('adviceText').textContent = advice.text;
  document.getElementById('bankBalance').textContent = formatMoney(state.balances.bank);
  document.getElementById('dailyGuide').textContent = formatMoney(livingTotal() / 7);
  document.getElementById('uberTargetBig').textContent = formatMoney(advice.plan.currentTarget);
  document.getElementById('uberHoursNote').textContent = '≈ ' + advice.hours.toFixed(0) + ' hours at ' + formatMoney(advice.rate) + '/hr';
  // confirmed receivable + work logs from weeks not yet checked in
  const pw = planningWeekIndex();
  const pendingWork = state.dailyLogs
    .filter(d => d.work > 0 && weekIndexOf(parseDate(d.date)) >= pw)
    .reduce((s, d) => s + d.work, 0);
  document.getElementById('receivableBig').textContent = formatMoney((state.balances.receivable || 0) + pendingWork);
}

function renderDaily() {
  const w = currentWeekIndex();
  const plan = computePlan(planningWeekIndex());
  const target = plan.currentTarget;
  const rate = uberRate();
  const living = livingTotal();

  const earned = weekUberSoFar(w);
  const spent = weekSpendSoFar(w);
  const uberLeft = Math.max(target - earned, 0);
  const spendLeft = living - spent;
  const dDays = driveDaysLeft(w);
  const sDays = spendDaysLeft(w);

  // uber progress
  document.getElementById('uberWeekLabel').textContent = formatMoney(earned) + ' of ' + formatMoney(target);
  document.getElementById('uberWeekPct').textContent = target > 0 ? Math.min(Math.round(earned / target * 100), 100) + '%' : '—';
  document.getElementById('uberWeekBar').style.width = target > 0 ? Math.min(earned / target * 100, 100) + '%' : '0%';
  document.getElementById('uberWeekNote').textContent = uberLeft > 0
    ? formatMoney(uberLeft) + ' left' + (dDays > 0 ? ' → ' + formatMoney(uberLeft / dDays) + '/day (~' + (uberLeft / dDays / rate).toFixed(1) + ' hrs/day) over ' + dDays + (dDays === 1 ? ' day' : ' days') : ' — week is over, it rolls into Sunday’s recalculation')
    : 'Target hit — everything above this is extra cushion.';

  // spending progress
  document.getElementById('spendWeekLabel').textContent = formatMoney(spent) + ' of ' + formatMoney(living);
  document.getElementById('spendWeekPct').textContent = living > 0 ? Math.round(spent / living * 100) + '%' : '—';
  const spendBar = document.getElementById('spendWeekBar');
  spendBar.style.width = living > 0 ? Math.min(spent / living * 100, 100) + '%' : '0%';
  spendBar.classList.toggle('over', spent > living);
  document.getElementById('spendWeekNote').textContent = spendLeft >= 0
    ? formatMoney(spendLeft) + ' left' + (sDays > 0 ? ' → ' + formatMoney(spendLeft / sDays) + '/day for the next ' + sDays + (sDays === 1 ? ' day' : ' days') : '')
    : formatMoney(-spendLeft) + ' over budget — about ' + ((-spendLeft) / rate).toFixed(1) + ' extra Uber hours covers it.';

  // suggestion
  let advice;
  if (state.dailyLogs.length === 0) {
    advice = 'Log what you earn and spend each day and I’ll tell you every evening exactly how much Uber is left for the week and what tomorrow needs to look like.';
  } else if (uberLeft <= 0 && spendLeft >= 0) {
    advice = 'Perfect week so far — Uber target hit and spending under control. Anything more you drive is pure cushion. Enjoy the rest of the week.';
  } else {
    const parts = [];
    if (uberLeft > 0) {
      if (dDays > 0) {
        parts.push(`You need ${formatMoney(uberLeft)} more on Uber this week — that's ${formatMoney(uberLeft / dDays)}/day (about ${(uberLeft / dDays / rate).toFixed(1)} hours each day) over the remaining ${dDays} ${dDays === 1 ? 'day' : 'days'}.`);
      } else {
        parts.push(`This week closed ${formatMoney(uberLeft)} short of the Uber target — don't stress, Sunday's check-in recalculates and spreads it forward.`);
      }
    } else {
      parts.push('Uber target already hit for the week — nice.');
    }
    if (spendLeft < 0) {
      parts.push(`Spending is ${formatMoney(-spendLeft)} over the weekly ${formatMoney(living)} — either pull back the next few days or add ~${((-spendLeft) / rate).toFixed(1)} Uber hours to cover it.`);
    } else if (sDays > 0) {
      parts.push(`You have ${formatMoney(spendLeft)} left to spend — keep it under ${formatMoney(spendLeft / sDays)}/day and you're golden.`);
    }
    advice = parts.join(' ');
  }

  // what tomorrow takes out / brings in
  const tomorrow = addDays(new Date(), 1);
  const tBills = billsForDate(tomorrow);
  const tSalary = isSalaryDay(tomorrow);
  const tLabel = tomorrow.toLocaleDateString('en-US', { weekday: 'long' });
  if (tBills.length) {
    const total = tBills.reduce((s, b) => s + b.amount, 0);
    advice += ` Tomorrow (${tLabel}): ${tBills.map(b => b.name + ' ' + formatMoney(b.amount)).join(' + ')} comes out — make sure ${formatMoney(total)} is sitting in the bank tonight. It's already in the plan, so no stress.`;
  } else {
    advice += ` Tomorrow (${tLabel}): no bills due — just your everyday spending.`;
  }
  if (tSalary) {
    advice += ` And good news: your ${formatMoney(state.settings.salaryAmount)} paycheck lands tomorrow (Friday).`;
  }
  document.getElementById('dailyAdviceText').textContent = advice;

  // coming up — next 7 days
  const comingList = document.getElementById('comingUpList');
  comingList.innerHTML = '';
  const upcoming = upcomingMoneyEvents(7);
  if (upcoming.length === 0) {
    comingList.innerHTML = '<div class="empty-note">Nothing scheduled in the next 7 days — just everyday spending and driving.</div>';
  } else {
    upcoming.forEach(u => {
      const row = document.createElement('div');
      row.className = 'tx-row';
      const day = u.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const outs = u.bills.map(b => b.name + ' ' + formatMoney(b.amount));
      const outTotal = u.bills.reduce((s, b) => s + b.amount, 0);
      const evNames = u.events.map(ev => '🎉 ' + ev.name + ' — paid from its fund');
      row.innerHTML = `
        <div class="tx-left">
          <span class="tx-cat">${day}</span>
          <span class="tx-date">${[...outs, ...(u.salary ? ['Paycheck arrives'] : []), ...evNames].join(' · ')}</span>
        </div>
        <div class="tx-right">
          ${outTotal > 0 ? `<span class="tx-amt expense">-${formatMoney(outTotal)}</span>` : ''}
          ${u.salary ? `<span class="tx-amt income" style="margin-left:10px">+${formatMoney(state.settings.salaryAmount)}</span>` : ''}
        </div>`;
      comingList.appendChild(row);
    });
  }

  // day-by-day list for this week
  const list = document.getElementById('dailyWeekList');
  list.innerHTML = '';
  const logs = logsForWeek(w);
  const today = todayISO();
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart(w), i);
    const iso = toISO(day);
    const dayLogs = logs.filter(d => d.date === iso);
    const uber = dayLogs.reduce((s, d) => s + (d.uber || 0), 0);
    const spend = dayLogs.reduce((s, d) => s + (d.spend || 0), 0);
    const work = dayLogs.reduce((s, d) => s + (d.work || 0), 0);
    const hours = dayLogs.reduce((s, d) => s + (d.hours || 0), 0);
    const notes = dayLogs.map(d => d.note).filter(Boolean).join(', ');
    const row = document.createElement('div');
    row.className = 'tx-row' + (iso === today ? ' today-row' : '');
    const label = day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    row.innerHTML = `
      <div class="tx-left">
        <span class="tx-cat">${label}${iso === today ? ' · today' : ''}</span>
        <span class="tx-date">${dayLogs.length ? (hours ? hours + 'h driven' : '') + (notes ? (hours ? ' · ' : '') + notes : '') || 'logged' : (iso > today ? 'coming up' : 'nothing logged')}</span>
      </div>
      <div class="tx-right">
        ${uber > 0 ? `<span class="tx-amt income">+${formatMoney(uber)}</span>` : ''}
        ${spend > 0 ? `<span class="tx-amt expense" style="margin-left:10px">-${formatMoney(spend)}</span>` : ''}
        ${work > 0 ? `<span class="tx-amt work-amt" style="margin-left:10px" title="refundable work expense">☕ ${formatMoney(work)}</span>` : ''}
        ${dayLogs.length ? `<button class="tx-del" data-date="${iso}" title="Delete this day's entries">&times;</button>` : ''}
      </div>`;
    const del = row.querySelector('.tx-del');
    if (del) {
      del.addEventListener('click', () => {
        state.dailyLogs = state.dailyLogs.filter(d => d.date !== iso);
        saveState();
        renderAll();
      });
    }
    list.appendChild(row);
  }
}

function renderCheckin() {
  const w = pendingWeekIndex();
  const done = state.checkins.some(c => c.week === w);
  document.getElementById('checkinTitle').textContent = 'Sunday Check-in — Week ' + w;
  document.getElementById('checkinSubtitle').textContent =
    fmtRange(weekStart(w), weekEnd(w)) + (done ? ' (already saved — saving again will overwrite it)' : '') +
    '. Fill this in at the end of Sunday.';

  document.getElementById('ciSalary').value = isSalaryWeek(w) ? state.settings.salaryAmount : 0;
  document.getElementById('ciEkub').value = Math.round(state.settings.ekubWeekly + goalTopUpWeekly(w));
  const evTotal = eventWeeklyNeeds(w).reduce((s, n) => s + n.weekly, 0);
  document.getElementById('ciEvent').value = Math.round(evTotal);

  // prefill from daily logs where available
  const loggedUber = weekUberSoFar(w);
  const loggedHours = weekHoursSoFar(w);
  const loggedSpend = weekSpendSoFar(w);
  const loggedWork = weekWorkSoFar(w);
  if (loggedUber > 0) document.getElementById('ciUber').value = Math.round(loggedUber * 100) / 100;
  if (loggedHours > 0) document.getElementById('ciHours').value = Math.round(loggedHours * 10) / 10;
  document.getElementById('ciWork').value = Math.round(loggedWork * 100) / 100;
  document.getElementById('ciReimb').value = 0;

  const bills = billsForWeek(w);
  const billTotal = bills.reduce((s, b) => s + b.amount, 0);
  const expectedSpend = (loggedSpend > 0 ? loggedSpend : livingTotal()) + billTotal;
  document.getElementById('ciSpend').value = Math.round(expectedSpend * 100) / 100;
  document.getElementById('ciSpend').title = (loggedSpend > 0 ? 'Your daily logs ' + formatMoney(loggedSpend) : 'Planned living ' + formatMoney(livingTotal())) + (bills.length ? ' + ' + bills.map(b => b.name).join(', ') : '');

  const sel = document.getElementById('ciEventSelect');
  sel.innerHTML = '<option value="">— none —</option>';
  state.events.filter(ev => ev.spent < ev.amount).forEach(ev => {
    const opt = document.createElement('option');
    opt.value = ev.id;
    opt.textContent = ev.name;
    sel.appendChild(opt);
  });

  // history
  const hist = document.getElementById('checkinHistory');
  hist.innerHTML = '';
  if (state.checkins.length === 0) {
    hist.innerHTML = '<div class="empty-note">No check-ins yet. Your first one is this Sunday.</div>';
  } else {
    [...state.checkins].sort((a, b) => b.week - a.week).forEach(c => {
      const row = document.createElement('div');
      row.className = 'tx-row';
      const income = c.uber + c.salary + c.other + (c.reimb || 0);
      const out = c.spend + c.ekub + c.event + (c.eventSpentAmt || 0) + (c.work || 0);
      row.innerHTML = `
        <div class="tx-left">
          <span class="tx-cat">Week ${c.week} — ${fmtRange(weekStart(c.week), weekEnd(c.week))}</span>
          <span class="tx-date">in ${formatMoney(income)} · out ${formatMoney(out)}${c.note ? ' · ' + c.note : ''}</span>
        </div>
        <div class="tx-right">
          <span class="tx-amt ${income - out >= 0 ? 'income' : 'expense'}">${income - out >= 0 ? '+' : ''}${formatMoney(income - out)}</span>
        </div>`;
      hist.appendChild(row);
    });
  }
}

function renderNextPlan(week) {
  const card = document.getElementById('nextPlanCard');
  card.style.display = 'block';
  const plan = computePlan(week);
  const target = plan.currentTarget;
  const rate = uberRate();
  const bills = billsForWeek(week);
  const salary = isSalaryWeek(week) ? state.settings.salaryAmount : 0;
  const evNeeds = eventWeeklyNeeds(week);
  const evTotal = evNeeds.reduce((s, n) => s + n.weekly, 0);
  const sim = plan;

  let html = `<div class="plan-line"><span>Week ${week}</span><strong>${fmtRange(weekStart(week), weekEnd(week))}</strong></div>`;
  html += `<div class="plan-line highlight"><span>Drive for</span><strong>${formatMoney(target)} on Uber (≈ ${(target / rate).toFixed(0)} hrs)</strong></div>`;
  html += `<div class="plan-line"><span>Salary coming</span><strong>${salary ? formatMoney(salary) + ' — ' + fmtDay(salaryDateOfWeek(week)) : 'no — Uber week'}</strong></div>`;
  const bd = billDatesForWeek(week);
  html += `<div class="plan-line"><span>Bills to pay</span><strong>${bd.length ? bd.map(x => x.bill.name + ' ' + formatMoney(x.bill.amount) + ' (' + fmtDay(x.date) + ')').join(', ') : 'none'}</strong></div>`;
  html += `<div class="plan-line"><span>Live on</span><strong>${formatMoney(livingTotal())} (${formatMoney(livingTotal() / 7)}/day)</strong></div>`;
  html += `<div class="plan-line"><span>Move to Ekub / savings</span><strong>${formatMoney(state.settings.ekubWeekly + plan.topUp)}${plan.topUp > 0.5 ? ' (includes ' + formatMoney(plan.topUp) + ' goal top-up)' : ''}</strong></div>`;
  html += `<div class="plan-line"><span>Expected bank at week's end</span><strong>${plan.rows.length ? formatMoney(plan.rows[0].bank) : '—'}</strong></div>`;
  if (evTotal > 0) {
    html += `<div class="plan-line"><span>Move to event fund</span><strong>${formatMoney(evTotal)} (${evNeeds.map(n => n.ev.name + ' ' + formatMoney(n.weekly)).join(', ')})</strong></div>`;
  }
  const evDue = state.events.filter(ev => ev.spent < ev.amount && weekIndexOf(parseDate(ev.deadline)) === week);
  evDue.forEach(ev => {
    html += `<div class="plan-line event-due"><span>🎉 ${ev.name}</span><strong>spend ${formatMoney(ev.amount)} from the fund — it's planned, enjoy it guilt-free</strong></div>`;
  });
  if (sim.minBank < 0) {
    html += `<p class="warn-note">⚠ Cash gets tight around ${fmtDate(weekStart(sim.minBankWeek))} — a couple of extra Uber hours this week buys you breathing room.</p>`;
  }
  document.getElementById('nextPlanBox').innerHTML = html;
}

function renderRoadmap() {
  const fromWeek = planningWeekIndex();
  const sim = computePlan(fromWeek);
  const tbody = document.querySelector('#roadmapTable tbody');
  tbody.innerHTML = '';
  sim.rows.forEach(r => {
    const tr = document.createElement('tr');
    if (r.eventNotes.length) tr.className = 'row-event';
    if (r.bank < 0) tr.className = 'row-danger';
    tr.innerHTML = `
      <td>${r.week}</td>
      <td>${fmtRange(r.start, r.end)}</td>
      <td>${r.salary ? formatMoney(r.salary) : '—'}</td>
      <td class="bills-cell">${r.bills.length ? r.bills.map(b => b.name).join(', ') : '—'}</td>
      <td>${formatMoney(r.target)}</td>
      <td>${r.eventNotes.join('; ') || '—'}</td>
      <td class="${r.bank < 0 ? 'neg' : ''}">${formatMoney(r.bank)}</td>
      <td>${formatMoney(r.ekub)}</td>
      <td>${formatMoney(r.eventFund)}</td>`;
    tbody.appendChild(tr);
  });
}

function renderSettings() {
  document.getElementById('setBank').value = state.balances.bank;
  document.getElementById('setEkub').value = state.balances.ekub;
  document.getElementById('setReceivable').value = state.balances.receivable || 0;

  const evSavedBox = document.getElementById('setEventSaved');
  evSavedBox.innerHTML = '';
  state.events.filter(ev => ev.spent < ev.amount).forEach(ev => {
    const label = document.createElement('label');
    label.className = 'field';
    label.innerHTML = `<span>${ev.name} fund ($)</span>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.dataset.eventId = ev.id;
    input.value = ev.saved;
    label.appendChild(input);
    evSavedBox.appendChild(label);
  });

  document.getElementById('setGoalAmount').value = state.settings.goalAmount;
  document.getElementById('setGoalDate').value = state.settings.goalDate;
  document.getElementById('setEkubWeekly').value = state.settings.ekubWeekly;
  document.getElementById('setSalary').value = state.settings.salaryAmount;
  document.getElementById('setRate').value = state.settings.uberRate;
  const actual = actualUberRate();
  const hint = document.getElementById('rateHint');
  if (hint) {
    hint.textContent = actual
      ? `On your logged trips so far you're averaging ${formatMoney(actual)}/hr. Set the rate to match if you like — it only changes the “hours” estimate, not how much money you need.`
      : 'This just converts your weekly dollar target into an hours estimate.';
  }
  document.getElementById('setFood').value = state.settings.living.food;
  document.getElementById('setEnt').value = state.settings.living.entertainment;
  document.getElementById('setGas').value = state.settings.living.gas;

  const billInputs = document.getElementById('billInputs');
  billInputs.innerHTML = '';
  state.settings.bills.forEach((b, i) => {
    const label = document.createElement('label');
    const ord = d => d + (d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th');
    const when = b.rule === 'salary' ? 'salary Fridays' : 'the ' + ord(b.day) + ' of the month';
    label.innerHTML = `<span>${b.name} (${when})</span>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.dataset.billIndex = i;
    input.value = b.amount;
    label.appendChild(input);
    billInputs.appendChild(label);
  });

  const evList = document.getElementById('eventList');
  evList.innerHTML = '';
  state.events.forEach(ev => {
    const row = document.createElement('div');
    row.className = 'tx-row';
    row.innerHTML = `
      <div class="tx-left">
        <span class="tx-cat">${ev.name}${ev.spent >= ev.amount ? ' ✓ done' : ''}</span>
        <span class="tx-date">${formatMoney(ev.amount)} by ${fmtDate(parseDate(ev.deadline))} · saved ${formatMoney(ev.saved)}</span>
      </div>
      <div class="tx-right"><button class="tx-del" data-id="${ev.id}" title="Delete">&times;</button></div>`;
    row.querySelector('.tx-del').addEventListener('click', () => {
      state.events = state.events.filter(x => x.id !== ev.id);
      saveState();
      renderAll();
    });
    evList.appendChild(row);
  });
}

function renderAll() {
  renderDashboard();
  renderDaily();
  renderCheckin();
  renderRoadmap();
  renderSettings();
}

// ---------- events ----------

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

document.getElementById('dailyForm').addEventListener('submit', e => {
  e.preventDefault();
  const num = id => parseFloat(document.getElementById(id).value) || 0;
  const date = document.getElementById('dlDate').value;
  const uber = num('dlUber');
  const hours = num('dlHours');
  const spend = num('dlSpend');
  const work = num('dlWork');
  const note = document.getElementById('dlNote').value.trim();
  if (!date || (uber <= 0 && spend <= 0 && hours <= 0 && work <= 0)) return;

  state.dailyLogs.push({
    id: 'dl' + Date.now(),
    date, uber, hours, spend, work,
    note: note || undefined,
  });
  saveState();
  document.getElementById('dailyForm').reset();
  document.getElementById('dlDate').value = todayISO();
  renderAll();
});

document.getElementById('checkinForm').addEventListener('submit', e => {
  e.preventDefault();
  const w = pendingWeekIndex();
  const num = id => parseFloat(document.getElementById(id).value) || 0;

  const entry = {
    week: w,
    uber: num('ciUber'),
    hours: num('ciHours'),
    salary: num('ciSalary'),
    other: num('ciOther'),
    spend: num('ciSpend'),
    ekub: num('ciEkub'),
    event: num('ciEvent'),
    work: num('ciWork'),
    reimb: num('ciReimb'),
    eventSpentId: document.getElementById('ciEventSelect').value || null,
    eventSpentAmt: num('ciEventSpent'),
    note: document.getElementById('ciNote').value.trim(),
    savedAt: todayISO(),
  };

  // if this week was already saved, roll its effects back first so
  // re-saving never double-counts
  const previous = state.checkins.find(c => c.week === w);
  if (previous && previous.before) {
    state.balances = previous.before.balances;
    state.events = previous.before.events;
  }
  entry.before = {
    balances: JSON.parse(JSON.stringify(state.balances)),
    events: JSON.parse(JSON.stringify(state.events)),
  };

  // update balances — work expenses leave the bank now and come back as a
  // receivable until the boss refunds them
  state.balances.bank += entry.uber + entry.salary + entry.other + entry.reimb
    - entry.spend - entry.ekub - entry.event - entry.work;
  state.balances.ekub += entry.ekub;
  state.balances.receivable = Math.max((state.balances.receivable || 0) + entry.work - entry.reimb, 0);

  // distribute event contribution: earliest deadline first
  let remaining = entry.event;
  upcomingEvents(w).forEach(ev => {
    if (remaining <= 0) return;
    const need = Math.max(ev.amount - ev.saved, 0);
    const put = Math.min(need, remaining);
    ev.saved += put;
    remaining -= put;
  });
  if (remaining > 0) state.balances.bank += remaining; // overflow back to bank

  // event spending
  if (entry.eventSpentId && entry.eventSpentAmt > 0) {
    const ev = state.events.find(x => x.id === entry.eventSpentId);
    if (ev) {
      const fromFund = Math.min(ev.saved, entry.eventSpentAmt);
      ev.saved -= fromFund;
      const shortfall = entry.eventSpentAmt - fromFund;
      state.balances.bank -= shortfall;
      ev.spent += entry.eventSpentAmt;
    }
  }

  // overwrite if re-doing the same week
  state.checkins = state.checkins.filter(c => c.week !== w);
  state.checkins.push(entry);
  saveState();

  document.getElementById('checkinForm').reset();
  renderAll();
  renderNextPlan(w + 1);
  document.getElementById('nextPlanCard').scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('saveBalances').addEventListener('click', () => {
  state.balances.bank = parseFloat(document.getElementById('setBank').value) || 0;
  state.balances.ekub = parseFloat(document.getElementById('setEkub').value) || 0;
  state.balances.receivable = parseFloat(document.getElementById('setReceivable').value) || 0;
  document.querySelectorAll('#setEventSaved input').forEach(input => {
    const ev = state.events.find(x => x.id === input.dataset.eventId);
    if (ev) ev.saved = parseFloat(input.value) || 0;
  });
  saveState();
  renderAll();
});

document.getElementById('saveGoal').addEventListener('click', () => {
  state.settings.goalAmount = parseFloat(document.getElementById('setGoalAmount').value) || state.settings.goalAmount;
  state.settings.goalDate = document.getElementById('setGoalDate').value || state.settings.goalDate;
  state.settings.ekubWeekly = parseFloat(document.getElementById('setEkubWeekly').value) || state.settings.ekubWeekly;
  saveState();
  renderAll();
});

document.getElementById('saveIncome').addEventListener('click', () => {
  state.settings.salaryAmount = parseFloat(document.getElementById('setSalary').value) || state.settings.salaryAmount;
  state.settings.uberRate = parseFloat(document.getElementById('setRate').value) || state.settings.uberRate;
  saveState();
  renderAll();
});

document.getElementById('saveLiving').addEventListener('click', () => {
  state.settings.living.food = parseFloat(document.getElementById('setFood').value) || 0;
  state.settings.living.entertainment = parseFloat(document.getElementById('setEnt').value) || 0;
  state.settings.living.gas = parseFloat(document.getElementById('setGas').value) || 0;
  saveState();
  renderAll();
});

document.getElementById('saveBills').addEventListener('click', () => {
  document.querySelectorAll('#billInputs input').forEach(input => {
    const b = state.settings.bills[parseInt(input.dataset.billIndex)];
    if (b) b.amount = parseFloat(input.value) || 0;
  });
  saveState();
  renderAll();
});

document.getElementById('addEvent').addEventListener('click', () => {
  const name = document.getElementById('newEventName').value.trim();
  const amount = parseFloat(document.getElementById('newEventAmount').value);
  const date = document.getElementById('newEventDate').value;
  if (!name || !amount || amount <= 0 || !date) return;
  state.events.push({ id: 'ev' + Date.now(), name, amount, deadline: date, saved: 0, spent: 0 });
  state.events.sort((a, b) => a.deadline.localeCompare(b.deadline));
  document.getElementById('newEventName').value = '';
  document.getElementById('newEventAmount').value = '';
  document.getElementById('newEventDate').value = '';
  saveState();
  renderAll();
});

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'money-road-map-backup-' + todayISO() + '.json';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const def = defaultState();
      state = {
        version: 4,
        settings: Object.assign(def.settings, parsed.settings || {}),
        balances: Object.assign(def.balances, parsed.balances || {}),
        events: parsed.events || def.events,
        checkins: parsed.checkins || [],
        dailyLogs: parsed.dailyLogs || [],
      };
      saveState();
      renderAll();
    } catch (err) {
      alert('Could not read that file as a valid backup.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('resetBtn').addEventListener('click', () => {
  if (confirm('This will delete all check-ins, balances, and settings. Are you sure?')) {
    state = defaultState();
    saveState();
    renderAll();
  }
});

// ---------- init ----------

document.getElementById('dlDate').value = todayISO();
renderAll();

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const APP_DOMAIN = '@w90.app';
const WEEK_COUNT = 16;
const HEBCAL_LAT = 40.7146, HEBCAL_LON = -73.9534;

const state = {
  session: null,
  me: null,          // { id, username }
  profiles: [],      // [{ id, username }]
  absences: [],      // [{ user_id, shabbos }]
  selected: null,
  tab: 'calendar',
};

/* ---------- dates ---------- */
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function labelFor(friday) {
  const sat = new Date(friday); sat.setDate(sat.getDate() + 1);
  const m = MONTHS_SHORT[friday.getMonth()];
  if (sat.getMonth() === friday.getMonth()) return `${m} ${friday.getDate()}-${sat.getDate()}`;
  return `${m} ${friday.getDate()}-${MONTHS_SHORT[sat.getMonth()]} ${sat.getDate()}`;
}
function buildWeeks() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const add = (5 - today.getDay() + 7) % 7; // coming Friday (today if Friday)
  const first = new Date(today); first.setDate(today.getDate() + add);
  const weeks = [];
  for (let i = 0; i < WEEK_COUNT; i++) {
    const f = new Date(first); f.setDate(first.getDate() + i * 7);
    weeks.push({ id: iso(f), label: labelFor(f), candles: null, date: f });
  }
  return weeks;
}
const WEEKS = buildWeeks();
const WEEK_BY_ID = Object.fromEntries(WEEKS.map(w => [w.id, w]));
const TODAY_ID = iso(new Date());

async function loadCandleTimes() {
  try {
    const start = WEEKS[0].id, end = WEEKS[WEEKS.length - 1].id;
    const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&start=${start}&end=${end}&c=on&geo=pos&latitude=${HEBCAL_LAT}&longitude=${HEBCAL_LON}&tzid=America%2FNew_York&maj=off&min=off&nx=off&mf=off&ss=off&mod=off`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    for (const item of data.items || []) {
      if (item.category !== 'candles') continue;
      const day = item.date.slice(0, 10);
      const w = WEEK_BY_ID[day];
      if (w) {
        const m = item.title.match(/Candle lighting: (.+)/);
        if (m) w.candles = m[1].replace(/(\d):(\d{2})(am|pm)/i, (a, h, mm, ap) => `${h}:${mm} ${ap.toUpperCase()}`);
      }
    }
  } catch (e) { /* times are a nicety; skip silently */ }
}

/* ---------- data ---------- */
async function loadData() {
  const [{ data: profiles, error: e1 }, { data: absences, error: e2 }] = await Promise.all([
    supabase.from('profiles').select('id, username'),
    supabase.from('absences').select('user_id, shabbos'),
  ]);
  if (e1 || e2) throw new Error((e1 || e2).message);
  state.profiles = (profiles || []).sort((a, b) => a.username.localeCompare(b.username));
  state.absences = absences || [];
  state.me = state.profiles.find(p => p.id === state.session.user.id) || null;
}

function nameOf(userId) {
  const p = state.profiles.find(p => p.id === userId);
  return p ? p.username : 'Member';
}
function initialsOf(username) {
  const parts = username.trim().split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : (parts[0][1] || ''))).toUpperCase();
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function outIdsFor(weekId) {
  return state.absences.filter(a => a.shabbos === weekId).map(a => a.user_id);
}
function countsFor(weekId) {
  const outs = outIdsFor(weekId);
  return { out: outs.length, in: state.profiles.length - outs.length };
}
function isOut(userId, weekId) {
  return state.absences.some(a => a.shabbos === weekId && a.user_id === userId);
}

/* ---------- actions ---------- */
async function signIn(username, password) {
  const uname = username.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const { error } = await supabase.auth.signInWithPassword({ email: uname + APP_DOMAIN, password });
  return error ? error.message : null;
}
async function toggleAbsence(weekId) {
  const mine = isOut(state.session.user.id, weekId);
  if (mine) {
    const { error } = await supabase.from('absences').delete()
      .eq('user_id', state.session.user.id).eq('shabbos', weekId);
    if (error) return error.message;
    state.absences = state.absences.filter(a => !(a.shabbos === weekId && a.user_id === state.session.user.id));
  } else {
    const { error } = await supabase.from('absences').insert({ user_id: state.session.user.id, shabbos: weekId });
    if (error) return error.message;
    state.absences.push({ user_id: state.session.user.id, shabbos: weekId });
  }
  return null;
}

/* ---------- rendering ---------- */
const app = document.getElementById('app');

function renderSignIn() {
  app.innerHTML = `
    <h1>W90 Shabbos Coverage</h1>
    <p class="sub">Sign in to post the Shabbosim you'll miss and see the whole team's calendar.</p>
    <form class="signin" id="signin-form">
      <label for="username">Username</label>
      <input id="username" autocomplete="username" autocapitalize="none" required>
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" required>
      <div class="error" id="signin-error"></div>
      <button class="btn primary" type="submit" id="signin-btn">Sign in</button>
    </form>`;
  document.getElementById('signin-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('signin-btn');
    const err = document.getElementById('signin-error');
    btn.disabled = true; err.textContent = '';
    const message = await signIn(document.getElementById('username').value, document.getElementById('password').value);
    if (message) {
      err.textContent = message === 'Invalid login credentials' ? 'Wrong username or password.' : message;
      btn.disabled = false;
      return;
    }
    await boot();
  });
}

function weekSumHtml() {
  return `<div class="week-sum">` + WEEKS.map((w, i) => {
    const { out, in: inn } = countsFor(w.id);
    const outNames = outIdsFor(w.id).map(id => id === state.session.user.id ? `${nameOf(id)} (you)` : nameOf(id)).join(', ');
    return `<button type="button" class="week-row${state.selected === w.id ? ' sel' : ''}" data-week="${w.id}">
      <span class="week-dates">${i === 0 ? 'This week &middot; ' : ''}${esc(w.label)}</span>
      <span class="week-counts">${inn} in &middot; ${out} out</span>
      ${out > 0 ? `<span class="week-outs">Out: ${esc(outNames)}</span>` : ''}
    </button>`;
  }).join('') + `</div>`;
}

function detailHtml() {
  const w = WEEK_BY_ID[state.selected];
  const outs = outIdsFor(w.id);
  const onIds = state.profiles.map(p => p.id).filter(id => !outs.includes(id));
  const meOut = outs.includes(state.session.user.id);
  const chip = (id, cls) => `<span class="${cls}">${esc(nameOf(id))}${id === state.session.user.id ? ' (you)' : ''}</span>`;
  return `<div class="detail">
    <div class="detail-head">
      <div>${state.selected === WEEKS[0].id ? '<span class="tag-next">This Shabbos &middot; </span>' : ''}<span class="detail-title">${esc(w.label)}</span></div>
      ${w.candles ? `<div class="candles">Candles ${esc(w.candles)}</div>` : ''}
    </div>
    <div class="split">
      <div>
        <div class="split-label on">ON (${onIds.length})</div>
        <div class="chips">${onIds.length ? onIds.map(id => chip(id, 'chip-on')).join('') : '<span class="note">Nobody yet</span>'}</div>
      </div>
      <div>
        <div class="split-label off">OUT (${outs.length})</div>
        <div class="chips">${outs.length ? outs.map(id => chip(id, 'chip-off')).join('') : '<span class="note">Nobody out</span>'}</div>
      </div>
    </div>
    <div class="detail-action">
      <button type="button" class="btn small ${meOut ? 'selected' : 'primary'}" id="toggle-btn">
        ${meOut ? "You're out - undo" : "I'm missing this Shabbos"}
      </button>
    </div>
  </div>
  <p class="note">Tap any week or Shabbos to see who is on and who is out. Red marks are the guys who are out - everyone else is on.</p>`;
}

function monthsHtml() {
  const first = WEEKS[0].date;
  const last = WEEKS[WEEKS.length - 1].date;
  const months = [];
  let d = new Date(first.getFullYear(), first.getMonth(), 1);
  while (d <= last) { months.push({ y: d.getFullYear(), m: d.getMonth() }); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
  return months.map(({ y, m }) => {
    const firstWeekday = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < firstWeekday; i++) cells.push('<div class="cell blank"></div>');
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(y, m, day);
      const id = iso(date);
      const wd = date.getDay();
      const week = wd === 5 ? WEEK_BY_ID[id] : null;
      const cls = ['cell'];
      if (wd === 5) cls.push('fr');
      if (wd === 6) cls.push('sa');
      if (id === TODAY_ID) cls.push('today');
      if (week && state.selected === id) cls.push('selected');
      if (!week) {
        cells.push(`<div class="${cls.join(' ')}"><span class="daynum">${day}</span></div>`);
        continue;
      }
      const { out, in: inn } = countsFor(id);
      const outChips = outIdsFor(id).map(uid =>
        `<span class="chip-out">${uid === state.session.user.id ? 'YOU' : esc(initialsOf(nameOf(uid)))}</span>`).join('');
      cells.push(`<button type="button" class="${cls.join(' ')}" data-week="${id}" aria-label="Shabbos ${esc(week.label)}, ${out} out">
        <span class="daynum">${day}</span>
        ${out > 0 ? `<span class="out-chips">${outChips}</span>` : ''}
        <span class="onoff">${inn} in &middot; ${out} out</span>
      </button>`);
    }
    return `<div class="cal-month">
      <div class="month-label">${MONTHS_SHORT[m]} ${y}</div>
      <div class="cal-grid">${['Su','Mo','Tu','We','Th','Fr','Sa'].map(x => `<div class="weekday">${x}</div>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
    </div>`;
  }).join('');
}

function calendarTabHtml() {
  return weekSumHtml() + detailHtml() + monthsHtml();
}

function postTabHtml() {
  return `<p class="note">Signed in as ${esc(nameOf(state.session.user.id))}. Tap a Shabbos to mark yourself out; tap again to undo.</p>
  <div class="post-list">` + WEEKS.map(w => {
    const mine = isOut(state.session.user.id, w.id);
    return `<div class="post-row">
      <span class="post-dates">Shabbos ${esc(w.label)}</span>
      <button type="button" class="btn small ${mine ? 'selected' : 'primary'}" data-week="${w.id}">
        ${mine ? "You're out - undo" : "I'm missing this one"}
      </button>
    </div>`;
  }).join('') + `</div>`;
}

function teamTabHtml() {
  return `<div class="post-list">` + state.profiles.map(p => {
    const count = state.absences.filter(a => a.user_id === p.id).length;
    return `<div class="team-row">
      <span class="team-name">${esc(p.username)}${p.id === state.session.user.id ? ' (you)' : ''}</span>
      <span class="team-count${count === 0 ? ' zero' : ''}">${count === 0 ? 'All in' : count + ' off'}</span>
    </div>`;
  }).join('') + `</div>
  <p class="note">Shabbosim each person posted as missing, over the next ${WEEK_COUNT} weeks.</p>`;
}

function render() {
  const tabs = [['calendar', 'Calendar'], ['post', 'Post time off'], ['team', 'Team']];
  app.innerHTML = `
    <h1>W90 Shabbos Coverage</h1>
    <p class="sub">Signed in as ${esc(nameOf(state.session.user.id))} &middot; one shared calendar of who is on and who is out.</p>
    <div class="tabs">${tabs.map(([id, label]) =>
      `<button type="button" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</div>
    <div id="tab-body">${
      state.tab === 'calendar' ? calendarTabHtml() : state.tab === 'post' ? postTabHtml() : teamTabHtml()
    }</div>
    <div class="footer">
      <button type="button" class="btn small ghost" id="signout-btn">Sign out</button>
    </div>`;

  app.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
  app.querySelectorAll('[data-week]').forEach(b => b.addEventListener('click', async () => {
    const weekId = b.dataset.week;
    if (b.classList.contains('week-row') || b.classList.contains('cell')) {
      state.selected = weekId; render();
      document.querySelector('.detail')?.scrollIntoView({ block: 'nearest' });
    }
  }));
  const toggleBtn = document.getElementById('toggle-btn');
  if (toggleBtn) toggleBtn.addEventListener('click', async () => {
    toggleBtn.disabled = true;
    const err = await toggleAbsence(state.selected);
    if (err) alert(err);
    render();
  });
  document.querySelectorAll('.post-row [data-week]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    const err = await toggleAbsence(b.dataset.week);
    if (err) alert(err);
    render();
  }));
  document.getElementById('signout-btn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    state.session = null; state.me = null; state.profiles = []; state.absences = [];
    renderSignIn();
  });
}

/* ---------- boot ---------- */
async function boot() {
  const { data } = await supabase.auth.getSession();
  state.session = data.session;
  if (!state.session) { renderSignIn(); return; }
  app.innerHTML = '<div class="loading">Loading the team calendar...</div>';
  try {
    await loadData();
  } catch (e) {
    app.innerHTML = `<div class="loading">Could not load the calendar: ${esc(e.message)}</div>`;
    return;
  }
  if (!state.selected) state.selected = WEEKS[0].id;
  render();
}

supabase.auth.onAuthStateChange((_event, session) => {
  state.session = session;
  if (!session) renderSignIn();
});

loadCandleTimes().then(() => { if (state.session) render(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();

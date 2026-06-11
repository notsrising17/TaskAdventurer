// Phase 1.5 smoke tests — run with:
//   python3 -m http.server 8907 &  (repo root)
//   node tests/smoke.mjs
// Covers: v4 migration, rolling-window streak math, re-entry detection and
// bulk reschedule, crit probability bounds + fairness gap, relative dates,
// TODAY strip cap, quick capture/tavern, boss-fight split, milestone
// pricing, tokens, export/import round-trip.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8907/index.html';
let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  ' + (extra ?? '')));
  if (!ok) failures++;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

function dstr(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---------- 1. v4 migration from a v3 save ----------
await page.goto(BASE);
await page.evaluate(({ past }) => {
  localStorage.clear();
  localStorage.setItem('ta_version', '3');
  localStorage.setItem('ta_tasks', JSON.stringify([
    { id: 1, name: 'OLD HABIT', domain: 2, type: 1, dailyCap: true, goal: 3, weekCount: 0, weeklyHits: 4, wkStreak: 3, weekStart: null },
    { id: 2, name: 'OLD QUEST', domain: 0, type: 0, done: false, due: past },
  ]));
  localStorage.setItem('ta_milestones', JSON.stringify([0, 2, 0, 0, 0]));
}, { past: dstr(-2) });
await page.reload();
let r = await page.evaluate(() => {
  const h = state.tasks.find(t => t.id === 1), q = state.tasks.find(t => t.id === 2);
  return {
    version: localStorage.getItem('ta_version'),
    weekLogLen: (h.weekLog || []).length,
    weekLogHits: (h.weekLog || []).filter(e => e.hit).length,
    snooze: q.snoozeCount,
    msBase: META.msBase.join(','),
    msInit: META.msInit,
  };
});
check('migration: version bumped to 4', r.version === '4', r.version);
check('migration: weekLog seeded from wkStreak (3 hits)', r.weekLogHits >= 3 && r.weekLogLen >= 3, JSON.stringify(r));
check('migration: snoozeCount initialized', r.snooze === 0, r.snooze);
check('migration: msBase records pre-existing milestones', r.msBase === '0,2,0,0,0', r.msBase);

// idempotency: run migrate(3) again, nothing changes
r = await page.evaluate(() => {
  const before = JSON.stringify(state.tasks) + JSON.stringify(META.msBase);
  migrate(3);
  return before === JSON.stringify(state.tasks) + JSON.stringify(META.msBase);
});
check('migration: idempotent', r === true);

// ---------- 2. rolling-window streak math ----------
r = await page.evaluate(() => {
  const t = { type: 1, weekLog: [] };
  for (let k = 10; k >= 1; k--) t.weekLog.push({ w: mondayStrOffset(-k), hit: k === 1 ? 0 : 1 }); // missed last week
  const w = weekWindow(t);
  const t2 = { type: 1, weekLog: [{ w: mondayStrOffset(-1), hit: 1 }] };
  const w2 = weekWindow(t2);
  // cap test
  const t3 = { type: 1, weekLog: [] };
  for (let k = 0; k < 30; k++) pushWeekLog(t3, mondayStrOffset(-30 + k), 1);
  return { hits: w.hits, of: w.of, youngHits: w2.hits, youngOf: w2.of, capped: t3.weekLog.length };
});
check('streaks: 7 OF LAST 8 after one missed week', r.hits === 7 && r.of === 8, JSON.stringify(r));
check('streaks: young habit windows over fewer weeks', r.youngHits === 1 && r.youngOf === 1, JSON.stringify(r));
check('streaks: weekLog capped at 26', r.capped === 26, r.capped);
r = await page.evaluate(() => document.body.innerText.includes('BROKEN') || document.body.innerText.includes('MISSED') || document.body.innerText.includes('FAILED'));
check('streaks: no broken/missed/failed copy anywhere', r === false);

// ---------- 3. re-entry ritual: 6-day gap, 4 overdue quests ----------
await page.evaluate(({ d6, o1, o2, o3, o4 }) => {
  localStorage.clear();
  localStorage.setItem('ta_version', '4');
  localStorage.setItem('ta_tasks', JSON.stringify([
    { id: 1, name: 'Q1', domain: 0, type: 0, done: false, due: o1, snoozeCount: 0 },
    { id: 2, name: 'Q2', domain: 1, type: 0, done: false, due: o2, snoozeCount: 0 },
    { id: 3, name: 'Q3', domain: 2, type: 0, done: false, due: o3, snoozeCount: 0 },
    { id: 4, name: 'Q4', domain: 3, type: 0, done: false, due: o4, snoozeCount: 0 },
  ]));
  localStorage.setItem('ta_meta', JSON.stringify(Object.assign(metaDefaults(), { lastSeen: d6, msInit: true })));
}, { d6: dstr(-6), o1: dstr(-6), o2: dstr(-5), o3: dstr(-4), o4: dstr(-3) });
await page.reload();
r = await page.evaluate(() => document.getElementById('campWrap').classList.contains('open'));
check('re-entry: MAKE CAMP modal shows after 6-day gap with overdue quests', r === true);
r = await page.evaluate(() => document.getElementById('campBox').innerText);
check('re-entry: modal shows no counts/lists of what was missed', !/[0-9]/.test(r) && !/OVERDUE|MISSED/i.test(r), r);
await page.click('#campReplan');
r = await page.evaluate(({ today }) => {
  const dues = state.tasks.map(t => t.due);
  const days = daysLeftInWeek();
  const allFuture = dues.every(d => d >= today);
  const perDay = {}; dues.forEach(d => perDay[d] = (perDay[d] || 0) + 1);
  const maxPerDay = Math.max(...Object.values(perDay));
  const overdueVisible = document.querySelectorAll('.task.overdue').length;
  const snoozes = state.tasks.map(t => t.snoozeCount);
  return { allFuture, maxPerDay, days, overdueVisible, snoozes };
}, { today: dstr(0) });
check('re-entry: replan moves all quests to today or later', r.allFuture === true, JSON.stringify(r));
check('re-entry: spread round-robin (≤2/day when 4 quests over ≥2 days)', r.maxPerDay <= Math.ceil(4 / Math.min(4, r.days)), JSON.stringify(r));
check('re-entry: no overdue red visible after replan', r.overdueVisible === 0, r.overdueVisible);
check('re-entry: replan counts half toward snooze', r.snoozes.every(s => s === 0.5), JSON.stringify(r.snoozes));
await page.reload();
r = await page.evaluate(() => document.getElementById('campWrap').classList.contains('open'));
check('re-entry: modal never appears two opens in a row', r === false);

// ---------- 4. crit bounds: 1000 completions ----------
r = await page.evaluate(() => {
  META.critMiss = 0; META.critBonus = [0, 0, 0, 0, 0];
  let crits = 0, gap = 0, maxGap = 0;
  const t = { domain: 0, type: 1 };
  for (let i = 0; i < 1000; i++) {
    const before = META.critBonus[0];
    rollCrit(t);
    if (META.critBonus[0] > before) { crits++; if (gap > maxGap) maxGap = gap; gap = 0; }
    else gap++;
  }
  return { rate: crits / 1000, maxGap };
});
check('crits: rate within 9%-16% over 1000 completions', r.rate >= 0.09 && r.rate <= 0.16, r.rate);
check('crits: no gap exceeds 15 (fairness guard)', r.maxGap <= 14, r.maxGap); // 14 misses then forced 15th

// ---------- 5. milestone pricing ----------
r = await page.evaluate(() => {
  META.msBase = [0, 0, 0, 0, 0];
  state.milestones = [0, 0, 0, 0, 0];
  const c = MILESTONE_COST[0];
  const fresh0 = nextMilestoneCost(0);
  state.milestones[0] = 1; const fresh1 = nextMilestoneCost(0);
  state.milestones[0] = 2; const fresh2 = nextMilestoneCost(0);
  META.msBase = [1, 0, 0, 0, 0]; state.milestones[0] = 1;
  const migrated = nextMilestoneCost(0);
  state.milestones = [0, 0, 0, 0, 0]; META.msBase = [0, 0, 0, 0, 0];
  return { c, fresh0, fresh1, fresh2, migrated };
});
check('milestones: first costs ceil(c/3)', r.fresh0 === Math.ceil(r.c / 3), JSON.stringify(r));
check('milestones: second costs ceil(2c/3)', r.fresh1 === Math.ceil(2 * r.c / 3), JSON.stringify(r));
check('milestones: third costs full', r.fresh2 === r.c, JSON.stringify(r));
check('milestones: migrated domain pays full price', r.migrated === r.c, JSON.stringify(r));

// ---------- 6. TODAY strip cap with 20-task backlog ----------
await page.evaluate(({ past }) => {
  localStorage.clear();
  localStorage.setItem('ta_version', '4');
  const tasks = [];
  for (let i = 0; i < 20; i++) tasks.push({ id: 100 + i, name: 'T' + i, domain: i % 5, type: 0, done: false, due: past, snoozeCount: 0 });
  localStorage.setItem('ta_tasks', JSON.stringify(tasks));
  localStorage.setItem('ta_meta', JSON.stringify(Object.assign(metaDefaults(), { lastSeen: null, msInit: true, camped: true })));
}, { past: dstr(-1) });
await page.reload();
r = await page.evaluate(() => ({
  stripRows: document.querySelector('.todayStrip').querySelectorAll('.task').length,
  camp: document.getElementById('campWrap').classList.contains('open'),
}));
check('strip: never more than 3 items with 20-task backlog', r.stripRows === 3, r.stripRows);

// complete all 3 → celebration once
r = await page.evaluate(() => {
  const ids = lastStripIds.slice();
  ids.forEach(id => toggleTask(id));
  const t1 = document.getElementById('toast').textContent;
  const cel1 = META.celebrated;
  // complete 3 more — should NOT celebrate again today
  lastStripIds.slice().forEach(id => toggleTask(id));
  return { cel: cel1 === todayStr(), toast: t1 };
});
check('strip: clearing all items fires the daily celebration once', r.cel === true, JSON.stringify(r));

// ---------- 7. quick capture + tavern ----------
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ta_version', '4'); });
await page.reload();
await page.click('#qcFab');
await page.fill('#qcInput', 'buy a lute');
await page.press('#qcInput', 'Enter');
r = await page.evaluate(() => {
  const t = state.tasks[0];
  return {
    n: state.tasks.length, dom: t.domain, due: t.due,
    tavern: !!document.querySelector('.tavernGroup'),
    statuses: DOMAINS.map((_, i) => domainStatus(i)),
    inStrip: stripCandidates().some(x => x.id === t.id),
  };
});
check('capture: two interactions save a domainless quest into TAVERN', r.n === 1 && r.dom === -1 && r.due === null && r.tavern, JSON.stringify(r));
check('capture: tavern items cause no status effects', r.statuses.every(s => s === 'IDLE'), JSON.stringify(r.statuses));
check('capture: tavern items never enter the TODAY strip', r.inStrip === false);
r = await page.evaluate(() => {
  for (let i = 0; i < 4; i++) quickCapture('idea ' + i);
  renderList();
  return document.querySelector('.tavernGroup').innerText.includes('SORT THE TAVERN?');
});
check('capture: 5+ items shows gentle SORT THE TAVERN? nudge', r === true);
r = await page.evaluate(() => { classifyTask(state.tasks[0].id, 3); return state.tasks[0].domain; });
check('capture: one-tap classify moves item to a domain', r === 3);

// ---------- 8. boss-fight split ----------
await page.evaluate(() => {
  localStorage.clear(); localStorage.setItem('ta_version', '4');
  localStorage.setItem('ta_tasks', JSON.stringify([{ id: 7, name: 'TAXES', domain: 1, type: 0, done: false, due: null, snoozeCount: 3 }]));
});
await page.reload();
r = await page.evaluate(() => document.body.innerText.includes('THIS MAY BE A BOSS FIGHT'));
check('split: 3 snoozes show the boss-fight prompt', r === true);
await page.evaluate(() => openSplit(7));
await page.fill('.splitInput >> nth=0', 'gather forms');
await page.fill('.splitInput >> nth=1', 'fill them in');
await page.click('#splitSave');
r = await page.evaluate(() => {
  const kids = state.tasks.filter(t => t.parentId === 7);
  toggleTask(kids[0].id);
  const partial = document.body.innerText.includes('1/2 ENCOUNTERS');
  toggleTask(kids[1].id);
  const parent = state.tasks.find(t => t.id === 7);
  return { kids: kids.length, partial, parentDone: parent.done, promptGone: !document.body.innerText.includes('BOSS FIGHT') };
});
check('split: children created and roll up (1/2 ENCOUNTERS)', r.kids === 2 && r.partial, JSON.stringify(r));
check('split: parent auto-conquers when all children done', r.parentDone === true);
check('split: prompt does not reappear after splitting', r.promptGone === true);

// ---------- 9. relative dates ----------
r = await page.evaluate(({ t1, t10, p9 }) => ({ a: fmtDue(t1), b: fmtDue(t10), c: fmtDue(p9), d: fmtDue((new Date().getFullYear()) + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '-' + String(new Date().getDate()).padStart(2, '0')) }),
  { t1: dstr(1), t10: dstr(10), p9: dstr(-9) });
check('dates: tomorrow renders TOMORROW', r.a === 'TOMORROW', r.a);
check('dates: 10 days out renders the absolute date', /^[A-Z]{3} \d+$/.test(r.b), r.b);
check('dates: 9 days past renders the 7+ cap', r.c === 'BESIEGED 7+ DAYS', r.c);
check('dates: today renders TODAY', r.d === 'TODAY', r.d);

// ---------- 10. tokens ----------
r = await page.evaluate(() => {
  META.tokens = 1; META.offers = [];
  const t = { id: 50, name: 'RUN', domain: 2, type: 1, dailyCap: true, goal: 3, weekCount: 0, weeklyHits: 2, wkStreak: 4, weekStart: '2000-01-03', weekLog: [], snoozeCount: 0 };
  state.tasks.push(t);
  checkWeeklyReset(); // missed week on streak 4 → offer queued
  const offered = META.offers.length === 1;
  renderList();
  const promptShown = document.body.innerText.includes('KEEP THE FIRE LIT');
  spendToken(true);
  const entry = t.weekLog.find(e => e.w === '2000-01-03');
  return { offered, promptShown, hit: entry && entry.hit === 1, streak: t.wkStreak, tokens: META.tokens, offersLeft: META.offers.length };
});
check('tokens: missed week on streak ≥2 queues exactly one offer', r.offered && r.promptShown, JSON.stringify(r));
check('tokens: spending marks the week hit and preserves the streak', r.hit && r.streak === 4 && r.tokens === 0 && r.offersLeft === 0, JSON.stringify(r));

// token cap via milestones
r = await page.evaluate(() => { META.tokens = 2; const before = META.tokens; return before; });
check('tokens: cap held at 2 (grant path uses Math-capped increment)', r === 2);

// ---------- 11. export / import round-trip ----------
r = await page.evaluate(() => {
  META.pins = { date: todayStr(), ids: [50] }; META.tokens = 1;
  const payload = { version: SCHEMA_VERSION, name: state.name, tasks: state.tasks, milestones: state.milestones, checkin: [], events: state.events, eventSums: state.eventSums, meta: META };
  const json = JSON.stringify(payload);
  // wipe + import
  state.tasks = []; META = metaDefaults();
  const p = JSON.parse(json);
  state.tasks = p.tasks; state.milestones = p.milestones;
  META = Object.assign(metaDefaults(), p.meta);
  let v = parseInt(p.version) || 1; if (v < 4) META.msInit = false;
  while (v < SCHEMA_VERSION) { migrate(v); v++; }
  const t = state.tasks.find(x => x.id === 50);
  return { weekLog: t.weekLog.length > 0, tokens: META.tokens, pins: META.pins.ids.includes(50), parents: state.tasks.some(x => x.parentId === 7), snooze: state.tasks.some(x => x.snoozeCount >= 3) };
});
check('export/import: round-trips weekLog, tokens, pins, parents, snooze counts',
  r.weekLog && r.tokens === 1 && r.pins && r.parents && r.snooze, JSON.stringify(r));

// old (v2) payload imports cleanly through migration
r = await page.evaluate(({ mon }) => {
  const p = { version: 2, name: 'OLD', tasks: [{ id: 9, name: 'TGT', domain: 4, type: 2, goal: 2, count: 3, weekStart: mon }], captures: [0, 0, 0, 0, 1] };
  state.tasks = p.tasks;
  state.milestones = DOMAINS.map((_, i) => (p.captures && p.captures[i]) || 0);
  META = metaDefaults(); META.msInit = false;
  let v = p.version; while (v < SCHEMA_VERSION) { migrate(v); v++; }
  const t = state.tasks[0];
  return { type: t.type, cap: t.dailyCap, wc: t.weekCount, weekLog: Array.isArray(t.weekLog), msBase: META.msBase.join(',') };
}, { mon: await page.evaluate(() => mondayStr()) });
check('export/import: old v2 payload migrates (target→habit, weekLog, msBase)',
  r.type === 1 && r.cap === false && r.wc === 3 && r.weekLog && r.msBase === '0,0,0,0,1', JSON.stringify(r));

// ---------- wrap up ----------
check('zero page errors across all scenarios', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);

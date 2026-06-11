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
check('migration: version bumped to 5', r.version === '5', r.version);
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

// ---------- 4. crit bounds: 5000 completions ----------
r = await page.evaluate(() => {
  META.critMiss = 0;
  EXPEDITION.upgrades.lucky = 0; // base rate
  let crits = 0, gap = 0, maxGap = 0;
  const t = { domain: 0, type: 1 };
  const N = 5000; // larger sample tightens variance so the band check is stable
  for (let i = 0; i < N; i++) {
    if (rollCrit(t)) { crits++; if (gap > maxGap) maxGap = gap; gap = 0; }
    else gap++;
  }
  // Lucky Charm tiers shift the rate but never past the 16% cap
  EXPEDITION.upgrades.lucky = 2;
  const cappedRate = expMods().critRate;
  EXPEDITION.upgrades.lucky = 0;
  return { rate: crits / N, maxGap, cappedRate };
});
check('crits: rate within 9%-16% over 5000 completions', r.rate >= 0.09 && r.rate <= 0.16, r.rate);
check('crits: no gap exceeds 15 (fairness guard)', r.maxGap <= 14, r.maxGap); // 14 misses then forced 15th
check('crits: lucky charm II rate capped at 16%', r.cappedRate <= 0.16, r.cappedRate);

// ---------- 5. expedition league math ----------
r = await page.evaluate(({ thisWeekDue, nextWeekDue }) => {
  EXPEDITION = expDefaults(); EXPEDITION.week = mondayStr(); saveExp();
  const habit = { id: 901, name: 'H', domain: 2, type: 1 };
  const quest = { id: 902, name: 'Q', domain: 1, type: 0, due: null };
  const dueQ = { id: 903, name: 'DQ', domain: 0, type: 0, due: thisWeekDue };
  const lateQ = { id: 904, name: 'LQ', domain: 3, type: 0, due: nextWeekDue };
  const tav = { id: 905, name: 'T', domain: -1, type: 0 };
  const a = earnLeagues(habit, 'habit', false);   // 1
  const b = earnLeagues(quest, 'done', false);    // 2
  const c = earnLeagues(dueQ, 'done', false);     // 3 (punctuality)
  const d = earnLeagues(lateQ, 'done', false);    // 2 (due next week — no bonus)
  const e = earnLeagues(tav, 'done', false);      // 0 (tavern)
  const f = earnLeagues(dueQ, 'done', true);      // 6 (crit doubles)
  const g = earnLeagues(habit, 'habit', true);    // 2 (crit habit)
  return { a, b, c, d, e, f, g, total: EXPEDITION.leagues, leader: EXPEDITION.lastLeader };
}, { thisWeekDue: dstr(0), nextWeekDue: dstr(8) });
check('leagues: habit=1 quest=2 due-this-week=3', r.a === 1 && r.b === 2 && r.c === 3, JSON.stringify(r));
check('leagues: due outside this week earns no punctuality bonus', r.d === 2, r.d);
check('leagues: tavern earns 0', r.e === 0, r.e);
check('leagues: crit doubles the event value (3→6, 1→2)', r.f === 6 && r.g === 2, JSON.stringify(r));
check('leagues: shared counter sums all domains', r.total === 1 + 2 + 3 + 2 + 0 + 6 + 2, r.total);
check('leagues: last earner leads the party', r.leader === 2, r.leader);

// undo refunds exactly what was granted, floor 0
r = await page.evaluate(() => {
  const before = EXPEDITION.leagues;
  const habit = { id: 901, name: 'H', domain: 2, type: 1 };
  const dueQ = { id: 903, name: 'DQ', domain: 0, type: 0, due: todayStr() };
  const r1 = refundLeagues(habit, 'habit'); // pops the crit grant (2)
  const r2 = refundLeagues(dueQ, 'done');   // pops the crit grant (6)
  const r3 = refundLeagues({ id: 999 }, 'done'); // nothing ledgered → 0
  // floor 0: drain everything then refund more
  EXPEDITION.leagues = 0; EXPEDITION.ledger = [{ id: 1, ev: 'done', amt: 5 }];
  refundLeagues({ id: 1 }, 'done');
  return { before, r1, r2, r3, floored: EXPEDITION.leagues };
});
check('leagues: undo refunds the exact ledgered amount (LIFO)', r.r1 === 2 && r.r2 === 6, JSON.stringify(r));
check('leagues: refund without a ledger entry is a no-op', r.r3 === 0, r.r3);
check('leagues: refund floors at 0', r.floored === 0, r.floored);

// completion path integration: toggling a real task moves the expedition
r = await page.evaluate(() => {
  EXPEDITION = expDefaults(); EXPEDITION.week = mondayStr(); saveExp();
  META.critMiss = 0;
  const t = { id: 910, name: 'INTEG', domain: 4, type: 0, done: false, due: null, repeat: 0, snoozeCount: 0 };
  state.tasks.push(t);
  const r0 = EXPEDITION.leagues;
  toggleTask(910); const after = EXPEDITION.leagues;
  toggleTask(910); const undone = EXPEDITION.leagues; // un-complete refunds
  state.tasks = state.tasks.filter(x => x.id !== 910);
  return { r0, gained: after - r0, undone };
});
check('leagues: toggleTask grants ≥2 and un-toggle refunds it', r.gained >= 2 && r.undone === r.r0, JSON.stringify(r));

// ---------- 5b. rollover ceremony ----------
r = await page.evaluate(() => {
  EXPEDITION = expDefaults();
  EXPEDITION.week = mondayStrOffset(-1); // last week
  EXPEDITION.leagues = 27; EXPEDITION.reps = 14; EXPEDITION.gold = 0;
  const fired = checkExpeditionWeek();
  const p = EXPEDITION.pending;
  const second = checkExpeditionWeek(); // same week — must not double-fire
  return { fired, second, p, gold: EXPEDITION.gold, best: EXPEDITION.best, leagues: EXPEDITION.leagues, week: EXPEDITION.week === mondayStr() };
});
check('rollover: fires once on a new week', r.fired === true && r.second === false, JSON.stringify(r));
check('rollover: 27 leagues = 5 landmarks = +15 gold', r.p.landmarks === 5 && r.p.gold === 15 && r.gold === 15, JSON.stringify(r.p));
check('rollover: personal best recorded', r.best === 27, r.best);
check('rollover: route resets (no trailhead = 0)', r.leagues === 0 && r.week === true, JSON.stringify(r));

// rested week: zero reps → quiet copy, no numbers
r = await page.evaluate(() => {
  EXPEDITION = expDefaults();
  EXPEDITION.week = mondayStrOffset(-1); EXPEDITION.leagues = 3; EXPEDITION.reps = 0;
  checkExpeditionWeek();
  maybeShowRollover();
  const txt = document.getElementById('rollBox').innerText;
  const open = document.getElementById('rollWrap').classList.contains('open');
  closeRollover();
  const cleared = EXPEDITION.pending === null;
  return { rested: EXPEDITION.gold === 0, txt, open, cleared };
});
check('rollover: rested week shows THE PARTY RESTED with no numbers', r.open && /PARTY RESTED/.test(r.txt) && !/\d/.test(r.txt), r.txt);
check('rollover: dismiss clears pending (no re-fire on reload)', r.cleared === true);

// trailhead start bonus applies at the next rollover
r = await page.evaluate(() => {
  EXPEDITION = expDefaults();
  EXPEDITION.week = mondayStrOffset(-1); EXPEDITION.leagues = 10; EXPEDITION.reps = 5;
  EXPEDITION.upgrades.trailhead = 1;
  checkExpeditionWeek();
  EXPEDITION.pending = null;
  return EXPEDITION.leagues;
});
check('rollover: trailhead I starts the new run at +3 leagues', r === 3, r);

// pack mule raises landmark gold
r = await page.evaluate(() => {
  EXPEDITION = expDefaults();
  EXPEDITION.week = mondayStrOffset(-1); EXPEDITION.leagues = 10; EXPEDITION.reps = 5;
  EXPEDITION.upgrades.mule = 1;
  checkExpeditionWeek();
  const g = EXPEDITION.pending.gold;
  EXPEDITION.pending = null;
  return g; // 2 landmarks × (3+2)
});
check('rollover: pack mule banks 5 gold per landmark', r === 10, r);

// ---------- 5c. outfitter + v5 migration ----------
r = await page.evaluate(() => {
  EXPEDITION = expDefaults(); EXPEDITION.week = mondayStr(); EXPEDITION.gold = 30;
  META.tokens = 2;
  renderShop();
  const kitFull = document.getElementById('shopList').innerText.includes('POUCH FULL');
  // buy trailhead I (15)
  document.querySelectorAll('#shopList .shopBuy')[0].click();
  const afterBuy = { gold: EXPEDITION.gold, tier: EXPEDITION.upgrades.trailhead };
  return { kitFull, afterBuy };
});
check('outfitter: campfire kit blocked at token cap', r.kitFull === true);
check('outfitter: trailhead I costs 15 and applies', r.afterBuy.gold === 15 && r.afterBuy.tier === 1, JSON.stringify(r.afterBuy));

// v5 migration: legacy milestones convert at 25 gold each; this week's
// completions seed as leagues
await page.goto(BASE);
await page.evaluate(({ mon }) => {
  localStorage.clear();
  localStorage.setItem('ta_version', '4');
  localStorage.setItem('ta_meta', JSON.stringify({ welcomed: true, msInit: true }));
  localStorage.setItem('ta_milestones', JSON.stringify([1, 2, 0, 0, 0]));
  const t = { id: 1, name: 'Q', domain: 0, type: 0, done: true, due: null, snoozeCount: 0 };
  const h = { id: 2, name: 'H', domain: 2, type: 1, dailyCap: true, goal: 3, weekCount: 2, weekStart: mon, weekLog: [], snoozeCount: 0 };
  localStorage.setItem('ta_tasks', JSON.stringify([t, h]));
  const now = Date.now();
  localStorage.setItem('ta_events', JSON.stringify([
    { t: now - 1000, ev: 'done', id: 1, d: 0, k: 0 },
    { t: now - 900, ev: 'habit', id: 2, d: 2, k: 1 },
    { t: now - 800, ev: 'habit', id: 2, d: 2, k: 1 },
  ]));
}, { mon: await page.evaluate(() => mondayStr()) });
await page.reload();
r = await page.evaluate(() => ({
  gold: EXPEDITION.gold, converted: EXPEDITION.converted,
  leagues: EXPEDITION.leagues, reps: EXPEDITION.reps, week: EXPEDITION.week === mondayStr(),
}));
check('v5 migration: 3 milestones convert to 75 gold', r.gold === 75 && r.converted === true, JSON.stringify(r));
check('v5 migration: this week seeds 2+1+1=4 leagues from events', r.leagues === 4 && r.reps === 3, JSON.stringify(r));
check('v5 migration: party ships mid-route, current week set', r.week === true, JSON.stringify(r));
// idempotent: reload again, gold unchanged
await page.reload();
r = await page.evaluate(() => EXPEDITION.gold);
check('v5 migration: conversion is one-time (reload-safe)', r === 75, r);

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
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('ta_version', '4');
  localStorage.setItem('ta_meta', JSON.stringify({ welcomed: true }));
});
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
  localStorage.setItem('ta_meta', JSON.stringify({ welcomed: true }));
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

// ---------- welcome card + sample campaign ----------
await page.goto(BASE);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
r = await page.evaluate(() => ({
  visible: document.getElementById('welcomeWrap').classList.contains('open'),
  welcomed: META.welcomed,
}));
check('welcome: card shown on first run (empty storage)', r.visible, JSON.stringify(r));
check('welcome: welcomed flag still false before choice', !r.welcomed, JSON.stringify(r));

// choose sample campaign
await page.evaluate(() => welcomeSeed());
r = await page.evaluate(() => {
  const doms = [...new Set(state.tasks.map(t => t.domain))];
  return { count: state.tasks.length, welcomed: META.welcomed, visible: document.getElementById('welcomeWrap').classList.contains('open'), uniqueDomains: doms.length };
});
check('welcome: card dismissed after seed', !r.visible, JSON.stringify(r));
check('welcome: welcomed flag set', r.welcomed, JSON.stringify(r));
check('welcome: sample tasks created', r.count >= 5, r.count);
check('welcome: tasks span multiple domains', r.uniqueDomains >= 3, r.uniqueDomains);

// not shown again for existing users
await page.reload();
r = await page.evaluate(() => document.getElementById('welcomeWrap').classList.contains('open'));
check('welcome: not shown again after welcomed=true', !r, r);

// start empty path
await page.goto(BASE);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.evaluate(() => welcomeEmpty());
r = await page.evaluate(() => ({ welcomed: META.welcomed, count: state.tasks.length }));
check('welcome: empty path sets welcomed flag', r.welcomed, JSON.stringify(r));
check('welcome: empty path leaves zero tasks', r.count === 0, r.count);

// ---------- importLines / brain dump ----------
await page.goto(BASE);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
r = await page.evaluate(() => {
  const before = state.tasks.length;
  importLines(['FORGE A SWORD', '', 'TRAIN THE MILITIA', '   ', 'SCOUT THE PASS']);
  return { added: state.tasks.length - before, allTavern: state.tasks.every(t => t.domain === -1) };
});
check('importLines: blanks skipped, correct count added', r.added === 3, r.added);
check('importLines: all land in tavern', r.allTavern, r.allTavern);

// cap at 100
r = await page.evaluate(() => {
  state.tasks = [];
  const lines = Array.from({ length: 150 }, (_, i) => 'TASK ' + i);
  importLines(lines);
  return state.tasks.length;
});
check('importLines: capped at 100 tasks from 150 lines', r === 100, r);

// ---------- captureBar quick capture ----------
await page.goto(BASE);
await page.evaluate(() => { localStorage.clear(); META.welcomed = true; saveMeta(); });
await page.reload();
r = await page.evaluate(() => {
  const inp = document.getElementById('captureInput');
  inp.value = 'LIGHT THE SIGNAL FIRE';
  captureBarSubmit();
  const t = state.tasks[state.tasks.length - 1];
  return { name: t.name, domain: t.domain, input: inp.value };
});
check('captureBar: task created in tavern', r.domain === -1, JSON.stringify(r));
check('captureBar: input cleared after submit', r.input === '', r.input);

// ---------- 12. preset parser ----------
await page.goto(BASE);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ta_meta', JSON.stringify({welcomed:true})); });
await page.reload();

// valid TSV: 5 domains, comma name intact, correct count
r = await page.evaluate(() => {
  const tsv = [
    '# comment line',
    'domain\tgoal\tcap\tsample\tname',
    'work\t3\tyes\tyes\tInbox to zero',
    'health\t4\tyes\tyes\tMove your body 20 minutes',
    'creativity\t4\tyes\tyes\tMake something for 20 minutes',
    'home\t4\tno\tyes\tOne 10-minute tidy burst',
    'social\t3\tno\tyes\tText someone you\'ve been meaning to',
    'home\t2\tno\tno\tOne load of laundry, start to put-away',
  ].join('\n');
  const presets = parsePresetsTSV(tsv);
  const laundry = presets.find(p => p.name === 'One load of laundry, start to put-away');
  return {
    count: presets.length,
    domainNames: [...new Set(presets.map(p => p.domain))].sort(),
    laundryName: laundry ? laundry.name : null,
    capWork: presets.find(p=>p.domain==='work').cap,
    sampleWork: presets.find(p=>p.domain==='work').sample,
  };
});
check('presets: parser returns correct count (6 data rows)', r.count === 6, r.count);
check('presets: comma in name preserved intact (laundry row)', r.laundryName === 'One load of laundry, start to put-away', r.laundryName);
check('presets: all 5 domains parsed', r.domainNames.join(',') === 'creativity,health,home,social,work', r.domainNames);
check('presets: cap and sample parsed correctly', r.capWork === true && r.sampleWork === true, JSON.stringify(r));

// malformed line (4 fields) warns but doesn't kill the rest
r = await page.evaluate(() => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  const tsv = [
    'domain\tgoal\tcap\tsample\tname',
    'work\t3\tyes\tyes\tGood row',
    'work\t3\tyes\tBAD ROW ONLY FOUR FIELDS',  // missing one tab
    'health\t4\tyes\tyes\tAlso good',
  ].join('\n');
  const presets = parsePresetsTSV(tsv);
  console.warn = origWarn;
  return { count: presets.length, warned: warns.some(w => /line 3/.test(w) || /line 4/.test(w)) };
});
check('presets: malformed line warns to console with line number', r.warned === true, JSON.stringify(r));
check('presets: malformed line skipped, valid rows still parse', r.count === 2, r.count);

// unknown domain warns and is skipped
r = await page.evaluate(() => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  const tsv = 'domain\tgoal\tcap\tsample\tname\nunknowndomain\t3\tyes\tno\tShould skip\nwork\t2\tno\tno\tKeep me';
  const presets = parsePresetsTSV(tsv);
  console.warn = origWarn;
  return { count: presets.length, warned: warns.some(w => /unknown.*domain/i.test(w) || /unknowndomain/i.test(w)) };
});
check('presets: unknown domain warns and is skipped', r.warned === true && r.count === 1, JSON.stringify(r));

// domain mapping is by name, not index
r = await page.evaluate(() => {
  // Build TSV with domains in reverse order vs DOMAINS array
  const domainNames = DOMAINS.map(d => d.name||d.cls||'').filter(Boolean);
  const lines = ['domain\tgoal\tcap\tsample\tname'];
  domainNames.forEach((name, i) => lines.push(`${name}\t${i+1}\tno\tno\tTest ${name}`));
  const presets = parsePresetsTSV(lines.join('\n'));
  return presets.every(p => {
    const expectedIdx = DOMAINS.findIndex(d => (d.name||d.cls||'').toLowerCase() === p.domain);
    return p.domainIdx === expectedIdx;
  });
});
check('presets: domain mapped by name not index', r === true, r);

// ---------- 13. preset fallback (offline) ----------
r = await page.evaluate(() => {
  // Simulate fetch failure by temporarily breaking loadPresets
  _presetsCache = null; _presetsLoading = null;
  const origFetch = window.fetch;
  window.fetch = () => Promise.reject(new Error('offline'));
  return loadPresets().then(presets => {
    window.fetch = origFetch;
    _presetsCache = null; _presetsLoading = null;
    const domains = [...new Set(presets.map(p => p.domain))];
    const allSample = presets.every(p => p.sample);
    return { count: presets.length, domains: domains.length, allSample };
  });
});
check('presets: fallback returns one preset per domain (5)', r.count === 5 && r.domains === 5, JSON.stringify(r));
check('presets: fallback presets are all sample:yes', r.allSample === true, r.allSample);

// ---------- 14. sample campaign uses TSV sample:yes rows ----------
await page.goto(BASE);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.evaluate(() => welcomeSeed());
r = await page.evaluate(() => {
  const habits = state.tasks.filter(t => t.type === 1);  // T_HABIT === 1
  const habitDomains = [...new Set(habits.map(t => t.domain))];
  const allHaveGoal = habits.every(t => t.goal > 0);
  const allHaveCap = habits.every(t => typeof t.dailyCap === 'boolean');
  return { habitCount: habits.length, habitDomains: habitDomains.length, allHaveGoal, allHaveCap };
});
check('presets: sample campaign seeds habits from TSV (≥5)', r.habitCount >= 5, r.habitCount);
check('presets: sample habits span all 5 domains', r.habitDomains === 5, r.habitDomains);
check('presets: sample habits have goal and dailyCap from TSV', r.allHaveGoal && r.allHaveCap, JSON.stringify(r));

// with fetch blocked, fallback still seeds one habit per domain
await page.goto(BASE);
await page.evaluate(() => { localStorage.clear(); });
await page.reload();
await page.evaluate(() => {
  _presetsCache = null; _presetsLoading = null;
  const origFetch = window.fetch;
  window.fetch = (url, ...args) => {
    if (typeof url === 'string' && url.includes('presets.tsv')) return Promise.reject(new Error('blocked'));
    return origFetch(url, ...args);
  };
});
await page.evaluate(() => welcomeSeed());
r = await page.evaluate(() => {
  const habits = state.tasks.filter(t => t.type === 1);
  const habitDomains = [...new Set(habits.map(t => t.domain))];
  return { habitCount: habits.length, habitDomains: habitDomains.length };
});
check('presets: offline fallback seeds ≥1 habit per domain (5 domains)', r.habitDomains === 5, JSON.stringify(r));

// ---------- wrap up ----------
check('zero page errors across all scenarios', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);

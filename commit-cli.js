#!/usr/bin/env node
'use strict';
// commit-cli.js — track commitments / promises so nothing falls through the cracks.
//
// A commitment is a thing someone owes a client (or the office owes someone):
// "call Martha back about the tile", "send Lisa the change-order quote",
// "Jorge to pick up the permit Friday". The pain this solves: a busy CEO makes
// dozens of verbal promises a week and loses track of them.
//
// Source of truth is a local JSON ledger (commitments.json). The Telegram bot
// (profile Z) is the primary interface for a non-technical user. A closed-roster
// guard reuses config.json so we never attach a commitment to a client/person
// that isn't already known — the model can suggest, a human confirms.
//
// Usage:
//   commit-cli.js add  --what "..." [--who NAME] [--client "Name"] [--due YYYY-MM-DD|today|tomorrow|+Nd|fri]
//                      [--job N] [--source manual|rq_xxx|field_capture] [--note "..."]
//   commit-cli.js list [--open|--all|--overdue|--done] [--client "Name"] [--who NAME]
//   commit-cli.js show  <n|cm_id>
//   commit-cli.js done  <n|cm_id>
//   commit-cli.js cancel <n|cm_id> [--reason "..."]
//   commit-cli.js overdue            (shorthand for list --overdue)
//
// Indices (n) are 1-based over the CURRENT list view and shift after mutations —
// prefer the cm_ id, or re-run `list`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = '/root/construction-bi-pipeline';
const LEDGER = path.join(DIR, 'commitments.json');
const CONFIG = path.join(DIR, 'config.json');

// ── ledger io ───────────────────────────────────────────────────────────────
function loadLedger() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return []; } }
function saveLedger(l) { fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }

// ── roster ────────────────────────────────────────────────────────────────────
function biz() { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).businesses[0]; }
function clientList() { return (biz().clients || []); }
function peopleList() { return (biz().people || []); }

function norm(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
// closed-roster resolution against a {name}-list. Returns {name} or {error,suggestions}.
function resolveAgainst(list, arg, label) {
  const want = norm(arg);
  if (!want) return { error: `no ${label} name`, suggestions: [] };
  const exact = list.find(c => norm(c.name) === want);
  if (exact) return { name: exact.name };
  // accept a unique prefix/substring match before falling back to fuzzy
  const subs = list.filter(c => norm(c.name).includes(want) || want.includes(norm(c.name)));
  if (subs.length === 1) return { name: subs[0].name };
  const scored = list.map(c => ({ name: c.name, d: lev(norm(c.name), want) })).sort((a, b) => a.d - b.d);
  return { error: `${label} "${arg}" not in roster`, suggestions: scored.slice(0, 3).map(s => s.name) };
}
function resolveClient(arg) { return resolveAgainst(clientList(), arg, 'client'); }
function resolvePerson(arg) { return resolveAgainst(peopleList(), arg, 'person'); }

// ── dates ─────────────────────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().slice(0, 10); }
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
// parse a friendly due date into YYYY-MM-DD (or null). Accepts ISO, today,
// tomorrow, +Nd, or a weekday name (next occurrence).
function parseDue(s) {
  if (!s) return null;
  const t = String(s).trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const base = new Date(todayStr() + 'T00:00:00Z');
  if (t === 'today') return todayStr();
  if (t === 'tomorrow' || t === 'tmrw') { base.setUTCDate(base.getUTCDate() + 1); return base.toISOString().slice(0, 10); }
  let m = t.match(/^\+(\d+)d?$/);
  if (m) { base.setUTCDate(base.getUTCDate() + parseInt(m[1], 10)); return base.toISOString().slice(0, 10); }
  const dk = Object.keys(DOW).find(k => t.startsWith(k));
  if (dk) {
    const target = DOW[dk];
    let delta = (target - base.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7; // "fri" means the upcoming friday, not today
    base.setUTCDate(base.getUTCDate() + delta);
    return base.toISOString().slice(0, 10);
  }
  return null; // unrecognised — caller decides whether to store raw or reject
}
function isOverdue(it) {
  return it.status === 'open' && it.due && it.due < todayStr();
}
function dueLabel(it) {
  if (!it.due) return 'no date';
  const d = it.due, t = todayStr();
  if (it.status !== 'open') return d; // don't shout OVERDUE on done/cancelled
  if (d < t) return `OVERDUE ${d}`;
  if (d === t) return `due today`;
  return `due ${d}`;
}

// ── flags ─────────────────────────────────────────────────────────────────────
function parseFlags(args) {
  const out = { _: [] };
  const bools = new Set(['open', 'all', 'overdue', 'done']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (bools.has(key)) out[key] = true;
      else { out[key] = args[i + 1]; i++; }
    } else out._.push(a);
  }
  return out;
}

// ── selection ─────────────────────────────────────────────────────────────────
// view = the list the user is currently looking at (so 1-based n matches)
function resolveRef(view, ref) {
  if (/^cm_/.test(ref)) return view.findIndex(x => x.id === ref);
  const n = parseInt(ref, 10);
  if (Number.isInteger(n) && n >= 1 && n <= view.length) return n - 1;
  return -1;
}
function defaultView(ledger) {
  return ledger.filter(x => x.status === 'open')
    .sort((a, b) => {
      // overdue first, then by due date (undated last), then created
      const ao = isOverdue(a) ? 0 : 1, bo = isOverdue(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ad = a.due || '9999', bd = b.due || '9999';
      if (ad !== bd) return ad.localeCompare(bd);
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
}

// ── rendering ─────────────────────────────────────────────────────────────────
function fmtLine(it, i) {
  const who = it.who ? `${it.who} → ` : (it.who_raw ? `${it.who_raw}? → ` : '');
  const cl = it.client ? ` · ${it.client}` : '';
  const job = it.job ? ` (job #${it.job})` : '';
  const flag = isOverdue(it) ? '🔴' : (it.due === todayStr() ? '🟡' : '⚪');
  // snoozed tasks are hidden from the card cycler/digests until the date —
  // mark them here so text lists tell the same story.
  const snz = (it.status === 'open' && it.snooze_until && it.snooze_until > todayStr()) ? `  😴 until ${it.snooze_until}` : '';
  return `${i + 1}. ${flag} ${who}${it.what}${cl}${job}  [${dueLabel(it)}]${snz}  \`${it.id}\``;
}

// ── commands ────────────────────────────────────────────────────────────────
function cmdAdd(f) {
  const what = f.what || f._.join(' ').trim();
  if (!what) { console.error('add: need --what "the thing owed"'); process.exit(1); }

  let client = null;
  if (f.client) {
    const r = resolveClient(f.client);
    if (r.error) { console.error(`⚠ ${r.error}. Did you mean: ${r.suggestions.join(', ')}? Re-run with the exact name.`); process.exit(2); }
    client = r.name;
  }
  let who = null;
  if (f.who) {
    const r = resolvePerson(f.who);
    if (r.error) { console.error(`⚠ ${r.error}. Did you mean: ${r.suggestions.join(', ')}? Re-run with the exact name.`); process.exit(2); }
    who = r.name;
  }
  let due = null;
  if (f.due) {
    due = parseDue(f.due);
    if (!due) { console.error(`⚠ couldn't read due date "${f.due}". Use YYYY-MM-DD, today, tomorrow, +3d, or a weekday.`); process.exit(2); }
  }

  const item = {
    id: 'cm_' + crypto.randomBytes(5).toString('hex'),
    created_at: new Date().toISOString(),
    who, what, client,
    job: f.job ? parseInt(f.job, 10) : null,
    due,
    source: f.source || 'manual',
    status: 'open',
    done_at: null,
    note: f.note || null,
  };
  const l = loadLedger();
  l.push(item);
  saveLedger(l);
  console.log(`✅ Logged commitment \`${item.id}\`:`);
  console.log('   ' + fmtLine(item, 0).replace(/^1\. /, ''));
}

function cmdList(f, forcedFilter) {
  const l = loadLedger();
  const filter = forcedFilter || (f.overdue ? 'overdue' : f.all ? 'all' : f.done ? 'done' : 'open');
  let view;
  if (filter === 'all') view = l.slice();
  else if (filter === 'done') view = l.filter(x => x.status === 'done');
  else if (filter === 'overdue') view = l.filter(isOverdue);
  else view = defaultView(l); // open

  if (f.client) { const r = resolveClient(f.client); const nm = r.name || f.client; view = view.filter(x => x.client && norm(x.client) === norm(nm)); }
  if (f.who) { const r = resolvePerson(f.who); const nm = r.name || f.who; view = view.filter(x => x.who && norm(x.who) === norm(nm)); }

  if (filter === 'open' || filter === 'overdue') {
    view.sort((a, b) => {
      const ao = isOverdue(a) ? 0 : 1, bo = isOverdue(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return (a.due || '9999').localeCompare(b.due || '9999');
    });
  }

  const titles = { open: 'Open commitments', overdue: 'Overdue commitments', all: 'All commitments', done: 'Completed commitments' };
  if (!view.length) { console.log(`✅ ${titles[filter]}: none.`); return view; }
  const nOver = view.filter(isOverdue).length;
  console.log(`📌 ${titles[filter]} (${view.length}${nOver ? `, ${nOver} overdue` : ''}):`);
  view.forEach((it, i) => {
    let line = fmtLine(it, i);
    if (filter === 'all' || filter === 'done') line += `  <${it.status}>`;
    console.log('  ' + line);
  });
  return view;
}

function cmdShow(f) {
  const ref = f._[0];
  if (!ref) { console.error('show: need <n|cm_id>'); process.exit(1); }
  const l = loadLedger();
  const view = defaultView(l);
  let idx = resolveRef(view, ref);
  let item = idx >= 0 ? view[idx] : null;
  if (!item && /^cm_/.test(ref)) item = l.find(x => x.id === ref) || null;
  if (!item) { console.error(`show: "${ref}" not found in current open list — use the cm_ id.`); process.exit(1); }
  console.log(JSON.stringify(item, null, 2));
}

function mutate(f, fn, label) {
  const ref = f._[0];
  if (!ref) { console.error(`${label}: need <n|cm_id>`); process.exit(1); }
  const l = loadLedger();
  const view = defaultView(l);
  let item = null;
  const idx = resolveRef(view, ref);
  if (idx >= 0) item = view[idx];
  else if (/^cm_/.test(ref)) item = l.find(x => x.id === ref) || null;
  if (!item) { console.error(`${label}: "${ref}" not found — re-run \`list\` or use the cm_ id.`); process.exit(1); }
  fn(item);
  saveLedger(l);
  return item;
}

function cmdDone(f) {
  const it = mutate(f, (item) => {
    item.status = 'done'; item.done_at = new Date().toISOString();
    if (f.by) item.completed_by = resolvePersonLenientName(f.by);
    if (f.note) item.note = (item.note ? item.note + ' | ' : '') + f.note;
  }, 'done');
  console.log(`✅ Marked done${it.completed_by ? ' by ' + it.completed_by : ''}: ${it.what}${it.client ? ' · ' + it.client : ''}  \`${it.id}\``);
}
function cmdCancel(f) {
  const it = mutate(f, (item) => { item.status = 'cancelled'; item.done_at = new Date().toISOString(); if (f.reason) item.note = (item.note ? item.note + ' | ' : '') + 'cancelled: ' + f.reason; }, 'cancel');
  console.log(`🗑  Cancelled: ${it.what}  \`${it.id}\``);
}

// lenient person resolution for operator names coming from Telegram first_name —
// resolve to the roster name when it matches, otherwise keep the raw string
// (an unknown operator should never block marking a task done).
function resolvePersonLenientName(arg) {
  const r = resolvePerson(arg);
  return r.name || String(arg).trim();
}

function cmdDelegate(f) {
  if (!f.to) { console.error('delegate: need --to NAME'); process.exit(1); }
  const r = resolvePerson(f.to);
  if (r.error) { console.error(`⚠ ${r.error}. Did you mean: ${r.suggestions.join(', ')}?`); process.exit(2); }
  const it = mutate(f, (item) => { item.delegated_to = r.name; }, 'delegate');
  console.log(`👤 Delegated to ${r.name}: ${it.what}  \`${it.id}\``);
}

function cmdSnooze(f) {
  const until = parseDue(f.until);
  if (!until) { console.error('snooze: need --until today|tomorrow|+3d|fri|YYYY-MM-DD'); process.exit(1); }
  const it = mutate(f, (item) => { item.snooze_until = until; }, 'snooze');
  console.log(`😴 Snoozed until ${until}: ${it.what}  \`${it.id}\``);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks card cycler — JSON render payloads consumed by the review-buttons
// Hermes plugin (tk:* callbacks), same contract as review-cli.js's rq:* cards:
// {ok, empty?, parse_mode, text, reply_markup, answer?, id?}. These commands
// only render/navigate or mutate LOCAL ledger fields (done/delegate/snooze) —
// no external system is written. Stateless: the active filter rides in
// callback_data as a 1-char code (a=open, o=overdue, m=mine).
// ─────────────────────────────────────────────────────────────────────────────
const TFILTER_LABELS = { a: 'open', o: 'overdue', m: 'mine' };
function tfcode(c) { return TFILTER_LABELS[c] ? c : 'a'; }
function outJSON(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function tclean(s, max) {
  let t = String(s == null ? '' : s).replace(/[`*_\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}
// person ≈ operator match, lenient both ways ("Jorge" vs "Jorge Cruz")
function isPerson(name, op) {
  const a = norm(name), b = norm(op);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}
function taskMatchesFilter(it, code, op) {
  if (code === 'o') return isOverdue(it);
  if (code === 'm') return isPerson(it.delegated_to || it.who || '', op || '');
  return true; // 'a' = all open
}
// Cycler order: 'urgency' (default — overdue first, then due date) or 'client'
// (group a client's tasks together; the client with the most urgent task comes
// first, within each client overdue-first). Config: businesses[0].telegram_ui.tasks.sort
function tasksSortMode() {
  try { return (((biz().telegram_ui || {}).tasks || {}).sort) === 'client' ? 'client' : 'urgency'; }
  catch { return 'urgency'; }
}
// Lower sorts first: overdue ahead of not, then due date asc (undated last), then created.
function urgencyKey(it) {
  return `${isOverdue(it) ? 0 : 1}|${it.due || '9999-99-99'}|${String(it.created_at || '')}`;
}
// Re-order an already urgency-sorted list into client groups, each group placed
// by its most-urgent task; clientless tasks last.
function groupByClient(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.client ? norm(it.client) : '~~none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const arr of groups.values()) arr.sort((a, b) => urgencyKey(a).localeCompare(urgencyKey(b)));
  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[0] === '~~none') return 1;
    if (b[0] === '~~none') return -1;
    const ak = urgencyKey(a[1][0]), bk = urgencyKey(b[1][0]);
    return ak !== bk ? ak.localeCompare(bk) : a[0].localeCompare(b[0]);
  });
  return ordered.flatMap(([, arr]) => arr);
}
// Open tasks for the cycler: open status, snoozes respected, then sorted.
function cyclerView(ledger, code, op) {
  const t = todayStr();
  const items = defaultView(ledger)
    .filter(it => !it.snooze_until || it.snooze_until <= t)
    .filter(it => taskMatchesFilter(it, code, op));
  return tasksSortMode() === 'client' ? groupByClient(items) : items;
}

function taskCardText(it, i, n, code) {
  const L = [];
  L.push(`*Task ${i + 1} of ${n}*${code !== 'a' ? ` · _${TFILTER_LABELS[code]}_` : ''}`);
  const flag = isOverdue(it) ? '🔴' : (it.due === todayStr() ? '🟡' : '⚪');
  L.push(`${flag} ${tclean(dueLabel(it), 24)}`);
  L.push('');
  const owner = it.delegated_to || it.who;
  L.push(`${owner ? `*${tclean(owner, 30)}* → ` : ''}${tclean(it.what, 160)}`);
  if (it.delegated_to && it.who && it.delegated_to !== it.who) L.push(`_(delegated from ${tclean(it.who, 30)})_`);
  if (it.client) L.push(`Client: ${tclean(it.client, 40)}${it.job ? ` · job #${it.job}` : ''}`);
  if (it.note) L.push(`Note: ${tclean(it.note, 120)}`);
  L.push(`Created ${String(it.created_at || '').slice(0, 10) || '?'}${it.source && it.source !== 'manual' ? ` · from ${tclean(it.source, 20)}` : ''}`);
  return L.join('\n');
}
function taskNavRow(it, i, n, code) {
  return [
    { text: i > 0 ? '◀' : '·', callback_data: i > 0 ? `tk:prev:${code}:${it.id}` : 'tk:noop' },
    { text: `${i + 1}/${n}`, callback_data: 'tk:noop' },
    { text: i < n - 1 ? '▶' : '·', callback_data: i < n - 1 ? `tk:next:${code}:${it.id}` : 'tk:noop' },
  ];
}
function taskCardKeyboard(it, i, n, code) {
  return { inline_keyboard: [
    [
      { text: '✅ Done', callback_data: `tk:done:${code}:${it.id}` },
      { text: '👤 Delegate', callback_data: `tk:dl:${code}:${it.id}` },
      { text: '😴 Snooze', callback_data: `tk:sn:${code}:${it.id}` },
    ],
    [
      { text: '✉️ Email', callback_data: `tk:em:${code}:${it.id}` },
      { text: '🏠 Client', callback_data: `tk:cl:${code}:${it.id}` },
      { text: '🗑 Dismiss', callback_data: `tk:del:${code}:${it.id}` },
    ],
    [
      { text: '⏭ Skip', callback_data: `tk:skip:${code}:${it.id}` },
      { text: '🔽 Filter', callback_data: `tk:flt:${code}:${it.id}` },
    ],
    taskNavRow(it, i, n, code),
  ] };
}
function taskEmptyPayload(ledger, code) {
  const t = todayStr();
  const doneToday = ledger.filter(x => x.status === 'done' && String(x.done_at || '').slice(0, 10) === t).length;
  const snoozed = ledger.filter(x => x.status === 'open' && x.snooze_until && x.snooze_until > t).length;
  const bits = [`${doneToday} done today`];
  if (snoozed) bits.push(`${snoozed} snoozed`);
  const label = code !== 'a' ? `No *${TFILTER_LABELS[code]}* tasks` : '🎉 *No open tasks.*';
  return { ok: true, empty: true, parse_mode: 'Markdown', reply_markup: null,
    text: `${label} — ${bits.join(', ')}.` };
}

function taskCardPayload(at, move, code, op) {
  code = tfcode(code);
  const l = loadLedger();
  const list = cyclerView(l, code, op);
  if (!list.length) return taskEmptyPayload(l, code);
  let idx, answer = null;
  if (!at || at === 'first') idx = 0;
  else {
    let pos = list.findIndex(x => x.id === at);
    if (pos < 0) {
      // item just acted on / filtered out → land on the next by due-order
      const orig = l.find(x => x.id === at);
      const after = orig ? list.findIndex(x => (x.due || '9999') >= (orig.due || '9999') && x.id !== at) : -1;
      idx = after >= 0 ? after : Math.max(0, list.length - 1);
      move = 'here';
    } else idx = pos;
  }
  if (move === 'next') { if (idx < list.length - 1) idx++; else answer = 'End of list.'; }
  else if (move === 'prev') { if (idx > 0) idx--; else answer = 'Start of list.'; }
  const it = list[idx];
  const pay = { ok: true, empty: false, parse_mode: 'Markdown', id: it.id,
    text: taskCardText(it, idx, list.length, code), reply_markup: taskCardKeyboard(it, idx, list.length, code) };
  if (answer) pay.answer = answer;
  return pay;
}

function taskFilterMenuPayload(id, code) {
  code = tfcode(code);
  const opt = (lbl, c) => ([{ text: (c === code ? '● ' : '') + lbl, callback_data: `tk:setf:${c}:${id}` }]);
  return { ok: true, parse_mode: 'Markdown', text: '*Filter tasks:*', reply_markup: { inline_keyboard: [
    opt('All open', 'a'), opt('Overdue', 'o'), opt('Mine', 'm'),
    [{ text: '⬅ Back', callback_data: `tk:card:${code}:${id}` }],
  ] } };
}

function snoozeMenuPayload(id, code) {
  code = tfcode(code);
  const opt = (lbl, days) => ({ text: lbl, callback_data: `tk:sx:${code}:${days}:${id}` });
  return { ok: true, parse_mode: 'Markdown', text: '*Snooze until when?*', reply_markup: { inline_keyboard: [
    [opt('Tomorrow', 1), opt('+3 days', 3)],
    [opt('Next week', 7), { text: '⬅ Back', callback_data: `tk:card:${code}:${id}` }],
  ] } };
}

// Who can a task be delegated TO — the operator team, not the whole people
// roster (subs/suppliers don't run the bots). Config-driven:
// businesses[0].telegram_ui.tasks.delegates = [{name, profile}], where profile
// is the Hermes profile whose bot gets the "new task for you" ping. Falls back
// to the leaderboard operators (no ping target known).
function delegateList() {
  const d = ((uiCfg().tasks || {}).delegates);
  if (Array.isArray(d) && d.length) {
    return d.map(x => (typeof x === 'string' ? { name: x } : x)).filter(x => x && x.name);
  }
  return operatorList().map(name => ({ name }));
}

// Fix a task's client (closed roster). For legacy tasks mis-attributed before
// §A split multi-client recordings into per-client segments.
function clientPickerPayload(id, code, page) {
  code = tfcode(code);
  const list = clientList();
  const PER = 8;
  const pages = Math.max(1, Math.ceil(list.length / PER));
  const p = Math.min(Math.max(0, parseInt(page, 10) || 0), pages - 1);
  const slice = list.slice(p * PER, p * PER + PER);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map(c => ({ text: tclean(c.name, 24), callback_data: `tk:xc:${code}:${list.indexOf(c)}:${id}` })));
  }
  const navrow = [];
  if (p > 0) navrow.push({ text: '◀', callback_data: `tk:pc:${code}:${p - 1}:${id}` });
  navrow.push({ text: '⬅ Back', callback_data: `tk:card:${code}:${id}` });
  if (p < pages - 1) navrow.push({ text: '▶', callback_data: `tk:pc:${code}:${p + 1}:${id}` });
  rows.push(navrow);
  return { ok: true, parse_mode: 'Markdown', text: 'Fix the *client* for this task:', reply_markup: { inline_keyboard: rows } };
}

function delegatePickerPayload(id, code, page) {
  code = tfcode(code);
  const list = delegateList();
  const PER = 8;
  const pages = Math.max(1, Math.ceil(list.length / PER));
  const p = Math.min(Math.max(0, parseInt(page, 10) || 0), pages - 1);
  const slice = list.slice(p * PER, p * PER + PER);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map(c => ({ text: tclean(c.name, 24), callback_data: `tk:xd:${code}:${list.indexOf(c)}:${id}` })));
  }
  const navrow = [];
  if (p > 0) navrow.push({ text: '◀', callback_data: `tk:pd:${code}:${p - 1}:${id}` });
  navrow.push({ text: '⬅ Back', callback_data: `tk:card:${code}:${id}` });
  if (p < pages - 1) navrow.push({ text: '▶', callback_data: `tk:pd:${code}:${p + 1}:${id}` });
  rows.push(navrow);
  return { ok: true, parse_mode: 'Markdown', text: 'Delegate to *whom*?', reply_markup: { inline_keyboard: rows } };
}

// Ping the delegate's own bot: a DM in their home channel with the task and an
// Open button (their gateway runs the same plugin + shared ledger, so the
// button opens the live card). Best-effort — a failed ping never blocks the
// delegation itself.
async function pingDelegate(delegate, it, by) {
  if (!delegate.profile) return false;
  const envPath = `/root/.hermes/profiles/${delegate.profile}/.env`;
  const env = fs.readFileSync(envPath, 'utf8');
  const token = (env.match(/TELEGRAM_BOT_TOKEN\s*=\s*(.+)/) || [])[1];
  const chat = (env.match(/TELEGRAM_HOME_CHANNEL\s*=\s*(.+)/) || [])[1];
  if (!token || !chat) return false;
  const L = [`👤 *New task for you* — delegated by ${tclean(by || 'the office', 30)}`, ''];
  L.push(`${tclean(it.what, 120)}${it.client ? ` · ${tclean(it.client, 40)}` : ''}`);
  L.push(tclean(dueLabel(it), 30));
  await require('axios').post(`https://api.telegram.org/bot${token.trim()}/sendMessage`, {
    chat_id: chat.trim(),
    text: L.join('\n'),
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '📂 Open task', callback_data: `tk:card:a:${it.id}` }]] },
  }, { timeout: 10000 });
  return true;
}

// Find an OPEN ledger item by cm_ id (cycler actions never touch done/cancelled).
function openItem(l, id) {
  const it = l.find(x => x.id === id);
  return it && it.status === 'open' ? it : null;
}
// The card to land on after the current item leaves the cycler view (Done /
// Dismiss / Snooze). Computed from the CURRENT view, BEFORE the mutation, so we
// advance to the genuine next card by the cycler's own order — never bounce to
// the first card (which happened when due-date fallback matched index 0).
// Returns 'first' only when the acted-on item was the last one in the view.
function nextIdAfter(view, id) {
  const pos = view.findIndex(x => x.id === id);
  if (pos < 0) return null;
  if (pos < view.length - 1) return view[pos + 1].id; // the next card forward
  if (pos > 0) return view[pos - 1].id;                // was last → step back
  return null;                                         // was the only card
}
function staleCardPayload(id, code, op) {
  const pay = taskCardPayload(id, 'here', code, op);
  pay.answer = 'Task already closed.';
  return pay;
}

function cmdTaskDone(f) {
  const l = loadLedger();
  const it = openItem(l, f.id);
  if (!it) { outJSON(staleCardPayload(f.id, f.f, f.op)); return; }
  const code = tfcode(f.f);
  const nextId = nextIdAfter(cyclerView(l, code, f.op), it.id);
  it.status = 'done'; it.done_at = new Date().toISOString();
  if (f.by) it.completed_by = resolvePersonLenientName(f.by);
  saveLedger(l);
  const pay = taskCardPayload(nextId || 'first', 'here', code, f.op);
  pay.answer = `✅ Done${it.completed_by ? ' — ' + it.completed_by : ''}`;
  outJSON(pay);
}
async function cmdTaskDelegate(f) {
  const l = loadLedger();
  const it = openItem(l, f.id);
  if (!it) { outJSON(staleCardPayload(f.id, f.f, f.op)); return; }
  const d = delegateList()[parseInt(f.person, 10)];
  if (!d) { outJSON({ ok: false, parse_mode: 'Markdown', text: '❌ Bad selection.', answer: 'Bad selection' }); return; }
  // store the canonical roster name when it resolves (keeps "mine" matching
  // and the Register consistent), else the configured delegate name as-is
  it.delegated_to = resolvePersonLenientName(d.name);
  if (f.by) it.delegated_by = resolvePersonLenientName(f.by);
  saveLedger(l);
  let pinged = false;
  try { pinged = await pingDelegate(d, it, f.by); }
  catch { pinged = false; }
  const pay = taskCardPayload(it.id, 'here', tfcode(f.f), f.op);
  pay.answer = `👤 Delegated to ${d.name}${pinged ? ' — bot notified' : ''}`;
  outJSON(pay);
}
// ── home / register / leaderboard (Phase 3) ──────────────────────────────────
const ARCHIVE = path.join(DIR, 'leaderboard-archive.json');

// optional per-deployment UI config: businesses[0].telegram_ui.tasks.default_filter
function uiCfg() {
  try { return biz().telegram_ui || {}; } catch { return {}; }
}

// The Tasks "home" message: summary + entry buttons. Also what tk:home renders
// in place, so Back from Register/Leaderboard always lands somewhere sane.
function homePayload() {
  const t = todayStr();
  const l = loadLedger();
  const open = l.filter(x => x.status === 'open' && (!x.snooze_until || x.snooze_until <= t));
  const overdue = open.filter(isOverdue);
  const dueToday = open.filter(x => x.due === t);
  const snoozed = l.filter(x => x.status === 'open' && x.snooze_until && x.snooze_until > t);
  const doneToday = l.filter(x => x.status === 'done' && String(x.done_at || '').slice(0, 10) === t);
  const lines = ['📌 *Tasks*', ''];
  lines.push(`Open: *${open.length}*${overdue.length ? ` · 🔴 overdue: *${overdue.length}*` : ''}${dueToday.length ? ` · 🟡 due today: *${dueToday.length}*` : ''}`);
  const bits = [];
  if (doneToday.length) bits.push(`✅ ${doneToday.length} done today`);
  if (snoozed.length) bits.push(`😴 ${snoozed.length} snoozed`);
  if (bits.length) lines.push(bits.join(' · '));
  if (!open.length) lines.push('', '🎉 Nothing open — all caught up.');
  const df = tfcode(((uiCfg().tasks || {}).default_filter || 'a'));
  const rows = [];
  if (open.length) rows.push([{ text: '📋 Work through them →', callback_data: `tk:card:${df}:first` }]);
  rows.push([
    { text: '🗂 Register', callback_data: 'tk:reg:a:0:first' },
    { text: '🏆 Leaderboard', callback_data: 'tk:lb:a:first' },
  ]);
  return { ok: true, parse_mode: 'Markdown', text: lines.join('\n'),
    reply_markup: { inline_keyboard: rows } };
}

// Register = completed tasks, newest first (a VIEW over the ledger — no new store).
function registerPayload(page) {
  const done = loadLedger().filter(x => x.status === 'done')
    .sort((a, b) => String(b.done_at || '').localeCompare(String(a.done_at || '')));
  const PER = 8;
  const pages = Math.max(1, Math.ceil(done.length / PER));
  const p = Math.min(Math.max(0, parseInt(page, 10) || 0), pages - 1);
  const slice = done.slice(p * PER, p * PER + PER);
  const L = [`🗂 *Register — completed tasks* (${done.length})${pages > 1 ? ` · page ${p + 1}/${pages}` : ''}`, ''];
  if (!done.length) L.push('_Nothing completed yet._');
  for (const it of slice) {
    const by = it.completed_by || it.delegated_to || it.who;
    L.push(`✅ ${tclean(it.what, 60)}${it.client ? ` · ${tclean(it.client, 30)}` : ''}`);
    L.push(`    ${by ? tclean(by, 30) + ' · ' : ''}${String(it.done_at || '').slice(0, 10) || '?'}`);
  }
  const nav = [];
  if (p > 0) nav.push({ text: '◀', callback_data: `tk:reg:a:${p - 1}:first` });
  nav.push({ text: '⬅ Back', callback_data: 'tk:home:a:first' });
  if (p < pages - 1) nav.push({ text: '▶', callback_data: `tk:reg:a:${p + 1}:first` });
  return { ok: true, parse_mode: 'Markdown', text: L.join('\n'),
    reply_markup: { inline_keyboard: [nav] } };
}

function monthOf(iso) { return String(iso || '').slice(0, 7); }

// The leaderboard ranks OPERATORS (the people who tap Done), not assignees —
// a sub's task counts for whichever operator closes it. The roster of
// operators is config-driven: businesses[0].telegram_ui.leaderboard.operators,
// falling back to the configured email senders.
function operatorList() {
  const ops = ((uiCfg().leaderboard || {}).operators);
  if (Array.isArray(ops) && ops.length) return ops;
  const senders = (biz().email || {}).senders || {};
  return Object.keys(senders).map(k => k.charAt(0).toUpperCase() + k.slice(1));
}
function canonOperator(name, ops) {
  return ops.find(o => isPerson(o, name)) || null;
}

// Standings for a month: {operator: count} plus an unattributed bucket for
// completions with no operator on record (legacy items, non-operator names).
function standingsFor(ledger, month) {
  const ops = operatorList();
  const tally = {};
  let unattributed = 0;
  for (const it of ledger) {
    if (it.status !== 'done' || monthOf(it.done_at) !== month) continue;
    const op = it.completed_by ? canonOperator(it.completed_by, ops) : null;
    if (op) tally[op] = (tally[op] || 0) + 1;
    else unattributed++;
  }
  const rows = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  rows.unattributed = unattributed;
  return rows;
}
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${names[(m || 1) - 1]} ${y}`;
}

// Leaderboard for the current calendar month. Past months are lazily archived
// to leaderboard-archive.json the first time the board runs after a rollover —
// the archive is a permanent record of final standings per month.
function leaderboardPayload() {
  const l = loadLedger();
  const thisMonth = todayStr().slice(0, 7);
  let archive; try { archive = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8')); } catch { archive = {}; }
  const pastMonths = [...new Set(l.filter(x => x.status === 'done' && x.done_at)
    .map(x => monthOf(x.done_at)))].filter(m => m && m < thisMonth);
  let archChanged = false;
  for (const m of pastMonths) {
    if (!archive[m]) { archive[m] = Object.fromEntries(standingsFor(l, m)); archChanged = true; }
  }
  if (archChanged) { try { fs.writeFileSync(ARCHIVE, JSON.stringify(archive, null, 2)); } catch {} }

  const rows = standingsFor(l, thisMonth);
  const unattributed = rows.unattributed || 0;
  const medals = ['🥇', '🥈', '🥉'];
  const L = [`🏆 *Leaderboard — ${monthLabel(thisMonth)}*`, ''];
  if (!rows.length) L.push('_No operator completions yet this month — tap ✅ Done on a task card to get on the board._');
  rows.slice(0, 10).forEach(([name, n], i) => {
    L.push(`${medals[i] || ` ${i + 1}.`} ${tclean(name, 30)} — *${n}* ✅`);
  });
  if (unattributed) L.push('', `_+${unattributed} completed outside the cards (not ranked)._`);
  const prev = Object.keys(archive).sort().pop();
  if (prev) {
    const prows = Object.entries(archive[prev])
      .filter(([name]) => name !== '(unattributed)')
      .sort((a, b) => b[1] - a[1]);
    if (prows.length) L.push('', `_Last archived month (${monthLabel(prev)}): ${tclean(prows[0][0], 30)} led with ${prows[0][1]}._`);
  }
  L.push('', '_Resets on the 1st of each month._');
  return { ok: true, parse_mode: 'Markdown', text: L.join('\n'),
    reply_markup: { inline_keyboard: [[{ text: '⬅ Back', callback_data: 'tk:home:a:first' }]] } };
}

// 🗑 on the task card: cancel (not done) — leaves the Register and the
// leaderboard untouched, for system-generated tasks that aren't real work.
function cmdTaskSetClient(f) {
  const l = loadLedger();
  const it = openItem(l, f.id);
  if (!it) { outJSON(staleCardPayload(f.id, f.f, f.op)); return; }
  const c = clientList()[parseInt(f.client, 10)];
  if (!c) { outJSON({ ok: false, parse_mode: 'Markdown', text: '❌ Bad selection.', answer: 'Bad selection' }); return; }
  const prev = it.client || '(none)';
  it.client = c.name;
  it.client_corrected = true;
  if (norm(prev) !== norm(c.name)) it.note = (it.note ? it.note + ' | ' : '') + `client corrected ${prev} → ${c.name}`;
  saveLedger(l);
  // re-render the same task (it may shift position under client-sort) in place
  const pay = taskCardPayload(it.id, 'here', tfcode(f.f), f.op);
  pay.answer = `🏠 Client → ${c.name}`;
  outJSON(pay);
}

function cmdTaskDismiss(f) {
  const l = loadLedger();
  const it = openItem(l, f.id);
  if (!it) { outJSON(staleCardPayload(f.id, f.f, f.op)); return; }
  const code = tfcode(f.f);
  const nextId = nextIdAfter(cyclerView(l, code, f.op), it.id);
  it.status = 'cancelled';
  it.done_at = new Date().toISOString();
  const by = f.by ? resolvePersonLenientName(f.by) : null;
  it.note = (it.note ? it.note + ' | ' : '') + `dismissed via Telegram${by ? ' by ' + by : ''}`;
  saveLedger(l);
  const pay = taskCardPayload(nextId || 'first', 'here', code, f.op);
  pay.answer = '🗑 Dismissed';
  outJSON(pay);
}

function cmdTaskSnooze(f) {
  const l = loadLedger();
  const it = openItem(l, f.id);
  if (!it) { outJSON(staleCardPayload(f.id, f.f, f.op)); return; }
  const days = Math.min(Math.max(1, parseInt(f.days, 10) || 1), 30);
  const until = parseDue(`+${days}d`);
  const code = tfcode(f.f);
  const nextId = nextIdAfter(cyclerView(l, code, f.op), it.id);
  it.snooze_until = until;
  saveLedger(l);
  // snoozed item leaves the cycler view → advance to the genuine next task
  const pay = taskCardPayload(nextId || 'first', 'here', code, f.op);
  pay.answer = `😴 Snoozed until ${until}`;
  outJSON(pay);
}

// ── main ──────────────────────────────────────────────────────────────────────
function main() {
  const [, , cmd, ...rest] = process.argv;
  const f = parseFlags(rest);
  switch (cmd) {
    case 'add': return cmdAdd(f);
    case 'list': case 'ls': return void cmdList(f);
    case 'overdue': return void cmdList(f, 'overdue');
    case 'show': return cmdShow(f);
    case 'done': case 'complete': return cmdDone(f);
    case 'cancel': case 'rm': return cmdCancel(f);
    case 'delegate': return cmdDelegate(f);
    case 'snooze': return cmdSnooze(f);
    // ── card cycler (JSON out; consumed by the review-buttons plugin) ─────────
    case 'card': return outJSON(taskCardPayload(f.at || 'first', f.move || 'here', f.f, f.op));
    case 'home': return outJSON(homePayload());
    case 'register': return outJSON(registerPayload(f.page));
    case 'leaderboard': return outJSON(leaderboardPayload());
    case 'filter-menu': return outJSON(taskFilterMenuPayload(f.id, f.f));
    case 'snooze-menu': return outJSON(snoozeMenuPayload(f.id, f.f));
    case 'delegate-picker': return outJSON(delegatePickerPayload(f.id, f.f, f.page));
    case 'client-picker': return outJSON(clientPickerPayload(f.id, f.f, f.page));
    case 'tsetclient': return cmdTaskSetClient(f);
    case 'tdone': return cmdTaskDone(f);
    case 'tdismiss': return cmdTaskDismiss(f);
    case 'tdelegate': return void cmdTaskDelegate(f).catch(e => { outJSON({ ok: false, parse_mode: 'Markdown', text: '❌ ' + e.message, answer: 'Delegate failed' }); });
    case 'tsnooze': return cmdTaskSnooze(f);
    default:
      console.log('commit-cli.js — commitment tracker (nothing falls through the cracks)');
      console.log('Commands:');
      console.log('  add --what "..." [--who NAME] [--client "Name"] [--due today|tomorrow|+3d|fri|YYYY-MM-DD] [--job N] [--note "..."]');
      console.log('  list [--open|--overdue|--all|--done] [--client "Name"] [--who NAME]');
      console.log('  overdue');
      console.log('  show <n|cm_id>');
      console.log('  done <n|cm_id>');
      console.log('  cancel <n|cm_id> [--reason "..."]');
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exit(1);
  }
}
main();

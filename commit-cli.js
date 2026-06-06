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
  return `${i + 1}. ${flag} ${who}${it.what}${cl}${job}  [${dueLabel(it)}]  \`${it.id}\``;
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
  const it = mutate(f, (item) => { item.status = 'done'; item.done_at = new Date().toISOString(); }, 'done');
  console.log(`✅ Marked done: ${it.what}${it.client ? ' · ' + it.client : ''}  \`${it.id}\``);
}
function cmdCancel(f) {
  const it = mutate(f, (item) => { item.status = 'cancelled'; item.done_at = new Date().toISOString(); if (f.reason) item.note = (item.note ? item.note + ' | ' : '') + 'cancelled: ' + f.reason; }, 'cancel');
  console.log(`🗑  Cancelled: ${it.what}  \`${it.id}\``);
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

#!/usr/bin/env node
'use strict';
// status-cli.js — read-only Telegram digests for the bot menu (Status / Today).
//
// Emits the same JSON render-payload contract as review-cli.js / commit-cli.js
// card commands: {ok, parse_mode, text, reply_markup}. The review-buttons
// Hermes plugin sends these as messages when /status or /today is typed (or
// picked from the bot menu). Strictly read-only — nothing is written anywhere.
//
// Usage:
//   status-cli.js status     queue depth, open tasks, last ingest time
//   status-cli.js today      tasks due/overdue today + completions today

const fs = require('fs');
const path = require('path');

const DIR = '/root/construction-bi-pipeline';
const QUEUE = path.join(DIR, 'review-queue.json');
const LEDGER = path.join(DIR, 'commitments.json');
const PROCESSED = path.join(DIR, 'processed_recordings.json');
const CAPTURE = path.join(DIR, 'capture-queue.json');
let jobctx = null;
try { jobctx = require('./job-context.js'); } catch { /* optional until §3 lands */ }

function readJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function outJSON(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function clean(s, max) {
  let t = String(s == null ? '' : s).replace(/[`*_\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}
function ago(date) {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function openTasks(l, t) {
  return l.filter(x => x.status === 'open' && (!x.snooze_until || x.snooze_until <= t));
}

// Entry buttons shared by both digests: jump into the Review cards (needs a
// real rq_ id) and the Tasks hub. Rows are omitted when there's nothing there.
function entryButtons(pending, openCount) {
  const row = [];
  if (pending.length) row.push({ text: `📋 Review (${pending.length}) →`, callback_data: `rq:card:a:${pending[0].id}` });
  row.push({ text: openCount ? `✅ Tasks (${openCount}) →` : '✅ Tasks →', callback_data: 'tk:home:a:first' });
  return { inline_keyboard: [row] };
}

function cmdStatus() {
  const t = todayStr();
  const q = readJSON(QUEUE, []);
  const l = readJSON(LEDGER, []);
  const pending = q.filter(x => x.status === 'pending')
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const open = openTasks(l, t);
  const overdue = open.filter(x => x.due && x.due < t);
  const approvedToday = q.filter(x => x.status === 'approved' && String(x.approved_at || '').slice(0, 10) === t).length;
  const doneToday = l.filter(x => x.status === 'done' && String(x.done_at || '').slice(0, 10) === t).length;

  const L = ['🔍 *Status*', ''];
  L.push(`📋 Review queue: *${pending.length}* pending${approvedToday ? ` · ${approvedToday} approved today` : ''}`);
  L.push(`✅ Tasks: *${open.length}* open${overdue.length ? ` · 🔴 ${overdue.length} overdue` : ''}${doneToday ? ` · ${doneToday} done today` : ''}`);
  const captures = readJSON(CAPTURE, []);
  const pendingCaptures = Array.isArray(captures) ? captures.filter(x => x && x.status === 'pending').length : 0;
  if (pendingCaptures) L.push(`📨 Field captures waiting: *${pendingCaptures}*`);
  try {
    const m = fs.statSync(PROCESSED).mtime;
    L.push(`🎙 Last ingest activity: ${ago(m)}`);
  } catch { L.push('🎙 Last ingest activity: unknown'); }

  // Active jobs in their current state (§3 read-back) — most-recently-updated
  // first, compact one line each. The full per-job view is the morning digest.
  const jobs = (jobctx ? jobctx.list() : [])
    .filter(j => j.state_count > 0 || j.phase)
    .sort((a, b) => String((b.last_updated || {}).date || '').localeCompare(String((a.last_updated || {}).date || '')));
  if (jobs.length) {
    L.push('');
    L.push(`🏗 *Active jobs: ${jobs.length}*`);
    for (const j of jobs.slice(0, 6)) {
      const ctx = jobctx.get(j.job_id);
      const line = ctx ? jobctx.summaryLine(ctx) : '';
      L.push(`• ${clean(j.client || ('job #' + j.job_id), 24)}${j.job ? ` _(${clean(j.job, 20)})_` : ''}${line ? ` — ${clean(line, 60)}` : ''}`);
    }
    if (jobs.length > 6) L.push(`  _…and ${jobs.length - 6} more_`);
  }

  outJSON({ ok: true, parse_mode: 'Markdown', text: L.join('\n'),
    reply_markup: entryButtons(pending, open.length) });
}

function cmdToday() {
  const t = todayStr();
  const q = readJSON(QUEUE, []);
  const l = readJSON(LEDGER, []);
  const pending = q.filter(x => x.status === 'pending')
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const open = openTasks(l, t);
  const overdue = open.filter(x => x.due && x.due < t)
    .sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  const dueToday = open.filter(x => x.due === t);
  const doneToday = l.filter(x => x.status === 'done' && String(x.done_at || '').slice(0, 10) === t);

  const L = [`📅 *Today — ${t}*`, ''];
  const item = it => {
    const who = it.delegated_to || it.who;
    return `• ${who ? clean(who, 24) + ' → ' : ''}${clean(it.what, 60)}${it.client ? ` · ${clean(it.client, 28)}` : ''}`;
  };
  if (overdue.length) {
    L.push(`🔴 *Overdue (${overdue.length})*`);
    overdue.slice(0, 6).forEach(it => L.push(item(it) + `  _(${it.due})_`));
    if (overdue.length > 6) L.push(`  _…and ${overdue.length - 6} more_`);
    L.push('');
  }
  if (dueToday.length) {
    L.push(`🟡 *Due today (${dueToday.length})*`);
    dueToday.slice(0, 6).forEach(it => L.push(item(it)));
    if (dueToday.length > 6) L.push(`  _…and ${dueToday.length - 6} more_`);
    L.push('');
  }
  if (!overdue.length && !dueToday.length) L.push('🎉 Nothing due today.', '');
  if (doneToday.length) L.push(`✅ Done today: *${doneToday.length}*`);
  if (pending.length) L.push(`📋 Waiting for review: *${pending.length}*`);

  outJSON({ ok: true, parse_mode: 'Markdown', text: L.join('\n').trimEnd(),
    reply_markup: entryButtons(pending, open.length) });
}

const cmd = process.argv[2];
if (cmd === 'status') cmdStatus();
else if (cmd === 'today') cmdToday();
else { console.log('status-cli.js — read-only digests\n  status\n  today'); process.exit(cmd ? 1 : 0); }

#!/usr/bin/env node
'use strict';
// morning-brief.js — the 7am daily brief, delivered straight to Luis on Telegram
// via a Hermes cron (deliver=telegram, no-agent: this script's stdout IS the message).
//
// Sources are all LOCAL and cheap (no Jobber API calls — avoids throttling on a
// scheduled job): the commitments ledger and the review queue. Designed to stay
// silent-ish: if there's genuinely nothing to flag, it still sends a short
// "all clear" so Luis knows the system is alive.

const fs = require('fs');
const path = require('path');

const DIR = '/root/construction-bi-pipeline';
let jobctx = null;
try { jobctx = require('./job-context.js'); } catch { /* optional until §3 lands */ }
const COMMITMENTS = path.join(DIR, 'commitments.json');
const QUEUE = path.join(DIR, 'review-queue.json');

function readJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

// Brief is generated in the business's local time. Compute "today" in that tz so
// overdue math lines up with how the operator thinks about dates.
const TZ = (() => {
  try { return require('./src/config').settings().timezone; } catch { return 'America/New_York'; }
})();
function etTodayStr() {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}
function etHeaderDate() {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
}
function daysBetween(aStr, bStr) {
  const a = new Date(aStr + 'T00:00:00Z'), b = new Date(bStr + 'T00:00:00Z');
  return Math.round((a - b) / 86400000);
}

const today = etTodayStr();
const ledger = readJSON(COMMITMENTS, []);
const open = ledger.filter(c => c.status === 'open');

const overdue = open.filter(c => c.due && c.due < today).sort((a, b) => (a.due || '').localeCompare(b.due || ''));
const dueToday = open.filter(c => c.due === today);
const dueSoon = open.filter(c => c.due && c.due > today && daysBetween(c.due, today) <= 2)
  .sort((a, b) => a.due.localeCompare(b.due));
const noDate = open.filter(c => !c.due);

function who(c) { return c.who ? `${c.who} → ` : (c.who_raw ? `${c.who_raw}? → ` : ''); }
function cli(c) { return c.client ? ` · ${c.client}` : ''; }
function line(c, tail) { return `  • ${who(c)}${c.what}${cli(c)}${tail ? '  _' + tail + '_' : ''}`; }

const out = [];
out.push(`☀️ *Morning brief — ${etHeaderDate()}*`);

if (overdue.length) {
  out.push('', `🔴 *Overdue (${overdue.length})*`);
  overdue.forEach(c => {
    const late = daysBetween(today, c.due);
    out.push(line(c, `${late}d late · was due ${c.due}`));
  });
}
if (dueToday.length) {
  out.push('', `🟡 *Due today (${dueToday.length})*`);
  dueToday.forEach(c => out.push(line(c)));
}
if (dueSoon.length) {
  out.push('', `⏳ *Coming up (${dueSoon.length})*`);
  dueSoon.forEach(c => out.push(line(c, `due ${c.due}`)));
}

// Review queue — split recordings vs field-capture items still pending.
const q = readJSON(QUEUE, []);
const pending = q.filter(x => x.status === 'pending');
const fieldPending = pending.filter(x => x.source === 'field_capture').length;
const recPending = pending.length - fieldPending;
if (pending.length) {
  out.push('', `📋 *Review queue (${pending.length})*`);
  const bits = [];
  if (recPending) bits.push(`${recPending} recording${recPending > 1 ? 's' : ''}`);
  if (fieldPending) bits.push(`${fieldPending} field item${fieldPending > 1 ? 's' : ''}`);
  out.push(`  ${bits.join(' + ')} waiting — reply */review* to clear.`);
  // Surface machine-read receipt amounts that still need a human to confirm.
  const autoReads = pending.filter(x => x.proposed_expense && x.proposed_expense.amount != null);
  if (autoReads.length) {
    const sum = autoReads.reduce((t, x) => t + Number(x.proposed_expense.amount || 0), 0);
    out.push(`  🤖 incl. ${autoReads.length} auto-read receipt${autoReads.length > 1 ? 's' : ''} (~$${sum.toFixed(2)}) to confirm — these are OCR guesses, not yet logged.`);
  }
}

// Jobs in progress (§B morning digest) — where each active job stands now, so
// the brief is forward-looking, not just a task list. Reads the living context
// files; flags jobs that are past their planned phase or have gone quiet.
if (jobctx) {
  const jobs = jobctx.list()
    .filter(j => j.phase || j.state_count)
    .map(j => jobctx.get(j.job_id)).filter(Boolean)
    .sort((a, b) => String((b.last_updated || {}).date || '').localeCompare(String((a.last_updated || {}).date || '')));
  if (jobs.length) {
    out.push('', `🏗 *Jobs in progress (${jobs.length})*`);
    for (const c of jobs.slice(0, 10)) {
      const sched = c.schedule_ref || {};
      const lastEnd = (sched.phases || []).map(p => p.end).filter(Boolean).sort().pop();
      const flags = [];
      if (lastEnd && lastEnd < today) flags.push(`🔴 ${daysBetween(today, lastEnd)}d past plan`);
      const lu = (c.last_updated || {}).date;
      if (lu && daysBetween(today, lu) >= 7) flags.push(`😴 quiet ${daysBetween(today, lu)}d`);
      const s = jobctx.summaryLine(c);
      out.push(`  *${c.client || ('job #' + c.job_id)}*${c.phase ? ' — ' + c.phase : ''}${flags.length ? '  ' + flags.join(' · ') : ''}`);
      if (s) out.push(`     _${s.length > 70 ? s.slice(0, 69) + '…' : s}_`);
    }
    if (jobs.length > 10) out.push(`  _…and ${jobs.length - 10} more — */status* for all._`);
  }
}

// Footer / all-clear.
if (!overdue.length && !dueToday.length && !dueSoon.length && !pending.length) {
  const n = open.length;
  out.push('', n
    ? `✅ Nothing due and nothing in the review queue. ${n} open commitment${n > 1 ? 's' : ''} on the list — */commitments* to see them.`
    : `✅ All clear — no open commitments, nothing in the review queue. Have a good one.`);
} else {
  const remaining = noDate.length;
  if (remaining) out.push('', `_(+${remaining} open with no due date — */commitments* for the full list.)_`);
}

process.stdout.write(out.join('\n') + '\n');

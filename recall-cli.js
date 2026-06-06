#!/root/.hermes/node/bin/node
'use strict';
/*
 * recall-cli.js — "What's the status on <client>?" in one answer.
 *
 * Aggregates everything we know about a client into a single readable summary:
 *   • Jobber jobs + P&L (best-effort; never blocks if the API is slow/down)
 *   • Open promises/commitments from the ledger
 *   • Upcoming meetings on the Cruz Schedule calendar
 *   • Planned jobs / schedule status
 *   • Recent captured activity (recordings + field notes) from the review queue
 *
 * Read-only. Local sources are always shown; Jobber is wrapped so a throttle or
 * outage degrades to "unavailable right now" instead of failing the whole recall.
 *
 * Usage:  recall-cli.js "Client Name" [--quick]   (--quick skips Jobber API calls)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = '/root/construction-bi-pipeline';
const NODE = '/root/.hermes/node/bin/node';
const JOBBER = path.join(DIR, 'jobber-cli.js');
const CONFIG = path.join(DIR, 'config.json');

function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function norm(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function roster() {
  const c = readJSON(CONFIG, {});
  const b = (c.businesses || [])[0] || {};
  return (b.clients || []).map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean);
}
function resolveClient(arg) {
  const names = roster(), want = norm(arg);
  if (!want) return { client: null, suggestions: [] };
  const exact = names.find(n => norm(n) === want);
  if (exact) return { client: exact, suggestions: [] };
  // substring either direction
  let partial = names.filter(n => norm(n).includes(want) || want.includes(norm(n)));
  // every query word appears in the client name (handles "Lisa Gallan" → "Lisa & Joe Gallan")
  if (!partial.length) {
    const wt = want.split(' ').filter(t => t.length >= 2);
    partial = names.filter(n => { const nn = norm(n); return wt.length && wt.every(t => nn.includes(t)); });
  }
  if (partial.length === 1) return { client: partial[0], suggestions: [] };
  if (partial.length > 1) return { client: null, suggestions: partial };
  const ranked = names.map(n => ({ n, d: lev(want, norm(n)) })).sort((a, b) => a.d - b.d);
  return { client: null, suggestions: ranked.slice(0, 4).map(x => x.n) };
}
// Strict: for records that carry a clean client NAME field (commitments,
// job-plans, review queue). Normalized equality or full containment only — never
// single-token overlap, so "Lisa & Joe Gallan" never pulls "Lisa Hannan" or
// "Jesse + Eva Gallan".
function belongsClient(recClient, client) {
  const a = norm(recClient), b = norm(client);
  return !!a && (a === b || a.includes(b) || b.includes(a));
}
// Loose: for FREE TEXT (calendar summary/location). Requires the full client
// string as a substring, OR every significant (len>=4) name word present — so
// both "lisa" AND "gallan" must appear, not just one.
function belongsText(text, client) {
  const t = norm(text); if (!t) return false;
  if (t.includes(norm(client))) return true;
  const toks = norm(client).split(' ').filter(x => x.length >= 4);
  return toks.length > 0 && toks.every(tok => t.includes(tok));
}

function jobber(args, timeoutMs = 25000) {
  try { return execFileSync(NODE, [JOBBER, ...args], { encoding: 'utf8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (e) { return null; }
}

// ── main ──
const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
const name = argv.filter(a => !a.startsWith('--')).join(' ').trim();
if (!name) { console.log('Usage: recall-cli.js "Client Name" [--quick]'); process.exit(1); }

const r = resolveClient(name);
if (!r.client) {
  console.log(`I don't have a client matching "${name}".` +
    (r.suggestions.length ? `\nClosest: ${r.suggestions.join(', ')}. Try the exact name.` : ''));
  process.exit(0);
}
const client = r.client;
const out = [`📇 *${client}* — full picture`, ''];

// 1) Jobs + P&L (best-effort)
if (!quick) {
  const jobs = jobber(['jobs', client]);
  if (jobs) out.push('🧰 *Jobs*', jobs, '');
  else out.push('🧰 *Jobs*', '_Jobber unavailable right now — try again in a moment._', '');
  const pnl = jobber(['job-pnl', client]);
  if (pnl) out.push('💰 *Money (P&L)*', pnl, '');
} else {
  out.push('_(quick mode — Jobber jobs/P&L skipped)_', '');
}

// 2) Open promises
const ledger = readJSON(path.join(DIR, 'commitments.json'), []);
const open = (Array.isArray(ledger) ? ledger : []).filter(c => c.status === 'open' && belongsClient(c.client, client));
if (open.length) {
  out.push(`🤝 *Open promises (${open.length})*`);
  open.forEach(c => out.push(`  • ${c.who ? c.who + ' → ' : ''}${c.what}${c.due ? '  _(due ' + c.due + ')_' : ''}`));
  out.push('');
}

// 3) Upcoming calendar meetings
try {
  const cal = require(path.join(DIR, 'calendar-writer'));
  cal.listAdhocEvents({ days: 90 }).then(items => {
    const mine = items.filter(e => belongsText((e.summary || '') + ' ' + (e.location || ''), client));
    finish(mine);
  }).catch(() => finish(null));
} catch (e) { finish(null); }

function finish(calItems) {
  if (calItems && calItems.length) {
    out.push(`📅 *Upcoming meetings (${calItems.length})*`);
    calItems.forEach(e => {
      const when = e.all_day ? e.start + ' (all day)' : e.start.replace('T', ' ').slice(0, 16) + ' ET';
      out.push(`  • ${when} — ${e.summary}${e.location ? ' @ ' + e.location : ''}`);
    });
    out.push('');
  } else if (calItems === null) {
    out.push('📅 _Calendar unavailable right now._', '');
  }

  // 4) Planned jobs / schedule
  const plans = readJSON(path.join(DIR, 'job-plans.json'), []);
  const mine = (Array.isArray(plans) ? plans : []).filter(p => belongsClient(p.client, client));
  if (mine.length) {
    out.push(`🗓️ *Planned jobs (${mine.length})*`);
    mine.forEach(p => out.push(`  • #${p.job_number} ${p.job_title || ''} — ${p.status || '?'}`));
    out.push('');
  }

  // 5) Recent captured activity (review queue: recordings + field notes)
  const q = readJSON(path.join(DIR, 'review-queue.json'), []);
  const acts = (Array.isArray(q) ? q : [])
    .filter(i => belongsClient(i.proposed_client, client))
    .sort((a, b) => String(b.created_at || b.recording_date || '').localeCompare(String(a.created_at || a.recording_date || '')))
    .slice(0, 6);
  if (acts.length) {
    out.push(`🗂️ *Recent activity (${acts.length})*`);
    acts.forEach(i => {
      const d = String(i.recording_date || i.created_at || '').slice(0, 10);
      const src = i.source === 'field_capture' ? '📲 field' : '🎙️ rec';
      const st = i.status === 'pending' ? '⏳ pending' : i.status;
      const snip = (i.proposed_note || i.analysis_summary || i.transcript_snippet || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      out.push(`  • ${d} ${src} [${st}] ${snip}${snip.length >= 100 ? '…' : ''}`);
    });
    out.push('');
  }

  if (out[out.length - 1] === '') out.pop();
  if (out.length <= 2) out.push('_Nothing on file yet for this client._');
  process.stdout.write(out.join('\n') + '\n');
}

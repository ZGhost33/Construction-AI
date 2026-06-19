#!/usr/bin/env node
'use strict';
// inference-cli.js — the inference + proactive layer (§4), OBSERVATION MODE.
//
// Nothing here surfaces a live card or writes job state. The on-approve check
// and the daily sweep log CANDIDATES to inference-log.json; the owner skims
// them (daily push + /observe) and, when satisfied, flips the dial to live.
//
//   infer-on-approve --job N --client "..." --note "..."   (called from approve)
//   sweep                                                   (daily cron)
//   observe                                                 (JSON digest → /observe + push)
//   config                                                  (show the dial)
//
// Dial: businesses[0].telegram_ui.inference =
//   { mode:"observation"|"live", sensitivity:"chatty"|"balanced"|"quiet",
//     daily_cap:N, quiet_days:N, bottleneck:N }
// Defaults: observation / chatty / cap 30 / quiet 7 / bottleneck 3.

const fs = require('fs');
const path = require('path');
const inf = require('./inference.js');
const jc = require('./job-context.js');

const DIR = '/root/construction-bi-pipeline';
const CONFIG = path.join(DIR, 'config.json');
const LEDGER = path.join(DIR, 'commitments.json');

function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function biz() { return (readJSON(CONFIG, { businesses: [{}] }).businesses[0]) || {}; }
function outJSON(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function clean(s, max) { let t = String(s == null ? '' : s).replace(/[`*_\[\]]/g, '').replace(/\s+/g, ' ').trim(); if (max && t.length > max) t = t.slice(0, max - 1) + '…'; return t; }
function today() { return new Date().toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

function dial() {
  const d = (biz().telegram_ui || {}).inference || {};
  return {
    mode: d.mode === 'live' ? 'live' : 'observation',
    sensitivity: ['chatty', 'balanced', 'quiet'].includes(d.sensitivity) ? d.sensitivity : 'chatty',
    daily_cap: Number.isInteger(d.daily_cap) ? d.daily_cap : 30,
    quiet_days: Number.isInteger(d.quiet_days) ? d.quiet_days : 7,
    bottleneck: Number.isInteger(d.bottleneck) ? d.bottleneck : 3,
  };
}
function passesSensitivity(conf, sensitivity) {
  if (sensitivity === 'quiet') return conf === 'high';
  if (sensitivity === 'balanced') return conf !== 'low';
  return true; // chatty
}

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
// Operators (the office: Luis/Jorge/Danilo) — their workload is not a
// "bottleneck", so they're excluded from that signal. Config-driven.
function operators() {
  const ui = biz().telegram_ui || {};
  const ops = (ui.leaderboard || {}).operators;
  if (Array.isArray(ops) && ops.length) return ops;
  const senders = (biz().email || {}).senders || {};
  return Object.keys(senders).map(k => k.charAt(0).toUpperCase() + k.slice(1));
}
function isOperator(name) {
  return operators().some(o => { const a = norm(o), b = norm(name); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); });
}

// ACTIONABILITY GATE for proactive cards: a proactive ping may only surface if
// it names a specific job/client OR a specific bottlenecked resource, AND it's
// an anomaly/decision (stall / quiet / bottleneck) — never a bare aggregate or
// count ("you have N tasks"). Aggregates belong in the morning digest.
function proactiveKind(c) { return c.kind || (c.dedupe || '').split(':')[0]; }
function isActionableProactive(c) {
  if (c.type !== 'proactive') return true;       // gate applies only to proactive
  const k = proactiveKind(c);
  if (k === 'stall' || k === 'pastend' || k === 'quiet') return !!(c.job_id || c.client);
  if (k === 'bottleneck') return !!c.person && !isOperator(c.person);
  return false;                                  // anything else (aggregates) → suppressed
}

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { out[a.slice(2)] = args[i + 1]; i++; }
    else out._.push(a);
  }
  return out;
}

// ── §4.1 on-approve: what does this note IMPLY about the job's other state? ────
async function cmdInferOnApprove(f) {
  const d = dial();
  const job = f.job && /^\d+$/.test(String(f.job)) ? String(f.job) : null;
  if (!job || !f.note) { console.log('infer-on-approve: --job N and --note required'); return; }
  const ctx = jc.get(job);
  if (!ctx || !(ctx.state || []).length) { console.log('(no prior state to reason about)'); return; }
  const { inferStateChange } = require('./src/claude.js');
  const apiKey = biz().anthropic_api_key || readJSON(CONFIG, {}).anthropic_api_key;
  let inferences = [];
  try {
    inferences = await inferStateChange(apiKey, biz(), {
      job: ctx.job, client: ctx.client, state: ctx.state,
      schedule_phases: (ctx.schedule_ref || {}).phases || [],
    }, f.note);
  } catch (e) { console.log('infer-on-approve: ' + e.message); return; }

  const cands = inferences
    .filter(x => x && x.implication && passesSensitivity(x.confidence || 'medium', d.sensitivity))
    .map(x => ({
      type: 'inferred-update', job_id: job, client: ctx.client || f.client || null,
      text: `${ctx.client || 'Job #' + job}: ${x.implication}`,
      detail: x.because || null, confidence: x.confidence || 'medium',
      element: x.element || null, implication: x.implication,
      dedupe: `${x.element || ''}:${x.implication}`,
    }));
  const n = inf.add(cands);
  console.log(`🔭 observed ${n} inferred-update candidate(s) for job #${job} (mode: ${d.mode}).`);
}

// ── §4.3 daily sweep: cross-job patterns (rule-based, cheap, deterministic) ────
function cmdSweep() {
  const d = dial();
  const t = today();
  const jobs = jc.list().map(j => jc.get(j.job_id)).filter(Boolean);
  const cands = [];

  for (const ctx of jobs) {
    const lu = (ctx.last_updated || {}).date;
    // quiet job — a SPECIFIC job with no update in quiet_days (anomaly + decision)
    if (lu && daysBetween(lu, t) >= d.quiet_days) {
      cands.push({ type: 'proactive', kind: 'quiet', job_id: ctx.job_id, client: ctx.client,
        text: `${ctx.client || 'Job #' + ctx.job_id} has gone quiet — no update in ${daysBetween(lu, t)} days. Still active?`,
        confidence: 'medium', dedupe: `quiet:${ctx.job_id}:${lu}` });
    }
    // past planned completion — a SPECIFIC job past its last scheduled phase end
    const phases = ((ctx.schedule_ref || {}).phases || []).filter(p => p.end);
    if (phases.length) {
      const lastEnd = phases.map(p => p.end).sort().pop();
      if (lastEnd < t) {
        const past = daysBetween(lastEnd, t);
        cands.push({ type: 'proactive', kind: 'stall', job_id: ctx.job_id, client: ctx.client,
          text: `${ctx.client || 'Job #' + ctx.job_id} is ${past} day(s) past its planned completion (${lastEnd}) — stalled?`,
          detail: `Last planned phase ended ${lastEnd}; check actual status.`, confidence: 'high', dedupe: `pastend:${ctx.job_id}:${lastEnd}` });
      }
    }
  }

  // Bottlenecked RESOURCE — a non-operator (sub/contractor) whom multiple jobs
  // are waiting on. Counts DISTINCT jobs (the constraint), not raw task totals,
  // and excludes the office (an operator carrying many tasks is workload, not a
  // bottleneck). Framed as a decision.
  const ledger = readJSON(LEDGER, []);
  const open = ledger.filter(x => x.status === 'open');
  const byWho = {};
  for (const it of open) {
    const who = it.delegated_to || it.who;
    if (!who || isOperator(who)) continue;
    (byWho[who] = byWho[who] || []).push(it);
  }
  for (const [who, items] of Object.entries(byWho)) {
    const jobsSet = new Set(items.map(x => x.job || x.client).filter(Boolean));
    if (jobsSet.size >= d.bottleneck) {
      cands.push({ type: 'proactive', kind: 'bottleneck', job_id: null, client: null, person: who,
        text: `${jobsSet.size} jobs are waiting on ${who} this week — bottleneck?`,
        detail: `${items.length} open task(s) for ${who} across ${jobsSet.size} job(s)/client(s).`,
        confidence: 'medium', dedupe: `bottleneck:${who}:${jobsSet.size}` });
    }
  }

  // Actionability gate: drop any proactive card that isn't a specific,
  // actionable anomaly (pure aggregates/counts never get sent).
  const filtered = cands.filter(c => isActionableProactive(c) && passesSensitivity(c.confidence, d.sensitivity));
  const n = inf.add(filtered);
  console.log(`🔭 sweep: ${n} new proactive candidate(s) logged (mode: ${d.mode}, sensitivity: ${d.sensitivity}).`);
}

// ── live confirm cards (§4 live) ──────────────────────────────────────────────
function infList() { return inf.openCandidates().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))); }
function nextInfId(list, id) {
  const pos = list.findIndex(x => x.id === id);
  if (pos < 0) return null;
  if (pos < list.length - 1) return list[pos + 1].id;
  if (pos > 0) return list[pos - 1].id;
  return null;
}
function infCardText(c, i, n) {
  const isUpd = c.type === 'inferred-update';
  const L = [`${isUpd ? '🤔' : '💡'} *${isUpd ? 'Inferred update' : 'Proactive'} ${i + 1} of ${n}*`];
  const head = `${c.client || ''}${c.job_id ? ' (job #' + c.job_id + ')' : ''}`.trim();
  if (head) L.push(head);
  L.push('', clean(c.text, 200));
  if (c.detail) { L.push('', `_${clean(c.detail, 200)}_`); }
  L.push('', isUpd ? 'Confirm this update to the job?' : 'Useful?');
  return L.join('\n');
}
function infCardKeyboard(c, i, n) {
  return { inline_keyboard: [
    [
      { text: '✅ Confirm', callback_data: `if:accept:${c.id}` },
      { text: '❌ Dismiss', callback_data: `if:reject:${c.id}` },
      { text: '⏭ Skip', callback_data: `if:skip:${c.id}` },
    ],
    [
      { text: i > 0 ? '◀' : '·', callback_data: i > 0 ? `if:prev:${c.id}` : 'if:noop' },
      { text: `${i + 1}/${n}`, callback_data: 'if:noop' },
      { text: i < n - 1 ? '▶' : '·', callback_data: i < n - 1 ? `if:next:${c.id}` : 'if:noop' },
    ],
  ] };
}
function infEmptyPayload() {
  return { ok: true, empty: true, parse_mode: 'Markdown', reply_markup: null,
    text: '🔭 *Observation log clear* — nothing to review right now.' };
}
function infCardPayload(at, move) {
  const list = infList();
  if (!list.length) return infEmptyPayload();
  let idx = 0, answer = null;
  if (at && at !== 'first') {
    const pos = list.findIndex(x => x.id === at);
    idx = pos < 0 ? 0 : pos;
    if (pos < 0) move = 'here';
  }
  if (move === 'next') { if (idx < list.length - 1) idx++; else answer = 'End of list.'; }
  else if (move === 'prev') { if (idx > 0) idx--; else answer = 'Start of list.'; }
  const c = list[idx];
  const pay = { ok: true, empty: false, parse_mode: 'Markdown', id: c.id,
    text: infCardText(c, idx, list.length), reply_markup: infCardKeyboard(c, idx, list.length) };
  if (answer) pay.answer = answer;
  return pay;
}

function cmdInfCard(f) { outJSON(infCardPayload(f.at || 'first', f.move || 'here')); }

function cmdInfAccept(f) {
  const c = inf.get(f.id);
  if (!c || c.status !== 'observed') { const p = infCardPayload(f.id, 'here'); p.answer = 'Already handled.'; outJSON(p); return; }
  const nextId = nextInfId(infList(), f.id);
  // Inferred-update: write the now-confirmed state into the job context. It
  // becomes a confirmed fact (basis INFERRED, confirmed:true) — which is allowed
  // to inform future inference, unlike an unconfirmed one. Proactive: just close.
  if (c.type === 'inferred-update' && c.job_id && c.element) {
    try {
      jc.applyUpdate(c.job_id, {
        stateItems: [{ element: c.element, status: c.implication || c.text, basis: 'INFERRED', confirmed: true }],
        timelineEvent: `Confirmed via inference${f.op ? ' by ' + f.op : ''}: ${c.implication || c.text}`,
        source: 'inference', by: f.op || null,
      });
    } catch (e) { /* non-fatal */ }
  }
  inf.setStatus(f.id, 'confirmed', f.op);
  const pay = infCardPayload(nextId || 'first', 'here');
  pay.answer = c.type === 'inferred-update' ? '✅ Confirmed — job state updated' : '✅ Got it';
  outJSON(pay);
}

function cmdInfReject(f) {
  const c = inf.get(f.id);
  if (!c || c.status !== 'observed') { const p = infCardPayload(f.id, 'here'); p.answer = 'Already handled.'; outJSON(p); return; }
  const nextId = nextInfId(infList(), f.id);
  inf.setStatus(f.id, 'rejected', f.op);
  const pay = infCardPayload(nextId || 'first', 'here');
  pay.answer = '❌ Dismissed';
  outJSON(pay);
}

// ── observe: digest (observation mode) or the first confirm card (live) ───────
function cmdObserve() {
  const d = dial();
  if (d.mode === 'live') { outJSON(infCardPayload('first', 'here')); return; }
  const cands = inf.openCandidates().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const updates = cands.filter(c => c.type === 'inferred-update');
  const proactive = cands.filter(c => c.type === 'proactive');
  const L = [`🔭 *Observation log* · _${d.mode} mode · ${d.sensitivity}_`];
  if (!cands.length) {
    L.push('', '_Nothing noticed yet. As approvals and the daily sweep run, candidate inferences land here for you to judge._');
    outJSON({ ok: true, parse_mode: 'Markdown', text: L.join('\n'), reply_markup: null });
    return;
  }
  const cap = d.daily_cap;
  if (updates.length) {
    L.push('', `🤔 *Inferred updates (${updates.length})*`);
    updates.slice(0, cap).forEach(c => { L.push(`• ${clean(c.text, 80)}`); if (c.detail) L.push(`   _${clean(c.detail, 80)}_`); });
  }
  if (proactive.length) {
    L.push('', `💡 *Proactive (${proactive.length})*`);
    proactive.slice(0, cap).forEach(c => L.push(`• ${clean(c.text, 90)}`));
  }
  L.push('', '_Observation mode: candidates, not acted on. Say the word to flip the dial to live confirm cards._');
  outJSON({ ok: true, parse_mode: 'Markdown', text: L.join('\n'), reply_markup: null });
}

function cmdConfig() { outJSON({ ok: true, ...dial(), open_candidates: inf.openCandidates().length }); }

// One-time / periodic cleanup: reject any already-logged proactive candidate
// that doesn't clear the actionability gate (e.g. legacy aggregate cards).
function cmdPrune() {
  let pruned = 0;
  for (const c of inf.openCandidates()) {
    if (!isActionableProactive(c)) { inf.setStatus(c.id, 'rejected', 'actionability-gate'); pruned++; }
  }
  console.log(`pruned ${pruned} non-actionable candidate(s).`);
}

async function main() {
  const cmd = process.argv[2];
  const f = parseFlags(process.argv.slice(3));
  switch (cmd) {
    case 'infer-on-approve': return cmdInferOnApprove(f);
    case 'sweep': return cmdSweep();
    case 'observe': return cmdObserve();
    case 'card': return cmdInfCard(f);
    case 'accept': return cmdInfAccept(f);
    case 'reject': return cmdInfReject(f);
    case 'config': return cmdConfig();
    case 'prune': return cmdPrune();
    default:
      console.log('inference-cli.js (§4 observation mode)\n  infer-on-approve --job N --client ".." --note ".."\n  sweep\n  observe\n  config');
      process.exit(cmd ? 1 : 0);
  }
}
main().catch(e => { console.error('inference-cli failed: ' + e.message); process.exit(1); });

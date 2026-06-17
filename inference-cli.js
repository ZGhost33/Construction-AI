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
    // quiet job — no update in quiet_days
    if (lu && daysBetween(lu, t) >= d.quiet_days) {
      cands.push({ type: 'proactive', job_id: ctx.job_id, client: ctx.client,
        text: `${ctx.client || 'Job #' + ctx.job_id} has gone quiet — no update in ${daysBetween(lu, t)} days`,
        confidence: 'medium', dedupe: `quiet:${lu}` });
    }
    // past planned completion — today beyond the last scheduled phase end
    const phases = ((ctx.schedule_ref || {}).phases || []).filter(p => p.end);
    if (phases.length) {
      const lastEnd = phases.map(p => p.end).sort().pop();
      if (lastEnd < t) {
        const past = daysBetween(lastEnd, t);
        cands.push({ type: 'proactive', job_id: ctx.job_id, client: ctx.client,
          text: `${ctx.client || 'Job #' + ctx.job_id} is ${past} day(s) past its planned completion (${lastEnd})`,
          detail: `Last planned phase ended ${lastEnd}; check actual status.`, confidence: 'high', dedupe: `pastend:${lastEnd}` });
      }
    }
  }

  // bottlenecked people — one assignee with many open commitments across jobs
  const ledger = readJSON(LEDGER, []);
  const open = ledger.filter(x => x.status === 'open');
  const byWho = {};
  for (const it of open) {
    const who = it.delegated_to || it.who;
    if (!who) continue;
    (byWho[who] = byWho[who] || []).push(it);
  }
  for (const [who, items] of Object.entries(byWho)) {
    if (items.length >= d.bottleneck) {
      const jobsN = new Set(items.map(x => x.job || x.client).filter(Boolean)).size;
      cands.push({ type: 'proactive', job_id: null, client: null,
        text: `${who} is carrying ${items.length} open task(s)${jobsN ? ` across ${jobsN} job(s)/client(s)` : ''}`,
        confidence: 'medium', dedupe: `bottleneck:${who}:${items.length}` });
    }
  }

  const filtered = cands.filter(c => passesSensitivity(c.confidence, d.sensitivity));
  const n = inf.add(filtered);
  console.log(`🔭 sweep: ${n} new proactive candidate(s) logged (mode: ${d.mode}, sensitivity: ${d.sensitivity}).`);
}

// ── observe: the digest the owner skims (/observe + daily push) ───────────────
function cmdObserve() {
  const d = dial();
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
  L.push('', '_Observation mode: these are candidates, not acted on. When they read useful, say the word and I\'ll flip the dial to live cards._');
  outJSON({ ok: true, parse_mode: 'Markdown', text: L.join('\n'), reply_markup: null });
}

function cmdConfig() { outJSON({ ok: true, ...dial(), open_candidates: inf.openCandidates().length }); }

async function main() {
  const cmd = process.argv[2];
  const f = parseFlags(process.argv.slice(3));
  switch (cmd) {
    case 'infer-on-approve': return cmdInferOnApprove(f);
    case 'sweep': return cmdSweep();
    case 'observe': return cmdObserve();
    case 'config': return cmdConfig();
    default:
      console.log('inference-cli.js (§4 observation mode)\n  infer-on-approve --job N --client ".." --note ".."\n  sweep\n  observe\n  config');
      process.exit(cmd ? 1 : 0);
  }
}
main().catch(e => { console.error('inference-cli failed: ' + e.message); process.exit(1); });

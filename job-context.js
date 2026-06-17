'use strict';
// job-context.js — the living per-job state store (Intelligent Jobs §3).
//
// Each active job has a context object describing its TRUE current state, built
// up from approved recording/field-note segments. Jobber stays the system of
// record for formal data; this is the agent's working memory of *state*.
//
// Every state fact is tagged STATED (someone said it) or INFERRED (deduced by
// the agent, §4) plus a `confirmed` flag. This phase writes only STATED+confirmed
// facts (a human approved the note). The schema carries the INFERRED/confirmed
// fields so §4 can populate them with no migration. Hard rule for §4: an
// INFERRED-unconfirmed fact must never feed another inference.
//
// Concurrency: three bots (Luis/Jorge/Danilo) can approve segments about the
// same job within seconds of each other. Read-modify-write is wrapped in an
// advisory lockfile + atomic tmp→rename write so near-simultaneous updates
// serialize instead of clobbering.

const fs = require('fs');
const path = require('path');

const DIR = '/root/construction-bi-pipeline';
const STORE = path.join(DIR, 'job-context.json');
const LOCK = STORE + '.lock';

function load() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; } }
function saveAtomic(obj) {
  const tmp = STORE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, STORE);
}
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }

// Advisory lock: O_EXCL create, bounded retry, with a stale-lock breaker so a
// crashed writer can't wedge the store forever. Returns a release function.
function acquireLock(retries = 30, waitMs = 200, staleMs = 30000) {
  for (let i = 0; i < retries; i++) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(LOCK); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > staleMs) fs.unlinkSync(LOCK); } catch { /* race */ }
      sleepSync(waitMs);
    }
  }
  throw new Error('job-context: could not acquire lock');
}

function newContext(jobId) {
  return {
    job_id: String(jobId), job: null, client: null, address: null,
    phase: null,
    last_updated: null,
    state: [],          // { element, status, basis:STATED|INFERRED, date, confirmed, source }
    timeline: [],       // { date, event, source }
    open_questions: [], // { text, basis, confirmed, source }  — §4 populates
    schedule_ref: null, materials_ref: null,
    created_at: new Date().toISOString(), updated_at: null,
  };
}

// Run a mutator against one job's context under the lock, atomically.
function withJob(jobId, mutator) {
  const release = acquireLock();
  try {
    const all = load();
    const ctx = all[jobId] || newContext(jobId);
    mutator(ctx);
    ctx.updated_at = new Date().toISOString();
    all[jobId] = ctx;
    saveAtomic(all);
    return ctx;
  } finally { release(); }
}

// Apply an approved segment's extracted state to a job.
//   p = { job, client, address, phase, stateItems:[{element,status,basis?,confirmed?}],
//         timelineEvent, recordingId, speaker, by, source, date }
// Newer same-element facts supersede older ones. Everything written here is
// STATED+confirmed unless explicitly flagged (INFERRED comes from §4).
function applyUpdate(jobId, p) {
  return withJob(String(jobId), (ctx) => {
    if (p.job) ctx.job = p.job;
    if (p.client) ctx.client = p.client;
    if (p.address) ctx.address = p.address;
    if (p.phase) ctx.phase = p.phase;
    const date = p.date || new Date().toISOString().slice(0, 10);
    const srcId = p.recordingId || null;
    for (const si of (p.stateItems || [])) {
      if (!si || !si.element) continue;
      const key = norm(si.element);
      const entry = {
        element: String(si.element).slice(0, 60),
        status: String(si.status || '').slice(0, 120),
        basis: si.basis === 'INFERRED' ? 'INFERRED' : 'STATED',
        date,
        confirmed: si.confirmed !== false,
        source: srcId,
      };
      const existing = ctx.state.find(x => norm(x.element) === key);
      if (existing) Object.assign(existing, entry); else ctx.state.push(entry);
    }
    if (p.timelineEvent) {
      ctx.timeline.push({ date, event: String(p.timelineEvent).slice(0, 200), source: srcId });
      if (ctx.timeline.length > 40) ctx.timeline = ctx.timeline.slice(-40); // compress: keep recent
    }
    ctx.last_updated = { recording_id: srcId, date, speaker: p.speaker || null, by: p.by || null, source: p.source || 'recording' };
  });
}

function get(jobId) { return load()[String(jobId)] || null; }

// All job contexts for a client (read-back, e.g. on an intake card).
function byClient(clientName) {
  const want = norm(clientName);
  if (!want) return [];
  return Object.values(load()).filter(c => norm(c.client) === want);
}

// Compact one-line state for a job: "paint · drywall complete; painters Thu".
// Uses the most-recently-touched state items (pushed to the end on update).
function summaryLine(ctx, maxItems = 2) {
  const top = (ctx.state || []).slice(-maxItems).map(s => `${s.element} ${s.status}`.trim()).filter(Boolean).join('; ');
  const phase = ctx.phase || '';
  return [phase, top].filter(Boolean).join(' · ');
}

function list() {
  const all = load();
  return Object.values(all).map(c => ({
    job_id: c.job_id, job: c.job, client: c.client, phase: c.phase,
    last_updated: c.last_updated, state_count: (c.state || []).length,
    open_count: (c.open_questions || []).length,
  }));
}

// Human-readable rendering for the Drive mirror.
function render(ctx) {
  const L = [];
  L.push(`JOB: ${ctx.job || '?'} (job #${ctx.job_id})`);
  L.push(`Client: ${ctx.client || '?'}${ctx.address ? ' · ' + ctx.address : ''}`);
  if (ctx.phase) L.push(`Phase: ${ctx.phase}`);
  const lu = ctx.last_updated;
  if (lu) L.push(`Last updated: ${lu.date || '?'}${lu.speaker ? ' · ' + lu.speaker : ''}${lu.source ? ' (' + lu.source + ')' : ''}`);
  L.push('');
  L.push('CURRENT STATE');
  if (!(ctx.state || []).length) L.push('  (nothing recorded yet)');
  for (const s of (ctx.state || [])) {
    L.push(`  - ${s.element}: ${s.status} [${s.basis}${s.confirmed ? '' : ', unconfirmed'}, ${s.date}]`);
  }
  if ((ctx.open_questions || []).length) {
    L.push('');
    L.push('OPEN QUESTIONS / UNCONFIRMED');
    for (const q of ctx.open_questions) L.push(`  - ${q.text}${q.confirmed ? '' : ' (unconfirmed)'}`);
  }
  L.push('');
  L.push('TIMELINE (recent)');
  for (const t of (ctx.timeline || []).slice(-12)) L.push(`  - ${t.date}: ${t.event}`);
  L.push('');
  L.push(`(Hermes working memory — Jobber remains the system of record. Updated ${ctx.updated_at || '?'}.)`);
  return L.join('\n');
}

module.exports = { applyUpdate, get, list, byClient, summaryLine, render, load, newContext, norm };

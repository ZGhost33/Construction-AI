'use strict';
// inference.js — candidate store for the inference + proactive layer (§4).
//
// OBSERVATION MODE (the default and the only mode this build runs): the
// on-approve contradiction check and the daily cross-job sweep write CANDIDATES
// here. They are NOT shown as live review cards — they accrue to a log the
// owner skims (daily push + /observe) to judge usefulness before the dial is
// flipped to live. Nothing here ever mutates a job's context or a task; these
// are observations, never silent writes.
//
// Integrity rule (enforced by callers, recorded here): an INFERRED-unconfirmed
// fact never feeds another inference. Inference input is STATED+confirmed state
// only; candidates produced here stay candidates until a human confirms them
// (which, in observation mode, never happens — they just inform the owner).

const fs = require('fs');
const path = require('path');

const DIR = '/root/construction-bi-pipeline';
const STORE = path.join(DIR, 'inference-log.json');
const LOCK = STORE + '.lock';

function load() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return { candidates: [] }; } }
function saveAtomic(obj) {
  const tmp = STORE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, STORE);
}
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } }
function today() { return new Date().toISOString().slice(0, 10); }

function withLock(fn) {
  for (let i = 0; i < 30; i++) {
    try {
      const fd = fs.openSync(LOCK, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
      try { return fn(); } finally { try { fs.unlinkSync(LOCK); } catch {} }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 30000) fs.unlinkSync(LOCK); } catch {}
      sleepSync(200);
    }
  }
  throw new Error('inference: could not acquire lock');
}

// De-dupe key so the same observation isn't logged every run (the daily sweep
// re-derives the same "Harris drywall stalled" until the state changes).
function keyOf(c) { return `${c.type}|${c.job_id || ''}|${(c.dedupe || c.text || '').toLowerCase().slice(0, 80)}`; }

// Add candidates (array). Skips ones already open with the same key. Returns
// how many were newly added.
function add(candidates) {
  if (!candidates || !candidates.length) return 0;
  return withLock(() => {
    const store = load();
    const openKeys = new Set(store.candidates.filter(c => c.status === 'observed').map(keyOf));
    let n = 0;
    for (const c of candidates) {
      if (!c || !c.text) continue;
      const cand = {
        id: 'inf_' + require('crypto').randomBytes(4).toString('hex'),
        type: c.type || 'proactive',          // 'inferred-update' | 'proactive'
        kind: c.kind || null,                  // proactive: stall | quiet | bottleneck
        job_id: c.job_id || null,
        client: c.client || null,
        person: c.person || null,              // bottleneck: the resource everyone waits on
        text: String(c.text).slice(0, 300),
        detail: c.detail ? String(c.detail).slice(0, 400) : null,
        element: c.element || null,            // for inferred-update: the state element
        implication: c.implication || null,    // …and its implied new status
        basis: 'INFERRED',
        confidence: c.confidence || 'medium',
        dedupe: c.dedupe || null,
        status: 'observed',                    // 'observed' | 'confirmed' | 'rejected'
        created_at: new Date().toISOString(),
        date: today(),
      };
      if (openKeys.has(keyOf(cand))) continue;
      store.candidates.push(cand);
      openKeys.add(keyOf(cand));
      n++;
    }
    // bound the log
    if (store.candidates.length > 1000) store.candidates = store.candidates.slice(-1000);
    saveAtomic(store);
    return n;
  });
}

function openCandidates() { return load().candidates.filter(c => c.status === 'observed'); }
function since(dateStr) { return openCandidates().filter(c => String(c.date) >= dateStr); }
function get(id) { return load().candidates.find(c => c.id === id) || null; }

// Resolve a candidate (confirmed/rejected) — used by the live confirm cards.
function setStatus(id, status, by) {
  return withLock(() => {
    const store = load();
    const c = store.candidates.find(x => x.id === id);
    if (!c) return null;
    c.status = status;                 // 'confirmed' | 'rejected'
    c.resolved_at = new Date().toISOString();
    c.resolved_by = by || null;
    saveAtomic(store);
    return c;
  });
}

module.exports = { add, load, openCandidates, since, get, setStatus, today };

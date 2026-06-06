#!/root/.hermes/node/bin/node
'use strict';
/*
 * health-check.js — Cruz system watchdog (runs under trusted Z, --no-agent cron).
 *
 * Prints NOTHING when everything is healthy (so the cron stays silent and does
 * not overwhelm). Prints a concise problem report ONLY when something is wrong,
 * which the cron then delivers to Luis on Telegram. "Fail loud, stay quiet
 * otherwise."  Pass --verbose to always print a status (for manual checks).
 *
 * Checks: cron freshness, gateway processes, capture-drain backlog,
 * review-queue depth/aging, disk space. Read-only — never writes anything live.
 */
const fs = require('fs');
const { execSync } = require('child_process');

const PIPELINE = '/root/construction-bi-pipeline';
const Z = '/root/.hermes/profiles/z';
const now = Date.now();
const problems = [];   // real failures → page Luis
const warnings = [];   // advisory → only shown alongside a problem or with --verbose

function ageMin(iso) { return iso ? (now - Date.parse(iso)) / 60000 : Infinity; }
function fmtAge(min) {
  if (!isFinite(min)) return 'a long time';
  if (min < 90) return Math.round(min) + 'm';
  const h = min / 60;
  if (h < 48) return h.toFixed(1) + 'h';
  return (h / 24).toFixed(1) + 'd';
}

// 1) Cron job freshness + last status
//
// De-dup note: a FAILED run must be paged exactly once, not on every 30-min
// health-check until the next run overwrites the status. Without this, one
// morning hiccup on a *daily* cron generates ~26h of identical Telegram pings.
// We persist the last_run_at we've already alerted on per job; a failure is only
// re-paged if it's a genuinely NEW run (different last_run_at). The "hasn't run
// in X" branch is intentionally NOT de-duped — a cron that's gone dark is an
// ongoing problem worth repeating.
const HC_STATE = Z + '/cron/health-check-state.json';
let hcState = { alertedCronRuns: {} };
try { hcState = JSON.parse(fs.readFileSync(HC_STATE, 'utf8')); hcState.alertedCronRuns = hcState.alertedCronRuns || {}; } catch (_) {}
let hcStateDirty = false;
try {
  const j = JSON.parse(fs.readFileSync(Z + '/cron/jobs.json', 'utf8'));
  const jobs = (j.jobs || []).filter(x => x.enabled);
  for (const job of jobs) {
    const sched = job.schedule || {};
    if (sched.kind === 'once') continue;
    const maxMin = sched.kind === 'interval' ? (sched.minutes || 60) * 2 + 5 : 26 * 60;
    const since = ageMin(job.last_run_at || job.created_at);
    if (since > maxMin) {
      problems.push(`Cron "${job.name}" hasn't run in ${fmtAge(since)} (expected ${sched.display || sched.kind}).`);
    } else if (job.last_status && /fail|error/i.test(String(job.last_status))) {
      const runKey = String(job.last_run_at || job.created_at || '');
      if (hcState.alertedCronRuns[job.name] !== runKey) {
        problems.push(`Cron "${job.name}" last run failed (${job.last_status})` +
          (job.last_error ? `: ${String(job.last_error).slice(0, 120)}` : '') + '.');
        hcState.alertedCronRuns[job.name] = runKey;  // remember: this run is now paged
        hcStateDirty = true;
      }
    }
  }
} catch (e) { problems.push('Could not read cron jobs.json: ' + e.message); }

// 2) Gateway processes alive (office + both field bots)
try {
  const ps = execSync('ps -eo args', { encoding: 'utf8' });
  for (const p of [['z', 'office (Z)'], ['danilo', 'Danilo bot'], ['jorge', 'Jorge bot']]) {
    if (!new RegExp('--profile ' + p[0] + ' gateway run').test(ps)) {
      problems.push(`${p[1]} gateway is NOT running — that bot is offline.`);
    }
  }
} catch (e) { warnings.push('Could not check gateway processes: ' + e.message); }

// 3) Capture-drain backlog (field items stuck before reaching review)
try {
  const f = PIPELINE + '/capture-inbox/inbox.jsonl';
  if (fs.existsSync(f)) {
    const stuck = fs.readFileSync(f, 'utf8').trim().split(/\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(r => r && r.status === 'new' && ageMin(r.ts) > 15);
    if (stuck.length) {
      problems.push(`${stuck.length} field capture(s) stuck in the inbox >15 min — the drain may be down (crew items aren't reaching review).`);
    }
  }
} catch (e) { warnings.push('Could not check capture inbox: ' + e.message); }

// 4) Review queue depth / aging (advisory — liberates, doesn't overwhelm)
try {
  const q = JSON.parse(fs.readFileSync(PIPELINE + '/review-queue.json', 'utf8'));
  const pend = (Array.isArray(q) ? q : []).filter(i => i.status === 'pending');
  if (pend.length) {
    const oldest = Math.max(...pend.map(i => ageMin(i.created_at)));
    if (pend.length >= 15) warnings.push(`Review queue has ${pend.length} items waiting — a /review pass would clear the backlog.`);
    if (oldest > 72 * 60) warnings.push(`Oldest review item has waited ${fmtAge(oldest)} — send /review so nothing ages out.`);
  }
} catch (e) { warnings.push('Could not read review queue: ' + e.message); }

// 5) Disk space
try {
  const cols = execSync('df -P / | tail -1', { encoding: 'utf8' }).trim().split(/\s+/);
  const usePct = parseInt(cols[4], 10);
  if (usePct >= 90) problems.push(`Disk is ${usePct}% full on / — clear space before logs/data can't write.`);
  else if (usePct >= 80) warnings.push(`Disk is ${usePct}% full on /.`);
} catch (e) { /* non-fatal */ }

// ---- output ----
const verbose = process.argv.includes('--verbose');
if (problems.length) {
  console.log('🚨 Cruz system health — needs attention:');
  problems.forEach(p => console.log('• ' + p));
  if (warnings.length) { console.log('\nAlso worth a look:'); warnings.forEach(w => console.log('• ' + w)); }
} else if (verbose) {
  console.log('✅ All systems healthy.');
  if (warnings.length) { console.log('\nAdvisory:'); warnings.forEach(w => console.log('• ' + w)); }
}
// Persist the de-dup state so an already-paged cron failure isn't repeated next
// run. Best-effort: a write failure here must never break the watchdog.
if (hcStateDirty) {
  try {
    const tmp = HC_STATE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(hcState, null, 2));
    fs.renameSync(tmp, HC_STATE);
  } catch (_) { /* non-fatal */ }
}
// healthy + non-verbose → no output → cron stays silent.

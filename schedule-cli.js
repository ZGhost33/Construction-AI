#!/root/.hermes/node/bin/node
'use strict';
/*
 * schedule-cli.js — tentative job scheduling for Cruz Services.
 *
 * When a quote is converted to a job in Jobber, this drafts a week-by-week
 * tentative schedule + a cross-referenced materials list (schedule-planner.js),
 * parks it for review, and on approval writes three places:
 *   - Google Drive: a "Materials & Schedule" doc in the client's folder
 *   - Jobber: a summary note on the job (links to the Drive doc)
 *   - Google Calendar: one event per phase + order reminders for long-lead items
 *
 * Like the rest of the pipeline this is STRICT: scan only DRAFTS and parks a
 * proposal — nothing is written to Jobber/Drive/Calendar until `approve`.
 *
 * Commands:
 *   scan [--seed] [--quiet]        detect newly-converted jobs; --seed = baseline only (no drafts)
 *   list                           pending plans
 *   show <job#|id>                 render a plan
 *   draft "Client" [--job N]       generate + park a plan on demand
 *   approve <job#|id>              write Drive doc + Jobber note + Calendar
 *   calendar <job#|id>             (re)push only the calendar for a stored plan
 *   dismiss <job#|id> [--reason ..]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const STORE = path.join(DIR, 'job-plans.json');
const NODE = process.execPath;
const JOBBER = path.join(DIR, 'jobber-cli.js');
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const ROOT_FOLDER_ID = cfg.google_drive_root_folder_id;
let _set = {};
try { _set = require('./src/config').settings(cfg); } catch { _set = {}; }
const CAL = _set.calendarName || 'Cruz Schedule';

const planner = require('./schedule-planner');
const api = require('./jobber-api');

// ── store ────────────────────────────────────────────────────────────────────
function load() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return []; } }
function save(rows) {
  const tmp = STORE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, STORE);
}
function genId() { return 'jp_' + crypto.randomBytes(5).toString('hex'); }

function findRow(rows, key) {
  if (!key) return null;
  const s = String(key);
  return rows.find(r => r.id === s) ||
    rows.find(r => String(r.job_number) === s.replace(/^#/, '')) || null;
}

// parse "--flag value" / "--flag=value" / boolean "--flag"
function parseFlags(args, bools = new Set()) {
  const flags = {}; const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let m;
    if ((m = /^--([^=]+)=(.*)$/.exec(a))) { flags[m[1]] = m[2]; }
    else if (/^--/.test(a)) {
      const name = a.slice(2);
      if (bools.has(name)) flags[name] = true;
      else { flags[name] = args[i + 1]; i++; }
    } else rest.push(a);
  }
  return { flags, rest };
}

// ── markdown doc for Drive ───────────────────────────────────────────────────
function planToMarkdown(p) {
  const L = [];
  L.push(`# ${p.client} — Job #${p.job_number}: ${p.job_title}`);
  L.push(`**Tentative schedule** · Start ${p.start_date} · ~${p.duration_weeks} week(s)`);
  L.push(`_Auto-generated from the approved quote scope on ${planner.etDate(p.generated_at)}. Tentative — adjust as the job firms up._`);
  if (p.jobber_uri) L.push(`\n[Open job in Jobber](${p.jobber_uri})`);
  if (p.summary) L.push(`\n${p.summary}`);

  L.push('\n## Week-by-week');
  for (const w of p.weeks) {
    L.push(`\n### Week ${w.week} (${w.start} → ${w.end}) — ${w.phase}`);
    for (const t of (w.tasks || [])) L.push(`- ${t}`);
    if (w.materials_onsite && w.materials_onsite.length) {
      L.push(`\n**Materials on site this week:** ${w.materials_onsite.join(', ')}`);
    }
  }

  L.push('\n## Materials list (with on-site-by dates)');
  L.push('\n| ☐ | Item | Qty | Category | On site by | For phase | Notes |');
  L.push('|---|------|-----|----------|-----------|-----------|-------|');
  for (const m of p.materials) {
    const qty = m.qty != null ? `${m.qty}${m.unit ? ' ' + m.unit : ''}` : '';
    const lead = m.long_lead ? ' ⏳' : '';
    L.push(`| ☐ | ${m.item}${lead} | ${qty} | ${m.category || ''} | ${m.needed_by || ''} | ${m.for_phase || ''} | ${m.notes || ''} |`);
  }

  const longLead = (p.materials || []).filter(m => m.long_lead);
  if (longLead.length) {
    L.push('\n## ⏳ Long-lead / order-ahead items');
    for (const m of longLead) L.push(`- **${m.item}** — ${m.order_by ? `**order by ${m.order_by}**, ` : ''}on site by **${m.needed_by}** (${m.for_phase})${m.notes ? ' — ' + m.notes : ''}`);
  }
  if (p.assumptions && p.assumptions.length) {
    L.push('\n## Assumptions');
    for (const a of p.assumptions) L.push(`- ${a}`);
  }
  return L.join('\n') + '\n';
}

// short Jobber note body (the full doc lives in Drive)
function planToJobberNote(p, driveUrl) {
  const L = [];
  L.push(`[Tentative schedule — auto-generated from quote scope]`);
  L.push(`Start ${p.start_date} · ~${p.duration_weeks} week(s).`);
  if (p.summary) L.push('', p.summary);
  L.push('', 'Phases:');
  for (const w of p.weeks) L.push(`  Wk${w.week} (${w.start}): ${w.phase}`);
  const longLead = (p.materials || []).filter(m => m.long_lead);
  if (longLead.length) {
    L.push('', 'Order-ahead:');
    for (const m of longLead) L.push(`  • ${m.item} — ${m.order_by ? `order by ${m.order_by}, ` : ''}on site by ${m.needed_by}`);
  }
  if (driveUrl) L.push('', `Full materials list & week-by-week schedule: ${driveUrl}`);
  return L.join('\n');
}

// ── commands ─────────────────────────────────────────────────────────────────
async function fetchJob(clientName, jobNumber) {
  const client = await api.findClient(clientName);
  const jobs = await api.jobsForClient(client.id);
  let job = jobNumber ? jobs.find(j => j.jobNumber === Number(jobNumber)) : jobs[0];
  if (!job) throw new Error(`Job ${jobNumber ? '#' + jobNumber : ''} not found for ${client.name}. Available: ${jobs.map(j => '#' + j.jobNumber).join(', ')}`);
  return { client, job };
}

async function cmdScan(args) {
  const { flags } = parseFlags(args, new Set(['seed', 'quiet']));
  const rows = load();
  const seen = new Set(rows.map(r => Number(r.job_number)));
  let jobs = await api.recentJobs(60);
  jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (flags.seed) {
    let n = 0;
    for (const j of jobs) {
      if (seen.has(j.jobNumber)) continue;
      rows.push({ id: genId(), job_number: j.jobNumber, client: j.client?.name || '?', job_title: j.title, status: 'preexisting', detected_at: new Date().toISOString() });
      seen.add(j.jobNumber); n++;
    }
    save(rows);
    if (!flags.quiet) console.log(`[schedule-scan] baseline set — marked ${n} existing job(s) as pre-existing; future new jobs will be drafted.`);
    return;
  }

  // Candidate = new (unseen) job with a start date, created recently. Scope
  // (lineItems) is fetched per-candidate below to keep this scan cheap.
  const cutoff = Date.now() - 21 * 86400000;
  const candidates = jobs.filter(j =>
    !seen.has(j.jobNumber) && j.startAt &&
    (!j.createdAt || new Date(j.createdAt).getTime() >= cutoff)
  );

  if (!candidates.length) {
    if (!flags.quiet) console.log('[schedule-scan] no newly-converted jobs to plan.');
    return;
  }

  // Wall-clock budget. Each plan draft is an LLM call that can take 30-100s for a
  // big job; the cron has a 120s hard kill. So we draft only as many jobs as fit
  // in the budget and DEFER the rest — they're left unmarked, so the next run
  // picks them up. This guarantees a run finishes cleanly instead of being killed
  // mid-draft. (Conversions are low-volume, so deferral is rarely more than 1 job.)
  const SCAN_BUDGET_MS = 95000;
  // Per-job cap. A single plan for a very large job can legitimately take 100s+
  // to generate (e.g. an 18-week full-house reno ≈ 47K chars / ~220s). That alone
  // exceeds the cron's 120s hard kill, so we never let one inline draft run past
  // PLAN_CAP_MS: we abort it and re-draft that job in a DETACHED background
  // process (new session, survives the cron's kill) that finishes minutes later
  // and saves the plan itself. Normal jobs (~30s) still draft inline immediately.
  const PLAN_CAP_MS = Number(process.env.PLAN_CAP_MS) || 70000;
  const scanStart = Date.now();
  let deferred = 0;
  const drafted = [];
  const offload = []; // jobs too big to draft inline → drafted in the background
  for (const c of candidates) {
    if (drafted.length && Date.now() - scanStart > SCAN_BUDGET_MS) {
      deferred = candidates.length - (candidates.indexOf(c)); // this one + the rest
      break;
    }
    try {
      const j = await api.getJobWithScope(c.client.id, c.jobNumber);
      if (!j || !(j.lineItems?.nodes?.length)) {
        // No scope to plan from — mark seen so we don't keep re-checking.
        rows.push({ id: genId(), job_number: c.jobNumber, client: c.client?.name || '?', job_title: c.title, status: 'no-scope', detected_at: new Date().toISOString() });
        seen.add(c.jobNumber);
        continue;
      }
      const ac = new AbortController();
      const cap = setTimeout(() => ac.abort(), PLAN_CAP_MS);
      let plan;
      try {
        plan = await planner.generatePlan(j, c.client?.name || '?', { signal: ac.signal });
      } catch (e) {
        if (ac.signal.aborted) {
          // Too big to finish inline within budget → hand off to the background.
          rows.push({ id: genId(), job_number: c.jobNumber, client: c.client?.name || '?', job_title: c.title, status: 'drafting', detected_at: new Date().toISOString() });
          seen.add(c.jobNumber);
          offload.push({ job_number: c.jobNumber, client: c.client?.name || '?' });
          save(rows);
          continue;
        }
        throw e;
      } finally {
        clearTimeout(cap);
      }
      rows.push({
        id: genId(), job_number: c.jobNumber, client: c.client?.name || '?', job_title: c.title,
        start_date: plan.start_date, status: 'pending', detected_at: new Date().toISOString(),
        plan, outputs: null,
      });
      seen.add(c.jobNumber);
      drafted.push(plan);
    } catch (e) {
      // Park a stub so we don't retry forever on a broken job; surface the error.
      rows.push({ id: genId(), job_number: c.jobNumber, client: c.client?.name || '?', job_title: c.title, status: 'error', detected_at: new Date().toISOString(), error: e.message });
      seen.add(c.jobNumber);
    }
    // Persist after EVERY candidate, not just at the end. If the run is killed
    // mid-loop (e.g. the cron's hard timeout on a multi-job morning), completed
    // drafts are already saved and undrafted jobs simply get picked up next run.
    save(rows);
  }
  save(rows);

  // Kick off background drafts for any oversized jobs. One detached `sh -c` chain
  // drafts them SEQUENTIALLY (so they don't race on job-plans.json) in a new
  // session (detached+unref) that outlives this cron process and its 120s kill.
  // Each `draft` call replaces this job's `drafting` stub with the finished plan.
  if (offload.length) {
    try {
      const { spawn } = require('child_process');
      const self = __filename;
      const chain = offload
        .map(o => `${JSON.stringify(process.execPath)} ${JSON.stringify(self)} draft ${JSON.stringify(o.client)} --job ${o.job_number}`)
        .join(' ; ');
      const child = spawn('sh', ['-c', chain], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) {
      // If the spawn itself fails, the stub stays 'drafting'; surface it but don't crash the scan.
      console.error('[schedule-scan] background draft spawn failed:', e.message);
    }
  }

  // Telegram-friendly summary (cron delivers stdout verbatim).
  const L = [];
  if (drafted.length) {
    L.push(`🗓️ ${drafted.length} new job${drafted.length === 1 ? '' : 's'} converted — tentative schedule${drafted.length === 1 ? '' : 's'} drafted for your review:`);
    for (const p of drafted) {
      const longLead = (p.materials || []).filter(m => m.long_lead).length;
      L.push('');
      L.push(`• ${p.client} — Job #${p.job_number} "${p.job_title}"`);
      L.push(`  Start ${p.start_date} · ~${p.duration_weeks} wk · ${p.materials.length} materials${longLead ? ` (${longLead} long-lead)` : ''}`);
      L.push(`  Review:  schedule-cli.js show ${p.job_number}`);
      L.push(`  Approve: schedule-cli.js approve ${p.job_number}`);
    }
  } else if (offload.length) {
    L.push('🗓️ New job conversion detected.');
  }
  if (offload.length) {
    L.push('');
    L.push(`🛠️ ${offload.length} large job${offload.length === 1 ? '' : 's'} ${offload.length === 1 ? 'is' : 'are'} being drafted in the background (big plans take a few minutes) — ${offload.length === 1 ? 'it' : 'they'}'ll appear in \`schedule-cli.js list\` shortly:`);
    for (const o of offload) L.push(`  • ${o.client} — Job #${o.job_number}`);
  }
  if (deferred > 0) {
    L.push('');
    L.push(`⏳ ${deferred} more new job${deferred === 1 ? '' : 's'} detected but deferred to keep this run under its time budget — they'll be drafted on the next scan.`);
  }
  if (L.length) console.log(L.join('\n'));
}

function cmdList() {
  const rows = load().filter(r => r.status === 'pending');
  if (!rows.length) { console.log('No pending schedules.'); return; }
  console.log(`Pending schedules (${rows.length}):\n`);
  rows.forEach((r, i) => {
    const p = r.plan || {};
    const longLead = (p.materials || []).filter(m => m.long_lead).length;
    console.log(`${i + 1}. #${r.job_number} ${r.client} — "${r.job_title}"`);
    console.log(`   start ${r.start_date} · ~${p.duration_weeks} wk · ${(p.materials || []).length} materials${longLead ? ` (${longLead} long-lead)` : ''}  [${r.id}]`);
  });
  console.log('\nshow <job#> · approve <job#> · dismiss <job#>');
}

function cmdShow(key) {
  const rows = load();
  const r = findRow(rows, key);
  if (!r) { console.error(`No plan found for "${key}".`); process.exit(1); }
  if (!r.plan) { console.log(`#${r.job_number} ${r.client} — status: ${r.status}${r.error ? ' (' + r.error + ')' : ''}`); return; }
  if (r.pending_edit) {
    console.log('⚠️  STAGED EDIT (not yet applied) — apply with `edit ' + r.job_number + ' --apply`:\n');
    console.log(planner.renderPlan(r.pending_edit));
    console.log('\n──── changes vs current ────');
    console.log(renderPlanDiff(r.plan, r.pending_edit));
    console.log(`\nstatus: ${r.status} · edit STAGED   [${r.id}]`);
    return;
  }
  console.log(planner.renderPlan(r.plan));
  console.log(`\nstatus: ${r.status}${r.outputs ? ' · written' : ''}   [${r.id}]`);
}

async function cmdDraft(args) {
  const { flags, rest } = parseFlags(args);
  const clientName = rest[0];
  if (!clientName) { console.error('usage: schedule-cli.js draft "Client Name" [--job N]'); process.exit(1); }
  const { client, job } = await fetchJob(clientName, flags.job);
  const plan = await planner.generatePlan(job, client.name);
  const rows = load();
  // replace any existing non-approved plan for this job
  const idx = rows.findIndex(r => Number(r.job_number) === job.jobNumber && r.status !== 'approved');
  const row = {
    id: idx >= 0 ? rows[idx].id : genId(),
    job_number: job.jobNumber, client: client.name, job_title: job.title,
    start_date: plan.start_date, status: 'pending', detected_at: new Date().toISOString(), plan, outputs: null,
  };
  if (idx >= 0) rows[idx] = row; else rows.push(row);
  save(rows);
  console.log(planner.renderPlan(plan));
  console.log(`\nParked for review [${row.id}]. Approve with:  schedule-cli.js approve ${job.jobNumber}`);
}

function writeDriveDoc(plan) {
  const drive = require('./src/drive');
  const md = planToMarkdown(plan);
  const safeTitle = `${plan.client} #${plan.job_number} - Materials & Schedule.md`.replace(/[\/]/g, '-');
  const tmp = path.join('/tmp', safeTitle);
  fs.writeFileSync(tmp, md);
  return drive.uploadFile(ROOT_FOLDER_ID, plan.client, tmp, safeTitle)
    .then(res => { try { fs.unlinkSync(tmp); } catch (_) {} return res; });
}

// Refresh an existing Drive doc's content in place (same fileId / link).
async function updateDriveDoc(plan, fileId) {
  const drive = require('./src/drive');
  const md = planToMarkdown(plan);
  const safeTitle = `${plan.client} #${plan.job_number} - Materials & Schedule.md`.replace(/[\/]/g, '-');
  const tmp = path.join('/tmp', safeTitle);
  fs.writeFileSync(tmp, md);
  try { return await drive.updateFileById(fileId, tmp, safeTitle); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// Concise human diff between two plan versions (for the edit preview).
function renderPlanDiff(a, b) {
  const L = [];
  if ((a.duration_weeks || 0) !== (b.duration_weeks || 0)) {
    L.push(`• Duration: ${a.duration_weeks} → ${b.duration_weeks} week(s)`);
  }
  const aw = new Map((a.weeks || []).map(w => [w.week, w]));
  const bw = new Map((b.weeks || []).map(w => [w.week, w]));
  const weeks = [...new Set([...aw.keys(), ...bw.keys()])].sort((x, y) => x - y);
  for (const wn of weeks) {
    const x = aw.get(wn), y = bw.get(wn);
    if (x && !y) { L.push(`• Wk${wn} removed (${x.phase})`); continue; }
    if (!x && y) { L.push(`• Wk${wn} added: ${y.phase} (${y.start}→${y.end})`); continue; }
    const c = [];
    if (x.phase !== y.phase) c.push(`phase "${x.phase}" → "${y.phase}"`);
    if (x.start !== y.start || x.end !== y.end) c.push(`dates ${x.start}→${x.end}  ⇒  ${y.start}→${y.end}`);
    const xt = (x.tasks || []).length, yt = (y.tasks || []).length;
    if (xt !== yt) c.push(`tasks ${xt}→${yt}`);
    if (c.length) L.push(`• Wk${wn}: ${c.join('; ')}`);
  }
  const key = m => (m.item || '').toLowerCase();
  const am = new Map((a.materials || []).map(m => [key(m), m]));
  const bm = new Map((b.materials || []).map(m => [key(m), m]));
  for (const [k, m] of bm) if (!am.has(k)) L.push(`• + material: ${m.item} (need by ${m.needed_by})`);
  for (const [k, m] of am) if (!bm.has(k)) L.push(`• − material: ${m.item}`);
  for (const [k, m] of bm) {
    const o = am.get(k);
    if (o && (o.needed_by !== m.needed_by || o.order_by !== m.order_by)) {
      L.push(`• Δ ${m.item}: need ${o.needed_by}→${m.needed_by}` +
        (o.order_by !== m.order_by ? `, order ${o.order_by || '—'}→${m.order_by || '—'}` : ''));
    }
  }
  for (const n of (b.assumptions || []).filter(s => /^EDIT/i.test(s))) L.push(`• ${n}`);
  return L.length ? L.join('\n') : '(no structural changes detected)';
}

async function cmdApprove(args) {
  const { flags, rest } = parseFlags(args, new Set(['no-calendar', 'no-drive', 'no-note']));
  const rows = load();
  const r = findRow(rows, rest[0]);
  if (!r) { console.error(`No plan found for "${rest[0]}".`); process.exit(1); }
  if (!r.plan) { console.error(`#${r.job_number} has no plan (status ${r.status}).`); process.exit(1); }
  const p = r.plan;
  const outputs = r.outputs || {};
  const report = [];

  // 1) Drive doc
  if (!flags['no-drive'] && !outputs.drive_url) {
    try {
      const res = await writeDriveDoc(p);
      outputs.drive_file_id = res.id; outputs.drive_url = res.webViewLink;
      report.push(`✓ Drive doc: ${res.webViewLink}`);
    } catch (e) { report.push(`✗ Drive upload failed: ${e.message}`); }
  } else if (outputs.drive_url) report.push(`• Drive doc already filed: ${outputs.drive_url}`);

  // 2) Jobber note (links the Drive doc)
  if (!flags['no-note'] && !outputs.jobber_note) {
    try {
      const note = planToJobberNote(p, outputs.drive_url);
      const out = execFileSync(NODE, [JOBBER, 'note', p.client, note, '--job', String(p.job_number)], { encoding: 'utf8' });
      outputs.jobber_note = true;
      report.push(`✓ Jobber note posted on #${p.job_number}` + (/✓|added|created/i.test(out) ? '' : `\n   ${out.trim().slice(0, 200)}`));
    } catch (e) { report.push(`✗ Jobber note failed: ${(e.stdout || e.message || '').toString().trim().slice(0, 200)}`); }
  } else if (outputs.jobber_note) report.push('• Jobber note already posted');

  // 3) Calendar
  if (!flags['no-calendar']) {
    try {
      const cal = require('./calendar-writer');
      const res = await cal.writeScheduleToCalendar(p);
      outputs.calendar = { count: res.created.length, replaced: res.replaced };
      report.push(`✓ Calendar: ${res.created.length} event(s) on "${CAL}"${res.replaced ? ` (replaced ${res.replaced})` : ''}`);
    } catch (e) {
      outputs.calendar_pending = true;
      report.push(`⏳ Calendar not written: ${e.message}\n   (Run \`schedule-cli.js calendar ${p.job_number}\` after enabling/sharing the calendar.)`);
    }
  }

  r.outputs = outputs;
  r.status = 'approved';
  r.approved_at = new Date().toISOString();
  save(rows);
  console.log(`Approved schedule for ${p.client} #${p.job_number}:\n` + report.map(s => '  ' + s).join('\n'));
}

function cmdPreview(key) {
  const rows = load();
  const r = findRow(rows, key);
  if (!r || !r.plan) { console.error(`No plan found for "${key}".`); process.exit(1); }
  console.log('================ DRIVE DOC (Markdown) ================\n');
  console.log(planToMarkdown(r.plan));
  console.log('\n================ JOBBER NOTE ================\n');
  console.log(planToJobberNote(r.plan, '<drive-link-inserted-on-approve>'));
  console.log('\n(Nothing written. Use `approve ' + r.job_number + '` to file these + calendar.)');
}

async function cmdCalendar(key) {
  const rows = load();
  const r = findRow(rows, key);
  if (!r || !r.plan) { console.error(`No plan found for "${key}".`); process.exit(1); }
  const cal = require('./calendar-writer');
  const res = await cal.writeScheduleToCalendar(r.plan);
  r.outputs = r.outputs || {};
  r.outputs.calendar = { count: res.created.length, replaced: res.replaced };
  delete r.outputs.calendar_pending;
  save(rows);
  console.log(`✓ Calendar updated for #${r.job_number}: ${res.created.length} event(s)${res.replaced ? ` (replaced ${res.replaced})` : ''}.`);
}

function cmdDismiss(args) {
  const { flags, rest } = parseFlags(args);
  const rows = load();
  const r = findRow(rows, rest[0]);
  if (!r) { console.error(`No plan found for "${rest[0]}".`); process.exit(1); }
  r.status = 'dismissed';
  r.dismissed_at = new Date().toISOString();
  if (flags.reason) r.reason = flags.reason;
  save(rows);
  console.log(`Dismissed schedule for #${r.job_number} ${r.client}${flags.reason ? ` — ${flags.reason}` : ''}.`);
}

// ── edit an existing schedule (surgical) ─────────────────────────────────────
// Two-step like draft→approve:
//   edit <job#> "what to change"   → computes + STAGES the edit, prints a diff
//   edit <job#> --apply            → commits: re-pushes calendar + refreshes the
//                                    Drive doc in place (only if the plan is
//                                    already approved/live). --note also posts a
//                                    short Jobber revision note.
async function cmdEdit(args) {
  const { flags, rest } = parseFlags(args, new Set(['apply', 'note', 'no-drive']));
  const rows = load();
  const r = findRow(rows, rest[0]);
  if (!r) { console.error(`No plan found for "${rest[0]}".`); process.exit(1); }
  if (!r.plan) { console.error(`#${r.job_number} has no plan (status ${r.status}).`); process.exit(1); }

  if (flags.apply) {
    const next = r.pending_edit;
    if (!next) { console.error(`No staged edit for #${r.job_number}. First run: edit ${r.job_number} "your change"`); process.exit(1); }
    const report = [];
    r.plan = next;
    delete r.pending_edit;
    r.edited_at = new Date().toISOString();
    if (r.status === 'approved') {
      r.outputs = r.outputs || {};
      try {
        const cal = require('./calendar-writer');
        const res = await cal.writeScheduleToCalendar(next);
        r.outputs.calendar = { count: res.created.length, replaced: res.replaced };
        report.push(`✓ Calendar: ${res.created.length} event(s) (replaced ${res.replaced})`);
      } catch (e) { report.push(`✗ Calendar update failed: ${e.message}`); }
      if (!flags['no-drive']) {
        try {
          if (r.outputs.drive_file_id) {
            const res = await updateDriveDoc(next, r.outputs.drive_file_id);
            r.outputs.drive_url = res.webViewLink || r.outputs.drive_url;
            report.push(`✓ Drive doc refreshed (same link): ${r.outputs.drive_url}`);
          } else {
            const res = await writeDriveDoc(next);
            r.outputs.drive_file_id = res.id; r.outputs.drive_url = res.webViewLink;
            report.push(`✓ Drive doc created: ${res.webViewLink}`);
          }
        } catch (e) { report.push(`✗ Drive refresh failed: ${e.message}`); }
      }
      if (flags.note) {
        try {
          const note = `[Schedule revised ${planner.etDate()}] See updated plan: ${r.outputs.drive_url || ''}`;
          execFileSync(NODE, [JOBBER, 'note', next.client, note, '--job', String(r.job_number)], { encoding: 'utf8' });
          report.push('✓ Jobber revision note posted');
        } catch (e) { report.push(`✗ Jobber note failed: ${(e.stdout || e.message || '').toString().trim().slice(0, 160)}`); }
      }
    } else {
      report.push(`• Parked plan updated (status ${r.status}; nothing live to rewrite until approve).`);
    }
    save(rows);
    console.log(`Applied edit to #${r.job_number}:\n` + report.map(s => '  ' + s).join('\n'));
    return;
  }

  // preview/stage mode
  const instruction = rest.slice(1).join(' ');
  if (!instruction) { console.error('Usage: schedule-cli.js edit <job#> "what to change"   (then: edit <job#> --apply)'); process.exit(1); }
  const next = await planner.applyEdit(r.plan, instruction);
  r.pending_edit = next;
  save(rows);
  const live = r.status === 'approved';
  console.log(`Proposed edit for #${r.job_number} "${r.plan.job_title}"\n   instruction: ${instruction}\n`);
  console.log(renderPlanDiff(r.plan, next));
  console.log(`\nReview full revised plan:  schedule-cli.js show ${r.job_number}`);
  console.log(`Apply:  schedule-cli.js edit ${r.job_number} --apply` +
    (live ? '   (re-pushes calendar + refreshes Drive doc)' : '   (updates the parked plan)'));
}

// ── ad-hoc standalone calendar events ────────────────────────────────────────
//   event add "<natural language>" [--yes]   parse → preview; --yes writes it
//   event list [--days N]                      upcoming ad-hoc events
//   event delete <aid|id|summary>              remove one
async function cmdEvent(args) {
  const sub = args[0];
  const { flags, rest } = parseFlags(args.slice(1), new Set(['yes']));
  const cal = require('./calendar-writer');

  if (sub === 'add') {
    const text = rest.join(' ');
    if (!text) { console.error('Usage: schedule-cli.js event add "inspection Thursday 9am" [--yes]'); process.exit(1); }
    const ev = await planner.parseAdhocEvent(text);
    if (ev.needs_clarification) {
      console.log(`Need a bit more to schedule that: ${ev.needs_clarification}`);
      return;
    }
    const when = ev.all_day
      ? `${ev.start}${ev.end && ev.end !== ev.start ? ' → ' + ev.end : ''} (all day)`
      : `${ev.start.replace('T', ' ')}${ev.end ? ' → ' + ev.end.replace('T', ' ').slice(11) : ''} ET`;
    if (!flags.yes) {
      console.log(`Will add to "${CAL}":\n   ${ev.summary}\n   ${when}` +
        (ev.location ? `\n   @ ${ev.location}` : '') + (ev.notes ? `\n   ${ev.notes}` : ''));
      console.log(`\nConfirm with:  schedule-cli.js event add "${text}" --yes`);
      return;
    }
    const res = await cal.addAdhocEvent(ev);
    console.log(`✓ Added to ${CAL} [${res.aid}]: ${res.summary} — ${when}`);
    return;
  }

  if (sub === 'list') {
    const days = flags.days ? Number(flags.days) : 60;
    const items = await cal.listAdhocEvents({ days });
    if (!items.length) { console.log(`No ad-hoc events on ${CAL} in the next ${days} days.`); return; }
    console.log(`Ad-hoc events on ${CAL} (next ${days} days):`);
    for (const e of items) {
      const when = e.all_day ? e.start + ' (all day)' : e.start.replace('T', ' ').slice(0, 16) + ' ET';
      console.log(`  [${e.aid || '------'}] ${when} — ${e.summary}${e.location ? ' @ ' + e.location : ''}`);
    }
    return;
  }

  if (sub === 'delete' || sub === 'remove' || sub === 'cancel') {
    const key = rest.join(' ');
    if (!key) { console.error('Usage: schedule-cli.js event delete <id|summary>'); process.exit(1); }
    const res = await cal.deleteAdhocEvent(key);
    console.log(`✓ Deleted from ${CAL}: ${res.summary}`);
    return;
  }

  console.log('Usage: schedule-cli.js event add "<text>" [--yes] | event list [--days N] | event delete <id|summary>');
}

// ── dispatch ─────────────────────────────────────────────────────────────────
(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'scan':     await cmdScan(args); break;
    case 'list':     cmdList(); break;
    case 'show':     cmdShow(args[0]); break;
    case 'preview':  cmdPreview(args[0]); break;
    case 'draft':    await cmdDraft(args); break;
    case 'approve':  await cmdApprove(args); break;
    case 'edit':     await cmdEdit(args); break;
    case 'calendar': await cmdCalendar(args[0]); break;
    case 'event':    await cmdEvent(args); break;
    case 'dismiss':  cmdDismiss(args); break;
    default:
      console.log('Commands: scan [--seed] | list | show <job#> | draft "Client" [--job N] | approve <job#> | edit <job#> "change" [--apply] | calendar <job#> | event add|list|delete | dismiss <job#> [--reason ..]');
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

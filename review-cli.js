#!/usr/bin/env node
'use strict';
// review-cli.js — review/clear the Pocket recording review queue.
//
// Deterministic helper invoked by the `review` skill (and usable by hand).
// All Jobber writes go through jobber-cli.js (never direct). A closed-roster
// guard ensures we never write a note to a client that isn't already in
// config.json — the model can suggest, but a human must confirm the exact name.
//
// Usage:
//   review-cli.js list
//   review-cli.js show    <n|rq_id>
//   review-cli.js approve <n|rq_id> [--client "Exact Name"] [--job N] [--note "override text"] [--dry-run]
//   review-cli.js dismiss <n|rq_id> [--reason "why"]
//
// Indices (n) are 1-based over PENDING items ordered by created_at. After an
// approve/dismiss the indices shift, so prefer the rq_ id or re-run `list`.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const DIR = '/root/construction-bi-pipeline';
const QUEUE = path.join(DIR, 'review-queue.json');
const CONFIG = path.join(DIR, 'config.json');
const NODE = '/root/.hermes/node/bin/node';
const JOBBER = path.join(DIR, 'jobber-cli.js');
const DRIVE = path.join(DIR, 'drive-cli.js');
const JOBCTX = path.join(DIR, 'job-context-cli.js');
const INFCLI = path.join(DIR, 'inference-cli.js');
let jobctx = null;
try { jobctx = require('./job-context.js'); } catch { /* optional */ }
const COMMITMENTS = path.join(DIR, 'commitments.json');
const crypto = require('crypto');

// ── helpers ───────────────────────────────────────────────────────────────────
function loadQueue() { try { return JSON.parse(fs.readFileSync(QUEUE, 'utf8')); } catch { return []; } }
function saveQueue(q) { fs.writeFileSync(QUEUE, JSON.stringify(q, null, 2)); }
function clientList() {
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  return (c.businesses[0].clients || []);
}
function peopleList() {
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  return (c.businesses[0].people || []);
}
// Lenient person resolution for auto-extraction: return the canonical roster
// name on a confident match, else null (caller keeps the raw text).
function resolvePersonLenient(arg) {
  const want = norm(arg);
  if (!want) return null;
  const list = peopleList();
  const exact = list.find(p => norm(p.name) === want);
  if (exact) return exact.name;
  // first-name / substring match, only if unambiguous
  const subs = list.filter(p => { const n = norm(p.name); return n === want || n.split(' ')[0] === want || n.startsWith(want + ' '); });
  if (subs.length === 1) return subs[0].name;
  return null;
}

// Parse the "Commitments:" section of a recording note into structured items.
// Format (one per line): "• Who → What — YYYY-MM-DD"  (date and arrow optional)
function parseCommitmentsSection(note) {
  const lines = String(note || '').split('\n');
  const start = lines.findIndex(l => /^\s*commitments\s*:/i.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*$/.test(raw)) { if (out.length) break; else continue; }      // blank ends the section once we've started
    if (/^\s*[A-Za-z][A-Za-z ]+:\s*$/.test(raw)) break;                    // a new "Header:" line ends it
    const m = raw.match(/^\s*[•\-\*]\s+(.*\S)\s*$/);                       // must be a bullet
    if (!m) { if (out.length) break; else continue; }
    let body = m[1];
    let due = null;
    const dm = body.match(/[—–-]\s*~?(\d{4}-\d{2}-\d{2})\s*$/);            // trailing — YYYY-MM-DD
    if (dm) { due = dm[1]; body = body.slice(0, dm.index).trim(); }
    let who = null, what = body;
    const am = body.match(/^(.{1,40}?)\s*(?:→|->)\s*(.*\S)\s*$/);          // Who → What
    if (am) { who = am[1].trim(); what = am[2].trim(); }
    if (what) out.push({ whoRaw: who, what, due });
  }
  return out;
}

// Append extracted commitments to the ledger. Idempotent per (source, what).
// Returns the number actually added.
function extractCommitmentsFromNote(note, { client, job, recordingId }) {
  const parsed = parseCommitmentsSection(note);
  if (!parsed.length) return 0;
  let ledger; try { ledger = JSON.parse(fs.readFileSync(COMMITMENTS, 'utf8')); } catch { ledger = []; }
  const source = recordingId ? `recording:${recordingId}` : 'recording';
  const seen = new Set(ledger.filter(x => x.source === source).map(x => norm(x.what)));
  let added = 0;
  for (const p of parsed) {
    if (seen.has(norm(p.what))) continue;
    const canon = p.whoRaw ? resolvePersonLenient(p.whoRaw) : null;
    ledger.push({
      id: 'cm_' + crypto.randomBytes(5).toString('hex'),
      created_at: new Date().toISOString(),
      who: canon,
      who_raw: canon ? null : (p.whoRaw || null),
      what: p.what,
      client: client || null,
      job: job ? parseInt(job, 10) : null,
      due: p.due || null,
      source,
      status: 'open',
      done_at: null,
      note: null,
    });
    seen.add(norm(p.what));
    added++;
  }
  if (added) fs.writeFileSync(COMMITMENTS, JSON.stringify(ledger, null, 2));
  return added;
}
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
function pendingItems(q) {
  return q.filter(x => x.status === 'pending')
          .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}
// resolve a ref ("3" or "rq_abc123") to an index into the full queue array
function resolveIndex(q, ref) {
  if (/^rq_/.test(ref)) {
    const idx = q.findIndex(x => x.id === ref);
    return idx >= 0 ? idx : null;
  }
  const n = parseInt(ref, 10);
  if (!Number.isInteger(n) || n < 1) return null;
  const pend = pendingItems(q);
  const item = pend[n - 1];
  if (!item) return null;
  return q.findIndex(x => x.id === item.id);
}
// closed-roster resolution: returns {name} on a confident match, else {error, suggestions}
function resolveClient(arg) {
  const list = clientList();
  const want = norm(arg);
  if (!want) return { error: 'no client name', suggestions: [] };
  const exact = list.find(c => norm(c.name) === want);
  if (exact) return { name: exact.name };
  const scored = list.map(c => ({ name: c.name, d: lev(norm(c.name), want) }))
                     .sort((a, b) => a.d - b.d);
  return { error: `client "${arg}" not in roster`, suggestions: scored.slice(0, 3).map(s => s.name) };
}
function rosterStatus(name) {
  const r = resolveClient(name);
  return r.error ? '⚠ not in roster' : (norm(r.name) === norm(name) ? '✓' : `→ ${r.name}`);
}
// minimal flag parser
function parseFlags(args) {
  const out = { _: [] };
  const bools = new Set(['dry-run', 'no-expense']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--') && bools.has(a.slice(2))) out[a.slice(2)] = true;
    else if (a.startsWith('--')) { out[a.slice(2)] = args[i + 1]; i++; }
    else out._.push(a);
  }
  return out;
}

// ── commands ────────────────────────────────────────────────────────────────
function cmdList() {
  const q = loadQueue();
  const pend = pendingItems(q);
  if (!pend.length) { console.log('✅ Review queue is empty — nothing pending.'); return; }
  const lines = [`📋 *${pend.length} pending recording${pend.length > 1 ? 's' : ''}*`, ''];
  pend.forEach((it, i) => {
    const date = (it.recording_date || '?').slice(0, 10);
    const client = it.proposed_client && it.proposed_client !== 'UNKNOWN' ? it.proposed_client : 'unknown client';
    const conf = it.confidence || '?';
    const rs = it.proposed_client && it.proposed_client !== 'UNKNOWN' ? rosterStatus(it.proposed_client) : '';
    lines.push(`*${i + 1}.* ${date} — ${client} ${rs ? '(' + rs + ')' : ''} _[${conf}]_`);
    lines.push(`    bucket: ${it.bucket || '?'}  ·  id: \`${it.id}\``);
    if (it.proposed_job) lines.push(`    job: ${it.proposed_job}`);
    if (it.proposed_expense && it.proposed_expense.amount != null) {
      lines.push(`    💵 $${Number(it.proposed_expense.amount).toFixed(2)} _(🤖 auto-read from photo — confirm on approve)_`);
    }
    const note = (it.proposed_note || it.analysis_summary || '').replace(/\s+/g, ' ').trim();
    if (note) lines.push(`    _${note.slice(0, 120)}${note.length > 120 ? '…' : ''}_`);
    lines.push('');
  });
  lines.push('`show N` for detail · `approve N` / `dismiss N` to act (N or id).');
  console.log(lines.join('\n'));
}

function cmdShow(ref) {
  const q = loadQueue();
  const idx = resolveIndex(q, ref);
  if (idx === null) { console.log(`❌ No pending item "${ref}".`); process.exit(1); }
  const it = q[idx];
  const L = [];
  L.push(`*Item ${ref}* · id \`${it.id}\` · status: ${it.status}`);
  if (it.source !== 'field_capture') L.push(`Recording: ${it.recording_date} (${it.recording_id})`);
  L.push(`Device: ${it.device_person || '?'}`);
  L.push(`Proposed client: *${it.proposed_client}* (${rosterStatus(it.proposed_client)})`);
  if (it.proposed_job) L.push(`Proposed job: ${it.proposed_job}`);
  L.push(`Confidence: ${it.confidence} · bucket: ${it.bucket}`);
  const sig = it.signals || {};
  L.push(`Signals → device: ${sig.device || '-'} · content: ${sig.content || '-'} (${sig.content_confidence || '-'}) · voice: ${sig.voice ? JSON.stringify(sig.voice) : 'none'}`);
  if (it.new_client_data) L.push(`New-client data: ${JSON.stringify(it.new_client_data)}`);
  if (it.source === 'field_capture') {
    L.push(`Source: 📲 field capture (${it.kind || 'note'})`);
    if (it.attachment_path) L.push(`Attachment: ${it.attachment_name || it.attachment_path}${fs.existsSync(it.attachment_path) ? '' : '  ⚠ FILE MISSING'}`);
    if (it.needs_routing) L.push(`⚠ Client not matched — field tech typed "${it.proposed_client}". Suggestions: ${(it.suggestions || []).join(', ') || '(none)'}. Approve with --client "Exact Name".`);
    if (it.proposed_expense && it.proposed_expense.amount != null) {
      const pe = it.proposed_expense;
      L.push(`💵 *Auto-read from the photo — not yet confirmed:* $${Number(pe.amount).toFixed(2)} — ${pe.description || ''}${pe.date ? '  (' + pe.date + ')' : ''}`);
      L.push(`   🤖 OCR's best guess — check it against the receipt. On approve this logs the expense to ${it.proposed_client}'s active job (which makes it confirmed). Fix the amount with --amount N, or skip with --no-expense.`);
    }
  }
  L.push('');
  L.push('— transcript snippet —');
  L.push(it.transcript_snippet || (it.source === 'field_capture' ? '(field capture — no recording)' : '(none)'));
  L.push('');
  L.push('— proposed note —');
  L.push(it.proposed_note || '(none)');
  console.log(L.join('\n'));
}

function cmdApprove(ref, flags) {
  const q = loadQueue();
  const idx = resolveIndex(q, ref);
  if (idx === null) { console.log(`❌ No pending item "${ref}".`); process.exit(1); }
  const it = q[idx];
  if (it.status !== 'pending') { console.log(`⚠ Item ${it.id} is already "${it.status}". Nothing done.`); process.exit(1); }

  const clientArg = flags.client || it.proposed_client;
  if (!clientArg || clientArg === 'UNKNOWN') {
    console.log(`❌ No client to route to. This looks like a new prospect — create the client first:\n   jobber-cli.js create-client "Name" "Address" ...\nthen: review-cli.js approve ${ref} --client "Name"`);
    process.exit(1);
  }
  const r = resolveClient(clientArg);
  if (r.error) {
    console.log(`❌ ${r.error}. Closest roster names:\n   - ${r.suggestions.join('\n   - ')}\nRe-run with the exact one, e.g.: review-cli.js approve ${ref} --client "${r.suggestions[0]}"`);
    process.exit(1);
  }
  const canonical = r.name;
  const noteText = flags.note || it.proposed_note;
  if (!noteText || !noteText.trim()) { console.log('❌ No note text to write (and no --note override given).'); process.exit(1); }
  const jobNum = flags.job && /^\d+$/.test(String(flags.job)) ? String(flags.job) : null;

  const args = [JOBBER, 'note', canonical, noteText];
  if (jobNum) args.push('--job', jobNum);

  const hasAttachment = it.attachment_path && fs.existsSync(it.attachment_path);
  if (it.attachment_path && !hasAttachment) {
    console.log(`⚠ Note: attachment recorded (${it.attachment_name || it.attachment_path}) but file is missing on disk — note will post without it.`);
  }

  // Receipt → expense: if OCR pre-filled an expense, plan to log it on approve.
  // Office can override the amount (--amount N) or skip it (--no-expense).
  let expensePlan = null;
  if (it.proposed_expense && it.proposed_expense.amount != null && !flags['no-expense']) {
    const amt = (flags.amount != null && /^\d+(\.\d+)?$/.test(String(flags.amount))) ? Number(flags.amount) : Number(it.proposed_expense.amount);
    if (!Number.isNaN(amt) && amt > 0) expensePlan = { amount: amt, description: it.proposed_expense.description || 'Field receipt' };
  }

  if (flags.dryRun) {
    console.log(`🧪 DRY RUN — would write note to *${canonical}*${jobNum ? ' job #' + jobNum : ' (auto-route by scope)'}:`);
    console.log(noteText.slice(0, 400) + (noteText.length > 400 ? '…' : ''));
    if (hasAttachment) console.log(`🧪 …and would file "${it.attachment_name}" to ${canonical}'s Drive folder.`);
    if (expensePlan) console.log(`🧪 …and would log an expense to ${canonical}: $${expensePlan.amount.toFixed(2)} — ${expensePlan.description}`);
    return;
  }

  let result = '';
  try {
    result = execFileSync(NODE, args, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    console.log(`❌ Jobber write FAILED — item left pending.\n${(err.stderr || err.message || '').toString().slice(0, 500)}`);
    process.exit(1);
  }

  let driveResult = '';
  if (hasAttachment) {
    try {
      driveResult = execFileSync(NODE, [DRIVE, 'upload', it.attachment_path, canonical, it.attachment_name || ''],
        { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    } catch (err) {
      // Note already posted; don't fail the whole approve. Flag for retry.
      it.drive_error = (err.stderr || err.message || '').toString().slice(0, 400);
      console.log(`⚠ Note posted, but Drive upload FAILED: ${it.drive_error}\n   Re-file manually: drive-cli.js upload "${it.attachment_path}" "${canonical}"`);
    }
  }

  // Auto-extract commitments from the note's "Commitments:" section so verbal
  // promises captured in the recording become tracked follow-ups (Phase 2).
  let committed = 0;
  if (it.source !== 'field_capture') {
    try { committed = extractCommitmentsFromNote(noteText, { client: canonical, job: jobNum, recordingId: it.recording_id || it.id }); }
    catch (err) { console.log(`⚠ Note posted; commitment extraction skipped (${(err.message || '').slice(0, 120)}).`); }
  }

  // Update the job's living context file (Intelligent Jobs §3). This approved
  // segment is already scoped to ONE job (§A), so its state writes only into
  // that job's context — cross-job contamination is structurally impossible.
  // Non-fatal: the note is already in Jobber; a context-write failure is logged
  // and never blocks the approval. Keyed on jobNum (no job# → skip, can't key).
  let contextMsg = '';
  if (jobNum) {
    try {
      const speaker = it.device_person || (it.signals && it.signals.content) || '';
      const ctxArgs = [JOBCTX, 'update', '--job', jobNum, '--client', canonical, '--note', noteText,
        '--recording-id', it.recording_id || it.id, '--source', it.source || 'recording'];
      if (it.proposed_job) ctxArgs.push('--job-title', String(it.proposed_job));
      if (speaker) ctxArgs.push('--speaker', String(speaker));
      const cr = execFileSync(NODE, ctxArgs, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      it.context_result = cr.slice(0, 300);
      contextMsg = `\n${cr.split('\n').pop()}`;
    } catch (err) {
      it.context_error = (err.stderr || err.message || '').toString().slice(0, 300);
      // Quiet by default — context is the agent's memory, not a user deliverable.
    }
    // Inferred-state check (§4.1), DETACHED so it never slows the approve tap.
    // Observation mode: it only logs candidates to the inference log; nothing
    // surfaces or writes state. Fire-and-forget — review-cli exits without it.
    try {
      const child = spawn(NODE, [INFCLI, 'infer-on-approve', '--job', jobNum, '--client', canonical, '--note', noteText],
        { detached: true, stdio: 'ignore' });
      child.unref();
    } catch { /* best-effort */ }
  }

  // Log the receipt expense (note already posted; failure here is non-fatal).
  let expenseMsg = '';
  if (expensePlan) {
    try {
      const er = execFileSync(NODE, [JOBBER, 'expense', canonical, String(expensePlan.amount), expensePlan.description],
        { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      it.expense_result = er.slice(0, 400);
      expenseMsg = `\n💵 Logged expense to ${canonical}: $${expensePlan.amount.toFixed(2)} — ${expensePlan.description}.\n${er}`;
    } catch (err) {
      it.expense_error = (err.stderr || err.message || '').toString().slice(0, 400);
      expenseMsg = `\n⚠ Note/file done, but expense log FAILED: ${it.expense_error}\n   Log it manually: jobber-cli.js expense "${canonical}" ${expensePlan.amount} "${expensePlan.description}"`;
    }
  }

  it.status = 'approved';
  it.approved_at = new Date().toISOString();
  it.approved_client = canonical;
  it.approved_job = jobNum;
  it.jobber_result = result.toString().trim().slice(0, 500);
  if (driveResult) it.drive_result = driveResult.slice(0, 500);
  if (committed) it.commitments_extracted = committed;
  saveQueue(q);
  console.log(`✅ Approved — note written to *${canonical}*${jobNum ? ' (job #' + jobNum + ')' : ''}.\n${it.jobber_result}` +
    (driveResult ? `\n📎 Filed "${it.attachment_name}" to ${canonical}'s Drive folder.\n${driveResult}` : '') +
    (committed ? `\n📌 Logged ${committed} commitment${committed > 1 ? 's' : ''} to your follow-up list (\`commit-cli.js list\`).` : '') +
    contextMsg +
    expenseMsg);
}

function cmdDismiss(ref, flags) {
  const q = loadQueue();
  const idx = resolveIndex(q, ref);
  if (idx === null) { console.log(`❌ No pending item "${ref}".`); process.exit(1); }
  const it = q[idx];
  if (it.status !== 'pending') { console.log(`⚠ Item ${it.id} is already "${it.status}". Nothing done.`); process.exit(1); }
  it.status = 'dismissed';
  it.dismissed_at = new Date().toISOString();
  it.dismiss_reason = flags.reason || '';
  saveQueue(q);
  console.log(`🗑️ Dismissed item ${it.id} (${it.proposed_client || 'unknown'})${flags.reason ? ' — ' + flags.reason : ''}. Not written to Jobber.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Card cycler — emits JSON render payloads consumed by the `review-buttons`
// Hermes plugin, which applies them in place (editMessageText). All Jobber
// writes still flow through approve/dismiss; these commands only render/navigate
// and mutate LOCAL queue fields (proposed_client / speaker / note overrides).
// Stateless: the active filter rides in callback_data as a 1-char code.
// ─────────────────────────────────────────────────────────────────────────────
const METRICS = path.join(DIR, 'ui-metrics.json');
const FILTERS = { a: 'all', u: 'unknown', l: 'lowconf' };
const FILTER_LABELS = { a: 'all', u: 'unknown client', l: 'low confidence' };
function fcode(c) { return FILTERS[c] ? c : 'a'; }
// config-driven default filter: businesses[0].telegram_ui.review.default_filter
function defaultFilter() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return fcode((((c.businesses[0] || {}).telegram_ui || {}).review || {}).default_filter);
  } catch { return 'a'; }
}
function outJSON(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

// strip legacy-Markdown-significant chars from dynamic text so a stray `_`/`*`/`[`
// in a transcript can never break Telegram's Markdown parse.
function clean(s, max) {
  let t = String(s == null ? '' : s).replace(/[`*_\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}
// like clean() but keeps line breaks — for multi-paragraph fields (full note)
function cleanML(s, max) {
  let t = String(s == null ? '' : s).replace(/[`*_\[\]]/g, '').replace(/[ \t]+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}
function today() { return new Date().toISOString().slice(0, 10); }

function matchesFilter(it, code) {
  if (code === 'u') return !it.proposed_client || it.proposed_client === 'UNKNOWN' || it.needs_routing;
  if (code === 'l') return it.confidence && String(it.confidence).toLowerCase() !== 'high';
  return true; // 'a' = all
}
function filteredPending(q, code) { return pendingItems(q).filter(it => matchesFilter(it, code)); }

function speakerLabel(it) {
  if (it.proposed_speaker) return clean(it.proposed_speaker, 40);
  const v = (it.signals || {}).voice;
  if (v && typeof v === 'object') {
    if (v.name) return `${clean(v.name, 30)}${v.confidence != null ? ` (${Math.round(v.confidence)}%)` : ''}`;
    const names = Object.values(v).filter(x => typeof x === 'string');
    if (names.length) return clean(names.join(', '), 40);
  }
  return null;
}

function cardText(it, i, n, code) {
  const L = [];
  L.push(`*Review ${i + 1} of ${n}*${code !== 'a' ? ` · _${FILTER_LABELS[code]}_` : ''}`);
  const src = it.device_person || (it.source === 'field_capture' ? 'field capture' : (it.source || 'recording'));
  const date = String(it.recording_date || it.created_at || '').slice(0, 10) || '?';
  L.push(`🎙 ${clean(src, 30)} · ${date}`);
  // When a recording covered several jobs, this card is one slice of it.
  if (it.segment_count && it.segment_count > 1) {
    L.push(`🧩 _Job ${(it.segment_index || 0) + 1} of ${it.segment_count} in one recording${it.segment_topic ? ` · ${clean(it.segment_topic, 28)}` : ''}_`);
  }
  L.push(`Confidence: ${clean(it.confidence || '?', 12)} · bucket: ${clean(String(it.bucket || '?').replace(/_/g, ' '), 16)}`);
  const sig = it.signals || {};
  L.push(`Signals: device ${clean(sig.device || '—', 16)} · content ${clean(sig.content || '—', 16)}${sig.content_confidence ? ` (${clean(sig.content_confidence, 8)})` : ''} · voice ${sig.voice ? '✓' : '—'}`);
  const snip = clean(it.transcript_snippet || it.analysis_summary || '', 240);
  if (snip) { L.push(''); L.push(`“${snip}”`); }
  L.push('');
  const pc = it.proposed_client && it.proposed_client !== 'UNKNOWN' ? it.proposed_client : 'UNKNOWN';
  L.push(`Suggested client: *${clean(pc, 40)}* (${rosterStatus(it.proposed_client || '')})${it.client_overridden ? ' _(corrected)_' : ''}`);
  const sp = speakerLabel(it);
  if (sp) L.push(`Speaker: ${sp}${it.speaker_overridden ? ' _(corrected)_' : ''}`);
  if (it.proposed_job) L.push(`Job: ${clean(it.proposed_job, 40)}`);
  if (it.proposed_expense && it.proposed_expense.amount != null) {
    L.push(`💵 $${Number(it.proposed_expense.amount).toFixed(2)} _(auto-read — confirm on approve)_`);
  }
  // §3 read-back: where this client's job(s) stand now, so you review with
  // context. Local, best-effort — never breaks the card if the store is absent.
  try {
    if (jobctx && it.proposed_client && it.proposed_client !== 'UNKNOWN') {
      const ctxs = jobctx.byClient(it.proposed_client).filter(c => c.phase || (c.state || []).length);
      if (ctxs.length === 1) {
        const s = jobctx.summaryLine(ctxs[0]);
        if (s) L.push(`📋 _Job state: ${clean(s, 60)}_`);
      } else if (ctxs.length > 1) {
        L.push(`📋 _${ctxs.length} active jobs: ${clean(ctxs.map(c => c.phase || 'active').join(' · '), 50)}_`);
      }
    }
  } catch { /* read-back is best-effort */ }
  return L.join('\n');
}

function navRow(it, i, n, code) {
  return [
    { text: i > 0 ? '◀' : '·', callback_data: i > 0 ? `rq:prev:${code}:${it.id}` : 'rq:noop' },
    { text: `${i + 1}/${n}`, callback_data: 'rq:noop' },
    { text: i < n - 1 ? '▶' : '·', callback_data: i < n - 1 ? `rq:next:${code}:${it.id}` : 'rq:noop' },
  ];
}
function cardKeyboard(it, i, n, code) {
  return { inline_keyboard: [
    [
      { text: '✅ Approve', callback_data: `rq:approve:${code}:${it.id}` },
      { text: '❌ Dismiss', callback_data: `rq:dismiss:${code}:${it.id}` },
      { text: '⏭ Skip', callback_data: `rq:skip:${code}:${it.id}` },
    ],
    [
      { text: '✏️ Update', callback_data: `rq:upd:${code}:${it.id}` },
      { text: '👁 Full', callback_data: `rq:full:${code}:${it.id}` },
      { text: '🔽 Filter', callback_data: `rq:flt:${code}:${it.id}` },
    ],
    navRow(it, i, n, code),
  ] };
}

function emptyPayload(q, code) {
  const a = q.filter(x => x.status === 'approved' && String(x.approved_at || '').slice(0, 10) === today()).length;
  const d = q.filter(x => x.status === 'dismissed' && String(x.dismissed_at || '').slice(0, 10) === today()).length;
  return { ok: true, empty: true, parse_mode: 'Markdown', reply_markup: null,
    text: `🎉 *Queue clear.* ${a} approved, ${d} dismissed today.` };
}

// Resolve which card to render from (--at, --move). Handles an `at` whose item
// was just acted on / filtered out by advancing to the next item by time order.
function cardPayload(at, move, code) {
  code = fcode(code);
  const q = loadQueue();
  const list = filteredPending(q, code);
  if (!list.length) return emptyPayload(q, code);
  let idx, answer = null;
  if (!at || at === 'first') idx = 0;
  else {
    let pos = list.findIndex(x => x.id === at);
    if (pos < 0) {
      // item gone from the filtered set → land on the next item by created_at
      const orig = q.find(x => x.id === at);
      const after = orig ? list.findIndex(x => String(x.created_at || '') > String(orig.created_at || '')) : -1;
      idx = after >= 0 ? after : Math.max(0, list.length - 1);
      move = 'here';
    } else idx = pos;
  }
  if (move === 'next') { if (idx < list.length - 1) idx++; else answer = 'End of queue.'; }
  else if (move === 'prev') { if (idx > 0) idx--; else answer = 'Start of queue.'; }
  const it = list[idx];
  const pay = { ok: true, empty: false, parse_mode: 'Markdown', id: it.id,
    text: cardText(it, idx, list.length, code), reply_markup: cardKeyboard(it, idx, list.length, code) };
  if (answer) pay.answer = answer;
  return pay;
}

// 👁 Full: everything we know about the item, rendered in place — the complete
// note that Approve would write, the analyzer's summary, the transcript
// excerpt, speaker matches, and the gate reason. Approve stays one tap away.
function detailPayload(id, code) {
  code = fcode(code);
  const q = loadQueue();
  const it = q.find(x => x.id === id);
  if (!it || it.status !== 'pending') return cardPayload(id, 'here', code);
  const L = [];
  L.push('👁 *Full detail*');
  const src = it.device_person || (it.source === 'field_capture' ? 'field capture' : (it.source || 'recording'));
  const date = String(it.recording_date || it.created_at || '').slice(0, 10) || '?';
  L.push(`🎙 ${clean(src, 30)} · ${date} · ${clean(String(it.bucket || '?').replace(/_/g, ' '), 18)} · ${clean(it.confidence || '?', 10)} confidence`);
  if (it.reason) L.push(`Gate: ${clean(it.reason, 100)}`);
  const v = (it.signals || {}).voice;
  if (v && typeof v === 'object') {
    const sp = Object.entries(v)
      .map(([spk, m]) => `${clean(spk, 20)} → ${clean((m && m.name) || '?', 24)}${m && m.confidence != null ? ` (${Math.round(m.confidence * 100)}%)` : ''}`)
      .slice(0, 5);
    if (sp.length) L.push(`Voices: ${sp.join(' · ')}`);
  }
  if (it.analysis_summary) { L.push(''); L.push('*Summary:*'); L.push(cleanML(it.analysis_summary, 700)); }
  if (it.transcript_snippet) { L.push(''); L.push('*Transcript excerpt:*'); L.push(`“${cleanML(it.transcript_snippet, 700)}”`); }
  if (it.proposed_note) { L.push(''); L.push(`*Note that Approve writes to ${clean(it.proposed_client || '?', 32)}:*`); L.push(cleanML(it.proposed_note, 2200)); }
  // §3 read-back: the current state of this client's job(s), so the reviewer
  // sees where the job is before approving more onto it.
  try {
    if (jobctx && it.proposed_client && it.proposed_client !== 'UNKNOWN') {
      for (const ctx of jobctx.byClient(it.proposed_client).filter(c => c.phase || (c.state || []).length)) {
        L.push('');
        L.push(`*Current job state — ${clean(ctx.job || ('job #' + ctx.job_id), 32)}:*`);
        if (ctx.phase) L.push(`Phase: ${clean(ctx.phase, 24)}`);
        for (const s of (ctx.state || []).slice(-6)) L.push(`• ${clean(s.element, 24)}: ${clean(s.status, 48)} _(${s.basis === 'INFERRED' ? '🤔 inferred' : 'stated'})_`);
        if (ctx.schedule_ref) L.push(`📐 _Schedule: ${ctx.schedule_ref.duration_weeks || '?'} wk${ctx.schedule_ref.scope_confidence === 'low' ? ' · ⚠ thin scope' : ''}_`);
      }
    }
  } catch { /* best-effort */ }
  let text = L.join('\n');
  if (text.length > 3900) text = text.slice(0, 3899) + '…';
  return { ok: true, parse_mode: 'Markdown', id, text, reply_markup: { inline_keyboard: [
    [
      { text: '✅ Approve', callback_data: `rq:approve:${code}:${id}` },
      { text: '⬅ Back to card', callback_data: `rq:card:${code}:${id}` },
    ],
  ] } };
}

// Card-flow approve executor: run the real cmdApprove (captured) and translate
// the outcome into a render payload. Three outcomes:
//   approved   → next card + receipt text (plugin posts the receipt as a reply)
//   AMBIGUOUS  → job-picker keyboard (rq:aokj:<F>:<jobNum>:<id>) so the
//                operator routes the note instead of the item silently sticking
//   other fail → error card with the captured output, item stays pending
function runApproveCaptured(ref, flags) {
  const logs = [];
  const origLog = console.log, origExit = process.exit;
  console.log = (...a) => logs.push(a.join(' '));
  process.exit = (c) => { const e = new Error('exit'); e.__exit = c || 0; throw e; };
  try { cmdApprove(ref, flags); }
  catch (e) { if (e == null || e.__exit === undefined) logs.push('❌ ' + ((e && e.message) || String(e))); }
  finally { console.log = origLog; process.exit = origExit; }
  return logs.join('\n');
}

function cmdApproveExec(flags) {
  const id = flags.id;
  const code = fcode(flags.f);
  const back = [{ text: '⬅ Back to card', callback_data: `rq:card:${code}:${id}` }];
  const q0 = loadQueue();
  const before = q0.find(x => x.id === id);
  if (!before || before.status !== 'pending') {
    const pay = cardPayload(id, 'here', code);
    pay.answer = 'Item no longer pending.';
    outJSON(pay); return;
  }
  const apFlags = {};
  if (flags.job != null) apFlags.job = flags.job;
  const out = runApproveCaptured(id, apFlags);

  const q = loadQueue();
  const it = q.find(x => x.id === id);
  if (it && it.status === 'approved') {
    const pay = cardPayload(id, 'here', code); // id left pending set → advances
    pay.answer = '✅ Approved';
    pay.receipt = out.slice(0, 3000);
    outJSON(pay); return;
  }
  if (/AMBIGUOUS/.test(out)) {
    const jobs = [...out.matchAll(/#(\d+) — (.+)/g)].slice(0, 8)
      .map(m => ({ num: m[1], title: m[2].trim() }));
    if (jobs.length) {
      const rows = jobs.map(j => ([{ text: clean(`#${j.num} ${j.title}`, 32), callback_data: `rq:aokj:${code}:${j.num}:${id}` }]));
      rows.push(back);
      outJSON({ ok: true, parse_mode: 'Markdown', id,
        text: `🧭 *Which job for ${clean((it && it.proposed_client) || 'this client', 32)}?*\n_The note didn't clearly match one active job — pick where it goes:_`,
        reply_markup: { inline_keyboard: rows }, answer: 'Pick the job' });
      return;
    }
  }
  outJSON({ ok: true, parse_mode: 'Markdown', id, answer: 'Approve failed', alert: true,
    text: `❌ *Approve failed — item left pending.*\n\n${clean(out, 600)}`,
    reply_markup: { inline_keyboard: [back] } });
}

// Two-tap approve, in place: render the card text + a Confirm/Cancel keyboard.
// Confirm (rq:aok) runs the live Jobber write in the plugin and then advances
// the card; Cancel (rq:card) just re-renders the card. If the item already left
// the filtered set (e.g. double-tap), fall back to the normal card render.
function approvePromptPayload(id, code) {
  code = fcode(code);
  const q = loadQueue();
  const list = filteredPending(q, code);
  const idx = list.findIndex(x => x.id === id);
  if (idx < 0) return cardPayload(id, 'here', code);
  const it = list[idx];
  const exp = it.proposed_expense && it.proposed_expense.amount != null
    ? ` and logs the $${Number(it.proposed_expense.amount).toFixed(2)} expense`
    : '';
  return { ok: true, parse_mode: 'Markdown', id: it.id,
    text: cardText(it, idx, list.length, code) + `\n\n⚠️ *Approve?* This posts the note to Jobber${exp}.`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Confirm', callback_data: `rq:aok:${code}:${it.id}` },
      { text: '✖ Cancel', callback_data: `rq:card:${code}:${it.id}` },
    ]] } };
}

function filterMenuPayload(id, code) {
  code = fcode(code);
  const opt = (lbl, c) => ([{ text: (c === code ? '● ' : '') + lbl, callback_data: `rq:setf:${c}:${id}` }]);
  return { ok: true, parse_mode: 'Markdown', text: '*Filter queue:*', reply_markup: { inline_keyboard: [
    opt('All', 'a'), opt('Unknown client', 'u'), opt('Low confidence', 'l'),
    [{ text: '⬅ Back', callback_data: `rq:card:${code}:${id}` }],
  ] } };
}

function updateMenuPayload(id, code) {
  code = fcode(code);
  return { ok: true, parse_mode: 'Markdown', text: '*What needs fixing?*', reply_markup: { inline_keyboard: [
    [{ text: '🏠 Wrong client', callback_data: `rq:uc:${code}:${id}` }],
    [{ text: '🎙 Wrong speaker', callback_data: `rq:us:${code}:${id}` }],
    [{ text: '📝 Add a note', callback_data: `rq:un:${code}:${id}` }],
    [{ text: '⬅ Back', callback_data: `rq:card:${code}:${id}` }],
  ] } };
}

function pickerPayload(kind, id, code, page) {
  code = fcode(code);
  const list = kind === 'client' ? clientList() : peopleList();
  const PER = 8;
  const pages = Math.max(1, Math.ceil(list.length / PER));
  const p = Math.min(Math.max(0, parseInt(page, 10) || 0), pages - 1);
  const slice = list.slice(p * PER, p * PER + PER);
  const sel = kind === 'client' ? 'xc' : 'xs';
  const nav = kind === 'client' ? 'pc' : 'ps';
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map(c => ({ text: clean(c.name, 24), callback_data: `rq:${sel}:${code}:${list.indexOf(c)}:${id}` })));
  }
  const navrow = [];
  if (p > 0) navrow.push({ text: '◀', callback_data: `rq:${nav}:${code}:${p - 1}:${id}` });
  navrow.push({ text: '⬅ Back', callback_data: `rq:upd:${code}:${id}` });
  if (p < pages - 1) navrow.push({ text: '▶', callback_data: `rq:${nav}:${code}:${p + 1}:${id}` });
  rows.push(navrow);
  const title = kind === 'client'
    ? 'Pick the correct *client*:\n_(Watch: Lisa & Joe Gallan vs. Jesse & Eva Gallan.)_'
    : 'Pick the correct *speaker*:';
  return { ok: true, parse_mode: 'Markdown', text: title, reply_markup: { inline_keyboard: rows } };
}

function cmdUpdate(flags) {
  const q = loadQueue();
  const idx = resolveIndex(q, flags.id);
  if (idx === null) { outJSON({ ok: false, parse_mode: 'Markdown', text: '❌ Item no longer pending.', answer: 'Item not found' }); return; }
  const it = q[idx];
  const code = fcode(flags.f);
  let answer = null;
  if (flags.client != null) {
    const c = clientList()[parseInt(flags.client, 10)];
    if (c) { it.proposed_client = c.name; it.needs_routing = false; it.client_overridden = true; answer = `Client → ${c.name}`; }
  } else if (flags.speaker != null) {
    const p = peopleList()[parseInt(flags.speaker, 10)];
    if (p) { it.proposed_speaker = p.name; it.speaker_overridden = true; answer = `Speaker → ${p.name}`; }
  } else if (flags.note != null) {
    const txt = String(flags.note).trim();
    if (txt) {
      it.proposed_note = (it.proposed_note ? it.proposed_note + '\n\n' : '') + `[Office note] ${txt}`;
      (it.office_notes = it.office_notes || []).push(txt);
      answer = 'Note added';
    }
  }
  saveQueue(q);
  const pay = cardPayload(it.id, 'here', code);
  if (answer) pay.answer = answer;
  outJSON(pay);
}

function cmdMetric(flags) {
  let m; try { m = JSON.parse(fs.readFileSync(METRICS, 'utf8')); } catch { m = {}; }
  const key = flags._[0];
  if (key) { const k = `${key}:${flags.op || 'unknown'}`; m[k] = (m[k] || 0) + 1; try { fs.writeFileSync(METRICS, JSON.stringify(m, null, 2)); } catch {} }
  outJSON({ ok: true });
}

// ── module export (for unit testing the parser without running the CLI) ───────
if (require.main !== module) {
  module.exports = { parseCommitmentsSection, resolvePersonLenient, extractCommitmentsFromNote, norm };
  return;
}

// ── dispatch ────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const ref = flags._[0];
switch (cmd) {
  case 'list': cmdList(); break;
  case 'show': if (!ref) { console.log('usage: review-cli.js show <n|rq_id>'); process.exit(1); } cmdShow(ref); break;
  case 'approve': if (!ref) { console.log('usage: review-cli.js approve <n|rq_id> [--client ..] [--job N] [--note ..] [--dry-run]'); process.exit(1); } cmdApprove(ref, flags); break;
  case 'dismiss': if (!ref) { console.log('usage: review-cli.js dismiss <n|rq_id> [--reason ..]'); process.exit(1); } cmdDismiss(ref, flags); break;
  // ── card cycler (JSON out; consumed by the review-buttons plugin) ──────────
  case 'card': outJSON(cardPayload(flags.at || 'first', flags.move || 'here', flags.f || defaultFilter())); break;
  case 'approve-prompt': outJSON(approvePromptPayload(flags.id, flags.f)); break;
  case 'approve-exec': cmdApproveExec(flags); break;
  case 'detail': outJSON(detailPayload(flags.id, flags.f)); break;
  case 'filter-menu': outJSON(filterMenuPayload(flags.id, flags.f)); break;
  case 'update-menu': outJSON(updateMenuPayload(flags.id, flags.f)); break;
  case 'picker': outJSON(pickerPayload(flags.kind === 'speaker' ? 'speaker' : 'client', flags.id, flags.f, flags.page)); break;
  case 'update': cmdUpdate(flags); break;
  case 'metric': cmdMetric(flags); break;
  default:
    console.log('review-cli.js — Pocket review queue\n  list\n  show <n|rq_id>\n  approve <n|rq_id> [--client "Name"] [--job N] [--note "text"] [--dry-run]\n  dismiss <n|rq_id> [--reason "why"]');
    process.exit(cmd ? 1 : 0);
}

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
const { execFileSync } = require('child_process');

const DIR = '/root/construction-bi-pipeline';
const QUEUE = path.join(DIR, 'review-queue.json');
const CONFIG = path.join(DIR, 'config.json');
const NODE = '/root/.hermes/node/bin/node';
const JOBBER = path.join(DIR, 'jobber-cli.js');
const DRIVE = path.join(DIR, 'drive-cli.js');
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
  default:
    console.log('review-cli.js — Pocket review queue\n  list\n  show <n|rq_id>\n  approve <n|rq_id> [--client "Name"] [--job N] [--note "text"] [--dry-run]\n  dismiss <n|rq_id> [--reason "why"]');
    process.exit(cmd ? 1 : 0);
}

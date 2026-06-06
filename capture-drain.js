#!/root/.hermes/node/bin/node
'use strict';
/*
 * capture-drain.js — runs under the TRUSTED Z profile (cron).
 * Moves new field-capture items from capture-inbox/inbox.jsonl into the
 * existing review-queue.json so they surface in Z's /review flow on Telegram.
 * Nothing here writes to Jobber/Drive — approval still happens via review-cli.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PIPELINE = '/root/construction-bi-pipeline';
const INBOX_DIR = path.join(PIPELINE, 'capture-inbox');
const INBOX_JSONL = path.join(INBOX_DIR, 'inbox.jsonl');
const QUEUE = path.join(PIPELINE, 'review-queue.json');
const NODE = '/root/.hermes/node/bin/node';
const OCR = path.join(PIPELINE, 'receipt-ocr.js');

const personFull = { 'jorge': 'Jorge Cruz', 'danilo': 'Danilo Silva' };

// Receipt OCR: for receipt/invoice uploads with an image/PDF, read vendor+total
// so the office gets a pre-filled expense to approve. Best-effort — any failure
// just leaves the item as a normal note+file (graceful degradation).
const RECEIPT_KINDS = new Set(['receipt', 'invoice']);
const OCR_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf']);
function ocrReceipt(attachmentPath) {
  try {
    if (!attachmentPath || !fs.existsSync(attachmentPath)) return null;
    if (!OCR_EXTS.has(path.extname(attachmentPath).toLowerCase())) return null;
    const out = execFileSync(NODE, [OCR, attachmentPath], { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
    const j = JSON.parse(out.trim());
    return (j && j.ok && j.total != null) ? j : null;
  } catch (e) { return null; }
}

function readQueue() { try { return JSON.parse(fs.readFileSync(QUEUE, 'utf8')); } catch (e) { return []; } }
function readInbox() {
  if (!fs.existsSync(INBOX_JSONL)) return [];
  return fs.readFileSync(INBOX_JSONL, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

const items = readInbox();
const newItems = items.filter(x => x.status === 'new');
if (!newItems.length) { console.log('[capture-drain] no new items'); process.exit(0); }

const q = readQueue();
const existingSrc = new Set(q.map(x => x.capture_id).filter(Boolean));
let added = 0;

for (const it of newItems) {
  if (existingSrc.has(it.id)) continue; // idempotent guard
  const person = personFull[it.person] || it.person;
  const noteLines = [];
  noteLines.push(`[Field capture via Telegram — ${person}] ${new Date(it.ts).toISOString().slice(0, 10)}`);
  if (it.kind && it.kind !== 'note') noteLines.push(`Type: ${it.kind}`);
  if (it.text) noteLines.push('', it.text);
  if (it.attachment_name) noteLines.push('', `Attachment: ${it.attachment_name}`);

  // Receipt/invoice OCR → pre-filled expense proposal (best-effort).
  let proposedExpense = null;
  if (RECEIPT_KINDS.has(it.kind) && it.attachment) {
    const ex = ocrReceipt(it.attachment);
    if (ex) {
      const desc = (ex.vendor ? ex.vendor : 'Receipt') + (ex.summary ? ' — ' + ex.summary : '');
      proposedExpense = { amount: ex.total, description: desc.slice(0, 200), date: ex.date || null, vendor: ex.vendor || null, category: ex.category || null };
      noteLines.push('', `💵 Receipt read: ${ex.vendor || '?'} — $${Number(ex.total).toFixed(2)}${ex.date ? ' on ' + ex.date : ''}${ex.category ? ' (' + ex.category + ')' : ''}`);
    }
  }

  q.push({
    id: 'rq_' + crypto.randomBytes(6).toString('hex'),
    capture_id: it.id,
    source: 'field_capture',
    device_person: person,
    recording_id: null,
    bucket: 'field_capture',
    proposed_client: it.client || it.client_raw || 'UNKNOWN',
    proposed_job: null,
    proposed_action: proposedExpense ? 'note+file+expense' : (it.attachment ? 'note+file' : 'note'),
    proposed_note: noteLines.join('\n'),
    proposed_expense: proposedExpense,
    receipt_extract: proposedExpense ? { vendor: proposedExpense.vendor, total: proposedExpense.amount, date: proposedExpense.date, category: proposedExpense.category } : null,
    attachment_path: it.attachment || null,
    attachment_name: it.attachment_name || null,
    needs_routing: !!it.needs_routing,
    suggestions: it.suggestions || [],
    kind: it.kind,
    confidence: it.client ? 'medium' : 'low',
    reason: it.needs_routing
      ? 'field capture — client name not matched, please route'
      : (proposedExpense ? 'field capture — receipt OCR pre-filled an expense' : 'field capture via Telegram'),
    signals: { device: person, source: 'telegram_field_capture' },
    analysis_summary: proposedExpense
      ? `receipt: ${proposedExpense.vendor || '?'} $${Number(proposedExpense.amount).toFixed(2)}`
      : (it.text ? it.text.slice(0, 280) : `${it.kind} upload${it.attachment_name ? ': ' + it.attachment_name : ''}`),
    new_client_data: null,
    status: 'pending',
    created_at: it.ts || new Date().toISOString()
  });
  it.status = 'drained';
  it.drained_at = new Date().toISOString();
  added++;
}

// persist queue + rewrite inbox with updated statuses
fs.writeFileSync(QUEUE, JSON.stringify(q, null, 2));
fs.writeFileSync(INBOX_JSONL, items.map(x => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''));
console.log(`[capture-drain] queued ${added} field-capture item(s) for review`);

#!/usr/bin/env node
'use strict';
// gmail-cli.js — send email through Gmail using the existing service account
// with Google Workspace domain-wide delegation (no new credential files).
//
// Safety model (matches the rest of the pipeline):
//   * Preview-first: `send` PRINTS the draft and exits unless --confirm.
//   * Two-tap in Telegram: the ✉️ Email button renders a draft card
//     (task-draft); only the explicit 📤 Send tap fires task-send.
//   * Closed contact book: recipients resolve from contacts.json (keyed by the
//     client roster name) — never invented. No contact on file → no send.
//   * One send per task: task-send refuses a resend (email_sent_at) without --force.
//
// Senders are config-driven (businesses[0].email):
//   "email": {
//     "senders": { "george": "george@example.com", "danilo": "danilo@example.com" },
//     "default_sender": "george"
//   }
// The Workspace admin must grant the service account's client_id the scope
// https://www.googleapis.com/auth/gmail.send (Admin console → Security →
// API controls → Domain-wide delegation) before any send works. `check`
// verifies that grant without sending anything.
//
// Usage:
//   gmail-cli.js check [--as george]
//   gmail-cli.js contacts
//   gmail-cli.js send --to addr|"Client Name" --subject "..." --body "..." [--as george] [--confirm]
//   gmail-cli.js task-draft --id cm_xxx --op NAME [--f CODE]     (JSON payload)
//   gmail-cli.js task-send  --id cm_xxx --op NAME [--f CODE] [--force]

const fs = require('fs');
const path = require('path');
// googleapis is loaded lazily — draft/contact rendering must work (and fail
// helpfully) even where the lib isn't installed; only send/check need it.
function gapi() { return require('googleapis').google; }

const DIR = '/root/construction-bi-pipeline';
const CONFIG = path.join(DIR, 'config.json');
const KEY_PATH = path.join(DIR, 'drive-service-account.json');
const CONTACTS = path.join(DIR, 'contacts.json');
const LEDGER = path.join(DIR, 'commitments.json');

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

function readJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function biz() { return readJSON(CONFIG, { businesses: [{}] }).businesses[0] || {}; }
function emailCfg() { return biz().email || {}; }
function contacts() { return readJSON(CONTACTS, {}); }
function outJSON(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function clean(s, max) {
  let t = String(s == null ? '' : s).replace(/[`*_\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}
// like clean() but keeps line breaks — used for the body preview in the draft card
function cleanML(s, max) {
  let t = String(s == null ? '' : s).replace(/[`*_\[\]]/g, '').replace(/[ \t]+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}

// ── flags ─────────────────────────────────────────────────────────────────────
function parseFlags(args) {
  const out = { _: [] };
  const bools = new Set(['confirm', 'force']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (bools.has(key)) out[key] = true;
      else { out[key] = args[i + 1]; i++; }
    } else out._.push(a);
  }
  return out;
}

// ── sender / recipient resolution ─────────────────────────────────────────────
// Map an operator (Telegram first name or config key) to a Workspace mailbox.
function resolveSender(asArg) {
  const cfg = emailCfg();
  const senders = cfg.senders || {};
  if (asArg && asArg.includes('@')) return asArg; // explicit address
  const want = String(asArg || '').toLowerCase().trim();
  if (want && senders[want]) return senders[want];
  // first-name prefix match ("George" -> senders.george)
  if (want) {
    const k = Object.keys(senders).find(k => want.startsWith(k) || k.startsWith(want));
    if (k) return senders[k];
  }
  if (cfg.default_sender && senders[cfg.default_sender]) return senders[cfg.default_sender];
  return null;
}

// Resolve a recipient: a literal address passes through; anything else must be
// an exact client-roster name present in contacts.json (closed book).
function resolveRecipient(to) {
  if (!to) return { error: 'no recipient' };
  if (String(to).includes('@')) return { email: String(to).trim() };
  const c = contacts()[to];
  if (c && c.email) return { email: c.email, attn: c.attn || null, name: to };
  return { error: `no contact on file for "${to}" — add it to contacts.json` };
}

// ── gmail ─────────────────────────────────────────────────────────────────────
function jwtFor(sender) {
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  return new (gapi().auth.JWT)({
    email: key.client_email,
    key: key.private_key,
    scopes: [SCOPE],
    subject: sender, // the Workspace user we send as (domain-wide delegation)
  });
}

// RFC 2047: non-ASCII in a header (em-dashes, accents) must be MIME-encoded
// or clients render mojibake like "Ã¢Â€Â”".
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function buildRaw({ from, to, subject, body }) {
  const msg = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
  return Buffer.from(msg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gmailSend({ from, to, subject, body }) {
  const google = gapi();
  const auth = jwtFor(from);
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: buildRaw({ from, to, subject, body }) },
  });
  return res.data.id;
}

// ── commands ──────────────────────────────────────────────────────────────────
async function cmdCheck(f) {
  const sender = resolveSender(f.as);
  if (!sender) {
    console.log('❌ No sender configured. Add businesses[0].email.senders to config.json.');
    process.exit(2);
  }
  try {
    await jwtFor(sender).authorize();
    console.log(`✅ Delegation OK — can send as ${sender} (scope gmail.send).`);
  } catch (e) {
    console.log(`❌ Delegation NOT working for ${sender}: ${e.message}`);
    console.log('   Grant the service account domain-wide delegation in the Workspace');
    console.log('   Admin console (Security → API controls → Domain-wide delegation):');
    try {
      const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
      console.log(`   client ID: ${key.client_id}`);
    } catch {}
    console.log(`   scope:     ${SCOPE}`);
    process.exit(1);
  }
}

function cmdContacts() {
  const c = contacts();
  const names = Object.keys(c);
  if (!names.length) { console.log('contacts.json is empty — add {"Client Name": {"email": "...", "attn": "First"}}'); return; }
  console.log(`📇 ${names.length} contact(s):`);
  for (const n of names) console.log(`  ${n} → ${c[n].email}${c[n].attn ? ` (attn: ${c[n].attn})` : ''}`);
}

async function cmdSend(f) {
  const sender = resolveSender(f.as);
  if (!sender) { console.error('❌ no sender configured (businesses[0].email.senders)'); process.exit(2); }
  const r = resolveRecipient(f.to);
  if (r.error) { console.error(`❌ ${r.error}`); process.exit(2); }
  if (!f.subject || !f.body) { console.error('send: need --subject and --body'); process.exit(1); }

  console.log('── Draft ───────────────────────────────');
  console.log(`From:    ${sender}`);
  console.log(`To:      ${r.email}`);
  console.log(`Subject: ${f.subject}`);
  console.log('');
  console.log(f.body);
  console.log('────────────────────────────────────────');
  if (!f.confirm) { console.log('(dry run — re-run with --confirm to send)'); return; }
  const id = await gmailSend({ from: sender, to: r.email, subject: f.subject, body: f.body });
  console.log(`📤 Sent (message id ${id}).`);
}

// ── task email flow (Telegram two-tap) ────────────────────────────────────────
// Deterministic draft from the task + contact book. Built identically by
// task-draft (preview) and task-send (the actual send), so what you saw is
// exactly what goes out.
function draftForTask(it, op) {
  if (!it.client) return { error: 'Task has no client — nothing to email.' };
  const r = resolveRecipient(it.client);
  if (r.error) return { error: r.error };
  const sender = resolveSender(op);
  if (!sender) return { error: 'Email not configured (businesses[0].email.senders).' };
  const opName = String(op || '').trim() || 'Cruz Services';
  // operator edits (✏️ Edit on the draft card) persist on the task and win
  // over the template — task-send rebuilds the same way, so what was last
  // previewed is exactly what goes out.
  const ov = it.email_draft || {};
  const subject = ov.subject || `${it.client} — ${clean(it.what, 60)}`;
  const body = ov.body || [
    `Hi${r.attn ? ' ' + r.attn : ''},`,
    '',
    `Following up on: ${it.what}.`,
    ...(it.note ? ['', it.note] : []),
    '',
    'Thanks,',
    opName,
    'Cruz Services',
  ].join('\n');
  return { sender, to: r.email, subject, body, edited: !!(ov.subject || ov.body) };
}

function loadTask(id) {
  const l = readJSON(LEDGER, []);
  return { ledger: l, it: l.find(x => x.id === id) || null };
}

function backRow(id, code) {
  return [{ text: '⬅ Back', callback_data: `tk:card:${code}:${id}` }];
}

// Render the draft-preview card payload (shared by task-draft and the
// post-edit re-render in task-draft-set).
function draftPayload(it, op, code) {
  const d = draftForTask(it, op);
  if (d.error) {
    return { ok: true, parse_mode: 'Markdown', text: `✉️ *Can't draft this email*\n\n${d.error}`,
      reply_markup: { inline_keyboard: [backRow(it.id, code)] } };
  }
  const sentNote = it.email_sent_at ? `\n\n⚠️ _Already emailed ${String(it.email_sent_at).slice(0, 10)} — sending again duplicates it._` : '';
  const text = [
    `✉️ *Email draft — not sent yet*${d.edited ? ' _(edited)_' : ''}`,
    '',
    `From: ${clean(d.sender, 50)}`,
    `To: ${clean(d.to, 50)}`,
    `Subject: ${clean(d.subject, 80)}`,
    '',
    cleanML(d.body, 700),
  ].join('\n') + sentNote;
  return { ok: true, parse_mode: 'Markdown', text, reply_markup: { inline_keyboard: [
    [
      { text: '📤 Send it', callback_data: `tk:emok:${code}:${it.id}` },
      { text: '✏️ Edit', callback_data: `tk:emed:${code}:${it.id}` },
    ],
    backRow(it.id, code),
  ] } };
}

function cmdTaskDraft(f) {
  const code = f.f || 'a';
  const { it } = loadTask(f.id);
  if (!it || it.status !== 'open') {
    outJSON({ ok: false, parse_mode: 'Markdown', text: '❌ Task no longer open.', answer: 'Task not found' });
    return;
  }
  outJSON(draftPayload(it, f.op, code));
}

// Apply an operator's free-text edit to the draft. The whole reply becomes the
// new body; a first line of "Subject: ..." moves into the subject instead.
function cmdTaskDraftSet(f) {
  const code = f.f || 'a';
  const { ledger, it } = loadTask(f.id);
  if (!it || it.status !== 'open') {
    outJSON({ ok: false, parse_mode: 'Markdown', text: '❌ Task no longer open.', answer: 'Task not found' });
    return;
  }
  const raw = String(f.text || '').trim();
  if (!raw) {
    const pay = draftPayload(it, f.op, code);
    pay.answer = 'Empty edit — draft unchanged';
    outJSON(pay);
    return;
  }
  const lines = raw.split('\n');
  const ov = it.email_draft || {};
  const m = lines[0].match(/^subject\s*:\s*(.+)$/i);
  if (m) {
    ov.subject = m[1].trim();
    const rest = lines.slice(1).join('\n').trim();
    if (rest) ov.body = rest;
  } else {
    ov.body = raw;
  }
  it.email_draft = ov;
  it.email_draft_by = String(f.op || '').trim() || null;
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  const pay = draftPayload(it, f.op, code);
  pay.answer = '✏️ Draft updated';
  outJSON(pay);
}

async function cmdTaskSend(f) {
  const code = f.f || 'a';
  const { ledger, it } = loadTask(f.id);
  if (!it || it.status !== 'open') {
    outJSON({ ok: false, parse_mode: 'Markdown', text: '❌ Task no longer open.', answer: 'Task not found' });
    return;
  }
  if (it.email_sent_at && !f.force) {
    outJSON({ ok: true, parse_mode: 'Markdown', answer: `Already sent ${String(it.email_sent_at).slice(0, 10)}`,
      text: `✉️ Already emailed ${String(it.email_sent_at).slice(0, 10)} for this task — not resending.`,
      reply_markup: { inline_keyboard: [backRow(it.id, code)] } });
    return;
  }
  const d = draftForTask(it, f.op);
  if (d.error) {
    outJSON({ ok: true, parse_mode: 'Markdown', text: `✉️ ${d.error}`, answer: 'Not sent',
      reply_markup: { inline_keyboard: [backRow(it.id, code)] } });
    return;
  }
  try {
    const id = await gmailSend({ from: d.sender, to: d.to, subject: d.subject, body: d.body });
    it.email_sent_at = new Date().toISOString();
    it.email_sent_by = String(f.op || '').trim() || null;
    it.note = (it.note ? it.note + ' | ' : '') + `emailed ${d.to} ${it.email_sent_at.slice(0, 10)}`;
    fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
    outJSON({ ok: true, parse_mode: 'Markdown', answer: `📤 Sent to ${d.to}`,
      text: `📤 *Sent* to ${clean(d.to, 50)} (message ${clean(id, 24)}).\n\n${clean(d.subject, 80)}`,
      reply_markup: { inline_keyboard: [backRow(it.id, code)] } });
  } catch (e) {
    outJSON({ ok: true, parse_mode: 'Markdown', answer: 'Send failed', alert: true,
      text: `❌ *Send failed:* ${clean(e.message, 200)}\n\nIf this mentions unauthorized\\_client, the Workspace delegation grant is missing.`,
      reply_markup: { inline_keyboard: [backRow(it.id, code)] } });
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const [, , cmd, ...rest] = process.argv;
  const f = parseFlags(rest);
  switch (cmd) {
    case 'check': return cmdCheck(f);
    case 'contacts': return cmdContacts();
    case 'send': return cmdSend(f);
    case 'task-draft': return cmdTaskDraft(f);
    case 'task-draft-set': return cmdTaskDraftSet(f);
    case 'task-send': return cmdTaskSend(f);
    default:
      console.log('gmail-cli.js — Gmail via Workspace delegation (preview-first)');
      console.log('  check [--as george]');
      console.log('  contacts');
      console.log('  send --to addr|"Client Name" --subject "..." --body "..." [--as george] [--confirm]');
      console.log('  task-draft --id cm_xxx --op NAME [--f CODE]');
      console.log('  task-send  --id cm_xxx --op NAME [--f CODE] [--force]');
      process.exit(cmd ? 1 : 0);
  }
}
main().catch(err => { console.error('gmail-cli failed: ' + err.message); process.exit(1); });

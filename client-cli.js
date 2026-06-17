#!/usr/bin/env node
'use strict';
// client-cli.js — guided "New Client" flow for the Telegram bot (/newclient).
//
// Human-in-the-loop, never auto-create: the operator types a name+address,
// gets a confirmation card, and only an explicit ✅ Create tap fires the
// atomic create. All writes go through the existing wrappers:
//   jobber-cli.js create-client --confirm   (Jobber + Notion + config.json)
//   drive-cli.js  create-folder             (client Drive folder)
//
// Atomicity / failure handling (surface + retry, not auto-delete):
//   1. dup-guard against the closed roster BEFORE any write,
//   2. create the Jobber client (authoritative). On failure → nothing created,
//   3. create the Drive folder (idempotent). On failure the Jobber client
//      stands and the draft is kept so the folder can be retried with one tap —
//      we never silently leave a half-created client, and never auto-delete a
//      live Jobber record.
//
// Emits the same JSON render-payload contract as the other *-cli.js card
// commands: {ok, parse_mode, text, reply_markup, answer?, id?}.
//
// Commands:
//   client-cli.js menu-check                       (parity probe → {ok:true})
//   client-cli.js preview --text "Name, Address" [--op NAME]
//   client-cli.js create  --id nc_xxx [--op NAME]
//   client-cli.js retry-folder --id nc_xxx [--op NAME]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = '/root/construction-bi-pipeline';
const CONFIG = path.join(DIR, 'config.json');
const DRAFTS = path.join(DIR, 'new-client-drafts.json');
const NODE = process.execPath;
const JOBBER = path.join(DIR, 'jobber-cli.js');
const DRIVE = path.join(DIR, 'drive-cli.js');

function readJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function biz() { return (readJSON(CONFIG, { businesses: [{}] }).businesses[0]) || {}; }
function clientList() { return biz().clients || []; }
function outJSON(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function clean(s, max) {
  let t = String(s == null ? '' : s).replace(/[`*_\[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}
function norm(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── flags ─────────────────────────────────────────────────────────────────────
function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { out[a.slice(2)] = args[i + 1]; i++; }
    else out._.push(a);
  }
  return out;
}

// ── draft store (bounded) ─────────────────────────────────────────────────────
function loadDrafts() { return readJSON(DRAFTS, {}); }
function saveDrafts(d) {
  // keep only the most recent 100 drafts so an abandoned flow never leaks.
  const keys = Object.keys(d).sort((a, b) => String((d[a] || {}).created_at || '').localeCompare(String((d[b] || {}).created_at || '')));
  while (keys.length > 100) delete d[keys.shift()];
  fs.writeFileSync(DRAFTS, JSON.stringify(d, null, 2));
}

// ── parse "Name, Address" ─────────────────────────────────────────────────────
function parseNameAddress(text) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'Nothing to read — reply with a name and address.' };
  const i = raw.indexOf(',');
  const name = (i < 0 ? raw : raw.slice(0, i)).trim();
  const address = (i < 0 ? '' : raw.slice(i + 1)).trim();
  if (!name) return { error: 'Couldn\'t read a name. Try: `Jane Doe, 123 Main St, Stuart FL`' };
  if (name.length > 80) return { error: 'That name looks too long — first part before the comma is the name.' };
  return { name, address };
}

function dupInRoster(name) {
  const want = norm(name);
  return clientList().find(c => norm(c.name) === want) || null;
}

// ── payloads ──────────────────────────────────────────────────────────────────
function errorCard(msg) {
  return { ok: true, parse_mode: 'Markdown', text: `➕ *New client*\n\n❌ ${clean(msg, 200)}\n\n_Send /newclient to try again._` };
}

function confirmCard(draft) {
  const text = [
    '➕ *New client — confirm*',
    '',
    `Name: *${clean(draft.name, 60)}*`,
    `Address: ${draft.address ? clean(draft.address, 80) : '_(none)_'}`,
    '',
    'On confirm I will create:',
    '• Jobber client',
    '• Drive folder',
    '• Notion + config entry',
    '',
    '_Nothing is created until you tap Create._',
  ].join('\n');
  return { ok: true, parse_mode: 'Markdown', id: draft.id, text, reply_markup: { inline_keyboard: [[
    { text: '✅ Create', callback_data: `nc:create:${draft.id}` },
    { text: '✖ Cancel', callback_data: `nc:cancel:${draft.id}` },
  ]] } };
}

function successCard(draft, jobberLine) {
  const text = [
    '✅ *Client created*',
    '',
    `*${clean(draft.name, 60)}*${draft.address ? `\n${clean(draft.address, 80)}` : ''}`,
    '',
    '✓ Jobber   ✓ Drive folder   ✓ Notion/config',
    jobberLine ? `\n_${clean(jobberLine, 120)}_` : '',
  ].join('\n');
  return { ok: true, parse_mode: 'Markdown', text, answer: '✅ Client created' };
}

function folderFailedCard(draft, err) {
  const text = [
    '⚠️ *Partly created*',
    '',
    `*${clean(draft.name, 60)}* is in Jobber, Notion and config —`,
    'but the *Drive folder* step failed:',
    `_${clean(err, 160)}_`,
    '',
    'Nothing is half-hidden: the client exists. Tap to finish the folder.',
  ].join('\n');
  return { ok: true, parse_mode: 'Markdown', id: draft.id, text, answer: '⚠️ Folder step failed', reply_markup: { inline_keyboard: [[
    { text: '🔄 Retry folder', callback_data: `nc:foldr:${draft.id}` },
    { text: '⬅ Done', callback_data: `nc:cancel:${draft.id}` },
  ]] } };
}

// ── commands ──────────────────────────────────────────────────────────────────
function cmdPreview(f) {
  const p = parseNameAddress(f.text);
  if (p.error) { outJSON(errorCard(p.error)); return; }
  const dup = dupInRoster(p.name);
  if (dup) { outJSON(errorCard(`"${dup.name}" is already a client — no need to create it.`)); return; }
  const drafts = loadDrafts();
  const id = 'nc_' + crypto.randomBytes(4).toString('hex');
  const draft = { id, name: p.name, address: p.address, op: (f.op || '').trim() || null, created_at: new Date().toISOString(), jobber_done: false };
  drafts[id] = draft;
  saveDrafts(drafts);
  outJSON(confirmCard(draft));
}

function runCapture(cli, args) {
  try {
    const out = execFileSync(NODE, [cli, ...args], { encoding: 'utf8', timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, out: String(out || '').trim() };
  } catch (err) {
    return { ok: false, out: String((err.stdout || '') + (err.stderr || err.message || '')).trim() };
  }
}

function createFolderStep(draft, drafts) {
  const r = runCapture(DRIVE, ['create-folder', draft.name]);
  if (r.ok) {
    delete drafts[draft.id];
    saveDrafts(drafts);
    return successCard(draft, draft.jobber_line);
  }
  draft.jobber_done = true; // Jobber half already done; keep draft for retry
  drafts[draft.id] = draft;
  saveDrafts(drafts);
  return folderFailedCard(draft, r.out || 'unknown error');
}

function cmdCreate(f) {
  const drafts = loadDrafts();
  const draft = drafts[f.id];
  if (!draft) { outJSON(errorCard('That draft expired. Send /newclient to start over.')); return; }

  // If Jobber half already done (e.g. a retry landed here), go straight to folder.
  if (draft.jobber_done) { outJSON(createFolderStep(draft, drafts)); return; }

  // Race-safe dup re-check just before writing.
  const dup = dupInRoster(draft.name);
  if (dup) { delete drafts[draft.id]; saveDrafts(drafts); outJSON(errorCard(`"${dup.name}" is already a client.`)); return; }

  // 1. Jobber (+ Notion + config) — authoritative, must succeed first.
  const args = ['create-client', draft.name, draft.address || '', '--confirm'];
  const jr = runCapture(JOBBER, args);
  const created = jr.ok && /client created/i.test(jr.out);
  if (!created) {
    delete drafts[draft.id]; saveDrafts(drafts);
    outJSON(errorCard(`Jobber create failed — nothing was created.\n${jr.out.slice(0, 200)}`));
    return;
  }
  draft.jobber_done = true;
  draft.jobber_line = (jr.out.split('\n').find(l => /client created/i.test(l)) || '').trim();
  // 2. Drive folder — idempotent; failure is surfaced + retryable.
  outJSON(createFolderStep(draft, drafts));
}

function cmdRetryFolder(f) {
  const drafts = loadDrafts();
  const draft = drafts[f.id];
  if (!draft) { outJSON(errorCard('That draft expired — the client may already be complete. Check Drive.')); return; }
  outJSON(createFolderStep(draft, drafts));
}

// ── main ──────────────────────────────────────────────────────────────────────
const cmd = process.argv[2];
const f = parseFlags(process.argv.slice(3));
switch (cmd) {
  case 'menu-check': outJSON({ ok: true, handler: 'newclient' }); break;
  case 'preview': cmdPreview(f); break;
  case 'create': cmdCreate(f); break;
  case 'retry-folder': cmdRetryFolder(f); break;
  default:
    console.log('client-cli.js — guided New Client flow\n  menu-check\n  preview --text "Name, Address" [--op NAME]\n  create --id nc_xxx [--op NAME]\n  retry-folder --id nc_xxx');
    process.exit(cmd ? 1 : 0);
}

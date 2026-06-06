#!/root/.hermes/node/bin/node
'use strict';
/*
 * capture-mcp.js — minimal, dependency-free MCP stdio server.
 *
 * Purpose: give the isolated jorge/danilo Telegram bots EXACTLY ONE capability:
 * deposit a field note and/or an uploaded file into a quarantined inbox, tagged
 * with a client. It NEVER writes to Jobber, Drive, Notion, config.json, the
 * review queue, or anything else. The trusted Z profile drains the inbox and
 * gates everything through the existing review queue.
 *
 * Exposes one tool: capture(client, kind, text, attachment_path?)
 *
 * Hard guarantees:
 *   - Only ever writes under INBOX_DIR.
 *   - Reads config.json ONLY to validate client names against the closed roster.
 *   - No shell, no network, no arbitrary fs writes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PIPELINE = '/root/construction-bi-pipeline';
const CONFIG = path.join(PIPELINE, 'config.json');
const INBOX_DIR = path.join(PIPELINE, 'capture-inbox');
const ATTACH_DIR = path.join(INBOX_DIR, 'attachments');
const INBOX_JSONL = path.join(INBOX_DIR, 'inbox.jsonl');
const PERSON = process.env.CAPTURE_PERSON || 'Unknown Field Tech';

fs.mkdirSync(ATTACH_DIR, { recursive: true });

function norm(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function roster() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const b = (cfg.businesses && cfg.businesses[0]) || {};
    return (b.clients || []).map(c => (typeof c === 'string' ? c : c.name)).filter(Boolean);
  } catch (e) { return []; }
}
function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function resolveClient(arg) {
  const names = roster();
  const want = norm(arg);
  if (!want) return { client: null, matched: false, suggestions: [] };
  const exact = names.find(n => norm(n) === want);
  if (exact) return { client: exact, matched: true, suggestions: [] };
  const ranked = names.map(n => ({ n, d: lev(want, norm(n)) })).sort((a, b) => a.d - b.d);
  return { client: null, matched: false, suggestions: ranked.slice(0, 4).map(x => x.n) };
}

function captureItem(args) {
  const client = String(args.client || '').trim();
  const kind = String(args.kind || 'note').trim().toLowerCase();
  const text = String(args.text || '').trim();
  const srcPath = args.attachment_path ? String(args.attachment_path).trim() : null;

  if (!client) return { error: 'Ask the crew member which client/job this is for, then try again.' };
  if (!text && !srcPath) return { error: 'There is nothing to save yet — ask for a note or a photo/file (and which client it is for).' };

  const r = resolveClient(client);
  const id = 'cap_' + crypto.randomBytes(5).toString('hex');
  const ts = new Date().toISOString();

  let stored = null, attachName = null;
  if (srcPath) {
    if (!fs.existsSync(srcPath)) {
      return { error: `That file didn't come through yet — ask the crew member to send it once more.` };
    }
    attachName = path.basename(srcPath);
    stored = path.join(ATTACH_DIR, `${id}_${attachName}`);
    fs.copyFileSync(srcPath, stored);
  }

  const rec = {
    id, ts, person: PERSON,
    client_raw: client,
    client: r.matched ? r.client : null,
    needs_routing: !r.matched,
    suggestions: r.matched ? [] : r.suggestions,
    kind, text: text || null,
    attachment: stored, attachment_name: attachName, source_path: srcPath || null,
    status: 'new'
  };
  fs.appendFileSync(INBOX_JSONL, JSON.stringify(rec) + '\n');

  const what = stored
    ? (text ? `your note and the ${kind === 'photo' ? 'photo' : 'file'} (${attachName})` : `the ${kind === 'photo' ? 'photo' : 'file'} (${attachName})`)
    : `your ${kind === 'note' ? 'note' : kind}`;

  let msg;
  if (r.matched) {
    msg = `✅ Got it — saved ${what} for ${r.client}. The office will see it and take it from here. Nothing else you need to do.`;
  } else {
    msg = `✅ Got it — saved ${what}. I wasn't sure exactly which client "${client}" is, so the office will sort that out — it's safe and won't get lost.` +
      (r.suggestions.length ? ` (Did you mean ${r.suggestions.slice(0, 3).join(', ')}? If so, just reply with the exact name.)` : '');
  }
  return { ok: true, id, message: msg };
}

// ---- minimal MCP stdio (newline-delimited JSON-RPC) ----
const TOOL = {
  name: 'capture',
  description: 'Save a field note and/or an uploaded file (invoice, receipt, document, photo) for a specific client. This is the ONLY action available. It does not write to Jobber or any live record — it deposits the item into the office review queue for approval. Always include which client it is for.',
  inputSchema: {
    type: 'object',
    properties: {
      client: { type: 'string', description: 'Client name this note/file is about (e.g. "Martha Glantz").' },
      kind: { type: 'string', enum: ['note', 'invoice', 'receipt', 'document', 'photo', 'question'], description: 'What kind of item this is.' },
      text: { type: 'string', description: 'The note text, or a short caption describing the attached file. Optional if an attachment is provided.' },
      attachment_path: { type: 'string', description: 'Local path of an uploaded file, if the user sent one. Leave empty for a text-only note.' }
    },
    required: ['client', 'kind']
  }
};

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    handle(msg);
  }
});

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'field-capture', version: '1.0.0' }
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: [TOOL] });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name !== 'capture') return replyErr(id, -32602, `Unknown tool: ${name}`);
    let out;
    try { out = captureItem(args); } catch (e) { out = { error: 'Capture failed: ' + e.message }; }
    if (out.error) {
      return reply(id, { content: [{ type: 'text', text: out.error }], isError: true });
    }
    return reply(id, { content: [{ type: 'text', text: out.message }] });
  }
  if (typeof id !== 'undefined') return replyErr(id, -32601, `Method not found: ${method}`);
}

#!/usr/bin/env node
'use strict';
/*
 * smoke-test.js — READ-ONLY connectivity check for every external integration
 * this deployment depends on. It performs only reads (or zero-effect probes):
 * no Jobber/Drive/Calendar/Notion records are created, updated, or deleted.
 *
 * Prints a PASS / FAIL / SKIP table and exits non-zero if any *configured*
 * integration fails (SKIP = not configured, treated as non-fatal).
 *
 * Usage: node smoke-test.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); }
  catch (e) { console.error('Cannot read config.json:', e.message); process.exit(2); }
})();

let SET = {};
try { SET = require('./src/config').settings(cfg); } catch { SET = {}; }
const TZ = SET.timezone || 'America/New_York';
const CAL_NAME = SET.calendarName || 'Cruz Schedule';

const results = []; // { name, status: 'PASS'|'FAIL'|'SKIP', detail }
function record(name, status, detail) { results.push({ name, status, detail: detail || '' }); }

// Small helper: minimal HTTPS request with timeout, resolves {status, body}.
function httpsReq(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function checkAnthropic() {
  const key = cfg.anthropic_api_key || cfg.businesses?.[0]?.anthropic_api_key;
  if (!key || /REPLACE|YOUR_/i.test(key)) return record('Anthropic', 'SKIP', 'no api key');
  try {
    const body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    const { status, body: resp } = await httpsReq({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', timeout: 15000,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, body);
    if (status === 200) return record('Anthropic', 'PASS', 'messages API reachable');
    const j = (() => { try { return JSON.parse(resp); } catch { return {}; } })();
    record('Anthropic', 'FAIL', `HTTP ${status} ${j.error?.message || ''}`.trim());
  } catch (e) { record('Anthropic', 'FAIL', e.message); }
}

async function checkJobber() {
  const jc = cfg.businesses?.[0]?.jobber;
  if (!jc?.client_id || /REPLACE|YOUR_/i.test(jc.client_id)) return record('Jobber', 'SKIP', 'not configured');
  if (!fs.existsSync(path.join(DIR, 'jobber-tokens.json'))) return record('Jobber', 'FAIL', 'jobber-tokens.json missing (run OAuth)');
  try {
    const api = require('./jobber-api');
    const data = await api.gql('query { account { name } }');
    const name = data?.account?.name;
    if (name) return record('Jobber', 'PASS', `account "${name}"`);
    record('Jobber', 'FAIL', 'no account returned');
  } catch (e) { record('Jobber', 'FAIL', e.message); }
}

async function checkDrive() {
  if (!fs.existsSync(path.join(DIR, 'drive-service-account.json'))) return record('Google Drive', 'SKIP', 'service-account key missing');
  const root = cfg.google_drive_root_folder_id;
  if (!root || /REPLACE|FOLDER_ID/i.test(root)) return record('Google Drive', 'SKIP', 'root folder id not set');
  try {
    const drive = require('./src/drive');
    const folders = await drive.listClientFolders(root); // read-only list
    record('Google Drive', 'PASS', `${folders.length} client folder(s) under root`);
  } catch (e) { record('Google Drive', 'FAIL', e.message); }
}

async function checkCalendar() {
  if (!fs.existsSync(path.join(DIR, 'drive-service-account.json'))) return record('Google Calendar', 'SKIP', 'service-account key missing');
  try {
    const cw = require('./calendar-writer');
    const id = await cw.findCruzCalendar(); // read-only lookup by name
    if (id) return record('Google Calendar', 'PASS', `"${CAL_NAME}" found`);
    record('Google Calendar', 'FAIL', `calendar "${CAL_NAME}" not shared with service account`);
  } catch (e) { record('Google Calendar', 'FAIL', e.message); }
}

async function checkNotion() {
  const token = cfg.notion_token || cfg.businesses?.[0]?.notion_token;
  if (!token || /REPLACE|YOUR_/i.test(token)) return record('Notion', 'SKIP', 'no token');
  try {
    const { status, body } = await httpsReq({
      hostname: 'api.notion.com', path: '/v1/users/me', method: 'GET', timeout: 15000,
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
    });
    if (status === 200) {
      const j = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      return record('Notion', 'PASS', `bot "${j.name || j.bot?.owner?.type || 'integration'}"`);
    }
    record('Notion', 'FAIL', `HTTP ${status}`);
  } catch (e) { record('Notion', 'FAIL', e.message); }
}

async function checkSpeakerID() {
  // Speaker identification runs locally via resemblyzer in a dedicated venv
  // (see pocket-ingest.js / voice-identify.py). This checks the real dependency
  // — the venv + Python stack — not any cloud service. It's a non-fatal
  // enhancement: the pipeline degrades to no speaker attribution if absent.
  const venvPy = '/root/venv-voice/bin/python3';
  const script = path.join(DIR, 'voice-identify.py');
  if (!fs.existsSync(script)) return record('Speaker ID', 'SKIP', 'voice-identify.py not present');
  if (!fs.existsSync(venvPy)) return record('Speaker ID', 'FAIL', `venv missing (${venvPy}) — run provision.sh`);
  try {
    // Prove the full stack imports (numpy + resemblyzer/torch + audio libs).
    execFileSync(venvPy, ['-c', 'import numpy,resemblyzer,soundfile,librosa,torch'], { timeout: 60000, stdio: ['ignore', 'ignore', 'pipe'] });
    // Prove the script runs and read back enrolled profile count.
    const out = execFileSync(venvPy, [script, 'list'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
    let n = 0; try { n = (JSON.parse(out.trim().split('\n').pop()) || []).length; } catch {}
    return record('Speaker ID', 'PASS', `resemblyzer venv ready, ${n} profile(s) enrolled`);
  } catch (e) {
    const msg = (e.stderr ? e.stderr.toString().trim().split('\n').pop() : e.message) || e.message;
    return record('Speaker ID', 'FAIL', `venv stack error: ${msg}`.slice(0, 120));
  }
}

async function checkTelegram() {
  // The bot token lives in the Hermes profile env, not config.json.
  const token = process.env.TELEGRAM_BOT_TOKEN || cfg.telegram?.bot_token;
  if (!token) return record('Telegram', 'SKIP', 'TELEGRAM_BOT_TOKEN not in env (delivery via Hermes)');
  try {
    const { status, body } = await httpsReq({
      hostname: 'api.telegram.org', path: `/bot${token}/getMe`, method: 'GET', timeout: 15000, headers: {},
    });
    const j = (() => { try { return JSON.parse(body); } catch { return {}; } })();
    if (status === 200 && j.ok) return record('Telegram', 'PASS', `@${j.result?.username || 'bot'}`);
    record('Telegram', 'FAIL', `HTTP ${status} ${j.description || ''}`.trim());
  } catch (e) { record('Telegram', 'FAIL', e.message); }
}

// Menu→handler parity: every command in the Telegram menu manifest must have a
// reachable handler. For each command we resolve its probe (a render handler IS
// its own read-only probe; a prompt handler declares a dedicated probe) and run
// it — a valid {ok:true} payload proves the handler is wired. Prevents a command
// being registered for autocomplete but dead in the dispatcher.
async function checkMenuParity() {
  const manifestPath = path.join(DIR, 'telegram-menu.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { return record('Menu parity', 'SKIP', 'telegram-menu.json not present'); }
  const cmds = manifest.commands || [];
  if (!cmds.length) return record('Menu parity', 'FAIL', 'manifest has no commands');

  const broken = [];
  for (const c of cmds) {
    const h = c.handler || {};
    const probe = h.type === 'render' ? { cli: h.cli, args: h.args || [] } : h.probe;
    if (!c.cmd || !c.desc) { broken.push(`${c.cmd || '?'}(missing cmd/desc)`); continue; }
    if (!probe || !probe.cli) { broken.push(`${c.cmd}(no handler)`); continue; }
    const cliPath = path.join(DIR, probe.cli);
    if (!fs.existsSync(cliPath)) { broken.push(`${c.cmd}(missing ${probe.cli})`); continue; }
    try {
      const out = execFileSync(process.execPath, [cliPath, ...(probe.args || [])],
        { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      const j = JSON.parse(line);
      if (j.ok !== true) broken.push(`${c.cmd}(handler returned ok=${j.ok})`);
    } catch (e) {
      broken.push(`${c.cmd}(${(e.message || 'error').slice(0, 40)})`);
    }
  }
  if (broken.length) return record('Menu parity', 'FAIL', `${cmds.length - broken.length}/${cmds.length} wired · broken: ${broken.join(', ')}`);
  record('Menu parity', 'PASS', `${cmds.length} commands, all handlers reachable`);
}

async function main() {
  console.log(`\n=== smoke-test (read-only) — ${SET.businessName || 'deployment'} — ${new Date().toISOString()} ===`);
  console.log(`timezone=${TZ}  calendar="${CAL_NAME}"\n`);

  await Promise.allSettled([
    checkAnthropic(), checkJobber(), checkDrive(), checkCalendar(),
    checkNotion(), checkSpeakerID(), checkTelegram(), checkMenuParity(),
  ]);

  // Stable order for the table.
  const order = ['Anthropic', 'Jobber', 'Google Drive', 'Google Calendar', 'Notion', 'Speaker ID', 'Telegram', 'Menu parity'];
  results.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  const icon = { PASS: '✓', FAIL: '✖', SKIP: '·' };
  const pad = s => (s + ' '.repeat(16)).slice(0, 16);
  for (const r of results) console.log(`  ${icon[r.status]} ${pad(r.name)} ${r.status.padEnd(4)} ${r.detail}`);

  const fails = results.filter(r => r.status === 'FAIL').length;
  const passes = results.filter(r => r.status === 'PASS').length;
  const skips = results.filter(r => r.status === 'SKIP').length;
  console.log(`\n--- ${passes} pass · ${fails} fail · ${skips} skip ---`);
  if (fails) { console.log('RESULT: FAIL\n'); process.exit(1); }
  console.log('RESULT: OK\n');
  process.exit(0);
}

main().catch(e => { console.error('smoke-test crashed:', e.message); process.exit(2); });

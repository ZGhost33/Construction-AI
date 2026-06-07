#!/usr/bin/env node
'use strict';
/*
 * validate-config.js — verify a deployment's config.json against the schema
 * before the pipeline is allowed to run. Read-only: never writes anything,
 * never calls a live API. Secrets are masked in all output.
 *
 * Usage:
 *   node validate-config.js [path/to/config.json]   # default: ./config.json
 *
 * Exit code 0 = valid (warnings allowed). Non-zero = at least one ERROR.
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CONFIG_PATH = path.resolve(process.argv[2] || path.join(DIR, 'config.json'));

const errors = [];
const warnings = [];
const ok = [];
function err(m) { errors.push(m); }
function warn(m) { warnings.push(m); }
function pass(m) { ok.push(m); }

// Mask a secret: keep a short prefix, hide the rest. Never print full secrets.
function mask(v) {
  if (v == null) return '(unset)';
  const s = String(v);
  if (!s) return '(empty)';
  if (s.length <= 8) return s.slice(0, 2) + '****';
  return s.slice(0, 6) + '…' + s.slice(-2) + ` (${s.length} chars)`;
}
function isPlaceholder(s) {
  if (!s) return true;
  return /REPLACE|YOUR_|_HERE|NOTION_DATABASE_ID|GOOGLE_DRIVE_FOLDER_ID|sk-ant-REPLACE|pk_DEVICE|pk_YOUR/i.test(String(s));
}
function present(s) { return s != null && String(s).length > 0 && !isPlaceholder(s); }

// ── load ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`✖ config not found at ${CONFIG_PATH}`);
  console.error('  Copy config.example.json → config.json and fill it in.');
  process.exit(2);
}
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`✖ config.json is not valid JSON: ${e.message}`);
  process.exit(2);
}

// ── schema_version ───────────────────────────────────────────────────────────
const CURRENT_SCHEMA = 1;
if (cfg.schema_version == null) {
  warn(`schema_version missing — assuming v${CURRENT_SCHEMA}. Run migrate-config.js to stamp it.`);
} else if (!Number.isInteger(cfg.schema_version)) {
  err(`schema_version must be an integer (got ${JSON.stringify(cfg.schema_version)}).`);
} else if (cfg.schema_version > CURRENT_SCHEMA) {
  err(`schema_version ${cfg.schema_version} is newer than this code supports (v${CURRENT_SCHEMA}).`);
} else if (cfg.schema_version < CURRENT_SCHEMA) {
  warn(`schema_version ${cfg.schema_version} < v${CURRENT_SCHEMA}. Run migrate-config.js.`);
} else {
  pass(`schema_version v${cfg.schema_version}`);
}

// ── required: anthropic_api_key ──────────────────────────────────────────────
if (!present(cfg.anthropic_api_key)) err('anthropic_api_key is missing or still a placeholder.');
else pass(`anthropic_api_key ${mask(cfg.anthropic_api_key)}`);

// ── timezone ─────────────────────────────────────────────────────────────────
const tz = cfg.timezone || 'America/New_York';
try {
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  if (cfg.timezone) pass(`timezone ${tz}`);
  else warn(`timezone not set — defaulting to ${tz}. Set it for this business.`);
} catch {
  err(`timezone "${tz}" is not a valid IANA timezone.`);
}

// ── calendar_name / business_short_name (defaults are fine, just inform) ──────
if (!cfg.calendar_name) warn('calendar_name not set — defaulting to "Cruz Schedule". Set it to this business\'s calendar.');
else pass(`calendar_name "${cfg.calendar_name}"`);

// ── businesses ───────────────────────────────────────────────────────────────
if (!Array.isArray(cfg.businesses) || cfg.businesses.length === 0) {
  err('businesses must be a non-empty array.');
} else {
  if (cfg.businesses.length > 1) {
    warn(`businesses has ${cfg.businesses.length} entries — this is a single-business deployment; only businesses[0] is used. Split extra businesses into their own deployments.`);
  }
  const biz = cfg.businesses[0];
  if (!present(biz.name)) err('businesses[0].name is missing or a placeholder.');
  else pass(`business "${biz.name}"`);

  if (!Array.isArray(biz.clients)) err('businesses[0].clients must be an array.');
  else pass(`clients: ${biz.clients.length}`);

  if (!Array.isArray(biz.people)) warn('businesses[0].people is not an array — speaker attribution will be limited.');
  else pass(`people: ${biz.people.length}`);

  // Jobber
  const j = biz.jobber;
  if (!j || !present(j.client_id) || !present(j.client_secret)) {
    warn('jobber.client_id/client_secret not set — Jobber integration disabled.');
  } else {
    pass(`jobber client_id ${mask(j.client_id)}`);
    if (!fs.existsSync(path.join(DIR, 'jobber-tokens.json'))) {
      warn('jobber-tokens.json not found — run the OAuth flow (jobber-setup.js) before Jobber calls work.');
    }
  }

  // Pocket
  if (present(biz.pocket_api_key)) pass(`pocket_api_key ${mask(biz.pocket_api_key)}`);
  else warn('businesses[0].pocket_api_key not set — recording ingest disabled.');
  if (Array.isArray(biz.pocket_devices)) pass(`pocket_devices: ${biz.pocket_devices.length}`);
}

// ── Notion ───────────────────────────────────────────────────────────────────
const notionToken = cfg.notion_token || cfg.businesses?.[0]?.notion_token;
const notionDbs = cfg.notion_databases || cfg.businesses?.[0]?.notion_databases;
if (!present(notionToken)) {
  warn('notion_token not set (top-level or businesses[0]) — Notion sync disabled.');
} else {
  pass(`notion_token ${mask(notionToken)}`);
  if (cfg.notion_token) warn('notion_token is set at the top level; businesses[0].notion_token is now canonical and all readers fall back to it — the top-level copy is redundant and can be removed.');
  const REQ_DBS = ['clients', 'conversation_log', 'client_details', 'commitments', 'open_questions'];
  if (!notionDbs || typeof notionDbs !== 'object') {
    err('notion_databases is missing — required for Notion sync.');
  } else {
    const missing = REQ_DBS.filter(k => !present(notionDbs[k]));
    if (missing.length) warn(`notion_databases missing/placeholder: ${missing.join(', ')}`);
    else pass(`notion_databases: all ${REQ_DBS.length} ids set`);
  }
}

// ── Google Drive / Calendar ──────────────────────────────────────────────────
if (!present(cfg.google_drive_root_folder_id)) {
  warn('google_drive_root_folder_id not set — Drive doc writing disabled.');
} else {
  pass(`google_drive_root_folder_id ${mask(cfg.google_drive_root_folder_id)}`);
}
if (!fs.existsSync(path.join(DIR, 'drive-service-account.json'))) {
  warn('drive-service-account.json not found — Drive & Calendar writes will fail.');
} else {
  pass('drive-service-account.json present');
}

// ── Azure (optional) ─────────────────────────────────────────────────────────
if (present(cfg.azure_speaker_key)) pass(`azure_speaker_key ${mask(cfg.azure_speaker_key)} (region ${cfg.azure_speaker_region || 'eastus'})`);
else warn('azure_speaker_key not set — speaker identification will be skipped (non-fatal).');

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\n=== validate-config: ${CONFIG_PATH} ===\n`);
for (const m of ok) console.log(`  ✓ ${m}`);
if (warnings.length) { console.log('\n  Warnings:'); for (const m of warnings) console.log(`  ⚠ ${m}`); }
if (errors.length) { console.log('\n  Errors:'); for (const m of errors) console.log(`  ✖ ${m}`); }

console.log(`\n--- ${ok.length} ok · ${warnings.length} warning(s) · ${errors.length} error(s) ---`);
if (errors.length) { console.log('RESULT: INVALID\n'); process.exit(1); }
console.log('RESULT: VALID\n');
process.exit(0);

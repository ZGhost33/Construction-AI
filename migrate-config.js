#!/usr/bin/env node
'use strict';
/*
 * migrate-config.js — bring a config.json up to the current schema version by
 * applying ordered, idempotent migrations. Always writes a timestamped .bak
 * before changing anything. A config already at the current version is a no-op.
 *
 * Usage:
 *   node migrate-config.js [path/to/config.json] [--dry-run]
 *
 * Exit 0 = up to date (or migrated). Exit 1 = config newer than this code.
 *          Exit 2 = file missing / unreadable.
 *
 * To add a migration: append an entry to MIGRATIONS with the next `to` number
 * and an idempotent `apply(cfg)`. Bump CURRENT_SCHEMA to match.
 */
const fs = require('fs');
const path = require('path');

const CURRENT_SCHEMA = 1;

// Ordered migrations. Each runs when the config's version < `to`. `apply` must
// be idempotent (safe to re-run) and only ever ADD/normalize — never destroy.
const MIGRATIONS = [
  {
    to: 1,
    note: 'introduce schema_version + business-agnostic settings (timezone, calendar_name, business_short_name) and surface notion_token at top level',
    apply(cfg) {
      const biz = (Array.isArray(cfg.businesses) && cfg.businesses[0]) || {};
      if (cfg.business_short_name == null) cfg.business_short_name = biz.name || 'the company';
      if (cfg.timezone == null) cfg.timezone = 'America/New_York';
      if (cfg.calendar_name == null) cfg.calendar_name = 'Cruz Schedule';
      // The monitor/sync scripts read a top-level notion_token; mirror it from
      // businesses[0] if it only lives there.
      if (cfg.notion_token == null && biz.notion_token) cfg.notion_token = biz.notion_token;
      cfg.schema_version = 1;
      return cfg;
    },
  },
];

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.find(a => !a.startsWith('--'));
const CONFIG_PATH = path.resolve(fileArg || path.join(__dirname, 'config.json'));

// ── load ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(CONFIG_PATH)) { console.error(`✖ config not found: ${CONFIG_PATH}`); process.exit(2); }
let raw, cfg;
try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); cfg = JSON.parse(raw); }
catch (e) { console.error(`✖ config.json is not valid JSON: ${e.message}`); process.exit(2); }

const from = Number.isInteger(cfg.schema_version) ? cfg.schema_version : 0;
console.log(`config: ${CONFIG_PATH}`);
console.log(`current schema_version: ${cfg.schema_version == null ? '(unset → treated as 0)' : cfg.schema_version}`);
console.log(`target schema_version:  ${CURRENT_SCHEMA}`);

if (from > CURRENT_SCHEMA) {
  console.error(`✖ config is at v${from}, newer than this code supports (v${CURRENT_SCHEMA}). Update the code.`);
  process.exit(1);
}
if (from === CURRENT_SCHEMA) {
  console.log('\n✓ already up to date — no migration needed (no-op).');
  process.exit(0);
}

// ── apply pending migrations in order ────────────────────────────────────────
const pending = MIGRATIONS.filter(m => m.to > from).sort((a, b) => a.to - b.to);
console.log(`\nPending migrations: ${pending.map(m => `v${m.to}`).join(' → ') || '(none)'}`);
let working = JSON.parse(JSON.stringify(cfg)); // operate on a copy
for (const m of pending) {
  console.log(`  • applying v${m.to}: ${m.note}`);
  working = m.apply(working);
}

const next = JSON.stringify(working, null, 2) + '\n';

if (dryRun) {
  console.log('\n[dry-run] no files written. Resulting top-level keys would be:');
  console.log('  ' + Object.keys(working).join(', '));
  console.log(`  schema_version: ${working.schema_version}`);
  process.exit(0);
}

// ── backup, then write ───────────────────────────────────────────────────────
const bak = `${CONFIG_PATH}.bak-${Date.now()}`;
fs.writeFileSync(bak, raw);
console.log(`\nBackup written: ${bak}`);
const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
fs.writeFileSync(tmp, next);
fs.renameSync(tmp, CONFIG_PATH);
console.log(`✓ migrated v${from} → v${working.schema_version}. Run validate-config.js to confirm.`);
process.exit(0);

#!/usr/bin/env node
'use strict';
// contacts-sync.js — pull client email addresses from Jobber into contacts.json
// (the closed contact book used by gmail-cli.js / the ✉️ Email task button).
//
// Read-only against Jobber (uses jobber-api.js's shared gql client). Local
// writes only touch contacts.json, and only with --write:
//   * Only clients already in the config roster get entries (closed roster —
//     a Jobber client we don't track never enters the book).
//   * Existing contacts.json entries are NEVER overwritten (manual fixes win);
//     pass --overwrite to refresh them from Jobber.
//
// Usage:
//   contacts-sync.js            preview what would change
//   contacts-sync.js --write    apply
//   contacts-sync.js --write --overwrite

const fs = require('fs');
const path = require('path');
const { gql } = require('./jobber-api.js');

const DIR = '/root/construction-bi-pipeline';
const CONFIG = path.join(DIR, 'config.json');
const CONTACTS = path.join(DIR, 'contacts.json');

function norm(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchJobberClients() {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 30; page++) { // hard stop well past any real roster
    const data = await gql(`
      query($cursor: String) {
        clients(first: 100, after: $cursor) {
          nodes { name firstName emails { address primary } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { cursor });
    const c = data.clients;
    out.push(...c.nodes);
    if (!c.pageInfo.hasNextPage) break;
    cursor = c.pageInfo.endCursor;
  }
  return out;
}

function bestEmail(emails) {
  if (!Array.isArray(emails) || !emails.length) return null;
  const primary = emails.find(e => e && e.primary && e.address);
  return (primary || emails.find(e => e && e.address) || {}).address || null;
}

async function main() {
  const write = process.argv.includes('--write');
  const overwrite = process.argv.includes('--overwrite');

  const roster = (JSON.parse(fs.readFileSync(CONFIG, 'utf8')).businesses[0].clients || []);
  let contacts; try { contacts = JSON.parse(fs.readFileSync(CONTACTS, 'utf8')); } catch { contacts = {}; }

  console.log('Fetching clients from Jobber (read-only)…');
  const jobber = await fetchJobberClients();
  const byNorm = new Map(jobber.map(c => [norm(c.name), c]));

  const added = [], updated = [], kept = [], noEmail = [], noMatch = [];
  for (const r of roster) {
    const jc = byNorm.get(norm(r.name));
    if (!jc) { noMatch.push(r.name); continue; }
    const email = bestEmail(jc.emails);
    if (!email) { noEmail.push(r.name); continue; }
    const entry = { email, ...(jc.firstName ? { attn: jc.firstName } : {}) };
    if (!contacts[r.name]) { contacts[r.name] = entry; added.push(`${r.name} → ${email}${entry.attn ? ` (attn: ${entry.attn})` : ''}`); }
    else if (overwrite && contacts[r.name].email !== email) { contacts[r.name] = entry; updated.push(`${r.name} → ${email}`); }
    else kept.push(r.name);
  }

  const show = (label, arr) => { if (arr.length) { console.log(`\n${label} (${arr.length}):`); arr.forEach(x => console.log('  ' + x)); } };
  show(write ? '✅ Added' : 'Would add', added);
  show(write ? '🔁 Updated (--overwrite)' : 'Would update with --overwrite', updated);
  if (kept.length) console.log(`\nUnchanged (already in book): ${kept.length}`);
  show('⚠ In roster but no email in Jobber', noEmail);
  show('⚠ In roster but not found in Jobber', noMatch);

  if (write) {
    fs.writeFileSync(CONTACTS, JSON.stringify(contacts, null, 2));
    console.log(`\n📇 contacts.json saved — ${Object.keys(contacts).length} total contact(s).`);
  } else {
    console.log('\n(dry run — re-run with --write to save)');
  }
}

main().catch(err => { console.error('contacts-sync failed: ' + err.message); process.exit(1); });

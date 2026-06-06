#!/usr/bin/env node
'use strict';
// commit-sync-notion.js — mirror the LOCAL commitments ledger to Notion.
//
// The local ledger (commitments.json) is the source of truth; this pushes a
// durable copy to the Notion "Commitments" database so the record survives a
// VPS handoff and is visible to whoever takes over. It is one-way (local →
// Notion), idempotent (upserts by a "Local ID" property), and best-effort:
// any Notion hiccup must never disturb the local CLI or the bot.
//
// Usage:
//   commit-sync-notion.js            # sync the whole ledger
//   commit-sync-notion.js cm_abc123  # sync just one item (used by commit-cli)
//   commit-sync-notion.js --quiet    # suppress per-row logging (for cron)

const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = '/root/construction-bi-pipeline';
const CONFIG = path.join(DIR, 'config.json');
const LEDGER = path.join(DIR, 'commitments.json');

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const TOKEN = cfg.businesses[0].notion_token;
const DBS = cfg.notion_databases || cfg.businesses[0].notion_databases || {};
const COMMIT_DB = DBS.commitments;
const CLIENTS_DB = DBS.clients;

function notion(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com', path: p, method,
      headers: {
        Authorization: 'Bearer ' + TOKEN,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ object: 'error', code: 'parse', message: d.slice(0, 200) }); } }); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function notionRetry(method, p, body) {
  for (let i = 0; ; i++) {
    const res = await notion(method, p, body);
    if (res.object === 'error' && (res.status === 429 || res.code === 'rate_limited') && i < 4) { await sleep(1000 * (i + 1)); continue; }
    return res;
  }
}

function norm(s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function todayStr() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }

// Map a local item's status to the Notion select. Open + past-due => OVERDUE.
function notionStatus(it) {
  if (it.status === 'done') return 'DONE';
  if (it.status === 'cancelled') return 'CANCELLED';
  if (it.due && it.due < todayStr()) return 'OVERDUE';
  return 'OPEN';
}

// Build a name -> page_id map of clients (paginated). Best-effort; on error
// returns an empty map so the relation is simply skipped.
async function loadClientIndex() {
  const map = new Map();
  if (!CLIENTS_DB) return map;
  let cursor;
  try {
    do {
      const res = await notionRetry('POST', `/v1/databases/${CLIENTS_DB}/query`, cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
      if (res.object === 'error') break;
      for (const pg of res.results || []) {
        // find the title property regardless of its name
        const titleProp = Object.values(pg.properties || {}).find(p => p.type === 'title');
        const nm = titleProp?.title?.[0]?.plain_text;
        if (nm) map.set(norm(nm), pg.id);
      }
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
  } catch { /* best effort */ }
  return map;
}

// Index existing mirror pages by their Local ID.
async function loadMirrorIndex() {
  const map = new Map();
  let cursor;
  do {
    const res = await notionRetry('POST', `/v1/databases/${COMMIT_DB}/query`, cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
    if (res.object === 'error') { console.error('mirror index error:', res.code, res.message); break; }
    for (const pg of res.results || []) {
      const lid = pg.properties?.['Local ID']?.rich_text?.[0]?.plain_text;
      if (lid) map.set(lid, pg.id);
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return map;
}

function buildProps(it, clientIndex) {
  const who = it.who || it.who_raw || '';
  const props = {
    'Name': { title: [{ text: { content: it.what || '(no description)' } }] },
    'Status': { select: { name: notionStatus(it) } },
    'Who Promised': { rich_text: who ? [{ text: { content: who } }] : [] },
    'Local ID': { rich_text: [{ text: { content: it.id } }] },
    'Source': { rich_text: it.source ? [{ text: { content: it.source } }] : [] },
    'Due Date': it.due ? { date: { start: it.due } } : { date: null },
  };
  if (it.client) {
    const pid = clientIndex.get(norm(it.client));
    if (pid) props['Clients'] = { relation: [{ id: pid }] };
    // if no relation match, drop the raw name into Promised To so it isn't lost
    else props['Promised To'] = { rich_text: [{ text: { content: it.client } }] };
  }
  return props;
}

(async () => {
  if (!TOKEN || !COMMIT_DB) { console.error('Notion not configured (token/db missing) — skipping sync.'); process.exit(0); }
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const onlyId = args.find(a => /^cm_/.test(a)) || null;

  let ledger; try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { ledger = []; }
  let items = ledger;
  if (onlyId) items = ledger.filter(x => x.id === onlyId);
  if (!items.length) { if (!quiet) console.log('nothing to sync'); process.exit(0); }

  const [clientIndex, mirrorIndex] = await Promise.all([loadClientIndex(), loadMirrorIndex()]);

  let created = 0, updated = 0, failed = 0;
  for (const it of items) {
    const props = buildProps(it, clientIndex);
    const existing = mirrorIndex.get(it.id);
    let res;
    if (existing) res = await notionRetry('PATCH', `/v1/pages/${existing}`, { properties: props });
    else res = await notionRetry('POST', '/v1/pages', { parent: { database_id: COMMIT_DB }, properties: props });
    if (res.object === 'error') { failed++; if (!quiet) console.error(`✗ ${it.id}: ${res.code} ${res.message}`); }
    else { existing ? updated++ : created++; if (!quiet) console.log(`${existing ? '↻' : '+'} ${it.id} ${it.what.slice(0, 50)}`); }
    await sleep(120); // be gentle with Notion rate limits (3 req/s)
  }
  console.log(`[commit-sync-notion] created ${created}, updated ${updated}${failed ? `, FAILED ${failed}` : ''} (of ${items.length}).`);
  process.exit(failed && !created && !updated ? 1 : 0);
})().catch(e => { console.error('sync error:', e.message); process.exit(1); });

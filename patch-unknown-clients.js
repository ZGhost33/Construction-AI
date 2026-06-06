#!/usr/bin/env node
/**
 * patch-unknown-clients.js
 *
 * One-time script to fix "Unknown Client" entries in the Notion conversation log.
 * For each Unknown Client page it:
 *   1. Reads the stored transcript back from Notion
 *   2. Re-runs Claude analysis with the updated prompt + full client list
 *   3. If a client is resolved, patches the existing Notion page in-place
 *      (updates Name, Client relation, Confidence) — no duplicates created
 *
 * Usage:
 *   node patch-unknown-clients.js [--dry-run]
 *
 * --dry-run  : print what would be changed without touching Notion
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const { analyzeTranscript } = require('./src/claude');

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DRY_RUN = process.argv.includes('--dry-run');

// ─── load config ─────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const anthropicApiKey = config.anthropic_api_key;

// We patch all businesses that have real Notion tokens
const businesses = config.businesses.filter(b =>
  b.notion_token && !b.notion_token.startsWith('secret_REPLACE') && b.notion_databases?.conversation_log
);

// ─── helpers ─────────────────────────────────────────────────────────────────
function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function toRichText(text) {
  if (!text) return [];
  const chunks = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ type: 'text', text: { content: text.slice(i, i + 2000) } });
  }
  return chunks;
}

function readRichText(richTextArr) {
  if (!Array.isArray(richTextArr)) return '';
  return richTextArr.map(b => b.plain_text || b.text?.content || '').join('');
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Notion: query for all Unknown Client pages ───────────────────────────────
async function fetchUnknownPages(token, databaseId) {
  const pages = [];
  let cursor = undefined;

  do {
    const body = {
      filter: {
        property: 'Name',
        title: { contains: 'Unknown Client' },
      },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;

    const res = await axios.post(
      `${NOTION_BASE}/databases/${databaseId}/query`,
      body,
      { headers: notionHeaders(token), timeout: 15000 }
    );

    pages.push(...(res.data.results || []));
    cursor = res.data.has_more ? res.data.next_cursor : undefined;
  } while (cursor);

  return pages;
}

// ─── Notion: look up client page by name ─────────────────────────────────────
async function findClientPage(token, databaseId, clientName) {
  if (!clientName || clientName === 'UNKNOWN') return null;
  try {
    const res = await axios.post(
      `${NOTION_BASE}/databases/${databaseId}/query`,
      {
        filter: { property: 'Name', title: { equals: clientName } },
        page_size: 1,
      },
      { headers: notionHeaders(token), timeout: 15000 }
    );
    if (res.data.results?.[0]?.id) return res.data.results[0].id;

    // Fallback: case-insensitive local match
    const all = await axios.post(
      `${NOTION_BASE}/databases/${databaseId}/query`,
      { page_size: 100 },
      { headers: notionHeaders(token), timeout: 15000 }
    );
    const lower = clientName.toLowerCase();
    return all.data.results?.find(p => {
      const t = p.properties?.Name?.title?.[0]?.text?.content || '';
      return t.toLowerCase() === lower;
    })?.id || null;
  } catch {
    return null;
  }
}

// ─── Notion: patch an existing page ──────────────────────────────────────────
async function patchPage(token, pageId, properties) {
  await axios.patch(
    `${NOTION_BASE}/pages/${pageId}`,
    { properties },
    { headers: notionHeaders(token), timeout: 15000 }
  );
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== patch-unknown-clients${DRY_RUN ? ' [DRY RUN]' : ''} ===\n`);

  let totalPatched = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const business of businesses) {
    const { name, notion_token, notion_databases } = business;
    console.log(`\n── Business: ${name} ──`);

    // Fetch all Unknown Client conversation log entries
    let unknownPages;
    try {
      unknownPages = await fetchUnknownPages(notion_token, notion_databases.conversation_log);
    } catch (err) {
      console.error(`  ERROR fetching unknown pages: ${err.message}`);
      continue;
    }

    console.log(`  Found ${unknownPages.length} "Unknown Client" entries to patch`);
    if (unknownPages.length === 0) continue;

    for (const page of unknownPages) {
      const pageId = page.id;
      const currentName = readRichText(page.properties?.Name?.title);
      const date = page.properties?.Date?.date?.start || 'unknown';

      // Read stored transcript
      const transcript = readRichText(page.properties?.['Full Transcript']?.rich_text);
      if (!transcript || transcript.trim().length < 20) {
        console.log(`  SKIP  [${date}] "${currentName}" — no transcript stored`);
        totalSkipped++;
        continue;
      }

      // Re-run Claude
      let analysis;
      try {
        analysis = await analyzeTranscript(anthropicApiKey, business, transcript, date);
      } catch (err) {
        console.error(`  ERROR [${date}] Claude failed: ${err.message}`);
        totalFailed++;
        await sleep(2000);
        continue;
      }

      const { client: clientName, confidence, summary } = analysis;

      if (!clientName || clientName === 'UNKNOWN') {
        console.log(`  SKIP  [${date}] still UNKNOWN after re-analysis`);
        totalSkipped++;
        await sleep(500);
        continue;
      }

      // Build new title
      const newTitle = `${date} — ${clientName}`;
      console.log(`  PATCH [${date}] "${currentName}" → "${newTitle}" (${confidence})`);
      if (DRY_RUN) {
        console.log(`         summary: ${(summary || '').slice(0, 120)}...`);
        totalPatched++;
        await sleep(300);
        continue;
      }

      // Look up client page in Notion clients DB
      let clientPageId = null;
      try {
        clientPageId = await findClientPage(notion_token, notion_databases.clients, clientName);
        if (!clientPageId) {
          console.log(`         WARNING: "${clientName}" not found in Notion clients DB — patching without relation`);
        }
      } catch (err) {
        console.log(`         WARNING: client lookup failed: ${err.message}`);
      }

      // Patch the conversation log entry
      try {
        const props = {
          Name: { title: toRichText(newTitle) },
          Confidence: { select: { name: capitalize(confidence) } },
        };
        if (clientPageId) {
          props.Client = { relation: [{ id: clientPageId }] };
        }
        await patchPage(notion_token, pageId, props);
        console.log(`         ✓ patched`);
        totalPatched++;
      } catch (err) {
        console.error(`         ERROR patching page: ${err.message}`);
        totalFailed++;
      }

      // Brief pause to respect Notion + Claude rate limits
      await sleep(1500);
    }
  }

  console.log(`\n=== Done: ${totalPatched} patched, ${totalSkipped} skipped, ${totalFailed} failed ===\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

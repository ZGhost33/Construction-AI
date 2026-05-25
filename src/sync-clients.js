/**
 * sync-clients.js
 *
 * Syncs clients from Jobber → Notion → config.json.
 * Called at the start of every pipeline run for each business that has Jobber configured.
 *
 * Logic:
 *   1. Fetch all clients from Jobber
 *   2. For each, check if already in business.clients (config.json)
 *   3. If missing: create in Notion clients DB + add to config.json
 *
 * This means any client added to Jobber (manually or via Hermes) will
 * automatically appear in Notion and be recognised by Claude within 15 minutes.
 */

const { fetchAllClients, fetchClientScopes } = require('./jobber');
const { addClientToConfig } = require('./config');

const SCOPES_PATH = require('path').join(__dirname, '..', 'client-scopes.json');

function loadScopes() {
  try { return JSON.parse(require('fs').readFileSync(SCOPES_PATH, 'utf8')); } catch { return {}; }
}
function saveScopes(scopes) {
  require('fs').writeFileSync(SCOPES_PATH, JSON.stringify(scopes, null, 2), 'utf8');
}
const notion = require('./notion');
const { log } = require('./logger');

let driveModule = null;
function getDrive() {
  if (!driveModule) {
    try { driveModule = require('./drive'); } catch (_) {}
  }
  return driveModule;
}

// Normalise a name for comparison — lowercase, collapse spaces, & / + → "and"
function normaliseName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[&+]/g, 'and')
    .replace(/\s+/g, ' ')
    .trim();
}

// Format a Jobber billing address into a single string
function formatAddress(addr) {
  if (!addr) return '';
  const parts = [addr.street, addr.city, addr.province, addr.postalCode].filter(Boolean);
  return parts.join(', ');
}

async function syncJobberClients(business, config = {}) {
  const { name: bizName, jobber, notion_token, notion_databases, clients: configClients } = business;
  const rootFolderId = config.google_drive_root_folder_id;

  if (!jobber?.client_id) return; // Jobber not configured for this business
  if (!notion_token || notion_token.startsWith('secret_REPLACE')) return;

  const existingNames = new Set((configClients || []).map(c => normaliseName(c.name)));

  let jobberClients;
  try {
    jobberClients = await fetchAllClients(jobber);
  } catch (err) {
    log(`[${bizName}] Jobber client sync skipped — ${err.message}`);
    return;
  }

  let added = 0;
  for (const jc of jobberClients) {
    if (!jc.name) continue;
    if (existingNames.has(normaliseName(jc.name))) continue; // already known

    const address = formatAddress(jc.billingAddress);
    const phone = jc.phones?.[0]?.number || null;
    const email = jc.emails?.[0]?.address || null;

    log(`[${bizName}] New Jobber client detected: "${jc.name}" — syncing to Notion + config...`);

    // Create in Notion (skip if already exists)
    try {
      const existing = await notion.findClientPage(notion_token, notion_databases.clients, jc.name);
      if (!existing) {
        await notion.createClient(notion_token, notion_databases.clients, {
          name: jc.name,
          address,
          contact: phone || email || null,
        });
        log(`[${bizName}] ✓ "${jc.name}" created in Notion`);
      } else {
        log(`[${bizName}]   "${jc.name}" already in Notion — skipping Notion create`);
      }
    } catch (err) {
      log(`[${bizName}] ERROR creating "${jc.name}" in Notion: ${err.message}`);
    }

    // Add to config.json so Claude can match future recordings
    try {
      addClientToConfig(bizName, jc.name, address);
      existingNames.add(normaliseName(jc.name)); // prevent double-adding in same run
      added++;
    } catch (err) {
      log(`[${bizName}] ERROR adding "${jc.name}" to config: ${err.message}`);
    }

    // Auto-create Drive folder for the new client
    if (rootFolderId && rootFolderId !== 'PASTE_FOLDER_ID_HERE') {
      const d = getDrive();
      if (d) {
        try {
          const result = await d.ensureClientFolder(rootFolderId, jc.name);
          if (result.created) log(`[${bizName}] ✓ Drive folder created for "${jc.name}"`);
        } catch (err) {
          log(`[${bizName}] Drive folder skipped for "${jc.name}": ${err.message}`);
        }
      }
    }
  }

  if (added > 0) {
    log(`[${bizName}] Client sync complete — ${added} new client(s) added`);
  }

  // Sync client scopes from Jobber quotes — only once every 6 hours (scopes rarely change)
  const allScopes = loadScopes();
  const lastSync = allScopes[`__last_sync_${bizName}`] || 0;
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (Date.now() - lastSync > SIX_HOURS) {
    await new Promise(r => setTimeout(r, 3000)); // brief pause after client sync
    try {
      const freshScopes = await fetchClientScopes(jobber);
      allScopes[bizName] = freshScopes;
      allScopes[`__last_sync_${bizName}`] = Date.now();
      saveScopes(allScopes);
      log(`[${bizName}] ✓ Client scopes updated (${Object.keys(freshScopes).length} clients with quotes)`);
    } catch (err) {
      log(`[${bizName}] Scope sync skipped — ${err.message}`);
    }
  }

  // Ensure Drive folders exist for ALL configured clients (catches existing ones too)
  if (rootFolderId && rootFolderId !== 'PASTE_FOLDER_ID_HERE') {
    const d = getDrive();
    if (d) {
      for (const c of (configClients || [])) {
        try {
          const result = await d.ensureClientFolder(rootFolderId, c.name);
          if (result.created) log(`[${bizName}] ✓ Drive folder created for "${c.name}"`);
        } catch (err) {
          log(`[${bizName}] Drive folder error for "${c.name}": ${err.message}`);
        }
      }
    }
  }
}

module.exports = { syncJobberClients };

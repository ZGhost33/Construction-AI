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

const { fetchAllClients } = require('./jobber');
const { addClientToConfig } = require('./config');
const notion = require('./notion');
const { log } = require('./logger');

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

async function syncJobberClients(business) {
  const { name: bizName, jobber, notion_token, notion_databases, clients: configClients } = business;

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
  }

  if (added > 0) {
    log(`[${bizName}] Client sync complete — ${added} new client(s) added`);
  }
}

module.exports = { syncJobberClients };

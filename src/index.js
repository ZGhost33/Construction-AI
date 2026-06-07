/**
 * ⚠️ LEGACY / DEAD CODE — the old PM2 entry point (`npm start`/`npm run dev`).
 * NO Hermes cron runs this. The live pipeline is the top-level `pocket-ingest.js`
 * and its sibling cron scripts. Do not edit this to change production behavior.
 * See CLAUDE.md → "Live vs. legacy".
 */
const { loadConfig } = require('./config');
const { processBusiness } = require('./pipeline');
const { syncJobberClients } = require('./sync-clients');
const { processNewConvertedQuotes } = require('./quote-processor');
const { startLocationServer } = require('./location-server');
const { startDashboard } = require('./dashboard-server');
const { log } = require('./logger');

async function runOnce(config) {
  log('=== Pipeline run starting ===');
  for (const business of config.businesses) {
    // Support both single pocket_api_key and multi-device pocket_devices array
    const hasDevices = business.pocket_devices && business.pocket_devices.some(d => d.api_key && !d.api_key.startsWith('pk_REPLACE'));
    const hasKey = business.pocket_api_key && !business.pocket_api_key.startsWith('pk_REPLACE');
    if (!hasDevices && !hasKey) {
      log(`[${business.name}] Skipping — pocket_api_key not configured`);
      continue;
    }
    if (!business.notion_token || business.notion_token.startsWith('secret_REPLACE')) {
      log(`[${business.name}] Skipping — notion_token not configured`);
      continue;
    }
    await syncJobberClients(business, config);
    await processNewConvertedQuotes(config.anthropic_api_key, business, config);
    await processBusiness(config.anthropic_api_key, business, config.location_timeout_hours || 12);
  }
  log('=== Pipeline run complete ===');
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }

  const intervalMs = (config.poll_interval_minutes || 15) * 60 * 1000;
  const port = config.location_server_port || 3456;

  log(`Starting pipeline — polling every ${config.poll_interval_minutes || 15} minutes`);
  log(`Configured businesses: ${config.businesses.map(b => b.name).join(', ')}`);

  // Start the location webhook server
  startLocationServer(port);

  // Start the CEO dashboard
  const dashboardPort = config.dashboard_port || 4000;
  startDashboard(dashboardPort);
  log(`[Dashboard] CEO dashboard at http://5.161.227.111:${dashboardPort}`);

  // Run immediately on start
  await runOnce(config);

  // Then poll on interval
  setInterval(async () => {
    try {
      config = loadConfig();
      await runOnce(config);
    } catch (err) {
      log(`ERROR in pipeline run: ${err.message}`);
    }
  }, intervalMs);
}

main();

const { loadConfig } = require('./config');
const { processBusiness } = require('./pipeline');
const { startLocationServer } = require('./location-server');
const { log } = require('./logger');

async function runOnce(config) {
  log('=== Pipeline run starting ===');
  for (const business of config.businesses) {
    if (!business.pocket_api_key || business.pocket_api_key.startsWith('pk_REPLACE')) {
      log(`[${business.name}] Skipping — pocket_api_key not configured`);
      continue;
    }
    if (!business.notion_token || business.notion_token.startsWith('secret_REPLACE')) {
      log(`[${business.name}] Skipping — notion_token not configured`);
      continue;
    }
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

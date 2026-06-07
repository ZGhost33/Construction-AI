const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`config.json not found at ${CONFIG_PATH}. Copy config.json.example and fill in your credentials.`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);

  if (!config.anthropic_api_key || config.anthropic_api_key.startsWith('sk-ant-REPLACE')) {
    throw new Error('anthropic_api_key is not set in config.json');
  }
  if (!Array.isArray(config.businesses) || config.businesses.length === 0) {
    throw new Error('No businesses defined in config.json');
  }

  return config;
}

// Adds a new client to a business in config.json so future recordings can match against them
function addClientToConfig(businessName, clientName, address) {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);
  const biz = config.businesses.find(b => b.name === businessName);
  if (!biz) return;
  const already = biz.clients.some(c => c.name.toLowerCase() === clientName.toLowerCase());
  if (already) return;
  biz.clients.push({ name: clientName, address: address || '' });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// Resolves business-agnostic settings from config, with defaults equal to the
// original Cruz Services literals so an un-migrated config keeps working.
function settings(cfg) {
  if (!cfg) { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  const biz = (Array.isArray(cfg.businesses) && cfg.businesses[0]) || {};
  return {
    cfg, business: biz,
    schemaVersion: cfg.schema_version || 1,
    businessName: biz.name || cfg.business_short_name || 'the company',
    businessShortName: cfg.business_short_name || biz.name || 'the company',
    timezone: cfg.timezone || 'America/New_York',
    calendarName: cfg.calendar_name || 'Cruz Schedule',
    telegram: cfg.telegram || null,
  };
}

module.exports = { loadConfig, addClientToConfig, settings, CONFIG_PATH };

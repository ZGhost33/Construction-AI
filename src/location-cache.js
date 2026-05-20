const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'location-cache.json');

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch { return {}; }
}

function saveCache(data) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
}

function setLocation(pocketApiKey, clientName) {
  const cache = loadCache();
  cache[pocketApiKey] = {
    client: clientName,
    arrived_at: new Date().toISOString(),
  };
  saveCache(cache);
}

// Returns client name if check-in happened within timeoutHours, otherwise null
function getLocation(pocketApiKey, timeoutHours = 12) {
  const cache = loadCache();
  const entry = cache[pocketApiKey];
  if (!entry) return null;
  const ageHours = (Date.now() - new Date(entry.arrived_at).getTime()) / 36e5;
  if (ageHours > timeoutHours) return null;
  return entry.client;
}

function getAllLocations() {
  return loadCache();
}

module.exports = { setLocation, getLocation, getAllLocations };

const fs = require('fs');
const path = require('path');

const STORAGE_PATH = path.join(__dirname, '..', 'processed_recordings.json');

function loadStorage() {
  if (!fs.existsSync(STORAGE_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveStorage(data) {
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function isProcessed(businessName, recordingId) {
  const store = loadStorage();
  return !!(store[businessName] && store[businessName][recordingId]);
}

function markProcessed(businessName, recordingId, meta = {}) {
  const store = loadStorage();
  if (!store[businessName]) store[businessName] = {};
  store[businessName][recordingId] = {
    processed_at: new Date().toISOString(),
    ...meta,
  };
  saveStorage(store);
}

module.exports = { isProcessed, markProcessed };

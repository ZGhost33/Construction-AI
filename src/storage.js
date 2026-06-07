const fs = require('fs');
const path = require('path');

const STORAGE_PATH = path.join(__dirname, '..', 'processed_recordings.json');
const ATTEMPTS_PATH = path.join(__dirname, '..', 'ingest-attempts.json');

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

// ── Transient-failure attempt counter ──────────────────────────────────────────
// Tracks recordings that failed transiently (not yet processed) so the ingest
// loop can retry on the next cron run and give up after a bounded number of tries
// instead of either dropping silently or retrying forever. Kept in a SEPARATE file
// from processed_recordings.json so a pending retry is never mistaken for "done"
// by isProcessed().

function loadAttempts() {
  if (!fs.existsSync(ATTEMPTS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(ATTEMPTS_PATH, 'utf8')); } catch { return {}; }
}

function saveAttempts(data) {
  fs.writeFileSync(ATTEMPTS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Increment and return the attempt count for a recording.
function bumpAttempt(businessName, recordingId) {
  const store = loadAttempts();
  if (!store[businessName]) store[businessName] = {};
  const n = ((store[businessName][recordingId] || {}).attempts || 0) + 1;
  store[businessName][recordingId] = { attempts: n, last_attempt: new Date().toISOString() };
  saveAttempts(store);
  return n;
}

// Clear the counter once a recording reaches a terminal outcome.
function clearAttempts(businessName, recordingId) {
  const store = loadAttempts();
  if (store[businessName] && store[businessName][recordingId]) {
    delete store[businessName][recordingId];
    saveAttempts(store);
  }
}

module.exports = { isProcessed, markProcessed, bumpAttempt, clearAttempts };

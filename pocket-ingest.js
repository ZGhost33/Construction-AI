#!/usr/bin/env node
/**
 * pocket-ingest.js — Pocket Audio Ingestion Pipeline
 *
 * Triggered by Hermes cron every 15 minutes (configurable).
 * Replaces the PM2-managed pipeline.js for Jobber note writing.
 *
 * Pipeline per recording:
 *   1. Fetch new completed recordings via Pocket REST API
 *   2. Get signed audio URL via Pocket MCP (pocket-mcp.js)
 *   3. Download audio to /tmp, run voice identification (voice-identify.py)
 *   4. Segment transcript into distinct conversations (segmenter.js)
 *   5. For each conversation: triage → attribute (3 signals) → confidence gate
 *   6. HIGH confidence in normal mode → jobber-cli.js note
 *      All confidence in strict mode → review-queue.json
 *      no_business_content → archive log only
 *   7. Send Telegram digest if items queued
 *
 * Config fields (config.json):
 *   auto_write_mode: "strict" | "normal"  (default: "strict")
 *   silence_threshold_seconds: 180         (default: 180)
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const axios         = require('axios');
const { execFileSync } = require('child_process');
const crypto        = require('crypto');

const { fetchRecordings }       = require('./src/pocket');
const { getRecordingWithAudio } = require('./src/pocket-mcp');
const { segmentRecording }      = require('./src/segmenter');
const { analyzeConversation }   = require('./src/claude');
const { isProcessed, markProcessed, bumpAttempt, clearAttempts } = require('./src/storage');
const { log }                   = require('./src/logger');

const NODE   = '/root/.hermes/node/bin/node';
const PYTHON = '/root/venv-voice/bin/python3';
const PY_SCRIPT = path.join(__dirname, 'voice-identify.py');
const JOBBER_CLI = path.join(__dirname, 'jobber-cli.js');
const REVIEW_QUEUE_PATH = path.join(__dirname, 'review-queue.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// Give a transiently-failing recording this many cron runs to succeed before we
// mark it processed-with-error and stop retrying (prevents poison-recording loops).
const MAX_INGEST_ATTEMPTS = 3;

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ── Review queue ──────────────────────────────────────────────────────────────

function loadQueue() {
  try { return JSON.parse(fs.readFileSync(REVIEW_QUEUE_PATH, 'utf8')); } catch { return []; }
}

function saveQueue(queue) {
  fs.writeFileSync(REVIEW_QUEUE_PATH, JSON.stringify(queue, null, 2));
}

function addToQueue(item) {
  const queue = loadQueue();
  queue.push({ ...item, status: 'pending', created_at: new Date().toISOString() });
  saveQueue(queue);
}

// ── Telegram notification ─────────────────────────────────────────────────────

async function sendTelegramDigest(botToken, chatId, items) {
  if (!botToken || !chatId || !items.length) return;

  const lines = [`📋 *${items.length} recording${items.length > 1 ? 's' : ''} in review queue*`];
  const pending = loadQueue().filter(q => q.status === 'pending');

  // Group by confidence
  const byBucket = {};
  for (const item of items) {
    const key = item.bucket || 'uncertain';
    (byBucket[key] = byBucket[key] || []).push(item);
  }

  for (const [bucket, bucketItems] of Object.entries(byBucket)) {
    lines.push('');
    if (bucket === 'new_prospect') lines.push('🆕 *Possible new clients:*');
    else if (bucket === 'uncertain') lines.push('❓ *Uncertain routing:*');
    else lines.push('📁 *Job-relevant (needs confirmation):*');

    for (const item of bucketItems.slice(0, 5)) {
      const dateStr = item.recording_date ? item.recording_date.slice(0, 10) : '?';
      const clientStr = item.proposed_client && item.proposed_client !== 'UNKNOWN'
        ? item.proposed_client
        : 'unknown client';
      lines.push(`  • ${dateStr} — ${clientStr} (${item.confidence || '?'} confidence)`);
      if (item.reason) lines.push(`    _${item.reason}_`);
    }
    if (bucketItems.length > 5) lines.push(`  _...and ${bucketItems.length - 5} more_`);
  }

  lines.push('');
  const totalPending = pending.length;
  lines.push(`*Total pending: ${totalPending}* — tap a button below, or send /review`);

  const text = lines.join('\n');

  // ── Inline action buttons (one row per item, up to 8) ───────────────────────
  // Tapping fires a `rq:` callback consumed by the `review-buttons` Hermes plugin
  // (~/.hermes/plugins/review-buttons), which shells out to review-cli.js. If that
  // plugin is not installed, the buttons are simply inert — the /review text flow
  // still works. callback_data stays well under Telegram's 64-byte cap
  // (`rq:approve:rq_xxxxxxxxxxxx` ≈ 26 B).
  const reply_markup = buildReviewKeyboard(items);

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...(reply_markup ? { reply_markup } : {}),
    }, { timeout: 10000 });
  } catch (err) {
    log('[Ingest] Telegram digest failed: ' + err.message);
  }
}

// Build an inline keyboard: one row per item (capped), each row
// `[👁 Show] [✅ Approve <client>] [🗑 Dismiss]`, keyed by the item's rq_ id.
// Returns undefined when there are no id-bearing items (no markup attached).
function buildReviewKeyboard(items) {
  const withId = (items || []).filter(it => it && it.id);
  if (!withId.length) return undefined;
  const MAX_ROWS = 8;
  const rows = withId.slice(0, MAX_ROWS).map(it => {
    const client = (it.proposed_client && it.proposed_client !== 'UNKNOWN')
      ? it.proposed_client : 'unknown';
    const label = client.length > 18 ? client.slice(0, 17) + '…' : client;
    return [
      { text: '👁', callback_data: `rq:show:${it.id}` },
      { text: `✅ ${label}`, callback_data: `rq:approve:${it.id}` },
      { text: '🗑', callback_data: `rq:dismiss:${it.id}` },
    ];
  });
  // Opt-in entry to the card cycler. Tapping `rq:card:a:<firstId>` transforms
  // THIS digest message into the first review card in place (the `review-buttons`
  // plugin renders it). The per-item rows above remain the proven fallback, so
  // the old digest path is untouched if the plugin isn't installed.
  rows.unshift([{ text: '📋 Review as cards →', callback_data: `rq:card:a:${withId[0].id}` }]);
  return { inline_keyboard: rows };
}

// ── Voice identification ──────────────────────────────────────────────────────

/**
 * Identify speakers in a recording using voice-identify.py.
 * Returns { SPEAKER_00: "Luis Canuto", SPEAKER_01: "Jorge Cruz", ... } or {}
 */
function identifySpeakers(audioPath, segments) {
  if (!fs.existsSync(audioPath)) return {};

  // voice-identify.py expects a PATH to a segments JSON file (not a JSON string).
  // Passing the JSON inline as argv can also exceed the OS arg-length limit on
  // long recordings, so we write it to a temp file and hand over the path.
  const segPath = `/tmp/pocket-segments-${process.pid}-${Date.now()}.json`;
  try {
    fs.writeFileSync(segPath, JSON.stringify(segments));
    const out = execFileSync(PYTHON, [PY_SCRIPT, 'identify', audioPath, segPath], {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lastLine = out.trim().split('\n').pop();
    const parsed = JSON.parse(lastLine);
    return (parsed && !parsed.error) ? parsed : {};
  } catch (err) {
    log('[Ingest] Voice identification failed: ' + err.message);
    return {};
  } finally {
    try { fs.unlinkSync(segPath); } catch {}
  }
}

/**
 * Download audio from a signed URL to /tmp. Returns local path or null.
 */
async function downloadAudio(signedUrl, recordingId) {
  const destPath = `/tmp/pocket-audio-${recordingId}.mp3`;
  try {
    const res = await axios({ url: signedUrl, method: 'GET', responseType: 'stream', timeout: 60000 });
    const writer = fs.createWriteStream(destPath);
    await new Promise((resolve, reject) => {
      res.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    return destPath;
  } catch (err) {
    log('[Ingest] Audio download failed: ' + err.message);
    return null;
  }
}

// ── Confidence gate ───────────────────────────────────────────────────────────

/**
 * Combine the three signals into a final confidence level.
 *
 * Signals:
 *   A: devicePerson (always known — the device owner is SPEAKER_00)
 *   B: voiceMatches { speakerLabel: { name, confidence } } (from voice-identify.py)
 *   C: analysis.client + analysis.confidence (from Claude)
 *
 * Returns:
 *   { level: 'high'|'medium'|'low', conflicted: bool, reason: string, resolvedClient: string|null }
 */
function evaluateConfidence(devicePerson, voiceMatches, analysis, business) {
  const contentClient  = analysis.client;
  const contentConfidence = analysis.confidence;

  // Find which client voice matches map to.
  // voice-identify.py returns { speakerLabel: { name, confidence } }; tolerate a
  // legacy plain-string form { speakerLabel: "Name" } as well.
  const VOICE_MATCH_FLOOR = 0.75; // ignore weak speaker matches
  let voiceClient = null;
  if (Object.keys(voiceMatches).length > 0) {
    // Team roster names can be partial (e.g. "Luis") while a voice profile may be
    // fuller ("Luis Canuto"), so match on name-token overlap rather than exact string.
    const teamTokenSets = (business.people || []).map(p =>
      new Set(String(p.name || p).toLowerCase().split(/\s+/).filter(Boolean)));
    const isTeamMember = (nm) => {
      const toks = nm.toLowerCase().split(/\s+/).filter(Boolean);
      return teamTokenSets.some(ts => toks.some(t => ts.has(t)));
    };
    for (const [, val] of Object.entries(voiceMatches)) {
      const name = (val && typeof val === 'object') ? val.name : val;
      const conf = (val && typeof val === 'object' && typeof val.confidence === 'number') ? val.confidence : 1;
      if (typeof name !== 'string' || !name || conf < VOICE_MATCH_FLOOR) continue;
      if (!isTeamMember(name)) {
        // This is an enrolled voice that is NOT on the team → must be a client
        const match = business.clients.find(c =>
          c.name.toLowerCase().includes(name.split(' ')[0].toLowerCase()) ||
          name.toLowerCase().includes(c.name.split(' ').slice(-1)[0].toLowerCase())
        );
        if (match) { voiceClient = match.name; break; }
        voiceClient = name; // enrolled but not roster-matched → treat as unknown
      }
    }
  }

  // Gate evaluation
  if (contentClient === 'UNKNOWN' || !contentClient) {
    return { level: 'low', conflicted: false, reason: 'content signal returned UNKNOWN', resolvedClient: null };
  }

  // Signal conflict: voice says one client, content says another
  if (voiceClient && voiceClient !== contentClient &&
      !voiceClient.toLowerCase().includes(contentClient.split(' ').slice(-1)[0].toLowerCase()) &&
      !contentClient.toLowerCase().includes(voiceClient.split(' ')[0].toLowerCase())) {
    return {
      level: 'medium',
      conflicted: true,
      reason: `voice match suggests "${voiceClient}" but content analysis says "${contentClient}"`,
      resolvedClient: null,
    };
  }

  // Voice agrees with content → elevate
  if (voiceClient && contentConfidence === 'medium') {
    return { level: 'high', conflicted: false, reason: 'voice + content agree', resolvedClient: contentClient };
  }

  if (contentConfidence === 'high') {
    return { level: 'high', conflicted: false, reason: 'content signal high', resolvedClient: contentClient };
  }

  if (contentConfidence === 'medium') {
    return { level: 'medium', conflicted: false, reason: 'content medium, no voice confirmation', resolvedClient: contentClient };
  }

  return { level: 'low', conflicted: false, reason: 'low content confidence', resolvedClient: contentClient };
}

// ── Jobber: write note ────────────────────────────────────────────────────────

function writeJobberNote(clientName, noteText, jobTitle, jobNumber) {
  // When we've resolved a specific jobNumber, target it explicitly with --job N
  // (most precise). Otherwise fall back to jobber-cli.js's content auto-router and
  // include the job title in the note body as a routing hint for multi-job clients.
  const args = [JOBBER_CLI, 'note', clientName];
  if (jobNumber) {
    args.push(noteText, '--job', String(jobNumber));
  } else {
    const fullNote = jobTitle ? `[Job: ${jobTitle}]\n${noteText}` : noteText;
    args.push(fullNote);
  }

  execFileSync(NODE, args, {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

// ── Jobber: get jobs for client ───────────────────────────────────────────────

function getJobsForClient(clientName) {
  try {
    const out = execFileSync(NODE, [JOBBER_CLI, 'jobs', clientName], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Parse output like "Jobs for X (N):\n  #26 [LATE] — Lighting Extras\n..."
    const jobs = [];
    const lines = out.split('\n');
    for (const line of lines) {
      const m = line.match(/#(\d+)\s+\[.*?\]\s+—\s+(.+)/);
      if (m) jobs.push({ jobNumber: m[1], title: m[2].trim() });
    }
    return jobs;
  } catch {
    return [];
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function runIngestion() {
  const config = loadConfig();
  const autoWriteMode = config.auto_write_mode || 'strict';
  const silenceThreshold = config.silence_threshold_seconds || 180;

  // Telegram notification config (Z bot → Luis)
  const zEnvPath = '/root/.hermes/profiles/z/.env';
  let botToken = null;
  let chatId = null;
  try {
    const zEnv = fs.readFileSync(zEnvPath, 'utf8');
    const tokenMatch = zEnv.match(/TELEGRAM_BOT_TOKEN\s*=\s*(.+)/);
    const chatMatch  = zEnv.match(/TELEGRAM_HOME_CHANNEL\s*=\s*(.+)/);
    if (tokenMatch) botToken = tokenMatch[1].trim();
    if (chatMatch)  chatId   = chatMatch[1].trim();
  } catch (_) {}

  let totalQueued = 0;
  const newQueueItems = [];

  for (const business of config.businesses) {
    if (!business.pocket_api_key || business.pocket_api_key.includes('REPLACE_ME')) continue;

    const devices = business.pocket_devices || [{ api_key: business.pocket_api_key, person: 'unknown' }];

    for (const device of devices) {
      const apiKey = device.api_key || business.pocket_api_key;
      const devicePerson = device.person || 'unknown';

      let recordings;
      try {
        recordings = await fetchRecordings(apiKey);
      } catch (err) {
        log(`[Ingest] Failed to fetch recordings for ${devicePerson}: ${err.message}`);
        continue;
      }

      // Filter: completed state only, not already processed
      const newRecs = recordings.filter(r =>
        r.state === 'completed' &&
        !isProcessed(business.name, r.id)
      );

      if (newRecs.length === 0) {
        log(`[Ingest] ${devicePerson}: no new recordings`);
        continue;
      }

      log(`[Ingest] ${devicePerson}: ${newRecs.length} new recording(s)`);

      for (const rec of newRecs) {
        // A recording is marked processed ONLY when processRecording reaches a
        // terminal outcome (resolves). A transient failure throws → we don't mark,
        // so the next cron run retries with a fresh signed URL. A bounded counter
        // prevents both silent drops and infinite retries of a poison recording.
        // The per-recording try/catch also stops one bad recording from aborting
        // the whole batch.
        try {
          await processRecording(rec, apiKey, devicePerson, business, silenceThreshold, autoWriteMode, newQueueItems);
          markProcessed(business.name, rec.id, { device: devicePerson, processed_by: 'pocket-ingest' });
          clearAttempts(business.name, rec.id);
        } catch (err) {
          const attempts = bumpAttempt(business.name, rec.id);
          if (attempts >= MAX_INGEST_ATTEMPTS) {
            log(`[Ingest] ${rec.id}: failed ${attempts}x (${err.message}) — giving up, marking processed`);
            markProcessed(business.name, rec.id, {
              device: devicePerson, processed_by: 'pocket-ingest',
              failed: true, last_error: err.message, attempts,
            });
            clearAttempts(business.name, rec.id);
          } else {
            log(`[Ingest] ${rec.id}: transient failure (attempt ${attempts}/${MAX_INGEST_ATTEMPTS}): ${err.message} — will retry next run`);
          }
        }
      }
    }
  }

  // Send Telegram digest if anything was queued this run
  if (newQueueItems.length > 0) {
    log(`[Ingest] Queued ${newQueueItems.length} item(s) for review`);
    await sendTelegramDigest(botToken, chatId, newQueueItems);
  }

  log('[Ingest] Done.');
}

async function processRecording(rec, apiKey, devicePerson, business, silenceThreshold, autoWriteMode, newQueueItems) {
  const recId = rec.id;
  const recDate = rec.recording_at ? rec.recording_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
  log(`[Ingest] Processing ${recId} (${devicePerson}, ${recDate})`);

  // Step 1: Get transcript segments + signed audio URL via Pocket MCP
  let mcpResult;
  let mcpFailed = false;
  try {
    mcpResult = await getRecordingWithAudio(apiKey, recId);
  } catch (err) {
    log(`[Ingest] MCP fetch failed for ${recId}: ${err.message}. Falling back to REST transcript.`);
    mcpResult = {
      recordingId: recId,
      transcriptSegments: rec.transcript?.segments || [],
      audioUrl: null,
    };
    mcpFailed = true;
  }

  const segments = mcpResult.transcriptSegments || [];
  if (segments.length === 0) {
    // If MCP failed AND the REST list carried no transcript (it usually doesn't),
    // this is a TRANSIENT empty — not a genuinely empty recording. Throw so the
    // caller leaves it unmarked and retries next run with a fresh signed URL,
    // rather than silently dropping the whole recording.
    if (mcpFailed) {
      throw new Error(`no segments after MCP failure — transient, retry`);
    }
    log(`[Ingest] ${recId}: no segments — skipping`);
    return;
  }

  // Step 2: Download audio and run voice identification
  let voiceMatches = {}; // { SPEAKER_XX: "Name" }
  let audioPath = null;

  if (mcpResult.audioUrl?.signed_url) {
    audioPath = await downloadAudio(mcpResult.audioUrl.signed_url, recId);
    if (audioPath) {
      log(`[Ingest] ${recId}: running voice identification`);
      voiceMatches = identifySpeakers(audioPath, segments);
      log(`[Ingest] ${recId}: voice matches: ${JSON.stringify(voiceMatches)}`);
    }
  }

  // Step 3: Segment into conversations
  const conversations = segmentRecording(segments, silenceThreshold);
  log(`[Ingest] ${recId}: ${conversations.length} conversation(s) after segmentation`);

  // Step 4: Process each conversation
  for (const conv of conversations) {
    await processConversation(conv, recId, recDate, devicePerson, voiceMatches, business, autoWriteMode, newQueueItems);
  }

  // Cleanup temp audio
  if (audioPath && fs.existsSync(audioPath)) {
    try { fs.unlinkSync(audioPath); } catch (_) {}
  }
}

async function processConversation(conv, recId, recDate, devicePerson, voiceMatches, business, autoWriteMode, newQueueItems) {
  const config = loadConfig();
  const label = `${recId}:conv${conv.index}`;

  // Step 4a: Analyze with Claude (new function — no "UNKNOWN is worse than a guess")
  let analysis;
  try {
    analysis = await analyzeConversation(
      config.anthropic_api_key,
      business,
      conv.transcript,
      recDate,
      devicePerson,
      null,    // confirmedClient — will be set after gate evaluation if voice confirms
      null     // knownJobs — populated below for high-confidence cases
    );
  } catch (err) {
    // Don't silently drop this conversation. We can't safely retry the whole
    // recording (earlier conversations may already have written Jobber notes in
    // normal mode → double-write), so surface it to the review queue instead.
    log(`[Ingest] ${label}: Claude analysis failed: ${err.message} — queuing for manual review`);
    const item = {
      id: 'rq_' + crypto.randomBytes(6).toString('hex'),
      recording_id: recId,
      recording_date: recDate,
      conversation_index: conv.index,
      device_person: devicePerson,
      transcript_snippet: conv.transcript.slice(0, 300),
      bucket: 'uncertain',
      proposed_client: 'UNKNOWN',
      proposed_action: 'review',
      proposed_note: null,
      confidence: 'low',
      reason: 'Claude analysis failed: ' + err.message,
      signals: { device: devicePerson, voice: Object.keys(voiceMatches).length ? voiceMatches : null },
    };
    addToQueue(item);
    newQueueItems.push(item);
    return;
  }

  // Closed-roster guard: the proposed client MUST be a known client. If the
  // model returned a team member's name or anything not on the client roster,
  // coerce it to UNKNOWN so it can never surface as a real client.
  if (analysis.client && analysis.client !== 'UNKNOWN') {
    const ac = analysis.client.toLowerCase();
    const known = business.clients.some(c => {
      const cn = c.name.toLowerCase();
      return cn === ac || cn.includes(ac) || ac.includes(cn);
    });
    if (!known) {
      log(`[Ingest] ${label}: proposed client "${analysis.client}" is not on the roster — coercing to UNKNOWN`);
      analysis.client = 'UNKNOWN';
      if (analysis.confidence === 'high') analysis.confidence = 'low';
    }
  }

  const bucket = analysis.bucket || 'uncertain';
  log(`[Ingest] ${label}: bucket=${bucket}, client=${analysis.client}, confidence=${analysis.confidence}`);

  // Step 4b: no_business_content → archive log, nothing written
  if (bucket === 'no_business_content') {
    log(`[Ingest] ${label}: no business content — archived, no action`);
    return;
  }

  // Step 4c: Evaluate confidence gate
  const gate = evaluateConfidence(devicePerson, voiceMatches, analysis, business);
  log(`[Ingest] ${label}: gate=${gate.level}, conflicted=${gate.conflicted}, reason=${gate.reason}`);

  // Step 4d: new_prospect → always review queue, never auto-create
  if (bucket === 'new_prospect' || analysis.new_client) {
    const item = buildQueueItem(recId, recDate, conv, devicePerson, voiceMatches, analysis, gate, 'new_prospect');
    addToQueue(item);
    newQueueItems.push(item);
    log(`[Ingest] ${label}: possible new client → review queue`);
    return;
  }

  // Step 4e: Confidence gate decision
  const shouldAutoWrite = autoWriteMode === 'normal' && gate.level === 'high' && !gate.conflicted;

  if (!shouldAutoWrite) {
    // Strict mode: everything goes to review queue
    // Normal mode: medium/low/conflicted goes to review queue
    const reason = autoWriteMode === 'strict'
      ? 'strict mode — all recordings require review'
      : gate.conflicted
        ? gate.reason
        : `${gate.level} confidence — needs confirmation`;

    const item = buildQueueItem(recId, recDate, conv, devicePerson, voiceMatches, analysis, gate, bucket);
    item.reason = reason;
    addToQueue(item);
    newQueueItems.push(item);
    log(`[Ingest] ${label}: → review queue (${reason})`);
    return;
  }

  // Step 4f: AUTO-WRITE (normal mode, high confidence, not conflicted)
  const clientName = gate.resolvedClient;

  // Get jobs for job-level routing
  const jobs = getJobsForClient(clientName);
  let jobTitle = null;
  let jobNumber = null;

  // Resolve a proposed job title (analysis.job_id is a title string, not a number)
  // to its concrete jobNumber so we can target the note precisely with --job N.
  const resolveJobNumber = (title) => {
    if (!title || !jobs.length) return null;
    const t = title.toLowerCase();
    const m = jobs.find(j => j.title.toLowerCase() === t)
      || jobs.find(j =>
        t.includes(j.title.toLowerCase().slice(0, 10)) ||
        j.title.toLowerCase().includes(t.slice(0, 10)));
    return m ? { number: m.jobNumber, title: m.title } : null;
  };

  if (jobs.length > 1 && analysis.job_id) {
    const matched = resolveJobNumber(analysis.job_id);
    if (matched) { jobTitle = matched.title; jobNumber = matched.number; }
  }

  // If multi-job routing needed, re-analyze with job context
  let noteText = analysis.note_text;
  if (jobs.length > 1 && !noteText) {
    const detailed = await analyzeConversation(
      loadConfig().anthropic_api_key,
      business,
      conv.transcript,
      recDate,
      devicePerson,
      clientName,
      jobs
    );
    noteText = detailed.note_text || analysis.note_text;
    if (detailed.job_id) {
      const reMatched = resolveJobNumber(detailed.job_id);
      if (reMatched) { jobTitle = reMatched.title; jobNumber = reMatched.number; }
      else { jobTitle = detailed.job_id; jobNumber = null; }
    }
  }

  if (!noteText) {
    // Build note text from parts if Claude didn't format it
    const parts = [`[${analysis.source_tag || 'Field update'}] ${recDate}`];
    if (analysis.summary) parts.push('\n' + analysis.summary);
    if (analysis.commitments?.length) {
      parts.push('\nCommitments:');
      analysis.commitments.forEach(c => parts.push(`• ${c.who} → ${c.what}`));
    }
    if (analysis.open_questions?.length) {
      parts.push('\nOpen questions:');
      analysis.open_questions.forEach(q => parts.push(`• ${q}`));
    }
    noteText = parts.join('\n');
  }

  try {
    writeJobberNote(clientName, noteText, jobTitle, jobNumber);
    log(`[Ingest] ${label}: ✓ note written to Jobber for ${clientName}${jobTitle ? ' / ' + jobTitle + (jobNumber ? ' (#' + jobNumber + ')' : '') : ''}`);
  } catch (err) {
    log(`[Ingest] ${label}: Jobber write failed: ${err.message} — sending to review queue`);
    const item = buildQueueItem(recId, recDate, conv, devicePerson, voiceMatches, analysis, gate, bucket);
    item.reason = 'Jobber write failed: ' + err.message;
    item.proposed_note = noteText;
    addToQueue(item);
    newQueueItems.push(item);
  }
}

// ── Build a review queue item ─────────────────────────────────────────────────

function buildQueueItem(recId, recDate, conv, devicePerson, voiceMatches, analysis, gate, bucket) {
  return {
    id: 'rq_' + crypto.randomBytes(6).toString('hex'),
    recording_id: recId,
    recording_date: recDate,
    conversation_index: conv.index,
    device_person: devicePerson,
    transcript_snippet: conv.transcript.slice(0, 300),
    bucket,
    proposed_client: analysis.client || 'UNKNOWN',
    proposed_job: analysis.job_id || null,
    proposed_action: 'note',
    proposed_note: analysis.note_text || null,
    confidence: gate.level,
    reason: gate.reason || '',
    signals: {
      device: devicePerson,
      voice: Object.keys(voiceMatches).length > 0 ? voiceMatches : null,
      content: analysis.client,
      content_confidence: analysis.confidence,
    },
    analysis_summary: analysis.summary || '',
    new_client_data: analysis.new_client || null,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

runIngestion().catch(err => {
  log('[Ingest] FATAL: ' + err.message);
  process.exit(1);
});

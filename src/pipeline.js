/**
 * ⚠️ LEGACY / DEAD CODE — do not edit for ingest behavior.
 *
 * This is the old PM2-managed pipeline (reached only via `npm start`/`npm run dev`
 * through src/index.js). NO Hermes cron runs it. The live ingest path is the
 * top-level `pocket-ingest.js`. This module survives only because
 * src/voice-identifier.js (which it imports) also exports helpers used by
 * voice-cli.js. See CLAUDE.md → "Live vs. legacy".
 */
const { fetchRecordings, fetchRecordingDetail, flattenTranscript } = require('./pocket');
const { analyzeTranscript } = require('./claude');
const { isProcessed, markProcessed } = require('./storage');
const { getLocation } = require('./location-cache');
const { addClientToConfig } = require('./config');
const notion = require('./notion');
const { writeToJobber } = require('./jobber');
const { identifySpeakers, applyNamesToTranscript } = require('./voice-identifier');
const { log } = require('./logger');

async function processBusiness(anthropicApiKey, business, locationTimeoutHours = 12) {
  const { name, notion_token, notion_databases } = business;

  // Support both single pocket_api_key and multi-device pocket_devices array
  const devices = business.pocket_devices && business.pocket_devices.length > 0
    ? business.pocket_devices
    : [{ api_key: business.pocket_api_key, person: null }];

  // Collect recordings from all devices
  let allRecordings = [];
  for (const device of devices) {
    const label = device.person ? `${name}/${device.person}` : name;
    log(`[${label}] Fetching recordings...`);
    try {
      const recs = await fetchRecordings(device.api_key);
      const completed = recs.filter(r => r.state === 'completed');
      log(`[${label}] Found ${recs.length} total, ${completed.length} completed`);
      completed.forEach(r => allRecordings.push({ ...r, _device: device }));
    } catch (err) {
      log(`[${label}] ERROR fetching recordings: ${err.message}`);
    }
  }

  const completed = allRecordings;

  for (const recording of completed) {
    const recordingId = recording.id || recording.recording_id;
    if (!recordingId) continue;

    const device = recording._device || { api_key: business.pocket_api_key, person: null };
    const deviceLabel = device.person ? `${name}/${device.person}` : name;

    if (isProcessed(name, recordingId)) {
      log(`[${deviceLabel}] Skipping already-processed recording ${recordingId}`);
      continue;
    }

    log(`[${deviceLabel}] Processing recording ${recordingId}...`);

    try {
      const detail = await fetchRecordingDetail(device.api_key, recordingId);
      const segments = detail.transcript?.segments || detail.segments || detail.transcript_segments || [];

      if (segments.length === 0) {
        log(`[${deviceLabel}] Recording ${recordingId} has no transcript segments — skipping`);
        markProcessed(name, recordingId, { skipped: 'no_segments' });
        continue;
      }

      const recordingDate = (detail.recording_at || detail.created_at || detail.date || new Date().toISOString()).slice(0, 10);

      // Check GPS location cache — did this device check in recently?
      const confirmedClient = getLocation(device.api_key, locationTimeoutHours);

      // Speaker identification — try to map SPEAKER_XX to real names
      let transcriptText;
      try {
        const speakerMap = await identifySpeakers(
          segments,
          recordingId,
          device.person || null,        // device owner = SPEAKER_00
          confirmedClient || null        // known client = likely SPEAKER_01
        );
        const namedSpeakers = Object.values(speakerMap).filter(v => !v.startsWith('SPEAKER_'));
        if (namedSpeakers.length > 0) {
          log(`[${deviceLabel}] Speaker IDs: ${Object.entries(speakerMap).map(([k,v]) => `${k}→${v}`).join(', ')}`);
          transcriptText = applyNamesToTranscript(segments, speakerMap);
        } else {
          transcriptText = flattenTranscript(segments, business.people);
        }
      } catch (err) {
        log(`[${deviceLabel}] Speaker ID skipped: ${err.message}`);
        transcriptText = flattenTranscript(segments, business.people);
      }

      log(`[${deviceLabel}] Sending to Claude...`);
      const analysis = await analyzeTranscript(anthropicApiKey, business, transcriptText, recordingDate, confirmedClient);

      const { client: clientName, confidence, participants, summary, client_details, commitments, open_questions, log_entry, new_client, _cache_stats } = analysis;

      // Auto-create new client if Claude detected a declaration in the recording
      if (new_client?.name) {
        const exists = await notion.findClientPage(notion_token, notion_databases.clients, new_client.name);
        if (!exists) {
          log(`[${deviceLabel}] New client detected: "${new_client.name}" — creating in Notion...`);
          await notion.createClient(notion_token, notion_databases.clients, new_client);
          addClientToConfig(name, new_client.name, new_client.address || '');
          log(`[${deviceLabel}] ✓ New client "${new_client.name}" added to Notion and config.json`);
        } else {
          log(`[${deviceLabel}] New client "${new_client.name}" already exists in Notion — skipping create`);
        }
      }

      // Fallback: if Claude returned UNKNOWN but the summary or log_entry mentions a client name,
      // scan against known client keywords and auto-resolve with low confidence
      let finalClientName = clientName;
      let finalConfidence = confidence;
      if (!confirmedClient && clientName === 'UNKNOWN') {
        const scanText = `${summary || ''} ${log_entry || ''}`.toLowerCase();
        const fallback = resolveFallbackClient(scanText, business.clients);
        if (fallback) {
          log(`[${deviceLabel}] UNKNOWN resolved via summary scan → "${fallback}" (low confidence)`);
          finalClientName = fallback;
          finalConfidence = 'low';
        }
      }

      const resolvedClient = confirmedClient || finalClientName;
      const resolvedConfidence = confirmedClient ? 'high' : finalConfidence;

      log(`[${deviceLabel}] Client: "${resolvedClient}" (${resolvedClient === confirmedClient ? 'GPS-confirmed' : confidence + ' confidence'}) | cache_read=${_cache_stats?.cache_read || 0} tokens`);

      // Look up client page in Notion
      const clientPageId = await notion.findClientPage(notion_token, notion_databases.clients, resolvedClient);
      if (!clientPageId && resolvedClient !== 'UNKNOWN') {
        log(`[${deviceLabel}] WARNING: Client "${resolvedClient}" not found in Notion — writing without relation`);
      }

      const titleClient = resolvedClient !== 'UNKNOWN' ? resolvedClient : 'Unknown Client';
      const entryTitle = `${recordingDate} — ${titleClient}`;

      log(`[${deviceLabel}] Writing conversation log to Notion...`);
      const conversationPageId = await notion.createConversationLog(
        notion_token,
        notion_databases.conversation_log,
        {
          title: entryTitle,
          clientPageId,
          date: recordingDate,
          participants,
          summary: summary || log_entry,
          transcript: transcriptText,
          confidence: resolvedConfidence,
        }
      );

      if (Array.isArray(client_details) && client_details.length > 0) {
        log(`[${deviceLabel}] Writing ${client_details.length} client detail(s)...`);
        for (const detail of client_details) {
          await notion.createClientDetail(notion_token, notion_databases.client_details, {
            detail,
            clientPageId,
            category: inferCategory(detail),
            conversationPageId,
            date: recordingDate,
          });
        }
      }

      if (Array.isArray(commitments) && commitments.length > 0) {
        log(`[${deviceLabel}] Writing ${commitments.length} commitment(s)...`);
        for (const c of commitments) {
          await notion.createCommitment(notion_token, notion_databases.commitments, {
            what: c.what,
            clientPageId,
            who: c.who,
            promisedTo: c.promised_to,
            conversationPageId,
          });
        }
      }

      if (Array.isArray(open_questions) && open_questions.length > 0) {
        log(`[${deviceLabel}] Writing ${open_questions.length} open question(s)...`);
        for (const question of open_questions) {
          await notion.createOpenQuestion(notion_token, notion_databases.open_questions, {
            question,
            clientPageId,
            askedBy: participants?.[0] || 'Unknown',
            conversationPageId,
          });
        }
      }

      // Write to Jobber if configured
      if (business.jobber) {
        await writeToJobber(business.jobber, resolvedClient, analysis, recordingDate);
      }

      markProcessed(name, recordingId, { client: resolvedClient, confidence: resolvedConfidence });
      log(`[${deviceLabel}] ✓ Recording ${recordingId} processed successfully`);

    } catch (err) {
      log(`[${deviceLabel}] ERROR processing recording ${recordingId}: ${err.message}`);
      if (err.response?.data) {
        log(`[${deviceLabel}]  API response: ${JSON.stringify(err.response.data).slice(0, 300)}`);
      }
    }
  }
}

// Scan free-form text (summary + log_entry) for client name/keyword matches.
// Returns the best-matching client name, or null if nothing found.
function resolveFallbackClient(text, clients = []) {
  if (!text || !clients.length) return null;

  for (const c of clients) {
    // Build the same keyword set as the Claude prompt
    const lastName = c.name.split(' ').slice(-1)[0];
    const street = (c.address || '').match(/\d+\s+\S+\s+(\S+)/)?.[1] || '';
    const custom = Array.isArray(c.keywords) ? c.keywords : [];
    const keywords = [...new Set([...custom, c.name, lastName, street].filter(Boolean))];

    for (const kw of keywords) {
      if (kw.length >= 3 && text.includes(kw.toLowerCase())) {
        return c.name;
      }
    }
  }
  return null;
}

function inferCategory(detail) {
  const lower = (detail || '').toLowerCase();
  if (/floor|tile|paint|color|finish|cabinet|countertop|trim|door|window|fixture/.test(lower)) return 'Finishes';
  if (/layout|room|wall|kitchen|bath|bedroom|living|space|move|relocate|design/.test(lower)) return 'Layout';
  if (/schedule|date|week|month|deadline|start|complete|finish|timeline/.test(lower)) return 'Schedule';
  if (/budget|cost|price|pay|money|quote|estimate|invoice/.test(lower)) return 'Budget';
  return 'Other';
}

module.exports = { processBusiness };

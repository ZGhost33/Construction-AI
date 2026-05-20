const { fetchRecordings, fetchRecordingDetail, flattenTranscript } = require('./pocket');
const { analyzeTranscript } = require('./claude');
const { isProcessed, markProcessed } = require('./storage');
const { getLocation } = require('./location-cache');
const { addClientToConfig } = require('./config');
const notion = require('./notion');
const { writeToJobber } = require('./jobber');
const { log } = require('./logger');

async function processBusiness(anthropicApiKey, business, locationTimeoutHours = 12) {
  const { name, pocket_api_key, notion_token, notion_databases } = business;

  log(`[${name}] Fetching recordings...`);
  let recordings;
  try {
    recordings = await fetchRecordings(pocket_api_key);
  } catch (err) {
    log(`[${name}] ERROR fetching recordings: ${err.message}`);
    return;
  }

  const completed = recordings.filter(r => r.state === 'completed');
  log(`[${name}] Found ${recordings.length} total, ${completed.length} completed`);

  for (const recording of completed) {
    const recordingId = recording.id || recording.recording_id;
    if (!recordingId) continue;

    if (isProcessed(name, recordingId)) {
      log(`[${name}] Skipping already-processed recording ${recordingId}`);
      continue;
    }

    log(`[${name}] Processing recording ${recordingId}...`);

    try {
      const detail = await fetchRecordingDetail(pocket_api_key, recordingId);
      const segments = detail.transcript?.segments || detail.segments || detail.transcript_segments || [];

      if (segments.length === 0) {
        log(`[${name}] Recording ${recordingId} has no transcript segments — skipping`);
        markProcessed(name, recordingId, { skipped: 'no_segments' });
        continue;
      }

      const transcriptText = flattenTranscript(segments, business.people);
      const recordingDate = (detail.recording_at || detail.created_at || detail.date || new Date().toISOString()).slice(0, 10);

      // Check GPS location cache — did this device check in recently?
      const confirmedClient = getLocation(pocket_api_key, locationTimeoutHours);
      if (confirmedClient) {
        log(`[${name}] Location confirmed: "${confirmedClient}" (GPS check-in)`);
      }

      log(`[${name}] Sending to Claude...`);
      const analysis = await analyzeTranscript(anthropicApiKey, business, transcriptText, recordingDate, confirmedClient);

      const { client: clientName, confidence, participants, summary, client_details, commitments, open_questions, log_entry, new_client, _cache_stats } = analysis;

      // Auto-create new client if Claude detected a declaration in the recording
      if (new_client?.name) {
        const exists = await notion.findClientPage(notion_token, notion_databases.clients, new_client.name);
        if (!exists) {
          log(`[${name}] New client detected: "${new_client.name}" — creating in Notion...`);
          await notion.createClient(notion_token, notion_databases.clients, new_client);
          addClientToConfig(name, new_client.name, new_client.address || '');
          log(`[${name}] ✓ New client "${new_client.name}" added to Notion and config.json`);
        } else {
          log(`[${name}] New client "${new_client.name}" already exists in Notion — skipping create`);
        }
      }

      const resolvedClient = confirmedClient || clientName;
      const resolvedConfidence = confirmedClient ? 'high' : confidence;

      log(`[${name}] Client: "${resolvedClient}" (${resolvedClient === confirmedClient ? 'GPS-confirmed' : confidence + ' confidence'}) | cache_read=${_cache_stats?.cache_read || 0} tokens`);

      // Look up client page in Notion
      const clientPageId = await notion.findClientPage(notion_token, notion_databases.clients, resolvedClient);
      if (!clientPageId && resolvedClient !== 'UNKNOWN') {
        log(`[${name}] WARNING: Client "${resolvedClient}" not found in Notion — writing without relation`);
      }

      const titleClient = resolvedClient !== 'UNKNOWN' ? resolvedClient : 'Unknown Client';
      const entryTitle = `${recordingDate} — ${titleClient}`;

      log(`[${name}] Writing conversation log to Notion...`);
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
        log(`[${name}] Writing ${client_details.length} client detail(s)...`);
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
        log(`[${name}] Writing ${commitments.length} commitment(s)...`);
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
        log(`[${name}] Writing ${open_questions.length} open question(s)...`);
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
      log(`[${name}] ✓ Recording ${recordingId} processed successfully`);

    } catch (err) {
      log(`[${name}] ERROR processing recording ${recordingId}: ${err.message}`);
      if (err.response?.data) {
        log(`[${name}]   API response: ${JSON.stringify(err.response.data).slice(0, 300)}`);
      }
    }
  }
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

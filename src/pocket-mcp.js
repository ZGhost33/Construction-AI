/**
 * pocket-mcp.js — Pocket MCP client for signed audio URLs
 *
 * The Pocket REST API (/api/v1/public/recordings) returns transcripts only.
 * The Pocket MCP server (public.heypocketai.com/mcp) exposes signed S3 audio
 * URLs via the get_pocket_conversation tool. URLs expire in 1 hour.
 *
 * Usage:
 *   const { getRecordingWithAudio } = require('./src/pocket-mcp');
 *   const result = await getRecordingWithAudio(apiKey, recordingId);
 *   // result: { recordingId, recordingTitle, recordingDate, transcriptSegments, audioUrl }
 *   // audioUrl: { signed_url, expires_in, expires_at } or null
 */

const axios = require('axios');

const MCP_URL = 'https://public.heypocketai.com/mcp';
const MCP_TIMEOUT = 30000;

/**
 * Open a Pocket MCP session and return the session ID.
 */
async function openSession(apiKey) {
  const res = await axios.post(MCP_URL, {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pocket-ingest', version: '1.0.0' },
    },
    id: 1,
  }, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: MCP_TIMEOUT,
  });

  const sessionId = res.headers['mcp-session-id'];
  if (!sessionId) throw new Error('Pocket MCP: no session ID returned from initialize');
  return sessionId;
}

/**
 * Parse an SSE response body into a JSON-RPC result.
 * Pocket MCP returns: "event: message\ndata: {...}\n\n"
 */
function parseSseBody(body) {
  if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
    return body; // axios already parsed JSON
  }
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  const match = text.match(/data:\s*(\{[\s\S]*\})/);
  if (!match) throw new Error('Pocket MCP: could not parse SSE body: ' + text.slice(0, 200));
  return JSON.parse(match[1]);
}

/**
 * Fetch recording detail including signed audio URL via the Pocket MCP.
 *
 * Returns:
 *   {
 *     recordingId, recordingTitle, recordingDate, recordingTags,
 *     transcriptSegments: [{speaker, text, start, end}],
 *     audioUrl: { signed_url, expires_in, expires_at } | null
 *   }
 */
async function getRecordingWithAudio(apiKey, recordingId) {
  const sessionId = await openSession(apiKey);

  const res = await axios.post(MCP_URL, {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'get_pocket_conversation',
      arguments: { recording_ids: [recordingId] },
    },
    id: 2,
  }, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'mcp-session-id': sessionId,
    },
    timeout: MCP_TIMEOUT,
    responseType: 'text',
  });

  const envelope = parseSseBody(res.data);
  if (envelope.error) {
    throw new Error('Pocket MCP get_pocket_conversation error: ' + JSON.stringify(envelope.error));
  }

  const contentText = envelope.result?.content?.[0]?.text;
  if (!contentText) throw new Error('Pocket MCP: empty content in get_pocket_conversation response');

  const parsed = JSON.parse(contentText);
  const recordings = parsed.recordings || parsed.data || (Array.isArray(parsed) ? parsed : [parsed]);

  const rec = recordings.find(r => r.recordingId === recordingId) || recordings[0];
  if (!rec) throw new Error('Pocket MCP: recording ' + recordingId + ' not found in response');

  return {
    recordingId: rec.recordingId,
    recordingTitle: rec.recordingTitle || '',
    recordingDate: rec.recordingDate || '',
    recordingTags: rec.recordingTags || [],
    transcriptSegments: rec.transcriptSegments || [],
    audioUrl: rec.audioUrl || null,
  };
}

module.exports = { getRecordingWithAudio };

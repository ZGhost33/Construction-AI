const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// Model to use — update as newer versions are released
const MODEL = 'claude-sonnet-4-6';

let _client = null;

function getClient(apiKey) {
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

// Load scopes from client-scopes.json — keyed by businessName → clientName → scope text
function loadScopes(businessName) {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'client-scopes.json'), 'utf8');
    return JSON.parse(raw)[businessName] || {};
  } catch { return {}; }
}

// Build the static system prompt for a business — this content is cached
function buildSystemContent(business) {
  const scopes = loadScopes(business.name);

  const clientList = business.clients
    .map(c => {
      const scope = scopes[c.name];
      return scope
        ? `- ${c.name} — ${c.address}\n  Scope: ${scope}`
        : `- ${c.name} — ${c.address}`;
    })
    .join('\n');

  const peopleList = business.people
    .map(p => `- ${p.name} = ${p.role}`)
    .join('\n');

  // Build keyword map from client list — last name + street name + any custom keywords
  const keywordMap = business.clients.map(c => {
    const lastName = c.name.split(' ').slice(-1)[0];
    const street = (c.address || '').match(/\d+\s+\S+\s+(\S+)/)?.[1] || '';
    const custom = Array.isArray(c.keywords) ? c.keywords : [];
    const all = [...new Set([...custom, lastName, street].filter(Boolean))];
    return `- "${all.join(', ')}" → ${c.name}`;
  }).join('\n');

  return `You are analyzing construction project conversations for ${business.name}.

ACTIVE CLIENTS:
${clientList || '(none configured)'}

CLIENT KEYWORD SHORTCUTS — if any of these words or names appear anywhere in the transcript, map to that client:
${keywordMap || '(none configured)'}

KNOWN PEOPLE AND ROLES:
${peopleList || '(none configured)'}

INSTRUCTIONS:
Analyze the transcript below and return ONLY valid JSON — no markdown fences, no explanation, just the JSON object.

Required JSON structure:
{
  "client": "<best-match client name from the list above, or UNKNOWN>",
  "confidence": "<high|medium|low>",
  "participants": ["name1", "name2"],
  "summary": "<2-3 sentence summary of what was discussed>",
  "client_details": ["specific decision or detail 1", "specific decision or detail 2"],
  "commitments": [
    {"who": "name", "promised_to": "name", "what": "what was promised", "by_when": "deadline as ISO date string or null"}
  ],
  "open_questions": ["unresolved question 1"],
  "log_entry": "<one paragraph suitable for a project log>",
  "new_client": null
}

Rules:
- client matching: use the CLIENT KEYWORD SHORTCUTS above aggressively. A single last name mention (e.g. "Harris", "Joyce", "Callery") is enough to identify the client with high confidence. A street name alone (e.g. "Oakmont", "Brandywine", "Burning Tree") is also enough. If multiple keywords appear, pick the strongest match.
- scope matching: each client has a Scope line listing their project work (rooms, materials, fixtures, trade work). If no name or street is mentioned but the conversation describes work that matches a client's scope (e.g. "the shower conversion" → Deb Vivian, "the impact windows" → Tara Squier, "the kitchen cabinets" → a client with a cabinet scope), use the scope to identify the client. Scope match alone is sufficient for medium confidence.
- CRITICAL: if you can identify which client this conversation is about from ANY context clue — the work being described, the location, the people present, a partial name, anything — put that client in the "client" field. Do NOT return UNKNOWN if you have enough context to make a reasonable guess. A medium or low confidence match is always better than UNKNOWN.
- CONSISTENCY RULE: if your summary mentions a client's name, you MUST use that same client in the "client" field. It is never acceptable to write a client's name in the summary but return UNKNOWN in the client field.
- if the confirmed client is provided at the top, always use that — never override it.
- client_details: only concrete facts, decisions, or specifications (materials, dimensions, colors, finishes, layout changes). Skip vague statements.
- commitments: only explicit promises with a clear responsible party and deliverable.
- open_questions: only genuinely unresolved items that need follow-up.
- If an array has no entries, return an empty array [].
- new_client: if anyone in the recording explicitly declares a new client being added (phrases like "new client", "new project for", "adding [name]", "new customer"), extract: {"name": "Full Name", "address": "full address or null", "contact": "phone or email or null"}. Otherwise set to null.
- Do not include any text outside the JSON object.`;
}

// Parse Claude's response — handles unescaped quotes and markdown fences
function parseAnalysis(text) {
  const cleaned = text.trim();

  // First try direct parse
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // Strip markdown fences if present
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch (_) {}
  }

  // Regex extraction: find outermost JSON object
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch (_) {}
  }

  throw new Error(`Could not parse Claude response as JSON. Response was:\n${cleaned.slice(0, 500)}`);
}

async function analyzeTranscript(apiKey, business, transcriptText, recordingDate, confirmedClient = null) {
  const client = getClient(apiKey);

  const locationLine = confirmedClient
    ? `CONFIRMED CLIENT (GPS check-in — do not override): ${confirmedClient}\n\n`
    : '';

  const userContent = `${locationLine}Recording date: ${recordingDate || 'unknown'}

TRANSCRIPT:
${transcriptText}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: buildSystemContent(business),
        // Cache the static system prompt — it's the same for every recording
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: userContent,
      },
    ],
  });

  const raw = response.content[0]?.text || '';
  const analysis = parseAnalysis(raw);

  // Attach cache usage stats for logging
  const usage = response.usage || {};
  analysis._cache_stats = {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_created: usage.cache_creation_input_tokens,
  };

  return analysis;
}

// ── New pipeline: analyzeConversation ────────────────────────────────────────
// Analyzes a PRE-SEGMENTED conversation chunk.
// Key difference: does NOT have "UNKNOWN is worse than a guess".
// See full JSDoc in the function body.

async function analyzeConversation(apiKey, business, transcript, recordingDate, devicePerson, confirmedClient, knownJobs) {
  const client = getClient(apiKey);
  const scopes = loadScopes(business.name);

  const clientList = business.clients
    .map(c => {
      const scope = scopes[c.name];
      return scope ? `- ${c.name} — ${c.address}\n  Scope: ${scope}` : `- ${c.name} — ${c.address}`;
    })
    .join('\n');

  const peopleList = business.people
    .map(p => `- ${p.name} = ${p.role}`)
    .join('\n');

  const keywordMap = business.clients.map(c => {
    const lastName = c.name.split(' ').slice(-1)[0];
    const street = (c.address || '').match(/\d+\s+\S+\s+(\S+)/)?.[1] || '';
    const custom = Array.isArray(c.keywords) ? c.keywords : [];
    const all = [...new Set([...custom, lastName, street].filter(Boolean))];
    return `- "${all.join(', ')}" → ${c.name}`;
  }).join('\n');

  const jobSection = (confirmedClient && knownJobs && knownJobs.length > 0)
    ? `\nCONFIRMED CLIENT: ${confirmedClient}\nRoute to the specific job whose scope best matches this conversation:\n${knownJobs.map(j => `- Job #${j.jobNumber}: ${j.title}`).join('\n')}\nIf content spans two separate job scopes, set job_id to null and list both numbers in job_ids_multi.\nIf uncertain which job, set job_id to null.`
    : '';

  const systemContent = `You are analyzing construction project conversations for ${business.name}.

ACTIVE CLIENTS:
${clientList || '(none configured)'}

CLIENT KEYWORD SHORTCUTS — if any of these words or names appear, map to that client:
${keywordMap || '(none configured)'}

KNOWN PEOPLE AND ROLES:
${peopleList || '(none configured)'}

DEVICE WORN BY: ${devicePerson || 'unknown'} — SPEAKER_00 is most likely ${devicePerson || 'the device owner'}.
${jobSection}

INSTRUCTIONS:
Analyze this pre-segmented conversation (it is ONE conversation already).
Return ONLY valid JSON — no markdown fences, no explanation.

{
  "client": "<exact client name from list, or UNKNOWN>",
  "confidence": "<high|medium|low>",
  "bucket": "<job_relevant|new_prospect|no_business_content|uncertain>",
  "source_tag": "<Client meeting|Field update|Internal|Supplier call>",
  "participants": ["name1"],
  "job_id": "<Job #N title or null>",
  "job_ids_multi": [],
  "summary": "<2-3 sentence summary>",
  "commitments": [{"who": "name", "what": "promised", "by_when": "ISO date or null"}],
  "open_questions": ["unresolved question"],
  "note_text": "<formatted note ready for Jobber — [source_tag] date, summary, commitments, open questions>",
  "new_client": null
}

CRITICAL RULES:
- Return UNKNOWN if you do not have enough context to identify the client. Do NOT guess to avoid UNKNOWN.
- Single keyword match (one last name, one street) = medium confidence at most.
- Two or more independent signals (name + scope, or name + address) = high confidence.
- no_business_content: personal talk, dead air, zero job context.
- Internal team conversations (Luis/Jorge/Danilo giving status, deciding next steps) are job_relevant — never no_business_content.
- source_tag: "Client meeting" if a non-team participant is present; "Field update" if device owner is at a job site reporting in; "Internal" if all team members; "Supplier call" if a supplier is talking.
- note_text format: "[source_tag] YYYY-MM-DD\\n\\n<summary paragraph>\\n\\nCommitments:\\n• who → what\\n\\nOpen questions:\\n• question". Omit empty sections.
- new_client: only if someone explicitly declares a new client (name + project intent). Otherwise null.`;

  const confirmedLine = confirmedClient
    ? `CONFIRMED CLIENT (voice identification — do not override): ${confirmedClient}\n\n`
    : '';

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `${confirmedLine}Recording date: ${recordingDate || 'unknown'}\n\nTRANSCRIPT:\n${transcript}` }],
  });

  const raw = response.content[0]?.text || '';
  const analysis = parseAnalysis(raw);
  const usage = response.usage || {};
  analysis._cache_stats = {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_created: usage.cache_creation_input_tokens,
  };
  return analysis;
}

// ── Multi-job segment split (Intelligent Jobs §A) ─────────────────────────────
// A single conversation can cover several jobs (Harris drywall + the Gallan job
// + a trim order for a third site). Filing all of that under one client
// cross-contaminates per-job state. This splits the conversation into SEGMENTS,
// one per distinct client/job/topic, each fully attributed and noted on its own.
// Single-job conversations return exactly one segment (the n=1 common case,
// behaviourally identical to analyzeConversation). One LLM call, same cost.
async function analyzeConversationSegments(apiKey, business, transcript, recordingDate, devicePerson) {
  const client = getClient(apiKey);
  const scopes = loadScopes(business.name);

  const clientList = business.clients
    .map(c => {
      const scope = scopes[c.name];
      return scope ? `- ${c.name} — ${c.address}\n  Scope: ${scope}` : `- ${c.name} — ${c.address}`;
    })
    .join('\n');
  const peopleList = business.people.map(p => `- ${p.name} = ${p.role}`).join('\n');
  const keywordMap = business.clients.map(c => {
    const lastName = c.name.split(' ').slice(-1)[0];
    const street = (c.address || '').match(/\d+\s+\S+\s+(\S+)/)?.[1] || '';
    const custom = Array.isArray(c.keywords) ? c.keywords : [];
    const all = [...new Set([...custom, lastName, street].filter(Boolean))];
    return `- "${all.join(', ')}" → ${c.name}`;
  }).join('\n');

  const systemContent = `You are analyzing construction project conversations for ${business.name}.

ACTIVE CLIENTS:
${clientList || '(none configured)'}

CLIENT KEYWORD SHORTCUTS — if any of these words or names appear, map to that client:
${keywordMap || '(none configured)'}

KNOWN PEOPLE AND ROLES:
${peopleList || '(none configured)'}

DEVICE WORN BY: ${devicePerson || 'unknown'} — SPEAKER_00 is most likely ${devicePerson || 'the device owner'}.

INSTRUCTIONS:
This recording may cover MORE THAN ONE job or client — the speaker often moves
between sites in one continuous talk. Split it into SEGMENTS, one per distinct
client/job/topic. If the whole thing is about a single job, return exactly ONE
segment. Return ONLY valid JSON — no markdown fences, no explanation.

{
  "segments": [
    {
      "client": "<exact client name from the list, or UNKNOWN>",
      "confidence": "<high|medium|low>",
      "bucket": "<job_relevant|new_prospect|no_business_content|uncertain>",
      "source_tag": "<Client meeting|Field update|Internal|Supplier call>",
      "participants": ["name1"],
      "job_id": "<Job title hint or null>",
      "topic": "<3-6 word label, e.g. 'Harris drywall' or 'trim material order'>",
      "transcript_excerpt": "<the lines from THIS segment only, quoted, ~400 chars max>",
      "summary": "<2-3 sentence summary of THIS segment only>",
      "commitments": [{"who": "name", "what": "promised", "by_when": "ISO date or null"}],
      "open_questions": ["unresolved question"],
      "note_text": "<Jobber note for THIS segment only — [source_tag] date, summary, commitments, open questions>",
      "new_client": null
    }
  ]
}

CRITICAL RULES:
- One segment per distinct job/client. A talk about Harris drywall, the Gallan
  job, and a trim order for a third site = THREE segments. But never split a
  single coherent job discussion into several segments.
- ISOLATION: each segment's summary, commitments, and note_text contain ONLY
  that segment's facts. NEVER let one job's facts appear in another segment —
  wrong attribution corrupts downstream job state. This is the whole point.
- Return UNKNOWN for a segment's client if you cannot identify it. Do NOT guess
  to avoid UNKNOWN — an unidentified segment is fine, a human will route it.
- Single keyword match (one last name, one street) = medium confidence at most.
  Two or more independent signals (name + scope, or name + address) = high.
- no_business_content: personal talk, dead air, zero job context — give it its
  own segment with that bucket; it will be dropped.
- Internal team status/next-steps talk is job_relevant, never no_business_content.
- source_tag: "Client meeting" if a non-team participant is present; "Field
  update" if device owner is on site reporting; "Internal" if all team members;
  "Supplier call" if a supplier is talking.
- note_text format: "[source_tag] YYYY-MM-DD\\n\\n<summary>\\n\\nCommitments:\\n• who → what\\n\\nOpen questions:\\n• question". Omit empty sections.
- new_client: only if someone explicitly declares a new client (name + intent). Otherwise null.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Recording date: ${recordingDate || 'unknown'}\n\nTRANSCRIPT:\n${transcript}` }],
  });

  const raw = response.content[0]?.text || '';
  const parsed = parseAnalysis(raw);
  // Tolerate the model returning a bare single object instead of {segments:[…]}.
  let segments = Array.isArray(parsed.segments) ? parsed.segments : null;
  if (!segments || !segments.length) segments = [parsed];
  const usage = response.usage || {};
  return {
    segments,
    _cache_stats: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read: usage.cache_read_input_tokens,
      cache_created: usage.cache_creation_input_tokens,
    },
  };
}

// ── Per-job state extraction (Intelligent Jobs §3) ────────────────────────────
// Given an approved note for ONE job, extract the job STATE it states — phase,
// status of trade/phase elements, and a one-line timeline event. STATED facts
// only: never infer beyond the text (that's §4). Conservative on purpose —
// garbage state poisons downstream inference.
async function extractJobState(apiKey, business, noteText, ctx = {}) {
  const client = getClient(apiKey);
  const sys = `You extract construction job STATE from one approved field note for ${business.name}.
Return ONLY valid JSON — no markdown fences, no explanation:
{
  "phase": "<the job's current phase if the note clearly implies one, else null>",
  "state": [ { "element": "<trade/phase or building element>", "status": "<short current status>" } ],
  "timeline_event": "<one short past-tense line summarizing what this note records, <=140 chars>"
}
RULES:
- STATED ONLY. Record only what the note actually says. If painters are coming Thursday, status is "painters scheduled Thursday" — NOT "paint started". Never infer a completion the note doesn't state.
- element: lowercase generic trade/phase words (demo, rough-in, drywall, paint, trim, flooring, inspection, etc.). Merge synonyms (sheetrock→drywall).
- 0 to 4 state items. Skip vague talk. If the note states no concrete job state, return an empty state array.
- Do not include any text outside the JSON object.`;
  const msg = `JOB: ${ctx.jobTitle || '?'} for ${ctx.client || '?'}\n\nAPPROVED NOTE:\n${noteText}`;
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: sys }],
    messages: [{ role: 'user', content: msg }],
  });
  const parsed = parseAnalysis(response.content[0]?.text || '');
  return {
    phase: parsed.phase || null,
    state: Array.isArray(parsed.state) ? parsed.state : [],
    timeline_event: parsed.timeline_event || null,
  };
}

module.exports = { analyzeTranscript, analyzeConversation, analyzeConversationSegments, extractJobState };

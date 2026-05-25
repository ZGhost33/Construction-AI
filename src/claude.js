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

module.exports = { analyzeTranscript };

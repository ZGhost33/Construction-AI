const Anthropic = require('@anthropic-ai/sdk');

// Model to use — update as newer versions are released
const MODEL = 'claude-sonnet-4-6';

let _client = null;

function getClient(apiKey) {
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

// Build the static system prompt for a business — this content is cached
function buildSystemContent(business) {
  const clientList = business.clients
    .map(c => `- ${c.name} — ${c.address}`)
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

/**
 * docs-generator.js
 *
 * Uses Claude to generate a week-by-week project schedule and a
 * trade-categorized materials list from a Jobber quote's line items.
 * Returns structured JSON for pdf-generator.js to render.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-6';
let _client = null;
function getClient(apiKey) {
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

// Try to parse JSON — if truncated, attempt to recover the partial structure
function parseJSON(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  try { return JSON.parse(cleaned); } catch (_) {}

  // Recovery: find the last complete top-level array item and close the structure
  // Works for both schedule (weeks array) and materials (categories array)
  const arrayKey = cleaned.includes('"weeks"') ? '"weeks"' : '"categories"';
  const arrStart = cleaned.indexOf('[', cleaned.indexOf(arrayKey));
  if (arrStart === -1) throw new Error('Could not parse response as JSON');

  // Walk backwards from end to find last complete object (ends with })
  let truncated = cleaned;
  const lastCompleteObj = truncated.lastIndexOf('},');
  if (lastCompleteObj > arrStart) {
    truncated = truncated.slice(0, lastCompleteObj + 1) + ']}}';
    try { return JSON.parse(truncated); } catch (_) {}
  }
  throw new Error('Could not recover truncated JSON response');
}

function buildScopeText(quote) {
  return (quote.lineItems || [])
    .filter(li => li.name && !li.name.toLowerCase().startsWith('scope note'))
    .map(li => {
      const desc = (li.description || '').trim();
      return desc ? `• ${li.name}: ${desc}` : `• ${li.name}`;
    })
    .join('\n');
}

// ── Schedule generator ────────────────────────────────────────────────────────

async function generateSchedule(apiKey, quote, clientName) {
  const client = getClient(apiKey);
  const scope = buildScopeText(quote);

  const prompt = `You are a construction project manager for Cruz Services, a residential remodeling contractor in Stuart, FL.

Generate a realistic week-by-week project schedule for this job.

Client: ${clientName}
Job: ${quote.title}

SCOPE OF WORK:
${scope}

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "project_name": "${quote.title}",
  "estimated_duration_weeks": <number>,
  "assumptions": [
    "Permits pulled and approved before work begins",
    "Materials ordered and confirmed before each phase starts",
    "<any other relevant assumption based on scope>"
  ],
  "weeks": [
    {
      "week": "Week 1",
      "phase": "<phase name, e.g. Demolition>",
      "tasks": ["<specific task>", "<specific task>"],
      "trades": ["<trade, e.g. General Contractor>", "<trade>"]
    }
  ],
  "milestones": [
    {"name": "<milestone name>", "week": "Week X"}
  ]
}

Rules:
- Be realistic about duration — don't compress trades that can't overlap
- Group tasks logically: demo → rough framing → rough mechanical → inspections → drywall → finishes → punch-out
- Identify which trades are on site each week
- Milestones should mark major phase completions and client walk-throughs
- If scope includes permits, add a permit approval wait period (usually 1-2 weeks)
- If scope includes specialty items (custom cabinets, impact windows, stone countertops), add procurement lead time`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.content[0]?.text || '';
  return parseJSON(text);
}

// ── Materials list generator ──────────────────────────────────────────────────

async function generateMaterials(apiKey, quote, clientName) {
  const client = getClient(apiKey);
  const scope = buildScopeText(quote);

  const prompt = `You are a construction materials coordinator for Cruz Services, a residential remodeling contractor in Stuart, FL.

Generate a comprehensive materials procurement list for this job, organized by trade category.

Client: ${clientName}
Job: ${quote.title}

SCOPE OF WORK:
${scope}

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "categories": [
    {
      "name": "<trade category, e.g. Demolition & Disposal>",
      "items": [
        {
          "item": "<material or supply name>",
          "quantity": "<number or range>",
          "unit": "<unit, e.g. LF, SF, EA, bags>",
          "notes": "<supplier hint, spec, or lead time if relevant>"
        }
      ]
    }
  ]
}

Category names to use where applicable (only include categories relevant to this scope):
- Demolition & Disposal
- Permits & Inspections
- Framing & Structural
- Waterproofing & Moisture Barrier
- Plumbing (Rough-in)
- Electrical (Rough-in)
- Insulation
- Drywall & Plaster
- Tile & Stone
- Cabinetry & Millwork
- Countertops
- Flooring
- Windows & Doors
- Fixtures & Hardware
- Paint & Finishes
- Exterior
- Specialty Items
- Miscellaneous Supplies

Rules:
- Limit to 6 items per category maximum — focus on the most important/costly ones
- Be concise in notes — max 8 words per note
- If exact quantity is unknown, use a short range or "TBD"
- Flag lead-time items with note "4-6 wk lead time"
- Skip categories with zero items
- Keep the entire JSON response under 3000 tokens`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.content[0]?.text || '';
  return parseJSON(text);
}

module.exports = { generateSchedule, generateMaterials };

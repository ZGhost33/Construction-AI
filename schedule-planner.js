#!/root/.hermes/node/bin/node
'use strict';
/*
 * schedule-planner.js — turn a Jobber job's scope into a TENTATIVE week-by-week
 * schedule plus a materials list whose "needed on-site by" dates are
 * cross-referenced to the week each material is consumed.
 *
 * The schedule is a SUGGESTION generated from the quote/job line-item scope.
 * Nothing is written to Jobber, Drive, or Calendar here — this only produces a
 * structured plan object. schedule-cli.js handles review + writes.
 *
 * Usage:
 *   schedule-planner.js "Client Name" [--job N]      # fetch from Jobber, print plan
 *   schedule-planner.js "Client Name" --job N --json # machine-readable
 * Programmatic:
 *   const { generatePlan } = require('./schedule-planner');
 *   const plan = await generatePlan(jobObject, clientName);
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const API_KEY = cfg.anthropic_api_key || cfg.businesses?.[0]?.anthropic_api_key;
const MODEL = 'claude-sonnet-4-6';
let SET = {};
try { SET = require('./src/config').settings(cfg); } catch { SET = {}; }
const TZ = SET.timezone || 'America/New_York';
const BUSINESS_NAME = SET.businessName || 'Cruz Services';
const CALENDAR_NAME = SET.calendarName || 'Cruz Schedule';

// ── date helpers (server is UTC; the business runs on configured timezone) ────
function etDate(iso) {
  // Return YYYY-MM-DD in the configured timezone for an ISO timestamp (or Date).
  const d = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function shiftDays(ymd, n) {
  if (!ymd) return null;
  const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Compute an explicit order-by date per long-lead material (single source of
// truth used by the calendar + Drive doc + Jobber note). Fabricated cabinetry is
// ordered ~4 weeks before its install week (shop lead time); other long-lead
// items act on their needed_by date (e.g. stone is templated on site first, so
// its "order" date is the template/needed_by date). Mutates materials in place.
function computeOrderDates(materials, weeks) {
  const W = weeks || [];
  const weekForPhase = (forPhase) => {
    const fp = String(forPhase || '').toLowerCase();
    const num = fp.match(/(?:week|wk)\s*(\d+)/);
    if (num) { const w = W.find(w => Number(w.week) === Number(num[1])); if (w) return w; }
    return W.find(w => w.phase && fp.includes(String(w.phase).toLowerCase().slice(0, 10))) || null;
  };
  for (const m of (materials || [])) {
    if (!m.long_lead) { m.order_by = null; continue; }
    const cat = String(m.category || '').toLowerCase();
    const isCabinetry = cat.includes('cabinet') || /cabinet|vanity|crown|light rail|rollout|pullout|decorative panel/i.test(String(m.item || ''));
    if (isCabinetry) {
      const w = weekForPhase(m.for_phase);
      m.order_by = (w && w.start) ? shiftDays(w.start, -28) : shiftDays(m.needed_by, -28);
    } else {
      m.order_by = m.needed_by || null;
    }
  }
  return materials;
}

// Streaming Anthropic call. WHY streaming matters here: a plan for a big job can
// take 60-100s+ to generate. A non-streamed POST keeps the socket idle that whole
// time, so it's indistinguishable from a hang — and the daily schedule-scan cron
// has a 120s hard kill, so one slow/stalled call used to SIGKILL the entire scan
// (and, because save() only ran at the end, lose every draft in the run).
//
// With stream:true the server emits SSE deltas continuously, so a healthy long
// generation never looks idle, while a GENUINE stall (no bytes for the idle
// window) trips the socket timeout and fails fast — caught per-job by cmdScan.
//
// Returns the SAME shape the callers expect: { status, json:{ content:[{type,text}] } }
// on success, or { status, raw|json } on an HTTP error, so generatePlan/applyEdit/
// parseAdhocEvent need no changes.
const ANTHROPIC_IDLE_MS = 35000;  // no bytes for 35s ⇒ treat as a hang
// `signal` (optional AbortSignal) lets a caller cap a single generation and abort
// the in-flight request — cmdScan uses this to bound one oversized draft so the
// cron never blocks, then re-drafts that job in a detached background process.
function anthropic(body, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const data = JSON.stringify({ ...body, stream: true });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      timeout: ANTHROPIC_IDLE_MS, signal,
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      },
    }, r => {
      // Non-200 errors come back as a single normal JSON body, not SSE.
      if (r.statusCode !== 200) {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: r.statusCode, raw: d }); } });
        return;
      }
      let buf = '', text = '', errMsg = null;
      r.setEncoding('utf8');
      r.on('data', chunk => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let ev; try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.type === 'content_block_delta' && ev.delta) {
            if (ev.delta.type === 'text_delta' && ev.delta.text) text += ev.delta.text;
          } else if (ev.type === 'error') {
            errMsg = ev.error?.message || 'stream error';
          }
        }
      });
      r.on('end', () => {
        if (errMsg) return resolve({ status: 502, json: { error: { message: errMsg } } });
        resolve({ status: 200, json: { content: [{ type: 'text', text }] } });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`anthropic stream idle >${ANTHROPIC_IDLE_MS / 1000}s (treated as a hang)`)); });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function buildScopeText(job) {
  const items = (job.lineItems?.nodes || []);
  if (!items.length) return '(no line items on this job)';
  return items.map((li, i) => {
    const qty = (li.quantity != null && li.quantity !== 1) ? ` (qty ${li.quantity})` : '';
    return `${i + 1}. ${li.name}${qty}\n${(li.description || '').trim()}`;
  }).join('\n\n');
}

const SCHEMA_PROMPT = `You are an experienced residential general-contractor planner for a small construction company (${BUSINESS_NAME}). Given a job's scope of work and a tentative START DATE, produce a realistic, conservative, week-by-week TENTATIVE schedule and a materials list.

Rules:
- Break the work into sequential PHASES grouped into calendar weeks starting from the given start date. A typical small residential job is 1-6 weeks; do not pad. Crews work Mon-Fri.
- Order phases the way the trades actually run (e.g. demo -> rough-in/framing -> inspections -> drywall -> finish -> punch list). Respect dependencies.
- Build a MATERIALS list derived ONLY from the scope. For each material set "needed_by" to a date a few days BEFORE the week that consumes it. Long-lead / special-order items (cabinetry, countertops, custom doors, windows, tile from a supplier) must be ordered well ahead — set their needed_by earlier and note the lead time.
- FABRICATED CABINETRY (cabinets and their matching accessories/moldings/panels) has a long shop lead time: the purchase order must be placed about 4 WEEKS before the cabinet-install week. Call this out in the item's notes (e.g. "Order ~4 weeks before install").
- Cross-reference: every material's "for_phase" must name the phase/week that uses it, and each week lists which materials must be on site that week.
- Quantities: include a number only if it's clearly inferable from the scope; otherwise null. Never invent SKUs or prices.
- THIN SCOPE: if the scope is too thin to sequence a phase honestly, do NOT invent a plausible sequence — that poisons everything downstream. Set "scope_confidence" to "low", set the affected weeks' phase to "UNKNOWN — needs input" with an empty tasks list, and add a pointed line to "needs_input" naming exactly what you'd need (e.g. "Is there electrical scope?"). Only sequence phases the scope actually supports. A short honest plan beats a long invented one.
- If the scope is merely incomplete (not absent), make reasonable assumptions and list them in "assumptions"; set "scope_confidence" to "medium".

Respond with ONE JSON object, no prose, no code fences:
{
  "duration_weeks": number,
  "summary": string,                       // 1-2 sentence overview of the plan
  "weeks": [
    {
      "week": number,                       // 1-based
      "start": "YYYY-MM-DD",                // Monday of that week (or job start for week 1)
      "end": "YYYY-MM-DD",                  // Friday of that week
      "phase": string,                      // short phase name
      "tasks": [string, ...],
      "materials_onsite": [string, ...]     // materials that must be on site this week
    }
  ],
  "materials": [
    {
      "item": string,
      "qty": number|null,
      "unit": string|null,                  // e.g. "ea", "lf", "sheets", "boxes"
      "category": string,                   // lumber, hardware, cabinetry, electrical, plumbing, tile, paint, etc.
      "needed_by": "YYYY-MM-DD",
      "for_phase": string,                  // which phase/week consumes it
      "long_lead": boolean,                 // true for special-order items
      "notes": string|null
    }
  ],
  "assumptions": [string, ...],
  "scope_confidence": "high|medium|low",       // low = scope too thin to sequence honestly
  "needs_input": [string, ...]                 // specific questions when scope_confidence is low
}`;

async function generatePlan(job, clientName, opts = {}) {
  if (!API_KEY) throw new Error('anthropic_api_key not found in config.json');
  const startDate = etDate(job.startAt) || etDate();
  const scope = buildScopeText(job);
  const userText =
    `CLIENT: ${clientName}\n` +
    `JOB #${job.jobNumber}: ${job.title}\n` +
    `TENTATIVE START DATE: ${startDate} (America/New_York)\n` +
    `TODAY: ${etDate()}\n\n` +
    `SCOPE OF WORK (from the approved quote / job line items):\n${scope}\n`;

  const res = await anthropic({
    model: MODEL, max_tokens: 16000, temperature: 0.2,
    messages: [{ role: 'user', content: [{ type: 'text', text: SCHEMA_PROMPT + '\n\n---\n\n' + userText }] }],
  }, opts.signal);
  if (res.status !== 200 || !res.json) {
    throw new Error('anthropic error: ' + (res.json?.error?.message || res.raw?.slice(0, 200) || ('HTTP ' + res.status)));
  }
  const text = (res.json.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  let parsed;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : text);
  } catch { throw new Error('could not parse plan JSON: ' + text.slice(0, 200)); }

  computeOrderDates(parsed.materials, parsed.weeks);

  return {
    job_number: job.jobNumber,
    job_title: job.title,
    client: clientName,
    start_date: startDate,
    jobber_uri: job.jobberWebUri || null,
    generated_at: new Date().toISOString(),
    duration_weeks: parsed.duration_weeks ?? (parsed.weeks ? parsed.weeks.length : null),
    summary: parsed.summary || '',
    weeks: parsed.weeks || [],
    materials: parsed.materials || [],
    assumptions: parsed.assumptions || [],
    tentative: true,
  };
}

// ── pretty printer (shared shape with schedule-cli show) ─────────────────────
function renderPlan(p) {
  const L = [];
  L.push(`📋 TENTATIVE SCHEDULE — ${p.client} · Job #${p.job_number} "${p.job_title}"`);
  L.push(`   Start: ${p.start_date} · ~${p.duration_weeks} week(s)`);
  if (p.summary) L.push(`   ${p.summary}`);
  L.push('');
  for (const w of p.weeks) {
    L.push(`Week ${w.week} (${w.start} → ${w.end}) — ${w.phase}`);
    for (const t of (w.tasks || [])) L.push(`   • ${t}`);
    if (w.materials_onsite && w.materials_onsite.length) L.push(`   📦 on site: ${w.materials_onsite.join(', ')}`);
    L.push('');
  }
  L.push('MATERIALS LIST (on-site-by dates):');
  for (const m of p.materials) {
    const q = m.qty != null ? `${m.qty}${m.unit ? ' ' + m.unit : ''} ` : '';
    const lead = m.long_lead ? ' ⏳long-lead' : '';
    L.push(`   ☐ ${q}${m.item} — need by ${m.needed_by} [${m.for_phase}]${lead}${m.notes ? ' — ' + m.notes : ''}`);
  }
  if (p.assumptions && p.assumptions.length) {
    L.push('', 'Assumptions:');
    for (const a of p.assumptions) L.push(`   - ${a}`);
  }
  return L.join('\n');
}

// ── surgical edit of an existing stored plan ─────────────────────────────────
const EDIT_PROMPT = `You are editing an EXISTING tentative construction schedule (JSON) for a small GC.
Apply ONLY the change the user asks for, then return the FULL updated plan as ONE JSON object (same shape).

Hard rules:
- Change ONLY what the instruction requires. Preserve every other week, task, material, and field exactly.
- Crews work Mon-Fri. Week "start" is a Monday, "end" the Friday of that week.
- If a change shifts dates (e.g. a phase grows from 1 to 2 weeks, or a phase moves), RE-FLOW all downstream weeks so weeks stay consecutive, correctly numbered, and Mon-Fri. Update each affected week's start/end and the plan's duration_weeks.
- Keep materials cross-referenced: if a phase moves, update the needed_by dates of materials whose for_phase points at moved/downstream weeks so they stay a few days before their consuming week. Do NOT recompute "order_by" — it is added later in code; you may omit it.
- Never invent scope that wasn't requested. If the instruction is ambiguous or impossible, return the plan UNCHANGED and add a short string to "assumptions" beginning with "EDIT NOTE:" explaining why.
- Add a one-line entry to "assumptions" starting with "EDIT (YYYY-MM-DD): " summarizing what you changed.

Return the complete updated JSON object, no prose, no code fences.`;

async function applyEdit(plan, instruction) {
  if (!API_KEY) throw new Error('anthropic_api_key not found in config.json');
  const userText =
    `TODAY: ${etDate()} (America/New_York)\n` +
    `INSTRUCTION: ${instruction}\n\n` +
    `CURRENT PLAN JSON:\n${JSON.stringify({
      duration_weeks: plan.duration_weeks, summary: plan.summary,
      weeks: plan.weeks, materials: plan.materials, assumptions: plan.assumptions,
    }, null, 2)}\n`;

  const res = await anthropic({
    model: MODEL, max_tokens: 16000, temperature: 0.1,
    messages: [{ role: 'user', content: [{ type: 'text', text: EDIT_PROMPT + '\n\n---\n\n' + userText }] }],
  });
  if (res.status !== 200 || !res.json) {
    throw new Error('anthropic error: ' + (res.json?.error?.message || res.raw?.slice(0, 200) || ('HTTP ' + res.status)));
  }
  const text = (res.json.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  let parsed;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : text);
  } catch { throw new Error('could not parse edited plan JSON: ' + text.slice(0, 200)); }

  computeOrderDates(parsed.materials, parsed.weeks);

  // Merge edited fields back onto the stored plan, preserving identity/output metadata.
  return {
    ...plan,
    duration_weeks: parsed.duration_weeks ?? (parsed.weeks ? parsed.weeks.length : plan.duration_weeks),
    summary: parsed.summary ?? plan.summary,
    weeks: parsed.weeks || plan.weeks,
    materials: parsed.materials || plan.materials,
    assumptions: parsed.assumptions || plan.assumptions,
    edited_at: new Date().toISOString(),
    tentative: true,
  };
}

// ── natural-language → structured ad-hoc calendar event ──────────────────────
const EVENT_PROMPT = `Convert the user's request into ONE calendar event for a small construction company's shared "${CALENDAR_NAME}" calendar. Resolve all relative dates/times against the provided NOW (${TZ}).

Return ONE JSON object, no prose, no code fences:
{
  "summary": string,                 // short title, e.g. "Inspection — Joyce kitchen"
  "all_day": boolean,                // true if no specific time was given
  "start": string,                   // all_day: "YYYY-MM-DD"; timed: "YYYY-MM-DDTHH:MM:SS" (local ET, 24h, no timezone suffix)
  "end": string|null,                // all_day multi-day: inclusive LAST day "YYYY-MM-DD"; timed: end "YYYY-MM-DDTHH:MM:SS" or null (defaults to +1h)
  "location": string|null,
  "notes": string|null,
  "needs_clarification": string|null // if the date or time genuinely cannot be resolved, a short question; otherwise null
}

Rules:
- If a clock time is given (e.g. "9am", "2:30"), all_day=false. If only a day/date is given, all_day=true.
- "tomorrow", "next Tuesday", "this Friday", "in 2 weeks" are relative to NOW. Assume the nearest sensible future occurrence.
- Default duration 1 hour for timed events unless a range is stated.
- Do NOT invent a date you cannot infer — set needs_clarification instead.`;

async function parseAdhocEvent(text) {
  if (!API_KEY) throw new Error('anthropic_api_key not found in config.json');
  const now = new Date();
  const nowStr = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'long', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const userText = `NOW (${TZ}): ${nowStr}\nTODAY: ${etDate()}\n\nREQUEST: ${text}\n`;
  const res = await anthropic({
    model: MODEL, max_tokens: 1000, temperature: 0,
    messages: [{ role: 'user', content: [{ type: 'text', text: EVENT_PROMPT + '\n\n---\n\n' + userText }] }],
  });
  if (res.status !== 200 || !res.json) {
    throw new Error('anthropic error: ' + (res.json?.error?.message || res.raw?.slice(0, 200) || ('HTTP ' + res.status)));
  }
  const out = (res.json.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  try {
    const m = out.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : out);
  } catch { throw new Error('could not parse event JSON: ' + out.slice(0, 200)); }
}

module.exports = { generatePlan, applyEdit, parseAdhocEvent, computeOrderDates, renderPlan, etDate, shiftDays };

// ── standalone ───────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const asJson = args.includes('--json');
    const jobFlagIdx = args.indexOf('--job');
    const wantJob = jobFlagIdx !== -1 ? Number(args[jobFlagIdx + 1]) : null;
    const clientName = args.filter(a => !a.startsWith('--'))
      .filter((a, i, arr) => !(jobFlagIdx !== -1 && a === String(wantJob)))[0];
    if (!clientName) { console.error('usage: schedule-planner.js "Client Name" [--job N] [--json]'); process.exit(1); }

    const api = require('./jobber-api');
    const client = await api.findClient(clientName);
    const jobs = await api.jobsForClient(client.id);
    if (!jobs.length) { console.error(`No jobs found for ${client.name}`); process.exit(1); }
    let job = wantJob ? jobs.find(j => j.jobNumber === wantJob) : jobs[0];
    if (!job) { console.error(`Job #${wantJob} not found for ${client.name}. Available: ${jobs.map(j => '#' + j.jobNumber).join(', ')}`); process.exit(1); }

    const plan = await generatePlan(job, client.name);
    if (asJson) process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    else console.log(renderPlan(plan));
  })().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}

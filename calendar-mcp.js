#!/root/.hermes/node/bin/node
'use strict';
/*
 * calendar-mcp.js — minimal, dependency-light MCP stdio server.
 *
 * Purpose: give the isolated jorge/danilo Telegram bots a NARROW calendar
 * capability — add a meeting/appointment to the shared "Cruz Schedule" calendar
 * and list upcoming meetings. Nothing else.
 *
 * Exposes exactly two tools:
 *   - add_meeting(text, confirm?)   parse natural language → preview, then write
 *   - list_meetings(days?, query?)  upcoming ad-hoc meetings (optional name filter)
 *
 * Hard guarantees:
 *   - Reuses the existing calendar-writer.js (service account) and
 *     schedule-planner.js NL parser — no new auth, no new scopes.
 *   - NO delete, NO schedule edit/approve, NO Jobber, NO Drive, NO config writes,
 *     NO arbitrary shell/fs. Only addAdhocEvent + listAdhocEvents.
 *   - Every event it writes is stamped "(Added by <PERSON> from the field.)" for
 *     auditability. The trusted Z profile can delete/correct anything.
 */
const PIPELINE = '/root/construction-bi-pipeline';
const cal = require(PIPELINE + '/calendar-writer');
const planner = require(PIPELINE + '/schedule-planner');

const PERSON = process.env.CAPTURE_PERSON || 'Field Tech';

function whenStr(ev) {
  return ev.all_day
    ? `${ev.start}${ev.end && ev.end !== ev.start ? ' → ' + ev.end : ''} (all day)`
    : `${ev.start.replace('T', ' ')}${ev.end ? ' → ' + ev.end.replace('T', ' ').slice(11) : ''} ET`;
}

async function addMeeting(args) {
  const text = String(args.text || '').trim();
  const confirm = args.confirm === true || args.confirm === 'true';
  if (!text) return { error: 'Tell me what to schedule, e.g. "meeting with the inspector Thursday 9am".' };

  let ev;
  try { ev = await planner.parseAdhocEvent(text); }
  catch (e) { return { error: 'Could not understand that meeting: ' + e.message }; }

  if (ev.needs_clarification) {
    return { message: `Need a bit more to schedule that: ${ev.needs_clarification}` };
  }
  const when = whenStr(ev);
  const preview = `${ev.summary}\n   ${when}` +
    (ev.location ? `\n   @ ${ev.location}` : '');

  if (!confirm) {
    return { message: `Will add to the Cruz Schedule calendar:\n   ${preview}\n\nReply "yes" to confirm and I'll add it.` };
  }

  // stamp who added it, then write
  ev.notes = (ev.notes ? ev.notes + ' ' : '') + `(Added by ${PERSON} from the field.)`;
  let res;
  try { res = await cal.addAdhocEvent(ev); }
  catch (e) { return { error: 'Failed to add to the calendar: ' + e.message }; }
  return { message: `✅ Added to Cruz Schedule: ${ev.summary} — ${when}` +
    (ev.location ? ` @ ${ev.location}` : '') };
}

async function listMeetings(args) {
  const days = args.days ? Math.max(1, Math.min(365, Number(args.days) || 60)) : 60;
  const q = String(args.query || '').trim().toLowerCase();
  let items;
  try { items = await cal.listAdhocEvents({ days }); }
  catch (e) { return { error: 'Could not read the calendar: ' + e.message }; }

  if (q) items = items.filter(e =>
    String(e.summary || '').toLowerCase().includes(q) ||
    String(e.location || '').toLowerCase().includes(q));

  if (!items.length) {
    return { message: q
      ? `No upcoming meetings matching "${args.query}" in the next ${days} days.`
      : `No meetings on the Cruz Schedule in the next ${days} days.` };
  }
  const lines = items.map(e => {
    const when = e.all_day ? e.start + ' (all day)' : e.start.replace('T', ' ').slice(0, 16) + ' ET';
    return `• ${when} — ${e.summary}${e.location ? ' @ ' + e.location : ''}`;
  });
  const head = q ? `Upcoming meetings matching "${args.query}":` : `Upcoming meetings (next ${days} days):`;
  return { message: head + '\n' + lines.join('\n') };
}

// ---- tool schemas ----
const TOOLS = [
  {
    name: 'add_meeting',
    description: 'Add a meeting, appointment, or site visit to the shared "Cruz Schedule" calendar. Use for "add a meeting…", "put it on the calendar", "book a site visit", "schedule an appointment". Call first WITHOUT confirm to show a preview, then call again with confirm=true once the user agrees. This only adds calendar events — it cannot edit job schedules, write Jobber notes, or delete anything.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The meeting in plain language, including who/what, day and time, e.g. "meeting with electrician Andre at the Gallan site 9am Wednesday".' },
        confirm: { type: 'boolean', description: 'Leave false/empty to preview. Set true to actually write the event after the user confirms.' }
      },
      required: ['text']
    }
  },
  {
    name: 'list_meetings',
    description: 'List upcoming meetings/appointments on the "Cruz Schedule" calendar. Use for "what meetings do I have", "when is my next meeting with Lisa". Optionally filter by a name/keyword via query.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days ahead to look (default 60).' },
        query: { type: 'string', description: 'Optional filter — a client or person name to match, e.g. "Lisa".' }
      }
    }
  }
];

// ---- minimal MCP stdio (newline-delimited JSON-RPC) ----
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    handle(msg);
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'cruz-calendar', version: '1.0.0' }
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    let out;
    try {
      if (name === 'add_meeting') out = await addMeeting(args);
      else if (name === 'list_meetings') out = await listMeetings(args);
      else return replyErr(id, -32602, `Unknown tool: ${name}`);
    } catch (e) { out = { error: 'Calendar action failed: ' + e.message }; }
    if (out.error) return reply(id, { content: [{ type: 'text', text: out.error }], isError: true });
    return reply(id, { content: [{ type: 'text', text: out.message }] });
  }
  if (typeof id !== 'undefined') return replyErr(id, -32601, `Method not found: ${method}`);
}

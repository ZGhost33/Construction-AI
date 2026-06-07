'use strict';
/*
 * calendar-writer.js — push a tentative job schedule onto the shared
 * "Cruz Schedule" Google Calendar using the existing Drive service account.
 *
 * Setup (one-time, done by the owner):
 *   1. Enable the Google Calendar API for the GCP project.
 *   2. Create a calendar named exactly "Cruz Schedule".
 *   3. Share it with the service-account email
 *      (construction-pipeline@cruz-services-pipeline-497111.iam.gserviceaccount.com)
 *      granting "Make changes to events".
 * After that this module auto-discovers the calendar by name — no ID to copy.
 *
 * Events are tagged with extendedProperties.private.cruz_job = <jobNumber> so a
 * re-approval cleanly deletes the old events for that job before writing fresh
 * ones (idempotent — no duplicates).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DIR = __dirname;
const KEY_PATH = path.join(DIR, 'drive-service-account.json');
const ID_FILE = path.join(DIR, 'cruz-calendar.json'); // { "calendar_id": "...@group.calendar.google.com" }
let _set = {};
try { _set = require('./src/config').settings(); } catch { /* config may be absent in some contexts */ }
const CALENDAR_NAME = _set.calendarName || 'Cruz Schedule';
const TZ = _set.timezone || 'America/New_York';

function getCalendar() {
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

// Find the shared "Cruz Schedule" calendar id. Throws an actionable error if the
// API is disabled or the calendar hasn't been shared with the service account.
async function findCruzCalendar(cal) {
  cal = cal || getCalendar();

  // 1) Explicit calendar ID (cruz-calendar.json). This is the reliable path:
  // a calendar shared with a service account through the Calendar UI usually
  // does NOT appear in calendarList.list, but the SA can still read/write it
  // directly by ID. Verify access with calendars.get before trusting it.
  try {
    const cfgId = JSON.parse(fs.readFileSync(ID_FILE, 'utf8')).calendar_id;
    if (cfgId) {
      try {
        await cal.calendars.get({ calendarId: cfgId });
        return cfgId;
      } catch (e) {
        if (/has not been used|is disabled|accessNotConfigured/i.test(e.message)) {
          throw new Error('Google Calendar API is not enabled for the project yet. Enable it, then retry.');
        }
        throw new Error(`Configured calendar id (${cfgId}) is not accessible to the service account — ` +
          `confirm it's shared with the SA email with "Make changes to events". (${e.message})`);
      }
    }
  } catch (e) {
    // Only swallow "file missing / unparseable"; re-throw real access errors.
    if (e.code !== 'ENOENT' && !/Unexpected token|JSON/.test(e.message)) throw e;
  }

  // 2) Fallback: discover by name via calendarList (works if the SA happens to
  // have the calendar in its list, e.g. added via CalendarList.insert).
  let items = [];
  try {
    const r = await cal.calendarList.list({ maxResults: 250 });
    items = r.data.items || [];
  } catch (e) {
    if (/has not been used|is disabled|accessNotConfigured/i.test(e.message)) {
      throw new Error('Google Calendar API is not enabled for the project yet. Enable it, then retry.');
    }
    throw e;
  }
  const match = items.find(c => (c.summary || '').trim().toLowerCase() === CALENDAR_NAME.toLowerCase());
  if (!match) {
    throw new Error(`Can't locate the "${CALENDAR_NAME}" calendar. Either (a) save its Calendar ID to ` +
      `${ID_FILE} as {"calendar_id":"…@group.calendar.google.com"}, or (b) share it so it appears in the ` +
      `service account's list. (Calendars currently visible to the SA: ${items.map(c => c.summary).filter(Boolean).join(', ') || 'none'})`);
  }
  return match.id;
}

// Google all-day events use exclusive end dates; add one day so the last day is included.
function plusDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function clearJobEvents(cal, calendarId, jobNumber) {
  // Find and delete any existing events tagged for this job.
  const r = await cal.events.list({
    calendarId,
    privateExtendedProperty: [`cruz_job=${jobNumber}`],
    maxResults: 250,
    singleEvents: true,
    showDeleted: false,
  });
  const existing = r.data.items || [];
  for (const ev of existing) {
    try { await cal.events.delete({ calendarId, eventId: ev.id }); } catch (_) { /* best-effort */ }
  }
  return existing.length;
}

// Write a plan (from schedule-planner) to the calendar. Returns { calendarId, created, replaced }.
async function writeScheduleToCalendar(plan) {
  const cal = getCalendar();
  const calendarId = await findCruzCalendar(cal);
  const replaced = await clearJobEvents(cal, calendarId, plan.job_number);

  const created = [];
  const tag = (kind) => ({ private: { cruz_job: String(plan.job_number), cruz_kind: kind } });
  const link = plan.jobber_uri ? `\n\nJobber: ${plan.jobber_uri}` : '';
  const tentative = '\n\n(Tentative — auto-generated from the approved quote scope.)';

  // One all-day, multi-day event per phase/week.
  for (const w of (plan.weeks || [])) {
    const descLines = [];
    if (w.tasks && w.tasks.length) descLines.push('Tasks:', ...w.tasks.map(t => '• ' + t));
    if (w.materials_onsite && w.materials_onsite.length) {
      descLines.push('', 'Materials on site:', ...w.materials_onsite.map(m => '📦 ' + m));
    }
    const ev = await cal.events.insert({
      calendarId,
      requestBody: {
        summary: `[#${plan.job_number} ${plan.client}] Wk${w.week}: ${w.phase}`,
        description: descLines.join('\n') + link + tentative,
        start: { date: w.start, timeZone: TZ },
        end: { date: plusDays(w.end, 1), timeZone: TZ },
        extendedProperties: tag('phase'),
        transparency: 'transparent',
      },
    });
    created.push({ kind: 'phase', week: w.week, id: ev.data.id });
  }

  // Order-reminder events for long-lead materials, CONSOLIDATED by order date so
  // a single supplier order (e.g. the whole Fabuwood cabinet package) shows up as
  // one calendar item instead of a dozen stacked on the same day. The order date
  // is the material's order_by (computed by the planner: ~4 weeks before install
  // for fabricated cabinetry), falling back to needed_by.
  const qtyOf = (m) => (m.qty != null ? `${m.qty}${m.unit ? ' ' + m.unit : ''} ` : '');
  const orderGroups = new Map(); // 'YYYY-MM-DD' -> [materials]
  for (const m of (plan.materials || [])) {
    if (!m.long_lead) continue; // only critical-path / special-order items get a reminder
    const date = m.order_by || m.needed_by;
    if (!date) continue;
    if (!orderGroups.has(date)) orderGroups.set(date, []);
    orderGroups.get(date).push(m);
  }
  for (const [date, mats] of [...orderGroups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let summary, descBody;
    if (mats.length === 1) {
      const m = mats[0];
      summary = `⏳ ORDER: ${qtyOf(m)}${m.item} — ${plan.client} #${plan.job_number}`;
      descBody = `On site by ${m.needed_by}. For "${m.for_phase}".${m.notes ? '\n' + m.notes : ''}`;
    } else {
      summary = `⏳ ORDER (${mats.length} items) — ${plan.client} #${plan.job_number}`;
      descBody = 'Place this order now so the items are on site in time:\n' +
        mats.map(m => `• ${qtyOf(m)}${m.item} — on site by ${m.needed_by} (for "${m.for_phase}")${m.notes ? '\n   ' + m.notes : ''}`).join('\n');
    }
    const ev = await cal.events.insert({
      calendarId,
      requestBody: {
        summary,
        description: descBody + link + tentative,
        start: { date, timeZone: TZ },
        end: { date: plusDays(date, 1), timeZone: TZ },
        extendedProperties: tag('order'),
        transparency: 'transparent',
      },
    });
    created.push({ kind: 'order', date, items: mats.length, id: ev.data.id });
  }

  return { calendarId, created, replaced };
}

// ── ad-hoc (standalone) events ───────────────────────────────────────────────
// One-off events not tied to a job (e.g. "inspection Thursday 9am"). Tagged
// cruz_adhoc=1 with a short cruz_aid so they're distinct from job phase/order
// events and can be listed/deleted independently. `ev` shape:
//   { summary, all_day, start, end, location, notes }
// all_day: start/end are 'YYYY-MM-DD' (end = inclusive last day, or omitted for
// single-day). timed: start/end are 'YYYY-MM-DDTHH:MM:SS' local (ET); if end is
// omitted a 1-hour default is used.
async function addAdhocEvent(ev, cal) {
  cal = cal || getCalendar();
  const calendarId = await findCruzCalendar(cal);
  const aid = Math.random().toString(16).slice(2, 8);
  const body = {
    summary: ev.summary || '(untitled)',
    location: ev.location || undefined,
    description: (ev.notes ? ev.notes + '\n\n' : '') + '(Added to Cruz Schedule via the scheduler.)',
    extendedProperties: { private: { cruz_adhoc: '1', cruz_aid: aid } },
  };
  if (ev.all_day) {
    const lastDay = ev.end || ev.start;
    body.start = { date: ev.start, timeZone: TZ };
    body.end = { date: plusDays(lastDay, 1), timeZone: TZ }; // exclusive end
  } else {
    let end = ev.end;
    if (!end) {
      const d = new Date(ev.start); d.setMinutes(d.getMinutes() + 60);
      end = d.toISOString().slice(0, 19);
    }
    body.start = { dateTime: ev.start, timeZone: TZ };
    body.end = { dateTime: end, timeZone: TZ };
  }
  const r = await cal.events.insert({ calendarId, requestBody: body });
  return { id: r.data.id, aid, summary: body.summary, htmlLink: r.data.htmlLink };
}

async function listAdhocEvents({ days = 60 } = {}, cal) {
  cal = cal || getCalendar();
  const calendarId = await findCruzCalendar(cal);
  const timeMin = new Date(Date.now() - 86400000).toISOString();
  const timeMax = new Date(Date.now() + days * 86400000).toISOString();
  const r = await cal.events.list({
    calendarId, privateExtendedProperty: ['cruz_adhoc=1'],
    singleEvents: true, orderBy: 'startTime', timeMin, timeMax, maxResults: 250,
  });
  return (r.data.items || []).map(ev => ({
    id: ev.id,
    aid: ev.extendedProperties?.private?.cruz_aid || null,
    summary: ev.summary,
    start: ev.start.date || ev.start.dateTime,
    all_day: !!ev.start.date,
    location: ev.location || null,
  }));
}

// Delete an ad-hoc event by short id (cruz_aid), full event id, or unambiguous
// summary substring. Throws if nothing matches or a summary match is ambiguous.
async function deleteAdhocEvent(key, cal) {
  cal = cal || getCalendar();
  const calendarId = await findCruzCalendar(cal);
  const r = await cal.events.list({
    calendarId, privateExtendedProperty: ['cruz_adhoc=1'],
    singleEvents: true, maxResults: 250,
  });
  const items = r.data.items || [];
  let target = items.find(e => e.extendedProperties?.private?.cruz_aid === key)
    || items.find(e => e.id === key);
  if (!target) {
    const matches = items.filter(e => (e.summary || '').toLowerCase().includes(String(key).toLowerCase()));
    if (matches.length === 1) target = matches[0];
    else if (matches.length > 1) {
      throw new Error(`"${key}" matches ${matches.length} events: ${matches.map(e => e.summary).join('; ')}. Use the id to disambiguate.`);
    }
  }
  if (!target) throw new Error(`No ad-hoc event matches "${key}".`);
  await cal.events.delete({ calendarId, eventId: target.id });
  return { id: target.id, summary: target.summary };
}

module.exports = {
  writeScheduleToCalendar, findCruzCalendar, getCalendar,
  addAdhocEvent, listAdhocEvents, deleteAdhocEvent,
};

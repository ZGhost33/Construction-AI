#!/usr/bin/env node
'use strict';
// job-context-cli.js — read/write the per-job context store (Intelligent Jobs §3).
//
//   update --job N --client "Name" --note "..." [--job-title "..."]
//          [--recording-id X] [--speaker NAME] [--by NAME]
//          [--source recording|field_capture] [--date YYYY-MM-DD]
//        → extract STATED state from the approved note (LLM) and merge it into
//          job N's context; print a one-line summary. Called from review-cli
//          approve (non-fatal there).
//   show --job N            → JSON of the job's context
//   list                    → all jobs with phase + last-updated (for /status)
//   render --job N          → human-readable text (used by the Drive mirror)
//
// Jobber stays the system of record; this is the agent's working memory.

const fs = require('fs');
const path = require('path');
const jc = require('./job-context.js');
const { extractJobState } = require('./src/claude.js');

const DIR = '/root/construction-bi-pipeline';
const CONFIG = path.join(DIR, 'config.json');

function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function biz() { return (readJSON(CONFIG, { businesses: [{}] }).businesses[0]) || {}; }

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { out[a.slice(2)] = args[i + 1]; i++; }
    else out._.push(a);
  }
  return out;
}

async function cmdUpdate(f) {
  const job = f.job && /^\d+$/.test(String(f.job)) ? String(f.job) : null;
  if (!job) { console.error('update: --job N required (no job# → nothing to key context on)'); process.exit(2); }
  const note = f.note || '';
  if (!note.trim()) { console.error('update: --note required'); process.exit(2); }

  const b = biz();
  const apiKey = b.anthropic_api_key || readJSON(CONFIG, {}).anthropic_api_key;
  let extracted = { phase: null, state: [], timeline_event: null };
  try {
    extracted = await extractJobState(apiKey, b, note, { client: f.client, jobTitle: f['job-title'] });
  } catch (err) {
    // Non-fatal: still record a timeline entry + last_updated even if the LLM
    // extraction failed, so the job at least shows recent activity.
    console.error('job-context: state extraction failed (recording activity only): ' + err.message);
  }

  const ctx = jc.applyUpdate(job, {
    job: f['job-title'] || null,
    client: f.client || null,
    address: f.address || null,
    phase: extracted.phase,
    stateItems: extracted.state,
    timelineEvent: extracted.timeline_event || `Note filed by ${f.speaker || f.by || 'field'}`,
    recordingId: f['recording-id'] || null,
    speaker: f.speaker || null,
    by: f.by || null,
    source: f.source || 'recording',
    date: f.date || null,
  });
  console.log(`📋 Job #${job} context updated — ${(extracted.state || []).length} state item(s), phase: ${ctx.phase || '—'}.`);
}

function cmdShow(f) {
  const ctx = jc.get(f.job);
  if (!ctx) { console.log(JSON.stringify({ ok: false, error: 'no context for job ' + f.job })); return; }
  console.log(JSON.stringify(ctx, null, 2));
}

function cmdList() { console.log(JSON.stringify(jc.list(), null, 2)); }

function cmdRender(f) {
  const ctx = jc.get(f.job);
  if (!ctx) { console.log('(no context for job ' + f.job + ')'); return; }
  console.log(jc.render(ctx));
}

async function main() {
  const cmd = process.argv[2];
  const f = parseFlags(process.argv.slice(3));
  switch (cmd) {
    case 'update': return cmdUpdate(f);
    case 'show': return cmdShow(f);
    case 'list': return cmdList();
    case 'render': return cmdRender(f);
    default:
      console.log('job-context-cli.js\n  update --job N --client "Name" --note "..." [--job-title ..] [--recording-id ..] [--speaker ..] [--source recording|field_capture]\n  show --job N\n  list\n  render --job N');
      process.exit(cmd ? 1 : 0);
  }
}
main().catch(err => { console.error('job-context-cli failed: ' + err.message); process.exit(1); });

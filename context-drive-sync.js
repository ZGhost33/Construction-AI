#!/usr/bin/env node
'use strict';
// context-drive-sync.js — mirror each job's living context (§3) to a human-
// readable doc in that client's Drive folder. The async "fast-follow" deferred
// from §3: runs on a cron, never near the approve tap.
//
// One living doc per job ("JOB CONTEXT — #<id> <client>.txt"), updated in place.
// Idempotent: a content hash on the job context skips jobs whose state hasn't
// changed since the last sync, so a frequent cron is cheap. Best-effort —
// Drive is a convenience mirror; Jobber + job-context.json remain the records.
//
// Usage:
//   context-drive-sync.js --job N     sync one job
//   context-drive-sync.js --all       sync every active job (the cron path)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jc = require('./job-context.js');
const drive = require('./src/drive.js');

const DIR = '/root/construction-bi-pipeline';
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const ROOT = cfg.google_drive_root_folder_id;

function hashOf(text) { return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16); }

async function syncJob(jobId) {
  const ctx = jc.get(jobId);
  if (!ctx || !ctx.client) return { skipped: 'no client' };
  const text = jc.render(ctx);
  const hash = hashOf(text);
  if ((ctx.drive_doc || {}).hash === hash) return { skipped: 'unchanged' };

  const name = `JOB CONTEXT — #${ctx.job_id} ${ctx.client}.txt`;
  await drive.ensureClientFolder(ROOT, ctx.client);
  // Find an existing doc for THIS job (match the #id, so retitling the job or
  // multiple jobs per client never collide).
  let existing = null;
  try { existing = (await drive.listFiles(ROOT, ctx.client, 'JOB CONTEXT')).find(f => (f.name || '').includes('#' + ctx.job_id)); } catch { /* fall through to create */ }

  const tmp = `/tmp/jobctx-${ctx.job_id}-${process.pid}.txt`;
  fs.writeFileSync(tmp, text);
  let res;
  try {
    res = existing ? await drive.updateFileById(existing.id, tmp, name)
                   : await drive.uploadFile(ROOT, ctx.client, tmp, name);
  } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }

  jc.setDriveSync(jobId, { file_id: res.id, hash, url: res.webViewLink || null });
  return { ok: true, action: existing ? 'updated' : 'created', url: res.webViewLink || null };
}

async function main() {
  const args = process.argv.slice(2);
  const ji = args.indexOf('--job');
  if (ji >= 0) { console.log(JSON.stringify(await syncJob(args[ji + 1]))); return; }
  if (args.includes('--all')) {
    let written = 0, unchanged = 0, errored = 0;
    for (const j of jc.list()) {
      try { const r = await syncJob(j.job_id); if (r.ok) written++; else unchanged++; }
      catch (e) { errored++; console.error(`#${j.job_id}: ${e.message}`); }
    }
    // Silent-ish (cron): only print when something was written or failed.
    if (written || errored) console.log(`context-drive-sync: ${written} written, ${unchanged} unchanged, ${errored} error(s)`);
    return;
  }
  console.log('context-drive-sync.js --job N | --all');
}
main().catch(e => { console.error('context-drive-sync failed: ' + e.message); process.exit(1); });

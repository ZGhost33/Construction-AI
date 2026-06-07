#!/usr/bin/env node
/**
 * voice-cli.js — Voice Profile Management CLI
 *
 * Usage:
 *   node voice-cli.js enroll "Luis Cruz" /path/to/audio.m4a
 *   node voice-cli.js list
 *   node voice-cli.js status "Luis Cruz"
 *   node voice-cli.js test <recording-id> /path/to/audio.m4a
 *   node voice-cli.js delete "Luis Cruz"
 *   node voice-cli.js inbox                  ← show pending audio files
 *   node voice-cli.js add-audio <recording-id> /path/to/audio.m4a
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadProfiles, saveProfiles, INBOX_DIR, PROFILES_PATH } = require('./src/voice-identifier');

const PYTHON    = '/root/venv-voice/bin/python3';
const PY_SCRIPT = path.join(__dirname, 'voice-identify.py');

function pyRun(...args) {
  const out = execFileSync(PYTHON, [PY_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'inherit'], // stderr to terminal (shows progress)
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const [,, cmd, ...args] = process.argv;

async function main() {
  switch (cmd) {

    // ── enroll ──────────────────────────────────────────────────────────────
    case 'enroll': {
      const name      = args[0];
      const audioPath = args[1];
      if (!name || !audioPath) {
        console.error('Usage: node voice-cli.js enroll "Person Name" /path/to/audio.m4a');
        process.exit(1);
      }
      if (!fs.existsSync(audioPath)) {
        console.error(`ERROR: Audio file not found: ${audioPath}`);
        process.exit(1);
      }
      const result = pyRun('enroll', name, audioPath);
      console.log(`\n✓ "${name}" enrolled (${result.embedding_dim}-dim voice embedding)`);
      console.log(`  Ready for speaker identification`);
      break;
    }

    // ── list ────────────────────────────────────────────────────────────────
    case 'list': {
      const profiles = pyRun('list');
      if (!profiles.length) {
        console.log('No voice profiles enrolled yet.');
        console.log('Enroll someone: node voice-cli.js enroll "Name" /path/to/audio.m4a');
        break;
      }
      console.log(`\nVoice Profiles (${profiles.length}):\n`);
      console.log('  Name'.padEnd(35) + 'Enrolled'.padEnd(25) + 'Embedding');
      console.log('  ' + '─'.repeat(70));
      for (const p of profiles) {
        const date = p.enrolled_at ? new Date(p.enrolled_at).toLocaleDateString() : '—';
        const emb  = p.has_embedding ? '✓' : '✗ missing';
        console.log(`  ${p.name.padEnd(35)}${date.padEnd(25)}${emb}`);
      }
      console.log('');
      break;
    }

    // ── status ──────────────────────────────────────────────────────────────
    case 'status': {
      // Alias for list
      const profiles = pyRun('list');
      const name = args[0];
      const p = profiles.find(x => x.name === name);
      if (!p) { console.error(`No profile found for "${name}"`); process.exit(1); }
      console.log(`\nProfile: ${p.name}`);
      console.log(`  Enrolled:    ${p.enrolled_at || '—'}`);
      console.log(`  Embedding:   ${p.has_embedding ? '✓ ready' : '✗ missing'}`);
      console.log('');
      break;
    }

    // ── delete ──────────────────────────────────────────────────────────────
    case 'delete': {
      const name = args[0];
      if (!name) { console.error('Usage: node voice-cli.js delete "Person Name"'); process.exit(1); }
      const result = pyRun('delete', name);
      console.log(result.deleted ? `✓ Deleted profile for "${name}"` : `No profile found for "${name}"`);
      break;
    }

    // ── add-audio ───────────────────────────────────────────────────────────
    // Copy an audio file into the inbox for a specific recording ID
    case 'add-audio': {
      const recordingId = args[0];
      const audioPath   = args[1];
      if (!recordingId || !audioPath) {
        console.error('Usage: node voice-cli.js add-audio <recording-id> /path/to/audio.m4a');
        process.exit(1);
      }
      if (!fs.existsSync(audioPath)) {
        console.error(`ERROR: File not found: ${audioPath}`);
        process.exit(1);
      }
      if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR, { recursive: true });
      const ext  = path.extname(audioPath);
      const dest = path.join(INBOX_DIR, recordingId + ext);
      fs.copyFileSync(audioPath, dest);
      console.log(`✓ Audio saved to inbox: ${dest}`);
      console.log(`  Next pipeline run will identify speakers for recording ${recordingId}`);
      break;
    }

    // ── inbox ───────────────────────────────────────────────────────────────
    case 'inbox': {
      if (!fs.existsSync(INBOX_DIR)) { console.log('Inbox is empty.'); break; }
      const files = fs.readdirSync(INBOX_DIR);
      if (files.length === 0) { console.log('Inbox is empty.'); break; }
      console.log(`\nAudio files pending identification (${files.length}):\n`);
      files.forEach(f => {
        const stat = fs.statSync(path.join(INBOX_DIR, f));
        const mb   = (stat.size / 1048576).toFixed(1);
        console.log(`  ${f}  (${mb} MB)`);
      });
      console.log('');
      break;
    }

    default: {
      console.log(`
Cruz Services — Voice Profile Manager

Commands:
  enroll "Name" /path/to/audio.m4a   Enroll a person's voice (need ~30s speech)
  list                                Show all enrolled profiles
  status "Name"                       Check enrollment status for a person
  delete "Name"                       Remove a voice profile
  add-audio <rec-id> /path/to/audio  Add recording audio to inbox for auto-ID
  inbox                               Show pending audio files in inbox

Setup:
  Speaker ID runs locally via resemblyzer (no cloud key needed).
  Requires the Python venv at /root/venv-voice (created by provision.sh).

Workflow:
  1. Enroll each person once with a clear audio sample
  2. Drop recording audio files in audio-inbox/<recording-id>.m4a
  3. Pipeline auto-identifies speakers on next run
      `);
    }
  }
}

main().catch(e => {
  console.error('ERROR:', e.response?.data || e.message);
  process.exit(1);
});

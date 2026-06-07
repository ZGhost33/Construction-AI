/**
 * voice-identifier.js
 *
 * Speaker identification for Pocket recordings (local resemblyzer — no cloud key).
 *
 * Flow:
 *   1. Load voice-profiles.json (enrolled names; embeddings managed by voice-identify.py)
 *   2. For each unique SPEAKER_XX in the recording, extract that speaker's
 *      audio using ffmpeg + Pocket timestamps
 *   3. Score it against enrolled embeddings via voice-identify.py (resemblyzer GE2E,
 *      run in the /root/venv-voice venv)
 *   4. Return a map: { SPEAKER_00: "Luis Cruz", SPEAKER_01: "Brian Harris", ... }
 *
 * Falls back gracefully:
 *   - device owner is always SPEAKER_00
 *   - no audio file in inbox: returns device-owner mapping (+ known client in 2-speaker calls)
 *   - no enrolled profiles: returns device-owner mapping
 *   - a speaker can't be matched: keeps its SPEAKER_XX label
 *
 * NOTE: this module backs the legacy src/pipeline.js plus the voice-cli helpers.
 * The live ingest path (pocket-ingest.js) calls voice-identify.py directly.
 */

const fs      = require('fs');
const path    = require('path');
const { execSync, execFileSync } = require('child_process');
const os      = require('os');
const { log } = require('./logger');

const PYTHON   = '/root/venv-voice/bin/python3';
const PY_SCRIPT = path.join(__dirname, '..', 'voice-identify.py');

const PROFILES_PATH = path.join(__dirname, '..', 'voice-profiles.json');
const INBOX_DIR     = path.join(__dirname, '..', 'audio-inbox');

// ── Profile registry ──────────────────────────────────────────────────────────

function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); } catch { return {}; }
}

function saveProfiles(profiles) {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2));
}

// ── Audio inbox ───────────────────────────────────────────────────────────────
// When you download a Pocket recording, drop it in audio-inbox/<recordingId>.<ext>
// Supported: .m4a .mp3 .wav .mp4 .ogg .flac

function findAudioFile(recordingId) {
  if (!fs.existsSync(INBOX_DIR)) return null;
  const exts = ['.m4a', '.mp3', '.wav', '.mp4', '.ogg', '.flac'];
  for (const ext of exts) {
    const p = path.join(INBOX_DIR, recordingId + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Audio extraction ──────────────────────────────────────────────────────────
// Extract all segments for a given speaker from the full recording audio.
// Returns a Buffer of PCM WAV (16kHz mono) — the format resemblyzer expects.

function extractSpeakerAudio(audioPath, segments, speakerId) {
  const speakerSegs = segments.filter(s => s.speaker === speakerId && s.end > s.start);
  if (speakerSegs.length === 0) return null;

  const tmp = path.join(os.tmpdir(), `spk_${speakerId}_${Date.now()}`);
  const segFiles = [];

  try {
    // Extract each segment to a temp file
    for (let i = 0; i < speakerSegs.length; i++) {
      const seg = speakerSegs[i];
      const dur = (seg.end - seg.start).toFixed(3);
      if (parseFloat(dur) < 1) continue; // skip very short segments

      const segFile = `${tmp}_seg${i}.wav`;
      execSync(
        `ffmpeg -y -ss ${seg.start} -t ${dur} -i "${audioPath}" ` +
        `-ar 16000 -ac 1 -f wav "${segFile}" -loglevel error`,
        { timeout: 30000 }
      );
      if (fs.existsSync(segFile) && fs.statSync(segFile).size > 1000) {
        segFiles.push(segFile);
      }
    }

    if (segFiles.length === 0) return null;

    // Concatenate all segments into one file
    const listFile = `${tmp}_list.txt`;
    const outFile  = `${tmp}_combined.wav`;
    fs.writeFileSync(listFile, segFiles.map(f => `file '${f}'`).join('\n'));
    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" -ar 16000 -ac 1 "${outFile}" -loglevel error`,
      { timeout: 30000 }
    );

    if (!fs.existsSync(outFile)) return null;
    return fs.readFileSync(outFile);

  } finally {
    // Cleanup temp files
    [...segFiles, `${tmp}_list.txt`, `${tmp}_combined.wav`].forEach(f => {
      try { fs.unlinkSync(f); } catch (_) {}
    });
  }
}

// ── Main identification ───────────────────────────────────────────────────────

async function identifySpeakers(segments, recordingId, devicePerson, knownClient) {
  const speakerMap = {};

  // Layer 1: device owner is always SPEAKER_00
  if (devicePerson) {
    speakerMap['SPEAKER_00'] = devicePerson;
  }

  const uniqueSpeakers = [...new Set(segments.map(s => s.speaker).filter(Boolean))];

  // Layer 2 fallback: in a 2-speaker recording, SPEAKER_01 = known client.
  // Used whenever we can't run voiceprint identification.
  const withKnownClient = () => {
    if (knownClient && uniqueSpeakers.length === 2) {
      const other = uniqueSpeakers.find(s => s !== 'SPEAKER_00');
      if (other) speakerMap[other] = knownClient;
    }
    return speakerMap;
  };

  // Voiceprint identification needs the recording audio in the inbox
  const audioPath = findAudioFile(recordingId);
  if (!audioPath) {
    log(`[Voice] No audio file for ${recordingId} — using device/client mapping only`);
    return withKnownClient();
  }

  log(`[Voice] Audio found for ${recordingId} — running resemblyzer identification`);

  // Check enrolled profiles exist
  const profiles = loadProfiles();
  if (Object.keys(profiles).length === 0) {
    log(`[Voice] No enrolled speakers yet — skipping identification`);
    return withKnownClient();
  }

  // Write segments to temp file for Python script
  const tmpSegments = path.join(os.tmpdir(), `segments_${recordingId}.json`);
  try {
    fs.writeFileSync(tmpSegments, JSON.stringify(segments));

    const output = execFileSync(PYTHON, [PY_SCRIPT, 'identify', audioPath, tmpSegments], {
      timeout: 120000,
      encoding: 'utf8',
    });

    const identified = JSON.parse(output.trim().split('\n').pop());
    for (const [speakerId, match] of Object.entries(identified)) {
      if (!speakerMap[speakerId]) {
        speakerMap[speakerId] = match.name;
        log(`[Voice] ${speakerId} → "${match.name}" (${match.confidence})`);
      }
    }
  } catch (err) {
    log(`[Voice] Resemblyzer error: ${err.message}`);
  } finally {
    try { fs.unlinkSync(tmpSegments); } catch (_) {}
  }

  return speakerMap;
}

// ── Format for Claude ─────────────────────────────────────────────────────────
// Convert raw segments to labeled transcript text

function applyNamesToTranscript(segments, speakerMap) {
  return segments.map(seg => {
    const name = speakerMap[seg.speaker] || seg.speaker;
    return `[${name}]: ${seg.text}`;
  }).join('\n');
}

module.exports = {
  loadProfiles,
  saveProfiles,
  findAudioFile,
  identifySpeakers,
  applyNamesToTranscript,
  INBOX_DIR,
  PROFILES_PATH,
};

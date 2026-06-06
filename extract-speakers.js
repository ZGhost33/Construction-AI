#!/usr/bin/env node
/**
 * extract-speakers.js
 * Fetches Pocket transcript, extracts per-speaker audio, saves to audio-samples/
 */

const { fetchRecordingDetail } = require('./src/pocket');
const { loadConfig } = require('./src/config');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RECORDING_ID = process.argv[2];
const SPEAKER_MAP  = JSON.parse(process.argv[3]); // e.g. '{"SPEAKER_00":"Luis Cruz","SPEAKER_01":"Tobias"}'
const AUDIO_FILE   = process.argv[4];

if (!RECORDING_ID || !SPEAKER_MAP || !AUDIO_FILE) {
  console.error('Usage: node extract-speakers.js <recording-id> \'{"SPEAKER_00":"Name",...}\' /path/to/audio.mp3');
  process.exit(1);
}

const config = loadConfig();
const b      = config.businesses[0];
const device = b.pocket_devices?.[0] || { api_key: b.pocket_api_key };

fs.mkdirSync('./audio-samples', { recursive: true });

fetchRecordingDetail(device.api_key, RECORDING_ID).then(d => {
  const segs = d.transcript?.segments || d.segments || [];
  console.log(`Loaded ${segs.length} segments from recording ${RECORDING_ID}`);

  for (const [speakerId, name] of Object.entries(SPEAKER_MAP)) {
    const mine = segs.filter(s => s.speaker === speakerId && (s.end - s.start) >= 1.0);
    const totalSecs = mine.reduce((t, s) => t + (s.end - s.start), 0);
    console.log(`\n${speakerId} (${name}): ${mine.length} segments, ${totalSecs.toFixed(1)}s total speech`);

    if (!mine.length) {
      console.log('  Skipping — no segments');
      continue;
    }

    const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'spk_'));
    const segFiles = [];

    for (let i = 0; i < mine.length; i++) {
      const seg  = mine[i];
      const dur  = (seg.end - seg.start).toFixed(3);
      const out  = path.join(tmpDir, `seg${i}.wav`);
      try {
        execSync(
          `ffmpeg -y -ss ${seg.start} -t ${dur} -i "${AUDIO_FILE}" -ar 16000 -ac 1 "${out}" -loglevel error`,
          { timeout: 30000 }
        );
        if (fs.existsSync(out) && fs.statSync(out).size > 1000) segFiles.push(out);
      } catch (e) { /* skip bad segment */ }
    }

    if (!segFiles.length) {
      console.log('  No valid audio segments extracted');
      continue;
    }

    const listFile = path.join(tmpDir, 'list.txt');
    const combined = path.join(tmpDir, 'combined.wav');
    fs.writeFileSync(listFile, segFiles.map(f => `file '${f}'`).join('\n'));
    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" -ar 16000 -ac 1 "${combined}" -loglevel error`,
      { timeout: 60000 }
    );

    const safeName  = name.replace(/ /g, '_');
    const enrollFile = `./audio-samples/${safeName}.wav`;
    fs.copyFileSync(combined, enrollFile);

    const sizeMB = (fs.statSync(enrollFile).size / 1048576).toFixed(2);
    console.log(`  ✓ Saved ${enrollFile} (${sizeMB} MB, ${segFiles.length} segments)`);

    // Cleanup
    segFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
    try { fs.unlinkSync(listFile); fs.unlinkSync(combined); } catch (_) {}
  }

  console.log('\nDone! Now run:');
  for (const [, name] of Object.entries(SPEAKER_MAP)) {
    const safeName = name.replace(/ /g, '_');
    console.log(`  node voice-cli.js enroll "${name}" ./audio-samples/${safeName}.wav`);
  }
}).catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

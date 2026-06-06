/**
 * segmenter.js — Split a Pocket recording into distinct conversations.
 *
 * A single recording may span multiple unrelated conversations (Luis forgets
 * to stop/start between sites, drives between jobs with the Pocket running).
 * This module splits on silence gaps ONLY. It is biased toward keeping
 * conversations together: when borderline, do NOT cut.
 *
 * Algorithm:
 *   1. Walk segments in order.
 *   2. Compute gap = segments[i+1].start - segments[i].end.
 *   3. Gap >= silenceThreshold (default 180s) = hard split boundary.
 *   4. Conversations with < minSpeechSeconds (default 15s) are discarded.
 *
 * Returns an array of conversation objects:
 *   [{
 *     index: 0,
 *     segments: [{speaker, text, start, end}],
 *     startTime: seconds,
 *     endTime: seconds,
 *     totalSpeechSeconds: number,
 *     speakers: Set of speaker labels,
 *     transcript: "SPEAKER_00: text\nSPEAKER_01: text\n..."
 *   }]
 */

const DEFAULT_SILENCE_THRESHOLD = 180; // seconds — configurable in config.json
const DEFAULT_MIN_SPEECH_SECONDS = 15;

/**
 * @param {Array} segments - Pocket transcript segments [{speaker, text, start, end}]
 * @param {number} silenceThresholdSeconds - Gap size that triggers a split
 * @param {number} minSpeechSeconds - Conversations shorter than this are discarded
 * @returns {Array} conversations
 */
function segmentRecording(segments, silenceThresholdSeconds, minSpeechSeconds) {
  const threshold = silenceThresholdSeconds || DEFAULT_SILENCE_THRESHOLD;
  const minSpeech = minSpeechSeconds || DEFAULT_MIN_SPEECH_SECONDS;

  if (!Array.isArray(segments) || segments.length === 0) return [];

  // Build conversation chunks by splitting on silence gaps
  const chunks = [];
  let current = [segments[0]];

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const seg = segments[i];
    const gap = seg.start - prev.end;

    if (gap >= threshold) {
      // Hard boundary — flush current chunk and start new one
      chunks.push(current);
      current = [seg];
    } else {
      current.push(seg);
    }
  }
  if (current.length > 0) chunks.push(current);

  // Convert chunks to conversation objects, discard short ones
  const conversations = [];
  for (let i = 0; i < chunks.length; i++) {
    const segs = chunks[i];
    const totalSpeech = segs.reduce((t, s) => t + Math.max(0, s.end - s.start), 0);

    if (totalSpeech < minSpeech) continue; // too thin — dead air or noise

    const speakers = new Set(segs.map(s => s.speaker).filter(Boolean));
    const startTime = segs[0].start;
    const endTime = segs[segs.length - 1].end;

    // Build flat transcript text for Claude
    const transcript = segs
      .map(s => `${s.speaker || 'UNKNOWN'}: ${s.text}`)
      .join('\n');

    conversations.push({
      index: conversations.length,
      segments: segs,
      startTime,
      endTime,
      totalSpeechSeconds: totalSpeech,
      speakers,
      transcript,
    });
  }

  return conversations;
}

module.exports = { segmentRecording, DEFAULT_SILENCE_THRESHOLD };

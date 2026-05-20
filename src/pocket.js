const axios = require('axios');

const BASE_URL = 'https://public.heypocketai.com/api/v1/public/recordings';

async function fetchRecordings(apiKey) {
  const res = await axios.get(BASE_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 30000,
  });
  // API may return array directly or wrapped in a data/items field
  const body = res.data;
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.recordings)) return body.recordings;
  return [];
}

async function fetchRecordingDetail(apiKey, recordingId) {
  const res = await axios.get(`${BASE_URL}/${recordingId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 30000,
  });
  // API wraps response in { success: true, data: {...} }
  return res.data?.data || res.data;
}

function flattenTranscript(segments, people) {
  // Build a name map from known people (speaker IDs/labels → readable names)
  const speakerMap = {};
  if (Array.isArray(people)) {
    people.forEach(p => {
      // Pocket may label speakers as "SPEAKER_0", "SPEAKER_1", etc.
      // We can't pre-map these without knowing which ID is which person,
      // so we pass the map through in case the API returns speaker names directly.
      speakerMap[p.name] = p.name;
      speakerMap[p.name.toLowerCase()] = p.name;
    });
  }

  if (!Array.isArray(segments) || segments.length === 0) return '';

  return segments
    .map(s => {
      const speaker = speakerMap[s.speaker] || s.speaker || 'UNKNOWN';
      return `${speaker}: ${s.text}`;
    })
    .join('\n');
}

module.exports = { fetchRecordings, fetchRecordingDetail, flattenTranscript };

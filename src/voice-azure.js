/**
 * voice-azure.js
 *
 * Wrapper for Azure Cognitive Services Speaker Recognition API.
 * Text-independent speaker identification — no passphrase required.
 *
 * Docs: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speaker-recognition-overview
 */

const axios = require('axios');
const fs    = require('fs');
const FormData = require('form-data');

function getBase(region) {
  return `https://${region}.api.cognitive.microsoft.com/speaker/identification/v2.0/text-independent`;
}

function headers(key) {
  return { 'Ocp-Apim-Subscription-Key': key };
}

// ── Profile management ────────────────────────────────────────────────────────

async function createProfile(key, region) {
  const res = await axios.post(
    `${getBase(region)}/profiles`,
    { locale: 'en-US' },
    { headers: { ...headers(key), 'Content-Type': 'application/json' } }
  );
  return res.data.profileId;
}

async function deleteProfile(key, region, profileId) {
  await axios.delete(`${getBase(region)}/profiles/${profileId}`, { headers: headers(key) });
}

async function listProfiles(key, region) {
  const res = await axios.get(`${getBase(region)}/profiles`, { headers: headers(key) });
  return res.data.value || [];
}

// ── Enrollment ────────────────────────────────────────────────────────────────
// Needs at least 20 seconds of net speech (non-silence).
// Returns { remainingEnrollmentsSpeechLength, speechLength, enrollmentStatus }
// enrollmentStatus: 'Enrolling' | 'Training' | 'Enrolled'

async function enrollFromFile(key, region, profileId, audioPath) {
  const form = new FormData();
  form.append('audioData', fs.createReadStream(audioPath));

  const res = await axios.post(
    `${getBase(region)}/profiles/${profileId}/enrollments`,
    form,
    { headers: { ...headers(key), ...form.getHeaders() }, timeout: 60000 }
  );
  return res.data;
}

async function enrollFromBuffer(key, region, profileId, audioBuffer, mimeType = 'audio/wav') {
  const form = new FormData();
  form.append('audioData', audioBuffer, { filename: 'audio.wav', contentType: mimeType });

  const res = await axios.post(
    `${getBase(region)}/profiles/${profileId}/enrollments`,
    form,
    { headers: { ...headers(key), ...form.getHeaders() }, timeout: 60000 }
  );
  return res.data;
}

async function getEnrollmentStatus(key, region, profileId) {
  const res = await axios.get(
    `${getBase(region)}/profiles/${profileId}`,
    { headers: headers(key) }
  );
  return res.data; // { profileId, locale, enrollmentStatus, speechLength, ... }
}

// ── Identification ────────────────────────────────────────────────────────────
// Given an audio clip, identify which enrolled speaker it belongs to.
// profileIds: array of Azure profile IDs to compare against.
// Returns { identifiedProfileId, confidence } or null if no match.

async function identifyAudio(key, region, audioBuffer, profileIds, mimeType = 'audio/wav') {
  if (!profileIds || profileIds.length === 0) return null;

  const form = new FormData();
  form.append('audioData', audioBuffer, { filename: 'audio.wav', contentType: mimeType });

  // Azure allows up to 50 profiles per call
  const idList = profileIds.slice(0, 50).join(',');

  const res = await axios.post(
    `${getBase(region)}/profiles:identify?profileIds=${idList}`,
    form,
    { headers: { ...headers(key), ...form.getHeaders() }, timeout: 30000 }
  );

  const result = res.data;
  if (!result.identifiedProfileId) return null;
  return {
    profileId: result.identifiedProfileId,
    confidence: result.confidence, // 'Low' | 'Normal' | 'High'
  };
}

module.exports = {
  createProfile,
  deleteProfile,
  listProfiles,
  enrollFromFile,
  enrollFromBuffer,
  getEnrollmentStatus,
  identifyAudio,
};

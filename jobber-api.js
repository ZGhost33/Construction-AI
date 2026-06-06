'use strict';
/*
 * jobber-api.js — shared, safe Jobber GraphQL client.
 *
 * Why this exists: jobber-cli.js has its own getToken, and ad-hoc scripts that
 * roll their own refresh logic against the same jobber-tokens.json caused a
 * single-use-refresh-token chain break (the 2026-06-01 incident). This module
 * centralizes token handling with two safety properties:
 *   - reads tokens fresh from disk on every call (no stale in-memory copy),
 *   - writes atomically (tmp + rename) and ALWAYS preserves the rotated
 *     refresh_token, so a partial write can never strand the grant.
 *
 * Read-only consumers (scheduler, reports) should use this. It does not write
 * to Jobber — mutations still go through jobber-cli.js.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DIR = __dirname;
const CONFIG = path.join(DIR, 'config.json');
const TOKENS = path.join(DIR, 'jobber-tokens.json');
const GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const API_VERSION = '2026-05-12';

const jc = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).businesses[0].jobber;

function loadTokens() {
  return JSON.parse(fs.readFileSync(TOKENS, 'utf8'));
}

function saveTokensAtomic(tokens) {
  const tmp = TOKENS + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2));
  fs.renameSync(tmp, TOKENS);
}

// Jobber access tokens are JWTs whose `exp` claim is the source of truth for
// expiry. Trusting the OAuth response's expires_in is fragile (the auth-code
// exchange sometimes omits it, which silently nulls expires_at and triggers a
// refresh on every call). Always derive from the JWT, with sane fallbacks.
function computeExpiry(accessToken, expiresInSec) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
    if (payload && payload.exp) return payload.exp * 1000;
  } catch (_) { /* not a JWT — fall through */ }
  if (expiresInSec) return Date.now() + expiresInSec * 1000;
  return Date.now() + 50 * 60 * 1000; // conservative 50-min default
}

async function getToken() {
  let tokens = loadTokens();
  // Refresh only when within 5 min of expiry. expires_at may be a real epoch ms.
  if (!tokens.expires_at || Date.now() > tokens.expires_at - 300000) {
    const body = new URLSearchParams({
      client_id: jc.client_id, client_secret: jc.client_secret,
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
    });
    const res = await axios.post(TOKEN_URL, body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
    // Re-read in case another process refreshed while we were waiting; prefer
    // the freshest refresh_token to avoid clobbering a newer rotation.
    tokens = {
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token || tokens.refresh_token,
      expires_at: computeExpiry(res.data.access_token, res.data.expires_in),
    };
    saveTokensAtomic(tokens);
  }
  return tokens.access_token;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query, variables = {}, _attempt = 0) {
  const token = await getToken();
  const res = await axios.post(GRAPHQL_URL, { query, variables }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': API_VERSION,
    },
    timeout: 25000,
  });
  if (res.data.errors) {
    const msg = res.data.errors.map(e => e.message).join(', ');
    // Jobber uses a cost-based throttle; back off and retry a few times.
    if (/throttle/i.test(msg) && _attempt < 4) {
      await sleep(3000 * (_attempt + 1));
      return gql(query, variables, _attempt + 1);
    }
    throw new Error(msg);
  }
  return res.data.data;
}

// ── Convenience reads ────────────────────────────────────────────────────────

async function findClient(clientName) {
  const data = await gql(`
    query($term: String!) { clients(searchTerm: $term, first: 5) { nodes { id name } } }
  `, { term: clientName });
  const clients = data?.clients?.nodes || [];
  if (!clients.length) throw new Error(`No client found matching "${clientName}"`);
  const lower = clientName.toLowerCase();
  return clients.find(c =>
    c.name.toLowerCase().includes(lower) ||
    lower.includes(c.name.toLowerCase().split(' ')[0])
  ) || clients[0];
}

// Pull jobs for a client with the fields the scheduler needs (scope = lineItems).
async function jobsForClient(clientId) {
  const data = await gql(`
    query($id: EncodedId!) {
      client(id: $id) {
        name
        jobs(first: 25) {
          nodes {
            id jobNumber title jobStatus startAt endAt total createdAt jobberWebUri
            lineItems(first: 50) { nodes { name description quantity unitPrice } }
          }
        }
      }
    }
  `, { id: clientId });
  return data?.client?.jobs?.nodes || [];
}

// Most-recently-created jobs across the whole account, with the fields the
// daily detector needs. Used to spot newly-converted quotes (a converted quote
// becomes a job, so createdAt ~ conversion time).
async function recentJobs(limit = 50) {
  // Lightweight (no lineItems) to stay under the cost throttle; the scanner pulls
  // full scope per-candidate via jobsForClient once it decides which to plan.
  const data = await gql(`
    query($n: Int!) {
      jobs(first: $n) {
        nodes {
          id jobNumber title jobStatus startAt endAt createdAt jobberWebUri
          client { id name }
        }
      }
    }
  `, { n: limit });
  return data?.jobs?.nodes || [];
}

// Fetch one job (with full scope/lineItems) for a known client + job number.
async function getJobWithScope(clientId, jobNumber) {
  const jobs = await jobsForClient(clientId);
  return jobs.find(j => j.jobNumber === Number(jobNumber)) || null;
}

module.exports = { gql, getToken, findClient, jobsForClient, recentJobs, getJobWithScope, API_VERSION };

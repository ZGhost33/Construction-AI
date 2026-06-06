#!/root/.hermes/node/bin/node
'use strict';
/*
 * jobber-reauth.js — one-time Jobber OAuth re-authorization helper.
 *
 * Jobber refresh tokens are single-use and rotate on every refresh. If the
 * rotation chain ever breaks (e.g. two processes refresh against the same
 * token file at once), the only fix is to re-authorize the app. This helper
 * does that without standing up a web server:
 *
 *   1) node jobber-reauth.js url
 *        -> prints the authorize URL. Open it in a browser, log into Jobber,
 *           click Authorize. The browser will try to load
 *           http://localhost:8080/callback?code=XXXX and fail to connect —
 *           that is expected. Copy the `code` value out of the address bar.
 *
 *   2) node jobber-reauth.js exchange <code>
 *        -> exchanges the code for a fresh access+refresh token pair and writes
 *           jobber-tokens.json atomically (timestamped backup first).
 *
 * Writes are atomic (tmp file + rename) and always preserve a rotated refresh
 * token, so a partial write can't strand the grant the way ad-hoc scripts can.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DIR = __dirname;
const CONFIG = path.join(DIR, 'config.json');
const TOKENS = path.join(DIR, 'jobber-tokens.json');
const AUTHORIZE_URL = 'https://api.getjobber.com/api/oauth/authorize';
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

const jc = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).businesses[0].jobber;

function buildAuthUrl() {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('client_id', jc.client_id);
  u.searchParams.set('redirect_uri', jc.redirect_uri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', 'reauth' + Date.now());
  return u.toString();
}

function saveTokensAtomic(tokens) {
  if (fs.existsSync(TOKENS)) {
    fs.copyFileSync(TOKENS, TOKENS + '.bak-' + Date.now());
  }
  const tmp = TOKENS + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2));
  fs.renameSync(tmp, TOKENS); // atomic on same filesystem
}

async function exchange(code) {
  if (!code) { console.error('usage: jobber-reauth.js exchange <code>'); process.exit(1); }
  // Strip anything the user accidentally pasted around the code (full URL, quotes).
  const m = String(code).match(/code=([^&\s'"]+)/);
  const cleanCode = m ? decodeURIComponent(m[1]) : String(code).trim();
  const body = new URLSearchParams({
    client_id: jc.client_id,
    client_secret: jc.client_secret,
    grant_type: 'authorization_code',
    code: cleanCode,
    redirect_uri: jc.redirect_uri,
  });
  let res;
  try {
    res = await axios.post(TOKEN_URL, body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 });
  } catch (e) {
    console.error('EXCHANGE FAILED:', e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 300));
    console.error('The code may be expired (they last only a few minutes) or already used. Re-run `url` and try again.');
    process.exit(1);
  }
  const d = res.data;
  if (!d.access_token || !d.refresh_token) {
    console.error('UNEXPECTED RESPONSE — missing tokens. Keys:', Object.keys(d));
    process.exit(1);
  }
  // Derive expiry from the JWT exp claim — the auth-code exchange may omit
  // expires_in, which would otherwise null out expires_at.
  let expMs;
  try {
    const payload = JSON.parse(Buffer.from(d.access_token.split('.')[1], 'base64').toString());
    expMs = payload?.exp ? payload.exp * 1000 : (d.expires_in ? Date.now() + d.expires_in * 1000 : Date.now() + 50 * 60 * 1000);
  } catch { expMs = d.expires_in ? Date.now() + d.expires_in * 1000 : Date.now() + 50 * 60 * 1000; }
  const tokens = {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: expMs,
  };
  saveTokensAtomic(tokens);
  // Verify the new token actually works before declaring success.
  try {
    const v = await axios.post('https://api.getjobber.com/api/graphql',
      { query: 'query{ clients(first:1){ nodes{ name } } }' },
      { headers: { Authorization: 'Bearer ' + tokens.access_token, 'X-JOBBER-GRAPHQL-VERSION': '2026-05-12' }, timeout: 15000 });
    const ok = !!v.data?.data?.clients;
    console.log('✓ Re-authorized. New access token valid until', new Date(tokens.expires_at).toISOString());
    console.log('  Verification query:', ok ? 'OK (clients reachable)' : 'returned no data — check manually');
  } catch (e) {
    console.log('Tokens saved, but verification query failed:', e.response?.status || e.message);
  }
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'url') { console.log(buildAuthUrl()); return; }
  if (cmd === 'exchange') { await exchange(arg); return; }
  console.error('usage:\n  jobber-reauth.js url\n  jobber-reauth.js exchange <code>');
  process.exit(1);
})();

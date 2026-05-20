/**
 * Run this ONCE to authorize the pipeline with your Jobber account.
 * It will open a browser, you click Allow, and tokens are saved to jobber-tokens.json.
 *
 * Usage: node jobber-setup.js
 */

const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
const { client_id, client_secret, redirect_uri } = config.businesses[0].jobber;

const TOKENS_PATH = path.join(__dirname, 'jobber-tokens.json');
const AUTH_URL = `https://api.getjobber.com/api/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code`;
const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirect_uri);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400);
    res.end('No authorization code found.');
    return;
  }

  console.log('Authorization code received. Exchanging for tokens...');

  try {
    const body = new URLSearchParams({
      client_id,
      client_secret,
      grant_type: 'authorization_code',
      code,
      redirect_uri,
    });

    const axios = require('axios');
    const response = await axios.post(TOKEN_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const tokens = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_at: Date.now() + (response.data.expires_in * 1000),
    };

    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
    console.log('✓ Tokens saved to jobber-tokens.json');
    console.log('✓ Setup complete — you can now run the pipeline');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>✓ Jobber connected successfully. You can close this tab.</h2>');
    server.close();

  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.writeHead(500);
    res.end('Token exchange failed. Check the console.');
    server.close();
  }
});

const PORT = new URL(redirect_uri).port || 8080;
server.listen(PORT, () => {
  console.log(`\nOpening Jobber authorization page...`);
  console.log(`If the browser doesn't open, visit:\n${AUTH_URL}\n`);
  exec(`open "${AUTH_URL}"`);
});

#!/usr/bin/env node
'use strict';
// inference-digest.js — the daily observation push (§4 observation mode).
//
// Runs the cross-job sweep, then sends the observation digest to the owner —
// "here's what I would have surfaced." Only pushes when there's something to
// say (no daily empty message). Plain Telegram send; no live cards. Intended
// to run once a day from a Hermes cron during the observation period.
//
// Usage: inference-digest.js [--chat CHAT_ID]   (default: TELEGRAM_HOME_CHANNEL)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const axios = require('axios');

const DIR = '/root/construction-bi-pipeline';
const NODE = process.execPath;
const INFCLI = path.join(DIR, 'inference-cli.js');
const Z_ENV = '/root/.hermes/profiles/z/.env';

function creds() {
  const env = fs.readFileSync(Z_ENV, 'utf8');
  const token = (env.match(/TELEGRAM_BOT_TOKEN\s*=\s*(.+)/) || [])[1];
  const chat = (env.match(/TELEGRAM_HOME_CHANNEL\s*=\s*(.+)/) || [])[1];
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not found in ' + Z_ENV);
  return { token: token.trim(), chat: chat && chat.trim() };
}

async function main() {
  const args = process.argv.slice(2);
  const chatFlag = args.indexOf('--chat');
  const { token, chat } = creds();
  const chatId = chatFlag >= 0 ? args[chatFlag + 1] : chat;
  if (!chatId) { console.error('no chat id (set TELEGRAM_HOME_CHANNEL or pass --chat)'); process.exit(1); }

  // 1. run the sweep (logs new proactive candidates)
  try { execFileSync(NODE, [INFCLI, 'sweep'], { encoding: 'utf8', timeout: 60000 }); }
  catch (e) { console.error('sweep failed (continuing to digest): ' + e.message); }

  // 2. render the observation digest
  const out = execFileSync(NODE, [INFCLI, 'observe'], { encoding: 'utf8', timeout: 30000 });
  const payload = JSON.parse(out.trim().split('\n').pop());

  // 3. only push when there's something worth reading
  if (/Nothing noticed yet/.test(payload.text || '')) { console.log('nothing to push today'); return; }

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId, text: payload.text, parse_mode: payload.parse_mode || 'Markdown',
  }, { timeout: 10000 });
  console.log('observation digest pushed to ' + chatId);
}

main().catch(err => { console.error('inference-digest failed: ' + err.message); process.exit(1); });

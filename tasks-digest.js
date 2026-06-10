#!/usr/bin/env node
'use strict';
// tasks-digest.js — send the Tasks home message (summary + card-cycler entry,
// Register and Leaderboard buttons) to Telegram. The payload itself is rendered
// by `commit-cli.js home` so the sent message and the in-place tk:home
// re-render are always identical. The agent (or a cron) runs this when someone
// asks for their tasks; all button taps are handled by the review-buttons
// Hermes plugin (tk:* callbacks).
//
// Read-only against the ledger; the only side effect is the Telegram message.
//
// Usage: tasks-digest.js [--chat CHAT_ID]   (default: TELEGRAM_HOME_CHANNEL)

const fs = require('fs');
const { execFileSync } = require('child_process');
const axios = require('axios');

const DIR = '/root/construction-bi-pipeline';
const Z_ENV = '/root/.hermes/profiles/z/.env';

function telegramCreds() {
  const env = fs.readFileSync(Z_ENV, 'utf8');
  const token = (env.match(/TELEGRAM_BOT_TOKEN\s*=\s*(.+)/) || [])[1];
  const chat = (env.match(/TELEGRAM_HOME_CHANNEL\s*=\s*(.+)/) || [])[1];
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not found in ' + Z_ENV);
  return { token: token.trim(), chat: chat && chat.trim() };
}

async function main() {
  const args = process.argv.slice(2);
  const chatFlag = args.indexOf('--chat');
  const { token, chat } = telegramCreds();
  const chatId = chatFlag >= 0 ? args[chatFlag + 1] : chat;
  if (!chatId) { console.error('no chat id (set TELEGRAM_HOME_CHANNEL or pass --chat)'); process.exit(1); }

  const out = execFileSync(process.execPath, [`${DIR}/commit-cli.js`, 'home'], { encoding: 'utf8' });
  const payload = JSON.parse(out.trim().split('\n').pop());

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: payload.text,
    parse_mode: payload.parse_mode || 'Markdown',
    ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}),
  }, { timeout: 10000 });
  console.log(`sent tasks home to ${chatId}`);
}

main().catch(err => { console.error('tasks-digest failed: ' + err.message); process.exit(1); });

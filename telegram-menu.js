#!/usr/bin/env node
'use strict';
// telegram-menu.js — register the guided-workflow bot menu (setMyCommands).
//
// Puts the five work flows in the Telegram menu button / "/" autocomplete:
//   /review     Review queue cards
//   /tasks      Tasks hub (open cycler, register, leaderboard)
//   /status     Read-only system digest
//   /today      Due/overdue today
//   /newclient  Human-confirmed client creation (agent-led flow)
//
// Session plumbing commands (/new /topic /retry …) are deliberately NOT
// registered here — they stay typeable but out of the menu, per the UX brief.
// Run once after deploy (idempotent): node telegram-menu.js [--env PATH]
//
// The only write is Telegram's own setMyCommands for this bot.

const fs = require('fs');
const axios = require('axios');

const DEFAULT_ENV = '/root/.hermes/profiles/z/.env';

const COMMANDS = [
  { command: 'review', description: '📋 Review queue — work through pending cards' },
  { command: 'tasks', description: '✅ Tasks — open, register, leaderboard' },
  { command: 'newclient', description: '➕ New client — guided create (you confirm)' },
  { command: 'status', description: '🔍 Status — queue depth, tasks, last ingest' },
  { command: 'today', description: '📅 Today — due and overdue tasks' },
];

async function main() {
  const args = process.argv.slice(2);
  const envFlag = args.indexOf('--env');
  const envPath = envFlag >= 0 ? args[envFlag + 1] : DEFAULT_ENV;
  const env = fs.readFileSync(envPath, 'utf8');
  const token = (env.match(/TELEGRAM_BOT_TOKEN\s*=\s*(.+)/) || [])[1];
  if (!token) { console.error('TELEGRAM_BOT_TOKEN not found in ' + envPath); process.exit(1); }

  const { data } = await axios.post(
    `https://api.telegram.org/bot${token.trim()}/setMyCommands`,
    { commands: COMMANDS },
    { timeout: 10000 },
  );
  if (!data.ok) throw new Error(JSON.stringify(data));
  console.log(`✅ bot menu set (${COMMANDS.length} commands) via ${envPath}`);
}

main().catch(err => { console.error('telegram-menu failed: ' + err.message); process.exit(1); });

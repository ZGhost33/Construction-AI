#!/usr/bin/env node
/**
 * Drive CLI — used by Hermes agents to access job files from Telegram.
 *
 * Usage:
 *   node drive-cli.js search "Catherine McDonald" [keyword]
 *   node drive-cli.js get <file-id>
 *   node drive-cli.js upload <file-path> "Client Name" [custom-filename]
 *   node drive-cli.js upload-telegram <telegram-file-id> "Client Name" [custom-filename]
 *   node drive-cli.js folders
 *   node drive-cli.js create-folder "Client Name"
 *
 * Output is plain text — Hermes reads it and responds to the user.
 */

const fs = require('fs');
const path = require('path');
const drive = require('./src/drive');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const ROOT_FOLDER_ID = config.google_drive_root_folder_id;

// Bot token for Telegram file downloads — read from first Hermes profile that has one
function getBotToken() {
  // Try Jorge's bot first, then Danilo's
  const profiles = [
    '/root/.hermes/profiles/jorge/.env',
    '/root/.hermes/profiles/danilo/.env',
    '/root/.hermes/profiles/luis/.env',
  ];
  for (const p of profiles) {
    try {
      const env = fs.readFileSync(p, 'utf8');
      const match = env.match(/TELEGRAM_BOT_TOKEN\s*=\s*(.+)/);
      if (match) return match[1].trim();
    } catch (_) {}
  }
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

function formatFileList(files) {
  if (!files.length) return '(no files found)';
  return files.map((f, i) => {
    const size = f.size ? ` (${Math.round(f.size / 1024)}KB)` : '';
    const date = f.modifiedTime ? ` — ${f.modifiedTime.slice(0, 10)}` : '';
    return `${i + 1}. ${f.name}${size}${date}\n   ID: ${f.id}\n   Link: ${f.webViewLink}`;
  }).join('\n\n');
}

async function cmdSearch(clientName, keyword) {
  if (!clientName) {
    console.error('Usage: node drive-cli.js search "Client Name" [keyword]');
    process.exit(1);
  }
  if (!ROOT_FOLDER_ID) {
    console.error('google_drive_root_folder_id not set in config.json');
    process.exit(1);
  }

  const files = await drive.listFiles(ROOT_FOLDER_ID, clientName, keyword || null);
  if (!files.length) {
    console.log(`No files found for "${clientName}"${keyword ? ` matching "${keyword}"` : ''}`);
  } else {
    console.log(`Files for ${clientName}${keyword ? ` (filtered: "${keyword}")` : ''} — ${files.length} found:\n`);
    console.log(formatFileList(files));
  }
}

async function cmdGet(fileId) {
  if (!fileId) {
    console.error('Usage: node drive-cli.js get <file-id>');
    process.exit(1);
  }

  console.log(`Downloading file ${fileId}...`);
  const localPath = await drive.downloadFile(fileId, '/tmp');
  console.log(`✓ Downloaded to: ${localPath}`);
  // Output path on its own line so Hermes can parse and send it as a file
  console.log(`FILE_PATH:${localPath}`);
}

async function cmdUpload(filePath, clientName, customName) {
  if (!filePath || !clientName) {
    console.error('Usage: node drive-cli.js upload <file-path> "Client Name" [custom-filename]');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Uploading "${path.basename(filePath)}" to ${clientName}...`);
  const result = await drive.uploadFile(ROOT_FOLDER_ID, clientName, filePath, customName || null);
  console.log(`✓ Uploaded: ${result.name}`);
  console.log(`  View: ${result.webViewLink}`);
}

async function cmdUploadTelegram(telegramFileId, clientName, customName) {
  if (!telegramFileId || !clientName) {
    console.error('Usage: node drive-cli.js upload-telegram <telegram-file-id> "Client Name" [custom-filename]');
    process.exit(1);
  }

  const botToken = getBotToken();
  if (!botToken) {
    console.error('Could not find Telegram bot token');
    process.exit(1);
  }

  console.log(`Saving file to ${clientName} folder...`);
  const result = await drive.uploadFromTelegram(
    ROOT_FOLDER_ID, clientName, botToken, telegramFileId, customName || null
  );
  console.log(`✓ Saved to Drive: ${result.name}`);
  console.log(`  View: ${result.webViewLink}`);
}

async function cmdFolders() {
  // List client folders using the configured client list as reference
  const biz = config.businesses.find(b => b.name === 'Cruz Services');
  const clients = biz?.clients || [];
  console.log(`Configured clients (${clients.length}):`);
  clients.forEach(c => console.log(`  • ${c.name}`));
  console.log(`\nRoot folder: https://drive.google.com/drive/folders/${ROOT_FOLDER_ID}`);
}

async function cmdCreateFolder(clientName) {
  if (!clientName) {
    console.error('Usage: node drive-cli.js create-folder "Client Name"');
    process.exit(1);
  }

  const result = await drive.ensureClientFolder(ROOT_FOLDER_ID, clientName);
  if (result.created) {
    console.log(`✓ Folder created for "${clientName}" (ID: ${result.folderId})`);
  } else {
    console.log(`Folder already exists for "${clientName}" (ID: ${result.folderId})`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

(async () => {
  try {
    switch (cmd) {
      case 'search':         await cmdSearch(args[0], args[1]); break;
      case 'get':            await cmdGet(args[0]); break;
      case 'upload':         await cmdUpload(args[0], args[1], args[2]); break;
      case 'upload-telegram': await cmdUploadTelegram(args[0], args[1], args[2]); break;
      case 'folders':        await cmdFolders(); break;
      case 'create-folder':  await cmdCreateFolder(args[0]); break;
      default:
        console.log(`Drive CLI — construction-bi-pipeline

Commands:
  search "Client Name" [keyword]                  List files for a client
  get <file-id>                                   Download a file (outputs FILE_PATH for Hermes)
  upload <file-path> "Client Name" [name]         Upload a local file to client folder
  upload-telegram <tg-file-id> "Client Name"      Save a Telegram file to client folder
  folders                                         List all client folders
  create-folder "Client Name"                     Create a folder for a new client
`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();

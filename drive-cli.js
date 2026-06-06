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
  if (files.length) {
    console.log(`Files for ${clientName}${keyword ? ` (filtered: "${keyword}")` : ''} — ${files.length} found:\n`);
    console.log(formatFileList(files));
    return;
  }

  // No files came back. Be honest about WHY — don't let a name mismatch read as
  // "empty." Distinguish: folder missing vs. folder exists-but-empty vs. a
  // keyword that simply matched nothing. The CLI is the source of truth here so
  // the agent relays a fact instead of guessing.
  const folders = await drive.listClientFolders(ROOT_FOLDER_ID);
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(clientName);
  const match = folders.find(f => norm(f.name) === want);

  if (match && keyword) {
    // Folder is real; the keyword filter is what came up empty. Show what's there.
    const all = await drive.listFiles(ROOT_FOLDER_ID, match.name, null);
    if (all.length) {
      console.log(`No files matching "${keyword}" in ${match.name}'s folder, but it has ${all.length} other file(s):\n`);
      console.log(formatFileList(all));
    } else {
      console.log(`${match.name}'s folder exists but is empty — nothing uploaded yet (so nothing matches "${keyword}").`);
    }
    return;
  }

  if (match) {
    console.log(`${match.name}'s folder exists but is currently empty — no files have been uploaded yet. (This is a confirmed empty folder, not a lookup error.)`);
    return;
  }

  // No folder by that name. Offer the closest real folders so a typo/variant
  // never gets reported as "no files."
  const sub = folders.filter(f => norm(f.name).includes(want) || want.includes(norm(f.name)));
  const lev = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const near = (sub.length ? sub.map(f => f.name)
    : folders.map(f => ({ n: f.name, d: lev(want, norm(f.name)) }))
        .sort((x, y) => x.d - y.d).filter(x => x.d <= 6).slice(0, 5).map(x => x.n));
  console.log(`No Drive folder found for "${clientName}".` +
    (near.length ? ` Closest folder${near.length > 1 ? 's' : ''}: ${near.join(', ')}. Try the exact name.`
                 : ` No similar folder names either — check the client name.`));
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

async function cmdMergeFolders(sourceName, targetName) {
  if (!sourceName || !targetName) {
    console.error('Usage: node drive-cli.js merge-folders "Duplicate Name" "Keep Name"');
    process.exit(1);
  }
  console.log(`Merging "${sourceName}" into "${targetName}"...`);
  const result = await drive.mergeFolders(ROOT_FOLDER_ID, sourceName, targetName);
  if (result.moved === 0) {
    console.log('Source folder was empty — deleted.');
  } else {
    console.log(`Moved ${result.moved} file(s):`);
    result.files.forEach(f => console.log(`  ✓ ${f}`));
    console.log('Source folder deleted.');
  }
  console.log(`Done. All files now in "${targetName}".`);
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
      case 'merge-folders':  await cmdMergeFolders(args[0], args[1]); break;
      default:
        console.log(`Drive CLI — construction-bi-pipeline

Commands:
  search "Client Name" [keyword]                  List files for a client
  get <file-id>                                   Download a file (outputs FILE_PATH for Hermes)
  upload <file-path> "Client Name" [name]         Upload a local file to client folder
  upload-telegram <tg-file-id> "Client Name"      Save a Telegram file to client folder
  folders                                         List all client folders
  create-folder "Client Name"                     Create a folder for a new client
  merge-folders "Duplicate Name" "Keep Name"      Merge duplicate folders into one
`);

    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();

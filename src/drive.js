/**
 * drive.js — Google Drive API client for Cruz Services
 *
 * Uses a service account to access a shared Drive folder.
 * All client files live under a root folder with one sub-folder per client.
 *
 * Folder structure:
 *   Cruz Services Jobs/
 *     ├── Catherine McDonald/
 *     ├── Brian Harris/
 *     └── ...
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const KEY_PATH = path.join(__dirname, '..', 'drive-service-account.json');

function getAuth() {
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

function getDrive() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

// ── Folder helpers ────────────────────────────────────────────────────────────

// Find a folder by name inside a parent folder. Returns folder ID or null.
async function findFolder(drive, name, parentId) {
  const q = [
    `mimeType = 'application/vnd.google-apps.folder'`,
    `name = '${name.replace(/'/g, "\\'")}'`,
    `'${parentId}' in parents`,
    `trashed = false`,
  ].join(' and ');

  const res = await drive.files.list({
    q,
    fields: 'files(id, name)',
    spaces: 'drive',
  });
  return res.data.files?.[0]?.id || null;
}

// Create a folder inside a parent. Returns folder ID.
async function createFolder(drive, name, parentId) {
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return res.data.id;
}

// Get or create a client folder under the root. Returns folder ID.
async function getClientFolder(rootFolderId, clientName) {
  const drive = getDrive();
  let folderId = await findFolder(drive, clientName, rootFolderId);
  if (!folderId) {
    folderId = await createFolder(drive, clientName, rootFolderId);
  }
  return folderId;
}

// ── File operations ───────────────────────────────────────────────────────────

// List files in a client's folder (optionally filter by keyword)
async function listFiles(rootFolderId, clientName, keyword = null) {
  const drive = getDrive();
  const folderId = await findFolder(drive, clientName, rootFolderId);
  if (!folderId) return [];

  let q = `'${folderId}' in parents and trashed = false`;
  if (keyword) {
    q += ` and name contains '${keyword.replace(/'/g, "\\'")}'`;
  }

  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink, webContentLink)',
    orderBy: 'modifiedTime desc',
    spaces: 'drive',
    pageSize: 20,
  });
  return res.data.files || [];
}

// Upload a file to a client's folder. Returns the uploaded file metadata.
async function uploadFile(rootFolderId, clientName, filePath, customName = null) {
  const drive = getDrive();
  const folderId = await getClientFolder(rootFolderId, clientName);

  const fileName = customName || path.basename(filePath);
  const fileStream = fs.createReadStream(filePath);

  // Guess MIME type from extension
  const ext = path.extname(fileName).toLowerCase();
  const mimeMap = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.heic': 'image/heic',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.dwg': 'application/acad',
    '.dxf': 'application/dxf',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: { mimeType, body: fileStream },
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

// Download a file by ID to a local temp path. Returns the local file path.
async function downloadFile(fileId, destDir = '/tmp') {
  const drive = getDrive();

  // Get file metadata first
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType',
  });
  const fileName = meta.data.name;
  const destPath = path.join(destDir, fileName);

  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    res.data.on('end', resolve).on('error', reject).pipe(dest);
  });

  return destPath;
}

// Download a file from Telegram and upload it to Drive
async function uploadFromTelegram(rootFolderId, clientName, botToken, telegramFileId, customName = null) {
  // Get Telegram file path
  const infoRes = await axios.get(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${telegramFileId}`
  );
  if (!infoRes.data.ok) throw new Error('Could not get Telegram file info');

  const tgFilePath = infoRes.data.result.file_path;
  const tgFileName = path.basename(tgFilePath);
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${tgFilePath}`;

  // Download to /tmp
  const localPath = `/tmp/${Date.now()}_${tgFileName}`;
  const writer = fs.createWriteStream(localPath);
  const dlRes = await axios({ url: downloadUrl, method: 'GET', responseType: 'stream' });
  await new Promise((resolve, reject) => {
    dlRes.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  // Upload to Drive
  const result = await uploadFile(rootFolderId, clientName, localPath, customName || tgFileName);

  // Clean up temp file
  fs.unlink(localPath, () => {});

  return result;
}

// Create a client folder if it doesn't exist (called during client sync)
async function ensureClientFolder(rootFolderId, clientName) {
  const drive = getDrive();
  let folderId = await findFolder(drive, clientName, rootFolderId);
  if (!folderId) {
    folderId = await createFolder(drive, clientName, rootFolderId);
    return { created: true, folderId };
  }
  return { created: false, folderId };
}

module.exports = {
  listFiles,
  uploadFile,
  downloadFile,
  uploadFromTelegram,
  ensureClientFolder,
  getClientFolder,
};

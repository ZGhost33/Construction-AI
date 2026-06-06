/**
 * drive.js — Google Drive API client for Cruz Services
 *
 * Uses a service account to access CRUZ DRIVE (Google Shared Drive).
 * All client files live under the Shared Drive with one sub-folder per client.
 *
 * Folder structure:
 *   CRUZ DRIVE (Shared Drive)/
 *     ├── Brian Harris/
 *     ├── Martha Glantz/
 *     └── ...
 *
 * Shared Drive ID: 0AOUeQmyt6sXMUk9PVA
 * Service account must be added as Content Manager on the Shared Drive.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const KEY_PATH = path.join(__dirname, '..', 'drive-service-account.json');

// Shared Drive parameters — required for all API calls
const SHARED_DRIVE_PARAMS = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
};

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

// Canonicalize a folder/client name for matching & creation: collapse any run of
// whitespace to a single space and trim. This is what prevents "Jane Joyce" and
// "Jane  Joyce" (two spaces — as Jobber sometimes stores names) from resolving to
// two different folders and silently spawning duplicates.
function normName(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// Find a folder by name inside a parent folder. Returns folder ID or null.
//
// Whitespace- and case-insensitive: we list the parent's child folders and match
// on the normalized name rather than an exact Drive `name =` query. An exact
// (raw) match always wins; otherwise we fall back to the normalized match,
// preferring the oldest folder (the original canonical one) when duplicates still
// exist, so lookups are stable.
async function findFolder(drive, name, parentId) {
  const want = normName(name).toLowerCase();

  let folders = [], token = null;
  do {
    const res = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, createdTime)',
      pageSize: 200,
      pageToken: token,
      ...SHARED_DRIVE_PARAMS,
    });
    folders = folders.concat(res.data.files || []);
    token = res.data.nextPageToken;
  } while (token);

  if (!folders.length) return null;
  const exact = folders.find(f => f.name === name);
  if (exact) return exact.id;
  const matches = folders
    .filter(f => normName(f.name).toLowerCase() === want)
    .sort((a, b) => String(a.createdTime || '').localeCompare(String(b.createdTime || '')));
  return matches[0]?.id || null;
}

// Create a folder inside a parent. Returns folder ID. Name is normalized so we
// never create a folder whose only difference from an existing one is whitespace.
async function createFolder(drive, name, parentId) {
  const res = await drive.files.create({
    requestBody: {
      name: normName(name),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    ...SHARED_DRIVE_PARAMS,
  });
  return res.data.id;
}

// List every client folder under the root (id + name). Used by the CLI to give
// honest, specific answers ("exists but empty" vs "no such folder, did you mean…")
// instead of a vague "empty" that an agent might over-interpret.
async function listClientFolders(rootFolderId) {
  const drive = getDrive();
  let folders = [], token = null;
  do {
    const res = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and '${rootFolderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 200,
      pageToken: token,
      ...SHARED_DRIVE_PARAMS,
    });
    folders = folders.concat(res.data.files || []);
    token = res.data.nextPageToken;
  } while (token);
  return folders;
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
    pageSize: 20,
    ...SHARED_DRIVE_PARAMS,
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
    ...SHARED_DRIVE_PARAMS,
  });
  return res.data;
}

// Update the CONTENT of an existing Drive file in place (same fileId, same link).
// Used to refresh a schedule's "Materials & Schedule" doc after an edit without
// creating a duplicate file. Returns { id, name, webViewLink }.
async function updateFileById(fileId, filePath, newName = null) {
  const drive = getDrive();
  const fileStream = fs.createReadStream(filePath);
  // Match uploadFile: .md/.txt and unknown extensions are stored as octet-stream
  // so the in-place update keeps the existing file's type/rendering unchanged.
  const mimeType = 'application/octet-stream';
  const res = await drive.files.update({
    fileId,
    ...(newName ? { requestBody: { name: newName } } : {}),
    media: { mimeType, body: fileStream },
    fields: 'id, name, webViewLink',
    ...SHARED_DRIVE_PARAMS,
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
    ...SHARED_DRIVE_PARAMS,
  });
  const fileName = meta.data.name;
  const destPath = path.join(destDir, fileName);

  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get(
    { fileId, alt: 'media', ...SHARED_DRIVE_PARAMS },
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
  listClientFolders,
  uploadFile,
  updateFileById,
  downloadFile,
  uploadFromTelegram,
  ensureClientFolder,
  getClientFolder,
  moveFile,
  trashFolder,
  mergeFolders,
};


// Move a file from one folder to another (used for merging duplicate client folders)
async function moveFile(fileId, fromFolderId, toFolderId) {
  const d = getDrive();
  const res = await d.files.update({
    fileId,
    addParents: toFolderId,
    removeParents: fromFolderId,
    fields: 'id, name, webViewLink',
    ...SHARED_DRIVE_PARAMS,
  });
  return res.data;
}

// Trash a folder by ID
async function trashFolder(folderId) {
  const d = getDrive();
  await d.files.update({
    fileId: folderId,
    requestBody: { trashed: true },
    ...SHARED_DRIVE_PARAMS,
  });
}

// Merge all files from sourceName folder into targetName folder, then trash source
async function mergeFolders(rootFolderId, sourceName, targetName) {
  const d = getDrive();
  const sourceFolderId = await findFolder(d, sourceName, rootFolderId);
  if (!sourceFolderId) throw new Error('Source folder not found: ' + sourceName);
  const targetFolderId = await findFolder(d, targetName, rootFolderId);
  if (!targetFolderId) throw new Error('Target folder not found: ' + targetName);

  const res = await d.files.list({
    q: "'" + sourceFolderId + "' in parents and trashed = false",
    fields: 'files(id, name)',
    ...SHARED_DRIVE_PARAMS,
  });
  const files = res.data.files || [];

  for (const file of files) {
    await moveFile(file.id, sourceFolderId, targetFolderId);
  }

  await trashFolder(sourceFolderId);
  return { moved: files.length, files: files.map(f => f.name) };
}

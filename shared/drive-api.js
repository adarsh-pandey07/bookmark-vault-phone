// Google Drive calls shared by the extension and the phone app.
// Every function takes an access token; signing in is done by each side
// (the extension with chrome.identity, the phone app with Google's sign-in
// script). With the drive.file scope, the app only sees files it made itself.

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const FOLDER_NAME = 'Bookmark Vault';
export const SNAPSHOT_NAME = 'vault.json.gz'; // all bookmarks, written by the extension
export const EDITS_NAME = 'phone-edits.json'; // To do / Done / star changes, written by the phone

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';

async function call(token, url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg += ` ${(await res.json()).error?.message ?? ''}`; } catch {}
    const err = new Error(`Drive: ${msg.trim()}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Files the app can see with this name (newest first).
export async function find(token, { name, parent, folder = false } = {}) {
  const parts = ['trashed = false'];
  if (name) parts.push(`name = '${q(name)}'`);
  if (parent) parts.push(`'${q(parent)}' in parents`);
  if (folder) parts.push(`mimeType = '${FOLDER_TYPE}'`);
  const url = `${API}/files?${new URLSearchParams({
    q: parts.join(' and '),
    fields: 'files(id,name,mimeType,size,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: '100',
    spaces: 'drive',
  })}`;
  return (await (await call(token, url)).json()).files;
}

export async function findFolder(token) {
  return (await find(token, { name: FOLDER_NAME, folder: true }))[0] ?? null;
}

// A file's details by its ID, or null if it's gone or in the trash.
export async function info(token, fileId) {
  try {
    const f = await (await call(token, `${API}/files/${encodeURIComponent(fileId)}?fields=id,name,size,modifiedTime,parents,trashed`)).json();
    return f.trashed ? null : f;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// The folder, using the ID remembered from last time when it still exists.
// Looking up by name is a fallback only: Drive's search lags a few seconds
// behind new files, so a quick second lookup can miss a folder just made.
export async function ensureFolder(token, knownId) {
  if (knownId && (await info(token, knownId))) return { id: knownId };
  const found = await findFolder(token);
  if (found) return found;
  const res = await call(token, `${API}/files?fields=id,name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_TYPE }),
  });
  return res.json();
}

async function upload(token, fileId, meta, blob) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', blob);
  const fields = 'fields=id,name,size,modifiedTime';
  const url = fileId
    ? `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=multipart&${fields}`
    : `${UPLOAD}/files?uploadType=multipart&${fields}`;
  return (await call(token, url, { method: fileId ? 'PATCH' : 'POST', body: form })).json();
}

// Write a file in the folder. id = the file's ID from last time: it's
// replaced in place. Without one (or if that file was deleted), an existing
// file with the same name is replaced, otherwise a new one is made.
// Returns the file's details; keep its id for next time.
export async function save(token, { folderId, name, id, blob }) {
  if (id && (await info(token, id))) return upload(token, id, {}, blob); // (a file in the trash counts as gone)
  const existing = (await find(token, { name, parent: folderId }))[0];
  return upload(token, existing?.id, existing ? {} : { name, parents: [folderId] }, blob);
}

// Older name for save() without a remembered ID (used by the test page).
export const put = (token, folderId, name, blob) => save(token, { folderId, name, blob });

export async function download(token, fileId) {
  return (await call(token, `${API}/files/${fileId}?alt=media`)).blob();
}

// JSON packed small with gzip (bookmark text compresses about 5 to 1).
export async function pack(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(stream).arrayBuffer()], { type: 'application/gzip' });
}

export async function unpack(blob) {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

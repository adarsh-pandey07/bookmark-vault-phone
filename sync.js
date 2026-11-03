// How the phone page and the extension stay in step through Google Drive.
//
// The extension uploads every bookmark to vault.json.gz. The phone keeps a
// copy (the "base") and a list of your changes that the computer hasn't
// confirmed yet ("pending"). What you see is the base with your pending
// changes on top.
//
// The phone writes its pending changes to phone-edits.json. The computer
// merges them (newest change to each field wins) and uploads vault.json.gz
// again. When the phone sees its change in the new upload (or a newer change
// made on the computer), it stops sending it.
import { mergeUserFields, valueOf } from './shared/user-fields.js';

// Fields the phone can change.
export const PHONE_FIELDS = ['status', 'star', 'snoozeUntil'];

// Note a change you just made to t (with setField) so it gets sent.
export function recordEdit(pending, t, field) {
  const e = pending[t.id] ?? { id: t.id, changed: {} };
  pending[t.id] = { ...e, [field]: valueOf(t, field), changed: { ...e.changed, [field]: t.changed[field] } };
  return pending;
}

// The bookmarks as you see them: the computer's copy with your changes on top.
export function overlay(base, pending) {
  return base.map((t) => {
    const e = pending[t.id];
    if (!e) return t;
    const copy = { ...t, changed: { ...(t.changed || {}) } };
    mergeUserFields(copy, e);
    return copy;
  });
}

// Changes the computer's copy doesn't include yet. A field is done once the
// computer has a change to it at least as new as yours. Changes to
// bookmarks the computer no longer has are dropped.
export function unconfirmed(base, pending) {
  const byId = new Map(base.map((t) => [t.id, t]));
  const out = {};
  for (const [id, e] of Object.entries(pending)) {
    const t = byId.get(id);
    if (!t) continue;
    const changed = {};
    for (const [f, at] of Object.entries(e.changed || {})) if ((t.changed?.[f] || 0) < at) changed[f] = at;
    if (!Object.keys(changed).length) continue;
    const keep = { id, changed };
    for (const f of Object.keys(changed)) keep[f] = e[f];
    out[id] = keep;
  }
  return out;
}

// What goes in phone-edits.json (without the time, so it can be compared).
export const editsBody = (pending) =>
  JSON.stringify(Object.values(pending).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

export class NothingOnDrive extends Error {}

// One sync. files = Drive IDs remembered from last time; base = the copy
// you have (or null); getPending = your changes right now (read after the
// download, so a change made while syncing isn't lost); sent = what was
// last written to phone-edits.json.
// Returns the new { files, base, pending, sent }.
export async function syncWithDrive(drive, token, { files = {}, base = null, getPending, sent = null }) {
  files = { ...files };

  // 1. Find the computer's upload, by its remembered ID if possible.
  let snap = files.snapshot ? await drive.info(token, files.snapshot) : null;
  if (!snap) {
    const folder = (files.folder && (await drive.info(token, files.folder))) || (await drive.findFolder(token));
    if (!folder) throw new NothingOnDrive('No "Bookmark Vault" folder in your Drive yet.');
    files.folder = folder.id;
    snap = (await drive.find(token, { name: drive.SNAPSHOT_NAME, parent: folder.id }))[0];
    if (!snap) throw new NothingOnDrive('The "Bookmark Vault" folder has no bookmarks yet.');
  }
  files.snapshot = snap.id;
  if (snap.parents?.[0]) files.folder = snap.parents[0];

  // 2. Download it if it changed.
  if (!base || base.modifiedTime !== snap.modifiedTime) {
    const data = await drive.unpack(await drive.download(token, snap.id));
    base = { tweets: (data.tweets || []).filter((t) => !t.stub), colors: data.colors || {}, exportedAt: data.exportedAt, modifiedTime: snap.modifiedTime };
  }

  // 3. Send the changes the computer doesn't have yet.
  const pending = unconfirmed(base.tweets, await getPending());
  const body = editsBody(pending);
  if (body !== (sent ?? editsBody({}))) {
    const blob = new Blob([`{"format":1,"from":"phone","updatedAt":${Date.now()},"edits":${body}}`], { type: 'application/json' });
    const file = await drive.save(token, { folderId: files.folder, name: drive.EDITS_NAME, id: files.edits, blob });
    files.edits = file.id;
  }
  return { files, base, pending, sent: body };
}

// Your own fields on a bookmark: reading status, star, note, tags,
// hand-picked categories and a "remind me" date. Each records when it last changed (t.changed),
// so edits made somewhere else (the phone app) can be merged field by field:
// the newest change to each field wins, and a status changed on the phone
// never overwrites a note written on the Mac.
//
// The post itself (text, author, media) comes from X and is never merged.

export const USER_FIELDS = ['status', 'star', 'note', 'tags', 'categories', 'snoozeUntil'];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Value as stored, with the defaults a bookmark has when a field was never set.
export function valueOf(t, field) {
  switch (field) {
    case 'status': return t.status || 'new';
    case 'star': return !!t.star;
    case 'note': return t.note || '';
    case 'tags': return t.tags || [];
    case 'categories': return t.locked ? (t.categories || []) : null; // only hand-picked ones count
    case 'snoozeUntil': return t.snoozeUntil || null; // "remind me" time, see reading.js
    default: return t[field];
  }
}

// Set one of your fields and note when. Returns true if it changed.
// For categories, pass the list you picked by hand, or null to go back to
// automatic sorting.
export function setField(t, field, value, at = Date.now()) {
  if (same(valueOf(t, field), value)) return false;
  if (field === 'categories') {
    t.locked = value != null;
    if (value != null) t.categories = value;
  } else {
    t[field] = value;
  }
  if (field === 'status') t.statusAt = at;
  t.changed = { ...(t.changed || {}), [field]: at };
  t.updatedAt = Date.now();
  return true;
}

// Copy into `local` every field that `remote` changed more recently.
// Returns the names of the fields that were taken from `remote`.
// Automatic categories are worked out again by the caller when a bookmark
// goes back to automatic sorting.
export function mergeUserFields(local, remote) {
  const taken = [];
  for (const field of USER_FIELDS) {
    const theirs = remote.changed?.[field] || 0;
    const ours = local.changed?.[field] || 0;
    if (theirs > ours && setField(local, field, valueOf(remote, field), theirs)) taken.push(field);
  }
  return taken;
}

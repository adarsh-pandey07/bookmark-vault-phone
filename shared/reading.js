// Reading status for each bookmark: New (not really looked at yet), To do
// (need to work on or try it), or Done (seen). Separate from that, any
// bookmark can be starred as Important. Bookmarks without a status are New.
import { setField } from './user-fields.js';

export const STATUSES = [['new', 'New'], ['todo', 'To do'], ['done', 'Done']];
export const statusOf = (t) => t.status || 'new';
export const statusLabel = (s) => STATUSES.find(([k]) => k === s)?.[1] ?? 'New';

export const setStatus = (t, status) => setField(t, 'status', status);

// Local date like "2026-11-02", so the daily pick changes at your midnight.
export const today = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Small, repeatable random number from a string, so the daily pick stays the
// same all day instead of changing every time the popup opens.
export function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// ---------------- resurfacing ----------------
// Bringing old bookmarks back so they don't get buried: daily picks (with a
// reason for each), "remind me" dates, shuffle, and a weekly review.
// Daily picks and the weekly review can be turned off in the dashboard.
export const DEFAULT_RESURFACE = { daily: true, weekly: true, weekDay: 0 }; // weekDay: 0 = Sunday … 6 = Saturday
export const resurfaceSettings = (saved) => ({ ...DEFAULT_RESURFACE, ...(saved || {}) });

const DAY = 864e5;
export const isSnoozed = (t, now = Date.now()) => (t.snoozeUntil || 0) > now; // waiting for its date
export const isDue = (t, now = Date.now()) => !!t.snoozeUntil && t.snoozeUntil <= now; // its date has come
export const snooze = (t, at) => setField(t, 'snoozeUntil', at || null);

// "Remind me" choices, each at 8:00 in the morning.
export function snoozeChoices(now = Date.now()) {
  const at8 = (ms) => { const d = new Date(ms); d.setHours(8, 0, 0, 0); return d.getTime(); };
  const dow = new Date(now).getDay();
  const toSat = ((6 - dow + 7) % 7) || 7; // next Saturday (a week ahead if today is Saturday)
  const month = new Date(now); month.setMonth(month.getMonth() + 1);
  return [
    ['Tomorrow', at8(now + DAY)],
    [dow === 0 || dow === 6 ? 'Next weekend' : 'This weekend', at8(now + toSat * DAY)],
    ['Next week', at8(now + 7 * DAY)],
    ['In a month', at8(month.getTime())],
  ];
}

// "3 weeks", "8 months"…
export function span(ms) {
  const d = Math.floor(ms / DAY);
  if (d < 1) return 'less than a day';
  if (d < 14) return `${d} day${d === 1 ? '' : 's'}`;
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  if (d < 730) return `${Math.round(d / 30.4)} months`;
  return `${Math.round(d / 365)} years`;
}

// Why a bookmark came up, shown under each pick.
export function pickReason(t, now = Date.now()) {
  if (isDue(t, now)) return 'You asked to see this again';
  if (statusOf(t) === 'todo') return t.statusAt ? `In To do for ${span(now - t.statusAt)}` : 'In To do';
  if (statusOf(t) === 'done') return t.createdAt ? `Posted ${span(now - t.createdAt)} ago, already Done` : 'Already Done';
  return t.createdAt ? `Posted ${span(now - t.createdAt)} ago, still New` : 'Still New';
}

// "Pick up again": a few bookmarks a day so old ones don't get buried.
// First any whose "remind me" date has come, then up to 2 from To do (the
// ones waiting longest first), the rest from New bookmarks posted more than
// 2 weeks ago, chosen at random for the day. Snoozed ones wait for their date.
// (Post date stands in for the save date: imported bookmarks all share the
// import day as their save date.)
// skip = ids you dismissed today.
export function dailyPicks(all, { count = 5, day = today(), skip = [], now = Date.now() } = {}) {
  const skipped = new Set(skip);
  const ok = (t) => !t.stub && !skipped.has(t.id) && !isSnoozed(t, now);
  const due = all.filter((t) => ok(t) && isDue(t, now)).sort((a, b) => a.snoozeUntil - b.snoozeUntil);
  const rest = (t) => ok(t) && !isDue(t, now);
  const todo = all.filter((t) => rest(t) && statusOf(t) === 'todo')
    .sort((a, b) => (a.statusAt || a.savedAt || 0) - (b.statusAt || b.savedAt || 0));
  const twoWeeks = now - 14 * DAY;
  const old = all.filter((t) => rest(t) && statusOf(t) === 'new' && (t.createdAt || t.savedAt || 0) < twoWeeks)
    .map((t) => [t, seeded(day + t.id)]).sort((a, b) => a[1] - b[1]).map(([t]) => t);
  const picks = due.slice(0, count);
  for (const t of todo.slice(0, 2)) { if (picks.length >= count) break; picks.push(t); }
  for (const t of old) { if (picks.length >= count) break; picks.push(t); }
  for (const t of todo.slice(2)) { if (picks.length >= count) break; picks.push(t); } // few old New ones: fill with To do
  return picks;
}

// A random handful of bookmarks you haven't finished (New or To do).
export function shuffled(all, { count = 3, seed = String(Math.random()), now = Date.now() } = {}) {
  return all.filter((t) => !t.stub && statusOf(t) !== 'done' && !isSnoozed(t, now))
    .map((t) => [t, seeded(seed + t.id)]).sort((a, b) => a[1] - b[1]).slice(0, count).map(([t]) => t);
}

// Weekly review: your oldest New bookmarks, to go through one at a time.
export function weeklyReview(all, { count = 10, now = Date.now() } = {}) {
  return all.filter((t) => !t.stub && statusOf(t) === 'new' && !isSnoozed(t, now))
    .sort((a, b) => (a.createdAt || Infinity) - (b.createdAt || Infinity)).slice(0, count);
}

// The weekly review is offered from your chosen day until you start or skip
// it, for up to a week. Returns the date it's for ("2026-11-01"), or null.
// doneFor = the date of the last one you started or skipped.
export function weeklyDue(settings, doneFor, now = Date.now()) {
  if (!settings.weekly) return null;
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() - settings.weekDay + 7) % 7)); // the latest chosen weekday, today or before
  const key = today(d);
  return key === doneFor ? null : key;
}

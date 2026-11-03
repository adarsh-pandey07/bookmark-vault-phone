// Bookmark Vault on the phone: read your bookmarks, search and browse them,
// and mark them To do / Done / Important or "remind me later".
// Four tabs at the bottom: New, To do, Browse (lists and categories), Search. Works offline
// from the copy saved on the phone; changes go back to the computer through
// Google Drive (see sync.js).
import * as drive from './shared/drive-api.js';
import { setField, valueOf } from './shared/user-fields.js';
import { statusOf, snoozeChoices, isDue } from './shared/reading.js';
import { GOOGLE_CLIENT_ID, SIGNIN_URL } from './shared/config.js';
import * as store from './store.js';
import { installBox, isInstalled, device, onInstallChange } from './install.js';
import { recordEdit, overlay, unconfirmed, editsBody, syncWithDrive, NothingOnDrive } from './sync.js';

const $ = (id) => document.getElementById(id);
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const PAGE = 40;

const state = {
  base: null, pending: {}, files: {}, sent: null, syncedAt: 0,
  tweets: [], // what you see: base + your changes
  route: null, seg: 'all', q: '', shown: PAGE,
  syncing: false, error: null,
};

// ---------------- Google sign-in ----------------
// Google gives the page a token that lasts about an hour.
// - With the sign-in helper (SIGNIN_URL, see signin-helper/): you sign in
//   once and the phone also keeps a "refresh token", which gets a new hourly
//   token without asking. It stays on this phone.
// - Without it: signing in again takes a tap every hour, so syncing after
//   that waits for "Sync".
const clientId = () => GOOGLE_CLIENT_ID || ls.get('clientId') || '';
const helper = () => SIGNIN_URL.replace(/\/+$/, '');

function savedToken() {
  try {
    const t = JSON.parse(ls.get('token') || 'null');
    return t && t.until > Date.now() + 60_000 ? t.token : null;
  } catch { return null; }
}
const keepToken = (r) => {
  ls.set('token', JSON.stringify({ token: r.access_token, until: Date.now() + (Number(r.expires_in) || 3600) * 1000 }));
  ls.set('signedIn', '1');
  return r.access_token;
};
// Can sync without a tap?
const signedIn = () => !!(savedToken() || (helper() && ls.get('refresh')));

async function askHelper(path, body) {
  const res = await fetch(`${helper()}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `sign-in helper: ${res.status}`), { code: data.error, status: res.status });
  return data;
}

// A fresh token without a tap, from the refresh token. null if there's none
// or Google no longer accepts it (then you're asked to sign in again).
let refreshing = null;
function refreshToken() {
  const rt = helper() && ls.get('refresh');
  if (!rt) return Promise.resolve(null);
  refreshing ??= askHelper('refresh', { refresh_token: rt })
    .then(keepToken)
    .catch((e) => {
      if (e.code === 'invalid_grant') ls.del('refresh'); // revoked or expired: sign in again
      else if (e instanceof TypeError) throw e; // offline: try again later
      return null;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function currentToken() {
  return savedToken() || (await refreshToken());
}

function signIn() {
  return new Promise((resolve, reject) => {
    if (!clientId()) { reject(new Error('Add the Google client ID first.')); return; }
    if (!window.google?.accounts?.oauth2) { reject(new Error(navigator.onLine ? 'Google sign-in is still loading. Try again in a moment.' : 'You\'re offline.')); return; }
    const error_callback = (e) => reject(new Error(e?.type === 'popup_closed' ? 'Sign-in was closed.' : `Google: ${e?.type || 'sign-in failed'}`));
    if (helper()) {
      google.accounts.oauth2.initCodeClient({
        client_id: clientId(),
        scope: drive.SCOPE,
        ux_mode: 'popup',
        callback: async (r) => {
          if (r.error) { reject(new Error(`Google: ${r.error}`)); return; }
          try {
            const t = await askHelper('token', { code: r.code });
            if (t.refresh_token) ls.set('refresh', t.refresh_token);
            resolve(keepToken(t));
          } catch (e) { reject(new Error(`Couldn't finish signing in: ${e.message}`)); }
        },
        error_callback,
      }).requestCode();
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: drive.SCOPE,
      callback: (r) => {
        if (r.error) { reject(new Error(`Google: ${r.error}`)); return; }
        resolve(keepToken(r));
      },
      error_callback,
    });
    client.requestAccessToken(ls.get('signedIn') ? { prompt: '' } : {});
  });
}

// ---------------- syncing ----------------
const dirty = () => editsBody(state.pending) !== (state.sent ?? editsBody({}));
const pendingCount = () => Object.keys(state.pending).length;

async function sync({ interactive = false } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  renderStatus();
  try {
    state.error = await syncOnce(interactive);
  } finally {
    state.syncing = false;
    show();
    if (!state.error && dirty()) syncSoon(); // you changed something while it ran
  }
}

// One try. Returns the error to show, or null.
async function syncOnce(interactive, retry = true) {
  let token;
  try { token = await currentToken(); } catch { return 'offline'; }
  if (!token) {
    if (!interactive) return state.error;
    try { token = await signIn(); } catch (e) { return e.message; }
  }
  try {
    const r = await syncWithDrive(drive, token, {
      files: state.files, base: state.base, sent: state.sent, getPending: async () => state.pending,
    });
    Object.assign(state, { files: r.files, base: r.base, sent: r.sent, syncedAt: Date.now() });
    state.pending = unconfirmed(r.base.tweets, state.pending); // keeps changes made while syncing
    await store.set({ base: state.base, pending: state.pending, files: state.files, sent: state.sent, syncedAt: state.syncedAt });
    rebuild();
    return null;
  } catch (e) {
    if (e.status === 401) {
      ls.del('token');
      if (retry && helper() && ls.get('refresh')) return syncOnce(interactive, false); // the token ended early: get a fresh one
      return 'Google signed you out. Tap Sync to sign in again.';
    }
    if (e instanceof NothingOnDrive) return `${e.message} On your computer, open the Bookmark Vault dashboard and press "Connect Google Drive" (under Phone).`;
    if (!navigator.onLine || e instanceof TypeError) return 'offline';
    return e.message || String(e);
  }
}

let soonTimer;
function syncSoon() {
  clearTimeout(soonTimer);
  if (signedIn() && navigator.onLine) soonTimer = setTimeout(() => sync(), 1500);
}
addEventListener('online', () => { if (state.error === 'offline') state.error = null; renderStatus(); if (dirty()) syncSoon(); });
addEventListener('offline', () => renderStatus());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.base && signedIn() && Date.now() - state.syncedAt > 5 * 60_000) sync();
});

// ---------------- your changes ----------------
// The bookmark stays where it is until you leave the screen, so a mis-tap
// can be seen and undone; the bar at the bottom offers Undo.
function edit(id, changes, message) {
  const cur = state.tweets.find((t) => t.id === id);
  if (!cur) return;
  const before = changes.map(([f]) => [f, valueOf(cur, f)]);
  const t = { ...cur, changed: { ...(cur.changed || {}) } }; // never change the computer's copy itself
  for (const [field, value] of changes) if (setField(t, field, value)) recordEdit(state.pending, t, field);
  store.set({ pending: state.pending });
  state.tweets = state.tweets.map((x) => (x.id === id ? t : x));
  const el = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  if (el) el.replaceWith(card(t));
  renderStatus();
  if (message) toast(message, () => edit(id, before));
  syncSoon();
}

const STATUS_DONE_MSG = { done: 'Marked Done', todo: 'Moved to To do', new: 'Marked New' };
// Acting on a bookmark whose reminder has come ends the reminder.
const withReminderDone = (t, changes) => (isDue(t) ? [...changes, ['snoozeUntil', null]] : changes);
function toggleStatus(t, s) {
  const next = statusOf(t) === s ? 'new' : s;
  edit(t.id, withReminderDone(t, [['status', next]]), STATUS_DONE_MSG[next]);
}

let toastTimer;
function toast(text, undo) {
  $('toastText').textContent = text;
  $('undo').hidden = !undo;
  $('undo').onclick = () => { hideToast(); undo(); };
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
const hideToast = () => { $('toast').hidden = true; };

// ---------------- screens ----------------
// Addresses (#new, #browse, #cat/Dev, #author/handle…) so the phone's back gesture works.
const LISTS = {
  all: { title: 'All bookmarks', icon: '☰', color: '#007aff', test: () => true, seg: true },
  later: { title: 'Reminders', icon: '⏰', color: '#ff9500', test: (t) => !!t.snoozeUntil },
  done: { title: 'Done', icon: '✓', color: '#34c759', test: (t) => statusOf(t) === 'done' },
  missing: { title: 'Missing from X', icon: '!', color: '#8e8e93', test: (t) => !!t.missingSince, seg: true },
};
const SEG = [['all', 'All'], ['new', 'New'], ['todo', 'To do'], ['done', 'Done']];
const TABS = ['new', 'todo', 'search', 'star', 'browse'];

function parseRoute(hash = location.hash) {
  const h = decodeURIComponent(hash.replace(/^#/, ''));
  if (h.startsWith('cat/')) return { tab: 'browse', view: 'cat', arg: h.slice(4), hash: h };
  if (h.startsWith('author/')) return { tab: 'browse', view: 'author', arg: h.slice(7), hash: h };
  if (h === 'authors') return { tab: 'browse', view: 'authors', hash: h };
  if (h.startsWith('list/') && LISTS[h.slice(5)]) return { tab: 'browse', view: 'list', arg: h.slice(5), hash: h };
  if (TABS.includes(h)) return { tab: h, view: h, hash: h };
  return { tab: 'new', view: 'new', hash: 'new' };
}

// Remember where you were in each screen.
const scrolls = {};
const visited = [];
function go(hash, { replace = false } = {}) {
  if (hash === state.route?.hash) return;
  if (replace) location.replace(`#${hash}`);
  else location.hash = hash;
}
function goBack(target) {
  if (visited[visited.length - 2] === target) history.back();
  else go(target, { replace: true });
}
addEventListener('hashchange', () => openRoute());

function openRoute() {
  const next = parseRoute();
  if (state.route) scrolls[state.route.hash] = scrollY;
  const changed = next.hash !== state.route?.hash;
  if (visited[visited.length - 2] === next.hash) visited.pop(); else if (changed) visited.push(next.hash);
  state.route = next;
  if (changed) { state.seg = 'all'; state.shown = PAGE; }
  render();
  scrollTo({ top: scrolls[next.hash] || 0 });
}

const parentCat = (c) => (c.includes(' / ') ? c.slice(0, c.lastIndexOf(' / ')) : null);
const leafName = (c) => c.split(' / ').pop();
const pretty = (c) => c.replaceAll(' / ', ' › ');
const inCategory = (t, c) => (t.categories || []).some((x) => x === c || x.startsWith(`${c} / `));
// The same color the dashboard gives the category (sent with the upload).
const colorOf = (c) => state.base?.colors?.[c.split(' / ')[0]] || '#8e8e93';

// Categories directly under `parent` (or the top ones), with how many bookmarks each has.
function subCategories(parent) {
  const counts = new Map();
  const prefix = parent ? `${parent} / ` : '';
  for (const t of state.tweets) {
    const seen = new Set();
    for (const c of t.categories || []) {
      if (prefix && !c.startsWith(prefix)) continue;
      const name = prefix + c.slice(prefix.length).split(' / ')[0];
      if (name && !seen.has(name)) { seen.add(name); counts.set(name, (counts.get(name) || 0) + 1); }
    }
  }
  return [...counts].sort((a, b) => leafName(a[0]).localeCompare(leafName(b[0])));
}

// People you've bookmarked, most bookmarked first.
function authors() {
  const by = new Map();
  for (const t of state.tweets) {
    const hd = t.author?.handle;
    if (!hd) continue;
    const e = by.get(hd) || { a: t.author, n: 0 };
    e.n++;
    by.set(hd, e);
  }
  return [...by.values()].sort((x, y) => y.n - x.n || (x.a.name || '').localeCompare(y.a.name || ''));
}
const authorOf = (handle) => state.tweets.find((t) => t.author?.handle === handle)?.author || { handle };

const haystack = (t) => [t.text, t.author?.name, t.author?.handle, t.quoted?.text, t.quoted?.author?.handle,
  ...(t.categories || []), ...(t.tags || []), t.note, ...(t.links || []).map((l) => l.expanded || l.url || '')].join(' ').toLowerCase();

function screen() {
  const r = state.route;
  switch (r.view) {
    case 'new': return { title: 'New', test: (t) => statusOf(t) === 'new',
      empty: ['All caught up', 'New bookmarks from X show up here.'] };
    case 'todo': return { title: 'To do', test: (t) => statusOf(t) === 'todo', sort: 'statusAt',
      empty: ['Nothing to do', 'Tap To do on a bookmark to keep it here.'] };
    case 'star': return { title: 'Important', test: (t) => !!t.star, seg: true,
      empty: ['Nothing marked Important', 'Tap ☆ on a bookmark to keep it here.'] };
    case 'search': return { title: 'Search', search: true, seg: true, test: () => true,
      empty: ['Search your bookmarks', 'Text, authors, categories, tags and notes.'] };
    case 'list': { const l = LISTS[r.arg]; return { title: l.title, test: l.test, seg: l.seg, back: 'browse', sort: r.arg === 'later' ? 'snooze' : null,
      empty: ['Nothing here yet', ''] }; }
    case 'cat': return { title: leafName(r.arg), test: (t) => inCategory(t, r.arg), seg: true, cat: r.arg,
      back: parentCat(r.arg) ? `cat/${parentCat(r.arg)}` : 'browse', backLabel: parentCat(r.arg) ? leafName(parentCat(r.arg)) : 'Browse',
      empty: ['Nothing here yet', ''] };
    case 'author': { const a = authorOf(r.arg); return { title: a.name || `@${r.arg}`, author: a, test: (t) => t.author?.handle === r.arg, seg: true,
      back: visited[visited.length - 2] === 'authors' ? 'authors' : 'browse', backLabel: visited[visited.length - 2] === 'authors' ? 'Authors' : 'Browse',
      empty: ['Nothing here yet', ''] }; }
    case 'authors': return { title: 'Authors', back: 'browse' };
    default: return { title: 'Browse' };
  }
}

function visible(sc) {
  const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  if (sc.search && !words.length) return null;
  const list = state.tweets.filter((t) => sc.test(t)
    && (!sc.seg || state.seg === 'all' || statusOf(t) === state.seg)
    && (!sc.search || words.every((w) => haystack(t).includes(w))));
  if (sc.sort === 'snooze') return list.sort((a, b) => a.snoozeUntil - b.snoozeUntil);
  if (sc.sort === 'statusAt') return list.sort((a, b) => (b.statusAt || 0) - (a.statusAt || 0));
  return list.sort((a, b) => String(b.sortKey || '').localeCompare(String(a.sortKey || '')));
}

// ---------------- showing ----------------
function rebuild() {
  state.tweets = overlay(state.base?.tweets || [], state.pending);
  if (state.route) render();
}

// Small element helper, like the dashboard's: h('div', { class: 'x' }, child, …)
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k);
  return e;
}
const svg = (cls, viewBox, inner) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = inner;
  return s;
};
const chevron = () => svg('chev', '0 0 8 14', '<path d="m1 1 6 6-6 6"/>');
const starIcon = (on) => svg(`star${on ? ' on' : ''}`, '0 0 24 24', '<path d="m12 3.2 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>');

// Profile picture, or the first letter when there's none (or it can't load offline).
function avatar(a = {}, cls = 'avatar') {
  const letter = () => {
    const d = h('div', { class: `${cls} letter`, 'aria-hidden': 'true' }, (a.name || a.handle || '?').trim()[0]?.toUpperCase() || '?');
    let n = 0;
    for (const c of a.handle || '') n = (n * 31 + c.charCodeAt(0)) % 360;
    d.style.background = `hsl(${n} 45% 52%)`;
    return d;
  };
  if (!a.avatar) return letter();
  const img = h('img', { class: cls, src: a.avatar, alt: '', loading: 'lazy' });
  img.onerror = () => img.replaceWith(letter());
  return img;
}

function render() {
  const r = state.route;
  const sc = screen();
  for (const b of document.querySelectorAll('.tab')) {
    if (b.dataset.tab === r.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  $('back').hidden = !sc.back;
  $('backLabel').textContent = sc.backLabel || 'Browse';
  renderControls(sc);
  $('list').classList.toggle('browse', r.view === 'browse' || r.view === 'authors');
  if (r.view === 'browse') { renderBrowse(); setTitle('Browse'); return; }
  if (r.view === 'authors') { renderAuthors(); setTitle('Authors', authors().length); return; }

  const list = visible(sc);
  setTitle(sc.title, list ? list.length : null, sc.author);
  if (!list || !list.length) {
    const filtered = (sc.search && state.q.trim()) || (sc.seg && state.seg !== 'all');
    const [big, small] = list && filtered ? ['Nothing matches', ''] : sc.empty;
    $('list').replaceChildren(h('div', { class: 'empty' }, h('b', {}, big), h('span', {}, small)));
    $('more').hidden = true;
    return;
  }
  $('list').replaceChildren(...list.slice(0, state.shown).map(card));
  $('more').hidden = list.length <= state.shown;
  $('more').textContent = `Show more (${(list.length - state.shown).toLocaleString()} left)`;
}

function setTitle(text, n, author) {
  $('title').replaceChildren(...[author && avatar(author, 'avatar t-avatar'), h('span', { class: 'tt' }, text), n != null && h('span', { class: 'count' }, n.toLocaleString())].filter(Boolean));
}

// Under the title: the search box, the All / New / To do / Done switch, and sub-categories.
function renderControls(sc) {
  const kids = [];
  if (sc.search) {
    let q = $('q');
    if (!q) {
      q = h('input', { id: 'q', class: 'search', type: 'search', placeholder: 'Search bookmarks', autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Search bookmarks' });
      q.oninput = () => { state.q = q.value; state.shown = PAGE; render(); };
    }
    q.value = state.q;
    kids.push(q);
  }
  if (sc.seg) {
    kids.push(h('div', { class: 'status-seg', role: 'group', 'aria-label': 'Reading status' },
      SEG.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(state.seg === k), onclick: () => { state.seg = k; state.shown = PAGE; render(); } }, label))));
  }
  if (sc.cat) {
    // Sub-categories of this one; on a sub-category, its siblings.
    const own = subCategories(sc.cat);
    const parent = own.length ? sc.cat : parentCat(sc.cat);
    const subs = own.length ? own : parent ? subCategories(parent) : [];
    if (subs.length) {
      const chip = (label, target) => h('button', { class: 'chip', type: 'button', style: `--c:${colorOf(target)}`, 'aria-pressed': String(sc.cat === target),
        onclick: () => go(`cat/${target}`, { replace: true }) }, label);
      const chips = h('div', { class: 'chips subcats', 'aria-label': 'Sub-categories' },
        chip(`All ${leafName(parent)}`, parent), subs.map(([c]) => chip(leafName(c), c)));
      kids.push(chips);
      requestAnimationFrame(() => chips.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' }));
    }
  }
  const box = $('controls');
  // Keep the search box itself (not a copy) so typing isn't interrupted.
  if (box.children.length !== kids.length || [...box.children].some((c, i) => c !== kids[i])) box.replaceChildren(...kids);
}

const row = ({ icon, color, img, label, sub, n, onclick, cls = '', data }) => h('button', { class: `row ${cls}`, type: 'button', onclick, ...data },
  icon && h('span', { class: 'ic', style: `background:${color}` }, icon),
  img,
  h('span', { class: 'label' }, label, sub && h('small', {}, sub)),
  n != null && h('span', { class: 'n' }, n.toLocaleString()),
  !cls && chevron());
const group = (title, rows, plain) => [h('div', { class: 'group-title' }, title), h('div', { class: `rows${plain ? ' plain' : ''}` }, rows)];
const authorRow = ({ a, n }) => row({ img: avatar(a), label: a.name || `@${a.handle}`, sub: a.name ? `@${a.handle}` : '', n,
  onclick: () => go(`author/${a.handle}`), data: { 'data-author': a.handle } });

function renderBrowse() {
  const count = (test) => state.tweets.filter(test).length;
  const lists = Object.entries(LISTS)
    .map(([k, l]) => ({ k, l, n: count(l.test) }))
    .filter(({ k, n }) => k !== 'missing' || n)
    .map(({ k, l, n }) => row({ icon: l.icon, color: l.color, label: l.title, n, onclick: () => go(`list/${k}`) }));
  const cats = subCategories(null).map(([c, n]) => row({ img: h('span', { class: 'swatch', style: `background:${colorOf(c)}` }), label: pretty(c), n,
    onclick: () => go(`cat/${c}`), data: { 'data-cat': c } }));
  const people = authors();
  const top = people.slice(0, 8).map(authorRow);
  if (people.length > 8) top.push(row({ label: `All authors (${people.length.toLocaleString()})`, cls: 'link', onclick: () => go('authors') }));
  const n = Object.keys(state.pending).length;
  $('list').replaceChildren(
    ...browseInstall(),
    ...group('Lists', lists),
    ...(cats.length ? group('Categories', cats) : []),
    ...(top.length ? group('Top authors', top) : []),
    ...group('Google Drive', [
      row({ label: 'Sync now', cls: 'link', onclick: () => sync({ interactive: true }) }),
      row({ label: 'Sign out of Google', cls: 'link', onclick: signOut }),
      row({ label: 'Remove from this phone', cls: 'danger', onclick: reset }),
    ], true),
    h('p', { class: 'note-line' }, `${state.base.tweets.length.toLocaleString()} bookmarks on this phone, from your computer ${ago(state.base.exportedAt)}. Last synced ${state.syncedAt ? ago(state.syncedAt) : 'never'}.${n ? ` ${n} change${n === 1 ? '' : 's'} not yet on your computer.` : ''}`),
  );
  $('more').hidden = true;
}

// A reminder to add the app to the home screen, until it's there or you close it.
function browseInstall() {
  if (isInstalled() || device().os === 'desktop' || ls.get('installHidden')) return [];
  const close = h('button', { class: 'install-close', type: 'button', 'aria-label': 'Hide', onclick: () => { ls.set('installHidden', '1'); wrap.remove(); } }, '×');
  const wrap = h('div', { class: 'browse-install' }, installBox({ compact: true }), close);
  return [wrap];
}

function renderAuthors() {
  $('list').replaceChildren(h('div', { class: 'rows' }, authors().map(authorRow)));
  $('more').hidden = true;
}

// ---------------- the bookmark card (same parts as the dashboard's) ----------------
const fmtNum = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const reminderDate = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const ext = { target: '_blank', rel: 'noopener noreferrer' };

// Links, @mentions and #hashtags in the text open on X.
function richText(str) {
  const out = [];
  const re = /(https?:\/\/[^\s]+)|(@\w{1,15})|(#[\p{L}\p{N}_]+)/gu;
  let last = 0;
  for (const m of str.matchAll(re)) {
    if (m.index > last) out.push(str.slice(last, m.index));
    const [tok] = m;
    let href; let label = tok;
    if (m[1]) { href = tok; label = tok.replace(/^https?:\/\/(www\.)?/, ''); if (label.length > 40) label = label.slice(0, 38) + '…'; }
    else if (m[2]) href = `https://x.com/${tok.slice(1)}`;
    else href = `https://x.com/hashtag/${encodeURIComponent(tok.slice(1))}`;
    out.push(h('a', { href, ...ext }, label));
    last = m.index + tok.length;
  }
  out.push(str.slice(last));
  return out;
}

function textBlock(str, clampable = true) {
  if (!str) return null;
  const p = h('p', { class: 'text' }, richText(str));
  if (!clampable || str.length < 300) return p;
  p.classList.add('clamped');
  const btn = h('button', { class: 'more', type: 'button', onclick: () => { p.classList.remove('clamped'); btn.remove(); } }, 'Show more');
  return [p, btn];
}

function mediaBlock(t, tweetUrl) {
  const items = (t.media || []).slice(0, 4);
  if (!items.length) return null;
  return h('div', { class: `media n${items.length}` }, items.map((m) => {
    const fail = (e) => { e.target.closest('.m')?.remove(); }; // offline, or the post is gone
    if (m.type === 'photo') {
      const img = h('img', { src: `${m.url}?name=small`, alt: m.alt || '', loading: 'lazy' });
      img.onerror = fail;
      return h('div', { class: 'm' }, h('a', { href: `${m.url}?name=orig`, ...ext }, img));
    }
    const gif = m.type === 'animated_gif';
    if (m.video) {
      const v = h('video', { src: m.video, poster: m.url, preload: 'none', playsinline: true, controls: !gif, loop: gif, muted: gif });
      if (gif) v.onclick = () => (v.paused ? v.play().catch(() => {}) : v.pause());
      return h('div', { class: 'm' }, v, h('span', { class: 'badge' }, gif ? 'GIF' : 'VIDEO'));
    }
    const img = h('img', { src: m.url, alt: '', loading: 'lazy' });
    img.onerror = fail;
    return h('div', { class: 'm' }, h('a', { href: tweetUrl, ...ext }, img), h('span', { class: 'badge' }, gif ? 'GIF' : 'VIDEO'));
  }));
}

function linkCard(t) {
  const c = t.card;
  if (!c) return null;
  return h('a', { class: 'linkcard', href: c.url || t.links?.[0]?.url || t.url, ...ext },
    c.image && h('img', { src: c.image, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }),
    h('div', { class: 'lc' },
      c.domain && h('div', { class: 'lc-d' }, c.domain),
      c.title && h('div', { class: 'lc-t' }, c.title),
      c.description && h('div', { class: 'lc-x' }, c.description)));
}

function quoteBlock(q) {
  if (!q) return null;
  return h('div', { class: 'quote' },
    h('div', { class: 'qh' },
      q.author?.avatar && h('img', { src: q.author.avatar, alt: '', onerror: (e) => e.target.remove() }),
      h('strong', {}, q.author?.name || ''),
      h('span', { class: 'muted' }, q.author?.handle ? `@${q.author.handle}` : '')),
    textBlock(q.text, false),
    mediaBlock(q, q.url));
}

function card(t) {
  const a = t.author || {};
  const s = statusOf(t);
  const head = h('div', { class: 'card-head' },
    avatar(a),
    h('div', { class: 'who' },
      h('button', { type: 'button', onclick: () => a.handle && go(`author/${a.handle}`) },
        h('span', { class: 'name' }, a.name || 'Unknown'),
        h('span', { class: 'handle' }, a.handle ? `@${a.handle}` : ''))),
    t.missingSince && h('span', { class: 'missing-badge' }, 'Missing'),
    t.snoozeUntil && h('span', { class: `reminder-badge${isDue(t) ? ' due' : ''}` }, `⏰ ${isDue(t) ? 'Today' : reminderDate(t.snoozeUntil).replace(/^\w+,? /, '')}`),
    h('a', { class: 'date', href: t.url || `https://x.com/i/web/status/${t.id}`, ...ext }, fmtDate(t.createdAt)));

  const chips = (t.categories || []).length || (t.tags || []).length
    ? h('div', { class: 'chips' },
      (t.categories || []).map((c) => h('button', { class: 'chip', type: 'button', style: `--c:${colorOf(c)}`, onclick: () => go(`cat/${c}`) },
        h('span', { class: 'swatch', style: `background:${colorOf(c)}` }), leafName(c))),
      (t.tags || []).map((tag) => h('span', { class: 'chip tag' }, `#${tag}`)))
    : null;

  const st = t.stats || {};
  const foot = h('div', { class: 'card-foot' },
    h('div', { class: 'stats' },
      st.likes != null && h('span', { title: 'Likes' }, `♥ ${fmtNum.format(st.likes)}`),
      st.retweets != null && h('span', { title: 'Reposts' }, `⟲ ${fmtNum.format(st.retweets)}`),
      st.views != null && h('span', { title: 'Views' }, `◉ ${fmtNum.format(st.views)}`)),
    h('div', { class: 'acts' },
      h('button', { class: 'star-btn', type: 'button', 'aria-label': 'Important', title: 'Important', 'aria-pressed': String(!!t.star),
        onclick: () => edit(t.id, [['star', !t.star]], t.star ? 'Removed from Important' : 'Marked Important') }, starIcon(t.star)),
      h('span', { class: 'seg' },
        ['todo', 'done'].map((k) => h('button', { type: 'button', 'aria-pressed': String(s === k), onclick: () => toggleStatus(t, k) },
          k === 'done' ? (s === 'done' ? '✓ Done' : 'Done') : 'To do'))),
      laterSelect(t),
      h('a', { class: 'open-x', href: t.url || `https://x.com/i/web/status/${t.id}`, ...ext }, 'Open ↗')));

  return h('article', { class: `card item is-${s}`, 'data-id': t.id },
    head,
    textBlock(t.text), mediaBlock(t, t.url), linkCard(t), quoteBlock(t.quoted),
    t.note && h('div', { class: 'note' }, t.note),
    chips,
    foot);
}

function laterSelect(t) {
  const sel = h('select', { class: 'later-select', 'aria-label': 'Remind me later' },
    h('option', { value: '' }, t.snoozeUntil ? '⏰ Later' : 'Later'),
    snoozeChoices().map(([label, at]) => h('option', { value: String(at) }, label)),
    t.snoozeUntil && h('option', { value: 'clear' }, 'Cancel reminder'));
  sel.onchange = () => {
    const v = sel.value;
    if (!v) return;
    if (v === 'clear') edit(t.id, [['snoozeUntil', null]], 'Reminder cancelled');
    else edit(t.id, [['snoozeUntil', Number(v)]], `Reminder set for ${reminderDate(Number(v))}`);
  };
  return sel;
}

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function renderStatus() {
  const box = state.base ? $('status') : $('setupStatus');
  let text = '';
  let level = '';
  const n = pendingCount();
  const changes = `${n} change${n === 1 ? '' : 's'}`;
  if (state.syncing) text = 'Syncing…';
  else if (state.error === 'offline' || !navigator.onLine) { text = `Offline${dirty() ? ` · ${changes} saved on this phone, will sync later` : ''}`; level = 'warn'; }
  else if (state.error) { text = state.error; level = 'error'; }
  else if (state.base) {
    const parts = [`From your computer ${ago(state.base.exportedAt)}`];
    if (dirty()) parts.push(signedIn() ? `${changes} to send` : `${changes} on this phone · tap Sync to send`);
    else if (n) parts.push(`${changes} sent, your computer adds them when it next syncs`);
    text = parts.join(' · ');
    if (dirty() && !signedIn()) level = 'warn';
  }
  box.textContent = text;
  box.className = `status ${level}`;
  $('sync').disabled = state.syncing;
  $('connect').disabled = state.syncing;
}

function show() {
  const ready = !!state.base;
  $('setup').hidden = ready;
  $('app').hidden = !ready;
  $('clientId').hidden = !!GOOGLE_CLIENT_ID;
  googleButton();
  if (!ready) showInstallStep();
  renderStatus();
}

// With the Google app built in, connecting is just Google's sign-in.
const G_LOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
function googleButton() {
  if (!GOOGLE_CLIENT_ID || $('connect').classList.contains('google-btn')) return;
  $('connect').className = 'google-btn';
  $('connect').innerHTML = `${G_LOGO}<span>Sign in with Google</span>`;
  $('connectTitle').textContent = 'Sign in with Google';
  $('connectNote').hidden = false;
}

// On a phone that hasn't added the app yet, the first screen has two steps:
// 1. add it to the home screen, 2. connect. On iPhone the order matters (the
// home-screen app doesn't share Safari's storage), so step 2 says so.
let installShown = false;
function showInstallStep() {
  const d = device();
  const need = d.os !== 'desktop' && !isInstalled();
  $('installStep').hidden = !need;
  $('connectHead').hidden = !need;
  $('connectStep').classList.toggle('step', need);
  $('connectStep').classList.toggle('later', need && d.os === 'ios');
  if (need && !installShown) { $('installSlot').replaceChildren(installBox()); installShown = true; }
}
onInstallChange(() => { if (!state.base) showInstallStep(); else if (state.route.view === 'browse') render(); });

// ---------------- controls ----------------
$('clientId').value = ls.get('clientId') || '';
$('connect').onclick = () => {
  const id = $('clientId').value.trim();
  if (!GOOGLE_CLIENT_ID) {
    if (!id) { $('clientId').focus(); state.error = 'Paste the Google client ID first.'; renderStatus(); return; }
    ls.set('clientId', id);
  }
  sync({ interactive: true });
};
$('sync').onclick = () => sync({ interactive: true });
$('more').onclick = () => { state.shown += PAGE; render(); };
$('back').onclick = () => { const sc = screen(); if (sc.back) goBack(sc.back); };
for (const b of document.querySelectorAll('.tab')) {
  b.onclick = () => {
    const tab = b.dataset.tab;
    if (state.route.tab === tab) {
      // Tapping the open tab again: back to its first screen, at the top.
      if (state.route.view !== tab) go(tab, { replace: true });
      scrolls[tab] = 0;
      scrollTo({ top: 0, behavior: 'smooth' });
    } else go(tab);
    if (tab === 'search') setTimeout(() => $('q')?.focus(), 0);
  };
}

const forgetSignIn = () => ['token', 'refresh', 'signedIn'].forEach(ls.del);
function signOut() {
  const t = savedToken();
  const rt = ls.get('refresh');
  forgetSignIn();
  // Tell Google too, so the keys stop working everywhere.
  if (rt && helper()) askHelper('revoke', { token: rt }).catch(() => {});
  else if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t, () => {});
  renderStatus();
  toast('Signed out of Google. Your bookmarks stay on this phone.');
}
async function reset() {
  if (!confirm(dirty() ? 'Some changes haven\'t reached your computer yet. Remove everything from this phone anyway?' : 'Remove your bookmarks from this phone? They stay on your computer and in Drive.')) return;
  await store.clear();
  forgetSignIn();
  Object.assign(state, { base: null, pending: {}, files: {}, sent: null, syncedAt: 0, tweets: [], error: null });
  show();
}

// ---------------- start ----------------
async function start() {
  const [base, pending, files, sent, syncedAt] = await Promise.all(['base', 'pending', 'files', 'sent', 'syncedAt'].map(store.get));
  Object.assign(state, { base, pending: pending || {}, files: files || {}, sent, syncedAt: syncedAt || 0 });
  state.tweets = overlay(base?.tweets || [], state.pending);
  openRoute();
  show();
  if (signedIn()) sync();
}
window.bvStarted = true;
start().catch((e) => { state.error = `Couldn't open the saved copy: ${e.message || e}`; show(); });

// Keeps the page working offline (see sw.js).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

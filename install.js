// Helping people add the page to their home screen, so it opens like an app.
//
// - Android (Chrome, Edge, Samsung Internet): the browser offers a real
//   install. We catch its offer and show our own "Install app" button.
// - iPhone and iPad: there's no install button a page can show, so we
//   explain the two taps (Share, then Add to Home Screen) with the same
//   icons Safari uses. Install first: on iPhone the home-screen app keeps
//   its own copy of everything, separate from Safari.
// - Opened inside another app (X, Gmail…): those built-in browsers can't
//   install, so we say how to open it in the real browser.

// Android's install offer, saved until you tap our button. index.html
// catches one that arrives before this file has loaded.
let offer = window.bvInstallOffer || null;
const listeners = new Set();
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // keep the browser's own mini-bar from popping up at a random moment
  offer = e;
  listeners.forEach((fn) => fn());
});
let justInstalled = false;
addEventListener('appinstalled', () => {
  offer = null;
  justInstalled = true;
  try { localStorage.setItem('installed', '1'); } catch {}
  listeners.forEach((fn) => fn());
});
export const onInstallChange = (fn) => listeners.add(fn);

// Running from the home screen (not a browser tab)?
export const isInstalled = () =>
  matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;

// 'ios' | 'android' | 'desktop', and which browser it is.
export function device(ua = navigator.userAgent, touch = navigator.maxTouchPoints || 0) {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1); // iPads say "Macintosh"
  const android = /Android/.test(ua);
  const inApp = /FBAN|FBAV|Instagram|Line\/|Twitter|GSA\/|; wv\)/.test(ua);
  const browser = ios
    ? (/CriOS/.test(ua) ? 'chrome' : /FxiOS/.test(ua) ? 'firefox' : /EdgiOS/.test(ua) ? 'edge' : 'safari')
    : /SamsungBrowser/.test(ua) ? 'samsung' : /Firefox/.test(ua) ? 'firefox' : /EdgA/.test(ua) ? 'edge' : 'chrome';
  return { os: ios ? 'ios' : android ? 'android' : 'desktop', browser, inApp };
}

export const canInstallNow = () => !!offer;

// Show Android's install window. Resolves true if you said yes.
export async function installNow() {
  if (!offer) return false;
  const e = offer;
  offer = null;
  await e.prompt();
  const choice = await e.userChoice.catch(() => ({ outcome: 'dismissed' }));
  listeners.forEach((fn) => fn());
  return choice.outcome === 'accepted';
}

// Icons as the phone shows them, so the steps can be matched by eye.
const ICONS = {
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4 4 4"/><path d="M7 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1"/></svg>',
  add: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
  dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18.5" r="1.4"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/></svg>',
};

// The steps for this phone: [{ icon, html }], or null when nothing is needed.
export function steps(d = device()) {
  if (d.os === 'ios') {
    if (d.inApp) return [{ icon: 'share', html: 'This is another app\'s built-in browser, which can\'t add apps. Tap <b>Share</b> or <b>⋯</b> and choose <b>Open in Safari</b>, then follow the steps there.' }];
    const where = d.browser === 'safari' ? 'at the bottom of Safari (at the top on iPad)' : 'in the address bar';
    return [
      { icon: 'share', html: `Tap <b>Share</b> ${where}.` },
      { icon: 'add', html: 'Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.' },
      { icon: 'home', html: 'Open <b>Bookmarks</b> from your home screen and connect there.' },
    ];
  }
  if (d.os === 'android') {
    if (d.inApp) return [{ icon: 'dots', html: 'This is another app\'s built-in browser, which can\'t install apps. Tap <b>⋮</b> and choose <b>Open in Chrome</b>.' }];
    return [
      { icon: 'dots', html: `Tap <b>⋮</b> ${d.browser === 'samsung' ? 'or ☰ at the bottom' : 'at the top right'}.` },
      { icon: 'add', html: 'Tap <b>Install app</b> or <b>Add to Home screen</b>, then <b>Install</b>.' },
      { icon: 'home', html: 'Open <b>Bookmarks</b> from your home screen.' },
    ];
  }
  return null;
}

// The install box: Android's button when the browser offers one, otherwise
// the steps. compact: leave out the longer notes.
export function installBox({ compact = false } = {}) {
  const d = device();
  const box = document.createElement('div');
  box.className = 'install';
  const draw = () => {
    if (box.dataset.drawn && !box.isConnected) { listeners.delete(draw); return; } // gone from the page
    box.dataset.drawn = '1';
    box.replaceChildren();
    const title = document.createElement('div');
    title.className = 'install-title';
    if (isInstalled()) { box.hidden = true; return; }
    box.hidden = false;
    if (d.os === 'desktop') {
      title.textContent = 'Open this page on your phone';
      const p = document.createElement('p');
      p.className = 'install-note';
      p.textContent = `Scan the QR code in the Bookmark Vault dashboard (under Phone), or type ${location.host}${location.pathname} into your phone's browser.`;
      box.append(title, p);
      return;
    }
    if (justInstalled) {
      title.textContent = 'Added to your home screen';
      const p = document.createElement('p');
      p.className = 'install-note';
      p.textContent = 'Open Bookmarks from your home screen, or carry on here.';
      box.classList.add('done');
      box.append(title, p);
      return;
    }
    title.textContent = 'Add Bookmarks to your home screen';
    box.append(title);
    if (canInstallNow() && d.os === 'android') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'primary install-btn';
      b.textContent = 'Install app';
      b.onclick = () => installNow();
      const p = document.createElement('p');
      p.className = 'install-note';
      p.textContent = 'It opens full screen, works offline and gets its own icon. Nothing to download from a store.';
      box.append(b, p);
      return;
    }
    const ol = document.createElement('ol');
    ol.className = 'install-steps';
    for (const s of steps(d)) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="install-ic">${ICONS[s.icon]}</span><span>${s.html}</span>`;
      ol.append(li);
    }
    box.append(ol);
    if (d.os === 'ios' && !compact) {
      const p = document.createElement('p');
      p.className = 'install-note';
      p.textContent = 'Install first, then connect inside the app: on iPhone the home-screen app keeps its own copy, separate from Safari.';
      box.append(p);
    }
  };
  draw();
  onInstallChange(draw);
  return box;
}

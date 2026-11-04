// Shows that a button is working: it's disabled, gets a spinner and a label
// like "Signing in…", and goes back to how it was when you call the
// returned function (or set a new label with step('Uploading…')).
//   const done = busy(btn, 'Signing in…');
//   try { … done.step('Uploading…'); … } finally { done(); }
export function busy(btn, label) {
  if (!btn) { const noop = () => {}; noop.step = noop; return noop; }
  const before = [...btn.childNodes];
  const wasDisabled = btn.disabled;
  const show = (text) => {
    const s = document.createElement('span');
    s.className = 'spinner';
    s.setAttribute('aria-hidden', 'true');
    btn.replaceChildren(s, text);
  };
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  show(label);
  const done = () => {
    if (!btn.isConnected && !btn.hasAttribute('aria-busy')) return;
    btn.removeAttribute('aria-busy');
    btn.disabled = wasDisabled;
    btn.replaceChildren(...before);
  };
  done.step = (text) => { if (btn.hasAttribute('aria-busy')) show(text); };
  return done;
}

// A spinner element, for status lines.
export function spinner() {
  const s = document.createElement('span');
  s.className = 'spinner';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

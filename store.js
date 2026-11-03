// Saved on the phone (IndexedDB), so the page works offline:
//   base    — the computer's last upload { tweets, exportedAt, modifiedTime }
//   pending — your changes not yet confirmed by the computer
//   files   — Drive file IDs
//   sent    — what was last written to phone-edits.json
//   syncedAt
const DB = 'bookmark-vault-phone';
let opened;

function open() {
  return (opened ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

export async function get(key) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const g = d.transaction('kv').objectStore('kv').get(key);
    g.onsuccess = () => resolve(g.result ?? null);
    g.onerror = () => reject(g.error);
  });
}

export async function set(values) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    for (const [k, v] of Object.entries(values)) tx.objectStore('kv').put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clear() {
  const d = await open();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

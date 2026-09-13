// Persisted extension settings, shared by the popup and the background worker.
// Content scripts run in an isolated world without ES module import support,
// so they use the small duplicate in content/state-bridge.js with the same
// storage keys and defaults instead of importing this file.

export const DEFAULT_STATE = {
  enabled: false,
  darkMode: false,
  features: {
    quickbar: true,
    notif: true,
    autorefresh: false,
    gradeBadge: true,
    keyboardNav: false,
  },
};

export async function getState() {
  const stored = await chrome.storage.sync.get(DEFAULT_STATE);
  return {
    ...DEFAULT_STATE,
    ...stored,
    features: { ...DEFAULT_STATE.features, ...(stored.features || {}) },
  };
}

export async function setState(partial) {
  const current = await getState();
  const next = {
    ...current,
    ...partial,
    features: { ...current.features, ...(partial.features || {}) },
  };
  await chrome.storage.sync.set(next);
  return next;
}

export function onStateChange(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    callback(changes);
  });
}

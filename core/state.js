// Persisted extension settings, shared by the popup and the background worker.
// Content scripts run in an isolated world without ES module import support,
// so they use the small duplicate in core/state-bridge.js with the same
// storage keys and defaults instead of importing this file.

export const DEFAULT_STATE = {
  enabled: false,
  irkEnabled: false,
  pluginEnabled: true,
  darkMode: false,
  myUniversity: null,
  features: {
    quickbar: true,
    autorefresh: false,
    gradeBadge: true,
    keyboardNav: false,
    classicWidgets: true,
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

// `partial` may be a plain object or an updater `(current) => partialObject`,
// mirroring core/state-bridge.js's setState.
export async function setState(partial) {
  const current = await getState();
  const resolved = typeof partial === 'function' ? partial(current) : partial;
  const next = {
    ...current,
    ...resolved,
    features: { ...current.features, ...(resolved.features || {}) },
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

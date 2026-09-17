// Storage helper for the content-script world. Content scripts run isolated
// from ES module imports, so this mirrors core/state.js's keys/defaults
// rather than importing it. Keep the two in sync if the shape changes.
(function () {
  const DEFAULT_STATE = {
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

  async function getState() {
    const stored = await chrome.storage.sync.get(DEFAULT_STATE);
    return {
      ...DEFAULT_STATE,
      ...stored,
      features: { ...DEFAULT_STATE.features, ...(stored.features || {}) },
    };
  }

  // `partial` may be a plain object or an updater `(current) => partialObject`
  // — inject.js's toggleFeature handler needs the updater form to flip a
  // flag off the freshly-read state instead of a stale closed-over value.
  async function setState(partial) {
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

  function onStateChange(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      callback(changes);
    });
  }

  window.USOSPP_STATE = { DEFAULT_STATE, getState, setState, onStateChange };
})();

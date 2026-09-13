// Storage helper for the content-script world. Content scripts run isolated
// from ES module imports, so this mirrors shared/state.js's keys/defaults
// rather than importing it. Keep the two in sync if the shape changes.
(function () {
  const DEFAULT_STATE = {
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

  async function getState() {
    const stored = await chrome.storage.sync.get(DEFAULT_STATE);
    return {
      ...DEFAULT_STATE,
      ...stored,
      features: { ...DEFAULT_STATE.features, ...(stored.features || {}) },
    };
  }

  async function setState(partial) {
    const current = await getState();
    const next = {
      ...current,
      ...partial,
      features: { ...current.features, ...(partial.features || {}) },
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

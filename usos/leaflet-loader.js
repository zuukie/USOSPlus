// Lazy Leaflet loader — the map is rarely opened, so leaflet.js/css are NOT
// in the static content_scripts list. Call ensureLeaflet() before any
// window.L usage; resolves immediately when already loaded.
//
// The injection itself goes through the background service worker
// (chrome.scripting, ISOLATED world = the same realm this content script
// and usos/app.js run in). A plain page-DOM <script
// src="chrome-extension://…"> would land Leaflet in the page's own JS
// world, where content scripts can't see it — plus it would need a
// web_accessible_resources entry and the page's CSP to allow it. This
// path needs neither.
(function () {
  let leafletPromise = null;

  function ensureLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletPromise) return leafletPromise;
    leafletPromise = (async () => {
      const res = await chrome.runtime.sendMessage({ type: 'usospp:ensureLeaflet' });
      if (!res || !res.ok) {
        throw new Error((res && res.error) || 'leaflet load failed');
      }
      if (!window.L) throw new Error('leaflet unavailable');
    })().catch((e) => {
      leafletPromise = null; // allow retry on next map open
      throw e;
    });
    return leafletPromise;
  }

  window.USOSPP_LEAFLET = { ensureLeaflet };
})();

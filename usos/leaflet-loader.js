// Lazy Leaflet loader — map is rarely opened, so leaflet.js/css are NOT in
// the static content_scripts list anymore. Call ensureLeaflet() before any
// window.L usage; resolves immediately when already loaded (e.g. older
// dynamic registrations that still inject it statically).
(function () {
  let leafletPromise = null;

  function injectCss(href) {
    return new Promise((resolve) => {
      if (document.querySelector(`link[data-usospp-leaflet-css]`)) { resolve(); return; }
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.usosppLeafletCss = '1';
      link.onload = () => resolve();
      link.onerror = () => resolve(); // map still works unstyled rather than never
      document.head.appendChild(link);
    });
  }

  function injectJs(src) {
    return new Promise((resolve, reject) => {
      if (window.L) { resolve(); return; }
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('leaflet load failed'));
      document.head.appendChild(script);
    });
  }

  function ensureLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletPromise) return leafletPromise;
    leafletPromise = (async () => {
      const cssUrl = chrome.runtime.getURL('vendor/leaflet/leaflet.css');
      const jsUrl = chrome.runtime.getURL('vendor/leaflet/leaflet.js');
      await injectCss(cssUrl);
      await injectJs(jsUrl);
      if (!window.L) throw new Error('leaflet unavailable');
    })().catch((e) => {
      leafletPromise = null; // allow retry on next map open
      throw e;
    });
    return leafletPromise;
  }

  window.USOSPP_LEAFLET = { ensureLeaflet };
})();

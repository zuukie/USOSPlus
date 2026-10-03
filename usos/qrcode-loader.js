// Lazy QR-code generator loader — only the mLegitymacja "Do odbioru"
// view needs it, so vendor/qrcode is NOT in the static content_scripts
// list. Call ensureQrCode() before any window.qrcode usage; resolves
// immediately when already loaded.
//
// Same injection path as usos/leaflet-loader.js: through the background
// service worker (chrome.scripting, ISOLATED world = the same realm this
// content script and usos/app.js run in).
(function () {
  let qrPromise = null;

  function ensureQrCode() {
    if (window.qrcode) return Promise.resolve();
    if (qrPromise) return qrPromise;
    qrPromise = (async () => {
      const res = await chrome.runtime.sendMessage({ type: 'usospp:ensureQrCode' });
      if (!res || !res.ok) {
        throw new Error((res && res.error) || 'qrcode load failed');
      }
      if (!window.qrcode) throw new Error('qrcode unavailable');
    })().catch((e) => {
      qrPromise = null; // allow retry on next pickup-view open
      throw e;
    });
    return qrPromise;
  }

  window.USOSPP_QRCODE = { ensureQrCode };
})();

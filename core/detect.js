// Shared platform-detection registry. Deliberately knows nothing about
// USOSweb or IRK selectors itself (that logic stays in usos/ and irk/,
// see ARCHITECTURE.md) — each module registers its own matcher, and
// detectPlatform() just asks each one in turn. This keeps core free of
// USOS/IRK-specific knowledge while still giving every part of the
// extension (content scripts, popup, background) one shared answer to
// "what kind of page is this: usosweb / irk / unknown".
(function () {
  const detectors = [];

  function registerDetector(platform, matches) {
    detectors.push({ platform, matches });
  }

  function detectPlatform(doc = document) {
    for (const { platform, matches } of detectors) {
      try {
        if (matches(doc)) return platform;
      } catch (e) {
        // A broken/incompatible detector shouldn't block the others.
      }
    }
    return 'unknown';
  }

  window.USOSPP_CORE = { registerDetector, detectPlatform };
})();

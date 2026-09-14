// IRK (Internetowa Rekrutacja Kandydatów) detection.
//
// Verified live (2026-09-14) against https://irk.usos.pwr.edu.pl — the
// system's own name appears in three independent spots, inflected
// differently in each: <title>"Internetowa Rekrutacja Kandydatów PWr"</title>,
// the header ("System Internetowej Rekrutacji Kandydatów") and the footer's
// #footer section ("Internetowa Rekrutacja Kandydatów"). The regex below
// matches the shared "Internetow(a|ej) Rekrutacj(a|i) Kandydat(ów)" stem
// across those inflections rather than one exact phrase. Only this one
// installation has been checked — other universities' IRK likely share the
// same MUCI-built template (same footer credits "Międzyuniwersyteckie
// Centrum Informatyzacji" as USOSweb's own footer), but that's not
// confirmed, so treat this the same as adapters.js's "UNVERIFIED" sections:
// a false negative (module stays inactive) is the safe failure mode here,
// not a false positive.
(function () {
  const NAME_RE = /Internetow\w*\s+Rekrutacj\w*\s+Kandydat/i;

  function looksLikeIrk(doc = document) {
    const title = doc.title || '';
    if (NAME_RE.test(title)) return true;
    const footer = doc.querySelector('#footer, footer');
    if (footer && NAME_RE.test(footer.textContent || '')) return true;
    const header = doc.querySelector('header');
    if (header && NAME_RE.test(header.textContent || '')) return true;
    return false;
  }

  window.USOSPP_IRK_DETECT = { looksLikeIrk };
  if (window.USOSPP_CORE) window.USOSPP_CORE.registerDetector('irk', looksLikeIrk);
})();

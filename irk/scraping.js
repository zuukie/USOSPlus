// Builds one data model for the IRK dashboard out of a few sibling IRK
// pages, same idea as usos/scraping.js: IRK is a classic server-rendered,
// multi-page app, so a single page load only ever has ONE section's data.
// We fetch the sibling pages ourselves (same-origin, so the browser sends
// the visitor's existing session cookies automatically — no credentials are
// read or handled by us) and parse the returned HTML.
(function () {
  const PATHS = {
    home(slug) { return `/pl/home/${slug}/`; },
    offer(slug) { return `/pl/offer/${slug}/`; },
    news(slug) { return `/pl/news/${slug}/`; },
  };

  async function fetchDoc(path) {
    try {
      const res = await fetch(path, { credentials: 'same-origin' });
      if (!res.ok) return null;
      const html = await res.text();
      return new DOMParser().parseFromString(html, 'text/html');
    } catch (e) {
      return null;
    }
  }

  // slug is null when the visitor hasn't picked a recruitment campaign yet
  // (the plain /pl/ landing page lists several — "Studia I stopnia...",
  // "Szkoła doktorska", ... — each its own campaign with its own slug, so
  // there's nothing single to dashboard until one is chosen).
  async function collectAll(slug) {
    if (!slug) return { noRecruitmentSelected: true };

    const adapters = window.USOSPP_IRK_ADAPTERS;
    const [offerDoc, newsDoc] = await Promise.all([
      fetchDoc(PATHS.offer(slug)),
      fetchDoc(PATHS.news(slug)),
    ]);

    const recruitmentLabel = adapters.recruitmentLabel(offerDoc || document);
    const offerResult = offerDoc
      ? adapters.getOfferList(offerDoc)
      : { supported: false, verified: false, groups: [] };
    const newsResult = newsDoc
      ? adapters.getNews(newsDoc)
      : { supported: false, verified: false, categories: [] };

    return { noRecruitmentSelected: false, slug, recruitmentLabel, offerResult, newsResult };
  }

  // Oferta's own listing (adapter.getOfferList) doesn't carry which wydział
  // each kierunek belongs to — the site's only listing grouped by wydział
  // (Filtry > Jednostki organizacyjne, and a "Wydział X" combo box) works by
  // setting a session-wide filter on /filter/ that then silently affects
  // every later unfiltered fetch of the same recruitment (verified live:
  // fetching the plain Oferta page after filtering by one wydział kept
  // returning that wydział's shorter list) — not something we want to touch
  // for a client-side filter UI. Each kierunek's own detail page already
  // has a real "Jednostka organizacyjna" field though (see
  // adapter.getProgrammeDetail), so this fetches all of them in parallel
  // once and reads that field back out — no session state involved, and the
  // exact same field irk/app.js's programme detail view already renders.
  async function fetchUnitsByUrl(urls) {
    const adapters = window.USOSPP_IRK_ADAPTERS;
    const entries = await Promise.all(urls.map(async (url) => {
      let doc = await fetchDoc(url);
      if (!doc) return [url, null];
      let detail = adapters.getProgrammeDetail(doc);
      if (!detail.supported) {
        // A multi-variant kierunek's Oferta link points to a /field/<code>/
        // hub (see adapter.getFieldVariants), not a single programme page —
        // follow its first variant instead, since every variant of the same
        // kierunek is the same wydział in practice.
        const hub = adapters.getFieldVariants(doc);
        if (hub.supported && hub.variants[0]) {
          doc = await fetchDoc(hub.variants[0].url);
          detail = doc ? adapters.getProgrammeDetail(doc) : null;
        } else {
          detail = null;
        }
      }
      const unitField = detail && detail.fields.find((f) => /Jednostka organizacyjna/i.test(f.label));
      return [url, unitField ? unitField.value : null];
    }));
    return Object.fromEntries(entries);
  }

  window.USOSPP_IRK_SCRAPE = { collectAll, fetchDoc, fetchUnitsByUrl, PATHS };
})();

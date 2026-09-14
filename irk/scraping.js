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
    units(slug) { return `/pl/offer/${slug}/units/`; },
    registrationSelect() { return '/pl/offer/registration-select/'; },
    // Account-wide — not scoped to any one recruitment slug (see
    // adapter.getApplications). Only reachable with a logged-in candidate
    // session; for anyone else this just parses into "unsupported".
    applications() { return '/pl/profile/applications/'; },
    // "Ustawienia konta" — also account-wide (see adapter.getAccountProfile).
    account() { return '/pl/profile/'; },
    // "Formularze osobowe" hub — account-wide too (auto-selects whichever
    // recruitment the session currently has picked, same as applications()).
    // Each individual form lives under a slug-scoped URL of its own (see
    // adapter.getPersonalFormsHub's forms[].url) fetched lazily on demand —
    // see fetchPersonalForm.
    personalForms() { return '/pl/profile/dataset/'; },
    // Also account-wide (see adapter.getPayments) — payment history isn't
    // scoped to any one recruitment either.
    payments() { return '/pl/profile/payments/'; },
    // Also account-wide (see adapter.getMessages) — inbox isn't scoped to
    // any one recruitment either. Individual conversations (adapter.
    // getMessageThread) live at their own URL, fetched lazily on demand —
    // see fetchMessageThread.
    messages() { return '/pl/profile/messages/'; },
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
    const adapters = window.USOSPP_IRK_ADAPTERS;
    // Read off the currently loaded page itself — see adapter.isLoggedIn —
    // not one of the fetched sibling docs, and computed before the
    // no-recruitment early return since the sidebar's account card/nav
    // lock icons need it regardless of whether a recruitment is selected.
    const loggedIn = adapters.isLoggedIn(document);
    const loginUrl = adapters.getLoginUrl(document);
    if (!slug) return { noRecruitmentSelected: true, loggedIn, loginUrl };

    const [offerDoc, newsDoc, unitsDoc, applicationsDoc, accountDoc, personalFormsDoc, paymentsDoc, messagesDoc] = await Promise.all([
      fetchDoc(PATHS.offer(slug)),
      fetchDoc(PATHS.news(slug)),
      fetchDoc(PATHS.units(slug)),
      fetchDoc(PATHS.applications()),
      fetchDoc(PATHS.account()),
      fetchDoc(PATHS.personalForms()),
      fetchDoc(PATHS.payments()),
      fetchDoc(PATHS.messages()),
    ]);

    const recruitmentLabel = adapters.recruitmentLabel(offerDoc || document);
    const offerResult = offerDoc
      ? adapters.getOfferList(offerDoc)
      : { supported: false, verified: false, groups: [] };
    const newsResult = newsDoc
      ? adapters.getNews(newsDoc)
      : { supported: false, verified: false, categories: [] };
    const unitsResult = unitsDoc
      ? adapters.getUnitsList(unitsDoc)
      : { supported: false, verified: false, units: [] };
    // Fetched unconditionally alongside the rest, same as unitsResult — for
    // an anonymous visitor (or one not logged in as a candidate) this just
    // comes back unsupported, same as any other adapter on a page that
    // doesn't apply to them.
    const applicationsResult = applicationsDoc
      ? adapters.getApplications(applicationsDoc)
      : { supported: false, verified: false, recruitments: [] };
    const accountResult = accountDoc
      ? adapters.getAccountProfile(accountDoc)
      : { supported: false, verified: false };
    const personalFormsResult = personalFormsDoc
      ? adapters.getPersonalFormsHub(personalFormsDoc)
      : { supported: false, verified: false, forms: [] };
    const paymentsResult = paymentsDoc
      ? adapters.getPayments(paymentsDoc)
      : { supported: false, verified: false, currencies: [] };
    const messagesResult = messagesDoc
      ? adapters.getMessages(messagesDoc)
      : { supported: false, verified: false, conversations: [] };

    return {
      noRecruitmentSelected: false,
      slug,
      recruitmentLabel,
      loggedIn,
      loginUrl,
      offerResult,
      newsResult,
      unitsResult,
      applicationsResult,
      accountResult,
      personalFormsResult,
      paymentsResult,
      messagesResult,
    };
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

  // The list of parallel recruitment campaigns (Studia I stopnia, Szkoła
  // Doktorska, ...) this IRK installation runs, for the in-dashboard "zmień
  // rekrutację" picker — see adapter.getRecruitmentOptions and app.js's
  // openRecruitmentPicker. Fetched fresh each time the picker opens rather
  // than cached on the data model, since it has nothing to do with the
  // currently selected recruitment's own data.
  async function fetchRecruitmentOptions() {
    const doc = await fetchDoc(PATHS.registrationSelect());
    if (!doc) return { supported: false, verified: false, options: [] };
    return window.USOSPP_IRK_ADAPTERS.getRecruitmentOptions(doc);
  }

  // Verified live (2026-09-14): visiting this URL directly (a plain GET,
  // nothing submitted) sets which recruitment campaign the visitor's session
  // is browsing and redirects to `next` — and the server rewrites `next`'s
  // own slug segment to match the NEWLY selected campaign before doing so,
  // so passing back the CURRENT recruitment's own Oferta path here reliably
  // lands on the equivalent Oferta view under the new one, not a 404.
  function switchRecruitmentUrl(targetSlug, currentSlug) {
    const next = currentSlug ? PATHS.offer(currentSlug) : '/pl/home/';
    return `${location.origin}/pl/offer/registration-select/${targetSlug}/?next=${encodeURIComponent(next)}`;
  }

  // The "Dokumenty i dalsze kroki" checklist for one application is only
  // fetched on demand (see app.js's ensureNextSteps) — a candidate can have
  // half a dozen applications and nobody looks at every checklist on every
  // visit, unlike the applications list itself which is cheap enough to
  // always fetch alongside collectAll.
  async function fetchApplicationNextSteps(url) {
    const doc = await fetchDoc(url);
    if (!doc) return { supported: false, verified: false, templates: [], checklist: [] };
    return window.USOSPP_IRK_ADAPTERS.getApplicationNextSteps(doc);
  }

  // One "Formularze osobowe" form (Podstawowe dane osobowe / Adres i dane
  // kontaktowe / Zdjęcie / Wykształcenie), fetched on demand the same way as
  // fetchApplicationNextSteps — see app.js's ensurePersonalForm.
  async function fetchPersonalForm(url) {
    const doc = await fetchDoc(url);
    if (!doc) return { supported: false, verified: false, fields: [] };
    return window.USOSPP_IRK_ADAPTERS.getPersonalForm(doc);
  }

  // A matura-type document's "Edytuj wyniki egzaminów" page (see
  // adapter.parseCertificateEntry's examScoresUrl), fetched on demand the
  // same way as fetchPersonalForm — see app.js's ensureExamScores.
  async function fetchExamScores(url) {
    const doc = await fetchDoc(url);
    if (!doc) return { supported: false, verified: false, exams: [] };
    return window.USOSPP_IRK_ADAPTERS.getExamScores(doc);
  }

  // One conversation's own page (see adapter.getMessages' rows[].url),
  // fetched on demand the same way as fetchApplicationNextSteps — see
  // app.js's ensureMessageThread.
  async function fetchMessageThread(url) {
    const doc = await fetchDoc(url);
    if (!doc) return { supported: false, verified: false, messages: [] };
    return window.USOSPP_IRK_ADAPTERS.getMessageThread(doc);
  }

  window.USOSPP_IRK_SCRAPE = {
    collectAll,
    fetchDoc,
    fetchUnitsByUrl,
    fetchRecruitmentOptions,
    fetchApplicationNextSteps,
    fetchPersonalForm,
    fetchExamScores,
    fetchMessageThread,
    switchRecruitmentUrl,
    PATHS,
  };
})();

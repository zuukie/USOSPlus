// Builds one data model for the USOS++ redesign out of several USOSweb pages.
// USOSweb itself is a classic server-rendered, multi-page app — a single page
// load only ever has ONE section's data in its DOM. To show a dashboard that
// combines plan/oceny/zaliczenia in one view, we fetch the sibling pages
// ourselves (same-origin, so the browser sends the user's existing session
// cookies automatically — no credentials are read or handled by us) and
// parse the returned HTML. This is still just "reading what's already on
// pages the logged-in user can see", never a USOS API call.
(function () {
  const PATHS = {
    // Note: the "Numer albumu" / faculty info panel only renders on the
    // home/index page, not on every page — cas-bar (name) is the only user
    // info present shell-wide. Fetch home explicitly rather than trusting
    // whatever page the redesign happened to mount on.
    home: 'kontroler.php?_action=home/index',
    grupy: 'kontroler.php?_action=home/grupy',
    zaliczenia: 'kontroler.php?_action=dla_stud/studia/zaliczenia/index',
    // Per-stage settlement details (see adapter.getEtapDetails) — one per
    // detailsId scraped from the zaliczenia list's "Szczegóły" links, so it
    // generalizes to however many stages a given account happens to list.
    etapDetails(detailsId) {
      return `kontroler.php?_action=dla_stud/studia/zaliczenia/pokazEtap&etpos_id=${encodeURIComponent(detailsId)}`;
    },
    oceny: 'kontroler.php?_action=dla_stud/studia/oceny/index',
    plan: 'kontroler.php?_action=home/plan',
    egzaminy: 'kontroler.php?_action=dla_stud/rejestracja/egzaminy',
    // University-wide announcements — also the site's own landing page
    // (news/default). Server-rendered markup varies per installation
    // (universities restyle these pages themselves): adapter.getNews
    // feature-detects the observed shapes in order (.title-wrapper-section
    // at PWr, <hr>-separated heading segments at UJD, div.pole items at
    // PB, div.info-box items with p.header/p.stamp at AL, usos-frame
    // cards at TUK, table.grey + tr.strong items at PBS/PO, h1 segments
    // at POLSL), and when none of them matches — e.g. PW ships its own
    // client-side and the DOM carries nothing — collectNews below probes
    // the pwnews JSON add-on (see PATHS.newsFallback).
    news: 'kontroler.php?_action=news/default',
    // Announcements fallback for installations whose news/default renders
    // NO announcements server-side and instead ships them through a local
    // dodatki add-on: an inline jQuery script XHRs this JSON endpoint and
    // client-side injects the items straight into the DOM (which our
    // fetch+parse scraping never sees — no JS execution on our side).
    // Verified live (2026-09-16, anonymous) at usosweb.usos.pw.edu.pl,
    // whose news/default carries only the data-migration status table:
    // kontroler.php?_action=dodatki/pwnews&langset=pl answers with a JSON
    // array [{id, nazwa, opis, grupa_odbiorcow, data: "YYYY-MM-DD"}] (see
    // adapter.parseNewsJson). Other installations are expected to answer
    // 404/plain HTML — the probe only fires when the news/default DOM
    // parse came back empty, so PWr/PB (standard server-rendered news)
    // never pay for it.
    newsFallback: 'kontroler.php?_action=dodatki/pwnews&langset=pl',
    // Płatności — one nav view merges what USOS spreads across five
    // sub-pages plus a hub. "należności rozliczone" (settled dues) is
    // deliberately left out: for a student, "was this paid" is already
    // answered by the payments list below, so keeping both would just be
    // the same 22 PLN shown twice from two sides of the same transaction.
    platnosciNierozliczone: 'kontroler.php?_action=dodatki/platnosci/naleznosciNierozliczone',
    platnosciPlanyRatalne: 'kontroler.php?_action=dodatki/platnosci/planyRatalne',
    platnosciWplaty: 'kontroler.php?_action=dodatki/platnosci/wplatyWszystkie',
    platnosciWplatyNierozliczone: 'kontroler.php?_action=dodatki/platnosci/wplatyNierozliczone',
    // Different module prefix (platnosci_fk, not platnosci) — verified live,
    // this isn't a guessable sibling path.
    platnosciKontaBankowe: 'kontroler.php?_action=dodatki/platnosci_fk/kontaBankowe',
    // Personalized hub listing the student's own programme stage(s) (see
    // adapter.getOwnProgrammes) — used to filter the faculty-wide
    // registration calendar down to just this student's kierunek.
    zapisyHub: 'kontroler.php?_action=dla_stud/rejestracja/przedmioty',
    // Personal registration calendar (see adapter.getPersonalCalendar) —
    // the student's own tours with exact times, attributes and actions.
    // Unlike the faculty-wide rejJednostki calendar below, this one is
    // already filtered to the logged-in student, so it is the primary
    // source for the Zapisy view; rejJednostki stays only as a fallback
    // enrichment when this fetch fails.
    kalendarz: 'kontroler.php?_action=dla_stud/rejestracja/kalendarz',
    // Faculty-wide registration calendar — needs the jednostka code, which
    // varies per student/university, so it's a function rather than a
    // static path (see adapter.getUser().facultyCode).
    rejestracje(kod) {
      return `kontroler.php?_action=news/rejestracje/rejJednostki&jed_org_kod=${encodeURIComponent(kod)}`;
    },
    // Subjects inside one personal-calendar tour (see
    // adapter.getRejSubjects) — the "pokaż przedmioty…" link target. Takes
    // the full stored subjectsUrl: rej_kod is stable, but the callback token
    // is per page load, so callers must pass a freshly scraped URL (see
    // refreshPersonalCalendar below), never one kept across sessions.
    rejSubjects(subjectsUrl) {
      try {
        const u = new URL(subjectsUrl, location.origin);
        const rejKod = u.searchParams.get('rej_kod');
        const callback = u.searchParams.get('callback');
        if (!rejKod) return null;
        let path = `kontroler.php?_action=katalog2/przedmioty/szukajPrzedmiotu&method=rej&rej_kod=${encodeURIComponent(rejKod)}`;
        if (callback) path += `&callback=${encodeURIComponent(callback)}`;
        return path;
      } catch (e) {
        return null;
      }
    },
    // Per-stage subject list (see adapter.getStageSubjects) — one per
    // {prg_kod, etp_kod} pair from getOwnProgrammes, so it's generalized to
    // however many stages/semesters a given account happens to list there,
    // not hardcoded to one kierunek.
    stageSubjects(prgKod, etpKod) {
      return `kontroler.php?_action=katalog2/programy/pokazEtapProgramu&prg_kod=${encodeURIComponent(prgKod)}&etp_kod=${encodeURIComponent(etpKod)}`;
    },
    // Topbar search (see searchCatalog below). These are the SAME plain,
    // session-cookie-authenticated JSON endpoints the classic Katalog
    // autocomplete boxes call directly from the browser (verified live) —
    // unlike USOSmail's history/compose widgets, there's no CSRF wall and no
    // "don't use this as an API" notice here, so this is fair game under the
    // same "read what the logged-in user can already see" rule as
    // everything else in this file, just JSON instead of HTML.
    // The classic UI actually has two separate boxes for this — one search-
    // param per field, both hitting the same endpoint (verified live:
    // _pattern matches on name and returns nothing for an exact code;
    // _prz_kod_pattern is the other way around) — searchCatalog below fires
    // both and merges them so one search box covers what USOS itself splits
    // into "po nazwie" / "po kodzie".
    searchSubjects(pattern) {
      return `kontroler.php?_action=jsonQueries/jsonSzukajPrzedmiotu&_pattern=${encodeURIComponent(pattern)}`;
    },
    searchSubjectsByCode(pattern) {
      return `kontroler.php?_action=jsonQueries/jsonSzukajPrzedmiotu&_prz_kod_pattern=${encodeURIComponent(pattern)}`;
    },
    searchUnits(pattern) {
      return `kontroler.php?_action=jsonQueries/jsonSzukajJednostki&_pattern=${encodeURIComponent(pattern)}`;
    },
    searchPrograms(pattern) {
      return `kontroler.php?_action=jsonQueries/jsonSzukajProgramu&_pattern=${encodeURIComponent(pattern)}`;
    },
    // Detail pages for a search result — see adapter.getUnitDetail /
    // getProgramDetail.
    unitDetail(kod) {
      return `kontroler.php?_action=katalog2/jednostki/pokazJednostke&kod=${encodeURIComponent(kod)}`;
    },
    programDetail(kod) {
      return `kontroler.php?_action=katalog2/programy/pokazProgram&kod=${encodeURIComponent(kod)}`;
    },
    // Building list for one jednostka AND all of its sub-units, recursively
    // — see adapter.getBuildingsForUnit. Passing the whole university's own
    // root jed_org_kod (found via getUnitDetail's ancestors chain) returns
    // every mappable building campus-wide in one request.
    buildingsForUnit(jedOrgKod) {
      return `kontroler.php?_action=katalog2/jednostki/budynkiJednostki&jed_org_kod=${encodeURIComponent(jedOrgKod)}`;
    },
    // The unit page's own "Prowadzone przedmioty" service (verified live,
    // PWr and PB): every subject OFFERED BY this exact unit — USOS filters
    // strictly by the owning unit, not recursively, so at both universities
    // wydziały hold the subjects while katedry return the empty marker
    // ("Brak przedmiotów oferowanych przez tę jednostkę"). Only the first
    // page (30 rows) comes back from this URL; further pages follow the
    // ready-built next-page-url in the response's <table-nav-bar> (see
    // adapter.getUnitSubjects). The cp_ params are display settings the
    // classic UI keeps per-user: cdydsDisplayLevel=3 adds the per-cycle
    // ("2024/25-Z"…) columns whose cells link rejestracjaNaPrzedmiotCyklu
    // with a cdyd_kod param, and showGroupsColumn=1 adds the course-group
    // column — both verified live on both universities.
    unitSubjects(kod) {
      return `kontroler.php?_action=katalog2/przedmioty/szukajPrzedmiotu&jed_org_kod=${encodeURIComponent(kod)}&method=faculty_organized&cp_cdydsDisplayLevel=3&cp_showGroupsColumn=1`;
    },
    // "Oferowane programy studiów" — same page-shape family as unitSubjects,
    // verified live at PWr (W3: 63 programs) and PB (Wydział Informatyki:
    // 46); empty units get "Brak programów studiów w tej jednostce.".
    unitPrograms(kod) {
      return `kontroler.php?_action=katalog2/programy/szukajProgramu&method=by_faculty&jed_org_kod=${encodeURIComponent(kod)}`;
    },
    // Four small "Moje studia" pages, all verified live against an empty
    // account (semester just started — no scholarship decisions, checkpoint
    // rules, petitions or open surveys yet): each one renders either a plain
    // <info-box> "brak ..." message or (podania) nothing at all when there's
    // nothing to show. None of them had real rows to check the "has data"
    // markup against — see adapter.genericInfoTable's comment.
    stypendia: 'kontroler.php?_action=dla_stud/studia/stypendia/stypendia',
    sprawdziany: 'kontroler.php?_action=dla_stud/studia/sprawdziany/index',
    podania: 'kontroler.php?_action=dla_stud/studia/podania/listaZlozonych',
    ankiety: 'kontroler.php?_action=dla_stud/studia/ankiety/index',
    // mLegitymacja order-status page — read-only display (see
    // adapter.getMlegitymacja). Verified live 2026-10-01 in the
    // "Oczekuje" state; states unobservable then (no order yet,
    // Do-odbioru/QR) are parsed defensively — see the adapter comment.
    mlegitymacja: 'kontroler.php?_action=dla_stud/studia/mlegitymacja/index',
  };

  // Maintenance mode (przerwa techniczna / synchronizacja danych): USOSweb
  // serves its "USOSweb tymczasowo niedostępny" dispatch page on EVERY
  // path — including the JSON endpoints below — with HTTP 503 (verified
  // live at usosweb.pb.edu.pl during a data sync: root, news/default and
  // jsonSzukajJednostki all returned the same 503 dispatch; the normal
  // shell shows none of those markers, so no false positives). One fetch
  // failing doesn't mean the system is down, but a run where EVERY fetch
  // got a 503 does — collectAll/collectAnon compare the two counters to
  // flag exactly that, and inject.js turns the flag into a clear "godzina
  // przerwy" notice instead of an all-empty panel. HTTP-503-only by
  // design: other failure modes (5xx, network) keep the per-view error
  // cards, which is the honest message there.
  let trackedCount = 0;
  let unavailableCount = 0;

  async function fetchJson(path) {
    try {
      const res = await fetch(path, { credentials: 'same-origin' });
      trackedCount++;
      if (res.status === 503) unavailableCount++;
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // Search cache (2 min) + abort of stale queries — the topbar fires on
  // every confirmed phrase and each confirmation used to cost 4 JSON
  // requests with no dedup, so fast typing produced races + duplicate load.
  const searchCache = new Map();
  let searchController = null;
  async function fetchJsonAbortable(path, signal) {
    try {
      const res = await fetch(path, { credentials: 'same-origin', signal });
      trackedCount++;
      if (res.status === 503) unavailableCount++;
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // Same min-search-length (3) the classic <usos-selector> autocomplete
  // widgets use — querying shorter patterns is just noise USOS itself
  // wouldn't bother sending either.
  async function searchCatalog(query) {
    const pattern = (query || '').trim();
    if (pattern.length < 3) return { subjects: [], units: [], programs: [] };
    const cached = searchCache.get(pattern);
    if (cached && Date.now() - cached.at < 120000) return cached.result;
    if (searchController) { try { searchController.abort(); } catch (e) { /* ignore */ } }
    searchController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const signal = searchController ? searchController.signal : undefined;
    const [subjectsByName, subjectsByCode, unitsJson, programsJson] = await Promise.all([
      fetchJsonAbortable(PATHS.searchSubjects(pattern), signal),
      fetchJsonAbortable(PATHS.searchSubjectsByCode(pattern), signal),
      fetchJsonAbortable(PATHS.searchUnits(pattern), signal),
      fetchJsonAbortable(PATHS.searchPrograms(pattern), signal),
    ]);
    // Merge by kod — a code query can occasionally also turn up in the
    // name results (or vice versa), and the two sets shouldn't show the
    // same subject twice.
    const subjectsByKod = new Map();
    (subjectsByName && subjectsByName.wyniki ? Object.values(subjectsByName.wyniki) : []).forEach((s) => subjectsByKod.set(s.kod, s));
    (subjectsByCode && subjectsByCode.wyniki ? Object.values(subjectsByCode.wyniki) : []).forEach((s) => subjectsByKod.set(s.kod, s));
    const result = {
      subjects: [...subjectsByKod.values()],
      units: unitsJson && unitsJson.wyniki ? Object.values(unitsJson.wyniki) : [],
      programs: programsJson && programsJson.wyniki ? Object.values(programsJson.wyniki) : [],
    };
    searchCache.set(pattern, { at: Date.now(), result });
    if (searchCache.size > 30) {
      const oldest = searchCache.keys().next().value;
      searchCache.delete(oldest);
    }
    return result;
  }

  async function fetchDoc(path) {
    try {
      const res = await fetch(path, { credentials: 'same-origin' });
      trackedCount++;
      if (res.status === 503) unavailableCount++;
      if (!res.ok) return null;
      const html = await res.text();
      return new DOMParser().parseFromString(html, 'text/html');
    } catch (e) {
      return null;
    }
  }

  // The exams module is a client-rendered AngularJS app that fetches its own
  // data after load — a static fetch() would only see the empty shell. We
  // load it for real in a hidden same-origin iframe and read the DOM it
  // ends up producing, then tear the iframe down.
  function fetchExamsDoc(timeoutMs = 6000) {
    return new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.setAttribute('aria-hidden', 'true');
      let settled = false;
      const finish = (doc) => {
        if (settled) return;
        settled = true;
        observer && observer.disconnect();
        clearTimeout(timer);
        iframe.remove();
        resolve(doc);
      };
      let observer = null;
      const timer = setTimeout(() => {
        finish(iframe.contentDocument || null);
      }, timeoutMs);
      iframe.addEventListener('load', () => {
        const idoc = iframe.contentDocument;
        if (!idoc) return finish(null);
        const app = idoc.querySelector('#appContainer');
        if (!app) return finish(idoc);
        observer = new MutationObserver(() => {
          if (app.querySelector('table, [ng-repeat]')) finish(idoc);
        });
        observer.observe(app, { childList: true, subtree: true });
      });
      iframe.addEventListener('error', () => finish(null));
      iframe.src = PATHS.egzaminy;
      document.body.appendChild(iframe);
    });
  }

  // Announcements, with the add-on fallback (see PATHS.newsFallback):
  // adapter.getNews's markup-shape parsers run first and win outright
  // whenever news/default carries server-rendered items (title-wrapper
  // sections at PWr, hr segments at UJD, .pole divs at PB, .info-box
  // divs at AL, usos-frame cards at TUK, table.grey items at PBS/PO,
  // h1 segments at POLSL — see adapters.js). Only when they find
  // nothing (or the page failed to fetch) do we probe the JSON endpoint and let adapter.parseNewsJson
  // shape the answer (PW). Either way a failed probe falls back to the
  // DOM result's ordinary "unsupported" state — an installation with
  // neither renderer keeps exactly the behavior it had before this
  // fallback existed. The probe goes through fetchJson, so during a
  // maintenance window its 503 counts toward the maintenance verdict
  // like every other fetch.
  async function collectNews(adapter, newsDoc) {
    const domNews = newsDoc ? adapter.getNews(newsDoc) : null;
    if (domNews && domNews.supported) return domNews;
    const json = await fetchJson(PATHS.newsFallback);
    if (json) {
      const jsonNews = adapter.parseNewsJson(json);
      if (jsonNews.supported) return jsonNews;
    }
    return domNews || { supported: false, verified: false, items: [] };
  }

  // Single-section refresh for the Aktualności "Spróbuj ponownie" link
  // (see app.js's renderAktualnosci): re-fetches ONLY news/default and
  // re-runs the same collectNews path (DOM shapes first, pwnews JSON
  // probe second) — not the whole collectAll/collectAnon model.
  async function refreshNews(adapter) {
    const newsDoc = await fetchDoc(PATHS.news);
    return collectNews(adapter, newsDoc);
  }

  async function collectAll(adapter) {
    trackedCount = 0;
    unavailableCount = 0;
    // Critical-for-dashboard first: home, zaliczenia, oceny, plan, hub,
    // news, kalendarz + płatności + moje-studia. Deliberately NOT here:
    // exams (hidden iframe ~6s), faculty rejestracje + per-stage subjects
    // (N extra pages) — those load lazily on view entry via
    // fetchExamsResult/fetchRegistrationsResult/fetchStageSubjectsResult.
    const [
      homeDoc, grupyDoc, zaliczeniaDoc, ocenyDoc, planDoc, zapisyHubDoc, newsDoc,
      kalendarzDoc,
      platnosciNierozDoc, planyRatalneDoc, wplatyDoc, wplatyNierozDoc, kontaBankoweDoc,
      stypendiaDoc, sprawdzianyDoc, podaniaDoc, ankietyDoc,
    ] = await Promise.all([
      fetchDoc(PATHS.home),
      fetchDoc(PATHS.grupy),
      fetchDoc(PATHS.zaliczenia),
      fetchDoc(PATHS.oceny),
      fetchDoc(PATHS.plan),
      fetchDoc(PATHS.zapisyHub),
      fetchDoc(PATHS.news),
      fetchDoc(PATHS.kalendarz),
      fetchDoc(PATHS.platnosciNierozliczone),
      fetchDoc(PATHS.platnosciPlanyRatalne),
      fetchDoc(PATHS.platnosciWplaty),
      fetchDoc(PATHS.platnosciWplatyNierozliczone),
      fetchDoc(PATHS.platnosciKontaBankowe),
      fetchDoc(PATHS.stypendia),
      fetchDoc(PATHS.sprawdziany),
      fetchDoc(PATHS.podania),
      fetchDoc(PATHS.ankiety),
    ]);

    // Prefer the fetched home page (has the album/faculty info panel); fall
    // back to the live document (still has cas-bar, so at least the name
    // resolves) if that fetch failed for some reason.
    const user = homeDoc ? adapter.getUser(homeDoc) : adapter.getUser(document);
    const etapyResult = zaliczeniaDoc
      ? adapter.getEtapy(zaliczeniaDoc)
      : { supported: false, verified: false, etapy: [] };
    const gradesResult = ocenyDoc
      ? adapter.getGrades(ocenyDoc)
      : { supported: false, verified: false, rows: [] };
    const planResult = planDoc
      ? adapter.getPlan(planDoc)
      : { supported: false, verified: false, raw: null };
    // Weekly plan reconstruction source: home/grupy lists every enrolled
    // group with its recurring schedule lines (server-rendered, unlike the
    // client-side home/plan timetable). getMyGroups is optional on older
    // adapters — guard with typeof.
    let myGroupsResult = { supported: false, verified: false, subjects: [] };
    try {
      if (grupyDoc && typeof adapter.getMyGroups === 'function') {
        myGroupsResult = adapter.getMyGroups(grupyDoc);
      }
    } catch (e) {
      // leave myGroupsResult as the unsupported default
    }
    const ownProgrammesResult = zapisyHubDoc
      ? adapter.getOwnProgrammes(zapisyHubDoc)
      : { supported: false, verified: false, programmes: [] };
    const newsResult = await collectNews(adapter, newsDoc);

    const EMPTY_GROUPS = { supported: false, verified: false, groups: [], grandTotal: null };
    const paymentsResult = {
      supported: !!(platnosciNierozDoc || wplatyDoc),
      verified: true,
      unpaid: platnosciNierozDoc ? adapter.getPaymentGroups(platnosciNierozDoc) : EMPTY_GROUPS,
      installments: planyRatalneDoc ? adapter.getPaymentGroups(planyRatalneDoc) : EMPTY_GROUPS,
      payments: wplatyDoc ? adapter.getPaymentGroups(wplatyDoc) : EMPTY_GROUPS,
      unsettledPayments: wplatyNierozDoc ? adapter.getPaymentGroups(wplatyNierozDoc) : EMPTY_GROUPS,
      bankAccounts: kontaBankoweDoc ? adapter.getBankAccounts(kontaBankoweDoc) : { supported: false, verified: false, accounts: [] },
    };

    const examsResult = { supported: false, verified: false, exams: [], deferred: true };
    const registrationsResult = { supported: false, verified: false, groups: [], deferred: true };

    // Personal calendar — primary source for the Zapisy view (see PATHS
    // above). Independent of facultyCode: it works wherever USOS serves
    // the dla_stud calendar for the logged-in student.
    let personalCalendarResult = { supported: false, verified: false, sections: [] };
    try {
      if (kalendarzDoc) personalCalendarResult = adapter.getPersonalCalendar(kalendarzDoc);
    } catch (e) {
      // leave personalCalendarResult as the unsupported default
    }

    const stageSubjectsResult = { supported: false, verified: false, stages: [], deferred: true };

    const scholarshipsResult = stypendiaDoc
      ? adapter.getScholarships(stypendiaDoc)
      : { supported: false, verified: false, rows: [] };
    const testsResult = sprawdzianyDoc
      ? adapter.getTests(sprawdzianyDoc)
      : { supported: false, verified: false, rows: [] };
    const petitionsResult = podaniaDoc
      ? adapter.getPetitions(podaniaDoc)
      : { supported: false, verified: false, rows: [] };
    const surveysResult = ankietyDoc
      ? adapter.getSurveys(ankietyDoc)
      : { supported: false, verified: false, rows: [] };

    return {
      user, etapyResult, gradesResult, planResult, myGroupsResult, examsResult, registrationsResult,
      personalCalendarResult,
      ownProgrammesResult, stageSubjectsResult, etapDetailsResult: { supported: false, verified: false, byId: {} },
      newsResult, paymentsResult,
      scholarshipsResult, testsResult, petitionsResult, surveysResult,
      // True when every single fetch of this run was a 503 dispatch — USOSweb
      // is down (see the counters' block comment above). Partial failure keeps
      // the ordinary per-view supported:false degradation instead.
      maintenance: trackedCount > 0 && trackedCount === unavailableCount,
    };
  }

  // Logged-out counterpart of collectAll — see app.js's PUBLIC_VIEWS for
  // which views USOSweb itself serves to anonymous visitors. At mount time
  // the shell only needs the ONE page it always renders from (Aktualności —
  // which also feeds the notification center), since the rest of the public
  // family (search + katalog2 pages, campus buildings) is fetched lazily on
  // view entry. Every other key keeps collectAll's empty/unsupported default
  // shape, so no getter or renderer that reads a personal section can crash
  // on the anonymous data model.
  async function collectAnon(adapter) {
    trackedCount = 0;
    unavailableCount = 0;
    const newsDoc = await fetchDoc(PATHS.news);
    const newsResult = await collectNews(adapter, newsDoc);
    return {
      user: null,
      etapyResult: { supported: false, verified: false, etapy: [] },
      gradesResult: { supported: false, verified: false, rows: [] },
      planResult: { supported: false, verified: false, raw: null },
      myGroupsResult: { supported: false, verified: false, subjects: [] },
      examsResult: { supported: false, verified: false, exams: [] },
      registrationsResult: { supported: false, verified: false, groups: [] },
      personalCalendarResult: { supported: false, verified: false, sections: [] },
      ownProgrammesResult: { supported: false, verified: false, programmes: [] },
      stageSubjectsResult: { supported: false, verified: false, stages: [] },
      etapDetailsResult: { supported: false, verified: false, byId: {} },
      newsResult,
      paymentsResult: {
        supported: false,
        verified: true,
        unpaid: { supported: false, verified: false, groups: [], grandTotal: null },
        installments: { supported: false, verified: false, groups: [], grandTotal: null },
        payments: { supported: false, verified: false, groups: [], grandTotal: null },
        unsettledPayments: { supported: false, verified: false, groups: [], grandTotal: null },
        bankAccounts: { supported: false, verified: false, accounts: [] },
      },
      scholarshipsResult: { supported: false, verified: false, rows: [] },
      testsResult: { supported: false, verified: false, rows: [] },
      petitionsResult: { supported: false, verified: false, rows: [] },
      surveysResult: { supported: false, verified: false, rows: [] },
      maintenance: trackedCount > 0 && trackedCount === unavailableCount,
    };
  }

  // Fresh personal calendar on demand (see PATHS.rejSubjects): the
  // subjectsUrl/registerUrl links carry a per-page-load callback token, so
  // opening a tour always re-scrapes the calendar first and uses the fresh
  // URLs from that result — never ones stored from mount time.
  async function refreshPersonalCalendar(adapter) {
    const doc = await fetchDoc(PATHS.kalendarz);
    if (!doc) return { supported: false, verified: false, sections: [] };
    try {
      return adapter.getPersonalCalendar(doc);
    } catch (e) {
      return { supported: false, verified: false, sections: [] };
    }
  }

  // Subjects of one tour, from a freshly scraped subjectsUrl (see
  // PATHS.rejSubjects for why freshness matters). Read-only GET, like
  // every other fetch in this file — the actual enrolment POST
  // (brdg2/zarejestruj) is never called from here; the UI only deep-links
  // to it.
  async function fetchRejSubjects(adapter, subjectsUrl) {
    const path = PATHS.rejSubjects(subjectsUrl);
    if (!path) return { supported: false, verified: false, subjects: [], total: 0, nextUrl: null };
    const doc = await fetchDoc(path);
    if (!doc) return { supported: false, verified: false, subjects: [], total: 0, nextUrl: null };
    try {
      return adapter.getRejSubjects(doc);
    } catch (e) {
      return { supported: false, verified: false, subjects: [], total: 0, nextUrl: null };
    }
  }

  // Groups of one subject inside one tour, from a freshly scraped
  // groupsUrl (adapter.getRejGroups — brdg2/grupyPrzedmiotu). Same
  // freshness rule as fetchRejSubjects: the callback token is per page
  // load, so callers resolve the URL through a fresh calendar +
  // subjects scrape first (see app.js's fetchZapisGrupy), never reuse a
  // stored one across sessions.
  function rejGroupsPath(groupsUrl) {
    try {
      const u = new URL(groupsUrl, location.origin);
      const rejKod = u.searchParams.get('rej_kod');
      const przKod = u.searchParams.get('prz_kod');
      const cdydKod = u.searchParams.get('cdyd_kod');
      const callback = u.searchParams.get('callback');
      if (!rejKod || !przKod) return null;
      let path = `kontroler.php?_action=dla_stud/rejestracja/brdg2/grupyPrzedmiotu&rej_kod=${encodeURIComponent(rejKod)}&prz_kod=${encodeURIComponent(przKod)}`;
      if (cdydKod) path += `&cdyd_kod=${encodeURIComponent(cdydKod)}`;
      path += '&odczyt=1';
      if (callback) path += `&callback=${encodeURIComponent(callback)}`;
      return path;
    } catch (e) {
      return null;
    }
  }

  async function fetchRejGroups(adapter, groupsUrl) {
    const path = rejGroupsPath(groupsUrl);
    if (!path) return { supported: false, verified: false, sections: [] };
    const doc = await fetchDoc(path);
    if (!doc) return { supported: false, verified: false, sections: [] };
    try {
      return adapter.getRejGroups(doc);
    } catch (e) {
      return { supported: false, verified: false, sections: [] };
    }
  }

  // Details of one enrolled group (see adapter.getGroupDetails) — room,
  // building and lecturers for the weekly plan. Cached per URL (module
  // lifetime): one group page per enrolled group, fetched lazily on plan
  // view entry, never on mount.
  const groupDetailsCache = new Map();
  async function fetchGroupDetails(adapter, url) {
    const miss = { supported: false, verified: false };
    if (!url || !adapter || typeof adapter.getGroupDetails !== 'function') return miss;
    if (groupDetailsCache.has(url)) return groupDetailsCache.get(url);
    const doc = await fetchDoc(url);
    let res = miss;
    if (doc) {
      try {
        res = adapter.getGroupDetails(doc);
      } catch (e) { /* keep miss */ }
    }
    // Only successes are cached: a transient failure (expired callback
    // token, hiccup) cached as miss would poison the group forever —
    // rooms, teachers and meetings would stay missing with no retry.
    if (res && res.supported) {
      groupDetailsCache.set(url, res);
      if (groupDetailsCache.size > 100) {
        const oldest = groupDetailsCache.keys().next().value;
        groupDetailsCache.delete(oldest);
      }
    }
    return res;
  }
  async function fetchExamsResult(adapter, data) {
    if (!data || data.examsResultLoaded) return data ? data.examsResult : null;
    try {
      const examsDoc = await fetchExamsDoc();
      data.examsResult = examsDoc
        ? adapter.getExams(examsDoc)
        : { supported: false, verified: false, exams: [] };
    } catch (e) {
      data.examsResult = { supported: false, verified: false, exams: [] };
    }
    data.examsResultLoaded = true;
    return data.examsResult;
  }

  async function fetchRegistrationsResult(adapter, data) {
    if (!data || data.registrationsResultLoaded) return data ? data.registrationsResult : null;
    let result = { supported: false, verified: false, groups: [] };
    const user = data.user;
    if (user && user.facultyCode) {
      try {
        const regDoc = await fetchDoc(PATHS.rejestracje(user.facultyCode));
        if (regDoc) result = adapter.getRegistrationRounds(regDoc);
      } catch (e) { /* keep default */ }
    }
    data.registrationsResult = result;
    data.registrationsResultLoaded = true;
    return result;
  }

  async function fetchEtapDetailsResult(adapter, data) {
    if (!data || data.etapDetailsResultLoaded) return data ? data.etapDetailsResult : null;
    let result = { supported: false, verified: false, byId: {} };
    const etapy = data.etapyResult && Array.isArray(data.etapyResult.etapy) ? data.etapyResult.etapy : [];
    const ids = [...new Set(etapy.map((e) => e && e.detailsId).filter(Boolean))];
    if (ids.length && typeof adapter.getEtapDetails === 'function') {
      try {
        const docs = await Promise.all(ids.map((id) => fetchDoc(PATHS.etapDetails(id))));
        const byId = {};
        ids.forEach((id, i) => {
          const doc = docs[i];
          if (!doc) return;
          byId[id] = adapter.getEtapDetails(doc);
        });
        result = { supported: Object.keys(byId).length > 0, verified: true, byId };
      } catch (e) { /* keep default */ }
    }
    data.etapDetailsResult = result;
    data.etapDetailsResultLoaded = true;
    return result;
  }

  async function fetchStageSubjectsResult(adapter, data) {
    if (!data || data.stageSubjectsResultLoaded) return data ? data.stageSubjectsResult : null;
    let result = { supported: false, verified: false, stages: [] };
    const own = data.ownProgrammesResult;
    if (own && own.supported && Array.isArray(own.programmes) && own.programmes.length) {
      try {
        const stageDocs = await Promise.all(
          own.programmes.map((p) => fetchDoc(PATHS.stageSubjects(p.prgKod, p.etpKod)))
        );
        const stages = own.programmes
          .map((p, i) => {
            const doc = stageDocs[i];
            if (!doc) return null;
            return { ...p, ...adapter.getStageSubjects(doc) };
          })
          .filter(Boolean);
        result = { supported: stages.length > 0, verified: true, stages };
      } catch (e) { /* keep default */ }
    }
    data.stageSubjectsResult = result;
    data.stageSubjectsResultLoaded = true;
    return result;
  }

  // Participants of one enrolled group (see adapter.getGroupParticipants).
  // The wrnav table paginates server-side (default 30 rows); a lone
  // tab_limit param is ignored, so we follow the page's own
  // tab_limit=500 link (full tab_offset/tab_limit/tab_order triplet)
  // instead of guessing params — verified live: 30 → 110 rows on a
  // lecture group. Separate cache from fetchGroupDetails (different URL
  // and purpose). Fetched lazily on Studenci view entry, never on mount.
  const groupParticipantsCache = new Map();
  async function fetchGroupParticipants(adapter, url) {
    const miss = { supported: false, verified: false, hidden: false, students: [] };
    if (!url || !adapter || typeof adapter.getGroupParticipants !== 'function') return miss;
    if (groupParticipantsCache.has(url)) return groupParticipantsCache.get(url);
    const parse = (doc) => {
      try {
        return adapter.getGroupParticipants(doc);
      } catch (e) {
        return miss;
      }
    };
    let doc = await fetchDoc(url);
    let res = doc ? parse(doc) : miss;
    if (doc && res.supported && !res.hidden) {
      const bigLink = [...doc.querySelectorAll('table.wrnav a')]
        .map((a) => a.href)
        .find((h) => /tab_limit=500/.test(h || ''));
      if (bigLink) {
        const bigDoc = await fetchDoc(bigLink);
        if (bigDoc) {
          const bigRes = parse(bigDoc);
          if (bigRes.supported && !bigRes.hidden && bigRes.students.length >= res.students.length) res = bigRes;
        }
      }
    }
    groupParticipantsCache.set(url, res);
    if (groupParticipantsCache.size > 100) {
      const oldest = groupParticipantsCache.keys().next().value;
      groupParticipantsCache.delete(oldest);
    }
    return res;
  }
  // All enrolled groups' participants in one go: {byUrl, groups:[{url,
  // subject, code, type, nr, ...result}], visible, hidden} for the
  // Studenci view. Stored on data.participantsResult (…Loaded flag, same
  // pattern as the other fetch*Result helpers).
  async function fetchParticipantsResult(adapter, data) {
    if (!data || data.participantsResultLoaded) return data ? data.participantsResult : null;
    const result = { supported: false, verified: true, byUrl: {}, groups: [], visible: 0, hidden: 0 };
    const mg = data.myGroupsResult;
    if (mg && Array.isArray(mg.subjects) && mg.subjects.length) {
      const jobs = [];
      mg.subjects.forEach((s) => (s.groups || []).forEach((g) => {
        if (g.detailsUrl) jobs.push({ url: g.detailsUrl, subject: s.name, code: s.code, type: g.type, nr: g.nr });
      }));
      const seen = new Set();
      const uniqueJobs = jobs.filter((j) => !seen.has(j.url) && (seen.add(j.url), true));
      const settled = await Promise.all(uniqueJobs.map(async (j) => {
        try {
          return { ...j, res: await fetchGroupParticipants(adapter, j.url) };
        } catch (e) {
          return { ...j, res: { supported: false, verified: false, hidden: false, students: [] } };
        }
      }));
      settled.forEach(({ url, subject, code, type, nr, res }) => {
        result.byUrl[url] = res;
        result.groups.push({ url, subject, code, type, nr, ...res });
        if (res.supported && !res.hidden) { result.visible++; result.supported = true; }
        else result.hidden++;
      });
    }
    data.participantsResult = result;
    data.participantsResultLoaded = true;
    return result;
  }
  // mLegitymacja order status (see adapter.getMlegitymacja). Fetched
  // lazily on view entry — a rarely visited, one-light-page view — never
  // on mount. force:true re-reads for the manual "Sprawdź status" button
  // (the same GET the classic "Sprawdź status zamówienia" form sends).
  async function fetchMlegitymacjaResult(adapter, data, force) {
    const miss = { supported: false, verified: false, hasOrder: false, pickupReady: false, status: null, orderDate: null, validUntil: null, qrText: null, qrPass: null };
    if (!data) return miss;
    if (data.mlegitymacjaResultLoaded && !force) return data.mlegitymacjaResult;
    let result = miss;
    try {
      const doc = await fetchDoc(PATHS.mlegitymacja);
      if (doc && adapter && typeof adapter.getMlegitymacja === 'function') result = adapter.getMlegitymacja(doc);
    } catch (e) { /* keep default */ }
    data.mlegitymacjaResult = result;
    data.mlegitymacjaResultLoaded = true;
    return result;
  }
  window.USOSPP_SCRAPE = { collectAll, collectAnon, fetchDoc, PATHS, searchCatalog, refreshNews, refreshPersonalCalendar, fetchRejSubjects, fetchRejGroups, fetchGroupDetails, fetchGroupParticipants, fetchParticipantsResult, fetchExamsResult, fetchRegistrationsResult, fetchEtapDetailsResult, fetchStageSubjectsResult, fetchMlegitymacjaResult };
})();

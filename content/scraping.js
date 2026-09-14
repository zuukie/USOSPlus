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
    zaliczenia: 'kontroler.php?_action=dla_stud/studia/zaliczenia/index',
    oceny: 'kontroler.php?_action=dla_stud/studia/oceny/index',
    plan: 'kontroler.php?_action=home/plan',
    egzaminy: 'kontroler.php?_action=dla_stud/rejestracja/egzaminy',
    // University-wide announcements — also the site's own landing page
    // (news/default), verified against real markup: a repeating sequence of
    // sibling .title-wrapper-section / plain content divs inside .wrtext
    // (see adapter.getNews).
    news: 'kontroler.php?_action=news/default',
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
    // Faculty-wide registration calendar — needs the jednostka code, which
    // varies per student/university, so it's a function rather than a
    // static path (see adapter.getUser().facultyCode).
    rejestracje(kod) {
      return `kontroler.php?_action=news/rejestracje/rejJednostki&jed_org_kod=${encodeURIComponent(kod)}`;
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
  };

  async function fetchJson(path) {
    try {
      const res = await fetch(path, { credentials: 'same-origin' });
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
    const [subjectsByName, subjectsByCode, unitsJson, programsJson] = await Promise.all([
      fetchJson(PATHS.searchSubjects(pattern)),
      fetchJson(PATHS.searchSubjectsByCode(pattern)),
      fetchJson(PATHS.searchUnits(pattern)),
      fetchJson(PATHS.searchPrograms(pattern)),
    ]);
    // Merge by kod — a code query can occasionally also turn up in the
    // name results (or vice versa), and the two sets shouldn't show the
    // same subject twice.
    const subjectsByKod = new Map();
    (subjectsByName && subjectsByName.wyniki ? Object.values(subjectsByName.wyniki) : []).forEach((s) => subjectsByKod.set(s.kod, s));
    (subjectsByCode && subjectsByCode.wyniki ? Object.values(subjectsByCode.wyniki) : []).forEach((s) => subjectsByKod.set(s.kod, s));
    return {
      subjects: [...subjectsByKod.values()],
      units: unitsJson && unitsJson.wyniki ? Object.values(unitsJson.wyniki) : [],
      programs: programsJson && programsJson.wyniki ? Object.values(programsJson.wyniki) : [],
    };
  }

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

  async function collectAll(adapter) {
    const [
      homeDoc, zaliczeniaDoc, ocenyDoc, planDoc, zapisyHubDoc, newsDoc,
      platnosciNierozDoc, planyRatalneDoc, wplatyDoc, wplatyNierozDoc, kontaBankoweDoc,
      stypendiaDoc, sprawdzianyDoc, podaniaDoc, ankietyDoc,
    ] = await Promise.all([
      fetchDoc(PATHS.home),
      fetchDoc(PATHS.zaliczenia),
      fetchDoc(PATHS.oceny),
      fetchDoc(PATHS.plan),
      fetchDoc(PATHS.zapisyHub),
      fetchDoc(PATHS.news),
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
    const ownProgrammesResult = zapisyHubDoc
      ? adapter.getOwnProgrammes(zapisyHubDoc)
      : { supported: false, verified: false, programmes: [] };
    const newsResult = newsDoc
      ? adapter.getNews(newsDoc)
      : { supported: false, verified: false, items: [] };

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

    let examsResult = { supported: false, verified: false, exams: [] };
    try {
      const examsDoc = await fetchExamsDoc();
      if (examsDoc) examsResult = adapter.getExams(examsDoc);
    } catch (e) {
      // leave examsResult as the unsupported default
    }

    let registrationsResult = { supported: false, verified: false, groups: [] };
    if (user && user.facultyCode) {
      try {
        const regDoc = await fetchDoc(PATHS.rejestracje(user.facultyCode));
        if (regDoc) registrationsResult = adapter.getRegistrationRounds(regDoc);
      } catch (e) {
        // leave registrationsResult as the unsupported default
      }
    }

    let stageSubjectsResult = { supported: false, verified: false, stages: [] };
    if (ownProgrammesResult.supported) {
      try {
        const stageDocs = await Promise.all(
          ownProgrammesResult.programmes.map((p) => fetchDoc(PATHS.stageSubjects(p.prgKod, p.etpKod)))
        );
        const stages = ownProgrammesResult.programmes
          .map((p, i) => {
            const doc = stageDocs[i];
            if (!doc) return null;
            return { ...p, ...adapter.getStageSubjects(doc) };
          })
          .filter(Boolean);
        stageSubjectsResult = { supported: stages.length > 0, verified: true, stages };
      } catch (e) {
        // leave stageSubjectsResult as the unsupported default
      }
    }

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
      user, etapyResult, gradesResult, planResult, examsResult, registrationsResult,
      ownProgrammesResult, stageSubjectsResult, newsResult, paymentsResult,
      scholarshipsResult, testsResult, petitionsResult, surveysResult,
    };
  }

  window.USOSPP_SCRAPE = { collectAll, fetchDoc, PATHS, searchCatalog };
})();

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
    const [homeDoc, zaliczeniaDoc, ocenyDoc, planDoc, zapisyHubDoc, newsDoc] = await Promise.all([
      fetchDoc(PATHS.home),
      fetchDoc(PATHS.zaliczenia),
      fetchDoc(PATHS.oceny),
      fetchDoc(PATHS.plan),
      fetchDoc(PATHS.zapisyHub),
      fetchDoc(PATHS.news),
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

    return { user, etapyResult, gradesResult, planResult, examsResult, registrationsResult, ownProgrammesResult, stageSubjectsResult, newsResult };
  }

  window.USOSPP_SCRAPE = { collectAll, fetchDoc, PATHS };
})();

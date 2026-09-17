// The USOS++ redesign SPA. Ported from the approved design (design/USOS++.dc.html)
// onto vanilla DOM APIs — no inline `onclick="..."` attributes, since content
// scripts run in an isolated JS world and inline handler strings are looked
// up in the *page's* world, not ours. Every interaction goes through a single
// delegated click/change listener keyed off `data-action`.
//
// IMPORTANT product decision: the original design mockup used fabricated
// demo numbers (4.32 average, 120/210 ECTS, sample classes...) to show what
// the UI *could* look like. This build only ever renders real scraped data
// or an honest empty/"not verified yet" state — never placeholder numbers
// dressed up as real ones. Several sections (Plan, Oceny, Egzaminy) rely on
// USOS markup we could only observe empty during development; they degrade
// to a generic/raw view with a link back to classic USOSweb rather than
// pretending to understand a structure we haven't confirmed.
(function () {
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtGrade(raw) {
    if (raw === null || raw === undefined) return null;
    const m = String(raw).replace(',', '.').match(/[0-9]([.,][0-9])?/);
    return m ? m[0].replace(',', '.') : null;
  }

  function gradeBadge(gradeStr) {
    const n = parseFloat(gradeStr);
    if (Number.isNaN(n)) return { bg: 'var(--bg-subtle)', color: 'var(--ink-3)' };
    if (n >= 4.5) return { bg: 'oklch(90% 0.08 150)', color: 'oklch(35% 0.1 150)' };
    if (n >= 3.5) return { bg: 'oklch(92% 0.03 45)', color: 'oklch(40% 0.13 45)' };
    return { bg: 'oklch(92% 0.06 80)', color: 'oklch(42% 0.1 70)' };
  }

  // The mini widget uses 2-letter abbreviations (PN, WT…), the richer
  // per-subject plan page uses full Polish weekday names, and the planner's
  // group listings use lowercase nominative day words ("poniedziałek") —
  // shared by renderSubjectTimetable and the schedule planner so both agree
  // on column order regardless of which source backs a given entry.
  const DAY_KEYS = ['PN', 'WT', 'ŚR', 'CZ', 'PT', 'SO', 'ND'];
  const DAY_ALIASES = {
    PONIEDZIAŁEK: 'PN', WTOREK: 'WT', ŚRODA: 'ŚR', CZWARTEK: 'CZ',
    PIĄTEK: 'PT', SOBOTA: 'SO', NIEDZIELA: 'ND',
  };
  function shortDay(label) {
    const key = (label || '').toUpperCase();
    if (DAY_KEYS.includes(key)) return key;
    return DAY_ALIASES[key] || label;
  }
  function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }

  // "P"/"N" per USOS's own convention (see the legend text on a full plan
  // page: "tydzień parzysty (P)" / "tydzień nieparzysty (N)") — not
  // something we invented. `null` for a weekly class (`weeks === 'every'`
  // or missing, e.g. from the subject page's mini timetable, which never
  // carries this — see adapters.js's parseTimetable comment).
  function weeksLabel(weeks) {
    if (weeks === 'even') return 'P';
    if (weeks === 'odd') return 'N';
    return null;
  }

  // Two sessions overlapping in time only conflict if they could actually
  // land on the same real week — opposite, KNOWN parity (one odd, one
  // even) never does. Anything else (same parity, or either side unknown/
  // weekly) is treated as a real possible conflict, since we'd rather flag
  // a false positive than silently hide a true one.
  function sessionsOverlap(a, b) {
    if ((a.weeks === 'odd' && b.weeks === 'even') || (a.weeks === 'even' && b.weeks === 'odd')) return false;
    return toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);
  }

  // Assigns each subject in the planner a distinct hue, one per integer
  // index (see plannerColorSeed) rather than picking from a short fixed
  // list — a small palette runs out and starts repeating colours on
  // unrelated subjects once there are more subjects than list entries.
  // Stepping the hue wheel by the golden angle (~137.5°) instead keeps
  // consecutive indices visually far apart and never exactly repeats a hue
  // for any realistic number of subjects.
  const GOLDEN_ANGLE = 137.508;
  function hashStr(str) {
    let h = 0;
    for (let i = 0; i < (str || '').length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return h;
  }
  function subjectColor(seed, dark) {
    const hue = ((seed * GOLDEN_ANGLE) % 360 + 360) % 360;
    return dark
      ? { bg: `oklch(36% 0.09 ${hue})`, time: `oklch(80% 0.06 ${hue})`, label: `oklch(90% 0.05 ${hue})`, meta: `oklch(76% 0.06 ${hue})` }
      : { bg: `oklch(85% 0.08 ${hue})`, time: `oklch(38% 0.12 ${hue})`, label: `oklch(30% 0.14 ${hue})`, meta: `oklch(40% 0.1 ${hue})` };
  }

  function shortClassType(label) {
    const s = (label || '').toLowerCase();
    if (/laborator/.test(s)) return 'L';
    if (/wykład/.test(s)) return 'W';
    if (/ćwiczen/.test(s)) return 'C';
    if (/seminari/.test(s)) return 'S';
    if (/projekt/.test(s)) return 'P';
    if (/lektorat/.test(s)) return 'LE';
    return (label || '?').trim().charAt(0).toUpperCase() || '?';
  }

  // USOS appends a rotating `callback=` token to every katalog2 subject
  // link — re-fetching the exact same "Przedmioty" listing twice in a row
  // yields two different tokens (verified live). The real, stable identity
  // is the `prz_kod` query param, so anything that needs to recognize "the
  // same subject" across a page reload (matching a saved pick back to its
  // row, grouping picks, picking a stable colour) must key off this, not
  // off the raw URL string — otherwise a reopened subject looks like it has
  // no picks at all, and re-selecting "the same" group creates a second,
  // overlapping pick instead of replacing the first.
  function subjectId(url) {
    try {
      return new URL(url, location.origin).searchParams.get('prz_kod') || url;
    } catch (e) {
      return url;
    }
  }

  // Identifies "one class type within one subject's cycle" — used both as
  // the planner's draft-selection key and as each saved pick's `key`, so a
  // second choice for the same class type replaces the first rather than
  // duplicating it.
  function classTypeKey(subjectUrl, cycleName, classTypeLabel) {
    return `${subjectId(subjectUrl)}::${cycleName}::${classTypeLabel}`;
  }

  // Converts one {variable, group} entry from a generated candidate
  // (window.USOSPP_GENERATOR's output) into the exact same pick shape
  // plannerAddSubject builds for a manually-configured subject — so a
  // generated-then-saved plan is byte-for-byte indistinguishable from one
  // built by hand, and every existing planner function (plannerPicksBySubject,
  // renderPlannerGrid, plannerRemovePick…) handles it with zero special-casing.
  function pickFromAssignment({ variable, group }) {
    return {
      key: classTypeKey(variable.subjectUrl, variable.cycleName, variable.classTypeLabel),
      subjectUrl: variable.subjectUrl,
      subjectName: variable.subjectName,
      cycleName: variable.cycleName,
      classTypeLabel: variable.classTypeLabel,
      classTypeShort: variable.classTypeShort,
      nr: group.nr,
      sessions: group.sessions,
      teacher: group.teacher,
      occupancy: group.occupancy,
      detailsUrl: group.detailsUrl,
    };
  }

  // Extracts the short building code (e.g. "D-1") out of a place string
  // like "Budynek dydaktyczny [D-2], sala 333a" — the bracketed code is
  // what students actually navigate by, the full building name is just
  // clutter next to it.
  function buildingCode(place) {
    const m = /\[([^\]]+)\]/.exec(place || '');
    return m ? m[1] : null;
  }

  // Condenses "Budynek dydaktyczno-laboratoryjny [C-6], sala 130" down to
  // "C-6, sala 130" — same information a student actually needs to find the
  // room, without the long descriptive building name.
  function shortPlace(place) {
    if (!place) return null;
    const code = buildingCode(place);
    const roomMatch = /sala\s*([^\s,]+)/i.exec(place);
    const room = roomMatch ? `sala ${roomMatch[1]}` : null;
    return [code, room].filter(Boolean).join(', ') || place;
  }

  // getOwnProgrammes can return more than one programme stage at once (see
  // its own comment — USOS opens next-semester subjects for early browsing
  // well before the student is actually assigned to that semester), so
  // getStageSubjects' "active in current cycle" filter alone isn't enough
  // to keep a future semester's subjects out of the planner's candidate
  // list. Cycle codes ("2026/27-Z" winter, "2026/27-L" summer) sort
  // chronologically once parsed into (year, term) — the stage(s) with the
  // earliest cycle are treated as "currently assigned"; anything later is
  // a future semester and gets left out, with a note explaining why rather
  // than silently vanishing.
  function cycleRank(label) {
    const m = /^(\d{4})\/(\d{2})-([ZL])$/.exec(label || '');
    return m ? parseInt(m[1], 10) * 2 + (m[3] === 'Z' ? 0 : 1) : null;
  }
  function stageCycleLabel(stage) {
    const label = (stage.sections || []).map((sec) => sec.currentCycleLabel).find(Boolean);
    return label || null;
  }

  const NAV_ITEMS = [
    { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
    { id: 'aktualnosci', label: 'Aktualności', icon: 'bell' },
    { id: 'plan', label: 'Plan zajęć', icon: 'calendar' },
    { id: 'oceny', label: 'Oceny', icon: 'bars' },
    { id: 'przedmioty', label: 'Przedmioty', icon: 'book' },
    { id: 'egzaminy', label: 'Egzaminy', icon: 'check' },
    { id: 'sprawdziany', label: 'Sprawdziany', icon: 'clipboard' },
    { id: 'ects', label: 'ECTS / Postęp', icon: 'ring' },
  ];

  // Lower-traffic sections tucked behind the collapsible "Więcej" row in the
  // sidebar (see renderSidebar) instead of each getting a permanent
  // top-level slot. Mapa leads this group: it's reachable by search as
  // often as by the sidebar, and it works logged out unlike the rest.
  const MORE_NAV_ITEMS = [
    { id: 'katalog', label: 'Katalog', icon: 'layers' },
    { id: 'mapa', label: 'Mapa', icon: 'pin' },
    { id: 'platnosci', label: 'Płatności', icon: 'card' },
    { id: 'stypendia', label: 'Stypendia', icon: 'coins' },
    { id: 'podania', label: 'Podania', icon: 'send' },
    { id: 'ankiety', label: 'Ankiety', icon: 'star' },
    // USOSmail's own UI is 100% client-rendered against an internal,
    // CSRF-walled endpoint whose own error message says not to use it as an
    // API — and every USOSweb page sends X-Frame-Options: deny, so it can't
    // even be embedded in an iframe. No legitimate way to show it in our own
    // UI, so this is a pure link-out (see renderSidebar) rather than a real
    // nav view: it never becomes the active view and isn't in VALID_VIEWS.
    { id: 'wiadomosci', label: 'Wiadomości', icon: 'mail', external: 'kontroler.php?_action=home/usos_mail/nowaWiadomosc&usospp_off=1' },
  ];

  // Temporarily hidden from the sidebar (the views aren't reliable yet) —
  // see docs/hidden-nav-items.md. Everything behind them stays intact:
  // VALID_VIEWS, TITLES, renderers, scraping and fetches, so a hidden view
  // still works when opened directly (e.g. a sessionStorage restore after a
  // reload) and comes back to the menu by just removing its id from this set.
  const HIDDEN_NAV_ITEMS = new Set(['stypendia', 'podania', 'ankiety']);

  // "przedmioty" is a hub tile screen — Przegląd/Zapisy/Generator planu live
  // one level under it now instead of each having their own nav row. A nav
  // item should still read as "active" while the user is anywhere inside its
  // group (including a subject-detail page opened from within it), even
  // though only the hub id itself appears in NAV_ITEMS.
  const NAV_GROUPS = {
    przedmioty: ['przedmioty', 'przedmiotyLista', 'zapisy', 'planer'],
    katalog: ['katalog', 'katalogJednostki', 'katalogPrzedmioty', 'katalogKierunki', 'katalogBudynki'],
  };

  // Per-view list of `this.data` result keys whose *shape* — not just
  // whether the fetch itself succeeded — hasn't been confirmed against real
  // populated USOS markup yet (see the "UNVERIFIED" comments on
  // adapter.getPlan/getGrades/getExams and adapter.genericInfoTable). Drives
  // renderBetaNotice: a view shows the banner whenever one of its sources
  // actually has data (`supported`) that we're not yet sure we parsed
  // correctly (`!verified`), rather than every reviewer having to remember
  // to wire up a warning by hand on each new unverified page.
  const UNVERIFIED_SOURCES = {
    dashboard: ['gradesResult', 'planResult', 'examsResult'],
    plan: ['planResult'],
    oceny: ['gradesResult'],
    egzaminy: ['examsResult'],
    stypendia: ['scholarshipsResult'],
    sprawdziany: ['testsResult'],
    podania: ['petitionsResult'],
    ankiety: ['surveysResult'],
  };

  // A plain document reload (classic USOSweb navigation, not an SPA route
  // change) tears down and re-mounts the whole App, which used to always
  // land back on the dashboard. sessionStorage survives a reload of the same
  // tab but clears when the tab actually closes — exactly "stay where you
  // were" semantics, without a freshly opened USOS tab inheriting whatever
  // section a *different* tab last looked at (chrome.storage would do that).
  const VIEW_STORAGE_KEY = 'usospp_lastView';
  const VALID_VIEWS = new Set([
    ...NAV_ITEMS.filter((item) => !item.external).map((item) => item.id),
    ...MORE_NAV_ITEMS.filter((item) => !item.external).map((item) => item.id),
    'przedmiotyLista', 'zapisy', 'planer', 'ustawienia', 'subjectPage', 'catalogPage',
  ]);

  // Views that render entirely from pages USOSweb also serves to anonymous
  // visitors (news; the search→katalog2 subject/unit/program pages; campus
  // buildings), so they keep working while logged out — everything else in
  // this.data is personal and falls back to the login prompt (renderView).
  // The topbar's search overlay isn't a view and needs no entry here.
  const PUBLIC_VIEWS = new Set(['aktualnosci', 'subjectPage', 'catalogPage', 'mapa', 'katalog', 'katalogJednostki', 'katalogPrzedmioty', 'katalogKierunki', 'katalogBudynki']);

  // "Is there a new announcement since I last opened Aktualności" — chrome
  // .storage.local (device-local, not synced, survives tab close unlike
  // sessionStorage) remembers a signature of the titles shown last time the
  // user actually visited the page; any mismatch means something changed.
  // Keyed by origin so a future second-university install (see
  // background.js's registerUniversity) doesn't mix the two up.
  const NEWS_SEEN_KEY = 'usospp:newsSeenSignature:' + location.origin;
  function newsSignature(newsResult) {
    return ((newsResult && newsResult.items) || []).map((it) => it.title).join('|');
  }

  function saveViewState(payload) {
    try { sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(payload)); } catch (e) { /* private mode etc. */ }
  }

  function loadViewState() {
    try {
      const raw = sessionStorage.getItem(VIEW_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  const ICONS = {
    grid: '<rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.5"></rect><rect x="11" y="2.5" width="6.5" height="6.5" rx="1.5"></rect><rect x="2.5" y="11" width="6.5" height="6.5" rx="1.5"></rect><rect x="11" y="11" width="6.5" height="6.5" rx="1.5"></rect>',
    calendar: '<rect x="2.5" y="3.5" width="15" height="14" rx="2"></rect><line x1="2.5" y1="8" x2="17.5" y2="8"></line><line x1="6.5" y1="2" x2="6.5" y2="5"></line><line x1="13.5" y1="2" x2="13.5" y2="5"></line>',
    bars: '<line x1="4" y1="16" x2="4" y2="9"></line><line x1="10" y1="16" x2="10" y2="4"></line><line x1="16" y1="16" x2="16" y2="12"></line>',
    book: '<rect x="3" y="2.5" width="12" height="15" rx="1.5"></rect><rect x="6" y="4.5" width="9" height="13" rx="1.5" fill="var(--bg-page)"></rect><line x1="8.5" y1="8" x2="12.5" y2="8"></line><line x1="8.5" y1="11" x2="12.5" y2="11"></line>',
    check: '<circle cx="10" cy="10" r="7.2"></circle><path d="M6.8 10.2l2 2 4.2-4.4"></path>',
    ticket: '<path d="M3 7.3a1.6 1.6 0 0 1 1.6-1.6h10.8A1.6 1.6 0 0 1 17 7.3v1a1.3 1.3 0 0 0 0 2.4v1a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 11.7v-1a1.3 1.3 0 0 0 0-2.4v-1z"></path><line x1="10" y1="6" x2="10" y2="14" stroke-dasharray="1.6 1.6"></line>',
    layers: '<path d="M10 3l7 3.6-7 3.6-7-3.6L10 3z"></path><path d="M3 10.4l7 3.6 7-3.6"></path><path d="M3 14l7 3.6 7-3.6"></path>',
    ring: '<circle cx="10" cy="10" r="7.2" stroke-opacity="0.35"></circle><path d="M10 2.8a7.2 7.2 0 0 1 5.1 12.3"></path>',
    bell: '<path d="M5 8.2a5 5 0 0 1 10 0c0 3.6 1.3 4.8 1.3 4.8H3.7S5 11.8 5 8.2z"></path><path d="M8.2 15.6a1.9 1.9 0 0 0 3.6 0"></path>',
    card: '<rect x="2" y="4.5" width="16" height="11" rx="2"></rect><line x1="2" y1="8" x2="18" y2="8"></line><line x1="5" y1="12.5" x2="9" y2="12.5"></line>',
    mail: '<rect x="2" y="4" width="16" height="12" rx="2"></rect><path d="M3 5.5l7 5.5 7-5.5"></path>',
    settings: '<line x1="3" y1="5" x2="17" y2="5"></line><circle cx="12" cy="5" r="1.8" fill="var(--bg-page)"></circle><line x1="3" y1="10" x2="17" y2="10"></line><circle cx="7" cy="10" r="1.8" fill="var(--bg-page)"></circle><line x1="3" y1="15" x2="17" y2="15"></line><circle cx="14" cy="15" r="1.8" fill="var(--bg-page)"></circle>',
    close: '<line x1="5" y1="5" x2="15" y2="15"></line><line x1="15" y1="5" x2="5" y2="15"></line>',
    coins: '<circle cx="7.5" cy="8" r="4.3"></circle><circle cx="12.5" cy="12" r="4.3"></circle>',
    clipboard: '<rect x="4" y="3.5" width="12" height="14" rx="1.5"></rect><rect x="7" y="2" width="6" height="3" rx="1"></rect><line x1="6.5" y1="9" x2="13.5" y2="9"></line><line x1="6.5" y1="12.5" x2="13.5" y2="12.5"></line>',
    send: '<path d="M3 10l14-6.5-5.5 14-2.3-6.2L3 10z"></path>',
    star: '<path d="M10 2.8l2.2 4.6 5 .7-3.6 3.6.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.6 5-.7L10 2.8z"></path>',
    more: '<circle cx="5" cy="10" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="15" cy="10" r="1.3" fill="currentColor" stroke="none"></circle>',
    chevron: '<path d="M7.5 5l5.5 5-5.5 5" stroke-width="2"></path>',
    pin: '<path d="M10 2.6c-3.3 0-6 2.6-6 5.9 0 4.4 6 9.1 6 9.1s6-4.7 6-9.1c0-3.3-2.7-5.9-6-5.9z"></path><circle cx="10" cy="8.3" r="2.1"></circle>',
    lock: '<rect x="5" y="9" width="10" height="7.5" rx="1.5"></rect><path d="M7 9V6.3a3 3 0 0 1 6 0V9"></path>',
  };

  function icon(name, size = 19) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">${ICONS[name] || ''}</svg>`;
  }

  // Sub-pages one level under a nav hub (przedmiotyLista/zapisy/planer under
  // "Przedmioty", or a subject-detail page under whatever it was opened from)
  // no longer have their own persistent sidebar row, so they need this to get
  // back up a level.
  function backLink(viewId, label = '← Wróć') {
    return `<a data-action="nav" data-view="${esc(viewId)}" class="usospp-back-link">${esc(label)}</a>`;
  }

  // Every "open in classic USOS" link needs ?usospp_off=1 or the redesign
  // (still globally enabled for the domain) just mounts right back on top
  // of whatever page it opens, hiding the real content again — easy to
  // forget on a URL that came straight from a scraped href rather than one
  // built here with the param already on it, so the click handler adds it
  // centrally instead of relying on every call site to remember.
  function withUsospOff(url) {
    if (!url || /(?:^|[?&])usospp_off=/.test(url)) return url;
    return url + (url.includes('?') ? '&' : '?') + 'usospp_off=1';
  }

  // One row from adapter.getPaymentGroups — its `fields` are whatever
  // columns that particular USOS page happened to render (label -> text),
  // not a fixed shape, so this picks a sensible "title" (the free-text
  // description if there is one, else the fee category) and an "amount"
  // badge out of whatever's there instead of assuming column positions.
  function renderPaymentRow(row) {
    const entries = Object.entries(row.fields || {}).filter(([, v]) => v);
    if (!entries.length) return '';
    const amountEntry = entries.find(([label]) => /kwota|pozosta|należn/i.test(label));
    const titleEntry = entries.find(([label]) => /opis/i.test(label))
      || entries.find(([label]) => /rodzaj/i.test(label))
      || entries[0];
    const metaEntries = entries.filter(([label]) => label !== titleEntry[0] && (!amountEntry || label !== amountEntry[0]));
    return `
      <div class="usospp-list-row" style="align-items:flex-start;">
        <div>
          <div style="font-size:13.5px;font-weight:600;">${esc(titleEntry[1])}</div>
          ${metaEntries.length ? `<div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${metaEntries.map(([label, value]) => `${esc(label)}: ${esc(value)}`).join(' · ')}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0;">
          ${amountEntry ? `<div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(amountEntry[1])}</div>` : ''}
          ${row.detailsUrl ? `<div style="margin-top:6px;"><a data-action="openPaymentDetails" data-url="${esc(row.detailsUrl)}" style="font-size:12px;font-weight:600;color:#d9773a;cursor:pointer;">szczegóły →</a></div>` : ''}
        </div>
      </div>
    `;
  }

  // One row from adapter.genericInfoTable (stypendia/sprawdziany/podania/
  // ankiety) — same "unknown columns, pick a sensible title/status out of
  // whatever's there" approach as renderPaymentRow, just without a payments-
  // details modal to open: we haven't built dedicated detail-page scraping
  // for these four, so "szczegóły" simply links out to classic USOS.
  function renderInfoTableRow(row) {
    const entries = Object.entries(row.fields || {}).filter(([, v]) => v);
    if (!entries.length) return '';
    const statusEntry = entries.find(([label]) => /status|rozpatrzeni|stan/i.test(label));
    const titleEntry = entries.find(([label]) => /nazwa|rodzaj|opis|przedmiot|tytuł/i.test(label)) || entries[0];
    const metaEntries = entries.filter(([label]) => label !== titleEntry[0] && (!statusEntry || label !== statusEntry[0]));
    return `
      <div class="usospp-list-row" style="align-items:flex-start;">
        <div>
          <div style="font-size:13.5px;font-weight:600;">${esc(titleEntry[1])}</div>
          ${metaEntries.length ? `<div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${metaEntries.map(([label, value]) => `${esc(label)}: ${esc(value)}`).join(' · ')}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0;">
          ${statusEntry ? `<div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(statusEntry[1])}</div>` : ''}
          ${row.detailsUrl ? `<div style="margin-top:6px;"><a data-action="openUsos" data-url="${esc(row.detailsUrl)}" style="font-size:12px;font-weight:600;color:#d9773a;cursor:pointer;">szczegóły →</a></div>` : ''}
        </div>
      </div>
    `;
  }

  // One organizational unit's dues/payments (see adapter.getPaymentGroups) —
  // USOS bills/pays through several units (dziekanat, akademik, …), each
  // getting its own little labeled block with its own subtotal.
  function renderPaymentGroup(group) {
    return `
      <div style="margin-bottom:16px;">
        ${group.unitLabel ? `<div style="font-size:12px;font-weight:600;color:var(--ink-3);margin-bottom:6px;">${esc(group.unitLabel)}</div>` : ''}
        ${group.rows.map(renderPaymentRow).join('')}
        ${group.total ? `<div style="font-size:12px;color:var(--ink-3);text-align:right;margin-top:6px;">${esc(group.total)}</div>` : ''}
      </div>
    `;
  }

  // USOS++ mark per the brand system: a rounded orange tile (23% radius) with
  // two bold white "+" glyphs (59% of tile width, 16% inner gap). Below 32px
  // the tile radius shrinks and the gap widens (tracking -> 0) so the two
  // pluses don't visually merge — that's the "compact" variant.
  const LOGO_TILE_MASTER = '<rect x="0" y="0" width="100" height="100" rx="23" fill="#d9773a"/><rect x="27.7" y="36.25" width="7.1" height="21.5" rx="1.99" fill="#fff"/><rect x="20.5" y="43.45" width="21.5" height="7.1" rx="1.99" fill="#fff"/><rect x="65.2" y="36.25" width="7.1" height="21.5" rx="1.99" fill="#fff"/><rect x="58" y="43.45" width="21.5" height="7.1" rx="1.99" fill="#fff"/>';
  const LOGO_TILE_COMPACT = '<rect x="0" y="0" width="100" height="100" rx="18" fill="#d9773a"/><rect x="26.42" y="37.75" width="6.66" height="18.5" rx="1.87" fill="#fff"/><rect x="20.5" y="43.67" width="18.5" height="6.66" rx="1.87" fill="#fff"/><rect x="66.92" y="37.75" width="6.66" height="18.5" rx="1.87" fill="#fff"/><rect x="61" y="43.67" width="18.5" height="6.66" rx="1.87" fill="#fff"/>';
  function logoSvg(compact) {
    return `<svg viewBox="0 0 100 100" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">${compact ? LOGO_TILE_COMPACT : LOGO_TILE_MASTER}</svg>`;
  }

  const TITLES = {
    dashboard: ['Dashboard', 'Podsumowanie'],
    aktualnosci: ['Aktualności', 'Ogłoszenia i komunikaty z USOSweb'],
    plan: ['Plan zajęć', 'Bieżący tydzień'],
    oceny: ['Oceny', 'Aktualny widok z USOSweb'],
    przedmioty: ['Przedmioty', 'Przegląd, zapisy i generator planu'],
    przedmiotyLista: ['Przegląd przedmiotów', 'Na podstawie danych z USOSweb'],
    zapisy: ['Zapisy', 'Rejestracja na przedmioty — kalendarz wydziałowy'],
    planer: ['Generator planu', 'Podgląd — niczego tu nie zapisujemy w USOS'],
    egzaminy: ['Egzaminy', 'Zapisy i wyniki sesji'],
    ects: ['ECTS / Postęp', 'Realizacja programu studiów'],
    platnosci: ['Płatności', 'Należności, wpłaty i konta bankowe'],
    stypendia: ['Stypendia', 'Wypłaty i decyzje stypendialne'],
    sprawdziany: ['Sprawdziany', 'Zasady rozliczania przedmiotów'],
    podania: ['Podania', 'Złożone wnioski i ich rozpatrzenie'],
    ankiety: ['Ankiety', 'Ankiety do wypełnienia'],
    ustawienia: ['Ustawienia', 'Profil, wygląd i powiadomienia'],
    subjectPage: ['Przedmiot', 'Szczegóły z katalogu USOS'],
    catalogPage: ['Katalog', 'Szczegóły z katalogu USOS'],
    katalog: ['Katalog', 'Jednostki, przedmioty, kierunki i budynki'],
    katalogJednostki: ['Jednostki', 'Przeglądaj strukturę uczelni'],
    katalogPrzedmioty: ['Przedmioty', 'Oferta przedmiotów wg jednostek'],
    katalogKierunki: ['Kierunki i programy', 'Co można studiować i w jakich trybach'],
    katalogBudynki: ['Budynki', 'Lista budynków — dane z USOS'],
    mapa: ['Mapa kampusu', 'Budynki na mapie — dane z USOS'],
  };

  class App {
    constructor(root, data, initialSettings) {
      this.root = root;
      this.data = data;
      this.settings = initialSettings; // { darkMode, features }

      const saved = loadViewState();
      let initialView = 'dashboard';
      let initialSubjectUrl = null;
      let initialSubjectBackView = 'przedmiotyLista';
      let initialCatalogKind = null;
      let initialCatalogKod = null;
      let initialCatalogEtpKod = null;
      let initialCatalogBackView = 'dashboard';
      let initialCatalogPrevKind = null;
      let initialCatalogPrevKod = null;
      if (saved && VALID_VIEWS.has(saved.view)) {
        if (saved.view === 'subjectPage') {
          if (saved.subjectUrl) {
            initialView = 'subjectPage';
            initialSubjectUrl = saved.subjectUrl;
            initialSubjectBackView = (saved.subjectBackView && VALID_VIEWS.has(saved.subjectBackView) && saved.subjectBackView !== 'subjectPage')
              ? saved.subjectBackView
              : 'przedmiotyLista';
          }
        } else if (saved.view === 'catalogPage') {
          const validKind = saved.catalogKind === 'unit' || saved.catalogKind === 'program'
            || (saved.catalogKind === 'stage' && !!saved.catalogEtpKod);
          if (saved.catalogKod && validKind) {
            initialView = 'catalogPage';
            initialCatalogKind = saved.catalogKind;
            initialCatalogKod = saved.catalogKod;
            initialCatalogEtpKod = saved.catalogKind === 'stage' ? saved.catalogEtpKod : null;
            initialCatalogBackView = (saved.catalogBackView && VALID_VIEWS.has(saved.catalogBackView) && saved.catalogBackView !== 'catalogPage')
              ? saved.catalogBackView
              : 'dashboard';
            // A page opened from another catalog page remembers where
            // "Wróć" should land — the live snapshot (see openCatalogPage)
            // can't survive a reload, but {kind, kod} does, enough to
            // re-open that page.
            if ((saved.catalogKind === 'unit' || saved.catalogKind === 'program')
              && (saved.catalogBackPrevKind === 'unit' || saved.catalogBackPrevKind === 'program')) {
              initialCatalogPrevKind = saved.catalogBackPrevKind;
              initialCatalogPrevKod = saved.catalogBackPrevKod || null;
            }
          }
        } else {
          initialView = saved.view;
        }
      }

      this.state = {
        view: initialView,
        notifPanelOpen: false,
        avatarMenuOpen: false,
        moreExpanded: false,
        dismissedBetaViews: [],
        newsHasUpdate: false,
        paymentDetailsOpen: false,
        paymentDetailsLoading: false,
        paymentDetailsError: false,
        paymentDetailsData: null,
        groupsModalOpen: false,
        groupsModalLoading: false,
        groupsModalError: false,
        groupsModalData: null,
        groupsModalTitle: '',
        linksModalOpen: false,
        linksModalTitle: '',
        linksModalLinks: [],
        calcAvg: '',
        calcEcts: '',
        calcGrade: '5.0',
        calcNewEcts: '5',
        zapisyFilter: '',
        zapisyOwnOnly: true,
        subjectBackView: initialSubjectBackView,
        subjectUrl: initialSubjectUrl,
        subjectLoading: initialView === 'subjectPage',
        subjectError: false,
        subjectData: null,
        catalogKind: initialCatalogKind,
        catalogKod: initialCatalogKod,
        catalogEtpKod: initialCatalogEtpKod,
        catalogBackView: initialCatalogBackView,
        catalogLoading: initialView === 'catalogPage',
        catalogError: false,
        catalogData: null,
        catalogBuildings: [],
        catalogSubjects: [],
        catalogSubjectsTotal: 0,
        catalogSubjectsNextUrl: null,
        catalogSubjectsLoading: false,
        catalogSubjectQuery: '',
        catalogSubjectsCurrentOnly: false,
        catalogPrograms: [],
        catalogProgramsNextUrl: null,
        catalogProgramsLoading: false,
        catalogBackSnapshot: null,
        catalogBackPrevKind: initialCatalogPrevKind,
        catalogBackPrevKod: initialCatalogPrevKod,
        katalogRootKod: null,
        katalogRootLoading: false,
        katalogRootError: false,
        katalogRootData: null,
        katalogBrowseKod: null,
        katalogBrowseLoading: false,
        katalogBrowseError: false,
        katalogBrowseData: null,
        katalogPrzedmiotyUnitKod: null,
        katalogPrzedmiotyLoading: false,
        katalogPrzedmioty: [],
        katalogPrzedmiotyTotal: 0,
        katalogPrzedmiotyNextUrl: null,
        katalogPrzedmiotyQuery: '',
        katalogPrzedmiotyCurrentOnly: false,
        katalogKierunkiUnitKod: null,
        katalogKierunkiLoading: false,
        katalogKierunki: [],
        katalogKierunkiNextUrl: null,
        katalogBudynkiQuery: '',
        mapaLoading: false,
        mapaError: false,
        mapaBuildings: [],
        mapaUnitFilter: '', // a unitKod, not display text — several units share a display name (see getBuildingsForUnit)
        mapaFocusKod: null, // pending "pan the campus map to this building" request from the topbar search — see openMapaFocused
        mapaSearchQuery: '',
        searchQuery: '',
        searchLoading: false,
        searchResults: null,
        plannerExpandedUrl: null,
        plannerSubjectCache: {},
        plannerSubjectLoading: null,
        plannerGroupsCache: {},
        plannerDraftSelection: {},
        // classTypeKey -> { groupsUrl, classTypeLabel }: class types of the
        // currently-expanded subject whose EVERY group is drawn on the grid
        // as a hoverable "what if" ghost ("podgląd w planie"), see
        // plannerTogglePreview/renderPlannerGrid. Scoped to the expanded
        // subject — cleared whenever the configurator closes/switches.
        plannerPreviewKeys: {},
        plannerPicks: [],
        plannerPlans: [],
        plannerActivePlanId: null,
        plannerCustomSearchOpen: false,
        plannerCustomSearchQuery: '',
        plannerCustomSearchLoading: false,
        plannerCustomSearchResults: null,
        // ---- automatic generator ("Automatyczny" mode) ----
        plannerMode: 'manual',
        plannerAutoSelected: {}, // subjectId -> {subjectUrl, subjectName}
        plannerAutoEarliestStart: '',
        plannerAutoLatestEnd: '',
        plannerAutoBlockedWindows: [], // [{day, start, end}]
        plannerAutoBlockDraftDay: 'poniedziałek',
        plannerAutoBlockDraftStart: '',
        plannerAutoBlockDraftEnd: '',
        plannerAutoMaxPerDay: '',
        plannerAutoPreferredDays: '',
        plannerAutoMinimizeGaps: true,
        plannerAutoStatus: 'idle', // idle | fetching | generating | done | failed
        plannerAutoCandidates: [],
        plannerAutoActiveCandidateIndex: 0,
        plannerAutoFailure: null,
      };
      this._onClick = this.handleClick.bind(this);
      this._onChange = this.handleChange.bind(this);
      this._onInput = this.handleInput.bind(this);
      this._onKeydown = this.handleKeydown.bind(this);
      this._onPopState = this.handlePopState.bind(this);
      this._onMouseover = this.handleMouseover.bind(this);
      this._onMouseout = this.handleMouseout.bind(this);
      this.root.addEventListener('click', this._onClick);
      // Only `change` (fires on blur/select, not per keystroke) — a full
      // re-render on every keystroke would replace the focused <input> node
      // and drop the cursor mid-typing. The topbar search box needs actual
      // per-keystroke input, but never goes through a full render either
      // (see setSearchState) — it only ever patches the results dropdown
      // below the input, so the input itself is never touched.
      this.root.addEventListener('change', this._onChange);
      this.root.addEventListener('input', this._onInput);
      this.root.addEventListener('keydown', this._onKeydown);
      // Hover previewing for the planner's group candidates: mouseover/
      // mouseout are captured with the same root delegation as clicks so
      // they survive the [data-planner-root] innerHTML patches. The
      // handlers themselves only ever toggle CSS classes — a state round-
      // trip per mouse move would rebuild the whole planner.
      this.root.addEventListener('mouseover', this._onMouseover);
      this.root.addEventListener('mouseout', this._onMouseout);
      window.addEventListener('popstate', this._onPopState);
      // Anchors the bottom of the back/forward stack to whatever we're
      // about to show (dashboard, or a subjectPage/catalogPage restored
      // from sessionStorage above) — same URL, just carrying our own state
      // object, so a same-document popstate fires instead of the browser
      // falling through to whatever real entry preceded this page load. See
      // persistViewState()/handlePopState() for the rest of the mechanism.
      try { history.replaceState(this.viewStatePayload(), '', location.href); } catch (e) { /* ignore */ }
      this.setupTitleGuard();
      this.loadPlannerPicks();
      this.checkNewsUpdate();
      if (initialView === 'subjectPage' && initialSubjectUrl) {
        this.fetchSubjectData(initialSubjectUrl);
      }
      if (initialView === 'catalogPage' && initialCatalogKod) {
        if (initialCatalogKind === 'stage') {
          this.fetchStagePage(initialCatalogKod, initialCatalogEtpKod, null);
        } else {
          this.fetchCatalogPage(initialCatalogKind, initialCatalogKod);
        }
      }
      if (initialView === 'mapa') {
        this.ensureMapaData();
      }
      if (initialView === 'katalogJednostki' || initialView === 'katalogPrzedmioty' || initialView === 'katalogKierunki') {
        this.ensureKatalogRoot();
      }
      if (initialView === 'katalogBudynki') {
        this.ensureMapaData();
      }
    }

    destroy() {
      if (this._leafletMap) { this._leafletMap.remove(); this._leafletMap = null; }
      if (this._unitMap) { this._unitMap.remove(); this._unitMap = null; this._unitMapMarkersByKod = null; }
      this.root.removeEventListener('click', this._onClick);
      this.root.removeEventListener('change', this._onChange);
      this.root.removeEventListener('input', this._onInput);
      this.root.removeEventListener('keydown', this._onKeydown);
      this.root.removeEventListener('mouseover', this._onMouseover);
      this.root.removeEventListener('mouseout', this._onMouseout);
      window.removeEventListener('popstate', this._onPopState);
      if (this._titleObserver) this._titleObserver.disconnect();
    }

    // Classic USOSweb ships a static server-rendered <title> and no script
    // touches it afterwards (verified live) — but just in case some page we
    // haven't seen does, re-assert our title if anything changes it out from
    // under us instead of silently losing the tab label.
    setupTitleGuard() {
      let titleEl = document.querySelector('title');
      if (!titleEl) {
        titleEl = document.createElement('title');
        document.head.appendChild(titleEl);
      }
      this._titleObserver = new MutationObserver(() => {
        if (this._lastTitle && document.title !== this._lastTitle) {
          document.title = this._lastTitle;
        }
      });
      this._titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }

    updateDocumentTitle() {
      let [title] = TITLES[this.state.view] || [];
      if (this.state.view === 'subjectPage' && this.state.subjectData) {
        title = this.state.subjectData.subjectName || title;
      }
      if (this.state.view === 'catalogPage' && this.state.catalogData) {
        title = this.state.catalogData.name || this.state.catalogData.label || title;
      }
      const full = title ? `${title} – USOS++` : 'USOS++';
      this._lastTitle = full;
      if (document.title !== full) document.title = full;
    }

    // Same shape used to survive a real page reload (sessionStorage, see
    // saveViewState/loadViewState) and to survive a browser back/forward
    // click within the same document (history.pushState/popstate, see
    // persistViewState/handlePopState) — both just need to know which
    // "page" of the app is showing and enough to re-fetch it.
    viewStatePayload() {
      return {
        view: this.state.view,
        subjectUrl: this.state.view === 'subjectPage' ? this.state.subjectUrl : null,
        subjectBackView: this.state.view === 'subjectPage' ? this.state.subjectBackView : null,
        catalogKind: this.state.view === 'catalogPage' ? this.state.catalogKind : null,
        catalogKod: this.state.view === 'catalogPage' ? this.state.catalogKod : null,
        catalogEtpKod: this.state.view === 'catalogPage' && this.state.catalogKind === 'stage' ? this.state.catalogEtpKod : null,
        catalogBackView: this.state.view === 'catalogPage' ? this.state.catalogBackView : null,
        catalogBackPrevKind: this.state.view === 'catalogPage' && (this.state.catalogKind === 'unit' || this.state.catalogKind === 'program') ? (this.state.catalogBackPrevKind || null) : null,
        catalogBackPrevKod: this.state.view === 'catalogPage' && (this.state.catalogKind === 'unit' || this.state.catalogKind === 'program') ? (this.state.catalogBackPrevKod || null) : null,
      };
    }

    // Called right after every real "page change" inside the app (see the 4
    // call sites: navigate(), openSubjectPage(), openCatalogPage(),
    // openStagePage()) — never from handlePopState() itself, or every
    // browser-back click would also push a brand new forward entry and the
    // stack could never shrink. Pushing with the *same* URL is deliberate:
    // it keeps the tab on this exact document (a same-document navigation,
    // just a popstate event, no reload) while still giving the browser's
    // own back/forward buttons something to step through.
    persistViewState() {
      const payload = this.viewStatePayload();
      saveViewState(payload);
      try { history.pushState(payload, '', location.href); } catch (e) { /* ignore */ }
    }

    // Browser back/forward landed on one of our own history entries (pushed
    // by persistViewState above, or the base one from the constructor).
    // `event.state` is null when the user has gone further back than any
    // in-app navigation ever pushed — before this content script started
    // managing history at all — in which case there's nothing of ours to
    // restore and the browser is about to leave the page for real, so we
    // just fall back to the dashboard rather than guessing.
    handlePopState(e) {
      this.closeAnyModal();
      const p = e.state || {};
      let view = VALID_VIEWS.has(p.view) ? p.view : 'dashboard';
      if (view === 'subjectPage' && !p.subjectUrl) view = 'przedmiotyLista';
      if (view === 'catalogPage') {
        const validKind = p.catalogKind === 'unit' || p.catalogKind === 'program'
          || (p.catalogKind === 'stage' && !!p.catalogEtpKod);
        if (!p.catalogKod || !validKind) view = 'dashboard';
      }

      if (view === 'subjectPage') {
        const backView = (p.subjectBackView && VALID_VIEWS.has(p.subjectBackView) && p.subjectBackView !== 'subjectPage')
          ? p.subjectBackView
          : 'przedmiotyLista';
        this.setState({
          view: 'subjectPage',
          notifPanelOpen: false,
          avatarMenuOpen: false,
          subjectBackView: backView,
          subjectUrl: p.subjectUrl,
          subjectLoading: true,
          subjectError: false,
          subjectData: null,
        });
        this.fetchSubjectData(p.subjectUrl);
      } else if (view === 'catalogPage') {
        const backView = (p.catalogBackView && VALID_VIEWS.has(p.catalogBackView) && p.catalogBackView !== 'catalogPage')
          ? p.catalogBackView
          : 'dashboard';
        // Restored mid-chain ("Wróć" should re-open the previous catalog
        // page even though the live snapshot is gone) — see
        // openCatalogPage/catalogBack for the chain mechanism.
        const prevKind = (p.catalogKind === 'unit' || p.catalogKind === 'program')
          && p.catalogBackView === 'catalogPage'
          && (p.catalogBackPrevKind === 'unit' || p.catalogBackPrevKind === 'program')
          ? p.catalogBackPrevKind
          : null;
        this.setState({
          view: 'catalogPage',
          notifPanelOpen: false,
          avatarMenuOpen: false,
          catalogBackView: backView,
          catalogBackSnapshot: null,
          catalogBackPrevKind: prevKind,
          catalogBackPrevKod: prevKind ? (p.catalogBackPrevKod || null) : null,
          catalogKind: p.catalogKind,
          catalogKod: p.catalogKod,
          catalogEtpKod: p.catalogKind === 'stage' ? p.catalogEtpKod : null,
          catalogLoading: true,
          catalogError: false,
          catalogData: null,
          catalogBuildings: [],
        });
        if (p.catalogKind === 'stage') this.fetchStagePage(p.catalogKod, p.catalogEtpKod, null);
        else this.fetchCatalogPage(p.catalogKind, p.catalogKod);
      } else if (view === 'mapa') {
        this.setState({ view: 'mapa', notifPanelOpen: false, avatarMenuOpen: false });
        this.ensureMapaData();
      } else if (view === 'katalogJednostki' || view === 'katalogPrzedmioty' || view === 'katalogKierunki') {
        this.setState({ view, notifPanelOpen: false, avatarMenuOpen: false });
        this.ensureKatalogRoot();
      } else if (view === 'katalogBudynki') {
        this.setState({ view, notifPanelOpen: false, avatarMenuOpen: false });
        this.ensureMapaData();
      } else {
        this.setState({ view, notifPanelOpen: false, avatarMenuOpen: false });
      }
      saveViewState(this.viewStatePayload());
    }

    setState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      this.render();
    }

    // `render()` always rebuilds the ENTIRE `.usospp-root` innerHTML — fine
    // for occasional navigation, but the planner triggers several state
    // updates per click (expand → loading → fetched groups) and rebuilding
    // the sidebar/topbar/everything else on each one made the whole page
    // visibly flash. This patches just the planner's own DOM subtree
    // (marked `data-planner-root`) instead, and does nothing at all if the
    // planner isn't the active view (the state is still updated for next
    // time it's opened — no need to touch a DOM the user isn't looking at).
    setPlannerState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'planer') return;
      const el = this.root.querySelector('[data-planner-root]');
      if (!el) { this.render(); return; }
      el.innerHTML = this.renderPlannerBody();
    }

    // Same idea as setPlannerState: opening/closing the bell or avatar dropdown
    // only ever changes the topbar, but going through setState rebuilt the
    // whole page and replayed .usospp-view's fade-in across all the content
    // underneath it, which read as the page reloading itself.
    setTopbarState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-topbar-root]');
      if (!el) { this.render(); return; }
      el.outerHTML = this.renderTopbar();
    }

    // Same reasoning as setTopbarState/setPlannerSearchState — the
    // automatic generator's preferences card is its own isolated subtree
    // (unlike setPlannerState, which patches the whole planner body,
    // visibly flashing the subject list and results next to it on every
    // field edit). Only rendered while the "planer" view is showing its
    // "auto" mode, matching setPlannerState's own guard rather than
    // setTopbarState's always-visible one.
    setPlannerPrefsState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'planer' || this.state.plannerMode !== 'auto') return;
      const el = this.root.querySelector('[data-planner-prefs-root]');
      if (el) el.outerHTML = this.renderPlannerAutoPrefsForm();
    }

    // Dismissing the beta notice (see renderBetaNotice) only ever needs to
    // repaint the main content area, same reasoning as setTopbarState.
    setContentState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-content-root]');
      if (!el) { this.render(); return; }
      el.innerHTML = `${this.renderBetaNotice()}${this.renderView()}`;
    }

    // A view "has unverified data" when a source it actually displays came
    // back with real content (`supported`) whose shape we haven't confirmed
    // against a live populated page yet (`!verified`) — see
    // UNVERIFIED_SOURCES. Fetch failures alone (`supported: false`) don't
    // trigger this: those already show their own "couldn't read ..." hint,
    // which is a different, unrelated kind of problem.
    hasUnverifiedData() {
      const keys = UNVERIFIED_SOURCES[this.state.view] || [];
      return keys.some((key) => {
        const r = this.data[key];
        return r && r.supported && !r.verified;
      });
    }

    renderBetaNotice() {
      if (this.state.dismissedBetaViews.includes(this.state.view)) return '';
      if (!this.hasUnverifiedData()) return '';
      return `
        <div class="usospp-beta-notice">
          <span class="usospp-beta-notice-icon">⚠</span>
          <div>USOS++ jest jeszcze w wersji beta — ta strona nie została w pełni zweryfikowana i dane mogą wyświetlać się niepoprawnie.</div>
          <button class="usospp-beta-notice-close" data-action="dismissBetaNotice" title="Zamknij">${icon('close', 12)}</button>
        </div>
      `;
    }

    // checkNewsUpdate() resolves well after the initial render, completely
    // outside any click — going through setState would flash the fade-in
    // across the whole page just to light up one small dot in the sidebar.
    setSidebarState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-sidebar-root]');
      if (!el) { this.render(); return; }
      el.outerHTML = this.renderSidebar();
    }

    // Any modal (payment details, class groups, …) overlays whatever view
    // is underneath it — opening/closing it (or its loading -> loaded
    // transition) has nothing to do with the page content, so it gets the
    // same scoped-patch treatment as the topbar/sidebar/planner instead of
    // a full setState.
    setModalState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-modal-root]');
      if (!el) { this.render(); return; }
      el.innerHTML = this.renderModals();
    }

    // At most one of these is ever open at once, but data-modal-root holds
    // whichever it is — each renderer returns '' when it isn't the open one.
    renderModals() {
      return this.renderPaymentDetailsModal() + this.renderGroupsModal() + this.renderLinksModal();
    }

    closeAnyModal() {
      this.setModalState({ paymentDetailsOpen: false, groupsModalOpen: false, linksModalOpen: false });
    }

    // The search dropdown patches on every keystroke (after a debounce) —
    // going through setTopbarState here would replace the topbar's
    // outerHTML, including the <input> the user is actively typing into,
    // dropping focus and cursor position. This only ever touches the
    // results panel below the input.
    setSearchState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-search-results-root]');
      if (el) el.innerHTML = this.renderSearchResults();
    }

    // Same reasoning as setSearchState above, for the planner's own "Dodaj
    // przedmiot spoza listy" search box — going through setPlannerState
    // would rebuild the whole planner body (it patches [data-planner-root]),
    // including the <input> being typed into.
    setPlannerSearchState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'planer') return;
      const el = this.root.querySelector('[data-planner-search-results-root]');
      if (el) el.innerHTML = this.renderPlannerCustomSearchResults();
    }

    // Typing in the unit page's subject mini-search — same reasoning as
    // setSearchState above: only the list/body below the input is patched,
    // never the <input> itself, so the cursor never jumps.
    setCatalogSubjectsState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'catalogPage') return;
      const el = this.root.querySelector('[data-catalog-subjects-root]');
      if (el) el.innerHTML = this.renderCatalogSubjectsSectionBody();
    }

    // Everything that updates the "Przedmioty" section AFTER the unit page
    // is on screen: the offer list arriving, "Wczytaj więcej", the
    // current-year toggle. A plain setState here rebuilds the whole
    // .usospp-root — replaying the view's fade-in and re-mounting the unit
    // map preview over content the user is already reading, which read as
    // the page loading itself a second time. Instead the section card's
    // count title, its toggle and its rows are patched in place, so the
    // <input> sitting between them keeps its value and focus. A section
    // that turns fully hidden (failed/empty fetch, e.g. on katedry) is
    // removed by the same rule renderView hides it with.
    setCatalogSubjectsSectionState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'catalogPage') return;
      const card = this.root.querySelector('[data-catalog-subjects-card]');
      if (!card) return;
      if (!this.renderCatalogSubjectsSection()) { card.outerHTML = ''; return; }
      const title = this.root.querySelector('[data-catalog-subjects-title]');
      if (title) title.innerHTML = this.renderCatalogSubjectsTitle();
      const toggle = this.root.querySelector('[data-catalog-subjects-toggle-wrap]');
      if (toggle) toggle.innerHTML = this.renderCatalogSubjectsToggle();
      const body = this.root.querySelector('[data-catalog-subjects-root]');
      if (body) body.innerHTML = this.renderCatalogSubjectsSectionBody();
    }

    // Same reasoning for the "Programy studiów" card — but with no <input>
    // inside, so the whole card can be swapped in one piece (outerHTML,
    // like setMapaFilter): the freshly rendered section, or removal when
    // it turned hidden.
    setCatalogProgramsState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'catalogPage') return;
      const el = this.root.querySelector('[data-catalog-programs-card]');
      if (el) el.outerHTML = this.renderCatalogProgramsSection();
    }

    updateSettings(settings) {
      this.settings = settings;
      this.render();
    }

    navigate(view) {
      const patch = { view, notifPanelOpen: false, avatarMenuOpen: false };
      if (view === 'aktualnosci' && this.state.newsHasUpdate) {
        patch.newsHasUpdate = false;
        this.persistNewsSeen();
      }
      this.setState(patch);
      this.persistViewState();
      if (view === 'mapa') this.ensureMapaData();
      if (view === 'katalogJednostki') this.ensureKatalogRoot();
      if (view === 'katalogPrzedmioty') this.ensureKatalogRoot();
      if (view === 'katalogKierunki') this.ensureKatalogRoot();
      if (view === 'katalogBudynki') this.ensureMapaData();
    }

    persistNewsSeen() {
      const signature = newsSignature(this.data.newsResult);
      try { chrome.storage.local.set({ [NEWS_SEEN_KEY]: signature }); } catch (e) { /* ignore */ }
    }

    // Compares today's announcement titles against whatever was on the page
    // last time the user actually opened Aktualności (see persistNewsSeen)
    // to light up a small dot in the sidebar — same idea as the background
    // grade-check's hash diff in background.js, just for the news list and
    // surfaced in-app instead of as an OS notification.
    async checkNewsUpdate() {
      if (!this.data.newsResult || !this.data.newsResult.supported) return;
      const signature = newsSignature(this.data.newsResult);
      if (!signature) return;
      let stored;
      try {
        const res = await chrome.storage.local.get(NEWS_SEEN_KEY);
        stored = res[NEWS_SEEN_KEY];
      } catch (e) {
        return;
      }
      if (this.state.view === 'aktualnosci') {
        // Already looking at it on this very load — nothing to flag.
        if (stored !== signature) this.persistNewsSeen();
        return;
      }
      if (stored === undefined) {
        // First time ever — no prior signature to compare against, so
        // there's nothing genuinely "new" to announce yet.
        this.persistNewsSeen();
        return;
      }
      if (stored !== signature) {
        this.setSidebarState({ newsHasUpdate: true });
      }
    }

    handleClick(e) {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      switch (action) {
        case 'nav':
          this.navigate(el.dataset.view);
          break;
        case 'toggleMore':
          this.setSidebarState((s) => ({ moreExpanded: !s.moreExpanded }));
          break;
        case 'dismissBetaNotice':
          this.setContentState((s) => ({ dismissedBetaViews: [...s.dismissedBetaViews, s.view] }));
          break;
        case 'toggleNotifPanel':
          this.setTopbarState((s) => ({ notifPanelOpen: !s.notifPanelOpen, avatarMenuOpen: false }));
          break;
        case 'toggleAvatarMenu':
          this.setTopbarState((s) => ({ avatarMenuOpen: !s.avatarMenuOpen, notifPanelOpen: false }));
          break;
        case 'closeMenus':
          // Every click on empty space resolves here (it's the outermost
          // data-action ancestor) — only re-render when a menu is actually
          // open, otherwise every click on the page would force a full
          // innerHTML rebuild and feel like the page reloading itself.
          if (e.target === el && (this.state.notifPanelOpen || this.state.avatarMenuOpen)) {
            this.setTopbarState({ notifPanelOpen: false, avatarMenuOpen: false });
          }
          break;
        case 'stop':
          e.stopPropagation();
          break;
        case 'setDark':
          this.emitSettings({ darkMode: el.dataset.value === 'true' });
          break;
        case 'toggleFeature':
          this.emitSettings({ toggleFeature: el.dataset.key });
          break;
        case 'disableUsospp':
          this.emitSettings({ disable: true });
          break;
        case 'openUsos':
          window.open(withUsospOff(el.dataset.url || location.origin + '/kontroler.php'), '_blank', 'noopener');
          break;
        case 'rescrape':
          this.emitSettings({ rescrape: true });
          break;
        case 'toggleZapisyOwnOnly':
          this.setState((s) => ({ zapisyOwnOnly: !s.zapisyOwnOnly }));
          break;
        case 'openSubjectPage':
          this.openSubjectPage(el.dataset.url);
          break;
        case 'catalogBack':
          this.catalogBack();
          break;
        case 'catalogSubjectsLoadMore':
          this.loadMoreCatalogSubjects();
          break;
        case 'catalogProgramsLoadMore':
          this.loadMoreCatalogPrograms();
          break;
        case 'toggleCatalogSubjectsCurrentOnly':
          this.setCatalogSubjectsSectionState((s) => ({ catalogSubjectsCurrentOnly: !s.catalogSubjectsCurrentOnly }));
          break;
        case 'katalogBrowseUnit':
          this.fetchKatalogBrowse(el.dataset.kod);
          break;
        case 'katalogSelectUnit':
          this.katalogSelectUnit(el.dataset.kod);
          break;
        case 'katalogRetry':
          this.katalogRetry();
          break;
        case 'katalogPrzedmiotyLoadMore':
          this.loadMoreKatalogPrzedmioty();
          break;
        case 'katalogKierunkiLoadMore':
          this.loadMoreKatalogKierunki();
          break;
        case 'katalogPrzedmiotyToggleCurrent':
          this.setState((s) => ({ katalogPrzedmiotyCurrentOnly: !s.katalogPrzedmiotyCurrentOnly }));
          break;
        case 'searchOpenSubject':
          this.state.searchQuery = '';
          this.state.searchResults = null;
          this.openSubjectPage(el.dataset.url);
          break;
        case 'searchOpenUnit':
          this.state.searchQuery = '';
          this.state.searchResults = null;
          this.openCatalogPage('unit', el.dataset.kod);
          break;
        case 'searchOpenProgram':
          this.state.searchQuery = '';
          this.state.searchResults = null;
          this.openCatalogPage('program', el.dataset.kod);
          break;
        case 'openStage':
          this.openStagePage(el.dataset.prgKod, el.dataset.etpKod, el.dataset.label);
          break;
        case 'unitMapGoToBuilding':
          this.unitMapGoToBuilding(el.dataset.kod);
          break;
        case 'openMapaFocused':
          this.openMapaFocused(el.dataset.kod);
          break;
        case 'mapaSetFilter':
          this.setMapaFilter(el.dataset.unit || '');
          break;
        case 'mapaRefresh':
          this.mapaRefresh();
          break;
        case 'mapaGoToBuilding':
          this.mapaGoToBuilding(el.dataset.kod);
          break;
        case 'openPaymentDetails':
          this.openPaymentDetails(el.dataset.url);
          break;
        case 'closePaymentDetails':
          this.closePaymentDetails();
          break;
        case 'openGroupsModal':
          this.openGroupsModal(el.dataset.url, el.dataset.title);
          break;
        case 'closeGroupsModal':
          this.closeGroupsModal();
          break;
        case 'openLinksModal': {
          let links = [];
          try { links = JSON.parse(el.dataset.links || '[]'); } catch (err) { links = []; }
          this.openLinksModal(links, el.dataset.title);
          break;
        }
        case 'closeLinksModal':
          this.closeLinksModal();
          break;
        case 'closeModalBackdrop':
          // Only when the backdrop itself was clicked, not something
          // inside the modal card that happens to bubble up to it.
          if (e.target === el) this.closeAnyModal();
          break;
        case 'plannerToggleSubject':
          this.plannerToggleSubject(el.dataset.url);
          break;
        case 'plannerLoadGroups':
          this.plannerLoadGroups(el.dataset.url);
          break;
        case 'plannerTogglePreview':
          this.plannerTogglePreview(el.dataset.key, el.dataset.groupsUrl, el.dataset.classTypeLabel);
          break;
        case 'plannerTogglePreviewAll':
          this.plannerTogglePreviewAll(el.dataset.url);
          break;
        case 'plannerSelectGroup':
          this.plannerSelectGroup(el.dataset.key, el.dataset.groupsUrl, el.dataset.nr, el.dataset.classTypeLabel);
          break;
        case 'plannerAddSubject':
          this.plannerAddSubject(el.dataset.url, el.dataset.subjectName, el.dataset.cycleName);
          break;
        case 'plannerRemovePick':
          this.plannerRemovePick(el.dataset.key);
          break;
        case 'plannerClearAll':
          this.savePlannerPicks([]);
          break;
        case 'plannerSwitchPlan':
          this.plannerSwitchPlan(el.dataset.id);
          break;
        case 'plannerNewPlan':
          this.plannerNewPlan();
          break;
        case 'plannerDuplicatePlan':
          this.plannerDuplicatePlan();
          break;
        case 'plannerDeletePlan':
          this.plannerDeletePlan();
          break;
        case 'plannerToggleCustomSearch':
          this.plannerToggleCustomSearch();
          break;
        case 'plannerSelectSearchSubject':
          this.plannerSelectSearchSubject(el.dataset.url, el.dataset.name);
          break;
        case 'plannerSetMode':
          this.plannerSetMode(el.dataset.mode);
          break;
        case 'plannerAutoToggleSubject':
          this.plannerAutoToggleSubject(el.dataset.url, el.dataset.name);
          break;
        case 'plannerAutoAddBlock':
          this.plannerAutoAddBlock();
          break;
        case 'plannerAutoRemoveBlock':
          this.plannerAutoRemoveBlock(parseInt(el.dataset.index, 10));
          break;
        case 'plannerAutoToggleMinimizeGaps':
          this.setPlannerPrefsState((s) => ({ plannerAutoMinimizeGaps: !s.plannerAutoMinimizeGaps }));
          break;
        case 'plannerAutoGenerate':
          this.plannerAutoGenerate();
          break;
        case 'plannerUseGeneratedCandidate':
          this.plannerUseGeneratedCandidate(parseInt(el.dataset.index, 10));
          break;
        case 'plannerAutoSelectCandidate':
          this.setPlannerState({ plannerAutoActiveCandidateIndex: parseInt(el.dataset.index, 10) });
          break;
        default:
          break;
      }
    }

    // ---- planner: hover-preview for group candidates ("podgląd w planie")
    // These two listeners (wired in the constructor on this.root, so they
    // survive the planner's [data-planner-root] innerHTML patches) drive the
    // purely visual part of the candidates: hovering a candidate group makes
    // the grid read as if that group were already part of the plan — every
    // other candidate disappears for as long as the mouse stays on it.
    // No state is ever touched: hover is transient by definition and going
    // through setPlannerState would rebuild the whole planner on every
    // mouse move.

    handleMouseover(e) {
      if (this.state.view !== 'planer' || this.state.plannerMode !== 'manual') return;
      const cand = e.target.closest('[data-cand-group]');
      if (cand) {
        // Hovering a popover ROW previews that group AND keeps the popover
        // itself open (passing a bare gid would close it instantly, making
        // comparison-flicking between rows impossible). A standalone box
        // (singleton candidate) has no cluster ancestor — null is right.
        const cluster = cand.closest('[data-cand-cluster]');
        this.plannerHover(cand.dataset.candGroup, cluster ? cluster.dataset.candCluster : null);
        return;
      }
      // Not a group itself — but maybe a "N grup" neutral box or an open
      // candidate popover, which keeps its cluster active.
      const cluster = e.target.closest('[data-cand-cluster]');
      if (cluster) { this.plannerHover(null, cluster.dataset.candCluster); return; }
      this.plannerHover(null, null);
    }

    handleMouseout(e) {
      if (!this._plannerHoverActive) return;
      if (this.state.view !== 'planer' || this.state.plannerMode !== 'manual') { this.plannerHover(null, null); return; }
      // Only a REAL exit clears the preview: hops between candidate boxes,
      // popover rows and the popover itself fire mouseout first, but the
      // mouseover that follows re-asserts the right state anyway.
      const grid = this.root.querySelector('[data-planner-grid]');
      if (grid && e.relatedTarget && grid.contains(e.relatedTarget)) return;
      this.plannerHover(null, null);
    }

    // Applies the hover-preview state to the grid's candidate elements via
    // classes only. `gid` — the hovered candidate group (all of its sessions
    // across the week stay visible, everything else candidate-shaped hides,
    // so the schedule reads as final). `clusterId` — the "N grup" cluster
    // whose popover should be open (its neutral box hides too); without a
    // `gid` hovering it, the other clusters keep their neutral boxes.
    plannerHover(gid, clusterId) {
      if (this._plannerHoverGid === gid && this._plannerHoverCluster === clusterId) return;
      this._plannerHoverGid = gid;
      this._plannerHoverCluster = clusterId;
      this._plannerHoverActive = !!(gid || clusterId);
      const grid = this.root.querySelector('[data-planner-grid]');
      if (!grid) return;
      grid.querySelectorAll('[data-cand-group]:not([data-cand-row])').forEach((el) => {
        const mine = el.dataset.candGroup === gid;
        el.classList.toggle('usospp-cand-on', !!gid && mine);
        el.classList.toggle('usospp-cand-off', !!gid && !mine);
      });
      grid.querySelectorAll('[data-cand-neutral]').forEach((el) => {
        el.classList.toggle('usospp-cand-off', !!gid || (!!clusterId && el.dataset.candCluster === clusterId));
      });
      grid.querySelectorAll('[data-cand-pop]').forEach((el) => {
        el.classList.toggle('usospp-cand-pop-open', !!clusterId && el.dataset.candPop === clusterId);
      });
    }

    // The "szczegóły" link on a payment/due row points at a page classic
    // USOS renders itself — opening it in a new tab used to just mount
    // USOS++ there too and hide the real content, so instead we fetch and
    // parse that same URL ourselves and show it in our own modal.
    openPaymentDetails(url) {
      if (!url) return;
      this.setModalState({ paymentDetailsOpen: true, paymentDetailsLoading: true, paymentDetailsError: false, paymentDetailsData: null });
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setModalState({ paymentDetailsLoading: false, paymentDetailsError: true });
        return;
      }
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const details = doc && adapter ? adapter.getPaymentDetails(doc) : null;
          if (!details || !details.supported) {
            this.setModalState({ paymentDetailsLoading: false, paymentDetailsError: true });
          } else {
            this.setModalState({ paymentDetailsLoading: false, paymentDetailsData: details });
          }
        })
        .catch(() => {
          this.setModalState({ paymentDetailsLoading: false, paymentDetailsError: true });
        });
    }

    closePaymentDetails() {
      this.setModalState({ paymentDetailsOpen: false });
    }

    renderPaymentDetailsModal() {
      if (!this.state.paymentDetailsOpen) return '';
      const s = this.state;
      return `
        <div class="usospp-modal-backdrop" data-action="closeModalBackdrop">
          <div class="usospp-modal">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">Szczegóły</div>
              <button class="usospp-icon-btn" data-action="closePaymentDetails" title="Zamknij">${icon('close', 15)}</button>
            </div>
            ${s.paymentDetailsLoading ? `
              <div class="usospp-empty-hint">Wczytywanie…</div>
            ` : s.paymentDetailsError ? `
              <div class="usospp-empty-hint">Nie udało się wczytać szczegółów z USOS.</div>
            ` : `
              ${(s.paymentDetailsData.generalInfo || []).length ? `
                <div class="usospp-field-stack" style="margin-bottom:16px;">
                  ${s.paymentDetailsData.generalInfo.map((f) => `
                    <div class="usospp-list-row">
                      <div style="color:var(--ink-3);font-size:13px;">${esc(f.label)}</div>
                      <div style="font-weight:600;font-size:13px;text-align:right;">${esc(f.value || '—')}</div>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
              ${(s.paymentDetailsData.tables || []).map((t) => `
                <div style="margin-bottom:10px;">
                  ${t.title ? `<div style="font-size:12px;font-weight:600;color:var(--ink-3);margin-bottom:6px;">${esc(t.title)}</div>` : ''}
                  <table class="usospp-table">
                    ${t.headers.length ? `<thead><tr>${t.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : ''}
                    <tbody>
                      ${t.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}
                    </tbody>
                  </table>
                  ${t.footer ? `<div style="font-size:12.5px;font-weight:600;text-align:right;margin-top:6px;">${esc(t.footer)}</div>` : ''}
                </div>
              `).join('')}
            `}
          </div>
        </div>
      `;
    }

    // The "grupy →" link on a subject's class type used to bounce out to
    // classic USOS (and, like the payment "szczegóły" link before it, would
    // just mount USOS++ there too and hide what it actually opened). Same
    // fetch+parse-ourselves fix, reusing the getClassGroups adapter method
    // the planner already relies on — just shown in a modal instead of
    // expanded inline, since a subject page isn't already mid-selection the
    // way the planner is.
    openGroupsModal(url, title) {
      if (!url) return;
      this.setModalState({
        groupsModalOpen: true,
        groupsModalLoading: true,
        groupsModalError: false,
        groupsModalData: null,
        groupsModalTitle: title || 'Grupy zajęciowe',
      });
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setModalState({ groupsModalLoading: false, groupsModalError: true });
        return;
      }
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const data = doc && adapter ? adapter.getClassGroups(doc) : null;
          if (!data || !data.supported) {
            this.setModalState({ groupsModalLoading: false, groupsModalError: true });
          } else {
            this.setModalState({ groupsModalLoading: false, groupsModalData: data });
          }
        })
        .catch(() => {
          this.setModalState({ groupsModalLoading: false, groupsModalError: true });
        });
    }

    closeGroupsModal() {
      this.setModalState({ groupsModalOpen: false });
    }

    renderGroupsModal() {
      if (!this.state.groupsModalOpen) return '';
      const s = this.state;
      const data = s.groupsModalData;
      return `
        <div class="usospp-modal-backdrop" data-action="closeModalBackdrop">
          <div class="usospp-modal usospp-modal-wide">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">${esc(s.groupsModalTitle)}</div>
              <button class="usospp-icon-btn" data-action="closeGroupsModal" title="Zamknij">${icon('close', 15)}</button>
            </div>
            ${s.groupsModalLoading ? `
              <div class="usospp-empty-hint">Wczytywanie…</div>
            ` : s.groupsModalError || !data ? `
              <div class="usospp-empty-hint">Nie udało się wczytać grup.</div>
            ` : data.groups.length === 0 ? `
              <div class="usospp-empty-hint">Brak zdefiniowanych grup.</div>
            ` : `
              <table class="usospp-table">
                <thead><tr><th>Grupa</th><th>Terminy</th><th>Nauczyciel</th><th>Miejsca</th></tr></thead>
                <tbody>
                  ${data.groups.map((g) => `
                    <tr>
                      <td>${esc(g.nr)}</td>
                      <td>${g.sessions.map((sess) => `${esc(sess.day)} ${esc(sess.start)}–${esc(sess.end)}${weeksLabel(sess.weeks) ? ` (${weeksLabel(sess.weeks)})` : ''}${sess.place ? `, ${esc(sess.place)}` : ''}`).join('<br>') || '—'}</td>
                      <td>${esc(g.teacher || '—')}</td>
                      <td>${esc(g.occupancy || '—')}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `}
          </div>
        </div>
      `;
    }

    // A field like "Grupy:" can hold several links squashed into one table
    // cell (see adapter.fieldsFromTable's `links` array) — rather than
    // guessing which one the user wants, this lets them pick. The chosen
    // link still just opens in classic USOS: that destination page's own
    // HTML is malformed (mismatched <table> tags, verified live), so it's
    // not something worth writing our own parser against.
    openLinksModal(links, title) {
      this.setModalState({ linksModalOpen: true, linksModalLinks: links || [], linksModalTitle: title || '' });
    }

    closeLinksModal() {
      this.setModalState({ linksModalOpen: false });
    }

    renderLinksModal() {
      if (!this.state.linksModalOpen) return '';
      const s = this.state;
      return `
        <div class="usospp-modal-backdrop" data-action="closeModalBackdrop">
          <div class="usospp-modal">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">${esc(s.linksModalTitle)}</div>
              <button class="usospp-icon-btn" data-action="closeLinksModal" title="Zamknij">${icon('close', 15)}</button>
            </div>
            ${s.linksModalLinks.length === 0 ? `
              <div class="usospp-empty-hint">Brak opcji.</div>
            ` : s.linksModalLinks.map((l) => `
              <div class="usospp-dropdown-item" data-action="openUsos" data-url="${esc(l.href)}">${esc(l.label)}</div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Fetches and parses the subject's full catalog page on demand (see
    // adapter.getSubjectPage) and navigates to a real subview showing it,
    // instead of bouncing out to classic USOS. Lazy/per-click rather than
    // prefetched in collectAll, since there can be dozens of subjects listed
    // and only one is ever opened at a time.
    openSubjectPage(url) {
      if (!url) return;
      this.setState((s) => ({
        view: 'subjectPage',
        subjectBackView: s.view === 'subjectPage' ? s.subjectBackView : s.view,
        subjectUrl: url,
        subjectLoading: true,
        subjectError: false,
        subjectData: null,
      }));
      this.persistViewState();
      this.fetchSubjectData(url);
    }

    // Split out of openSubjectPage so a restored session (page reload landing
    // back on a previously open subject via sessionStorage) can re-fetch the
    // same data without re-deriving subjectBackView from a throwaway initial
    // state.
    fetchSubjectData(url) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ subjectLoading: false, subjectError: true });
        return;
      }
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const details = doc && adapter ? adapter.getSubjectPage(doc) : null;
          if (!details || !details.supported) {
            this.setState({ subjectLoading: false, subjectError: true });
          } else {
            this.setState({ subjectLoading: false, subjectData: details });
            this.loadSubjectTimetables(url, details.cycles);
          }
        })
        .catch(() => {
          this.setState({ subjectLoading: false, subjectError: true });
        });
    }

    // Opens a "jednostka" or "program" search result in our own page —
    // same shape as openSubjectPage/fetchSubjectData, just generalized over
    // `kind` since both are otherwise identical (fetch, parse, show, with a
    // back-link to wherever the user actually came from).
    openCatalogPage(kind, kod) {
      if (!kod) return;
      this.setState((s) => {
        // Opening catalog page B while catalog page A is showing makes
        // "Wróć" on B step back to A itself — one hop, like every other
        // back link in the app — instead of the OLD behavior of keeping
        // A's own back target (which skipped A entirely and landed back
        // on whatever view preceded the whole catalog chain). The plain
        // view-name link can't express "the wydział I just left", so A's
        // whole rendered state — its loaded subject rows included, which
        // a re-fetch would throw away — is snapshotted here and restored
        // by catalogBack(); catalogBackPrev* keeps {kind, kod} around
        // for the snapshot-less paths (reload, popstate).
        const fromCatalog = s.view === 'catalogPage' && !!s.catalogData
          && (s.catalogKind === 'unit' || s.catalogKind === 'program');
        return {
          view: 'catalogPage',
          catalogBackView: fromCatalog ? 'catalogPage' : (s.view === 'catalogPage' ? s.catalogBackView : s.view),
          catalogBackPrevKind: fromCatalog ? s.catalogKind : null,
          catalogBackPrevKod: fromCatalog ? s.catalogKod : null,
          catalogBackSnapshot: fromCatalog ? {
            kind: s.catalogKind,
            kod: s.catalogKod,
            data: s.catalogData,
            buildings: s.catalogBuildings,
            subjects: s.catalogSubjects,
            subjectsTotal: s.catalogSubjectsTotal,
            subjectsNextUrl: s.catalogSubjectsNextUrl,
            subjectsCurrentOnly: s.catalogSubjectsCurrentOnly,
            subjectsQuery: s.catalogSubjectQuery,
            programs: s.catalogPrograms,
            programsNextUrl: s.catalogProgramsNextUrl,
            backView: s.catalogBackView,
            prevKind: s.catalogBackPrevKind || null,
            prevKod: s.catalogBackPrevKod || null,
          } : null,
          catalogKind: kind,
          catalogKod: kod,
          catalogLoading: true,
          catalogError: false,
          catalogData: null,
          catalogBuildings: [],
        };
      });
      this.persistViewState();
      this.fetchCatalogPage(kind, kod);
    }

    // "← Wróć" on a unit/program page that was opened from another unit/
    // program page. With a live snapshot this is instant — the previous
    // page's data, loaded subject rows, filters and pagination carry over
    // untouched; without one (reload/popstate in between) the page is
    // simply re-opened from its {kind, kod}. Both paths then behave like
    // every other back link: exactly one screen back.
    catalogBack() {
      const s = this.state;
      const kind = s.catalogBackPrevKind;
      const kod = s.catalogBackPrevKod;
      const snap = s.catalogBackSnapshot;
      if (kind !== 'unit' && kind !== 'program') {
        const target = s.catalogBackView && VALID_VIEWS.has(s.catalogBackView) && s.catalogBackView !== 'catalogPage'
          ? s.catalogBackView
          : 'dashboard';
        this.navigate(target);
        return;
      }
      if (!kod) {
        this.navigate('dashboard');
        return;
      }
      if (snap && snap.kind === kind && snap.kod === kod && snap.data) {
        this.setState({
          view: 'catalogPage',
          notifPanelOpen: false,
          avatarMenuOpen: false,
          catalogBackView: snap.backView,
          catalogBackPrevKind: snap.prevKind,
          catalogBackPrevKod: snap.prevKod,
          catalogBackSnapshot: null,
          catalogKind: kind,
          catalogKod: kod,
          catalogEtpKod: null,
          catalogLoading: false,
          catalogError: false,
          catalogData: snap.data,
          catalogBuildings: snap.buildings || [],
          catalogSubjects: snap.subjects || [],
          catalogSubjectsTotal: snap.subjectsTotal || 0,
          catalogSubjectsNextUrl: snap.subjectsNextUrl || null,
          catalogSubjectQuery: snap.subjectsQuery || '',
          catalogSubjectsCurrentOnly: !!snap.subjectsCurrentOnly,
          catalogPrograms: snap.programs || [],
          catalogProgramsNextUrl: snap.programsNextUrl || null,
        });
        this.persistViewState();
      } else {
        this.openCatalogPage(kind, kod);
      }
    }

    // Back link for the unit/program catalog pages — the dedicated one-hop
    // action when this page was opened from another catalog page, the plain
    // view link otherwise.
    catalogBackHeader() {
      const s = this.state;
      if ((s.catalogBackPrevKind === 'unit' || s.catalogBackPrevKind === 'program') && s.catalogBackPrevKod) {
        return `<a data-action="catalogBack" class="usospp-back-link">← Wróć</a>`;
      }
      return backLink(s.catalogBackView || 'dashboard');
    }

    fetchCatalogPage(kind, kod) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ catalogLoading: false, catalogError: true });
        return;
      }
      const url = kind === 'unit' ? scrape.PATHS.unitDetail(kod) : scrape.PATHS.programDetail(kod);
      // The unit page also shows supplementary sections that each fetch on
      // their own (subjects the unit offers — see adapter.getUnitSubjects —
      // and its study programmes): they reset here so a re-fetch (opening
      // another unit, a popstate back into this page) never shows the
      // previous unit's rows, and they never turn the page into an error
      // view when their request fails — the sections just stay hidden.
      if (kind === 'unit') {
        this.setState({
          catalogBuildings: [],
          catalogSubjects: [],
          catalogSubjectsTotal: 0,
          catalogSubjectsNextUrl: null,
          catalogSubjectsLoading: true,
          catalogSubjectQuery: '',
          catalogSubjectsCurrentOnly: false,
          catalogPrograms: [],
          catalogProgramsNextUrl: null,
          catalogProgramsLoading: true,
        });
      }
      // A unit page also shows its own "Budynki jednostki" list (see
      // renderUnitPage) — one cheap request tacked on in parallel, not
      // gated behind the main detail fetch succeeding, and never turns this
      // into an error page on its own (buildings are supplementary here,
      // unlike on the dedicated "Mapa" view).
      const buildingsPromise = kind === 'unit' ? scrape.fetchDoc(scrape.PATHS.buildingsForUnit(kod)) : Promise.resolve(null);
      Promise.all([scrape.fetchDoc(url), buildingsPromise])
        .then(([doc, buildingsDoc]) => {
          const adapter = adapters.selectAdapter();
          const details = doc && adapter
            ? (kind === 'unit' ? adapter.getUnitDetail(doc) : adapter.getProgramDetail(doc))
            : null;
          const buildingsResult = kind === 'unit' && buildingsDoc && adapter ? adapter.getBuildingsForUnit(buildingsDoc) : null;
          if (!details || !details.supported) {
            this.setState({ catalogLoading: false, catalogError: true });
          } else {
            this.setState({
              catalogLoading: false,
              catalogData: details,
              catalogBuildings: (buildingsResult && buildingsResult.supported) ? buildingsResult.buildings : [],
            });
          }
        })
        .catch(() => {
          this.setState({ catalogLoading: false, catalogError: true });
        });

      if (kind !== 'unit') return;
      // Section fetches below never block the card above. The subject
      // listing's nav-bar next-page-url points at 30-row pages (the classic
      // UI default) — its limit segment is swapped for 300, a page size the
      // classic UI itself offers (verified live), so "Wczytaj więcej" walks
      // a 3500-row wydział in a handful of requests.
      const stillOnPage = () => this.state.view === 'catalogPage' && this.state.catalogKind === 'unit' && this.state.catalogKod === kod;
      scrape.fetchDoc(scrape.PATHS.unitSubjects(kod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitSubjects(doc) : null;
          if (!stillOnPage()) return;
          this.setCatalogSubjectsSectionState({
            catalogSubjects: res ? res.subjects : [],
            catalogSubjectsTotal: res ? res.total : 0,
            catalogSubjectsNextUrl: res && res.nextUrl ? res.nextUrl.replace(/(tab[0-9a-z]+_limit)=\d+/, '$1=300') : null,
            catalogSubjectsLoading: false,
          });
        })
        .catch(() => {
          if (stillOnPage()) this.setCatalogSubjectsSectionState({ catalogSubjectsLoading: false });
        });
      scrape.fetchDoc(scrape.PATHS.unitPrograms(kod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitPrograms(doc) : null;
          if (!stillOnPage()) return;
          this.setCatalogProgramsState({
            catalogPrograms: res ? res.programs : [],
            catalogProgramsNextUrl: res ? res.nextUrl : null,
            catalogProgramsLoading: false,
          });
        })
        .catch(() => {
          if (stillOnPage()) this.setCatalogProgramsState({ catalogProgramsLoading: false });
        });
    }

    // "Wczytaj więcej" for the subject-offer listing — follows the current
    // page's own nav-bar next-page-url (already limit-boosted to 300 rows by
    // fetchCatalogPage) until a page comes back without one, merging rows by
    // kod so the list can't duplicate if USOS re-sorts between requests.
    loadMoreCatalogSubjects() {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const url = this.state.catalogSubjectsNextUrl;
      if (!scrape || !adapters || !url || this.state.catalogSubjectsLoading) return;
      const kod = this.state.catalogKod;
      this.setCatalogSubjectsSectionState({ catalogSubjectsLoading: true });
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitSubjects(doc) : null;
          if (this.state.view !== 'catalogPage' || this.state.catalogKind !== 'unit' || this.state.catalogKod !== kod) return;
          const known = new Set(this.state.catalogSubjects.map((r) => r.kod));
          const fresh = res ? res.subjects.filter((r) => !known.has(r.kod)) : [];
          this.setCatalogSubjectsSectionState({
            catalogSubjects: this.state.catalogSubjects.concat(fresh),
            catalogSubjectsTotal: (res && res.total) || this.state.catalogSubjectsTotal,
            // A page with nothing new ends the walk even if it still carries
            // a next-page-url — otherwise the button would re-fetch the same
            // tail forever.
            catalogSubjectsNextUrl: (res && res.nextUrl && fresh.length) ? res.nextUrl.replace(/(tab[0-9a-z]+_limit)=\d+/, '$1=300') : null,
            catalogSubjectsLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view === 'catalogPage' && this.state.catalogKind === 'unit') {
            this.setCatalogSubjectsSectionState({ catalogSubjectsLoading: false, catalogSubjectsNextUrl: null });
          }
        });
    }

    // Same walk for the programmes section — both verified listings render
    // in one page, but the nav-bar link is parsed generically so a bigger
    // university would simply get the button too.
    loadMoreCatalogPrograms() {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const url = this.state.catalogProgramsNextUrl;
      if (!scrape || !adapters || !url || this.state.catalogProgramsLoading) return;
      const kod = this.state.catalogKod;
      this.setCatalogProgramsState({ catalogProgramsLoading: true });
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitPrograms(doc) : null;
          if (this.state.view !== 'catalogPage' || this.state.catalogKind !== 'unit' || this.state.catalogKod !== kod) return;
          const known = new Set(this.state.catalogPrograms.map((r) => r.kod));
          const fresh = res ? res.programs.filter((r) => !known.has(r.kod)) : [];
          this.setCatalogProgramsState({
            catalogPrograms: this.state.catalogPrograms.concat(fresh),
            catalogProgramsNextUrl: (res && res.nextUrl && fresh.length) ? res.nextUrl : null,
            catalogProgramsLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view === 'catalogPage' && this.state.catalogKind === 'unit') {
            this.setCatalogProgramsState({ catalogProgramsLoading: false, catalogProgramsNextUrl: null });
          }
        });
    }

    // A stage ("semestr") link from a program's "Główne toki nauczania" —
    // reuses the exact same PATHS.stageSubjects/getStageSubjects pipeline
    // getOwnProgrammes already feeds for the logged-in user's own programme
    // (see renderPrzedmiotyLista), just for an arbitrary browsed program
    // instead. `catalogKod` doubles as this stage's prg_kod (it's the same
    // code the program page itself was opened with), so "back" can reopen
    // that exact program rather than the generic catalogBackView, which
    // points further back to wherever the user was before the program page.
    openStagePage(prgKod, etpKod, label) {
      if (!prgKod || !etpKod) return;
      this.setState((s) => ({
        view: 'catalogPage',
        catalogBackView: s.view === 'catalogPage' ? s.catalogBackView : s.view,
        catalogKind: 'stage',
        catalogKod: prgKod,
        catalogEtpKod: etpKod,
        catalogLoading: true,
        catalogError: false,
        catalogData: null,
      }));
      this.persistViewState();
      this.fetchStagePage(prgKod, etpKod, label);
    }

    fetchStagePage(prgKod, etpKod, label) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ catalogLoading: false, catalogError: true });
        return;
      }
      scrape.fetchDoc(scrape.PATHS.stageSubjects(prgKod, etpKod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const details = doc && adapter ? adapter.getStageSubjects(doc) : null;
          if (!details) {
            this.setState({ catalogLoading: false, catalogError: true });
          } else {
            this.setState({ catalogLoading: false, catalogData: { prgKod, etpKod, label, ...details } });
          }
        })
        .catch(() => {
          this.setState({ catalogLoading: false, catalogError: true });
        });
    }

    // Loads the WHOLE campus's buildings in one shot, the first time "Mapa"
    // is opened — see adapter.getBuildingsForUnit's comment for why one
    // request against the university's own root jednostka is enough
    // (buildings of every sub-unit are already included recursively),
    // rather than crawling every jednostka individually. The root is found
    // by walking up getUnitDetail's `ancestors` from the student's own
    // faculty — this.data.user.facultyCode, scraped at startup with zero
    // extra requests (see adapter.getUser) — or, when logged out, from any
    // unit the public search can find (inline fallback below). Cached in
    // chrome.storage.local (buildings essentially never change) so a later
    // visit/reload doesn't re-fetch; see mapaRefresh() for the manual
    // override.
    // ensureMapaData/fetchMapaData also run while the Mapa view isn't the
    // active one — the building section of the topbar search warms the
    // campus list on first keystrokes (onSearchInput). A full render() from
    // there would rebuild the topbar and yank focus out of the search
    // input mid-typing, and no other view reads the mapa state, so only a
    // visible Mapa view needs re-rendering when these async flips land.
    // katalogBudynki reads the same mapaBuildings list as its own rows, so
    // it needs the same re-render (otherwise the list stays on its first
    // empty paint until the user visits Mapa and comes back).
    renderMapaStateIfNeeded() {
      if (this.state.view === 'mapa' || this.state.view === 'katalogBudynki') this.render();
    }

    async ensureMapaData() {
      if (this.state.mapaBuildings.length || this.state.mapaLoading) return;
      this.state.mapaLoading = true;
      this.state.mapaError = false;
      this.renderMapaStateIfNeeded();
      const cacheKey = 'usospp:campusBuildings:' + location.origin;
      try {
        const stored = await chrome.storage.local.get(cacheKey);
        const cached = stored[cacheKey];
        if (cached && Array.isArray(cached.buildings) && cached.buildings.length) {
          this.state.mapaLoading = false;
          this.state.mapaBuildings = cached.buildings;
          this.renderMapaStateIfNeeded();
          return;
        }
      } catch (e) { /* private mode etc. — fall through to a live fetch */ }
      await this.fetchMapaData(cacheKey);
    }

    async fetchMapaData(cacheKey) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const adapter = adapters ? adapters.selectAdapter() : null;
      if (!scrape || !adapter) {
        this.state.mapaLoading = false;
        this.state.mapaError = true;
        this.renderMapaStateIfNeeded();
        return;
      }
      try {
        const facultyCode = this.data.user && this.data.user.facultyCode;
        let rootKod = facultyCode || null;
        if (facultyCode) {
          const unitDoc = await scrape.fetchDoc(scrape.PATHS.unitDetail(facultyCode));
          const detail = unitDoc ? adapter.getUnitDetail(unitDoc) : null;
          if (detail && detail.ancestors && detail.ancestors.length) rootKod = detail.ancestors[0].kod;
        }
        // Anonymous session (or a facultyCode whose ancestors didn't
        // resolve): no personal data to walk up from, so find ANY unit via
        // the same public search the wyszukiwarka uses and walk up ITS
        // ancestors instead — the search endpoint is as public as the news
        // page (see collectAnon). Patterns ordered by what any Polish
        // university practically always has among its jednostki. UNVERIFIED
        // live: the jsonSzukajJednostki endpoint for an anonymous session —
        // if it refuses, this loop just yields nothing and the Mapa shows
        // its ordinary error + "Spróbuj ponownie" card.
        if (!rootKod) {
          for (const pattern of ['instytut', 'wydzia', 'zakład']) {
            const found = await scrape.searchCatalog(pattern);
            if (!found.units.length) continue;
            const anyKod = found.units[0].kod;
            const unitDoc = await scrape.fetchDoc(scrape.PATHS.unitDetail(anyKod));
            const detail = unitDoc ? adapter.getUnitDetail(unitDoc) : null;
            if (detail && detail.ancestors && detail.ancestors.length) rootKod = detail.ancestors[0].kod;
            else if (detail && detail.supported) rootKod = anyKod; // top of what we can reach — its own subtree is the best we can place
            if (rootKod) break;
          }
        }
        if (!rootKod) {
          this.state.mapaLoading = false;
          this.state.mapaError = true;
          this.renderMapaStateIfNeeded();
          return;
        }
        const buildingsDoc = await scrape.fetchDoc(scrape.PATHS.buildingsForUnit(rootKod));
        const result = buildingsDoc ? adapter.getBuildingsForUnit(buildingsDoc) : null;
        this.state.mapaLoading = false;
        if (!result || !result.supported) {
          this.state.mapaError = true;
          this.renderMapaStateIfNeeded();
          return;
        }
        this.state.mapaBuildings = result.buildings;
        this.renderMapaStateIfNeeded();
        try {
          await chrome.storage.local.set({ [cacheKey]: { rootKod, buildings: result.buildings, fetchedAt: Date.now() } });
        } catch (e) { /* ignore — cache is a pure optimization */ }
      } catch (e) {
        this.state.mapaLoading = false;
        this.state.mapaError = true;
        this.renderMapaStateIfNeeded();
      }
    }

    // Manual "odśwież" link in renderMapa() — buildings are cached
    // indefinitely (see ensureMapaData), so this is the only way to pick up
    // a change without waiting for the cache to be cleared some other way.
    async mapaRefresh() {
      const cacheKey = 'usospp:campusBuildings:' + location.origin;
      try { await chrome.storage.local.remove(cacheKey); } catch (e) { /* ignore */ }
      this.state.mapaBuildings = [];
      this.state.mapaLoading = true;
      this.state.mapaError = false;
      this.render();
      await this.fetchMapaData(cacheKey);
    }

    // Manual "odśwież" link in renderMapa() — buildings are cached
    // indefinitely (see ensureMapaData), so this is the only way to pick up
    // a change without waiting for the cache to be cleared some other way.
    async mapaRefresh() {
      const cacheKey = 'usospp:campusBuildings:' + location.origin;
      try { await chrome.storage.local.remove(cacheKey); } catch (e) { /* ignore */ }
      this.state.mapaBuildings = [];
      this.state.mapaLoading = true;
      this.state.mapaError = false;
      this.render();
      await this.fetchMapaData(cacheKey);
    }

    // Katalog: root uczelni + browse drzewa + oferta per jednostka.
    // Root tym samym sposobem co Mapa (własny wydział → ancestors[0],
    // anonimowo: public search → ancestors) — działa bez logowania.
    renderKatalogStateIfNeeded() {
      if ((this.state.view || '').startsWith('katalog')) this.render();
    }

    async ensureKatalogRoot() {
      if (this.state.katalogRootData || this.state.katalogRootLoading) return;
      this.state.katalogRootLoading = true;
      this.state.katalogRootError = false;
      this.renderKatalogStateIfNeeded();
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const adapter = adapters ? adapters.selectAdapter() : null;
      if (!scrape || !adapter) {
        this.state.katalogRootLoading = false;
        this.state.katalogRootError = true;
        this.renderKatalogStateIfNeeded();
        return;
      }
      try {
        const facultyCode = this.data.user && this.data.user.facultyCode;
        let rootKod = null;
        let rootDetail = null;
        if (facultyCode) {
          const unitDoc = await scrape.fetchDoc(scrape.PATHS.unitDetail(facultyCode));
          const detail = unitDoc ? adapter.getUnitDetail(unitDoc) : null;
          if (detail && detail.supported) {
            rootKod = (detail.ancestors && detail.ancestors.length) ? detail.ancestors[0].kod : facultyCode;
            if (rootKod === facultyCode) rootDetail = detail;
          }
        }
        if (!rootKod) {
          for (const pattern of ['instytut', 'wydzia', 'zakład']) {
            const found = await scrape.searchCatalog(pattern);
            if (!found.units.length) continue;
            const anyKod = found.units[0].kod;
            const unitDoc = await scrape.fetchDoc(scrape.PATHS.unitDetail(anyKod));
            const detail = unitDoc ? adapter.getUnitDetail(unitDoc) : null;
            if (!detail || !detail.supported) continue;
            rootKod = (detail.ancestors && detail.ancestors.length) ? detail.ancestors[0].kod : anyKod;
            if (rootKod === anyKod) rootDetail = detail;
            if (rootKod) break;
          }
        }
        if (!rootKod) {
          this.state.katalogRootLoading = false;
          this.state.katalogRootError = true;
          this.renderKatalogStateIfNeeded();
          return;
        }
        if (!rootDetail) {
          const rootDoc = await scrape.fetchDoc(scrape.PATHS.unitDetail(rootKod));
          rootDetail = rootDoc ? adapter.getUnitDetail(rootDoc) : null;
        }
        this.state.katalogRootLoading = false;
        if (!rootDetail || !rootDetail.supported) {
          this.state.katalogRootError = true;
        } else {
          this.state.katalogRootKod = rootKod;
          this.state.katalogRootData = rootDetail;
          this.state.katalogRootError = false;
        }
        this.renderKatalogStateIfNeeded();
      } catch (e) {
        this.state.katalogRootLoading = false;
        this.state.katalogRootError = true;
        this.renderKatalogStateIfNeeded();
      }
    }

    katalogRetry() {
      this.state.katalogRootKod = null;
      this.state.katalogRootData = null;
      this.state.katalogRootError = false;
      this.state.katalogBrowseKod = null;
      this.state.katalogBrowseData = null;
      this.state.katalogBrowseError = false;
      this.ensureKatalogRoot();
    }

    fetchKatalogBrowse(kod) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters || !kod) return;
      this.setState({ katalogBrowseKod: kod, katalogBrowseLoading: true, katalogBrowseError: false, katalogBrowseData: null });
      scrape.fetchDoc(scrape.PATHS.unitDetail(kod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const detail = doc && adapter ? adapter.getUnitDetail(doc) : null;
          if (this.state.katalogBrowseKod !== kod) return;
          if (!detail || !detail.supported) {
            this.setState({ katalogBrowseLoading: false, katalogBrowseError: true });
          } else {
            this.setState({ katalogBrowseLoading: false, katalogBrowseData: detail });
          }
        })
        .catch(() => {
          if (this.state.katalogBrowseKod !== kod) return;
          this.setState({ katalogBrowseLoading: false, katalogBrowseError: true });
        });
    }

    // Picker w Przedmiotach/Kierunkach: ta sama jednostka dla obu nie jest
    // współdzielona celowo — każdy widok pamięta własny wybór.
    katalogSelectUnit(kod) {
      if (!kod) return;
      if (this.state.view === 'katalogPrzedmioty') {
        this.setState({
          katalogPrzedmiotyUnitKod: kod,
          katalogPrzedmiotyLoading: true,
          katalogPrzedmioty: [],
          katalogPrzedmiotyTotal: 0,
          katalogPrzedmiotyNextUrl: null,
          katalogPrzedmiotyQuery: '',
          katalogPrzedmiotyCurrentOnly: false,
        });
        this.fetchKatalogPrzedmioty(kod);
      } else if (this.state.view === 'katalogKierunki') {
        this.setState({
          katalogKierunkiUnitKod: kod,
          katalogKierunkiLoading: true,
          katalogKierunki: [],
          katalogKierunkiNextUrl: null,
        });
        this.fetchKatalogKierunki(kod);
      }
    }

    fetchKatalogPrzedmioty(kod) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ katalogPrzedmiotyLoading: false });
        return;
      }
      scrape.fetchDoc(scrape.PATHS.unitSubjects(kod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitSubjects(doc) : null;
          if (this.state.view !== 'katalogPrzedmioty' || this.state.katalogPrzedmiotyUnitKod !== kod) return;
          this.setState({
            katalogPrzedmioty: res ? res.subjects : [],
            katalogPrzedmiotyTotal: res ? res.total : 0,
            katalogPrzedmiotyNextUrl: res && res.nextUrl ? res.nextUrl.replace(/(tab[0-9a-z]+_limit)=\d+/, '$1=300') : null,
            katalogPrzedmiotyLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view !== 'katalogPrzedmioty' || this.state.katalogPrzedmiotyUnitKod !== kod) return;
          this.setState({ katalogPrzedmiotyLoading: false });
        });
    }

    loadMoreKatalogPrzedmioty() {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const url = this.state.katalogPrzedmiotyNextUrl;
      const kod = this.state.katalogPrzedmiotyUnitKod;
      if (!scrape || !adapters || !url || this.state.katalogPrzedmiotyLoading) return;
      this.setState({ katalogPrzedmiotyLoading: true });
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitSubjects(doc) : null;
          if (this.state.view !== 'katalogPrzedmioty' || this.state.katalogPrzedmiotyUnitKod !== kod) return;
          const known = new Set(this.state.katalogPrzedmioty.map((r) => r.kod));
          const fresh = res ? res.subjects.filter((r) => !known.has(r.kod)) : [];
          this.setState({
            katalogPrzedmioty: this.state.katalogPrzedmioty.concat(fresh),
            katalogPrzedmiotyTotal: (res && res.total) || this.state.katalogPrzedmiotyTotal,
            katalogPrzedmiotyNextUrl: (res && res.nextUrl && fresh.length) ? res.nextUrl.replace(/(tab[0-9a-z]+_limit)=\d+/, '$1=300') : null,
            katalogPrzedmiotyLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view === 'katalogPrzedmioty') this.setState({ katalogPrzedmiotyLoading: false, katalogPrzedmiotyNextUrl: null });
        });
    }

    fetchKatalogKierunki(kod) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ katalogKierunkiLoading: false });
        return;
      }
      scrape.fetchDoc(scrape.PATHS.unitPrograms(kod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitPrograms(doc) : null;
          if (this.state.view !== 'katalogKierunki' || this.state.katalogKierunkiUnitKod !== kod) return;
          this.setState({
            katalogKierunki: res ? res.programs : [],
            katalogKierunkiNextUrl: res ? res.nextUrl : null,
            katalogKierunkiLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view !== 'katalogKierunki' || this.state.katalogKierunkiUnitKod !== kod) return;
          this.setState({ katalogKierunkiLoading: false });
        });
    }

    loadMoreKatalogKierunki() {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const url = this.state.katalogKierunkiNextUrl;
      const kod = this.state.katalogKierunkiUnitKod;
      if (!scrape || !adapters || !url || this.state.katalogKierunkiLoading) return;
      this.setState({ katalogKierunkiLoading: true });
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitPrograms(doc) : null;
          if (this.state.view !== 'katalogKierunki' || this.state.katalogKierunkiUnitKod !== kod) return;
          const known = new Set(this.state.katalogKierunki.map((r) => r.kod));
          const fresh = res ? res.programs.filter((r) => !known.has(r.kod)) : [];
          this.setState({
            katalogKierunki: this.state.katalogKierunki.concat(fresh),
            katalogKierunkiNextUrl: (res && res.nextUrl && fresh.length) ? res.nextUrl : null,
            katalogKierunkiLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view === 'katalogKierunki') this.setState({ katalogKierunkiLoading: false, katalogKierunkiNextUrl: null });
        });
    }

    setKatalogPrzedmiotyQueryState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'katalogPrzedmioty') return;
      // Patch listy bez dotykania inputa — ten sam powód co
      // setCatalogSubjectsState (focus/kursor w trakcie pisania).
      this.render();
      const input = this.root.querySelector('[data-action="katalogPrzedmiotyQueryInput"]');
      if (input && document.activeElement !== input) { /* render odtworzył input — focus wraca tylko gdy był */ }
      if (input) {
        const val = this.state.katalogPrzedmiotyQuery || '';
        if (input.value !== val) input.value = val;
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ }
      }
    }

    setKatalogBudynkiQueryState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'katalogBudynki') return;
      this.render();
      const input = this.root.querySelector('[data-action="katalogBudynkiQueryInput"]');
      if (input) {
        const val = this.state.katalogBudynkiQuery || '';
        if (input.value !== val) input.value = val;
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ }
      }
    }

    // "Pokaż na mapie" on a unit page's building list — instead of
    // navigating away to the dedicated Mapa view, pans/zooms the inline
    // preview map (mounted by mountUnitMapPreview) to that building and
    // opens its popup. scrollIntoView first because the map sits ABOVE the
    // list, which can run long enough for the clicked row to be off-screen.
    unitMapGoToBuilding(budKod) {
      if (!this._unitMap || !this._unitMapMarkersByKod) return;
      const marker = this._unitMapMarkersByKod[budKod];
      if (!marker) return;
      const container = this.root.querySelector('[data-unit-map]');
      if (container) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      this._unitMap.setView(marker.getLatLng(), 17);
      marker.openPopup();
    }

    // Called by setMapaFilter AND by the initial mount — updates which
    // markers are shown on the ALREADY-MOUNTED map (add/removeFrom, not
    // recreate) and re-fits the view to whatever ends up visible, so
    // picking a wydział zooms in on just its buildings, and clearing the
    // filter naturally zooms back out to the whole campus (the visible set
    // becomes everything again). Keyed by unitKod, not display text — see
    // adapter.getBuildingsForUnit's comment: several distinct units
    // (different wydziały's own "Kierownik Administracji Wydziałowej",
    // for one) share the exact same name, so text equality would wrongly
    // show buildings from more than one unit at once.
    applyMapaFilter() {
      if (!this._mapaMarkersByKod || !this._leafletMap) return;
      const filter = this.state.mapaUnitFilter;
      const visible = [];
      Object.values(this._mapaMarkersByKod).forEach(({ marker, building }) => {
        const show = !filter || building.unitKod === filter;
        const onMap = this._leafletMap.hasLayer(marker);
        if (show && !onMap) marker.addTo(this._leafletMap);
        else if (!show && onMap) marker.remove();
        if (show) visible.push(marker.getLatLng());
      });
      if (visible.length === 1) this._leafletMap.setView(visible[0], 16);
      else if (visible.length > 1) this._leafletMap.fitBounds(window.L.latLngBounds(visible).pad(0.15));
    }

    // Deliberately bypasses setState/render() — see mountMapaIfNeeded's
    // comment for why a full render would destroy and recreate the whole
    // Leaflet map (losing pan/zoom) on every filter change, exactly the
    // "page reload" flash this codebase's other setXState methods (see
    // setTopbarState et al.) already exist to avoid elsewhere.
    setMapaFilter(unitKod) {
      this.state.mapaUnitFilter = unitKod;
      this.applyMapaFilter();
      const el = this.root.querySelector('[data-mapa-filter-root]');
      if (el) el.outerHTML = this.renderMapaFilterChips();
    }

    // Live, purely client-side filter over the already-loaded mapaBuildings
    // (no fetch, no debounce needed) — see setSearchState/
    // setPlannerSearchState for the same "patch only the results subtree"
    // reasoning, so typing never drops focus/cursor from the <input>.
    onMapaSearchInput(value) {
      this.state.mapaSearchQuery = value;
      const el = this.root.querySelector('[data-mapa-search-results-root]');
      if (el) el.innerHTML = this.renderMapaSearchResults();
    }

    renderMapaSearchResults() {
      const q = this.state.mapaSearchQuery.trim().toLowerCase();
      if (q.length < 2) return '';
      const matches = this.state.mapaBuildings
        .filter((b) => b.kod && (b.name.toLowerCase().includes(q) || (b.address && b.address.toLowerCase().includes(q))))
        .slice(0, 8);
      if (!matches.length) {
        return `<div class="usospp-search-dropdown"><div class="usospp-empty-hint" style="padding:16px;">Brak wyników.</div></div>`;
      }
      return `
        <div class="usospp-search-dropdown">
          ${matches.map((b) => `
            <div class="usospp-search-item" data-action="mapaGoToBuilding" data-kod="${esc(b.kod)}">
              <div class="usospp-search-item-title">${esc(b.name)}</div>
              <div class="usospp-search-item-sub">${esc(b.address || b.unitName || '')}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    // Pans/zooms the ALREADY-MOUNTED campus map to one building and opens
    // its popup — used by the Mapa view's own search dropdown. If the
    // building is hidden behind the current wydział filter, clears the
    // filter first so
    // it's actually visible rather than silently focusing on nothing.
    mapaGoToBuilding(budKod) {
      const entry = this._mapaMarkersByKod && this._mapaMarkersByKod[budKod];
      if (!entry || !this._leafletMap) return;
      if (this.state.mapaUnitFilter && entry.building.unitKod !== this.state.mapaUnitFilter) {
        this.state.mapaUnitFilter = '';
        this.applyMapaFilter();
        const filterEl = this.root.querySelector('[data-mapa-filter-root]');
        if (filterEl) filterEl.outerHTML = this.renderMapaFilterChips();
      }
      this._leafletMap.setView(entry.marker.getLatLng(), 17);
      entry.marker.openPopup();
      this.mapaClearSearch();
    }

    // A building hit in the topbar search ("Budynki" section of
    // renderSearchResults) — jump to the Mapa view and, once its markers
    // are created, pan to that building and open its popup. The pending kod
    // lives in state (not a plain field) because the user can land on the
    // view while buildings are still loading — mountMapaIfNeeded then
    // consumes it on the first render that actually has markers. One-shot:
    // cleared when consumed so an unrelated later re-render doesn't zoom
    // the map again.
    openMapaFocused(budKod) {
      if (!budKod) return;
      this.state.mapaFocusKod = budKod;
      // Clear any wydział filter BEFORE navigating: the user asked for one
      // specific building, which may belong to a unit outside it (and a
      // filter-hidden marker's popup would be a confusing no-op). Doing it
      // here — pre-render — means the chip strip just draws filterless,
      // no DOM patching like mapaGoToBuilding needs mid-view.
      this.state.mapaUnitFilter = '';
      this.navigate('mapa'); // navigate() itself calls ensureMapaData() — a no-op if already loading/loaded
    }

    // Bypasses render() same as setMapaFilter — also has to reach into the
    // DOM directly for the <input>'s own value, since (unlike state) that
    // isn't something a scoped innerHTML patch of the results dropdown
    // alone would ever touch.
    mapaClearSearch() {
      this.state.mapaSearchQuery = '';
      const input = this.root.querySelector('[data-mapa-search-input]');
      if (input) input.value = '';
      const resultsEl = this.root.querySelector('[data-mapa-search-results-root]');
      if (resultsEl) resultsEl.innerHTML = '';
    }

    // Leaflet keeps a live L.Map bound to a specific DOM node. render()
    // (see its call to this method at the end) replaces `.usospp-root`'s
    // entire innerHTML on every call, so any previous map instance is left
    // attached to an already-detached element and must be torn down before
    // a fresh one is created here — this runs after EVERY render(), not
    // just the first time "Mapa" is opened. Filter changes (setMapaFilter)
    // deliberately never call render() for exactly this reason.
    mountMapaIfNeeded() {
      if (this.state.view !== 'mapa') {
        if (this._leafletMap) { this._leafletMap.remove(); this._leafletMap = null; this._mapaMarkersByKod = null; }
        return;
      }
      const container = this.root.querySelector('[data-mapa-map]');
      if (!container) return; // loading/error/empty state currently shown — nothing to mount yet
      if (this._leafletMap) { this._leafletMap.remove(); this._leafletMap = null; }
      const map = window.L.map(container, { center: [51.11, 17.03], zoom: 12 });
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      const markerIcon = this.mapaMarkerIcon();
      this._leafletMap = map;
      this._mapaMarkersByKod = {};
      this.state.mapaBuildings.forEach((b) => {
        const marker = window.L.marker([b.lat, b.lng], { icon: markerIcon })
          .bindPopup(`<b>${esc(b.name)}</b>${b.address ? `<br>${esc(b.address)}` : ''}`);
        this._mapaMarkersByKod[b.kod] = { marker, building: b };
      });
      this.applyMapaFilter(); // also fits the view to whatever ends up visible under the current filter
      // Pending focus from the topbar's building search (openMapaFocused)
      // — after applyMapaFilter, so the fit-to-visible wouldn't immediately
      // undo the pan. animate:false skips the whole-campus → building
      // transition, landing directly on a tight, unmistakably-this-one
      // framing. Consumed exactly once.
      if (this.state.mapaFocusKod) {
        const entry = this._mapaMarkersByKod[this.state.mapaFocusKod];
        if (entry) {
          map.setView(entry.marker.getLatLng(), 18, { animate: false });
          entry.marker.openPopup();
        }
        this.state.mapaFocusKod = null;
      }
    }

    // Shared by the full Mapa view and the unit-page preview — explicit
    // chrome.runtime.getURL icon paths instead of leaflet.css's own relative
    // `images/marker-icon.png`, needed because that CSS is injected into
    // USOSweb's own document, not served from our own origin, so a relative
    // path would resolve against USOSweb's URL.
    mapaMarkerIcon() {
      return window.L.icon({
        iconUrl: chrome.runtime.getURL('vendor/leaflet/images/marker-icon.png'),
        iconRetinaUrl: chrome.runtime.getURL('vendor/leaflet/images/marker-icon-2x.png'),
        shadowUrl: chrome.runtime.getURL('vendor/leaflet/images/marker-shadow.png'),
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41],
      });
    }

    // Inline map preview on a unit page (renderUnitPage's "Budynki jednostki"
    // card) — just this unit's buildings (which buildingsForUnit already
    // includes with all sub-units', recursively), no building search and no
    // wydział filter chips: the dedicated Mapa view is one "Zobacz na mapie"
    // click away for pan/zoom beyond this or campus-wide context. Same
    // teardown-before-remount discipline as mountMapaIfNeeded(): render()
    // replaces this container on every call, so any live instance would be
    // stranded on a detached node.
    mountUnitMapPreview() {
      if (this._unitMap) { this._unitMap.remove(); this._unitMap = null; this._unitMapMarkersByKod = null; }
      if (this.state.view !== 'catalogPage' || this.state.catalogKind !== 'unit') return;
      const buildings = this.state.catalogBuildings;
      if (!buildings || !buildings.length) return;
      const container = this.root.querySelector('[data-unit-map]');
      if (!container) return; // still loading / errored — card (so the div) isn't rendered
      const map = window.L.map(container, { center: [51.11, 17.03], zoom: 12, scrollWheelZoom: false });
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      const markerIcon = this.mapaMarkerIcon();
      // Kept keyed by building kod so unitMapGoToBuilding (the "Pokaż na
      // mapie" links in the list below the map) can find one marker without
      // scanning the DOM for it.
      this._unitMapMarkersByKod = {};
      const points = [];
      buildings.forEach((b) => {
        const marker = window.L.marker([b.lat, b.lng], { icon: markerIcon })
          .bindPopup(`<b>${esc(b.name)}</b>${b.address ? `<br>${esc(b.address)}` : ''}`);
        marker.addTo(map);
        this._unitMapMarkersByKod[b.kod] = marker;
        points.push(marker.getLatLng());
      });
      if (points.length === 1) map.setView(points[0], 17);
      else map.fitBounds(window.L.latLngBounds(points).pad(0.2));
      this._unitMap = map;
    }

    // The mini timetable embedded directly in the subject page only has a
    // one-letter class-type code per entry and no teacher/room. Each cycle's
    // "Przejdź do planu" link (captured as `planUrl`) points to a richer,
    // separate page with that detail (see adapter.getSubjectTimetable) — so
    // once the subject page itself has rendered, fetch those in the
    // background per cycle and upgrade each cycle's timetable in place.
    // Guarded by `subjectUrl` (not object identity) so a stale response
    // arriving after the user opened a *different* subject is dropped.
    loadSubjectTimetables(url, cycles) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) return;
      const adapter = adapters.selectAdapter();
      if (!adapter) return;
      cycles.forEach((cycle, idx) => {
        if (!cycle.planUrl) return;
        scrape.fetchDoc(cycle.planUrl)
          .then((doc) => {
            if (!doc || this.state.subjectUrl !== url) return;
            const tt = adapter.getSubjectTimetable(doc);
            if (!tt || !tt.days.length) return;
            this.setState((s) => {
              if (!s.subjectData || s.subjectUrl !== url) return {};
              const nextCycles = s.subjectData.cycles.map((c, i) => (i === idx ? { ...c, timetable: tt } : c));
              return { subjectData: { ...s.subjectData, cycles: nextCycles } };
            });
          })
          .catch(() => {});
      });
    }

    // ---- schedule planner (what-if plan, never touches real USOS state) ---

    // Applies a freshly-loaded (or cross-tab-changed) planner store snapshot
    // — { plans: [{id,name,picks}], activePlanId } — to local state. Also
    // recomputes every pick's `key` in every plan (not just the active one,
    // so switching to an old plan doesn't resurrect the stale-key bug) from
    // its own stable fields: `key` used to be built from the raw subject
    // URL before classTypeKey started normalizing through subjectId, so
    // picks saved before that fix carry a key baked with a since-rotated
    // `callback=` token that would keep failing to match on reopen.
    // Idempotent, so it's safe to run on every load.
    applyPlannerData(data) {
      if (!data || !Array.isArray(data.plans) || !data.plans.length) return;
      let changed = false;
      const migratedPlans = data.plans.map((plan) => {
        const picks = (plan.picks || []).map((p) => {
          const key = classTypeKey(p.subjectUrl, p.cycleName, p.classTypeLabel);
          if (key !== p.key) changed = true;
          return { ...p, key };
        });
        return { ...plan, picks };
      });
      // Prefer whatever THIS tab already has active (if it still exists)
      // over blindly following the snapshot's activePlanId — otherwise one
      // tab switching plans would silently switch what a different open
      // tab is looking at too.
      const preferredId = this.state.plannerActivePlanId;
      const activePlanId = migratedPlans.some((p) => p.id === preferredId)
        ? preferredId
        : (migratedPlans.some((p) => p.id === data.activePlanId) ? data.activePlanId : migratedPlans[0].id);
      const activePlan = migratedPlans.find((p) => p.id === activePlanId);
      this.setPlannerState({
        plannerPlans: migratedPlans.map((p) => ({ id: p.id, name: p.name, pickCount: p.picks.length })),
        plannerActivePlanId: activePlanId,
        plannerPicks: (activePlan && activePlan.picks) || [],
      });
      if (changed) {
        const planner = window.USOSPP_PLANNER;
        if (planner) planner.setData({ ...data, plans: migratedPlans });
      }
    }

    loadPlannerPicks() {
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      planner.getData().then((data) => this.applyPlannerData(data));
      // Guarded so a second App instance in the same page lifetime (there
      // shouldn't normally be one) doesn't stack duplicate listeners.
      if (!this._plannerListenerBound) {
        this._plannerListenerBound = true;
        planner.onDataChange((data) => this.applyPlannerData(data));
      }
    }

    // Persists `nextPicks` into the currently-active plan's slot only —
    // every other saved plan is untouched.
    savePlannerPicks(nextPicks, extraPatch) {
      this.setPlannerState({ plannerPicks: nextPicks, ...extraPatch });
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      const activeId = this.state.plannerActivePlanId;
      planner.setData((data) => {
        if (!data.plans.some((p) => p.id === activeId)) return data;
        return { ...data, plans: data.plans.map((p) => (p.id === activeId ? { ...p, picks: nextPicks } : p)) };
      }).then((next) => {
        this.setPlannerState({ plannerPlans: next.plans.map((p) => ({ id: p.id, name: p.name, pickCount: p.picks.length })) });
      });
    }

    // Switches which saved plan is being edited/previewed. Any in-progress,
    // unsaved subject configurator is discarded (it belongs to whichever
    // plan was active when it was opened).
    plannerSwitchPlan(id) {
      if (!id || id === this.state.plannerActivePlanId) return;
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      planner.setData((data) => (data.plans.some((p) => p.id === id) ? { ...data, activePlanId: id } : data))
        .then((next) => this.applyPlannerSwitchResult(next));
    }

    plannerNewPlan() {
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      planner.setData((data) => {
        if (data.plans.length >= planner.MAX_PLANS) return data;
        const plan = { id: planner.genId(), name: `Plan ${data.plans.length + 1}`, picks: [] };
        return { plans: [...data.plans, plan], activePlanId: plan.id };
      }).then((next) => this.applyPlannerSwitchResult(next));
    }

    plannerDuplicatePlan() {
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      planner.setData((data) => {
        if (data.plans.length >= planner.MAX_PLANS) return data;
        const source = data.plans.find((p) => p.id === data.activePlanId) || data.plans[0];
        if (!source) return data;
        const plan = { id: planner.genId(), name: `${source.name} (kopia)`, picks: JSON.parse(JSON.stringify(source.picks || [])) };
        return { plans: [...data.plans, plan], activePlanId: plan.id };
      }).then((next) => this.applyPlannerSwitchResult(next));
    }

    // Never removes the last remaining plan — there must always be
    // something to show/edit.
    plannerDeletePlan() {
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      planner.setData((data) => {
        if (data.plans.length <= 1) return data;
        const nextPlans = data.plans.filter((p) => p.id !== data.activePlanId);
        return { plans: nextPlans, activePlanId: nextPlans[0].id };
      }).then((next) => this.applyPlannerSwitchResult(next));
    }

    // Shared tail for the four plan-list mutations above: adopt whatever
    // plan ended up active and close any open subject configurator, since
    // it belonged to the plan we just switched away from.
    applyPlannerSwitchResult(next) {
      const plan = next.plans.find((p) => p.id === next.activePlanId);
      this.setPlannerState({
        plannerPlans: next.plans.map((p) => ({ id: p.id, name: p.name, pickCount: p.picks.length })),
        plannerActivePlanId: next.activePlanId,
        plannerPicks: (plan && plan.picks) || [],
        plannerExpandedUrl: null,
        plannerDraftSelection: {},
      });
    }

    // "Dodaj przedmiot spoza listy" — lets a student search the full USOS
    // catalog for a subject their programme stage didn't surface (e.g. WF,
    // a language, an elective from another kierunek) instead of being
    // limited to stageSubjects. Toggling the box closed also drops any
    // in-progress search text/results, same as clearSearch() does for the
    // topbar search.
    plannerToggleCustomSearch() {
      this.setPlannerState((s) => {
        const next = !s.plannerCustomSearchOpen;
        return next
          ? { plannerCustomSearchOpen: true }
          : { plannerCustomSearchOpen: false, plannerCustomSearchQuery: '', plannerCustomSearchResults: null, plannerCustomSearchLoading: false };
      });
    }

    // Picking a search result behaves differently depending on which mode
    // the search box was opened from (the box itself — plannerCustomSearch*
    // state — is shared, see renderPlannerCustomSearch). In manual mode it
    // hands the URL to plannerToggleSubject, which is fully generic over
    // `url` and doesn't care whether it came from stageSubjects or a catalog
    // search. In automatic mode there's no per-subject configurator to open
    // — the algorithm picks the group — so it's just added straight into
    // plannerAutoSelected, same as ticking an existing checkbox. Either way
    // the search box's own query/results are cleared so the dropdown
    // collapses, but stays open (plannerCustomSearchOpen) in case the
    // student wants to add a second subject that wasn't on the list either.
    plannerSelectSearchSubject(url, name) {
      if (!url) return;
      this.setPlannerState({ plannerCustomSearchQuery: '', plannerCustomSearchResults: null, plannerCustomSearchLoading: false });
      if (this.state.plannerMode === 'auto') {
        this.plannerAutoToggleSubject(url, name);
        return;
      }
      this.plannerToggleSubject(url);
    }

    // ---- automatic generator ------------------------------------------

    plannerSetMode(mode) {
      if (mode !== 'manual' && mode !== 'auto') return;
      this.setPlannerState({ plannerMode: mode });
    }

    plannerAutoToggleSubject(url, name) {
      if (!url) return;
      const id = subjectId(url);
      this.setPlannerState((s) => {
        const next = { ...s.plannerAutoSelected };
        if (next[id]) delete next[id];
        else next[id] = { subjectUrl: url, subjectName: name };
        return { plannerAutoSelected: next };
      });
    }

    plannerAutoAddBlock() {
      const { plannerAutoBlockDraftDay: day, plannerAutoBlockDraftStart: start, plannerAutoBlockDraftEnd: end } = this.state;
      if (!day || !start || !end) return;
      this.setPlannerPrefsState((s) => ({
        plannerAutoBlockedWindows: [...s.plannerAutoBlockedWindows, { day, start, end }],
        plannerAutoBlockDraftStart: '',
        plannerAutoBlockDraftEnd: '',
      }));
    }

    plannerAutoRemoveBlock(index) {
      this.setPlannerPrefsState((s) => ({ plannerAutoBlockedWindows: s.plannerAutoBlockedWindows.filter((_, i) => i !== index) }));
    }

    // Ensures every selected subject's page AND every one of its class
    // types' groups are cached (reusing the SAME plannerSubjectCache/
    // plannerGroupsCache the manual flow already lazily fills — see
    // plannerToggleSubject/plannerLoadGroups — so nothing already loaded
    // manually gets re-fetched), then builds one CSP variable per (subject,
    // class type) with its domain attached. Picks the same "first cycle
    // that isn't finished" a student would see expanding the subject
    // manually (renderPlannerSubjectPanel), for consistency.
    async plannerAutoFetchAll() {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) return { ok: false };
      const adapter = adapters.selectAdapter();
      if (!adapter) return { ok: false };
      const selected = Object.values(this.state.plannerAutoSelected);
      if (!selected.length) return { ok: false };

      const missingSubjects = selected.filter((s) => !this.state.plannerSubjectCache[s.subjectUrl]);
      if (missingSubjects.length) {
        const docs = await Promise.all(missingSubjects.map((s) => scrape.fetchDoc(s.subjectUrl)));
        const patch = {};
        missingSubjects.forEach((s, i) => {
          const doc = docs[i];
          const details = doc ? adapter.getSubjectPage(doc) : null;
          patch[s.subjectUrl] = (details && details.supported) ? details : { supported: false };
        });
        this.setPlannerState((st) => ({ plannerSubjectCache: { ...st.plannerSubjectCache, ...patch } }));
      }

      const variables = [];
      selected.forEach((s) => {
        const details = this.state.plannerSubjectCache[s.subjectUrl];
        if (!details || !details.supported) return;
        const relevantCycles = details.cycles.filter((c) => !/zakończon/i.test(c.cycleState || ''));
        const cycle = (relevantCycles.length ? relevantCycles : details.cycles)[0];
        if (!cycle) return;
        (cycle.classTypes || []).forEach((ct) => {
          if (!ct.groupsUrl) return;
          variables.push({
            subjectUrl: s.subjectUrl,
            subjectName: details.subjectName || s.subjectName,
            cycleName: cycle.cycleName,
            classTypeLabel: ct.label,
            classTypeShort: shortClassType(ct.label),
            groupsUrl: ct.groupsUrl,
          });
        });
      });

      const missingGroupsUrls = [...new Set(variables.map((v) => v.groupsUrl))].filter((u) => !this.state.plannerGroupsCache[u]);
      if (missingGroupsUrls.length) {
        const docs = await Promise.all(missingGroupsUrls.map((u) => scrape.fetchDoc(u)));
        const patch = {};
        missingGroupsUrls.forEach((u, i) => {
          const doc = docs[i];
          const data = doc ? adapter.getClassGroups(doc) : { supported: false, groups: [] };
          patch[u] = { loading: false, data };
        });
        this.setPlannerState((st) => ({ plannerGroupsCache: { ...st.plannerGroupsCache, ...patch } }));
      }

      const finalVariables = variables.map((v) => {
        const cached = this.state.plannerGroupsCache[v.groupsUrl];
        return { ...v, groups: (cached && cached.data && cached.data.groups) || [] };
      });
      return { ok: finalVariables.length > 0, variables: finalVariables };
    }

    // Kicks off fetch → generate. Yields a frame between each state
    // transition (setTimeout after requestAnimationFrame) so the "wczytywanie
    // grup…"/"generowanie…" states actually paint before the heavy,
    // synchronous CSP search runs on the main thread — see the plan doc's
    // note on why this is a cheap, worthwhile insurance even with a
    // sub-250ms search budget.
    async plannerAutoGenerate() {
      if (this.state.plannerAutoStatus === 'fetching' || this.state.plannerAutoStatus === 'generating') return;
      if (!Object.keys(this.state.plannerAutoSelected).length) return;

      this.setPlannerState({ plannerAutoStatus: 'fetching', plannerAutoCandidates: [], plannerAutoFailure: null });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

      const { ok, variables } = await this.plannerAutoFetchAll();
      if (!ok) {
        this.setPlannerState({ plannerAutoStatus: 'failed', plannerAutoFailure: { kind: 'fetch', message: 'Nie udało się wczytać grup zajęć dla wybranych przedmiotów — spróbuj ponownie.' } });
        return;
      }

      this.setPlannerState({ plannerAutoStatus: 'generating' });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

      const engine = window.USOSPP_GENERATOR;
      if (!engine) {
        this.setPlannerState({ plannerAutoStatus: 'failed', plannerAutoFailure: { kind: 'error', message: 'Silnik generatora nie jest dostępny.' } });
        return;
      }

      const hardConstraints = {
        earliestStart: this.state.plannerAutoEarliestStart || null,
        latestEnd: this.state.plannerAutoLatestEnd || null,
        blockedWindows: this.state.plannerAutoBlockedWindows,
      };
      const preferences = {
        maxPerDay: this.state.plannerAutoMaxPerDay ? parseInt(this.state.plannerAutoMaxPerDay, 10) : null,
        preferredDays: this.state.plannerAutoPreferredDays ? parseInt(this.state.plannerAutoPreferredDays, 10) : null,
        minimizeGaps: this.state.plannerAutoMinimizeGaps,
      };

      const result = engine.generate({ variables, hardConstraints, preferences });
      if (result.ok) {
        this.setPlannerState({ plannerAutoStatus: 'done', plannerAutoCandidates: result.candidates, plannerAutoActiveCandidateIndex: 0, plannerAutoFailure: null });
      } else {
        this.setPlannerState({ plannerAutoStatus: 'failed', plannerAutoFailure: result });
      }
    }

    // "Użyj tego planu" — saves the chosen candidate as a brand-new saved
    // plan (same mechanism as plannerNewPlan/planner-store.js's MAX_PLANS
    // cap), never merged into whatever's currently active. Switches back to
    // manual mode on success so the result immediately shows in the normal,
    // fully-editable planner — confirmed with the user: a generated plan is
    // just an ordinary plan afterward, nothing special about it.
    plannerUseGeneratedCandidate(index) {
      const candidate = this.state.plannerAutoCandidates[index];
      const planner = window.USOSPP_PLANNER;
      if (!candidate || !planner) return;
      if (this.state.plannerPlans.length >= planner.MAX_PLANS) {
        this.setPlannerState({ plannerAutoFailure: { kind: 'plan-limit', message: `Masz już zapisanych ${planner.MAX_PLANS} planów — usuń jeden z istniejących w trybie manualnym (zakładki planu), żeby zapisać tę propozycję.` } });
        return;
      }
      const picks = candidate.assignment.map(pickFromAssignment);
      planner.setData((data) => {
        if (data.plans.length >= planner.MAX_PLANS) return data;
        const plan = { id: planner.genId(), name: `Wygenerowany plan ${data.plans.length + 1}`, picks };
        return { plans: [...data.plans, plan], activePlanId: plan.id };
      }).then((next) => {
        this.applyPlannerSwitchResult(next);
        this.setPlannerState({ plannerMode: 'manual', plannerAutoCandidates: [], plannerAutoStatus: 'idle', plannerAutoFailure: null });
      });
    }

    // Expands/collapses a subject's class-type configurator in the planner's
    // subject list. Pre-fills the draft selection from whatever's already
    // saved for this subject, so reopening it to tweak one class type
    // doesn't blank out the others; fetches the subject's cycle/class-type
    // data on first expand only (cached per session after that).
    plannerToggleSubject(url) {
      if (!url) return;
      if (this.state.plannerExpandedUrl === url) {
        this.setPlannerState({ plannerExpandedUrl: null, plannerPreviewKeys: {} });
        return;
      }
      const existing = {};
      this.state.plannerPicks.forEach((p) => {
        if (subjectId(p.subjectUrl) === subjectId(url)) existing[p.key] = { ...p };
      });
      // One state update (one DOM patch) covers both "expand + prefill" and,
      // if needed, "start loading" — issuing them separately made every
      // first-time expand redraw the planner (and, before setPlannerState
      // existed, the whole app) twice back to back.
      const needsFetch = !this.state.plannerSubjectCache[url];
      this.setPlannerState({
        plannerExpandedUrl: url,
        plannerDraftSelection: existing,
        // A brand-new configurator starts with a clean preview state — the
        // previous subject's "podgląd w planie" ghosts would otherwise linger
        // on the grid with no visible way to switch them off (their toggle
        // buttons just left the panel together with the old subject).
        plannerPreviewKeys: {},
        plannerSubjectLoading: needsFetch ? url : this.state.plannerSubjectLoading,
      });
      if (!needsFetch) return;
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) return;
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const details = doc && adapter ? adapter.getSubjectPage(doc) : null;
          this.setPlannerState((s) => {
            if (s.plannerSubjectLoading !== url) return {};
            return {
              plannerSubjectLoading: null,
              plannerSubjectCache: { ...s.plannerSubjectCache, [url]: (details && details.supported) ? details : { supported: false } },
            };
          });
        })
        .catch(() => {
          this.setPlannerState((s) => (s.plannerSubjectLoading === url
            ? { plannerSubjectLoading: null, plannerSubjectCache: { ...s.plannerSubjectCache, [url]: { supported: false } } }
            : {}));
        });
    }

    plannerLoadGroups(groupsUrl) {
      if (!groupsUrl) return;
      const cached = this.state.plannerGroupsCache[groupsUrl];
      if (cached && (cached.loading || cached.data)) return;
      this.setPlannerState((s) => ({ plannerGroupsCache: { ...s.plannerGroupsCache, [groupsUrl]: { loading: true, data: null } } }));
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) return;
      scrape.fetchDoc(groupsUrl)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const data = doc && adapter ? adapter.getClassGroups(doc) : { supported: false, groups: [] };
          this.setPlannerState((s) => ({ plannerGroupsCache: { ...s.plannerGroupsCache, [groupsUrl]: { loading: false, data } } }));
        })
        .catch(() => {
          this.setPlannerState((s) => ({ plannerGroupsCache: { ...s.plannerGroupsCache, [groupsUrl]: { loading: false, data: { supported: false, groups: [] } } } }));
        });
    }

    // Clicking the radio option that's already active toggles it off
    // instead of just re-selecting the same thing:
    // - if that class type was never actually saved, the draft simply
    //   disappears (nothing to undo, there was nothing committed yet);
    // - if it WAS saved, we don't delete the real pick immediately — we
    //   mark it as pending removal so the grid can show it struck through
    //   until "Dodaj do planu" actually commits the removal. Clicking the
    //   same row again while pending removal re-selects it normally,
    //   which cancels the removal.
    plannerSelectGroup(key, groupsUrl, nr, classTypeLabel) {
      const cached = this.state.plannerGroupsCache[groupsUrl];
      const group = cached && cached.data ? cached.data.groups.find((g) => g.nr === nr) : null;
      if (!group) return;
      const current = this.state.plannerDraftSelection[key];
      const isReselectingActive = current && !current.removed && current.nr === nr;
      if (isReselectingActive) {
        const wasCommitted = this.state.plannerPicks.some((p) => p.key === key);
        this.setPlannerState((s) => {
          const next = { ...s.plannerDraftSelection };
          if (wasCommitted) next[key] = { removed: true, nr, classTypeLabel };
          else delete next[key];
          return { plannerDraftSelection: next };
        });
        return;
      }
      this.setPlannerState((s) => {
        // Committing to a concrete group ends the visual browsing for that
        // class type: with the preview left on, the freshly-chosen draft
        // ghost would keep hiding under the pile of remaining candidate
        // boxes at the same slot.
        const preview = { ...s.plannerPreviewKeys };
        delete preview[key];
        return { plannerDraftSelection: { ...s.plannerDraftSelection, [key]: { ...group, classTypeLabel } }, plannerPreviewKeys: preview };
      });
    }

    // Toggles one class type's "podgląd w planie". While on, EVERY group of
    // that class type is drawn on the preview grid as a hoverable ghost
    // (renderPlannerGrid) next to the picks already made — the student can
    // try each group on for size visually before committing to one.
    // Toggling on also fetches the group list if it isn't cached yet
    // (plannerLoadGroups is idempotent when it is), so entering visual mode
    // is a single click — no need to press "Pokaż grupy" first.
    plannerTogglePreview(key, groupsUrl, classTypeLabel) {
      if (!key || !groupsUrl) return;
      const on = !this.state.plannerPreviewKeys[key];
      this.setPlannerState((s) => {
        const next = { ...s.plannerPreviewKeys };
        if (on) next[key] = { groupsUrl, classTypeLabel };
        else delete next[key];
        return { plannerPreviewKeys: next };
      });
      if (on) this.plannerLoadGroups(groupsUrl);
    }

    // "Podgląd wszystkich grup" for the whole active cycle at once — the
    // same operation as plannerTogglePreview, applied to every class type
    // that has a groups list. Turning everything off only clears THIS
    // subject's flags.
    plannerTogglePreviewAll(url) {
      if (!url) return;
      const details = this.state.plannerSubjectCache[url];
      if (!details || !details.supported) return;
      const relevantCycles = details.cycles.filter((c) => !/zakończon/i.test(c.cycleState || ''));
      const cycle = (relevantCycles.length ? relevantCycles : details.cycles)[0];
      if (!cycle) return;
      const pairs = (cycle.classTypes || [])
        .filter((ct) => ct.groupsUrl)
        .map((ct) => [classTypeKey(url, cycle.cycleName, ct.label), { groupsUrl: ct.groupsUrl, classTypeLabel: ct.label }]);
      if (!pairs.length) return;
      const allOn = pairs.every(([key]) => this.state.plannerPreviewKeys[key]);
      this.setPlannerState((s) => {
        const next = { ...s.plannerPreviewKeys };
        pairs.forEach(([key, meta]) => {
          if (allOn) delete next[key];
          else next[key] = meta;
        });
        return { plannerPreviewKeys: next };
      });
      if (!allOn) pairs.forEach(([, meta]) => this.plannerLoadGroups(meta.groupsUrl));
    }

    // Commits every class-type choice made for the currently-expanded
    // subject into the saved plan: a normal draft replaces any prior pick
    // for the same class type (same `key`), and one marked `removed` (see
    // plannerSelectGroup) drops it instead of recreating it. Every other
    // subject's picks are left untouched.
    plannerAddSubject(url, subjectName, cycleName) {
      const draft = this.state.plannerDraftSelection;
      const keys = Object.keys(draft);
      if (!keys.length) return;
      const newPicks = keys
        .filter((key) => !draft[key].removed)
        .map((key) => {
          const g = draft[key];
          return {
            key,
            subjectUrl: url,
            subjectName,
            cycleName,
            classTypeLabel: g.classTypeLabel,
            classTypeShort: shortClassType(g.classTypeLabel),
            nr: g.nr,
            sessions: g.sessions,
            teacher: g.teacher,
            occupancy: g.occupancy,
            detailsUrl: g.detailsUrl,
          };
        });
      const otherPicks = this.state.plannerPicks.filter((p) => !keys.includes(p.key));
      this.savePlannerPicks([...otherPicks, ...newPicks], { plannerExpandedUrl: null, plannerPreviewKeys: {} });
    }

    plannerRemovePick(key) {
      this.savePlannerPicks(this.state.plannerPicks.filter((p) => p.key !== key));
    }

    get plannerPicksBySubject() {
      const map = new Map();
      this.state.plannerPicks.forEach((p) => {
        const id = subjectId(p.subjectUrl);
        if (!map.has(id)) map.set(id, { subjectUrl: p.subjectUrl, subjectName: p.subjectName, picks: [] });
        map.get(id).picks.push(p);
      });
      return [...map.values()];
    }

    // Every subject the planner (manual list AND automatic generator's
    // subject picker) can offer: auto-detected from the student's current
    // programme stage, plus anything added via "Dodaj przedmiot spoza
    // listy" (derived straight from plannerPicks — see renderPlannerBody's
    // former inline version of this, now shared so both modes agree).
    get plannerSubjectCandidates() {
      const stages = this.stageSubjects;
      const stageRanks = stages.map((s) => cycleRank(stageCycleLabel(s)));
      const knownRanks = stageRanks.filter((r) => r !== null);
      const earliestRank = knownRanks.length ? Math.min(...knownRanks) : null;
      const currentStages = earliestRank === null
        ? stages
        : stages.filter((s, i) => stageRanks[i] === null || stageRanks[i] === earliestRank);
      const skippedStages = stages.length - currentStages.length;

      const allSubjects = [];
      const seen = new Set();
      currentStages.forEach((stage) => (stage.sections || []).forEach((section) => (section.subjects || []).forEach((s) => {
        if (!s.detailsUrl || seen.has(s.detailsUrl)) return;
        seen.add(s.detailsUrl);
        allSubjects.push(s);
      })));

      const knownIds = new Set(allSubjects.map((s) => subjectId(s.detailsUrl)));
      const customSubjects = [];
      const seenCustom = new Set();
      this.state.plannerPicks.forEach((p) => {
        const id = subjectId(p.subjectUrl);
        if (knownIds.has(id) || seenCustom.has(id)) return;
        seenCustom.add(id);
        customSubjects.push({ name: p.subjectName, code: '', detailsUrl: p.subjectUrl });
      });

      return { subjects: [...allSubjects, ...customSubjects], autoCount: allSubjects.length, skippedStages };
    }

    // Colour is assigned by subject NAME, not by subject id — USOS often
    // splits one real course into separate wykład/ćwiczenia/lab subjects
    // with their own prz_kod (so they're tracked as distinct picks), but
    // they share the exact same displayed name (e.g. two "Fizyka 1A" rows)
    // and a student thinks of them as one course, so they should share a
    // colour. Assigning by position in an alphabetically-sorted list of
    // every name currently in view (rather than hashing the name) avoids
    // two unrelated subjects landing on the same colour by coincidence,
    // for as many distinct subjects as the palette has hues.
    get plannerColorIndex() {
      const names = new Set();
      this.stageSubjects.forEach((stage) => (stage.sections || []).forEach((section) => (section.subjects || []).forEach((s) => {
        if (s.name) names.add(s.name.trim().toLowerCase());
      })));
      this.state.plannerPicks.forEach((p) => {
        if (p.subjectName) names.add(p.subjectName.trim().toLowerCase());
      });
      const map = new Map();
      [...names].sort().forEach((n, i) => map.set(n, i));
      return map;
    }

    plannerColorSeed(name) {
      const key = (name || '').trim().toLowerCase();
      const map = this.plannerColorIndex;
      return map.has(key) ? map.get(key) : hashStr(key);
    }

    handleChange(e) {
      const el = e.target.closest('[data-bind]');
      if (!el) return;
      // The auto-generator's preference fields (time/number inputs) fire
      // 'change' on every native spinner/arrow nudge, not just on blur —
      // routing those through the generic setState below would replay the
      // whole page's fade-in on each one (see setTopbarState's comment for
      // the same issue elsewhere). setPlannerPrefsState only patches that
      // one card.
      if (el.dataset.bind.startsWith('plannerAuto')) {
        this.setPlannerPrefsState({ [el.dataset.bind]: el.value });
        return;
      }
      this.setState({ [el.dataset.bind]: el.value });
    }

    handleInput(e) {
      if (e.target.dataset.action === 'searchInput') this.onSearchInput(e.target.value);
      else if (e.target.dataset.action === 'plannerSearchInput') this.onPlannerSearchInput(e.target.value);
      else if (e.target.dataset.action === 'mapaSearchInput') this.onMapaSearchInput(e.target.value);
      else if (e.target.dataset.action === 'catalogSubjectQueryInput') this.setCatalogSubjectsState({ catalogSubjectQuery: e.target.value });
      else if (e.target.dataset.action === 'katalogPrzedmiotyQueryInput') this.setKatalogPrzedmiotyQueryState({ katalogPrzedmiotyQuery: e.target.value });
      else if (e.target.dataset.action === 'katalogBudynkiQueryInput') this.setKatalogBudynkiQueryState({ katalogBudynkiQuery: e.target.value });
    }

    handleKeydown(e) {
      if (e.target.dataset.action === 'searchInput' && e.key === 'Escape') {
        this.clearSearch();
        e.target.blur();
      } else if (e.target.dataset.action === 'mapaSearchInput' && e.key === 'Escape') {
        this.mapaClearSearch();
        e.target.blur();
      }
    }

    // Debounced so we're not firing three requests per keystroke — 3 chars
    // minimum matches the classic <usos-selector> autocomplete's own
    // min-search-length, so we're never querying anything USOS itself
    // wouldn't bother searching for either.
    onSearchInput(value) {
      this.state.searchQuery = value; // the <input> already shows this — no DOM patch needed just for that
      clearTimeout(this._searchDebounce);
      const q = value.trim();
      if (q.length < 3) {
        this.setSearchState({ searchResults: null, searchLoading: false });
        // Two characters are already enough to resolve a campus building
        // (renderSearchResults matches buildings locally) — warm the
        // campus list at that point so those queries can answer too.
        if (q.length === 2) this.ensureMapaData();
        return;
      }
      // Katalog search is about to fire; buildings meanwhile answer from
      // the campus list client-side, so warm it if not loaded yet.
      // ensureMapaData() is idempotent and mostly serves from cache, and
      // its loading state only ever affects the Mapa view's rendering.
      this.ensureMapaData();
      this.setSearchState({ searchLoading: true });
      this._searchDebounce = setTimeout(() => this.runSearch(q), 300);
    }

    async runSearch(query) {
      const scrape = window.USOSPP_SCRAPE;
      if (!scrape) { this.setSearchState({ searchLoading: false }); return; }
      const results = await scrape.searchCatalog(query);
      // The query may have changed (or been cleared) while this was in
      // flight — a stale, slower response landing after a newer one (or
      // after the box was cleared) shouldn't clobber what's now on screen.
      if (this.state.searchQuery.trim() !== query) return;
      this.setSearchState({ searchLoading: false, searchResults: results });
    }

    clearSearch() {
      this.state.searchQuery = '';
      this.setSearchState({ searchResults: null, searchLoading: false });
      const input = this.root.querySelector('[data-search-input]');
      if (input) input.value = '';
    }

    // Same debounce/min-length/staleness-guard shape as onSearchInput/
    // runSearch above, kept as its own state slice (plannerCustomSearch*)
    // rather than reusing searchQuery/searchResults — this box lives inside
    // the planner, not the topbar, and the two shouldn't clobber each
    // other's in-flight query if both happened to be touched.
    onPlannerSearchInput(value) {
      this.state.plannerCustomSearchQuery = value; // the <input> already shows this — no DOM patch needed just for that
      clearTimeout(this._plannerSearchDebounce);
      const q = value.trim();
      if (q.length < 3) {
        this.setPlannerSearchState({ plannerCustomSearchResults: null, plannerCustomSearchLoading: false });
        return;
      }
      this.setPlannerSearchState({ plannerCustomSearchLoading: true });
      this._plannerSearchDebounce = setTimeout(() => this.runPlannerSearch(q), 300);
    }

    async runPlannerSearch(query) {
      const scrape = window.USOSPP_SCRAPE;
      if (!scrape) { this.setPlannerSearchState({ plannerCustomSearchLoading: false }); return; }
      const results = await scrape.searchCatalog(query);
      if (this.state.plannerCustomSearchQuery.trim() !== query) return;
      this.setPlannerSearchState({ plannerCustomSearchLoading: false, plannerCustomSearchResults: results.subjects });
    }

    emitSettings(payload) {
      this.root.dispatchEvent(new CustomEvent('usospp:settings', { detail: payload, bubbles: true }));
    }

    render() {
      const dark = this.settings.darkMode;
      this.root.innerHTML = `
        <div class="usospp-root" data-theme="${dark ? 'dark' : 'light'}" data-action="closeMenus">
          ${this.renderSidebar()}
          <div class="usospp-main">
            ${this.renderTopbar()}
            <main class="usospp-content" data-action="closeMenus" data-content-root>
              ${this.renderBetaNotice()}
              ${this.renderView()}
            </main>
          </div>
          <div data-modal-root>${this.renderModals()}</div>
        </div>
      `;
      this.updateDocumentTitle();
      this.mountMapaIfNeeded();
      this.mountUnitMapPreview();
    }

    // Unlike the Aktualności dot, this has no "seen" state to persist — it's
    // just a live reflection of whether any due is currently outstanding, so
    // it disappears on its own once everything is paid off. Always on, not a
    // toggle in Ustawienia.
    hasUnpaidPayments() {
      const unpaid = this.data.paymentsResult && this.data.paymentsResult.unpaid;
      return !!(unpaid && unpaid.groups && unpaid.groups.some((g) => g.rows && g.rows.length > 0));
    }

    // Small "needs attention" dot per nav item id — factored out so both the
    // top-level rows and the collapsed "Więcej" summary row (see
    // renderSidebar) can ask the same question.
    navItemDot(id) {
      if (id === 'aktualnosci') return this.state.newsHasUpdate;
      if (id === 'platnosci') return this.hasUnpaidPayments();
      if (id === 'ankiety') return this.pendingSurveys.length > 0;
      return false;
    }

    renderSidebar() {
      const u = this.data.user || {};
      const initials = (u.name || '? ?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
      // Logged out, only PUBLIC_VIEWS render real content — everything else
      // lands on the login prompt (renderView's gate). The click behavior
      // stays exactly the same, but locked rows get a lock icon + dimmed
      // style so it's obvious upfront which sections need a login. External
      // link-outs (Wiadomości) have no view id in PUBLIC_VIEWS, so they read
      // as locked too.
      const loggedOut = !!this.data.loggedOut;
      const renderNavItem = (item, sub) => {
        const locked = loggedOut && !PUBLIC_VIEWS.has(item.id);
        const lockedClass = locked ? ' usospp-nav-item-locked' : '';
        const lockedTitle = locked ? ' title="Wymaga zalogowania"' : '';
        return item.external ? `
        <div class="usospp-nav-item${sub ? ' sub' : ''}${lockedClass}" data-action="openUsos" data-url="${esc(location.origin)}/${item.external}" title="${locked ? 'Wymaga zalogowania — ' : ''}Otwiera klasyczny USOS w nowej karcie">
          ${icon(locked ? 'lock' : item.icon)}<span>${esc(item.label)}</span>
        </div>
      ` : `
        <div class="usospp-nav-item${sub ? ' sub' : ''}${this.isNavActive(item.id) ? ' active' : ''}${lockedClass}" data-action="nav" data-view="${item.id}"${lockedTitle}>
          ${icon(locked ? 'lock' : item.icon)}<span>${esc(item.label)}</span>
          ${this.navItemDot(item.id) ? '<span class="usospp-nav-dot"></span>' : ''}
        </div>
      `;
      };
      // Three states, independent of each other: fully expanded shows every
      // item (moreExpanded); collapsed-but-something-inside-is-active shows
      // just that one row, so you never lose track of where you are; fully
      // collapsed (not expanded, nothing active inside) shows nothing.
      // moreOpen only ever means "fully expanded" — it does NOT auto-force
      // itself open just because the active view happens to live in here,
      // otherwise there'd be no way to collapse it back while still on one
      // of its pages.
      const moreOpen = this.state.moreExpanded;
      // Hidden views (HIDDEN_NAV_ITEMS) are left out of the listing and the
      // collapsed dot, but the active-row lookup below runs on the full list
      // on purpose — a hidden view opened directly still shows its row for
      // orientation, exactly like any other active "Więcej" item.
      const visibleMoreItems = MORE_NAV_ITEMS.filter((item) => !HIDDEN_NAV_ITEMS.has(item.id));
      const activeMoreItem = MORE_NAV_ITEMS.find((item) => item.id === this.state.view);
      const moreActive = !!activeMoreItem;
      const moreHasDot = !moreOpen && !activeMoreItem && visibleMoreItems.some((item) => this.navItemDot(item.id));
      const moreChildren = moreOpen
        ? visibleMoreItems.map((item) => renderNavItem(item, true)).join('')
        : (activeMoreItem ? renderNavItem(activeMoreItem, true) : '');
      return `
        <aside class="usospp-sidebar" data-sidebar-root>
          <div class="usospp-brand">
            <div class="usospp-logo">${logoSvg(false)}</div>
            <div class="usospp-brand-text">USOS<span>++</span></div>
          </div>
          <nav class="usospp-nav">
            ${NAV_ITEMS.map((item) => renderNavItem(item, false)).join('')}
            <div class="usospp-nav-item${moreActive ? ' active' : ''}" data-action="toggleMore">
              ${icon('more')}<span>Więcej</span>
              <div style="margin-left:auto;display:flex;align-items:center;gap:6px;">
                ${moreHasDot ? '<span style="width:7px;height:7px;border-radius:50%;background:#d9773a;flex-shrink:0;"></span>' : ''}
                <span class="usospp-nav-chevron${moreOpen ? ' open' : ''}">${icon('chevron', 12)}</span>
              </div>
            </div>
            ${moreChildren}
          </nav>
          <div class="usospp-spacer"></div>
          ${loggedOut ? `
          <a class="usospp-user-card" ${this.data.loginUrl ? `href="${esc(this.data.loginUrl)}"` : `data-action="nav" data-view="dashboard"`} style="text-decoration:none;" title="Zaloguj się do USOSweb">
            <div class="usospp-avatar" style="background:oklch(38% 0.01 55);">${icon('lock', 16)}</div>
            <div class="usospp-user-meta">
              <div class="usospp-user-name">Niezalogowany</div>
              <div class="usospp-user-sub">Zaloguj się →</div>
            </div>
          </a>
          ` : `
          <div class="usospp-user-card" data-action="nav" data-view="ustawienia" title="Ustawienia">
            <div class="usospp-avatar">${esc(initials || '—')}</div>
            <div class="usospp-user-meta">
              <div class="usospp-user-name">${esc(u.name || 'Nie rozpoznano')}</div>
              <div class="usospp-user-sub">${esc(this.kierunek || u.faculty || (u.album ? `nr albumu ${u.album}` : '—'))}</div>
            </div>
          </div>
          `}
        </aside>
      `;
    }

    // "przedmioty" groups przedmiotyLista/zapisy/planer under one nav row
    // (see NAV_GROUPS) — a nav item should read as active from anywhere in
    // its group, including a subject-detail page opened from within it.
    isNavActive(itemId) {
      const group = NAV_GROUPS[itemId] || [itemId];
      if (group.includes(this.state.view)) return true;
      return this.state.view === 'subjectPage' && group.includes(this.state.subjectBackView);
    }

    renderTopbar() {
      let [title, subtitle] = TITLES[this.state.view] || ['', ''];
      if (this.state.view === 'subjectPage' && this.state.subjectData) {
        title = this.state.subjectData.subjectName || title;
      }
      if (this.state.view === 'catalogPage' && this.state.catalogData) {
        title = this.state.catalogData.name || this.state.catalogData.label || title;
      }
      const u = this.data.user || {};
      const initials = (u.name || '? ?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
      return `
        <header class="usospp-topbar" data-topbar-root>
          <div>
            <div class="usospp-title">${esc(title)}</div>
            <div class="usospp-subtitle">${esc(subtitle)}</div>
          </div>
          <div class="usospp-topbar-actions">
            <div class="usospp-search-wrap">
              <input
                class="usospp-search-input"
                data-action="searchInput"
                data-search-input
                type="text"
                placeholder="Szukaj przedmiotu, jednostki, programu studiów…"
                value="${esc(this.state.searchQuery)}"
              >
              <div data-search-results-root>${this.renderSearchResults()}</div>
            </div>
            <div class="usospp-menu-wrap">
              <button class="usospp-icon-btn" data-action="toggleNotifPanel" title="Powiadomienia">${icon('bell', 17)}</button>
              ${this.state.notifPanelOpen ? `
                <div class="usospp-dropdown" data-action="stop">
                  <div class="usospp-dropdown-head">
                    <span>Aktualności</span>
                  </div>
                  ${this.renderNotifPanelBody()}
                </div>
              ` : ''}
            </div>
            <div class="usospp-divider"></div>
            <div class="usospp-menu-wrap">
              <div class="usospp-avatar-trigger" data-action="toggleAvatarMenu">
                <div class="usospp-avatar">${esc(initials || '—')}</div>
                <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="var(--ink-2)" stroke-width="2"><path d="M5 8l5 5 5-5"></path></svg>
              </div>
              ${this.state.avatarMenuOpen ? `
                <div class="usospp-dropdown" data-action="stop">
                  <div class="usospp-dropdown-head-block">
                    <div class="usospp-dropdown-name">${esc(u.name || '—')}</div>
                    <div class="usospp-dropdown-sub">${u.album ? `nr albumu ${esc(u.album)}` : '—'}</div>
                  </div>
                  <div class="usospp-dropdown-item" data-action="nav" data-view="ustawienia">Ustawienia konta</div>
                  <div class="usospp-dropdown-item" data-action="disableUsospp" style="color:oklch(58% 0.19 25);">Wyłącz panel USOS++ / Powrót do USOS</div>
                </div>
              ` : ''}
            </div>
          </div>
        </header>
      `;
    }

    // Small preview inside the topbar's bell dropdown — full announcements
    // (with their formatted body) live on the "Aktualności" nav page, this
    // is just titles + a link over there.
    renderNotifPanelBody() {
      const news = this.data.newsResult || {};
      const items = (news.items || []).slice(0, 4);
      if (!news.supported || items.length === 0) {
        return `<div class="usospp-empty-hint">Brak aktualności do wyświetlenia.</div>`;
      }
      return `
        ${items.map((item) => `
          <div class="usospp-dropdown-item" data-action="nav" data-view="aktualnosci">${esc(item.title)}</div>
        `).join('')}
        <div class="usospp-dropdown-item" data-action="nav" data-view="aktualnosci" style="text-align:center;color:#d9773a;font-weight:600;">Zobacz wszystkie →</div>
      `;
    }

    // Topbar search dropdown — see scraping.js's searchCatalog. Osoby
    // (people) search isn't included here: it's the one Katalog search that
    // goes through USOSmail's same CSRF-walled internal proxy, so it stays
    // out of scope the same way USOSmail itself did.
    renderSearchResults() {
      const q = this.state.searchQuery.trim();
      if (q.length < 2) return '';
      const ql = q.toLowerCase();
      // Campus buildings come from the already-loaded campus list (warmed
      // by onSearchInput) and are matched client-side — no server query —
      // so they can answer at 2 characters, before the 3-char katalog
      // search has even fired. Empty when the list isn't loaded yet or its
      // fetch failed; the section then simply doesn't appear.
      // b.kod required: buildings whose USOS row carried no bud_kod (rare —
      // 1 of 93 rows on a live PWr fetch) can't be focused by kod after the
      // click, so offering them as search results would be a silent no-op.
      const buildings = this.state.mapaBuildings
        .filter((b) => b.kod && (
          (b.name && b.name.toLowerCase().includes(ql))
          || String(b.kod).toLowerCase().includes(ql)
          || (b.address && b.address.toLowerCase().includes(ql))))
        .slice(0, 4);
      const buildingItem = (b) => `
        <div class="usospp-search-item" data-action="openMapaFocused" data-kod="${esc(b.kod)}">
          <div class="usospp-search-item-title">${esc(b.name)}</div>
          <div class="usospp-search-item-sub">${esc(b.address || b.unitName || '')}</div>
        </div>
      `;
      if (this.state.searchLoading) {
        if (!buildings.length) {
          return `<div class="usospp-search-dropdown"><div class="usospp-empty-hint" style="padding:16px;">Szukanie…</div></div>`;
        }
        return `
          <div class="usospp-search-dropdown">
            <div class="usospp-search-section-title">Budynki</div>
            ${buildings.map(buildingItem).join('')}
            <div class="usospp-empty-hint" style="padding:8px 16px 12px 16px;">Szukanie w katalogu…</div>
          </div>
        `;
      }
      const r = this.state.searchResults || { subjects: [], units: [], programs: [] };
      const total = r.subjects.length + r.units.length + r.programs.length + buildings.length;
      if (total === 0) {
        return `
          <div class="usospp-search-dropdown">
            <div class="usospp-empty-hint" style="padding:16px 16px 4px 16px;">Brak wyników dla „${esc(q)}”.</div>
            <div class="usospp-empty-hint" style="padding:0 16px 16px 16px;">
              Szukasz osoby? Wyszukiwanie osób nie jest tu dostępne —
              <a data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=katalog2/osoby/index&usospp_off=1" style="font-weight:600;color:#d9773a;">sprawdź w klasycznym USOS →</a>
            </div>
          </div>
        `;
      }
      const section = (title, items, render) => (items.length ? `
        <div class="usospp-search-section-title">${esc(title)}</div>
        ${items.map(render).join('')}
      ` : '');
      return `
        <div class="usospp-search-dropdown">
          ${section('Budynki', buildings, buildingItem)}
          ${section('Przedmioty', r.subjects.slice(0, 6), (subj) => `
            <div class="usospp-search-item" data-action="searchOpenSubject" data-url="${esc(location.origin)}/kontroler.php?_action=katalog2/przedmioty/pokazPrzedmiot&prz_kod=${esc(subj.kod)}">
              <div class="usospp-search-item-title">${esc(subj.nazwa)}</div>
              <div class="usospp-search-item-sub">${esc(subj.jedn || '')}${subj.jedn ? ' · ' : ''}${esc(subj.kod)}</div>
            </div>
          `)}
          ${section('Jednostki', r.units.slice(0, 6), (unit) => `
            <div class="usospp-search-item" data-action="searchOpenUnit" data-kod="${esc(unit.kod)}">
              <div class="usospp-search-item-title">${esc(unit.nazwa)}</div>
              <div class="usospp-search-item-sub">${esc(unit.kod)}</div>
            </div>
          `)}
          ${section('Programy studiów', r.programs.slice(0, 6), (prog) => `
            <div class="usospp-search-item" data-action="searchOpenProgram" data-kod="${esc(prog.kod)}">
              <div class="usospp-search-item-title">${esc(prog.desc)}</div>
              <div class="usospp-search-item-sub">${esc(prog.kod)}</div>
            </div>
          `)}
        </div>
      `;
    }

    renderView() {
      // Logged out of USOSweb, the view split matters: sections built from
      // pages USOSweb itself serves to anonymous visitors (PUBLIC_VIEWS —
      // Aktualności, wyszukiwarka→katalog pages, campus Mapa) render
      // normally on public data alone, while every personal view falls back
      // to the same login prompt instead of its normal (empty) content —
      // the sidebar/topbar stay fully usable either way.
      if (this.data.loggedOut && !PUBLIC_VIEWS.has(this.state.view)) return this.renderLoggedOut();
      switch (this.state.view) {
        case 'dashboard': return this.renderDashboard();
        case 'aktualnosci': return this.renderAktualnosci();
        case 'plan': return this.renderPlan();
        case 'oceny': return this.renderOceny();
        case 'przedmioty': return this.renderPrzedmiotyHub();
        case 'przedmiotyLista': return this.renderPrzedmiotyLista();
        case 'zapisy': return this.renderZapisy();
        case 'planer': return this.renderPlanner();
        case 'egzaminy': return this.renderEgzaminy();
        case 'ects': return this.renderEcts();
        case 'platnosci': return this.renderPlatnosci();
        case 'stypendia': return this.renderStypendia();
        case 'sprawdziany': return this.renderSprawdziany();
        case 'podania': return this.renderPodania();
        case 'ankiety': return this.renderAnkiety();
        case 'ustawienia': return this.renderUstawienia();
        case 'subjectPage': return this.renderSubjectPage();
        case 'mapa': return this.renderMapa();
        case 'katalog': return this.renderKatalogHub();
        case 'katalogJednostki': return this.renderKatalogJednostki();
        case 'katalogPrzedmioty': return this.renderKatalogPrzedmioty();
        case 'katalogKierunki': return this.renderKatalogKierunki();
        case 'katalogBudynki': return this.renderKatalogBudynki();
        case 'catalogPage': {
          if (this.state.catalogKind === 'unit') return this.renderUnitPage();
          if (this.state.catalogKind === 'stage') return this.renderStagePage();
          return this.renderProgramPage();
        }
        default: return '';
      }
    }

    // ---- helpers over scraped data -----------------------------------

    get gradeRows() {
      const g = this.data.gradesResult || {};
      if (!Array.isArray(g.rows)) return [];
      return g.rows;
    }

    get numericGrades() {
      return this.gradeRows
        .map((row) => {
          const cells = Array.isArray(row) ? row : [row.text];
          for (let i = cells.length - 1; i >= 0; i--) {
            const g = fmtGrade(cells[i]);
            if (g) return g;
          }
          return null;
        })
        .filter(Boolean);
    }

    get planEvents() {
      const p = this.data.planResult || {};
      return Array.isArray(p.raw) ? p.raw : [];
    }

    get etapy() {
      const e = this.data.etapyResult || {};
      return Array.isArray(e.etapy) ? e.etapy : [];
    }

    get exams() {
      const ex = this.data.examsResult || {};
      return Array.isArray(ex.exams) ? ex.exams : [];
    }

    get registrationGroups() {
      const r = this.data.registrationsResult || {};
      return Array.isArray(r.groups) ? r.groups : [];
    }

    get ownProgrammes() {
      const p = this.data.ownProgrammesResult || {};
      return Array.isArray(p.programmes) ? p.programmes : [];
    }

    // Same source renderZapisy already relies on for "Tylko mój kierunek" —
    // the "Wymagania etapów studiów" hub is the only reliable "what's my
    // kierunek" signal we have (see getOwnProgrammes' comment in adapters.js).
    get kierunek() {
      return this.ownProgrammes.find((p) => p.directionName)?.directionName || null;
    }

    get stageSubjects() {
      const s = this.data.stageSubjectsResult || {};
      return Array.isArray(s.stages) ? s.stages : [];
    }

    get pendingSurveys() {
      const s = this.data.surveysResult || {};
      return Array.isArray(s.rows) ? s.rows : [];
    }

    // ---- views ---------------------------------------------------------

    renderLoggedOut() {
      const loginUrl = this.data.loginUrl;
      return `
        <div class="usospp-view">
          <div class="usospp-loggedout">
            <div class="usospp-loggedout-logo">${logoSvg(false)}</div>
            <div class="usospp-loggedout-title">Zaloguj się do USOSweb</div>
            <p class="usospp-loggedout-text">Nie jesteś obecnie zalogowany/a, więc ten widok nie ma skąd wziąć danych. Aktualności, Katalog, Mapa kampusu i wyszukiwarka (przedmioty, jednostki, programy studiów) działają też bez logowania — wybierz je z menu po lewej.</p>
            ${loginUrl ? `
              <a class="usospp-btn-primary" style="display:inline-block;text-decoration:none;" href="${esc(loginUrl)}">Zaloguj się →</a>
            ` : `
              <p class="usospp-muted-text">Nie udało się znaleźć linku logowania — odśwież stronę.</p>
            `}
          </div>
        </div>
      `;
    }

    renderDashboard() {
      const grades = this.numericGrades;
      const avg = grades.length ? (grades.reduce((a, b) => a + parseFloat(b), 0) / grades.length).toFixed(2) : null;
      const events = this.planEvents;
      const etapy = this.etapy;
      const currentEtap = etapy[0];

      return `
        <div class="usospp-view">
          <div class="usospp-stat-grid">
            <div class="usospp-card usospp-stat">
              <div class="usospp-stat-label">Średnia (z widocznych ocen)</div>
              <div class="usospp-stat-value">${avg ? esc(avg) : '—'}</div>
              <div class="usospp-stat-hint">${grades.length ? `na podstawie ${grades.length} ocen` : 'brak ocen do policzenia'}</div>
            </div>
            <div class="usospp-card usospp-stat">
              <div class="usospp-stat-label">Etap studiów</div>
              <div class="usospp-stat-value" style="font-size:19px;">${currentEtap ? esc(currentEtap.label) : '—'}</div>
              <div class="usospp-stat-hint">${currentEtap ? esc(currentEtap.status || '') : 'brak danych'}</div>
            </div>
            <div class="usospp-card usospp-stat">
              <div class="usospp-stat-label">Kolejne zajęcia</div>
              <div class="usospp-stat-value" style="font-size:19px;">${events.length ? 'zobacz plan →' : 'brak'}</div>
              <div class="usospp-stat-hint">${events.length ? `${events.length} poz. w bieżącym tygodniu` : 'brak zajęć w planie'}</div>
            </div>
            <div class="usospp-card usospp-stat">
              <div class="usospp-stat-label">Egzaminy</div>
              <div class="usospp-stat-value">${this.exams.length || 0}</div>
              <div class="usospp-stat-hint" data-action="nav" data-view="egzaminy" style="cursor:pointer;font-weight:600;color:oklch(58% 0.15 45);">zobacz →</div>
            </div>
          </div>

          <div class="usospp-two-col">
            <div class="usospp-card">
              <div class="usospp-card-head"><div class="usospp-card-title">Plan zajęć — bieżący tydzień</div><a data-action="nav" data-view="plan" style="font-size:12.5px;font-weight:600;cursor:pointer;">szczegóły →</a></div>
              ${events.length ? `<div class="usospp-raw-dump">${esc(JSON.stringify(events.slice(0, 5), null, 2))}</div>` : `<div class="usospp-empty-hint">Brak zajęć zaplanowanych w tym tygodniu.</div>`}
            </div>
            <div class="usospp-card">
              <div class="usospp-card-head"><div class="usospp-card-title">Zaliczenia etapów</div></div>
              ${etapy.length ? etapy.map((e) => `
                <div class="usospp-list-row">
                  <div style="font-size:13px;">${esc(e.label)}</div>
                  <div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(e.status || '—')}</div>
                </div>
              `).join('') : `<div class="usospp-empty-hint">Brak danych o etapach.</div>`}
            </div>
          </div>
        </div>
      `;
    }

    // Same "strona główna" announcements USOS classic shows on login — see
    // adapter.getNews. Body HTML is already sanitized down to a plain-text
    // allowlist by the adapter (it's fetched HTML from a page we don't
    // control, not something we generated), so it's safe to inject directly
    // here without another esc() pass.
    renderAktualnosci() {
      const news = this.data.newsResult || {};
      const items = news.items || [];
      if (!news.supported) {
        return `<div class="usospp-view"><div class="usospp-empty-hint">Nie udało się odczytać aktualności ze strony USOS.</div></div>`;
      }
      if (items.length === 0) {
        return `<div class="usospp-view"><div class="usospp-empty-hint">Brak aktualności.</div></div>`;
      }
      return `
        <div class="usospp-view">
          ${items.map((item) => `
            <div class="usospp-card">
              ${item.date ? `<div class="usospp-muted-text" style="margin-bottom:6px;">${esc(item.date)}</div>` : ''}
              <div class="usospp-card-title" style="margin-bottom:10px;">${esc(item.title)}</div>
              <div class="usospp-news-body">${item.html}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    renderPlan() {
      const events = this.planEvents;
      const p = this.data.planResult || {};
      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Plan zajęć</div>
              <div style="display:flex;gap:10px;align-items:center;">
                <span class="usospp-tag-muted">${p.verified ? '' : 'podgląd eksperymentalny'}</span>
                <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=home/plan&usospp_off=1">Otwórz w USOS →</button>
              </div>
            </div>
            ${!p.supported ? `
              <div class="usospp-empty-hint">Nie udało się odczytać planu zajęć ze strony USOS.</div>
            ` : events.length ? `
              <p class="usospp-muted-text">Struktura pojedynczych zajęć w planie USOS nie została jeszcze w pełni potwierdzona (Twój plan jest obecnie pusty) — poniżej surowe dane odczytane ze strony, żeby nic nie zgubić:</p>
              <div class="usospp-raw-dump">${esc(JSON.stringify(events, null, 2))}</div>
            ` : `
              <div class="usospp-empty-hint">Brak zajęć zaplanowanych w tym tygodniu.</div>
            `}
          </div>
        </div>
      `;
    }

    renderOceny() {
      const rows = this.gradeRows;
      const g = this.data.gradesResult || {};
      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Oceny końcowe z przedmiotów</div>
              <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dla_stud/studia/oceny/index&usospp_off=1">Otwórz w USOS →</button>
            </div>
            ${!g.supported ? `
              <div class="usospp-empty-hint">Nie udało się odczytać ocen ze strony USOS.</div>
            ` : rows.length === 0 ? `
              <div class="usospp-empty-hint">Brak ocen końcowych — jeszcze nic tu nie ma w tym cyklu.</div>
            ` : `
              <table class="usospp-table">
                <tbody>
                  ${rows.map((row) => `<tr>${(Array.isArray(row) ? row : [row.label, row.text]).map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}
                </tbody>
              </table>
            `}
          </div>
        </div>
      `;
    }

    // The hub tile screen behind the "Przedmioty" nav item — Przegląd,
    // Zapisy and Generator planu each used to be their own top-level nav row;
    // grouping them here freed up sidebar space for future sections.
    renderPrzedmiotyHub() {
      const tiles = [
        { view: 'przedmiotyLista', icon: 'book', title: 'Przegląd przedmiotów', desc: 'Etapy studiów i przedmioty przypisane do Twojego programu.' },
        { view: 'zapisy', icon: 'ticket', title: 'Zapisy na przedmioty', desc: 'Kalendarz tur rejestracji na wydziale — bez zapisywania niczego za Ciebie.' },
        { view: 'planer', icon: 'layers', title: 'Generator planu', desc: 'Poukładaj sobie plan zajęć na próbę, zanim zapiszesz się naprawdę.' },
      ];
      // All three tiles are personal — logged out they all land on the login
      // prompt, so dim them with the shared locked-tile style + lock pill
      // (same as IRK's renderHubTile) instead of looking freely available.
      const locked = !!this.data.loggedOut;
      return `
        <div class="usospp-view">
          <div class="usospp-hub-grid">
            ${tiles.map((t) => `
              <div class="usospp-hub-tile${locked ? ' usospp-hub-tile-locked' : ''}" data-action="nav" data-view="${esc(t.view)}">
                <div class="usospp-hub-tile-icon">${icon(locked ? 'lock' : t.icon, 20)}</div>
                <div class="usospp-hub-tile-title">${esc(t.title)}</div>
                ${locked
                  ? `<div class="usospp-lock-hint">${icon('lock', 12)} Zaloguj się, aby odblokować</div>`
                  : `<div class="usospp-hub-tile-desc">${esc(t.desc)}</div>`}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Publiczny hub Katalogu — ten sam pattern co renderPrzedmiotyHub:
    // kafelki prowadzą do pod-widoków przez data-action="nav". Działa bez
    // logowania (PUBLIC_VIEWS), wszystko dociągane leniwie z katalog2.
    renderKatalogHub() {
      const tiles = [
        { view: 'katalogJednostki', icon: 'grid', title: 'Jednostki', desc: 'Wydziały, katedry i instytuty — przeglądaj strukturę uczelni.' },
        { view: 'katalogPrzedmioty', icon: 'book', title: 'Przedmioty', desc: 'Oferta przedmiotów wybranej jednostki.' },
        { view: 'katalogKierunki', icon: 'star', title: 'Kierunki i programy', desc: 'Co można studiować — programy zgrupowane po kierunku.' },
        { view: 'katalogBudynki', icon: 'pin', title: 'Budynki', desc: 'Lista budynków z adresami i podglądem na mapie.' },
      ];
      return `
        <div class="usospp-view">
          <div class="usospp-hub-grid">
            ${tiles.map((t) => `
              <div class="usospp-hub-tile" data-action="nav" data-view="${esc(t.view)}">
                <div class="usospp-hub-tile-icon">${icon(t.icon, 20)}</div>
                <div class="usospp-hub-tile-title">${esc(t.title)}</div>
                <div class="usospp-hub-tile-desc">${esc(t.desc)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Jednostki: przeglądanie drzewa od korzenia uczelni. Root wyprowadzany
    // jak w fetchMapaData (własny wydział → ancestors[0], anonimowo: public
    // search → ancestors). Klik w dziecko przełącza browse na tę jednostkę,
    // klik w nazwę/„szczegóły” otwiera pełną stronę catalogPage unit.
    renderKatalogJednostki() {
      const s = this.state;
      if (s.katalogRootLoading || s.katalogBrowseLoading) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie jednostek…</div></div></div>`;
      }
      const data = s.katalogBrowseData || s.katalogRootData;
      if (s.katalogRootError || s.katalogBrowseError || !data) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać jednostek.</div><div style="margin-top:10px;"><a data-action="katalogRetry" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div></div></div>`;
      }
      const atRoot = !s.katalogBrowseKod || s.katalogBrowseKod === s.katalogRootKod;
      return `
        <div class="usospp-view">
          ${backLink('katalog')}
          <div class="usospp-card">
            ${data.ancestors && data.ancestors.length ? `
              <div style="font-size:12.5px;color:var(--ink-3);margin-bottom:10px;">
                ${data.ancestors.map((a) => `<span data-action="katalogBrowseUnit" data-kod="${esc(a.kod)}" style="text-decoration:underline;cursor:pointer;">${esc(a.name)}</span>`).join(' / ')}
              </div>
            ` : ''}
            <div class="usospp-card-title" style="margin-bottom:6px;">${esc(data.name || 'Jednostki')}</div>
            <div style="margin-bottom:14px;"><a data-action="searchOpenUnit" data-kod="${esc(atRoot ? (s.katalogRootKod || '') : (s.katalogBrowseKod || ''))}" style="font-size:12.5px;font-weight:600;cursor:pointer;">szczegóły jednostki →</a></div>
            ${(data.children || []).length ? `
              <div class="usospp-card" style="box-shadow:none;border:1px solid var(--border);">
                <div class="usospp-card-title" style="margin-bottom:14px;">Jednostki podrzędne (${(data.children || []).length})</div>
                ${(data.children || []).map((c) => `
                  <div class="usospp-list-row" data-action="katalogBrowseUnit" data-kod="${esc(c.kod)}" style="cursor:pointer;">
                    <div style="font-size:13.5px;font-weight:500;">${esc(c.name)}</div>
                    <div style="color:var(--ink-3);">→</div>
                  </div>
                `).join('')}
              </div>
            ` : `<div class="usospp-empty-hint">Brak podjednostek.</div>`}
          </div>
        </div>
      `;
    }

    // Wspólny picker jednostek (dzieci roota = wydziały) dla Przedmiotów
    // i Kierunków. USOS nie ma endpointu „wszystkie przedmioty uczelni” —
    // jest tylko oferta per jednostka (faculty_organized / by_faculty),
    // więc wybór wydziału jest bramą do przeglądania, nie doodatkiem.
    renderKatalogUnitPicker(selectedKod) {
      const root = this.state.katalogRootData;
      const kids = (root && root.children) || [];
      if (!kids.length) return '';
      const chipStyle = 'flex:0 0 auto;border-radius:99px;padding:6px 13px;font-size:12.5px;';
      return `
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">
          ${kids.map((c) => `<button class="usospp-mode-btn${selectedKod === c.kod ? ' active' : ''}" style="${chipStyle}" data-action="katalogSelectUnit" data-kod="${esc(c.kod)}">${esc(c.name)}</button>`).join('')}
        </div>
      `;
    }

    renderKatalogPrzedmioty() {
      const s = this.state;
      if (s.katalogRootLoading) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie jednostek…</div></div></div>`;
      }
      if (s.katalogRootError || !s.katalogRootData) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać jednostek.</div><div style="margin-top:10px;"><a data-action="katalogRetry" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div></div></div>`;
      }
      const q = (s.katalogPrzedmiotyQuery || '').trim().toLowerCase();
      const currentYear = (() => {
        const years = new Set();
        s.katalogPrzedmioty.forEach((r) => (r.years || []).forEach((y) => years.add(y)));
        return years.size ? Math.max(...years) : null;
      })();
      const rows = s.katalogPrzedmioty.filter((r) => {
        if (s.katalogPrzedmiotyCurrentOnly && currentYear && !(r.years || []).includes(currentYear)) return false;
        if (!q) return true;
        return (r.name || '').toLowerCase().includes(q) || (r.kod || '').toLowerCase().includes(q);
      });
      const yearLabel = currentYear ? `${currentYear}/${String((currentYear + 1) % 100).padStart(2, '0')}` : '';
      return `
        <div class="usospp-view">
          ${backLink('katalog')}
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:12px;">Wybierz jednostkę</div>
            ${this.renderKatalogUnitPicker(s.katalogPrzedmiotyUnitKod)}
            ${!s.katalogPrzedmiotyUnitKod ? `<div class="usospp-empty-hint">Wybierz wydział powyżej, aby zobaczyć jego ofertę przedmiotów.</div>` : `
              <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">
                <input class="usospp-search-input" data-action="katalogPrzedmiotyQueryInput" type="text" placeholder="Szukaj po nazwie lub kodzie…" autocomplete="off" value="${esc(s.katalogPrzedmiotyQuery)}" style="flex:1;">
                ${currentYear && s.katalogPrzedmioty.length ? `<a data-action="katalogPrzedmiotyToggleCurrent" style="font-size:12px;font-weight:600;color:${s.katalogPrzedmiotyCurrentOnly ? '#d9773a' : 'var(--ink-3)'};white-space:nowrap;cursor:pointer;">${s.katalogPrzedmiotyCurrentOnly ? '●' : '○'} tylko ${esc(yearLabel)}</a>` : ''}
              </div>
              <div data-katalog-przedmioty-root>
                ${s.katalogPrzedmiotyLoading && !s.katalogPrzedmioty.length ? `<div class="usospp-empty-hint">Wczytywanie przedmiotów…</div>` : `
                  ${rows.slice(0, 400).map((r) => `
                    <div class="usospp-list-row" data-action="openSubjectPage" data-url="${esc(r.url)}" style="cursor:pointer;align-items:flex-start;">
                      <div>
                        <div style="font-size:13.5px;font-weight:500;">${esc(r.name)}</div>
                        ${r.grupa ? `<div style="color:var(--ink-3);font-size:12px;margin-top:2px;">${esc(r.grupa)}</div>` : ''}
                      </div>
                      <div style="color:var(--ink-3);font-size:11.5px;font-family:ui-monospace,Menlo,monospace;flex-shrink:0;">${esc(r.kod)}</div>
                    </div>
                  `).join('')}
                  ${rows.length > 400 ? `<div class="usospp-empty-hint">Pokazuję pierwszych 400 — doprecyzuj wyszukiwanie, aby zawęzić.</div>` : ''}
                  ${!rows.length && !s.katalogPrzedmiotyLoading ? `<div class="usospp-empty-hint">Brak przedmiotów${q || (s.katalogPrzedmiotyCurrentOnly && currentYear) ? ' spełniających filtr' : ' w tej jednostce'}.</div>` : ''}
                  ${s.katalogPrzedmiotyLoading ? `<div class="usospp-empty-hint">Wczytywanie…</div>` : ''}
                  ${s.katalogPrzedmiotyNextUrl && !s.katalogPrzedmiotyLoading ? `<a data-action="katalogPrzedmiotyLoadMore" style="display:inline-block;margin-top:10px;font-size:13px;font-weight:600;color:#d9773a;cursor:pointer;">Wczytaj więcej →</a>` : ''}
                `}
              </div>
            `}
          </div>
        </div>
      `;
    }

    // Wariant A: brak osobnego parsera kierunku — programy grupowane po
    // polu `kierunek` z getUnitPrograms (jeden wiersz USOS na kierunek,
    // w środku kilka instancji pokazProgram). Klik → searchOpenProgram.
    renderKatalogKierunki() {
      const s = this.state;
      if (s.katalogRootLoading) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie jednostek…</div></div></div>`;
      }
      if (s.katalogRootError || !s.katalogRootData) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać jednostek.</div><div style="margin-top:10px;"><a data-action="katalogRetry" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div></div></div>`;
      }
      const byKierunek = new Map();
      s.katalogKierunki.forEach((p) => {
        const key = p.kierunek || '—';
        if (!byKierunek.has(key)) byKierunek.set(key, []);
        byKierunek.get(key).push(p);
      });
      return `
        <div class="usospp-view">
          ${backLink('katalog')}
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:12px;">Wybierz jednostkę</div>
            ${this.renderKatalogUnitPicker(s.katalogKierunkiUnitKod)}
            ${!s.katalogKierunkiUnitKod ? `<div class="usospp-empty-hint">Wybierz wydział powyżej, aby zobaczyć jego kierunki i programy.</div>` : `
              ${s.katalogKierunkiLoading && !s.katalogKierunki.length ? `<div class="usospp-empty-hint">Wczytywanie programów…</div>` : `
                ${[...byKierunek.entries()].map(([kierunek, programs]) => `
                  <div style="margin-bottom:10px;">
                    ${kierunek !== '—' ? `<div style="font-size:12px;font-weight:600;color:var(--ink-3);margin-bottom:4px;">${esc(kierunek)}</div>` : ''}
                    <div style="display:flex;flex-wrap:wrap;gap:6px;">${programs.map((p) => `<button class="usospp-mode-btn" style="flex:0 0 auto;border-radius:99px;padding:6px 13px;font-size:12.5px;" data-action="searchOpenProgram" data-kod="${esc(p.kod)}">${esc(p.name)}</button>`).join('')}</div>
                  </div>
                `).join('')}
                ${!s.katalogKierunki.length && !s.katalogKierunkiLoading ? `<div class="usospp-empty-hint">Brak programów w tej jednostce.</div>` : ''}
                ${s.katalogKierunkiNextUrl && !s.katalogKierunkiLoading ? `<a data-action="katalogKierunkiLoadMore" style="display:inline-block;margin-top:10px;font-size:13px;font-weight:600;color:#d9773a;cursor:pointer;">Wczytaj więcej →</a>` : ''}
              `}
            `}
          </div>
        </div>
      `;
    }

    // Budynki: ta sama lista co Mapa (state.mapaBuildings), ale jako lista
    // nazwa / jednostka / adres + „Zobacz na mapie” → openMapaFocused.
    renderKatalogBudynki() {
      const s = this.state;
      if (s.mapaLoading || (!s.mapaBuildings.length && !s.mapaError)) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie budynków…</div></div></div>`;
      }
      if (s.mapaError || !s.mapaBuildings.length) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać budynków.</div><div style="margin-top:10px;"><a data-action="mapaRefresh" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div></div></div>`;
      }
      const q = (s.katalogBudynkiQuery || '').trim().toLowerCase();
      const rows = s.mapaBuildings.filter((b) => {
        if (!q) return true;
        return (b.name || '').toLowerCase().includes(q)
          || (b.kod || '').toLowerCase().includes(q)
          || (b.address || '').toLowerCase().includes(q)
          || (b.unitName || '').toLowerCase().includes(q);
      });
      return `
        <div class="usospp-view">
          ${backLink('katalog')}
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Budynki (${rows.length}${q ? ` z ${s.mapaBuildings.length}` : ''})</div>
            </div>
            <input class="usospp-search-input" data-action="katalogBudynkiQueryInput" type="text" placeholder="Szukaj budynku, adresu, jednostki…" autocomplete="off" value="${esc(s.katalogBudynkiQuery)}" style="width:100%;margin-bottom:12px;">
            <div data-katalog-budynki-root>
              ${rows.slice(0, 300).map((b) => `
                <div class="usospp-list-row" style="align-items:flex-start;">
                  <div>
                    <div style="font-size:13.5px;font-weight:500;">${esc(b.name)}</div>
                    ${b.unitName ? `<div style="color:var(--ink-3);font-size:12px;margin-top:2px;">${esc(b.unitName)}</div>` : ''}
                    ${b.address ? `<div style="color:var(--ink-3);font-size:12px;margin-top:2px;">${esc(b.address)}</div>` : ''}
                  </div>
                  <div style="flex-shrink:0;">${b.kod ? `<a data-action="openMapaFocused" data-kod="${esc(b.kod)}" style="font-size:12px;font-weight:600;color:#d9773a;cursor:pointer;">Zobacz na mapie →</a>` : ''}</div>
                </div>
              `).join('')}
              ${rows.length > 300 ? `<div class="usospp-empty-hint">Pokazuję pierwszych 300 — doprecyzuj wyszukiwanie, aby zawęzić.</div>` : ''}
              ${!rows.length ? `<div class="usospp-empty-hint">Brak budynków spełniających filtr.</div>` : ''}
            </div>
          </div>
        </div>
      `;
    }

    renderPrzedmiotyLista() {
      const etapy = this.etapy;
      const stages = this.stageSubjects;
      return `
        <div class="usospp-view">
          ${backLink('przedmioty')}
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Przedmioty / etapy studiów</div>
              <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dla_stud/studia/podpiecia/lista&usospp_off=1">Podpięcia w USOS →</button>
            </div>
            ${etapy.length === 0 ? `
              <div class="usospp-empty-hint">Brak danych — lista zapisanych przedmiotów nie jest jeszcze obsługiwana, zajrzyj do „podpięć” w klasycznym USOS.</div>
            ` : etapy.map((e) => `
              <div class="usospp-list-row">
                <div>
                  <div style="font-size:14px;font-weight:600;">${esc(e.label)}</div>
                  <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(e.programLabel)} · cykl ${esc(e.cycle || '—')}</div>
                </div>
                <div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(e.status || '—')}</div>
              </div>
            `).join('')}
          </div>

          ${stages.length === 0 ? '' : stages.map((stage) => this.renderStageSubjectsCard(stage)).join('')}
        </div>
      `;
    }

    renderStageSubjectsCard(stage) {
      const sections = Array.isArray(stage.sections) ? stage.sections : [];
      return `
        <div class="usospp-card">
          <div class="usospp-card-head">
            <div class="usospp-card-title">Przedmioty — ${esc(stage.label || stage.directionName || 'etap studiów')}</div>
            <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=katalog2/programy/pokazEtapProgramu&prg_kod=${esc(stage.prgKod)}&etp_kod=${esc(stage.etpKod)}&usospp_off=1">Otwórz w USOS →</button>
          </div>
          ${!stage.supported || sections.length === 0 ? `
            <div class="usospp-empty-hint">Brak przedmiotów aktywnych w bieżącym cyklu dla tego etapu.</div>
          ` : sections.map((section) => `
            <div style="margin-bottom:16px;">
              <div class="usospp-eyebrow" style="margin-bottom:8px;">${esc(section.label)}${section.currentCycleLabel ? ` · ${esc(section.currentCycleLabel)}` : ''}</div>
              ${section.subjects.length === 0 ? `
                <div class="usospp-empty-hint">Brak przedmiotów aktywnych w bieżącym cyklu.</div>
              ` : section.subjects.map((s) => `
                <div class="usospp-list-row">
                  <div>
                    <div style="font-size:13.5px;font-weight:500;">${esc(s.name)}</div>
                    <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(s.code || '')}${s.status ? ' · ' + esc(s.status) : ''}</div>
                  </div>
                  ${s.detailsUrl ? `<a data-action="openSubjectPage" data-url="${esc(s.detailsUrl)}" style="font-size:12px;font-weight:600;white-space:nowrap;">szczegóły →</a>` : ''}
                </div>
              `).join('')}
            </div>
          `).join('')}
        </div>
      `;
    }

    renderSubjectPage() {
      const s = this.state;
      const backView = s.subjectBackView || 'przedmiotyLista';
      const header = backLink(backView);
      if (s.subjectLoading) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie…</div></div></div>`;
      }
      if (s.subjectError || !s.subjectData) {
        return `
          <div class="usospp-view">
            ${header}
            <div class="usospp-card">
              <div class="usospp-empty-hint">Nie udało się wczytać strony przedmiotu.</div>
              ${s.subjectUrl ? `<a data-action="openUsos" data-url="${esc(s.subjectUrl)}" style="font-size:12.5px;font-weight:600;">Otwórz w klasycznym USOS →</a>` : ''}
            </div>
          </div>
        `;
      }
      const d = s.subjectData;
      // Finished cycles are past semesters nobody registers into any more —
      // only show the current/upcoming one(s), with a fallback to "show
      // everything" if for some reason every cycle looks finished (e.g. an
      // unrecognized state string) so we never silently show an empty page.
      const relevantCycles = d.cycles.filter((c) => !/zakończon/i.test(c.cycleState || ''));
      const cyclesToShow = relevantCycles.length ? relevantCycles : d.cycles;
      return `
        <div class="usospp-view">
          ${header}
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">${esc(d.subjectName || 'Przedmiot')}</div>
              <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(s.subjectUrl)}">Otwórz w USOS →</button>
            </div>
            ${d.generalInfo.map((f) => this.renderSubjectField(f)).join('')}
          </div>
          ${cyclesToShow.map((c) => this.renderSubjectCycleCard(c)).join('')}
        </div>
      `;
    }

    // "Jednostki" search result — see adapter.getUnitDetail. Only the
    // ancestor chain and direct children of the org hierarchy are shown
    // (not the whole tree); staff/subject/programme listings for the unit
    // stay a link-out for now rather than replicating those full pages too.
    renderUnitPage() {
      const s = this.state;
      const header = this.catalogBackHeader();
      if (s.catalogLoading) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie…</div></div></div>`;
      }
      if (s.catalogError || !s.catalogData) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać danych jednostki.</div></div></div>`;
      }
      const d = s.catalogData;
      return `
        <div class="usospp-view">
          ${header}
          <div class="usospp-card">
            ${d.ancestors.length ? `
              <div style="font-size:12.5px;color:var(--ink-3);margin-bottom:10px;">
                ${d.ancestors.map((a) => `<span data-action="searchOpenUnit" data-kod="${esc(a.kod)}" style="text-decoration:underline;cursor:pointer;">${esc(a.name)}</span>`).join(' / ')}
              </div>
            ` : ''}
            <div class="usospp-card-title" style="margin-bottom:14px;">${esc(d.name)}</div>
            ${d.fields.length ? `
              <div class="usospp-field-stack">
                ${d.fields.map((f) => `
                  <div class="usospp-list-row"><div style="color:var(--ink-3);font-size:13px;">${esc(f.label)}</div><div style="font-weight:600;font-size:13px;text-align:right;">${esc(f.value)}</div></div>
                `).join('')}
              </div>
            ` : ''}
          </div>
          ${d.children.length ? this.renderUnitChildrenCards(d.children) : ''}
          ${this.renderCatalogProgramsSection()}
          ${this.renderCatalogSubjectsSection()}
          ${s.catalogBuildings.length ? `
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:14px;">Budynki jednostki</div>
              <div class="usospp-map-container" data-unit-map style="height:260px;border-radius:12px;overflow:hidden;margin-bottom:14px;"></div>
              ${s.catalogBuildings.map((b) => `
                <div class="usospp-list-row" style="align-items:flex-start;">
                  <div>
                    <div style="font-size:13.5px;font-weight:500;">${esc(b.name)}</div>
                    ${b.address ? `<div style="color:var(--ink-3);font-size:12px;margin-top:2px;">${esc(b.address)}</div>` : ''}
                  </div>
                  <div style="flex-shrink:0;">${b.kod ? `<a data-action="unitMapGoToBuilding" data-kod="${esc(b.kod)}" style="font-size:12px;font-weight:600;color:#d9773a;cursor:pointer;">Pokaż na mapie ↑</a>` : ''}</div>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }

    // A wydział's direct children mix teaching units (katedry, instytuty)
    // with administrative/support ones (Dziekanat, Zespół…, Centralne
    // Laboratorium…) — verified live on PWr W3 (9 katedry + 1 instytut vs
    // 20 pomocnicze) and PB. Only name prefixes seen live at BOTH
    // universities count as teaching here; everything else falls into the
    // neutral "Pozostałe jednostki" bucket, which is what made the old flat
    // "Jednostki podległe" list look like a random grab bag.
    renderUnitChildrenCards(children) {
      const isTeaching = (name) => /^(Katedra|Instytut)\b/.test(name || '');
      const row = (c) => `
        <div class="usospp-list-row" data-action="searchOpenUnit" data-kod="${esc(c.kod)}" style="cursor:pointer;">
          <div style="font-size:13.5px;font-weight:500;">${esc(c.name)}</div>
          <div style="color:var(--ink-3);">→</div>
        </div>`;
      const teaching = children.filter((c) => isTeaching(c.name));
      const other = children.filter((c) => !isTeaching(c.name));
      return `
          ${teaching.length ? `
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:14px;">Katedry i instytuty</div>
              ${teaching.map(row).join('')}
            </div>
          ` : ''}
          ${other.length ? `
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:14px;">Pozostałe jednostki</div>
              ${other.map(row).join('')}
            </div>
          ` : ''}
      `;
    }

    // The newest cycle year seen across the loaded rows — cdyd_kod values
    // look like "2024/25-Z" (PWr) or "2018Z" (PB), so the leading 4 digits
    // normalize both. This is deliberately data-driven rather than derived
    // from today's date: whatever the listing itself considers the newest
    // year IS the "aktualny rok" the toggle keeps.
    catalogSubjectsCurrentYear() {
      const years = new Set();
      this.state.catalogSubjects.forEach((r) => r.years.forEach((y) => years.add(y)));
      return years.size ? Math.max(...years) : null;
    }

    // "Przedmioty" — the unit's own subject offering (wydziały hold the
    // subjects at both verified universities; katedry return none, so the
    // section just doesn't render for them). Three patch zones — count
    // title, current-year toggle, rows — are kept apart from each other on
    // purpose (see setCatalogSubjectsSectionState): the <input> between
    // them never gets rebuilt, so neither section updates arriving while
    // the user types nor the patchers can drop its value or focus.
    renderCatalogSubjectsSection() {
      const s = this.state;
      if (!s.catalogSubjects.length && !s.catalogSubjectsLoading && !s.catalogSubjectsTotal) return '';
      return `
        <div class="usospp-card" data-catalog-subjects-card>
          <div class="usospp-card-head">
            <div class="usospp-card-title" data-catalog-subjects-title>${this.renderCatalogSubjectsTitle()}</div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">
            <input
              class="usospp-search-input"
              data-action="catalogSubjectQueryInput"
              type="text"
              placeholder="Szukaj po nazwie lub kodzie…"
              autocomplete="off"
              value="${esc(s.catalogSubjectQuery)}"
              style="flex:1;"
            >
            <span data-catalog-subjects-toggle-wrap style="flex:0 0 auto;">${this.renderCatalogSubjectsToggle()}</span>
          </div>
          <div data-catalog-subjects-root>${this.renderCatalogSubjectsSectionBody()}</div>
        </div>
      `;
    }

    // Patchable bits of the section above — see setCatalogSubjectsSectionState.
    renderCatalogSubjectsTitle() {
      const s = this.state;
      return `Przedmioty${s.catalogSubjects.length ? ` (${s.catalogSubjects.length}${s.catalogSubjectsTotal > s.catalogSubjects.length ? ` z ${s.catalogSubjectsTotal}` : ''})` : ''}`;
    }

    renderCatalogSubjectsToggle() {
      const s = this.state;
      const currentYear = this.catalogSubjectsCurrentYear();
      if (!currentYear || !s.catalogSubjects.length) return '';
      const yearLabel = `${currentYear}/${String((currentYear + 1) % 100).padStart(2, '0')}`;
      return `<a data-action="toggleCatalogSubjectsCurrentOnly" style="font-size:12px;font-weight:600;color:${s.catalogSubjectsCurrentOnly ? '#d9773a' : 'var(--ink-3)'};white-space:nowrap;cursor:pointer;">${s.catalogSubjectsCurrentOnly ? '●' : '○'} tylko ${yearLabel}</a>`;
    }

    // Patched part of the section above — see setCatalogSubjectsState. Rows
    // are click-through to our existing subject page via the subject's own
    // details URL. The 400-row render ceiling keeps a 3500+-row wydział
    // (verified live: W3 = 3576) from freezing the panel document; the
    // mini-search narrows within the loaded batch, "Wczytaj więcej" extends
    // it, and mass-scrolling is what the classic UI's pagination is for.
    renderCatalogSubjectsSectionBody() {
      const s = this.state;
      const currentYear = this.catalogSubjectsCurrentYear();
      const q = s.catalogSubjectQuery.trim().toLowerCase();
      const rows = s.catalogSubjects.filter((r) => {
        if (s.catalogSubjectsCurrentOnly && currentYear && !r.years.includes(currentYear)) return false;
        if (!q) return true;
        return (r.name || '').toLowerCase().includes(q) || (r.kod || '').toLowerCase().includes(q);
      });
      const visible = Math.min(rows.length, 400);
      return `
          ${rows.slice(0, 400).map((r) => `
            <div class="usospp-list-row" data-action="openSubjectPage" data-url="${esc(r.url)}" style="cursor:pointer;align-items:flex-start;">
              <div>
                <div style="font-size:13.5px;font-weight:500;">${esc(r.name)}</div>
                ${r.grupa ? `<div style="color:var(--ink-3);font-size:12px;margin-top:2px;">${esc(r.grupa)}</div>` : ''}
              </div>
              <div style="color:var(--ink-3);font-size:11.5px;font-family:ui-monospace,Menlo,monospace;flex-shrink:0;">${esc(r.kod)}</div>
            </div>
          `).join('')}
          ${rows.length > 400 ? `<div class="usospp-empty-hint">Pokazuję pierwszych 400 — doprecyzuj wyszukiwanie, aby zawęzić.</div>` : ''}
          ${!rows.length && !s.catalogSubjectsLoading ? `<div class="usospp-empty-hint">Brak przedmiotów${q || (s.catalogSubjectsCurrentOnly && currentYear) ? ' spełniających filtr' : ''}.</div>` : ''}
          ${s.catalogSubjectsLoading ? `<div class="usospp-empty-hint">Wczytywanie…</div>` : ''}
          ${!s.catalogSubjectsLoading ? `
            ${(rows.length && (s.catalogSubjectsTotal > s.catalogSubjects.length || q || (s.catalogSubjectsCurrentOnly && currentYear))) ? `<div style="font-size:12px;color:var(--ink-3);margin-top:10px;">${visible} z ${s.catalogSubjects.length}${s.catalogSubjectsTotal > s.catalogSubjects.length ? ` wczytanych (ogółem ${s.catalogSubjectsTotal})` : ' pasujących'}</div>` : ''}
            ${s.catalogSubjectsNextUrl ? `<a data-action="catalogSubjectsLoadMore" style="display:inline-block;margin-top:10px;font-size:13px;font-weight:600;color:#d9773a;cursor:pointer;">Wczytaj więcej →</a>` : ''}
          ` : ''}
      `;
    }

    // "Programy studiów" — every kierunek this unit offers, each listing its
    // program instances (full-time/Erasmus/…) as chips that open our own
    // program page. Hidden entirely while the first page loads empty or for
    // units without programmes (verified marker), same graceful rules as the
    // subjects section. Loaded chips stay visible while "Wczytaj więcej"
    // fetches — only the first, still-empty load shows "Wczytywanie…" — so
    // the in-place card swap (setCatalogProgramsState) doesn't flash.
    renderCatalogProgramsSection() {
      const s = this.state;
      if (!s.catalogPrograms.length && !s.catalogProgramsLoading) return '';
      const byKierunek = new Map();
      s.catalogPrograms.forEach((p) => {
        const key = p.kierunek || '—';
        if (!byKierunek.has(key)) byKierunek.set(key, []);
        byKierunek.get(key).push(p);
      });
      const chip = (p) => `<button class="usospp-mode-btn" style="flex:0 0 auto;border-radius:99px;padding:6px 13px;font-size:12.5px;" data-action="searchOpenProgram" data-kod="${esc(p.kod)}">${esc(p.name)}</button>`;
      return `
        <div class="usospp-card" data-catalog-programs-card>
          <div class="usospp-card-title" style="margin-bottom:14px;">Programy studiów (${s.catalogPrograms.length})</div>
          ${(s.catalogProgramsLoading && !s.catalogPrograms.length) ? `<div class="usospp-empty-hint">Wczytywanie…</div>` : `
            ${[...byKierunek.entries()].map(([kierunek, programs]) => `
              <div style="margin-bottom:10px;">
                ${kierunek !== '—' ? `<div style="font-size:12px;font-weight:600;color:var(--ink-3);margin-bottom:4px;">${esc(kierunek)}</div>` : ''}
                <div style="display:flex;flex-wrap:wrap;gap:6px;">${programs.map(chip).join('')}</div>
              </div>
            `).join('')}
            ${s.catalogProgramsNextUrl ? `<a data-action="catalogProgramsLoadMore" style="display:inline-block;margin-top:10px;font-size:13px;font-weight:600;color:#d9773a;cursor:pointer;">Wczytaj więcej →</a>` : ''}
          `}
        </div>
      `;
    }

    // Campus-wide building map — see ensureMapaData/mountMapaIfNeeded for
    // how data is fetched and how the Leaflet instance is (re)mounted.
    renderMapa() {
      const s = this.state;
      if (s.mapaLoading) {
        return `<div class="usospp-view"><div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie budynków kampusu…</div></div></div>`;
      }
      if (s.mapaError) {
        return `
          <div class="usospp-view">
            <div class="usospp-card">
              <div class="usospp-empty-hint">Nie udało się wczytać mapy budynków.</div>
              <div style="margin-top:10px;"><a data-action="mapaRefresh" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div>
            </div>
          </div>
        `;
      }
      if (!s.mapaBuildings.length) {
        return `<div class="usospp-view"><div class="usospp-card"><div class="usospp-empty-hint">Brak budynków z dostępnymi współrzędnymi.</div></div></div>`;
      }
      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Budynki kampusu (${s.mapaBuildings.length})</div>
              <a data-action="mapaRefresh" style="font-size:12px;color:var(--ink-3);text-decoration:underline;cursor:pointer;">odśwież</a>
            </div>
            <div class="usospp-search-wrap" style="width:100%;margin-bottom:12px;">
              <input
                class="usospp-search-input"
                data-action="mapaSearchInput"
                data-mapa-search-input
                type="text"
                placeholder="Szukaj budynku…"
                autocomplete="off"
                value="${esc(s.mapaSearchQuery)}"
              >
              <div data-mapa-search-results-root>${this.renderMapaSearchResults()}</div>
            </div>
            ${this.renderMapaFilterChips()}
            <div class="usospp-map-container" data-mapa-map style="height:520px;border-radius:12px;overflow:hidden;margin-top:12px;"></div>
          </div>
        </div>
      `;
    }

    // Its own top-level element carries data-mapa-filter-root so setMapaFilter
    // can replace just this chip strip (outerHTML) without touching the map
    // container next to it — same reasoning as setTopbarState et al. Chips
    // are keyed (data-unit) by unitKod, not display name — see
    // applyMapaFilter's comment for why name equality would be wrong.
    renderMapaFilterChips() {
      const s = this.state;
      const seen = new Map();
      s.mapaBuildings.forEach((b) => {
        if (b.unitKod && !seen.has(b.unitKod)) seen.set(b.unitKod, b.unitName || b.unitKod);
      });
      const units = [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pl'));
      const chipStyle = 'flex:0 0 auto;border-radius:99px;padding:6px 13px;font-size:12.5px;';
      return `
        <div data-mapa-filter-root style="display:flex;flex-wrap:wrap;gap:6px;">
          <button class="usospp-mode-btn${!s.mapaUnitFilter ? ' active' : ''}" style="${chipStyle}" data-action="mapaSetFilter" data-unit="">Wszystkie</button>
          ${units.map(([kod, name]) => `<button class="usospp-mode-btn${s.mapaUnitFilter === kod ? ' active' : ''}" style="${chipStyle}" data-action="mapaSetFilter" data-unit="${esc(kod)}">${esc(name)}</button>`).join('')}
        </div>
      `;
    }

    // "Programy studiów" search result — see adapter.getProgramDetail.
    // "Główne toki nauczania" stage links open our own stage subpage (see
    // openStagePage/renderStagePage) instead of bouncing out to USOS.
    renderProgramPage() {
      const s = this.state;
      const header = this.catalogBackHeader();
      if (s.catalogLoading) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie…</div></div></div>`;
      }
      if (s.catalogError || !s.catalogData) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać danych programu.</div></div></div>`;
      }
      const d = s.catalogData;
      return `
        <div class="usospp-view">
          ${header}
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:14px;">${esc(d.name)}</div>
            ${d.kierunki.length ? `
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;">
                ${d.kierunki.map((k) => `<span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(k)}</span>`).join('')}
              </div>
            ` : ''}
            <div class="usospp-field-stack">
              ${d.fields.map((f) => `
                <div class="usospp-list-row"><div style="color:var(--ink-3);font-size:13px;">${esc(f.label)}</div><div style="font-weight:600;font-size:13px;text-align:right;">${esc(f.value)}</div></div>
              `).join('')}
            </div>
          </div>
          ${d.units.length ? `
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:14px;">Jednostki oferujące ten program</div>
              ${d.units.map((u) => `
                <div class="usospp-list-row" data-action="searchOpenUnit" data-kod="${esc(u.kod)}" style="cursor:pointer;">
                  <div style="font-size:13.5px;font-weight:500;">${esc(u.name)}</div>
                  <div style="color:var(--ink-3);">→</div>
                </div>
              `).join('')}
            </div>
          ` : ''}
          ${d.stages.length ? `
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:14px;">Główne toki nauczania</div>
              ${d.stages.map((st) => `
                <div class="usospp-list-row">
                  <div style="font-size:13px;">${esc(st.label)}</div>
                  <a data-action="openStage" data-prg-kod="${esc(st.prgKod)}" data-etp-kod="${esc(st.etpKod)}" data-label="${esc(st.label)}" style="font-size:12px;font-weight:600;color:#d9773a;cursor:pointer;">szczegóły →</a>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }

    // A single "semestr" opened from a program's "Główne toki nauczania" —
    // reuses renderStageSubjectsCard verbatim (see the same card in
    // renderPrzedmiotyLista, for the user's own programme). "Back" reopens
    // the specific program this stage belongs to (catalogKod doubles as its
    // prg_kod) rather than the generic catalogBackView, which points
    // further back to wherever the program page itself was opened from.
    renderStagePage() {
      const s = this.state;
      const header = `<a data-action="searchOpenProgram" data-kod="${esc(s.catalogKod)}" class="usospp-back-link">← Wróć</a>`;
      if (s.catalogLoading) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie…</div></div></div>`;
      }
      if (s.catalogError || !s.catalogData) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać przedmiotów etapu.</div></div></div>`;
      }
      return `
        <div class="usospp-view">
          ${header}
          ${this.renderStageSubjectsCard(s.catalogData)}
        </div>
      `;
    }

    // A field's link is usually just "open this in classic USOS" — except a
    // link to a jednostka page, which we already have our own page for (see
    // renderUnitPage), so that one gets routed there instead.
    renderSubjectField(f) {
      // "Grupy:" and anything shaped like it can hold several links in one
      // cell — showing them squashed together as unclickable text loses
      // them, so this offers a pick-one modal instead.
      if (f.links && f.links.length > 1) {
        return `
          <div class="usospp-list-row">
            <div style="font-size:12.5px;color:var(--ink-2);">${esc(f.label)}</div>
            <a data-action="openLinksModal" data-links='${esc(JSON.stringify(f.links))}' data-title="${esc(f.label)}" style="font-size:12.5px;font-weight:600;cursor:pointer;">${f.links.length} opcje →</a>
          </div>
        `;
      }
      let actionAttrs = `data-action="openUsos" data-url="${esc(f.link)}"`;
      if (f.link && /pokazJednostke/.test(f.link)) {
        let kod = null;
        try { kod = new URL(f.link).searchParams.get('kod'); } catch (e) { /* fall back to openUsos */ }
        if (kod) actionAttrs = `data-action="searchOpenUnit" data-kod="${esc(kod)}"`;
      }
      return `
        <div class="usospp-list-row">
          <div style="font-size:12.5px;color:var(--ink-2);">${esc(f.label)}</div>
          <div style="font-size:12.5px;font-weight:600;text-align:right;max-width:60%;">${f.link ? `<a ${actionAttrs} style="cursor:pointer;">${esc(f.value)}</a>` : esc(f.value)}</div>
        </div>
      `;
    }

    renderSubjectCycleCard(c) {
      return `
        <div class="usospp-card">
          <div class="usospp-card-head">
            <div class="usospp-card-title">${esc(c.cycleName)}</div>
            <div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(c.cycleState || '—')}</div>
          </div>
          <div style="font-size:12.5px;color:var(--ink-3);margin-bottom:14px;">${esc(c.period || '—')}</div>

          ${c.registrationStatus ? `
            <div class="usospp-list-row">
              <div style="font-size:13px;color:var(--ink-2);">Rejestracja</div>
              <div style="font-size:13px;font-weight:600;text-align:right;">
                ${esc(c.registrationStatus)}${c.registrationUrl ? ` · <a data-action="openUsos" data-url="${esc(c.registrationUrl)}">szczegóły →</a>` : ''}
              </div>
            </div>
          ` : ''}

          ${c.classTypes.length ? `
            <div class="usospp-eyebrow" style="margin-top:14px;margin-bottom:8px;">Typ zajęć</div>
            ${c.classTypes.map((ct) => `
              <div class="usospp-list-row">
                <div style="font-size:13px;">${esc(ct.label)}</div>
                ${ct.groupsUrl ? `<a data-action="openGroupsModal" data-url="${esc(ct.groupsUrl)}" data-title="${esc(ct.label)}" style="font-size:12px;font-weight:600;cursor:pointer;">grupy →</a>` : ''}
              </div>
            `).join('')}
          ` : ''}

          ${c.timetable.days.length ? this.renderSubjectTimetable(c.timetable) : ''}

          ${c.fields.length ? `
            <div class="usospp-eyebrow" style="margin-top:14px;margin-bottom:8px;">Szczegóły</div>
            ${c.fields.map((f) => this.renderSubjectField(f)).join('')}
          ` : ''}
        </div>
      `;
    }

    // Renders a real weekly-schedule grid (hour labels down the left, one
    // column per day, entries positioned by actual clock time) instead of
    // just stacking boxes per day — much easier to read at a glance than a
    // plain list of "start–end" text.
    renderSubjectTimetable(tt) {
      const days = tt.days;
      const allMins = days.flatMap((d) => d.entries.flatMap((e) => [toMin(e.start), toMin(e.end)])).filter((n) => n !== null);
      if (!allMins.length) return '';
      const hourStart = Number.isFinite(tt.hourStart) ? tt.hourStart : Math.floor(Math.min(...allMins) / 60);
      const hourEnd = Number.isFinite(tt.hourEnd) ? tt.hourEnd : Math.ceil(Math.max(...allMins) / 60);
      const ROW_H = 64; // px per hour — tall enough to fit type/teacher/room text
      const totalHeight = Math.max(1, hourEnd - hourStart) * ROW_H;
      const hours = [];
      for (let h = hourStart; h <= hourEnd; h++) hours.push(h);
      const sortedDays = [...days].sort((a, b) => DAY_KEYS.indexOf(shortDay(a.day)) - DAY_KEYS.indexOf(shortDay(b.day)));

      return `
        <div class="usospp-eyebrow" style="margin-top:14px;margin-bottom:8px;">Plan zajęć (wszystkie grupy)</div>
        <div class="usospp-timetable">
          <div class="usospp-tt-hours" style="height:${totalHeight}px;">
            ${hours.map((h) => `<div class="usospp-tt-hour" style="top:${(h - hourStart) * ROW_H}px;">${h}:00</div>`).join('')}
          </div>
          <div class="usospp-tt-days">
            ${sortedDays.map((d) => `
              <div class="usospp-tt-daycol">
                <div class="usospp-tt-daylabel">${esc(shortDay(d.day))}</div>
                <div class="usospp-tt-daybody" style="height:${totalHeight}px;background-size:100% ${ROW_H}px;">
                  ${d.entries.map((e) => {
                    const startMin = toMin(e.start);
                    const endMin = toMin(e.end);
                    if (startMin === null || endMin === null) return '';
                    const top = (startMin - hourStart * 60) * (ROW_H / 60);
                    const height = Math.max(40, (endMin - startMin) * (ROW_H / 60));
                    const weeksTag = weeksLabel(e.weeks);
                    const full = [e.label, e.teacher, e.place].filter(Boolean).join(' — ')
                      + (weeksTag ? ` — co drugi tydzień (${e.weeks === 'even' ? 'parzyste' : 'nieparzyste'})` : '');
                    return `
                      <div class="usospp-tt-entry" style="top:${top}px;height:${height}px;" title="${esc(full)}">
                        <div class="usospp-tt-entry-time">${esc(e.start)}–${esc(e.end)}${weeksTag ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:9.5px;padding:1px 5px;">${weeksTag}</span>` : ''}</div>
                        <div class="usospp-tt-entry-label">${esc(e.label || '')}</div>
                        ${e.teacher ? `<div class="usospp-tt-entry-meta">${esc(e.teacher)}</div>` : ''}
                        ${e.place ? `<div class="usospp-tt-entry-meta">${esc(e.place)}</div>` : ''}
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    renderZapisy() {
      const r = this.data.registrationsResult || {};
      const owns = this.ownProgrammes;
      const prgKods = [...new Set(owns.map((p) => p.prgKod).filter(Boolean))];
      const semesters = [...new Set(owns.map((p) => p.semester).filter((n) => Number.isInteger(n)))];
      const directionName = owns.find((p) => p.directionName)?.directionName || null;
      const hasOwnData = prgKods.length > 0;
      const ownOnly = hasOwnData && this.state.zapisyOwnOnly;

      let groups = this.registrationGroups.filter((g) => g.rounds.length > 0);
      if (ownOnly) {
        groups = groups.filter((g) => prgKods.some((kod) => g.groupLabel.includes(kod)));
      }
      const filter = (this.state.zapisyFilter || '').trim().toLowerCase();
      const filtered = filter
        ? groups.filter((g) => g.groupLabel.toLowerCase().includes(filter) || g.code.toLowerCase().includes(filter))
        : groups;

      const flatRounds = [];
      filtered.forEach((g) => {
        // "sem. <N>" in the heading, matched against the semester numbers
        // found on the student's own rejestracja/przedmioty hub — best
        // effort, since we don't have a confirmed single "current semester"
        // field (see getOwnProgrammes' comment).
        const semMatch = g.groupLabel.match(/sem\.\s*(\d+)/i);
        const headingSemester = semMatch ? parseInt(semMatch[1], 10) : null;
        const isOwnSemester = headingSemester !== null && semesters.includes(headingSemester);
        g.rounds.forEach((round) => flatRounds.push({ ...round, group: g, isOwnSemester }));
      });
      flatRounds.sort((a, b) => (a.startsAt || '').localeCompare(b.startsAt || ''));

      // A single faculty can list well over a thousand rounds (every
      // programme/semester/round-name combination gets its own group) —
      // confirmed against the live W4N page (1590 rows). Rendering that
      // unfiltered would be both unreadable and a large DOM dump, so cap the
      // default view and push people toward the filter box instead.
      const RENDER_CAP = 150;
      const capped = !filter && flatRounds.length > RENDER_CAP;
      const toRender = capped ? flatRounds.slice(0, RENDER_CAP) : flatRounds;

      const u = this.data.user || {};

      return `
        <div class="usospp-view">
          ${backLink('przedmioty')}
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Rejestracje na przedmioty</div>
              <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dla_stud/rejestracja/kalendarz&usospp_off=1">Twój kalendarz w USOS →</button>
            </div>
            ${!r.supported ? `
              <div class="usospp-empty-hint">Nie udało się odczytać listy rejestracji wydziałowych — sprawdź w klasycznym USOS.</div>
            ` : `
              <p class="usospp-muted-text" style="margin-bottom:14px;">
                Tury zapisów zgłoszone dla ${esc(u.faculty || 'Twojej jednostki')} wraz z terminami — również te, do których nie masz jeszcze osobistego dostępu. Kliknięcie „zobacz przedmioty” otwiera prawdziwą stronę USOS w nowej karcie; USOS++ niczego tu za Ciebie nie zapisuje.
              </p>
              ${hasOwnData ? `
                <div class="usospp-list-row" style="margin-bottom:12px;">
                  <div>
                    <div style="font-size:13.5px;font-weight:500;">Tylko mój kierunek${directionName ? ` — ${esc(directionName)}` : ''}</div>
                    <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${semesters.length ? `Wykryte semestry: ${semesters.join(', ')} (na podstawie „Rejestracja na przedmioty” w USOS — może obejmować więcej niż jeden, jeśli USOS pokazuje kilka naraz)` : 'Dopasowanie po kodzie programu studiów'}</div>
                  </div>
                  <div class="usospp-switch ${ownOnly ? 'on' : ''}" data-action="toggleZapisyOwnOnly"><div class="usospp-switch-knob"></div></div>
                </div>
              ` : `
                <div class="usospp-empty-hint" style="padding:10px 0;">Nie udało się rozpoznać Twojego kierunku — pokazuję rejestracje całego wydziału, przefiltruj ręcznie poniżej.</div>
              `}
              <input class="usospp-input" style="margin-bottom:16px;" placeholder="Filtruj po nazwie kierunku / semestru… (np. informatyka stosowana)" value="${esc(this.state.zapisyFilter || '')}" data-bind="zapisyFilter">
              ${flatRounds.length === 0 ? `
                <div class="usospp-empty-hint">${filter || ownOnly ? 'Brak tur pasujących do filtra.' : 'Brak zdefiniowanych tur zapisów w tej chwili.'}</div>
              ` : `
                ${capped ? `<div class="usospp-tag-muted" style="display:block;margin-bottom:10px;">Pokazano ${RENDER_CAP} z ${flatRounds.length} tur (najbliższe terminy). Zawęź filtrem powyżej.</div>` : ''}
                ${toRender.map((round) => this.renderRegistrationRound(round)).join('')}
              `}
            `}
          </div>
        </div>
      `;
    }

    renderRegistrationRound(round) {
      const g = round.group;
      const accessBadge = round.hasAccess
        ? `<div class="usospp-badge" style="background:oklch(90% 0.08 150);color:oklch(35% 0.1 150);">masz dostęp</div>`
        : `<div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-3);">brak dostępu</div>`;
      return `
        <div class="usospp-list-row" style="align-items:flex-start;">
          <div>
            <div style="font-size:13.5px;font-weight:600;">${esc(g.groupLabel)}${round.isOwnSemester ? ' <span class="usospp-tag-muted" style="font-style:normal;font-weight:600;color:oklch(58% 0.15 45);">· Twój semestr?</span>' : ''}</div>
            <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(round.roundType || '')}${round.roundNote ? ' · ' + esc(round.roundNote) : ''}</div>
            <div style="font-size:12px;color:var(--ink-2);margin-top:4px;">${esc(round.state || '—')}</div>
            ${round.startsAt ? `<div style="font-size:11.5px;color:var(--ink-3);margin-top:2px;">${esc(round.startsAt)}${round.endsAt ? ' – ' + esc(round.endsAt) : ''}</div>` : ''}
            ${g.subjectsUrl ? `<div style="margin-top:6px;"><a data-action="openUsos" data-url="${esc(g.subjectsUrl)}" style="font-size:12px;font-weight:600;">zobacz przedmioty w tej turze →</a></div>` : ''}
          </div>
          ${accessBadge}
        </div>
      `;
    }

    // Lets a student assemble a what-if weekly schedule out of real group
    // data before/during registration — purely a local preview: nothing
    // here is ever submitted to USOS, and picks persist across sessions via
    // chrome.storage.local (see planner-store.js) so the draft survives
    // closing the panel or the browser.
    // The outer wrapper is only ever produced by the normal full-page
    // render path (navigating to this view). Everything that can change
    // afterwards (expanding a subject, loading its groups, picking one,
    // adding/removing a pick) goes through setPlannerState, which patches
    // just this node's innerHTML — see setPlannerState's own comment.
    renderPlanner() {
      return `
        <div class="usospp-view">
          ${backLink('przedmioty')}
          <div data-planner-root>${this.renderPlannerBody()}</div>
        </div>
      `;
    }

    renderPlannerBody() {
      const modeTabs = `
        <div style="display:flex;gap:6px;margin-bottom:16px;">
          <button class="usospp-mode-btn${this.state.plannerMode !== 'auto' ? ' active' : ''}" data-action="plannerSetMode" data-mode="manual">Manualny</button>
          <button class="usospp-mode-btn${this.state.plannerMode === 'auto' ? ' active' : ''}" data-action="plannerSetMode" data-mode="auto">Automatyczny</button>
        </div>
      `;
      if (this.state.plannerMode === 'auto') {
        return modeTabs + this.renderPlannerAutoBody();
      }

      const { subjects, skippedStages } = this.plannerSubjectCandidates;
      const bySubject = this.plannerPicksBySubject;

      return `
        ${modeTabs}
        <div class="usospp-card">
          <div class="usospp-card-head">
            <div class="usospp-card-title">Generator planu</div>
            ${this.state.plannerPicks.length ? `<button class="usospp-btn-ghost" data-action="plannerClearAll">Wyczyść plan</button>` : ''}
          </div>
          <p class="usospp-muted-text">
            Ułóż sobie przykładowy plan zajęć na podstawie realnych grup — jeszcze przed zapisami albo w ich trakcie. To tylko podgląd: USOS++ nikogo nigdzie nie zapisuje, wybory zapisują się jedynie lokalnie w tym rozszerzeniu, żeby można było do nich wrócić później.
          </p>
        </div>

        <div class="usospp-planner-layout">
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:12px;">Dodaj przedmiot</div>
            ${this.renderPlannerPlanTabs()}
            ${this.renderPlannerCustomSearch()}
            ${skippedStages > 0 ? `<div class="usospp-tag-muted" style="display:block;margin-bottom:10px;">Pominięto ${skippedStages} etap(y) programu z późniejszego cyklu (np. kolejny semestr) — pokazujemy tylko przedmioty z bieżącego cyklu.</div>` : ''}
            ${subjects.length === 0 ? `
              <div class="usospp-empty-hint">Nie znaleźliśmy listy przedmiotów Twojego kierunku — sprawdź zakładkę „Przedmioty” albo dodaj przedmiot spoza listy powyżej.</div>
            ` : subjects.map((s) => this.renderPlannerSubjectRow(s)).join('')}
          </div>

          <div style="display:flex;flex-direction:column;gap:20px;">
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:12px;">Twój plan (podgląd)</div>
              ${this.renderPlannerGrid()}
            </div>

            ${bySubject.length ? `
              <div class="usospp-card">
                <div class="usospp-card-title" style="margin-bottom:6px;">Wybrane przedmioty</div>
                ${bySubject.map((entry) => this.renderPlannerPickGroup(entry)).join('')}
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }

    // "Dodaj przedmiot spoza listy" — collapsed to a plain ghost button;
    // expanded, a search box over the full catalog (same searchCatalog used
    // by the topbar search, see onPlannerSearchInput), so a student can add
    // a subject their programme stage didn't surface (WF, a language
    // elective, a course from another kierunek…).
    renderPlannerCustomSearch() {
      if (!this.state.plannerCustomSearchOpen) {
        return `<button class="usospp-btn-ghost" style="margin-bottom:12px;" data-action="plannerToggleCustomSearch">+ Dodaj przedmiot spoza listy</button>`;
      }
      return `
        <div style="margin-bottom:14px;">
          <div class="usospp-search-wrap" style="width:100%;">
            <input class="usospp-search-input" type="text" placeholder="Szukaj przedmiotu po nazwie lub kodzie…" data-action="plannerSearchInput" value="${esc(this.state.plannerCustomSearchQuery)}">
            <div data-planner-search-results-root>${this.renderPlannerCustomSearchResults()}</div>
          </div>
          <a data-action="plannerToggleCustomSearch" style="display:inline-block;margin-top:8px;font-size:12px;font-weight:600;">Anuluj</a>
        </div>
      `;
    }

    renderPlannerCustomSearchResults() {
      const q = this.state.plannerCustomSearchQuery.trim();
      if (q.length < 3) return '';
      if (this.state.plannerCustomSearchLoading) {
        return `<div class="usospp-search-dropdown"><div class="usospp-empty-hint" style="padding:16px;">Szukanie…</div></div>`;
      }
      const results = this.state.plannerCustomSearchResults;
      if (!results) return '';
      if (results.length === 0) {
        return `<div class="usospp-search-dropdown"><div class="usospp-empty-hint" style="padding:16px;">Brak wyników dla „${esc(q)}”.</div></div>`;
      }
      return `
        <div class="usospp-search-dropdown">
          ${results.slice(0, 8).map((subj) => `
            <div class="usospp-search-item" data-action="plannerSelectSearchSubject" data-url="${esc(location.origin)}/kontroler.php?_action=katalog2/przedmioty/pokazPrzedmiot&prz_kod=${esc(subj.kod)}" data-name="${esc(subj.nazwa)}">
              <div class="usospp-search-item-title">${esc(subj.nazwa)}</div>
              <div class="usospp-search-item-sub">${esc(subj.jedn || '')}${subj.jedn ? ' · ' : ''}${esc(subj.kod)}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    renderPlannerAutoBody() {
      const { subjects } = this.plannerSubjectCandidates;
      // A subject picked via the search box below is checked into
      // plannerAutoSelected immediately (see plannerSelectSearchSubject),
      // but — unlike a manually-picked one — has no committed pick yet, so
      // plannerSubjectCandidates' pick-derived customSubjects list doesn't
      // know about it. Union it in here so it still shows up as a normal,
      // untickable-off-and-back-on row instead of only existing invisibly
      // in plannerAutoSelected.
      const knownIds = new Set(subjects.map((s) => subjectId(s.detailsUrl)));
      const extraSelected = Object.values(this.state.plannerAutoSelected)
        .filter((v) => !knownIds.has(subjectId(v.subjectUrl)))
        .map((v) => ({ name: v.subjectName, code: '', detailsUrl: v.subjectUrl }));
      const allRows = [...subjects, ...extraSelected];
      const selectedCount = Object.keys(this.state.plannerAutoSelected).length;
      const status = this.state.plannerAutoStatus;
      const busy = status === 'fetching' || status === 'generating';
      return `
        <div class="usospp-card">
          <div class="usospp-card-title" style="margin-bottom:6px;">Generator automatyczny</div>
          <p class="usospp-muted-text">
            Wybierz przedmioty, ustaw ograniczenia i preferencje — USOS++ spróbuje ułożyć za Ciebie do 5 pasujących wariantów planu z realnych grup. To wciąż tylko podgląd czasowy: nie sprawdzamy, czy zapisy na dany cykl są otwarte.
          </p>
        </div>

        <div class="usospp-two-col">
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:12px;">Przedmioty do uwzględnienia (${selectedCount})</div>
            ${this.renderPlannerCustomSearch()}
            ${allRows.length === 0 ? `
              <div class="usospp-empty-hint">Nie znaleźliśmy listy przedmiotów Twojego kierunku — dodaj przedmiot spoza listy powyżej.</div>
            ` : allRows.map((s) => this.renderPlannerAutoSubjectRow(s)).join('')}
          </div>

          ${this.renderPlannerAutoPrefsForm()}
        </div>

        <button class="usospp-btn-primary" style="margin-top:16px;" data-action="plannerAutoGenerate" ${selectedCount === 0 || busy ? 'disabled' : ''}>
          ${status === 'fetching' ? 'Wczytywanie grup…' : status === 'generating' ? 'Generowanie…' : 'Generuj plan'}
        </button>

        <div style="margin-top:20px;">
          ${this.renderPlannerAutoResults()}
        </div>
      `;
    }

    renderPlannerAutoSubjectRow(s) {
      const id = subjectId(s.detailsUrl);
      const checked = !!this.state.plannerAutoSelected[id];
      return `
        <div class="usospp-list-row" data-action="plannerAutoToggleSubject" data-url="${esc(s.detailsUrl)}" data-name="${esc(s.name)}" style="cursor:pointer;">
          <div style="min-width:0;">
            <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.name)}</div>
            <div style="font-size:11.5px;color:var(--ink-3);">${esc(s.code || '')}</div>
          </div>
          <div class="usospp-switch${checked ? ' on' : ''}"><div class="usospp-switch-knob"></div></div>
        </div>
      `;
    }

    renderPlannerAutoPrefsForm() {
      const s = this.state;
      const dayOptions = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];
      return `
        <div class="usospp-card" data-planner-prefs-root>
          <div class="usospp-card-title" style="margin-bottom:12px;">Ograniczenia i preferencje</div>

          <div class="usospp-field-stack">
            <div>
              <label class="usospp-field-label">Najwcześniejsza godzina rozpoczęcia (twarde)</label>
              <input class="usospp-input" type="time" data-bind="plannerAutoEarliestStart" value="${esc(s.plannerAutoEarliestStart)}">
            </div>
            <div>
              <label class="usospp-field-label">Najpóźniejsza godzina zakończenia (twarde)</label>
              <input class="usospp-input" type="time" data-bind="plannerAutoLatestEnd" value="${esc(s.plannerAutoLatestEnd)}">
            </div>
          </div>

          <div style="margin-top:14px;">
            <label class="usospp-field-label">Zablokowane terminy (twarde)</label>
            ${s.plannerAutoBlockedWindows.map((b, i) => `
              <div class="usospp-list-row">
                <div style="font-size:12.5px;">${esc(shortDay(b.day))} ${esc(b.start)}–${esc(b.end)}</div>
                <a data-action="plannerAutoRemoveBlock" data-index="${i}" style="font-size:12px;font-weight:600;color:oklch(58% 0.19 25);">usuń</a>
              </div>
            `).join('')}
            <div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap;">
              <select class="usospp-input" style="width:auto;" data-bind="plannerAutoBlockDraftDay">
                ${dayOptions.map((d) => `<option value="${esc(d)}" ${s.plannerAutoBlockDraftDay === d ? 'selected' : ''}>${esc(shortDay(d))}</option>`).join('')}
              </select>
              <input class="usospp-input" style="width:auto;" type="time" data-bind="plannerAutoBlockDraftStart" value="${esc(s.plannerAutoBlockDraftStart)}">
              <span style="color:var(--ink-3);">–</span>
              <input class="usospp-input" style="width:auto;" type="time" data-bind="plannerAutoBlockDraftEnd" value="${esc(s.plannerAutoBlockDraftEnd)}">
              <button class="usospp-btn-ghost" data-action="plannerAutoAddBlock">+ Dodaj blokadę</button>
            </div>
          </div>

          <div class="usospp-field-stack" style="margin-top:14px;">
            <div>
              <label class="usospp-field-label">Maks. liczba zajęć dziennie (preferencja)</label>
              <input class="usospp-input" type="number" min="1" data-bind="plannerAutoMaxPerDay" value="${esc(s.plannerAutoMaxPerDay)}" placeholder="bez limitu">
            </div>
            <div>
              <label class="usospp-field-label">Preferowana liczba dni zajęciowych</label>
              <input class="usospp-input" type="number" min="1" max="7" data-bind="plannerAutoPreferredDays" value="${esc(s.plannerAutoPreferredDays)}" placeholder="bez preferencji">
            </div>
            <div class="usospp-list-row">
              <div style="font-size:13px;">Minimalizuj okienka między zajęciami</div>
              <div class="usospp-switch${s.plannerAutoMinimizeGaps ? ' on' : ''}" data-action="plannerAutoToggleMinimizeGaps"><div class="usospp-switch-knob"></div></div>
            </div>
          </div>
        </div>
      `;
    }

    renderPlannerAutoResults() {
      const status = this.state.plannerAutoStatus;
      if (status === 'idle') {
        return `<div class="usospp-card"><div class="usospp-empty-hint">Wybierz przedmioty i kliknij „Generuj plan”.</div></div>`;
      }
      if (status === 'fetching' || status === 'generating') {
        return `<div class="usospp-card"><div class="usospp-empty-hint">${status === 'fetching' ? 'Wczytywanie grup zajęć…' : 'Generowanie propozycji…'}</div></div>`;
      }
      if (status === 'failed') {
        return this.renderPlannerAutoFailure();
      }
      const candidates = this.state.plannerAutoCandidates;
      if (!candidates.length) {
        return `<div class="usospp-card"><div class="usospp-empty-hint">Brak propozycji.</div></div>`;
      }
      const activeIndex = Math.min(this.state.plannerAutoActiveCandidateIndex, candidates.length - 1);
      const active = candidates[activeIndex];
      return `
        <div class="usospp-card">
          <div class="usospp-card-head">
            <div class="usospp-card-title">Wygenerowane warianty</div>
            <button class="usospp-btn-primary" data-action="plannerUseGeneratedCandidate" data-index="${activeIndex}">Użyj tego planu</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;">
            ${candidates.map((c, i) => `
              <button class="usospp-mode-btn${i === activeIndex ? ' active' : ''}" data-action="plannerAutoSelectCandidate" data-index="${i}">Wariant ${i + 1}</button>
            `).join('')}
          </div>
          ${this.renderPlannerCandidateGrid(active)}
        </div>
      `;
    }

    renderPlannerAutoFailure() {
      const f = this.state.plannerAutoFailure;
      if (!f) return '';
      if (f.kind === 'plan-limit' || f.kind === 'fetch' || f.kind === 'error') {
        return `<div class="usospp-card"><div class="usospp-empty-hint">${esc(f.message)}</div></div>`;
      }
      if (f.reason === 'empty-domain') {
        return `
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:8px;color:oklch(55% 0.19 25);">Nie da się ułożyć planu</div>
            <p class="usospp-muted-text">Żadna dostępna grupa nie mieści się w Twoich ograniczeniach dla:</p>
            <ul style="margin:6px 0 0 18px;padding:0;font-size:13px;">
              ${f.emptyVariables.map((v) => `<li>${esc(v.subjectName)} — ${esc(v.classTypeLabel)}</li>`).join('')}
            </ul>
            <p class="usospp-muted-text" style="margin-top:8px;">Poluzuj godziny dostępności albo usuń kolidującą blokadę terminu i spróbuj ponownie.</p>
          </div>
        `;
      }
      if (f.reason === 'infeasible') {
        const hasRelaxations = f.helpfulRelaxations && f.helpfulRelaxations.length;
        const hasPairs = f.conflictingPairs && f.conflictingPairs.length;
        return `
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:8px;color:oklch(55% 0.19 25);">Nie da się ułożyć planu</div>
            <p class="usospp-muted-text">Każdy przedmiot z osobna ma jakieś dostępne grupy, ale żadna ich kombinacja nie mieści się bez kolizji.</p>
            ${hasRelaxations ? `
              <p style="font-size:13px;font-weight:600;margin-top:10px;margin-bottom:4px;">To by pomogło (sprawdzone):</p>
              <ul style="margin:0 0 0 18px;padding:0;font-size:13px;">
                ${f.helpfulRelaxations.map((r) => `<li>Zluzuj: ${esc(r)}</li>`).join('')}
              </ul>
            ` : ''}
            ${hasPairs ? `
              <p style="font-size:13px;font-weight:600;margin-top:10px;margin-bottom:4px;">Całkowicie skonfliktowane pary zajęć:</p>
              <ul style="margin:0 0 0 18px;padding:0;font-size:13px;">
                ${f.conflictingPairs.map((p) => `<li>${esc(p.a)} ↔ ${esc(p.b)}</li>`).join('')}
              </ul>
            ` : ''}
            ${!hasRelaxations && !hasPairs ? `<p class="usospp-muted-text" style="margin-top:8px;">Spróbuj usunąć jeden z przedmiotów z generowania albo poluzować preferencje.</p>` : ''}
          </div>
        `;
      }
      return `<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wygenerować planu.</div></div>`;
    }

    // Same pixel-positioned weekly grid as renderPlannerGrid (same classes:
    // .usospp-timetable/.usospp-tt-*), just sourced from one generated
    // candidate's assignment instead of state.plannerPicks — no draft-
    // ghosting, no pendingRemoval, no conflict detection needed, since the
    // CSP engine only ever returns candidates that are already internally
    // conflict-free by construction.
    renderPlannerCandidateGrid(candidate) {
      const dark = this.settings.darkMode;
      const flat = [];
      candidate.assignment.forEach(({ variable, group }) => {
        (group.sessions || []).forEach((s) => {
          if (!s.start || !s.end) return;
          flat.push({
            day: s.day, start: s.start, end: s.end, place: s.place, weeks: s.weeks,
            subjectName: variable.subjectName, classTypeShort: variable.classTypeShort, teacher: group.teacher,
            seed: this.plannerColorSeed(variable.subjectName),
          });
        });
      });
      if (!flat.length) return `<div class="usospp-empty-hint">Brak zajęć w tym wariancie.</div>`;

      const allMins = flat.flatMap((e) => [toMin(e.start), toMin(e.end)]).filter((n) => n !== null);
      const hourStart = Math.max(0, Math.floor(Math.min(...allMins) / 60));
      const hourEnd = Math.ceil(Math.max(...allMins) / 60);
      const ROW_H = 60;
      const totalHeight = Math.max(1, hourEnd - hourStart) * ROW_H;
      const hours = [];
      for (let h = hourStart; h <= hourEnd; h++) hours.push(h);

      const byDay = {};
      flat.forEach((e) => { const d = shortDay(e.day); (byDay[d] = byDay[d] || []).push(e); });
      const dayGroups = DAY_KEYS.map((dk) => ({ day: dk, entries: byDay[dk] || [] })).filter((d) => d.entries.length);

      return `
        <div class="usospp-timetable">
          <div class="usospp-tt-hours" style="height:${totalHeight}px;">
            ${hours.map((h) => `<div class="usospp-tt-hour" style="top:${(h - hourStart) * ROW_H}px;">${h}:00</div>`).join('')}
          </div>
          <div class="usospp-tt-days">
            ${dayGroups.map((d) => `
              <div class="usospp-tt-daycol">
                <div class="usospp-tt-daylabel">${esc(d.day)}</div>
                <div class="usospp-tt-daybody" style="height:${totalHeight}px;background-size:100% ${ROW_H}px;">
                  ${d.entries.map((e) => {
                    const startMin = toMin(e.start);
                    const endMin = toMin(e.end);
                    const top = (startMin - hourStart * 60) * (ROW_H / 60);
                    const height = Math.max(36, (endMin - startMin) * (ROW_H / 60));
                    const color = subjectColor(e.seed, dark);
                    const weeksTag = weeksLabel(e.weeks);
                    const full = [e.subjectName, e.teacher, e.place].filter(Boolean).join(' — ')
                      + (weeksTag ? ` — co drugi tydzień (${e.weeks === 'even' ? 'parzyste' : 'nieparzyste'})` : '');
                    return `
                      <div class="usospp-tt-entry" style="top:${top}px;height:${height}px;background:${color.bg};" title="${esc(full)}">
                        <div class="usospp-tt-entry-time" style="color:${color.time};">${esc(e.start)}–${esc(e.end)}${weeksTag ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:9.5px;padding:1px 5px;">${weeksTag}</span>` : ''}</div>
                        <div class="usospp-tt-entry-label" style="color:${color.label};">${esc(e.classTypeShort)} · ${esc(e.subjectName)}</div>
                        ${e.teacher ? `<div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(e.teacher)}</div>` : ''}
                        ${e.place ? `<div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(shortPlace(e.place))}</div>` : ''}
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // A student comparing a few "what if" layouts (e.g. morning vs. evening
    // lab group) needs more than one saved draft at once — this is a small
    // tab strip over the saved plans (see planner-store.js), capped at
    // MAX_PLANS since an unbounded pile of half-abandoned drafts helps no
    // one. Duplicate/delete act on whichever plan is currently active,
    // rather than needing per-tab icon buttons.
    renderPlannerPlanTabs() {
      const plans = this.state.plannerPlans;
      const activeId = this.state.plannerActivePlanId;
      const planner = window.USOSPP_PLANNER;
      const maxPlans = (planner && planner.MAX_PLANS) || 5;
      const atLimit = plans.length >= maxPlans;
      return `
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
          ${plans.map((p) => `
            <button class="usospp-mode-btn${p.id === activeId ? ' active' : ''}" style="flex:none;padding:6px 12px;font-size:12px;" data-action="plannerSwitchPlan" data-id="${esc(p.id)}">${esc(p.name)}</button>
          `).join('')}
          ${!atLimit ? `<button class="usospp-btn-ghost" style="padding:6px 12px;font-size:12px;" data-action="plannerNewPlan">+ Nowy plan</button>` : ''}
        </div>
        <div style="display:flex;gap:14px;margin-bottom:14px;">
          ${!atLimit ? `<a data-action="plannerDuplicatePlan" style="font-size:12px;font-weight:600;">Duplikuj ten plan</a>` : `<span class="usospp-tag-muted">limit ${maxPlans} planów</span>`}
          ${plans.length > 1 ? `<a data-action="plannerDeletePlan" style="font-size:12px;font-weight:600;color:oklch(58% 0.19 25);">Usuń ten plan</a>` : ''}
        </div>
      `;
    }

    renderPlannerSubjectRow(s) {
      const url = s.detailsUrl;
      const expanded = this.state.plannerExpandedUrl === url;
      const color = subjectColor(this.plannerColorSeed(s.name), this.settings.darkMode);
      const already = this.state.plannerPicks.some((p) => subjectId(p.subjectUrl) === subjectId(url));
      return `
        <div class="usospp-planner-subject">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;cursor:pointer;" data-action="plannerToggleSubject" data-url="${esc(url)}">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              <span style="width:9px;height:9px;border-radius:999px;flex-shrink:0;background:${already ? color.time : 'var(--border)'};"></span>
              <div style="min-width:0;">
                <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.name)}</div>
                <div style="font-size:11.5px;color:var(--ink-3);">${esc(s.code || '')}</div>
              </div>
            </div>
            <span style="font-size:12px;font-weight:600;color:var(--ink-3);flex-shrink:0;">${expanded ? '▲' : (already ? 'edytuj ▾' : 'dodaj ▾')}</span>
          </div>
          ${expanded ? this.renderPlannerSubjectPanel(url) : ''}
        </div>
      `;
    }

    renderPlannerSubjectPanel(url) {
      if (this.state.plannerSubjectLoading === url) {
        return `<div class="usospp-empty-hint" style="padding:10px 0;">Wczytywanie…</div>`;
      }
      const details = this.state.plannerSubjectCache[url];
      if (!details || !details.supported) {
        return `<div class="usospp-empty-hint" style="padding:10px 0;">Nie udało się wczytać zajęć tego przedmiotu. <a data-action="openUsos" data-url="${esc(url)}">Otwórz w USOS →</a></div>`;
      }
      const relevantCycles = details.cycles.filter((c) => !/zakończon/i.test(c.cycleState || ''));
      const cycle = (relevantCycles.length ? relevantCycles : details.cycles)[0];
      if (!cycle) {
        return `<div class="usospp-empty-hint" style="padding:10px 0;">Ten przedmiot nie ma aktywnego cyklu zajęć.</div>`;
      }
      if (!cycle.classTypes.length) {
        return `<div class="usospp-empty-hint" style="padding:10px 0;">Brak zdefiniowanych typów zajęć dla tego cyklu.</div>`;
      }
      const previewable = cycle.classTypes.filter((ct) => ct.groupsUrl);
      const allPreviewed = previewable.length > 0
        && previewable.every((ct) => this.state.plannerPreviewKeys[classTypeKey(url, cycle.cycleName, ct.label)]);
      return `
        <div style="padding:2px 0 12px 0;">
          <div style="font-size:11.5px;color:var(--ink-3);margin-bottom:10px;">${esc(cycle.cycleName)}${cycle.period ? ` · ${esc(cycle.period)}` : ''}</div>
          ${cycle.classTypes.map((ct) => this.renderPlannerClassType(url, cycle.cycleName, ct)).join('')}
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">
            <button class="usospp-btn-primary" data-action="plannerAddSubject" data-url="${esc(url)}" data-subject-name="${esc(details.subjectName)}" data-cycle-name="${esc(cycle.cycleName)}">
              Dodaj do planu
            </button>
            ${previewable.length ? `
              <button class="usospp-btn-ghost" data-action="plannerTogglePreviewAll" data-url="${esc(url)}">
                ${allPreviewed ? 'Ukryj podgląd w planie' : 'Podgląd wszystkich grup'}
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }

    renderPlannerClassType(url, cycleName, ct) {
      const key = classTypeKey(url, cycleName, ct.label);
      const selection = this.state.plannerDraftSelection[key];
      if (!ct.groupsUrl) {
        return `
          <div style="margin-bottom:14px;">
            <div style="font-size:12.5px;font-weight:600;margin-bottom:4px;">${esc(ct.label)}</div>
            <div class="usospp-empty-hint" style="padding:4px 0;">Brak listy grup do wyboru dla tego typu zajęć.</div>
          </div>
        `;
      }
      const cached = this.state.plannerGroupsCache[ct.groupsUrl];
      const pendingRemoval = !!(selection && selection.removed);
      const previewed = !!this.state.plannerPreviewKeys[key];
      return `
        <div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;">
            <div style="font-size:12.5px;font-weight:600;">${esc(ct.label)}</div>
            <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
              ${selection && !pendingRemoval ? `<span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:11px;">grupa ${esc(selection.nr)}</span>` : ''}
              <a class="usospp-cand-toggle${previewed ? ' active' : ''}" data-action="plannerTogglePreview" data-key="${esc(key)}" data-groups-url="${esc(ct.groupsUrl)}" data-class-type-label="${esc(ct.label)}">${previewed ? 'ukryj podgląd' : 'podgląd w planie'}</a>
            </div>
          </div>
          ${previewed ? `<div style="font-size:11px;color:var(--ink-3);margin-bottom:6px;">Wszystkie grupy tego typu są widoczne w planie jako propozycje — najedź na termin, żeby zobaczyć plan z konkretną grupą; kliknij go, żeby ją wybrać.</div>` : ''}
          ${pendingRemoval ? `<div style="font-size:11.5px;color:oklch(55% 0.19 25);margin-bottom:6px;">Grupa ${esc(selection.nr)} zostanie usunięta z planu po zapisaniu — kliknij ją ponownie, aby to odwołać.</div>` : ''}
          ${!cached ? `
            <button class="usospp-btn-ghost" data-action="plannerLoadGroups" data-url="${esc(ct.groupsUrl)}">Pokaż grupy</button>
          ` : cached.loading ? `
            <div class="usospp-empty-hint" style="padding:4px 0;">Wczytywanie grup…</div>
          ` : !cached.data || !cached.data.supported || !cached.data.groups.length ? `
            <div class="usospp-empty-hint" style="padding:4px 0;">Nie udało się wczytać grup. <a data-action="openUsos" data-url="${esc(ct.groupsUrl)}">Otwórz w USOS →</a></div>
          ` : `
            <div style="max-height:220px;overflow-y:auto;">
              ${cached.data.groups.map((g) => this.renderPlannerGroupOption(key, ct.groupsUrl, ct.label, g, !pendingRemoval && !!(selection && selection.nr === g.nr))).join('')}
            </div>
          `}
        </div>
      `;
    }

    renderPlannerGroupOption(key, groupsUrl, classTypeLabel, g, selected) {
      const schedule = (g.sessions || []).map((sess) => `${esc(shortDay(sess.day))} ${esc(sess.start)}–${esc(sess.end)}${weeksLabel(sess.weeks) ? ` (${weeksLabel(sess.weeks)})` : ''}${sess.place ? `, ${esc(shortPlace(sess.place))}` : ''}`).join(' · ') || 'brak danych o terminie';
      const buildings = [...new Set((g.sessions || []).map((sess) => buildingCode(sess.place)).filter(Boolean))];
      return `
        <div class="usospp-radio-row${selected ? ' selected' : ''}" data-action="plannerSelectGroup" data-key="${esc(key)}" data-groups-url="${esc(groupsUrl)}" data-nr="${esc(g.nr)}" data-class-type-label="${esc(classTypeLabel)}">
          <div class="usospp-radio-dot"></div>
          <div style="min-width:0;flex:1;">
            <div style="font-size:12.5px;font-weight:600;">
              Grupa ${esc(g.nr)}
              ${buildings.length ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:10.5px;padding:2px 9px;">${esc(buildings.join(', '))}</span>` : ''}
              ${g.occupancy ? ` <span style="color:var(--ink-3);font-weight:500;">· ${esc(g.occupancy)}</span>` : ''}
            </div>
            <div style="font-size:11.5px;color:var(--ink-3);margin-top:1px;">${schedule}</div>
            ${g.teacher ? `<div style="font-size:11.5px;color:var(--ink-3);">${esc(g.teacher)}</div>` : ''}
          </div>
        </div>
      `;
    }

    renderPlannerPickGroup(entry) {
      const color = subjectColor(this.plannerColorSeed(entry.subjectName), this.settings.darkMode);
      return `
        <div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border-soft);">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="width:9px;height:9px;border-radius:999px;flex-shrink:0;background:${color.time};"></span>
            <div style="font-size:13px;font-weight:600;">${esc(entry.subjectName)}</div>
          </div>
          ${entry.picks.map((p) => `
            <div class="usospp-list-row">
              <div>
                <div style="font-size:12.5px;">${esc(p.classTypeLabel)} · grupa ${esc(p.nr)}</div>
                <div style="font-size:11.5px;color:var(--ink-3);margin-top:1px;">${(p.sessions || []).map((sess) => `${esc(shortDay(sess.day))} ${esc(sess.start)}–${esc(sess.end)}${weeksLabel(sess.weeks) ? ` (${weeksLabel(sess.weeks)})` : ''}`).join(' · ') || 'brak danych o terminie'}${p.teacher ? ' · ' + esc(p.teacher) : ''}</div>
              </div>
              <a data-action="plannerRemovePick" data-key="${esc(p.key)}" style="font-size:12px;font-weight:600;color:oklch(58% 0.19 25);">usuń</a>
            </div>
          `).join('')}
        </div>
      `;
    }

    // Builds the weekly-grid preview straight out of saved picks' sessions
    // (not out of any adapter timetable), and flags same-day overlapping
    // entries — a schedule the student assembled themselves can perfectly
    // well contain a conflict, so we surface it rather than silently
    // allowing or blocking any particular combination.
    renderPlannerGrid() {
      const dark = this.settings.darkMode;
      const draftSelection = this.state.plannerExpandedUrl ? this.state.plannerDraftSelection : {};
      const flat = [];
      this.state.plannerPicks.forEach((p) => {
        const pendingRemoval = !!(draftSelection[p.key] && draftSelection[p.key].removed);
        (p.sessions || []).forEach((s, i) => {
          if (!s.start || !s.end) return;
          flat.push({
            day: s.day, start: s.start, end: s.end, place: s.place, weeks: s.weeks,
            subjectName: p.subjectName, classTypeShort: p.classTypeShort, teacher: p.teacher,
            seed: this.plannerColorSeed(p.subjectName), pickKey: `${p.key}::${i}`, key: p.key, draft: false, pendingRemoval,
          });
        });
      });

      // While a subject's configurator is open, mirror whatever's currently
      // selected there into the grid right away as a dashed placeholder —
      // without this, picking a group only shows up after "Dodaj do planu",
      // so there's no way to see whether a choice actually fits until it's
      // already been committed.
      const expandedUrl = this.state.plannerExpandedUrl;
      if (expandedUrl) {
        const cached = this.state.plannerSubjectCache[expandedUrl];
        const subjectName = (cached && cached.subjectName) || '…';
        Object.entries(this.state.plannerDraftSelection).forEach(([key, g]) => {
          // A draft selection that's prefilled straight from an already-
          // saved pick (reopening a subject shows its existing choice as
          // "selected" automatically) is already on the grid as a real,
          // solid entry — ghosting it too would just draw a second, dashed
          // copy on top of itself. Only draw the ghost when the draft
          // actually differs from what's committed (i.e. the student is
          // previewing a change before saving it).
          const matchesCommitted = this.state.plannerPicks.some((p) => p.key === key && p.nr === g.nr);
          if (matchesCommitted) return;
          (g.sessions || []).forEach((s, i) => {
            if (!s.start || !s.end) return;
            flat.push({
              day: s.day, start: s.start, end: s.end, place: s.place, weeks: s.weeks,
              subjectName, classTypeShort: shortClassType(g.classTypeLabel), teacher: g.teacher,
              seed: this.plannerColorSeed(subjectName), pickKey: `${key}::draft::${i}`, key, draft: true,
            });
          });
        });

        // Previewed class types ("podgląd w planie", see
        // plannerTogglePreview): every not-yet-chosen group becomes a
        // lightweight ghost box for each of its sessions (renderPlannerCandDay).
        // They feed the hour range like real entries — the time axis has to
        // stretch to show them — but are deliberately excluded from the
        // conflict computation below: trying every group on for size is the
        // whole point of the preview.
        Object.entries(this.state.plannerPreviewKeys).forEach(([key, meta]) => {
          const groupsEntry = this.state.plannerGroupsCache[meta.groupsUrl];
          if (!groupsEntry || groupsEntry.loading || !groupsEntry.data || !groupsEntry.data.supported) return;
          const draft = this.state.plannerDraftSelection[key];
          groupsEntry.data.groups.forEach((g) => {
            // The class type's draft/committed choice is already on the
            // grid (dashed ghost / solid box) — ghosting the same group a
            // second time would just double-draw it on top of itself. An
            // exception: while the committed choice is pending removal
            // (draft.removed), it renders struck-through and the student
            // is re-picking, so its group belongs back in the candidates.
            if (draft && !draft.removed && draft.nr === g.nr) return;
            const removalPending = !!(draft && draft.removed);
            if (!removalPending && this.state.plannerPicks.some((p) => p.key === key && p.nr === g.nr)) return;
            (g.sessions || []).forEach((s) => {
              if (!s.start || !s.end) return;
              flat.push({
                day: s.day, start: s.start, end: s.end, place: s.place, weeks: s.weeks,
                subjectName, classTypeShort: shortClassType(meta.classTypeLabel), teacher: g.teacher,
                seed: this.plannerColorSeed(subjectName), pickKey: `cand::${key}::${g.nr}`, key,
                draft: false, pendingRemoval: false, candidate: true, candGroup: `${key}::${g.nr}`,
                candRef: { key, groupsUrl: meta.groupsUrl, classTypeLabel: meta.classTypeLabel, nr: g.nr, teacher: g.teacher },
              });
            });
          });
        });
      }

      if (!flat.length) {
        return `<div class="usospp-empty-hint">Dodaj przedmioty po lewej, żeby zobaczyć tu podgląd planu.</div>`;
      }

      const allMins = flat.flatMap((e) => [toMin(e.start), toMin(e.end)]).filter((n) => n !== null);
      const hourStart = Math.max(0, Math.floor(Math.min(...allMins) / 60));
      const hourEnd = Math.ceil(Math.max(...allMins) / 60);
      const ROW_H = 60;
      const totalHeight = Math.max(1, hourEnd - hourStart) * ROW_H;
      const hours = [];
      for (let h = hourStart; h <= hourEnd; h++) hours.push(h);

      const byDay = {};
      flat.forEach((e) => {
        const d = shortDay(e.day);
        (byDay[d] = byDay[d] || []).push(e);
      });
      const conflicts = new Set();
      Object.values(byDay).forEach((list) => {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];
            if (a.candidate || b.candidate) continue;
            if (sessionsOverlap(a, b)) {
              conflicts.add(a.pickKey);
              conflicts.add(b.pickKey);
            }
          }
        }
      });

      // Which candidate groups would collide with the schedule as it
      // stands. Same-key entries are exempt — a different group of the
      // same class type REPLACES the current choice, it doesn't stack on
      // it — as are picks pending removal (the student is already
      // re-choosing there). Purely candidate-vs-candidate overlap never
      // counts: parallel groups sharing one slot are the normal case.
      const riskyGids = new Set();
      Object.values(byDay).forEach((list) => {
        list.forEach((c) => {
          if (!c.candidate) return;
          list.forEach((r) => {
            if (r.candidate || r.pendingRemoval || r.key === c.key) return;
            if (sessionsOverlap(c, r)) riskyGids.add(c.candGroup);
          });
        });
      });

      const dayGroups = DAY_KEYS.map((dk) => ({ day: dk, entries: byDay[dk] || [] })).filter((d) => d.entries.length);

      return `
        ${conflicts.size ? `<div style="font-size:12px;font-weight:600;color:oklch(55% 0.19 25);margin-bottom:10px;">⚠ Wybrane zajęcia nakładają się w czasie — zaznaczone poniżej.</div>` : ''}
        <div class="usospp-timetable" data-planner-grid>
          <div class="usospp-tt-hours" style="height:${totalHeight}px;">
            ${hours.map((h) => `<div class="usospp-tt-hour" style="top:${(h - hourStart) * ROW_H}px;">${h}:00</div>`).join('')}
          </div>
          <div class="usospp-tt-days">
            ${dayGroups.map((d, di) => `
              <div class="usospp-tt-daycol">
                <div class="usospp-tt-daylabel">${esc(d.day)}</div>
                <div class="usospp-tt-daybody" style="height:${totalHeight}px;background-size:100% ${ROW_H}px;">
                  ${this.renderPlannerCandDay(d.day, d.entries.filter((e) => e.candidate), hourStart, dark, riskyGids, di, dayGroups.length)}
                  ${d.entries.filter((e) => !e.candidate).map((e) => {
                    const startMin = toMin(e.start);
                    const endMin = toMin(e.end);
                    const top = (startMin - hourStart * 60) * (ROW_H / 60);
                    const height = Math.max(36, (endMin - startMin) * (ROW_H / 60));
                    const color = subjectColor(e.seed, dark);
                    const conflict = conflicts.has(e.pickKey);
                    const removeColor = 'oklch(55% 0.19 25)';
                    const weeksTag = weeksLabel(e.weeks);
                    const full = [e.subjectName, e.teacher, e.place].filter(Boolean).join(' — ')
                      + (weeksTag ? ` — co drugi tydzień (${e.weeks === 'even' ? 'parzyste' : 'nieparzyste'})` : '')
                      + (e.draft ? ' (jeszcze niedodane)' : e.pendingRemoval ? ' (zostanie usunięte po zapisaniu)' : '');
                    const entryStyle = e.draft
                      ? `background:transparent;border:2px dashed ${color.time};opacity:0.85;`
                      : e.pendingRemoval
                        ? `background:transparent;border:2px dashed ${removeColor};opacity:0.55;`
                        : `background:${color.bg};`;
                    const labelStyle = `color:${e.pendingRemoval ? removeColor : color.label};${e.pendingRemoval ? 'text-decoration:line-through;' : ''}`;
                    return `
                      <div class="usospp-tt-entry${conflict ? ' usospp-tt-entry--conflict' : ''}" style="top:${top}px;height:${height}px;${entryStyle}" title="${esc(full)}">
                        <div class="usospp-tt-entry-time" style="color:${e.pendingRemoval ? removeColor : color.time};">${esc(e.start)}–${esc(e.end)}${weeksTag ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:9.5px;padding:1px 5px;">${weeksTag}</span>` : ''}</div>
                        <div class="usospp-tt-entry-label" style="${labelStyle}">${esc(e.classTypeShort)} · ${esc(e.subjectName)}</div>
                        ${e.teacher ? `<div class="usospp-tt-entry-meta" style="color:${e.pendingRemoval ? removeColor : color.meta};">${esc(e.teacher)}</div>` : ''}
                        ${e.place ? `<div class="usospp-tt-entry-meta" style="color:${e.pendingRemoval ? removeColor : color.meta};">${esc(shortPlace(e.place))}</div>` : ''}
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Candidate ghosts for one day column of the preview grid — entries
    // from previewed class types ("podgląd w planie"), clustered by
    // (start, end, weeks). Parallel groups almost always share one
    // identical slot, and a stack of exact-duplicate boxes would only ever
    // let the top one be hovered, so a multi-group cluster renders as a
    // single neutral "N grup" box: hovering it opens a popover with one
    // row per group (row hover = live preview in the grid, row click =
    // choose), backed by one hidden per-group box so the hovered group can
    // materialize exactly where the neutral box sits. A cluster of one is
    // the simple case from the feature description — its box is directly
    // hoverable/clickable.
    renderPlannerCandDay(dayKey, candEntries, hourStart, dark, riskyGids, dayIndex, dayCount) {
      if (!candEntries.length) return '';
      const ROW_H = 60;
      const bySlot = new Map();
      candEntries.forEach((e) => {
        const cid = `${dayKey}::${e.start}::${e.end}::${e.weeks || ''}`;
        if (!bySlot.has(cid)) bySlot.set(cid, []);
        bySlot.get(cid).push(e);
      });
      // The rightmost day columns anchor the popover to the right edge, so
      // it grows inward instead of widening the timetable's horizontal
      // scroll to nothing.
      const anchorRight = dayIndex >= dayCount - 2;
      return [...bySlot.entries()].map(([cid, entries]) => {
        const first = entries[0];
        const top = (toMin(first.start) - hourStart * 60) * (ROW_H / 60);
        const height = Math.max(36, (toMin(first.end) - toMin(first.start)) * (ROW_H / 60));
        if (entries.length === 1) {
          return this.renderPlannerCandBox(first, { top, height, dark, stacked: false, risky: riskyGids.has(first.candGroup) });
        }
        const boxes = entries
          .map((e) => this.renderPlannerCandBox(e, { top, height, dark, stacked: true, risky: riskyGids.has(e.candGroup) }))
          .join('');
        const byGid = new Map();
        entries.forEach((e) => { if (!byGid.has(e.candGroup)) byGid.set(e.candGroup, e); });
        const rows = [...byGid.values()].map((e) => `
          <div class="usospp-cand-row${riskyGids.has(e.candGroup) ? ' usospp-cand-row--risk' : ''}" data-cand-row="1"
               data-cand-group="${esc(e.candGroup)}" data-action="plannerSelectGroup"
               data-key="${esc(e.candRef.key)}" data-groups-url="${esc(e.candRef.groupsUrl)}"
               data-nr="${esc(e.candRef.nr)}" data-class-type-label="${esc(e.candRef.classTypeLabel)}">
            <div class="usospp-cand-row-main">
              Grupa ${esc(e.candRef.nr)}
              <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:10px;padding:1px 7px;">${esc(e.classTypeShort)}</span>
              ${riskyGids.has(e.candGroup) ? '<span class="usospp-cand-risk-dot" title="Nachodzi na zajęcia już wybrane w planie"></span>' : ''}
            </div>
            <div class="usospp-cand-row-sub">${esc(e.candRef.teacher || 'brak danych o prowadzącym')}${e.place ? ` · ${esc(shortPlace(e.place))}` : ''}</div>
          </div>
        `).join('');
        const labels = [...new Set(entries.map((e) => e.classTypeShort))];
        const color = subjectColor(this.plannerColorSeed(first.subjectName), dark);
        const weeksTag = weeksLabel(first.weeks);
        return `
          <div class="usospp-tt-entry usospp-tt-entry--cand usospp-cand-neutral" data-cand-neutral="1" data-cand-cluster="${esc(cid)}"
               style="top:${top}px;height:${height}px;border:2px dashed ${color.time};background:${color.bg};opacity:0.45;"
               title="${esc(`${byGid.size} równoległych grup na ten termin — najedź, aby je porównać`)}">
            <div class="usospp-tt-entry-time" style="color:${color.time};">${esc(first.start)}–${esc(first.end)}${weeksTag ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:9.5px;padding:1px 5px;">${weeksTag}</span>` : ''}</div>
            <div class="usospp-tt-entry-label" style="color:${color.label};">${labels.length === 1 ? `${esc(labels[0])} · ` : ''}${byGid.size} grup — wybierz</div>
            <div class="usospp-tt-entry-meta" style="color:${color.meta};">najedź, aby porównać terminy</div>
          </div>
          ${boxes}
          <div class="usospp-cand-pop" data-cand-pop="${esc(cid)}" data-cand-cluster="${esc(cid)}" style="top:${top + height + 2}px;${anchorRight ? 'right:2px;' : 'left:2px;'}">
            <div class="usospp-cand-pop-title">Najedź na grupę, aby zobaczyć ją w planie — kliknij, aby wybrać:</div>
            ${rows}
          </div>
        `;
      }).join('');
    }

    // One candidate group's ghost box. Same visual family as a draft ghost
    // (dashed, subject colour) but visibly lighter — a "maybe", not a
    // choice. Clicking runs the very same plannerSelectGroup the radio rows
    // in the subject list use, so a group picked from the grid is
    // indistinguishable from one picked from the list afterwards.
    renderPlannerCandBox(e, { top, height, dark, stacked, risky }) {
      const color = subjectColor(e.seed, dark);
      const weeksTag = weeksLabel(e.weeks);
      const full = `${e.subjectName} — ${e.candRef.classTypeLabel} — grupa ${e.candRef.nr}`
        + (e.teacher ? ` — ${e.teacher}` : '')
        + (e.place ? ` — ${e.place}` : '')
        + (weeksTag ? ` — co drugi tydzień (${e.weeks === 'even' ? 'parzyste' : 'nieparzyste'})` : '')
        + (risky ? ' — nachodzi na zajęcia już wybrane w planie' : '')
        + ' — propozycja, kliknij, aby wybrać';
      return `
        <div class="usospp-tt-entry usospp-tt-entry--cand${stacked ? ' usospp-cand-in-stack' : ''}${risky ? ' usospp-cand-risk' : ''}"
             data-cand-group="${esc(e.candGroup)}" data-action="plannerSelectGroup"
             data-key="${esc(e.candRef.key)}" data-groups-url="${esc(e.candRef.groupsUrl)}"
             data-nr="${esc(e.candRef.nr)}" data-class-type-label="${esc(e.candRef.classTypeLabel)}"
             style="top:${top}px;height:${height}px;border:2px dashed ${color.time};background:${color.bg};opacity:0.55;"
             title="${esc(full)}">
          <div class="usospp-tt-entry-time" style="color:${color.time};">${esc(e.start)}–${esc(e.end)}${weeksTag ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:9.5px;padding:1px 5px;">${weeksTag}</span>` : ''}</div>
          <div class="usospp-tt-entry-label" style="color:${color.label};">${esc(e.classTypeShort)} · grupa ${esc(e.candRef.nr)}${risky ? ' ⚠' : ''}</div>
          ${e.teacher ? `<div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(e.teacher)}</div>` : ''}
          ${e.place ? `<div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(shortPlace(e.place))}</div>` : ''}
        </div>
      `;
    }

    renderEgzaminy() {
      const exams = this.exams;
      const ex = this.data.examsResult || {};
      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Egzaminy</div>
              <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dla_stud/rejestracja/egzaminy&usospp_off=1">Otwórz zapisy w USOS →</button>
            </div>
            ${!ex.supported ? `
              <div class="usospp-empty-hint">Brak zaplanowanych egzaminów albo moduł zapisów jeszcze się nie wczytał — sprawdź w klasycznym USOS.</div>
            ` : `
              <div class="usospp-raw-dump">${esc(JSON.stringify(exams, null, 2))}</div>
            `}
          </div>
        </div>
      `;
    }

    renderEcts() {
      const etapy = this.etapy;
      const s = this.state;
      const avgNum = parseFloat((s.calcAvg || '').replace(',', '.'));
      const ectsNum = parseFloat((s.calcEcts || '').replace(',', '.'));
      const newGrade = parseFloat(s.calcGrade);
      const newEcts = parseFloat(s.calcNewEcts);
      const canProject = !Number.isNaN(avgNum) && !Number.isNaN(ectsNum) && ectsNum > 0;
      const projected = canProject ? ((avgNum * ectsNum + newGrade * newEcts) / (ectsNum + newEcts)).toFixed(2) : null;

      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:16px;">Zaliczenia etapów</div>
            ${etapy.length === 0 ? `<div class="usospp-empty-hint">Brak danych o etapach studiów.</div>` : etapy.map((e) => `
              <div class="usospp-list-row">
                <div>
                  <div style="font-size:14px;font-weight:600;">${esc(e.label)}</div>
                  <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(e.programLabel)}</div>
                  <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">Cykl: ${esc(e.cycle || '—')} · koniec: ${esc(e.endDate || '—')}</div>
                </div>
                <div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(e.status || '—')}</div>
              </div>
            `).join('')}
          </div>

          <div class="usospp-card">
            <div class="usospp-card-title">Kalkulator średniej</div>
            <div class="usospp-muted-text" style="margin-bottom:16px;">Podaj swoją obecną średnią i sumę ECTS (nie odczytujemy tego jeszcze automatycznie z USOS), żeby sprawdzić, jak wpłynie kolejna ocena.</div>
            <div class="usospp-calc-grid">
              <div>
                <label class="usospp-field-label">Obecna średnia</label>
                <input class="usospp-input" placeholder="np. 4.20" value="${esc(s.calcAvg)}" data-bind="calcAvg">
              </div>
              <div>
                <label class="usospp-field-label">Suma zaliczonych ECTS</label>
                <input class="usospp-input" placeholder="np. 90" value="${esc(s.calcEcts)}" data-bind="calcEcts">
              </div>
              <div>
                <label class="usospp-field-label">Spodziewana ocena</label>
                <select class="usospp-input" data-bind="calcGrade">
                  ${['5.0', '4.5', '4.0', '3.5', '3.0'].map((g) => `<option value="${g}" ${s.calcGrade === g ? 'selected' : ''}>${g}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="usospp-field-label">ECTS przedmiotu</label>
                <select class="usospp-input" data-bind="calcNewEcts">
                  ${['3', '4', '5', '6'].map((n) => `<option value="${n}" ${s.calcNewEcts === n ? 'selected' : ''}>${n}</option>`).join('')}
                </select>
              </div>
              <div class="usospp-calc-result">
                <div style="font-size:11px;color:var(--ink-3);font-weight:600;">nowa średnia</div>
                <div style="font-size:20px;font-weight:700;color:oklch(58% 0.15 45);">${projected || '—'}</div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // USOS spreads this across a hub + 5 sub-pages (należności nierozliczone
    // / rozliczone, plany ratalne, wpłaty wszystkie / nierozliczone) plus a
    // separate "konta bankowe" page under a different module entirely — see
    // scraping.js's PATHS.platnosci* comment for why "rozliczone" specifically
    // is folded away rather than shown as its own section here.
    renderPlatnosci() {
      const p = this.data.paymentsResult || {};
      const unpaid = p.unpaid || { groups: [] };
      const installments = p.installments || { groups: [] };
      const payments = p.payments || { groups: [] };
      const unsettled = p.unsettledPayments || { groups: [] };
      const accounts = (p.bankAccounts && p.bankAccounts.accounts) || [];

      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:14px;">Do zapłaty</div>
            ${installments.groups.length ? `
              <div class="usospp-notice">
                <span>Masz należności czekające na wybór planu ratalnego.</span>
                <a data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dodatki/platnosci/planyRatalne&usospp_off=1">Wybierz w USOS →</a>
              </div>
            ` : ''}
            ${unpaid.groups.length === 0 ? `
              <div class="usospp-empty-hint">Brak nierozliczonych należności — wszystko opłacone</div>
            ` : unpaid.groups.map(renderPaymentGroup).join('')}
            ${unpaid.grandTotal ? `<div style="font-size:12.5px;font-weight:600;text-align:right;">${esc(unpaid.grandTotal)}</div>` : ''}
          </div>

          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:14px;">Historia wpłat</div>
            ${unsettled.groups.length ? `
              <div class="usospp-notice">
                <span>Część wpłat nie została jeszcze w pełni rozliczona z należnościami.</span>
                <a data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dodatki/platnosci/wplatyNierozliczone&usospp_off=1">Otwórz w USOS →</a>
              </div>
            ` : ''}
            ${payments.groups.length === 0 ? `
              <div class="usospp-empty-hint">Brak zarejestrowanych wpłat.</div>
            ` : payments.groups.map(renderPaymentGroup).join('')}
            ${payments.grandTotal ? `<div style="font-size:12.5px;font-weight:600;text-align:right;">${esc(payments.grandTotal)}</div>` : ''}
          </div>

          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:14px;">Konta bankowe do wpłat</div>
            ${accounts.length === 0 ? `
              <div class="usospp-empty-hint">Nie udało się odczytać numerów kont z USOS.</div>
            ` : accounts.map((a) => `
              <div class="usospp-list-row" style="align-items:flex-start;">
                <div>
                  <div style="font-size:13.5px;font-weight:600;">${esc(a.label)}</div>
                  <div style="font-size:13px;font-family:ui-monospace,monospace;margin-top:4px;">${esc(a.number)}</div>
                  <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(a.bankName || '—')}${a.currency ? ` · ${esc(a.currency)}` : ''}</div>
                </div>
                ${a.blankietUrl ? `<a href="${esc(a.blankietUrl)}" target="_blank" rel="noopener" style="font-size:12.5px;font-weight:600;color:#d9773a;white-space:nowrap;flex-shrink:0;">blankiet →</a>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Shared shell for the four small "Moje studia" list pages — each is
    // just adapter.genericInfoTable's rows in one card, or an empty hint.
    renderInfoTableView(result, emptyText) {
      const rows = (result && Array.isArray(result.rows)) ? result.rows : [];
      return `
        <div class="usospp-view">
          <div class="usospp-card">
            ${rows.length === 0
              ? `<div class="usospp-empty-hint">${esc(emptyText)}</div>`
              : rows.map(renderInfoTableRow).join('')}
          </div>
        </div>
      `;
    }

    renderStypendia() {
      return this.renderInfoTableView(this.data.scholarshipsResult, 'Brak informacji o otrzymywanych stypendiach.');
    }

    renderSprawdziany() {
      return this.renderInfoTableView(this.data.testsResult, 'Nie jesteś zapisany na żadne zajęcia lub żaden z prowadzących nie zdefiniował elektronicznych zasad rozliczania swojego przedmiotu.');
    }

    renderPodania() {
      return this.renderInfoTableView(this.data.petitionsResult, 'Brak złożonych podań.');
    }

    renderAnkiety() {
      return this.renderInfoTableView(this.data.surveysResult, 'Brak ankiet do wypełnienia.');
    }

    renderUstawienia() {
      const u = this.data.user || {};
      const f = this.settings.features || {};
      const dark = this.settings.darkMode;
      // Grouped by *when* each feature actually does something — see
      // inject.js's applyIndependentFeatures for the code these describe.
      const featureGroups = [
        {
          label: 'Wymagają włączonego panelu USOS++',
          keys: {
            keyboardNav: ['Nawigacja klawiaturą', 'Skróty 1–9 do przełączania sekcji w USOS++'],
            autorefresh: ['Automatyczne odświeżanie danych', 'Dane odświeżają się bez przeładowania strony'],
            gradeBadge: ['Odznaka średniej na ikonie', 'Aktualizuje się, gdy panel USOS++ jest włączony'],
          },
        },
        {
          label: 'Działają niezależnie od panelu USOS++',
          keys: {
            quickbar: ['Szybkie akcje w toolbarze', 'Widoczne w klasycznym USOS, gdy panel USOS++ jest wyłączony'],
            classicWidgets: ['Widżety na stronach klasycznych', 'Średnia w Ocenach, zaległości w Płatnościach, licznik zajęć w Planie i podsumowanie w Mój USOSweb'],
          },
        },
      ];
      return `
        <div class="usospp-view">
          <div class="usospp-two-col">
            <div style="display:flex;flex-direction:column;gap:20px;">
              <div class="usospp-card">
                <div class="usospp-card-title" style="margin-bottom:18px;">Profil</div>
                <div class="usospp-field-stack">
                  <div>
                    <label class="usospp-field-label">Imię i nazwisko</label>
                    <input class="usospp-input" value="${esc(u.name || '—')}" readonly>
                  </div>
                  <div>
                    <label class="usospp-field-label">Numer albumu</label>
                    <input class="usospp-input" value="${esc(u.album || '—')}" readonly>
                  </div>
                  <div>
                    <label class="usospp-field-label">Jednostka</label>
                    <input class="usospp-input" value="${esc(u.faculty || '—')}" readonly>
                  </div>
                  <div>
                    <label class="usospp-field-label">Kierunek</label>
                    <input class="usospp-input" value="${esc(this.kierunek || '—')}" readonly>
                  </div>
                </div>
              </div>

              <div class="usospp-card">
                <div class="usospp-card-title" style="margin-bottom:6px;">Wygląd</div>
                <div class="usospp-muted-text" style="margin-bottom:16px;">Wybierz jasny lub ciemny motyw interfejsu USOS++.</div>
                <div style="display:flex;gap:10px;">
                  <button class="usospp-mode-btn ${!dark ? 'active' : ''}" data-action="setDark" data-value="false">☀ Jasny</button>
                  <button class="usospp-mode-btn ${dark ? 'active' : ''}" data-action="setDark" data-value="true">☾ Ciemny</button>
                </div>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:20px;">
              ${featureGroups.map((group) => `
                <div class="usospp-card">
                  <div class="usospp-card-title" style="margin-bottom:16px;">${esc(group.label)}</div>
                  <div class="usospp-field-stack">
                    ${Object.keys(group.keys).map((key) => `
                      <div class="usospp-list-row">
                        <div>
                          <div style="font-size:13.5px;font-weight:500;">${esc(group.keys[key][0])}</div>
                          <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(group.keys[key][1])}</div>
                        </div>
                        <div class="usospp-switch ${f[key] ? 'on' : ''}" data-action="toggleFeature" data-key="${key}"><div class="usospp-switch-knob"></div></div>
                      </div>
                    `).join('')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;
    }

  }

  window.USOSPP_APP = {
    mount(root, data, settings) {
      const app = new App(root, data, settings);
      app.render();
      return app;
    },
  };
})();

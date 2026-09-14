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
    // USOSmail's own UI is 100% client-rendered against an internal,
    // CSRF-walled endpoint whose own error message says not to use it as an
    // API — and every USOSweb page sends X-Frame-Options: deny, so it can't
    // even be embedded in an iframe. No legitimate way to show it in our own
    // UI, so this is a pure link-out (see renderSidebar) rather than a real
    // nav view: it never becomes the active view and isn't in VALID_VIEWS.
    { id: 'wiadomosci', label: 'Wiadomości', icon: 'mail', external: 'kontroler.php?_action=home/usos_mail/nowaWiadomosc&usospp_off=1' },
    { id: 'egzaminy', label: 'Egzaminy', icon: 'check' },
    { id: 'sprawdziany', label: 'Sprawdziany', icon: 'clipboard' },
    { id: 'ects', label: 'ECTS / Postęp', icon: 'ring' },
  ];

  // Lower-traffic sections tucked behind the collapsible "Więcej" row in the
  // sidebar (see renderSidebar) instead of each getting a permanent
  // top-level slot.
  const MORE_NAV_ITEMS = [
    { id: 'platnosci', label: 'Płatności', icon: 'card' },
    { id: 'stypendia', label: 'Stypendia', icon: 'coins' },
    { id: 'podania', label: 'Podania', icon: 'send' },
    { id: 'ankiety', label: 'Ankiety', icon: 'star' },
  ];

  // "przedmioty" is a hub tile screen — Przegląd/Zapisy/Generator planu live
  // one level under it now instead of each having their own nav row. A nav
  // item should still read as "active" while the user is anywhere inside its
  // group (including a subject-detail page opened from within it), even
  // though only the hub id itself appears in NAV_ITEMS.
  const NAV_GROUPS = {
    przedmioty: ['przedmioty', 'przedmiotyLista', 'zapisy', 'planer'],
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
    ...MORE_NAV_ITEMS.map((item) => item.id),
    'przedmiotyLista', 'zapisy', 'planer', 'ustawienia', 'subjectPage', 'catalogPage',
  ]);

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
        searchQuery: '',
        searchLoading: false,
        searchResults: null,
        plannerExpandedUrl: null,
        plannerSubjectCache: {},
        plannerSubjectLoading: null,
        plannerGroupsCache: {},
        plannerDraftSelection: {},
        plannerPicks: [],
        plannerPlans: [],
        plannerActivePlanId: null,
      };
      this._onClick = this.handleClick.bind(this);
      this._onChange = this.handleChange.bind(this);
      this._onInput = this.handleInput.bind(this);
      this._onKeydown = this.handleKeydown.bind(this);
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
    }

    destroy() {
      this.root.removeEventListener('click', this._onClick);
      this.root.removeEventListener('change', this._onChange);
      this.root.removeEventListener('input', this._onInput);
      this.root.removeEventListener('keydown', this._onKeydown);
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

    persistViewState() {
      saveViewState({
        view: this.state.view,
        subjectUrl: this.state.view === 'subjectPage' ? this.state.subjectUrl : null,
        subjectBackView: this.state.view === 'subjectPage' ? this.state.subjectBackView : null,
        catalogKind: this.state.view === 'catalogPage' ? this.state.catalogKind : null,
        catalogKod: this.state.view === 'catalogPage' ? this.state.catalogKod : null,
        catalogEtpKod: this.state.view === 'catalogPage' && this.state.catalogKind === 'stage' ? this.state.catalogEtpKod : null,
        catalogBackView: this.state.view === 'catalogPage' ? this.state.catalogBackView : null,
      });
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
        default:
          break;
      }
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
                      <td>${g.sessions.map((sess) => `${esc(sess.day)} ${esc(sess.start)}–${esc(sess.end)}${sess.place ? `, ${esc(sess.place)}` : ''}`).join('<br>') || '—'}</td>
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
      this.setState((s) => ({
        view: 'catalogPage',
        catalogBackView: s.view === 'catalogPage' ? s.catalogBackView : s.view,
        catalogKind: kind,
        catalogKod: kod,
        catalogLoading: true,
        catalogError: false,
        catalogData: null,
      }));
      this.persistViewState();
      this.fetchCatalogPage(kind, kod);
    }

    fetchCatalogPage(kind, kod) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ catalogLoading: false, catalogError: true });
        return;
      }
      const url = kind === 'unit' ? scrape.PATHS.unitDetail(kod) : scrape.PATHS.programDetail(kod);
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const details = doc && adapter
            ? (kind === 'unit' ? adapter.getUnitDetail(doc) : adapter.getProgramDetail(doc))
            : null;
          if (!details || !details.supported) {
            this.setState({ catalogLoading: false, catalogError: true });
          } else {
            this.setState({ catalogLoading: false, catalogData: details });
          }
        })
        .catch(() => {
          this.setState({ catalogLoading: false, catalogError: true });
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

    // Expands/collapses a subject's class-type configurator in the planner's
    // subject list. Pre-fills the draft selection from whatever's already
    // saved for this subject, so reopening it to tweak one class type
    // doesn't blank out the others; fetches the subject's cycle/class-type
    // data on first expand only (cached per session after that).
    plannerToggleSubject(url) {
      if (!url) return;
      if (this.state.plannerExpandedUrl === url) {
        this.setPlannerState({ plannerExpandedUrl: null });
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
      this.setPlannerState((s) => ({ plannerDraftSelection: { ...s.plannerDraftSelection, [key]: { ...group, classTypeLabel } } }));
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
      this.savePlannerPicks([...otherPicks, ...newPicks], { plannerExpandedUrl: null });
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
      this.setState({ [el.dataset.bind]: el.value });
    }

    handleInput(e) {
      if (e.target.dataset.action === 'searchInput') this.onSearchInput(e.target.value);
    }

    handleKeydown(e) {
      if (e.target.dataset.action === 'searchInput' && e.key === 'Escape') {
        this.clearSearch();
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
        return;
      }
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
      const renderNavItem = (item, sub) => item.external ? `
        <div class="usospp-nav-item${sub ? ' sub' : ''}" data-action="openUsos" data-url="${esc(location.origin)}/${item.external}" title="Otwiera klasyczny USOS w nowej karcie">
          ${icon(item.icon)}<span>${esc(item.label)}</span>
        </div>
      ` : `
        <div class="usospp-nav-item${sub ? ' sub' : ''}${this.isNavActive(item.id) ? ' active' : ''}" data-action="nav" data-view="${item.id}">
          ${icon(item.icon)}<span>${esc(item.label)}</span>
          ${this.navItemDot(item.id) ? '<span class="usospp-nav-dot"></span>' : ''}
        </div>
      `;
      // Three states, independent of each other: fully expanded shows every
      // item (moreExpanded); collapsed-but-something-inside-is-active shows
      // just that one row, so you never lose track of where you are; fully
      // collapsed (not expanded, nothing active inside) shows nothing.
      // moreOpen only ever means "fully expanded" — it does NOT auto-force
      // itself open just because the active view happens to live in here,
      // otherwise there'd be no way to collapse it back while still on one
      // of its pages.
      const moreOpen = this.state.moreExpanded;
      const activeMoreItem = MORE_NAV_ITEMS.find((item) => item.id === this.state.view);
      const moreActive = !!activeMoreItem;
      const moreHasDot = !moreOpen && !activeMoreItem && MORE_NAV_ITEMS.some((item) => this.navItemDot(item.id));
      const moreChildren = moreOpen
        ? MORE_NAV_ITEMS.map((item) => renderNavItem(item, true)).join('')
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
          <div class="usospp-user-card" data-action="nav" data-view="ustawienia" title="Ustawienia">
            <div class="usospp-avatar">${esc(initials || '—')}</div>
            <div class="usospp-user-meta">
              <div class="usospp-user-name">${esc(u.name || 'Nie rozpoznano')}</div>
              <div class="usospp-user-sub">${esc(this.kierunek || u.faculty || (u.album ? `nr albumu ${u.album}` : '—'))}</div>
            </div>
          </div>
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
                  <div class="usospp-dropdown-item" data-action="disableUsospp" style="color:oklch(58% 0.19 25);">Wyłącz USOS++ / Powrót do USOS</div>
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
      if (q.length < 3) return '';
      if (this.state.searchLoading) {
        return `<div class="usospp-search-dropdown"><div class="usospp-empty-hint" style="padding:16px;">Szukanie…</div></div>`;
      }
      const r = this.state.searchResults;
      if (!r) return '';
      const total = r.subjects.length + r.units.length + r.programs.length;
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
      // Logged out of USOSweb: no per-page data exists to show regardless
      // of which nav item is active, so every view falls back to the same
      // login prompt instead of rendering its normal (empty) content — the
      // sidebar/topbar stay fully usable, only the content pane changes.
      if (this.data.loggedOut) return this.renderLoggedOut();
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
            <p class="usospp-loggedout-text">Nie jesteś obecnie zalogowany/a, więc USOS++ nie ma skąd wziąć danych.</p>
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
      const header = backLink(s.catalogBackView || 'dashboard');
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
          ${d.children.length ? `
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:14px;">Jednostki podległe</div>
              ${d.children.map((c) => `
                <div class="usospp-list-row" data-action="searchOpenUnit" data-kod="${esc(c.kod)}" style="cursor:pointer;">
                  <div style="font-size:13.5px;font-weight:500;">${esc(c.name)}</div>
                  <div style="color:var(--ink-3);">→</div>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }

    // "Programy studiów" search result — see adapter.getProgramDetail.
    // "Główne toki nauczania" stage links open our own stage subpage (see
    // openStagePage/renderStagePage) instead of bouncing out to USOS.
    renderProgramPage() {
      const s = this.state;
      const header = backLink(s.catalogBackView || 'dashboard');
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
                    const full = [e.label, e.teacher, e.place].filter(Boolean).join(' — ');
                    return `
                      <div class="usospp-tt-entry" style="top:${top}px;height:${height}px;" title="${esc(full)}">
                        <div class="usospp-tt-entry-time">${esc(e.start)}–${esc(e.end)}</div>
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
      const stages = this.stageSubjects;
      const stageRanks = stages.map((s) => cycleRank(stageCycleLabel(s)));
      const knownRanks = stageRanks.filter((r) => r !== null);
      const earliestRank = knownRanks.length ? Math.min(...knownRanks) : null;
      // Only the stage(s) on the earliest (currently-running) cycle count as
      // "your assigned semester" — a stage on a later cycle is a future
      // semester USOS already lets you browse, kept out of the candidate
      // list so it doesn't look like a random, unexplained subject. A stage
      // whose cycle we couldn't parse is kept rather than dropped, so an
      // unexpected label never silently hides real subjects.
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
      const bySubject = this.plannerPicksBySubject;

      return `
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
            ${skippedStages > 0 ? `<div class="usospp-tag-muted" style="display:block;margin-bottom:10px;">Pominięto ${skippedStages} etap(y) programu z późniejszego cyklu (np. kolejny semestr) — pokazujemy tylko przedmioty z bieżącego cyklu.</div>` : ''}
            ${allSubjects.length === 0 ? `
              <div class="usospp-empty-hint">Nie znaleźliśmy listy przedmiotów Twojego kierunku — sprawdź zakładkę „Przedmioty”.</div>
            ` : allSubjects.map((s) => this.renderPlannerSubjectRow(s)).join('')}
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
      return `
        <div style="padding:2px 0 12px 0;">
          <div style="font-size:11.5px;color:var(--ink-3);margin-bottom:10px;">${esc(cycle.cycleName)}${cycle.period ? ` · ${esc(cycle.period)}` : ''}</div>
          ${cycle.classTypes.map((ct) => this.renderPlannerClassType(url, cycle.cycleName, ct)).join('')}
          <button class="usospp-btn-primary" style="margin-top:6px;" data-action="plannerAddSubject" data-url="${esc(url)}" data-subject-name="${esc(details.subjectName)}" data-cycle-name="${esc(cycle.cycleName)}">
            Dodaj do planu
          </button>
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
      return `
        <div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <div style="font-size:12.5px;font-weight:600;">${esc(ct.label)}</div>
            ${selection && !pendingRemoval ? `<span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:11px;">grupa ${esc(selection.nr)}</span>` : ''}
          </div>
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
      const schedule = (g.sessions || []).map((sess) => `${esc(shortDay(sess.day))} ${esc(sess.start)}–${esc(sess.end)}${sess.place ? `, ${esc(shortPlace(sess.place))}` : ''}`).join(' · ') || 'brak danych o terminie';
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
                <div style="font-size:11.5px;color:var(--ink-3);margin-top:1px;">${(p.sessions || []).map((sess) => `${esc(shortDay(sess.day))} ${esc(sess.start)}–${esc(sess.end)}`).join(' · ') || 'brak danych o terminie'}${p.teacher ? ' · ' + esc(p.teacher) : ''}</div>
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
            day: s.day, start: s.start, end: s.end, place: s.place,
            subjectName: p.subjectName, classTypeShort: p.classTypeShort, teacher: p.teacher,
            seed: this.plannerColorSeed(p.subjectName), pickKey: `${p.key}::${i}`, draft: false, pendingRemoval,
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
              day: s.day, start: s.start, end: s.end, place: s.place,
              subjectName, classTypeShort: shortClassType(g.classTypeLabel), teacher: g.teacher,
              seed: this.plannerColorSeed(subjectName), pickKey: `${key}::draft::${i}`, draft: true,
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
            if (toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end)) {
              conflicts.add(a.pickKey);
              conflicts.add(b.pickKey);
            }
          }
        }
      });

      const dayGroups = DAY_KEYS.map((dk) => ({ day: dk, entries: byDay[dk] || [] })).filter((d) => d.entries.length);

      return `
        ${conflicts.size ? `<div style="font-size:12px;font-weight:600;color:oklch(55% 0.19 25);margin-bottom:10px;">⚠ Wybrane zajęcia nakładają się w czasie — zaznaczone poniżej.</div>` : ''}
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
                    const conflict = conflicts.has(e.pickKey);
                    const removeColor = 'oklch(55% 0.19 25)';
                    const full = [e.subjectName, e.teacher, e.place].filter(Boolean).join(' — ')
                      + (e.draft ? ' (jeszcze niedodane)' : e.pendingRemoval ? ' (zostanie usunięte po zapisaniu)' : '');
                    const entryStyle = e.draft
                      ? `background:transparent;border:2px dashed ${color.time};opacity:0.85;`
                      : e.pendingRemoval
                        ? `background:transparent;border:2px dashed ${removeColor};opacity:0.55;`
                        : `background:${color.bg};`;
                    const labelStyle = `color:${e.pendingRemoval ? removeColor : color.label};${e.pendingRemoval ? 'text-decoration:line-through;' : ''}`;
                    return `
                      <div class="usospp-tt-entry${conflict ? ' usospp-tt-entry--conflict' : ''}" style="top:${top}px;height:${height}px;${entryStyle}" title="${esc(full)}">
                        <div class="usospp-tt-entry-time" style="color:${e.pendingRemoval ? removeColor : color.time};">${esc(e.start)}–${esc(e.end)}</div>
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
          label: 'Wymagają włączonego USOS++',
          keys: {
            keyboardNav: ['Nawigacja klawiaturą', 'Skróty 1–9 do przełączania sekcji w USOS++'],
            autorefresh: ['Automatyczne odświeżanie danych', 'Dane odświeżają się bez przeładowania strony'],
            gradeBadge: ['Odznaka średniej na ikonie', 'Aktualizuje się, gdy USOS++ jest włączony'],
          },
        },
        {
          label: 'Działają niezależnie od USOS++',
          keys: {
            quickbar: ['Szybkie akcje w toolbarze', 'Widoczne w klasycznym USOS, gdy USOS++ jest wyłączony'],
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

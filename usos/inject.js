// Entry point for the USOSweb content script. Decides whether to hand the
// page over to the USOS++ redesign, keeps it in sync with popup toggles, and
// wires the small always-available features that work without the full
// redesign (quick-access bar, keyboard shortcuts, background grade check).
(function () {
  const { getState, onStateChange } = window.USOSPP_STATE;
  const { selectAdapter } = window.USOSPP_ADAPTERS;
  const { collectAll } = window.USOSPP_SCRAPE;

  let app = null;
  let container = null;
  let quickbarEl = null;
  let autorefreshTimer = null;
  let currentSettings = null;
  let cachedLogoutUrl = null;

  // Sticky per-tab "stay native" flag. ?usospp_off=1 used to bypass only the
  // single page load carrying it — clicking anywhere onward (or reloading)
  // dropped the param and the redesign remounted on top of the classic page
  // mid-task. Now the param plants a sessionStorage flag instead: the whole
  // tab stays classic across navigations, reloads and POST round-trips until
  // the quickbar toggle clears it. sessionStorage (not localStorage, not a
  // global setting) gives exactly that lifetime: per tab, dies with the tab,
  // never leaks into other tabs. Private-mode failures degrade to the old
  // one-shot param behavior.
  const NATIVE_TAB_KEY = 'usospp:nativeTab';
  function readNativeTabFlag() {
    try { return sessionStorage.getItem(NATIVE_TAB_KEY) === '1'; } catch (e) { return false; }
  }
  function writeNativeTabFlag(on) {
    try {
      if (on) sessionStorage.setItem(NATIVE_TAB_KEY, '1');
      else sessionStorage.removeItem(NATIVE_TAB_KEY);
    } catch (e) { /* private mode etc. */ }
  }
  function isBypassed() {
    return new URLSearchParams(location.search).has('usospp_off') || readNativeTabFlag();
  }

  function findHostRoot() {
    return document.querySelector('usos-layout');
  }

  function hideNative() {
    const host = findHostRoot();
    if (host) host.classList.add('usospp-host-hidden');
    const scroller = document.querySelector('top-scroller');
    if (scroller) scroller.classList.add('usospp-host-hidden');
  }

  function showNative() {
    const host = findHostRoot();
    if (host) host.classList.remove('usospp-host-hidden');
    const scroller = document.querySelector('top-scroller');
    if (scroller) scroller.classList.remove('usospp-host-hidden');
  }

  function captureLogoutUrl() {
    const cas = document.querySelector('cas-bar');
    cachedLogoutUrl = cas ? cas.getAttribute('logout-url') : null;
  }

  // cas-bar is part of USOSweb's shared page shell, so it (and usos-layout/
  // usos-frame, which looksLikeUsos checks) is present even on the "musisz
  // się zalogować" page — mode="anon" is what actually distinguishes a
  // logged-out load from a real one. Without this check mountRedesign()
  // would fetch a dozen pages that are all just this same login prompt and
  // render the full dashboard shell with everything silently empty, with no
  // hint that logging in (not disabling USOS++) is what's needed.
  function isLoggedOut() {
    const cas = document.querySelector('cas-bar');
    return !!cas && cas.getAttribute('mode') === 'anon';
  }

  // USOSweb's technical-break dispatch ("USOSweb tymczasowo niedostępny"),
  // served on EVERY path with HTTP 503 during maintenance windows like a
  // data sync (verified live at usosweb.pb.edu.pl mid-sync: root, news and
  // the JSON search endpoints all returned the same dispatch; the normal
  // shell — re-verified right after the sync ended — never shows this
  // heading, so no false positives). The dispatch is a full USOS shell
  // with cas-bar mode="anon", so it must be checked BEFORE isLoggedOut():
  // otherwise a maintenance load would mount the all-empty anonymous
  // design right over the university's own explanation. UNVERIFIED for
  // non-Polish USOSweb deployments, where the heading is presumably
  // translated — those fall through to collectAnon, whose run then comes
  // back 100% 503s and flags data.maintenance instead.
  function isMaintenancePage() {
    const h1 = document.querySelector('h1');
    return !!h1 && h1.textContent.trim() === 'USOSweb tymczasowo niedostępny';
  }

  // The dispatch page's "Szczegóły" frame carries the current reason (e.g.
  // "Trwa synchronizacja danych" — verified live; other reasons exist, so
  // the text is read out, not matched). null off the dispatch page.
  function getMaintenanceReason() {
    const el = document.querySelector('usos-frame .stretch');
    return el ? el.textContent.trim() : null;
  }

  function ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.id = 'usospp-container';
    document.body.appendChild(container);
    container.addEventListener('usospp:settings', onAppSettingsEvent);
    return container;
  }

  async function onAppSettingsEvent(e) {
    const { darkMode, toggleFeature, rescrape, disable } = e.detail || {};
    if (disable) {
      // Global (cross-tab) setting — storage.onChanged in every matching
      // tab's inject.js picks this up and unmounts back to classic USOS.
      await window.USOSPP_STATE.setState({ enabled: false });
      return;
    }
    if (darkMode !== undefined) {
      const next = await window.USOSPP_STATE.setState({ darkMode });
      currentSettings = next;
      if (app) app.updateSettings({ darkMode: next.darkMode, features: next.features });
    }
    if (toggleFeature) {
      const next = await window.USOSPP_STATE.setState((s) => ({
        features: { ...s.features, [toggleFeature]: !s.features[toggleFeature] },
      }));
      currentSettings = next;
      if (app) app.updateSettings({ darkMode: next.darkMode, features: next.features });
      applyIndependentFeatures(next);
      // Reflect a gradeBadge toggle immediately rather than waiting for the
      // next mount/refresh — maybeUpdateBadge() itself clears the icon text
      // when the feature is now off.
      if (toggleFeature === 'gradeBadge' && app) maybeUpdateBadge(app.data);
    }
    if (rescrape) refreshData();
  }

  async function refreshData() {
    const adapter = selectAdapter();
    if (!adapter || !app) return;
    if (isLoggedOut()) {
      // Session expired while the redesign was already open (autorefresh,
      // or an explicit rescrape) — drop back to the login prompt instead of
      // re-rendering the dashboard with everything now empty.
      unmountRedesign();
      await mountRedesign();
      return;
    }
    const data = await collectAll(adapter);
    if (data.maintenance) {
      // The site went down while the redesign was already open (autorefresh
      // tick or an explicit rescrape): every fetched page was the 503
      // dispatch, so the model would render an all-empty dashboard. Swap
      // the whole panel for the plain notice instead.
      unmountRedesign();
      mountMaintenanceNotice();
      return;
    }
    // Lazy results ride outside collectAll — the participants roster in
    // particular. Without this carry-over, every autorefresh tick wipes a
    // loaded roster from under open plan modals: session details fall back
    // to "…", and an open group list sticks on "Pobieranie listy…" with no
    // trigger left to fetch it.
    if (app.data && app.data.participantsResultLoaded && !data.participantsResultLoaded) {
      data.participantsResult = app.data.participantsResult;
      data.participantsResultLoaded = true;
    }
    // Same ride for group details (room/teacher/meetings behind the
    // Dynamiczny plan): collectAll doesn't fetch them, so without this
    // every autorefresh tick empties the concrete plan until the next
    // plan-view entry re-triggers the lazy fetch.
    if (app.data && app.data.groupDetails && !data.groupDetails) {
      data.groupDetails = app.data.groupDetails;
    }
    app.data = data;
    app.render();
    app.checkNewsUpdate();
    maybeUpdateBadge(data);
    // Race cover: the tick landed mid-fetch (the promise mutated the
    // already-replaced object) or the roster never loaded at all — an open
    // plan modal would sit on its loading state forever, so re-kick the
    // shared lazy trigger (no-op when loaded or already in flight).
    if ((app.state.planGroupList || app.state.planSessionModal) && !data.participantsResultLoaded
      && typeof app.ensureParticipantsResult === 'function') {
      app.ensureParticipantsResult(() => app.setModalState({}));
    }
  }

  function clearBadge() {
    chrome.runtime.sendMessage({ type: 'usospp:setBadge', text: '' }).catch(() => {});
  }

  // Strict grade check shared with app.js: only a whole cell exactly
  // equal to a Polish final grade (2.0–5.5) counts — subject codes and
  // dates must never become phantom grades.
  function strictGrade(raw) {
    if (raw === null || raw === undefined) return null;
    const t = String(raw).trim().replace(/\s+/g, '');
    if (!/^(2(?:[.,]0)?|3(?:[.,]0|[.,]5)?|4(?:[.,]0|[.,]5)?|5(?:[.,]0|[.,]5)?)$/.test(t)) return null;
    return t.replace(',', '.').replace(/^([2-5])$/, '$1.0');
  }

  function gradesFromRows(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map((row) => {
        if (row && typeof row === 'object' && !Array.isArray(row)) {
          return row.grade ? strictGrade(row.grade) : null;
        }
        const cells = Array.isArray(row) ? row : [row.text];
        for (let i = cells.length - 1; i >= 0; i--) {
          const g = strictGrade(cells[i]);
          if (g) return g;
        }
        return null;
      })
      .filter(Boolean);
  }

  function maybeUpdateBadge(data) {
    if (!currentSettings || !currentSettings.features.gradeBadge) {
      clearBadge();
      return;
    }
    const grades = Array.isArray(data.gradesResult && data.gradesResult.rows) ? data.gradesResult.rows : [];
    const nums = gradesFromRows(grades);
    const text = nums.length ? (nums.reduce((a, b) => a + parseFloat(b), 0) / nums.length).toFixed(1) : '';
    chrome.runtime.sendMessage({ type: 'usospp:setBadge', text }).catch(() => {});
  }

  async function mountRedesign() {
    captureLogoutUrl();
    const adapter = selectAdapter();
    if (!adapter) {
      hideNative();
      const el = ensureContainer();
      el.innerHTML = `
        <div style="max-width:520px;margin:80px auto;padding:24px;font-family:system-ui,sans-serif;">
          <h2 style="margin:0 0 8px 0;">USOS++ nie rozpoznaje tej strony</h2>
          <p style="color:#666;line-height:1.5;">Nie udało się wykryć obsługiwanej wersji USOSweb na tej stronie. Wyłącz USOS++ w popupie rozszerzenia, aby wrócić do klasycznego widoku.</p>
        </div>
      `;
      return;
    }
    if (isMaintenancePage()) {
      mountMaintenanceNotice(getMaintenanceReason());
      return;
    }
    hideNative();
    const el = ensureContainer();
    if (isLoggedOut()) {
      // Still mount the real app shell (sidebar/topbar stay usable, nav
      // still highlights whatever's clicked). USOSweb serves several pages
      // to anonymous visitors too — Aktualności, the whole katalog2/search
      // family (wyszukiwarka, subject/unit/program pages) and the campus
      // buildings — so those views keep working logged out, and only each
      // personal view's content pane is replaced by App#renderLoggedOut
      // (see app.js's PUBLIC_VIEWS). collectAnon fetches the one public
      // page the shell itself renders from at mount; the rest of the public
      // family fetches lazily per view. No point fetching the personal
      // pages — they are all just this same login prompt right now.
      const cas = document.querySelector('cas-bar');
      const data = await window.USOSPP_SCRAPE.collectAnon(adapter);
      if (data.maintenance) {
        // A non-Polish dispatch page this shell didn't recognize by its
        // heading, or the site went down between page load and mount —
        // every fetch came back 503. Nothing public works either.
        mountMaintenanceNotice();
        return;
      }
      data.loggedOut = true;
      data.loginUrl = cas ? cas.getAttribute('login-url') : null;
      app = window.USOSPP_APP.mount(el, data, { darkMode: currentSettings.darkMode, features: currentSettings.features });
      maybeUpdateBadge(data);
      return;
    }
    const data = await collectAll(adapter);
    if (data.maintenance) {
      mountMaintenanceNotice();
      return;
    }
    app = window.USOSPP_APP.mount(el, data, { darkMode: currentSettings.darkMode, features: currentSettings.features });
    maybeUpdateBadge(data);
  }

  function unmountRedesign() {
    clearBadge();
    if (app) {
      app.destroy();
      app = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    showNative();
    syncCanvasTheme();
  }

  // Overscroll rubber-banding + scrollbar paint from <html>, outside the
  // .usospp-root theme scope — without this, dark mode bounces into white.
  // Set only while the redesign is mounted (classic USOS pages are light; a
  // leaked dark canvas would be wrong there); the matching
  // html[data-usospp-theme] rules live in core/ui/design-system.css.
  function syncCanvasTheme() {
    try {
      if (app) document.documentElement.dataset.usosppTheme = currentSettings && currentSettings.darkMode ? 'dark' : 'light';
      else delete document.documentElement.dataset.usosppTheme;
    } catch (e) { /* canvas theming is cosmetic — never break mount/unmount */ }
  }

  // Replaces the whole redesign with one card when USOSweb itself is down
  // — mounting the app shell there would only render a stack of empty
  // panes (sidebar, topbar, "brak danych" everywhere). Shows the
  // university's own reason line when we're on the dispatch page, a
  // reload button that re-checks after the break ends, and an escape hatch
  // to the classic dispatch page. Reached two ways: a fresh load landing
  // on the dispatch (isMaintenancePage in mountRedesign), or a refresh/
  // autorefresh collect that came back 100% 503s (data.maintenance) — the
  // mid-session case, where the live DOM is a healthy stale page and only
  // the fetches reveal the outage.
  function mountMaintenanceNotice(reason) {
    const dark = !!(currentSettings && currentSettings.darkMode);
    hideNative();
    const el = ensureContainer();
    el.innerHTML = '';
    const card = document.createElement('div');
    card.style.cssText = [
      'max-width:520px;margin:80px auto;padding:28px;font-family:system-ui,sans-serif;text-align:left;',
      `border:1px solid ${dark ? '#3a332a' : '#e5e0d8'};border-radius:16px;`,
      `background:${dark ? '#211c17' : '#fdfcf9'};color:${dark ? '#efe9df' : '#2b2118'};`,
    ].join('');
    const h2 = document.createElement('h2');
    h2.textContent = 'USOSweb tymczasowo niedostępny';
    h2.style.cssText = 'margin:0 0 10px 0;font-size:1.3rem;';
    card.appendChild(h2);
    const reasonP = document.createElement('p');
    reasonP.textContent = reason || 'Przepraszamy. USOSweb jest chwilowo niedostępny.';
    reasonP.style.cssText = 'font-size:1.05rem;margin:0 0 10px 0;';
    card.appendChild(reasonP);
    const expl = document.createElement('p');
    expl.textContent = 'To nie jest błąd USOS++ — serwer uczelni odsyła tę stronę na każde zapytanie. Po zakończeniu przerwy wróci normalny widok.';
    expl.style.cssText = 'opacity:0.75;line-height:1.5;margin:0 0 20px 0;';
    card.appendChild(expl);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;';
    const retry = document.createElement('button');
    retry.textContent = 'Spróbuj ponownie';
    retry.style.cssText = 'padding:10px 18px;border:0;border-radius:10px;background:#241c14;color:#fff;font-weight:600;font-size:14px;cursor:pointer;';
    retry.addEventListener('click', () => location.reload());
    actions.appendChild(retry);
    const classicUrl = new URL(location.href);
    classicUrl.searchParams.set('usospp_off', '1');
    const classic = document.createElement('a');
    classic.href = classicUrl.toString();
    classic.textContent = 'Klasyczny USOSweb →';
    classic.style.cssText = 'color:inherit;opacity:0.8;font-size:14px;text-decoration:none;';
    actions.appendChild(classic);
    card.appendChild(actions);
    el.appendChild(card);
  }

  // ---- independent small features (work with or without the full redesign) ----

  function ensureQuickbar() {
    if (quickbarEl) return;
    quickbarEl = document.createElement('div');
    quickbarEl.id = 'usospp-quickbar';
    quickbarEl.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:99999;display:flex;gap:6px;background:#241c14;border-radius:14px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,0.25);font-family:system-ui,sans-serif;align-items:center;';

    // Toggle button to enable USOS++ redesign (also the return path from a
    // sticky native tab — clears the per-tab flag first, otherwise this tab
    // would keep bypassing despite the global setting).
    const toggle = document.createElement('div');
    toggle.title = 'Włącz panel USOS++';
    toggle.style.cssText = 'width:24px;height:24px;border-radius:12px;background:#d9773a;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.1s,background 0.15s;flex-shrink:0;margin-left:4px;margin-right:8px;';
    toggle.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v6"></path><path d="M5.5 5.8a6.5 6.5 0 1 0 9 0"></path></svg>';
    toggle.addEventListener('mouseenter', () => { toggle.style.background = 'oklch(52% 0.15 45)'; });
    toggle.addEventListener('mouseleave', () => { toggle.style.background = '#d9773a'; });
    toggle.addEventListener('mousedown', () => { toggle.style.transform = 'scale(0.9)'; });
    toggle.addEventListener('mouseup', () => { toggle.style.transform = 'scale(1)'; });
    toggle.addEventListener('click', async () => {
      writeNativeTabFlag(false);
      const next = await window.USOSPP_STATE.setState({ enabled: true });
      currentSettings = next;
      // Apply directly instead of waiting for the storage-event round-trip
      // (which this same tab may never see) — applyState is idempotent.
      await applyState(next);
    });
    quickbarEl.appendChild(toggle);

    const links = [
      ['Plan', 'home/plan'],
      ['Oceny', 'dla_stud/studia/oceny/index'],
      ['Egzaminy', 'dla_stud/rejestracja/egzaminy'],
      ['ECTS', 'dla_stud/studia/zaliczenia/index'],
    ];
    links.forEach(([label, action]) => {
      const a = document.createElement('a');
      a.textContent = label;
      a.href = `${location.origin}/kontroler.php?_action=${action}`;
      a.style.cssText = 'color:#fff;font-size:12px;font-weight:600;padding:8px 12px;border-radius:9px;text-decoration:none;';
      a.addEventListener('mouseenter', () => { a.style.background = 'rgba(255,255,255,0.12)'; });
      a.addEventListener('mouseleave', () => { a.style.background = 'transparent'; });
      quickbarEl.appendChild(a);
    });
    document.body.appendChild(quickbarEl);
  }

  function removeQuickbar() {
    if (quickbarEl) {
      quickbarEl.remove();
      quickbarEl = null;
    }
  }

  // ---- classic-page widgets: small native-styled hints injected straight
  // into classic USOSweb pages (Oceny/Plan/Mój USOSweb) when the
  // full redesign is off. Same "independent" spirit as the quickbar above,
  // just page-specific — each function reads whatever the current page
  // already renders (via the adapter's `doc = document` default) instead of
  // fetching anything, except the home summary, which needs two other pages'
  // data and is the only one that fetches.

  let classicWidgetEl = null;
  let homeSummaryPending = false;

  function removeClassicWidgets() {
    removeHomeLayout();
    try { if (planTimetableObserver) planTimetableObserver.disconnect(); } catch (e) { /* ignore */ }
    planTimetableObserver = null;
    if (classicWidgetEl) {
      classicWidgetEl.remove();
      classicWidgetEl = null;
    }
  }

  function widgetTag() {
    const tag = document.createElement('span');
    tag.className = 'usospp-classic-widget-tag';
    tag.textContent = 'USOS++';
    return tag;
  }

  function averageFromGradeRows(rows) {
    const nums = gradesFromRows(rows);
    return nums.length ? { avg: (nums.reduce((a, b) => a + parseFloat(b), 0) / nums.length).toFixed(2), count: nums.length } : null;
  }

  function countUnpaidRows(paymentGroups) {
    return (paymentGroups.groups || []).reduce((n, g) => n + (g.rows ? g.rows.length : 0), 0);
  }

  // UNVERIFIED: same caveat as adapter.getGrades — only the empty state has
  // ever been observed live, so the populated-row path renders once real rows
  // show up; the empty path below renders unconditionally so an empty account
  // still sees proof the widget is alive instead of silence.
  function injectOcenyWidget() {
    const adapter = selectAdapter();
    const frame = document.querySelector('usos-frame#oceny, usos-frame.oceny');
    if (!adapter || !frame) {
      logClassicSkip('oceny', !adapter ? 'no adapter' : 'no anchor');
      return;
    }
    const avg = averageFromGradeRows(adapter.getGrades().rows);
    const el = document.createElement('div');
    if (avg) {
      el.className = 'usospp-classic-widget usospp-classic-widget--info';
      const strong = document.createElement('strong');
      strong.textContent = avg.avg;
      const desc = document.createElement('span');
      desc.textContent = `średnia z ${avg.count} widocznych ocen`;
      el.append(strong, desc, widgetTag());
    } else {
      el.className = 'usospp-classic-widget usospp-classic-widget--info usospp-classic-widget--empty';
      el.dataset.empty = 'true';
      const desc = document.createElement('span');
      desc.textContent = 'Brak ocen końcowych — średnia niepoliczona';
      el.append(desc, widgetTag());
    }
    frame.before(el);
    classicWidgetEl = el;
    logClassicInjected('oceny', avg ? 'with-avg' : 'empty');
  }

  // Classic plan page (home/plan): a mini "Ten tydzień" for the week USOS
  // actually rendered — the same aggregate the panel's left box shows
  // (count + hours, busiest day, free days, per-type breakdown), computed
  // from the rendered weekly timetable, in any format: the new UI's live
  // <usos-timetable> (see colsFromNewUi inline in render) or the old html
  // grid table (see colsFromOldPlanTable). The old approach (getMyGroups
  // on this page's DOM + the static register() literal) could never work
  // here: the groups frame lives on home/grupy, and on week views register()
  // carries params instead of events (see getPlan's comment) — so it always
  // showed a false "Brak zajęć". Counting rendered <timetable-entry> nodes
  // needs no fetches and follows USOS's own week logic (selected week,
  // holidays, cancelled classes) including the week selector: entries are
  // re-rendered client-side, so one persistent observer keeps the summary in
  // sync as the user flips weeks.
  const PLAN_DAY_ORDER = { PN: 0, WT: 1, 'ŚR': 2, CZ: 3, PT: 4, SO: 5, ND: 6 };
  function planDayKey(name) {
    // Same normalization as adapters.js's stripPl: NFD alone is NOT enough
    // because Ł/ł have no decomposition ("Poniedziałek" would never match).
    const norm = (name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
    if (norm.startsWith('poniedzial')) return 'PN';
    if (norm.startsWith('wtorek') || norm.startsWith('wtorku')) return 'WT';
    if (norm.startsWith('srod')) return 'ŚR';
    if (norm.startsWith('czwartek')) return 'CZ';
    if (norm.startsWith('piatek') || norm.startsWith('piatku')) return 'PT';
    if (norm.startsWith('sobot')) return 'SO';
    if (norm.startsWith('niedziel')) return 'ND';
    return null;
  }
  function planToMin(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  function planFmtDur(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h && m) return `${h} h ${m} min`;
    if (h) return `${h} h`;
    return `${m} min`;
  }
  function planZajeciaWord(n) {
    if (n === 1) return '1 zajęcie';
    if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return `${n} zajęcia`;
    return `${n} zajęć`;
  }
  // "05.10.2026 – 11.10.2026" for the displayed week. Primary source is the
  // page's own h1 ("Mój plan zajęć (2026-10-05 - 2026-10-11)") — present in
  // every weekly format, old and new. Falls back to the plan_week_sel_week
  // URL param, then to the current week's Monday.
  function planWeekLabel() {
    const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    const fmtIso = (y, m, d) => `${d}.${m}.${y}`;
    try {
      const h1 = document.querySelector('h1');
      const hm = h1 && /\((\d{4})-(\d{2})-(\d{2})\s*-\s*(\d{4})-(\d{2})-(\d{2})\)/.exec(h1.textContent || '');
      if (hm) return `${fmtIso(hm[1], hm[2], hm[3])} – ${fmtIso(hm[4], hm[5], hm[6])}`;
    } catch (e) { /* fall through */ }
    let monday = null;
    try {
      const param = new URLSearchParams(location.search).get('plan_week_sel_week');
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(param || '');
      if (m) monday = new Date(+m[1], +m[2] - 1, +m[3]);
    } catch (e) { monday = null; }
    if (!monday || Number.isNaN(monday.getTime())) {
      const now = new Date();
      const dow = (now.getDay() + 6) % 7; // Monday = 0
      monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    }
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return `${fmt(monday)} – ${fmt(sunday)}`;
  }
  // Semester view ("Okres planu zajęć: semestralny") overlays the whole
  // semester's template — there is no single week to summarize, so the
  // widget stays out. Detected via the timebase radio (works for full page
  // loads and client-side switches alike) or the plan_division URL param.
  function isPlanSemesterView() {
    try {
      const radio = document.querySelector('#timebase_sem');
      if (radio && radio.checked) return true;
      if (new URLSearchParams(location.search).get('plan_division') === 'semester') return true;
    } catch (e) { /* fall through */ }
    return false;
  }
  // Short class-type codes used by the old HTML table format ("13:15, W"),
  // mapped to the full names the new timetable (and the panel) uses.
  // Unknown codes pass through untouched rather than becoming "inne".
  const PLAN_TYPE_SHORT = {
    W: 'Wykład', 'Ć': 'Ćwiczenia', C: 'Ćwiczenia', L: 'Zajęcia laboratoryjne',
    S: 'Seminarium', K: 'Konwersatorium', P: 'Projekt',
    E: 'Egzamin', WF: 'Wychowanie fizyczne',
  };
  // Weekly grid of the OLD html table format: header row with day names +
  // hour gutter + entry cells (td[onclick*=pokazZajecia], rowspan-sized).
  // Days are NOT raw cell indexes: day widths come from the HEADER row's
  // colspans (verified live: a calm week renders PN–CZ single-width with a
  // double-width Friday, a busy week renders every day double-width so
  // overlapping classes can sit side by side; entries always colspan=1).
  // Days are therefore assigned via an occupancy model over the
  // header-derived sub-columns, not by counting cells. Returns
  // [{key, entries:[{start, end, label}]}] like the new-ui path, or null
  // when no weekly grid table is present (other formats / not rendered yet).
  function colsFromOldPlanTable(wrapper) {
    const tables = [...wrapper.querySelectorAll('table')];
    const grid = tables.find((t) => {
      const first = t.rows && t.rows[0];
      return first && [...first.cells].some((c) => planDayKey((c.textContent || '').trim()));
    });
    if (!grid || !grid.rows.length) return null;
    // Skip the corner cell; each header cell's colspan is its day's width
    // (missing/empty colspan = 1).
    const dayWidths = [...grid.rows[0].cells]
      .slice(1)
      .map((c) => ({ key: planDayKey((c.textContent || '').trim()), w: Math.max(1, parseInt(c.getAttribute('colspan') || '1', 10) || 1) }))
      .filter((d) => d.key);
    if (!dayWidths.length) return null;
    const subDay = [];
    dayWidths.forEach((d, di) => {
      for (let k = 0; k < d.w; k++) subDay.push(di);
    });
    const dayCols = dayWidths.map((d) => d.key);
    const busySub = new Array(subDay.length).fill(0);
    const cols = dayCols.map((key) => ({ key, entries: [] }));
    for (let i = 1; i < grid.rows.length; i++) {
      const cells = [...grid.rows[i].cells];
      cells.forEach((cell) => {
        const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();
        // Hour gutter ("7:00") — not a day column. Entry cells carry the
        // group link in onclick and a "13:15, W" note, never a bare hour.
        if (!cell.hasAttribute('onclick') && /^\d{1,2}:\d{2}$/.test(text)) return;
        const rs = parseInt(cell.getAttribute('rowspan') || '1', 10) || 1;
        const cs = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
        // First run of cs free sub-columns; degrade to a narrower run
        // rather than dropping the cell entirely.
        let sub = -1;
        for (let want = cs; want >= 1 && sub === -1; want--) {
          for (let s = 0; s + want <= busySub.length; s++) {
            let free = true;
            for (let k = 0; k < want; k++) {
              if (busySub[s + k] > i) { free = false; break; }
            }
            if (free) { sub = s; break; }
          }
        }
        if (sub === -1) return; // fully covered row — ignore
        for (let k = 0; k < cs && sub + k < busySub.length; k++) busySub[sub + k] = i + rs;
        const col = subDay[sub];
        if (col == null || col >= dayCols.length) return;
        const onclick = cell.getAttribute('onclick') || '';
        if (!/pokazZajecia/.test(onclick)) return; // empty filler cell
        const noteEl = cell.querySelector('span.note');
        const nm = noteEl && /^(\d{1,2}):(\d{2}),\s*(.+)$/.exec((noteEl.textContent || '').replace(/\s+/g, ' ').trim());
        if (!nm) return;
        const start = `${nm[1].padStart(2, '0')}:${nm[2]}`;
        const code = nm[3].trim();
        // Grid rows are 5 minutes each (hour gutter cells use rowspan=12).
        const dur = rs * 5;
        const endMin = planToMin(start) + dur;
        const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
        cols[col].entries.push({ start, end, label: PLAN_TYPE_SHORT[code] || code || 'inne' });
      });
    }
    return cols;
  }
  let planTimetableObserver = null;
  function injectPlanWidget() {
    const adapter = selectAdapter();
    const wrapper = document.querySelector('.timetable-wrapper');
    if (!adapter || !wrapper || typeof adapter.getSubjectTimetable !== 'function') {
      logClassicSkip('plan', !adapter ? 'no adapter' : 'no anchor');
      return;
    }
    try { if (planTimetableObserver) planTimetableObserver.disconnect(); } catch (e) { /* ignore */ }
    planTimetableObserver = null;
    const render = () => {
      // Semester view has no single week — the widget must not show there.
      // Handled first so a week→semester switch removes an existing widget.
      if (isPlanSemesterView()) {
        if (classicWidgetEl) {
          try { classicWidgetEl.remove(); } catch (e) { /* ignore */ }
          classicWidgetEl = null;
          logClassicSkip('plan', 'semester view has no single week');
        }
        return;
      }
      // Weekly views, any format: new-ui renders <usos-timetable> (entries
      // arrive via XHR), the old html format renders a server-side grid
      // table. Day columns are the readiness signal in both: USOS renders
      // them even for an empty week, so columns + zero entries = genuinely
      // free, while no columns at all = not rendered yet.
      let cols = null;
      const ttEl = wrapper.querySelector('usos-timetable');
      if (ttEl && ttEl.querySelector('timetable-day')) {
        let byLabel = {};
        try {
          const tt = adapter.getSubjectTimetable();
          if (tt && tt.supported) {
            (tt.days || []).forEach((d) => {
              byLabel[(d.day || '').trim()] = d.entries || [];
            });
          }
        } catch (e) { byLabel = {}; }
        cols = [...ttEl.children]
          .filter((c) => c.querySelector && c.querySelector('timetable-day'))
          .map((c) => {
            const lblEl = c.querySelector('div > div');
            const label = lblEl && lblEl.textContent ? lblEl.textContent.trim() : '';
            const entries = byLabel[label] || [];
            // Fallback when the parser didn't claim the day (e.g. label
            // drift): count raw entries so the number never under-reports.
            const raw = entries.length ? entries : [...c.querySelectorAll('timetable-entry')].map(() => ({}));
            return { key: planDayKey(label), entries: raw };
          })
          .filter((c) => c.key)
          .sort((a, b) => PLAN_DAY_ORDER[a.key] - PLAN_DAY_ORDER[b.key]);
      } else {
        cols = colsFromOldPlanTable(wrapper);
      }
      // null = not rendered yet (or image format, which has no parseable
      // timetable at all) — keep waiting for the observer/timeout path.
      if (!cols || !cols.length) return;
      if (classicWidgetEl && classicWidgetEl.parentNode !== wrapper) return; // navigated away
      let count = 0;
      let minutes = 0;
      const byDayMin = {};
      const byDayCount = {};
      const byType = {};
      cols.forEach((col) => {
        (col.entries || []).forEach((e) => {
          count += 1;
          byDayCount[col.key] = (byDayCount[col.key] || 0) + 1;
          const s = planToMin(e.start);
          const en = planToMin(e.end);
          if (s !== null && en !== null && en > s) {
            minutes += en - s;
            byDayMin[col.key] = (byDayMin[col.key] || 0) + (en - s);
          }
          const t = ((e.label || '').split(',')[0] || '').trim() || 'inne';
          byType[t] = (byType[t] || 0) + 1;
        });
      });
      let el = classicWidgetEl;
      if (!el) {
        el = document.createElement('div');
        wrapper.prepend(el);
        classicWidgetEl = el;
      }
      el.innerHTML = '';
      delete el.dataset.empty;
      if (!count) {
        // Zero entries with rendered day columns = a genuinely empty week
        // (holiday break etc.), not a read failure.
        el.className = 'usospp-classic-widget usospp-classic-widget--info usospp-classic-widget--empty';
        el.dataset.empty = 'true';
        const desc = document.createElement('span');
        desc.textContent = 'Brak zajęć w tym tygodniu';
        el.append(desc, widgetTag());
        logClassicInjected('plan', 'empty-week');
        return;
      }
      let busiest = null;
      Object.keys(PLAN_DAY_ORDER).forEach((d) => {
        if (byDayMin[d] && (!busiest || byDayMin[d] > byDayMin[busiest])) busiest = d;
      });
      // Free = rendered columns with no entries. Weekend columns only exist
      // when the grid actually spans them — same spirit as the panel, which
      // hides "Wolne: SO, ND" noise when the weekend is never taught.
      const freeDays = cols.filter((c) => !(byDayCount[c.key] > 0)).map((c) => c.key);
      const types = Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t} ×${n}`)
        .join(' · ');
      el.className = 'usospp-classic-widget usospp-classic-widget--info usospp-classic-plan';
      const head = document.createElement('div');
      head.className = 'usospp-classic-plan-head';
      const strong = document.createElement('strong');
      strong.textContent = planZajeciaWord(count);
      const week = document.createElement('span');
      week.textContent = minutes > 0
        ? `· łącznie ${planFmtDur(minutes)} · ${planWeekLabel()}`
        : `· ${planWeekLabel()}`;
      head.append(strong, week, widgetTag());
      el.append(head);
      if (busiest) {
        const busy = document.createElement('div');
        busy.className = 'usospp-classic-plan-line';
        busy.append('Najbardziej zapracowany: ');
        const b = document.createElement('b');
        b.textContent = busiest;
        busy.append(b, ` (${planFmtDur(byDayMin[busiest])})`);
        el.append(busy);
      }
      const free = document.createElement('div');
      free.className = 'usospp-classic-plan-line';
      if (freeDays.length) {
        free.append('Wolne: ');
        const b = document.createElement('b');
        b.textContent = freeDays.join(', ');
        free.append(b);
      } else {
        free.textContent = 'Brak dni wolnych w tym tygodniu.';
      }
      el.append(free);
      if (types) {
        const t = document.createElement('div');
        t.className = 'usospp-classic-plan-types';
        t.textContent = types;
        el.append(t);
      }
      logClassicInjected('plan', `week-summary:${count}`);
    };
    let settled = false;
    let debounce = null;
    const schedule = () => {
      if (settled) {
        // Week-flip re-render: USOS swaps entries in bursts, debounce so we
        // count once per settled DOM.
        try { clearTimeout(debounce); } catch (e) { /* ignore */ }
        debounce = setTimeout(render, 300);
        return;
      }
      render();
      if (classicWidgetEl) {
        settled = true;
        try { clearTimeout(timer); } catch (e) { /* ignore */ }
      }
    };
    if (typeof MutationObserver !== 'undefined') {
      planTimetableObserver = new MutationObserver(schedule);
      try {
        planTimetableObserver.observe(wrapper, { childList: true, subtree: true });
      } catch (e) { planTimetableObserver = null; }
    }
    const timer = setTimeout(() => {
      // No parseable timetable after 10s (XHR failed, odd view, or the
      // image format, which carries no DOM data at all): inject nothing —
      // a fake "Brak zajęć" would be worse than silence.
      if (!settled && !classicWidgetEl) {
        logClassicSkip('plan', 'no parseable weekly timetable after 10s');
        try { if (planTimetableObserver) planTimetableObserver.disconnect(); } catch (e) { /* ignore */ }
        planTimetableObserver = null;
      }
    }, 10000);
    schedule(); // synchronous first attempt — timetable may already be there
  }

  // Cross-page card for "Mój USOSweb" (home/index) — the only classic widget
  // that needs data from other pages (średnia lives on Oceny, zaległości on
  // Płatności). Deliberately fetches just those two instead of the full
  // collectAll() the redesign uses, to keep this lightweight.
  async function injectHomeSummary() {
    if (homeSummaryPending) return;
    const table = document.querySelector('.local-home-table');
    const adapter = selectAdapter();
    if (!table || !adapter) {
      logClassicSkip('home', !adapter ? 'no adapter' : 'no anchor');
      return;
    }
    homeSummaryPending = true;
    try {
      const { fetchDoc, PATHS } = window.USOSPP_SCRAPE;
      const [ocenyDoc, platnosciDoc] = await Promise.all([
        fetchDoc(PATHS.oceny),
        fetchDoc(PATHS.platnosciNierozliczone),
      ]);
      // The toggle may have flipped, or the page navigated away, while
      // those fetches were in flight.
      if (!currentSettings || !currentSettings.features.classicWidgets || currentSettings.enabled) return;
      if (!document.body.contains(table) || classicWidgetEl) return;

      const avg = ocenyDoc ? averageFromGradeRows(adapter.getGrades(ocenyDoc).rows) : null;
      const paymentsResult = platnosciDoc ? adapter.getPaymentGroups(platnosciDoc) : { groups: [] };
      const totalRows = platnosciDoc ? countUnpaidRows(paymentsResult) : 0;
      const isEmpty = !avg && !totalRows;

      const frame = document.createElement('usos-frame');
      frame.id = 'usospp-home-summary';
      if (isEmpty) frame.dataset.empty = 'true';
      const h2 = document.createElement('h2');
      h2.setAttribute('slot', 'title');
      h2.textContent = 'USOS++ — podsumowanie';
      frame.appendChild(h2);

      const body = document.createElement('div');
      body.className = 'usospp-classic-home-summary';

      // Row 1 (oceny): always rendered — average, honest empty state, or
      // fetch-failure notice. Two rows (oceny + płatności) even when empty
      // so an empty account still sees proof the widget is alive.
      {
        const row = document.createElement('div');
        row.className = 'usospp-classic-home-row' + ((!ocenyDoc || !avg) ? ' usospp-classic-home-row--empty' : '');
        const label = document.createElement('span');
        if (avg) {
          label.append('Średnia ocen: ');
          const strong = document.createElement('strong');
          strong.textContent = avg.avg;
          label.appendChild(strong);
        } else if (!ocenyDoc) {
          label.textContent = 'Nie udało się pobrać ocen';
        } else {
          label.textContent = 'Brak ocen końcowych — średnia niepoliczona';
        }
        const link = document.createElement('a');
        link.href = `${location.origin}/kontroler.php?_action=dla_stud/studia/oceny/index`;
        link.textContent = 'oceny →';
        row.append(label, link);
        body.appendChild(row);
      }
      // Row 2 (płatności): same always-render contract as above.
      {
        const row = document.createElement('div');
        row.className = 'usospp-classic-home-row' + ((!platnosciDoc || !totalRows) ? ' usospp-classic-home-row--empty' : '');
        const label = document.createElement('span');
        if (totalRows) {
          label.textContent = paymentsResult.grandTotal || `${totalRows} nierozliczonych należności`;
        } else if (!platnosciDoc) {
          label.textContent = 'Nie udało się pobrać płatności';
        } else {
          label.textContent = 'Brak nierozliczonych należności — wszystko uregulowane';
        }
        const link = document.createElement('a');
        link.href = `${location.origin}/kontroler.php?_action=dodatki/platnosci/naleznosciNierozliczone`;
        link.textContent = 'płatności →';
        row.append(label, link);
        body.appendChild(row);
      }
      frame.appendChild(body);
      table.prepend(frame);
      classicWidgetEl = frame;
      logClassicInjected('home', isEmpty ? 'empty' : 'with-data');
    } finally {
      homeSummaryPending = false;
    }
  }

  function logClassicSkip(page, reason) {
    try { console.info(`[USOS++] classic widget skipped (${page}): ${reason}`); } catch (e) { /* never break inject over logging */ }
  }

  function logClassicInjected(page, state) {
    try { console.info(`[USOS++] classic widget injected (${page}): ${state}`); } catch (e) { /* never break inject over logging */ }
  }

  // The classic USOS shell sometimes paints its content late (client-side
  // timetable/Angular sections): a one-shot querySelector at document_idle
  // can miss an anchor that shows up a moment later. Wait briefly for it
  // instead of silently giving up — one observer per page load at most,
  // always disconnected via finish().
  function waitForClassicAnchor(selector, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const found = document.querySelector(selector);
      if (found) { resolve(found); return; }
      let done = false;
      let observer = null;
      const finish = () => {
        if (done) return;
        done = true;
        try { if (observer) observer.disconnect(); } catch (e) { /* ignore */ }
        clearTimeout(timer);
        resolve(document.querySelector(selector));
      };
      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(() => {
          if (document.querySelector(selector)) finish();
        });
        try {
          observer.observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) { observer = null; }
      }
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  // ---- home layout editor ("Mój USOSweb", home/index): rearrange cards
  // between the native columns + change order + hide cards. Part of
  // classicWidgets (no separate flag): visible only while the panel is off.
  // Native look is untouched outside edit mode — cards are only *moved*
  // between the page's own column containers, never restyled.
  const HOME_LAYOUT_KEY = 'usospp:homeLayout:' + location.origin;
  let homeToolbarEl = null;
  let homeEdit = null; // { snapshot: [{el, parent, next}], tray } while editing

  function homeSlug(text) {
    return (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'karta';
  }

  // Stable card id: existing DOM id wins, then title slug, then positional
  // fallback. Uniqueness enforced by the caller (first wins, later get :2).
  function homeCardId(el, fallbackIdx) {
    if (el.id) return '#' + el.id;
    const h = el.querySelector('h2[slot="title"]');
    const t = h ? h.textContent.trim() : '';
    if (t) return 't:' + homeSlug(t);
    return 'x:' + fallbackIdx;
  }

  // Column containers: the DIVs directly under .local-home-table. Table-level
  // frames (our summary) live in the virtual "top" zone = the table itself.
  function homeColumns() {
    const table = document.querySelector('.local-home-table');
    if (!table) return { table: null, cols: [] };
    const cols = [...table.children].filter((el) =>
      el.tagName !== 'USOS-FRAME'
      && el.id !== 'usospp-home-summary');
    return { table, cols };
  }

  function homeCards() {
    const { table, cols } = homeColumns();
    if (!table) return [];
    const out = [];
    const seen = new Set();
    const push = (el) => {
      let id = homeCardId(el, out.length);
      if (seen.has(id)) id += ':' + out.length;
      seen.add(id);
      out.push({ el, id });
    };
    [...table.children].forEach((el) => { if (el.tagName === 'USOS-FRAME') push(el); });
    cols.forEach((col) => {
      [...col.children].forEach((el) => { if (el.tagName === 'USOS-FRAME') push(el); });
    });
    return out;
  }

  function homeCardsById() {
    const map = new Map();
    homeCards().forEach(({ el, id }) => { if (!map.has(id)) map.set(id, el); });
    return map;
  }

  async function homeLayoutLoad() {
    try {
      const res = await chrome.storage.local.get({ [HOME_LAYOUT_KEY]: null });
      const v = res[HOME_LAYOUT_KEY];
      if (v && Array.isArray(v.cols) && Array.isArray(v.hidden)) return v;
    } catch (e) { /* storage unavailable — default layout */ }
    return null;
  }

  async function homeLayoutSave(layout) {
    try { await chrome.storage.local.set({ [HOME_LAYOUT_KEY]: layout }); } catch (e) { /* best effort */ }
  }

  function homeSerialize() {
    const { table, cols } = homeColumns();
    if (!table) return null;
    const byEl = new Map(homeCards().map(({ el, id }) => [el, id]));
    const idsOf = (container) => [...container.children]
      .filter((el) => el.tagName === 'USOS-FRAME' && byEl.has(el))
      .map((el) => byEl.get(el));
    // Top zone first, then each native column in DOM order. Ghosts (hidden
    // in edit) land in `hidden`, never in the visible order lists.
    const zones = [table, ...cols];
    const hidden = [...document.querySelectorAll('.local-home-table .usospp-home-ghost')]
      .map((el) => byEl.get(el)).filter(Boolean);
    return {
      v: 1,
      cols: zones.map((z) => idsOf(z).filter((id) => !hidden.includes(id))),
      hidden,
    };
  }

  function homeApplyLayout(layout) {
    if (!layout) return;
    const byId = homeCardsById();
    const { table, cols } = homeColumns();
    if (!table) return;
    (layout.hidden || []).forEach((id) => {
      const el = byId.get(id);
      if (el) el.classList.add('usospp-home-hidden');
    });
    const zoneLists = layout.cols || [];
    // Top zone (table-level cards like our summary): insert in order before
    // the first native column so they stay on top instead of sinking below.
    const anchor = cols[0] || null;
    (zoneLists[0] || []).forEach((id) => {
      const el = byId.get(id);
      if (!el || el.classList.contains('usospp-home-hidden')) return;
      table.insertBefore(el, anchor);
    });
    zoneLists.slice(1).forEach((ids, ci) => {
      const zone = cols[ci];
      if (!zone) return;
      (ids || []).forEach((id) => {
        const el = byId.get(id);
        if (!el || el.classList.contains('usospp-home-hidden')) return;
        zone.appendChild(el);
      });
    });
    // Unknown/new cards keep their native position (never moved).
  }

  function homeExitEdit() {
    document.querySelectorAll('.usospp-home-gripbox, .usospp-home-eyebox').forEach((h) => h.remove());
    document.querySelectorAll('.usospp-home-editing-table').forEach((t) => t.classList.remove('usospp-home-editing-table'));
    document.querySelectorAll('.usospp-home-dragover, .usospp-home-drop-before, .usospp-home-drop-after')
      .forEach((el) => el.classList.remove('usospp-home-dragover', 'usospp-home-drop-before', 'usospp-home-drop-after'));
    document.querySelectorAll('.local-home-table usos-frame').forEach((el) => {
      el.classList.remove('usospp-home-editing');
    });
    homeEdit = null;
  }

  function renderHomeToolbar(editing) {
    if (homeToolbarEl) { homeToolbarEl.remove(); homeToolbarEl = null; }
    const table = document.querySelector('.local-home-table');
    if (!table || !table.isConnected) return;
    const bar = document.createElement('div');
    bar.className = 'usospp-home-toolbar' + (editing ? ' usospp-home-toolbar--edit' : '');
    if (!editing) {
      // Deliberately subtle: one clickable element in the USOS++ tag style
      // (see .usospp-home-editbtn in usos.css), right-aligned with a padded
      // hit-area so the whole label — not just the glyphs — is clickable.
      const btn = document.createElement('span');
      btn.className = 'usospp-home-editbtn';
      btn.setAttribute('role', 'button');
      btn.setAttribute('tabindex', '0');
      btn.textContent = 'Edytuj układ · USOS++';
      btn.addEventListener('click', homeStartEdit);
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); homeStartEdit(); }
      });
      bar.append(btn);
    } else {
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'usospp-home-btn usospp-home-btn--primary';
      save.textContent = 'Zapisz';
      save.addEventListener('click', homeSaveEdit);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'usospp-home-btn';
      cancel.textContent = 'Anuluj';
      cancel.addEventListener('click', homeCancelEdit);
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'usospp-home-btn usospp-home-btn--danger';
      reset.textContent = 'Przywróć domyślny';
      reset.addEventListener('click', homeResetLayout);
      bar.append(save, cancel, reset);
    }
    table.before(bar);
    homeToolbarEl = bar;
  }

  // Edit-mode icons live inside the card's own title (h2): the native h2 is
  // itself positioned, so it would otherwise hijack absolute positioning from
  // the card and the icons would sink to the title's bottom edge, straddling
  // its border. Anchored to the h2 and optically centered via top:50% +
  // translateY, so every widget keeps a single row.
  const HOME_EYE_OPEN = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"></path><circle cx="10" cy="10" r="2.4"></circle></svg>';
  const HOME_EYE_OFF = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"></path><circle cx="10" cy="10" r="2.4"></circle><line x1="3.5" y1="16.5" x2="16.5" y2="3.5"></line></svg>';

  function homeTitleEl(cardEl) {
    return cardEl.querySelector(':scope > h2') || null;
  }

  function homeRefreshEye(cardEl) {
    const eye = cardEl.querySelector('.usospp-home-eye');
    if (!eye) return;
    const hidden = cardEl.classList.contains('usospp-home-ghost');
    eye.innerHTML = hidden ? HOME_EYE_OFF : HOME_EYE_OPEN;
    eye.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    eye.title = hidden ? 'Pokaż okienko' : 'Ukryj okienko';
  }

  function homeToggleHidden(cardEl) {
    // Ghost = hidden-in-edit, kept in place (no separate tray). Persisted as
    // hidden on save; converted to display:none then.
    cardEl.classList.toggle('usospp-home-ghost');
    homeRefreshEye(cardEl);
  }

  // Edit-mode icons: anchored to the CARD's edges (flush left/right) and
  // vertically centered on the title row. Anchoring to the h2 was tried and
  // abandoned: native USOS indents the h2 ~17px inside the card, so h2-based
  // offsets can never reach the card edges. The title center is measured from
  // live layout (robust to any native indentation/padding).
  function homeAttachIcons(cardEl) {
    const title = homeTitleEl(cardEl);
    const left = document.createElement('span');
    left.className = 'usospp-home-gripbox';
    const grip = document.createElement('span');
    grip.className = 'usospp-home-grip';
    grip.textContent = '⋮⋮';
    grip.setAttribute('draggable', 'true');
    grip.setAttribute('tabindex', '0');
    grip.setAttribute('role', 'button');
    grip.setAttribute('aria-label', 'Przeciągnij lub użyj strzałek, aby przenieść okienko');
    grip.title = 'Przeciągnij, aby przenieść (strzałki też działają)';
    grip.addEventListener('dragstart', (e) => {
      try { e.dataTransfer.setData('text/plain', 'home-card'); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* ignore */ }
      homeEdit.dragEl = cardEl;
      cardEl.classList.add('usospp-home-dragging');
    });
    grip.addEventListener('dragend', () => {
      cardEl.classList.remove('usospp-home-dragging');
      if (homeEdit) homeEdit.dragEl = null;
      homeClearDropMarks();
    });
    grip.addEventListener('keydown', (e) => {
      const moves = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
      const mv = moves[e.key];
      if (!mv) return;
      e.preventDefault();
      homeMoveCardKey(cardEl, mv[0], mv[1]);
    });
    left.append(grip);
    const right = document.createElement('span');
    right.className = 'usospp-home-eyebox';
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'usospp-home-eye';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      homeToggleHidden(cardEl);
    });
    right.append(eye);
    cardEl.append(left, right);
    // Pin both boxes to the title's vertical middle; fall back to the
    // card's top edge for untitled cards (CSS translateY is cleared there).
    if (title && title.offsetHeight) {
      const mid = `${title.offsetTop + title.offsetHeight / 2}px`;
      left.style.top = mid;
      right.style.top = mid;
    } else {
      left.style.top = '8px';
      left.style.transform = 'none';
      right.style.top = '8px';
      right.style.transform = 'none';
    }
  }

  function homeClearDropMarks() {
    document.querySelectorAll('.usospp-home-drop-before, .usospp-home-drop-after, .usospp-home-dragover')
      .forEach((el) => el.classList.remove('usospp-home-drop-before', 'usospp-home-drop-after', 'usospp-home-dragover'));
  }

  function homeMoveCardTo(cardEl, targetZone, beforeEl) {
    if (!cardEl || !targetZone) return;
    if (beforeEl && beforeEl.parentElement === targetZone && beforeEl !== cardEl) targetZone.insertBefore(cardEl, beforeEl);
    else if (beforeEl !== cardEl) targetZone.appendChild(cardEl);
  }

  // Keyboard move: [dx, dy] between/inside zones (zones = top + columns).
  // Ghost (hidden-in-edit) cards move like the rest — their position is
  // kept and applies once unhidden.
  function homeMoveCardKey(cardEl, dx, dy) {
    const { table, cols } = homeColumns();
    if (!table) return;
    const zones = [table, ...cols];
    const zone = cardEl.parentElement;
    const zi = zones.indexOf(zone);
    if (zi === -1) return;
    if (dy !== 0) {
      const sibs = [...zone.children].filter((el) => el.tagName === 'USOS-FRAME');
      const i = sibs.indexOf(cardEl);
      const j = i + dy;
      if (j >= 0 && j < sibs.length) zone.insertBefore(cardEl, dy < 0 ? sibs[j] : sibs[j].nextSibling);
    }
    if (dx !== 0) {
      const nz = zones[(zi + dx + zones.length) % zones.length];
      if (nz && nz !== zone) nz.appendChild(cardEl);
    }
    const grip = cardEl.querySelector('.usospp-home-grip');
    if (grip) grip.focus();
  }

  function wireHomeDropZone(zoneEl) {
    // Wired once per element (edit mode can be entered repeatedly); the
    // handlers consult the live homeEdit state, so re-wiring is unnecessary.
    if (zoneEl.dataset.homeWired) return;
    zoneEl.dataset.homeWired = '1';
    zoneEl.addEventListener('dragover', (e) => {
      if (!homeEdit || !homeEdit.dragEl) return;
      e.preventDefault();
      e.stopPropagation();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
      const after = homeAfterElement(zoneEl, e.clientY);
      homeClearDropMarks();
      zoneEl.classList.add('usospp-home-dragover');
      if (after) {
        // Orange line above the card the dragged element would precede.
        after.classList.add('usospp-home-drop-before');
      } else {
        // Cursor past the last card (or an empty column): mark the end of
        // the list instead, otherwise dropping last shows no indicator.
        const cards = [...zoneEl.children].filter((el) =>
          el.tagName === 'USOS-FRAME' && el !== homeEdit.dragEl);
        const last = cards[cards.length - 1];
        if (last) last.classList.add('usospp-home-drop-after');
      }
      homeEdit.dropTarget = { zone: zoneEl, before: after || null };
    });
    zoneEl.addEventListener('dragleave', (e) => {
      // Only clear when truly leaving the zone (not bubbling from a card).
      if (e.target === zoneEl) zoneEl.classList.remove('usospp-home-dragover');
    });
    zoneEl.addEventListener('drop', (e) => {
      if (!homeEdit || !homeEdit.dragEl) return;
      e.preventDefault();
      e.stopPropagation();
      const el = homeEdit.dragEl;
      const target = homeEdit.dropTarget;
      const zone = (target && target.zone && target.zone.isConnected) ? target.zone : zoneEl;
      const before = target ? target.before : null;
      // Ghost state is preserved across moves — hiding is eye-only.
      homeMoveCardTo(el, zone, before);
      homeEdit.dropTarget = null;
      homeClearDropMarks();
    });
  }

  function homeAfterElement(zoneEl, y) {
    const cards = [...zoneEl.children].filter((el) =>
      el.tagName === 'USOS-FRAME'
      && !(homeEdit.dragEl && el === homeEdit.dragEl)
      && !el.classList.contains('usospp-home-dragging'));
    let closest = null;
    let closestOff = Number.NEGATIVE_INFINITY;
    cards.forEach((el) => {
      const box = el.getBoundingClientRect();
      const off = y - (box.top + box.height / 2);
      if (off < 0 && off > closestOff) { closestOff = off; closest = el; }
    });
    return closest;
  }

  function homeStartEdit() {
    const { table } = homeColumns();
    if (!table || homeEdit) return;
    // Drop the native margin-top pull-up while editing (see
    // .usospp-home-editing-table in usos.css).
    table.classList.add('usospp-home-editing-table');    // Snapshot for Anuluj: exact DOM positions + ghost/hidden classes.
    const snapshot = homeCards().map(({ el }) => ({
      el,
      parent: el.parentElement,
      next: el.nextSibling,
      ghost: el.classList.contains('usospp-home-ghost'),
      hidden: el.classList.contains('usospp-home-hidden'),
    }));
    homeEdit = { snapshot, dragEl: null, dropTarget: null };
    renderHomeToolbar(true);
    homeCards().forEach(({ el }) => {
      el.classList.add('usospp-home-editing');
      // Saved-hidden cards become visible ghosts in place — no tray.
      if (el.classList.contains('usospp-home-hidden')) {
        el.classList.remove('usospp-home-hidden');
        el.classList.add('usospp-home-ghost');
      }
      // Icons go into the title row when there is one (grip left, eye
      // right, both measured off the live title center); untitled cards get
      // a top-anchored fallback (see usos.css).
      homeAttachIcons(el);
      homeRefreshEye(el);
    });
    const { table: t2, cols } = homeColumns();
    if (t2) wireHomeDropZone(t2);
    cols.forEach((c) => wireHomeDropZone(c));
    try { console.info('[USOS++] home layout edit started'); } catch (e) { /* ignore */ }
  }

  function homeSaveEdit() {
    if (!homeEdit) return;
    const layout = homeSerialize();
    if (layout) homeLayoutSave(layout);
    // Ghosts become truly hidden only now, on explicit save.
    document.querySelectorAll('.local-home-table .usospp-home-ghost')
      .forEach((el) => {
        el.classList.remove('usospp-home-ghost');
        el.classList.add('usospp-home-hidden');
      });
    homeExitEdit();
    initHomeLayoutToolbar();
    try { console.info('[USOS++] home layout saved'); } catch (e) { /* ignore */ }
  }

  function homeCancelEdit() {
    if (!homeEdit) return;
    homeEdit.snapshot.forEach(({ el, parent, next, ghost, hidden }) => {
      if (!el.isConnected || !parent.isConnected) return;
      parent.insertBefore(el, next);
      if (ghost) el.classList.add('usospp-home-ghost');
      else el.classList.remove('usospp-home-ghost');
      if (hidden) el.classList.add('usospp-home-hidden');
      else el.classList.remove('usospp-home-hidden');
    });
    homeExitEdit();
    initHomeLayoutToolbar();
    try { console.info('[USOS++] home layout edit cancelled'); } catch (e) { /* ignore */ }
  }

  async function homeResetLayout() {
    try { await chrome.storage.local.remove(HOME_LAYOUT_KEY); } catch (e) { /* ignore */ }
    location.reload();
  }

  function initHomeLayoutToolbar() {
    renderHomeToolbar(false);
  }

  // Entry point for home/index (called after the summary widget is in place):
  // re-apply saved order/hidden, then offer the Edit button.
  async function initHomeLayout() {
    const { table } = homeColumns();
    if (!table) return;
    const layout = await homeLayoutLoad();
    // Re-check: user may have navigated away during the async load.
    if (!document.body.contains(table)) return;
    if (layout) homeApplyLayout(layout);
    initHomeLayoutToolbar();
  }

  function removeHomeLayout() {
    if (homeEdit) {
      // Restore pre-edit DOM before tearing down (same as cancel, no save).
      homeEdit.snapshot.forEach(({ el, parent, next, ghost, hidden }) => {
        try {
          if (el.isConnected && parent.isConnected) {
            parent.insertBefore(el, next);
            if (ghost) el.classList.add('usospp-home-ghost');
            else el.classList.remove('usospp-home-ghost');
            if (hidden) el.classList.add('usospp-home-hidden');
            else el.classList.remove('usospp-home-hidden');
          }
        } catch (e) { /* ignore */ }
      });
      homeEdit = null;
    } else {
      // Feature turned off (or panel on): leave a pristine native page —
      // saved hidden/order stays in storage and re-applies on next load.
      document.querySelectorAll('.local-home-table .usospp-home-hidden, .local-home-table .usospp-home-ghost')
        .forEach((el) => el.classList.remove('usospp-home-hidden', 'usospp-home-ghost'));
    }
    document.querySelectorAll('.usospp-home-gripbox, .usospp-home-eyebox').forEach((h) => h.remove());
    document.querySelectorAll('.usospp-home-editing-table').forEach((t) => t.classList.remove('usospp-home-editing-table'));
    if (homeToolbarEl) { homeToolbarEl.remove(); homeToolbarEl = null; }
  }

  async function applyClassicWidgets(settings) {
    if (!settings.features.classicWidgets || settings.enabled) {
      removeClassicWidgets();
      return;
    }
    if (classicWidgetEl) return; // already injected for this page load
    const action = new URLSearchParams(location.search).get('_action');
    const anchorSelector =
      action === 'dla_stud/studia/oceny/index' ? 'usos-frame#oceny, usos-frame.oceny'
      : action === 'home/plan' ? '.timetable-wrapper'
      : action === 'home/index' ? '.local-home-table'
      : null;
    if (!anchorSelector) return; // not a widget page — nothing to wait for
    const anchor = await waitForClassicAnchor(anchorSelector);
    if (!anchor) {
      logClassicSkip(action, 'anchor not found after 5s');
      return;
    }
    // The toggle may have flipped, or the page navigated away, while waiting.
    if (!currentSettings || !currentSettings.features.classicWidgets || currentSettings.enabled) return;
    if (classicWidgetEl) return;
    if (action === 'dla_stud/studia/oceny/index') injectOcenyWidget();
    else if (action === 'home/plan') injectPlanWidget();
    else if (action === 'home/index') {
      await injectHomeSummary();
      // Layout after the summary exists so it joins as a regular card.
      if (!currentSettings || !currentSettings.features.classicWidgets || currentSettings.enabled) return;
      initHomeLayout();
    }
  }

  function onKeydown(e) {
    if (!app) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName)) return;
    const map = { '1': 'dashboard', '2': 'aktualnosci', '3': 'plan', '4': 'oceny', '5': 'przedmioty', '6': 'egzaminy', '7': 'ects', '8': 'platnosci', '9': 'ustawienia' };
    if (map[e.key]) app.navigate(map[e.key]);
  }

  function applyIndependentFeatures(settings) {
    // A sticky-bypassed tab always shows the quickbar — it's the only
    // in-tab return path to the panel, so the quickbar feature flag must
    // not be able to hide it there. The whole-plugin kill switch still wins
    // (pluginEnabled === false hides everything, bypass included).
    if ((settings.features.quickbar && !settings.enabled) || (isBypassed() && settings.pluginEnabled !== false)) ensureQuickbar();
    else removeQuickbar();

    if (settings.features.keyboardNav && settings.enabled) document.addEventListener('keydown', onKeydown);
    else document.removeEventListener('keydown', onKeydown);

    if (settings.enabled && settings.features.autorefresh) {
      if (!autorefreshTimer) autorefreshTimer = setInterval(refreshData, 120000);
    } else if (autorefreshTimer) {
      clearInterval(autorefreshTimer);
      autorefreshTimer = null;
    }
  }

  // A whole-extension kill switch, distinct from `enabled` (which only
  // toggles the full-page panel) — see popup.js's danger zone. When
  // off, nothing below (panel, quickbar, keyboard nav, autorefresh, classic
  // widgets) is allowed to run, regardless of what's individually toggled
  // on. Gated only here, at runtime — `enabled`/`features` in storage are
  // left untouched, so turning the plugin back on restores exactly what was
  // on before, with no separate "off" state to reconcile.
  async function applyState(settings) {
    currentSettings = settings;
    const active = settings.pluginEnabled !== false;
    const effective = active ? settings : {
      ...settings,
      enabled: false,
      features: Object.fromEntries(Object.keys(settings.features).map((k) => [k, false])),
    };
    if (effective.enabled) {
      if (!app) await mountRedesign();
      else app.updateSettings({ darkMode: effective.darkMode, features: effective.features });
      syncCanvasTheme();
    } else if (app || container) {
      unmountRedesign();
    }
    applyIndependentFeatures(effective);
    applyClassicWidgets(effective);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return undefined;
    // Alive-check for popup.js's toggleEnabled (pingTab there): answered from
    // this top-level listener, which exists as soon as the script loads,
    // regardless of whether the panel is currently on. No response means no
    // content script in the tab at all — a missing/lost dynamic registration
    // that the popup must rebuild (register + reload) before enabling.
    if (msg.type === 'usospp:ping') {
      sendResponse(true);
      return undefined;
    }
    if (msg.type === 'usospp:navigate' && app) {
      app.navigate(msg.view);
      return undefined;
    }
    if (msg.type === 'usospp:getSnapshot') {
      if (!app) {
        sendResponse(null);
        return undefined;
      }
      const grades = app.numericGrades;
      const avg = grades.length ? (grades.reduce((a, b) => a + parseFloat(b), 0) / grades.length).toFixed(2) : null;
      // Earliest session starting now-or-later across the next 8 weeks
      // (verified concreteSessions shape: {date 'YYYY-MM-DD', start 'HH:MM',
      // subject, type, room, building}). Null when the plan details aren't
      // loaded yet or nothing is scheduled — the popup hides the card then.
      let nextSession = null;
      try {
        if (typeof app.concreteSessionsForOffset === 'function') {
          const now = Date.now();
          outer: for (let off = 0; off < 8; off++) {
            const list = app.concreteSessionsForOffset(off) || [];
            for (const s of list) {
              const t = Date.parse(`${s.date}T${s.start}:00`);
              if (Number.isFinite(t) && t >= now) {
                nextSession = {
                  date: s.date, start: s.start, end: s.end || null,
                  subject: s.subject || null, type: s.type || null,
                  room: s.room || null, building: s.building || null,
                };
                break outer;
              }
            }
          }
        }
      } catch (e) { nextSession = null; }
      sendResponse({
        user: app.data.user,
        avg,
        gradeCount: grades.length,
        planEventCount: app.planEvents.length,
        examCount: app.exams.length,
        etap: app.etapy[0] || null,
        nextSession,
      });
      return undefined;
    }
    return undefined;
  });

  // Links like "Otwórz w USOS →" need to actually show classic USOSweb, even
  // though the redesign is globally enabled for the domain — otherwise
  // they'd just reopen the same redesign (or its unverified fallback) on the
  // new tab, defeating their entire purpose. Appending ?usospp_off=1 plants
  // the sticky per-tab native flag (see NATIVE_TAB_KEY above), so the whole
  // tab renders as classic USOS — including onward navigations, reloads and
  // POST round-trips that no longer carry the param — without touching the
  // stored (global, cross-tab) `enabled` setting. The quickbar toggle is the
  // way back: it clears the tab flag and mounts the panel in this tab only.
  if (new URLSearchParams(location.search).has('usospp_off')) writeNativeTabFlag(true);
  const bypassThisLoad = isBypassed();

  (async () => {
    const settings = await getState();
    await applyState(bypassThisLoad ? { ...settings, enabled: false } : settings);
  })();

  onStateChange(async () => {
    const settings = await getState();
    if (isBypassed()) {
      // Sticky native tab (see NATIVE_TAB_KEY): the panel must never mount
      // here, but lightweight features toggled from another tab/the popup
      // should still apply live instead of waiting for a reload. The quickbar
      // toggle clears the tab flag itself and re-applies via applyState
      // directly, so this path only handles *other* tabs' changes.
      const active = settings.pluginEnabled !== false;
      const effective = active
        ? { ...settings, enabled: false }
        : {
          ...settings,
          enabled: false,
          features: Object.fromEntries(Object.keys(settings.features).map((k) => [k, false])),
        };
      currentSettings = effective;
      applyIndependentFeatures(effective);
      applyClassicWidgets(effective);
      return;
    }
    await applyState(settings);
  });
})();

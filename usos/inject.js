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
    app.data = data;
    app.render();
    app.checkNewsUpdate();
    maybeUpdateBadge(data);
  }

  function clearBadge() {
    chrome.runtime.sendMessage({ type: 'usospp:setBadge', text: '' }).catch(() => {});
  }

  function maybeUpdateBadge(data) {
    if (!currentSettings || !currentSettings.features.gradeBadge) {
      clearBadge();
      return;
    }
    const grades = Array.isArray(data.gradesResult && data.gradesResult.rows) ? data.gradesResult.rows : [];
    const nums = grades
      .map((row) => {
        const cells = Array.isArray(row) ? row : [row.text];
        for (let i = cells.length - 1; i >= 0; i--) {
          const m = String(cells[i]).replace(',', '.').match(/[0-9]([.][0-9])?/);
          if (m) return m[0];
        }
        return null;
      })
      .filter(Boolean);
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

    // Toggle button to enable USOS++ redesign
    const toggle = document.createElement('div');
    toggle.title = 'Włącz panel USOS++';
    toggle.style.cssText = 'width:24px;height:24px;border-radius:12px;background:#d9773a;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.1s,background 0.15s;flex-shrink:0;margin-left:4px;margin-right:8px;';
    toggle.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v6"></path><path d="M5.5 5.8a6.5 6.5 0 1 0 9 0"></path></svg>';
    toggle.addEventListener('mouseenter', () => { toggle.style.background = 'oklch(52% 0.15 45)'; });
    toggle.addEventListener('mouseleave', () => { toggle.style.background = '#d9773a'; });
    toggle.addEventListener('mousedown', () => { toggle.style.transform = 'scale(0.9)'; });
    toggle.addEventListener('mouseup', () => { toggle.style.transform = 'scale(1)'; });
    toggle.addEventListener('click', async () => {
      await window.USOSPP_STATE.setState({ enabled: true });
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
  // into classic USOSweb pages (Oceny/Płatności/Plan/Mój USOSweb) when the
  // full redesign is off. Same "independent" spirit as the quickbar above,
  // just page-specific — each function reads whatever the current page
  // already renders (via the adapter's `doc = document` default) instead of
  // fetching anything, except the home summary, which needs two other pages'
  // data and is the only one that fetches.

  let classicWidgetEl = null;
  let homeSummaryPending = false;

  function removeClassicWidgets() {
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
    const nums = (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const cells = Array.isArray(row) ? row : [row.text];
        for (let i = cells.length - 1; i >= 0; i--) {
          const m = String(cells[i]).replace(',', '.').match(/[0-9]([.][0-9])?/);
          if (m) return m[0];
        }
        return null;
      })
      .filter(Boolean);
    return nums.length ? { avg: (nums.reduce((a, b) => a + parseFloat(b), 0) / nums.length).toFixed(2), count: nums.length } : null;
  }

  function countUnpaidRows(paymentGroups) {
    return (paymentGroups.groups || []).reduce((n, g) => n + (g.rows ? g.rows.length : 0), 0);
  }

  // UNVERIFIED: same caveat as adapter.getGrades — only the empty state has
  // ever been observed live, so this only renders once real rows show up.
  function injectOcenyWidget() {
    const adapter = selectAdapter();
    const frame = document.querySelector('usos-frame#oceny, usos-frame.oceny');
    if (!adapter || !frame) return;
    const avg = averageFromGradeRows(adapter.getGrades().rows);
    if (!avg) return;
    const el = document.createElement('div');
    el.className = 'usospp-classic-widget usospp-classic-widget--info';
    const strong = document.createElement('strong');
    strong.textContent = avg.avg;
    const desc = document.createElement('span');
    desc.textContent = `średnia z ${avg.count} widocznych ocen`;
    el.append(strong, desc, widgetTag());
    frame.before(el);
    classicWidgetEl = el;
  }

  function injectPlatnosciWidget() {
    const adapter = selectAdapter();
    const main = document.querySelector('#layout-main-content');
    if (!adapter || !main) return;
    const result = adapter.getPaymentGroups();
    const totalRows = countUnpaidRows(result);
    if (!totalRows) return;
    const anchor = main.querySelector('usos-frame, info-box');
    const el = document.createElement('div');
    el.className = 'usospp-classic-widget usospp-classic-widget--warning';
    const strong = document.createElement('strong');
    strong.textContent = result.grandTotal || `${totalRows} ${totalRows === 1 ? 'pozycja' : 'pozycje'} do zapłaty`;
    const desc = document.createElement('span');
    desc.textContent = 'masz nierozliczone należności';
    el.append(strong, desc, widgetTag());
    if (anchor) anchor.before(el);
    else main.prepend(el);
    classicWidgetEl = el;
  }

  // UNVERIFIED: same caveat as adapter.getPlan — the shape of a populated
  // event has never been observed live, so this reports only a count, never
  // per-event details (same restraint usos/app.js's renderPlan takes).
  function injectPlanWidget() {
    const adapter = selectAdapter();
    const wrapper = document.querySelector('.timetable-wrapper');
    if (!adapter || !wrapper) return;
    const events = adapter.getPlan().raw;
    if (!Array.isArray(events) || !events.length) return;
    const el = document.createElement('div');
    el.className = 'usospp-classic-widget usospp-classic-widget--info';
    const strong = document.createElement('strong');
    strong.textContent = String(events.length);
    const desc = document.createElement('span');
    desc.textContent = events.length === 1 ? 'zajęcia w tym tygodniu' : 'zajęć w tym tygodniu';
    el.append(strong, desc, widgetTag());
    wrapper.prepend(el);
    classicWidgetEl = el;
  }

  // Cross-page card for "Mój USOSweb" (home/index) — the only classic widget
  // that needs data from other pages (średnia lives on Oceny, zaległości on
  // Płatności). Deliberately fetches just those two instead of the full
  // collectAll() the redesign uses, to keep this lightweight.
  async function injectHomeSummary() {
    if (homeSummaryPending) return;
    const table = document.querySelector('.local-home-table');
    const adapter = selectAdapter();
    if (!table || !adapter) return;
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
      const totalRows = countUnpaidRows(paymentsResult);
      if (!avg && !totalRows) return;

      const frame = document.createElement('usos-frame');
      const h2 = document.createElement('h2');
      h2.setAttribute('slot', 'title');
      h2.textContent = 'USOS++ — podsumowanie';
      frame.appendChild(h2);

      const body = document.createElement('div');
      body.className = 'usospp-classic-home-summary';

      if (avg) {
        const row = document.createElement('div');
        row.className = 'usospp-classic-home-row';
        const label = document.createElement('span');
        label.append('Średnia ocen: ');
        const strong = document.createElement('strong');
        strong.textContent = avg.avg;
        label.appendChild(strong);
        const link = document.createElement('a');
        link.href = `${location.origin}/kontroler.php?_action=dla_stud/studia/oceny/index`;
        link.textContent = 'oceny →';
        row.append(label, link);
        body.appendChild(row);
      }
      if (totalRows) {
        const row = document.createElement('div');
        row.className = 'usospp-classic-home-row';
        const label = document.createElement('span');
        label.textContent = paymentsResult.grandTotal || `${totalRows} nierozliczonych należności`;
        const link = document.createElement('a');
        link.href = `${location.origin}/kontroler.php?_action=dodatki/platnosci/naleznosciNierozliczone`;
        link.textContent = 'płatności →';
        row.append(label, link);
        body.appendChild(row);
      }
      frame.appendChild(body);
      table.prepend(frame);
      classicWidgetEl = frame;
    } finally {
      homeSummaryPending = false;
    }
  }

  function applyClassicWidgets(settings) {
    if (!settings.features.classicWidgets || settings.enabled) {
      removeClassicWidgets();
      return;
    }
    if (classicWidgetEl) return; // already injected for this page load
    const action = new URLSearchParams(location.search).get('_action');
    if (action === 'dla_stud/studia/oceny/index') injectOcenyWidget();
    else if (action === 'dodatki/platnosci/naleznosciNierozliczone') injectPlatnosciWidget();
    else if (action === 'home/plan') injectPlanWidget();
    else if (action === 'home/index') injectHomeSummary();
  }

  function onKeydown(e) {
    if (!app) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName)) return;
    const map = { '1': 'dashboard', '2': 'aktualnosci', '3': 'plan', '4': 'oceny', '5': 'przedmioty', '6': 'egzaminy', '7': 'ects', '8': 'platnosci', '9': 'ustawienia' };
    if (map[e.key]) app.navigate(map[e.key]);
  }

  function applyIndependentFeatures(settings) {
    if (settings.features.quickbar && !settings.enabled) ensureQuickbar();
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
  // toggles the full-page panel) — see popup.js's "Wyłącz wtyczkę". When
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
      sendResponse({
        user: app.data.user,
        avg,
        gradeCount: grades.length,
        planEventCount: app.planEvents.length,
        examCount: app.exams.length,
        etap: app.etapy[0] || null,
      });
      return undefined;
    }
    return undefined;
  });

  // Links like "Otwórz w USOS →" need to actually show classic USOSweb, even
  // though the redesign is globally enabled for the domain — otherwise
  // they'd just reopen the same redesign (or its unverified fallback) on the
  // new tab, defeating their entire purpose. Appending ?usospp_off=1 makes
  // this one page load render as classic USOS without touching the stored
  // (global, cross-tab) `enabled` setting; navigating onward from there
  // drops the param and the redesign resumes normally.
  const bypassThisLoad = new URLSearchParams(location.search).has('usospp_off');

  (async () => {
    const settings = await getState();
    await applyState(bypassThisLoad ? { ...settings, enabled: false } : settings);
  })();

  onStateChange(async () => {
    if (bypassThisLoad) return;
    const settings = await getState();
    await applyState(settings);
  });
})();

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
    }
    if (rescrape) refreshData();
  }

  async function refreshData() {
    const adapter = selectAdapter();
    if (!adapter || !app) return;
    const data = await collectAll(adapter);
    app.data = data;
    app.render();
    maybeUpdateBadge(data);
  }

  function maybeUpdateBadge(data) {
    if (!currentSettings || !currentSettings.features.gradeBadge) return;
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
    hideNative();
    const el = ensureContainer();
    const data = await collectAll(adapter);
    app = window.USOSPP_APP.mount(el, data, { darkMode: currentSettings.darkMode, features: currentSettings.features });
    maybeUpdateBadge(data);
  }

  function unmountRedesign() {
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

  // ---- independent small features (work with or without the full redesign) ----

  function ensureQuickbar() {
    if (quickbarEl) return;
    quickbarEl = document.createElement('div');
    quickbarEl.id = 'usospp-quickbar';
    quickbarEl.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:99999;display:flex;gap:6px;background:#241c14;border-radius:14px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,0.25);font-family:system-ui,sans-serif;';
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

  function onKeydown(e) {
    if (!app) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName)) return;
    const map = { '1': 'dashboard', '2': 'plan', '3': 'oceny', '4': 'przedmioty', '5': 'egzaminy', '6': 'ects', '7': 'powiadomienia', '8': 'ustawienia' };
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

  async function applyState(settings) {
    currentSettings = settings;
    if (settings.enabled) {
      if (!app) await mountRedesign();
      else app.updateSettings({ darkMode: settings.darkMode, features: settings.features });
    } else if (app || container) {
      unmountRedesign();
    }
    applyIndependentFeatures(settings);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return undefined;
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

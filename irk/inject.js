// Entry point for the IRK content script. Same mount/unmount shape as
// usos/inject.js, scoped down to what irk/app.js actually renders — no
// quickbar, autorefresh or classic-page widgets yet, since IRK v1 doesn't
// have independent small features the way USOS does.
(function () {
  // Loud on purpose while IRK is new — the guard below silently no-ops on
  // every non-IRK page by design, so without this line there is otherwise
  // no way to tell "detection said no" apart from "this file never even
  // ran" or "it crashed before reaching here" from the console alone.
  const platform = window.USOSPP_CORE ? window.USOSPP_CORE.detectPlatform() : 'USOSPP_CORE missing';
  console.info('[USOS++] irk/inject.js loaded, detectPlatform() =', platform);
  if (platform !== 'irk') return;

  const { getState, onStateChange, setState } = window.USOSPP_STATE;
  const adapters = window.USOSPP_IRK_ADAPTERS;
  const scrape = window.USOSPP_IRK_SCRAPE;

  let app = null;
  let container = null;
  let currentSettings = null;
  let nativeChipEl = null;

  // Sticky per-tab "stay native" flag — same mechanism as usos/inject.js's
  // NATIVE_TAB_KEY (?usospp_off=1 plants it, the whole tab stays classic
  // across navigations/reloads until cleared). IRK has no quickbar yet, so
  // the return path is a minimal floating chip, shown only while bypassed.
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

  // Auth pages always stay native (verified live 2026-09-14 bug: mounting
  // the dashboard on the login form hid it behind "Nie wybrano rekrutacji").
  // Unlike ?usospp_off this never plants the sticky flag — after
  // login/logout IRK redirects to a normal page that mounts fresh.
  const isAuthPage = /^\/(?:pl\/)?auth\//.test(location.pathname);

  function ensureNativeChip() {
    if (nativeChipEl) return;
    nativeChipEl = document.createElement('div');
    nativeChipEl.id = 'usospp-irk-native-chip';
    nativeChipEl.title = 'Wróć do panelu USOS++';
    nativeChipEl.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:99999;display:flex;gap:8px;align-items:center;background:#241c14;border-radius:14px;padding:8px 12px 8px 8px;box-shadow:0 8px 24px rgba(0,0,0,0.25);font-family:system-ui,sans-serif;cursor:pointer;';
    nativeChipEl.innerHTML = '<span style="width:24px;height:24px;border-radius:12px;background:#d9773a;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v6"></path><path d="M5.5 5.8a6.5 6.5 0 1 0 9 0"></path></svg></span><span style="color:#fff;font-size:12px;font-weight:600;">USOS++</span>';
    nativeChipEl.addEventListener('click', async () => {
      writeNativeTabFlag(false);
      const next = await setState({ irkEnabled: true });
      currentSettings = next;
      // Apply directly instead of waiting for the storage-event round-trip
      // (which this same tab may never see) — applyState is idempotent.
      await applyState(next);
    });
    document.body.appendChild(nativeChipEl);
  }

  function removeNativeChip() {
    if (nativeChipEl) {
      nativeChipEl.remove();
      nativeChipEl = null;
    }
  }

  // header/main/footer#footer is IRK's own top-level page shell (verified
  // live — see ARCHITECTURE.md) — same idea as usos/inject.js's
  // hideNative/showNative for usos-layout/top-scroller.
  const NATIVE_SELECTORS = ['header', 'main', 'footer#footer'];
  function hideNative() {
    NATIVE_SELECTORS.forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) el.classList.add('usospp-host-hidden');
    });
  }
  function showNative() {
    NATIVE_SELECTORS.forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) el.classList.remove('usospp-host-hidden');
    });
  }

  function ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.id = 'usospp-irk-container';
    document.body.appendChild(container);
    container.addEventListener('usospp-irk:settings', onAppSettingsEvent);
    return container;
  }

  async function onAppSettingsEvent(e) {
    const { disable, irkFavorites } = e.detail || {};
    if (disable) await setState({ irkEnabled: false });
    if (irkFavorites) await setState({ irkFavorites });
  }

  async function mountDashboard() {
    try {
      hideNative();
      const el = ensureContainer();
      const slug = adapters.recruitmentSlug();
      console.info('[USOS++] mounting IRK dashboard, slug =', slug);
      const data = await scrape.collectAll(slug);
      app = window.USOSPP_IRK_APP.mount(el, data, { darkMode: currentSettings.darkMode, irkFavorites: currentSettings.irkFavorites || [] });
    } catch (e) {
      // A thrown error here previously left hideNative() applied with no
      // container ever appended — page looked "frozen blank" instead of
      // failing loudly, which is worse than the classic page staying up.
      console.error('[USOS++] IRK dashboard failed to mount:', e);
      showNative();
    }
  }

  function unmountDashboard() {
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

  // Same <html>-canvas theming as usos/inject.js's syncCanvasTheme (see its
  // comment) — IRK shares core/ui/design-system.css, so the same
  // html[data-usospp-theme] rules apply here.
  function syncCanvasTheme() {
    try {
      if (app) document.documentElement.dataset.usosppTheme = currentSettings && currentSettings.darkMode ? 'dark' : 'light';
      else delete document.documentElement.dataset.usosppTheme;
    } catch (e) { /* cosmetic only */ }
  }

  // Same whole-extension kill switch as usos/inject.js's applyState — see
  // its comment. `irkEnabled` in storage is left untouched when the plugin
  // is off, so re-enabling it restores whatever was on before.
  async function applyState(settings) {
    currentSettings = settings;
    const active = settings.pluginEnabled !== false;
    const irkOn = active && settings.irkEnabled && !isBypassed() && !isAuthPage;
    if (irkOn) {
      if (!app) await mountDashboard();
      else app.updateSettings({ darkMode: settings.darkMode, irkFavorites: settings.irkFavorites || [] });
      syncCanvasTheme();
    } else if (app || container) {
      unmountDashboard();
    }
    // Bypassed tab (and otherwise switched on): the chip is the only
    // in-tab return path, so it shows regardless of any feature flag —
    // except under the whole-plugin kill switch, which hides everything.
    if (isBypassed() && active && settings.irkEnabled) ensureNativeChip();
    else removeNativeChip();
  }

  // Same bypass usos/inject.js supports — a "otwórz w IRK" link needs to
  // actually show classic IRK, even with the dashboard globally enabled for
  // the domain (see irk/app.js's withUsospOff). ?usospp_off=1 plants the
  // sticky per-tab native flag, so onward navigations in this tab stay
  // classic until the floating chip clears it — without touching the stored
  // (global, cross-tab) `irkEnabled` setting.
  if (new URLSearchParams(location.search).has('usospp_off')) writeNativeTabFlag(true);
  const bypassThisLoad = isBypassed();

  // /pl/auth/login/, /pl/auth/register/…, and (verified live — this one
  // path alone skips the /pl/ prefix) /auth/logout/ all render with IRK's
  // shared header/footer/title, so looksLikeIrk() (and therefore
  // detectPlatform()) matches them same as any other IRK page. Mounting the
  // dashboard on top of the actual login FORM hid the real e-mail/password
  // fields behind our own shell — and since that page's URL has no
  // recruitment slug in it, the shell showed "Nie wybrano rekrutacji", so
  // clicking through it re-selected a recruitment INSTEAD of ever reaching
  // the login form. Bug report (2026-09-14): a candidate who first picked a
  // recruitment, then hit a protected view's "Zaloguj się →" button, got
  // stuck looping back to "pick a recruitment" and could never actually log
  // in. Native IRK needs to render itself, unmodified, on these pages —
  // once login/registration/logout completes, IRK's own redirect lands back
  // on a normal page where USOS++ re-mounts fresh, same as any other
  // navigation. (isAuthPage itself is defined next to the bypass helpers
  // above, since applyState also needs it.)
  const bypassedAtLoad = bypassThisLoad || isAuthPage;

  (async () => {
    const settings = await getState();
    console.info('[USOS++] initial settings, irkEnabled =', settings.irkEnabled, bypassedAtLoad ? `(bypassed via ${isAuthPage ? 'auth page' : 'usospp_off'})` : '');
    await applyState(settings);
  })();

  onStateChange(async () => {
    // Live check (not the load-time const): the native chip clears the tab
    // flag and this same tab must then pick up the change.
    if (isBypassed()) return;
    const settings = await getState();
    console.info('[USOS++] settings changed, irkEnabled =', settings.irkEnabled);
    await applyState(settings);
  });
})();

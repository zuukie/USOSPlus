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
    const { disable } = e.detail || {};
    if (disable) await setState({ irkEnabled: false });
  }

  async function mountDashboard() {
    try {
      hideNative();
      const el = ensureContainer();
      const slug = adapters.recruitmentSlug();
      console.info('[USOS++] mounting IRK dashboard, slug =', slug);
      const data = await scrape.collectAll(slug);
      app = window.USOSPP_IRK_APP.mount(el, data, { darkMode: currentSettings.darkMode });
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
  }

  async function applyState(settings) {
    currentSettings = settings;
    if (settings.irkEnabled) {
      if (!app) await mountDashboard();
      else app.updateSettings({ darkMode: settings.darkMode });
    } else if (app || container) {
      unmountDashboard();
    }
  }

  // Same bypass usos/inject.js supports — a "otwórz w IRK" link needs to
  // actually show classic IRK for that one load, even with the dashboard
  // globally enabled for the domain (see irk/app.js's withUsospOff).
  const bypassParam = new URLSearchParams(location.search).has('usospp_off');

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
  // navigation.
  const isAuthPage = /^\/(?:pl\/)?auth\//.test(location.pathname);
  const bypassThisLoad = bypassParam || isAuthPage;

  (async () => {
    const settings = await getState();
    console.info('[USOS++] initial settings, irkEnabled =', settings.irkEnabled, bypassThisLoad ? `(bypassed via ${isAuthPage ? 'auth page' : 'usospp_off'})` : '');
    await applyState(bypassThisLoad ? { ...settings, irkEnabled: false } : settings);
  })();

  onStateChange(async () => {
    if (bypassThisLoad) return;
    const settings = await getState();
    console.info('[USOS++] settings changed, irkEnabled =', settings.irkEnabled);
    await applyState(settings);
  });
})();

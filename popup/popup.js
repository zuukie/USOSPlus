import { getState, setState } from '../core/state.js';

// Grouped by *when* each feature actually does something — see inject.js's
// applyIndependentFeatures for the code these hints describe.
const FEATURE_GROUPS = [
  {
    label: 'Wymagają włączonego panelu USOS++',
    keys: {
      keyboardNav: ['Nawigacja klawiaturą', 'Skróty 1–9 do przełączania sekcji w USOS++'],
      autorefresh: ['Automatyczne odświeżanie danych', 'Dane odświeżają się bez przeładowania strony'],
      gradeBadge: ['Odznaka średniej na ikonie', 'Aktualizuje się, gdy USOS++ jest włączony'],
    },
  },
  {
    label: 'Działają niezależnie od panelu USOS++',
    keys: {
      quickbar: ['Szybkie akcje w toolbarze', 'Widoczne w klasycznym USOS, gdy USOS++ jest wyłączony'],
      classicWidgets: ['Widżety na stronach klasycznych', 'Średnia w Ocenach, zaległości w Płatnościach, licznik zajęć w Planie i podsumowanie w Mój USOSweb'],
    },
  },
];
const FEATURE_META = Object.assign({}, ...FEATURE_GROUPS.map((g) => g.keys));

const QUICK_ACTIONS = [
  { key: 'plan', label: 'Plan', view: 'plan', path: 'kontroler.php?_action=home/plan' },
  { key: 'oceny', label: 'Oceny', view: 'oceny', path: 'kontroler.php?_action=dla_stud/studia/oceny/index' },
  { key: 'egzaminy', label: 'Egzaminy', view: 'egzaminy', path: 'kontroler.php?_action=dla_stud/rejestracja/egzaminy' },
  { key: 'ustawienia', label: 'Ustaw.', view: 'ustawienia', path: 'kontroler.php?_action=home/index' },
];

// USOS++ mark per the brand system: a rounded orange tile with two bold white
// "+" glyphs. The popup's brand logo renders at 26px, just under the 32px
// threshold where the brand system switches to the "compact" variant (wider
// gap between the two pluses so they don't visually merge at small sizes).
const LOGO_TILE_COMPACT = '<rect x="0" y="0" width="100" height="100" rx="18" fill="#d9773a"/><rect x="26.42" y="37.75" width="6.66" height="18.5" rx="1.87" fill="#fff"/><rect x="20.5" y="43.67" width="18.5" height="6.66" rx="1.87" fill="#fff"/><rect x="66.92" y="37.75" width="6.66" height="18.5" rx="1.87" fill="#fff"/><rect x="61" y="43.67" width="18.5" height="6.66" rx="1.87" fill="#fff"/>';
function logoSvg() {
  return `<svg viewBox="0 0 100 100" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">${LOGO_TILE_COMPACT}</svg>`;
}

const appEl = document.getElementById('app');

// Runs the SAME check as irk/detect.js's looksLikeIrk, but directly in the
// tab via chrome.scripting (activeTab covers this without needing the user
// to have granted anything yet — opening the popup is itself the qualifying
// user gesture). Checking only tab.title/tab.url (as an earlier version of
// this did) isn't enough: IRK's own pages carry a per-section title like
// "Oferta - IRK" or "Aktualności - IRK" — only the site's root page happens
// to have the full "Internetowa Rekrutacja Kandydatów" phrase in its title,
// so every other page silently failed to detect (found live on
// /pl/offer/<slug>/, where the phrase only remains in the footer, not the
// title). Duplicated here (rather than shared) because chrome.scripting's
// `func` runs with no closure over this file's scope — must be self
// contained. Keep this in sync with irk/detect.js's NAME_RE.
async function detectIrkOnTab(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const NAME_RE = /Internetow\w*\s+Rekrutacj\w*\s+Kandydat/i;
        if (NAME_RE.test(document.title || '')) return true;
        const footer = document.querySelector('#footer, footer');
        if (footer && NAME_RE.test(footer.textContent || '')) return true;
        const header = document.querySelector('header');
        if (header && NAME_RE.test(header.textContent || '')) return true;
        return false;
      },
    });
    return !!result;
  } catch (e) {
    return false;
  }
}

let state = null;
let view = 'main';
let tab = null;
let hasHostPermission = false;
let looksLikeUsos = false;
let looksLikeIrk = false;
let snapshot = null;
let busy = false;
// Set when a previous addUniversity/toggleIrkEnabled attempt's
// usospp:registerUniversity round-trip came back { ok: false } — background.js's
// registerModule can genuinely fail (a permission grant it doesn't see yet,
// moments after chrome.permissions.request resolved — see its own retry
// comment) and used to do so in total silence, with neither side checking the
// result: the tab would just reload back into classic USOS with nothing
// having changed and no error anywhere the user would think to look.
let actionError = null;
// Which action the "Spróbuj ponownie" link re-runs — the one that originally
// failed (addUniversity for a failed "Dodaj obsługę…", toggleEnabled when
// enabling failed deeper in its own flow), so retrying reproduces what the
// user actually clicked for instead of a look-alike action that would end in
// a slightly different state.
let actionErrorRetry = 'addUniversity';

function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `*://${u.hostname}/*`;
  } catch (e) {
    return null;
  }
}

async function detectTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = activeTab || null;
  hasHostPermission = false;
  looksLikeUsos = false;
  looksLikeIrk = false;
  if (tab && tab.url) {
    const pattern = originPatternFor(tab.url);
    if (pattern) {
      try {
        hasHostPermission = await chrome.permissions.contains({ origins: [pattern] });
      } catch (e) {
        hasHostPermission = false;
      }
    }
    // A hostname like "irk.usos.pwr.edu.pl" contains "usos" too, so the IRK
    // check (a specific system name, checked against the real DOM) takes
    // priority over this generic substring one wherever both flags end up
    // set — see render()'s `irkView`.
    looksLikeUsos = /usos/i.test(tab.url) || /usos/i.test(tab.title || '');
    looksLikeIrk = await detectIrkOnTab(tab.id);
  }
}

function fetchSnapshot() {
  if (!tab) return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: 'usospp:getSnapshot' }, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp || null);
    });
  });
}

// True only when this tab is actually running our content script — the
// end-side listener (usos/inject.js's 'usospp:ping') answers regardless of
// the panel being on or off, so a response cleanly separates "script is
// there, just disabled" from "script never injected at all".
// toggleEnabled uses that split to keep the verified live-toggle path (PWr's
// static content scripts, and any dynamically-added university whose
// registration survived) reload-free, and to re-register + reload only on a
// tab whose registration is genuinely missing.
function pingTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'usospp:ping' }, (resp) => {
      resolve(!chrome.runtime.lastError && !!resp);
    });
  });
}

async function init() {
  state = await getState();
  await detectTab();
  if (tab && hasHostPermission && looksLikeUsos) snapshot = await fetchSnapshot();
  render();
}

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function switchHtml(on, key) {
  return `<div class="pp-switch ${on ? 'on' : ''}" data-toggle-feature="${key}"><div class="pp-switch-knob"></div></div>`;
}

function render() {
  const dark = state.darkMode;
  // The features subview only ever applies to the USOS toggles in
  // FEATURE_GROUPS, so an IRK-looking tab always gets its own small
  // header+body instead of being routed through view === 'features'.
  const irkView = !!(tab && looksLikeIrk);
  appEl.innerHTML = `
    <div class="pp-root" data-theme="${dark ? 'dark' : 'light'}">
      ${view === 'features' ? renderFeaturesHeader() : irkView ? renderIrkHeader() : renderMainHeader()}
      ${view === 'features' ? renderFeaturesBody() : irkView ? renderIrkBody() : renderMainBody()}
      ${renderFooter()}
    </div>
  `;
  bindEvents();
}

function renderMainHeader() {
  const enabled = state.enabled;
  return `
    <div class="pp-header">
      <div class="pp-brand">
        <div class="pp-logo">${logoSvg()}</div>
        <div class="pp-brand-text">USOS<span>++</span></div>
      </div>
      <div class="pp-status-pill">
        <span class="pp-status-dot" style="background:${enabled ? 'oklch(58% 0.13 150)' : 'var(--ink-3)'};"></span>
        ${enabled ? 'Aktywne' : 'Nieaktywne'}
      </div>
    </div>
  `;
}

// IRK equivalent of renderMainHeader. Before the origin is added there's
// nothing to toggle yet, so the pill just says "wykryto"; once added, it
// reflects state.irkEnabled the same way renderMainHeader's pill reflects
// state.enabled.
function renderIrkHeader() {
  const known = hasHostPermission;
  const on = known && state.irkEnabled;
  return `
    <div class="pp-header">
      <div class="pp-brand">
        <div class="pp-logo">${logoSvg()}</div>
        <div class="pp-brand-text">USOS<span>++</span></div>
      </div>
      <div class="pp-status-pill">
        <span class="pp-status-dot" style="background:${on ? 'oklch(58% 0.13 150)' : 'var(--ink-3)'};"></span>
        ${!known ? 'IRK · wykryto' : on ? 'Aktywne' : 'Nieaktywne'}
      </div>
    </div>
  `;
}

function renderFeaturesHeader() {
  return `
    <div class="pp-header">
      <div class="pp-back" data-action="goMain">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="var(--ink)" stroke-width="1.8"><path d="M12.5 5L7 10l5.5 5"></path></svg>
        <div class="pp-back-title">Funkcje</div>
      </div>
    </div>
  `;
}

function renderMainBody() {
  const enabled = state.enabled;

  let banner = '';
  if (actionError) {
    banner = `
      <div class="pp-unsupported-banner">
        <span>⚠️</span>
        <div>
          ${esc(actionError)}
          <div style="margin-top:6px;"><a data-action="${actionErrorRetry}" data-module="usos">Spróbuj ponownie →</a></div>
        </div>
      </div>
    `;
  } else if (tab && !hasHostPermission && looksLikeUsos) {
    banner = `
      <div class="pp-unsupported-banner">
        <span>🎓</span>
        <div>
          Ta karta wygląda jak USOSweb innej uczelni (${esc(new URL(tab.url).hostname)}).
          <div style="margin-top:6px;"><a data-action="addUniversity" data-module="usos">Dodaj obsługę tej uczelni →</a></div>
        </div>
      </div>
    `;
  }

  const stats = snapshot
    ? `
      <div class="pp-stat-grid">
        <div class="pp-stat-card">
          <div class="pp-stat-label">Średnia (widoczne oceny)</div>
          <div class="pp-stat-value">${snapshot.avg || '—'}</div>
          <div class="pp-stat-hint">${snapshot.gradeCount ? `${snapshot.gradeCount} ocen` : 'brak ocen'}</div>
        </div>
        <div class="pp-stat-card">
          <div class="pp-stat-label">Etap studiów</div>
          <div class="pp-stat-value" style="font-size:14px;">${snapshot.etap ? esc(snapshot.etap.label) : '—'}</div>
          <div class="pp-stat-hint">${snapshot.etap ? esc(snapshot.etap.status || '') : 'brak danych'}</div>
        </div>
      </div>
    `
    : '';

  const nextInfo = snapshot
    ? `
      <div>
        <div class="pp-section-heading">Stan danych</div>
        <div class="pp-list-item">
          <div class="pp-list-bar" style="background:oklch(55% 0.15 45);"></div>
          <div>
            <div class="pp-list-title">${snapshot.planEventCount || 0} poz. w planie · ${snapshot.examCount || 0} egzaminów</div>
            <div class="pp-list-sub">${snapshot.user && snapshot.user.name ? esc(snapshot.user.name) : 'Nie rozpoznano użytkownika'}</div>
          </div>
        </div>
      </div>
    `
    : '';

  return `
    <div class="pp-body">
      ${banner}
      <button class="pp-main-btn ${enabled ? 'on' : 'off'}" data-action="toggleEnabled" ${tab ? '' : 'disabled'}>
        <span style="display:flex;">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 3v6"></path><path d="M5.5 5.8a6.5 6.5 0 1 0 9 0"></path></svg>
        </span>
        ${enabled ? 'Wyłącz panel USOS++' : 'Włącz panel USOS++'}
      </button>

      ${stats}
      ${nextInfo}

      <div style="margin-top:8px;">
        <div class="pp-section-heading">Szybki dostęp</div>
        ${!state.myUniversity ? `
          <div class="pp-my-uni-hint">
            Wejdź na stronę swojej uczelni i kliknij <a data-action="setMyUniversity">tutaj</a>, aby ustawić ją jako Moja Uczelnia
          </div>
        ` : `
          <div class="pp-quick-home" data-action="quickHome">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12"></polyline></svg>
            <span>Strona główna mojej uczelni</span>
          </div>
        `}
        <div class="pp-quick-grid">
          ${QUICK_ACTIONS.map((qa) => `
            <div class="pp-quick-action ${!state.myUniversity ? 'disabled' : ''}" data-action="quick" data-view="${qa.view}" data-path="${qa.path}">
              <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7"></circle></svg>
              <span>${qa.label}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="pp-manage-row" data-action="goFeatures">
        <span>Zarządzaj funkcjami</span>
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="var(--ink-3)" stroke-width="2"><path d="M7.5 5l5.5 5-5.5 5"></path></svg>
      </div>
    </div>
  `;
}

// Before hasHostPermission, same opt-in flow as "Dodaj obsługę tej uczelni"
// above but registering the 'irk' file set (see background.js's
// registerModule) instead of 'usos'. After that, a real toggle — irk/app.js
// shows the full dashboard (Oferta/Aktualności/Jednostki + Zgłoszenia,
// Formularze, Płatności, Wiadomości i Konto po zalogowaniu).
function renderIrkBody() {
  const errorBanner = actionError ? `
    <div class="pp-unsupported-banner">
      <span>⚠️</span>
      <div>
        ${esc(actionError)}
        <div style="margin-top:6px;"><a data-action="${actionErrorRetry}" data-module="irk">Spróbuj ponownie →</a></div>
      </div>
    </div>
  ` : '';
  if (!hasHostPermission) {
    return `
      <div class="pp-body">
        ${errorBanner}
        <div class="pp-unsupported-banner">
          <span>🎓</span>
          <div>
            Ta karta wygląda jak IRK (Internetowa Rekrutacja Kandydatów)${tab && tab.url ? ` — ${esc(new URL(tab.url).hostname)}` : ''}.
            <div style="margin-top:6px;"><a data-action="addUniversity" data-module="irk">Dodaj obsługę tej uczelni (IRK) →</a></div>
          </div>
        </div>
        <div class="pp-empty">Oferta, aktualności i jednostki bez logowania; zgłoszenia, formularze, płatności, wiadomości i konto — po zalogowaniu na konto kandydata.</div>
      </div>
    `;
  }
  const enabled = state.irkEnabled;
  return `
    <div class="pp-body">
      ${errorBanner}
      <button class="pp-main-btn ${enabled ? 'on' : 'off'}" data-action="toggleIrkEnabled">
        <span style="display:flex;">
          <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 3v6"></path><path d="M5.5 5.8a6.5 6.5 0 1 0 9 0"></path></svg>
        </span>
        ${enabled ? 'Wyłącz panel USOS++ (IRK)' : 'Włącz panel USOS++ (IRK)'}
      </button>
      <div class="pp-main-hint">${enabled ? 'Klasyczny IRK jest zastąpiony dashboardem — oferta, aktualności, jednostki oraz (po zalogowaniu) zgłoszenia, formularze, płatności, wiadomości i konto' : 'Przełącz aktualną kartę IRK na dashboard USOS++'}</div>
      <div class="pp-empty">Sekcje konta kandydata wymagają zalogowania w IRK; oferta, aktualności i jednostki działają anonimowo.</div>
    </div>
  `;
}

function renderFeaturesBody() {
  const f = state.features;
  return `
    <div class="pp-body">
      ${state.myUniversity ? `
        <div style="margin-bottom:14px;">
          <div class="pp-section-heading">Moja Uczelnia</div>
          <div class="pp-manage-row">
            <span style="font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(state.myUniversity)}</span>
            <div class="pp-dark-toggle" data-action="removeMyUniversity" style="color:var(--ink-critical); font-weight:600; font-size:11px;">Usuń</div>
          </div>
        </div>
      ` : ''}
      <div>
        <div class="pp-section-heading">Rozszerzenie</div>
        <div class="pp-features-list">
          <div class="pp-feature-row">
            <div>
              <div class="pp-feature-label">Wyłącz wtyczkę</div>
              <div class="pp-feature-hint">Wyłącza panel USOS++, IRK i wszystkie funkcje niezależne (pasek szybkich akcji, widżety, odświeżanie) na wszystkich stronach</div>
            </div>
            ${switchHtml(state.pluginEnabled, '__plugin')}
          </div>
        </div>
      </div>
      ${FEATURE_GROUPS.map((group) => `
        <div>
          <div class="pp-section-heading">${esc(group.label)}</div>
          <div class="pp-features-list">
            ${Object.keys(group.keys).map((key) => `
              <div class="pp-feature-row">
                <div>
                  <div class="pp-feature-label">${esc(group.keys[key][0])}</div>
                  <div class="pp-feature-hint">${esc(group.keys[key][1])}</div>
                </div>
                ${switchHtml(f[key], key)}
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderFooter() {
  const dark = state.darkMode;
  return `
    <div class="pp-footer">
      <div class="pp-dark-toggle" data-action="toggleDark">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="var(--ink-2)" stroke-width="1.7"><path d="M16 11.5A6.5 6.5 0 1 1 8.5 4a5.2 5.2 0 0 0 7.5 7.5z"></path></svg>
        <span>Tryb ciemny</span>
        ${switchHtml(dark, '__dark')}
      </div>
      <div class="pp-settings-icon" data-action="openExtensionPage">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="2.4"></circle><path d="M10 2.5v2.2M10 15.3v2.2M17.5 10h-2.2M4.7 10H2.5M15 5l-1.5 1.5M6.5 13.5L5 15M15 15l-1.5-1.5M6.5 6.5L5 5"></path></svg>
      </div>
    </div>
  `;
}

function bindEvents() {
  appEl.querySelectorAll('[data-toggle-feature]').forEach((el) => {
    el.addEventListener('click', async () => {
      const key = el.dataset.toggleFeature;
      if (key === '__dark') {
        state = await setState({ darkMode: !state.darkMode });
      } else if (key === '__plugin') {
        state = await setState({ pluginEnabled: !state.pluginEnabled });
      } else {
        state = await setState({ features: { ...state.features, [key]: !state.features[key] } });
      }
      render();
    });
  });

  appEl.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => onAction(el));
  });
}

async function onAction(el) {
  const action = el.dataset.action;
  if (busy) return;

  if (action === 'goFeatures') { view = 'features'; render(); return; }
  if (action === 'goMain') { view = 'main'; render(); return; }
  if (action === 'toggleDark') { state = await setState({ darkMode: !state.darkMode }); render(); return; }
  if (action === 'removeMyUniversity') { state = await setState({ myUniversity: null }); render(); return; }
  if (action === 'setMyUniversity') {
    if (!tab || !tab.url) return;
    const origin = new URL(tab.url).origin;
    state = await setState({ myUniversity: origin });
    render();
    return;
  }
  if (action === 'quickHome') {
    if (!state.myUniversity) return;
    chrome.tabs.create({ url: `${state.myUniversity}/` });
    window.close();
    return;
  }

  if (action === 'openExtensionPage') {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    return;
  }

  if (action === 'toggleEnabled') {
    if (!tab) return;
    const next = !state.enabled;
    if (!next) {
      state = await setState({ enabled: false });
      snapshot = null;
      render();
      return;
    }
    busy = true;
    const alive = await pingTab(tab.id);
    // Happy path — our content script is already running in this tab (PWr's
    // static install, or a dynamically-added university whose registration
    // is live): inject.js reacts to the storage change alone and mounts
    // without a reload, same as before this handler grew the recovery path.
    if (alive) {
      state = await setState({ enabled: true });
      render();
      setTimeout(async () => {
        snapshot = await fetchSnapshot();
        busy = false;
        render();
      }, 700);
      return;
    }
    const pattern = tab.url ? originPatternFor(tab.url) : null;
    if (!looksLikeUsos || !pattern) {
      // Not a USOSweb-looking tab: the toggle is only the stored preference
      // here (nothing on this tab could ever react to it right now), so it
      // stays the plain live flip it always was.
      state = await setState({ enabled: true });
      busy = false;
      render();
      return;
    }
    // USOSweb-looking tab with NO content script answering: this university
    // was never added, or it was added but its dynamic registration is gone
    // or never actually happened (registerModule's permission-race failure
    // was silent, and once the host permission IS granted, "Dodaj obsługę"
    // can't come back — hasHostPermission gates it — leaving the toggle a
    // permanent no-op). So: (re-)request the permission (no prompt when
    // already granted), (re-)register via the background worker, and only
    // then flip the flag and reload the tab. Anything that fails keeps the
    // popup open with a "Spróbuj ponownie" banner instead of the old silence.
    actionError = null;
    actionErrorRetry = 'toggleEnabled';
    render();
    try {
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) {
        actionError = 'Nie udzielono pozwolenia dla tej strony.';
        return;
      }
      hasHostPermission = true; // see addUniversity: keep the popup's state in step with the grant
      const result = await chrome.runtime.sendMessage({ type: 'usospp:registerUniversity', originPattern: pattern, module: 'usos' });
      if (!result || !result.ok) {
        actionError = 'Nie udało się włączyć panelu USOS++.';
        return;
      }
      state = await setState({ enabled: true });
      await chrome.tabs.reload(tab.id);
      window.close();
    } finally {
      busy = false;
      render();
    }
    return;
  }

  if (action === 'toggleIrkEnabled') {
    if (!tab) return;
    const next = !state.irkEnabled;
    state = await setState({ irkEnabled: next });
    if (!next) {
      render();
      return;
    }
    // Turning it ON: re-register the module for this origin before
    // reloading, not just flip the flag — chrome.scripting's own
    // registration was observed to not reliably survive an unpacked-
    // extension reload (see background.js's REGISTRY_KEY comment), so
    // without this, "Włącz" can silently do nothing if that happened since
    // the domain was first added, with no way for the user to fix it short
    // of re-granting permission from scratch. Idempotent either way, and
    // the tab needs a reload regardless for a freshly (re-)registered
    // content script to actually run.
    busy = true;
    actionError = null;
    render();
    try {
      const pattern = originPatternFor(tab.url);
      if (pattern) {
        const result = await chrome.runtime.sendMessage({ type: 'usospp:registerUniversity', originPattern: pattern, module: 'irk' });
        if (!result || !result.ok) {
          state = await setState({ irkEnabled: false });
          actionError = 'Nie udało się włączyć panelu IRK. Spróbuj ponownie.';
          actionErrorRetry = 'toggleIrkEnabled';
          return;
        }
      }
      await chrome.tabs.reload(tab.id);
      window.close();
    } finally {
      busy = false;
      render();
    }
    return;
  }

  if (action === 'quick') {
    if (!tab) return;
    const qa = QUICK_ACTIONS.find(q => q.view === el.dataset.view);
    if (!qa) return;

    if (state.myUniversity) {
      chrome.tabs.create({ url: `${state.myUniversity}/${qa.path}` });
      window.close();
      return;
    }

    if (hasHostPermission && looksLikeUsos && state.enabled) {
      chrome.tabs.sendMessage(tab.id, { type: 'usospp:navigate', view: el.dataset.view });
      window.close();
    } else if (tab.url && looksLikeUsos) {
      const origin = new URL(tab.url).origin;
      state = await setState({ myUniversity: origin });
      render();
      chrome.tabs.create({ url: `${origin}/${qa.path}` });
      window.close();
    } else {
      actionError = 'Wejdź na stronę swojej uczelni, kliknij jeszcze raz aby ustawić daną uczelnię jako Moja Uczelnia';
      actionErrorRetry = 'quick';
      render();
    }
    return;
  }

  if (action === 'addUniversity') {
    if (!tab || !tab.url) return;
    const pattern = originPatternFor(tab.url);
    if (!pattern) return;
    const module = el.dataset.module || 'usos';
    busy = true;
    actionError = null;
    render();
    try {
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) return;
      // Keep this popup's own view in step with what was just granted —
      // detectTab() only ran at init, so without this, a registration failure
      // right after a grant would render UI for a "not-yet-granted" state
      // that is no longer true (and renderIrkBody's banner used to pick its
      // retry action off exactly this stale flag, see below).
      hasHostPermission = true;
      // registerModule's result used to be ignored here while its failures
      // were silent on its side too (see background.js's retry comment): the
      // tab reloaded as plain classic USOS, the granted permission kept the
      // "Dodaj obsługę" banner from ever coming back (hasHostPermission gates
      // it first), and the user was left stuck with a toggle nothing
      // responds to. A failure now keeps the popup open with a retry banner.
      const result = await chrome.runtime.sendMessage({ type: 'usospp:registerUniversity', originPattern: pattern, module });
      if (!result || !result.ok) {
        actionError = 'Nie udało się dodać obsługi tej uczelni.';
        actionErrorRetry = 'addUniversity';
        return;
      }
      await chrome.tabs.reload(tab.id);
      window.close();
    } finally {
      busy = false;
      render();
    }
  }
}

init();

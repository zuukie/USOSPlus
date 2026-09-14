import { getState, setState } from '../shared/state.js';

// Grouped by *when* each feature actually does something — see inject.js's
// applyIndependentFeatures for the code these hints describe.
const FEATURE_GROUPS = [
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

let state = null;
let view = 'main';
let tab = null;
let isKnownUsos = false;
let looksLikeUsos = false;
let snapshot = null;
let busy = false;

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
  isKnownUsos = false;
  looksLikeUsos = false;
  if (tab && tab.url) {
    const pattern = originPatternFor(tab.url);
    if (pattern) {
      try {
        isKnownUsos = await chrome.permissions.contains({ origins: [pattern] });
      } catch (e) {
        isKnownUsos = false;
      }
    }
    looksLikeUsos = /usos/i.test(tab.url) || /usos/i.test(tab.title || '');
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

async function init() {
  state = await getState();
  await detectTab();
  if (tab && isKnownUsos) snapshot = await fetchSnapshot();
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
  appEl.innerHTML = `
    <div class="pp-root" data-theme="${dark ? 'dark' : 'light'}">
      ${view === 'features' ? renderFeaturesHeader() : renderMainHeader()}
      ${view === 'features' ? renderFeaturesBody() : renderMainBody()}
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
  const onUsosTab = !!(tab && isKnownUsos);

  let banner = '';
  if (tab && !isKnownUsos && looksLikeUsos) {
    banner = `
      <div class="pp-unsupported-banner">
        <span>🎓</span>
        <div>
          Ta karta wygląda jak USOSweb innej uczelni (${esc(new URL(tab.url).hostname)}).
          <div style="margin-top:6px;"><a data-action="addUniversity">Dodaj obsługę tej uczelni →</a></div>
        </div>
      </div>
    `;
  } else if (tab && !isKnownUsos && !looksLikeUsos) {
    banner = `<div class="pp-empty">Otwórz stronę USOSweb swojej uczelni, aby zobaczyć dane i włączyć redesign.</div>`;
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
        ${enabled ? 'Wyłącz USOS++' : 'Włącz USOS++'}
      </button>
      <div class="pp-main-hint">${enabled ? 'Klasyczny USOSweb jest zastąpiony nowym interfejsem' : 'Przełącz aktualną stronę USOSweb na nowy interfejs'}</div>

      ${stats}
      ${nextInfo}

      <div>
        <div class="pp-section-heading">Szybki dostęp</div>
        <div class="pp-quick-grid">
          ${QUICK_ACTIONS.map((qa) => `
            <div class="pp-quick-action" data-action="quick" data-view="${qa.view}" data-path="${qa.path}">
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

function renderFeaturesBody() {
  const f = state.features;
  return `
    <div class="pp-body">
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

  if (action === 'openExtensionPage') {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    return;
  }

  if (action === 'toggleEnabled') {
    if (!tab) return;
    busy = true;
    state = await setState({ enabled: !state.enabled });
    render();
    if (state.enabled) {
      setTimeout(async () => {
        snapshot = await fetchSnapshot();
        busy = false;
        render();
      }, 700);
    } else {
      snapshot = null;
      busy = false;
    }
    return;
  }

  if (action === 'quick') {
    if (!tab) return;
    if (isKnownUsos && state.enabled) {
      chrome.tabs.sendMessage(tab.id, { type: 'usospp:navigate', view: el.dataset.view });
      window.close();
    } else if (tab.url) {
      const origin = new URL(tab.url).origin;
      chrome.tabs.update(tab.id, { url: `${origin}/${el.dataset.path}` });
      window.close();
    }
    return;
  }

  if (action === 'addUniversity') {
    if (!tab || !tab.url) return;
    const pattern = originPatternFor(tab.url);
    if (!pattern) return;
    busy = true;
    try {
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (granted) {
        await chrome.runtime.sendMessage({ type: 'usospp:registerUniversity', originPattern: pattern });
        await chrome.tabs.reload(tab.id);
        window.close();
      }
    } finally {
      busy = false;
    }
  }
}

init();

// The USOS++ IRK dashboard SPA. Same shell pattern as usos/app.js (single
// delegated click listener keyed off data-action, template-string
// rendering) but far smaller: IRK v1 only covers what's realistically
// scrapable and generalizable across universities — Oferta (kierunki) and
// Aktualności. "Terminy"/"Wymagane dokumenty"/"Opłaty" turned out to live on
// the university's own separate recruitment site (rekrutacja.pwr.edu.pl —
// not IRK itself, and not standardized across universities), so those stay
// plain external links rather than being scraped. "Status zgłoszenia" /
// "wyniki kwalifikacji" need a logged-in candidate account to verify against
// real markup — not done yet (see ARCHITECTURE.md) — so they're also left
// as external links for now, clearly not pretending to show real data.
(function () {
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const ICONS = {
    grid: '<rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.5"></rect><rect x="11" y="2.5" width="6.5" height="6.5" rx="1.5"></rect><rect x="2.5" y="11" width="6.5" height="6.5" rx="1.5"></rect><rect x="11" y="11" width="6.5" height="6.5" rx="1.5"></rect>',
    bell: '<path d="M5 8.2a5 5 0 0 1 10 0c0 3.6 1.3 4.8 1.3 4.8H3.7S5 11.8 5 8.2z"></path><path d="M8.2 15.6a1.9 1.9 0 0 0 3.6 0"></path>',
    book: '<rect x="3" y="2.5" width="12" height="15" rx="1.5"></rect><rect x="6" y="4.5" width="9" height="13" rx="1.5" fill="var(--bg-page)"></rect><line x1="8.5" y1="8" x2="12.5" y2="8"></line><line x1="8.5" y1="11" x2="12.5" y2="11"></line>',
    layers: '<path d="M10 3l7 3.6-7 3.6-7-3.6L10 3z"></path><path d="M3 10.4l7 3.6 7-3.6"></path><path d="M3 14l7 3.6 7-3.6"></path>',
    check: '<circle cx="10" cy="10" r="7.2"></circle><path d="M6.8 10.2l2 2 4.2-4.4"></path>',
    close: '<line x1="5" y1="5" x2="15" y2="15"></line><line x1="15" y1="5" x2="5" y2="15"></line>',
  };
  function icon(name, size = 19) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">${ICONS[name] || ''}</svg>`;
  }

  const LOGO_TILE_COMPACT = '<rect x="0" y="0" width="100" height="100" rx="18" fill="#d9773a"/><rect x="26.42" y="37.75" width="6.66" height="18.5" rx="1.87" fill="#fff"/><rect x="20.5" y="43.67" width="18.5" height="6.66" rx="1.87" fill="#fff"/><rect x="66.92" y="37.75" width="6.66" height="18.5" rx="1.87" fill="#fff"/><rect x="61" y="43.67" width="18.5" height="6.66" rx="1.87" fill="#fff"/>';
  function logoSvg() {
    return `<svg viewBox="0 0 100 100" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">${LOGO_TILE_COMPACT}</svg>`;
  }

  const NAV_ITEMS = [
    { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
    { id: 'aktualnosci', label: 'Aktualności', icon: 'bell' },
    { id: 'oferta', label: 'Oferta (kierunki)', icon: 'book' },
  ];
  const VALID_VIEWS = new Set([...NAV_ITEMS.map((i) => i.id), 'programme']);

  const TITLES = {
    dashboard: ['Dashboard', 'Podsumowanie rekrutacji'],
    aktualnosci: ['Aktualności', 'Ogłoszenia z tej rekrutacji'],
    oferta: ['Oferta', 'Kierunki studiów w tej rekrutacji'],
    programme: ['Kierunek', 'Szczegóły z IRK'],
  };

  // Same "stay where you were" reasoning as usos/app.js's VIEW_STORAGE_KEY —
  // sessionStorage survives a reload of the same tab, cleared on tab close.
  const VIEW_STORAGE_KEY = 'usospp_irk_lastView';
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

  // Every "open in classic IRK" link needs this or the redesign (still
  // globally enabled for the domain) just mounts right back on top of
  // whatever page it opens — same fix usos/app.js's withUsospOff applies for
  // USOSweb, and irk/inject.js checks the same query param on load.
  function withUsospOff(url) {
    if (!url) return url;
    return url + (url.includes('?') ? '&' : '?') + 'usospp_off=1';
  }

  class App {
    constructor(root, data, initialSettings) {
      this.root = root;
      this.data = data;
      this.settings = initialSettings; // { darkMode }

      const saved = loadViewState();
      let initialView = 'dashboard';
      let initialProgrammeUrl = null;
      if (saved && VALID_VIEWS.has(saved.view)) {
        if (saved.view === 'programme' && saved.programmeUrl) {
          initialView = 'programme';
          initialProgrammeUrl = saved.programmeUrl;
        } else if (saved.view !== 'programme') {
          initialView = saved.view;
        }
      }

      this.state = {
        view: initialView,
        dismissedBetaViews: [],
        programmeUrl: initialProgrammeUrl,
        programmeLoading: initialView === 'programme',
        programmeError: false,
        programmeData: null,
        // Set instead of programmeData when the opened URL turns out to be
        // a multi-variant kierunek's hub page rather than a single
        // programme — see fetchProgramme/adapter.getFieldVariants.
        fieldData: null,
        oferaSearch: '',
        oferaUnitFilter: '',
        // 'idle' | 'loading' | 'done' | 'error' — see ensureOfertaEnriched.
        oferaEnrichStatus: 'idle',
        unitByUrl: {},
      };
      this._onClick = this.handleClick.bind(this);
      this._onInput = this.handleInput.bind(this);
      this._onChange = this.handleChange.bind(this);
      this.root.addEventListener('click', this._onClick);
      // Only `input`/`change` on the two Oferta filter controls — see
      // setOfertaResults/setOfertaUnitSelect, which patch just their own
      // subtree instead of going through the full render() a plain
      // setState() would do, so typing in the search box doesn't lose
      // cursor position on every keystroke (same reasoning as
      // usos/app.js's setSearchState).
      this.root.addEventListener('input', this._onInput);
      this.root.addEventListener('change', this._onChange);
      if (initialView === 'programme' && initialProgrammeUrl) this.fetchProgramme(initialProgrammeUrl);
      if (initialView === 'oferta') this.ensureOfertaEnriched();
    }

    destroy() {
      this.root.removeEventListener('click', this._onClick);
      this.root.removeEventListener('input', this._onInput);
      this.root.removeEventListener('change', this._onChange);
    }

    setState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      this.render();
    }

    updateSettings(settings) {
      this.settings = settings;
      this.render();
    }

    navigate(view) {
      this.setState({ view });
      this.persistViewState();
      if (view === 'oferta') this.ensureOfertaEnriched();
    }

    // Patches just the Oferta results list — used by both the search input
    // (fires on every keystroke) and the wydział <select> (fires on
    // selection), so neither one triggers a full render() that would
    // rebuild the search input mid-keystroke and drop focus/cursor.
    setOfertaResults(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-oferta-results]');
      if (el) el.innerHTML = this.renderOfertaResults();
      else this.render();
    }

    // Fetches every visible kierunek's own detail page once (see
    // scrape.fetchUnitsByUrl's comment for why this, not the site's
    // session-based wydział filter) to learn which wydział each belongs to,
    // enabling the wydział filter and the per-row subtitle. Runs once per
    // mount — cheap enough for ~30-40 parallel requests done a single time,
    // not on every Oferta visit.
    async ensureOfertaEnriched() {
      if (this.state.oferaEnrichStatus !== 'idle') return;
      const offer = this.data.offerResult;
      if (!offer || !offer.supported) return;
      this.state.oferaEnrichStatus = 'loading';
      this.patchOfertaUnitSelect();
      const urls = offer.groups.flatMap((g) => g.items.map((it) => it.url));
      try {
        this.state.unitByUrl = await window.USOSPP_IRK_SCRAPE.fetchUnitsByUrl(urls);
        this.state.oferaEnrichStatus = 'done';
      } catch (e) {
        this.state.oferaEnrichStatus = 'error';
      }
      this.patchOfertaUnitSelect();
      const resultsEl = this.root.querySelector('[data-oferta-results]');
      if (resultsEl) resultsEl.innerHTML = this.renderOfertaResults();
    }

    patchOfertaUnitSelect() {
      const el = this.root.querySelector('[data-oferta-unit-select]');
      if (el) el.innerHTML = this.renderOfertaUnitSelect();
    }

    persistViewState() {
      saveViewState({
        view: this.state.view,
        programmeUrl: this.state.view === 'programme' ? this.state.programmeUrl : null,
      });
    }

    openProgramme(url) {
      if (!url) return;
      this.setState({ view: 'programme', programmeUrl: url, programmeLoading: true, programmeError: false, programmeData: null, fieldData: null });
      this.persistViewState();
      this.fetchProgramme(url);
    }

    fetchProgramme(url) {
      const scrape = window.USOSPP_IRK_SCRAPE;
      const adapters = window.USOSPP_IRK_ADAPTERS;
      scrape.fetchDoc(url)
        .then((doc) => {
          if (!doc) { this.setState({ programmeLoading: false, programmeError: true }); return; }
          const detail = adapters.getProgrammeDetail(doc);
          if (detail.supported) { this.setState({ programmeLoading: false, programmeData: detail, fieldData: null }); return; }
          // Not a single programme page — a multi-variant kierunek's hub,
          // most likely (see adapter.getFieldVariants).
          const hub = adapters.getFieldVariants(doc);
          if (hub.supported) this.setState({ programmeLoading: false, fieldData: hub, programmeData: null });
          else this.setState({ programmeLoading: false, programmeError: true });
        })
        .catch(() => this.setState({ programmeLoading: false, programmeError: true }));
    }

    hasUnverifiedProgrammeStatus() {
      return this.state.view === 'programme' && this.state.programmeData && this.state.programmeData.statusSupported && !this.state.programmeData.statusVerified;
    }

    renderBetaNotice() {
      if (this.state.dismissedBetaViews.includes(this.state.view)) return '';
      if (!this.hasUnverifiedProgrammeStatus()) return '';
      return `
        <div class="usospp-beta-notice">
          <span class="usospp-beta-notice-icon">⚠</span>
          <div>USOS++ dla IRK jest w wersji beta — status zapisów na tej stronie nie został jeszcze zweryfikowany na żywej, otwartej turze rekrutacji.</div>
          <button class="usospp-beta-notice-close" data-action="dismissBetaNotice" title="Zamknij">${icon('close', 12)}</button>
        </div>
      `;
    }

    handleClick(e) {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      switch (el.dataset.action) {
        case 'nav':
          this.navigate(el.dataset.view);
          break;
        case 'dismissBetaNotice':
          this.setState((s) => ({ dismissedBetaViews: [...s.dismissedBetaViews, s.view] }));
          break;
        case 'openProgramme':
          this.openProgramme(el.dataset.url);
          break;
        case 'openIrk':
          window.open(withUsospOff(el.dataset.url || location.origin), '_blank', 'noopener');
          break;
        case 'disableUsospp':
          this.emitSettings({ disable: true });
          break;
        default:
          break;
      }
    }

    handleInput(e) {
      const el = e.target.closest('[data-action="oferaSearchInput"]');
      if (!el) return;
      this.setOfertaResults({ oferaSearch: el.value });
    }

    handleChange(e) {
      const el = e.target.closest('[data-action="oferaUnitSelect"]');
      if (!el) return;
      this.setOfertaResults({ oferaUnitFilter: el.value });
    }

    emitSettings(detail) {
      this.root.dispatchEvent(new CustomEvent('usospp-irk:settings', { detail, bubbles: true }));
    }

    render() {
      const [title, subtitle] = TITLES[this.state.view] || [];
      this.root.innerHTML = `
        <div class="usospp-root" data-theme="${this.settings.darkMode ? 'dark' : 'light'}">
          <aside class="usospp-sidebar">
            <div class="usospp-brand">
              <div class="usospp-logo">${logoSvg()}</div>
              <div class="usospp-brand-text">USOS<span>++</span></div>
            </div>
            <nav class="usospp-nav">
              ${NAV_ITEMS.map((item) => `
                <div class="usospp-nav-item ${this.state.view === item.id ? 'active' : ''}" data-action="nav" data-view="${item.id}">
                  ${icon(item.icon, 17)}
                  <span>${esc(item.label)}</span>
                </div>
              `).join('')}
            </nav>
            <div class="usospp-spacer"></div>
            <div class="usospp-nav-item" data-action="disableUsospp">
              ${icon('close', 17)}
              <span>Wyłącz USOS++ (IRK)</span>
            </div>
          </aside>
          <div class="usospp-main">
            <div class="usospp-topbar">
              <div>
                <div class="usospp-title">${esc(title || 'USOS++')}</div>
                <div class="usospp-subtitle">${esc(this.data.recruitmentLabel || subtitle || '')}</div>
              </div>
            </div>
            <div class="usospp-content">
              ${this.renderBetaNotice()}
              <div class="usospp-view">${this.renderView()}</div>
            </div>
          </div>
        </div>
      `;
    }

    renderView() {
      if (this.data.noRecruitmentSelected) return this.renderNoRecruitment();
      switch (this.state.view) {
        case 'dashboard': return this.renderDashboard();
        case 'aktualnosci': return this.renderAktualnosci();
        case 'oferta': return this.renderOferta();
        case 'programme': return this.renderProgramme();
        default: return '';
      }
    }

    renderNoRecruitment() {
      return `
        <div class="usospp-loggedout">
          <div class="usospp-loggedout-logo">${logoSvg()}</div>
          <div class="usospp-loggedout-title">Nie wybrano rekrutacji</div>
          <p class="usospp-loggedout-text">Ta strona IRK obsługuje kilka równoległych rekrutacji naraz. Wybierz jedną z nich w klasycznym IRK, żeby zobaczyć tu dashboard.</p>
          <a class="usospp-btn-primary" data-action="openIrk" data-url="${esc(location.origin)}/pl/offer/registration-select/?next=/pl/home/">Wybierz rekrutację →</a>
        </div>
      `;
    }

    renderDashboard() {
      const offer = this.data.offerResult || { groups: [] };
      const totalCount = offer.groups.reduce((sum, g) => sum + g.items.length, 0);
      const slug = this.data.slug;
      return `
        <div class="usospp-stat-grid">
          <div class="usospp-card">
            <div class="usospp-stat-label">Kierunki w ofercie</div>
            <div class="usospp-stat-value">${totalCount || '—'}</div>
            <div class="usospp-stat-hint">${offer.supported ? 'w tej rekrutacji' : 'nie udało się wczytać oferty'}</div>
          </div>
          <div class="usospp-card">
            <div class="usospp-stat-label">Aktualności</div>
            <div class="usospp-stat-value">${(this.data.newsResult && this.data.newsResult.categories.reduce((n, c) => n + c.items.length, 0)) || '—'}</div>
            <div class="usospp-stat-hint">ogłoszeń w tej rekrutacji</div>
          </div>
        </div>
        <div class="usospp-hub-grid">
          <div class="usospp-hub-tile" data-action="nav" data-view="oferta">
            <div class="usospp-hub-tile-icon">${icon('book')}</div>
            <div class="usospp-hub-tile-title">Oferta — kierunki</div>
            <div class="usospp-hub-tile-desc">Lista kierunków z tej rekrutacji, z podziałem na wydziały i limitami miejsc.</div>
          </div>
          <div class="usospp-hub-tile" data-action="nav" data-view="aktualnosci">
            <div class="usospp-hub-tile-icon">${icon('bell')}</div>
            <div class="usospp-hub-tile-title">Aktualności</div>
            <div class="usospp-hub-tile-desc">Ogłoszenia i komunikaty publikowane w tej rekrutacji.</div>
          </div>
          <div class="usospp-hub-tile" data-action="openIrk" data-url="${esc(location.origin)}/pl/offer/${esc(slug)}/units/">
            <div class="usospp-hub-tile-icon">${icon('layers')}</div>
            <div class="usospp-hub-tile-title">Jednostki →</div>
            <div class="usospp-hub-tile-desc">Wydziały prowadzące rekrutację — otwiera klasyczny IRK (jeszcze nie mamy tu własnego widoku).</div>
          </div>
          <div class="usospp-hub-tile" data-action="openIrk" data-url="${esc(location.origin)}/pl/offer/${esc(slug)}/registration/">
            <div class="usospp-hub-tile-icon">${icon('check')}</div>
            <div class="usospp-hub-tile-title">Status zgłoszenia →</div>
            <div class="usospp-hub-tile-desc">Wymaga zalogowania na konto kandydata — otwiera klasyczny IRK.</div>
          </div>
        </div>
      `;
    }

    renderAktualnosci() {
      const result = this.data.newsResult;
      if (!result || !result.supported) return `<div class="usospp-card"><div class="usospp-empty-hint">Brak aktualności w tej rekrutacji.</div></div>`;
      return result.categories.map((cat) => `
        <div class="usospp-card">
          <div class="usospp-card-head"><div class="usospp-card-title">${esc(cat.label)}</div></div>
          ${cat.items.map((item) => `
            <div class="usospp-list-row">
              <div>
                <div style="font-size:13.5px;font-weight:600;">${item.url ? `<a data-action="openIrk" data-url="${esc(item.url)}">${esc(item.title)}</a>` : esc(item.title)}</div>
              </div>
              ${item.date ? `<div class="usospp-tag-muted">${esc(item.date)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      `).join('');
    }

    renderOferta() {
      const result = this.data.offerResult;
      if (!result || !result.supported) return `<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać oferty.</div></div>`;
      return `
        <div class="usospp-card">
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
            <input class="usospp-input" style="flex:1;min-width:180px;" type="search" placeholder="Szukaj kierunku…" value="${esc(this.state.oferaSearch)}" data-action="oferaSearchInput">
            <div data-oferta-unit-select style="min-width:200px;">${this.renderOfertaUnitSelect()}</div>
          </div>
        </div>
        <div data-oferta-results>${this.renderOfertaResults()}</div>
      `;
    }

    // Every wydział name seen so far in unitByUrl (see ensureOfertaEnriched)
    // — sorted with Polish collation so ą/ć/ł/... land next to their plain
    // letters instead of at the end.
    renderOfertaUnitSelect() {
      const enriching = this.state.oferaEnrichStatus === 'loading';
      const units = [...new Set(Object.values(this.state.unitByUrl).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pl'));
      return `
        <select class="usospp-input" data-action="oferaUnitSelect" ${enriching ? 'disabled' : ''}>
          <option value="">${enriching ? 'Wczytywanie wydziałów…' : 'Wszystkie wydziały'}</option>
          ${units.map((u) => `<option value="${esc(u)}" ${this.state.oferaUnitFilter === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}
        </select>
      `;
    }

    renderOfertaResults() {
      const result = this.data.offerResult;
      const search = this.state.oferaSearch.trim().toLowerCase();
      const unitFilter = this.state.oferaUnitFilter;
      const unitByUrl = this.state.unitByUrl;
      const filtering = !!search || !!unitFilter;

      const totalCount = result.groups.reduce((n, g) => n + g.items.length, 0);
      const groups = result.groups
        .map((group) => ({
          letter: group.letter,
          items: group.items.filter((item) => {
            if (search && !item.name.toLowerCase().includes(search)) return false;
            if (unitFilter && unitByUrl[item.url] !== unitFilter) return false;
            return true;
          }),
        }))
        .filter((g) => g.items.length > 0);
      const visibleCount = groups.reduce((n, g) => n + g.items.length, 0);

      if (!totalCount) return `<div class="usospp-card" style="margin-top:16px;"><div class="usospp-empty-hint">Brak kierunków w tej rekrutacji.</div></div>`;
      if (!visibleCount) {
        return `<div class="usospp-card" style="margin-top:16px;"><div class="usospp-empty-hint">Żaden kierunek nie pasuje do filtrów.</div></div>`;
      }
      return `
        <div class="usospp-muted-text" style="margin:12px 2px;">${filtering ? `${visibleCount} z ${totalCount} kierunków` : `${totalCount} kierunków`}</div>
        <div class="usospp-card">
          ${groups.map((group) => `
            <div class="usospp-eyebrow">${esc(group.letter)}</div>
            ${group.items.map((item) => `
              <div class="usospp-list-row">
                <div>
                  <div style="font-size:13.5px;font-weight:600;"><a data-action="openProgramme" data-url="${esc(item.url)}">${esc(item.name)}</a></div>
                  ${unitByUrl[item.url] ? `<div class="usospp-tag-muted">${esc(unitByUrl[item.url])}</div>` : ''}
                </div>
                ${item.count !== null ? `<div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${item.count}</div>` : ''}
              </div>
            `).join('')}
          `).join('')}
        </div>
      `;
    }

    renderProgramme() {
      const s = this.state;
      if (s.programmeLoading) return `<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie…</div></div>`;
      if (s.fieldData) return this.renderFieldVariants(s.fieldData);
      if (s.programmeError || !s.programmeData) return `<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać tego kierunku.</div></div>`;
      const d = s.programmeData;
      return `
        <a class="usospp-back-link" data-action="nav" data-view="oferta">← Wróć do oferty</a>
        <div class="usospp-card-title" style="font-size:20px;margin-top:6px;">${esc(d.name)}</div>
        ${d.status ? `<div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);margin-top:8px;display:inline-block;">${esc(d.status)}</div>` : ''}
        <table class="usospp-table" style="margin-top:16px;">
          <tbody>
            ${d.fields.map((f) => `<tr><td style="color:var(--ink-3);width:220px;">${esc(f.label)}</td><td>${f.link ? `<a data-action="openIrk" data-url="${esc(f.link)}">${esc(f.value)}</a>` : esc(f.value)}</td></tr>`).join('')}
          </tbody>
        </table>
        ${d.sections.map((sec) => `
          <div class="usospp-card" style="margin-top:16px;">
            <div class="usospp-card-title">${esc(sec.title)}</div>
            <div class="usospp-news-body">${sec.html}</div>
          </div>
        `).join('')}
      `;
    }

    // A kierunek offered in several variants (different campus/city or
    // study mode) — pick one to see its real "Szczegóły" (see
    // fetchProgramme's fallback to adapter.getFieldVariants).
    renderFieldVariants(field) {
      return `
        <a class="usospp-back-link" data-action="nav" data-view="oferta">← Wróć do oferty</a>
        <div class="usospp-card-title" style="font-size:20px;margin-top:6px;">${esc(field.name)}</div>
        <div class="usospp-muted-text" style="margin:8px 0 16px;">Ten kierunek jest oferowany w kilku wariantach — wybierz jeden:</div>
        <div class="usospp-card">
          ${field.variants.map((v) => `
            <div class="usospp-list-row">
              <div style="font-size:13.5px;font-weight:600;"><a data-action="openProgramme" data-url="${esc(v.url)}">${esc(v.name)}</a></div>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  function mount(root, data, settings) {
    const app = new App(root, data, settings);
    app.render();
    return app;
  }

  window.USOSPP_IRK_APP = { mount };
})();

// The USOS++ IRK dashboard SPA. Same shell pattern as usos/app.js (single
// delegated click listener keyed off data-action, template-string
// rendering) but far smaller. Covers what's realistically scrapable and
// generalizable across universities — Oferta (kierunki), Aktualności,
// Jednostki, and (once a logged-in candidate session made it verifiable —
// see adapter.getApplications) Zgłoszenia: status kwalifikacji, decyzje and
// the "Dokumenty i dalsze kroki" checklist per application. "Terminy"/
// "Wymagane dokumenty ogólne"/"Opłaty" still turned out to live on the
// university's own separate recruitment site (rekrutacja.pwr.edu.pl — not
// IRK itself, and not standardized across universities), so those stay
// plain external links rather than being scraped.
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
    lock: '<rect x="5" y="9" width="10" height="7.5" rx="1.5"></rect><path d="M7 9V6.3a3 3 0 0 1 6 0V9"></path>',
    user: '<circle cx="10" cy="7" r="3.2"></circle><path d="M4 16.5c0-3 2.7-5 6-5s6 2 6 5"></path>',
    edit: '<path d="M13.4 3.4a1.8 1.8 0 0 1 2.5 2.5L6.5 15.3l-3.2.7.7-3.2 9.4-9.4z"></path><line x1="11.7" y1="5.1" x2="14.2" y2="7.6"></line>',
    cash: '<rect x="2.3" y="5.5" width="15.4" height="9" rx="1.6"></rect><circle cx="10" cy="10" r="2.1"></circle><line x1="4.6" y1="7.8" x2="4.6" y2="7.8"></line><line x1="15.4" y1="12.2" x2="15.4" y2="12.2"></line>',
    mail: '<rect x="2.3" y="4.5" width="15.4" height="11" rx="1.6"></rect><path d="M3 5.5l7 6 7-6"></path>',
  };
  function icon(name, size = 19) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">${ICONS[name] || ''}</svg>`;
  }

  // Maps an adapter-reported tone ('positive'/'negative'/'warning'/'neutral'
  // /null — see getApplications) onto one of design-system.css's badge
  // color variants, falling back to the plain gray badge for anything
  // unrecognized instead of guessing a color.
  function badgeToneClass(tone) {
    if (tone === 'positive') return 'usospp-badge-positive';
    if (tone === 'negative') return 'usospp-badge-negative';
    if (tone === 'warning') return 'usospp-badge-warning';
    return '';
  }

  const LOGO_TILE_COMPACT = '<rect x="0" y="0" width="100" height="100" rx="18" fill="#d9773a"/><rect x="26.42" y="37.75" width="6.66" height="18.5" rx="1.87" fill="#fff"/><rect x="20.5" y="43.67" width="18.5" height="6.66" rx="1.87" fill="#fff"/><rect x="66.92" y="37.75" width="6.66" height="18.5" rx="1.87" fill="#fff"/><rect x="61" y="43.67" width="18.5" height="6.66" rx="1.87" fill="#fff"/>';
  function logoSvg() {
    return `<svg viewBox="0 0 100 100" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">${LOGO_TILE_COMPACT}</svg>`;
  }

  // Split so the sidebar can show a divider between what works for anyone
  // browsing IRK anonymously and what needs a logged-in candidate session
  // (see adapter.isLoggedIn) — the latter get a lock icon instead of their
  // usual one, and their view shows renderLoginRequired() instead of
  // rendering with data that was never fetched.
  const NAV_ITEMS_PUBLIC = [
    { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
    { id: 'aktualnosci', label: 'Aktualności', icon: 'bell' },
    { id: 'oferta', label: 'Oferta (kierunki)', icon: 'book' },
    { id: 'jednostki', label: 'Jednostki', icon: 'layers' },
  ];
  const NAV_ITEMS_PROTECTED = [
    { id: 'zgloszenia', label: 'Zgłoszenia', icon: 'check' },
    { id: 'formularze', label: 'Formularze osobowe', icon: 'edit' },
    { id: 'platnosci', label: 'Płatności', icon: 'cash' },
    { id: 'wiadomosci', label: 'Wiadomości', icon: 'mail' },
    { id: 'konto', label: 'Moje konto', icon: 'user' },
  ];
  const NAV_ITEMS = [...NAV_ITEMS_PUBLIC, ...NAV_ITEMS_PROTECTED];
  const VALID_VIEWS = new Set([...NAV_ITEMS.map((i) => i.id), 'programme']);

  const TITLES = {
    dashboard: ['Dashboard', 'Podsumowanie rekrutacji'],
    aktualnosci: ['Aktualności', 'Ogłoszenia z tej rekrutacji'],
    oferta: ['Oferta', 'Kierunki studiów w tej rekrutacji'],
    programme: ['Kierunek', 'Szczegóły z IRK'],
    jednostki: ['Jednostki', 'Wydziały prowadzące tę rekrutację'],
    zgloszenia: ['Zgłoszenia', 'Status Twoich zgłoszeń rekrutacyjnych'],
    formularze: ['Formularze osobowe', 'Podgląd danych zgłoszonych do tej rekrutacji'],
    platnosci: ['Płatności', 'Historia operacji finansowych na koncie IRK'],
    wiadomosci: ['Wiadomości', 'Korespondencja z uczelnią'],
    konto: ['Moje konto', 'Ustawienia konta w IRK'],
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
        // Recruitment switcher (sidebar chip + Dashboard card, both open the
        // same modal) — see openRecruitmentPicker/switchRecruitment.
        recruitmentPickerOpen: false,
        recruitmentOptionsStatus: 'idle', // 'idle' | 'loading' | 'done' | 'error'
        recruitmentOptions: null,
        // "Dokumenty i dalsze kroki" per application, fetched lazily the
        // first time its <details> is opened — see ensureNextSteps. Keyed
        // by applicationId: { status: 'idle'|'loading'|'done'|'error', data }.
        applicationNextSteps: {},
        // One "Formularze osobowe" form's fields, fetched lazily the first
        // time its <details> is opened — see ensurePersonalForm. Keyed by
        // the form's own URL: { status: 'idle'|'loading'|'done'|'error', data }.
        personalForms: {},
        // One matura document's "wyniki egzaminów" (see ensureExamScores),
        // keyed by its own examScoresUrl the same way personalForms is keyed
        // by form URL.
        examScores: {},
        // One conversation's messages, fetched lazily the first time its
        // <details> is opened — see ensureMessageThread. Keyed by the
        // conversation's own URL, same shape as personalForms/examScores.
        messageThreads: {},
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

    // "Jednostki" links a wydział straight into Oferta pre-filtered to it,
    // reusing the same oferaUnitFilter/unitByUrl the search box's own wydział
    // <select> already drives — the wydział names on both pages come from
    // the exact same "Wydział X" strings the site uses everywhere, so no
    // extra mapping is needed between the two.
    navigateToOfertaFilteredByUnit(unitName) {
      this.setState({ view: 'oferta', oferaUnitFilter: unitName || '' });
      this.persistViewState();
      this.ensureOfertaEnriched();
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

    // Same scoped-patch reasoning as usos/app.js's setModalState — opening
    // or closing the recruitment picker has nothing to do with whatever view
    // is underneath it.
    setModalState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-modal-root]');
      if (!el) { this.render(); return; }
      el.innerHTML = this.renderModals();
    }

    renderModals() {
      return this.renderRecruitmentPickerModal();
    }

    openRecruitmentPicker() {
      this.setModalState({ recruitmentPickerOpen: true });
      this.ensureRecruitmentOptions();
    }

    closeRecruitmentPicker() {
      this.setModalState({ recruitmentPickerOpen: false });
    }

    // Fetched once per mount (idle-guarded, same shape as
    // ensureOfertaEnriched) — the picker itself is cheap enough to just
    // re-show whatever came back on subsequent opens.
    async ensureRecruitmentOptions() {
      if (this.state.recruitmentOptionsStatus !== 'idle') return;
      this.setModalState({ recruitmentOptionsStatus: 'loading' });
      try {
        const result = await window.USOSPP_IRK_SCRAPE.fetchRecruitmentOptions();
        this.setModalState({ recruitmentOptionsStatus: 'done', recruitmentOptions: result.supported ? result.options : [] });
      } catch (e) {
        this.setModalState({ recruitmentOptionsStatus: 'error' });
      }
    }

    // A real page navigation (see scrape.switchRecruitmentUrl's comment on
    // why this is safe to trigger directly) — the current tab reloads onto
    // the newly selected recruitment, where USOS++ re-detects and re-mounts
    // itself fresh, same as any other IRK navigation.
    switchRecruitment(slug) {
      if (!slug) return;
      location.href = window.USOSPP_IRK_SCRAPE.switchRecruitmentUrl(slug, this.data.slug);
    }

    // Lazily fetches one application's "Dokumenty i dalsze kroki" the first
    // time its <details> is opened (see the "toggleNextSteps" click case) —
    // idle-guarded the same way ensureRecruitmentOptions is, so re-opening
    // an already-loaded (or still-loading) one doesn't refetch.
    async ensureNextSteps(applicationId, url) {
      if (!applicationId || !url) return;
      const current = this.state.applicationNextSteps[applicationId];
      if (current && current.status !== 'idle') return;
      this.patchNextSteps(applicationId, { status: 'loading' });
      try {
        const result = await window.USOSPP_IRK_SCRAPE.fetchApplicationNextSteps(url);
        this.patchNextSteps(applicationId, { status: 'done', data: result });
      } catch (e) {
        this.patchNextSteps(applicationId, { status: 'error' });
      }
    }

    // Patches just this one application's disclosure body — a full render()
    // would rebuild every <details> in the list and collapse the one the
    // visitor just opened.
    patchNextSteps(applicationId, patch) {
      const prev = this.state.applicationNextSteps[applicationId] || { status: 'idle' };
      this.state.applicationNextSteps = {
        ...this.state.applicationNextSteps,
        [applicationId]: { ...prev, ...patch },
      };
      const el = this.root.querySelector(`[data-next-steps-body="${applicationId}"]`);
      if (el) el.innerHTML = this.renderNextStepsBody(applicationId);
      else this.render();
    }

    // Lazily fetches one "Formularze osobowe" form's field values the first
    // time its <details> is opened — same idle-guarded shape as
    // ensureNextSteps, just keyed by the form's own URL instead of an
    // application id.
    async ensurePersonalForm(url) {
      if (!url) return;
      const current = this.state.personalForms[url];
      if (current && current.status !== 'idle') return;
      this.patchPersonalForm(url, { status: 'loading' });
      try {
        const result = await window.USOSPP_IRK_SCRAPE.fetchPersonalForm(url);
        this.patchPersonalForm(url, { status: 'done', data: result });
      } catch (e) {
        this.patchPersonalForm(url, { status: 'error' });
      }
    }

    // Patches just this one form's disclosure body — see patchNextSteps.
    patchPersonalForm(url, patch) {
      const prev = this.state.personalForms[url] || { status: 'idle' };
      this.state.personalForms = { ...this.state.personalForms, [url]: { ...prev, ...patch } };
      const el = this.root.querySelector(`[data-personal-form-body="${url}"]`);
      if (el) el.innerHTML = this.renderPersonalFormBody(url);
      else this.render();
    }

    // Lazily fetches one matura document's exam scores the first time its
    // <details> is opened — same idle-guarded shape as ensurePersonalForm,
    // keyed by the document's own examScoresUrl.
    async ensureExamScores(url) {
      if (!url) return;
      const current = this.state.examScores[url];
      if (current && current.status !== 'idle') return;
      this.patchExamScores(url, { status: 'loading' });
      try {
        const result = await window.USOSPP_IRK_SCRAPE.fetchExamScores(url);
        this.patchExamScores(url, { status: 'done', data: result });
      } catch (e) {
        this.patchExamScores(url, { status: 'error' });
      }
    }

    patchExamScores(url, patch) {
      const prev = this.state.examScores[url] || { status: 'idle' };
      this.state.examScores = { ...this.state.examScores, [url]: { ...prev, ...patch } };
      const el = this.root.querySelector(`[data-exam-scores-body="${url}"]`);
      if (el) el.innerHTML = this.renderExamScoresBody(url);
      else this.render();
    }

    // Lazily fetches one conversation's messages the first time its
    // <details> is opened — same idle-guarded shape as ensureExamScores.
    async ensureMessageThread(url) {
      if (!url) return;
      const current = this.state.messageThreads[url];
      if (current && current.status !== 'idle') return;
      this.patchMessageThread(url, { status: 'loading' });
      try {
        const result = await window.USOSPP_IRK_SCRAPE.fetchMessageThread(url);
        this.patchMessageThread(url, { status: 'done', data: result });
      } catch (e) {
        this.patchMessageThread(url, { status: 'error' });
      }
    }

    patchMessageThread(url, patch) {
      const prev = this.state.messageThreads[url] || { status: 'idle' };
      this.state.messageThreads = { ...this.state.messageThreads, [url]: { ...prev, ...patch } };
      const el = this.root.querySelector(`[data-message-thread-body="${url}"]`);
      if (el) el.innerHTML = this.renderMessageThreadBody(url);
      else this.render();
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
        case 'openRecruitmentPicker':
          this.openRecruitmentPicker();
          break;
        case 'closeRecruitmentPicker':
          this.closeRecruitmentPicker();
          break;
        case 'switchRecruitment':
          this.switchRecruitment(el.dataset.slug);
          break;
        case 'openUnitOferta':
          this.navigateToOfertaFilteredByUnit(el.dataset.unit);
          break;
        case 'toggleNextSteps':
          this.ensureNextSteps(el.dataset.applicationId, el.dataset.url);
          break;
        case 'togglePersonalForm':
          this.ensurePersonalForm(el.dataset.url);
          break;
        case 'toggleExamScores':
          this.ensureExamScores(el.dataset.url);
          break;
        case 'toggleMessageThread':
          this.ensureMessageThread(el.dataset.url);
          break;
        case 'closeModalBackdrop':
          // Only when the backdrop itself was clicked, not something inside
          // the modal card that happens to bubble up to it.
          if (e.target === el) this.closeRecruitmentPicker();
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

    renderNavItem(item, requiresLogin) {
      const locked = requiresLogin && !this.data.loggedIn;
      return `
        <div class="usospp-nav-item ${this.state.view === item.id ? 'active' : ''}" data-action="nav" data-view="${item.id}">
          ${icon(locked ? 'lock' : item.icon, 17)}
          <span>${esc(item.label)}</span>
        </div>
      `;
    }

    // Sits right above "Wyłącz USOS++" — a quick, always-visible answer to
    // "am I logged into IRK right now" without needing to open a protected
    // view first to find out. Clicking it while logged in jumps straight to
    // the in-app "Moje konto" view (see renderKonto); while logged out it
    // follows the exact same loginUrl as renderLoginRequired.
    renderAccountCard() {
      if (this.data.loggedIn) {
        const name = this.data.accountResult && this.data.accountResult.fullName;
        return `
          <div class="usospp-user-card" data-action="nav" data-view="konto" style="margin-bottom:8px;">
            <div class="usospp-avatar" style="background:oklch(55% 0.12 150);">${icon('check', 16)}</div>
            <div class="usospp-user-meta">
              <div class="usospp-user-name">${esc(name || 'Zalogowano')}</div>
              <div class="usospp-user-sub">Konto kandydata w IRK</div>
            </div>
          </div>
        `;
      }
      return `
        <a class="usospp-user-card" href="${esc(this.data.loginUrl || '/pl/auth/login/')}" style="margin-bottom:8px;text-decoration:none;">
          <div class="usospp-avatar" style="background:oklch(38% 0.01 55);">${icon('lock', 16)}</div>
          <div class="usospp-user-meta">
            <div class="usospp-user-name">Niezalogowany</div>
            <div class="usospp-user-sub">Zaloguj się →</div>
          </div>
        </a>
      `;
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
            <div class="usospp-user-card" data-action="openRecruitmentPicker" title="Zmień rekrutację" style="margin-bottom:16px;">
              <div class="usospp-user-meta">
                <div class="usospp-user-sub" style="text-transform:uppercase;font-size:10px;letter-spacing:0.03em;">Rekrutacja</div>
                <div class="usospp-user-name" style="white-space:normal;">${esc(this.data.recruitmentLabel || 'Nie wybrano')}</div>
              </div>
            </div>
            <nav class="usospp-nav">
              ${NAV_ITEMS_PUBLIC.map((item) => this.renderNavItem(item, false)).join('')}
              <div class="usospp-nav-divider"></div>
              ${NAV_ITEMS_PROTECTED.map((item) => this.renderNavItem(item, true)).join('')}
            </nav>
            <div class="usospp-spacer"></div>
            ${this.renderAccountCard()}
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
          <div data-modal-root>${this.renderModals()}</div>
        </div>
      `;
    }

    renderView() {
      if (this.data.noRecruitmentSelected) return this.renderNoRecruitment();
      if (NAV_ITEMS_PROTECTED.some((item) => item.id === this.state.view) && !this.data.loggedIn) {
        return this.renderLoginRequired();
      }
      switch (this.state.view) {
        case 'dashboard': return this.renderDashboard();
        case 'aktualnosci': return this.renderAktualnosci();
        case 'oferta': return this.renderOferta();
        case 'programme': return this.renderProgramme();
        case 'jednostki': return this.renderJednostki();
        case 'zgloszenia': return this.renderZgloszenia();
        case 'formularze': return this.renderFormularze();
        case 'platnosci': return this.renderPlatnosci();
        case 'wiadomosci': return this.renderWiadomosci();
        case 'konto': return this.renderKonto();
        default: return '';
      }
    }

    renderNoRecruitment() {
      return `
        <div class="usospp-loggedout">
          <div class="usospp-loggedout-logo">${logoSvg()}</div>
          <div class="usospp-loggedout-title">Nie wybrano rekrutacji</div>
          <p class="usospp-loggedout-text">Ta strona IRK obsługuje kilka równoległych rekrutacji naraz. Wybierz jedną z nich, żeby zobaczyć tu dashboard.</p>
          <button class="usospp-btn-primary" data-action="openRecruitmentPicker">Wybierz rekrutację →</button>
        </div>
      `;
    }

    // Same wording/shape as usos/app.js's renderLoggedOut (.usospp-loggedout
    // family), adapted to IRK: unlike USOS classic — where being logged out
    // means the ENTIRE dashboard has nothing to show — most of IRK works
    // fine anonymously, so this only replaces the content pane for the one
    // (currently: Zgłoszenia) view that actually needs a candidate session,
    // not the whole app shell.
    renderLoginRequired() {
      return `
        <div class="usospp-loggedout">
          <div class="usospp-loggedout-logo">${logoSvg()}</div>
          <div class="usospp-loggedout-title">Zaloguj się do IRK</div>
          <p class="usospp-loggedout-text">Ta sekcja pokazuje dane z Twojego konta kandydata i wymaga zalogowania.</p>
          ${this.data.loginUrl ? `<a class="usospp-btn-primary" style="display:inline-block;text-decoration:none;" href="${esc(this.data.loginUrl)}">Zaloguj się →</a>` : ''}
        </div>
      `;
    }

    renderDashboard() {
      const offer = this.data.offerResult || { groups: [] };
      const totalCount = offer.groups.reduce((sum, g) => sum + g.items.length, 0);
      const slug = this.data.slug;
      return `
        <div class="usospp-card" style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;">
          <div>
            <div class="usospp-stat-label">Aktualna rekrutacja</div>
            <div class="usospp-card-title" style="margin-top:4px;">${esc(this.data.recruitmentLabel || 'Nie wybrano')}</div>
          </div>
          <button class="usospp-btn-ghost" data-action="openRecruitmentPicker">Zmień rekrutację</button>
        </div>
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
          <div class="usospp-hub-tile" data-action="nav" data-view="jednostki">
            <div class="usospp-hub-tile-icon">${icon('layers')}</div>
            <div class="usospp-hub-tile-title">Jednostki</div>
            <div class="usospp-hub-tile-desc">Wydziały prowadzące tę rekrutację, z liczbą kierunków i linkiem do USOSweb.</div>
          </div>
          <div class="usospp-hub-tile" data-action="nav" data-view="zgloszenia">
            <div class="usospp-hub-tile-icon">${icon(this.data.loggedIn ? 'check' : 'lock')}</div>
            <div class="usospp-hub-tile-title">Zgłoszenia rekrutacyjne</div>
            <div class="usospp-hub-tile-desc">Status kwalifikacji, decyzje i wymagane dokumenty — wymaga zalogowania na konto kandydata.</div>
          </div>
          <div class="usospp-hub-tile" data-action="nav" data-view="formularze">
            <div class="usospp-hub-tile-icon">${icon(this.data.loggedIn ? 'edit' : 'lock')}</div>
            <div class="usospp-hub-tile-title">Formularze osobowe</div>
            <div class="usospp-hub-tile-desc">Podgląd danych zgłoszonych do rekrutacji (dane podstawowe, adres, zdjęcie, wykształcenie) — wymaga zalogowania na konto kandydata.</div>
          </div>
          <div class="usospp-hub-tile" data-action="nav" data-view="platnosci">
            <div class="usospp-hub-tile-icon">${icon(this.data.loggedIn ? 'cash' : 'lock')}</div>
            <div class="usospp-hub-tile-title">Płatności</div>
            <div class="usospp-hub-tile-desc">Historia opłat rekrutacyjnych i wpłat na koncie IRK — wymaga zalogowania na konto kandydata.</div>
          </div>
          <div class="usospp-hub-tile" data-action="nav" data-view="wiadomosci">
            <div class="usospp-hub-tile-icon">${icon(this.data.loggedIn ? 'mail' : 'lock')}</div>
            <div class="usospp-hub-tile-title">Wiadomości</div>
            <div class="usospp-hub-tile-desc">Korespondencja z uczelnią — wymaga zalogowania na konto kandydata.</div>
          </div>
          <div class="usospp-hub-tile" data-action="nav" data-view="konto">
            <div class="usospp-hub-tile-icon">${icon(this.data.loggedIn ? 'user' : 'lock')}</div>
            <div class="usospp-hub-tile-title">Moje konto</div>
            <div class="usospp-hub-tile-desc">Dane konta, zdjęcie, metoda logowania i ustawienia powiadomień — wymaga zalogowania na konto kandydata.</div>
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

      // A wydział filter is only meaningful once unitByUrl has actually
      // loaded — without this, arriving here with a filter already set (see
      // navigateToOfertaFilteredByUnit) would flash "żaden kierunek nie
      // pasuje" for the second or so enrichment takes, since every item's
      // unitByUrl lookup is still empty at that point.
      if (unitFilter && this.state.oferaEnrichStatus === 'loading') {
        return `<div class="usospp-card" style="margin-top:16px;"><div class="usospp-empty-hint">Wczytywanie…</div></div>`;
      }

      if (!totalCount) return `<div class="usospp-card" style="margin-top:16px;"><div class="usospp-empty-hint">Brak kierunków w tej rekrutacji.</div></div>`;
      if (!visibleCount) {
        return `<div class="usospp-card" style="margin-top:16px;"><div class="usospp-empty-hint">Żaden kierunek nie pasuje do filtrów.</div></div>`;
      }
      return `
        <div class="usospp-muted-text" style="margin:12px 2px;">${filtering ? `${visibleCount} z ${totalCount} kierunków` : `${totalCount} kierunków`}</div>
        <div class="usospp-card">
          ${groups.map((group, i) => `
            <div class="usospp-eyebrow" style="${i === 0 ? '' : 'margin-top:20px;'}margin-bottom:8px;">${esc(group.letter)}</div>
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

    renderJednostki() {
      const result = this.data.unitsResult;
      if (!result || !result.supported) return `<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać listy jednostek.</div></div>`;
      return `
        <div class="usospp-card">
          ${result.units.map((u) => {
            const extLinks = [
              ...(u.usosWebUrl ? [{ label: 'USOSweb', url: u.usosWebUrl }] : []),
              ...u.links,
            ];
            return `
              <div class="usospp-list-row">
                <div>
                  <div style="font-size:13.5px;font-weight:600;"><a data-action="openUnitOferta" data-unit="${esc(u.name)}">${esc(u.name)}</a></div>
                  ${extLinks.length ? `<div class="usospp-tag-muted">${extLinks.map((l) => `<a data-action="openIrk" data-url="${esc(l.url)}">${esc(l.label)} →</a>`).join(' · ')}</div>` : ''}
                </div>
                ${u.count !== null ? `<div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${u.count}</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // Verified live (2026-09-14) against a logged-in candidate account —
    // see adapter.getApplications' comment for the DOM this reads. Grouped
    // the same way the source page groups them: one card per recruitment
    // campaign applied to (there can be more than one — e.g. I stopień and
    // Szkoła Doktorska), one row per kierunek inside it.
    renderZgloszenia() {
      const result = this.data.applicationsResult;
      if (!result || !result.supported) {
        return `<div class="usospp-card"><div class="usospp-empty-hint">Brak zgłoszeń do pokazania — ta strona wymaga zalogowania na konto kandydata w IRK.</div></div>`;
      }
      const recruitments = result.recruitments.filter((r) => r.applications.length > 0);
      if (!recruitments.length) {
        return `<div class="usospp-card"><div class="usospp-empty-hint">Nie znaleziono żadnych zgłoszeń rekrutacyjnych na tym koncie.</div></div>`;
      }
      return recruitments.map((rec) => `
        <div class="usospp-card" style="margin-bottom:16px;">
          <div class="usospp-card-title">${esc(rec.name)}</div>
          <div class="usospp-muted-text" style="margin-top:2px;">${esc(rec.academicYear || '')}${rec.statusLabel ? ` · ${esc(rec.statusLabel)}` : ''}</div>
          ${rec.applications.map((a) => this.renderApplicationRow(a)).join('')}
        </div>
      `).join('');
    }

    renderApplicationRow(a) {
      const badges = [
        a.payment.status ? { tone: a.payment.tone, text: `${a.payment.amount ? `${esc(a.payment.amount)} — ` : ''}${esc(a.payment.status)}` } : null,
        a.qualification.status ? {
          tone: a.qualification.tone,
          text: esc(a.qualification.status) + (a.qualification.position !== null ? ` (poz. ${a.qualification.position})` : ''),
        } : null,
        a.decision.status && a.decision.status !== '---' ? { tone: a.decision.tone, text: esc(a.decision.status) } : null,
      ].filter(Boolean);

      const links = [
        a.criteriaUrl ? { label: 'zasady kwalifikacji', url: a.criteriaUrl } : null,
        a.historyUrl ? { label: 'historia zgłoszenia', url: a.historyUrl } : null,
        a.decision.downloadUrl ? { label: 'pobierz decyzję', url: a.decision.downloadUrl } : null,
        a.decision.decisionsUrl ? { label: 'szczegóły decyzji', url: a.decision.decisionsUrl } : null,
      ].filter(Boolean);

      return `
        <div style="padding:14px 0;border-top:1px solid var(--border-soft);">
          <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;">
            <div>
              <div style="font-size:13.5px;font-weight:600;"><a data-action="openProgramme" data-url="${esc(a.programmeUrl)}">${esc(a.programmeName)}</a></div>
              <div class="usospp-muted-text" style="margin-top:2px;">
                ${esc(a.turnLabel || '')}${a.dateRange ? ` · ${esc(a.dateRange)}` : ''}${a.priority !== null ? ` · priorytet ${a.priority}` : ''}${a.score ? ` · wynik <strong>${esc(a.score)}</strong>` : ''}
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              ${badges.map((b) => `<div class="usospp-badge ${badgeToneClass(b.tone)}">${b.text}</div>`).join('')}
            </div>
          </div>
          ${a.admissionDocument ? `<div class="usospp-muted-text" style="margin-top:8px;">${esc(a.admissionDocument.label)}: ${esc(a.admissionDocument.value)}</div>` : ''}
          ${a.comment ? `<div class="usospp-muted-text" style="margin-top:6px;">${esc(a.comment)}</div>` : ''}
          ${links.length ? `
            <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:12.5px;">
              ${links.map((l) => `<a data-action="openIrk" data-url="${esc(l.url)}">${esc(l.label)} →</a>`).join('')}
            </div>
          ` : ''}
          ${a.nextStepsUrl ? `
            <details class="usospp-disclosure">
              <summary data-action="toggleNextSteps" data-application-id="${esc(a.applicationId)}" data-url="${esc(a.nextStepsUrl)}">Dokumenty i dalsze kroki</summary>
              <div data-next-steps-body="${esc(a.applicationId)}">${this.renderNextStepsBody(a.applicationId)}</div>
            </details>
          ` : ''}
        </div>
      `;
    }

    // See ensureNextSteps/patchNextSteps — patched in place on load so
    // opening one application's disclosure doesn't collapse the others.
    renderNextStepsBody(applicationId) {
      const state = this.state.applicationNextSteps[applicationId];
      if (!state || state.status === 'idle') return '';
      if (state.status === 'loading') return `<div class="usospp-empty-hint" style="padding:8px 0;">Wczytywanie…</div>`;
      if (state.status === 'error' || !state.data || !state.data.supported) {
        return `<div class="usospp-empty-hint" style="padding:8px 0;">Nie udało się wczytać.</div>`;
      }
      const { templates, checklist } = state.data;
      return `
        ${checklist.length ? `
          <div class="usospp-disclosure-list">
            ${checklist.map((c) => `
              <div class="usospp-disclosure-row">
                <div>${esc(c.name)}</div>
                ${c.status ? `<div class="usospp-badge ${c.positive ? 'usospp-badge-positive' : ''}">${esc(c.status)}</div>` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${templates.length ? `
          <div class="usospp-muted-text" style="margin-top:10px;">
            ${templates.map((t) => `${esc(t.name)}: ${t.links.map((l) => `<a data-action="openIrk" data-url="${esc(l.url)}">${esc(l.language || 'pobierz')} →</a>`).join(' ')}`).join('<br>')}
          </div>
        ` : ''}
      `;
    }

    // Verified live (2026-09-14) against a logged-in candidate account — see
    // adapter.getPersonalFormsHub/getPersonalForm's comments. Same read-only
    // principle as renderKonto: this NEVER turns into an editable form of
    // our own (a wrongly-mapped field or a validation rule we didn't
    // replicate could silently corrupt a real application) — "Edytuj →"
    // always opens the actual IRK page, this view only previews what's
    // already there.
    renderFormularze() {
      const result = this.data.personalFormsResult;
      if (!result || !result.supported) {
        return `<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać formularzy osobowych.</div></div>`;
      }
      return `
        <div class="usospp-card">
          <div class="usospp-muted-text">Podgląd danych, które zgłosiłeś/aś w tej rekrutacji. Zmiana odbywa się wyłącznie na stronie IRK — kliknij „Edytuj”.</div>
        </div>
        ${result.forms.map((f) => `
          <div class="usospp-card" style="margin-top:16px;">
            <div class="usospp-card-head">
              <div class="usospp-card-title">${esc(f.label)}</div>
              <a data-action="openIrk" data-url="${esc(f.url)}" style="font-size:12.5px;">Edytuj →</a>
            </div>
            <details class="usospp-disclosure">
              <summary data-action="togglePersonalForm" data-url="${esc(f.url)}">Pokaż zgłoszone dane</summary>
              <div data-personal-form-body="${esc(f.url)}" style="margin-top:10px;">
                ${this.renderPersonalFormBody(f.url)}
              </div>
            </details>
          </div>
        `).join('')}
      `;
    }

    // See ensurePersonalForm/patchPersonalForm — patched in place on load so
    // opening one form's disclosure doesn't collapse any other open one.
    renderPersonalFormBody(url) {
      const state = this.state.personalForms[url];
      if (!state || state.status === 'idle') return '';
      if (state.status === 'loading') return `<div class="usospp-empty-hint" style="padding:8px 0;">Wczytywanie…</div>`;
      if (state.status === 'error' || !state.data || !state.data.supported) {
        return `<div class="usospp-empty-hint" style="padding:8px 0;">Nie udało się wczytać tego formularza.</div>`;
      }
      const { locked, lockReason, fields } = state.data;
      return `
        ${locked ? `<div class="usospp-beta-notice" style="margin-bottom:10px;"><span class="usospp-beta-notice-icon">🔒</span><div>${esc(lockReason || 'Nie można teraz edytować tego formularza w IRK.')}</div></div>` : ''}
        <table class="usospp-table">
          <tbody>
            ${fields.map((f) => {
              if (f.type === 'section') return `<tr><td colspan="2" style="font-weight:600;padding-top:14px;">${esc(f.label)}</td></tr>`;
              if (f.type === 'documents') return `<tr><td colspan="2" style="padding-top:14px;">${this.renderCertificateCategory(f)}</td></tr>`;
              const value = f.type === 'checkbox' ? (f.value ? 'Tak' : 'Nie') : (f.value === null || f.value === '' ? '—' : esc(f.value));
              return `<tr><td style="color:var(--ink-3);width:220px;">${esc(f.label)}</td><td>${value}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      `;
    }

    // "Wykształcenie"'s "Dokumenty" categories (matura, olimpiady, wyższe,
    // certyfikaty) — see adapter.parseCertificateCategory. Same read-only
    // principle as everywhere else in this view: "Edytuj" and "Edytuj wyniki
    // egzaminów" are real navigations into IRK's own forms (nothing here
    // submits anything), and "usuń" is never rendered at all — the adapter
    // deliberately doesn't even read that link's URL (see its comment).
    renderCertificateCategory(f) {
      return `
        <div style="font-weight:600;">${esc(f.label)}</div>
        ${f.description ? `<div class="usospp-muted-text" style="margin-top:2px;">${esc(f.description)}</div>` : ''}
        ${f.documents.map((d) => `
          <div class="usospp-card" style="margin-top:8px;padding:10px 12px;">
            <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;">
              <div style="font-weight:600;font-size:13px;">${esc(d.name)}</div>
              <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px;">
                ${d.editUrl ? `<a data-action="openIrk" data-url="${esc(d.editUrl)}">Edytuj →</a>` : ''}
                ${d.examScoresUrl ? `<a data-action="openIrk" data-url="${esc(d.examScoresUrl)}">Edytuj wyniki egzaminów →</a>` : ''}
              </div>
            </div>
            ${d.fields.map((df) => `<div class="usospp-muted-text" style="margin-top:4px;">${esc(df.label)}: ${esc(df.value)}</div>`).join('')}
            ${d.examScoresUrl ? `
              <details class="usospp-disclosure" style="margin-top:8px;">
                <summary data-action="toggleExamScores" data-url="${esc(d.examScoresUrl)}">Pokaż wyniki egzaminów</summary>
                <div data-exam-scores-body="${esc(d.examScoresUrl)}" style="margin-top:8px;">${this.renderExamScoresBody(d.examScoresUrl)}</div>
              </details>
            ` : ''}
          </div>
        `).join('')}
        ${f.addUrl ? `<a data-action="openIrk" data-url="${esc(f.addUrl)}" style="display:inline-block;margin-top:10px;font-size:12.5px;">+ Dodaj dokument →</a>` : ''}
      `;
    }

    // See ensureExamScores/patchExamScores — patched in place on load so
    // opening one document's scores doesn't collapse any other open one.
    // Only the subjects/levels actually taken are shown (see
    // adapter.getExamScores) — not the ~50 IRK tracks in total.
    renderExamScoresBody(url) {
      const state = this.state.examScores[url];
      if (!state || state.status === 'idle') return '';
      if (state.status === 'loading') return `<div class="usospp-empty-hint" style="padding:8px 0;">Wczytywanie…</div>`;
      if (state.status === 'error' || !state.data || !state.data.supported) {
        return `<div class="usospp-empty-hint" style="padding:8px 0;">Nie udało się wczytać wyników.</div>`;
      }
      const { exams } = state.data;
      return `
        <table class="usospp-table">
          <tbody>
            ${exams.map((e) => `<tr><td style="color:var(--ink-3);">${esc(e.subject)}${e.level ? ` (${esc(e.level)})` : ''}</td><td>${e.value !== null && e.value !== '' ? esc(e.value) : '—'}</td></tr>`).join('')}
          </tbody>
        </table>
      `;
    }

    // Verified live (2026-09-14) — see adapter.getPayments' comment.
    // Read-only ledger only: the Autopay quick-pay widget and the bank
    // transfer account details are deliberately never reproduced here (see
    // the adapter comment on why) — "Zapłać / zobacz w IRK →" always sends
    // you to the real page for that, same as "Ustal priorytety".
    renderPlatnosci() {
      const result = this.data.paymentsResult;
      if (!result || !result.supported) {
        return `<div class="usospp-card"><div class="usospp-empty-hint">Brak danych o płatnościach do pokazania.</div></div>`;
      }
      return `
        <div class="usospp-card" style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;">
          <div>
            <div class="usospp-stat-label">Saldo</div>
            <div class="usospp-card-title" style="margin-top:4px;">${esc(result.totalBalance || '—')}</div>
          </div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;">
            ${result.priorityUrl ? `<a data-action="openIrk" data-url="${esc(result.priorityUrl)}">Ustal priorytety →</a>` : ''}
            ${result.pageUrl ? `<a data-action="openIrk" data-url="${esc(result.pageUrl)}">Zapłać / zobacz w IRK →</a>` : ''}
          </div>
        </div>
        ${result.currencies.map((c) => `
          <div class="usospp-card" style="margin-top:16px;">
            ${c.name ? `<div class="usospp-card-title" style="margin-bottom:6px;">${esc(c.name)}</div>` : ''}
            ${c.rows.map((r) => this.renderPaymentRow(r)).join('')}
          </div>
        `).join('')}
      `;
    }

    renderPaymentRow(r) {
      return `
        <div class="usospp-list-row">
          <div>
            <div style="font-size:13.5px;font-weight:600;">
              ${r.programmeUrl ? `<a data-action="openProgramme" data-url="${esc(r.programmeUrl)}">${esc(r.description)}</a>` : esc(r.description)}
            </div>
            <div class="usospp-muted-text" style="margin-top:2px;">
              ${r.created ? `Utworzono: ${esc(r.created)}` : ''}
              ${r.dueDate ? ` · termin: ${esc(r.dueDate)}` : ''}
              ${r.dueBankDate ? ` (przelew do: ${esc(r.dueBankDate)})` : ''}
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">
            ${r.status ? `<div class="usospp-badge ${badgeToneClass(/opłacono/i.test(r.status) ? 'positive' : null)}">${esc(r.status)}</div>` : ''}
            <div style="font-weight:600;${r.amountTone === 'negative' ? 'color:oklch(58% 0.19 25);' : r.amountTone === 'positive' ? 'color:oklch(50% 0.13 150);' : ''}">${esc(r.amount)}</div>
          </div>
        </div>
      `;
    }

    // Verified live (2026-09-14) — see adapter.getMessages'/getMessageThread's
    // comments. Read-only: opening a conversation shows the messages already
    // sent, but the "Twoja odpowiedź" reply box is never rendered — nor is
    // the inbox's own "Oznacz jako przeczytane"/"Usuń wybrane" bulk actions.
    // Replying, marking read, or deleting always stays a real navigation
    // into IRK via "Odpowiedz w IRK →".
    renderWiadomosci() {
      const result = this.data.messagesResult;
      if (!result || !result.supported) {
        return `<div class="usospp-card"><div class="usospp-empty-hint">Brak wiadomości do pokazania.</div></div>`;
      }
      return `
        <div class="usospp-card">
          ${result.conversations.map((c) => this.renderConversationRow(c)).join('')}
        </div>
      `;
    }

    renderConversationRow(c) {
      const tags = [
        c.unread ? { label: 'nieprzeczytana', tone: 'warning' } : null,
        c.fromContactForm ? { label: 'formularz kontaktowy', tone: null } : null,
        c.hasAttachments ? { label: 'załącznik', tone: null } : null,
      ].filter(Boolean);
      return `
        <details class="usospp-disclosure" style="border-top:1px solid var(--border-soft);padding:10px 0;">
          <summary data-action="toggleMessageThread" data-url="${esc(c.url)}" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;">
            <div>
              <div style="font-size:13.5px;font-weight:${c.unread ? '700' : '600'};">${esc(c.title)}</div>
              <div class="usospp-muted-text" style="margin-top:2px;">${esc(c.interlocutor || '')}${c.lastFromYou ? ' · Twoja odpowiedź jest ostatnia' : ''}</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">
              ${tags.map((t) => `<div class="usospp-badge ${badgeToneClass(t.tone)}">${esc(t.label)}</div>`).join('')}
              <div class="usospp-tag-muted">${esc(c.date || '')}</div>
            </div>
          </summary>
          <div data-message-thread-body="${esc(c.url)}" style="margin-top:10px;">${this.renderMessageThreadBody(c.url)}</div>
        </details>
      `;
    }

    // See ensureMessageThread/patchMessageThread — patched in place on load
    // so opening one conversation doesn't collapse any other open one.
    renderMessageThreadBody(url) {
      const state = this.state.messageThreads[url];
      if (!state || state.status === 'idle') return '';
      if (state.status === 'loading') return `<div class="usospp-empty-hint" style="padding:8px 0;">Wczytywanie…</div>`;
      if (state.status === 'error' || !state.data || !state.data.supported) {
        return `<div class="usospp-empty-hint" style="padding:8px 0;">Nie udało się wczytać wiadomości.</div>`;
      }
      const { messages } = state.data;
      return `
        ${messages.map((m) => `
          <div class="usospp-card" style="margin-top:8px;padding:10px 12px;">
            <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline;">
              <div style="font-weight:600;font-size:13px;">${esc(m.senderName)}${m.role ? ` <span class="usospp-tag-muted">(${esc(m.role)})</span>` : ''}</div>
              <div class="usospp-tag-muted">${esc(m.date || '')}</div>
            </div>
            <div class="usospp-news-body" style="margin-top:6px;">${m.bodyHtml}</div>
            ${m.attachments.length ? `
              <div style="margin-top:8px;font-size:12.5px;">
                ${m.attachments.map((a) => `<a data-action="openIrk" data-url="${esc(a.url)}">${esc(a.name)}${a.size ? ` (${esc(a.size)})` : ''} →</a>`).join('<br>')}
              </div>
            ` : ''}
          </div>
        `).join('')}
        <a data-action="openIrk" data-url="${esc(url)}" style="display:inline-block;margin-top:10px;font-size:12.5px;">Odpowiedz w IRK →</a>
      `;
    }

    renderKonto() {
      const result = this.data.accountResult;
      if (!result || !result.supported) {
        return `<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać danych konta.</div></div>`;
      }
      return `
        <div class="usospp-card" style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start;">
          ${result.photoUrl ? `<img src="${esc(result.photoUrl)}" alt="Zdjęcie" style="width:96px;height:120px;object-fit:cover;border-radius:10px;border:1px solid var(--border);flex-shrink:0;">` : ''}
          <div style="flex:1;min-width:220px;">
            <div class="usospp-card-title">${esc(result.fullName || 'Twoje konto')}</div>
            <div class="usospp-muted-text" style="margin-top:2px;">
              ${[result.email, result.irkId ? `ID w IRK: ${result.irkId}` : null, result.pesel ? `PESEL: ${result.pesel}` : null].filter(Boolean).map(esc).join(' · ')}
            </div>
            ${result.photoStatus.length ? `
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
                ${result.photoStatus.map((row) => `<div class="usospp-badge ${badgeToneClass(row.tone)}">${esc(row.label)}: ${esc(row.value)}</div>`).join('')}
              </div>
            ` : ''}
            ${result.actions.length ? `
              <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:12px;font-size:12.5px;">
                ${result.actions.map((a) => `<a data-action="openIrk" data-url="${esc(a.url)}" style="${a.destructive ? 'color:oklch(58% 0.19 25);' : ''}">${esc(a.label)} →</a>`).join('')}
              </div>
            ` : ''}
          </div>
        </div>
        ${result.authMethods.length ? `
          <div class="usospp-card" style="margin-top:16px;">
            <div class="usospp-card-title">Metody logowania</div>
            ${result.authMethods.map((m) => `
              <div class="usospp-list-row">
                <div>${esc(m.method)}</div>
                ${m.detail ? `<div class="usospp-tag-muted">${esc(m.detail)}</div>` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${result.notifications ? `
          <div class="usospp-card" style="margin-top:16px;">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Ustawienia powiadomień</div>
              ${result.notifications.settingsUrl ? `<a data-action="openIrk" data-url="${esc(result.notifications.settingsUrl)}" style="font-size:12.5px;">Zmień →</a>` : ''}
            </div>
            <div class="usospp-muted-text">Język powiadomień: ${esc(result.notifications.language || '—')}</div>
            <div class="usospp-muted-text" style="margin-top:4px;">E-mail o nowych wiadomościach: ${result.notifications.emailOnMessage ? 'włączone' : 'wyłączone'}</div>
            <div class="usospp-muted-text" style="margin-top:4px;">E-mail o nowych powiadomieniach: ${result.notifications.emailOnNotification ? 'włączone' : 'wyłączone'}</div>
          </div>
        ` : ''}
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
        ${d.pastTurns && d.pastTurns.length ? `
          <details class="usospp-disclosure">
            <summary>Minione tury w tej rekrutacji (${d.pastTurns.length})</summary>
            <div class="usospp-disclosure-list">
              ${d.pastTurns.map((t) => `
                <div class="usospp-disclosure-row">
                  <div>
                    <span class="usospp-disclosure-row-label">${esc(t.label)}</span>
                    ${t.range ? `<span class="usospp-disclosure-row-range"> · ${esc(t.range)}</span>` : ''}
                  </div>
                  ${t.criteriaUrl ? `<a data-action="openIrk" data-url="${esc(t.criteriaUrl)}">zasady kwalifikacji →</a>` : ''}
                </div>
              `).join('')}
            </div>
          </details>
        ` : ''}
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

    renderRecruitmentPickerModal() {
      if (!this.state.recruitmentPickerOpen) return '';
      const status = this.state.recruitmentOptionsStatus;
      const options = this.state.recruitmentOptions || [];
      const currentSlug = this.data.slug;
      return `
        <div class="usospp-modal-backdrop" data-action="closeModalBackdrop">
          <div class="usospp-modal">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">Zmień rekrutację</div>
              <button class="usospp-icon-btn" data-action="closeRecruitmentPicker" title="Zamknij">${icon('close', 15)}</button>
            </div>
            ${status === 'loading' ? `<div class="usospp-empty-hint">Wczytywanie listy rekrutacji…</div>` : ''}
            ${status === 'error' ? `<div class="usospp-empty-hint">Nie udało się wczytać listy rekrutacji.</div>` : ''}
            ${status === 'done' && !options.length ? `<div class="usospp-empty-hint">Brak dostępnych rekrutacji.</div>` : ''}
            ${status === 'done' && options.length ? options.map((o) => {
              const isCurrent = o.slug === currentSlug;
              return `
                <div class="usospp-list-row" style="${isCurrent ? 'opacity:0.55;' : 'cursor:pointer;'}" ${isCurrent ? '' : `data-action="switchRecruitment" data-slug="${esc(o.slug)}"`}>
                  <div>
                    <div style="font-size:13.5px;font-weight:600;">${esc(o.name)}${isCurrent ? ' <span class="usospp-tag-muted">(aktualna)</span>' : ''}</div>
                    ${o.description ? `<div class="usospp-muted-text" style="margin-top:2px;">${esc(o.description)}</div>` : ''}
                  </div>
                  ${o.protectedAccess ? `<div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">kod dostępu</div>` : ''}
                </div>
              `;
            }).join('') : ''}
          </div>
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

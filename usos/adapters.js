// Reads data out of the live USOSweb DOM. No USOS API calls anywhere here —
// everything below only looks at what the page already rendered for the
// logged-in user.
//
// USOSweb installations differ by version across universities. The "pwr"
// adapter below is verified against the real DOM of web.usos.pwr.edu.pl
// (USOSweb 7.3.1.0, the modern web-components shell with usos-frame /
// usos-timetable custom elements, some of them using an *open* shadow DOM).
// Sections marked UNVERIFIED were written from the empty-state markup only
// (this account's semester hadn't started yet during development) — the
// selectors are a best effort and may need adjusting once real data shows up.
//
// The "legacy" adapter is an unverified placeholder for older, classic-table
// USOSweb installations at other universities, kept here so support for a
// second school is a matter of filling in real selectors, not restructuring
// the extension.
(function () {
  function textOf(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  }

  // USOS duplicates tooltip text (round state, subject registration status,
  // attribute icons…) into a plain-text screen-reader-only element
  // referenced via aria-labelledby — reading that is simpler and safer than
  // un-escaping the HTML-encoded data-content attribute on the tooltip icon.
  function tipText(img, doc) {
    if (!img) return null;
    const id = img.getAttribute('aria-labelledby');
    const box = id ? doc.getElementById(id) : null;
    return box ? textOf(box) : null;
  }

  // Biweekly ("co drugi tydzień") classes render their parity as plain text
  // right next to the day/time — e.g. "co drugi czwartek (nieparzyste),
  // 11:15 - 13:00" on a groups list, or "co drugi wtorek (parzyste), 7:30 -
  // 9:00" in a subject's own full plan (both verified live, 2026-09-14, on
  // a real biweekly subject: 08IZZ0-25S101O00121G). A weekly class's text
  // has no such parenthetical at all ("każdy poniedziałek, ...") — absence
  // of a match here is exactly "every week", not "unknown".
  function parseWeeksParity(text) {
    const m = (text || '').match(/\((nie)?parzyste\)/i);
    return m ? (m[1] ? 'odd' : 'even') : 'every';
  }

  // UNVERIFIED shared shape for four small "Moje studia" pages (stypendia,
  // sprawdziany, podania, ankiety): each one is either an empty <info-box>
  // ("brak ...") or — presumably, once there's something to show — a plain
  // <table> with a header row. Confirmed live only against the *empty*
  // state on all four (this account's semester just started, so there was
  // nothing to check the populated markup against) — this generalizes the
  // same thead-th / tbody-td row shape getPaymentGroups already uses
  // elsewhere in this file, on the assumption USOSweb reuses its own table
  // conventions here too. Re-verify against real rows once any of these
  // pages actually has data.
  function genericInfoTable(doc) {
    const rows = [];
    doc.querySelectorAll('table').forEach((table) => {
      const headers = [...table.querySelectorAll('thead th')].map((th) => textOf(th) || '');
      table.querySelectorAll('tbody tr').forEach((tr) => {
        const cells = [...tr.querySelectorAll('td')];
        const fields = {};
        headers.forEach((label, i) => { if (label && cells[i]) fields[label] = textOf(cells[i]); });
        const link = tr.querySelector('a[href]');
        rows.push({ fields, detailsUrl: link ? link.href : null });
      });
    });
    return { supported: true, verified: false, rows };
  }

  function detectFooterVersion() {
    const row = document.querySelector('footer-row[icon="outlined.privacy_tip"]');
    const text = textOf(row) || '';
    const m = text.match(/USOSweb\s+([\d.]+)/i);
    return m ? m[1] : null;
  }

  // Announcement bodies come from the university's own page, but we still
  // don't trust raw innerHTML from a fetched document enough to inject it
  // straight into the extension's own DOM — sanitizeHtml (core/sanitize-html.js,
  // shared with irk/adapters.js's own Aktualności) rebuilds it using only an
  // allowlist of safe formatting tags instead.
  function sanitizeNewsHtml(nodes, doc) {
    return window.USOSPP_CORE_SANITIZE.sanitizeHtml(nodes, doc);
  }

  function hasModernShell() {
    return !!document.querySelector('usos-layout, usos-frame, cas-bar');
  }

  function looksLikeUsos() {
    const title = document.title || '';
    const footer = textOf(document.querySelector('usos-footer, #footer-system')) || '';
    return /usosweb/i.test(title) || /usosweb/i.test(footer) || /usosweb/i.test(document.body.innerHTML.slice(0, 500));
  }

  // ---------------------------------------------------------------------
  // PWR adapter — USOSweb 7.3.x modern shell
  // ---------------------------------------------------------------------
  const pwrAdapter = {
    id: 'usosweb-modern-7x',
    version: detectFooterVersion(),
    matches: hasModernShell,

    getUser(doc = document) {
      const cas = doc.querySelector('cas-bar');
      const name = cas ? cas.getAttribute('logged-user') : null;
      let album = null;
      let faculty = null;
      let facultyCode = null;
      const infoFrame = doc.querySelector('#info-frame');
      if (infoFrame) {
        const text = textOf(infoFrame) || '';
        const albumMatch = text.match(/Numer albumu:\s*(\d+)/);
        if (albumMatch) album = albumMatch[1];
        const facultyLink = infoFrame.querySelector('a[href*="katalog2/jednostki"]');
        if (facultyLink) {
          faculty = textOf(facultyLink);
          const codeMatch = facultyLink.href.match(/[?&]kod=([^&]+)/);
          if (codeMatch) facultyCode = decodeURIComponent(codeMatch[1]);
        }
      }
      return { name, album, faculty, facultyCode };
    },

    // Verified against real markup at
    // .../kontroler.php?_action=dla_stud/studia/zaliczenia/index
    getEtapy(doc = document) {
      const out = [];
      doc.querySelectorAll('usos-frame').forEach((frame) => {
        const titleEl = frame.querySelector('h2[slot="title"]');
        const programLabel = textOf(titleEl);
        if (!programLabel) return;
        frame.querySelectorAll('usos-frame-section').forEach((section) => {
          const label = section.getAttribute('section-title') || '';
          const kv = {};
          section.querySelectorAll('.inline-keyvalue-list > div').forEach((row) => {
            const cells = row.querySelectorAll(':scope > div');
            if (cells.length >= 2) {
              const key = textOf(cells[0]).replace(/:$/, '');
              kv[key] = textOf(cells[1]);
            }
          });
          const statusTag = section.querySelector('usos-tag');
          out.push({
            programLabel,
            label,
            cycle: kv['Cykl realizacji'] || null,
            endDate: kv['Data zakończenia'] || null,
            status: textOf(statusTag),
          });
        });
      });
      return { supported: true, verified: true, etapy: out };
    },

    // The rendered <usos-timetable> only builds its grid client-side inside
    // an *open* shadow root, which won't exist on a document fetched via
    // fetch()+DOMParser (custom elements never upgrade there). Instead we
    // read the raw data literal the server embeds for the JS to consume:
    // <script type="module">register('plan', 'home/index', [ ...events ]);
    // Only the empty-array case ([]) has been observed for real (no classes
    // scheduled yet this semester) — the shape of a populated array is
    // UNVERIFIED, so callers should treat `raw` as opaque until confirmed.
    getPlan(doc = document) {
      const scripts = [...doc.querySelectorAll('script')];
      for (const script of scripts) {
        const text = script.textContent || '';
        const m = text.match(/register\(\s*'plan'\s*,\s*'[^']*'\s*,\s*(\[[\s\S]*?\])\s*\)/);
        if (m) {
          try {
            return { supported: true, verified: false, raw: JSON.parse(m[1]) };
          } catch (e) {
            return { supported: true, verified: false, raw: null, parseError: true };
          }
        }
      }
      return { supported: false, verified: false, raw: null };
    },

    // UNVERIFIED: only the empty <usos-frame id="oceny"> (no rows) was
    // observed. Tries a plain <table>, then the same section-list pattern
    // used by "zaliczenia etapów", then gives up gracefully.
    getGrades(doc = document) {
      const frame = doc.querySelector('usos-frame#oceny, usos-frame.oceny');
      if (!frame) return { supported: false, verified: false, rows: [] };
      const table = frame.querySelector('table');
      if (table) {
        const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map(textOf));
        return { supported: true, verified: false, rows };
      }
      const sectionRows = [...frame.querySelectorAll('usos-frame-section')].map((section) => ({
        label: section.getAttribute('section-title') || '',
        text: textOf(section),
      }));
      return { supported: true, verified: false, rows: sectionRows };
    },

    // UNVERIFIED: rejestracja na egzaminy is a separate same-document
    // AngularJS app (ng-app="rejestracjeApp") that fetches its own data
    // client-side from rejestracje.usos.pwr.edu.pl after load. We never call
    // that backend ourselves — we only read the DOM it renders, from a
    // hidden same-origin iframe that loads the real page (see scraping.js).
    getExams(doc = document) {
      const app = doc.querySelector('#appContainer');
      if (!app) return { supported: false, verified: false, exams: [] };
      const rows = [...app.querySelectorAll('table tbody tr, [ng-repeat]')]
        .map((el) => textOf(el))
        .filter(Boolean);
      return { supported: rows.length > 0, verified: false, exams: rows };
    },

    // Verified against real markup at .../news/rejestracje/rejJednostki
    // ?jed_org_kod=<kod> — a public, faculty-wide registration calendar
    // (visible before USOS grants the student personal access to a round).
    // Each group of rounds is introduced by an <h2>…[KOD]</h2> heading
    // followed either by <notice-box>Brak zdefiniowanych tur</notice-box> or
    // a <table class="full-width"> whose <tr element="wiersz_tury"> rows we
    // parse below. Tooltip text (round state, attributes) is duplicated by
    // USOS into a plain-text screen-reader div referenced via
    // aria-labelledby — we read that instead of un-escaping the HTML-encoded
    // data-content attribute.
    getRegistrationRounds(doc = document) {
      const groups = [];
      doc.querySelectorAll('h2').forEach((h2) => {
        const heading = textOf(h2) || '';
        const codeMatch = heading.match(/\[([^\]]+)\]\s*$/);
        if (!codeMatch) return;
        const code = codeMatch[1];
        const groupLabel = heading.replace(/\s*\[[^\]]+\]\s*$/, '').trim();

        let subjectsUrl = null;
        let table = null;
        let el = h2.nextElementSibling;
        while (el && el.tagName !== 'H2') {
          if (!subjectsUrl && el.querySelector) {
            const link = el.querySelector('a[href*="szukajPrzedmiotu"]');
            if (link) subjectsUrl = link.href;
          }
          if (el.tagName === 'TABLE') table = el;
          el = el.nextElementSibling;
        }

        const rounds = [];
        if (table) {
          table.querySelectorAll('tr[element="wiersz_tury"]').forEach((tr) => {
            const cells = tr.querySelectorAll(':scope > td');
            const state = tipText(cells[0] && cells[0].querySelector('.smarty-tip-wrapper'), doc) || textOf(cells[0]);
            const times = cells[1] ? [...cells[1].querySelectorAll('local-time')].map((t) => t.getAttribute('datetime')) : [];
            const roundType = cells[2] ? textOf(cells[2].querySelector('span')) : null;
            const roundNote = cells[2] ? textOf(cells[2].querySelector('span.note')) : null;
            const attributes = {};
            if (cells[3]) {
              cells[3].querySelectorAll('img.rejestracja-ikona').forEach((img) => {
                const text = tipText(img, doc);
                if (!text) return;
                const m = text.match(/^([^:]+):\s*(.*)$/s);
                if (m) attributes[m[1].trim()] = m[2].trim();
              });
            }
            rounds.push({
              turaId: tr.getAttribute('tura_id'),
              state,
              startsAt: times[0] || null,
              endsAt: times[1] || null,
              roundType,
              roundNote,
              attributes,
              hasAccess: /^TAK/i.test(attributes['Czy masz dostęp do rejestracji'] || ''),
            });
          });
        }

        groups.push({ code, groupLabel, subjectsUrl, rounds });
      });

      return { supported: true, verified: true, groups };
    },

    // Verified against real markup at .../dla_stud/rejestracja/przedmioty —
    // the "Wymagania etapów studiów" block links to the student's own
    // programme stage(s). This is the only reliable "what's my kierunek"
    // signal we have (the zaliczenia/etapy page only exposes the
    // whole-programme stage, e.g. "I stopień", not a per-semester
    // breakdown) — the prg_kod in these links is what actually shows up
    // inside registration-round headings on the faculty calendar, so it's
    // what we filter by. Multiple entries can appear at once (e.g. both the
    // semester just finishing and the next one), so treat `semester` as "a
    // semester this account currently cares about", not THE current one.
    getOwnProgrammes(doc = document) {
      const programmes = [];
      doc.querySelectorAll('a[href*="pokazEtapProgramu"]').forEach((a) => {
        let url;
        try {
          url = new URL(a.href);
        } catch (e) {
          return;
        }
        const prgKod = url.searchParams.get('prg_kod');
        const etpKod = url.searchParams.get('etp_kod');
        if (!prgKod) return;
        const text = textOf(a) || '';
        const semMatch = text.match(/^(\d+)\s*semestr/i);
        const semester = semMatch ? parseInt(semMatch[1], 10) : null;
        const directionName = text.replace(/^\d+\s*semestr,?\s*/i, '').trim();
        programmes.push({ prgKod, etpKod, semester, directionName, label: text });
      });
      return { supported: programmes.length > 0, verified: true, programmes };
    },

    // Shared by every "Płatności" sub-page (naleznosciNierozliczone,
    // naleznosciRozliczone, planyRatalne, wplatyWszystkie,
    // wplatyNierozliczone — see scraping.js) — verified against real
    // markup+data on naleznosciRozliczone and wplatyWszystkie: dues/payments
    // are grouped per organizational unit, each group a <usos-frame> with a
    // [slot="title"] ("Należności dla: X" / "Wpłaty dla: X") and a plain
    // pre-JS-rendered <table> (DataTables only decorates it client-side —
    // fetch()+DOMParser sees the table before that runs: thead labels, tbody
    // rows, tfoot per-unit total). The other pages share this exact shape
    // but only their empty state (a bare <success-box>, no frames at all)
    // was actually observed on this account — reading column names straight
    // from whatever <thead th> the page renders (instead of hardcoding
    // positions) means this should still hold up once one of them has real
    // rows, rather than being a guess at their layout.
    getPaymentGroups(doc = document) {
      const groups = [];
      doc.querySelectorAll('usos-frame').forEach((frame) => {
        const table = frame.querySelector('table');
        if (!table) return;
        const unitLabel = textOf(frame.querySelector('[slot="title"]'));
        const headers = [...table.querySelectorAll('thead th')].map((th) => textOf(th) || '');
        const rows = [...table.querySelectorAll('tbody tr')].map((tr) => {
          const cells = [...tr.querySelectorAll('td')];
          const fields = {};
          headers.forEach((label, i) => {
            if (label && cells[i]) fields[label] = textOf(cells[i]);
          });
          const link = tr.querySelector('a[href]');
          return { fields, detailsUrl: link ? link.href : null };
        });
        const footRow = table.querySelector('tfoot tr');
        groups.push({ unitLabel, rows, total: footRow ? textOf(footRow) : null });
      });
      // The page-wide grand total ("Wszystkie należności: X PLN" / "Wszystkie
      // wpłaty: X PLN") sits as its own <info-box> after the last frame —
      // distinguished from the page's INTRO info-box (which comes before any
      // frame and doesn't start with "Wszystkie") by content, not position.
      const grandTotalBox = [...doc.querySelectorAll('info-box')].find((box) => /^Wszystkie/i.test(textOf(box) || ''));
      return { supported: true, verified: true, groups, grandTotal: grandTotalBox ? textOf(grandTotalBox) : null };
    },

    // Verified live (2026-09-14): empty account renders a single <info-box>
    // "Brak informacji o otrzymywanych stypendiach." and no table at all —
    // see genericInfoTable's comment for why the populated-row shape below
    // is a best guess, not confirmed.
    getScholarships(doc = document) {
      return genericInfoTable(doc);
    },

    // Verified live (2026-09-14): empty account (no lecturer has published
    // electronic grading rules yet) renders a single <info-box> and no
    // table. See genericInfoTable's comment.
    getTests(doc = document) {
      return genericInfoTable(doc);
    },

    // Verified live (2026-09-14): with zero submitted petitions, the page
    // renders no table AND no "brak" message at all — just the three static
    // instruction paragraphs. genericInfoTable naturally returns an empty
    // rows array in that case, same as it would for an empty <info-box>
    // page, so no special-casing needed here.
    getPetitions(doc = document) {
      return genericInfoTable(doc);
    },

    // Verified live (2026-09-14): empty account renders a single <info-box>
    // "Brak ankiet do wypełnienia" and no table. See genericInfoTable's
    // comment.
    getSurveys(doc = document) {
      return genericInfoTable(doc);
    },

    // Verified against real markup+data at .../dodatki/platnosci_fk/kontaBankowe
    // — a single <table class="grey"> with a bold "headnote" row ("Twoje
    // konta wirtualne"), a header row, then one row per virtual account
    // (Opis / Waluta / Numer konta / link to a downloadable "blankiet
    // wpłaty" PDF). The account-number cell bundles the bank name in a
    // trailing "(...)" — split off here so the number renders cleanly on
    // its own.
    getBankAccounts(doc = document) {
      const table = doc.querySelector('table.grey');
      if (!table) return { supported: false, verified: false, accounts: [] };
      const rows = [...table.querySelectorAll('tr')].filter((tr) => !tr.classList.contains('headnote') && tr.querySelector('td'));
      const accounts = rows.map((tr) => {
        const cells = [...tr.querySelectorAll('td')];
        if (cells.length < 3) return null;
        const label = textOf(cells[0]);
        const currency = textOf(cells[1]);
        const raw = textOf(cells[2]) || '';
        const m = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
        const link = cells[3] ? cells[3].querySelector('a') : null;
        return {
          label,
          currency,
          number: m ? m[1] : raw,
          bankName: m ? m[2] : null,
          blankietUrl: link ? link.href : null,
        };
      }).filter(Boolean);
      return { supported: accounts.length > 0, verified: true, accounts };
    },

    // Verified against real markup+data at .../dodatki/platnosci/szczegoly
    // ?id=<...>&typ=<rata|wplata> — the "szczegóły" link on every row from
    // getPaymentGroups. Two kinds of <usos-frame> here: "Informacje ogólne"
    // holds a label/value CSS-grid (children alternate label div, value div
    // — not a table), the rest ("Szczegóły rozliczenia" for a wpłata; a due
    // presumably has an equivalent) hold a plain table. Only the "typ=wplata"
    // shape was actually observed (this account has no unpaid "typ=rata"
    // dues to click into) — read generically off whichever shape each frame
    // actually has rather than assuming a fixed set of frames, so it isn't a
    // guess specific to one type.
    getPaymentDetails(doc = document) {
      const generalInfo = [];
      const tables = [];
      doc.querySelectorAll('usos-frame').forEach((frame) => {
        const titleEl = frame.querySelector('[slot="title"]');
        let title = null;
        if (titleEl) {
          const clone = titleEl.cloneNode(true);
          clone.querySelectorAll('usos-tooltip').forEach((t) => t.remove());
          title = textOf(clone);
        }

        const grid = frame.querySelector(':scope > div');
        const table = frame.querySelector('table');
        if (grid && !table) {
          const cells = [...grid.children];
          for (let i = 0; i + 1 < cells.length; i += 2) {
            const label = (textOf(cells[i]) || '').replace(/:$/, '');
            const value = textOf(cells[i + 1]);
            if (label) generalInfo.push({ label, value });
          }
          return;
        }
        if (table) {
          const headers = [...table.querySelectorAll('thead th')].map((th) => (textOf(th) || '').replace(/:$/, ''));
          const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => textOf(td) || ''));
          const footRow = table.querySelector('tfoot tr');
          tables.push({ title, headers, rows, footer: footRow ? textOf(footRow) : null });
        }
      });
      return { supported: generalInfo.length > 0 || tables.length > 0, verified: true, generalInfo, tables };
    },

    // Verified against real markup+data at .../katalog2/jednostki/pokazJednostke
    // ?kod=<...> — the organizational-unit page a "Jednostki" search result
    // opens. The hierarchy renders as one big, fully nested <ul>/<li> tree
    // (every ancestor AND every descendant at every level, each row a
    // <table class="local-treeitem">) with the CURRENT node the only one
    // rendered as plain <b> text instead of a link. Walking the *whole* tree
    // isn't useful for a single unit page, so this only pulls out the
    // ancestor chain (breadcrumb) and the current node's direct children.
    getUnitDetail(doc = document) {
      const name = textOf(doc.querySelector('main h1, .uwb-imgcover-title h1'));

      // Basic info ("Kod jednostki", "Nazwa w języku angielskim"…) isn't a
      // table here — it's label/value <div> pairs inside .uwb-side-defs.
      const fields = [];
      doc.querySelectorAll('.uwb-side-defs > .uwb-clearfix').forEach((row) => {
        const cells = row.children;
        if (cells.length < 2) return;
        const label = textOf(cells[0]);
        const value = textOf(cells[1]);
        if (label && value) fields.push({ label, value });
      });

      function kodFromHref(href) {
        try { return new URL(href).searchParams.get('kod'); } catch (e) { return null; }
      }
      // Each .local-treeitem row actually has TWO <a> tags to the same
      // target — one wrapping just a decorative <img> (empty text), one
      // wrapping the real name — so picking the first link would silently
      // grab the empty one.
      function textLink(table) {
        const links = [...table.querySelectorAll('a')];
        return links.find((a) => textOf(a)) || links[0] || null;
      }

      const currentBold = doc.querySelector('.local-factree .local-treeitem b');
      const ancestors = [];
      const children = [];
      if (currentBold) {
        const currentLi = currentBold.closest('li');
        let ancestorLi = currentLi ? currentLi.parentElement.closest('li') : null;
        while (ancestorLi) {
          const table = ancestorLi.querySelector(':scope > table.local-treeitem');
          const link = table ? textLink(table) : null;
          const kod = link ? kodFromHref(link.href) : null;
          if (kod) ancestors.unshift({ kod, name: textOf(link) });
          ancestorLi = ancestorLi.parentElement.closest('li');
        }

        const childList = currentLi ? currentLi.querySelector(':scope > ul') : null;
        if (childList) {
          childList.querySelectorAll(':scope > li > table.local-treeitem').forEach((table) => {
            const link = textLink(table);
            const kod = link ? kodFromHref(link.href) : null;
            if (kod) children.push({ kod, name: textOf(link) });
          });
        }
      }

      return { supported: !!name, verified: true, name, fields, ancestors, children };
    },

    // Verified against real markup+data at .../katalog2/programy/pokazProgram
    // ?kod=<...> — the program-instance page a "Programy studiów" search
    // result opens (distinct from a "kierunek" page, which groups several
    // programs together and isn't scraped here). The "Główne toki nauczania"
    // flowchart links straight to pokazEtapProgramu — the exact page
    // PATHS.stageSubjects/getStageSubjects already handle for the logged-in
    // user's own programmes — so this just harvests the same {prg_kod,
    // etp_kod} pairs from this page's own flowchart instead.
    getProgramDetail(doc = document) {
      const name = textOf(doc.querySelector('main h1'));

      function cellText(cell) {
        const clone = cell.cloneNode(true);
        clone.querySelectorAll('usos-tooltip, script').forEach((t) => t.remove());
        return textOf(clone);
      }

      const infoFrame = [...doc.querySelectorAll('usos-frame')].find((f) => {
        const h = f.querySelector('[slot="title"]');
        return h && /Informacje o programie/i.test(textOf(h) || '');
      });

      const fields = [];
      const kierunki = [];
      const units = [];
      if (infoFrame) {
        infoFrame.querySelectorAll('tbody > tr').forEach((tr) => {
          const cells = tr.querySelectorAll('td');
          if (cells.length < 2) return;
          const label = (cellText(cells[0]) || '').replace(/:$/, '');
          if (/^Kierunki do/i.test(label)) return; // "kierunki do wyboru" — usually empty, not worth a field
          if (/^Kierunki$/i.test(label)) {
            cells[1].querySelectorAll('a').forEach((a) => {
              const text = textOf(a);
              if (text && !kierunki.includes(text)) kierunki.push(text);
            });
            return;
          }
          if (/^Jednostki$/i.test(label)) {
            cells[1].querySelectorAll('a[href*="pokazJednostke"]').forEach((a) => {
              let kod = null;
              try { kod = new URL(a.href).searchParams.get('kod'); } catch (e) { /* skip */ }
              if (kod) units.push({ kod, name: textOf(a) });
            });
            return;
          }
          const value = cellText(cells[1]);
          if (label && value) fields.push({ label, value });
        });
      }

      const stages = [];
      doc.querySelectorAll('a[href*="pokazEtapProgramu"]').forEach((a) => {
        let url;
        try { url = new URL(a.href); } catch (e) { return; }
        const prgKod = url.searchParams.get('prg_kod');
        const etpKod = url.searchParams.get('etp_kod');
        if (!prgKod || !etpKod) return;
        stages.push({ prgKod, etpKod, label: textOf(a) });
      });

      return { supported: !!name, verified: true, name, fields, kierunki, units, stages };
    },

    // Verified against real markup at .../news/default (also the site's own
    // landing page once logged in). Announcements render as a flat sequence
    // of siblings inside a <div class="wrtext">: each one's heading is a
    // <div class="title-wrapper-section">…<h4>…</h4></div>, immediately
    // followed by one or more plain <div> wrappers holding its <p> body —
    // there's no shared container per-announcement, so we walk the sibling
    // list ourselves and split on the heading markers. The very first
    // heading on the page ("Witaj w systemie USOSweb") uses the plain
    // "title-wrapper" class instead (no "-section" suffix) — that's the
    // page's own generic greeting, not a real announcement, so it's
    // naturally excluded by matching only "title-wrapper-section".
    getNews(doc = document) {
      const anyHeading = doc.querySelector('.title-wrapper-section');
      const wrtext = anyHeading ? anyHeading.closest('.wrtext') : null;
      if (!wrtext) return { supported: false, verified: false, items: [] };

      const items = [];
      let current = null;
      Array.from(wrtext.children).forEach((child) => {
        if (child.classList.contains('title-wrapper-section')) {
          if (current) items.push(current);
          const h = child.querySelector('h1,h2,h3,h4,h5,h6');
          current = { title: textOf(h) || textOf(child), bodyNodes: [] };
        } else if (current) {
          current.bodyNodes.push(...Array.from(child.childNodes));
        }
      });
      if (current) items.push(current);

      const news = items
        .filter((it) => it.title)
        .map((it) => ({ title: it.title, html: sanitizeNewsHtml(it.bodyNodes, doc) }));
      return { supported: news.length > 0, verified: true, items: news };
    },

    // Verified against real markup at .../katalog2/programy/pokazEtapProgramu
    // ?prg_kod=<...>&etp_kod=<...> — the page each of getOwnProgrammes'
    // links points to, listing the subjects required at that stage. Every
    // "Przedmioty…" <h2> section (obowiązkowe, and presumably wybieralne on
    // stages that have electives — heading text isn't hardcoded) is followed
    // by a <table class="grey"> whose columns are: subject, "Okres" (the
    // date range this particular curriculum-code row applies to), one column
    // per teaching cycle (chronological, so the LAST one is the most recent
    // — treated as "the current cycle"), then "Wymagany do warunku". The
    // same subject name can repeat across multiple rows with different
    // codes because the curriculum was revised between cohorts — only rows
    // whose current-cycle cell actually has content are kept, since an empty
    // cell means that particular code variant doesn't apply this cycle
    // (just historical baggage duplicating the same subject name).
    getStageSubjects(doc = document) {
      const sections = [];
      doc.querySelectorAll('h2').forEach((h2) => {
        const label = textOf(h2) || '';
        if (!/^Przedmioty/i.test(label)) return;

        let table = null;
        let el = h2.nextElementSibling;
        while (el && el.tagName !== 'H2') {
          if (el.tagName === 'TABLE') table = el;
          el = el.nextElementSibling;
        }
        if (!table) return;

        const headerRow = table.querySelector('tr');
        const headerCells = headerRow ? [...headerRow.querySelectorAll('th')] : [];
        if (headerCells.length < 3) return;
        const cycleIndex = headerCells.length - 2;
        const currentCycleLabel = textOf(headerCells[cycleIndex]);

        const subjects = [];
        table.querySelectorAll('tbody tr').forEach((tr) => {
          const cells = tr.querySelectorAll(':scope > td');
          if (cells.length !== headerCells.length) return;
          const nameCell = cells[0];
          const link = nameCell.querySelector('a');
          const name = textOf(link) || textOf(nameCell);
          const code = textOf(nameCell.querySelector('span.note'));
          const detailsUrl = link ? link.href : null;
          const period = textOf(cells[1] && cells[1].querySelector('span.note')) || textOf(cells[1]);
          const cycleCell = cells[cycleIndex];
          const status = tipText(cycleCell && cycleCell.querySelector('img.rejestracja-ikona'), doc);
          const regLink = cycleCell ? cycleCell.querySelector('a[href*="rejestracjaNaPrzedmiotCyklu"]') : null;
          if (!status && !regLink) return; // not active in the current cycle — skip
          const requiredForConditional = textOf(cells[cells.length - 1]);
          subjects.push({
            name,
            code,
            detailsUrl,
            period,
            status,
            registrationUrl: regLink ? regLink.href : null,
            requiredForConditional,
          });
        });

        sections.push({ label, currentCycleLabel, subjects });
      });

      return { supported: sections.length > 0, verified: true, sections };
    },

    // Verified against real markup at
    // .../katalog2/przedmioty/pokazPrzedmiot?prz_kod=<...> — the full subject
    // catalog page (description/ECTS/coordinators/lecturers, one block per
    // teaching cycle with its own registration status + a full timetable).
    // Fetched lazily (on click, from app.js) rather than prefetched in bulk.
    //
    // Every section on this page is a <usos-frame><h2 slot="title">…</h2>
    // <div>…</div></usos-frame> — sections are NOT h2-to-next-h2 siblings
    // like on the registration-calendar pages, each is fully self-contained.
    // The per-cycle timetable ("cykl przedmiotu" — all groups combined, not
    // just one) is server-rendered as plain <timetable-entry style="
    // grid-row-start: gHHMM; grid-row-end: gHHMM" color="N"><div slot="info">
    // — genuinely static markup, unlike the home/plan page's client-only
    // <usos-timetable> (see getPlan's comment) — so it parses fine here.
    getSubjectPage(doc = document) {
      // Some fields (observed on "Moodle:") are just a <usos-spinner> plus an
      // inline <script> that queues a client-side AJAX call to fill the cell
      // in on a live page load — textContent includes a <script>'s source
      // as plain text, so without stripping it we'd render raw JS as the
      // field's "value". We don't execute page JS or call that AJAX
      // endpoint ourselves, so these fields end up empty here — that's
      // surfaced by omitting them entirely rather than showing a blank row.
      function cellText(cell) {
        const clone = cell.cloneNode(true);
        clone.querySelectorAll('usos-tooltip, script, usos-spinner').forEach((t) => t.remove());
        return textOf(clone);
      }

      function fieldsFromTable(table) {
        const fields = [];
        table.querySelectorAll('tbody > tr').forEach((tr) => {
          const cells = tr.querySelectorAll(':scope > td');
          if (cells.length < 2) return;
          const label = (textOf(cells[0]) || '').replace(/:$/, '');
          if (!label) return;
          const value = cellText(cells[1]);
          if (!value) return;
          // Most fields have zero or one link (e.g. "Jednostka:"), kept as
          // `link` for existing callers. "Grupy:" is the one field that can
          // hold several <br>-separated links to different curriculum
          // groups — those all land in `links` too, so a caller that wants
          // them doesn't have to fall back to `value`'s squashed, separator-
          // less concatenation of every link's text run together.
          const anchors = [...cells[1].querySelectorAll('a')];
          const links = anchors.map((a) => ({ label: textOf(a), href: a.href })).filter((l) => l.label);
          fields.push({ label, value, link: anchors.length === 1 ? anchors[0].href : null, links });
        });
        return fields;
      }

      // Unlike getSubjectTimetable's full per-subject plan (a separate page,
      // see below), this mini widget's entries carry no parity/frequency
      // text at all — verified live: a real <timetable-entry> here has only
      // `style` (rounded grid position) and a one-letter [slot="info"], no
      // dialog-event or equivalent. A biweekly class can't be distinguished
      // from a weekly one here; that only shows up once you follow "Przejdź
      // do planu" into the full timetable below.
      function parseTimetable(tt) {
        const hourStart = parseInt(tt.getAttribute('start'), 10);
        const hourEnd = parseInt(tt.getAttribute('end'), 10);
        const days = [];
        [...tt.children].forEach((dayWrap) => {
          if (!dayWrap.querySelector) return;
          const dayLabelEl = dayWrap.querySelector('div > div');
          const tday = dayWrap.querySelector('timetable-day');
          if (!dayLabelEl || !tday) return;
          const entries = [...tday.querySelectorAll('timetable-entry')].map((entry) => {
            const style = entry.getAttribute('style') || '';
            const start = style.match(/grid-row-start:\s*g(\d{2})(\d{2})/);
            const end = style.match(/grid-row-end:\s*g(\d{2})(\d{2})/);
            const info = entry.querySelector('[slot="info"]');
            return {
              label: info ? textOf(info) : null,
              start: start ? `${start[1]}:${start[2]}` : null,
              end: end ? `${end[1]}:${end[2]}` : null,
            };
          });
          if (entries.length) days.push({ day: textOf(dayLabelEl), entries });
        });
        return {
          hourStart: Number.isFinite(hourStart) ? hourStart : null,
          hourEnd: Number.isFinite(hourEnd) ? hourEnd : null,
          days,
        };
      }

      const frames = [...doc.querySelectorAll('usos-frame')];
      const findFrame = (re) => frames.find((f) => {
        const h = f.querySelector('h2[slot="title"]');
        return h && re.test(textOf(h) || '');
      });

      const subjectName = textOf(doc.querySelector('main h1')) || null;

      const infoFrame = findFrame(/Informacje ogólne/i);
      const infoTable = infoFrame ? infoFrame.querySelector('table') : null;
      const generalInfo = infoTable ? fieldsFromTable(infoTable) : [];

      const cycles = [];
      frames.forEach((frame) => {
        const h2 = frame.querySelector('h2[slot="title"]');
        const heading = h2 ? textOf(h2) : '';
        const m = heading.match(/Zajęcia w cyklu\s+"([^"]+)"\s*\(([^)]*)\)/);
        if (!m) return;
        const cycleName = m[1];
        const cycleState = m[2];
        const table = frame.querySelector('table');
        if (!table) {
          cycles.push({ cycleName, cycleState, period: null, registrationStatus: null, registrationUrl: null, planUrl: null, classTypes: [], timetable: { hourStart: null, hourEnd: null, days: [] }, fields: [] });
          return;
        }

        let period = null;
        let registrationStatus = null;
        let registrationUrl = null;
        let planUrl = null;
        let timetable = { hourStart: null, hourEnd: null, days: [] };
        let classTypes = [];
        const fields = [];

        table.querySelectorAll('tbody > tr').forEach((tr) => {
          const cells = tr.querySelectorAll(':scope > td');
          if (cells.length < 2) return;
          const label = (textOf(cells[0]) || '').replace(/:$/, '');
          if (/^Okres$/i.test(label)) {
            period = textOf(cells[1]);
            const extraCell = cells[2];
            if (extraCell) {
              registrationStatus = tipText(extraCell.querySelector('img.rejestracja-ikona'), doc);
              const regLink = extraCell.querySelector('a[href*="rejestracjaNaPrzedmiotCyklu"]');
              registrationUrl = regLink ? regLink.href : null;
              const planLink = extraCell.querySelector('a[href*="pokazPlanZajecPrzedmiotu"]');
              planUrl = planLink ? planLink.href : null;
              const tt = extraCell.querySelector('usos-timetable');
              if (tt) timetable = parseTimetable(tt);
            }
          } else if (/^Typ zajęć$/i.test(label)) {
            classTypes = [...cells[1].querySelectorAll(':scope > div')].map((div) => {
              const link = div.querySelector('a[href*="pokazGrupyZajec"]');
              const clone = div.cloneNode(true);
              const usosLink = clone.querySelector('usos-link');
              if (usosLink) usosLink.remove();
              return { label: textOf(clone), groupsUrl: link ? link.href : null };
            });
          } else {
            const value = cellText(cells[1]);
            if (!value) return;
            const links = cells[1].querySelectorAll('a');
            fields.push({ label, value, link: links.length === 1 ? links[0].href : null });
          }
        });

        cycles.push({ cycleName, cycleState, period, registrationStatus, registrationUrl, planUrl, classTypes, timetable, fields });
      });

      return { supported: !!subjectName, verified: true, subjectName, generalInfo, cycles };
    },

    // Verified against real markup at
    // .../katalog2/przedmioty/pokazPlanZajecPrzedmiotu?prz_kod=<...>&cdyd_kod=<...>&plan_division=semester
    // — the full (non-mini) per-subject timetable that each cycle's "Przejdź
    // do planu" link on pokazPrzedmiot points to (captured as `planUrl` by
    // getSubjectPage). Unlike the mini widget embedded directly in
    // pokazPrzedmiot (which only has a one-letter class-type code per
    // entry), each <timetable-entry> here carries full-text slots —
    // dialog-info (class type + group), dialog-person (teacher), dialog-place
    // (room/building) — so this is fetched as a follow-up once a subject
    // page is open, to enrich the initially-shown mini timetable.
    //
    // IMPORTANT: the entry's `style="grid-row-start: gHHMM"` attribute is
    // ROUNDED to a coarse layout grid (observed g1700 for a class that
    // actually starts 17:05) — it's fine for visual position but wrong as
    // displayed text. The exact time only exists in the dialog-event slot's
    // text ("każdy poniedziałek, 17:05 - 18:45"), so that's the source of
    // truth for start/end here, with the style attribute only as a fallback
    // if that text doesn't parse.
    getSubjectTimetable(doc = document) {
      const tt = doc.querySelector('usos-timetable');
      if (!tt) return { supported: false, verified: false, hourStart: null, hourEnd: null, days: [] };

      const hourStart = parseInt(tt.getAttribute('start'), 10);
      const hourEnd = parseInt(tt.getAttribute('end'), 10);
      const days = [];
      [...tt.children].forEach((dayWrap) => {
        if (!dayWrap.querySelector) return;
        const dayLabelEl = dayWrap.querySelector('div > div');
        const tday = dayWrap.querySelector('timetable-day');
        if (!dayLabelEl || !tday) return;
        const entries = [...tday.querySelectorAll('timetable-entry')].map((entry) => {
          const eventText = textOf(entry.querySelector('[slot="dialog-event"]')) || '';
          const timeMatch = eventText.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
          let start = null;
          let end = null;
          if (timeMatch) {
            start = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
            end = `${timeMatch[3].padStart(2, '0')}:${timeMatch[4]}`;
          } else {
            const style = entry.getAttribute('style') || '';
            const s = style.match(/grid-row-start:\s*g(\d{2})(\d{2})/);
            const e = style.match(/grid-row-end:\s*g(\d{2})(\d{2})/);
            start = s ? `${s[1]}:${s[2]}` : null;
            end = e ? `${e[1]}:${e[2]}` : null;
          }
          const label = textOf(entry.querySelector('[slot="dialog-info"]'));
          const teacher = (textOf(entry.querySelector('[slot="dialog-person"]')) || '').replace(/,\s*$/, '') || null;
          // USOS sometimes prints the building code bracket twice in a row
          // (observed "[D-1] [D-1]") — collapse only an exact, consecutive
          // duplicate, so a place with just one bracket is left untouched.
          const place = (textOf(entry.querySelector('[slot="dialog-place"]')) || '')
            .replace(/\bbudynek:\s*/i, '')
            .replace(/\[([^\]]+)\]\s*\[\1\]/, '[$1]') || null;
          const weeks = parseWeeksParity(eventText);
          return { label, teacher, place, start, end, weeks };
        });
        if (entries.length) days.push({ day: textOf(dayLabelEl), entries });
      });

      return {
        supported: days.length > 0,
        verified: true,
        hourStart: Number.isFinite(hourStart) ? hourStart : null,
        hourEnd: Number.isFinite(hourEnd) ? hourEnd : null,
        days,
      };
    },
    // Verified against real markup at
    // .../katalog2/przedmioty/pokazGrupyZajec?zaj_cyk_id=<...> — the "grupy
    // →" / "więcej informacji" link on each class type in getSubjectPage.
    // Lists every group offered for that one class type (occupancy, teacher,
    // room, day/time), which is exactly what the schedule planner needs to
    // let a student compare alternatives before choosing one — this is never
    // submitted anywhere, just read. A group can meet more than once a week;
    // each visit is its own <br>-separated chunk inside the "Termin(y)"
    // cell, so every group's schedule comes back as a `sessions` array
    // rather than a single day/time pair.
    getClassGroups(doc = document) {
      const tables = [...doc.querySelectorAll('table.grey')];
      const groupsTable = tables.find((t) => {
        const header = t.querySelector('tr');
        return header && /Grupa/i.test(textOf(header)) && /Termin/i.test(textOf(header));
      });
      if (!groupsTable) return { supported: false, verified: false, groups: [] };

      const groups = [];
      groupsTable.querySelectorAll('tr').forEach((tr) => {
        if (tr.querySelector('th')) return;
        const cells = tr.querySelectorAll(':scope > td');
        if (cells.length < 4) return;
        const nr = textOf(cells[0]);
        if (!nr) return;

        const clone = cells[1].cloneNode(true);
        const chunks = [[]];
        clone.childNodes.forEach((node) => {
          if (node.nodeName === 'BR') chunks.push([]);
          else chunks[chunks.length - 1].push(node);
        });
        const sessions = chunks
          .map((nodes) => {
            const wrap = doc.createElement('div');
            nodes.forEach((n) => wrap.appendChild(n));
            const text = textOf(wrap) || '';
            const m = text.match(/(poniedziałek|wtorek|środa|czwartek|piątek|sobota|niedziela)[^,]*,\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/i);
            if (!m) return null;
            const place = text.slice(m.index + m[0].length).replace(/^[,\s]+/, '').replace(/[,\s]+$/, '');
            return {
              day: m[1].toLowerCase(),
              start: `${m[2].padStart(2, '0')}:${m[3]}`,
              end: `${m[4].padStart(2, '0')}:${m[5]}`,
              place: place || null,
              weeks: parseWeeksParity(text),
            };
          })
          .filter(Boolean);

        const teacher = textOf(cells[2]);
        // Verified live: some cycles (registration not yet synced) render
        // every group's "Miejsca" cell as a bare "0/" with no limit after
        // the slash — not a real occupancy figure, just noise, so only
        // keep it when it's an actual "N/M" count.
        const occupancyRaw = textOf(cells[3]);
        const occupancy = /^\d+\s*\/\s*\d+$/.test(occupancyRaw || '') ? occupancyRaw : null;
        const detailsLink = cells[4] ? cells[4].querySelector('a') : null;
        groups.push({ nr, sessions, teacher, occupancy, detailsUrl: detailsLink ? detailsLink.href : null });
      });

      return { supported: groups.length > 0, verified: true, groups };
    },
  };

  // ---------------------------------------------------------------------
  // Legacy adapter placeholder — classic table-based USOSweb (pre web
  // components), used at some other universities. UNVERIFIED: no real
  // instance inspected yet. Kept minimal on purpose; fill in once we can
  // test against a real classic USOSweb install.
  // ---------------------------------------------------------------------
  const legacyAdapter = {
    id: 'usosweb-legacy',
    version: null,
    matches() { return !hasModernShell() && looksLikeUsos(); },
    getUser() { return { name: null, album: null, faculty: null }; },
    getEtapy() { return { supported: false, verified: false, etapy: [] }; },
    getPlan() { return { supported: false, verified: false, raw: null }; },
    getGrades() { return { supported: false, verified: false, rows: [] }; },
    getExams() { return { supported: false, verified: false, exams: [] }; },
    getRegistrationRounds() { return { supported: false, verified: false, groups: [] }; },
    getOwnProgrammes() { return { supported: false, verified: false, programmes: [] }; },
    getNews() { return { supported: false, verified: false, items: [] }; },
    getPaymentGroups() { return { supported: false, verified: false, groups: [], grandTotal: null }; },
    getBankAccounts() { return { supported: false, verified: false, accounts: [] }; },
    getPaymentDetails() { return { supported: false, verified: false, generalInfo: [], tables: [] }; },
    getScholarships() { return { supported: false, verified: false, rows: [] }; },
    getTests() { return { supported: false, verified: false, rows: [] }; },
    getPetitions() { return { supported: false, verified: false, rows: [] }; },
    getSurveys() { return { supported: false, verified: false, rows: [] }; },
    getUnitDetail() { return { supported: false, verified: false, name: null, fields: [], ancestors: [], children: [] }; },
    getProgramDetail() { return { supported: false, verified: false, name: null, fields: [], kierunki: [], units: [], stages: [] }; },
    getStageSubjects() { return { supported: false, verified: false, sections: [] }; },
    getSubjectPage() { return { supported: false, verified: false, generalInfo: [], cycles: [] }; },
    getSubjectTimetable() { return { supported: false, verified: false, hourStart: null, hourEnd: null, days: [] }; },
    getClassGroups() { return { supported: false, verified: false, groups: [] }; },
  };

  function selectAdapter() {
    if (pwrAdapter.matches()) return pwrAdapter;
    if (legacyAdapter.matches()) return legacyAdapter;
    return null;
  }

  // Same condition selectAdapter() itself uses to give up (see its two
  // .matches() checks) — exposed separately so core/detect.js's platform
  // registry can ask "is this USOSweb at all" without pulling in an actual
  // adapter instance.
  function isUsosPage(doc = document) {
    return hasModernShell() || looksLikeUsos();
  }

  window.USOSPP_ADAPTERS = { selectAdapter, looksLikeUsos, isUsosPage, detectFooterVersion };
  if (window.USOSPP_CORE) window.USOSPP_CORE.registerDetector('usos', isUsosPage);
})();

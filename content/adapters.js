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

  function detectFooterVersion() {
    const row = document.querySelector('footer-row[icon="outlined.privacy_tip"]');
    const text = textOf(row) || '';
    const m = text.match(/USOSweb\s+([\d.]+)/i);
    return m ? m[1] : null;
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
          const links = cells[1].querySelectorAll('a');
          fields.push({ label, value, link: links.length === 1 ? links[0].href : null });
        });
        return fields;
      }

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
          return { label, teacher, place, start, end };
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

  window.USOSPP_ADAPTERS = { selectAdapter, looksLikeUsos, detectFooterVersion };
})();

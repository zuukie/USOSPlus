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

  // <local-time datetime="YYYY-MM-DD[ HH:MM:SS]"> renders client-side, so a
  // fetched (never-upgraded) document has no text there — the datetime
  // attribute is the source of truth. Normalized to DD.MM.YYYY for display.
  function isoDatePl(dt) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dt || '');
    return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
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

  // Strict Polish final-grade parser. The old approach matched any digit
  // anywhere in the cell, so subject codes ("13IST0-…"), cycles
  // ("2026/27-Z") or ECTS counts became phantom grades and produced a fake
  // average over subjects with "(brak ocen)". Only a whole cell exactly
  // equal to a grade from the Polish scale counts: 2.0, 3.0, 3.5, 4.0,
  // 4.5, 5.0, 5.5 (comma or dot separator). Returns normalized "X.Y" or
  // null. Shared by getGrades; app.js's fmtGrade delegates to the same
  // rule via USOSPP_ADAPTERS.parseStrictGrade.
  const STRICT_GRADE_RE = /^(2(?:[.,]0)?|3(?:[.,]0|[.,]5)?|4(?:[.,]0|[.,]5)?|5(?:[.,]0|[.,]5)?)$/;
  function parseStrictGrade(raw) {
    if (raw === null || raw === undefined) return null;
    const t = String(raw).trim().replace(/\s+/g, '');
    if (!STRICT_GRADE_RE.test(t)) return null;
    return t.replace(',', '.').replace(/^([2-5])$/, '$1.0');
  }

  // Biweekly ("co drugi tydzień") classes render their parity as plain text
  // right next to the day/time — e.g. "co drugi czwartek (nieparzyste),
  // 11:15 - 13:00" on a groups list, or "co drugi wtorek (parzyste), 7:30 -
  // 9:00" in a subject's own full plan (both verified live, 2026-09-14, on
  // a real biweekly subject: 08IZZ0-25S101O00121G). Also matched: the TP/TN
  // abbreviations, single-letter (P)/(N), "tyg. parzyste" and bare
  // "parzyste/nieparzyste" without parens. A weekly class's text
  // has no such marker at all ("każdy poniedziałek, ...").
  // Returns 'even'/'odd' when decidable, 'unknown' for a biweekly line
  // with no decidable parity ("co drugi ..." and nothing else — a real
  // conflict candidate, never a weekly), 'every' otherwise.
  function parseWeeksParity(text) {
    const t = text || '';
    // Explicit parity words first — "nieparzyste" checked via the (nie)?
    // group so it can't false-hit the "parzyste" branch. Applied to
    // schedule-line texts only, never to subject names.
    const m = t.match(/(nie)?parzyst[aey]/i);
    if (m) return m[1] ? 'odd' : 'even';
    if (/\bTP\b/.test(t)) return 'even';
    if (/\bTN\b/.test(t)) return 'odd';
    const single = t.match(/\(\s*([PpNn])\s*\)/);
    if (single) return single[1].toUpperCase() === 'P' ? 'even' : 'odd';
    if (/\bco drugi\b/i.test(t)) return 'unknown';
    return 'every';
  }

  // Polish weekday words (as rendered on home/grupy schedule lines) to the
  // short day keys shared with app.js's planner (PN..ND). Matches inflected
  // forms by prefix: "poniedziałek/poniedziałki", "środa/środę", etc.
  // Abbreviations ("pn", "czw", ...) only match as whole words — as
  // prefixes they'd false-hit ("wt" starts half the dictionary).
  const GROUP_DAY_PREFIX = {
    poniedzialek: 'PN', poniedzialki: 'PN',
    wtorek: 'WT', wtorku: 'WT', wtorki: 'WT',
    srod: 'ŚR',
    czwartek: 'CZ', czwartku: 'CZ', czwartki: 'CZ',
    piatek: 'PT', piatku: 'PT', piatki: 'PT',
    sobot: 'SO', niedziel: 'ND',
  };
  const GROUP_DAY_ABBR = {
    pn: 'PN', pon: 'PN', wt: 'WT', wto: 'WT', sr: 'ŚR', sro: 'ŚR',
    czw: 'CZ', cz: 'CZ', pt: 'PT', pia: 'PT', so: 'SO', sob: 'SO',
    nie: 'ND', niedz: 'ND', nd: 'ND',
  };
  function stripPl(word) {
    return (word || '').toLowerCase()
      .replace(/ą/g, 'a').replace(/ć/g, 'c').replace(/ę/g, 'e')
      .replace(/ł/g, 'l').replace(/ń/g, 'n').replace(/ó/g, 'o')
      .replace(/ś/g, 's').replace(/ź|ż/g, 'z');
  }
  function parseGroupDay(word) {
    const norm = stripPl(word);
    if (Object.prototype.hasOwnProperty.call(GROUP_DAY_ABBR, norm)) return GROUP_DAY_ABBR[norm];
    for (const prefix of Object.keys(GROUP_DAY_PREFIX)) {
      if (norm.startsWith(prefix)) return GROUP_DAY_PREFIX[prefix];
    }
    return null;
  }

  // One time range inside a schedule text: "11:15 - 13:00", "7:30-9:00",
  // en/em dashes, "11:15 do 13:00" and the colon-joined "17:05:18:45" /
  // "17:05 : 18:45" meeting-cell shape. Trailing seconds ("18:55:00") and
  // a "g." suffix are tolerated. Dot-separated "18.55-20.35" too (Polish
  // schedules use it). Returns zero-padded {start, end, index, length} or
  // null. Hours/minutes are range-checked — "99:99" or "24:00" don't pass.
  function parseTimeRange(text) {
    const t = text || '';
    const m = t.match(/(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(?::|-|–|—|\bdo\b)\s*(\d{1,2})[:.](\d{2})(?::\d{2})?/i);
    if (!m) return null;
    const h1 = parseInt(m[1], 10), n1 = parseInt(m[2], 10);
    const h2 = parseInt(m[3], 10), n2 = parseInt(m[4], 10);
    if (h1 > 23 || h2 > 23 || n1 > 59 || n2 > 59) return null;
    const pad = (h, n) => `${String(h).padStart(2, '0')}:${String(n).padStart(2, '0')}`;
    return { start: pad(h1, n1), end: pad(h2, n2), index: m.index, length: m[0].length };
  }

  // One schedule line from home/grupy, e.g. "każdy poniedziałek, 18:55 -
  // 20:35" or "co drugi czwartek (nieparzyste), 11:15 - 13:00". Returns
  // {day, start, end, weeks} or null when the line carries no time info.
  // The time range is found first (shared parseTimeRange: dashes, "do",
  // seconds, dot-separated all OK), then the nearest day word before it —
  // so a parity parenthetical between weekday and time can't break the
  // match (it used to null the whole line and silently drop every
  // biweekly session). Parity itself comes from parseWeeksParity.
  function parseGroupSession(text) {
    if (!text) return null;
    const tr = parseTimeRange(text);
    if (!tr) return null;
    const words = String(text).slice(0, tr.index).match(/[A-Za-ząćęłńóśźż]+/gi) || [];
    let day = null;
    for (let i = words.length - 1; i >= 0; i--) {
      day = parseGroupDay(words[i]);
      if (day) break;
    }
    if (!day) return null;
    return { day, start: tr.start, end: tr.end, weeks: parseWeeksParity(text) };
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
    return window.USOSPP_CORE_SANITIZE.sanitizeHtml(nodes, doc, window.USOSPP_CORE_SANITIZE.NEWS_ALLOWED_TAGS);
  }

  // Same sanitizer, for a raw HTML string (the pwnews JSON endpoint's
  // "opis" field) instead of already-parsed document nodes: DOMParser
  // builds an inert document from the string (no scripts run, links
  // don't resolve), then the allowlist walk rebuilds it like any other
  // fetched body before it may enter our DOM.
  function sanitizeNewsHtmlString(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return window.USOSPP_CORE_SANITIZE.sanitizeHtml(Array.from(parsed.body.childNodes), parsed, window.USOSPP_CORE_SANITIZE.NEWS_ALLOWED_TAGS);
  }

  // The pwnews add-on's own inline renderer reads its data through a
  // getField(entry, [name variants]) indirection (read from its source on
  // the live news/default page) — normalize the same way instead of
  // hardcoding one spelling and breaking on entries the add-on itself
  // still accepts.
  function newsJsonField(entry, names) {
    for (let i = 0; i < names.length; i++) {
      const v = entry[names[i]];
      if (typeof v === 'string' && v !== '') return v;
    }
    return '';
  }

  // News/default's server-rendered HTML is NOT uniform across USOSweb
  // installations — each observed shape lives in its own feature-detected
  // parser below and getNews tries them in order (plus the pwnews JSON
  // probe in scraping.js's collectNews when all of these come back
  // empty). Never keyed by hostname: universities restyle these pages
  // on their own schedule (PB's page was "ostatnia modyfikacja: ~1,5
  // dnia" when discovered), so detection has to follow the markup that's
  // actually on screen today. All slices below share the {title, html}
  // news item shape (and no date — only the pwnews JSON has one).
  const NEWS_HEADING_TAG = /^H[2-6]$/;

  // Shape A (verified live at web.usos.pwr.edu.pl, 2026-09-16): a flat
  // sibling sequence inside <div class="wrtext"> where each
  // announcement's heading is a <div class="title-wrapper-section">…
  // <h4>…</h4></div> immediately followed by plain <div> wrappers with
  // its <p> body. The page's own greeting ("Witaj w systemie USOSweb")
  // uses the plain "title-wrapper" class instead — naturally excluded by
  // matching only the "-section" suffix.
  function parseTitleSectionNews(doc) {
    const anyHeading = doc.querySelector('.title-wrapper-section');
    const wrtext = anyHeading ? anyHeading.closest('.wrtext') : null;
    if (!wrtext) return [];
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
    return items
      .filter((it) => it.title)
      .map((it) => ({ title: it.title, html: sanitizeNewsHtml(it.bodyNodes, doc) }));
  }

  // Shape B (verified live at usosweb.ujd.edu.pl 2026-09-16, anonymous):
  // one <div class="wrtext"> holding the whole announcement archive as
  // flat heading + body siblings, with <hr> elements as the only
  // separators. Each segment's title is its FIRST h2-h6; the greeting is
  // the page-level <h1> ("Witaj w systemie…" — same role as shape A's
  // plain title-wrapper block, single live sample so far), so h1-titled
  // segments are dropped. Headings nested INSIDE a segment's body
  // (sub-blocks like per-course registration lists) stay body. HTML
  // comments holding retired announcements never become headings (they
  // aren't elements) and die in sanitization.
  function parseHrSegmentNews(doc) {
    for (const wrtext of doc.querySelectorAll('.wrtext')) {
      const kids = Array.from(wrtext.children);
      // Both markers must be DIRECT children: other installations float
      // note tables (data-migration status, "ostatnia modyfikacja") in
      // their own bare wrtext divs with neither headings nor separators.
      if (!kids.some((el) => NEWS_HEADING_TAG.test(el.tagName))) continue;
      if (!kids.some((el) => el.tagName === 'HR')) continue;

      const segmentItems = [];
      let current = null;
      const flush = () => { if (current) { segmentItems.push(current); current = null; } };
      Array.from(wrtext.childNodes).forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'HR') {
          flush();
          return;
        }
        if (!current) current = { title: null, bodyNodes: [] };
        if (current.title === null && node.nodeType === Node.ELEMENT_NODE) {
          if (NEWS_HEADING_TAG.test(node.tagName)) {
            current.title = textOf(node);
            return; // the heading itself is not part of the body
          }
          if (node.tagName === 'H1') {
            current.title = false; // page greeting segment — dropped by the filter below
            return;
          }
        }
        current.bodyNodes.push(node);
      });
      flush();

      const news = segmentItems
        .filter((it) => it.title)
        .map((it) => ({ title: it.title, html: sanitizeNewsHtml(it.bodyNodes, doc) }));
      if (news.length > 0) return news;
    }
    return [];
  }

  // Shape C (verified live at usosweb.pb.edu.pl 2026-09-16, anonymous):
  // announcements as consecutive <div class="pole …"> siblings, one
  // heading each (h3 observed), the rest of the pole's nodes its body.
  // The class token after "pole" is just a color category (informacja /
  // uwaga / red — red ones were only seen inside a comment holding a
  // retired maintenance notice, but they clearly intend to use it for
  // live urgent ones), so every .pole with a heading is kept rather than
  // trusting one category. The greeting ("Witamy w systemie…", observed
  // first at PB but mid-archive at PBS — shape F) is dropped by a
  // position-independent text check, not a first-item rule: no heading
  // separates it structurally (verified at PB; Polish-only pattern,
  // non-Polish installations would at worst show their greeting as one
  // extra announcement, which degrades gracefully).
  function parsePoleNews(doc) {
    const poles = doc.querySelectorAll('div.pole');
    const news = [];
    poles.forEach((pole, index) => {
      const heading = Array.from(pole.children).find((el) => /^H[1-6]$/.test(el.tagName));
      if (!heading) return;
      const title = textOf(heading);
      if (!title) return;
      if (/^(witaj|witamy)\b/i.test(title)) return;
      const bodyNodes = Array.from(pole.childNodes).filter((n) => n !== heading);
      news.push({ title, html: sanitizeNewsHtml(bodyNodes, doc) });
    });
    return news;
  }

  // Shape D (verified live at usosweb.al.edu.pl 2026-09-17, anonymous):
  // announcements as <div class="info-box"> siblings grouped under
  // <div class="separator-box"> section dividers, all inside .usos-ui.
  // Each box's title is its <p class="header">, its date (when present)
  // its <p class="stamp"> ("Dodano: DD.MM.YYYY r." — passed through as
  // raw text, like the pwnews JSON date; DOM shapes A-C have no date).
  // The remaining nodes are the body, sanitized like every other shape.
  // Only boxes carrying a stamp are kept: the page mixes real
  // announcements (the "Komunikaty" section) with undated static help
  // (login instructions, file links, migration timetable), and the
  // greeting lives in a separate .head-box outside the items. None of
  // this page's markers (h1-h6, hr, .pole, .title-wrapper) exist here,
  // so shapes A-C can't fire on it — and this parser requires the
  // .info-box + .separator-box pair, so it can't fire on theirs.
  function parseInfoBoxNews(doc) {
    const scope = doc.querySelector('.usos-ui');
    if (!scope) return [];
    if (!scope.querySelector('.info-box') || !scope.querySelector('.separator-box')) return [];
    const news = [];
    scope.querySelectorAll('.info-box').forEach((box) => {
      const header = box.querySelector('p.header');
      const title = textOf(header);
      if (!title) return;
      const stamp = box.querySelector('p.stamp');
      const stampText = textOf(stamp);
      if (!stampText) return; // undated static help — not an announcement
      const m = stampText.match(/Dodano:\s*(.+)/i);
      const date = m ? m[1].trim() : stampText;
      const bodyNodes = Array.from(box.childNodes).filter((n) => n !== header && n !== stamp);
      news.push({ title, html: sanitizeNewsHtml(bodyNodes, doc), date });
    });
    return news;
  }

  // Shape E (verified live at usosweb.tu.kielce.pl 2026-09-17,
  // anonymous): announcements as <usos-frame> cards, each headed by
  // <h2 slot="title"> (any h1-h6 accepted) with the body in the frame's
  // remaining nodes. The first frame is the greeting ("Witamy w
  // systemie…") — dropped by a position-independent witamy check, since
  // shape F proved greetings can sit mid-archive, not just first. No
  // dates on this installation. Tried after A-D: PWr's modern shell also
  // uses usos-frame, but shape A wins there first whenever it matches.
  function parseFrameNews(doc) {
    const frames = Array.from(doc.querySelectorAll('usos-frame'));
    const titled = frames.filter((f) => f.querySelector('h1,h2,h3,h4,h5,h6'));
    if (!titled.length) return [];
    const news = [];
    titled.forEach((frame) => {
      const heading = frame.querySelector('h1,h2,h3,h4,h5,h6');
      const title = textOf(heading);
      if (!title) return;
      if (/^(witaj|witamy)\b/i.test(title)) return;
      const bodyNodes = Array.from(frame.childNodes).filter((n) => n !== heading);
      news.push({ title, html: sanitizeNewsHtml(bodyNodes, doc) });
    });
    return news;
  }

  // Shape F (verified live at usosweb.pbs.edu.pl + usosweb.po.edu.pl
  // 2026-09-17, anonymous — one parser covers both installations):
  // one <table class="grey"> per announcement, with the title in its
  // <tr class="strong"> row and the body in the remaining rows (table /
  // tr / td are not in the sanitizer allowlist, so they unwrap down to
  // their text and links automatically). Tables WITHOUT a strong row
  // are the installation's own metadata (data-migration status,
  // "ostatnia modyfikacja") and are skipped structurally, not by text.
  // The greeting ("Witamy na PBŚ!") sits mid-archive here, hence the
  // position-independent witamy drop (also applied to shape C below).
  // No dates on either installation.
  function parseStrongTableNews(doc) {
    const tables = doc.querySelectorAll('table.grey');
    if (!tables.length) return [];
    const news = [];
    tables.forEach((table) => {
      const strongRow = table.querySelector('tr.strong');
      if (!strongRow) return;
      const title = textOf(strongRow);
      if (!title) return;
      if (/^(witaj|witamy)\b/i.test(title)) return;
      const strongRows = new Set([strongRow]);
      const bodyNodes = [];
      table.querySelectorAll('tr').forEach((tr) => {
        if (!strongRows.has(tr)) bodyNodes.push(tr);
      });
      news.push({ title, html: sanitizeNewsHtml(bodyNodes, doc) });
    });
    return news;
  }

  // Shape G (verified live at usosweb.polsl.pl 2026-09-17, anonymous):
  // flat flow where each announcement starts at an <h1>, body runs to
  // the next <h1> (an <hr/> additionally cuts off a heading-less EU
  // project footer, dropped for having no title). Unlike shape B,
  // titles ARE h1 here, so B's h1-drop would eat them — G runs after B
  // and only fires when B found nothing. Retired announcements inside
  // HTML comments never become headings (they aren't elements). Static
  // help sections ("LOGOWANIE DO USOSWEB") are structurally identical
  // to news and are kept deliberately — same graceful-degradation call
  // as shape C's non-Polish greeting. Title-bearing panel links (the
  // mLegitymacja h1 links a sub-panel file) stay plain text: bodies are
  // never rewritten. At least two titled segments are required, so a
  // one-h1 static info page can't pose as an archive. No dates here.
  function parseH1SegmentNews(doc) {
    const scope = doc.querySelector('main, #content, .usos-ui');
    if (!scope) return [];
    const h1s = Array.from(scope.querySelectorAll('h1'));
    if (h1s.length < 2) return [];
    const container = h1s[0].parentElement;
    if (!container || container.querySelectorAll('h1').length < 2) return [];
    const items = [];
    let current = null;
    let stopped = false;
    const flush = () => { if (current) { items.push(current); current = null; } };
    Array.from(container.childNodes).forEach((node) => {
      if (stopped) return;
      if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'H1' || node.tagName === 'HR')) {
        flush();
        if (node.tagName === 'H1') {
          const title = textOf(node);
          if (!title) return;
          if (/^(witaj|witamy)\b/i.test(title)) return;
          current = { title, bodyNodes: [] };
        }
        return;
      }
      // A nested <hr/> (e.g. wrapped in a centering div, as on the live
      // page) marks the footer boundary: flush and ignore everything
      // after it instead of appending boilerplate to the last item.
      if (node.nodeType === Node.ELEMENT_NODE && node.querySelector('hr')) {
        flush();
        stopped = true;
        return;
      }
      if (current) current.bodyNodes.push(node);
    });
    flush();
    return items
      .filter((it) => it.title)
      .map((it) => ({ title: it.title, html: sanitizeNewsHtml(it.bodyNodes, doc) }));
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
    // Each stage section carries its own "Szczegóły" link with etpos_id
    // (the key for the per-stage details page); each programme frame's
    // div[slot=foot] carries the rozliczenie state + the auto-settlement
    // hint. We only read the state — the actual "Zgłoś program do
    // rozliczenia" POST (behind a confirm dialog) stays in classic USOS.
    getEtapy(doc = document) {
      const out = [];
      doc.querySelectorAll('usos-frame').forEach((frame) => {
        const titleEl = frame.querySelector('h2[slot="title"]');
        const programLabel = textOf(titleEl);
        if (!programLabel) return;
        const foot = frame.querySelector('div[slot="foot"]');
        // The tooltip embeds the auto-settlement date as <local-time>
        // (no text in fetched docs), so rebuild from child nodes with the
        // datetime attribute resolved to DD.MM.YYYY.
        const tip = foot ? foot.querySelector('usos-tooltip') : null;
        let podpowiedz = null;
        if (tip) {
          podpowiedz = [...tip.childNodes].map((n) => {
            if (n.nodeType === 1 && n.tagName === 'LOCAL-TIME') return isoDatePl(n.getAttribute('datetime')) || '';
            return n.textContent || '';
          }).join('').replace(/\s+/g, ' ').trim() || null;
        }
        const rozliczenie = foot ? {
          stan: (textOf(foot.querySelector('b')) || '').replace(/\s+/g, ' ').trim() || null,
          // "Program zostanie zgłoszony do rozliczenia automatycznie
          // <date>. Jeśli masz zaliczenia…" — kept as plain text hint.
          podpowiedz,
          doZgloszenia: /zgłoś program do rozliczenia/i.test(textOf(foot.querySelector('button')) || ''),
        } : null;
        frame.querySelectorAll('usos-frame-section').forEach((section) => {
          const label = section.getAttribute('section-title') || '';
          const kv = {};
          section.querySelectorAll('.inline-keyvalue-list > div').forEach((row) => {
            const cells = row.querySelectorAll(':scope > div');
            if (cells.length >= 2) {
              const key = textOf(cells[0]).replace(/:$/, '');
              // Dates render via <local-time> (empty text in fetched docs).
              const lt = cells[1].querySelector('local-time');
              kv[key] = (lt && isoDatePl(lt.getAttribute('datetime'))) || textOf(cells[1]);
            }
          });
          const statusTag = section.querySelector('usos-tag');
          const detailsLink = section.querySelector('a[href*="zaliczenia/pokazEtap"]');
          const detailsHref = detailsLink ? (detailsLink.getAttribute('href') || '') : '';
          const detailsMatch = detailsHref.match(/[?&]etpos_id=(\d+)/);
          out.push({
            programLabel,
            label,
            cycle: kv['Cykl realizacji'] || null,
            endDate: kv['Data zakończenia'] || null,
            status: textOf(statusTag),
            detailsId: detailsMatch ? detailsMatch[1] : null,
            rozliczenie,
          });
        });
      });
      return { supported: true, verified: true, etapy: out };
    },

    // "Szczegółowe informacje o zaliczeniu etapu"
    // (.../zaliczenia/pokazEtap&etpos_id=N). Verified against real markup:
    // context kv-list (Program/Etap/Cykl), one table.grey with the point
    // totals + conditional/full requirements, ul.wymagania-przedmiotowe
    // with per-subject status, and a kv-list Podsumowanie ("Do zaliczenia
    // warunkowego/pełnego brakuje:" + "Status zaliczenia:"). Unknown rows
    // are kept as plain text rather than dropped; missing sections yield
    // null instead of failing the whole parse.
    getEtapDetails(doc = document) {
      const kvPairs = (root) => {
        const kv = {};
        if (!root) return kv;
        root.querySelectorAll(':scope > div').forEach((row) => {
          const cells = row.querySelectorAll(':scope > div');
          if (cells.length >= 2) {
            kv[(textOf(cells[0]) || '').replace(/:$/, '')] = textOf(cells[1]);
          }
        });
        return kv;
      };
      const statusOf = (text) => {
        const t = (text || '').toLowerCase();
        if (/niespełnione/.test(t)) return 'niespełnione';
        if (/spełnione/.test(t)) return 'spełnione';
        return null;
      };
      const main = doc.querySelector('#layout-main-content') || doc;
      const ctx = kvPairs(main.querySelector('.inline-keyvalue-list.context-list'));
      const punkty = { zEtapu: null, zPoprzednich: null, razem: null, warunkowe: null, pelne: null };
      const table = main.querySelector('table.grey');
      if (table) {
        [...table.rows].forEach((row, ri) => {
          const cells = [...row.cells].map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim());
          if (ri === 0 || cells.length < 2) return; // header ("P1 / Status")
          const label = cells[0];
          const value = cells[1] || null;
          const status = cells.length > 2 ? statusOf(cells[2]) : null;
          if (/^suma punktów z etapu/i.test(label)) punkty.zEtapu = value;
          else if (/poprzednich/i.test(label)) punkty.zPoprzednich = value;
          else if (/^razem/i.test(label)) punkty.razem = value;
          else if (/warunkowego/i.test(label)) punkty.warunkowe = { wymagane: value, status };
          else if (/pełnego/i.test(label)) punkty.pelne = { wymagane: value, status };
        });
      }
      const wymagania = [];
      main.querySelectorAll('ul.wymagania-przedmiotowe > li').forEach((li) => {
        const text = (li.textContent || '').replace(/\s+/g, ' ').trim();
        const codeMatch = text.match(/\[([^\]]+)\]/);
        const nameEl = li.querySelector('a') || li.querySelector('span.font-medium');
        const podMatch = text.match(/program \/ etap podpięcia:\s*(.*?)\s*(spełnione|niespełnione)?$/i);
        wymagania.push({
          nazwa: textOf(nameEl) || text.split('[')[0].trim() || null,
          kod: codeMatch ? codeMatch[1] : null,
          podpiecie: podMatch ? (podMatch[1].trim() || null) : null,
          status: statusOf(text),
        });
      });
      const podsumowanie = { brakujeWarunkowe: [], brakujePelne: [], status: null };
      const dl = main.querySelector('kv-list dl');
      if (dl) {
        [...dl.children].forEach((child) => {
          if (child.tagName === 'DT') {
            const key = (child.textContent || '').replace(/\s+/g, ' ').trim();
            const dd = child.nextElementSibling;
            const items = dd
              ? [...dd.querySelectorAll('li')].map((li) => (li.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
              : [];
            if (/warunkowego/i.test(key)) podsumowanie.brakujeWarunkowe = items;
            else if (/pełnego/i.test(key)) podsumowanie.brakujePelne = items;
            else if (/status zaliczenia/i.test(key)) {
              podsumowanie.status = items[0] || (dd ? (dd.textContent || '').replace(/\s+/g, ' ').trim() : null) || null;
            }
          }
        });
      }
      const statusTag = main.querySelector('usos-tag');
      if (!podsumowanie.status) podsumowanie.status = textOf(statusTag) || null;
      return {
        supported: true,
        verified: true,
        program: ctx['Program'] || null,
        etap: ctx['Etap'] || null,
        cykl: ctx['Cykl realizacji'] || null,
        punkty,
        wymagania,
        podsumowanie,
      };
    },

    // The rendered <usos-timetable> only builds its grid client-side inside
    // an *open* shadow root, which won't exist on a document fetched via
    // fetch()+DOMParser (custom elements never upgrade there). Instead we
    // read the raw data literal the server embeds for the JS to consume:
    // <script type="module">register('plan', 'home/index', [ ...events ]);
    // Only the empty-array case ([]) was observed for a long time. Verified
    // live 2026-09-28: on week views the third argument is NOT an array at
    // all but a params object, e.g.
    //   register('plan', 'home/plan', {"plan_week_sel_week":"2026-10-05"});
    // and the events themselves are loaded client-side by usosweb/
    // timetable.js (XHR), which fetch()+DOMParser never executes — so the
    // static register() literal is NOT a reliable plan source. It stays as
    // a best-effort primary (balanced-bracket parse, array only); the real
    // weekly plan is reconstructed from home/grupy via getMyGroups below,
    // which is fully server-rendered.
    getPlan(doc = document) {
      const scripts = [...doc.querySelectorAll('script')];
      for (const script of scripts) {
        const text = script.textContent || '';
        const head = text.match(/register\(\s*'plan'\s*,\s*'[^']*'\s*,/);
        if (!head) continue;
        const start = text.indexOf('[', head.index + head[0].length);
        if (start === -1) continue; // object params (week view) — no static events
        let depth = 0;
        let inStr = null;
        let esc = false;
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === inStr) inStr = null;
            continue;
          }
          if (ch === '"' || ch === "'") { inStr = ch; continue; }
          if (ch === '[') depth++;
          else if (ch === ']') {
            depth--;
            if (depth === 0) {
              const literal = text.slice(start, i + 1);
              try {
                return { supported: true, verified: true, raw: JSON.parse(literal) };
              } catch (e) {
                return { supported: true, verified: false, raw: null, parseError: true };
              }
            }
          }
        }
        return { supported: true, verified: false, raw: null, parseError: true };
      }
      return { supported: false, verified: false, raw: null };
    },

    // "Moje zajęcia" (home/grupy) — the student's own enrolled groups, fully
    // server-rendered (verified live 2026-09-28 on a real account):
    //   <usos-frame class="student"> <h2>Grupy, których jestem uczestnikiem</h2>
    //     <ul class="no-bullets separated"> <li>
    //       <div><span class="font-medium">NAME</span> [CODE]</div>
    //       <div>Semestr zimowy 2026/27</div>
    //       <ul> <li>
    //         <div><a href="...pokazZajecia&zaj_cyk_id=..&gr_nr=..">TYPE, grupa nr N</a></div>
    //         <div><ul class="no-bullets ..."><li>każdy poniedziałek, 18:55 - 20:35</li></ul></div>
    // Weekly lines ("każdy X, HH:MM - HH:MM") and biweekly ones
    // ("co drugi czwartek (nieparzyste), 11:15 - 13:00" — see
    // parseWeeksParity above) are parsed into sessions. This is the primary
    // source for the USOS++ weekly plan view.
    getMyGroups(doc = document) {
      const frames = [...doc.querySelectorAll('usos-frame')];
      const frame = frames.find((f) => {
        const h = f.querySelector('h2[slot="title"], h2');
        return h && /grupy,? których jestem uczestnikiem/i.test(textOf(h) || '');
      });
      if (!frame) return { supported: false, verified: false, subjects: [] };
      const subjects = [];
      const topList = frame.querySelector('ul.no-bullets.separated, ul');
      const topItems = topList
        ? [...topList.children].filter((el) => el.tagName === 'LI')
        : [];
      topItems.forEach((li) => {
        const nameEl = li.querySelector(':scope > div > span.font-medium');
        const headDiv = li.querySelector(':scope > div');
        const headText = textOf(headDiv) || '';
        const codeMatch = headText.match(/\[([^\]]+)\]\s*$/);
        const name = textOf(nameEl) || headText.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
        if (!name) return;
        const semDivs = [...li.querySelectorAll(':scope > div')];
        const semester = semDivs.length > 1 ? textOf(semDivs[1]) : null;
        const groups = [];
        li.querySelectorAll(':scope > ul > li').forEach((gli) => {
          const link = gli.querySelector('a[href*="pokazZajecia"]');
          const linkText = textOf(link) || '';
          const typeMatch = linkText.match(/^([^,]+),\s*grupa nr\s*(\d+)/i);
          let zajCykId = null;
          let grNr = typeMatch ? typeMatch[2] : null;
          let detailsUrl = link ? link.href : null;
          if (link) {
            try {
              const u = new URL(link.href);
              zajCykId = u.searchParams.get('zaj_cyk_id');
              if (!grNr) grNr = u.searchParams.get('gr_nr');
            } catch (e) { /* keep nulls */ }
          }
          const sessions = [];
          gli.querySelectorAll('ul li').forEach((sli) => {
            const s = parseGroupSession(textOf(sli) || '');
            if (s) sessions.push(s);
          });
          groups.push({
            type: typeMatch ? typeMatch[1].trim() : linkText,
            nr: grNr,
            zajCykId,
            detailsUrl,
            sessions,
          });
        });
        subjects.push({ name, code: codeMatch ? codeMatch[1] : null, semester, groups });
      });
      return { supported: subjects.length > 0, verified: true, subjects };
    },

    // Somebody-else's shared timetable (pokazPlanZajecStudenta&token=… or
    // &os_id=…, see usos/shared-plans-store.js). Same modern shell as the
    // employee plan: <timetable-day> columns of <timetable-entry name
    // subject name-id="CODE"> with slot="info|time|dialog-*". Verified live
    // 2026-10-06: week switching is a plain GET with
    // &plan_week_sel_week=YYYY-MM-DD, and <timetable-day> carries no date
    // attribute — dates come from the requested Monday + column index.
    // Sessions come out in the own-plan shape (weeklyPlan /
    // concreteSessionsForOffset) plus foreign:true, so the week grid, list
    // view and session modal render them unchanged; the roster row is
    // skipped for foreign sessions (see planSessionRosterRow).
    getSharedPlan(doc = document, mondayIso = null) {
      const none = { supported: false, verified: false, notShared: false, ownerName: null, sessions: [] };
      let bodyText = '';
      try { bodyText = textOf(doc.body) || ''; } catch (e) { return none; }
      const h1Text = textOf(doc.querySelector('h1')) || '';
      let ownerName = null;
      // The h1 carries a date-range note after the name ("X -
      // udostępniony plan zajęć (YYYY-MM-DD - YYYY-MM-DD)") — strip the
      // parenthetical before matching the owner.
      const ownerMatch = h1Text.replace(/\s*\(.*?\)\s*$/, '').match(/^(.*?)\s*-\s*udostępniony plan zajęć\s*$/i);
      if (ownerMatch && ownerMatch[1].trim()) ownerName = ownerMatch[1].trim();
      // Same h1, no timetable: sharing off (or an expired token).
      if (/nie udostępnia (swojego )?planu/i.test(bodyText)) {
        return { supported: false, verified: true, notShared: true, ownerName, sessions: [] };
      }
      const days = [...doc.querySelectorAll('timetable-day')];
      if (!days.length) return none;
      // Resolve the displayed week's Monday: explicit request param wins,
      // then the "później" switch (next Monday minus 7 days), then the
      // "Plan udostępniony YYYY-MM-DD - …" header.
      let monday = /^\d{4}-\d{2}-\d{2}$/.test(mondayIso || '') ? mondayIso : null;
      if (!monday) {
        const later = [...doc.querySelectorAll('a[data-setting-name="week_sel_week"]')]
          .find((a) => /później/i.test(textOf(a) || ''));
        const laterVal = later && later.getAttribute('data-setting-value');
        if (/^\d{4}-\d{2}-\d{2}$/.test(laterVal || '')) {
          const d = new Date(`${laterVal}T00:00:00`);
          d.setDate(d.getDate() - 7);
          monday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
      }
      if (!monday) {
        const hm = bodyText.match(/plan udostępniony\s*(\d{4}-\d{2}-\d{2})/i);
        if (hm) monday = hm[1];
      }
      if (!monday) return none;
      const DAY_KEYS = ['PN', 'WT', 'ŚR', 'CZ', 'PT', 'SO', 'ND'];
      const isoOf = (baseIso, addDays) => {
        const d = new Date(`${baseIso}T00:00:00`);
        d.setDate(d.getDate() + addDays);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const sessions = [];
      days.forEach((dayEl, dayIdx) => {
        const day = DAY_KEYS[dayIdx] || null;
        if (!day) return;
        const date = isoOf(monday, dayIdx);
        [...dayEl.querySelectorAll('timetable-entry')].forEach((entry) => {
          const info = textOf(entry.querySelector('[slot="info"]')) || '';
          const eventRange = textOf(entry.querySelector('[slot="dialog-event"]')) || '';
          const timeOnly = textOf(entry.querySelector('[slot="time"]')) || '';
          const infoLink = entry.querySelector('[slot="dialog-info"] a');
          const infoLinkText = textOf(infoLink) || '';
          const rangeParts = eventRange.split(/\s*[—–-]\s*/).map((t) => t.trim()).filter(Boolean);
          const start = rangeParts[0] || timeOnly.trim() || null;
          const end = rangeParts[1] || null;
          if (!start) return;
          const infoMatch = info.match(/^([^,]+),\s*gr\.\s*(\d+)\s*\(([^)]*)\)/);
          const place = infoMatch ? infoMatch[3] : '';
          const roomFromInfo = place.split(',')[0].trim() || null;
          const bcodeMatch = place.match(/bud\.\s*([A-Za-z0-9-]+)/i);
          const personLinks = [...entry.querySelectorAll('[slot="dialog-person"] a')];
          const teacher = personLinks.map((a) => textOf(a).trim()).filter(Boolean).join(', ') || null;
          const placeEl = entry.querySelector('[slot="dialog-place"]');
          const roomLinkText = textOf(placeEl && placeEl.querySelector('a')) || '';
          const room = roomLinkText.replace(/^sala\s+/i, '').replace(/,\s*$/, '').trim() || roomFromInfo;
          const bLinks = placeEl ? [...placeEl.querySelectorAll('a')] : [];
          const rawBuilding = textOf(bLinks[bLinks.length - 1]) || '';
          const normBuilding = rawBuilding.replace(/\[([^\]]+)\]\s*\[\1\]\s*$/, '[$1]').trim();
          const building = normBuilding || (bcodeMatch ? `[${bcodeMatch[1]}]` : null);
          const typeFull = (infoLinkText.split(',')[0] || '').trim();
          let detailsUrl = null;
          const href = infoLink && infoLink.getAttribute('href');
          if (href) {
            try { detailsUrl = new URL(href, location.origin).toString(); } catch (e) { /* keep null */ }
          }
          sessions.push({
            day,
            date,
            start,
            end,
            weeks: 'every',
            semester: null,
            subject: entry.getAttribute('name') || 'Zajęcia',
            code: entry.getAttribute('name-id') || null,
            type: typeFull || (infoMatch ? infoMatch[1].trim() : null),
            nr: infoMatch ? infoMatch[2] : null,
            detailsUrl,
            room: room || null,
            roomUrl: null,
            building,
            teacher,
            foreign: true,
          });
        });
      });
      const order = { PN: 0, WT: 1, ŚR: 2, CZ: 3, PT: 4, SO: 5, ND: 6 };
      sessions.sort((a, b) => (order[a.day] ?? 9) - (order[b.day] ?? 9) || String(a.start).localeCompare(String(b.start)));
      sessions.forEach((e, i) => { e.idx = i; });
      return { supported: sessions.length > 0, verified: true, notShared: false, ownerName, sessions };
    },

    // The user's own public plan link (home/publicznyLinkDoPlanu) — a
    // dialog fragment carrying the token URL in <text-field id="link14"
    // value="…pokazPlanZajecStudenta&token=…">. Pure read; the token is
    // the viewer's access credential, so callers display it only on
    // explicit user request and never persist it (see app.js).
    getOwnPlanLink(doc = document) {
      const miss = { supported: false, verified: false, url: null };
      let field = null;
      try {
        field = doc.querySelector('text-field#link14');
      } catch (e) {
        return miss;
      }
      const value = field && field.getAttribute('value');
      if (!value || !/pokazPlanZajecStudenta/i.test(value)) return miss;
      let url = null;
      try {
        url = new URL(value, location.origin).toString();
      } catch (e) {
        return miss;
      }
      return { supported: true, verified: true, url };
    },

    // Which plan-sharing mode is on (home/preferencje/preferencjeUsosweb,
    // "Plan zajęć studenta" radios). Read-only display only — flipping it
    // is a server-side write, the one thing this extension never does.
    // mode: 'zalogowani' (every logged-in user sees the plan, no expiry) |
    // 'tylko_ja' (off — only a 14-day token link works) | null (unknown).
    getPlanVisibility(doc = document) {
      const miss = { supported: false, verified: false, mode: null };
      let checked = null;
      try {
        checked = doc.querySelector('input[name="widocznosc_planu_zajec"]:checked');
      } catch (e) {
        return miss;
      }
      const value = checked && checked.getAttribute('value');
      if (value !== 'zalogowani' && value !== 'tylko_ja') return miss;
      return { supported: true, verified: true, mode: value };
    },

    // Verified live 2026-09-28 on a real account (PWr): the grades frame
    // (usos-frame#oceny) holds one table with a real <thead> —
    // Przedmiot | Program | Ocena | Akcje — and one row per subject. A
    // subject with no grade yet renders "(brak ocen)" in the Ocena cell, so
    // the row list is NOT the grade list: only cells from the Ocena column
    // that strictly match a Polish final grade count (see STRICT_GRADE_RE).
    // Rows keep the {subject, code, program, grade} shape; grade is the
    // normalized "X.Y" string or null.
    getGrades(doc = document) {
      const frame = doc.querySelector('usos-frame#oceny, usos-frame.oceny');
      if (!frame) return { supported: false, verified: false, rows: [] };
      const table = frame.querySelector('table');
      if (!table) {
        const sectionRows = [...frame.querySelectorAll('usos-frame-section')].map((section) => ({
          label: section.getAttribute('section-title') || '',
          text: textOf(section),
        }));
        return { supported: true, verified: false, rows: sectionRows };
      }
      const headers = [...table.querySelectorAll('thead th')].map((th) => textOf(th) || '');
      const lower = headers.map((h) => h.toLowerCase());
      const subjectIdx = lower.findIndex((h) => /przedmiot/.test(h));
      const programIdx = lower.findIndex((h) => /program/.test(h));
      const gradeIdx = lower.findIndex((h) => /ocena/.test(h));
      const rows = [...table.querySelectorAll('tbody tr')].map((tr) => {
        const cells = [...tr.querySelectorAll('td')];
        const cellText = (i) => (i >= 0 && cells[i] ? textOf(cells[i]) : null);
        const subjectCell = cellText(subjectIdx >= 0 ? subjectIdx : 0) || '';
        const codeMatch = subjectCell.match(/\[([^\]]+)\]\s*$/);
        const gradeCell = cellText(gradeIdx >= 0 ? gradeIdx : 2) || '';
        return {
          subject: subjectCell.replace(/\s*\[[^\]]+\]\s*$/, '').trim() || subjectCell,
          code: codeMatch ? codeMatch[1] : null,
          program: cellText(programIdx >= 0 ? programIdx : 1),
          grade: parseStrictGrade(gradeCell),
          gradeText: gradeCell,
        };
      });
      return { supported: true, verified: true, rows };
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

    // Participants of one group (same pokazZajecia?zaj_cyk_id=..&gr_nr=..
    // page as getGroupDetails). Verified live 2026-09-28 on a real account:
    // below the grey info + meetings tables sits table.wrnav with columns
    // Lp. | Nazwisko (a[href*=pokazOsobe&os_id=..]) | Imiona | Stan
    // (colspan=2, e.g. "aktywny"), rows alternate tr.odd_row/even_row.
    // Access note above the table reads "Do listy studentów mają dostęp
    // koordynatorzy przedmiotu, uczestnicy oraz prowadzący grup.
    // Jesteś uczestnikiem, zatem masz dostęp." when visible. Pagination is
    // server-side via tab_offset/tab_limit/tab_order (default tab_limit=30,
    // options up to 500; a lone tab_limit param is ignored — the scraper
    // follows the page's own tab_limit=500 link) — so this parser just
    // reads whatever rows are present. The own row carries no
    // marker; self-matching is done by name against getUser() in app.js.
    // Returns {supported, verified, hidden, students:[{surname, names,
    // status, osId}]}. Only name parts are kept — never album numbers etc.
    getGroupParticipants(doc = document) {
      const table = doc.querySelector('table.wrnav');
      const bodyText = textOf(doc.body) || '';
      const hasAccessNote = /do listy studentów mają dostęp/i.test(bodyText);
      if (!table) {
        return { supported: hasAccessNote, verified: true, hidden: true, students: [] };
      }
      const students = [];
      table.querySelectorAll('tbody tr').forEach((tr) => {
        const link = tr.querySelector('a[href*="pokazOsobe"]');
        if (!link) return;
        const cells = [...tr.querySelectorAll('td')].map((td) => (textOf(td) || '').trim());
        if (cells.length < 3) return;
        let osId = null;
        try { osId = new URL(link.href).searchParams.get('os_id'); } catch (e) { /* keep null */ }
        students.push({
          surname: cells[1] || textOf(link) || '',
          names: cells[2] || '',
          status: cells[3] || null,
          osId,
        });
      });
      return { supported: true, verified: true, hidden: false, students };
    },
    // Details of one enrolled group (katalog2/przedmioty/pokazZajecia
    // ?zaj_cyk_id=..&gr_nr=.. — the detailsUrl getMyGroups stores per
    // group). Verified live 2026-09-28 on a real account: the grey info
    // table's "Termin i miejsce:" row carries the recurring schedule line
    // plus the room link (a[href*=pokazSale], e.g. "sala 311d") and the
    // building note (span.note, e.g. "Gmach - Nowy Elektryczny [D-1]"),
    // while table#lista_dat_spotkan lists concrete meetings with a
    // per-meeting "Prowadzący" cell (td.prowadzacy — empty before the
    // semester starts, populated later). Returns {supported, verified,
    // room, roomUrl, building, scheduleText, teachers[], meetings[]}.
    getGroupDetails(doc = document) {
      const grey = doc.querySelector('table.grey');
      if (!grey) return { supported: false, verified: false };
      let room = null;
      let roomUrl = null;
      let building = null;
      let scheduleText = null;
      grey.querySelectorAll('tbody > tr, tr').forEach((tr) => {
        const cells = tr.querySelectorAll(':scope > td');
        if (cells.length < 2) return;
        if (!/termin i miejsce/i.test(textOf(cells[0]) || '')) return;
        const val = cells[1];
        scheduleText = textOf(val);
        const roomLink = val.querySelector('a[href*="pokazSale"]');
        if (roomLink) {
          room = textOf(roomLink);
          roomUrl = roomLink.href;
        }
        const note = val.querySelector('span.note');
        if (note) building = textOf(note);
      });
      // Group-level lecturer ("Prowadzący: X" row in the same grey table).
      // Meeting rows often carry no per-meeting teacher, so without this
      // teachers ends up [] even though USOS shows the lecturer plainly.
      // Nested meeting rows can't false-match (their first cell is a date).
      let groupTeacher = null;
      grey.querySelectorAll('tbody > tr, tr').forEach((tr) => {
        if (groupTeacher) return;
        const cells = tr.querySelectorAll(':scope > td');
        if (cells.length < 2) return;
        if (!/prowadz[ąa]cy/i.test(textOf(cells[0]) || '')) return;
        const link = cells[1].querySelector('a[href*="pokazOsobe"]');
        groupTeacher = link ? textOf(link) : textOf(cells[1]);
      });
      const meetings = [];
      doc.querySelectorAll('table#lista_dat_spotkan tbody tr').forEach((tr) => {
        const cells = tr.querySelectorAll(':scope > td');
        if (!cells.length) return;
        const cellText = textOf(cells[0]) || '';
        const dateIso = cellText.match(/(\d{4}-\d{2}-\d{2})/);
        const datePl = cellText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        const range = parseTimeRange(cellText);
        const roomLink = cells[0].querySelector('a[href*="pokazSale"]');
        const note = cells[0].querySelector('span.note');
        const teacher = cells.length > 1 ? textOf(cells[1]) : null;
        meetings.push({
          date: dateIso ? dateIso[1]
            : datePl ? `${datePl[3]}-${datePl[2].padStart(2, '0')}-${datePl[1].padStart(2, '0')}` : null,
          start: range ? range.start : null,
          end: range ? range.end : null,
          room: roomLink ? textOf(roomLink) : null,
          building: note ? textOf(note) : null,
          teacher: teacher || null,
        });
      });
      const teachers = [...new Set([groupTeacher, ...meetings.map((m) => m.teacher)].filter(Boolean))];
      const meetingRoom = meetings.map((m) => m.room).find(Boolean) || null;
      const meetingBuilding = meetings.map((m) => m.building).find(Boolean) || null;
      return {
        supported: true,
        verified: true,
        room: room || meetingRoom,
        roomUrl,
        building: building || meetingBuilding,
        scheduleText,
        teachers,
        meetings,
      };
    },
    // Verified live (2026-09-25) against .../dla_stud/rejestracja/kalendarz
    // on a real student account (PWr): the PERSONAL registration calendar,
    // already filtered to this student's programmes — 10 h2 sections, 9
    // tables, 59 rows. Sections without a [KOD] heading ("Rejestracje na
    // egzaminy" → przeniesDoRejestracjiNaEgzaminy, "Rejestracje żetonowe" →
    // zetony/index) are out of scope and skipped by link target, not by
    // title text. Every subject round carries three GET links, all scrapable
    // with the same fetch+DOMParser pattern as everything else here:
    //   "przejdź do rejestracji" → dla_stud/rejestracja/brdg2/wyborPrzedmiotu
    //     &rej_kod=<KOD>&callback=g_… (subject/group listing, read-only)
    //   "pokaż przedmioty…" → katalog2/przedmioty/szukajPrzedmiotu&method=rej
    //     &rej_kod=<KOD>&callback=g_… (see getRejSubjects)
    //   "Plan zajęć…" → katalog2/przedmioty/pokazPlanGrupyPrzedmiotow
    //     &grupa_kod=<GRUPA>&cdyd_kod=<CYKL>
    // The callback token is per page load (g_262cefcc → g_6c9b0fa0 after a
    // reload, verified), so stored URLs are only valid until the next
    // calendar scrape — never cache them across sessions. rej_kod is stable
    // and identical to the [KOD] on the faculty calendar (rejJednostki), so
    // it is the join key between the two sources. Times come from
    // <local-time datetime="YYYY-MM-DD HH:MM:SS">; the "opis" links are bare
    // <a href=""> with jQuery-delegated handlers, so the description is read
    // from the row cells instead. hasAccess is derived from the presence of
    // the registration link itself — this calendar only lists rounds
    // relevant to this student.
    getPersonalCalendar(doc = document) {
      const sections = [];
      doc.querySelectorAll('h2').forEach((h2) => {
        const heading = textOf(h2) || '';
        const codeMatch = heading.match(/\[([^\]]+)\]\s*$/);
        const code = codeMatch ? codeMatch[1] : null;
        const title = code ? heading.replace(/\s*\[[^\]]+\]\s*$/, '').trim() : heading;

        let table = null;
        let subjectsUrl = null;
        const planUrls = [];
        let outOfScope = false;
        let el = h2.nextElementSibling;
        while (el && el.tagName !== 'H2') {
          if (el.querySelectorAll) {
            el.querySelectorAll('a[href]').forEach((a) => {
              const href = a.getAttribute('href') || '';
              if (/przeniesDoRejestracjiNaEgzaminy|zetony\/index/.test(href)) outOfScope = true;
              if (!subjectsUrl && /szukajPrzedmiotu/.test(href) && /method=rej/.test(href)) subjectsUrl = a.href;
              if (/pokazPlanGrupyPrzedmiotow/.test(href)) {
                const label = textOf(a) || '';
                if (!planUrls.some((p) => p.url === a.href)) planUrls.push({ label, url: a.href });
              }
            });
            if (el.tagName === 'TABLE') table = el;
          }
          el = el.nextElementSibling;
        }
        if (outOfScope) return;

        const rounds = [];
        if (table) {
          table.querySelectorAll('tr').forEach((tr) => {
            const cells = tr.querySelectorAll(':scope > td');
            if (cells.length < 4) return;
            const rowText = textOf(tr) || '';
            if (/^\s*Stan\s*[|]/.test(rowText)) return; // header row
            const state = textOf(cells[0]);
            const times = cells[1] ? [...cells[1].querySelectorAll('local-time')].map((t) => t.getAttribute('datetime')) : [];
            const roundType = cells[2] ? textOf(cells[2].querySelector('span:not(.note)')) : null;
            const roundNote = cells[2] ? textOf(cells[2].querySelector('span.note')) : null;
            const descCell = cells[2] ? (textOf(cells[2]) || '') : '';
            const attrText = cells[3] ? (textOf(cells[3]) || '') : '';
            const regLink = tr.querySelector('a[href*="brdg2/wyborPrzedmiotu"]');
            let rejKod = null;
            if (regLink) {
              try { rejKod = new URL(regLink.href).searchParams.get('rej_kod'); } catch (e) { rejKod = null; }
            }
            const attributes = {};
            const dedMatch = attrText.match(/Rejestracja dedykowana:\s*(TAK|NIE)/i);
            const gieMatch = attrText.match(/giełda włączona:\s*(TAK|NIE)/i);
            const podMatch = attrText.match(/podpięcia wymagane[^:]*:\s*(TAK|NIE)/i);
            if (dedMatch) attributes['Rejestracja dedykowana'] = dedMatch[1].toUpperCase();
            if (gieMatch) attributes['Czy giełda włączona'] = gieMatch[1].toUpperCase();
            if (podMatch) attributes['Czy podpięcia wymagane'] = podMatch[1].toUpperCase();
            rounds.push({
              turaId: tr.getAttribute('tura_id'),
              rejKod,
              state,
              startsAt: times[0] || null,
              endsAt: times[1] || null,
              roundType: roundType || descCell.slice(0, 160) || null,
              roundNote,
              attributes,
              attributesText: attrText || null,
              registerUrl: regLink ? regLink.href : null,
              hasAccess: !!regLink,
            });
          });
        }

        sections.push({ code, title, subjectsUrl, planUrls, rounds });
      });

      return { supported: sections.length > 0, verified: true, sections };
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

    // mLegitymacja order page (dla_stud/studia/mlegitymacja/index).
    // Verified live (2026-10-01) against "Oczekuje": one <usos-frame>
    // carries .inline-keyvalue-list rows (label div + value div; status
    // text in <usos-tag>, dates in <local-time datetime="…"> — read the
    // attribute, the custom element never upgrades inside a fetched doc)
    // plus a GET "Sprawdź status zamówienia" form (a plain page refresh,
    // mirrored by scrape.fetchMlegitymacjaResult's force re-fetch).
    // Verified live (2026-10-02) against "Do odbioru": the pickup codes
    // sit in a hidden #qrcode-frame div (revealed in classic by
    // switchQrcodeFrame()) — #qr-code-text (text version of the QR),
    // .qr-code-img#<code> with a client-rendered <canvas> (empty in a
    // fetched doc, so we re-render the QR in-panel from the text via
    // vendor/qrcode), and #qr-code-pass.pass (activation code). The
    // "Dodaj mLegitymację do mObywatela" button only unhides that div;
    // "Anuluj zamówienie" is a POST form (anuluj) — a write, so link-out
    // only, like all other writes by project policy.
    // Verified live: "Oczekuje" (2026-10-01), "Do odbioru" incl. QR text
    // + activation code (2026-10-02), "Odebrana" (2026-10-02). States
    // never seen on this account — no order yet, "W trakcie", "Błąd",
    // "Anulowane", "Unieważnione" — render through the same code paths
    // with graceful fallbacks (neutral badge, generic/empty description),
    // so the result is marked verified; re-check those markups if one
    // of them ever shows up for real.
    getMlegitymacja(doc = document) {
      const miss = { supported: false, verified: false, hasOrder: false, pickupReady: false, status: null, orderDate: null, validUntil: null, qrText: null, qrPass: null };
      const h1 = textOf(doc.querySelector('h1')) || '';
      const frame = doc.querySelector('usos-frame');
      if (!frame && !/mlegitymac/i.test(h1) && !doc.querySelector('help-dialog')) return miss;
      const out = { supported: true, verified: true, hasOrder: false, pickupReady: false, status: null, orderDate: null, validUntil: null, qrText: null, qrPass: null };
      if (frame) {
        const rows = [...frame.querySelectorAll('.inline-keyvalue-list > div')];
        if (rows.length) out.hasOrder = true;
        rows.forEach((row) => {
          const cells = [...row.children].filter((c) => /^(DIV|SECTION)$/.test(c.tagName));
          if (cells.length < 2) return;
          const label = (textOf(cells[0]) || '').toLowerCase();
          const valueCell = cells[1];
          if (/status/.test(label)) {
            out.status = textOf(valueCell.querySelector('usos-tag') || valueCell) || null;
          } else if (/data zam/i.test(label)) {
            const lt = valueCell.querySelector('local-time');
            out.orderDate = (lt && lt.getAttribute('datetime')) || textOf(valueCell) || null;
          } else if (/wa[zż]no[sś]ci/i.test(label)) {
            const lt = valueCell.querySelector('local-time');
            out.validUntil = (lt && lt.getAttribute('datetime')) || textOf(valueCell) || null;
          }
        });
      }
      if (out.status && /^do odbioru/i.test(out.status.trim())) out.pickupReady = true;
      if (!out.pickupReady && doc.querySelector('.qr-code-img')) out.pickupReady = true;
      // Pickup codes (hidden #qrcode-frame in classic — already in the
      // DOM, no click needed to read them). Trimmed; empty -> null so
      // the render falls back to the classic link-out instead of
      // drawing a QR of nothing.
      const qrText = textOf(doc.querySelector('#qr-code-text')) || null;
      const qrPass = textOf(doc.querySelector('#qr-code-pass')) || null;
      if (qrText) { out.qrText = qrText.trim(); out.pickupReady = true; }
      if (qrPass) out.qrPass = qrPass.trim();
      return out;
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

    // Verified against real markup+data at .../katalog2/jednostki/
    // budynkiJednostki?jed_org_kod=<...> — one row per building of this unit
    // AND all of its sub-units, recursively (passing the whole university's
    // root jed_org_kod, found via getUnitDetail's ancestors chain, returns
    // every mappable building campus-wide). Coordinates only exist for rows
    // whose "Na mapie?" column says "TAK" — they live in a separate inline
    // createMap(...)/initializeMap() script, in the SAME top-to-bottom order
    // as the TAK rows (confirmed live: 54 TAK rows == 54 markers == 0
    // mismatches, cross-checked by name prefix on a 92-row, whole-campus
    // fetch). Rows without a resolved coordinate ("NIE" / "(adres nieznany)")
    // are dropped outright — a building we can't place on a map isn't useful
    // here, and the caller (the Mapa view) only ever wants placeable ones.
    getBuildingsForUnit(doc = document) {
      function budKodFromHref(href) {
        try { return new URL(href).searchParams.get('bud_kod'); } catch (e) { return null; }
      }
      function jedKodFromHref(href) {
        try { return new URL(href).searchParams.get('kod'); } catch (e) { return null; }
      }
      const rows = [...doc.querySelectorAll('.usos-ui table.grey tbody tr')];
      const takRows = [];
      rows.forEach((tr) => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 3) return;
        const link = tds[0].querySelector('a');
        const onMap = textOf(tds[2]) === 'TAK';
        if (!link || !onMap) return;
        // The owning-unit sub-link's `kod` — needed alongside its display
        // text because several *different* units across a whole-campus
        // fetch legitimately share the exact same name (e.g. 4 separate
        // wydziały each have their own "Kierownik Administracji
        // Wydziałowej"), so the name alone isn't a safe filter key.
        const unitLink = tds[0].querySelector('.note a');
        takRows.push({
          kod: budKodFromHref(link.href),
          name: textOf(link),
          unitName: textOf(tds[0].querySelector('.note')),
          unitKod: unitLink ? jedKodFromHref(unitLink.href) : null,
          address: textOf(tds[1]),
        });
      });

      // The marker script's `name` is a raw JS string literal — USOS HTML-
      // escapes quotes inside it (`&quot;`) even though it isn't rendered as
      // HTML, and doesn't collapse the double spaces some building names
      // apparently have in the source data. The table's own text (via
      // textOf/textContent above) has neither issue, so without decoding
      // here the startsWith check below would reject genuine matches —
      // confirmed live: 6 of 54 real PWr buildings only matched after this
      // normalization (double-spaced or quote-containing names).
      function decodeEntities(str) {
        const ta = doc.createElement('textarea');
        ta.innerHTML = str;
        return ta.value.replace(/\s+/g, ' ').trim();
      }
      const scriptText = [...doc.querySelectorAll('script')]
        .map((s) => s.textContent)
        .find((t) => /createMap\(|initializeMap\(/.test(t || '')) || '';
      const markers = [];
      const re = /name:\s*"([^"]*)",\s*lat:\s*([\d.]+),\s*lng:\s*([\d.]+)/g;
      let m;
      while ((m = re.exec(scriptText))) markers.push({ name: decodeEntities(m[1]), lat: parseFloat(m[2]), lng: parseFloat(m[3]) });

      const buildings = [];
      takRows.forEach((row, i) => {
        const marker = markers[i];
        // Defensive, not just optimistic: only accept the positional match
        // if the marker's name actually starts with this row's — if USOS
        // ever changes the template so the two lists drift apart, drop the
        // row instead of silently mis-pairing coordinates to the wrong
        // building.
        if (!row.kod || !marker || !marker.name.startsWith(row.name)) return;
        buildings.push({ kod: row.kod, name: row.name, unitName: row.unitName, unitKod: row.unitKod, address: row.address, lat: marker.lat, lng: marker.lng });
      });

      return { supported: buildings.length > 0, verified: true, buildings };
    },

    // Verified against real markup+data at .../katalog2/przedmioty/
    // szukajPrzedmiotu?method=faculty_organized&jed_org_kod=… (PWr W3:
    // 3576 rows, PB Wydział Informatyki: 2015). One <tr> per subject, but
    // each subject also has a second description row (<td colspan=…>)
    // without any subject link, so rows are found by their subject-details
    // <a> rather than by position. Cycle info lives in per-year cells whose
    // rejestracjaNaPrzedmiotCyklu links carry cdyd_kod — "2024/25-Z" at PWr,
    // "2018Z" at PB — so the year is read from the link param, never from
    // header alignment. The non-first pages of a listing nest in
    // <table-nav-bar next-page-url=…> (elements-count holds the exact
    // total, present on every page of a multi-page listing), which keeps
    // this working on any university's tab-id (PWr tab8296, PB tabcd6d)
    // without hardcoding either.
    getUnitSubjects(doc = document) {
      const bodyText = doc.body ? (doc.body.textContent || '') : '';
      if (bodyText.includes('Brak przedmiotów oferowanych przez tę jednostkę')) {
        return { supported: true, verified: true, subjects: [], total: 0, nextUrl: null };
      }
      const nav = doc.querySelector('table-nav-bar');
      const total = nav ? (parseInt(nav.getAttribute('elements-count'), 10) || 0) : 0;
      const nextUrl = nav && nav.getAttribute('next-page-url') ? nav.getAttribute('next-page-url') : null;

      function cdydParam(href) {
        const m = /[?&]cdyd_kod=([^&'"]+)/.exec(href);
        return m ? decodeURIComponent(m[1]) : null;
      }
      const subjects = [];
      const seen = new Set();
      doc.querySelectorAll("a[href*='pokazPrzedmiot&prz_kod=']").forEach((link) => {
        const tr = link.closest('tr');
        if (!tr) return;
        let kod = null;
        try { kod = new URL(link.href).searchParams.get('prz_kod'); } catch (e) { return; }
        if (!kod || seen.has(kod)) return;
        seen.add(kod);
        // The link URL carries a per-request callback token that pages can't
        // be re-fetched through later; the base URL without it is the exact
        // page the topbar search opens (verified)
        let url = link.href.replace(/([?&])callback=[^&]*/, '');
        const groupLink = tr.querySelector("a[href*='method=faculty_group']");
        let grupa = groupLink ? textOf(groupLink.closest('td')).replace(/\s+/g, ' ').replace(/^-\s*/, '').trim() : '';
        const cycles = new Set();
        const years = new Set();
        tr.querySelectorAll("a[href*='rejestracjaNaPrzedmiotCyklu']").forEach((a) => {
          const cdyd = cdydParam(a.href);
          if (!cdyd) return;
          cycles.add(cdyd);
          const year = parseInt(cdyd.slice(0, 4), 10);
          if (year) years.add(year);
        });
        subjects.push({ kod, name: textOf(link), url, grupa: grupa || null, cycles: [...cycles], years: [...years] });
      });

      return { supported: subjects.length > 0, verified: true, subjects, total, nextUrl };
    },

    // Verified live (2026-09-25) against .../katalog2/przedmioty/
    // szukajPrzedmiotu?method=rej&rej_kod=<KOD> — "Przedmioty w rejestracji
    // <title> [KOD]", reached from the personal calendar's "pokaż
    // przedmioty…" link (see getPersonalCalendar). Same row shape family as
    // getUnitSubjects (one <tr> per subject, found by its pokazPrzedmiot
    // link rather than by position; second description rows carry no subject
    // link): kod in the first cell, jednostka as a neighbouring unit link,
    // "Strona przedmiotu" link, registration-basket (koszyk) icons as
    // rejestracjaNaPrzedmiotCyklu links carrying cdyd_kod. The rej_kod page
    // itself is single-page for real tours (9 subjects on W04-T1) — a
    // <table-nav-bar> next page is still honoured if USOS ever paginates it.
    getRejSubjects(doc = document) {
      const nav = doc.querySelector('table-nav-bar');
      const total = nav ? (parseInt(nav.getAttribute('elements-count'), 10) || 0) : 0;
      const nextUrl = nav && nav.getAttribute('next-page-url') ? nav.getAttribute('next-page-url') : null;

      function cdydParam(href) {
        const m = /[?&]cdyd_kod=([^&'"]+)/.exec(href);
        return m ? decodeURIComponent(m[1]) : null;
      }
      const subjects = [];
      const seen = new Set();
      doc.querySelectorAll("a[href*='pokazPrzedmiot&prz_kod=']").forEach((link) => {
        const tr = link.closest('tr');
        if (!tr) return;
        let kod = null;
        try { kod = new URL(link.href).searchParams.get('prz_kod'); } catch (e) { return; }
        if (!kod || seen.has(kod)) return;
        // "Strona przedmiotu" links point at the same subject — only the
        // row's primary subject link (whose own text is the subject name)
        // starts a record.
        if (/^strona przedmiotu/i.test((link.textContent || '').trim())) return;
        seen.add(kod);
        // Same per-request callback token as in getUnitSubjects — strip it;
        // the base URL is the page the UI opens directly.
        const url = link.href.replace(/([?&])callback=[^&]*/, '');
        const unitLink = tr.querySelector("a[href*='pokazJednostke']");
        const cycles = new Set();
        tr.querySelectorAll("a[href*='rejestracjaNaPrzedmiotCyklu']").forEach((a) => {
          const cdyd = cdydParam(a.href);
          if (cdyd) cycles.add(cdyd);
        });
        // Registration-context links and occupancy live in the same row:
        // "grupyPrzedmiotu" opens the per-tour group list (see
        // getRejGroups), and "N/M (zarejestrowanych/limit)" is the
        // subject-level fill. Either may be absent — never guess. The
        // occupancy text is JS-rendered from HTML-encoded data-content
        // tooltip attributes (fetch+DOMParser never runs that JS), so the
        // row text is only the first place to look — tooltips second. The
        // count may be wrapped in markup ("1/75</b> (…)", decoded from
        // "&lt;b&gt;1/75&lt;/b&gt;"), hence the tag-tolerant pattern.
        const OCC_RE = /(\d+)\s*\/\s*(\d+)\s*(<[^>]*>\s*)*\(zarejestrowanych\/limit\)/;
        const groupsLink = tr.querySelector("a[href*='grupyPrzedmiotu']");
        let occMatch = (textOf(tr) || '').match(OCC_RE);
        if (!occMatch) {
          const tip = [...tr.querySelectorAll('[data-content]')]
            .map((el) => el.getAttribute('data-content') || '')
            .find((t) => /\(zarejestrowanych\/limit\)/.test(t));
          if (tip) occMatch = tip.match(OCC_RE);
        }
        // Per-cycle PERSONAL enrollment state (verified 2026-09-26 on the
        // W04-T1 fixture): each cycle <td> carries its own affordances — a
        // hidden POST form to brdg2/zarejestruj (PARSED ONLY, never
        // submitted — read-only rule) plus an action icon whose filename IS
        // the status vocabulary: zarejestruj.svg = you are NOT registered
        // here (screen-reader: "Kliknij tutaj żeby się zarejestrować"),
        // wyrejestruj.svg = you ARE registered (expected live once the tour
        // runs; same family, mirrored wording). The same cell also holds a
        // "Status rejestracji przedmiotu:" screen-reader line (tour-level
        // state, e.g. "mogą składać prośby") and the fill bar backing
        // `occupancy` above. Legacy koszyk_* gifs (see the page legend) are
        // mapped too, in case a tour renders them in-row instead: v_green /
        // out = registered, v_yellow = request, in = canRegister, x / grey
        // = unavailable. Association is strictly per-cell via the cell's own
        // cdyd_kod (hidden input or cycle link) — an icon that can't be tied
        // to a cycle is ignored, never guessed.
        const enrollment = {};
        const statusText = {};
        const ENR_RANK = { registered: 4, request: 3, canRegister: 2, unavailable: 1 };
        function setEnrollment(cdyd, st) {
          if (!cdyd || !st) return;
          const prev = enrollment[cdyd];
          if (!prev || (ENR_RANK[st] || 0) > (ENR_RANK[prev] || 0)) enrollment[cdyd] = st;
        }
        tr.querySelectorAll('td').forEach((td) => {
          let cdyd = null;
          const cdydInput = td.querySelector('input[name="cdyd_kod"]');
          if (cdydInput && cdydInput.value) cdyd = cdydInput.value;
          if (!cdyd) {
            const cycleLink = td.querySelector("a[href*='rejestracjaNaPrzedmiotCyklu']");
            if (cycleLink) cdyd = cdydParam(cycleLink.href);
          }
          if (!cdyd) return;
          cycles.add(cdyd);
          td.querySelectorAll("img[src*='img/rejestracja/']").forEach((img) => {
            const src = img.getAttribute('src') || '';
            const ownText = (img.closest('a, span, td') || td).textContent || '';
            if (/wyrejestruj/i.test(src) || /wyrejestruj|wypisz/i.test(ownText)) setEnrollment(cdyd, 'registered');
            else if (/zarejestruj/i.test(src) || /żeby się\s+zarejestrować/i.test(ownText)) setEnrollment(cdyd, 'canRegister');
          });
          td.querySelectorAll("img[src*='koszyk_']").forEach((img) => {
            const src = img.getAttribute('src') || '';
            const m = /koszyk_([a-z_]+)\.gif/.exec(src);
            if (!m) return;
            const kind = m[1];
            setEnrollment(cdyd,
              (kind === 'v_green' || kind === 'out') ? 'registered'
              : kind === 'v_yellow' ? 'request'
              : kind === 'in' ? 'canRegister' : 'unavailable');
          });
          const srLine = [...td.querySelectorAll('.screen-reader-only')]
            .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
            .find((t) => /Status rejestracji przedmiotu:/i.test(t));
          if (srLine && !statusText[cdyd]) statusText[cdyd] = srLine;
        });
        subjects.push({
          kod,
          name: textOf(link),
          url,
          jednostka: unitLink ? textOf(unitLink) : null,
          cycles: [...cycles],
          groupsUrl: groupsLink ? groupsLink.href : null,
          occupancy: occMatch ? { registered: parseInt(occMatch[1], 10), limit: parseInt(occMatch[2], 10) } : null,
          // Personal enrollment per cycle ('registered' | 'request' |
          // 'canRegister' | 'unavailable'); {} when the page shows no
          // per-cycle affordances. statusText holds the raw tour-level
          // "Status rejestracji przedmiotu:" line per cycle, if present.
          enrollment,
          statusText,
        });
      });

      return { supported: subjects.length > 0, verified: true, subjects, total, nextUrl };
    },

    // Verified live (2026-09-25) against .../dla_stud/rejestracja/brdg2/
    // grupyPrzedmiotu?rej_kod=<KOD>&prz_kod=<KOD>&cdyd_kod=<CYKL>&odczyt=1 —
    // "Sprawdź aktualne zapełnienie grup zajęciowych" for one subject inside
    // one tour (W04-T1 Algebra: 5× Ćwiczenia + 1× Wykład). One table.grey
    // headed "Grupa | Zapisanych | Limit dolny | Limit górny | Prowadzący |
    // Opis grupy | Termin", with single-cell section rows ("Ćwiczenia",
    // "Wykład") splitting the group rows. Row cells: nr | zapisanych |
    // limit-dolny (empty until USOS syncs registration — same "0/" noise
    // family as getClassGroups, kept only when numeric) | limit-górny |
    // prowadzący | opis | termin ("Czwartek 17:05-18:45", parsed with the
    // same day/time idiom as getClassGroups). NOTE: the header contains both
    // "Grupa" and "Termin", so getClassGroups would match this table and
    // misparse it (zapisanych-count as sessions source) — this dedicated
    // parser must be used for brdg2 pages instead. No enrolment affordances
    // live in these rows (no links, no forms) — read-only by construction.
    getRejGroups(doc = document) {
      const tables = [...doc.querySelectorAll('table.grey')];
      const groupsTable = tables.find((t) => {
        const header = t.querySelector('tr');
        const text = header ? textOf(header) : '';
        return /Zapisanych/i.test(text) && /Limit/i.test(text);
      });
      if (!groupsTable) return { supported: false, verified: false, sections: [] };

      const sections = [];
      let current = null;
      groupsTable.querySelectorAll('tr').forEach((tr, index) => {
        if (index === 0) return; // header row
        if (tr.querySelector('th')) return;
        const cells = tr.querySelectorAll(':scope > td');
        if (cells.length === 1) {
          const label = textOf(cells[0]);
          if (label) {
            current = { type: label, groups: [] };
            sections.push(current);
          }
          return;
        }
        if (cells.length < 6) return;
        const nr = textOf(cells[0]);
        if (!nr) return;
        if (!current) {
          current = { type: '', groups: [] };
          sections.push(current);
        }
        const zapisanych = parseInt((textOf(cells[1]) || '').replace(/\s+/g, ''), 10);
        const limitDolnyRaw = (textOf(cells[2]) || '').replace(/\s+/g, '');
        const limitGornyRaw = (textOf(cells[3]) || '').replace(/\s+/g, '');
        const terminText = textOf(cells[6]) || textOf(cells[cells.length - 1]) || '';
        // No comma here ("Czwartek 17:05-18:45"), unlike the catalog
        // "każdy poniedziałek, …" shape getClassGroups parses — comma optional.
        // Day is the nearest day word before the time range (inflected and
        // plural forms OK via parseGroupDay); the range itself comes from
        // the shared parseTimeRange (dashes, "do", seconds all tolerated).
        const range = parseTimeRange(terminText);
        const dayWords = range ? (terminText.slice(0, range.index).match(/[A-Za-ząćęłńóśźż]+/gi) || []) : [];
        let dayWord = null;
        for (let i = dayWords.length - 1; i >= 0; i--) {
          if (parseGroupDay(dayWords[i])) { dayWord = dayWords[i]; break; }
        }
        current.groups.push({
          nr,
          zapisanych: Number.isFinite(zapisanych) ? zapisanych : null,
          limitDolny: /^\d+$/.test(limitDolnyRaw) ? parseInt(limitDolnyRaw, 10) : null,
          limitGorny: /^\d+$/.test(limitGornyRaw) ? parseInt(limitGornyRaw, 10) : null,
          prowadzacy: textOf(cells[4]) || null,
          opis: textOf(cells[5]) || null,
          termin: terminText || null,
          session: (range && dayWord) ? {
            day: dayWord.toLowerCase(),
            start: range.start,
            end: range.end,
            weeks: parseWeeksParity(terminText),
          } : null,
        });
      });

      const total = sections.reduce((n, s) => n + s.groups.length, 0);
      return { supported: total > 0, verified: true, sections };
    },

    // Verified against real markup+data at .../katalog2/programy/
    // szukajProgramu?method=by_faculty&jed_org_kod=… (PWr W3, PB W9). One
    // <tr> per kierunek (pokazKierunek link) whose cell lists that
    // kierunek's program instances as pokazProgram&prg_kod= links — a
    // kierunek commonly has several (full-time/Erasmus…), so every program
    // keeps its kierunek's display name to group by.
    getUnitPrograms(doc = document) {
      const bodyText = doc.body ? (doc.body.textContent || '') : '';
      if (bodyText.includes('Brak programów studiów w tej jednostce')) {
        return { supported: true, verified: true, programs: [], nextUrl: null };
      }
      const nav = doc.querySelector('table-nav-bar');
      const nextUrl = nav && nav.getAttribute('next-page-url') ? nav.getAttribute('next-page-url') : null;
      const programs = [];
      const seen = new Set();
      doc.querySelectorAll("a[href*='pokazProgram&prg_kod=']").forEach((link) => {
        const tr = link.closest('tr');
        let prgKod = null;
        try { prgKod = new URL(link.href).searchParams.get('prg_kod'); } catch (e) { return; }
        if (!prgKod || seen.has(prgKod)) return;
        seen.add(prgKod);
        const kierunekLink = tr ? tr.querySelector("a[href*='pokazKierunek&kod=']") : null;
        programs.push({ kod: prgKod, name: textOf(link), kierunek: kierunekLink ? textOf(kierunekLink) : null });
      });

      return { supported: programs.length > 0, verified: true, programs, nextUrl };
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

    // Announcements from news/default (also the site's own landing page
    // once logged in). Every server-rendered markup variant is
    // feature-detected per parser (see the seven shapes above), tried in
    // a fixed order; the pwnews JSON probe in scraping.js's collectNews
    // only fires when ALL of these come back empty. Detection is by
    // markup, never by hostname — see the comment above the shape
    // parsers for why that matters.
    getNews(doc = document) {
      const parsers = [parseTitleSectionNews, parseHrSegmentNews, parsePoleNews, parseInfoBoxNews, parseFrameNews, parseStrongTableNews, parseH1SegmentNews];
      for (const parse of parsers) {
        const items = parse(doc);
        if (items.length > 0) return { supported: true, verified: true, items };
      }
      return { supported: false, verified: false, items: [] };
    },

    // Fallback news source for installations whose news/default renders no
    // server-side announcements: the "dodatki/pwnews" add-on ships them as
    // a JSON array that its own inline jQuery script injects client-side
    // (which fetch+parse scraping can't see; see scraping.js's
    // collectNews). Verified live (2026-09-16, anonymous) at
    // usosweb.usos.pw.edu.pl: array entries carry id, nazwa (title), opis
    // (HTML body — the add-on itself injects it unescaped into
    // .more-full), grupa_odbiorcow (audience code, meaning UNVERIFIED —
    // deliberately not used to filter; the add-on's own page shows
    // everything too) and data ("YYYY-MM-DD"; the DOM-rendered news have
    // no date, so this field stays null for them and the UI hides it).
    // The per-field name variants mirror the add-on's own getField lists
    // read from its source (see newsJsonField) — the renderer's skip
    // condition (all three fields empty) is tightened here to requiring a
    // title, matching the DOM getNews's .filter((it) => it.title).
    // Array order is the add-on's own display order (newest first at PW)
    // and is passed through unsorted.
    parseNewsJson(json) {
      if (!Array.isArray(json)) return { supported: false, verified: false, items: [] };
      const items = [];
      json.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const title = newsJsonField(entry, ['nazwa', 'NAZWA', 'tytul', 'TYTUL', 'title', 'Title']);
        if (!title) return;
        const opis = newsJsonField(entry, ['opis', 'OPIS', 'tresc', 'TRESC', 'content', 'Content', 'description', 'Description']);
        const date = newsJsonField(entry, ['data', 'DATA', 'date', 'Date']) || null;
        items.push({ title, html: opis ? sanitizeNewsHtmlString(opis) : '', date });
      });
      return { supported: items.length > 0, verified: true, items };
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
          const tr = parseTimeRange(eventText);
          let start = null;
          let end = null;
          if (tr) {
            start = tr.start;
            end = tr.end;
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
            // Day + range via the shared helpers (comma optional, inflected
            // days, dashes/"do"/seconds tolerated); anything after the
            // range is the room ("sala 212, bud. D-1").
            const tr = parseTimeRange(text);
            const dayWords = tr ? (text.slice(0, tr.index).match(/[A-Za-ząćęłńóśźż]+/gi) || []) : [];
            let dayWord = null;
            for (let i = dayWords.length - 1; i >= 0; i--) {
              if (parseGroupDay(dayWords[i])) { dayWord = dayWords[i]; break; }
            }
            if (!tr || !dayWord) return null;
            const place = text.slice(tr.index + tr.length).replace(/^[,\s]+/, '').replace(/[,\s]+$/, '');
            return {
              day: dayWord.toLowerCase(),
              start: tr.start,
              end: tr.end,
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
    getEtapDetails() { return { supported: false, verified: false }; },
    getPlan() { return { supported: false, verified: false, raw: null }; },
    getMyGroups() { return { supported: false, verified: false, subjects: [] }; },
    getGroupDetails() { return { supported: false, verified: false }; },
    getGroupParticipants() { return { supported: false, verified: false, hidden: false, students: [] }; },
    getGrades() { return { supported: false, verified: false, rows: [] }; },
    getExams() { return { supported: false, verified: false, exams: [] }; },
    getRegistrationRounds() { return { supported: false, verified: false, groups: [] }; },
    getPersonalCalendar() { return { supported: false, verified: false, sections: [] }; },
    getRejSubjects() { return { supported: false, verified: false, subjects: [], total: 0, nextUrl: null }; },
    getRejGroups() { return { supported: false, verified: false, sections: [] }; },
    getOwnProgrammes() { return { supported: false, verified: false, programmes: [] }; },
    getNews() { return { supported: false, verified: false, items: [] }; },
    parseNewsJson() { return { supported: false, verified: false, items: [] }; },
    getPaymentGroups() { return { supported: false, verified: false, groups: [], grandTotal: null }; },
    getBankAccounts() { return { supported: false, verified: false, accounts: [] }; },
    getPaymentDetails() { return { supported: false, verified: false, generalInfo: [], tables: [] }; },
    getScholarships() { return { supported: false, verified: false, rows: [] }; },
    getTests() { return { supported: false, verified: false, rows: [] }; },
    getPetitions() { return { supported: false, verified: false, rows: [] }; },
    getSurveys() { return { supported: false, verified: false, rows: [] }; },
    getMlegitymacja() { return { supported: false, verified: false, hasOrder: false, pickupReady: false, status: null, orderDate: null, validUntil: null, qrText: null, qrPass: null }; },
    getUnitDetail() { return { supported: false, verified: false, name: null, fields: [], ancestors: [], children: [] }; },
    getUnitSubjects() { return { supported: false, verified: false, subjects: [], total: 0, nextUrl: null }; },
    getUnitPrograms() { return { supported: false, verified: false, programs: [], nextUrl: null }; },
    getBuildingsForUnit() { return { supported: false, verified: false, buildings: [] }; },
    getProgramDetail() { return { supported: false, verified: false, name: null, fields: [], kierunki: [], units: [], stages: [] }; },
    getStageSubjects() { return { supported: false, verified: false, sections: [] }; },
    getSubjectPage() { return { supported: false, verified: false, generalInfo: [], cycles: [] }; },
    getSubjectTimetable() { return { supported: false, verified: false, hourStart: null, hourEnd: null, days: [] }; },
    getClassGroups() { return { supported: false, verified: false, groups: [] }; },
    getSharedPlan() { return { supported: false, verified: false, notShared: false, ownerName: null, sessions: [] }; },
    getOwnPlanLink() { return { supported: false, verified: false, url: null }; },
    getPlanVisibility() { return { supported: false, verified: false, mode: null }; },
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

  window.USOSPP_ADAPTERS = { selectAdapter, looksLikeUsos, isUsosPage, detectFooterVersion, parseStrictGrade };
  if (window.USOSPP_CORE) window.USOSPP_CORE.registerDetector('usos', isUsosPage);
})();

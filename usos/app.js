// The USOS++ redesign SPA. Ported from the approved design (design/USOS++.dc.html)
// onto vanilla DOM APIs — no inline `onclick="..."` attributes, since content
// scripts run in an isolated JS world and inline handler strings are looked
// up in the *page's* world, not ours. Every interaction goes through a single
// delegated click/change listener keyed off `data-action`.
//
// IMPORTANT product decision: the original design mockup used fabricated
// demo numbers (4.32 average, 120/210 ECTS, sample classes...) to show what
// the UI *could* look like. This build only ever renders real scraped data
// or an honest empty/"not verified yet" state — never placeholder numbers
// dressed up as real ones. Several sections (Plan, Oceny, Egzaminy) rely on
// USOS markup we could only observe empty during development; they degrade
// to a generic/raw view with a link back to classic USOSweb rather than
// pretending to understand a structure we haven't confirmed.
(function () {
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtGrade(raw) {
    if (raw === null || raw === undefined) return null;
    try {
      const strict = window.USOSPP_ADAPTERS && window.USOSPP_ADAPTERS.parseStrictGrade;
      if (typeof strict === 'function') return strict(raw);
    } catch (e) { /* fall through to local copy */ }
    // Local copy of the strict rule (same as adapters.js parseStrictGrade):
    // only a whole cell exactly equal to a Polish final grade counts, so
    // subject codes, cycles and ECTS numbers never become phantom grades.
    const t = String(raw).trim().replace(/\s+/g, '');
    if (!/^(2(?:[.,]0)?|3(?:[.,]0|[.,]5)?|4(?:[.,]0|[.,]5)?|5(?:[.,]0|[.,]5)?)$/.test(t)) return null;
    return t.replace(',', '.').replace(/^([2-5])$/, '$1.0');
  }

  function gradeBadge(gradeStr) {
    const n = parseFloat(gradeStr);
    if (Number.isNaN(n)) return { bg: 'var(--bg-subtle)', color: 'var(--ink-3)' };
    if (n >= 4.5) return { bg: 'oklch(90% 0.08 150)', color: 'oklch(35% 0.1 150)' };
    if (n >= 3.5) return { bg: 'oklch(92% 0.03 45)', color: 'oklch(40% 0.13 45)' };
    return { bg: 'oklch(92% 0.06 80)', color: 'oklch(42% 0.1 70)' };
  }

  // The mini widget uses 2-letter abbreviations (PN, WT…), the richer
  // per-subject plan page uses full Polish weekday names, and the planner's
  // group listings use lowercase nominative day words ("poniedziałek") —
  // shared by renderSubjectTimetable and the schedule planner so both agree
  // on column order regardless of which source backs a given entry.
  const DAY_KEYS = ['PN', 'WT', 'ŚR', 'CZ', 'PT', 'SO', 'ND'];
  const DAY_ALIASES = {
    PONIEDZIAŁEK: 'PN', WTOREK: 'WT', ŚRODA: 'ŚR', CZWARTEK: 'CZ',
    PIĄTEK: 'PT', SOBOTA: 'SO', NIEDZIELA: 'ND',
  };
  function shortDay(label) {
    const key = (label || '').toUpperCase();
    if (DAY_KEYS.includes(key)) return key;
    return DAY_ALIASES[key] || label;
  }
  function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }

  // "P"/"N" per USOS's own convention (see the legend text on a full plan
  // page: "tydzień parzysty (P)" / "tydzień nieparzysty (N)") — not
  // something we invented. `null` for a weekly class (`weeks === 'every'`
  // or missing, e.g. from the subject page's mini timetable, which never
  // carries this — see adapters.js's parseTimetable comment).
  function weeksLabel(weeks) {
    if (weeks === 'even') return 'P';
    if (weeks === 'odd') return 'N';
    return null;
  }

  // Two sessions overlapping in time only conflict if they could actually
  // land on the same real week — opposite, KNOWN parity (one odd, one
  // even) never does. Anything else (same parity, or either side unknown/
  // weekly) is treated as a real possible conflict, since we'd rather flag
  // a false positive than silently hide a true one.
  function sessionsOverlap(a, b) {
    if ((a.weeks === 'odd' && b.weeks === 'even') || (a.weeks === 'even' && b.weeks === 'odd')) return false;
    return toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);
  }

  // Side-by-side lane geometry for one planner-preview-grid box. Pure time
  // overlap (P/N included — same convention as renderPlanWeekGrid); single
  // boxes keep the full-width CSS default (left:3px;right:3px).
  function plannerLaneStyle(lane, laneCount) {
    if (!laneCount || laneCount <= 1) return '';
    return `left:calc(3px + (100% - 6px) * ${lane} / ${laneCount});right:auto;width:calc((100% - 6px) / ${laneCount});`;
  }

  // Stats for one saved planner plan (the "Moje plany" cards): distinct
  // subjects, picks (= groups), weekly hours and same-day overlapping
  // session pairs (parity-aware via sessionsOverlap — P/N never collide).
  // Pure and defensive: unusable times are skipped, never counted.
  function plannerPlanStats(picks) {
    const list = Array.isArray(picks) ? picks : [];
    const subjects = new Set(list.map((p) => subjectId(p.subjectUrl)).filter(Boolean)).size;
    let minutes = 0;
    const byDay = new Map();
    list.forEach((p) => {
      (p.sessions || []).forEach((s) => {
        const a = toMin(s.start);
        const b = toMin(s.end);
        if (a === null || b === null || b <= a) return;
        minutes += b - a;
        const day = String(s.day || '').toUpperCase();
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(s);
      });
    });
    let collisions = 0;
    byDay.forEach((sessions) => {
      for (let i = 0; i < sessions.length; i++) {
        for (let j = i + 1; j < sessions.length; j++) {
          if (sessionsOverlap(sessions[i], sessions[j])) collisions++;
        }
      }
    });
    const hours = Math.round((minutes / 60) * 10) / 10;
    return { subjects, groups: list.length, hours, collisions };
  }

  // Assigns each subject in the planner a distinct hue, one per integer
  // index (see plannerColorSeed) rather than picking from a short fixed
  // list — a small palette runs out and starts repeating colours on
  // unrelated subjects once there are more subjects than list entries.
  // Stepping the hue wheel by the golden angle (~137.5°) instead keeps
  // consecutive indices visually far apart and never exactly repeats a hue
  // for any realistic number of subjects.
  const GOLDEN_ANGLE = 137.508;
  function hashStr(str) {
    let h = 0;
    for (let i = 0; i < (str || '').length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return h;
  }
  function subjectColor(seed, dark) {
    const hue = planExportHue(seed);
    return dark
      ? { bg: `oklch(36% 0.09 ${hue})`, time: `oklch(80% 0.06 ${hue})`, label: `oklch(90% 0.05 ${hue})`, meta: `oklch(76% 0.06 ${hue})` }
      : { bg: `oklch(85% 0.08 ${hue})`, time: `oklch(38% 0.12 ${hue})`, label: `oklch(30% 0.14 ${hue})`, meta: `oklch(40% 0.1 ${hue})` };
  }

  function shortClassType(label) {
    const s = (label || '').toLowerCase();
    if (/laborator/.test(s)) return 'L';
    if (/wykład/.test(s)) return 'W';
    if (/ćwiczen/.test(s)) return 'C';
    if (/seminari/.test(s)) return 'S';
    if (/projekt/.test(s)) return 'P';
    if (/lektorat/.test(s)) return 'LE';
    return (label || '?').trim().charAt(0).toUpperCase() || '?';
  }

  // Week-grid day columns, shared by the HTML grid, the list view and the
  // PNG exporter: weekdays always stay, Saturday/Sunday appear only when
  // something actually happens there — an empty weekend isn't rendered.
  const PLAN_WEEKDAY_KEYS = ['PN', 'WT', 'ŚR', 'CZ', 'PT'];
  const PLAN_WEEKEND_KEYS = ['SO', 'ND'];
  function planGridDayKeys(weekly) {
    const list = Array.isArray(weekly) ? weekly : [];
    return PLAN_WEEKDAY_KEYS.concat(
      PLAN_WEEKEND_KEYS.filter((dk) => list.some((e) => e && e.day === dk)));
  }

  // Geometry shared by the HTML week grid and the PNG exporter so the
  // image can't drift from what's on screen: hour range, per-day lane
  // assignment for overlaps, pixel top/height per block (ROW_H px/hour).
  const PLAN_GRID_ROW_H = 60;
  function planWeekGridLayout(weekly, dayKeys) {
    const list = Array.isArray(weekly) ? weekly : [];
    const allMins = list.flatMap((e) => [toMin(e.start), toMin(e.end)]).filter((n) => n !== null);
    const hourStart = allMins.length ? Math.min(7, Math.floor(Math.min(...allMins) / 60)) : 7;
    const hourEnd = allMins.length ? Math.max(21, Math.ceil(Math.max(...allMins) / 60)) : 21;
    const totalHeight = Math.max(1, hourEnd - hourStart) * PLAN_GRID_ROW_H;
    const hours = [];
    for (let h = hourStart; h <= hourEnd; h++) hours.push(h);
    const days = (Array.isArray(dayKeys) ? dayKeys : []).map((dk) => {
      // Minute-based order — USOS hours aren't zero-padded ("9:15"), so a
      // string sort puts 11:15 before 9:15. Unparsable times sink last.
      const sorted = list.filter((e) => e.day === dk)
        .sort((a, b) => (toMin(a.start) ?? Infinity) - (toMin(b.start) ?? Infinity)
          || (toMin(a.end) ?? Infinity) - (toMin(b.end) ?? Infinity));
      // Overlap groups (connected by time overlap): lanes are assigned
      // inside each group and laneCount is per group, so a lone block
      // keeps full width even on a day that has an N/P pair elsewhere.
      // Lane reuse compares MINUTES — the old string comparison wrongly
      // reused lane 0 ("9:15" >= "11:00" is true lexicographically), so
      // the second of two same-slot blocks painted exactly over the
      // first. Same greedy scheme as the planner grid below.
      const groups = [];
      let cur = [];
      sorted.forEach((e) => {
        const s = toMin(e.start);
        if (cur.length && (s === null || !cur.some((a) => {
          const ae = toMin(a.end);
          return ae !== null && ae > s;
        }))) { groups.push(cur); cur = []; }
        cur.push(e);
      });
      if (cur.length) groups.push(cur);
      const blocks = [];
      groups.forEach((g) => {
        const laneEnds = [];
        const assigned = g.map((e) => {
          const s = toMin(e.start);
          let lane = s === null ? -1 : laneEnds.findIndex((end) => end !== null && s >= end);
          if (lane === -1) { lane = laneEnds.length; laneEnds.push(null); }
          laneEnds[lane] = toMin(e.end);
          return { e, lane };
        });
        const laneCount = Math.max(1, laneEnds.length);
        assigned.forEach(({ e, lane }) => {
          const startMin = toMin(e.start);
          const endMin = toMin(e.end);
          blocks.push({
            e,
            lane,
            laneCount,
            top: (startMin - hourStart * 60) * (PLAN_GRID_ROW_H / 60),
            height: Math.max(36, (endMin - startMin) * (PLAN_GRID_ROW_H / 60)),
          });
        });
      });
      return { day: dk, blocks };
    });
    return { hourStart, hourEnd, rowH: PLAN_GRID_ROW_H, totalHeight, hours, days };
  }

  // Canvas-safe twin of subjectColor's hue: canvas fillStyle can't be
  // trusted with oklch() (the canvas color parser lags CSS), so the PNG
  // painters re-derive the same golden-angle hue as plain hsl().
  function planExportHue(seed) {
    return (((seed * GOLDEN_ANGLE) % 360) + 360) % 360;
  }

  // Polish count noun (1 / 2-4 / 5+, teens exception) — pluralOsoba is
  // the "osoba" special case of this.
  function pluralPl(n, one, few, many) {
    if (n === 1) return one;
    const d10 = n % 10, d100 = n % 100;
    if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return few;
    return many;
  }

  function pluralOsoba(n) {
    if (n === 1) return 'osoba';
    const d10 = n % 10, d100 = n % 100;
    if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return 'osoby';
    return 'osób';
  }

  // Truncates canvas text with an ellipsis to fit maxW (measureText loop).
  function fitText(ctx, text, maxW) {
    const s = String(text || '');
    if (ctx.measureText(s).width <= maxW || s.length <= 1) return s;
    let out = s;
    while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) out = out.slice(0, -1);
    return `${out}…`;
  }

  // Brand lockup for the PNG export (see design/USOS++ Brand System.dc.html:
  // orange ++ mark + "USOS" ink / "++" orange, one row, General Sans 700).
  // Drawn with canvas primitives — no image loading, so it cannot fail to
  // appear. Returns the lockup width.
  // Brand lockup for the PNG export (see design/USOS++ Brand System.dc.html:
  // orange ++ mark + "USOS" ink / "++" orange, one row, General Sans 700).
  // Drawn with canvas primitives — no image loading, so it cannot fail to
  // appear. Proportions follow the brand spec, scaled to a 36px tile:
  // radius 23%, "++" 59% at tracking -0.04em, optical shift -3% up,
  // tile-to-text gap 1/4 of the tile, wordmark tracking -0.015em.
  // Returns the lockup width.
  function paintPlanLogo(ctx, W, pad, centerY) {
    const FONT = '"General Sans", system-ui, -apple-system, sans-serif';
    const ORANGE = '#d9773a';
    const iconSize = 36;
    const markPx = iconSize * 0.59;
    const gap = iconSize / 4;
    const fontPx = 20;
    const setSpacing = (em, px) => {
      try { ctx.letterSpacing = `${(-em * px).toFixed(2)}px`; } catch (e) { /* pre-99 canvas: ignore */ }
    };
    const x0 = W - pad - (iconSize + gap + ctx.measureText('USOS').width + ctx.measureText('++').width);
    const y = centerY - iconSize / 2;
    // The ++ mark: orange rounded square, white bold "++" optically
    // centered (metrics-based, minus the 3% upward correction).
    ctx.fillStyle = ORANGE;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x0, y, iconSize, iconSize, iconSize * 0.23);
      ctx.fill();
    } else {
      ctx.fillRect(x0, y, iconSize, iconSize);
    }
    ctx.font = `700 ${markPx.toFixed(2)}px ${FONT}`;
    setSpacing(0.04, markPx);
    const mm = ctx.measureText('++');
    const capHalf = Number.isFinite(mm.actualBoundingBoxAscent) && Number.isFinite(mm.actualBoundingBoxDescent)
      ? (mm.actualBoundingBoxAscent - mm.actualBoundingBoxDescent) / 2
      : markPx * 0.35; // mock contexts without font metrics
    ctx.fillStyle = '#ffffff';
    ctx.fillText('++', x0 + (iconSize - mm.width) / 2, y + iconSize / 2 - iconSize * 0.03 + capHalf);
    // The wordmark, vertically centered on the mark.
    const x = x0 + iconSize + gap;
    const baseline = y + iconSize / 2 + fontPx * 0.35;
    ctx.font = `700 ${fontPx}px ${FONT}`;
    setSpacing(0.015, fontPx);
    const wUsos = ctx.measureText('USOS').width;
    ctx.fillStyle = '#18181b';
    ctx.fillText('USOS', x, baseline);
    ctx.fillStyle = ORANGE;
    ctx.fillText('++', x + wUsos, baseline);
    try { ctx.letterSpacing = '0px'; } catch (e) { /* reset is best-effort */ }
    return W - pad - x0;
  }

  // Fit-to-one-page zoom for the PDF export: A4 at 96 CSS px/in minus our
  // own print padding (see usos.css — @page margin is 0 so the browser
  // prints no date/title/URL header or footer). Never scales up.
  const PLAN_PRINT_PAD_MM = 12;
  const PLAN_PRINT_PX_PER_MM = 96 / 25.4;
  // Usable print content box (page minus our own padding, px) — the box
  // planPrintZoom fits into and planPrintContentH centers within.
  function planPrintContentH(landscape = true) {
    const pad = PLAN_PRINT_PAD_MM * PLAN_PRINT_PX_PER_MM;
    return (landscape ? 210 : 297) * PLAN_PRINT_PX_PER_MM - pad * 2;
  }
  function planPrintContentW(landscape = true) {
    const pad = PLAN_PRINT_PAD_MM * PLAN_PRINT_PX_PER_MM;
    return (landscape ? 297 : 210) * PLAN_PRINT_PX_PER_MM - pad * 2;
  }
  function planPrintZoom(cardH, cardW, landscape) {
    const z = Math.min(planPrintContentH(landscape) / cardH, planPrintContentW(landscape) / cardW, 1);
    return Number.isFinite(z) && z > 0 ? z : 1;
  }

  // ---- plan → calendar (.ics) export ----
  // Pure builders (no DOM — safe in tests); the Blob download lives on the
  // App next to exportPlanPdf/exportPlanPng. Times are floating local (no
  // TZID): without a timezone database that's the only honest option —
  // Google/Apple/Outlook read them in the calendar's own zone.

  // RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines.
  function icsEscape(value) {
    return String(value == null ? '' : value)
      .replace(/\r\n|\r/g, '\n')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  // RFC 5545 line folding: at most 75 octets per line, continuation lines
  // starting with a single space (which leaves 74 for content). Byte-aware,
  // not char-aware — Polish diacritics are multibyte in UTF-8 and must
  // never be split mid-character.
  function icsFold(line) {
    if (line.length <= 75 && /^[\x00-\x7F]*$/.test(line)) return line;
    let out = '';
    let cur = '';
    let curBytes = 0;
    let budget = 75;
    const flush = () => { out += cur + '\r\n '; cur = ''; curBytes = 0; budget = 74; };
    for (let i = 0; i < line.length;) {
      const c = line.charCodeAt(i);
      let ch = line[i];
      let len = c < 0x80 ? 1 : (c < 0x800 ? 2 : 3);
      let next = i + 1;
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < line.length) {
        const lo = line.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) { ch = line.slice(i, i + 2); len = 4; next = i + 2; }
      }
      if (curBytes + len > budget) flush();
      cur += ch;
      curBytes += len;
      i = next;
    }
    return out + cur;
  }

  // "2026-10-05" + "15:15" → "20261005T151500" (floating local). null for
  // anything that doesn't look like a real date/time — the caller skips
  // such sessions instead of emitting broken VEVENTs.
  function icsDateTime(dateIso, hhmm) {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso || '');
    const tm = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if (!dm || !tm) return null;
    const hh = String(tm[1]).padStart(2, '0');
    if (Number(hh) > 23 || Number(tm[2]) > 59) return null;
    return `${dm[1]}${dm[2]}${dm[3]}T${hh}${tm[2]}00`;
  }

  function icsStamp(date) {
    const d = date instanceof Date ? date : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  }

  // Whole VCALENDAR from concrete sessions (real dates). opts: { dtstamp,
  // calName, domain }. Returns { ics, count } — count is the VEVENTs
  // actually emitted. UIDs are a stable hash of detailsUrl|date|start|end
  // (+ a per-file index against intra-file collisions), so re-importing an
  // unchanged plan doesn't duplicate events. Each event carries the
  // subject's own color (same golden-angle hue as the plan grid and the PNG
  // export) via the RFC 7986 COLOR property — honored by some calendars,
  // ignored by others, never harmful.
  function buildPlanIcs(sessions, opts) {
    const o = opts || {};
    const list = Array.isArray(sessions) ? sessions : [];
    const stamp = o.dtstamp || icsStamp(new Date());
    const domain = String(o.domain || 'usospp').replace(/\s+/g, '') || 'usospp';
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//USOS++//Plan//PL',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];
    if (o.calName) lines.push(`X-WR-CALNAME:${o.calName}`);
    let n = 0;
    list.forEach((s) => {
      if (!s) return;
      const start = icsDateTime(s.date, s.start);
      const end = icsDateTime(s.date, s.end);
      if (!start || !end || end <= start) return;
      // "[W] Programowanie obiektowe" — the same short type codes the plan
      // grid uses (see shortClassType), so the calendar reads like USOS++.
      const tag = s.type ? `[${shortClassType(s.type)}] ` : '';
      const title = `${tag}${s.subject || 'Zajęcia'}`;
      const locBits = [];
      if (s.room) locBits.push(s.room + (s.building ? ` (${s.building})` : ''));
      else if (s.building) locBits.push(s.building);
      const hue = Math.round(planExportHue(hashStr(s.code || s.subject || '')) * 10) / 10;
      const uidBase = [s.detailsUrl || '', s.date, s.start, s.end, s.subject || '', s.type || ''].join('|');
      const uid = `usospp-${(hashStr(uidBase) >>> 0).toString(16)}-${n}@${domain}`;
      n++;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `COLOR:hsl(${hue},65%,45%)`,
        `SUMMARY:${icsEscape(title)}`,
      );
      if (locBits.length) lines.push(`LOCATION:${icsEscape(locBits.join(' · '))}`);
      if (s.teacher) lines.push(`DESCRIPTION:${icsEscape(s.teacher)}`);
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return { ics: lines.map(icsFold).join('\r\n') + '\r\n', count: n };
  }

  // Panel lookahead: how far ahead the "next sessions" box searches for
  // the nearest upcoming session when the current week has nothing left.
  const PANEL_LOOKAHEAD_DAYS = 21;

  // Human countdown in Polish for a future timestamp: "za 5 min",
  // "za 2 godz. 15 min", "za 3 dni". Mode picks the verb: reaching the
  // session start vs reaching its end while it's already running.
  function formatCountdownPl(targetMs, nowMs, mode) {
    const diff = Math.max(0, targetMs - nowMs);
    const verb = mode === 'end' ? 'Koniec' : 'Zaczyna się';
    if (diff < 60 * 1000) return mode === 'end' ? 'Zaraz koniec' : 'Zaczyna się za chwilę';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${verb} za ${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) {
      const rest = mins % 60;
      return rest ? `${verb} za ${hours} godz. ${rest} min` : `${verb} za ${hours} godz.`;
    }
    const days = Math.floor(hours / 24);
    return `${verb} za ${days} ${days === 1 ? 'dzień' : 'dni'}`;
  }

  // Minutes → "12,3 h" / "40 h": one decimal (Polish comma) under 10 h
  // where rounding would hide everything, whole hours above.
  function fmtHoursPl(min) {
    const h = (Number(min) || 0) / 60;
    return (h < 10 ? h.toFixed(1).replace('.', ',') : String(Math.round(h))) + ' h';
  }

  // Minute ticker for panel countdowns. Updates only the [data-countdown]
  // spans in place — never a full re-render (which would replay the page
  // fade-in). Started lazily on first panel render; no-ops when the box
  // isn't on screen. Safe to call in non-DOM contexts (tests).
  let countdownTickerStarted = false;
  function ensureCountdownTicker() {
    if (countdownTickerStarted) return;
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    if (typeof setInterval === 'undefined') return;
    countdownTickerStarted = true;
    setInterval(() => {
      const now = Date.now();
      document.querySelectorAll('[data-countdown]').forEach((el) => {
        const target = Number(el.getAttribute('data-target') || 0);
        if (!target) return;
        el.textContent = formatCountdownPl(target, now, el.getAttribute('data-mode') || 'start');
      });
      // The plan's "now" line creeps with the same 60 s cadence: geometry
      // rides along in data attributes, so no re-render is needed. Off
      // after the axis ends (or before it starts) the line hides itself.
      document.querySelectorAll('[data-nowline]').forEach((el) => {
        const hourStart = Number(el.getAttribute('data-hour-start') || 7);
        const totalH = Number(el.getAttribute('data-total-height') || 0);
        const d = new Date(now);
        const top = d.getHours() * 60 + d.getMinutes() - hourStart * 60;
        if (top < 0 || top > totalH) { el.style.display = 'none'; return; }
        el.style.display = '';
        el.style.top = `${top}px`;
      });
    }, 60000);
  }

  // USOS appends a rotating `callback=` token to every katalog2 subject
  // link — re-fetching the exact same "Przedmioty" listing twice in a row
  // yields two different tokens (verified live). The real, stable identity
  // is the `prz_kod` query param, so anything that needs to recognize "the
  // same subject" across a page reload (matching a saved pick back to its
  // row, grouping picks, picking a stable colour) must key off this, not
  // off the raw URL string — otherwise a reopened subject looks like it has
  // no picks at all, and re-selecting "the same" group creates a second,
  // overlapping pick instead of replacing the first.
  function subjectId(url) {
    try {
      return new URL(url, location.origin).searchParams.get('prz_kod') || url;
    } catch (e) {
      return url;
    }
  }

  // Identifies "one class type within one subject's cycle" — used both as
  // the planner's draft-selection key and as each saved pick's `key`, so a
  // second choice for the same class type replaces the first rather than
  // duplicating it.
  function classTypeKey(subjectUrl, cycleName, classTypeLabel) {
    return `${subjectId(subjectUrl)}::${cycleName}::${classTypeLabel}`;
  }

  // Converts one {variable, group} entry from a generated candidate
  // (window.USOSPP_GENERATOR's output) into the exact same pick shape
  // plannerAddSubject builds for a manually-configured subject — so a
  // generated-then-saved plan is byte-for-byte indistinguishable from one
  // built by hand, and every existing planner function (plannerPicksBySubject,
  // renderPlannerGrid, plannerRemovePick…) handles it with zero special-casing.
  function pickFromAssignment({ variable, group }) {
    return {
      key: classTypeKey(variable.subjectUrl, variable.cycleName, variable.classTypeLabel),
      subjectUrl: variable.subjectUrl,
      subjectName: variable.subjectName,
      cycleName: variable.cycleName,
      classTypeLabel: variable.classTypeLabel,
      classTypeShort: variable.classTypeShort,
      nr: group.nr,
      sessions: group.sessions,
      teacher: group.teacher,
      occupancy: group.occupancy,
      detailsUrl: group.detailsUrl,
    };
  }

  // Extracts the short building code (e.g. "D-1") out of a place string
  // like "Budynek dydaktyczny [D-2], sala 333a" — the bracketed code is
  // what students actually navigate by, the full building name is just
  // clutter next to it.
  function buildingCode(place) {
    const m = /\[([^\]]+)\]/.exec(place || '');
    return m ? m[1] : null;
  }

  // Condenses "Budynek dydaktyczno-laboratoryjny [C-6], sala 130" down to
  // "C-6, sala 130" — same information a student actually needs to find the
  // room, without the long descriptive building name.
  function shortPlace(place) {
    if (!place) return null;
    const code = buildingCode(place);
    const roomMatch = /sala\s*([^\s,]+)/i.exec(place);
    const room = roomMatch ? `sala ${roomMatch[1]}` : null;
    return [code, room].filter(Boolean).join(', ') || place;
  }

  // getOwnProgrammes can return more than one programme stage at once (see
  // its own comment — USOS opens next-semester subjects for early browsing
  // well before the student is actually assigned to that semester), so
  // getStageSubjects' "active in current cycle" filter alone isn't enough
  // to keep a future semester's subjects out of the planner's candidate
  // list. Cycle codes ("2026/27-Z" winter, "2026/27-L" summer) sort
  // chronologically once parsed into (year, term) — the stage(s) with the
  // earliest cycle are treated as "currently assigned"; anything later is
  // a future semester and gets left out, with a note explaining why rather
  // than silently vanishing.
  function cycleRank(label) {
    const m = /^(\d{4})\/(\d{2})-([ZL])$/.exec(label || '');
    return m ? parseInt(m[1], 10) * 2 + (m[3] === 'Z' ? 0 : 1) : null;
  }
  function stageCycleLabel(stage) {
    const label = (stage.sections || []).map((sec) => sec.currentCycleLabel).find(Boolean);
    return label || null;
  }

  const NAV_ITEMS = [
    { id: 'dashboard', label: 'Panel', icon: 'grid' },
    { id: 'aktualnosci', label: 'Aktualności', icon: 'bell' },
    { id: 'plan', label: 'Plan zajęć', icon: 'calendar' },
    { id: 'oceny', label: 'Oceny', icon: 'bars' },
    { id: 'przedmioty', label: 'Przedmioty', icon: 'book' },
    { id: 'egzaminy', label: 'Egzaminy', icon: 'check' },
    { id: 'sprawdziany', label: 'Sprawdziany', icon: 'clipboard' },
    { id: 'ects', label: 'ECTS / Postęp', icon: 'ring' },
  ];

  // Lower-traffic sections tucked behind the collapsible "Więcej" row in the
  // sidebar (see renderSidebar) instead of each getting a permanent
  // top-level slot. Mapa leads this group: it's reachable by search as
  // often as by the sidebar, and it works logged out unlike the rest.
  const MORE_NAV_ITEMS = [
    { id: 'katalog', label: 'Katalog', icon: 'layers' },
    { id: 'mapa', label: 'Mapa', icon: 'pin' },
    { id: 'platnosci', label: 'Płatności', icon: 'card' },
    { id: 'stypendia', label: 'Stypendia', icon: 'coins' },
    { id: 'podania', label: 'Podania', icon: 'send' },
    { id: 'ankiety', label: 'Ankiety', icon: 'star' },
    { id: 'studenci', label: 'Studenci', icon: 'users' },
    // mLegitymacja is read-only status display (ordering/cancel/revoke
    // stay in classic USOS by project policy) — same low-traffic shelf
    // as the other "Moje studia" pages above, not a top-level slot.
    { id: 'mlegitymacja', label: 'mLegitymacja', icon: 'idcard' },
  ];

  // Temporarily hidden from the sidebar (the views aren't reliable yet) —
  // see docs/hidden-nav-items.md. Everything behind them stays intact:
  // VALID_VIEWS, TITLES, renderers, scraping and fetches, so a hidden view
  // still works when opened directly (e.g. a sessionStorage restore after a
  // reload) and comes back to the menu by just removing its id from this set.
  const HIDDEN_NAV_ITEMS = new Set(['stypendia', 'podania', 'ankiety']);

  // "przedmioty" is a hub tile screen — Przegląd/Zapisy/Generator planu live
  // one level under it now instead of each having their own nav row. A nav
  // item should still read as "active" while the user is anywhere inside its
  // group (including a subject-detail page opened from within it), even
  // though only the hub id itself appears in NAV_ITEMS.
  const NAV_GROUPS = {
    przedmioty: ['przedmioty', 'przedmiotyLista', 'zapisy', 'zapisTura', 'zapisGrupy', 'planer'],
    katalog: ['katalog', 'katalogJednostki', 'katalogPrzedmioty', 'katalogKierunki', 'katalogBudynki'],
  };

  // Per-view list of `this.data` result keys whose *shape* — not just
  // whether the fetch itself succeeded — hasn't been confirmed against real
  // populated USOS markup yet (see the "UNVERIFIED" comments on
  // adapter.getExams and adapter.genericInfoTable; getPlan's static
  // register() literal and getGrades were verified live 2026-09-28).
  // Drives renderBetaNotice: a view shows the banner whenever one of its sources
  // actually has data (`supported`) that we're not yet sure we parsed
  // correctly (`!verified`), rather than every reviewer having to remember
  // to wire up a warning by hand on each new unverified page.
  const UNVERIFIED_SOURCES = {
    dashboard: ['gradesResult', 'planResult', 'examsResult'],
    plan: ['planResult'],
    oceny: ['gradesResult'],
    egzaminy: ['examsResult'],
    stypendia: ['scholarshipsResult'],
    sprawdziany: ['testsResult'],
    podania: ['petitionsResult'],
    ankiety: ['surveysResult'],
    studenci: ['participantsResult'],
  };

  // A plain document reload (classic USOSweb navigation, not an SPA route
  // change) tears down and re-mounts the whole App, which used to always
  // land back on the dashboard. sessionStorage survives a reload of the same
  // tab but clears when the tab actually closes — exactly "stay where you
  // were" semantics, without a freshly opened USOS tab inheriting whatever
  // section a *different* tab last looked at (chrome.storage would do that).
  const VIEW_STORAGE_KEY = 'usospp_lastView';
  const VALID_VIEWS = new Set([
    ...NAV_ITEMS.map((item) => item.id),
    ...MORE_NAV_ITEMS.map((item) => item.id),
    'przedmiotyLista', 'zapisy', 'zapisTura', 'zapisGrupy', 'planer', 'ustawienia', 'subjectPage', 'catalogPage',
  ]);

  // Views that render entirely from pages USOSweb also serves to anonymous
  // visitors (news; the search→katalog2 subject/unit/program pages; campus
  // buildings), so they keep working while logged out — everything else in
  // this.data is personal and falls back to the login prompt (renderView).
  // The topbar's search overlay isn't a view and needs no entry here.
  const PUBLIC_VIEWS = new Set(['aktualnosci', 'subjectPage', 'catalogPage', 'mapa', 'katalog', 'katalogJednostki', 'katalogPrzedmioty', 'katalogKierunki', 'katalogBudynki']);

  // "Is there a new announcement since I last opened Aktualności" — chrome
  // .storage.local (device-local, not synced, survives tab close unlike
  // sessionStorage) remembers a signature of the titles shown last time the
  // user actually visited the page; any mismatch means something changed.
  // Keyed by origin so a future second-university install (see
  // background.js's registerUniversity) doesn't mix the two up.
  const NEWS_SEEN_KEY = 'usospp:newsSeenSignature:' + location.origin;
  // Persisted Studenci filters (excluded subjects + hide-lectures), same
  // device-local storage pattern as NEWS_SEEN_KEY — view state itself
  // stays in-memory, but the user explicitly asked these to survive reloads.
  const STUDENCI_FILTERS_KEY = 'usospp:studenciFilters:' + location.origin;
  function newsSignature(newsResult) {
    return ((newsResult && newsResult.items) || []).map((it) => it.title).join('|');
  }

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

  const ICONS = {
    grid: '<rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.5"></rect><rect x="11" y="2.5" width="6.5" height="6.5" rx="1.5"></rect><rect x="2.5" y="11" width="6.5" height="6.5" rx="1.5"></rect><rect x="11" y="11" width="6.5" height="6.5" rx="1.5"></rect>',
    calendar: '<rect x="2.5" y="3.5" width="15" height="14" rx="2"></rect><line x1="2.5" y1="8" x2="17.5" y2="8"></line><line x1="6.5" y1="2" x2="6.5" y2="5"></line><line x1="13.5" y1="2" x2="13.5" y2="5"></line>',
    bars: '<line x1="4" y1="16" x2="4" y2="9"></line><line x1="10" y1="16" x2="10" y2="4"></line><line x1="16" y1="16" x2="16" y2="12"></line>',
    book: '<rect x="3" y="2.5" width="12" height="15" rx="1.5"></rect><rect x="6" y="4.5" width="9" height="13" rx="1.5" fill="var(--bg-page)"></rect><line x1="8.5" y1="8" x2="12.5" y2="8"></line><line x1="8.5" y1="11" x2="12.5" y2="11"></line>',
    check: '<circle cx="10" cy="10" r="7.2"></circle><path d="M6.8 10.2l2 2 4.2-4.4"></path>',
    ticket: '<path d="M3 7.3a1.6 1.6 0 0 1 1.6-1.6h10.8A1.6 1.6 0 0 1 17 7.3v1a1.3 1.3 0 0 0 0 2.4v1a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 11.7v-1a1.3 1.3 0 0 0 0-2.4v-1z"></path><line x1="10" y1="6" x2="10" y2="14" stroke-dasharray="1.6 1.6"></line>',
    layers: '<path d="M10 3l7 3.6-7 3.6-7-3.6L10 3z"></path><path d="M3 10.4l7 3.6 7-3.6"></path><path d="M3 14l7 3.6 7-3.6"></path>',
    ring: '<circle cx="10" cy="10" r="7.2" stroke-opacity="0.35"></circle><path d="M10 2.8a7.2 7.2 0 0 1 5.1 12.3"></path>',
    bell: '<path d="M5 8.2a5 5 0 0 1 10 0c0 3.6 1.3 4.8 1.3 4.8H3.7S5 11.8 5 8.2z"></path><path d="M8.2 15.6a1.9 1.9 0 0 0 3.6 0"></path>',
    card: '<rect x="2" y="4.5" width="16" height="11" rx="2"></rect><line x1="2" y1="8" x2="18" y2="8"></line><line x1="5" y1="12.5" x2="9" y2="12.5"></line>',
    settings: '<line x1="3" y1="5" x2="17" y2="5"></line><circle cx="12" cy="5" r="1.8" fill="var(--bg-page)"></circle><line x1="3" y1="10" x2="17" y2="10"></line><circle cx="7" cy="10" r="1.8" fill="var(--bg-page)"></circle><line x1="3" y1="15" x2="17" y2="15"></line><circle cx="14" cy="15" r="1.8" fill="var(--bg-page)"></circle>',
    close: '<line x1="5" y1="5" x2="15" y2="15"></line><line x1="15" y1="5" x2="5" y2="15"></line>',
    coins: '<circle cx="7.5" cy="8" r="4.3"></circle><circle cx="12.5" cy="12" r="4.3"></circle>',
    clipboard: '<rect x="4" y="3.5" width="12" height="14" rx="1.5"></rect><rect x="7" y="2" width="6" height="3" rx="1"></rect><line x1="6.5" y1="9" x2="13.5" y2="9"></line><line x1="6.5" y1="12.5" x2="13.5" y2="12.5"></line>',
    send: '<path d="M3 10l14-6.5-5.5 14-2.3-6.2L3 10z"></path>',
    star: '<path d="M10 2.8l2.2 4.6 5 .7-3.6 3.6.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.6 5-.7L10 2.8z"></path>',
    more: '<circle cx="5" cy="10" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="15" cy="10" r="1.3" fill="currentColor" stroke="none"></circle>',
    chevron: '<path d="M7.5 5l5.5 5-5.5 5" stroke-width="2"></path>',
    pin: '<path d="M10 2.6c-3.3 0-6 2.6-6 5.9 0 4.4 6 9.1 6 9.1s6-4.7 6-9.1c0-3.3-2.7-5.9-6-5.9z"></path><circle cx="10" cy="8.3" r="2.1"></circle>',
    users: '<circle cx="7" cy="7" r="3"></circle><path d="M2.5 16.5a4.5 4.5 0 0 1 9 0"></path><circle cx="13.5" cy="8" r="2.4"></circle><path d="M14.5 12.6a3.6 3.6 0 0 1 3 3.9"></path>',
    lock: '<rect x="5" y="9" width="10" height="7.5" rx="1.5"></rect><path d="M7 9V6.3a3 3 0 0 1 6 0V9"></path>',
    idcard: '<rect x="2" y="4.5" width="16" height="11" rx="2"></rect><circle cx="7" cy="9" r="1.8"></circle><path d="M4.6 13.2a2.6 2.6 0 0 1 4.8 0"></path><line x1="12" y1="8" x2="16" y2="8"></line><line x1="12" y1="11" x2="16" y2="11"></line>',
  };

  function icon(name, size = 19) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">${ICONS[name] || ''}</svg>`;
  }

  // Sub-pages one level under a nav hub (przedmiotyLista/zapisy/planer under
  // "Przedmioty", or a subject-detail page under whatever it was opened from)
  // no longer have their own persistent sidebar row, so they need this to get
  // back up a level.
  function backLink(viewId, label = '← Wróć') {
    return `<a data-action="nav" data-view="${esc(viewId)}" class="usospp-back-link">${esc(label)}</a>`;
  }

  // Every "open in classic USOS" link needs ?usospp_off=1 or the redesign
  // (still globally enabled for the domain) just mounts right back on top
  // of whatever page it opens, hiding the real content again — easy to
  // forget on a URL that came straight from a scraped href rather than one
  // built here with the param already on it, so the click handler adds it
  // centrally instead of relying on every call site to remember.
  // Security: data-url values come from scraped DOM, so only same-origin
  // http(s) or site-relative URLs are allowed — anything else (javascript:,
  // data:, external origin) falls back to the USOS home page.
  function isSafeOpenUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url, location.origin);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return parsed.origin === location.origin;
    } catch (e) {
      return false;
    }
  }
  function withUsospOff(url) {
    if (!url) return location.origin + '/kontroler.php';
    if (!isSafeOpenUrl(url)) return location.origin + '/kontroler.php';
    if (/(?:^|[?&])usospp_off=/.test(url)) return url;
    return url + (url.includes('?') ? '&' : '?') + 'usospp_off=1';
  }
  function safeOpenUrl(url, fallback) {
    const target = isSafeOpenUrl(url) ? url : (fallback || (location.origin + '/kontroler.php'));
    window.open(withUsospOff(target), '_blank', 'noopener');
  }

  // One row from adapter.getPaymentGroups — its `fields` are whatever
  // columns that particular USOS page happened to render (label -> text),
  // not a fixed shape, so this picks a sensible "title" (the free-text
  // description if there is one, else the fee category) and an "amount"
  // badge out of whatever's there instead of assuming column positions.
  function renderPaymentRow(row) {
    const entries = Object.entries(row.fields || {}).filter(([, v]) => v);
    if (!entries.length) return '';
    const amountEntry = entries.find(([label]) => /kwota|pozosta|należn/i.test(label));
    const titleEntry = entries.find(([label]) => /opis/i.test(label))
      || entries.find(([label]) => /rodzaj/i.test(label))
      || entries[0];
    const metaEntries = entries.filter(([label]) => label !== titleEntry[0] && (!amountEntry || label !== amountEntry[0]));
    return `
      <div class="usospp-list-row" style="align-items:flex-start;">
        <div>
          <div style="font-size:13.5px;font-weight:600;">${esc(titleEntry[1])}</div>
          ${metaEntries.length ? `<div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${metaEntries.map(([label, value]) => `${esc(label)}: ${esc(value)}`).join(' · ')}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0;">
          ${amountEntry ? `<div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(amountEntry[1])}</div>` : ''}
          ${row.detailsUrl ? `<div style="margin-top:6px;"><a data-action="openPaymentDetails" data-url="${esc(row.detailsUrl)}" style="font-size:12px;font-weight:600;color:#d9773a;cursor:pointer;">szczegóły →</a></div>` : ''}
        </div>
      </div>
    `;
  }

  // Status badge for the mLegitymacja card header — design-system tones
  // (.usospp-badge-positive/-warning/-negative from design-system.css),
  // matched against the raw <usos-tag> text, first hit wins. Anything
  // unrecognised (Anulowane/Unieważnione/…) stays neutral, same subtle
  // look renderInfoTableRow uses for its status badges.
  function mlegStatusBadge(status) {
    const s = (status || '').trim();
    if (!s) return '';
    const tone = /^do odbioru|^odebran/i.test(s) ? 'usospp-badge-positive'
      : /^oczekuje|^w trakcie/i.test(s) ? 'usospp-badge-warning'
      : /^b[lł][aą]d/i.test(s) ? 'usospp-badge-negative' : '';
    const style = tone ? '' : ' style="background:var(--bg-subtle);color:var(--ink-2);"';
    return `<span class="usospp-badge ${tone}"${style}>${esc(s)}</span>`;
  }

  // Status legend for the mLegitymacja view — meanings paraphrased from
  // the help-dialog on dla_stud/studia/mlegitymacja/index (verified live
  // 2026-10-01). Matched against the raw <usos-tag> text, first hit wins.
  const MLEG_STATUS_INFO = [
    [/^oczekuje/i, 'Zamówienie zostało złożone. Uczelnia nie przekazała go jeszcze do systemu Ministerstwa Cyfryzacji.'],
    [/^w trakcie/i, 'Zamówienie zostało przekazane i jest przetwarzane przez system Ministerstwa Cyfryzacji — wydanie kodów trwa zazwyczaj kilka minut.'],
    [/^do odbioru/i, 'Zamówienie gotowe — możesz dodać mLegitymację do aplikacji mObywatel.'],
    [/^odebran/i, 'mLegitymacja została dodana do aplikacji mObywatel.'],
    [/^b[lł][aą]d/i, 'Przetwarzanie zamówienia zakończyło się błędem — szczegóły sprawdź w klasycznym USOS.'],
    [/^anulowane/i, 'Zamówienie (lub mLegitymacja) zostało anulowane.'],
    [/^uniewa[zż]nione/i, 'Uczelnia unieważniła zamówienie lub mLegitymację — zwykle z powodu utraty uprawnień.'],
  ];

  // "2026-10-01 11:11:49" / "2027-03-31" (local-time[datetime] on the
  // mLegitymacja page) -> "1.10.2026, 11:11" / "31.03.2027". Pass-through
  // on anything unparseable rather than showing nothing.
  function formatMlegDate(raw) {
    if (!raw) return '';
    const m = String(raw).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return String(raw);
    const date = `${+m[3]}.${+m[2]}.${m[1]}`;
    return m[4] ? `${date}, ${m[4]}:${m[5]}` : date;
  }
  // One row from adapter.genericInfoTable (stypendia/sprawdziany/podania/
  // ankiety) — same "unknown columns, pick a sensible title/status out of
  // whatever's there" approach as renderPaymentRow, just without a payments-
  // details modal to open: we haven't built dedicated detail-page scraping
  // for these four, so "szczegóły" simply links out to classic USOS.
  function renderInfoTableRow(row) {
    const entries = Object.entries(row.fields || {}).filter(([, v]) => v);
    if (!entries.length) return '';
    const statusEntry = entries.find(([label]) => /status|rozpatrzeni|stan/i.test(label));
    const titleEntry = entries.find(([label]) => /nazwa|rodzaj|opis|przedmiot|tytuł/i.test(label)) || entries[0];
    const metaEntries = entries.filter(([label]) => label !== titleEntry[0] && (!statusEntry || label !== statusEntry[0]));
    return `
      <div class="usospp-list-row" style="align-items:flex-start;">
        <div>
          <div style="font-size:13.5px;font-weight:600;">${esc(titleEntry[1])}</div>
          ${metaEntries.length ? `<div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${metaEntries.map(([label, value]) => `${esc(label)}: ${esc(value)}`).join(' · ')}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0;">
          ${statusEntry ? `<div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(statusEntry[1])}</div>` : ''}
          ${row.detailsUrl ? `<div style="margin-top:6px;"><a data-action="openUsos" data-url="${esc(row.detailsUrl)}" style="font-size:12px;font-weight:600;color:#d9773a;cursor:pointer;">szczegóły →</a></div>` : ''}
        </div>
      </div>
    `;
  }

  // One organizational unit's dues/payments (see adapter.getPaymentGroups) —
  // USOS bills/pays through several units (dziekanat, akademik, …), each
  // getting its own little labeled block with its own subtotal.
  function renderPaymentGroup(group) {
    return `
      <div style="margin-bottom:16px;">
        ${group.unitLabel ? `<div style="font-size:12px;font-weight:600;color:var(--ink-3);margin-bottom:6px;">${esc(group.unitLabel)}</div>` : ''}
        ${group.rows.map(renderPaymentRow).join('')}
        ${group.total ? `<div style="font-size:12px;color:var(--ink-3);text-align:right;margin-top:6px;">${esc(group.total)}</div>` : ''}
      </div>
    `;
  }

  // USOS++ mark per the brand system: a rounded orange tile (23% radius) with
  // two bold white "+" glyphs (59% of tile width, 16% inner gap). Below 32px
  // the tile radius shrinks and the gap widens (tracking -> 0) so the two
  // pluses don't visually merge — that's the "compact" variant.
  const LOGO_TILE_MASTER = '<rect x="0" y="0" width="100" height="100" rx="23" fill="#d9773a"/><rect x="27.7" y="36.25" width="7.1" height="21.5" rx="1.99" fill="#fff"/><rect x="20.5" y="43.45" width="21.5" height="7.1" rx="1.99" fill="#fff"/><rect x="65.2" y="36.25" width="7.1" height="21.5" rx="1.99" fill="#fff"/><rect x="58" y="43.45" width="21.5" height="7.1" rx="1.99" fill="#fff"/>';
  const LOGO_TILE_COMPACT = '<rect x="0" y="0" width="100" height="100" rx="18" fill="#d9773a"/><rect x="26.42" y="37.75" width="6.66" height="18.5" rx="1.87" fill="#fff"/><rect x="20.5" y="43.67" width="18.5" height="6.66" rx="1.87" fill="#fff"/><rect x="66.92" y="37.75" width="6.66" height="18.5" rx="1.87" fill="#fff"/><rect x="61" y="43.67" width="18.5" height="6.66" rx="1.87" fill="#fff"/>';
  function logoSvg(compact) {
    return `<svg viewBox="0 0 100 100" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">${compact ? LOGO_TILE_COMPACT : LOGO_TILE_MASTER}</svg>`;
  }

  const TITLES = {
    dashboard: ['Panel', 'Podsumowanie'],
    aktualnosci: ['Aktualności', 'Ogłoszenia i komunikaty z USOSweb'],
    plan: ['Plan zajęć', 'Bieżący tydzień'],
    oceny: ['Oceny', 'Aktualny widok z USOSweb'],
    przedmioty: ['Przedmioty', 'Przegląd, zapisy i generator planu'],
    przedmiotyLista: ['Przegląd przedmiotów', 'Na podstawie danych z USOSweb'],
    zapisy: ['Zapisy', 'Twoje tury rejestracji — terminy, przedmioty i plany'],
    zapisTura: ['Tura zapisów', 'Przedmioty w wybranej turze'],
    zapisGrupy: ['Grupy przedmiotu', 'Zapełnienie grup w turze'],
    planer: ['Generator planu', 'Podgląd — niczego tu nie zapisujemy w USOS'],
    egzaminy: ['Egzaminy', 'Zapisy i wyniki sesji'],
    ects: ['ECTS / Postęp', 'Realizacja programu studiów'],
    platnosci: ['Płatności', 'Należności, wpłaty i konta bankowe'],
    stypendia: ['Stypendia', 'Wypłaty i decyzje stypendialne'],
    sprawdziany: ['Sprawdziany', 'Zasady rozliczania przedmiotów'],
    podania: ['Podania', 'Złożone wnioski i ich rozpatrzenie'],
    ankiety: ['Ankiety', 'Ankiety do wypełnienia'],
    studenci: ['Studenci', 'Wspólne zajęcia z Twoich grup'],
    mlegitymacja: ['mLegitymacja', 'Status zamówienia legitymacji mobilnej'],
    ustawienia: ['Ustawienia', 'Profil, wygląd i powiadomienia'],
    subjectPage: ['Przedmiot', 'Szczegóły z katalogu USOS'],
    catalogPage: ['Katalog', 'Szczegóły z katalogu USOS'],
    katalog: ['Katalog', 'Jednostki, przedmioty, kierunki i budynki'],
    katalogJednostki: ['Jednostki', 'Przeglądaj strukturę uczelni'],
    katalogPrzedmioty: ['Przedmioty', 'Oferta przedmiotów wg jednostek'],
    katalogKierunki: ['Kierunki i programy', 'Co można studiować i w jakich trybach'],
    katalogBudynki: ['Budynki', 'Lista budynków — dane z USOS'],
    mapa: ['Mapa kampusu', 'Budynki na mapie — dane z USOS'],
  };

  class App {
    constructor(root, data, initialSettings) {
      this.root = root;
      this.data = data;
      this.settings = initialSettings; // { darkMode, features }

      const saved = loadViewState();
      let initialView = 'dashboard';
      let initialSubjectUrl = null;
      let initialSubjectBackView = 'przedmiotyLista';
      let initialCatalogKind = null;
      let initialCatalogKod = null;
      let initialCatalogEtpKod = null;
      let initialCatalogBackView = 'dashboard';
      let initialCatalogPrevKind = null;
      let initialCatalogPrevKod = null;
      let initialZapisTura = null;
      let initialZapisGrupy = null;
      if (saved && VALID_VIEWS.has(saved.view)) {
        if (saved.view === 'subjectPage') {
          if (saved.subjectUrl) {
            initialView = 'subjectPage';
            initialSubjectUrl = saved.subjectUrl;
            initialSubjectBackView = (saved.subjectBackView && VALID_VIEWS.has(saved.subjectBackView) && saved.subjectBackView !== 'subjectPage')
              ? saved.subjectBackView
              : 'przedmiotyLista';
          }
        } else if (saved.view === 'catalogPage') {
          const validKind = saved.catalogKind === 'unit' || saved.catalogKind === 'program'
            || (saved.catalogKind === 'stage' && !!saved.catalogEtpKod);
          if (saved.catalogKod && validKind) {
            initialView = 'catalogPage';
            initialCatalogKind = saved.catalogKind;
            initialCatalogKod = saved.catalogKod;
            initialCatalogEtpKod = saved.catalogKind === 'stage' ? saved.catalogEtpKod : null;
            initialCatalogBackView = (saved.catalogBackView && VALID_VIEWS.has(saved.catalogBackView) && saved.catalogBackView !== 'catalogPage')
              ? saved.catalogBackView
              : 'dashboard';
            // A page opened from another catalog page remembers where
            // "Wróć" should land — the live snapshot (see openCatalogPage)
            // can't survive a reload, but {kind, kod} does, enough to
            // re-open that page.
            if ((saved.catalogKind === 'unit' || saved.catalogKind === 'program')
              && (saved.catalogBackPrevKind === 'unit' || saved.catalogBackPrevKind === 'program')) {
              initialCatalogPrevKind = saved.catalogBackPrevKind;
              initialCatalogPrevKod = saved.catalogBackPrevKod || null;
            }
          }
        } else if (saved.view === 'zapisTura') {
          if (saved.zapisTuraSubjectsUrl || saved.zapisTuraKey) {
            initialView = 'zapisTura';
            initialZapisTura = {
              key: saved.zapisTuraKey || null,
              title: saved.zapisTuraTitle || '',
              code: saved.zapisTuraCode || '',
              subjectsUrl: saved.zapisTuraSubjectsUrl || '',
              registerUrl: saved.zapisTuraRegisterUrl || '',
              planUrls: Array.isArray(saved.zapisTuraPlanUrls) ? saved.zapisTuraPlanUrls : [],
            };
          }
        } else if (saved.view === 'zapisGrupy') {
          if (saved.zapisGrupyGroupsUrl || (saved.zapisGrupyTourKey && saved.zapisGrupySubjKod)) {
            initialView = 'zapisGrupy';
            initialZapisGrupy = {
              key: saved.zapisGrupyKey || null,
              tourKey: saved.zapisGrupyTourKey || null,
              subjKod: saved.zapisGrupySubjKod || null,
              title: saved.zapisGrupyTitle || '',
              kod: saved.zapisGrupyKod || '',
              cykl: saved.zapisGrupyCykl || '',
              occupancy: saved.zapisGrupyOccupancy || null,
              detailsUrl: saved.zapisGrupyDetailsUrl || '',
              groupsUrl: saved.zapisGrupyGroupsUrl || '',
              registerUrl: saved.zapisGrupyRegisterUrl || '',
              returnView: saved.zapisGrupyReturnView === 'planer' ? 'planer' : null,
            };
          }
        } else {
          initialView = saved.view;
        }
      }
      // Explicit deep-link (?usospp_view=…) — e.g. from the extension
      // popup's quick tiles opening a fresh tab. Takes precedence over the
      // sessionStorage restore (explicit user intent beats remembered
      // state); sanitized against VALID_VIEWS. Parameterized views
      // (subjectPage/catalogPage/zapisTura/zapisGrupy) are intentionally
      // excluded — they need a saved payload the URL can't carry, so the
      // param is ignored for those and the restore/default stands.
      try {
        const deepView = new URLSearchParams(location.search).get('usospp_view');
        if (deepView && VALID_VIEWS.has(deepView)
          && deepView !== 'subjectPage' && deepView !== 'catalogPage'
          && deepView !== 'zapisTura' && deepView !== 'zapisGrupy') {
          initialView = deepView;
        }
      } catch (e) { /* non-URL contexts — keep the restore */ }

      this.state = {
        view: initialView,
        notifPanelOpen: false,
        avatarMenuOpen: false,
        moreExpanded: false,
        dismissedBetaViews: [],
        newsHasUpdate: false,
        paymentDetailsOpen: false,
        paymentDetailsLoading: false,
        paymentDetailsError: false,
        paymentDetailsData: null,
        groupsModalOpen: false,
        groupsModalLoading: false,
        groupsModalError: false,
        groupsModalData: null,
        groupsModalTitle: '',
        linksModalOpen: false,
        linksModalTitle: '',
        linksModalLinks: [],
        calcAvg: '',
        calcEcts: '',
        calcGrade: '5.0',
        calcNewEcts: '5',
        zapisyFilter: '',
        planWeekOffset: 0,
        planViewMode: 'week', // 'week' (siatka) | 'list' (lista)
        planScope: 'concrete', // 'concrete' (dynamiczny: konkretny tydzień) | 'generic' (szablon ogólny)
        planDetailsLoading: false,
        planSessionModal: null, // weeklyPlan session object or null
        planGroupList: null, // session snapshot for the group roster modal or null
        planBuildingMap: null, // session snapshot for the building map modal or null
        planExportOpen: false, // export picker popup over the plan view
        sharedPlans: { plans: [], activeId: 'self' }, // somebody-else's timetables (see shared-plans-store.js)
        sharedPlansReady: false, // persisted list loaded from storage
        sharedPlanAddOpen: false, // "Dodaj plan" modal over the plan view
        sharedPlanAddError: null, // validation error in the add modal
        sharedOwnLink: null, // own public plan link {status, url} — memory only, never stored
        sharedVisibility: null, // plan-sharing mode {status, mode} — read-only display, memory only
        studenciQuery: '',
        studenciExcluded: [], // subject names excluded from Studenci matching
        studenciHideLectures: false, // hide Wykład groups from Studenci matching
        studenciFiltersReady: false, // persisted filters loaded from storage
        zapisTuraKey: initialZapisTura ? initialZapisTura.key : null,
        zapisTuraTitle: initialZapisTura ? initialZapisTura.title : '',
        zapisTuraCode: initialZapisTura ? initialZapisTura.code : '',
        zapisTuraSubjectsUrl: initialZapisTura ? initialZapisTura.subjectsUrl : '',
        zapisTuraRegisterUrl: initialZapisTura ? initialZapisTura.registerUrl : '',
        zapisTuraPlanUrls: initialZapisTura ? initialZapisTura.planUrls : [],
        zapisTuraSubjects: [],
        zapisTuraLoading: initialView === 'zapisTura',
        zapisTuraError: false,
        zapisGrupyKey: initialZapisGrupy ? initialZapisGrupy.key : null,
        zapisGrupyTourKey: initialZapisGrupy ? initialZapisGrupy.tourKey : null,
        zapisGrupySubjKod: initialZapisGrupy ? initialZapisGrupy.subjKod : null,
        zapisGrupyTitle: initialZapisGrupy ? initialZapisGrupy.title : '',
        zapisGrupyKod: initialZapisGrupy ? initialZapisGrupy.kod : '',
        zapisGrupyCykl: initialZapisGrupy ? initialZapisGrupy.cykl : '',
        zapisGrupyOccupancy: initialZapisGrupy ? initialZapisGrupy.occupancy : null,
        zapisGrupyDetailsUrl: initialZapisGrupy ? initialZapisGrupy.detailsUrl : '',
        zapisGrupyGroupsUrl: initialZapisGrupy ? initialZapisGrupy.groupsUrl : '',
        zapisGrupyRegisterUrl: initialZapisGrupy ? initialZapisGrupy.registerUrl : '',
        zapisGrupySections: [],
        zapisGrupyLoading: initialView === 'zapisGrupy',
        zapisGrupyError: false,
        // Main-plan bridge (see computeZapisMainPlanMatch): which rows of
        // this group list are in the MAIN plan, plus a one-shot flash after
        // "Dodaj do planu" and a highlight target when arriving from a plan
        // block (direction A).
        zapisGrupyMainPlan: null,
        zapisGrupyHighlightNr: null,
        zapisGrupyReturnView: initialZapisGrupy ? initialZapisGrupy.returnView : null,
        subjectBackView: initialSubjectBackView,
        subjectUrl: initialSubjectUrl,
        subjectLoading: initialView === 'subjectPage',
        subjectError: false,
        subjectData: null,
        catalogKind: initialCatalogKind,
        catalogKod: initialCatalogKod,
        catalogEtpKod: initialCatalogEtpKod,
        catalogBackView: initialCatalogBackView,
        catalogLoading: initialView === 'catalogPage',
        catalogError: false,
        catalogData: null,
        catalogBuildings: [],
        catalogSubjects: [],
        catalogSubjectsTotal: 0,
        catalogSubjectsNextUrl: null,
        catalogSubjectsLoading: false,
        catalogSubjectQuery: '',
        catalogSubjectsCurrentOnly: false,
        catalogPrograms: [],
        catalogProgramsNextUrl: null,
        catalogProgramsLoading: false,
        catalogBackSnapshot: null,
        catalogBackPrevKind: initialCatalogPrevKind,
        catalogBackPrevKod: initialCatalogPrevKod,
        katalogRootKod: null,
        katalogRootLoading: false,
        katalogRootError: false,
        katalogRootData: null,
        katalogBrowseKod: null,
        katalogBrowseLoading: false,
        katalogBrowseError: false,
        katalogBrowseData: null,
        katalogPrzedmiotyUnitKod: null,
        katalogPrzedmiotyLoading: false,
        katalogPrzedmioty: [],
        katalogPrzedmiotyTotal: 0,
        katalogPrzedmiotyNextUrl: null,
        katalogPrzedmiotyQuery: '',
        katalogPrzedmiotyCurrentOnly: false,
        katalogKierunkiUnitKod: null,
        katalogKierunkiLoading: false,
        katalogKierunki: [],
        katalogKierunkiNextUrl: null,
        katalogBudynkiQuery: '',
        mapaLoading: false,
        mapaError: false,
        mapaBuildings: [],
        mapaUnitFilter: '', // a unitKod, not display text — several units share a display name (see getBuildingsForUnit)
        mapaFocusKod: null, // pending "pan the campus map to this building" request from the topbar search — see openMapaFocused
        mapaSearchQuery: '',
        searchQuery: '',
        searchLoading: false,
        searchResults: null,
        plannerExpandedUrl: null,
        plannerSubjectCache: {},
        plannerSubjectLoading: null,
        plannerGroupsCache: {},
        plannerDraftSelection: {},
        // classTypeKey -> { groupsUrl, classTypeLabel }: class types of the
        // currently-expanded subject whose EVERY group is drawn on the grid
        // as a hoverable "what if" ghost ("podgląd w planie"), see
        // plannerTogglePreview/renderPlannerGrid. Scoped to the expanded
        // subject — cleared whenever the configurator closes/switches.
        plannerPreviewKeys: {},
        plannerPicks: [],
        plannerPlans: [],
        // Full plan records for the "Moje plany" section (stats need every
        // plan's picks, not just the active one's) — kept next to the
        // projections above, refreshed at the same four sites.
        plannerPlansFull: [],
        plannerActivePlanId: null,
        // The "my plan" integrations (Zapisy badges, tour banner, seat
        // guardian) read this plan — not necessarily the tab being looked
        // at (see planner-store.js's mainPlanId).
        plannerMainPlanId: null,
        // id of the plan tab currently showing an inline rename <input>,
        // or null when no rename is in progress.
        plannerRenamingPlanId: null,
        // id of the plan with an armed delete confirm ("Usuń?" → Potwierdź),
        // or null. Disarmed by switching plans or firing elsewhere.
        plannerConfirmDeleteId: null,
        // Subjects added via "Dodaj przedmiot spoza listy" (see
        // plannerSelectSearchSubject), keyed by plan: planId -> subjectId ->
        // {subjectUrl, subjectName}. A custom subject stays on its plan's
        // list even after its last pick is removed (plannerSubjectCandidates
        // unions this with the pick-derived customs) — otherwise it would
        // vanish and have to be searched again. Session-only: after a
        // reload, picks (persisted in the store) imply the customs again.
        plannerCustomSubjects: {},
        // Direction A of the Plan × Zapisy bridge: seat badges on the
        // visible grid's blocks. plannerZapisyMode (Planowanie/Zapisy
        // toggle above the grid) decides what block clicks do — Zapisy
        // opens the tour group list, Planowanie expands the left column.
        // Entering Zapisy auto-runs the check; badges stay for both modes.
        plannerRejCheck: 'idle', // idle | loading | done
        plannerRejBadges: {},
        plannerRejSummary: null,
        plannerZapisyMode: false,
        // Direction C: tour banner over the plan. Null = not loaded yet
        // (ensurePlannerTourBanner fills it once per page lifetime);
        // { tours: [] } = loaded, empty when no active tour covers the
        // main plan — the banner then renders nothing at all.
        plannerTourBanner: null,
        plannerCustomSearchOpen: false,
        plannerCustomSearchQuery: '',
        plannerCustomSearchLoading: false,
        plannerCustomSearchResults: null,
        // ---- automatic generator ("Automatyczny" mode) ----
        plannerMode: 'manual',
        plannerAutoSelected: {}, // subjectId -> {subjectUrl, subjectName}
        // Signature of the candidate list the last seed covered (sorted
        // subjectIds joined) — seedPlannerAutoSelected only union-ADDS, so
        // a manually unticked subject is never re-checked behind the
        // student's back; only genuinely new candidates get default-checked.
        plannerAutoSeedSig: null,
        plannerAutoEarliestStart: '',
        plannerAutoLatestEnd: '',
        plannerAutoBlockedWindows: [], // [{day, start, end}]
        plannerAutoBlockDraftDay: 'poniedziałek',
        plannerAutoBlockDraftStart: '',
        plannerAutoBlockDraftEnd: '',
        plannerAutoMaxPerDay: '',
        plannerAutoPreferredDays: '',
        plannerAutoMinimizeGaps: true,
        // Generator constraint (direction D): when on, groups the tour
        // reports as full are removed from the CSP domains before search.
        // Unknown seat state never filters — only confirmed-full groups go.
        plannerAutoOnlyFreeSeats: true,
        // Fresh tour seat map for the "pełna" tags on group rows/popovers:
        // `${kod}||${normalized label}||${nr}` -> { full, seatsText }.
        // seatsText counts TAKEN seats ("23/26", 'pełna' when full).
        // Filled by generate-with-constraint; absent until then.
        plannerAutoSeatMap: {},
        plannerAutoStatus: 'idle', // idle | fetching | generating | done | failed
        plannerAutoCandidates: [],
        plannerAutoActiveCandidateIndex: 0,
        plannerAutoFailure: null,
      };
      this._onClick = this.handleClick.bind(this);
      this._onChange = this.handleChange.bind(this);
      this._onInput = this.handleInput.bind(this);
      this._onKeydown = this.handleKeydown.bind(this);
      this._onPopState = this.handlePopState.bind(this);
      this.root.addEventListener('click', this._onClick);
      // Only `change` (fires on blur/select, not per keystroke) — a full
      // re-render on every keystroke would replace the focused <input> node
      // and drop the cursor mid-typing. The topbar search box needs actual
      // per-keystroke input, but never goes through a full render either
      // (see setSearchState) — it only ever patches the results dropdown
      // below the input, so the input itself is never touched.
      this.root.addEventListener('change', this._onChange);
      this.root.addEventListener('input', this._onInput);
      this.root.addEventListener('keydown', this._onKeydown);
      window.addEventListener('popstate', this._onPopState);
      // Anchors the bottom of the back/forward stack to whatever we're
      // about to show (dashboard, or a subjectPage/catalogPage restored
      // from sessionStorage above) — same URL, just carrying our own state
      // object, so a same-document popstate fires instead of the browser
      // falling through to whatever real entry preceded this page load. See
      // persistViewState()/handlePopState() for the rest of the mechanism.
      try { history.replaceState(this.viewStatePayload(), '', location.href); } catch (e) { /* ignore */ }
      this.setupTitleGuard();
      this.seedPlannerAutoSelected();
      this.loadPlannerPicks();
      this.checkNewsUpdate();
      if (initialView === 'subjectPage' && initialSubjectUrl) {
        this.fetchSubjectData(initialSubjectUrl);
      }
      if (initialView === 'zapisTura' && initialZapisTura) {
        this.fetchZapisTura(initialZapisTura);
      }
      if (initialView === 'zapisGrupy' && initialZapisGrupy) {
        this.fetchZapisGrupy(initialZapisGrupy);
      }
      if (initialView === 'catalogPage' && initialCatalogKod) {
        if (initialCatalogKind === 'stage') {
          this.fetchStagePage(initialCatalogKod, initialCatalogEtpKod, null);
        } else {
          this.fetchCatalogPage(initialCatalogKind, initialCatalogKod);
        }
      }
      if (initialView === 'mapa') {
        this.ensureMapaData();
      }
      if (initialView === 'plan' || initialView === 'dashboard') {
        this.ensurePlanDetails();
      }
      if (initialView === 'katalogJednostki' || initialView === 'katalogPrzedmioty' || initialView === 'katalogKierunki') {
        this.ensureKatalogRoot();
      }
      if (initialView === 'katalogBudynki') {
        this.ensureMapaData();
      }
      if (initialView === 'studenci') {
        this.loadStudenciFilters();
      }
      if (initialView === 'planer') {
        this.ensurePlannerTourBanner();
        this.plannerPrefetchPickedSubjects();
      }
      // Deferred per-view fetches (exams, registrations, stage subjects,
      // participants) — navigate() fires this on every view entry, so the
      // boot path must too; otherwise a refresh ON such a view sticks on
      // its loading state forever (nothing ever triggers the fetch).
      // No-op for views without deferred data or already-loaded flags.
      this.ensureDeferredData(initialView);
    }

    destroy() {
      if (this._leafletMap) { this._leafletMap.remove(); this._leafletMap = null; }
      if (this._unitMap) { this._unitMap.remove(); this._unitMap = null; this._unitMapMarkersByKod = null; }
      if (this._sessionMap) { this._sessionMap.remove(); this._sessionMap = null; }
      this.root.removeEventListener('click', this._onClick);
      this.root.removeEventListener('change', this._onChange);
      this.root.removeEventListener('input', this._onInput);
      this.root.removeEventListener('keydown', this._onKeydown);
      window.removeEventListener('popstate', this._onPopState);
      if (this._titleObserver) this._titleObserver.disconnect();
    }

    // Classic USOSweb ships a static server-rendered <title> and no script
    // touches it afterwards (verified live) — but just in case some page we
    // haven't seen does, re-assert our title if anything changes it out from
    // under us instead of silently losing the tab label.
    setupTitleGuard() {
      let titleEl = document.querySelector('title');
      if (!titleEl) {
        titleEl = document.createElement('title');
        document.head.appendChild(titleEl);
      }
      this._titleObserver = new MutationObserver(() => {
        if (this._lastTitle && document.title !== this._lastTitle) {
          document.title = this._lastTitle;
        }
      });
      this._titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }

    updateDocumentTitle() {
      let [title] = TITLES[this.state.view] || [];
      if (this.state.view === 'subjectPage' && this.state.subjectData) {
        title = this.state.subjectData.subjectName || title;
      }
      if (this.state.view === 'catalogPage' && this.state.catalogData) {
        title = this.state.catalogData.name || this.state.catalogData.label || title;
      }
      const full = title ? `${title} – USOS++` : 'USOS++';
      this._lastTitle = full;
      if (document.title !== full) document.title = full;
    }

    // Same shape used to survive a real page reload (sessionStorage, see
    // saveViewState/loadViewState) and to survive a browser back/forward
    // click within the same document (history.pushState/popstate, see
    // persistViewState/handlePopState) — both just need to know which
    // "page" of the app is showing and enough to re-fetch it.
    viewStatePayload() {
      return {
        view: this.state.view,
        subjectUrl: this.state.view === 'subjectPage' ? this.state.subjectUrl : null,
        subjectBackView: this.state.view === 'subjectPage' ? this.state.subjectBackView : null,
        zapisTuraKey: this.state.view === 'zapisTura' ? this.state.zapisTuraKey : null,
        zapisTuraTitle: this.state.view === 'zapisTura' ? this.state.zapisTuraTitle : null,
        zapisTuraCode: this.state.view === 'zapisTura' ? this.state.zapisTuraCode : null,
        zapisTuraSubjectsUrl: this.state.view === 'zapisTura' ? this.state.zapisTuraSubjectsUrl : null,
        zapisTuraRegisterUrl: this.state.view === 'zapisTura' ? this.state.zapisTuraRegisterUrl : null,
        zapisTuraPlanUrls: this.state.view === 'zapisTura' ? this.state.zapisTuraPlanUrls : null,
        zapisGrupyKey: this.state.view === 'zapisGrupy' ? this.state.zapisGrupyKey : null,
        zapisGrupyTourKey: this.state.view === 'zapisGrupy' ? this.state.zapisGrupyTourKey : null,
        zapisGrupySubjKod: this.state.view === 'zapisGrupy' ? this.state.zapisGrupySubjKod : null,
        zapisGrupyTitle: this.state.view === 'zapisGrupy' ? this.state.zapisGrupyTitle : null,
        zapisGrupyKod: this.state.view === 'zapisGrupy' ? this.state.zapisGrupyKod : null,
        zapisGrupyCykl: this.state.view === 'zapisGrupy' ? this.state.zapisGrupyCykl : null,
        zapisGrupyOccupancy: this.state.view === 'zapisGrupy' ? this.state.zapisGrupyOccupancy : null,
        zapisGrupyDetailsUrl: this.state.view === 'zapisGrupy' ? this.state.zapisGrupyDetailsUrl : null,
        zapisGrupyGroupsUrl: this.state.view === 'zapisGrupy' ? this.state.zapisGrupyGroupsUrl : null,
        zapisGrupyRegisterUrl: this.state.view === 'zapisGrupy' ? this.state.zapisGrupyRegisterUrl : null,
        zapisGrupyReturnView: this.state.view === 'zapisGrupy' ? this.state.zapisGrupyReturnView : null,
        catalogKind: this.state.view === 'catalogPage' ? this.state.catalogKind : null,
        catalogKod: this.state.view === 'catalogPage' ? this.state.catalogKod : null,
        catalogEtpKod: this.state.view === 'catalogPage' && this.state.catalogKind === 'stage' ? this.state.catalogEtpKod : null,
        catalogBackView: this.state.view === 'catalogPage' ? this.state.catalogBackView : null,
        catalogBackPrevKind: this.state.view === 'catalogPage' && (this.state.catalogKind === 'unit' || this.state.catalogKind === 'program') ? (this.state.catalogBackPrevKind || null) : null,
        catalogBackPrevKod: this.state.view === 'catalogPage' && (this.state.catalogKind === 'unit' || this.state.catalogKind === 'program') ? (this.state.catalogBackPrevKod || null) : null,
      };
    }

    // Called right after every real "page change" inside the app (see the 4
    // call sites: navigate(), openSubjectPage(), openCatalogPage(),
    // openStagePage()) — never from handlePopState() itself, or every
    // browser-back click would also push a brand new forward entry and the
    // stack could never shrink. Pushing with the *same* URL is deliberate:
    // it keeps the tab on this exact document (a same-document navigation,
    // just a popstate event, no reload) while still giving the browser's
    // own back/forward buttons something to step through.
    persistViewState() {
      const payload = this.viewStatePayload();
      saveViewState(payload);
      try { history.pushState(payload, '', location.href); } catch (e) { /* ignore */ }
    }

    // Browser back/forward landed on one of our own history entries (pushed
    // by persistViewState above, or the base one from the constructor).
    // `event.state` is null when the user has gone further back than any
    // in-app navigation ever pushed — before this content script started
    // managing history at all — in which case there's nothing of ours to
    // restore and the browser is about to leave the page for real, so we
    // just fall back to the dashboard rather than guessing.
    handlePopState(e) {
      this.closeAnyModal();
      const p = e.state || {};
      let view = VALID_VIEWS.has(p.view) ? p.view : 'dashboard';
      if (view === 'subjectPage' && !p.subjectUrl) view = 'przedmiotyLista';
      if (view === 'zapisTura' && !p.zapisTuraSubjectsUrl && !p.zapisTuraKey) view = 'zapisy';
      if (view === 'zapisGrupy' && !p.zapisGrupyGroupsUrl && !(p.zapisGrupyTourKey && p.zapisGrupySubjKod)) view = 'zapisy';
      if (view === 'catalogPage') {
        const validKind = p.catalogKind === 'unit' || p.catalogKind === 'program'
          || (p.catalogKind === 'stage' && !!p.catalogEtpKod);
        if (!p.catalogKod || !validKind) view = 'dashboard';
      }

      if (view === 'subjectPage') {
        const backView = (p.subjectBackView && VALID_VIEWS.has(p.subjectBackView) && p.subjectBackView !== 'subjectPage')
          ? p.subjectBackView
          : 'przedmiotyLista';
        this.setState({
          view: 'subjectPage',
          notifPanelOpen: false,
          avatarMenuOpen: false,
          subjectBackView: backView,
          subjectUrl: p.subjectUrl,
          subjectLoading: true,
          subjectError: false,
          subjectData: null,
        });
        this.fetchSubjectData(p.subjectUrl);
      } else if (view === 'catalogPage') {
        const backView = (p.catalogBackView && VALID_VIEWS.has(p.catalogBackView) && p.catalogBackView !== 'catalogPage')
          ? p.catalogBackView
          : 'dashboard';
        // Restored mid-chain ("Wróć" should re-open the previous catalog
        // page even though the live snapshot is gone) — see
        // openCatalogPage/catalogBack for the chain mechanism.
        const prevKind = (p.catalogKind === 'unit' || p.catalogKind === 'program')
          && p.catalogBackView === 'catalogPage'
          && (p.catalogBackPrevKind === 'unit' || p.catalogBackPrevKind === 'program')
          ? p.catalogBackPrevKind
          : null;
        this.setState({
          view: 'catalogPage',
          notifPanelOpen: false,
          avatarMenuOpen: false,
          catalogBackView: backView,
          catalogBackSnapshot: null,
          catalogBackPrevKind: prevKind,
          catalogBackPrevKod: prevKind ? (p.catalogBackPrevKod || null) : null,
          catalogKind: p.catalogKind,
          catalogKod: p.catalogKod,
          catalogEtpKod: p.catalogKind === 'stage' ? p.catalogEtpKod : null,
          catalogLoading: true,
          catalogError: false,
          catalogData: null,
          catalogBuildings: [],
        });
        if (p.catalogKind === 'stage') this.fetchStagePage(p.catalogKod, p.catalogEtpKod, null);
        else this.fetchCatalogPage(p.catalogKind, p.catalogKod);
      } else if (view === 'zapisTura') {
        this.setState({
          view: 'zapisTura',
          notifPanelOpen: false,
          avatarMenuOpen: false,
          zapisTuraKey: p.zapisTuraKey || null,
          zapisTuraTitle: p.zapisTuraTitle || '',
          zapisTuraCode: p.zapisTuraCode || '',
          zapisTuraSubjectsUrl: p.zapisTuraSubjectsUrl || '',
          zapisTuraRegisterUrl: p.zapisTuraRegisterUrl || '',
          zapisTuraPlanUrls: Array.isArray(p.zapisTuraPlanUrls) ? p.zapisTuraPlanUrls : [],
          zapisTuraSubjects: [],
          zapisTuraLoading: true,
          zapisTuraError: false,
        });
        this.fetchZapisTura({
          key: p.zapisTuraKey,
          title: p.zapisTuraTitle,
          code: p.zapisTuraCode,
          subjectsUrl: p.zapisTuraSubjectsUrl,
          registerUrl: p.zapisTuraRegisterUrl,
          planUrls: p.zapisTuraPlanUrls,
        });
      } else if (view === 'zapisGrupy') {
        this.setState({
          view: 'zapisGrupy',
          notifPanelOpen: false,
          avatarMenuOpen: false,
          zapisGrupyKey: p.zapisGrupyKey || null,
          zapisGrupyTourKey: p.zapisGrupyTourKey || null,
          zapisGrupySubjKod: p.zapisGrupySubjKod || null,
          zapisGrupyTitle: p.zapisGrupyTitle || '',
          zapisGrupyKod: p.zapisGrupyKod || '',
          zapisGrupyCykl: p.zapisGrupyCykl || '',
          zapisGrupyOccupancy: p.zapisGrupyOccupancy || null,
          zapisGrupyDetailsUrl: p.zapisGrupyDetailsUrl || '',
          zapisGrupyGroupsUrl: p.zapisGrupyGroupsUrl || '',
          zapisGrupyRegisterUrl: p.zapisGrupyRegisterUrl || '',
          zapisGrupySections: [],
          zapisGrupyLoading: true,
          zapisGrupyError: false,
          zapisGrupyMainPlan: null,
            zapisGrupyHighlightNr: p.zapisGrupyHighlightNr || null,
            zapisGrupyReturnView: p.zapisGrupyReturnView === 'planer' ? 'planer' : null,
        });
        this.fetchZapisGrupy({
          key: p.zapisGrupyKey,
          tourKey: p.zapisGrupyTourKey,
          subjKod: p.zapisGrupySubjKod,
          groupsUrl: p.zapisGrupyGroupsUrl,
        });
      } else if (view === 'mapa') {
        this.setState({ view: 'mapa', notifPanelOpen: false, avatarMenuOpen: false });
        this.ensureMapaData();
      } else if (view === 'katalogJednostki' || view === 'katalogPrzedmioty' || view === 'katalogKierunki') {
        this.setState({ view, notifPanelOpen: false, avatarMenuOpen: false });
        this.ensureKatalogRoot();
      } else if (view === 'katalogBudynki') {
        this.setState({ view, notifPanelOpen: false, avatarMenuOpen: false });
        this.ensureMapaData();
      } else {
        this.setState({ view, notifPanelOpen: false, avatarMenuOpen: false });
      }
      if (view === 'plan' || view === 'dashboard') this.ensurePlanDetails();
      saveViewState(this.viewStatePayload());
    }

    setState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      this.render();
    }

    // `render()` always rebuilds the ENTIRE `.usospp-root` innerHTML — fine
    // for occasional navigation, but the planner triggers several state
    // updates per click (expand → loading → fetched groups) and rebuilding
    // the sidebar/topbar/everything else on each one made the whole page
    // visibly flash. This patches just the planner's own DOM subtree
    // (marked `data-planner-root`) instead, and does nothing at all if the
    // planner isn't the active view (the state is still updated for next
    // time it's opened — no need to touch a DOM the user isn't looking at).
    setPlannerState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'planer') return;
      const el = this.root.querySelector('[data-planner-root]');
      if (!el) { this.render(); return; }
      el.innerHTML = this.renderPlannerBody();
    }

    // Same idea as setPlannerState: opening/closing the bell or avatar dropdown
    // only ever changes the topbar, but going through setState rebuilt the
    // whole page and replayed .usospp-view's fade-in across all the content
    // underneath it, which read as the page reloading itself.
    setTopbarState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-topbar-root]');
      if (!el) { this.render(); return; }
      el.outerHTML = this.renderTopbar();
    }

    // Same reasoning as setTopbarState/setPlannerSearchState — the
    // automatic generator's preferences card is its own isolated subtree
    // (unlike setPlannerState, which patches the whole planner body,
    // visibly flashing the subject list and results next to it on every
    // field edit). Only rendered while the "planer" view is showing its
    // "auto" mode, matching setPlannerState's own guard rather than
    // setTopbarState's always-visible one.
    setPlannerPrefsState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'planer' || this.state.plannerMode !== 'auto') return;
      const el = this.root.querySelector('[data-planner-prefs-root]');
      if (el) el.outerHTML = this.renderPlannerAutoPrefsForm();
    }

    // Dismissing the beta notice (see renderBetaNotice) only ever needs to
    // repaint the main content area, same reasoning as setTopbarState.
    // Content patches also silence the enter animation (see render()): the
    // <main> keeps data-enter="0" while its innerHTML swaps, so arriving
    // data never replays the navigation fade.
    setContentState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-content-root]');
      if (!el) { this.render(); return; }
      el.dataset.enter = '0';
      el.innerHTML = `${this.renderBetaNotice()}${this.renderView()}`;
    }

    // A view "has unverified data" when a source it actually displays came
    // back with real content (`supported`) whose shape we haven't confirmed
    // against a live populated page yet (`!verified`) — see
    // UNVERIFIED_SOURCES. Fetch failures alone (`supported: false`) don't
    // trigger this: those already show their own "couldn't read ..." hint,
    // which is a different, unrelated kind of problem.
    hasUnverifiedData() {
      const keys = UNVERIFIED_SOURCES[this.state.view] || [];
      return keys.some((key) => {
        const r = this.data[key];
        return r && r.supported && !r.verified;
      });
    }

    renderBetaNotice() {
      if (this.state.dismissedBetaViews.includes(this.state.view)) return '';
      if (!this.hasUnverifiedData()) return '';
      return `
        <div class="usospp-beta-notice">
          <span class="usospp-beta-notice-icon">⚠</span>
          <div>USOS++ jest jeszcze w wersji beta — ta strona nie została w pełni zweryfikowana i dane mogą wyświetlać się niepoprawnie.</div>
          <button class="usospp-beta-notice-close" data-action="dismissBetaNotice" title="Zamknij">${icon('close', 12)}</button>
        </div>
      `;
    }

    // checkNewsUpdate() resolves well after the initial render, completely
    // outside any click — going through setState would flash the fade-in
    // across the whole page just to light up one small dot in the sidebar.
    setSidebarState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-sidebar-root]');
      if (!el) { this.render(); return; }
      el.outerHTML = this.renderSidebar();
    }

    // Any modal (payment details, class groups, …) overlays whatever view
    // is underneath it — opening/closing it (or its loading -> loaded
    // transition) has nothing to do with the page content, so it gets the
    // same scoped-patch treatment as the topbar/sidebar/planner instead of
    // a full setState.
    setModalState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-modal-root]');
      if (!el) { this.render(); return; }
      el.innerHTML = this.renderModals();
      // The building map modal may carry an inline Leaflet preview
      // ([data-session-map]) — mount it after every modal-root patch, same
      // as render() does after a full rebuild.
      this.mountSessionMapPreview();
    }

    // At most one of these is ever open at once, but data-modal-root holds
    // whichever it is — each renderer returns '' when it isn't the open one.
    renderModals() {
      return this.renderPaymentDetailsModal() + this.renderGroupsModal() + this.renderLinksModal() + this.renderPlanSessionModal() + this.renderPlanGroupListModal() + this.renderPlanBuildingMapModal() + this.renderPlanExportModal() + this.renderSharedPlanAddModal();
    }

    closeAnyModal() {
      this.setModalState({ paymentDetailsOpen: false, groupsModalOpen: false, linksModalOpen: false, planSessionModal: null, planGroupList: null, planBuildingMap: null, planExportOpen: false, sharedPlanAddOpen: false });
    }

    // The search dropdown patches on every keystroke (after a debounce) —
    // going through setTopbarState here would replace the topbar's
    // outerHTML, including the <input> the user is actively typing into,
    // dropping focus and cursor position. This only ever touches the
    // results panel below the input.
    setSearchState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      const el = this.root.querySelector('[data-search-results-root]');
      if (el) el.innerHTML = this.renderSearchResults();
    }

    // Same reasoning as setSearchState above, for the planner's own "Dodaj
    // przedmiot spoza listy" search box — going through setPlannerState
    // would rebuild the whole planner body (it patches [data-planner-root]),
    // including the <input> being typed into.
    setPlannerSearchState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'planer') return;
      const el = this.root.querySelector('[data-planner-search-results-root]');
      if (el) el.innerHTML = this.renderPlannerCustomSearchResults();
    }

    // Typing in the unit page's subject mini-search — same reasoning as
    // setSearchState above: only the list/body below the input is patched,
    // never the <input> itself, so the cursor never jumps.
    setCatalogSubjectsState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'catalogPage') return;
      const el = this.root.querySelector('[data-catalog-subjects-root]');
      if (el) el.innerHTML = this.renderCatalogSubjectsSectionBody();
    }

    // Everything that updates the "Przedmioty" section AFTER the unit page
    // is on screen: the offer list arriving, "Wczytaj więcej", the
    // current-year toggle. A plain setState here rebuilds the whole
    // .usospp-root — replaying the view's fade-in and re-mounting the unit
    // map preview over content the user is already reading, which read as
    // the page loading itself a second time. Instead the section card's
    // count title, its toggle and its rows are patched in place, so the
    // <input> sitting between them keeps its value and focus. A section
    // that turns fully hidden (failed/empty fetch, e.g. on katedry) is
    // removed by the same rule renderView hides it with.
    setCatalogSubjectsSectionState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'catalogPage') return;
      const card = this.root.querySelector('[data-catalog-subjects-card]');
      if (!card) return;
      if (!this.renderCatalogSubjectsSection()) { card.outerHTML = ''; return; }
      const title = this.root.querySelector('[data-catalog-subjects-title]');
      if (title) title.innerHTML = this.renderCatalogSubjectsTitle();
      const toggle = this.root.querySelector('[data-catalog-subjects-toggle-wrap]');
      if (toggle) toggle.innerHTML = this.renderCatalogSubjectsToggle();
      const body = this.root.querySelector('[data-catalog-subjects-root]');
      if (body) body.innerHTML = this.renderCatalogSubjectsSectionBody();
    }

    // Same reasoning for the "Programy studiów" card — but with no <input>
    // inside, so the whole card can be swapped in one piece (outerHTML,
    // like setMapaFilter): the freshly rendered section, or removal when
    // it turned hidden.
    setCatalogProgramsState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'catalogPage') return;
      const el = this.root.querySelector('[data-catalog-programs-card]');
      if (el) el.outerHTML = this.renderCatalogProgramsSection();
    }

    updateSettings(settings) {
      this.settings = settings;
      this.render();
    }

    navigate(view) {
      const patch = { view, notifPanelOpen: false, avatarMenuOpen: false };
      if (view === 'aktualnosci' && this.state.newsHasUpdate) {
        patch.newsHasUpdate = false;
        this.persistNewsSeen();
      }
      this.setState(patch);
      this.persistViewState();
      if (view === 'mapa') this.ensureMapaData();
      if (view === 'planer') this.ensurePlannerTourBanner();
      if (view === 'planer') this.plannerPrefetchPickedSubjects();
      if (view === 'plan' || view === 'dashboard') this.ensurePlanDetails();
      if (view === 'katalogJednostki') this.ensureKatalogRoot();
      if (view === 'katalogPrzedmioty') this.ensureKatalogRoot();
      if (view === 'katalogKierunki') this.ensureKatalogRoot();
      if (view === 'katalogBudynki') this.ensureMapaData();
      if (view === 'studenci') this.loadStudenciFilters();
      // Pickup codes are sensitive — never revealed by navigation alone:
      // every entry to the view starts gated, only an explicit click
      // (mlegToggleQr) shows them, and they hide again on refresh.
      if (view === 'mlegitymacja') patch.mlegQrRevealed = false;
      this.ensureDeferredData(view);
    }

    // Lazy-loads sections deliberately left out of collectAll (exams iframe,
    // faculty rejestracje, per-stage subjects) on first view entry that
    // needs them. Re-renders only if the view is still the one that asked.
    ensureDeferredData(view) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters || !this.data) return;
      const adapter = adapters.selectAdapter ? adapters.selectAdapter() : null;
      if (!adapter) return;
      if ((view === 'egzaminy' || view === 'dashboard') && !this.data.examsResultLoaded && scrape.fetchExamsResult) {
        scrape.fetchExamsResult(adapter, this.data).then(() => {
          if (this.state.view === view) this.render();
        }).catch(() => {});
      }
      if ((view === 'zapisy' || view === 'zapisTura' || view === 'dashboard') && !this.data.registrationsResultLoaded && scrape.fetchRegistrationsResult) {
        scrape.fetchRegistrationsResult(adapter, this.data).then(() => {
          if (this.state.view === view) this.render();
        }).catch(() => {});
      }
      if ((view === 'przedmiotyLista' || view === 'zapisy' || view === 'dashboard' || view === 'planer') && !this.data.stageSubjectsResultLoaded && scrape.fetchStageSubjectsResult) {
        scrape.fetchStageSubjectsResult(adapter, this.data).then(() => {
          if (this.state.view === view) this.render();
        }).catch(() => {});
      }
      if (view === 'ects' && !this.data.etapDetailsResultLoaded && scrape.fetchEtapDetailsResult) {
        scrape.fetchEtapDetailsResult(adapter, this.data).then(() => {
          if (this.state.view === view) this.render();
        }).catch(() => {});
      }
      if (view === 'studenci' && scrape.fetchParticipantsResult) {
        this.ensureParticipantsResult(() => {
          if (this.state.view === view) this.render();
        });
      }
      if (view === 'mlegitymacja' && scrape.fetchMlegitymacjaResult) {
        scrape.fetchMlegitymacjaResult(adapter, this.data).then(() => {
          if (this.state.view === view) this.render();
        }).catch(() => {});
      }
    }

    persistNewsSeen() {
      const signature = newsSignature(this.data.newsResult);
      try { chrome.storage.local.set({ [NEWS_SEEN_KEY]: signature }); } catch (e) { /* ignore */ }
    }

    // Compares today's announcement titles against whatever was on the page
    // last time the user actually opened Aktualności (see persistNewsSeen)
    // to light up a small dot in the sidebar — same idea as the background
    // grade-check's hash diff in background.js, just for the news list and
    // surfaced in-app instead of as an OS notification.
    async checkNewsUpdate() {
      if (!this.data.newsResult || !this.data.newsResult.supported) return;
      const signature = newsSignature(this.data.newsResult);
      if (!signature) return;
      let stored;
      try {
        const res = await chrome.storage.local.get(NEWS_SEEN_KEY);
        stored = res[NEWS_SEEN_KEY];
      } catch (e) {
        return;
      }
      if (this.state.view === 'aktualnosci') {
        // Already looking at it on this very load — nothing to flag.
        if (stored !== signature) this.persistNewsSeen();
        return;
      }
      if (stored === undefined) {
        // First time ever — no prior signature to compare against, so
        // there's nothing genuinely "new" to announce yet.
        this.persistNewsSeen();
        return;
      }
      if (stored !== signature) {
        this.setSidebarState({ newsHasUpdate: true });
      }
    }

    handleClick(e) {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      switch (action) {
        case 'nav':
          this.navigate(el.dataset.view);
          break;
        case 'toggleMore':
          this.setSidebarState((s) => ({ moreExpanded: !s.moreExpanded }));
          break;
        case 'dismissBetaNotice':
          this.setContentState((s) => ({ dismissedBetaViews: [...s.dismissedBetaViews, s.view] }));
          break;
        case 'toggleNotifPanel':
          this.setTopbarState((s) => ({ notifPanelOpen: !s.notifPanelOpen, avatarMenuOpen: false }));
          break;
        case 'toggleAvatarMenu':
          this.setTopbarState((s) => ({ avatarMenuOpen: !s.avatarMenuOpen, notifPanelOpen: false }));
          break;
        case 'closeMenus':
          // Every click on empty space resolves here (it's the outermost
          // data-action ancestor) — only re-render when a menu is actually
          // open, otherwise every click on the page would force a full
          // innerHTML rebuild and feel like the page reloading itself.
          if (e.target === el && (this.state.notifPanelOpen || this.state.avatarMenuOpen)) {
            this.setTopbarState({ notifPanelOpen: false, avatarMenuOpen: false });
          }
          break;
        case 'stop':
          e.stopPropagation();
          break;
        case 'setDark':
          this.emitSettings({ darkMode: el.dataset.value === 'true' });
          break;
        case 'toggleFeature':
          this.emitSettings({ toggleFeature: el.dataset.key });
          break;
        case 'disableUsospp':
          this.emitSettings({ disable: true });
          break;
        case 'openUsos':
          safeOpenUrl(el.dataset.url || location.origin + '/kontroler.php');
          break;
        case 'viewSubjects':
          // Personal-calendar tour links (szukajPrzedmiotu&method=rej) open
          // the in-panel tour view; faculty-calendar links (jed_org_kod)
          // keep the old unit-offer view — one action, no duplicate paths.
          this.openZapisTuraFromUrl(el.dataset.url || '');
          break;
        case 'zapisTuraRetry':
          this.openZapisTuraFromUrl(this.state.zapisTuraSubjectsUrl || '');
          break;
        case 'openZapisGrupy': {
          let occ = null;
          try { occ = el.dataset.occ ? JSON.parse(el.dataset.occ) : null; } catch (e) { occ = null; }
          this.openZapisGrupy({
            tourKey: el.dataset.tour || null,
            subjKod: el.dataset.kod || null,
            title: el.dataset.name || '',
            kod: el.dataset.kod || '',
            cykl: el.dataset.cykl || '',
            occupancy: occ,
            detailsUrl: el.dataset.details || '',
            groupsUrl: el.dataset.url || '',
            registerUrl: el.dataset.register || '',
            // Entered from a tour list — back goes to the tour (default).
            returnView: null,
          });
          break;
        }
        case 'zapisGrupyRetry':
          this.fetchZapisGrupy({
            key: this.state.zapisGrupyKey,
            tourKey: this.state.zapisGrupyTourKey,
            subjKod: this.state.zapisGrupySubjKod,
            groupsUrl: this.state.zapisGrupyGroupsUrl,
          });
          break;
        case 'rescrape':
          this.emitSettings({ rescrape: true });
          break;
        case 'openSubjectPage':
          this.openSubjectPage(el.dataset.url);
          break;
        case 'catalogBack':
          this.catalogBack();
          break;
        case 'catalogSubjectsLoadMore':
          this.loadMoreCatalogSubjects();
          break;
        case 'catalogProgramsLoadMore':
          this.loadMoreCatalogPrograms();
          break;
        case 'toggleCatalogSubjectsCurrentOnly':
          this.setCatalogSubjectsSectionState((s) => ({ catalogSubjectsCurrentOnly: !s.catalogSubjectsCurrentOnly }));
          break;
        case 'katalogBrowseUnit':
          this.fetchKatalogBrowse(el.dataset.kod);
          break;
        case 'katalogSelectUnit':
          this.katalogSelectUnit(el.dataset.kod);
          break;
        case 'katalogRetry':
          this.katalogRetry();
          break;
        case 'newsRetry':
          this.newsRetry();
          break;
        case 'mlegitymacjaRefresh':
          this.mlegitymacjaRefresh();
          break;
        case 'mlegCopy':
          this.mlegCopy(el);
          break;
        case 'mlegToggleQr':
          this.setState({ mlegQrRevealed: !this.state.mlegQrRevealed });
          break;
        case 'planWeekPrev':
          this.setState((s) => ({ planWeekOffset: Number(s.planWeekOffset || 0) - 1 }));
          break;
        case 'planWeekNext':
          this.setState((s) => ({ planWeekOffset: Number(s.planWeekOffset || 0) + 1 }));
          break;
        case 'planWeekToday':
          this.setState({ planWeekOffset: 0 });
          break;
        case 'planViewWeek':
          this.setState({ planViewMode: 'week' });
          break;
        case 'planViewList':
          this.setState({ planViewMode: 'list' });
          break;
        case 'planScopeConcrete':
          this.setState({ planScope: 'concrete' });
          break;
        case 'planScopeGeneric':
          this.setState({ planScope: 'generic' });
          break;
        case 'sharedPlanSelect': {
          const id = (el.dataset.id || 'self').trim() || 'self';
          // The re-render persistSharedPlans does kicks ensureSharedPlanWeek
          // from renderPlan when a foreign plan becomes active.
          this.persistSharedPlans((d) => ({ ...d, activeId: id }));
          break;
        }
        case 'sharedPlanAddOpen':
          this.setModalState({ sharedPlanAddOpen: true, sharedPlanAddError: null });
          break;
        case 'sharedPlanAddClose':
          this.setModalState({ sharedPlanAddOpen: false, sharedPlanAddError: null });
          break;
        case 'sharedPlanAddCloseBackdrop':
          // Only the modal goes away — the plan view stays behind.
          if (e.target === el) this.setModalState({ sharedPlanAddOpen: false, sharedPlanAddError: null });
          break;
        case 'sharedPlanAddSubmit':
          this.submitSharedPlanAdd();
          break;
        case 'sharedPlanRemove': {
          const id = (el.dataset.id || '').trim();
          if (id) {
            this.persistSharedPlans((d) => ({
              plans: (d.plans || []).filter((p) => p && p.id !== id),
              activeId: d.activeId === id ? 'self' : d.activeId,
            }));
          }
          break;
        }
        case 'sharedPlanRetry': {
          // Drop the cached week (ready or not) — the re-render refetches it.
          const plan = this.activeSharedPlan;
          if (plan) {
            if (!this._sharedCache) this._sharedCache = {};
            delete this._sharedCache[this.sharedWeekKey(plan, this.state.planWeekOffset)];
          }
          this.render();
          break;
        }
        case 'sharedOwnLinkShow':
          this.showSharedOwnLink();
          break;
        case 'planExportPdf':
          // From the export picker: the modal must be gone from the DOM
          // before window.print() — the print stylesheet isolates the plan
          // card, and an open modal would print as garbage. setModalState
          // patches the DOM synchronously, so close-then-export in one
          // handler is enough.
          this.setModalState({ planExportOpen: false });
          this.exportPlanPdf();
          break;
        case 'planExportPng':
          this.setModalState({ planExportOpen: false });
          this.exportPlanPng();
          break;
        case 'planExportIcs':
          this.setModalState({ planExportOpen: false });
          this.exportPlanIcs();
          break;
        case 'openPlanExport':
          this.setModalState({ planExportOpen: true });
          break;
        case 'closePlanExport':
          this.setModalState({ planExportOpen: false });
          break;
        case 'planSessionDetails': {
          const idx = parseInt(el.dataset.idx || '-1', 10);
          const sess = this.planVisibleSessions()[idx];
          if (sess) {
            this.setModalState({ planSessionModal: sess });
            // Foreign sessions have no own-group roster behind them (and
            // must never match one by subject+type+nr) — details only.
            if (!sess.foreign) {
              this.ensureParticipantsResult(() => {
                if (!this.patchPlanRosterCell()) this.setModalState({});
              });
            }
          }
          break;
        }
        case 'closePlanSessionModal':
          this.setModalState({ planSessionModal: null });
          break;
        case 'openPlanGroupList': {
          this.setModalState({ planGroupList: this.state.planSessionModal });
          // Participants are normally fetched on Studenci entry — from the
          // plan modal they may not be loaded yet, so pull them lazily
          // (same fetch + guard as retryStudenciLoad, re-rendering only
          // the modal root when they land).
          this.ensureParticipantsResult(() => this.setModalState({}));
          break;
        }
        case 'closePlanGroupList':
          this.setModalState({ planGroupList: null });
          break;
        case 'closePlanGroupListBackdrop':
          // Only the list goes away — the session details stay open behind.
          if (e.target === el) this.setModalState({ planGroupList: null });
          break;
        case 'katalogPrzedmiotyLoadMore':
          this.loadMoreKatalogPrzedmioty();
          break;
        case 'katalogKierunkiLoadMore':
          this.loadMoreKatalogKierunki();
          break;
        case 'katalogPrzedmiotyToggleCurrent':
          this.setState((s) => ({ katalogPrzedmiotyCurrentOnly: !s.katalogPrzedmiotyCurrentOnly }));
          break;
        case 'searchOpenSubject':
          this.state.searchQuery = '';
          this.state.searchResults = null;
          this.openSubjectPage(el.dataset.url);
          break;
        case 'searchOpenUnit':
          this.state.searchQuery = '';
          this.state.searchResults = null;
          this.openCatalogPage('unit', el.dataset.kod);
          break;
        case 'searchOpenProgram':
          this.state.searchQuery = '';
          this.state.searchResults = null;
          this.openCatalogPage('program', el.dataset.kod);
          break;
        case 'openStage':
          this.openStagePage(el.dataset.prgKod, el.dataset.etpKod, el.dataset.label);
          break;
        case 'unitMapGoToBuilding':
          this.unitMapGoToBuilding(el.dataset.kod);
          break;
        case 'openMapaFocused':
          this.openMapaFocused(el.dataset.kod);
          break;
        case 'planSessionOpenMapa': {
          // Escape hatch from the building map modal: both modals must
          // close first — openMapaFocused's navigate() keeps modal state,
          // which would otherwise leave the stack over the Mapa view.
          const kod = el.dataset.kod || '';
          this.setModalState({ planSessionModal: null, planGroupList: null, planBuildingMap: null });
          if (kod) this.openMapaFocused(kod);
          break;
        }
        case 'openPlanBuildingMap': {
          if (this.state.planSessionModal) {
            this.setModalState({ planBuildingMap: this.state.planSessionModal });
            // Warm the campus list on demand (same lazy idea as the roster
            // behind "Zobacz listę") — repaints just the modal when it lands.
            this.ensureSessionMapaData();
          }
          break;
        }
        case 'closePlanBuildingMap':
          this.setModalState({ planBuildingMap: null });
          break;
        case 'closePlanBuildingMapBackdrop':
          // Only the map goes away — the session details stay open behind.
          if (e.target === el) this.setModalState({ planBuildingMap: null });
          break;
        case 'planSessionMapRetry':
          this.retrySessionMapa();
          break;
        case 'mapaSetFilter':
          this.setMapaFilter(el.dataset.unit || '');
          break;
        case 'studenciToggleSubject':
          this.toggleStudenciSubject(el.dataset.subject || '');
          break;
        case 'studenciToggleLectures':
          this.toggleStudenciLectures();
          break;
        case 'studenciClearFilters':
          this.clearStudenciFilters();
          break;
        case 'studenciRetryLoad':
          this.retryStudenciLoad();
          break;
        case 'planRetryDetails':
          this.ensurePlanDetails();
          break;
        case 'mapaRefresh':
          this.mapaRefresh();
          break;
        case 'mapaGoToBuilding':
          this.mapaGoToBuilding(el.dataset.kod);
          break;
        case 'openPaymentDetails':
          this.openPaymentDetails(el.dataset.url);
          break;
        case 'closePaymentDetails':
          this.closePaymentDetails();
          break;
        case 'openGroupsModal':
          this.openGroupsModal(el.dataset.url, el.dataset.title);
          break;
        case 'closeGroupsModal':
          this.closeGroupsModal();
          break;
        case 'openLinksModal': {
          let links = [];
          try { links = JSON.parse(el.dataset.links || '[]'); } catch (err) { links = []; }
          this.openLinksModal(links, el.dataset.title);
          break;
        }
        case 'closeLinksModal':
          this.closeLinksModal();
          break;
        case 'closeModalBackdrop':
          // Only when the backdrop itself was clicked, not something
          // inside the modal card that happens to bubble up to it.
          if (e.target === el) this.closeAnyModal();
          break;
        case 'plannerToggleSubject':
          this.plannerToggleSubject(el.dataset.url);
          break;
        case 'plannerFocusSubject':
          this.plannerFocusSubject(el.dataset.url || '');
          break;
        case 'plannerFocusPreview': {
          // Canonicalize before comparing: the block may carry a stale
          // `callback=` token while the list holds a fresh one — without
          // this, an already-expanded subject collapses instead of just
          // scrolling (and a collapsed one never matches its row).
          const url = this.plannerCanonicalSubjectUrl(el.dataset.url || '');
          const key = el.dataset.key || '';
          if (url && this.state.plannerExpandedUrl !== url) this.plannerToggleSubject(url);
          else this.plannerFocusSubject(url);
          this.plannerTogglePreviewForKey(key, !!this.state.plannerZapisyMode);
          break;
        }
        case 'plannerRevertDraft':
          this.plannerRevertDraft(el.dataset.key || '');
          break;
        case 'plannerLoadGroups':
          this.plannerLoadGroups(el.dataset.url);
          break;
        case 'plannerTogglePreview':
          this.plannerTogglePreview(el.dataset.key, el.dataset.groupsUrl, el.dataset.classTypeLabel);
          break;
        case 'plannerSelectGroup':
          this.plannerSelectGroup(el.dataset.key, el.dataset.groupsUrl, el.dataset.nr, el.dataset.classTypeLabel);
          break;
        case 'plannerAddSubject':
          this.plannerAddSubject(el.dataset.url, el.dataset.subjectName, el.dataset.cycleName);
          break;
        case 'plannerRemovePick':
          this.plannerRemovePick(el.dataset.key);
          break;
        case 'plannerSwitchPlan':
          this.plannerSwitchPlan(el.dataset.id);
          break;
        case 'plannerNewPlan':
          this.plannerNewPlan();
          break;
        case 'plannerDuplicatePlan':
          this.plannerDuplicatePlan(el.dataset.id || null);
          break;
        case 'plannerDeletePlan': {
          // Two-click confirm: first click arms ("Usuń?" → Potwierdź),
          // second fires. Anything switching plans disarms (see
          // applyPlannerSwitchResult).
          const id = el.dataset.id || this.state.plannerActivePlanId;
          if (this.state.plannerConfirmDeleteId !== id) {
            this.setPlannerState({ plannerConfirmDeleteId: id });
          } else {
            this.setPlannerState({ plannerConfirmDeleteId: null });
            this.plannerDeletePlan(id);
          }
          break;
        }
        case 'plannerCancelDelete':
          this.setPlannerState({ plannerConfirmDeleteId: null });
          break;
        case 'plannerSetMainPlan':
          this.plannerSetMainPlan(el.dataset.id);
          break;
        case 'plannerStartRename':
          this.plannerStartRename(el.dataset.id);
          break;
        case 'plannerCommitRename':
          this.plannerCommitRename(el.dataset.id);
          break;
        case 'plannerCancelRename':
          this.plannerCancelRename();
          break;
        case 'plannerNoop':
          // Swallows clicks that must not trigger an enclosing
          // data-action (e.g. the rename <input> inside a plan tab).
          break;
        case 'plannerToggleCustomSearch':
          this.plannerToggleCustomSearch();
          break;
        case 'plannerSelectSearchSubject':
          this.plannerSelectSearchSubject(el.dataset.url, el.dataset.name);
          break;
        case 'plannerCheckRejSeats':
          this.plannerCheckRejSeats();
          break;
        case 'plannerSubjectEnroll': {
          const nr = el.dataset.nr;
          this.openZapisGrupy({
            tourKey: el.dataset.tour || null,
            subjKod: el.dataset.kod || null,
            title: el.dataset.name || '',
            kod: el.dataset.kod || '',
            cykl: el.dataset.cykl || '',
            groupsUrl: el.dataset.url || '',
            registerUrl: el.dataset.register || '',
            highlightNr: nr === '' ? null : nr,
            // Entered from the planner's "Wybrane przedmioty" — the back
            // link must return to the edited plan, not to an empty tour.
            returnView: 'planer',
          });
          break;
        }
        case 'plannerSetZapisyMode': {
          const zapisy = el.dataset.mode === 'zapisy';
          this.setPlannerState({ plannerZapisyMode: zapisy });
          // Entering Zapisy pulls seat data: first the picks' check (fills
          // the tour-subject cache), then group lists for the remaining
          // candidate subjects so the list filter has full coverage.
          if (zapisy) {
            this.plannerCheckRejSeats().then(() => this.plannerPrefetchCandidateSeats());
          }
          break;
        }
        case 'plannerOpenTourBanner':
          this.plannerOpenTourBanner(parseInt(el.dataset.index || '0', 10));
          break;
        case 'plannerSetMode':
          this.plannerSetMode(el.dataset.mode);
          break;
        case 'plannerAutoToggleSubject':
          this.plannerAutoToggleSubject(el.dataset.url, el.dataset.name);
          break;
        case 'plannerAutoAddBlock':
          this.plannerAutoAddBlock();
          break;
        case 'plannerAutoRemoveBlock':
          this.plannerAutoRemoveBlock(parseInt(el.dataset.index, 10));
          break;
        case 'plannerAutoToggleMinimizeGaps':
          this.setPlannerPrefsState((s) => ({ plannerAutoMinimizeGaps: !s.plannerAutoMinimizeGaps }));
          break;
        case 'plannerAutoToggleOnlyFreeSeats':
          this.setPlannerPrefsState((s) => ({ plannerAutoOnlyFreeSeats: !s.plannerAutoOnlyFreeSeats }));
          break;
        case 'plannerAutoGenerate':
          this.plannerAutoGenerate();
          break;
        case 'plannerUseGeneratedCandidate':
          this.plannerUseGeneratedCandidate(parseInt(el.dataset.index, 10));
          break;
        case 'plannerAutoSelectCandidate':
          this.setPlannerState({ plannerAutoActiveCandidateIndex: parseInt(el.dataset.index, 10) });
          break;
        default:
          break;
      }
    }

    // (Candidate hover-preview retired with the side-by-side lanes —
    // every group has its own directly-clickable box now.)

    // The "szczegóły" link on a payment/due row points at a page classic
    // USOS renders itself — opening it in a new tab used to just mount
    // USOS++ there too and hide the real content, so instead we fetch and
    // parse that same URL ourselves and show it in our own modal.
    openPaymentDetails(url) {
      if (!url || !isSafeOpenUrl(url)) return;
      this.setModalState({ paymentDetailsOpen: true, paymentDetailsLoading: true, paymentDetailsError: false, paymentDetailsData: null });
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setModalState({ paymentDetailsLoading: false, paymentDetailsError: true });
        return;
      }
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const details = doc && adapter ? adapter.getPaymentDetails(doc) : null;
          if (!details || !details.supported) {
            this.setModalState({ paymentDetailsLoading: false, paymentDetailsError: true });
          } else {
            this.setModalState({ paymentDetailsLoading: false, paymentDetailsData: details });
          }
        })
        .catch(() => {
          this.setModalState({ paymentDetailsLoading: false, paymentDetailsError: true });
        });
    }

    closePaymentDetails() {
      this.setModalState({ paymentDetailsOpen: false });
    }

    renderPaymentDetailsModal() {
      if (!this.state.paymentDetailsOpen) return '';
      const s = this.state;
      return `
        <div class="usospp-modal-backdrop" data-action="closeModalBackdrop">
          <div class="usospp-modal">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">Szczegóły</div>
              <button class="usospp-icon-btn" data-action="closePaymentDetails" title="Zamknij">${icon('close', 15)}</button>
            </div>
            ${s.paymentDetailsLoading ? `
              <div class="usospp-empty-hint">Wczytywanie…</div>
            ` : s.paymentDetailsError ? `
              <div class="usospp-empty-hint">Nie udało się wczytać szczegółów z USOS.</div>
            ` : `
              ${(s.paymentDetailsData.generalInfo || []).length ? `
                <div class="usospp-field-stack" style="margin-bottom:16px;">
                  ${s.paymentDetailsData.generalInfo.map((f) => `
                    <div class="usospp-list-row">
                      <div style="color:var(--ink-3);font-size:13px;">${esc(f.label)}</div>
                      <div style="font-weight:600;font-size:13px;text-align:right;">${esc(f.value || '—')}</div>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
              ${(s.paymentDetailsData.tables || []).map((t) => `
                <div style="margin-bottom:10px;">
                  ${t.title ? `<div style="font-size:12px;font-weight:600;color:var(--ink-3);margin-bottom:6px;">${esc(t.title)}</div>` : ''}
                  <table class="usospp-table">
                    ${t.headers.length ? `<thead><tr>${t.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : ''}
                    <tbody>
                      ${t.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}
                    </tbody>
                  </table>
                  ${t.footer ? `<div style="font-size:12.5px;font-weight:600;text-align:right;margin-top:6px;">${esc(t.footer)}</div>` : ''}
                </div>
              `).join('')}
            `}
          </div>
        </div>
      `;
    }

    // The "grupy →" link on a subject's class type used to bounce out to
    // classic USOS (and, like the payment "szczegóły" link before it, would
    // just mount USOS++ there too and hide what it actually opened). Same
    // fetch+parse-ourselves fix, reusing the getClassGroups adapter method
    // the planner already relies on — just shown in a modal instead of
    // expanded inline, since a subject page isn't already mid-selection the
    // way the planner is.
    openGroupsModal(url, title) {
      if (!url) return;
      this.setModalState({
        groupsModalOpen: true,
        groupsModalLoading: true,
        groupsModalError: false,
        groupsModalData: null,
        groupsModalTitle: title || 'Grupy zajęciowe',
      });
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setModalState({ groupsModalLoading: false, groupsModalError: true });
        return;
      }
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const data = doc && adapter ? adapter.getClassGroups(doc) : null;
          if (!data || !data.supported) {
            this.setModalState({ groupsModalLoading: false, groupsModalError: true });
          } else {
            this.setModalState({ groupsModalLoading: false, groupsModalData: data });
          }
        })
        .catch(() => {
          this.setModalState({ groupsModalLoading: false, groupsModalError: true });
        });
    }

    closeGroupsModal() {
      this.setModalState({ groupsModalOpen: false });
    }

    renderGroupsModal() {
      if (!this.state.groupsModalOpen) return '';
      const s = this.state;
      const data = s.groupsModalData;
      return `
        <div class="usospp-modal-backdrop" data-action="closeModalBackdrop">
          <div class="usospp-modal usospp-modal-wide">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">${esc(s.groupsModalTitle)}</div>
              <button class="usospp-icon-btn" data-action="closeGroupsModal" title="Zamknij">${icon('close', 15)}</button>
            </div>
            ${s.groupsModalLoading ? `
              <div class="usospp-empty-hint">Wczytywanie…</div>
            ` : s.groupsModalError || !data ? `
              <div class="usospp-empty-hint">Nie udało się wczytać grup.</div>
            ` : data.groups.length === 0 ? `
              <div class="usospp-empty-hint">Brak zdefiniowanych grup.</div>
            ` : `
              <table class="usospp-table">
                <thead><tr><th>Grupa</th><th>Terminy</th><th>Nauczyciel</th><th>Miejsca</th></tr></thead>
                <tbody>
                  ${data.groups.map((g) => `
                    <tr>
                      <td>${esc(g.nr)}</td>
                      <td>${g.sessions.map((sess) => `${esc(sess.day)} ${esc(sess.start)}–${esc(sess.end)}${weeksLabel(sess.weeks) ? ` (${weeksLabel(sess.weeks)})` : ''}${sess.place ? `, ${esc(sess.place)}` : ''}`).join('<br>') || '—'}</td>
                      <td>${esc(g.teacher || '—')}</td>
                      <td>${esc(g.occupancy || '—')}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `}
          </div>
        </div>
      `;
    }

    // A field like "Grupy:" can hold several links squashed into one table
    // cell (see adapter.fieldsFromTable's `links` array) — rather than
    // guessing which one the user wants, this lets them pick. The chosen
    // link still just opens in classic USOS: that destination page's own
    // HTML is malformed (mismatched <table> tags, verified live), so it's
    // not something worth writing our own parser against.
    openLinksModal(links, title) {
      this.setModalState({ linksModalOpen: true, linksModalLinks: links || [], linksModalTitle: title || '' });
    }

    closeLinksModal() {
      this.setModalState({ linksModalOpen: false });
    }

    renderLinksModal() {
      if (!this.state.linksModalOpen) return '';
      const s = this.state;
      return `
        <div class="usospp-modal-backdrop" data-action="closeModalBackdrop">
          <div class="usospp-modal">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">${esc(s.linksModalTitle)}</div>
              <button class="usospp-icon-btn" data-action="closeLinksModal" title="Zamknij">${icon('close', 15)}</button>
            </div>
            ${s.linksModalLinks.length === 0 ? `
              <div class="usospp-empty-hint">Brak opcji.</div>
            ` : s.linksModalLinks.map((l) => `
              <div class="usospp-dropdown-item" data-action="openUsos" data-url="${esc(l.href)}">${esc(l.label)}</div>
            `).join('')}
          </div>
        </div>
      `;
    }

    planDayName(day) {
      return { PN: 'Poniedziałek', WT: 'Wtorek', 'ŚR': 'Środa', CZ: 'Czwartek', PT: 'Piątek', SO: 'Sobota', ND: 'Niedziela' }[day] || day;
    }

    // Full details of one weekly-plan session (click a grid block or list
    // row). Everything shown here already lives in weeklyPlan — the modal
    // just gives short blocks a readable home for all of it.
    renderPlanSessionModal() {
      const s = this.state.planSessionModal;
      if (!s) return '';
      // Concrete-scope sessions carry a real ISO date (Dynamiczny) — show
      // it instead of a parity tag, which would wrongly read "każdy
      // tydzień" for e.g. a biweekly group's meeting. Template sessions
      // (Ogólny) have no date, so the parity text stays.
      const when = s.date && /^\d{4}-\d{2}-\d{2}$/.test(s.date)
        ? s.date.split('-').reverse().join('.')
        : (s.weeks === 'even' ? 'tydzień parzysty (P)' : s.weeks === 'odd' ? 'tydzień nieparzysty (N)' : s.weeks === 'unknown' ? 'co drugi tydzień' : 'każdy tydzień');
      const roomLine = this.planRoomLine(s);
      const groupUrl = s.detailsUrl
        ? (s.detailsUrl.includes('?') ? `${s.detailsUrl}&usospp_off=1` : `${s.detailsUrl}?usospp_off=1`)
        : null;
      return `
        <div class="usospp-modal-backdrop" data-action="closeModalBackdrop">
          <div class="usospp-modal">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">${esc(s.subject)}</div>
              <button class="usospp-icon-btn" data-action="closePlanSessionModal" title="Zamknij">${icon('close', 15)}</button>
            </div>
            <table class="usospp-table"><tbody>
              <tr><td>Termin</td><td><strong>${esc(this.planDayName(s.day))} ${esc(s.start)}–${esc(s.end)}</strong> · ${esc(when)}</td></tr>
              <tr><td>Zajęcia</td><td>${esc(s.type || '—')}${s.nr ? `, grupa ${esc(String(s.nr))}` : ''}${s.code ? ` <span class="usospp-muted-text">[${esc(s.code)}]</span>` : ''}</td></tr>
              <tr><td>Sala</td><td>${roomLine ? esc(roomLine) : '—'}</td></tr>
              ${s.building ? `<tr><td>Budynek</td><td>${esc(s.building)} <a data-action="openPlanBuildingMap" style="font-weight:600;cursor:pointer;">Zobacz na mapie →</a></td></tr>` : ''}
              <tr><td>Prowadzący</td><td>${s.teacher ? esc(s.teacher) : '<span class="usospp-muted-text">brak danych w USOS</span>'}</td></tr>
              ${this.planSessionRosterRow(s)}
            </tbody></table>
            ${groupUrl ? `<div style="margin-top:12px;"><button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(groupUrl)}">Otwórz grupę w USOS →</button></div>` : ''}
          </div>
        </div>
      `;
    }

    // Matches a plan session's building string (e.g. "Gmach - Nowy
    // Elektryczny [D-1]") against the campus building list. Primary key is
    // the bracketed code via buildingCode() compared case-insensitively to
    // bud_kod; fallback is a name-contains match for strings without a
    // bracket. Returns {kod, building} (building null when the kod is known
    // but not on the mappable list) or null when there is nothing to match.
    sessionBuildingMatch(s) {
      if (!s || !s.building) return null;
      const norm = (v) => String(v || '').trim().toLowerCase();
      const list = Array.isArray(this.state.mapaBuildings) ? this.state.mapaBuildings : [];
      const rawKod = buildingCode(s.building);
      if (rawKod) {
        const hit = list.find((b) => b && b.kod && norm(b.kod) === norm(rawKod));
        if (hit) return { kod: hit.kod, building: hit };
        return { kod: rawKod, building: null };
      }
      const base = String(s.building).replace(/\s+/g, ' ').trim().toLowerCase();
      if (!base) return null;
      const hit = list.find((b) => b && b.name && (base.includes(b.name.toLowerCase()) || b.name.toLowerCase().includes(base)));
      if (hit) return { kod: hit.kod, building: hit };
      return null;
    }

    // Separate "building on map" modal, opened from the session modal's
    // Budynek row ("Zobacz na mapie →") — the same two-modal pattern as
    // the Studenci roster (row + "Zobacz listę →" opens the planGroupList
    // modal behind which the session details stay open).
    renderPlanBuildingMapModal() {
      const s = this.state.planBuildingMap;
      if (!s) return '';
      const match = this.sessionBuildingMatch(s);
      const kod = match && match.kod;
      let body;
      if (this.state.mapaError) {
        body = `
          <div class="usospp-empty-hint">Nie udało się wczytać mapy budynków.</div>
          <div style="margin-top:10px;"><a data-action="planSessionMapRetry" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div>`;
      } else if (!this.state.mapaBuildings.length) {
        body = `
          <div class="usospp-empty-hint">Wczytywanie mapy…</div>
          <div class="usospp-map-container" data-session-map style="height:320px;border-radius:12px;overflow:hidden;margin-top:12px;"></div>`;
      } else if (!match || !match.building) {
        body = `<div class="usospp-empty-hint">Tego budynku nie ma na mapie kampusu.</div>`;
      } else {
        body = `<div class="usospp-map-container" data-session-map style="height:320px;border-radius:12px;overflow:hidden;"></div>`;
      }
      const title = s.building ? `Budynek — ${s.building}` : 'Budynek na mapie';
      return `
        <div class="usospp-modal-backdrop" data-action="closePlanBuildingMapBackdrop">
          <div class="usospp-modal">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">${esc(title)}</div>
              <button class="usospp-icon-btn" data-action="closePlanBuildingMap" title="Zamknij">${icon('close', 15)}</button>
            </div>
            ${body}
            ${kod ? `<div style="margin-top:12px;"><a data-action="planSessionOpenMapa" data-kod="${esc(kod)}" style="font-size:12px;font-weight:600;color:#d9773a;cursor:pointer;">Zobacz na pełnej mapie →</a></div>` : ''}
          </div>
        </div>
      `;
    }

    // Mounts the single-marker preview rendered by
    // renderPlanBuildingMapModal. Same teardown-before-remount discipline
    // as mountMapaIfNeeded/mountUnitMapPreview: render() replaces the modal
    // DOM on every call, so a previous instance would be stranded on a
    // detached node. Called from render(), setModalState() and destroy().
    mountSessionMapPreview() {
      if (this._sessionMap) { this._sessionMap.remove(); this._sessionMap = null; }
      const s = this.state.planBuildingMap;
      if (!s) return;
      const container = this.root.querySelector('[data-session-map]');
      if (!container) return;
      const match = this.sessionBuildingMatch(s);
      if (!match || !match.building) return;
      if (!window.L) {
        const loader = window.USOSPP_LEAFLET;
        if (loader && !this._leafletLoading) {
          this._leafletLoading = true;
          loader.ensureLeaflet().then(() => {
            this._leafletLoading = false;
            this.mountSessionMapPreview();
          }).catch(() => { this._leafletLoading = false; });
        }
        return;
      }
      const b = match.building;
      const map = window.L.map(container, { center: [b.lat, b.lng], zoom: 17, scrollWheelZoom: false });
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      const marker = window.L.marker([b.lat, b.lng], { icon: this.mapaMarkerIcon() })
        .bindPopup(`<b>${esc(b.name)}</b>${b.address ? `<br>${esc(b.address)}` : ''}`);
      marker.addTo(map).openPopup();
      try { map.invalidateSize(); } catch (e) { /* cosmetic only */ }
      this._sessionMap = map;
    }

    // Warms the campus building list when the building map modal opens
    // (idempotent via ensureMapaData + cache) and repaints just the
    // modal root when the data lands, so the preview appears without a full
    // render. Fire-and-forget from the openPlanBuildingMap action.
    async ensureSessionMapaData() {
      if (this.state.mapaBuildings.length) {
        if (this.state.planBuildingMap) this.setModalState({});
        return;
      }
      if (this.state.mapaLoading || this.state.mapaError) return;
      await this.ensureMapaData();
      if (this.state.planBuildingMap) this.setModalState({});
    }

    // Modal-scoped retry: same cache-busting fetch as mapaRefresh, but
    // repaints only the modal root (a full render() would be fine too, yet
    // the modal-scoped patch avoids replaying the view fade underneath).
    async retrySessionMapa() {
      const cacheKey = 'usospp:campusBuildings:' + location.origin;
      try { await chrome.storage.local.remove(cacheKey); } catch (e) { /* ignore */ }
      this.state.mapaBuildings = [];
      this.state.mapaLoading = true;
      this.state.mapaError = false;
      this.setModalState({});
      await this.fetchMapaData(cacheKey);
      if (this.state.planBuildingMap) this.setModalState({});
    }

    // Export picker popup over the plan view: one "Eksportuj plan" button
    // opens this short wide modal with the three formats side by side,
    // instead of three competing buttons in the toolbar. PNG/PDF export
    // what's on screen; Kalendarz exports the whole semester as .ics
    // (concrete scope only — the generic template has no real dates).
    // Tiles reuse the existing planExport* actions, which close this modal
    // first (see their cases — PDF must print without a modal in the DOM).
    renderPlanExportModal() {
      if (!this.state.planExportOpen) return '';
      const scope = this.state.planScope === 'generic' ? 'generic' : 'concrete';
      const loading = !!this.state.planDetailsLoading;
      const calDisabled = scope === 'generic' || loading;
      const calTitle = scope === 'generic'
        ? 'Eksport kalendarza wymaga trybu Dynamicznego (prawdziwe daty)'
        : loading ? 'Dociąganie sal i prowadzących…' : 'Pobierz cały semestr jako plik do kalendarza';
      const tile = (action, title, desc, tip, disabled) => `
        <button class="usospp-btn-ghost" data-action="${action}" title="${tip}" ${disabled ? 'disabled style="opacity:.4;"' : ''} style="display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:14px;text-align:left;flex:1;min-width:0;">
          <span style="font-weight:700;font-size:14px;">${title}</span>
          <span class="usospp-muted-text" style="font-size:12px;font-weight:400;">${desc}</span>
        </button>`;
      return `
        <div class="usospp-modal-backdrop" data-action="closeModalBackdrop">
          <div class="usospp-modal usospp-modal-wide">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">Eksportuj plan</div>
              <button class="usospp-icon-btn" data-action="closePlanExport" title="Zamknij">${icon('close', 15)}</button>
            </div>
            <div style="display:flex;gap:10px;align-items:stretch;flex-wrap:wrap;">
              ${tile('planExportPng', 'PNG', 'Obraz tego, co widać — do wysłania i wydruku', 'Pobierz obraz planu (PNG)')}
              ${tile('planExportPdf', 'PDF', 'Dokument na jedną stronę A4', 'Drukuj / zapisz jako PDF')}
              ${tile('planExportIcs', 'Kalendarz', 'Plik do kalendarza (Google, Apple, Outlook) — cały semestr', calTitle, calDisabled)}
            </div>
            <div class="usospp-muted-text" style="font-size:12px;margin-top:12px;">Kalendarz importuj do <strong>osobnego kalendarza</strong> — łatwo cofnąć.</div>
          </div>
        </div>
      `;
    }

    // Roster of the exact group behind a plan session: by detailsUrl first,
    // same subject+type+nr fallback. {state, students}: 'loading' (not
    // fetched yet), 'ready', 'hidden' (USOS doesn't share the list),
    // 'missing' (no matching group).
    // Single lazy trigger for the participants roster (Studenci entry,
    // plan session modal, group list modal, autorefresh recovery):
    // fetchParticipantsResult mutates this.data in place and has no
    // in-flight guard of its own, so this serializes triggers behind
    // _participantsLoading. Returns true when the roster is already
    // available; otherwise kicks off at most one fetch and runs onReady
    // when it lands (callers repaint only their own surface there).
    ensureParticipantsResult(onReady) {
      if (this.data && this.data.participantsResultLoaded) return true;
      if (this._participantsLoading) return false;
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const adapter = adapters && adapters.selectAdapter ? adapters.selectAdapter() : null;
      if (!scrape || !scrape.fetchParticipantsResult || !adapter || !this.data) return false;
      this._participantsLoading = true;
      scrape.fetchParticipantsResult(adapter, this.data).then(() => {
        this._participantsLoading = false;
        if (onReady) onReady();
      }).catch(() => { this._participantsLoading = false; });
      return false;
    }
    planSessionRoster(s) {
      if (!this.data || !this.data.participantsResultLoaded) return { state: 'loading', students: [] };
      const res = this.data.participantsResult || {};
      const groups = Array.isArray(res.groups) ? res.groups : [];
      const group = (s && s.detailsUrl && res.byUrl && res.byUrl[s.detailsUrl])
        || (s && groups.find((g) => g && g.subject === s.subject && g.type === s.type && String(g.nr) === String(s.nr)))
        || null;
      if (!group) return { state: 'missing', students: [] };
      if (group.hidden || !group.supported) return { state: 'hidden', students: [] };
      return { state: 'ready', students: Array.isArray(group.students) ? group.students : [] };
    }

    // Roster rows for the list modal: "Imię Nazwisko" + isSelf, alphabetical (pl).
    planSessionRosterRows(s) {
      const { students } = this.planSessionRoster(s);
      const rawSelf = this.data && this.data.user && this.data.user.name;
      const selfName = rawSelf ? String(rawSelf).replace(/\s+/g, ' ').trim().toLowerCase() : null;
      return students
        .map((st) => ({
          display: `${(st.names || '').trim()} ${(st.surname || '').trim()}`.trim(),
          isSelf: !!selfName && this.studentKey(st.surname, st.names) === selfName,
        }))
        .filter((r) => r.display)
        .sort((a, b) => a.display.localeCompare(b.display, 'pl'));
    }

    planSessionRosterRow(s) {
      // No roster for somebody-else's sessions: there is no own-group list
      // behind them, and the subject+type+nr fallback in planSessionRoster
      // could match one of MY groups with a misleading student list.
      if (s && s.foreign) return '';
      return `<tr><td>Studenci</td><td data-plan-roster-cell>${this.planSessionRosterCellHtml(s)}</td></tr>`;
    }
    planSessionRosterCellHtml(s) {
      const r = this.planSessionRoster(s);
      if (r.state === 'ready') {
        const n = r.students.length;
        return `<strong>${n} ${pluralOsoba(n)}</strong> <a data-action="openPlanGroupList" style="font-weight:600;cursor:pointer;">Zobacz listę →</a>`;
      }
      if (r.state === 'loading') {
        return `<span class="usospp-muted-text">…</span> <a data-action="openPlanGroupList" style="font-weight:600;cursor:pointer;">Zobacz listę →</a>`;
      }
      return `<span class="usospp-muted-text">lista niedostępna</span>`;
    }
    // Targeted repaint of just the roster cell when the lazy roster lands
    // while session details are open — no full modal rebuild, so the popup
    // doesn't flicker. Returns false when there's nothing to patch
    // (modal closed/rebuilt meanwhile), letting the caller fall back.
    patchPlanRosterCell() {
      const s = this.state.planSessionModal;
      const root = this.root && this.root.querySelector('[data-modal-root]');
      const cell = root && root.querySelector('[data-plan-roster-cell]');
      if (!s || !cell) return false;
      cell.innerHTML = this.planSessionRosterCellHtml(s);
      return true;
    }

    renderPlanGroupListModal() {
      const s = this.state.planGroupList;
      if (!s) return '';
      const r = this.planSessionRoster(s);
      const title = `Studenci — ${s.subject}${s.type ? `, ${s.type}` : ''}${s.nr ? `, grupa ${s.nr}` : ''}`;
      let body;
      if (r.state === 'ready') {
        const rows = this.planSessionRosterRows(s);
        body = rows.length
          ? rows.map((p) => `<div class="usospp-list-row"><div style="font-weight:600;">${esc(p.display)}${p.isSelf ? ' <span class="usospp-badge">Ty</span>' : ''}</div></div>`).join('')
          : `<div class="usospp-empty-hint">Brak danych.</div>`;
      } else if (r.state === 'loading') {
        body = `<div class="usospp-empty-hint">Pobieranie listy…</div>`;
      } else if (r.state === 'hidden') {
        body = `<div class="usospp-empty-hint">USOS nie udostępnia listy studentów tej grupy.</div>`;
      } else {
        body = `<div class="usospp-empty-hint">Nie znaleziono listy tej grupy.</div>`;
      }
      return `
        <div class="usospp-modal-backdrop" data-action="closePlanGroupListBackdrop">
          <div class="usospp-modal">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">${esc(title)}</div>
              <button class="usospp-icon-btn" data-action="closePlanGroupList" title="Zamknij">${icon('close', 15)}</button>
            </div>
            ${body}
          </div>
        </div>
      `;
    }

    // Fetches and parses the subject's full catalog page on demand (see
    // adapter.getSubjectPage) and navigates to a real subview showing it,
    // instead of bouncing out to classic USOS. Lazy/per-click rather than
    // prefetched in collectAll, since there can be dozens of subjects listed
    // and only one is ever opened at a time.
    openSubjectPage(url) {
      if (!url) return;
      this.setState((s) => ({
        view: 'subjectPage',
        subjectBackView: s.view === 'subjectPage' ? s.subjectBackView : s.view,
        subjectUrl: url,
        subjectLoading: true,
        subjectError: false,
        subjectData: null,
      }));
      this.persistViewState();
      this.fetchSubjectData(url);
    }

    // Split out of openSubjectPage so a restored session (page reload landing
    // back on a previously open subject via sessionStorage) can re-fetch the
    // same data without re-deriving subjectBackView from a throwaway initial
    // state.
    fetchSubjectData(url) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ subjectLoading: false, subjectError: true });
        return;
      }
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const details = doc && adapter ? adapter.getSubjectPage(doc) : null;
          if (!details || !details.supported) {
            this.setState({ subjectLoading: false, subjectError: true });
          } else {
            this.setState({ subjectLoading: false, subjectData: details });
            this.loadSubjectTimetables(url, details.cycles);
          }
        })
        .catch(() => {
          this.setState({ subjectLoading: false, subjectError: true });
        });
    }

    // Opens a registration tour inside the panel: title/register/plan links
    // come from the Zapisy row, but the subjectsUrl itself is refreshed
    // first (refreshPersonalCalendar — the callback token is per page load,
    // so a stored URL may already be stale) and matched back by rej_kod. The
    // passed URL is only a fallback when the refresh itself fails. Read-only
    // GETs throughout — the enrolment POST (brdg2/zarejestruj) is never
    // called; saving happens in USOSweb via the deep link.
    openZapisTuraFromUrl(url) {
      if (!url) return;
      if (/[?&]method=rej\b/.test(url)) {
        const m = url.match(/[?&]rej_kod=([^&]+)/);
        const key = m ? decodeURIComponent(m[1]) : url;
        const row = this.zapisRounds.find((r) => r.rejKod === key || r.subjectsUrl === url);
        this.openZapisTura({
          key,
          title: (row && row.sectionTitle) || '',
          code: (row && (row.sectionCode || row.rejKod)) || key,
          subjectsUrl: url,
          registerUrl: (row && row.registerUrl) || null,
          planUrls: (row && row.planUrls) || [],
        });
        return;
      }
      const kodMatch1 = url.match(/[?&]jed_org_kod=([^&]+)/);
      const kodMatch2 = url.match(/[?&]kod=([^&]+)/);
      const jedOrgKod = kodMatch1 ? decodeURIComponent(kodMatch1[1])
        : kodMatch2 ? decodeURIComponent(kodMatch2[1]) : null;
      if (jedOrgKod) {
        this.setState({ view: 'katalogPrzedmioty', katalogPrzedmiotyUnitKod: jedOrgKod });
      } else {
        safeOpenUrl(url);
      }
    }

    openZapisTura(meta) {
      this.setState({
        view: 'zapisTura',
        zapisTuraKey: meta.key || null,
        zapisTuraTitle: meta.title || '',
        zapisTuraCode: meta.code || '',
        zapisTuraSubjectsUrl: meta.subjectsUrl || '',
        zapisTuraRegisterUrl: meta.registerUrl || '',
        zapisTuraPlanUrls: Array.isArray(meta.planUrls) ? meta.planUrls : [],
        zapisTuraSubjects: [],
        zapisTuraLoading: true,
        zapisTuraError: false,
      });
      this.persistViewState();
      this.fetchZapisTura(meta);
    }

    fetchZapisTura(meta) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ zapisTuraLoading: false, zapisTuraError: true });
        return;
      }
      const adapter = adapters.selectAdapter();
      const keyM = (meta.subjectsUrl || '').match(/[?&]rej_kod=([^&]+)/);
      const rejKod = keyM ? decodeURIComponent(keyM[1]) : (meta.key || null);
      // Data arrival repaints content in place (no navigation fade, no
      // sidebar/topbar rebuild); stale arrivals (navigated away meanwhile)
      // commit silently so a later back-navigation still finds the data.
      const commit = (patch) => {
        if (this.state.view === 'zapisTura') this.setContentState(patch);
        else Object.assign(this.state, patch);
      };
      // One final setState (loading → loaded in a single step): every full
      // render recreates .usospp-view and replays its fade-in, so N
      // setStates read as N page refreshes. Intermediate refresh results
      // only feed the retry URL — they never render on their own.
      const loadFrom = (subjectsUrl, extra) => scrape.fetchRejSubjects(adapter, subjectsUrl)
        .then((res) => {
          if (!res || !res.supported) {
            commit({ zapisTuraLoading: false, zapisTuraError: true, ...extra });
          } else {
            commit({ zapisTuraLoading: false, zapisTuraSubjects: res.subjects || [], ...extra });
          }
        })
        .catch(() => {
          commit({ zapisTuraLoading: false, zapisTuraError: true, ...extra });
        });
      scrape.refreshPersonalCalendar(adapter)
        .then((cal) => {
          const fresh = (cal && Array.isArray(cal.sections) ? cal.sections : [])
            .find((s) => s.code === rejKod || (s.rounds || []).some((r) => r.rejKod === rejKod));
          if (fresh && fresh.subjectsUrl) {
            const freshRound = (fresh.rounds || []).find((r) => r.rejKod === rejKod && r.registerUrl)
              || (fresh.rounds || []).find((r) => r.registerUrl);
            loadFrom(fresh.subjectsUrl, {
              zapisTuraSubjectsUrl: fresh.subjectsUrl,
              ...(freshRound && freshRound.registerUrl ? { zapisTuraRegisterUrl: freshRound.registerUrl } : null),
            });
          } else if (meta.subjectsUrl) {
            loadFrom(meta.subjectsUrl, {});
          } else {
            commit({ zapisTuraLoading: false, zapisTuraError: true });
          }
        })
        .catch(() => {
          if (meta.subjectsUrl) loadFrom(meta.subjectsUrl, {});
          else commit({ zapisTuraLoading: false, zapisTuraError: true });
        });
    }

    // Opens one subject's registration-context groups inside the panel.
    // Freshness chain (all read-only GETs): refresh calendar → find the
    // tour → fresh subjectsUrl → find the subject by kod → fresh groupsUrl
    // → group list. The enrolment POST is never called; saving stays a
    // deep link out of the panel.
    openZapisGrupy(meta) {
      if (!meta || (!meta.groupsUrl && !(meta.tourKey && meta.subjKod))) return;
      this.setState({
        view: 'zapisGrupy',
        zapisGrupyKey: (meta.tourKey || '') + '|' + (meta.subjKod || ''),
        zapisGrupyTourKey: meta.tourKey || null,
        zapisGrupySubjKod: meta.subjKod || null,
        zapisGrupyTitle: meta.title || '',
        zapisGrupyKod: meta.kod || '',
        zapisGrupyCykl: meta.cykl || '',
        zapisGrupyOccupancy: meta.occupancy || null,
        zapisGrupyDetailsUrl: meta.detailsUrl || '',
        zapisGrupyGroupsUrl: meta.groupsUrl || '',
        zapisGrupyRegisterUrl: meta.registerUrl || '',
        zapisGrupySections: [],
        zapisGrupyLoading: true,
        zapisGrupyError: false,
        zapisGrupyMainPlan: null,
        zapisGrupyHighlightNr: meta.highlightNr || null,
        // Where the back link returns: 'planer' when entered from the
        // planner's "Wybrane przedmioty" (plannerSubjectEnroll), otherwise
        // null meaning the tour. Sanitized — only 'planer' is accepted.
        zapisGrupyReturnView: meta.returnView === 'planer' ? 'planer' : null,
      });
      this.fetchZapisGrupy(meta);
    }

    fetchZapisGrupy(meta) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ zapisGrupyLoading: false, zapisGrupyError: true });
        return;
      }
      const adapter = adapters.selectAdapter();
      // Same single-render rule as fetchZapisTura: the freshness chain
      // (calendar → subjects → groups) accumulates fresh URLs/occupancy in
      // locals and commits them in ONE final setState — intermediate
      // setStates would each replay .usospp-view's fade-in.
      // Arrival repaints content in place (see fetchZapisTura's commit).
      const commit = (patch) => {
        if (this.state.view === 'zapisGrupy') this.setContentState(patch);
        else Object.assign(this.state, patch);
      };
      const occPatch = (occ) => (occ ? { zapisGrupyOccupancy: occ } : null);
      const urlPatch = (groupsUrl) => (groupsUrl ? { zapisGrupyGroupsUrl: groupsUrl } : null);
      const loadGroups = (groupsUrl, occ) => {
        if (!groupsUrl) {
          commit({ zapisGrupyLoading: false, zapisGrupyError: true, ...occPatch(occ) });
          return;
        }
        scrape.fetchRejGroups(adapter, groupsUrl)
          .then(async (res) => {
            if (!res || !res.supported) {
              commit({ zapisGrupyLoading: false, zapisGrupyError: true, ...urlPatch(groupsUrl), ...occPatch(occ) });
            } else {
              const sections = Array.isArray(res.sections) ? res.sections : [];
              // Main-plan match rides along in the SAME commit (one render,
              // no column pop-in later) — the store read is local, not USOS.
              let mainPlan = null;
              try { mainPlan = await this.computeZapisMainPlanMatch(sections); } catch (e) { mainPlan = null; }
              commit({ zapisGrupyLoading: false, zapisGrupySections: sections, ...urlPatch(groupsUrl), ...occPatch(occ), ...(mainPlan ? { zapisGrupyMainPlan: mainPlan } : null) });
            }
          })
          .catch(() => {
            commit({ zapisGrupyLoading: false, zapisGrupyError: true, ...urlPatch(groupsUrl), ...occPatch(occ) });
          });
      };
      const tourKey = meta.tourKey;
      const subjKod = meta.subjKod;
      if (!tourKey || !subjKod) {
        loadGroups(meta.groupsUrl, null);
        return;
      }
      scrape.refreshPersonalCalendar(adapter)
        .then((cal) => {
          const section = (cal && Array.isArray(cal.sections) ? cal.sections : [])
            .find((s) => s.code === tourKey || (s.rounds || []).some((r) => r.rejKod === tourKey));
          const subjectsUrl = section ? section.subjectsUrl : null;
          if (!subjectsUrl) {
            loadGroups(meta.groupsUrl, null);
            return;
          }
          scrape.fetchRejSubjects(adapter, subjectsUrl)
            .then((res) => {
              const subj = (res && Array.isArray(res.subjects) ? res.subjects : [])
                .find((x) => x.kod === subjKod);
              const occ = (subj && subj.occupancy) || null;
              if (subj && subj.groupsUrl) loadGroups(subj.groupsUrl, occ);
              else loadGroups(meta.groupsUrl, occ);
            })
            .catch(() => {
              loadGroups(meta.groupsUrl, null);
            });
        })
        .catch(() => {
          loadGroups(meta.groupsUrl, null);
        });
    }

    // Direction B of the Plan × Zapisy bridge: which rows of THIS group
    // list (subject kod = state.zapisGrupyKod) are in the MAIN plan.
    // Returns { planId, planName, rows } where rows maps
    // `${sectionType}||${nr}` -> { sessionMatch } — or null when there is
    // no main-plan pick for this subject (render then shows plain rows).
    async computeZapisMainPlanMatch(sections) {
      const kod = this.state.zapisGrupyKod;
      if (!kod || !Array.isArray(sections) || !sections.length) return null;
      const main = await this.getMainPlanRecord();
      if (!main) return null;
      return this.computeZapisMainPlanMatchFor(sections, kod, main.picks, main.name, main.id);
    }

    // Same row-match as computeZapisMainPlanMatch but over an explicit
    // picks array (kept for callers that already hold picks in hand).
    // NOTE: the pick goes in whole — overriding its classTypeLabel/nr with
    // the row's own values would make every row match itself (that bug
    // once lit 📅 on all rows). matchPickGroups already filters by the
    // pick's own type+nr; here we additionally pin hits to this row's nr.
    async computeZapisMainPlanMatchFor(sections, kod, picks, planName, planId) {
      const bridge = window.USOSPP_ZAPISY_PLAN;
      if (!bridge || !kod) return null;
      const rows = {};
      let count = 0;
      const mine = (picks || []).filter((p) => bridge.przKodFromUrl(p.subjectUrl) === kod);
      if (!mine.length) return null;
      (sections || []).forEach((sec) => {
        (sec.groups || []).forEach((g) => {
          const hits = mine
            .flatMap((p) => bridge.matchPickGroups(p, { sections: [sec] }))
            .filter((h) => String(h.group.nr) === String(g.nr));
          const hit = hits.find((h) => h.sessionMatch) || hits[0];
          if (hit) {
            rows[`${sec.type || ''}||${g.nr}`] = { sessionMatch: !!hit.sessionMatch };
            count += 1;
          }
        });
      });
      if (!count) return null;
      return { planId, planName, rows, count };
    }
    // Opens a "jednostka" or "program" search result in our own page —
    // same shape as openSubjectPage/fetchSubjectData, just generalized over
    // `kind` since both are otherwise identical (fetch, parse, show, with a
    // back-link to wherever the user actually came from).
    openCatalogPage(kind, kod) {
      if (!kod) return;
      this.setState((s) => {
        // Opening catalog page B while catalog page A is showing makes
        // "Wróć" on B step back to A itself — one hop, like every other
        // back link in the app — instead of the OLD behavior of keeping
        // A's own back target (which skipped A entirely and landed back
        // on whatever view preceded the whole catalog chain). The plain
        // view-name link can't express "the wydział I just left", so A's
        // whole rendered state — its loaded subject rows included, which
        // a re-fetch would throw away — is snapshotted here and restored
        // by catalogBack(); catalogBackPrev* keeps {kind, kod} around
        // for the snapshot-less paths (reload, popstate).
        const fromCatalog = s.view === 'catalogPage' && !!s.catalogData
          && (s.catalogKind === 'unit' || s.catalogKind === 'program');
        return {
          view: 'catalogPage',
          catalogBackView: fromCatalog ? 'catalogPage' : (s.view === 'catalogPage' ? s.catalogBackView : s.view),
          catalogBackPrevKind: fromCatalog ? s.catalogKind : null,
          catalogBackPrevKod: fromCatalog ? s.catalogKod : null,
          catalogBackSnapshot: fromCatalog ? {
            kind: s.catalogKind,
            kod: s.catalogKod,
            data: s.catalogData,
            buildings: s.catalogBuildings,
            subjects: s.catalogSubjects,
            subjectsTotal: s.catalogSubjectsTotal,
            subjectsNextUrl: s.catalogSubjectsNextUrl,
            subjectsCurrentOnly: s.catalogSubjectsCurrentOnly,
            subjectsQuery: s.catalogSubjectQuery,
            programs: s.catalogPrograms,
            programsNextUrl: s.catalogProgramsNextUrl,
            backView: s.catalogBackView,
            prevKind: s.catalogBackPrevKind || null,
            prevKod: s.catalogBackPrevKod || null,
          } : null,
          catalogKind: kind,
          catalogKod: kod,
          catalogLoading: true,
          catalogError: false,
          catalogData: null,
          catalogBuildings: [],
        };
      });
      this.persistViewState();
      this.fetchCatalogPage(kind, kod);
    }

    // "← Wróć" on a unit/program page that was opened from another unit/
    // program page. With a live snapshot this is instant — the previous
    // page's data, loaded subject rows, filters and pagination carry over
    // untouched; without one (reload/popstate in between) the page is
    // simply re-opened from its {kind, kod}. Both paths then behave like
    // every other back link: exactly one screen back.
    catalogBack() {
      const s = this.state;
      const kind = s.catalogBackPrevKind;
      const kod = s.catalogBackPrevKod;
      const snap = s.catalogBackSnapshot;
      if (kind !== 'unit' && kind !== 'program') {
        const target = s.catalogBackView && VALID_VIEWS.has(s.catalogBackView) && s.catalogBackView !== 'catalogPage'
          ? s.catalogBackView
          : 'dashboard';
        this.navigate(target);
        return;
      }
      if (!kod) {
        this.navigate('dashboard');
        return;
      }
      if (snap && snap.kind === kind && snap.kod === kod && snap.data) {
        this.setState({
          view: 'catalogPage',
          notifPanelOpen: false,
          avatarMenuOpen: false,
          catalogBackView: snap.backView,
          catalogBackPrevKind: snap.prevKind,
          catalogBackPrevKod: snap.prevKod,
          catalogBackSnapshot: null,
          catalogKind: kind,
          catalogKod: kod,
          catalogEtpKod: null,
          catalogLoading: false,
          catalogError: false,
          catalogData: snap.data,
          catalogBuildings: snap.buildings || [],
          catalogSubjects: snap.subjects || [],
          catalogSubjectsTotal: snap.subjectsTotal || 0,
          catalogSubjectsNextUrl: snap.subjectsNextUrl || null,
          catalogSubjectQuery: snap.subjectsQuery || '',
          catalogSubjectsCurrentOnly: !!snap.subjectsCurrentOnly,
          catalogPrograms: snap.programs || [],
          catalogProgramsNextUrl: snap.programsNextUrl || null,
        });
        this.persistViewState();
      } else {
        this.openCatalogPage(kind, kod);
      }
    }

    // Back link for the unit/program catalog pages — the dedicated one-hop
    // action when this page was opened from another catalog page, the plain
    // view link otherwise.
    catalogBackHeader() {
      const s = this.state;
      if ((s.catalogBackPrevKind === 'unit' || s.catalogBackPrevKind === 'program') && s.catalogBackPrevKod) {
        return `<a data-action="catalogBack" class="usospp-back-link">← Wróć</a>`;
      }
      return backLink(s.catalogBackView || 'dashboard');
    }

    fetchCatalogPage(kind, kod) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ catalogLoading: false, catalogError: true });
        return;
      }
      const url = kind === 'unit' ? scrape.PATHS.unitDetail(kod) : scrape.PATHS.programDetail(kod);
      // The unit page also shows supplementary sections that each fetch on
      // their own (subjects the unit offers — see adapter.getUnitSubjects —
      // and its study programmes): they reset here so a re-fetch (opening
      // another unit, a popstate back into this page) never shows the
      // previous unit's rows, and they never turn the page into an error
      // view when their request fails — the sections just stay hidden.
      if (kind === 'unit') {
        this.setState({
          catalogBuildings: [],
          catalogSubjects: [],
          catalogSubjectsTotal: 0,
          catalogSubjectsNextUrl: null,
          catalogSubjectsLoading: true,
          catalogSubjectQuery: '',
          catalogSubjectsCurrentOnly: false,
          catalogPrograms: [],
          catalogProgramsNextUrl: null,
          catalogProgramsLoading: true,
        });
      }
      // A unit page also shows its own "Budynki jednostki" list (see
      // renderUnitPage) — one cheap request tacked on in parallel, not
      // gated behind the main detail fetch succeeding, and never turns this
      // into an error page on its own (buildings are supplementary here,
      // unlike on the dedicated "Mapa" view).
      const buildingsPromise = kind === 'unit' ? scrape.fetchDoc(scrape.PATHS.buildingsForUnit(kod)) : Promise.resolve(null);
      Promise.all([scrape.fetchDoc(url), buildingsPromise])
        .then(([doc, buildingsDoc]) => {
          const adapter = adapters.selectAdapter();
          const details = doc && adapter
            ? (kind === 'unit' ? adapter.getUnitDetail(doc) : adapter.getProgramDetail(doc))
            : null;
          const buildingsResult = kind === 'unit' && buildingsDoc && adapter ? adapter.getBuildingsForUnit(buildingsDoc) : null;
          if (!details || !details.supported) {
            this.setState({ catalogLoading: false, catalogError: true });
          } else {
            this.setState({
              catalogLoading: false,
              catalogData: details,
              catalogBuildings: (buildingsResult && buildingsResult.supported) ? buildingsResult.buildings : [],
            });
          }
        })
        .catch(() => {
          this.setState({ catalogLoading: false, catalogError: true });
        });

      if (kind !== 'unit') return;
      // Section fetches below never block the card above. The subject
      // listing's nav-bar next-page-url points at 30-row pages (the classic
      // UI default) — its limit segment is swapped for 300, a page size the
      // classic UI itself offers (verified live), so "Wczytaj więcej" walks
      // a 3500-row wydział in a handful of requests.
      const stillOnPage = () => this.state.view === 'catalogPage' && this.state.catalogKind === 'unit' && this.state.catalogKod === kod;
      scrape.fetchDoc(scrape.PATHS.unitSubjects(kod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitSubjects(doc) : null;
          if (!stillOnPage()) return;
          this.setCatalogSubjectsSectionState({
            catalogSubjects: res ? res.subjects : [],
            catalogSubjectsTotal: res ? res.total : 0,
            catalogSubjectsNextUrl: res && res.nextUrl ? res.nextUrl.replace(/(tab[0-9a-z]+_limit)=\d+/, '$1=300') : null,
            catalogSubjectsLoading: false,
          });
        })
        .catch(() => {
          if (stillOnPage()) this.setCatalogSubjectsSectionState({ catalogSubjectsLoading: false });
        });
      scrape.fetchDoc(scrape.PATHS.unitPrograms(kod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitPrograms(doc) : null;
          if (!stillOnPage()) return;
          this.setCatalogProgramsState({
            catalogPrograms: res ? res.programs : [],
            catalogProgramsNextUrl: res ? res.nextUrl : null,
            catalogProgramsLoading: false,
          });
        })
        .catch(() => {
          if (stillOnPage()) this.setCatalogProgramsState({ catalogProgramsLoading: false });
        });
    }

    // "Wczytaj więcej" for the subject-offer listing — follows the current
    // page's own nav-bar next-page-url (already limit-boosted to 300 rows by
    // fetchCatalogPage) until a page comes back without one, merging rows by
    // kod so the list can't duplicate if USOS re-sorts between requests.
    loadMoreCatalogSubjects() {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const url = this.state.catalogSubjectsNextUrl;
      if (!scrape || !adapters || !url || this.state.catalogSubjectsLoading) return;
      const kod = this.state.catalogKod;
      this.setCatalogSubjectsSectionState({ catalogSubjectsLoading: true });
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitSubjects(doc) : null;
          if (this.state.view !== 'catalogPage' || this.state.catalogKind !== 'unit' || this.state.catalogKod !== kod) return;
          const known = new Set(this.state.catalogSubjects.map((r) => r.kod));
          const fresh = res ? res.subjects.filter((r) => !known.has(r.kod)) : [];
          this.setCatalogSubjectsSectionState({
            catalogSubjects: this.state.catalogSubjects.concat(fresh),
            catalogSubjectsTotal: (res && res.total) || this.state.catalogSubjectsTotal,
            // A page with nothing new ends the walk even if it still carries
            // a next-page-url — otherwise the button would re-fetch the same
            // tail forever.
            catalogSubjectsNextUrl: (res && res.nextUrl && fresh.length) ? res.nextUrl.replace(/(tab[0-9a-z]+_limit)=\d+/, '$1=300') : null,
            catalogSubjectsLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view === 'catalogPage' && this.state.catalogKind === 'unit') {
            this.setCatalogSubjectsSectionState({ catalogSubjectsLoading: false, catalogSubjectsNextUrl: null });
          }
        });
    }

    // Same walk for the programmes section — both verified listings render
    // in one page, but the nav-bar link is parsed generically so a bigger
    // university would simply get the button too.
    loadMoreCatalogPrograms() {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const url = this.state.catalogProgramsNextUrl;
      if (!scrape || !adapters || !url || this.state.catalogProgramsLoading) return;
      const kod = this.state.catalogKod;
      this.setCatalogProgramsState({ catalogProgramsLoading: true });
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitPrograms(doc) : null;
          if (this.state.view !== 'catalogPage' || this.state.catalogKind !== 'unit' || this.state.catalogKod !== kod) return;
          const known = new Set(this.state.catalogPrograms.map((r) => r.kod));
          const fresh = res ? res.programs.filter((r) => !known.has(r.kod)) : [];
          this.setCatalogProgramsState({
            catalogPrograms: this.state.catalogPrograms.concat(fresh),
            catalogProgramsNextUrl: (res && res.nextUrl && fresh.length) ? res.nextUrl : null,
            catalogProgramsLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view === 'catalogPage' && this.state.catalogKind === 'unit') {
            this.setCatalogProgramsState({ catalogProgramsLoading: false, catalogProgramsNextUrl: null });
          }
        });
    }

    // A stage ("semestr") link from a program's "Główne toki nauczania" —
    // reuses the exact same PATHS.stageSubjects/getStageSubjects pipeline
    // getOwnProgrammes already feeds for the logged-in user's own programme
    // (see renderPrzedmiotyLista), just for an arbitrary browsed program
    // instead. `catalogKod` doubles as this stage's prg_kod (it's the same
    // code the program page itself was opened with), so "back" can reopen
    // that exact program rather than the generic catalogBackView, which
    // points further back to wherever the user was before the program page.
    openStagePage(prgKod, etpKod, label) {
      if (!prgKod || !etpKod) return;
      this.setState((s) => ({
        view: 'catalogPage',
        catalogBackView: s.view === 'catalogPage' ? s.catalogBackView : s.view,
        catalogKind: 'stage',
        catalogKod: prgKod,
        catalogEtpKod: etpKod,
        catalogLoading: true,
        catalogError: false,
        catalogData: null,
      }));
      this.persistViewState();
      this.fetchStagePage(prgKod, etpKod, label);
    }

    fetchStagePage(prgKod, etpKod, label) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ catalogLoading: false, catalogError: true });
        return;
      }
      scrape.fetchDoc(scrape.PATHS.stageSubjects(prgKod, etpKod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const details = doc && adapter ? adapter.getStageSubjects(doc) : null;
          if (!details) {
            this.setState({ catalogLoading: false, catalogError: true });
          } else {
            this.setState({ catalogLoading: false, catalogData: { prgKod, etpKod, label, ...details } });
          }
        })
        .catch(() => {
          this.setState({ catalogLoading: false, catalogError: true });
        });
    }

    // Loads the WHOLE campus's buildings in one shot, the first time "Mapa"
    // is opened — see adapter.getBuildingsForUnit's comment for why one
    // request against the university's own root jednostka is enough
    // (buildings of every sub-unit are already included recursively),
    // rather than crawling every jednostka individually. The root is found
    // by walking up getUnitDetail's `ancestors` from the student's own
    // faculty — this.data.user.facultyCode, scraped at startup with zero
    // extra requests (see adapter.getUser) — or, when logged out, from any
    // unit the public search can find (inline fallback below). Cached in
    // chrome.storage.local (buildings essentially never change) so a later
    // visit/reload doesn't re-fetch; see mapaRefresh() for the manual
    // override.
    // ensureMapaData/fetchMapaData also run while the Mapa view isn't the
    // active one — the building section of the topbar search warms the
    // campus list on first keystrokes (onSearchInput). A full render() from
    // there would rebuild the topbar and yank focus out of the search
    // input mid-typing, and no other view reads the mapa state, so only a
    // visible Mapa view needs re-rendering when these async flips land.
    // katalogBudynki reads the same mapaBuildings list as its own rows, so
    // it needs the same re-render (otherwise the list stays on its first
    // empty paint until the user visits Mapa and comes back).
    renderMapaStateIfNeeded() {
      if (this.state.view === 'mapa' || this.state.view === 'katalogBudynki') this.render();
    }

    async ensureMapaData() {
      if (this.state.mapaBuildings.length || this.state.mapaLoading) return;
      this.state.mapaLoading = true;
      this.state.mapaError = false;
      this.renderMapaStateIfNeeded();
      const cacheKey = 'usospp:campusBuildings:' + location.origin;
      try {
        const stored = await chrome.storage.local.get(cacheKey);
        const cached = stored[cacheKey];
        if (cached && Array.isArray(cached.buildings) && cached.buildings.length) {
          this.state.mapaLoading = false;
          this.state.mapaBuildings = cached.buildings;
          this.renderMapaStateIfNeeded();
          return;
        }
      } catch (e) { /* private mode etc. — fall through to a live fetch */ }
      await this.fetchMapaData(cacheKey);
    }

    async fetchMapaData(cacheKey) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const adapter = adapters ? adapters.selectAdapter() : null;
      if (!scrape || !adapter) {
        this.state.mapaLoading = false;
        this.state.mapaError = true;
        this.renderMapaStateIfNeeded();
        return;
      }
      try {
        const facultyCode = this.data.user && this.data.user.facultyCode;
        let rootKod = facultyCode || null;
        if (facultyCode) {
          const unitDoc = await scrape.fetchDoc(scrape.PATHS.unitDetail(facultyCode));
          const detail = unitDoc ? adapter.getUnitDetail(unitDoc) : null;
          if (detail && detail.ancestors && detail.ancestors.length) rootKod = detail.ancestors[0].kod;
        }
        // Anonymous session (or a facultyCode whose ancestors didn't
        // resolve): no personal data to walk up from, so find ANY unit via
        // the same public search the wyszukiwarka uses and walk up ITS
        // ancestors instead — the search endpoint is as public as the news
        // page (see collectAnon). Patterns ordered by what any Polish
        // university practically always has among its jednostki. UNVERIFIED
        // live: the jsonSzukajJednostki endpoint for an anonymous session —
        // if it refuses, this loop just yields nothing and the Mapa shows
        // its ordinary error + "Spróbuj ponownie" card.
        if (!rootKod) {
          for (const pattern of ['instytut', 'wydzia', 'zakład']) {
            const found = await scrape.searchCatalog(pattern);
            if (!found.units.length) continue;
            const anyKod = found.units[0].kod;
            const unitDoc = await scrape.fetchDoc(scrape.PATHS.unitDetail(anyKod));
            const detail = unitDoc ? adapter.getUnitDetail(unitDoc) : null;
            if (detail && detail.ancestors && detail.ancestors.length) rootKod = detail.ancestors[0].kod;
            else if (detail && detail.supported) rootKod = anyKod; // top of what we can reach — its own subtree is the best we can place
            if (rootKod) break;
          }
        }
        if (!rootKod) {
          this.state.mapaLoading = false;
          this.state.mapaError = true;
          this.renderMapaStateIfNeeded();
          return;
        }
        const buildingsDoc = await scrape.fetchDoc(scrape.PATHS.buildingsForUnit(rootKod));
        const result = buildingsDoc ? adapter.getBuildingsForUnit(buildingsDoc) : null;
        this.state.mapaLoading = false;
        if (!result || !result.supported) {
          this.state.mapaError = true;
          this.renderMapaStateIfNeeded();
          return;
        }
        this.state.mapaBuildings = result.buildings;
        this.renderMapaStateIfNeeded();
        try {
          await chrome.storage.local.set({ [cacheKey]: { rootKod, buildings: result.buildings, fetchedAt: Date.now() } });
        } catch (e) { /* ignore — cache is a pure optimization */ }
      } catch (e) {
        this.state.mapaLoading = false;
        this.state.mapaError = true;
        this.renderMapaStateIfNeeded();
      }
    }

    // Manual "odśwież" link in renderMapa() — buildings are cached
    // indefinitely (see ensureMapaData), so this is the only way to pick up
    // a change without waiting for the cache to be cleared some other way.
    async mapaRefresh() {
      const cacheKey = 'usospp:campusBuildings:' + location.origin;
      try { await chrome.storage.local.remove(cacheKey); } catch (e) { /* ignore */ }
      this.state.mapaBuildings = [];
      this.state.mapaLoading = true;
      this.state.mapaError = false;
      this.render();
      await this.fetchMapaData(cacheKey);
    }

    // Manual "odśwież" link in renderMapa() — buildings are cached
    // indefinitely (see ensureMapaData), so this is the only way to pick up
    // a change without waiting for the cache to be cleared some other way.
    async mapaRefresh() {
      const cacheKey = 'usospp:campusBuildings:' + location.origin;
      try { await chrome.storage.local.remove(cacheKey); } catch (e) { /* ignore */ }
      this.state.mapaBuildings = [];
      this.state.mapaLoading = true;
      this.state.mapaError = false;
      this.render();
      await this.fetchMapaData(cacheKey);
    }

    // Katalog: root uczelni + browse drzewa + oferta per jednostka.
    // Root tym samym sposobem co Mapa (własny wydział → ancestors[0],
    // anonimowo: public search → ancestors) — działa bez logowania.
    renderKatalogStateIfNeeded() {
      if ((this.state.view || '').startsWith('katalog')) this.render();
    }

    async ensureKatalogRoot() {
      if (this.state.katalogRootData || this.state.katalogRootLoading) return;
      this.state.katalogRootLoading = true;
      this.state.katalogRootError = false;
      this.renderKatalogStateIfNeeded();
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const adapter = adapters ? adapters.selectAdapter() : null;
      if (!scrape || !adapter) {
        this.state.katalogRootLoading = false;
        this.state.katalogRootError = true;
        this.renderKatalogStateIfNeeded();
        return;
      }
      try {
        const facultyCode = this.data.user && this.data.user.facultyCode;
        let rootKod = null;
        let rootDetail = null;
        if (facultyCode) {
          const unitDoc = await scrape.fetchDoc(scrape.PATHS.unitDetail(facultyCode));
          const detail = unitDoc ? adapter.getUnitDetail(unitDoc) : null;
          if (detail && detail.supported) {
            rootKod = (detail.ancestors && detail.ancestors.length) ? detail.ancestors[0].kod : facultyCode;
            if (rootKod === facultyCode) rootDetail = detail;
          }
        }
        if (!rootKod) {
          for (const pattern of ['instytut', 'wydzia', 'zakład']) {
            const found = await scrape.searchCatalog(pattern);
            if (!found.units.length) continue;
            const anyKod = found.units[0].kod;
            const unitDoc = await scrape.fetchDoc(scrape.PATHS.unitDetail(anyKod));
            const detail = unitDoc ? adapter.getUnitDetail(unitDoc) : null;
            if (!detail || !detail.supported) continue;
            rootKod = (detail.ancestors && detail.ancestors.length) ? detail.ancestors[0].kod : anyKod;
            if (rootKod === anyKod) rootDetail = detail;
            if (rootKod) break;
          }
        }
        if (!rootKod) {
          this.state.katalogRootLoading = false;
          this.state.katalogRootError = true;
          this.renderKatalogStateIfNeeded();
          return;
        }
        if (!rootDetail) {
          const rootDoc = await scrape.fetchDoc(scrape.PATHS.unitDetail(rootKod));
          rootDetail = rootDoc ? adapter.getUnitDetail(rootDoc) : null;
        }
        this.state.katalogRootLoading = false;
        if (!rootDetail || !rootDetail.supported) {
          this.state.katalogRootError = true;
        } else {
          this.state.katalogRootKod = rootKod;
          this.state.katalogRootData = rootDetail;
          this.state.katalogRootError = false;
        }
        this.renderKatalogStateIfNeeded();
      } catch (e) {
        this.state.katalogRootLoading = false;
        this.state.katalogRootError = true;
        this.renderKatalogStateIfNeeded();
      }
    }

    katalogRetry() {
      this.state.katalogRootKod = null;
      this.state.katalogRootData = null;
      this.state.katalogRootError = false;
      this.state.katalogBrowseKod = null;
      this.state.katalogBrowseData = null;
      this.state.katalogBrowseError = false;
      this.ensureKatalogRoot();
    }

    // Manual "Spróbuj ponownie" in renderAktualnosci()'s failure card —
    // same lazy pattern as katalogRetry/mapaRefresh: flip a loading flag
    // (the card shows "Ładowanie…"), re-render, refetch just the news
    // section via scrape.refreshNews (same DOM-shapes-then-pwnews path
    // as the initial collect), store it back into the data model and
    // re-render. On failure the previous (unsupported) result stays, so
    // the card — with both buttons — simply comes back.
    async newsRetry() {
      if (this.state.newsRefreshing) return;
      this.setState({ newsRefreshing: true });
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      try {
        const adapter = adapters ? adapters.selectAdapter() : null;
        if (!scrape || !adapter || !scrape.refreshNews) throw new Error('no scraper');
        this.data.newsResult = await scrape.refreshNews(adapter);
      } catch (e) {
        // keep the previous result — the failure card stays
      }
      this.setState({ newsRefreshing: false });
    }

    fetchKatalogBrowse(kod) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters || !kod) return;
      this.setState({ katalogBrowseKod: kod, katalogBrowseLoading: true, katalogBrowseError: false, katalogBrowseData: null });
      scrape.fetchDoc(scrape.PATHS.unitDetail(kod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const detail = doc && adapter ? adapter.getUnitDetail(doc) : null;
          if (this.state.katalogBrowseKod !== kod) return;
          if (!detail || !detail.supported) {
            this.setState({ katalogBrowseLoading: false, katalogBrowseError: true });
          } else {
            this.setState({ katalogBrowseLoading: false, katalogBrowseData: detail });
          }
        })
        .catch(() => {
          if (this.state.katalogBrowseKod !== kod) return;
          this.setState({ katalogBrowseLoading: false, katalogBrowseError: true });
        });
    }

    // Picker w Przedmiotach/Kierunkach: ta sama jednostka dla obu nie jest
    // współdzielona celowo — każdy widok pamięta własny wybór.
    katalogSelectUnit(kod) {
      if (!kod) return;
      if (this.state.view === 'katalogPrzedmioty') {
        this.setState({
          katalogPrzedmiotyUnitKod: kod,
          katalogPrzedmiotyLoading: true,
          katalogPrzedmioty: [],
          katalogPrzedmiotyTotal: 0,
          katalogPrzedmiotyNextUrl: null,
          katalogPrzedmiotyQuery: '',
          katalogPrzedmiotyCurrentOnly: false,
        });
        this.fetchKatalogPrzedmioty(kod);
      } else if (this.state.view === 'katalogKierunki') {
        this.setState({
          katalogKierunkiUnitKod: kod,
          katalogKierunkiLoading: true,
          katalogKierunki: [],
          katalogKierunkiNextUrl: null,
        });
        this.fetchKatalogKierunki(kod);
      }
    }

    fetchKatalogPrzedmioty(kod) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ katalogPrzedmiotyLoading: false });
        return;
      }
      scrape.fetchDoc(scrape.PATHS.unitSubjects(kod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitSubjects(doc) : null;
          if (this.state.view !== 'katalogPrzedmioty' || this.state.katalogPrzedmiotyUnitKod !== kod) return;
          this.setState({
            katalogPrzedmioty: res ? res.subjects : [],
            katalogPrzedmiotyTotal: res ? res.total : 0,
            katalogPrzedmiotyNextUrl: res && res.nextUrl ? res.nextUrl.replace(/(tab[0-9a-z]+_limit)=\d+/, '$1=300') : null,
            katalogPrzedmiotyLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view !== 'katalogPrzedmioty' || this.state.katalogPrzedmiotyUnitKod !== kod) return;
          this.setState({ katalogPrzedmiotyLoading: false });
        });
    }

    loadMoreKatalogPrzedmioty() {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const url = this.state.katalogPrzedmiotyNextUrl;
      const kod = this.state.katalogPrzedmiotyUnitKod;
      if (!scrape || !adapters || !url || this.state.katalogPrzedmiotyLoading) return;
      this.setState({ katalogPrzedmiotyLoading: true });
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitSubjects(doc) : null;
          if (this.state.view !== 'katalogPrzedmioty' || this.state.katalogPrzedmiotyUnitKod !== kod) return;
          const known = new Set(this.state.katalogPrzedmioty.map((r) => r.kod));
          const fresh = res ? res.subjects.filter((r) => !known.has(r.kod)) : [];
          this.setState({
            katalogPrzedmioty: this.state.katalogPrzedmioty.concat(fresh),
            katalogPrzedmiotyTotal: (res && res.total) || this.state.katalogPrzedmiotyTotal,
            katalogPrzedmiotyNextUrl: (res && res.nextUrl && fresh.length) ? res.nextUrl.replace(/(tab[0-9a-z]+_limit)=\d+/, '$1=300') : null,
            katalogPrzedmiotyLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view === 'katalogPrzedmioty') this.setState({ katalogPrzedmiotyLoading: false, katalogPrzedmiotyNextUrl: null });
        });
    }

    fetchKatalogKierunki(kod) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) {
        this.setState({ katalogKierunkiLoading: false });
        return;
      }
      scrape.fetchDoc(scrape.PATHS.unitPrograms(kod))
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitPrograms(doc) : null;
          if (this.state.view !== 'katalogKierunki' || this.state.katalogKierunkiUnitKod !== kod) return;
          this.setState({
            katalogKierunki: res ? res.programs : [],
            katalogKierunkiNextUrl: res ? res.nextUrl : null,
            katalogKierunkiLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view !== 'katalogKierunki' || this.state.katalogKierunkiUnitKod !== kod) return;
          this.setState({ katalogKierunkiLoading: false });
        });
    }

    loadMoreKatalogKierunki() {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const url = this.state.katalogKierunkiNextUrl;
      const kod = this.state.katalogKierunkiUnitKod;
      if (!scrape || !adapters || !url || this.state.katalogKierunkiLoading) return;
      this.setState({ katalogKierunkiLoading: true });
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const res = doc && adapter ? adapter.getUnitPrograms(doc) : null;
          if (this.state.view !== 'katalogKierunki' || this.state.katalogKierunkiUnitKod !== kod) return;
          const known = new Set(this.state.katalogKierunki.map((r) => r.kod));
          const fresh = res ? res.programs.filter((r) => !known.has(r.kod)) : [];
          this.setState({
            katalogKierunki: this.state.katalogKierunki.concat(fresh),
            katalogKierunkiNextUrl: (res && res.nextUrl && fresh.length) ? res.nextUrl : null,
            katalogKierunkiLoading: false,
          });
        })
        .catch(() => {
          if (this.state.view === 'katalogKierunki') this.setState({ katalogKierunkiLoading: false, katalogKierunkiNextUrl: null });
        });
    }

    setKatalogPrzedmiotyQueryState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'katalogPrzedmioty') return;
      // Patch listy bez dotykania inputa — ten sam powód co
      // setCatalogSubjectsState (focus/kursor w trakcie pisania).
      this.render();
      const input = this.root.querySelector('[data-action="katalogPrzedmiotyQueryInput"]');
      if (input && document.activeElement !== input) { /* render odtworzył input — focus wraca tylko gdy był */ }
      if (input) {
        const val = this.state.katalogPrzedmiotyQuery || '';
        if (input.value !== val) input.value = val;
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ }
      }
    }

    setKatalogBudynkiQueryState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'katalogBudynki') return;
      this.render();
      const input = this.root.querySelector('[data-action="katalogBudynkiQueryInput"]');
      if (input) {
        const val = this.state.katalogBudynkiQuery || '';
        if (input.value !== val) input.value = val;
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ }
      }
    }

    // "Pokaż na mapie" on a unit page's building list — instead of
    // navigating away to the dedicated Mapa view, pans/zooms the inline
    // preview map (mounted by mountUnitMapPreview) to that building and
    // opens its popup. scrollIntoView first because the map sits ABOVE the
    // list, which can run long enough for the clicked row to be off-screen.
    unitMapGoToBuilding(budKod) {
      if (!this._unitMap || !this._unitMapMarkersByKod) return;
      const marker = this._unitMapMarkersByKod[budKod];
      if (!marker) return;
      const container = this.root.querySelector('[data-unit-map]');
      if (container) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      this._unitMap.setView(marker.getLatLng(), 17);
      marker.openPopup();
    }

    // Called by setMapaFilter AND by the initial mount — updates which
    // markers are shown on the ALREADY-MOUNTED map (add/removeFrom, not
    // recreate) and re-fits the view to whatever ends up visible, so
    // picking a wydział zooms in on just its buildings, and clearing the
    // filter naturally zooms back out to the whole campus (the visible set
    // becomes everything again). Keyed by unitKod, not display text — see
    // adapter.getBuildingsForUnit's comment: several distinct units
    // (different wydziały's own "Kierownik Administracji Wydziałowej",
    // for one) share the exact same name, so text equality would wrongly
    // show buildings from more than one unit at once.
    applyMapaFilter() {
      if (!this._mapaMarkersByKod || !this._leafletMap) return;
      const filter = this.state.mapaUnitFilter;
      const visible = [];
      Object.values(this._mapaMarkersByKod).forEach(({ marker, building }) => {
        const show = !filter || building.unitKod === filter;
        const onMap = this._leafletMap.hasLayer(marker);
        if (show && !onMap) marker.addTo(this._leafletMap);
        else if (!show && onMap) marker.remove();
        if (show) visible.push(marker.getLatLng());
      });
      if (visible.length === 1) this._leafletMap.setView(visible[0], 16);
      else if (visible.length > 1) this._leafletMap.fitBounds(window.L.latLngBounds(visible).pad(0.15));
    }

    // Deliberately bypasses setState/render() — see mountMapaIfNeeded's
    // comment for why a full render would destroy and recreate the whole
    // Leaflet map (losing pan/zoom) on every filter change, exactly the
    // "page reload" flash this codebase's other setXState methods (see
    // setTopbarState et al.) already exist to avoid elsewhere.
    setMapaFilter(unitKod) {
      this.state.mapaUnitFilter = unitKod;
      this.applyMapaFilter();
      const el = this.root.querySelector('[data-mapa-filter-root]');
      if (el) el.outerHTML = this.renderMapaFilterChips();
    }

    // Live, purely client-side filter over the already-loaded mapaBuildings
    // (no fetch, no debounce needed) — see setSearchState/
    // setPlannerSearchState for the same "patch only the results subtree"
    // reasoning, so typing never drops focus/cursor from the <input>.
    onMapaSearchInput(value) {
      this.state.mapaSearchQuery = value;
      const el = this.root.querySelector('[data-mapa-search-results-root]');
      if (el) el.innerHTML = this.renderMapaSearchResults();
    }

    renderMapaSearchResults() {
      const q = this.state.mapaSearchQuery.trim().toLowerCase();
      if (q.length < 2) return '';
      const matches = this.state.mapaBuildings
        .filter((b) => b.kod && (b.name.toLowerCase().includes(q) || (b.address && b.address.toLowerCase().includes(q))))
        .slice(0, 8);
      if (!matches.length) {
        return `<div class="usospp-search-dropdown"><div class="usospp-empty-hint" style="padding:16px;">Brak wyników.</div></div>`;
      }
      return `
        <div class="usospp-search-dropdown">
          ${matches.map((b) => `
            <div class="usospp-search-item" data-action="mapaGoToBuilding" data-kod="${esc(b.kod)}">
              <div class="usospp-search-item-title">${esc(b.name)}</div>
              <div class="usospp-search-item-sub">${esc(b.address || b.unitName || '')}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    // Pans/zooms the ALREADY-MOUNTED campus map to one building and opens
    // its popup — used by the Mapa view's own search dropdown. If the
    // building is hidden behind the current wydział filter, clears the
    // filter first so
    // it's actually visible rather than silently focusing on nothing.
    mapaGoToBuilding(budKod) {
      const entry = this._mapaMarkersByKod && this._mapaMarkersByKod[budKod];
      if (!entry || !this._leafletMap) return;
      if (this.state.mapaUnitFilter && entry.building.unitKod !== this.state.mapaUnitFilter) {
        this.state.mapaUnitFilter = '';
        this.applyMapaFilter();
        const filterEl = this.root.querySelector('[data-mapa-filter-root]');
        if (filterEl) filterEl.outerHTML = this.renderMapaFilterChips();
      }
      this._leafletMap.setView(entry.marker.getLatLng(), 17);
      entry.marker.openPopup();
      this.mapaClearSearch();
    }

    // A building hit in the topbar search ("Budynki" section of
    // renderSearchResults) — jump to the Mapa view and, once its markers
    // are created, pan to that building and open its popup. The pending kod
    // lives in state (not a plain field) because the user can land on the
    // view while buildings are still loading — mountMapaIfNeeded then
    // consumes it on the first render that actually has markers. One-shot:
    // cleared when consumed so an unrelated later re-render doesn't zoom
    // the map again.
    openMapaFocused(budKod) {
      if (!budKod) return;
      this.state.mapaFocusKod = budKod;
      // Clear any wydział filter BEFORE navigating: the user asked for one
      // specific building, which may belong to a unit outside it (and a
      // filter-hidden marker's popup would be a confusing no-op). Doing it
      // here — pre-render — means the chip strip just draws filterless,
      // no DOM patching like mapaGoToBuilding needs mid-view.
      this.state.mapaUnitFilter = '';
      this.navigate('mapa'); // navigate() itself calls ensureMapaData() — a no-op if already loading/loaded
    }

    // Bypasses render() same as setMapaFilter — also has to reach into the
    // DOM directly for the <input>'s own value, since (unlike state) that
    // isn't something a scoped innerHTML patch of the results dropdown
    // alone would ever touch.
    mapaClearSearch() {
      this.state.mapaSearchQuery = '';
      const input = this.root.querySelector('[data-mapa-search-input]');
      if (input) input.value = '';
      const resultsEl = this.root.querySelector('[data-mapa-search-results-root]');
      if (resultsEl) resultsEl.innerHTML = '';
    }

    // Leaflet keeps a live L.Map bound to a specific DOM node. render()
    // (see its call to this method at the end) replaces `.usospp-root`'s
    // entire innerHTML on every call, so any previous map instance is left
    // attached to an already-detached element and must be torn down before
    // a fresh one is created here — this runs after EVERY render(), not
    // just the first time "Mapa" is opened. Filter changes (setMapaFilter)
    // deliberately never call render() for exactly this reason.
    mountMapaIfNeeded() {
      if (this.state.view !== 'mapa') {
        if (this._leafletMap) { this._leafletMap.remove(); this._leafletMap = null; this._mapaMarkersByKod = null; }
        return;
      }
      const container = this.root.querySelector('[data-mapa-map]');
      if (!container) return; // loading/error/empty state currently shown — nothing to mount yet
      if (!window.L) {
        const loader = window.USOSPP_LEAFLET;
        if (loader && !this._leafletLoading) {
          this._leafletLoading = true;
          loader.ensureLeaflet().then(() => {
            this._leafletLoading = false;
            if (this.state.view === 'mapa') this.mountMapaIfNeeded();
          }).catch(() => {
            this._leafletLoading = false;
            this.state.mapaError = true;
            this.renderMapaStateIfNeeded();
          });
        }
        return;
      }
      if (this._leafletMap) { this._leafletMap.remove(); this._leafletMap = null; }
      const map = window.L.map(container, { center: [51.11, 17.03], zoom: 12 });
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      const markerIcon = this.mapaMarkerIcon();
      this._leafletMap = map;
      this._mapaMarkersByKod = {};
      this.state.mapaBuildings.forEach((b) => {
        const marker = window.L.marker([b.lat, b.lng], { icon: markerIcon })
          .bindPopup(`<b>${esc(b.name)}</b>${b.address ? `<br>${esc(b.address)}` : ''}`);
        this._mapaMarkersByKod[b.kod] = { marker, building: b };
      });
      this.applyMapaFilter(); // also fits the view to whatever ends up visible under the current filter
      // Pending focus from the topbar's building search (openMapaFocused)
      // — after applyMapaFilter, so the fit-to-visible wouldn't immediately
      // undo the pan. animate:false skips the whole-campus → building
      // transition, landing directly on a tight, unmistakably-this-one
      // framing. Consumed exactly once.
      if (this.state.mapaFocusKod) {
        const entry = this._mapaMarkersByKod[this.state.mapaFocusKod];
        if (entry) {
          map.setView(entry.marker.getLatLng(), 18, { animate: false });
          entry.marker.openPopup();
        }
        this.state.mapaFocusKod = null;
      }
    }

    // Shared by the full Mapa view and the unit-page preview — explicit
    // chrome.runtime.getURL icon paths instead of leaflet.css's own relative
    // `images/marker-icon.png`, needed because that CSS is injected into
    // USOSweb's own document, not served from our own origin, so a relative
    // path would resolve against USOSweb's URL.
    mapaMarkerIcon() {
      return window.L.icon({
        iconUrl: chrome.runtime.getURL('vendor/leaflet/images/marker-icon.png'),
        iconRetinaUrl: chrome.runtime.getURL('vendor/leaflet/images/marker-icon-2x.png'),
        shadowUrl: chrome.runtime.getURL('vendor/leaflet/images/marker-shadow.png'),
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41],
      });
    }

    // Inline map preview on a unit page (renderUnitPage's "Budynki jednostki"
    // card) — just this unit's buildings (which buildingsForUnit already
    // includes with all sub-units', recursively), no building search and no
    // wydział filter chips: the dedicated Mapa view is one "Zobacz na mapie"
    // click away for pan/zoom beyond this or campus-wide context. Same
    // teardown-before-remount discipline as mountMapaIfNeeded(): render()
    // replaces this container on every call, so any live instance would be
    // stranded on a detached node.
    mountUnitMapPreview() {
      if (this._unitMap) { this._unitMap.remove(); this._unitMap = null; this._unitMapMarkersByKod = null; }
      if (this.state.view !== 'catalogPage' || this.state.catalogKind !== 'unit') return;
      const buildings = this.state.catalogBuildings;
      if (!buildings || !buildings.length) return;
      const container = this.root.querySelector('[data-unit-map]');
      if (!container) return; // still loading / errored — card (so the div) isn't rendered
      if (!window.L) {
        const loader = window.USOSPP_LEAFLET;
        if (loader && !this._leafletLoading) {
          this._leafletLoading = true;
          loader.ensureLeaflet().then(() => {
            this._leafletLoading = false;
            this.mountUnitMapPreview();
          }).catch(() => { this._leafletLoading = false; });
        }
        return;
      }
      const map = window.L.map(container, { center: [51.11, 17.03], zoom: 12, scrollWheelZoom: false });
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      const markerIcon = this.mapaMarkerIcon();
      // Kept keyed by building kod so unitMapGoToBuilding (the "Pokaż na
      // mapie" links in the list below the map) can find one marker without
      // scanning the DOM for it.
      this._unitMapMarkersByKod = {};
      const points = [];
      buildings.forEach((b) => {
        const marker = window.L.marker([b.lat, b.lng], { icon: markerIcon })
          .bindPopup(`<b>${esc(b.name)}</b>${b.address ? `<br>${esc(b.address)}` : ''}`);
        marker.addTo(map);
        this._unitMapMarkersByKod[b.kod] = marker;
        points.push(marker.getLatLng());
      });
      if (points.length === 1) map.setView(points[0], 17);
      else map.fitBounds(window.L.latLngBounds(points).pad(0.2));
      this._unitMap = map;
    }

    // The mini timetable embedded directly in the subject page only has a
    // one-letter class-type code per entry and no teacher/room. Each cycle's
    // "Przejdź do planu" link (captured as `planUrl`) points to a richer,
    // separate page with that detail (see adapter.getSubjectTimetable) — so
    // once the subject page itself has rendered, fetch those in the
    // background per cycle and upgrade each cycle's timetable in place.
    // Guarded by `subjectUrl` (not object identity) so a stale response
    // arriving after the user opened a *different* subject is dropped.
    // Timetables arrive per cycle and at different times, but the page
    // must not rebuild for them: every full render recreates .usospp-view
    // (visible blink even with the enter-gated fade). So Promise.all waits
    // for every cycle, state commits silently, and only the skeleton slots
    // ([data-cycle-timetable]) are swapped for real timetables in place.
    loadSubjectTimetables(url, cycles) {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) return;
      const adapter = adapters.selectAdapter();
      if (!adapter) return;
      const jobs = cycles.map((cycle, idx) => {
        if (!cycle.planUrl) return Promise.resolve(null);
        return scrape.fetchDoc(cycle.planUrl)
          .then((doc) => {
            if (!doc) return { idx, tt: null };
            const tt = adapter.getSubjectTimetable(doc);
            return { idx, tt: (tt && tt.days.length) ? tt : null };
          })
          .catch(() => ({ idx, tt: null }));
      });
      Promise.all(jobs).then((results) => {
        const s = this.state;
        // Stale (user navigated elsewhere meanwhile): new view fetches its
        // own data — touch nothing, leave no skeletons behind elsewhere.
        if (!s.subjectData || s.subjectUrl !== url || s.view !== 'subjectPage') return;
        const byIdx = new Map(results.filter(Boolean).map((r) => [r.idx, r.tt]));
        const nextCycles = s.subjectData.cycles.map((c, i) => (
          byIdx.has(i) && byIdx.get(i) ? { ...c, timetable: byIdx.get(i) } : c
        ));
        // Silent commit (no render) — visible swap happens per slot below.
        s.subjectData = { ...s.subjectData, cycles: nextCycles };
        const root = this.root.querySelector('[data-content-root]');
        if (!root) return;
        cycles.forEach((cycle, idx) => {
          if (!cycle.planUrl) return;
          const slot = root.querySelector(`[data-cycle-timetable="${idx}"]`);
          if (!slot) return;
          const tt = byIdx.get(idx);
          const html = tt ? this.renderSubjectTimetable(tt) : '';
          slot.outerHTML = html || `<div style="font-size:11.5px;color:var(--ink-3);margin-top:14px;">Nie udało się pobrać planu.</div>`;
        });
      });
    }

    // ---- schedule planner (what-if plan, never touches real USOS state) ---

    // Tab-strip projection shared by every plan-list mutation tail:
    // {id, name, pickCount} plus isMain, so the star survives any refresh.
    projectPlannerPlans(plans, mainPlanId) {
      return (plans || []).map((p) => ({
        id: p.id,
        name: p.name,
        pickCount: (p.picks || []).length,
        isMain: p.id === mainPlanId,
      }));
    }

    // Full records for the "Moje plany" section: projection above plus the
    // picks (for stats) — refreshed at the same sites as plannerPlans.
    projectPlannerFullPlans(plans, mainPlanId) {
      return (plans || []).map((p) => ({
        id: p.id,
        name: p.name,
        picks: p.picks || [],
        isMain: p.id === mainPlanId,
        stats: plannerPlanStats(p.picks),
      }));
    }

    // Full main-plan record ({id, name, picks}) for the Zapisy
    // integrations — reads the store directly instead of local state,
    // which only ever holds the ACTIVE plan's picks.
    async getMainPlanRecord() {
      const planner = window.USOSPP_PLANNER;
      if (!planner) return null;
      const data = await planner.getData();
      const mainId = (data.plans.some((p) => p.id === data.mainPlanId)) ? data.mainPlanId : data.activePlanId;
      const plan = data.plans.find((p) => p.id === mainId) || data.plans[0];
      if (!plan) return null;
      return { id: plan.id, name: plan.name, picks: plan.picks || [] };
    }

    // Applies a freshly-loaded (or cross-tab-changed) planner store snapshot
    // — { plans: [{id,name,picks}], activePlanId, mainPlanId } — to local
    // state. Also recomputes every pick's `key` in every plan (not just the active one,
    // so switching to an old plan doesn't resurrect the stale-key bug) from
    // its own stable fields: `key` used to be built from the raw subject
    // URL before classTypeKey started normalizing through subjectId, so
    // picks saved before that fix carry a key baked with a since-rotated
    // `callback=` token that would keep failing to match on reopen.
    // Idempotent, so it's safe to run on every load.
    applyPlannerData(data) {
      if (!data || !Array.isArray(data.plans) || !data.plans.length) return;
      let changed = false;
      const migratedPlans = data.plans.map((plan) => {
        const picks = (plan.picks || []).map((p) => {
          const key = classTypeKey(p.subjectUrl, p.cycleName, p.classTypeLabel);
          if (key !== p.key) changed = true;
          return { ...p, key };
        });
        return { ...plan, picks };
      });
      // Prefer whatever THIS tab already has active (if it still exists)
      // over blindly following the snapshot's activePlanId — otherwise one
      // tab switching plans would silently switch what a different open
      // tab is looking at too.
      const preferredId = this.state.plannerActivePlanId;
      const activePlanId = migratedPlans.some((p) => p.id === preferredId)
        ? preferredId
        : (migratedPlans.some((p) => p.id === data.activePlanId) ? data.activePlanId : migratedPlans[0].id);
      const activePlan = migratedPlans.find((p) => p.id === activePlanId);
      // Unlike the active tab (kept per-tab, see above), the MAIN plan is
      // global truth — a star set in another tab is followed here.
      const mainPlanId = migratedPlans.some((p) => p.id === data.mainPlanId) ? data.mainPlanId : activePlanId;
      // Manual picks may contribute custom generator candidates (see
      // plannerSubjectCandidates) — assign them first so the seed below
      // sees the fresh list, then default-check any it hasn't seen yet.
      // Single render: seedPlannerAutoSelected never renders by itself.
      Object.assign(this.state, { plannerPicks: (activePlan && activePlan.picks) || [] });
      this.seedPlannerAutoSelected();
      this.setPlannerState({
        plannerPlans: this.projectPlannerPlans(migratedPlans, mainPlanId),
        plannerPlansFull: this.projectPlannerFullPlans(migratedPlans, mainPlanId),
        plannerActivePlanId: activePlanId,
        plannerMainPlanId: mainPlanId,
        plannerPicks: this.state.plannerPicks,
        plannerConfirmDeleteId: null,
      });
      // Dots need subject pages for picked subjects (see
      // plannerPrefetchPickedSubjects) — covers boot, reloads and
      // cross-tab updates landing here.
      this.plannerPrefetchPickedSubjects();
      if (changed) {
        const planner = window.USOSPP_PLANNER;
        if (planner) planner.setData({ ...data, plans: migratedPlans });
      }
    }

    loadPlannerPicks() {
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      planner.getData().then((data) => this.applyPlannerData(data));
      // Guarded so a second App instance in the same page lifetime (there
      // shouldn't normally be one) doesn't stack duplicate listeners.
      if (!this._plannerListenerBound) {
        this._plannerListenerBound = true;
        planner.onDataChange((data) => this.applyPlannerData(data));
      }
    }

    // Persists `nextPicks` into the currently-active plan's slot only —
    // every other saved plan is untouched.
    savePlannerPicks(nextPicks, extraPatch) {
      this.setPlannerState({ plannerPicks: nextPicks, ...extraPatch });
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      const activeId = this.state.plannerActivePlanId;
      planner.setData((data) => {
        if (!data.plans.some((p) => p.id === activeId)) return data;
        return { ...data, plans: data.plans.map((p) => (p.id === activeId ? { ...p, picks: nextPicks } : p)) };
      }).then((next) => {
        this.setPlannerState({
          plannerPlans: this.projectPlannerPlans(next.plans, next.mainPlanId),
          plannerPlansFull: this.projectPlannerFullPlans(next.plans, next.mainPlanId),
          plannerMainPlanId: next.mainPlanId,
        });
      });
    }

    // Switches which saved plan is being edited/previewed. Any in-progress,
    // unsaved subject configurator is discarded (it belongs to whichever
    // plan was active when it was opened).
    plannerSwitchPlan(id) {
      if (!id || id === this.state.plannerActivePlanId) return;
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      planner.setData((data) => (data.plans.some((p) => p.id === id) ? { ...data, activePlanId: id } : data))
        .then((next) => this.applyPlannerSwitchResult(next));
    }

    plannerNewPlan() {
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      planner.setData((data) => {
        if (data.plans.length >= planner.MAX_PLANS) return data;
        const plan = { id: planner.genId(), name: `Plan ${data.plans.length + 1}`, picks: [] };
        // Nowy plan nie rusza gwiazdki: main zostaje tam, gdzie był (fallback
        // na nowy tylko gdyby stary main nie istniał). Bez tego zapisany
        // snapshot tracił mainPlanId, a getData promował nowy plan na główny.
        const mainAlive = data.plans.some((p) => p.id === data.mainPlanId);
        return { plans: [...data.plans, plan], activePlanId: plan.id, mainPlanId: mainAlive ? data.mainPlanId : plan.id };
      }).then((next) => this.applyPlannerSwitchResult(next));
    }

    plannerDuplicatePlan(id) {
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      const srcId = id || this.state.plannerActivePlanId;
      planner.setData((data) => {
        if (data.plans.length >= planner.MAX_PLANS) return data;
        const source = data.plans.find((p) => p.id === srcId) || data.plans[0];
        if (!source) return data;
        const plan = { id: planner.genId(), name: `${source.name} (kopia)`, picks: JSON.parse(JSON.stringify(source.picks || [])) };
        // Jak wyżej: duplikat nie rusza gwiazdki głównego planu.
        const mainAlive = data.plans.some((p) => p.id === data.mainPlanId);
        return { plans: [...data.plans, plan], activePlanId: plan.id, mainPlanId: mainAlive ? data.mainPlanId : plan.id };
      }).then((next) => {
        this.applyPlannerSwitchResult(next);
        // Kopia dziedziczy zapamiętane customy źródła (inaczej usunięcie
        // terminu w kopii wyrzucałoby przedmiot z listy).
        const srcMem = (this.state.plannerCustomSubjects || {})[srcId];
        if (srcMem) {
          this.setPlannerState((s) => ({
            plannerCustomSubjects: { ...(s.plannerCustomSubjects || {}), [next.activePlanId]: { ...srcMem } },
          }));
        }
      });
    }

    // Never removes the last remaining plan — there must always be
    // something to show/edit. id defaults to the active plan (old callers).
    plannerDeletePlan(id) {
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      const delId = id || this.state.plannerActivePlanId;
      planner.setData((data) => {
        if (data.plans.length <= 1) return data;
        const nextPlans = data.plans.filter((p) => p.id !== delId);
        if (nextPlans.length === data.plans.length) return data;
        const mainAlive = nextPlans.some((p) => p.id === data.mainPlanId);
        const activeAlive = nextPlans.some((p) => p.id === data.activePlanId);
        const activeId = activeAlive ? data.activePlanId : nextPlans[0].id;
        return {
          plans: nextPlans,
          activePlanId: activeId,
          mainPlanId: mainAlive ? data.mainPlanId : activeId,
        };
      }).then((next) => {
        this.applyPlannerSwitchResult(next);
        // Usunięty plan zabiera swój wpis pamięci customów.
        if ((this.state.plannerCustomSubjects || {})[delId]) {
          this.setPlannerState((s) => {
            const mem = { ...(s.plannerCustomSubjects || {}) };
            delete mem[delId];
            return { plannerCustomSubjects: mem };
          });
        }
      });
    }

    // Shared tail for the four plan-list mutations above: adopt whatever
    // plan ended up active and close any open subject configurator, since
    // it belonged to the plan we just switched away from.
    applyPlannerSwitchResult(next) {
      const plan = next.plans.find((p) => p.id === next.activePlanId);
      this.setPlannerState({
        plannerPlans: this.projectPlannerPlans(next.plans, next.mainPlanId),
        plannerPlansFull: this.projectPlannerFullPlans(next.plans, next.mainPlanId),
        plannerActivePlanId: next.activePlanId,
        plannerMainPlanId: next.mainPlanId,
        plannerPicks: (plan && plan.picks) || [],
        plannerExpandedUrl: null,
        plannerDraftSelection: {},
        plannerRenamingPlanId: null,
        plannerConfirmDeleteId: null,
      });
      // Newly-active plan may carry picks whose subject pages aren't cached
      // (fresh switch) — warm them for the fractional dots.
      this.plannerPrefetchPickedSubjects();
    }

    // Star toggle: marks which saved plan the Zapisy integrations treat as
    // "my plan". Never touches the active tab or any picks — and never
    // discards an open configurator (unlike applyPlannerSwitchResult).
    plannerSetMainPlan(id) {
      if (!id || id === this.state.plannerMainPlanId) return;
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      planner.setData((data) => (data.plans.some((p) => p.id === id) ? { ...data, mainPlanId: id } : data))
        .then((next) => {
          this.setPlannerState({
            plannerPlans: this.projectPlannerPlans(next.plans, next.mainPlanId),
            plannerPlansFull: this.projectPlannerFullPlans(next.plans, next.mainPlanId),
            plannerMainPlanId: next.mainPlanId,
          });
        });
    }

    // Inline rename: the card name becomes an <input> (see
    // renderPlannerVersionCard); commit on Enter/✓, cancel on Escape/✕.
    // Anything else re-rendering the planner abandons the edit — rename is
    // an explicit mode, not ambient state.
    plannerStartRename(id) {
      if (!id) return;
      this.setPlannerState({ plannerRenamingPlanId: id });
      const input = this.root.querySelector(`input[data-plan-rename="${CSS.escape(id)}"]`);
      if (input) { input.focus(); input.select(); }
    }

    plannerCancelRename() {
      if (!this.state.plannerRenamingPlanId) return;
      this.setPlannerState({ plannerRenamingPlanId: null });
    }

    plannerCommitRename(id) {
      if (!id) return;
      const input = this.root.querySelector(`input[data-plan-rename="${CSS.escape(id)}"]`);
      const name = (input ? input.value : '').trim().slice(0, 40);
      // Empty (or unchanged-in-effect) commits just exit rename mode —
      // there is no "empty plan name" state to persist.
      if (!name) {
        this.setPlannerState({ plannerRenamingPlanId: null });
        return;
      }
      const planner = window.USOSPP_PLANNER;
      if (!planner) return;
      planner.setData((data) => ({
        ...data,
        plans: data.plans.map((p) => (p.id === id ? { ...p, name } : p)),
      })).then((next) => {
        this.setPlannerState({
          plannerPlans: this.projectPlannerPlans(next.plans, next.mainPlanId),
          plannerRenamingPlanId: null,
        });
      });
    }

    // Planowanie/Zapisy mode toggle above the grid (replaces the old
    // one-shot "Sprawdź miejsca" button): entering Zapisy auto-runs the
    // seat check whose badges and subject filter need its data.
    renderPlannerRejCheck() {
      if (!this.state.plannerPicks.length) return '';
      const zapisy = !!this.state.plannerZapisyMode;
      const loading = this.state.plannerRejCheck === 'loading';
      const summary = this.state.plannerRejSummary;
      return `
        <div style="display:flex;gap:6px;margin-bottom:12px;">
          <button class="usospp-mode-btn${!zapisy ? ' active' : ''}" data-action="plannerSetZapisyMode" data-mode="plan">Planowanie</button>
          <button class="usospp-mode-btn${zapisy ? ' active' : ''}" data-action="plannerSetZapisyMode" data-mode="zapisy">Zapisy</button>
        </div>
        ${zapisy ? `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
          <button class="usospp-btn-ghost" style="font-size:12px;${loading ? 'opacity:0.6;' : ''}" ${loading ? 'disabled' : ''} data-action="plannerCheckRejSeats">${loading ? 'Sprawdzam miejsca…' : 'Odśwież miejsca'}</button>
          ${summary ? `<span style="font-size:12px;color:var(--ink-3);">${esc(summary)}</span>` : ''}
        </div>` : ''}
      `;
    }

    async plannerCheckRejSeats() {
      if (this.state.plannerRejCheck === 'loading') return;
      this.setPlannerState({ plannerRejCheck: 'loading', plannerRejSummary: null });
      const res = await this.fetchRejSeatsForPicks(this.state.plannerPicks);
      if (!res || this.state.view !== 'planer') return;
      if (res.error) {
        this.setPlannerState({ plannerRejCheck: 'idle', plannerRejSummary: res.error });
        return;
      }
      const summary = res.matchedKods.size
        ? `${[...res.tourLabels].join(', ')} · ${res.matchedKods.size}/${res.totalKods} przedmiotów z planu w turze — kliknij blok, aby pokazać wolne terminy`
        : 'Brak Twoich przedmiotów w aktywnych turach zapisów.';
      this.setPlannerState({ plannerRejCheck: 'done', plannerRejBadges: res.badges, plannerRejSummary: summary });
    }

    // Shared core for direction A (badges on the visible grid), the seat
    // guardian and the generator's free-seats constraint: seat state per
    // pick key for the given picks, across all live personal tours.
    // Returns { badges, tourLabels, matchedKods, totalKods } or { error }.
    // In-memory caches (_plannerRejCache) make repeat checks cheap; stops
    // firing USOS requests the moment the planner is left.
    async fetchRejSeatsForPicks(picks) {
      const bridge = window.USOSPP_ZAPISY_PLAN;
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!bridge || !scrape || !adapters) return { error: 'Moduł zapisów niedostępny.' };
      try {
        const adapter = adapters.selectAdapter();
        const cal = await scrape.refreshPersonalCalendar(adapter);
        const sections = (cal && Array.isArray(cal.sections) ? cal.sections : []);
        if (!sections.length) return { error: 'Brak tur zapisów na Twoim koncie.' };
        const now = Date.now();
        const tours = [];
        sections.forEach((sec) => {
          (sec.rounds || []).forEach((r) => {
            if (!r.rejKod || !r.hasAccess) return;
            if (r.endsAt) {
              const end = Date.parse(String(r.endsAt).replace(' ', 'T'));
              if (!Number.isNaN(end) && end < now) return;
            }
            tours.push({ rejKod: r.rejKod, registerUrl: r.registerUrl || null, sectionCode: sec.code || r.rejKod, subjectsUrl: sec.subjectsUrl || null });
          });
        });
        if (!tours.length) return { error: 'Brak aktywnych tur zapisów z dostępem.' };
        const kodToPicks = new Map();
        (picks || []).forEach((p) => {
          const kod = bridge.przKodFromUrl(p.subjectUrl);
          if (!kod) return;
          if (!kodToPicks.has(kod)) kodToPicks.set(kod, []);
          kodToPicks.get(kod).push(p);
        });
        if (!kodToPicks.size) return { error: 'Plan nie zawiera przedmiotów z kodami USOS.' };
        this._plannerRejCache = this._plannerRejCache || {};
        const badges = {};
        const tourLabels = new Set();
        const matchedKods = new Set();
        for (const tour of tours) {
          if (!tour.subjectsUrl) continue;
          const cacheKey = `subj:${tour.rejKod}`;
          let subjects = this._plannerRejCache[cacheKey];
          if (!subjects) {
            const res = await scrape.fetchRejSubjects(adapter, tour.subjectsUrl).catch(() => null);
            subjects = (res && Array.isArray(res.subjects)) ? res.subjects : [];
            this._plannerRejCache[cacheKey] = subjects;
          }
          const byKod = new Map(subjects.map((s) => [s.kod, s]));
          for (const [kod, kodPicks] of kodToPicks) {
            const subj = byKod.get(kod);
            if (!subj || !subj.groupsUrl) continue;
            let rejGroups = this._plannerRejCache[`grp:${subj.groupsUrl}`];
            if (rejGroups === undefined) {
              const res = await scrape.fetchRejGroups(adapter, subj.groupsUrl).catch(() => null);
              rejGroups = (res && res.supported) ? res : null;
              this._plannerRejCache[`grp:${subj.groupsUrl}`] = rejGroups;
            }
            if (!rejGroups) continue;
            matchedKods.add(kod);
            tourLabels.add(tour.sectionCode);
            const subjMatch = bridge.matchSubject(kodPicks, subj);
            kodPicks.forEach((p) => {
              if (badges[p.key]) return;
              const hits = bridge.matchPickGroups(p, rejGroups);
              const hit = hits.find((h) => h.sessionMatch) || hits[0];
              const base = {
                tourKey: tour.rejKod,
                kod,
                cykl: (subj.cycles && subj.cycles[0]) || '',
                title: subj.name || p.subjectName,
                groupsUrl: subj.groupsUrl,
                registerUrl: tour.registerUrl,
                enrollment: subjMatch ? subjMatch.enrollment : null,
              };
              if (!hit) {
                // Subject is in the tour but this exact group isn't (label
                // skew the soft match couldn't bridge, group renumbered…).
                // Still a click-through: the block opens the group list,
                // just without seat numbers (known:false renders the plain
                // "zapisy" tag instead of "3/20" / "pełna").
                badges[p.key] = { ...base, nr: null, sessionMatch: false, rejSession: null, seatsText: null, full: false, known: false };
                return;
              }
              const seats = hit.seats;
              badges[p.key] = {
                ...base,
                nr: hit.group.nr,
                sessionMatch: !!hit.sessionMatch,
                rejSession: hit.group.session || null,
                // Counters show TAKEN seats ("23/26", never "3 wolne"):
                // a fuller group reads as more urgent, and "0/20" can no
                // longer be mistaken for "nothing there".
                seatsText: seats.known ? (seats.full ? 'pełna' : `${seats.taken}/${seats.cap}`) : null,
                taken: seats.known ? seats.taken : null,
                cap: seats.known ? seats.cap : null,
                full: !!seats.full,
                known: !!seats.known,
              };
            });
          }
          if (this.state.view !== 'planer') return null;
        }
        return { badges, tourLabels, matchedKods, totalKods: kodToPicks.size };
      } catch (e) {
        return { error: 'Nie udało się sprawdzić miejsc — spróbuj ponownie.' };
      }
    }

    // Tour subject matching one planner candidate: prz_kod first, then
    // normalized name (stage subject URLs don't always carry prz_kod).
    // Pure lookup over the cached tour subjects — no fetching.
    plannerMatchTourSubject(candidate, tourSubjs) {
      const all = this.plannerMatchTourSubjects(candidate, tourSubjs);
      return all.length ? all[0] : null;
    }

    // All matching tour subjects, best first: kod, then exact name, then
    // name containment either way (tour vs catalog names skew — suffixes
    // like "(L)", abbreviations). Exact is always tried everywhere before
    // any fuzzy hit, so "Fizyka 1A" never loses to "Fizyka 1". Deduped.
    plannerMatchTourSubjects(candidate, tourSubjs) {
      const bridge = window.USOSPP_ZAPISY_PLAN;
      const out = [];
      const seen = new Set();
      if (!bridge || !candidate) return out;
      const list = Array.isArray(tourSubjs) ? tourSubjs : [];
      const push = (t) => {
        if (t && !seen.has(t)) { seen.add(t); out.push(t); }
      };
      const kod = bridge.przKodFromUrl(candidate.detailsUrl || '');
      if (kod) {
        const byKod = list.find((t) => t && t.kod === kod);
        if (byKod) push(byKod);
      }
      const wantName = bridge.normType(candidate.name || '');
      if (wantName) {
        list.forEach((t) => {
          if (t && bridge.normType(t.name || '') === wantName) push(t);
        });
        list.forEach((t) => {
          const n = t ? bridge.normType(t.name || '') : '';
          if (n && (n.includes(wantName) || wantName.includes(n))) push(t);
        });
      }
      return out;
    }

    plannerCachedTourSubjects() {
      const out = [];
      Object.entries(this._plannerRejCache || {}).forEach(([k, v]) => {
        if (k.startsWith('subj:') && Array.isArray(v)) v.forEach((t) => out.push(t));
      });
      return out;
    }

    // Seat class of a planner candidate subject in Zapisy mode, from cached
    // tour data: 'free' (some group with free seats), 'full' (all known
    // groups full), 'unknown' (not in tour / no data — never filtered on,
    // only dimmed with a tag explaining why).
    plannerCandidateSeatClass(s) {
      const bridge = window.USOSPP_ZAPISY_PLAN;
      const cache = this._plannerRejCache;
      if (!bridge || !cache) return { cls: 'unknown', tag: null };
      const matches = this.plannerMatchTourSubjects(s, this.plannerCachedTourSubjects());
      if (!matches.length) return { cls: 'unknown', tag: 'spoza tury' };
      // A subject may sit in several tours — free anywhere counts; data
      // missing everywhere (but matched) is "brak danych", not "full".
      const withData = matches.filter((m) => m.groupsUrl && (cache[`grp:${m.groupsUrl}`] || {}).supported);
      if (!withData.length) return { cls: 'unknown', tag: 'brak danych' };
      let anyKnown = false;
      let anyFree = false;
      withData.forEach((m) => {
        const rejGroups = cache[`grp:${m.groupsUrl}`];
        (rejGroups.sections || []).forEach((sec) => (sec.groups || []).forEach((g) => {
          const st = bridge.groupSeatState(g);
          if (!st.known) return;
          anyKnown = true;
          if (!st.full) anyFree = true;
        }));
      });
      if (anyFree) return { cls: 'free', tag: null };
      if (anyKnown) return { cls: 'full', tag: 'brak miejsc' };
      return { cls: 'unknown', tag: 'brak danych' };
    }

    // After the zapisy-mode check fills the tour-subject cache, pull group
    // lists for candidate subjects matched to a tour (bounded: matched
    // only, cached for the page lifetime) so the list filter and ghost
    // dimming have data beyond the picked groups.
    async plannerPrefetchCandidateSeats() {
      if (this._candidateSeatsFetching) return;
      const bridge = window.USOSPP_ZAPISY_PLAN;
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const adapter = adapters && adapters.selectAdapter ? adapters.selectAdapter() : null;
      if (!bridge || !scrape || !adapter) return;
      const cache = this._plannerRejCache || {};
      const tourSubjs = this.plannerCachedTourSubjects();
      if (!tourSubjs.length) return;
      const urls = new Set();
      (this.plannerSubjectCandidates.subjects || []).forEach((s) => {
        const subj = this.plannerMatchTourSubject(s, tourSubjs);
        if (subj && subj.groupsUrl && cache[`grp:${subj.groupsUrl}`] === undefined) urls.add(subj.groupsUrl);
      });
      if (!urls.size) return;
      this._candidateSeatsFetching = true;
      try {
        await Promise.all([...urls].map(async (groupsUrl) => {
          const res = await scrape.fetchRejGroups(adapter, groupsUrl).catch(() => null);
          this._plannerRejCache[`grp:${groupsUrl}`] = (res && res.supported) ? res : null;
        }));
      } finally {
        this._candidateSeatsFetching = false;
        if (this.state.view === 'planer') this.setPlannerState({});
      }
    }

    // Seat state of one preview candidate group, from the cached tour
    // groups: {full, known, seatsText} or null when uncovered. The subject
    // match is kod-first (detailsUrl), name-exact, then name containment —
    // shared with the candidate list via plannerMatchTourSubjects — and the
    // first tour WITH usable group data wins (a name hit without data never
    // blocks a later tour that has it). sessions are the candidate's real
    // meetings: the bridge's soft type-match (catalog "Ćwiczenia, 30 godzin"
    // vs tour "Ćwiczenia") only counts with a confirmed sessionMatch, so
    // ghosts must bring their sessions — an empty list would veto every
    // soft match. Ghosts are hints; exact numbers live one click away in
    // Zapisy.
    plannerCandSeats(subjectName, classTypeLabel, nr, subjectDetailsUrl, sessions) {
      const bridge = window.USOSPP_ZAPISY_PLAN;
      const cache = this._plannerRejCache;
      if (!bridge || !cache || !subjectName) return null;
      const matches = this.plannerMatchTourSubjects(
        { name: subjectName, detailsUrl: subjectDetailsUrl || '' },
        this.plannerCachedTourSubjects());
      for (const subj of matches) {
        if (!subj || !subj.groupsUrl) continue;
        const rejGroups = cache[`grp:${subj.groupsUrl}`];
        if (!rejGroups || !rejGroups.supported) continue;
        const hits = bridge.matchPickGroups(
          { classTypeLabel, nr: String(nr), sessions: Array.isArray(sessions) ? sessions : [] }, rejGroups);
        const hit = hits.find((h) => String(h.group.nr) === String(nr));
        if (!hit) continue;
        const st = hit.seats || {};
        return {
          full: !!st.full,
          known: !!st.known,
          seatsText: st.known && !st.full && Number.isInteger(st.taken) ? `${st.taken}/${st.cap}` : null,
        };
      }
      return null;
    }

    // Clicking a badged grid block jumps to direction B (zapisGrupy) with
    // the block's own group pre-highlighted (see zapisGrupyHighlightNr).
    // Grid block clicks never navigate: both modes focus the subject and
    // toggle its free/all-slot ghosts (freeOnly follows Zapisy mode).
    // Navigation to Zapisy lives only in explicit buttons ("Zapisz się →",
    // tour banner, subject lists).
    plannerGridBlockAction({ top, height, entryStyle, key, subjectUrl }) {
      if (subjectUrl) {
        const zapisy = !!this.state.plannerZapisyMode;
        const keyAttr = key ? ` data-key="${esc(key)}"` : '';
        const preview = key ? 'Preview' : 'Subject';
        return {
          attr: ` data-action="plannerFocus${preview}" data-url="${esc(subjectUrl)}"${keyAttr} style="top:${top}px;height:${height}px;${entryStyle}cursor:pointer;"`,
          note: key
            ? (zapisy ? ' — kliknij, aby pokazać wolne terminy' : ' — kliknij, aby pokazać terminy')
            : ' — kliknij, aby pokazać na liście',
        };
      }
      return { attr: ` style="top:${top}px;height:${height}px;${entryStyle}"`, note: '' };
    }

    // Direction C of the Plan × Zapisy bridge: a thin banner over the plan
    // naming live tours that cover the MAIN plan's subjects. Once per page
    // lifetime, only while the planner is actually open, and reusing
    // direction A's subject cache — the calendar refresh (1 GET) plus one
    // subjects fetch per active tour, same order of magnitude as opening
    // the Zapisy list itself.
    async ensurePlannerTourBanner() {
      if (this._tourBannerTried || this.state.plannerTourBanner) return;
      this._tourBannerTried = true;
      const bridge = window.USOSPP_ZAPISY_PLAN;
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!bridge || !scrape || !adapters) return;
      try {
        const main = await this.getMainPlanRecord();
        if (!main || !(main.picks || []).length) return;
        const mainKods = new Set(main.picks.map((p) => bridge.przKodFromUrl(p.subjectUrl)).filter(Boolean));
        if (!mainKods.size) return;
        const adapter = adapters.selectAdapter();
        const cal = await scrape.refreshPersonalCalendar(adapter);
        const sections = (cal && Array.isArray(cal.sections) ? cal.sections : []);
        const now = Date.now();
        this._plannerRejCache = this._plannerRejCache || {};
        const tours = [];
        for (const sec of sections) {
          if (!sec.subjectsUrl) continue;
          const liveRounds = (sec.rounds || []).filter((r) => {
            if (!r.rejKod || !r.hasAccess) return false;
            if (r.endsAt) {
              const end = Date.parse(String(r.endsAt).replace(' ', 'T'));
              if (!Number.isNaN(end) && end < now) return false;
            }
            return true;
          });
          if (!liveRounds.length) continue;
          const firstRound = liveRounds[0];
          const cacheKey = `subj:${firstRound.rejKod}`;
          let subjects = this._plannerRejCache[cacheKey];
          if (!subjects) {
            const res = await scrape.fetchRejSubjects(adapter, sec.subjectsUrl).catch(() => null);
            subjects = (res && Array.isArray(res.subjects)) ? res.subjects : [];
            this._plannerRejCache[cacheKey] = subjects;
          }
          const covered = subjects.filter((s) => mainKods.has(s.kod));
          if (!covered.length) continue;
          if (this.state.view !== 'planer') return;
          const endM = String(firstRound.endsAt || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
          tours.push({
            rejKod: firstRound.rejKod,
            code: sec.code || firstRound.rejKod,
            title: sec.title || '',
            endsText: endM ? `${endM[3]}.${endM[2]}, ${endM[4]}:${endM[5]}` : null,
            endsRel: this.relZapisTime(firstRound.startsAt, firstRound.endsAt),
            subjectCount: covered.length,
            mainPlanName: main.name,
            subjectsUrl: sec.subjectsUrl,
            registerUrl: firstRound.registerUrl || null,
            planUrls: Array.isArray(sec.planUrls) ? sec.planUrls : [],
          });
        }
        if (this.state.view === 'planer') {
          this.setPlannerState({ plannerTourBanner: { tours } });
        } else {
          this.state.plannerTourBanner = { tours };
        }
      } catch (e) { /* banner stays absent — never an error state */ }
    }

    renderPlannerTourBanner() {
      const banner = this.state.plannerTourBanner;
      if (!banner || !(banner.tours || []).length) return '';
      return `
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
          ${banner.tours.map((t, i) => `
            <div class="usospp-planner-tourbanner">
              <span>🟠 <strong>${esc(t.code)}</strong>${t.endsText ? ` · do ${esc(t.endsText)}${t.endsRel ? ` (${esc(t.endsRel)})` : ''}` : ''} · dotyczy ${esc(String(t.subjectCount))} ${t.subjectCount === 1 ? 'przedmiotu' : (t.subjectCount % 10 >= 2 && t.subjectCount % 10 <= 4 && (t.subjectCount % 100 < 12 || t.subjectCount % 100 > 14) ? 'przedmioty' : 'przedmiotów')} z „${esc(t.mainPlanName)}”</span>
              <a data-action="plannerOpenTourBanner" data-index="${i}" style="font-weight:600;white-space:nowrap;">Przejdź do tury →</a>
            </div>
          `).join('')}
        </div>
      `;
    }

    plannerOpenTourBanner(index) {
      const banner = this.state.plannerTourBanner;
      const t = banner && (banner.tours || [])[index];
      if (!t) return;
      this.openZapisTura({
        key: t.rejKod,
        title: t.title,
        code: t.code,
        subjectsUrl: t.subjectsUrl,
        registerUrl: t.registerUrl,
        planUrls: t.planUrls,
      });
    }

    // "Dodaj przedmiot spoza listy" — lets a student search the full USOS
    // catalog for a subject their programme stage didn't surface (e.g. WF,
    // a language, an elective from another kierunek) instead of being
    // limited to stageSubjects. Toggling the box closed also drops any
    // in-progress search text/results, same as clearSearch() does for the
    // topbar search.
    plannerToggleCustomSearch() {
      this.setPlannerState((s) => {
        const next = !s.plannerCustomSearchOpen;
        return next
          ? { plannerCustomSearchOpen: true }
          : { plannerCustomSearchOpen: false, plannerCustomSearchQuery: '', plannerCustomSearchResults: null, plannerCustomSearchLoading: false };
      });
    }

    // Picking a search result behaves differently depending on which mode
    // the search box was opened from (the box itself — plannerCustomSearch*
    // state — is shared, see renderPlannerCustomSearch). In manual mode it
    // hands the URL to plannerToggleSubject, which is fully generic over
    // `url` and doesn't care whether it came from stageSubjects or a catalog
    // search. In automatic mode there's no per-subject configurator to open
    // — the algorithm picks the group — so it's just added straight into
    // plannerAutoSelected, same as ticking an existing checkbox. Either way
    // the search box's own query/results are cleared so the dropdown
    // collapses, but stays open (plannerCustomSearchOpen) in case the
    // student wants to add a second subject that wasn't on the list either.
    plannerSelectSearchSubject(url, name) {
      if (!url) return;
      this.setPlannerState({ plannerCustomSearchQuery: '', plannerCustomSearchResults: null, plannerCustomSearchLoading: false });
      if (this.state.plannerMode === 'auto') {
        this.plannerAutoToggleSubject(url, name);
        return;
      }
      // Remember the custom subject on this plan (see plannerCustomSubjects)
      // so it stays listed even after its last pick is removed.
      const planId = this.state.plannerActivePlanId;
      const cid = subjectId(url);
      this.setPlannerState((s) => {
        const planMem = { ...((s.plannerCustomSubjects || {})[planId] || {}) };
        if (!planMem[cid]) planMem[cid] = { subjectUrl: url, subjectName: name };
        return { plannerCustomSubjects: { ...(s.plannerCustomSubjects || {}), [planId]: planMem } };
      });
      this.plannerToggleSubject(url);
    }

    // ---- automatic generator ------------------------------------------

    plannerSetMode(mode) {
      if (mode !== 'manual' && mode !== 'auto') return;
      this.setPlannerState({ plannerMode: mode });
    }

    plannerAutoToggleSubject(url, name) {
      if (!url) return;
      const id = subjectId(url);
      this.setPlannerState((s) => {
        const next = { ...s.plannerAutoSelected };
        if (next[id]) delete next[id];
        else next[id] = { subjectUrl: url, subjectName: name };
        return { plannerAutoSelected: next };
      });
    }

    // Generator default: every candidate subject starts checked ("Przedmioty
    // do uwzględnienia (X)" reads as all-in until the student opts out).
    // Union-add only — never removes, never re-checks a manually unticked
    // subject. Runs once at construction (stage subjects are already in
    // this.data) and again from applyPlannerData (manual picks arrive async
    // and contribute custom candidates). No rendering here: the constructor
    // hasn't rendered yet, and applyPlannerData's own setPlannerState right
    // below picks the change up.
    seedPlannerAutoSelected() {
      const { subjects } = this.plannerSubjectCandidates;
      const ids = subjects.map((s) => subjectId(s.detailsUrl)).filter(Boolean).sort();
      const sig = ids.join('|');
      if (!sig || sig === this.state.plannerAutoSeedSig) return;
      const next = { ...this.state.plannerAutoSelected };
      subjects.forEach((s) => {
        const id = subjectId(s.detailsUrl);
        if (id && !next[id]) next[id] = { subjectUrl: s.detailsUrl, subjectName: s.name || '' };
      });
      Object.assign(this.state, { plannerAutoSelected: next, plannerAutoSeedSig: sig });
    }

    plannerAutoAddBlock() {
      const { plannerAutoBlockDraftDay: day, plannerAutoBlockDraftStart: start, plannerAutoBlockDraftEnd: end } = this.state;
      if (!day || !start || !end) return;
      this.setPlannerPrefsState((s) => ({
        plannerAutoBlockedWindows: [...s.plannerAutoBlockedWindows, { day, start, end }],
        plannerAutoBlockDraftStart: '',
        plannerAutoBlockDraftEnd: '',
      }));
    }

    plannerAutoRemoveBlock(index) {
      this.setPlannerPrefsState((s) => ({ plannerAutoBlockedWindows: s.plannerAutoBlockedWindows.filter((_, i) => i !== index) }));
    }

    // Ensures every selected subject's page AND every one of its class
    // types' groups are cached (reusing the SAME plannerSubjectCache/
    // plannerGroupsCache the manual flow already lazily fills — see
    // plannerToggleSubject/plannerLoadGroups — so nothing already loaded
    // manually gets re-fetched), then builds one CSP variable per (subject,
    // class type) with its domain attached. Picks the same "first cycle
    // that isn't finished" a student would see expanding the subject
    // manually (renderPlannerSubjectPanel), for consistency.
    async plannerAutoFetchAll() {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) return { ok: false };
      const adapter = adapters.selectAdapter();
      if (!adapter) return { ok: false };
      const selected = Object.values(this.state.plannerAutoSelected);
      if (!selected.length) return { ok: false };

      const missingSubjects = selected.filter((s) => !this.state.plannerSubjectCache[s.subjectUrl]);
      if (missingSubjects.length) {
        const docs = await Promise.all(missingSubjects.map((s) => scrape.fetchDoc(s.subjectUrl)));
        const patch = {};
        missingSubjects.forEach((s, i) => {
          const doc = docs[i];
          const details = doc ? adapter.getSubjectPage(doc) : null;
          patch[s.subjectUrl] = (details && details.supported) ? details : { supported: false };
        });
        this.setPlannerState((st) => ({ plannerSubjectCache: { ...st.plannerSubjectCache, ...patch } }));
      }

      const variables = [];
      selected.forEach((s) => {
        const details = this.state.plannerSubjectCache[s.subjectUrl];
        if (!details || !details.supported) return;
        const relevantCycles = details.cycles.filter((c) => !/zakończon/i.test(c.cycleState || ''));
        const cycle = (relevantCycles.length ? relevantCycles : details.cycles)[0];
        if (!cycle) return;
        (cycle.classTypes || []).forEach((ct) => {
          if (!ct.groupsUrl) return;
          variables.push({
            subjectUrl: s.subjectUrl,
            subjectName: details.subjectName || s.subjectName,
            cycleName: cycle.cycleName,
            classTypeLabel: ct.label,
            classTypeShort: shortClassType(ct.label),
            groupsUrl: ct.groupsUrl,
          });
        });
      });

      const missingGroupsUrls = [...new Set(variables.map((v) => v.groupsUrl))].filter((u) => !this.state.plannerGroupsCache[u]);
      if (missingGroupsUrls.length) {
        const docs = await Promise.all(missingGroupsUrls.map((u) => scrape.fetchDoc(u)));
        const patch = {};
        missingGroupsUrls.forEach((u, i) => {
          const doc = docs[i];
          const data = doc ? adapter.getClassGroups(doc) : { supported: false, groups: [] };
          patch[u] = { loading: false, data };
        });
        this.setPlannerState((st) => ({ plannerGroupsCache: { ...st.plannerGroupsCache, ...patch } }));
      }

      const finalVariables = variables.map((v) => {
        const cached = this.state.plannerGroupsCache[v.groupsUrl];
        return { ...v, groups: (cached && cached.data && cached.data.groups) || [] };
      });
      return { ok: finalVariables.length > 0, variables: finalVariables };
    }

    // Kicks off fetch → generate. Yields a frame between each state
    // transition (setTimeout after requestAnimationFrame) so the "wczytywanie
    // grup…"/"generowanie…" states actually paint before the heavy,
    // synchronous CSP search runs on the main thread — see the plan doc's
    // note on why this is a cheap, worthwhile insurance even with a
    // sub-250ms search budget.
    // Direction D, generator half: removes tour-confirmed-full groups from
    // the CSP domains (see plannerAutoOnlyFreeSeats). Unknown seat state
    // never filters — a group USOS didn't report on stays eligible. Returns
    // { variables, seatMap } for the search plus the popover "pełna" tags,
    // or { failure } when the filter empties a variable (surfaced as a
    // kind:'seats' message naming the subject, so the student knows exactly
    // which toggle to loosen). On tour-fetch errors the search proceeds
    // UNFILTERED — the generator must not block on a hiccup in tour data.
    async applyFreeSeatsConstraint(variables) {
      const bridge = window.USOSPP_ZAPISY_PLAN;
      if (!bridge) return { variables, seatMap: {} };
      const pseudoPicks = [];
      variables.forEach((v) => {
        const kod = bridge.przKodFromUrl(v.subjectUrl);
        if (!kod) return;
        (v.groups || []).forEach((g) => {
          pseudoPicks.push({
            key: `auto||${kod}||${v.classTypeLabel}||${g.nr}`,
            subjectUrl: v.subjectUrl,
            classTypeLabel: v.classTypeLabel,
            nr: g.nr,
            sessions: g.sessions || [],
          });
        });
      });
      const res = await this.fetchRejSeatsForPicks(pseudoPicks);
      if (!res || res.error) return { variables, seatMap: {} };
      const seatMap = {};
      Object.entries(res.badges).forEach(([pkey, b]) => {
        const parts = String(pkey).split('||');
        seatMap[`${b.kod}||${bridge.normType(parts[2] || '')}||${String(b.nr)}`] = {
          full: b.full,
          known: b.known,
          seatsText: b.seatsText,
        };
      });
      const emptied = [];
      const filtered = variables.map((v) => {
        const kod = bridge.przKodFromUrl(v.subjectUrl);
        const kept = (v.groups || []).filter((g) => {
          const hit = kod ? seatMap[`${kod}||${bridge.normType(v.classTypeLabel)}||${String(g.nr)}`] : null;
          return !(hit && hit.known && hit.full);
        });
        if (kept.length === 0 && (v.groups || []).length > 0) {
          emptied.push(`${v.subjectName} — ${v.classTypeLabel}`);
        }
        return { ...v, groups: kept };
      });
      if (emptied.length) {
        return {
          failure: {
            kind: 'seats',
            message: `Wszystkie grupy są pełne wg zapisów dla: ${emptied.join('; ')}. Wyłącz „Tylko grupy z wolnymi miejscami” albo poczekaj na kolejną turę.`,
          },
        };
      }
      return { variables: filtered, seatMap };
    }

    // "pełna" / free-seats tag for a group row, popover or ghost box —
    // driven by plannerAutoSeatMap (filled by generate-with-constraint).
    // Silent when the group was never checked: no data, no tag, no guessing.
    seatTagHtml(varKey, label, nr) {
      const map = this.state.plannerAutoSeatMap;
      const bridge = window.USOSPP_ZAPISY_PLAN;
      if (!map || !bridge) return '';
      const kod = String(varKey || '').split('::')[0];
      const hit = map[`${kod}||${bridge.normType(label)}||${String(nr)}`];
      if (!hit || !hit.known) return '';
      if (hit.full) return ` <span class="usospp-tt-entry-rej full">pełna</span>`;
      return ` <span class="usospp-tt-entry-rej">${esc(hit.seatsText || '')}</span>`;
    }

    async plannerAutoGenerate() {
      if (this.state.plannerAutoStatus === 'fetching' || this.state.plannerAutoStatus === 'generating') return;
      if (!Object.keys(this.state.plannerAutoSelected).length) return;

      this.setPlannerState({ plannerAutoStatus: 'fetching', plannerAutoCandidates: [], plannerAutoFailure: null });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

      const { ok, variables } = await this.plannerAutoFetchAll();
      if (!ok) {
        this.setPlannerState({ plannerAutoStatus: 'failed', plannerAutoFailure: { kind: 'fetch', message: 'Nie udało się wczytać grup zajęć dla wybranych przedmiotów — spróbuj ponownie.' } });
        return;
      }

      let searchVariables = variables;
      if (this.state.plannerAutoOnlyFreeSeats) {
        const constrained = await this.applyFreeSeatsConstraint(variables);
        if (this.state.view !== 'planer') return;
        if (constrained.failure) {
          this.setPlannerState({ plannerAutoStatus: 'failed', plannerAutoFailure: constrained.failure });
          return;
        }
        searchVariables = constrained.variables;
        this.setPlannerState({ plannerAutoSeatMap: constrained.seatMap });
      } else if (Object.keys(this.state.plannerAutoSeatMap || {}).length) {
        // Constraint off = zero tour requests: drop tags from the previous
        // constrained run instead of showing aging data.
        this.setPlannerState({ plannerAutoSeatMap: {} });
      }

      this.setPlannerState({ plannerAutoStatus: 'generating' });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

      const engine = window.USOSPP_GENERATOR;
      if (!engine) {
        this.setPlannerState({ plannerAutoStatus: 'failed', plannerAutoFailure: { kind: 'error', message: 'Silnik generatora nie jest dostępny.' } });
        return;
      }

      const hardConstraints = {
        earliestStart: this.state.plannerAutoEarliestStart || null,
        latestEnd: this.state.plannerAutoLatestEnd || null,
        blockedWindows: this.state.plannerAutoBlockedWindows,
      };
      const preferences = {
        maxPerDay: this.state.plannerAutoMaxPerDay ? parseInt(this.state.plannerAutoMaxPerDay, 10) : null,
        preferredDays: this.state.plannerAutoPreferredDays ? parseInt(this.state.plannerAutoPreferredDays, 10) : null,
        minimizeGaps: this.state.plannerAutoMinimizeGaps,
      };

      const result = engine.generate({ variables: searchVariables, hardConstraints, preferences });
      if (result.ok) {
        this.setPlannerState({ plannerAutoStatus: 'done', plannerAutoCandidates: result.candidates, plannerAutoActiveCandidateIndex: 0, plannerAutoFailure: null });
      } else {
        this.setPlannerState({ plannerAutoStatus: 'failed', plannerAutoFailure: result });
      }
    }

    // "Użyj tego planu" — saves the chosen candidate as a brand-new saved
    // plan (same mechanism as plannerNewPlan/planner-store.js's MAX_PLANS
    // cap), never merged into whatever's currently active. Switches back to
    // manual mode on success so the result immediately shows in the normal,
    // fully-editable planner — confirmed with the user: a generated plan is
    // just an ordinary plan afterward, nothing special about it.
    plannerUseGeneratedCandidate(index) {
      const candidate = this.state.plannerAutoCandidates[index];
      const planner = window.USOSPP_PLANNER;
      if (!candidate || !planner) return;
      if (this.state.plannerPlans.length >= planner.MAX_PLANS) {
        this.setPlannerState({ plannerAutoFailure: { kind: 'plan-limit', message: `Masz już zapisanych ${planner.MAX_PLANS} planów — usuń jeden z istniejących w sekcji „Moje plany”, żeby zapisać tę propozycję.` } });
        return;
      }
      const picks = candidate.assignment.map(pickFromAssignment);
      planner.setData((data) => {
        if (data.plans.length >= planner.MAX_PLANS) return data;
        const plan = { id: planner.genId(), name: `Wygenerowany plan ${data.plans.length + 1}`, picks };
        return { plans: [...data.plans, plan], activePlanId: plan.id };
      }).then((next) => {
        this.applyPlannerSwitchResult(next);
        this.setPlannerState({ plannerMode: 'manual', plannerAutoCandidates: [], plannerAutoStatus: 'idle', plannerAutoFailure: null });
      });
    }

    // Warms plannerSubjectCache for subjects that already have picks but
    // no cached page (e.g. right after a reload) — so the fractional
    // status dots (see plannerSubjectTypeProgress) are correct without
    // expanding every subject first. Bounded to picked subjects only, one
    // repaint total, in-flight deduped. Never writes failure markers (an
    // expand would then trust them and skip its own fetch).
    plannerPrefetchPickedSubjects() {
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) return;
      const adapter = adapters.selectAdapter ? adapters.selectAdapter() : null;
      if (!adapter) return;
      this._plannerSubjectPrefetch = this._plannerSubjectPrefetch || new Set();
      const urls = [...new Set(this.state.plannerPicks.map((p) => p.subjectUrl).filter(Boolean))];
      const missing = urls.filter((u) => !this.state.plannerSubjectCache[u] && !this._plannerSubjectPrefetch.has(u));
      if (!missing.length) return;
      missing.forEach((u) => this._plannerSubjectPrefetch.add(u));
      Promise.all(missing.map((url) => scrape.fetchDoc(url)
        .then((doc) => ({ url, details: doc && adapter ? adapter.getSubjectPage(doc) : null }))
        .catch(() => null)))
        .then((results) => {
          const patch = {};
          (results || []).forEach((r) => {
            this._plannerSubjectPrefetch.delete(r && r.url);
            if (r && r.details && r.details.supported) patch[r.url] = r.details;
          });
          if (!Object.keys(patch).length) return;
          this.setPlannerState((s) => ({ plannerSubjectCache: { ...s.plannerSubjectCache, ...patch } }));
        });
    }

    // Canonical list URL for a subject: the row's detailsUrl from
    // plannerSubjectCandidates with the same subjectId(). A block on the
    // grid (or a pick restored from storage) may carry a stale `callback=`
    // token while the freshly-fetched stage list holds a new one — raw
    // strings differ, the subject is the same. Everything expansion
    // compares (expandedUrl, row attribute, subject cache) must go through
    // here, otherwise a stage-listed subject stops expanding while customs
    // (token-less, stable URLs) keep working. Falls back to the given URL
    // when the subject isn't on the list (e.g. a later-cycle pick).
    plannerCanonicalSubjectUrl(url) {
      if (!url) return url;
      const id = subjectId(url);
      if (!id) return url;
      const hit = (this.plannerSubjectCandidates.subjects || []).find((s) => s.detailsUrl && subjectId(s.detailsUrl) === id);
      return (hit && hit.detailsUrl) || url;
    }

    // Expands/collapses a subject's class-type configurator in the planner's
    // subject list. Pre-fills the draft selection from whatever's already
    // saved for this subject, so reopening it to tweak one class type
    // doesn't blank out the others; fetches the subject's cycle/class-type
    // data on first expand only (cached per session after that).
    // Resolves the list's canonical URL for the subject first (see
    // plannerCanonicalSubjectUrl) — a saved block may carry a stale
    // `callback=` token while the list holds a fresh one, and raw-string
    // identity is what the row, the cache and the scroll lookup compare.
    plannerToggleSubject(url) {
      if (!url) return;
      url = this.plannerCanonicalSubjectUrl(url);
      if (this.state.plannerExpandedUrl === url) {
        this.setPlannerState({ plannerExpandedUrl: null, plannerPreviewKeys: {} });
        return;
      }
      const existing = {};
      this.state.plannerPicks.forEach((p) => {
        if (subjectId(p.subjectUrl) === subjectId(url)) existing[p.key] = { ...p };
      });
      // One state update (one DOM patch) covers both "expand + prefill" and,
      // if needed, "start loading" — issuing them separately made every
      // first-time expand redraw the planner (and, before setPlannerState
      // existed, the whole app) twice back to back.
      const needsFetch = !this.state.plannerSubjectCache[url];
      this.setPlannerState({
        plannerExpandedUrl: url,
        plannerDraftSelection: existing,
        // A brand-new configurator starts with a clean preview state — the
        // previous subject's "podgląd w planie" ghosts would otherwise linger
        // on the grid with no visible way to switch them off (their toggle
        // buttons just left the panel together with the old subject).
        plannerPreviewKeys: {},
        plannerSubjectLoading: needsFetch ? url : this.state.plannerSubjectLoading,
      });
      if (!needsFetch) return;
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) return;
      scrape.fetchDoc(url)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const details = doc && adapter ? adapter.getSubjectPage(doc) : null;
          this.setPlannerState((s) => {
            if (s.plannerSubjectLoading !== url) return {};
            return {
              plannerSubjectLoading: null,
              plannerSubjectCache: { ...s.plannerSubjectCache, [url]: (details && details.supported) ? details : { supported: false } },
            };
          });
          // A block-click preview (plannerTogglePreviewForKey) may be
          // waiting on exactly this configurator — complete it now.
          if (this._pendingPreview) {
            const pk = this._pendingPreview;
            this._pendingPreview = null;
            this.plannerTogglePreviewForKey(pk.key, pk.freeOnly);
          }
        })
        .catch(() => {
          this.setPlannerState((s) => (s.plannerSubjectLoading === url
            ? { plannerSubjectLoading: null, plannerSubjectCache: { ...s.plannerSubjectCache, [url]: { supported: false } } }
            : {}));
        });
    }

    // Clicking a block on the preview grid expands its subject in the
    // left list and scrolls to it — so a block can be traced back to the
    // group rows it came from. A different subject goes through the exact
    // same expand path as a manual toggle (including clearing the preview,
    // per the focus decision); an already-expanded one just scrolls.
    // setPlannerState patches synchronously, so the row can be queried
    // right away — unless the subject list itself never loaded, in which
    // case there's nothing to scroll to and we stop after expanding.
    plannerFocusSubject(url) {
      if (!url) return;
      url = this.plannerCanonicalSubjectUrl(url);
      if (this.state.plannerExpandedUrl !== url) this.plannerToggleSubject(url);
      if (!this.root || typeof this.root.querySelector !== 'function') return;
      let row = null;
      try {
        row = this.root.querySelector(`[data-planner-subject="${url}"]`);
      } catch (e) { row = null; }
      if (!row) return;
      try { row.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { /* ignore */ }
      try {
        row.classList.add('usospp-planner-flash');
        setTimeout(() => { try { row.classList.remove('usospp-planner-flash'); } catch (e) { /* ignore */ } }, 1600);
      } catch (e) { /* ignore */ }
    }

    plannerLoadGroups(groupsUrl) {
      if (!groupsUrl) return;
      const cached = this.state.plannerGroupsCache[groupsUrl];
      if (cached && (cached.loading || cached.data)) return;
this.setPlannerState((s) => ({ plannerGroupsCache: { ...s.plannerGroupsCache, [groupsUrl]: { loading: true, data: null } } }));
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      if (!scrape || !adapters) return;
      scrape.fetchDoc(groupsUrl)
        .then((doc) => {
          const adapter = adapters.selectAdapter();
          const data = doc && adapter ? adapter.getClassGroups(doc) : { supported: false, groups: [] };
          this.setPlannerState((s) => ({ plannerGroupsCache: { ...s.plannerGroupsCache, [groupsUrl]: { loading: false, data } } }));
        })
        .catch(() => {
          this.setPlannerState((s) => ({ plannerGroupsCache: { ...s.plannerGroupsCache, [groupsUrl]: { loading: false, data: { supported: false, groups: [] } } } }));
        });
    }

    // Clicking the radio option that's already active toggles it off
    // instead of just re-selecting the same thing:
    // - if that class type was never actually saved, the draft simply
    //   disappears (nothing to undo, there was nothing committed yet);
    // - if it WAS saved, we don't delete the real pick immediately — we
    //   mark it as pending removal so the grid can show it struck through
    //   until "Dodaj do planu" actually commits the removal. Clicking the
    //   same row again while pending removal re-selects it normally,
    //   which cancels the removal.
    plannerSelectGroup(key, groupsUrl, nr, classTypeLabel) {
      const cached = this.state.plannerGroupsCache[groupsUrl];
      const group = cached && cached.data ? cached.data.groups.find((g) => g.nr === nr) : null;
      if (!group) return;
      const current = this.state.plannerDraftSelection[key];
      const isReselectingActive = current && !current.removed && current.nr === nr;
      if (isReselectingActive) {
        const committedPick = this.state.plannerPicks.find((p) => p.key === key) || null;
        this.setPlannerState((s) => {
          const next = { ...s.plannerDraftSelection };
          if (!committedPick) delete next[key];
          // Odkliknięcie grupy, która nigdy nie była zapisana (draft B przy
          // commicie A), cofa draft do zapisanej grupy zamiast oznaczać B
          // do usunięcia — inaczej komunikat mówił o grupie spoza planu.
          else if (committedPick.nr !== nr) next[key] = { ...committedPick };
          else next[key] = { removed: true, nr, classTypeLabel };
          return { plannerDraftSelection: next };
        });
        return;
      }
      this.setPlannerState((s) => {
        // Committing to a concrete group ends the visual browsing for that
        // class type: with the preview left on, the freshly-chosen draft
        // ghost would keep hiding under the pile of remaining candidate
        // boxes at the same slot.
        const preview = { ...s.plannerPreviewKeys };
        delete preview[key];
        return { plannerDraftSelection: { ...s.plannerDraftSelection, [key]: { ...group, classTypeLabel } }, plannerPreviewKeys: preview };
      });
    }

    // Clicking a struck-through grid block (a committed pick shadowed by a
    // diverging draft — willBeReplaced — or marked for removal —
    // pendingRemoval) undoes the decision: the draft falls back to the
    // committed pick and this class type's preview ghosts go out, so the
    // block reads solid again. Grid counterpart of re-clicking the radio
    // row in the list; without it the struck block could only focus and
    // toggle ghosts, never take the change back.
    plannerRevertDraft(key) {
      if (!key) return;
      const committedPick = this.state.plannerPicks.find((p) => p.key === key) || null;
      this.setPlannerState((s) => {
        const draft = { ...s.plannerDraftSelection };
        if (committedPick) draft[key] = { ...committedPick };
        else delete draft[key];
        const preview = { ...s.plannerPreviewKeys };
        delete preview[key];
        return { plannerDraftSelection: draft, plannerPreviewKeys: preview };
      });
    }

    // Toggles one class type's "podgląd w planie". While on, groups of
    // that class type are drawn on the preview grid as hoverable ghosts
    // (renderPlannerGrid) next to the picks already made — the student can
    // try each group on for size visually before committing to one. In
    // Zapisy mode only free groups ghost (freeOnly + silent seat pull);
    // Planowanie ghosts all. Toggling on also fetches the group list if it
    // isn't cached yet (plannerLoadGroups is idempotent when it is), so
    // entering visual mode is a single click — no need to press
    // "Pokaż grupy" first.
    plannerTogglePreview(key, groupsUrl, classTypeLabel) {
      if (!key || !groupsUrl) return;
      const on = !this.state.plannerPreviewKeys[key];
      const freeOnly = !!this.state.plannerZapisyMode;
      this.setPlannerState((s) => {
        const next = { ...s.plannerPreviewKeys };
        if (on) next[key] = { groupsUrl, classTypeLabel, freeOnly };
        else delete next[key];
        return { plannerPreviewKeys: next };
      });
      if (!on) return;
      this.plannerLoadGroups(groupsUrl);
      this.plannerCheckRejSeats().then(() => this.plannerPrefetchCandidateSeats());
    }

    // Block click (plannerFocusPreview): focus the subject AND toggle
    // ghosts for that exact class type. groupsUrl is resolved from the
    // cached subject configurator — the same source plannerTogglePreview
    // uses — so no new fetching paths. freeOnly (Zapisy mode) shows only
    // free groups; Planowanie shows all.
    plannerTogglePreviewForKey(key, freeOnly = false) {
      if (!key) return;
      if (this.state.plannerPreviewKeys[key]) {
        if (this._pendingPreview && this._pendingPreview.key === key) this._pendingPreview = null;
        this.setPlannerState((s) => {
          const next = { ...s.plannerPreviewKeys };
          delete next[key];
          return { plannerPreviewKeys: next };
        });
        return;
      }
      let found = null;
      Object.entries(this.state.plannerSubjectCache || {}).forEach(([url, details]) => {
        if (found || !details || !details.supported) return;
        (details.cycles || []).forEach((cycle) => {
          (cycle.classTypes || []).forEach((ct) => {
            if (!found && ct.groupsUrl && classTypeKey(url, cycle.cycleName, ct.label) === key) {
              found = { groupsUrl: ct.groupsUrl, classTypeLabel: ct.label };
            }
          });
        });
      });
      if (!found) {
        // Subject configurator not cached yet (first expand still
        // fetching) — retry when it lands (see the fetch completion below).
        this._pendingPreview = { key, freeOnly };
        return;
      }
      this.setPlannerState((s) => {
        // Block-click previews are exclusive: enabling one replaces any
        // other (same subject or not) — otherwise Wykład + Ćwiczenia glow
        // at once with no way to tell which click owns the ghosts. The
        // configurator's own toggles (plannerTogglePreview) still stack.
        const next = {};
        // Block-click previews from Zapisy mode show only free groups (see
        // the entries loop); Planowanie and the configurator's own toggle
        // show all and dim full ones instead.
        next[key] = { ...found, freeOnly };
        return { plannerPreviewKeys: next };
      });
      this.plannerLoadGroups(found.groupsUrl);
      // Ghost counters need tour seat data — pull it silently (no mode
      // change) so free-filtering and N/M tags have coverage.
      this.plannerCheckRejSeats().then(() => this.plannerPrefetchCandidateSeats());
    }

    // Commits every class-type choice made for the currently-expanded
    // subject into the saved plan: a normal draft replaces any prior pick
    // for the same class type (same `key`), and one marked `removed` (see
    // plannerSelectGroup) drops it instead of recreating it. Every other
    // subject's picks are left untouched.
    plannerAddSubject(url, subjectName, cycleName) {
      const draft = this.state.plannerDraftSelection;
      const keys = Object.keys(draft);
      if (!keys.length) return;
      const newPicks = keys
        .filter((key) => !draft[key].removed)
        .map((key) => {
          const g = draft[key];
          return {
            key,
            subjectUrl: url,
            subjectName,
            cycleName,
            classTypeLabel: g.classTypeLabel,
            classTypeShort: shortClassType(g.classTypeLabel),
            nr: g.nr,
            sessions: g.sessions,
            teacher: g.teacher,
            occupancy: g.occupancy,
            detailsUrl: g.detailsUrl,
          };
        });
      const otherPicks = this.state.plannerPicks.filter((p) => !keys.includes(p.key));
      this.savePlannerPicks([...otherPicks, ...newPicks], { plannerExpandedUrl: null, plannerPreviewKeys: {} });
    }

    plannerRemovePick(key) {
      this.savePlannerPicks(this.state.plannerPicks.filter((p) => p.key !== key));
    }

    get plannerPicksBySubject() {
      const map = new Map();
      this.state.plannerPicks.forEach((p) => {
        const id = subjectId(p.subjectUrl);
        if (!map.has(id)) map.set(id, { subjectUrl: p.subjectUrl, subjectName: p.subjectName, picks: [] });
        map.get(id).picks.push(p);
      });
      return [...map.values()];
    }

    // Every subject the planner (manual list AND automatic generator's
    // subject picker) can offer: auto-detected from the student's current
    // programme stage, plus anything added via "Dodaj przedmiot spoza
    // listy" (derived straight from plannerPicks — see renderPlannerBody's
    // former inline version of this, now shared so both modes agree).
    get plannerSubjectCandidates() {
      const stages = this.stageSubjects;
      const stageRanks = stages.map((s) => cycleRank(stageCycleLabel(s)));
      const knownRanks = stageRanks.filter((r) => r !== null);
      const earliestRank = knownRanks.length ? Math.min(...knownRanks) : null;
      const currentStages = earliestRank === null
        ? stages
        : stages.filter((s, i) => stageRanks[i] === null || stageRanks[i] === earliestRank);
      const skippedStages = stages.length - currentStages.length;

      const allSubjects = [];
      const seen = new Set();
      currentStages.forEach((stage) => (stage.sections || []).forEach((section) => (section.subjects || []).forEach((s) => {
        if (!s.detailsUrl || seen.has(s.detailsUrl)) return;
        seen.add(s.detailsUrl);
        allSubjects.push(s);
      })));

      const knownIds = new Set(allSubjects.map((s) => subjectId(s.detailsUrl)));
      const customSubjects = [];
      const seenCustom = new Set();
      this.state.plannerPicks.forEach((p) => {
        const id = subjectId(p.subjectUrl);
        if (knownIds.has(id) || seenCustom.has(id)) return;
        seenCustom.add(id);
        customSubjects.push({ name: p.subjectName, code: '', detailsUrl: p.subjectUrl });
      });
      // Customs remembered from "Dodaj przedmiot spoza listy" (see
      // plannerCustomSubjects): they stay listed with an empty dot even
      // after their last pick is removed. Stage-listed subjects dedup out.
      const mem = ((this.state.plannerCustomSubjects || {})[this.state.plannerActivePlanId] || {});
      Object.values(mem).forEach((m) => {
        if (!m || !m.subjectUrl) return;
        const id = subjectId(m.subjectUrl);
        if (knownIds.has(id) || seenCustom.has(id)) return;
        seenCustom.add(id);
        customSubjects.push({ name: m.subjectName || '', code: '', detailsUrl: m.subjectUrl });
      });

      return { subjects: [...allSubjects, ...customSubjects], autoCount: allSubjects.length, skippedStages };
    }

    // Per-class-type completion of one subject for the status dot in the
    // left list (see renderPlannerSubjectRow): {done, total, perType} with
    // perType = [{label, short, nr|null}]. Null when there are no picks
    // (empty dot — needs no denominator) or the subject page isn't cached
    // yet (binary full dot until plannerPrefetchPickedSubjects fills it).
    // Denominator = class types WITH a group list (only those are
    // choosable); picks matching no actionable type (stale cycle) also
    // fall back to null rather than a misleading empty pie.
    plannerSubjectTypeProgress(url) {
      const id = subjectId(url);
      const picks = this.state.plannerPicks.filter((p) => subjectId(p.subjectUrl) === id);
      if (!picks.length) return null;
      const details = this.state.plannerSubjectCache[url];
      if (!details || !details.supported) return null;
      const relevantCycles = (details.cycles || []).filter((c) => !/zakończon/i.test(c.cycleState || ''));
      const cycle = (relevantCycles.length ? relevantCycles : details.cycles)[0];
      if (!cycle || !Array.isArray(cycle.classTypes) || !cycle.classTypes.length) return null;
      const actionable = cycle.classTypes.filter((ct) => ct.groupsUrl);
      if (!actionable.length) return null;
      const perType = actionable.map((ct) => {
        const key = classTypeKey(url, cycle.cycleName, ct.label);
        const pick = picks.find((p) => p.key === key);
        return { label: ct.label, short: shortClassType(ct.label), nr: pick ? pick.nr : null };
      });
      if (!perType.some((t) => t.nr)) return null;
      return { done: perType.filter((t) => t.nr).length, total: perType.length, perType };
    }

    // Colour is assigned by subject NAME, not by subject id — USOS often
    // splits one real course into separate wykład/ćwiczenia/lab subjects
    // with their own prz_kod (so they're tracked as distinct picks), but
    // they share the exact same displayed name (e.g. two "Fizyka 1A" rows)
    // and a student thinks of them as one course, so they should share a
    // colour. Assigning by position in an alphabetically-sorted list of
    // every name currently in view (rather than hashing the name) avoids
    // two unrelated subjects landing on the same colour by coincidence,
    // for as many distinct subjects as the palette has hues.
    get plannerColorIndex() {
      const names = new Set();
      this.stageSubjects.forEach((stage) => (stage.sections || []).forEach((section) => (section.subjects || []).forEach((s) => {
        if (s.name) names.add(s.name.trim().toLowerCase());
      })));
      this.state.plannerPicks.forEach((p) => {
        if (p.subjectName) names.add(p.subjectName.trim().toLowerCase());
      });
      const map = new Map();
      [...names].sort().forEach((n, i) => map.set(n, i));
      return map;
    }

    plannerColorSeed(name) {
      const key = (name || '').trim().toLowerCase();
      const map = this.plannerColorIndex;
      return map.has(key) ? map.get(key) : hashStr(key);
    }

    handleChange(e) {
      const el = e.target.closest('[data-bind]');
      if (!el) return;
      // The auto-generator's preference fields (time/number inputs) fire
      // 'change' on every native spinner/arrow nudge, not just on blur —
      // routing those through the generic setState below would replay the
      // whole page's fade-in on each one (see setTopbarState's comment for
      // the same issue elsewhere). setPlannerPrefsState only patches that
      // one card.
      if (el.dataset.bind.startsWith('plannerAuto')) {
        this.setPlannerPrefsState({ [el.dataset.bind]: el.value });
        return;
      }
      this.setState({ [el.dataset.bind]: el.value });
    }

    handleInput(e) {
      if (e.target.dataset.action === 'searchInput') this.onSearchInput(e.target.value);
      else if (e.target.dataset.action === 'plannerSearchInput') this.onPlannerSearchInput(e.target.value);
      else if (e.target.dataset.action === 'mapaSearchInput') this.onMapaSearchInput(e.target.value);
      else if (e.target.dataset.action === 'catalogSubjectQueryInput') this.setCatalogSubjectsState({ catalogSubjectQuery: e.target.value });
      else if (e.target.dataset.action === 'katalogPrzedmiotyQueryInput') this.setKatalogPrzedmiotyQueryState({ katalogPrzedmiotyQuery: e.target.value });
      else if (e.target.dataset.action === 'katalogBudynkiQueryInput') this.setKatalogBudynkiQueryState({ katalogBudynkiQuery: e.target.value });
      else if (e.target.dataset.action === 'studenciQueryInput') this.setStudenciQueryState({ studenciQuery: e.target.value });
    }

    handleKeydown(e) {
      if (e.target.dataset.action === 'searchInput' && e.key === 'Escape') {
        this.clearSearch();
        e.target.blur();
      } else if (e.target.dataset.action === 'mapaSearchInput' && e.key === 'Escape') {
        this.mapaClearSearch();
        e.target.blur();
      } else if (e.target.dataset.planRename) {
        // Inline plan-tab rename commit/cancel (see plannerCommitRename).
        if (e.key === 'Enter') this.plannerCommitRename(e.target.dataset.planRename);
        else if (e.key === 'Escape') this.plannerCancelRename();
      }
    }

    // Debounced so we're not firing three requests per keystroke — 3 chars
    // minimum matches the classic <usos-selector> autocomplete's own
    // min-search-length, so we're never querying anything USOS itself
    // wouldn't bother searching for either.
    onSearchInput(value) {
      this.state.searchQuery = value; // the <input> already shows this — no DOM patch needed just for that
      clearTimeout(this._searchDebounce);
      const q = value.trim();
      if (q.length < 3) {
        this.setSearchState({ searchResults: null, searchLoading: false });
        // Two characters are already enough to resolve a campus building
        // (renderSearchResults matches buildings locally) — warm the
        // campus list at that point so those queries can answer too.
        if (q.length === 2) this.ensureMapaData();
        return;
      }
      // Katalog search is about to fire; buildings meanwhile answer from
      // the campus list client-side, so warm it if not loaded yet.
      // ensureMapaData() is idempotent and mostly serves from cache, and
      // its loading state only ever affects the Mapa view's rendering.
      this.ensureMapaData();
      this.setSearchState({ searchLoading: true });
      this._searchDebounce = setTimeout(() => this.runSearch(q), 300);
    }

    async runSearch(query) {
      const scrape = window.USOSPP_SCRAPE;
      if (!scrape) { this.setSearchState({ searchLoading: false }); return; }
      const results = await scrape.searchCatalog(query);
      // The query may have changed (or been cleared) while this was in
      // flight — a stale, slower response landing after a newer one (or
      // after the box was cleared) shouldn't clobber what's now on screen.
      if (this.state.searchQuery.trim() !== query) return;
      this.setSearchState({ searchLoading: false, searchResults: results });
    }

    clearSearch() {
      this.state.searchQuery = '';
      this.setSearchState({ searchResults: null, searchLoading: false });
      const input = this.root.querySelector('[data-search-input]');
      if (input) input.value = '';
    }

    // Same debounce/min-length/staleness-guard shape as onSearchInput/
    // runSearch above, kept as its own state slice (plannerCustomSearch*)
    // rather than reusing searchQuery/searchResults — this box lives inside
    // the planner, not the topbar, and the two shouldn't clobber each
    // other's in-flight query if both happened to be touched.
    onPlannerSearchInput(value) {
      this.state.plannerCustomSearchQuery = value; // the <input> already shows this — no DOM patch needed just for that
      clearTimeout(this._plannerSearchDebounce);
      const q = value.trim();
      if (q.length < 3) {
        this.setPlannerSearchState({ plannerCustomSearchResults: null, plannerCustomSearchLoading: false });
        return;
      }
      this.setPlannerSearchState({ plannerCustomSearchLoading: true });
      this._plannerSearchDebounce = setTimeout(() => this.runPlannerSearch(q), 300);
    }

    async runPlannerSearch(query) {
      const scrape = window.USOSPP_SCRAPE;
      if (!scrape) { this.setPlannerSearchState({ plannerCustomSearchLoading: false }); return; }
      const results = await scrape.searchCatalog(query);
      if (this.state.plannerCustomSearchQuery.trim() !== query) return;
      this.setPlannerSearchState({ plannerCustomSearchLoading: false, plannerCustomSearchResults: results.subjects });
    }

    emitSettings(payload) {
      this.root.dispatchEvent(new CustomEvent('usospp:settings', { detail: payload, bubbles: true }));
    }

    render() {
      const dark = this.settings.darkMode;
      // Fade-in plays only when the view itself changes — data arriving
      // later patches content under data-enter="0" (see setContentState and
      // the zapis/subject fetchers) instead of flashing the whole page.
      const entering = this.state.view !== this._lastRenderedView;
      this._lastRenderedView = this.state.view;
      this.root.innerHTML = `
        <div class="usospp-root" data-theme="${dark ? 'dark' : 'light'}" data-action="closeMenus">
          ${this.renderSidebar()}
          <div class="usospp-main">
            ${this.renderTopbar()}
            <main class="usospp-content" data-action="closeMenus" data-content-root data-enter="${entering ? '1' : '0'}">
              ${this.renderBetaNotice()}
              ${this.renderView()}
            </main>
          </div>
          <div data-modal-root>${this.renderModals()}</div>
        </div>
      `;
      this.updateDocumentTitle();
      this.mountMapaIfNeeded();
      this.mountUnitMapPreview();
      this.mountSessionMapPreview();
      this.drawMlegQrIfNeeded();
    }

    // Unlike the Aktualności dot, this has no "seen" state to persist — it's
    // just a live reflection of whether any due is currently outstanding, so
    // it disappears on its own once everything is paid off. Always on, not a
    // toggle in Ustawienia.
    hasUnpaidPayments() {
      const unpaid = this.data.paymentsResult && this.data.paymentsResult.unpaid;
      return !!(unpaid && unpaid.groups && unpaid.groups.some((g) => g.rows && g.rows.length > 0));
    }

    // Small "needs attention" dot per nav item id — factored out so both the
    // top-level rows and the collapsed "Więcej" summary row (see
    // renderSidebar) can ask the same question.
    navItemDot(id) {
      if (id === 'aktualnosci') return this.state.newsHasUpdate;
      if (id === 'platnosci') return this.hasUnpaidPayments();
      if (id === 'ankiety') return this.pendingSurveys.length > 0;
      return false;
    }

    renderSidebar() {
      const u = this.data.user || {};
      const initials = (u.name || '? ?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
      // Logged out, only PUBLIC_VIEWS render real content — everything else
      // lands on the login prompt (renderView's gate). The click behavior
      // stays exactly the same, but locked rows get a lock icon + dimmed
      // style so it's obvious upfront which sections need a login.
      const loggedOut = !!this.data.loggedOut;
      const renderNavItem = (item, sub) => {
        const locked = loggedOut && !PUBLIC_VIEWS.has(item.id);
        const lockedClass = locked ? ' usospp-nav-item-locked' : '';
        const lockedTitle = locked ? ' title="Wymaga zalogowania"' : '';
        return `
        <div class="usospp-nav-item${sub ? ' sub' : ''}${this.isNavActive(item.id) ? ' active' : ''}${lockedClass}" data-action="nav" data-view="${item.id}"${lockedTitle}>
          ${icon(locked ? 'lock' : item.icon)}<span>${esc(item.label)}</span>
          ${this.navItemDot(item.id) ? '<span class="usospp-nav-dot"></span>' : ''}
        </div>
      `;
      };
      // Three states, independent of each other: fully expanded shows every
      // item (moreExpanded); collapsed-but-something-inside-is-active shows
      // just that one row, so you never lose track of where you are; fully
      // collapsed (not expanded, nothing active inside) shows nothing.
      // moreOpen only ever means "fully expanded" — it does NOT auto-force
      // itself open just because the active view happens to live in here,
      // otherwise there'd be no way to collapse it back while still on one
      // of its pages.
      const moreOpen = this.state.moreExpanded;
      // Hidden views (HIDDEN_NAV_ITEMS) are left out of the listing and the
      // collapsed dot, but the active-row lookup below runs on the full list
      // on purpose — a hidden view opened directly still shows its row for
      // orientation, exactly like any other active "Więcej" item.
      const visibleMoreItems = MORE_NAV_ITEMS.filter((item) => !HIDDEN_NAV_ITEMS.has(item.id));
      const activeMoreItem = MORE_NAV_ITEMS.find((item) => item.id === this.state.view);
      const moreActive = !!activeMoreItem;
      const moreHasDot = !moreOpen && !activeMoreItem && visibleMoreItems.some((item) => this.navItemDot(item.id));
      const moreChildren = moreOpen
        ? visibleMoreItems.map((item) => renderNavItem(item, true)).join('')
        : (activeMoreItem ? renderNavItem(activeMoreItem, true) : '');
      return `
        <aside class="usospp-sidebar" data-sidebar-root>
          <div class="usospp-brand">
            <div class="usospp-logo">${logoSvg(false)}</div>
            <div class="usospp-brand-text">USOS<span>++</span></div>
          </div>
          <nav class="usospp-nav">
            ${NAV_ITEMS.map((item) => renderNavItem(item, false)).join('')}
            <div class="usospp-nav-item${moreActive ? ' active' : ''}" data-action="toggleMore">
              ${icon('more')}<span>Więcej</span>
              <div style="margin-left:auto;display:flex;align-items:center;gap:6px;">
                ${moreHasDot ? '<span style="width:7px;height:7px;border-radius:50%;background:#d9773a;flex-shrink:0;"></span>' : ''}
                <span class="usospp-nav-chevron${moreOpen ? ' open' : ''}">${icon('chevron', 12)}</span>
              </div>
            </div>
            ${moreChildren}
          </nav>
          <div class="usospp-spacer"></div>
          ${loggedOut ? `
          <a class="usospp-user-card" ${this.data.loginUrl ? `href="${esc(this.data.loginUrl)}"` : `data-action="nav" data-view="dashboard"`} style="text-decoration:none;" title="Zaloguj się do USOSweb">
            <div class="usospp-avatar" style="background:oklch(38% 0.01 55);">${icon('lock', 16)}</div>
            <div class="usospp-user-meta">
              <div class="usospp-user-name">Niezalogowany</div>
              <div class="usospp-user-sub">Zaloguj się →</div>
            </div>
          </a>
          ` : `
          <div class="usospp-user-card" data-action="nav" data-view="ustawienia" title="Ustawienia">
            <div class="usospp-avatar">${esc(initials || '—')}</div>
            <div class="usospp-user-meta">
              <div class="usospp-user-name">${esc(u.name || 'Nie rozpoznano')}</div>
              <div class="usospp-user-sub">${esc(this.kierunek || u.faculty || (u.album ? `nr albumu ${u.album}` : '—'))}</div>
            </div>
          </div>
          `}
        </aside>
      `;
    }

    // "przedmioty" groups przedmiotyLista/zapisy/planer under one nav row
    // (see NAV_GROUPS) — a nav item should read as active from anywhere in
    // its group, including a subject-detail page opened from within it.
    isNavActive(itemId) {
      const group = NAV_GROUPS[itemId] || [itemId];
      if (group.includes(this.state.view)) return true;
      return this.state.view === 'subjectPage' && group.includes(this.state.subjectBackView);
    }

    renderTopbar() {
      let [title, subtitle] = TITLES[this.state.view] || ['', ''];
      if (this.state.view === 'subjectPage' && this.state.subjectData) {
        title = this.state.subjectData.subjectName || title;
      }
      if (this.state.view === 'catalogPage' && this.state.catalogData) {
        title = this.state.catalogData.name || this.state.catalogData.label || title;
      }
      const u = this.data.user || {};
      const initials = (u.name || '? ?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
      return `
        <header class="usospp-topbar" data-topbar-root>
          <div>
            <div class="usospp-title">${esc(title)}</div>
            <div class="usospp-subtitle">${esc(subtitle)}</div>
          </div>
          <div class="usospp-topbar-actions">
            <div class="usospp-search-wrap">
              <input
                class="usospp-search-input"
                data-action="searchInput"
                data-search-input
                type="text"
                placeholder="Szukaj przedmiotu, jednostki, programu studiów…"
                value="${esc(this.state.searchQuery)}"
              >
              <div data-search-results-root>${this.renderSearchResults()}</div>
            </div>
            <div class="usospp-menu-wrap">
              <button class="usospp-icon-btn" data-action="toggleNotifPanel" title="Powiadomienia">${icon('bell', 17)}</button>
              ${this.state.notifPanelOpen ? `
                <div class="usospp-dropdown" data-action="stop">
                  <div class="usospp-dropdown-head">
                    <span>Aktualności</span>
                  </div>
                  ${this.renderNotifPanelBody()}
                </div>
              ` : ''}
            </div>
            <div class="usospp-divider"></div>
            <div class="usospp-menu-wrap">
              <div class="usospp-avatar-trigger" data-action="toggleAvatarMenu">
                <div class="usospp-avatar">${esc(initials || '—')}</div>
                <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="var(--ink-2)" stroke-width="2"><path d="M5 8l5 5 5-5"></path></svg>
              </div>
              ${this.state.avatarMenuOpen ? `
                <div class="usospp-dropdown" data-action="stop">
                  <div class="usospp-dropdown-head-block">
                    <div class="usospp-dropdown-name">${esc(u.name || '—')}</div>
                    <div class="usospp-dropdown-sub">${u.album ? `nr albumu ${esc(u.album)}` : '—'}</div>
                  </div>
                  <div class="usospp-dropdown-item" data-action="nav" data-view="ustawienia">Ustawienia konta</div>
                  <div class="usospp-dropdown-item" data-action="disableUsospp" style="color:oklch(58% 0.19 25);">Wyłącz panel USOS++ / Powrót do USOS</div>
                </div>
              ` : ''}
            </div>
          </div>
        </header>
      `;
    }

    // Small preview inside the topbar's bell dropdown — full announcements
    // (with their formatted body) live on the "Aktualności" nav page, this
    // is just titles + a link over there.
    renderNotifPanelBody() {
      const news = this.data.newsResult || {};
      const items = (news.items || []).slice(0, 4);
      if (!news.supported || items.length === 0) {
        return `<div class="usospp-empty-hint">Brak aktualności do wyświetlenia.</div>`;
      }
      return `
        ${items.map((item) => `
          <div class="usospp-dropdown-item" data-action="nav" data-view="aktualnosci">${esc(item.title)}</div>
        `).join('')}
        <div class="usospp-dropdown-item" data-action="nav" data-view="aktualnosci" style="text-align:center;color:#d9773a;font-weight:600;">Zobacz wszystkie →</div>
      `;
    }

    // Topbar search dropdown — see scraping.js's searchCatalog. Osoby
    // (people) search isn't included here: it's the one Katalog search that
    // goes through USOSmail's same CSRF-walled internal proxy, so it stays
    // out of scope the same way USOSmail itself did.
    renderSearchResults() {
      const q = this.state.searchQuery.trim();
      if (q.length < 2) return '';
      const ql = q.toLowerCase();
      // Campus buildings come from the already-loaded campus list (warmed
      // by onSearchInput) and are matched client-side — no server query —
      // so they can answer at 2 characters, before the 3-char katalog
      // search has even fired. Empty when the list isn't loaded yet or its
      // fetch failed; the section then simply doesn't appear.
      // b.kod required: buildings whose USOS row carried no bud_kod (rare —
      // 1 of 93 rows on a live PWr fetch) can't be focused by kod after the
      // click, so offering them as search results would be a silent no-op.
      const buildings = this.state.mapaBuildings
        .filter((b) => b.kod && (
          (b.name && b.name.toLowerCase().includes(ql))
          || String(b.kod).toLowerCase().includes(ql)
          || (b.address && b.address.toLowerCase().includes(ql))))
        .slice(0, 4);
      const buildingItem = (b) => `
        <div class="usospp-search-item" data-action="openMapaFocused" data-kod="${esc(b.kod)}">
          <div class="usospp-search-item-title">${esc(b.name)}</div>
          <div class="usospp-search-item-sub">${esc(b.address || b.unitName || '')}</div>
        </div>
      `;
      if (this.state.searchLoading) {
        if (!buildings.length) {
          return `<div class="usospp-search-dropdown"><div class="usospp-empty-hint" style="padding:16px;">Szukanie…</div></div>`;
        }
        return `
          <div class="usospp-search-dropdown">
            <div class="usospp-search-section-title">Budynki</div>
            ${buildings.map(buildingItem).join('')}
            <div class="usospp-empty-hint" style="padding:8px 16px 12px 16px;">Szukanie w katalogu…</div>
          </div>
        `;
      }
      const r = this.state.searchResults || { subjects: [], units: [], programs: [] };
      const total = r.subjects.length + r.units.length + r.programs.length + buildings.length;
      if (total === 0) {
        return `
          <div class="usospp-search-dropdown">
            <div class="usospp-empty-hint" style="padding:16px 16px 4px 16px;">Brak wyników dla „${esc(q)}”.</div>
            <div class="usospp-empty-hint" style="padding:0 16px 16px 16px;">
              Szukasz osoby? Wyszukiwanie osób nie jest tu dostępne —
              <a data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=katalog2/osoby/index&usospp_off=1" style="font-weight:600;color:#d9773a;">sprawdź w klasycznym USOS →</a>
            </div>
          </div>
        `;
      }
      const section = (title, items, render) => (items.length ? `
        <div class="usospp-search-section-title">${esc(title)}</div>
        ${items.map(render).join('')}
      ` : '');
      return `
        <div class="usospp-search-dropdown">
          ${section('Budynki', buildings, buildingItem)}
          ${section('Przedmioty', r.subjects.slice(0, 6), (subj) => `
            <div class="usospp-search-item" data-action="searchOpenSubject" data-url="${esc(location.origin)}/kontroler.php?_action=katalog2/przedmioty/pokazPrzedmiot&prz_kod=${esc(subj.kod)}">
              <div class="usospp-search-item-title">${esc(subj.nazwa)}</div>
              <div class="usospp-search-item-sub">${esc(subj.jedn || '')}${subj.jedn ? ' · ' : ''}${esc(subj.kod)}</div>
            </div>
          `)}
          ${section('Jednostki', r.units.slice(0, 6), (unit) => `
            <div class="usospp-search-item" data-action="searchOpenUnit" data-kod="${esc(unit.kod)}">
              <div class="usospp-search-item-title">${esc(unit.nazwa)}</div>
              <div class="usospp-search-item-sub">${esc(unit.kod)}</div>
            </div>
          `)}
          ${section('Programy studiów', r.programs.slice(0, 6), (prog) => `
            <div class="usospp-search-item" data-action="searchOpenProgram" data-kod="${esc(prog.kod)}">
              <div class="usospp-search-item-title">${esc(prog.desc)}</div>
              <div class="usospp-search-item-sub">${esc(prog.kod)}</div>
            </div>
          `)}
        </div>
      `;
    }

    renderView() {
      // Logged out of USOSweb, the view split matters: sections built from
      // pages USOSweb itself serves to anonymous visitors (PUBLIC_VIEWS —
      // Aktualności, wyszukiwarka→katalog pages, campus Mapa) render
      // normally on public data alone, while every personal view falls back
      // to the same login prompt instead of its normal (empty) content —
      // the sidebar/topbar stay fully usable either way.
      if (this.data.loggedOut && !PUBLIC_VIEWS.has(this.state.view)) return this.renderLoggedOut();
      switch (this.state.view) {
        case 'dashboard': return this.renderDashboard();
        case 'aktualnosci': return this.renderAktualnosci();
        case 'plan': return this.renderPlan();
        case 'oceny': return this.renderOceny();
        case 'przedmioty': return this.renderPrzedmiotyHub();
        case 'przedmiotyLista': return this.renderPrzedmiotyLista();
        case 'zapisy': return this.renderZapisy();
        case 'zapisTura': return this.renderZapisTura();
        case 'zapisGrupy': return this.renderZapisGrupy();
        case 'planer': return this.renderPlanner();
        case 'egzaminy': return this.renderEgzaminy();
        case 'ects': return this.renderEcts();
        case 'platnosci': return this.renderPlatnosci();
        case 'stypendia': return this.renderStypendia();
        case 'sprawdziany': return this.renderSprawdziany();
        case 'podania': return this.renderPodania();
        case 'ankiety': return this.renderAnkiety();
        case 'studenci': return this.renderStudenci();
        case 'mlegitymacja': return this.renderMlegitymacja();
        case 'ustawienia': return this.renderUstawienia();
        case 'subjectPage': return this.renderSubjectPage();
        case 'mapa': return this.renderMapa();
        case 'katalog': return this.renderKatalogHub();
        case 'katalogJednostki': return this.renderKatalogJednostki();
        case 'katalogPrzedmioty': return this.renderKatalogPrzedmioty();
        case 'katalogKierunki': return this.renderKatalogKierunki();
        case 'katalogBudynki': return this.renderKatalogBudynki();
        case 'catalogPage': {
          if (this.state.catalogKind === 'unit') return this.renderUnitPage();
          if (this.state.catalogKind === 'stage') return this.renderStagePage();
          return this.renderProgramPage();
        }
        default: return '';
      }
    }

    // ---- helpers over scraped data -----------------------------------

    get gradeRows() {
      const g = this.data.gradesResult || {};
      if (!Array.isArray(g.rows)) return [];
      return g.rows;
    }

    get numericGrades() {
      return this.gradeRows
        .map((row) => {
          // New shape from getGrades: {subject, code, program, grade} —
          // only the parsed Ocena column counts (grade is null when the
          // subject has "(brak ocen)").
          if (row && typeof row === 'object' && !Array.isArray(row)) {
            if (row.grade) {
              const g = fmtGrade(row.grade);
              if (g) return g;
            }
            return null;
          }
          const cells = Array.isArray(row) ? row : [row.text];
          for (let i = cells.length - 1; i >= 0; i--) {
            const g = fmtGrade(cells[i]);
            if (g) return g;
          }
          return null;
        })
        .filter(Boolean);
    }

    get planEvents() {
      const p = this.data.planResult || {};
      return Array.isArray(p.raw) ? p.raw : [];
    }

    // Weekly plan reconstructed from home/grupy (getMyGroups): every
    // enrolled group flattened to {day, start, end, weeks, subject, code,
    // type, nr}. Recurring every week by nature (USOS renders "każdy X" /
    // "co drugi X (parzyste/nieparzyste)"), so the week switcher only moves
    // the displayed week label — the sessions repeat.
    get weeklyPlan() {
      const mg = this.data.myGroupsResult || {};
      if (!Array.isArray(mg.subjects)) return [];
      const details = (this.data.groupDetails && typeof this.data.groupDetails === 'object')
        ? this.data.groupDetails : {};
      const out = [];
      mg.subjects.forEach((s) => {
        (s.groups || []).forEach((g) => {
          const det = (g.detailsUrl && details[g.detailsUrl]) || null;
          const teachers = det && Array.isArray(det.teachers) ? det.teachers.filter(Boolean) : [];
          (g.sessions || []).forEach((sess) => {
            out.push({
              day: sess.day,
              start: sess.start,
              end: sess.end,
              weeks: sess.weeks || 'every',
              semester: s.semester || null,
              subject: s.name,
              code: s.code,
              type: g.type,
              nr: g.nr,
              detailsUrl: g.detailsUrl,
              room: (det && det.room) || null,
              roomUrl: (det && det.roomUrl) || null,
              building: (det && det.building) || null,
              teacher: teachers.length ? teachers.join(', ') : null,
            });
          });
        });
      });
      const order = { PN: 0, WT: 1, 'ŚR': 2, CZ: 3, PT: 4, SO: 5, ND: 6 };
      out.sort((a, b) => (order[a.day] ?? 9) - (order[b.day] ?? 9) || (toMin(a.start) ?? Infinity) - (toMin(b.start) ?? Infinity));
      out.forEach((e, i) => { e.idx = i; });
      return out;
    }

    // Monday of the displayed week (offset 0 = current week), returned as a
    // Date at local midnight.
    planWeekMonday(off = Number(this.state.planWeekOffset || 0)) {
      const now = new Date();
      const dow = (now.getDay() + 6) % 7; // Monday = 0
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + off * 7);
      monday.setHours(0, 0, 0, 0);
      return monday;
    }

    planWeekLabel(off = Number(this.state.planWeekOffset || 0)) {
      const monday = this.planWeekMonday(off);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
      return `${fmt(monday)} – ${fmt(sunday)}`;
    }

    // The seven days of a week (offset 0 = current): {date (Date), iso
    // (YYYY-MM-DD), day (PN..ND)}.
    planWeekDates(off = Number(this.state.planWeekOffset || 0)) {
      const monday = this.planWeekMonday(off);
      const keys = ['PN', 'WT', 'ŚR', 'CZ', 'PT', 'SO', 'ND'];
      return keys.map((day, i) => {
        const date = new Date(monday);
        date.setDate(monday.getDate() + i);
        const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        return { date, iso, day };
      });
    }

    // Position of the Google-style "now" line in the week grid, or null
    // when it must not render: generic scope (a recurring template has no
    // real dates), a non-current week offset, today not among the
    // displayed day columns (an empty weekend renders no column), or now
    // outside the hour axis. top is px from the day-body top — rowH is 60
    // px/hour, so 1 px = 1 minute. nowMs is a test seam (defaults to now).
    planNowline(layout, scope, nowMs = Date.now()) {
      if (scope === 'generic') return null;
      if (Number(this.state.planWeekOffset || 0) !== 0) return null;
      if (!layout || !Array.isArray(layout.days)) return null;
      const d = new Date(nowMs);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const today = this.planWeekDates(0).find((r) => r.iso === iso);
      if (!today || !layout.days.some((c) => c.day === today.day)) return null;
      const top = d.getHours() * 60 + d.getMinutes() - layout.hourStart * 60;
      if (top < 0 || top > layout.totalHeight) return null;
      return { day: today.day, top };
    }

    // Concrete week sessions: group meetings (see getGroupDetails) whose
    // date falls into the given week offset. Room/teacher come from the
    // concrete meeting itself (a meeting can move rooms), falling back to
    // the group's header info. Days without meetings are simply absent —
    // the renderer shows them as free.
    concreteSessionsForOffset(off) {
      const range = this.planWeekDates(off);
      const dayByIso = {};
      range.forEach((r) => { dayByIso[r.iso] = r.day; });
      const mg = this.data.myGroupsResult || {};
      if (!Array.isArray(mg.subjects)) return [];
      const details = (this.data.groupDetails && typeof this.data.groupDetails === 'object')
        ? this.data.groupDetails : {};
      const out = [];
      mg.subjects.forEach((s) => {
        (s.groups || []).forEach((g) => {
          const det = (g.detailsUrl && details[g.detailsUrl]) || null;
          const meetings = det && Array.isArray(det.meetings) ? det.meetings : [];
          meetings.forEach((m) => {
            if (!m.date || !dayByIso[m.date] || !m.start || !m.end) return;
            const detTeachers = det && Array.isArray(det.teachers) ? det.teachers.filter(Boolean) : [];
            out.push({
              date: m.date,
              day: dayByIso[m.date],
              start: m.start,
              end: m.end,
              weeks: 'every', // concrete date needs no parity tag
              semester: s.semester || null,
              subject: s.name,
              code: s.code,
              type: g.type,
              nr: g.nr,
              detailsUrl: g.detailsUrl,
              room: m.room || (det && det.room) || null,
              roomUrl: (det && det.roomUrl) || null,
              building: m.building || (det && det.building) || null,
              teacher: m.teacher || (detTeachers.length ? detTeachers.join(', ') : null),
            });
          });
        });
      });
      out.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (toMin(a.start) ?? Infinity) - (toMin(b.start) ?? Infinity));
      out.forEach((e, i) => { e.idx = i; });
      return out;
    }

    get concreteWeekSessions() {
      return this.concreteSessionsForOffset(Number(this.state.planWeekOffset || 0));
    }

    // Epoch ms for a concrete session's start/end ("2026-10-05" + "15:15").
    // Null when the session has no usable date/time. Single-digit hours
    // ("9:15", exactly how USOS renders them) must pass — the old
    // \d{2}:\d{2} gate silently dropped every pre-10:00 class from the
    // dashboard box while the grid showed it fine.
    // NOTE: `new Date("YYYY-MM-DDTHH:MM:00")` parses in the browser's
    // local zone with no DST-safe arithmetic — a session inside the autumn
    // changeover hour can shift by 60 min vs the grid (which never parses
    // dates). Countdown-only impact; revisit if USOS ever schedules one.
    sessionDateTime(e, which = 'start') {
      const t = which === 'end' ? e.end : e.start;
      if (!e.date || !t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
      const dt = new Date(`${e.date}T${t}:00`);
      return Number.isNaN(dt.getTime()) ? null : dt.getTime();
    }

    // Nearest sessions for the panel box: merges concrete weeks 0..2,
    // keeps everything not yet finished, capped at PANEL_LOOKAHEAD_DAYS
    // ahead. Splits into currently-running vs upcoming, both chronological.
    panelUpcomingSessions(nowMs = Date.now()) {
      const seen = new Map();
      for (let off = 0; off < 3; off++) {
        this.concreteSessionsForOffset(off).forEach((e) => {
          const start = this.sessionDateTime(e, 'start');
          const end = this.sessionDateTime(e, 'end');
          if (start == null || end == null) return;
          if (end < nowMs) return;
          if (start > nowMs + PANEL_LOOKAHEAD_DAYS * 86400000) return;
          const key = `${e.date}|${e.start}|${e.end}|${e.subject}|${e.type}|${e.nr}|${e.detailsUrl || ''}`;
          if (!seen.has(key)) seen.set(key, { ...e, _start: start, _end: end });
        });
      }
      const all = [...seen.values()].sort((a, b) => a._start - b._start || a._end - b._end);
      return {
        ongoing: all.filter((e) => e._start <= nowMs && nowMs < e._end),
        upcoming: all.filter((e) => e._start > nowMs),
      };
    }

    // One panel entry row: subject colour bar, name, location, time and a
    // live countdown span (ticked in place every 60 s, no re-render).
    renderPanelSessionRow(e, mode, nowMs) {
      const c = subjectColor(hashStr(e.code || e.subject || ''), this.settings.darkMode);
      const roomLine = this.planRoomLine(e);
      const target = mode === 'end' ? e._end : e._start;
      const dd = (e.date || '').slice(8);
      const mm = (e.date || '').slice(5, 7);
      return `
        <div class="usospp-list-row" style="border-left:4px solid ${c.bg};">
          <div style="padding-left:8px;">
            <div style="font-weight:600;">${esc(e.subject)}${e.type ? ` <span class="usospp-muted-text" style="font-weight:400;">· ${esc(e.type)}${e.nr ? `, gr. ${esc(String(e.nr))}` : ''}</span>` : ''}</div>
            <div class="usospp-muted-text" style="font-size:12.5px;">${esc(e.day || '')} ${esc(dd)}.${esc(mm)} · ${esc(e.start)}–${esc(e.end)}${roomLine ? ` · ${esc(roomLine)}` : ''}</div>
            <div class="usospp-stat-hint" style="font-weight:600;"><span data-countdown data-target="${target}" data-mode="${mode}">${esc(formatCountdownPl(target, nowMs, mode))}</span></div>
          </div>
        </div>`;
    }

    // Dynamic panel box replacing "Zaliczenia etapów": currently-running
    // sessions + what's next, with a 21-day lookahead. One box, sections
    // stacked and separated.
    renderPanelSessions(nowMs = Date.now()) {
      ensureCountdownTicker();
      const { ongoing, upcoming } = this.panelUpcomingSessions(nowMs);
      const section = (title, rows, separated) => rows.length ? `
        <div${separated ? ' style="border-top:1px solid var(--border);margin-top:12px;padding-top:4px;"' : ''}>
          <div class="usospp-card-title" style="margin:8px 0;font-size:14px;">${esc(title)}</div>
          ${rows.join('')}
        </div>` : '';
      if (!ongoing.length && !upcoming.length) {
        return `
          <div class="usospp-card-head"><div class="usospp-card-title">Zajęcia</div><a data-action="nav" data-view="plan" style="font-size:12.5px;font-weight:600;cursor:pointer;">plan →</a></div>
          <div class="usospp-empty-hint">Brak zajęć w ciągu następnych ${PANEL_LOOKAHEAD_DAYS} dni.</div>`;
      }
      const head = ongoing.length
        ? section('Aktualne zajęcia', ongoing.map((e) => this.renderPanelSessionRow(e, 'end', nowMs)), false)
          + section('Następne zajęcia', upcoming.slice(0, 2).map((e) => this.renderPanelSessionRow(e, 'start', nowMs)), true)
        : section('Kolejne zajęcia', upcoming.slice(0, 1).map((e) => this.renderPanelSessionRow(e, 'start', nowMs)), false)
          + section('Późniejsze zajęcia', upcoming.slice(1, 3).map((e) => this.renderPanelSessionRow(e, 'start', nowMs)), true);
      return `
        <div class="usospp-card-head"><div class="usospp-card-title">Zajęcia</div><a data-action="nav" data-view="plan" style="font-size:12.5px;font-weight:600;cursor:pointer;">plan →</a></div>
        ${head}`;
    }

    // Weekly aggregate for the panel's left box: counts and hours from
    // the concrete current-week sessions (offset 0), busiest day with its
    // load, free days, per-type counts. Pure computation — no new loads.
    get panelWeekSummary() {
      const events = this.concreteSessionsForOffset(0);
      const toMin = (t) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
        return m ? (+m[1]) * 60 + (+m[2]) : null;
      };
      const byDay = {};
      const byType = {};
      let minutes = 0;
      events.forEach((e) => {
        const s = toMin(e.start);
        const en = toMin(e.end);
        if (s !== null && en !== null && en > s) {
          minutes += en - s;
          byDay[e.day] = (byDay[e.day] || 0) + (en - s);
        }
        const t = e.type || 'inne';
        byType[t] = (byType[t] || 0) + 1;
      });
      const order = ['PN', 'WT', 'ŚR', 'CZ', 'PT', 'SO', 'ND'];
      let busiest = null;
      order.forEach((d) => {
        if (byDay[d] && (!busiest || byDay[d] > byDay[busiest])) busiest = d;
      });
      const busyDays = new Set(events.map((e) => e.day));
      // Weekend days count as "free" only when the account actually has
      // weekend teaching in its template — otherwise "Wolne: SO, ND" is
      // noise on top of every ordinary week.
      const weekendTaught = new Set((this.weeklyPlan || []).map((e) => e && e.day));
      const freeDays = order.filter((d) => !busyDays.has(d)
        && (d !== 'SO' && d !== 'ND' || weekendTaught.has(d)));
      return { count: events.length, minutes, byDay, busiest, freeDays, byType };
    }

    // Left panel box: this week's load at a glance. The right box
    // (renderPanelSessions) owns exact times + countdowns, so this one
    // stays an aggregate — deliberately no per-session rows.
    renderPanelWeekSummary() {
      const s = this.panelWeekSummary;
      const head = `
        <div class="usospp-card-head"><div class="usospp-card-title">Ten tydzień — ${esc(this.planWeekLabel(0))}</div><a data-action="nav" data-view="plan" style="font-size:12.5px;font-weight:600;cursor:pointer;">szczegóły →</a></div>`;
      if (!s.count) {
        return `${head}<div class="usospp-empty-hint">W tym tygodniu nie masz żadnych zajęć — wolne.</div>`;
      }
      const fmtDur = (min) => {
        const h = Math.floor(min / 60);
        const m = min % 60;
        if (h && m) return `${h} h ${m} min`;
        if (h) return `${h} h`;
        return `${m} min`;
      };
      const zajeciaWord = s.count === 1 ? '1 zajęcie'
        : [2, 3, 4].includes(s.count % 10) && ![12, 13, 14].includes(s.count % 100) ? `${s.count} zajęcia`
        : `${s.count} zajęć`;
      const types = Object.entries(s.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${esc(t)} ×${n}`)
        .join(' · ');
      return `${head}
        <div class="usospp-list-row">
          <div style="font-size:13px;"><strong>${zajeciaWord}</strong> · łącznie ${fmtDur(s.minutes)} na uczelni</div>
        </div>
        ${s.busiest ? `
        <div class="usospp-list-row">
          <div style="font-size:13px;">Najbardziej zapracowany: <strong>${esc(s.busiest)}</strong> (${fmtDur(s.byDay[s.busiest])})</div>
        </div>` : ''}
        <div class="usospp-list-row">
          <div style="font-size:13px;">${s.freeDays.length ? `Wolne: <strong>${esc(s.freeDays.join(', '))}</strong>` : 'Brak dni wolnych w tym tygodniu.'}</div>
        </div>
        ${types ? `<p class="usospp-muted-text" style="margin:8px 0 0 0;">${types}</p>` : ''}`;
    }

    // Sessions actually on screen right now (concrete week or generic
    // template) — the plan modal indexes into this via data-idx.
    planVisibleSessions() {
      // A foreign plan replaces the own-plan source for THIS view only —
      // dashboard summaries, semester progress and exports keep reading
      // the own-plan getters directly, so they never see somebody else.
      if (this.activeSharedPlan) return this.sharedWeekSessions;
      return this.state.planScope === 'generic' ? this.weeklyPlan : this.concreteWeekSessions;
    }

    // Somebody-else's timetables (see usos/shared-plans-store.js): the
    // persisted list loads once, fire-and-forget, re-rendering only when
    // the plan view is the one asking. Week data itself is never persisted
    // (token links die after 14 days — a stored week would masquerade as
    // live); it lives in _sharedCache keyed `${planId}|${weekOffset}`.
    async loadSharedPlans() {
      if (this.state.sharedPlansReady) return;
      const store = window.USOSPP_SHARED_PLANS;
      if (store) {
        try {
          const data = await store.getData();
          this.state.sharedPlans = {
            plans: Array.isArray(data.plans) ? data.plans : [],
            activeId: data.activeId || 'self',
          };
        } catch (e) { /* keep defaults */ }
      }
      this.state.sharedPlansReady = true;
      if (this.state.view === 'plan') this.render();
    }

    get activeSharedPlan() {
      const sp = this.state.sharedPlans || {};
      if (!sp || sp.activeId === 'self') return null;
      return (sp.plans || []).find((p) => p && p.id === sp.activeId) || null;
    }

    sharedPlanDisplayName(plan) {
      if (!plan) return 'Mój plan';
      return plan.nickname || plan.ownerName || 'Cudzy plan';
    }

    sharedWeekKey(plan, offset) {
      return `${plan.id}|${Number(offset || 0)}`;
    }

    sharedWeekState() {
      const plan = this.activeSharedPlan;
      if (!plan) return null;
      const cache = this._sharedCache || {};
      return cache[this.sharedWeekKey(plan, this.state.planWeekOffset)] || null;
    }

    get sharedWeekSessions() {
      const hit = this.sharedWeekState();
      return hit && hit.status === 'ready' ? hit.sessions : [];
    }

    // Kicks off the fetch for the active foreign week (once per plan+week)
    // and re-renders when it lands, if the plan view is still showing.
    // Called from renderPlan — the render itself reads sharedWeekState()
    // synchronously, so the first paint is a loading hint, never a block.
    ensureSharedPlanWeek() {
      const plan = this.activeSharedPlan;
      if (!plan) return;
      const offset = Number(this.state.planWeekOffset || 0);
      const key = this.sharedWeekKey(plan, offset);
      if (!this._sharedCache) this._sharedCache = {};
      if (this._sharedCache[key] || this._sharedLoadingKey === key) return;
      this._sharedLoadingKey = key;
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const adapter = adapters && adapters.selectAdapter ? adapters.selectAdapter() : null;
      const mondayIso = this.planWeekDates(offset)[0].iso;
      const url = scrape && scrape.PATHS ? scrape.PATHS.sharedPlanWeek(plan.url, mondayIso) : null;
      (async () => {
        let entry = { status: 'error', sessions: [], ownerName: null };
        try {
          const res = url && adapter && scrape
            ? await scrape.fetchSharedPlan(adapter, url, mondayIso)
            : null;
          if (res && res.supported) {
            entry = { status: 'ready', sessions: res.sessions || [], ownerName: res.ownerName || null };
          } else if (res && res.notShared) {
            entry = { status: 'not-shared', sessions: [], ownerName: res.ownerName || null };
          }
        } catch (e) { /* keep error entry */ }
        this._sharedCache[key] = entry;
        if (this._sharedLoadingKey === key) this._sharedLoadingKey = null;
        if (this.state.view === 'plan') this.render();
      })();
    }

    async persistSharedPlans(mutator) {
      const store = window.USOSPP_SHARED_PLANS;
      if (!store) return;
      const data = await store.setData(mutator);
      this.setState({
        sharedPlans: { plans: data.plans || [], activeId: data.activeId || 'self' },
      });
    }

    // Normalized "names surname" key for cross-group student dedup.
    studentKey(surname, names) {
      return `${names || ''} ${surname || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    // Fellow students aggregated from all visible group lists
    // (data.participantsResult): [{key, display, isSelf,
    // subjects:[{subject, code, type, nr}], count}], most shared first.
    // Self-match is by name against getUser() (cas-bar logged-user); when
    // the formats don't align there's simply no "Ty" badge — nothing breaks.
    get studentIndex() {
      const res = (this.data && this.data.participantsResult) || {};
      const groups = Array.isArray(res.groups) ? res.groups : [];
      const rawSelf = this.data && this.data.user && this.data.user.name;
      const selfName = rawSelf ? String(rawSelf).replace(/\s+/g, ' ').trim().toLowerCase() : null;
      const map = new Map();
      groups.forEach((g) => {
        if (!g || g.hidden || !Array.isArray(g.students)) return;
        g.students.forEach((s) => {
          const key = this.studentKey(s.surname, s.names);
          if (!key) return;
          if (!map.has(key)) {
            map.set(key, {
              key,
              display: `${(s.names || '').trim()} ${(s.surname || '').trim()}`.trim(),
              isSelf: !!selfName && key === selfName,
              subjects: [],
            });
          }
          map.get(key).subjects.push({ subject: g.subject, code: g.code, type: g.type, nr: g.nr });
        });
      });
      const out = [...map.values()];
      out.forEach((e) => { e.count = e.subjects.length; });
      out.sort((a, b) => (b.count - a.count) || a.display.localeCompare(b.display, 'pl'));
      return out;
    }

    setStudenciQueryState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      if (this.state.view !== 'studenci') return;
      // Same focus-preserving pattern as setKatalogPrzedmiotyQueryState.
      this.render();
      const input = this.root.querySelector('[data-action="studenciQueryInput"]');
      if (input) {
        const val = this.state.studenciQuery || '';
        if (input.value !== val) input.value = val;
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ }
      }
    }

    // Persisted Studenci filters: load once (fire-and-forget on view entry,
    // re-renders only if still on the view), save on every toggle.
    loadStudenciFilters() {
      if (this.state.studenciFiltersReady) return;
      try {
        const p = chrome.storage.local.get(STUDENCI_FILTERS_KEY);
        const apply = (stored) => {
          this.state.studenciFiltersReady = true;
          if (stored && typeof stored === 'object') {
            if (Array.isArray(stored.excluded)) this.state.studenciExcluded = stored.excluded.filter((x) => typeof x === 'string');
            if (typeof stored.hideLectures === 'boolean') this.state.studenciHideLectures = stored.hideLectures;
          }
          if (this.state.view === 'studenci') this.render();
        };
        if (p && typeof p.then === 'function') p.then((res) => apply(res && res[STUDENCI_FILTERS_KEY])).catch(() => apply(null));
        else apply(null);
      } catch (e) { this.state.studenciFiltersReady = true; }
    }

    persistStudenciFilters() {
      try {
        chrome.storage.local.set({ [STUDENCI_FILTERS_KEY]: {
          excluded: this.state.studenciExcluded || [],
          hideLectures: !!this.state.studenciHideLectures,
        } });
      } catch (e) { /* ignore */ }
    }

    toggleStudenciSubject(name) {
      const cur = new Set(this.state.studenciExcluded || []);
      if (cur.has(name)) cur.delete(name);
      else cur.add(name);
      this.setState({ studenciExcluded: [...cur] });
      this.persistStudenciFilters();
    }

    toggleStudenciLectures() {
      this.setState((s) => ({ studenciHideLectures: !s.studenciHideLectures }));
      this.persistStudenciFilters();
    }

    clearStudenciFilters() {
      this.setState({ studenciExcluded: [], studenciHideLectures: false });
      this.persistStudenciFilters();
    }

    // Manual retry for the Studenci loading state (covers a genuinely hung
    // fetch, not just the missing boot trigger). In-flight guard —
    // fetchParticipantsResult has none, so double-clicks would otherwise
    // duplicate all per-group fetches. Mirrors ensureDeferredData's
    // studenci branch, plus completion handling to clear the guard.
    retryStudenciLoad() {
      if (this.state.view !== 'studenci') return;
      if (this.data && this.data.participantsResultLoaded) { this.render(); return; }
      this.loadStudenciFilters();
      this.ensureParticipantsResult(() => {
        if (this.state.view === 'studenci') this.render();
      });
    }

    // studentIndex pruned by the Studenci filters: excluded subjects and,
    // optionally, Wykład groups are removed from each person's shared
    // list; people left with nothing drop out; counts re-derived.
    get visibleStudentIndex() {
      const excluded = new Set(this.state.studenciExcluded || []);
      const hideLectures = !!this.state.studenciHideLectures;
      if (!excluded.size && !hideLectures) return this.studentIndex;
      const out = [];
      this.studentIndex.forEach((e) => {
        const subjects = e.subjects.filter((s) => !excluded.has(s.subject || '')
          && !(hideLectures && /wykład/i.test(s.type || '')));
        if (!subjects.length) return;
        out.push({ ...e, subjects, count: subjects.length });
      });
      out.sort((a, b) => (b.count - a.count) || a.display.localeCompare(b.display, 'pl'));
      return out;
    }

    // Distinct subject names across visible group lists, for filter chips.
    get studenciFilterSubjects() {
      const res = (this.data && this.data.participantsResult) || {};
      const groups = Array.isArray(res.groups) ? res.groups : [];
      const names = [...new Set(groups.filter((g) => g && !g.hidden && g.subject).map((g) => g.subject))];
      names.sort((a, b) => a.localeCompare(b, 'pl'));
      return names;
    }

    // The Studenci view: everyone visible on your groups' public lists,
    // with the subjects/groups you share. Search filters by person or
    // subject name; chips exclude whole subjects (or all lectures) from
    // matching — exclusions persist in chrome.storage.local.
    renderStudenci() {
      const res = (this.data && this.data.participantsResult) || {};
      const loaded = !!(this.data && this.data.participantsResultLoaded);
      if (!loaded) {
        return `<div class="usospp-view"><div class="usospp-card"><div class="usospp-empty-hint">Pobieranie list uczestników z Twoich grup…<br><a data-action="studenciRetryLoad" style="font-size:12.5px;font-weight:600;cursor:pointer;">Spróbuj ponownie</a></div></div></div>`;
      }
      const index = this.visibleStudentIndex;
      const q = (this.state.studenciQuery || '').trim().toLowerCase();
      const matchesQuery = (e) => e.display.toLowerCase().includes(q)
        || e.subjects.some((s) => (s.subject || '').toLowerCase().includes(q));
      const filtered = q ? index.filter(matchesQuery) : index;
      const excluded = new Set(this.state.studenciExcluded || []);
      const hideLectures = !!this.state.studenciHideLectures;
      const filtersActive = excluded.size > 0 || hideLectures;
      // Searching something only the exclusions hide (e.g. a chipped-off
      // subject) yields zero silently — count full-index matches so the
      // empty state can name the filters as the culprit. The "wyczyść
      // filtry →" link in the card head is the way out.
      const hiddenMatchCount = (q && !filtered.length && filtersActive)
        ? this.studentIndex.filter(matchesQuery).length
        : 0;
      const chipStyle = 'flex:0 0 auto;border-radius:99px;padding:6px 13px;font-size:12.5px;';
      const subjectChips = this.studenciFilterSubjects.map((name) => {
        const off = excluded.has(name);
        return `<button class="usospp-mode-btn${off ? '' : ' active'}" style="${chipStyle}${off ? 'opacity:.45;' : ''}" data-action="studenciToggleSubject" data-subject="${esc(name)}" title="${off ? 'Kliknij, aby uwzględnić' : 'Kliknij, aby wykluczyć'}">${esc(name)}</button>`;
      }).join('');
      const chip = (s) => {
        const c = subjectColor(hashStr(s.code || s.subject || ''), this.settings.darkMode);
        return `<span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);border-left:3px solid ${c.bg};">${esc(s.subject || '')}${s.type ? ` · ${esc(s.type)}${s.nr ? `, gr. ${esc(String(s.nr))}` : ''}` : ''}</span>`;
      };
      const row = (e) => `
        <div class="usospp-list-row">
          <div>
            <div style="font-weight:600;">${esc(e.display)}${e.isSelf ? ' <span class="usospp-badge">Ty</span>' : ''}</div>
            ${e.isSelf ? '' : `<div class="usospp-muted-text" style="font-size:12px;">${e.count === 1 ? '1 wspólny przedmiot' : `${e.count} wspólne przedmioty`}</div>`}
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">${e.subjects.map(chip).join('')}</div>
          </div>
        </div>`;
      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-head"><div class="usospp-card-title">Studenci (${filtered.length})</div>${filtersActive ? `<a data-action="studenciClearFilters" style="font-size:12.5px;font-weight:600;cursor:pointer;">wyczyść filtry →</a>` : ''}</div>
            <input class="usospp-input" style="margin-bottom:12px;" placeholder="Szukaj po nazwisku lub przedmiocie…" value="${esc(this.state.studenciQuery || '')}" data-action="studenciQueryInput">
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;">
              <button class="usospp-mode-btn${hideLectures ? ' active' : ''}" style="${chipStyle}${hideLectures ? '' : 'opacity:.45;'}" data-action="studenciToggleLectures" title="${hideLectures ? 'Kliknij, aby uwzględnić wykłady' : 'Kliknij, aby ukryć wykłady'}">Bez wykładów</button>
              ${subjectChips}
            </div>
            ${!this.studentIndex.length ? `<div class="usospp-empty-hint">Żadna z Twoich grup nie ma publicznej listy uczestników.</div>`
              : !filtered.length ? (hiddenMatchCount === 1
                ? `<div class="usospp-empty-hint">Nic wśród uwzględnionych — 1 pasująca osoba jest ukryta przez filtry.</div>`
                : hiddenMatchCount > 1 && hiddenMatchCount < 5
                  ? `<div class="usospp-empty-hint">Nic wśród uwzględnionych — ${hiddenMatchCount} pasujące osoby są ukryte przez filtry.</div>`
                  : hiddenMatchCount >= 5
                    ? `<div class="usospp-empty-hint">Nic wśród uwzględnionych — ${hiddenMatchCount} pasujących osób jest ukrytych przez filtry.</div>`
                    : `<div class="usospp-empty-hint">Brak wyników — zmień zapytanie lub dostosuj filtry.</div>`)
              : filtered.map(row).join('')}
          </div>
        </div>
      `;
    }

    // Short room line for plan blocks: "sala 311d · D-1" (building code
    // from "Gmach - Nowy Elektryczny [D-1]"). Null when nothing known yet.
    planRoomLine(e) {
      const code = (e.building || '').match(/\[([^\]]+)\]/);
      const parts = [];
      if (e.room) parts.push(e.room);
      if (code) parts.push(code[1]);
      else if (e.building) parts.push(e.building);
      return parts.length ? parts.join(' · ') : null;
    }

    // Lazy room/lecturer enrichment for the weekly plan: one read-only
    // fetch per enrolled group (cached in scraping.js), fired on plan and
    // dashboard entry — never on mount, to keep it fast. Re-renders the
    // view when the details land. Serialized behind _planDetailsLoading
    // (rapid plan↔dashboard navigation must not fire N parallel bursts).
    // Misses are NOT stored — otherwise a retry could never refetch them.
    async ensurePlanDetails() {
      const mg = this.data.myGroupsResult || {};
      if (!Array.isArray(mg.subjects) || !mg.subjects.length) return;
      if (this._planDetailsLoading) return;
      if (!this.data.groupDetails) this.data.groupDetails = {};
      const urls = [];
      mg.subjects.forEach((s) => (s.groups || []).forEach((g) => {
        if (g.detailsUrl && !this.data.groupDetails[g.detailsUrl] && !urls.includes(g.detailsUrl)) urls.push(g.detailsUrl);
      }));
      if (!urls.length) return;
      const adapter = (window.USOSPP_ADAPTERS && typeof window.USOSPP_ADAPTERS.selectAdapter === 'function')
        ? window.USOSPP_ADAPTERS.selectAdapter() : null;
      const fetchDetails = window.USOSPP_SCRAPE && window.USOSPP_SCRAPE.fetchGroupDetails;
      if (!adapter || typeof fetchDetails !== 'function') return;
      this._planDetailsLoading = true;
      this.setState({ planDetailsLoading: true });
      try {
        const results = await Promise.all(urls.map((u) => fetchDetails(adapter, u)));
        urls.forEach((u, i) => { if (results[i] && results[i].supported) this.data.groupDetails[u] = results[i]; });
      } finally {
        this._planDetailsLoading = false;
        if (this.state.view === 'plan' || this.state.view === 'dashboard') {
          this.setState({ planDetailsLoading: false });
        } else {
          this.state.planDetailsLoading = false;
        }
      }
    }

    get etapy() {
      const e = this.data.etapyResult || {};
      return Array.isArray(e.etapy) ? e.etapy : [];
    }

    // Per-stage settlement details, keyed by the list's detailsId. Loaded
    // lazily on ECTS view entry (see fetchEtapDetailsResult) — empty until
    // then, so renderers must degrade to the plain stage row meanwhile.
    get etapDetails() {
      const r = this.data.etapDetailsResult || {};
      return r.byId && typeof r.byId === 'object' ? r.byId : {};
    }

    get exams() {
      const ex = this.data.examsResult || {};
      return Array.isArray(ex.exams) ? ex.exams : [];
    }

    get registrationGroups() {
      const r = this.data.registrationsResult || {};
      return Array.isArray(r.groups) ? r.groups : [];
    }

    // Single unified Zapisy model: the personal calendar
    // (personalCalendarResult — already filtered to this student, with exact
    // times, attributes and register links) flattened to rounds. The
    // faculty-wide registrationGroups feed the SAME shape only as a fallback
    // when the personal scrape is unsupported — never a second list in the
    // UI. Sorted by start time, nearest first.
    get zapisRounds() {
      const personal = this.data.personalCalendarResult || {};
      if (Array.isArray(personal.sections) && personal.sections.length) {
        const out = [];
        personal.sections.forEach((s) => {
          (s.rounds || []).forEach((r) => {
            out.push({
              source: 'personal',
              sectionCode: s.code,
              sectionTitle: s.title,
              subjectsUrl: s.subjectsUrl,
              planUrls: Array.isArray(s.planUrls) ? s.planUrls : [],
              turaId: r.turaId,
              rejKod: r.rejKod,
              state: r.state,
              startsAt: r.startsAt,
              endsAt: r.endsAt,
              roundType: r.roundType,
              roundNote: r.roundNote,
              attributes: r.attributes || {},
              registerUrl: r.registerUrl,
              hasAccess: r.hasAccess,
            });
          });
        });
        out.sort((a, b) => (a.startsAt || '').localeCompare(b.startsAt || ''));
        return out;
      }
      const out = [];
      this.registrationGroups.forEach((g) => {
        (g.rounds || []).forEach((r) => {
          out.push({
            source: 'faculty',
            sectionCode: g.code,
            sectionTitle: g.groupLabel,
            subjectsUrl: g.subjectsUrl,
            planUrls: [],
            turaId: r.turaId,
            rejKod: null,
            state: r.state,
            startsAt: r.startsAt,
            endsAt: r.endsAt,
            roundType: r.roundType,
            roundNote: r.roundNote,
            attributes: r.attributes || {},
            registerUrl: null,
            hasAccess: r.hasAccess,
          });
        });
      });
      out.sort((a, b) => (a.startsAt || '').localeCompare(b.startsAt || ''));
      return out;
    }

    get ownProgrammes() {
      const p = this.data.ownProgrammesResult || {};
      return Array.isArray(p.programmes) ? p.programmes : [];
    }

    // Same source renderZapisy already relies on for "Tylko mój kierunek" —
    // the "Wymagania etapów studiów" hub is the only reliable "what's my
    // kierunek" signal we have (see getOwnProgrammes' comment in adapters.js).
    get kierunek() {
      return this.ownProgrammes.find((p) => p.directionName)?.directionName || null;
    }

    get stageSubjects() {
      const s = this.data.stageSubjectsResult || {};
      return Array.isArray(s.stages) ? s.stages : [];
    }

    get pendingSurveys() {
      const s = this.data.surveysResult || {};
      return Array.isArray(s.rows) ? s.rows : [];
    }

    // ---- views ---------------------------------------------------------

    renderLoggedOut() {
      const loginUrl = this.data.loginUrl;
      return `
        <div class="usospp-view">
          <div class="usospp-loggedout">
            <div class="usospp-loggedout-logo">${logoSvg(false)}</div>
            <div class="usospp-loggedout-title">Zaloguj się do USOSweb</div>
            <p class="usospp-loggedout-text">Nie jesteś obecnie zalogowany/a, więc ten widok nie ma skąd wziąć danych. Aktualności, Katalog, Mapa kampusu i wyszukiwarka (przedmioty, jednostki, programy studiów) działają też bez logowania — wybierz je z menu po lewej.</p>
            ${loginUrl ? `
              <a class="usospp-btn-primary" style="display:inline-block;text-decoration:none;" href="${esc(loginUrl)}">Zaloguj się →</a>
            ` : `
              <p class="usospp-muted-text">Nie udało się znaleźć linku logowania — odśwież stronę.</p>
            `}
          </div>
        </div>
      `;
    }

    renderDashboard() {
      const grades = this.numericGrades;
      const avg = grades.length ? (grades.reduce((a, b) => a + parseFloat(b), 0) / grades.length).toFixed(2) : null;
      // Dashboard boxes always follow the concrete current week
      // (offset 0), independently of the plan view's own week offset.
      const etapy = this.etapy;
      const currentEtap = etapy[0];

      return `
        <div class="usospp-view">
          <div class="usospp-stat-grid">
            ${(() => {
              // Semester teaching progress (minutes-weighted): done hours
              // over all hours, past + future. Not the calendar semester —
              // exam sessions have no plan meetings, so the ring completes
              // at the last class. Hence the hint says "zajęć", not
              // "semestru".
              const p = this.semesterProgress;
              if (!p) return `
                <div class="usospp-card usospp-stat">
                  <div class="usospp-stat-label">Progres semestru</div>
                  <div class="usospp-stat-value">—</div>
                  <div class="usospp-stat-hint">brak zajęć w planie</div>
                </div>`;
              const approx = p.missing > 0 ? '≈ ' : '';
              return `
                <div class="usospp-card usospp-stat">
                  <div class="usospp-stat-label">Progres semestru</div>
                  <div class="usospp-ring" style="--p:${p.pct};" role="img" aria-label="Progres semestru: za Tobą ${approx}${p.pct}% godzin zajęć"><span>${p.pct}%</span></div>
                  <div class="usospp-stat-hint">${approx}${fmtHoursPl(p.doneMin)} z ${fmtHoursPl(p.totalMin)} zajęć za Tobą${p.missing > 0 ? ' · niepełne dane' : ''}</div>
                </div>`;
            })()}
            <div class="usospp-card usospp-stat">
              <div class="usospp-stat-label">Średnia (z widocznych ocen)</div>
              <div class="usospp-stat-value">${avg ? esc(avg) : '—'}</div>
              <div class="usospp-stat-hint">${grades.length ? `na podstawie ${grades.length} ocen` : 'brak ocen do policzenia'}</div>
            </div>
            <div class="usospp-card usospp-stat">
              <div class="usospp-stat-label">Etap studiów</div>
              <div class="usospp-stat-value" style="font-size:19px;">${currentEtap ? esc(currentEtap.label) : '—'}</div>
              <div class="usospp-stat-hint">${currentEtap ? esc(currentEtap.status || '') : 'brak danych'}${currentEtap ? ` · <span data-action="nav" data-view="ects" style="cursor:pointer;font-weight:600;color:oklch(58% 0.15 45);">więcej →</span>` : ''}</div>
            </div>
            <div class="usospp-card usospp-stat">
              <div class="usospp-stat-label">Egzaminy</div>
              <div class="usospp-stat-value">${this.exams.length || 0}</div>
              <div class="usospp-stat-hint" data-action="nav" data-view="egzaminy" style="cursor:pointer;font-weight:600;color:oklch(58% 0.15 45);">zobacz →</div>
            </div>
          </div>

          <div class="usospp-two-col">
            <div class="usospp-card">
              ${this.renderPanelWeekSummary()}
            </div>
            <div class="usospp-card">
              ${this.renderPanelSessions()}
            </div>
          </div>
        </div>
      `;
    }

    // Same "strona główna" announcements USOS classic shows on login — see
    // adapter.getNews. Body HTML is already sanitized down to a plain-text
    // allowlist by the adapter (it's fetched HTML from a page we don't
    // control, not something we generated), so it's safe to inject directly
    // here without another esc() pass.
    renderAktualnosci() {
      const news = this.data.newsResult || {};
      const items = news.items || [];
      if (!news.supported) {
        return `<div class="usospp-view"><div class="usospp-card"><div class="usospp-empty-hint">${this.state.newsRefreshing ? 'Ładowanie aktualności…' : 'Nie udało się odczytać aktualności ze strony USOS.'}</div><div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;"><button class="usospp-btn-ghost" data-action="newsRetry">Spróbuj ponownie</button><button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=news/default&usospp_off=1">Otwórz w USOS →</button></div></div></div>`;
      }
      if (items.length === 0) {
        return `<div class="usospp-view"><div class="usospp-empty-hint">Brak aktualności.</div></div>`;
      }
      return `
        <div class="usospp-view">
          ${items.map((item) => `
            <div class="usospp-card">
              ${item.date ? `<div class="usospp-muted-text" style="margin-bottom:6px;">${esc(item.date)}</div>` : ''}
              <div class="usospp-card-title" style="margin-bottom:10px;">${esc(item.title)}</div>
              <div class="usospp-news-body">${item.html}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    renderPlan() {
      // Foreign-plan mode: a shared page is always one real week, so the
      // scope is forced to concrete and the sessions come from the
      // per-week fetch cache. Own-plan getters stay untouched — dashboard
      // widgets, semester progress and exports never see somebody else.
      this.loadSharedPlans();
      const foreign = this.activeSharedPlan;
      if (foreign) this.ensureSharedPlanWeek();
      this.loadSharedVisibility();
      const scope = foreign ? 'concrete' : (this.state.planScope === 'generic' ? 'generic' : 'concrete');
      const sessions = this.planVisibleSessions();
      const mg = this.data.myGroupsResult || {};
      const rawEvents = this.planEvents;
      const offset = Number(this.state.planWeekOffset || 0);
      const mode = this.state.planViewMode === 'list' ? 'list' : 'week';
      const hasTemplate = this.weeklyPlan.length > 0;
      // Groups whose details (meetings behind the Dynamiczny scope) never
      // landed: an empty concrete week with missing details is a fetch
      // failure, not a free week — offer a retry instead of "wolne".
      const detailsMissing = this.planDetailsMissing();
      const planTitle = foreign ? `Plan zajęć — ${this.sharedPlanDisplayName(foreign)}` : 'Plan zajęć';
      const planBody = foreign
        ? this.renderForeignPlanBody(foreign, sessions, mode)
        : `${!hasTemplate ? `
              ${!mg.supported ? `<div class="usospp-empty-hint">Nie udało się odczytać planu zajęć (ani terminarza, ani Twoich grup) ze strony USOS.</div>`
                : `<div class="usospp-empty-hint">Brak zajęć w Twoich grupach — nie jesteś zapisany na żadne zajęcia ze stałym terminem.</div>`}
            ` : !sessions.length ? `
              ${scope === 'concrete' && detailsMissing > 0 && !this.state.planDetailsLoading ? `
                <div class="usospp-empty-hint">Nie udało się dociągnąć terminów ${detailsMissing} ${detailsMissing === 1 ? 'grupy' : 'grup'} — to może być chwilowy błąd USOSa, a nie wolny tydzień.<br><a data-action="planRetryDetails" style="font-size:12.5px;font-weight:600;cursor:pointer;">Spróbuj ponownie</a></div>
              ` : `
                <div class="usospp-empty-hint">W tym tygodniu nie masz żadnych zajęć — wolne.</div>
              `}
            ` : mode === 'week' ? this.renderPlanWeekGrid(sessions, scope) : this.renderPlanList(sessions, scope)}`;
      return `
        <div class="usospp-view">
          <div class="usospp-card usospp-plan-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">${esc(planTitle)}</div>
              <div class="usospp-plan-head-actions" style="display:flex;gap:10px;align-items:center;">
                ${foreign ? `
                  <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(foreign.url)}" title="Otwiera udostępniony plan w klasycznym USOS">Otwórz w USOS →</button>
                ` : `
                  <button class="usospp-btn-ghost" data-action="openPlanExport">Eksportuj plan</button>
                  <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=home/plan&usospp_off=1">Otwórz w USOS →</button>
                `}
              </div>
              <div class="usospp-print-brand"><span class="usospp-print-brand-word">USOS<em>++</em></span></div>
            </div>
            ${!foreign ? `
            <div class="usospp-plan-controls" style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
              <button class="usospp-mode-btn${scope === 'concrete' ? ' active' : ''}" data-action="planScopeConcrete">Dynamiczny</button>
              <button class="usospp-mode-btn${scope === 'generic' ? ' active' : ''}" data-action="planScopeGeneric">Ogólny</button>
              <span style="flex:1;"></span>
              <button class="usospp-mode-btn${mode === 'week' ? ' active' : ''}" data-action="planViewWeek">Tydzień</button>
              <button class="usospp-mode-btn${mode === 'list' ? ' active' : ''}" data-action="planViewList">Lista</button>
            </div>
            ` : `
            <div class="usospp-plan-controls" style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
              <span class="usospp-muted-text" style="font-size:12.5px;">Udostępniony plan — konkretny tydzień</span>
              <span style="flex:1;"></span>
              <button class="usospp-mode-btn${mode === 'week' ? ' active' : ''}" data-action="planViewWeek">Tydzień</button>
              <button class="usospp-mode-btn${mode === 'list' ? ' active' : ''}" data-action="planViewList">Lista</button>
            </div>
            `}
            <div class="usospp-plan-controls" style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
              ${scope === 'concrete' ? `
                <button class="usospp-btn-ghost" data-action="planWeekPrev">← Poprzedni</button>
                <button class="usospp-btn-ghost" data-action="planWeekToday" ${offset === 0 ? 'disabled style="opacity:.4;"' : ''}>Bieżący tydzień</button>
                <button class="usospp-btn-ghost" data-action="planWeekNext">Następny →</button>
                <span class="usospp-muted-text" style="font-weight:600;">${esc(this.planWeekLabel())}</span>
              ` : ''}
            </div>
            ${this.state.planDetailsLoading ? `<div class="usospp-empty-hint usospp-plan-loading" style="padding:0 0 8px 0;">Dociąganie sal i prowadzących…</div>` : ''}
            ${scope === 'generic' && hasTemplate ? (() => {
              // home/grupy lists every semester of the year with no
              // current-semester signal, so the generic template can mix
              // e.g. zimowy + letni. Concrete scope can't (real dates in
              // the displayed week). No silent filtering — say so out loud.
              const sems = [...new Set(sessions.map((e) => e && e.semester).filter(Boolean))];
              return sems.length > 1 ? `<div class="usospp-notice"><span>Ogólny miesza terminy z ${sems.length} semestrów (${esc(sems.join(' · '))}). Zakres Dynamiczny pokazuje konkretny tydzień z datami.</span></div>` : '';
            })() : ''}
            ${planBody}
            ${!foreign && !hasTemplate && rawEvents.length ? `
              <p class="usospp-muted-text">Surowe dane terminarza USOS:</p>
              <div class="usospp-raw-dump">${esc(JSON.stringify(rawEvents, null, 2))}</div>
            ` : ''}
          </div>
          <div class="usospp-card" style="margin-top:16px;">
            <div class="usospp-card-title" style="margin-bottom:6px;">Czyj plan</div>
            <div class="usospp-muted-text" style="margin-bottom:16px;">Podejrzyj plan innej osoby — wklej link spod share w USOS (Plan zajęć → share). Linki-tokeny działają ok. 14 dni, potem trzeba wkleić nowy.</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button class="usospp-mode-btn${!foreign ? ' active' : ''}" style="flex:none;" data-action="sharedPlanSelect" data-id="self">Mój plan</button>
              ${(this.state.sharedPlans.plans || []).map((p) => `
                <button class="usospp-mode-btn${foreign && foreign.id === p.id ? ' active' : ''}" style="flex:none;" data-action="sharedPlanSelect" data-id="${esc(p.id)}" title="${esc(p.ownerName || '')}">${esc(this.sharedPlanDisplayName(p))}</button>
              `).join('')}
              <button class="usospp-btn-ghost" style="flex:none;" data-action="sharedPlanAddOpen" title="Wklej link do udostępnionego planu (token lub os_id)">+ Dodaj plan…</button>
              ${foreign ? `<button class="usospp-btn-ghost" style="flex:none;" data-action="sharedPlanRemove" data-id="${esc(foreign.id)}" title="Usuń ten plan z listy">Usuń</button>` : ''}
            </div>
            ${this.renderSharedOwnLink()}
          </div>
        </div>
      `;
    }

    // Body of the plan view in foreign mode: loading / not-shared /
    // error states, otherwise the same week grid / list as the own plan
    // (sessions already carry real dates, so scope is always concrete).
    renderForeignPlanBody(foreign, sessions, mode) {
      const name = this.sharedPlanDisplayName(foreign);
      const hit = this.sharedWeekState();
      if (!hit) {
        return this._sharedLoadingKey
          ? `<div class="usospp-empty-hint">Pobieranie planu (${esc(name)})…</div>`
          : `<div class="usospp-empty-hint">Nie udało się pobrać planu — to może być chwilowy błąd USOSa.<br><a data-action="sharedPlanRetry" style="font-size:12.5px;font-weight:600;cursor:pointer;">Spróbuj ponownie</a></div>`;
      }
      if (hit.status === 'not-shared') {
        return `<div class="usospp-empty-hint"><strong>${esc(hit.ownerName || name)}</strong> nie udostępnia swojego planu zajęć — link wygasł albo wyłączono udostępnianie. Poproś o nowy odnośnik spod share w USOS.<br><a data-action="sharedPlanRetry" style="font-size:12.5px;font-weight:600;cursor:pointer;">Spróbuj ponownie</a> · <a data-action="sharedPlanRemove" data-id="${esc(foreign.id)}" style="font-size:12.5px;font-weight:600;cursor:pointer;">Usuń plan</a></div>`;
      }
      if (hit.status !== 'ready') {
        return `<div class="usospp-empty-hint">Nie udało się pobrać planu (${esc(name)}) — to może być chwilowy błąd USOSa.<br><a data-action="sharedPlanRetry" style="font-size:12.5px;font-weight:600;cursor:pointer;">Spróbuj ponownie</a></div>`;
      }
      if (!sessions.length) {
        return `<div class="usospp-empty-hint">W tym tygodniu ${esc(name)} nie ma żadnych zajęć — wolne.</div>`;
      }
      return mode === 'week' ? this.renderPlanWeekGrid(sessions, 'concrete') : this.renderPlanList(sessions, 'concrete');
    }

    // "Dodaj plan" modal: paste the shared-plan link (token or os_id), get
    // it validated live on submit, optional nickname. The token itself is
    // never rendered back anywhere (not even in the plan list) — only the
    // nickname / owner name.
    renderSharedPlanAddModal() {
      if (!this.state.sharedPlanAddOpen) return '';
      const err = this.state.sharedPlanAddError;
      return `
        <div class="usospp-modal-backdrop" data-action="sharedPlanAddCloseBackdrop">
          <div class="usospp-modal">
            <div class="usospp-modal-head">
              <div class="usospp-card-title">Dodaj cudzy plan</div>
              <button class="usospp-icon-btn" data-action="sharedPlanAddClose" title="Zamknij">${icon('close', 15)}</button>
            </div>
            <div class="usospp-muted-text" style="font-size:12.5px;margin-bottom:12px;">Poproś o link do planu: w USOS <strong>Mój USOSweb → Plan zajęć → share</strong> („wyślij komuś ten plan”). Link-token działa ok. 14 dni; na stałe działa też opcja <strong>Preferencje USOSweb → udostępnij wszystkim zalogowanym</strong> + link do profilu osoby.</div>
            <div style="font-size:12.5px;font-weight:600;margin-bottom:4px;">Link do planu</div>
            <input class="usospp-input" data-sharedplan-url type="url" inputmode="url" placeholder="https://web.usos…/kontroler.php?_action=katalog2/osoby/pokazPlanZajecStudenta&token=…" style="width:100%;margin-bottom:10px;">
            <div style="font-size:12.5px;font-weight:600;margin-bottom:4px;">Podpis (np. Ania) — opcjonalnie</div>
            <input class="usospp-input" data-sharedplan-name type="text" maxlength="40" placeholder="Jak podpisać ten plan" style="width:100%;margin-bottom:12px;">
            ${err ? `<div class="usospp-empty-hint" style="color:#b3402e;">${esc(err)}</div>` : ''}
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
              <button class="usospp-btn-ghost" data-action="sharedPlanAddClose">Anuluj</button>
              <button class="usospp-btn-ghost" data-action="sharedPlanAddSubmit" style="font-weight:700;">Dodaj plan</button>
            </div>
          </div>
        </div>
      `;
    }

    // Which plan-sharing mode is on (see adapter.getPlanVisibility).
    // Fetched once per panel lifetime on first plan-view render — a plain
    // read of the preferences page, displayed only, never flipped.
    async loadSharedVisibility() {
      if (this.state.sharedVisibility || this._sharedVisLoading) return;
      this._sharedVisLoading = true;
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const adapter = adapters && adapters.selectAdapter ? adapters.selectAdapter() : null;
      let entry = { status: 'error', mode: null };
      try {
        const res = scrape && adapter ? await scrape.fetchPlanVisibility(adapter) : null;
        if (res && res.supported && res.mode) entry = { status: 'ready', mode: res.mode };
      } catch (e) { /* keep error entry */ }
      this._sharedVisLoading = false;
      this.state.sharedVisibility = entry;
      if (this.state.view === 'plan') this.render();
    }

    // Fetches the user's own public plan link (a read-only dialog page).
    // Explicit click only, once per panel lifetime: a GET here might
    // rotate the token server-side, so it never fires automatically and
    // the URL lives in memory — shown on request, never stored anywhere.
    async showSharedOwnLink() {
      if (this._sharedOwnLoading) return;
      const cur = this.state.sharedOwnLink;
      if (cur && cur.status === 'ready') return;
      this._sharedOwnLoading = true;
      this.setState({ sharedOwnLink: { status: 'loading', url: null } });
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      const adapter = adapters && adapters.selectAdapter ? adapters.selectAdapter() : null;
      let entry = { status: 'error', url: null };
      try {
        const res = scrape && adapter ? await scrape.fetchOwnPlanLink(adapter) : null;
        if (res && res.supported && res.url) entry = { status: 'ready', url: res.url };
      } catch (e) { /* keep error entry */ }
      this._sharedOwnLoading = false;
      this.setState({ sharedOwnLink: entry });
    }

    // "Udostępnij swój plan" subsection of the Czyj-plan card: reveal link
    // on demand + copy (reuses mlegCopy) + deep-link to the classic
    // preferences where permanent sharing is toggled (flipping it would be
    // a server-side write — the one thing this extension never does).
    renderSharedOwnLink() {
      const st = this.state.sharedOwnLink;
      const vis = this.state.sharedVisibility;
      const prefsUrl = `${location.origin}/kontroler.php?_action=home/preferencje/preferencjeUsosweb`;
      const prefsLink = `<a data-action="openUsos" data-url="${esc(prefsUrl)}" style="font-weight:600;cursor:pointer;">Preferencje USOS →</a> (na samym dole, sekcja „Plan zajęć studenta”)`;
      // Live sharing status instead of a static hint: "zalogowani" means
      // every logged-in user sees the plan with no expiry; "tylko_ja"
      // means only the 14-day token link works. Display only — the toggle
      // itself stays a manual click in classic USOS.
      let statusLine;
      if (!vis || vis.status === 'loading') {
        statusLine = `<span class="usospp-muted-text">Sprawdzanie udostępniania…</span>`;
      } else if (vis.status === 'ready' && vis.mode === 'zalogowani') {
        statusLine = `<span><strong>Stałe udostępnianie: włączone</strong> — każda zalogowana osoba widzi Twój plan, bez limitu czasu. Zmiana: ${prefsLink}</span>`;
      } else if (vis.status === 'ready') {
        statusLine = `<span><strong>Stałe udostępnianie: wyłączone</strong> — działa tylko link 14-dniowy. Włącz na stałe: ${prefsLink}</span>`;
      } else {
        statusLine = `<span class="usospp-muted-text">Link-token działa ok. 14 dni; na stałe włączysz udostępnianie w USOS: ${prefsLink}</span>`;
      }
      let content;
      if (!st) {
        content = `<button class="usospp-btn-ghost" style="flex:none;" data-action="sharedOwnLinkShow">Pokaż mój link</button>`;
      } else if (st.status === 'loading') {
        content = `<div class="usospp-empty-hint">Pobieranie linku…</div>`;
      } else if (st.status === 'ready' && st.url) {
        content = `
          <input class="usospp-input" readonly value="${esc(st.url)}" style="flex:1;min-width:200px;">
          <button class="usospp-btn-ghost" style="flex:none;" data-action="mlegCopy" data-copy="${esc(st.url)}">Kopiuj</button>`;
      } else {
        content = `<div class="usospp-empty-hint">Nie udało się pobrać linku — <a data-action="sharedOwnLinkShow" style="font-size:12.5px;font-weight:600;cursor:pointer;">spróbuj ponownie</a>.</div>`;
      }
      return `
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft);">
          <div style="font-size:13.5px;font-weight:600;margin-bottom:4px;">Udostępnij swój plan</div>
          <div class="usospp-muted-text" style="font-size:12.5px;margin-bottom:4px;">Wyślij komuś link — zobaczy Twój plan.</div>
          <div style="font-size:12.5px;margin-bottom:10px;">${statusLine}</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">${content}</div>
        </div>
      `;
    }

    // Live-validates the pasted link (one read-only fetch of the current
    // week) before saving anything — a dead token or a random URL never
    // lands on the list.
    async submitSharedPlanAdd() {
      if (this._sharedAdding) return;
      const store = window.USOSPP_SHARED_PLANS;
      const fail = (msg) => this.setModalState({ sharedPlanAddError: msg });
      const urlInput = this.root && this.root.querySelector('[data-sharedplan-url]');
      const nameInput = this.root && this.root.querySelector('[data-sharedplan-name]');
      if (!store || !urlInput) { fail('Nie udało się odczytać formularza.'); return; }
      const norm = store.normalizeUrl(urlInput.value);
      if (!norm) { fail('To nie wygląda na link do udostępnionego planu — wklej pełny odnośnik spod share w USOS.'); return; }
      this._sharedAdding = true;
      try {
        const data = await store.getData();
        const dup = (data.plans || []).find((p) => p && p.url === norm.url);
        if (dup) {
          this.setModalState({ sharedPlanAddOpen: false, sharedPlanAddError: null });
          await this.persistSharedPlans((d) => ({ ...d, activeId: dup.id }));
          return;
        }
        if ((data.plans || []).length >= store.MAX_PLANS) {
          fail(`Lista pełna (maks. ${store.MAX_PLANS}) — usuń najpierw inny plan.`);
          return;
        }
        const scrape = window.USOSPP_SCRAPE;
        const adapters = window.USOSPP_ADAPTERS;
        const adapter = adapters && adapters.selectAdapter ? adapters.selectAdapter() : null;
        const mondayIso = this.planWeekDates(0)[0].iso;
        const url = scrape && scrape.PATHS ? scrape.PATHS.sharedPlanWeek(norm.url, mondayIso) : null;
        let res = null;
        try {
          res = url && adapter && scrape ? await scrape.fetchSharedPlan(adapter, url, mondayIso) : null;
        } catch (e) { res = null; }
        if (!res || (!res.supported && !res.notShared)) {
          fail('Nie udało się pobrać planu spod tego linku — sprawdź go i spróbuj ponownie.');
          return;
        }
        if (res.notShared) {
          fail(`${res.ownerName || 'Ta osoba'} nie udostępnia swojego planu zajęć.`);
          return;
        }
        const plan = {
          id: store.genId(),
          kind: norm.kind,
          url: norm.url,
          nickname: nameInput ? nameInput.value.trim().slice(0, 40) : '',
          ownerName: res.ownerName || null,
          addedAt: Date.now(),
        };
        this.setModalState({ sharedPlanAddOpen: false, sharedPlanAddError: null });
        await this.persistSharedPlans((d) => ({ plans: [...(d.plans || []), plan], activeId: plan.id }));
      } finally {
        this._sharedAdding = false;
      }
    }

    // Horizontal week timetable: day columns, full morning-to-evening hour
    // axis, sessions as positioned blocks. Same .usospp-timetable CSS as
    // the planner grid. Geometry comes from planWeekGridLayout (shared with
    // the PNG exporter); weekdays always render, an empty weekend doesn't.
    renderPlanWeekGrid(weekly, scope = 'generic') {
      const dark = this.settings.darkMode;
      const concrete = scope !== 'generic';
      const layout = planWeekGridLayout(weekly, planGridDayKeys(weekly));
      const ROW_H = layout.rowH;
      const totalHeight = layout.totalHeight;
      const hours = layout.hours;
      const hourStart = layout.hourStart;
      const shortDayName = { PN: 'Pon', WT: 'Wto', 'ŚR': 'Śro', CZ: 'Czw', PT: 'Pią', SO: 'Sob', ND: 'Nie' };
      const weekDates = concrete ? this.planWeekDates() : [];
      const dateByDay = {};
      weekDates.forEach((r) => { dateByDay[r.day] = r.date; });
      const fmtDate = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
      // Google-style "now" line in today's column (concrete scope, current
      // week only — see planNowline). Rendered once here, then repositioned
      // every 60 s by the countdown ticker via [data-nowline].
      const nowline = this.planNowline(layout, scope);
      if (nowline) ensureCountdownTicker();
      return `
        <div class="usospp-plan-week">
        <div class="usospp-timetable">
          <div class="usospp-tt-hours" style="height:${totalHeight}px;">
            ${hours.map((h) => `<div class="usospp-tt-hour" style="top:${(h - hourStart) * ROW_H}px;">${h}:00</div>`).join('')}
          </div>
          <div class="usospp-tt-days">
            ${layout.days.map((col, ci) => {
              // Generic scope is a recurring template with no real dates —
              // weekday names only. Concrete scope adds the week's date.
              const date = concrete ? (dateByDay[col.day] || (() => {
                const m = this.planWeekMonday();
                const d = new Date(m);
                d.setDate(m.getDate() + (['PN', 'WT', 'ŚR', 'CZ', 'PT', 'SO', 'ND'].indexOf(col.day)));
                return d;
              })()) : null;
              return `
              <div class="usospp-tt-daycol">
                <div class="usospp-tt-daylabel">${esc(shortDayName[col.day])}${date ? ` <span class="usospp-muted-text">${esc(fmtDate(date))}</span>` : ''}</div>
                <div class="usospp-tt-daybody" style="height:${totalHeight}px;background-size:100% ${ROW_H}px;">
                  ${nowline && col.day === nowline.day ? `<div class="usospp-nowline" data-nowline data-hour-start="${hourStart}" data-total-height="${totalHeight}" style="top:${nowline.top}px;"></div>` : ''}
                  ${!col.blocks.length ? (concrete ? `<div class="usospp-muted-text" style="position:absolute;top:10px;left:0;right:0;text-align:center;font-size:12px;">wolne</div>` : '') : col.blocks.map(({ e, lane, laneCount, top, height }) => {
                    const color = subjectColor(hashStr(e.code || e.subject || ''), dark);
                    const weeksTag = weeksLabel(e.weeks);
                    const widthPct = 100 / laneCount;
                    const leftPct = lane * widthPct;
                    const full = [e.subject, e.type + (e.nr ? `, grupa ${e.nr}` : ''), `${e.start}–${e.end}`, this.planRoomLine(e), e.teacher ? `Prowadzący: ${e.teacher}` : null].filter(Boolean).join(' — ')
                      + (weeksTag ? ` — co drugi tydzień (${e.weeks === 'even' ? 'parzyste' : 'nieparzyste'})` : '');
                    // Short blocks (e.g. 45-min classes) can't fit all five
                    // lines — compact mode shows only time + subject and the
                    // rest lives one click away in the session modal.
                    const compact = height < 90;
                    return `
                      <div class="usospp-tt-entry${compact ? ' usospp-tt-entry--compact' : ''}" title="${esc(full)}" data-action="planSessionDetails" data-idx="${e.idx}" style="top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px);right:auto;background:${color.bg};">
                        <div class="usospp-tt-entry-time" style="color:${color.time};">${esc(e.start)}–${esc(e.end)}${!compact && weeksTag ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:9.5px;padding:1px 5px;">${weeksTag}</span>` : ''}</div>
                        <div class="usospp-tt-entry-label" style="color:${color.label};">${esc(shortClassType(e.type))} · ${esc(e.subject)}</div>
                        ${compact ? '' : `
                        <div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(e.type || '')}${e.nr ? ` · grupa ${esc(String(e.nr))}` : ''}</div>
                        ${this.planRoomLine(e) ? `<div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(this.planRoomLine(e))}</div>` : ''}
                        ${e.teacher ? `<div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(e.teacher)}</div>` : ''}
                        `}
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>
        </div>
      `;
    }

    renderPlanList(weekly, scope = 'generic') {
      const concrete = scope !== 'generic';
      const DAY_NAMES = { PN: 'Poniedziałek', WT: 'Wtorek', 'ŚR': 'Środa', CZ: 'Czwartek', PT: 'Piątek', SO: 'Sobota', ND: 'Niedziela' };
      const dayKeys = concrete
        ? planGridDayKeys(weekly)
        : ['PN', 'WT', 'ŚR', 'CZ', 'PT', 'SO', 'ND'].filter((d) => weekly.some((e) => e.day === d));
      const dateByDay = {};
      if (concrete) this.planWeekDates().forEach((r) => {
        const d = r.date;
        dateByDay[r.day] = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
      });
      const weeksTag = (w) => w === 'even' ? ' <span class="usospp-badge">P</span>' : w === 'odd' ? ' <span class="usospp-badge">N</span>' : '';
      return `
        ${dayKeys.map((d) => {
          const entries = weekly.filter((e) => e.day === d);
          return `
          <div class="usospp-card-title" style="margin:14px 0 8px 0;">${DAY_NAMES[d]}${concrete && dateByDay[d] ? ` <span class="usospp-muted-text">${esc(dateByDay[d])}</span>` : ''}</div>
          ${!entries.length ? `<div class="usospp-empty-hint" style="padding:4px 0;">wolne</div>` : entries.map((e) => {
            const c = subjectColor(hashStr(e.code || e.subject || ''), this.settings.darkMode);
            const roomLine = this.planRoomLine(e);
            return `
            <div class="usospp-list-row" style="border-left:4px solid ${c.bg};cursor:pointer;" data-action="planSessionDetails" data-idx="${e.idx}">
              <div style="padding-left:8px;">
                <div style="font-weight:600;">${esc(e.start)} – ${esc(e.end)}${weeksTag(e.weeks)}</div>
                <div style="font-size:13px;">${esc(e.subject)}${e.code ? ` <span class="usospp-muted-text">[${esc(e.code)}]</span>` : ''}</div>
                <div class="usospp-muted-text" style="font-size:12px;">${esc(e.type || '')}${e.nr ? `, grupa ${esc(String(e.nr))}` : ''}${roomLine ? ` · ${esc(roomLine)}` : ''}</div>
                ${e.teacher ? `<div class="usospp-muted-text" style="font-size:12px;">${esc(e.teacher)}</div>` : ''}
              </div>
            </div>`;
          }).join('')}
          `;
        }).join('')}
      `;
    }

    // Shared "what's on screen" snapshot for both exporters: current
    // scope/mode/week, the sessions behind it, a human label and a
    // filename stem. No DOM — safe in tests. Generic scope is labelled
    // with the student's kierunek (same getter the Zapisy filter uses),
    // falling back to "Ogólny" when programmes weren't scraped.
    planExportSource() {
      const scope = this.state.planScope === 'generic' ? 'generic' : 'concrete';
      const mode = this.state.planViewMode === 'list' ? 'list' : 'week';
      const sessions = scope === 'generic' ? this.weeklyPlan : this.concreteWeekSessions;
      const label = scope === 'generic' ? (this.kierunek || 'Ogólny') : this.planWeekLabel();
      const m = this.planWeekMonday();
      const fileStem = scope === 'generic'
        ? 'plan-ogolny'
        : `plan-${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
      return { scope, mode, sessions, label, fileStem, title: `Plan zajęć – ${label}` };
    }

    // PDF = the browser's print dialog pointed at a print stylesheet that
    // isolates the plan card (see usos.css @media print): the user picks
    // "Save as PDF" there. No new permissions, no new dependencies. The
    // card is zoomed to fit one A4 landscape page (see planPrintZoom).
    exportPlanPdf() {
      if (typeof document === 'undefined' || typeof window === 'undefined') return false;
      const src = this.planExportSource();
      const prevTitle = document.title;
      document.title = src.title;
      document.body.classList.add('usospp-print-plan');
      // Fit-to-one-page: measure the card after print styles apply, then
      // zoom it into the usable page box. minHeight stretches the card to
      // the full usable height (in unzoomed px) so the flex centering from
      // print CSS has room to work instead of hugging the top. Both inline
      // styles removed in cleanup so the screen view is untouched.
      const card = typeof document.querySelector === 'function'
        ? document.querySelector('#usospp-container .usospp-plan-card')
        : null;
      let zoomed = null;
      if (card) {
        const z = planPrintZoom(card.scrollHeight || 0, card.scrollWidth || 0, true);
        if (z < 1) card.style.zoom = String(z);
        card.style.minHeight = `${planPrintContentH(true) / z}px`;
        zoomed = card;
      }
      const cleanup = () => {
        document.title = prevTitle;
        if (zoomed) { zoomed.style.zoom = ''; zoomed.style.minHeight = ''; }
        document.body.classList.remove('usospp-print-plan');
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      window.print();
      return true;
    }

    // PNG = the current plan painted onto a <canvas> (always light, brand
    // lockup top-right) and downloaded via an object-URL anchor — works
    // from a content script, no `downloads` permission needed. Returns
    // false when there's nothing to draw or no DOM (tests).
    exportPlanPng() {
      if (typeof document === 'undefined') return false;
      const src = this.planExportSource();
      if (!src.sessions.length) return false;
      const canvas = document.createElement('canvas');
      const ok = src.mode === 'list'
        ? this.paintPlanListCanvas(canvas, src)
        : this.paintPlanWeekCanvas(canvas, src);
      if (!ok || typeof canvas.toBlob !== 'function') return false;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${src.fileStem}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, 'image/png');
      return true;
    }

    // Whole-semester concrete sessions: tiles concreteSessionsForOffset
    // from the current week forward (meetings already sit in groupDetails —
    // no per-week fetching). Stops after 3 consecutive empty weeks (a
    // mid-semester break must not truncate the tail) with a hard cap of 20
    // offsets against pathological data. Past weeks are never included.
    planSemesterSessions() {
      const MAX_OFF = 19;
      const EMPTY_BREAK = 3;
      const out = [];
      let emptyRun = 0;
      for (let off = 0; off <= MAX_OFF; off++) {
        const week = this.concreteSessionsForOffset(off);
        if (!week.length) {
          emptyRun++;
          if (emptyRun >= EMPTY_BREAK) break;
          continue;
        }
        emptyRun = 0;
        out.push(...week);
      }
      out.sort((a, b) => (a.date || '').localeCompare(b.date || '')
        || (toMin(a.start) ?? Infinity) - (toMin(b.start) ?? Infinity));
      return out;
    }

    // Mirror of planSemesterSessions into the past: tiles
    // concreteSessionsForOffset backwards from last week (off -1, -2, …).
    // Same stop rule (3 consecutive empty weeks must not truncate the head
    // — a mid-semester break is empty in both directions) and the same
    // hard cap. Backs the semester-progress ring on the dashboard.
    planPastSessions() {
      const MAX_BACK = 19;
      const EMPTY_BREAK = 3;
      const out = [];
      let emptyRun = 0;
      for (let off = -1; off >= -MAX_BACK; off--) {
        const week = this.concreteSessionsForOffset(off);
        if (!week.length) {
          emptyRun++;
          if (emptyRun >= EMPTY_BREAK) break;
          continue;
        }
        emptyRun = 0;
        out.push(...week);
      }
      out.sort((a, b) => (a.date || '').localeCompare(b.date || '')
        || (toMin(a.start) ?? Infinity) - (toMin(b.start) ?? Infinity));
      return out;
    }

    // Groups whose meeting details never loaded (same count renderPlan
    // uses to tell a fetch failure from a free week). Their meetings are
    // absent from every concrete computation, so semester totals built on
    // them are a lower bound.
    planDetailsMissing() {
      const mg = this.data.myGroupsResult || {};
      const det = (this.data.groupDetails && typeof this.data.groupDetails === 'object')
        ? this.data.groupDetails : {};
      let missing = 0;
      (Array.isArray(mg.subjects) ? mg.subjects : []).forEach((s) => {
        ((s && s.groups) || []).forEach((g) => {
          if (g && g.detailsUrl && !det[g.detailsUrl]) missing++;
        });
      });
      return missing;
    }

    // Semester teaching progress, minutes-weighted: a 3 h lab moves the
    // needle more than a 45′ lektorat. done = fully finished (end <= now);
    // a currently-running session doesn't count yet. Past weeks come from
    // planPastSessions, the current week onwards from planSemesterSessions
    // (deduped by identity — the walks are week-disjoint, this is just
    // insurance). Null when there is nothing to measure; `missing` flags
    // the lower-bound case (see planDetailsMissing).
    get semesterProgress() {
      const nowMs = Date.now();
      const seen = new Set();
      let doneMin = 0, totalMin = 0;
      this.planPastSessions().concat(this.planSemesterSessions()).forEach((e) => {
        if (!e) return;
        const start = this.sessionDateTime(e, 'start');
        const end = this.sessionDateTime(e, 'end');
        if (start == null || end == null || end <= start) return;
        const key = `${e.date}|${e.start}|${e.end}|${e.subject}|${e.type}|${e.nr}|${e.detailsUrl || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        const mins = Math.round((end - start) / 60000);
        totalMin += mins;
        if (end <= nowMs) doneMin += mins;
      });
      if (!totalMin) return null;
      return {
        doneMin,
        totalMin,
        pct: Math.round((doneMin / totalMin) * 100),
        missing: this.planDetailsMissing(),
      };
    }

    // ICS = a whole-semester .ics download (same object-URL anchor trick
    // as PNG — works from a content script, no `downloads` permission).
    // Concrete scope only: the generic template has no real dates and USOS
    // week parity can't be mapped onto calendar recurrence honestly.
    // Returns false when there is nothing to export or no DOM (tests).
    exportPlanIcs() {
      if (typeof document === 'undefined') return false;
      if (this.state.planScope === 'generic') return false;
      const sessions = this.planSemesterSessions();
      if (!sessions.length) return false;
      const sems = [...new Set(sessions.map((s) => s && s.semester).filter(Boolean))];
      const semSlug = sems.length
        ? sems[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        : '';
      const label = sems.length > 1 ? `${sems.length}-semestry` : (semSlug || 'semestr');
      const { ics } = buildPlanIcs(sessions, {
        dtstamp: icsStamp(new Date()),
        calName: `Plan zajęć – ${sems.length ? sems.join(' · ') : label}`,
        domain: (() => { try { return location.hostname; } catch (e) { return 'usospp'; } })(),
      });
      const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `plan-${label}.ics`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return true;
    }

    // Paints the week grid onto a canvas using planWeekGridLayout — the
    // same geometry as the HTML grid, so the image matches the screen.
    // Always light (see planExportHue for the canvas-safe palette).
    paintPlanWeekCanvas(canvas, src) {
      const dayKeys = planGridDayKeys(src.sessions);
      const layout = planWeekGridLayout(src.sessions, dayKeys);
      const names = { PN: 'Poniedziałek', WT: 'Wtorek', 'ŚR': 'Środa', CZ: 'Czwartek', PT: 'Piątek', SO: 'Sobota', ND: 'Niedziela' };
      const dateByDay = {};
      if (src.scope !== 'generic') {
        this.planWeekDates().forEach((r) => {
          const d = r.date;
          dateByDay[r.day] = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
        });
      }
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return false;
      const S = 2; // retina scale for crisp text
      const gutter = 64, headH = 96, dayH = 32, pad = 24, colW = 230;
      const gridTop = headH + dayH;
      const W = gutter + dayKeys.length * colW + pad;
      const H = gridTop + layout.totalHeight + pad;
      canvas.width = W * S;
      canvas.height = H * S;
      ctx.scale(S, S);
      const INK = '#18181b', SUB = '#52525b', LINE = '#e4e4e7';
      const FONT = '"General Sans", system-ui, -apple-system, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = INK;
      ctx.font = `700 22px ${FONT}`;
      ctx.fillText('Plan zajęć', pad, 36);
      ctx.fillStyle = SUB;
      ctx.font = `14px ${FONT}`;
      ctx.fillText(src.label, pad, 60);
      paintPlanLogo(ctx, W, pad, 28);
      ctx.font = `700 14px ${FONT}`;
      dayKeys.forEach((dk, i) => {
        const x = gutter + i * colW;
        ctx.fillStyle = INK;
        ctx.fillText(dateByDay[dk] ? `${names[dk]} ${dateByDay[dk]}` : names[dk], x + 8, headH + 21);
      });
      ctx.font = `12px ${FONT}`;
      layout.hours.forEach((h) => {
        const y = gridTop + (h - layout.hourStart) * layout.rowH;
        ctx.fillStyle = LINE;
        ctx.fillRect(gutter, y, W - gutter - pad, 1);
        ctx.fillStyle = SUB;
        ctx.fillText(`${h}:00`, 10, y + 14);
      });
      layout.days.forEach((col, i) => {
        const x = gutter + i * colW;
        ctx.fillStyle = LINE;
        ctx.fillRect(x, gridTop, 1, layout.totalHeight);
        col.blocks.forEach((b) => {
          const e = b.e;
          const laneW = colW / b.laneCount;
          const bx = x + b.lane * laneW + 3;
          const bw = laneW - 6;
          const by = gridTop + b.top;
          const hue = planExportHue(hashStr(e.code || e.subject || ''));
          if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(bx, by, bw, b.height, 6);
            ctx.fillStyle = `hsl(${hue}, 65%, 88%)`;
            ctx.fill();
            ctx.strokeStyle = `hsl(${hue}, 45%, 60%)`;
            ctx.lineWidth = 1;
            ctx.stroke();
          } else {
            ctx.fillStyle = `hsl(${hue}, 65%, 88%)`;
            ctx.fillRect(bx, by, bw, b.height);
            ctx.strokeStyle = `hsl(${hue}, 45%, 60%)`;
            ctx.strokeRect(bx, by, bw, b.height);
          }
          ctx.fillStyle = `hsl(${hue}, 45%, 30%)`;
          ctx.font = `700 12px ${FONT}`;
          const tag = e.weeks === 'even' ? ' (P)' : e.weeks === 'odd' ? ' (N)' : '';
          ctx.fillText(fitText(ctx, `${e.start}–${e.end}${tag}`, bw - 12), bx + 6, by + 17);
          ctx.fillStyle = INK;
          ctx.font = `12px ${FONT}`;
          ctx.fillText(fitText(ctx, `${shortClassType(e.type)} · ${e.subject}`, bw - 12), bx + 6, by + 33);
          if (b.height >= 90) {
            ctx.fillStyle = SUB;
            ctx.font = `11.5px ${FONT}`;
            let line = by + 49;
            const meta = `${e.type || ''}${e.nr ? ` · grupa ${e.nr}` : ''}`.trim();
            if (meta) { ctx.fillText(fitText(ctx, meta, bw - 12), bx + 6, line); line += 16; }
            const room = this.planRoomLine(e);
            if (room) { ctx.fillText(fitText(ctx, room, bw - 12), bx + 6, line); line += 16; }
            if (e.teacher) ctx.fillText(fitText(ctx, e.teacher, bw - 12), bx + 6, line);
          }
        });
      });
      return true;
    }

    // Paints the list view onto a canvas: day sections with date, rows
    // with a subject color bar, time, subject and details. Always light.
    paintPlanListCanvas(canvas, src) {
      const names = { PN: 'Poniedziałek', WT: 'Wtorek', 'ŚR': 'Środa', CZ: 'Czwartek', PT: 'Piątek', SO: 'Sobota', ND: 'Niedziela' };
      const order = ['PN', 'WT', 'ŚR', 'CZ', 'PT', 'SO', 'ND'];
      const dayKeys = src.scope === 'generic'
        ? order.filter((d) => src.sessions.some((e) => e.day === d))
        : planGridDayKeys(src.sessions);
      const dateByDay = {};
      if (src.scope !== 'generic') {
        this.planWeekDates().forEach((r) => {
          const d = r.date;
          dateByDay[r.day] = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
        });
      }
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return false;
      const S = 2;
      const pad = 32, headH = 96, dayHeadH = 34, rowH = 68, freeH = 20;
      const W = 1100;
      const counts = dayKeys.map((d) => src.sessions.filter((e) => e.day === d).length);
      const entryCount = counts.reduce((n, c) => n + c, 0);
      const emptyCount = counts.filter((c) => c === 0).length;
      const H = headH + dayKeys.length * dayHeadH + entryCount * rowH + emptyCount * freeH + pad;
      canvas.width = W * S;
      canvas.height = H * S;
      ctx.scale(S, S);
      const INK = '#18181b', SUB = '#52525b', LINE = '#e4e4e7';
      const FONT = '"General Sans", system-ui, -apple-system, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = INK;
      ctx.font = `700 22px ${FONT}`;
      ctx.fillText('Plan zajęć', pad, 36);
      ctx.fillStyle = SUB;
      ctx.font = `14px ${FONT}`;
      ctx.fillText(src.label, pad, 60);
      paintPlanLogo(ctx, W, pad, 28);
      let y = headH;
      dayKeys.forEach((dk) => {
        const entries = src.sessions.filter((e) => e.day === dk);
        ctx.fillStyle = INK;
        ctx.font = `700 15px ${FONT}`;
        ctx.fillText(dateByDay[dk] ? `${names[dk]}  ${dateByDay[dk]}` : names[dk], pad, y + 22);
        y += dayHeadH;
        if (!entries.length) {
          ctx.fillStyle = SUB;
          ctx.font = `12px ${FONT}`;
          ctx.fillText('wolne', pad + 16, y + 14);
          y += freeH;
        }
        entries.forEach((e) => {
          const hue = planExportHue(hashStr(e.code || e.subject || ''));
          ctx.fillStyle = `hsl(${hue}, 55%, 55%)`;
          ctx.fillRect(pad, y + 6, 5, rowH - 12);
          ctx.fillStyle = INK;
          ctx.font = `700 13px ${FONT}`;
          const tag = e.weeks === 'even' ? ' (P)' : e.weeks === 'odd' ? ' (N)' : '';
          ctx.fillText(`${e.start} – ${e.end}${tag}`, pad + 16, y + 22);
          ctx.font = `13px ${FONT}`;
          ctx.fillText(fitText(ctx, `${e.subject}${e.code ? ` [${e.code}]` : ''}`, W - pad * 2 - 16), pad + 16, y + 41);
          ctx.fillStyle = SUB;
          ctx.font = `12px ${FONT}`;
          const room = this.planRoomLine(e);
          ctx.fillText(fitText(ctx,
            `${e.type || ''}${e.nr ? `, grupa ${e.nr}` : ''}${room ? ` · ${room}` : ''}${e.teacher ? ` · ${e.teacher}` : ''}`.trim(),
            W - pad * 2 - 16), pad + 16, y + 58);
          ctx.fillStyle = LINE;
          ctx.fillRect(pad, y + rowH - 1, W - pad * 2, 1);
          y += rowH;
        });
      });
      return true;
    }

    renderOceny() {
      const rows = this.gradeRows;
      const g = this.data.gradesResult || {};
      const grades = this.numericGrades;
      const avg = grades.length ? (grades.reduce((a, b) => a + parseFloat(b), 0) / grades.length).toFixed(2) : null;
      const cellOf = (row) => {
        if (row && typeof row === 'object' && !Array.isArray(row)) {
          return { subject: row.subject || '', program: row.program || '', grade: row.grade, gradeText: row.gradeText || '' };
        }
        const cells = Array.isArray(row) ? row : [row.label, row.text];
        return { subject: cells[0] || '', program: cells[1] || '', grade: null, gradeText: cells[2] || '' };
      };
      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Oceny końcowe z przedmiotów</div>
              <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dla_stud/studia/oceny/index&usospp_off=1">Otwórz w USOS →</button>
            </div>
            <div class="usospp-stat-hint" style="margin-bottom:10px;">${avg ? `Średnia: <strong>${esc(avg)}</strong> na podstawie ${grades.length} ${grades.length === 1 ? 'oceny' : 'ocen'}` : 'Brak ocen końcowych — średnia niepoliczona.'}</div>
            ${!g.supported ? `
              <div class="usospp-empty-hint">Nie udało się odczytać ocen ze strony USOS.</div>
            ` : rows.length === 0 ? `
              <div class="usospp-empty-hint">Brak ocen końcowych — jeszcze nic tu nie ma w tym cyklu.</div>
            ` : `
              <table class="usospp-table">
                <thead><tr><th>Przedmiot</th><th>Program</th><th>Ocena</th></tr></thead>
                <tbody>
                  ${rows.map((row) => {
                    const c = cellOf(row);
                    const badge = c.grade ? gradeBadge(c.grade) : null;
                    return `<tr><td>${esc(c.subject)}</td><td>${esc(c.program)}</td><td>${c.grade
                      ? `<span class="usospp-badge" style="background:${badge.bg};color:${badge.color};">${esc(c.grade.replace('.', ','))}</span>`
                      : `<span class="usospp-muted-text">—</span>`}</td></tr>`;
                  }).join('')}
                </tbody>
              </table>
            `}
          </div>
        </div>
      `;
    }

    // The hub tile screen behind the "Przedmioty" nav item — Przegląd,
    // Zapisy and Generator planu each used to be their own top-level nav row;
    // grouping them here freed up sidebar space for future sections.
    renderPrzedmiotyHub() {
      const tiles = [
        { view: 'przedmiotyLista', icon: 'book', title: 'Przegląd przedmiotów', desc: 'Etapy studiów i przedmioty przypisane do Twojego programu.' },
        { view: 'zapisy', icon: 'ticket', title: 'Zapisy na przedmioty', desc: 'Twoje tury rejestracji — terminy, przedmioty i plany. Sam zapis odbywa się w USOSweb.' },
        { view: 'planer', icon: 'layers', title: 'Generator planu', desc: 'Poukładaj sobie plan zajęć na próbę, zanim zapiszesz się naprawdę.' },
      ];
      // All three tiles are personal — logged out they all land on the login
      // prompt, so dim them with the shared locked-tile style + lock pill
      // (same as IRK's renderHubTile) instead of looking freely available.
      const locked = !!this.data.loggedOut;
      return `
        <div class="usospp-view">
          <div class="usospp-hub-grid">
            ${tiles.map((t) => `
              <div class="usospp-hub-tile${locked ? ' usospp-hub-tile-locked' : ''}" data-action="nav" data-view="${esc(t.view)}">
                <div class="usospp-hub-tile-icon">${icon(locked ? 'lock' : t.icon, 20)}</div>
                <div class="usospp-hub-tile-title">${esc(t.title)}</div>
                ${locked
                  ? `<div class="usospp-lock-hint">${icon('lock', 12)} Zaloguj się, aby odblokować</div>`
                  : `<div class="usospp-hub-tile-desc">${esc(t.desc)}</div>`}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Publiczny hub Katalogu — ten sam pattern co renderPrzedmiotyHub:
    // kafelki prowadzą do pod-widoków przez data-action="nav". Działa bez
    // logowania (PUBLIC_VIEWS), wszystko dociągane leniwie z katalog2.
    renderKatalogHub() {
      const tiles = [
        { view: 'katalogJednostki', icon: 'grid', title: 'Jednostki', desc: 'Wydziały, katedry i instytuty — przeglądaj strukturę uczelni.' },
        { view: 'katalogPrzedmioty', icon: 'book', title: 'Przedmioty', desc: 'Oferta przedmiotów wybranej jednostki.' },
        { view: 'katalogKierunki', icon: 'star', title: 'Kierunki i programy', desc: 'Co można studiować — programy zgrupowane po kierunku.' },
        { view: 'katalogBudynki', icon: 'pin', title: 'Budynki', desc: 'Lista budynków z adresami i podglądem na mapie.' },
      ];
      return `
        <div class="usospp-view">
          <div class="usospp-hub-grid">
            ${tiles.map((t) => `
              <div class="usospp-hub-tile" data-action="nav" data-view="${esc(t.view)}">
                <div class="usospp-hub-tile-icon">${icon(t.icon, 20)}</div>
                <div class="usospp-hub-tile-title">${esc(t.title)}</div>
                <div class="usospp-hub-tile-desc">${esc(t.desc)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Jednostki: przeglądanie drzewa od korzenia uczelni. Root wyprowadzany
    // jak w fetchMapaData (własny wydział → ancestors[0], anonimowo: public
    // search → ancestors). Klik w dziecko przełącza browse na tę jednostkę,
    // klik w nazwę/„szczegóły” otwiera pełną stronę catalogPage unit.
    renderKatalogJednostki() {
      const s = this.state;
      if (s.katalogRootLoading || s.katalogBrowseLoading) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie jednostek…</div></div></div>`;
      }
      const data = s.katalogBrowseData || s.katalogRootData;
      if (s.katalogRootError || s.katalogBrowseError || !data) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać jednostek.</div><div style="margin-top:10px;"><a data-action="katalogRetry" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div></div></div>`;
      }
      const atRoot = !s.katalogBrowseKod || s.katalogBrowseKod === s.katalogRootKod;
      return `
        <div class="usospp-view">
          ${backLink('katalog')}
          <div class="usospp-card">
            ${data.ancestors && data.ancestors.length ? `
              <div style="font-size:12.5px;color:var(--ink-3);margin-bottom:10px;">
                ${data.ancestors.map((a) => `<span data-action="katalogBrowseUnit" data-kod="${esc(a.kod)}" style="text-decoration:underline;cursor:pointer;">${esc(a.name)}</span>`).join(' / ')}
              </div>
            ` : ''}
            <div class="usospp-card-title" style="margin-bottom:6px;">${esc(data.name || 'Jednostki')}</div>
            <div style="margin-bottom:14px;"><a data-action="searchOpenUnit" data-kod="${esc(atRoot ? (s.katalogRootKod || '') : (s.katalogBrowseKod || ''))}" style="font-size:12.5px;font-weight:600;cursor:pointer;">szczegóły jednostki →</a></div>
            ${(data.children || []).length ? `
              <div class="usospp-card" style="box-shadow:none;border:1px solid var(--border);">
                <div class="usospp-card-title" style="margin-bottom:14px;">Jednostki podrzędne (${(data.children || []).length})</div>
                ${(data.children || []).map((c) => `
                  <div class="usospp-list-row" data-action="katalogBrowseUnit" data-kod="${esc(c.kod)}" style="cursor:pointer;">
                    <div style="font-size:13.5px;font-weight:500;">${esc(c.name)}</div>
                    <div style="color:var(--ink-3);">→</div>
                  </div>
                `).join('')}
              </div>
            ` : `<div class="usospp-empty-hint">Brak podjednostek.</div>`}
          </div>
        </div>
      `;
    }

    // Wspólny picker jednostek (dzieci roota = wydziały) dla Przedmiotów
    // i Kierunków. USOS nie ma endpointu „wszystkie przedmioty uczelni” —
    // jest tylko oferta per jednostka (faculty_organized / by_faculty),
    // więc wybór wydziału jest bramą do przeglądania, nie doodatkiem.
    renderKatalogUnitPicker(selectedKod) {
      const root = this.state.katalogRootData;
      const kids = (root && root.children) || [];
      if (!kids.length) return '';
      const chipStyle = 'flex:0 0 auto;border-radius:99px;padding:6px 13px;font-size:12.5px;';
      return `
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">
          ${kids.map((c) => `<button class="usospp-mode-btn${selectedKod === c.kod ? ' active' : ''}" style="${chipStyle}" data-action="katalogSelectUnit" data-kod="${esc(c.kod)}">${esc(c.name)}</button>`).join('')}
        </div>
      `;
    }

    renderKatalogPrzedmioty() {
      const s = this.state;
      if (s.katalogRootLoading) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie jednostek…</div></div></div>`;
      }
      if (s.katalogRootError || !s.katalogRootData) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać jednostek.</div><div style="margin-top:10px;"><a data-action="katalogRetry" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div></div></div>`;
      }
      const q = (s.katalogPrzedmiotyQuery || '').trim().toLowerCase();
      const currentYear = (() => {
        const years = new Set();
        s.katalogPrzedmioty.forEach((r) => (r.years || []).forEach((y) => years.add(y)));
        return years.size ? Math.max(...years) : null;
      })();
      const rows = s.katalogPrzedmioty.filter((r) => {
        if (s.katalogPrzedmiotyCurrentOnly && currentYear && !(r.years || []).includes(currentYear)) return false;
        if (!q) return true;
        return (r.name || '').toLowerCase().includes(q) || (r.kod || '').toLowerCase().includes(q);
      });
      const yearLabel = currentYear ? `${currentYear}/${String((currentYear + 1) % 100).padStart(2, '0')}` : '';
      return `
        <div class="usospp-view">
          ${backLink('katalog')}
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:12px;">Wybierz jednostkę</div>
            ${this.renderKatalogUnitPicker(s.katalogPrzedmiotyUnitKod)}
            ${!s.katalogPrzedmiotyUnitKod ? `<div class="usospp-empty-hint">Wybierz wydział powyżej, aby zobaczyć jego ofertę przedmiotów.</div>` : `
              <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">
                <input class="usospp-search-input" data-action="katalogPrzedmiotyQueryInput" type="text" placeholder="Szukaj po nazwie lub kodzie…" autocomplete="off" value="${esc(s.katalogPrzedmiotyQuery)}" style="flex:1;">
                ${currentYear && s.katalogPrzedmioty.length ? `<a data-action="katalogPrzedmiotyToggleCurrent" style="font-size:12px;font-weight:600;color:${s.katalogPrzedmiotyCurrentOnly ? '#d9773a' : 'var(--ink-3)'};white-space:nowrap;cursor:pointer;">${s.katalogPrzedmiotyCurrentOnly ? '●' : '○'} tylko ${esc(yearLabel)}</a>` : ''}
              </div>
              <div data-katalog-przedmioty-root>
                ${s.katalogPrzedmiotyLoading && !s.katalogPrzedmioty.length ? `<div class="usospp-empty-hint">Wczytywanie przedmiotów…</div>` : `
                  ${rows.slice(0, 400).map((r) => `
                    <div class="usospp-list-row" data-action="openSubjectPage" data-url="${esc(r.url)}" style="cursor:pointer;align-items:flex-start;">
                      <div>
                        <div style="font-size:13.5px;font-weight:500;">${esc(r.name)}</div>
                        ${r.grupa ? `<div style="color:var(--ink-3);font-size:12px;margin-top:2px;">${esc(r.grupa)}</div>` : ''}
                      </div>
                      <div style="color:var(--ink-3);font-size:11.5px;font-family:ui-monospace,Menlo,monospace;flex-shrink:0;">${esc(r.kod)}</div>
                    </div>
                  `).join('')}
                  ${rows.length > 400 ? `<div class="usospp-empty-hint">Pokazuję pierwszych 400 — doprecyzuj wyszukiwanie, aby zawęzić.</div>` : ''}
                  ${!rows.length && !s.katalogPrzedmiotyLoading ? `<div class="usospp-empty-hint">Brak przedmiotów${q || (s.katalogPrzedmiotyCurrentOnly && currentYear) ? ' spełniających filtr' : ' w tej jednostce'}.</div>` : ''}
                  ${s.katalogPrzedmiotyLoading ? `<div class="usospp-empty-hint">Wczytywanie…</div>` : ''}
                  ${s.katalogPrzedmiotyNextUrl && !s.katalogPrzedmiotyLoading ? `<a data-action="katalogPrzedmiotyLoadMore" style="display:inline-block;margin-top:10px;font-size:13px;font-weight:600;color:#d9773a;cursor:pointer;">Wczytaj więcej →</a>` : ''}
                `}
              </div>
            `}
          </div>
        </div>
      `;
    }

    // Wariant A: brak osobnego parsera kierunku — programy grupowane po
    // polu `kierunek` z getUnitPrograms (jeden wiersz USOS na kierunek,
    // w środku kilka instancji pokazProgram). Klik → searchOpenProgram.
    renderKatalogKierunki() {
      const s = this.state;
      if (s.katalogRootLoading) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie jednostek…</div></div></div>`;
      }
      if (s.katalogRootError || !s.katalogRootData) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać jednostek.</div><div style="margin-top:10px;"><a data-action="katalogRetry" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div></div></div>`;
      }
      const byKierunek = new Map();
      s.katalogKierunki.forEach((p) => {
        const key = p.kierunek || '—';
        if (!byKierunek.has(key)) byKierunek.set(key, []);
        byKierunek.get(key).push(p);
      });
      return `
        <div class="usospp-view">
          ${backLink('katalog')}
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:12px;">Wybierz jednostkę</div>
            ${this.renderKatalogUnitPicker(s.katalogKierunkiUnitKod)}
            ${!s.katalogKierunkiUnitKod ? `<div class="usospp-empty-hint">Wybierz wydział powyżej, aby zobaczyć jego kierunki i programy.</div>` : `
              ${s.katalogKierunkiLoading && !s.katalogKierunki.length ? `<div class="usospp-empty-hint">Wczytywanie programów…</div>` : `
                ${[...byKierunek.entries()].map(([kierunek, programs]) => `
                  <div style="margin-bottom:10px;">
                    ${kierunek !== '—' ? `<div style="font-size:12px;font-weight:600;color:var(--ink-3);margin-bottom:4px;">${esc(kierunek)}</div>` : ''}
                    <div style="display:flex;flex-wrap:wrap;gap:6px;">${programs.map((p) => `<button class="usospp-mode-btn" style="flex:0 0 auto;border-radius:99px;padding:6px 13px;font-size:12.5px;" data-action="searchOpenProgram" data-kod="${esc(p.kod)}">${esc(p.name)}</button>`).join('')}</div>
                  </div>
                `).join('')}
                ${!s.katalogKierunki.length && !s.katalogKierunkiLoading ? `<div class="usospp-empty-hint">Brak programów w tej jednostce.</div>` : ''}
                ${s.katalogKierunkiNextUrl && !s.katalogKierunkiLoading ? `<a data-action="katalogKierunkiLoadMore" style="display:inline-block;margin-top:10px;font-size:13px;font-weight:600;color:#d9773a;cursor:pointer;">Wczytaj więcej →</a>` : ''}
              `}
            `}
          </div>
        </div>
      `;
    }

    // Budynki: ta sama lista co Mapa (state.mapaBuildings), ale jako lista
    // nazwa / jednostka / adres + „Zobacz na mapie” → openMapaFocused.
    renderKatalogBudynki() {
      const s = this.state;
      if (s.mapaLoading || (!s.mapaBuildings.length && !s.mapaError)) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie budynków…</div></div></div>`;
      }
      if (s.mapaError || !s.mapaBuildings.length) {
        return `<div class="usospp-view">${backLink('katalog')}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać budynków.</div><div style="margin-top:10px;"><a data-action="mapaRefresh" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div></div></div>`;
      }
      const q = (s.katalogBudynkiQuery || '').trim().toLowerCase();
      const rows = s.mapaBuildings.filter((b) => {
        if (!q) return true;
        return (b.name || '').toLowerCase().includes(q)
          || (b.kod || '').toLowerCase().includes(q)
          || (b.address || '').toLowerCase().includes(q)
          || (b.unitName || '').toLowerCase().includes(q);
      });
      return `
        <div class="usospp-view">
          ${backLink('katalog')}
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Budynki (${rows.length}${q ? ` z ${s.mapaBuildings.length}` : ''})</div>
            </div>
            <input class="usospp-search-input" data-action="katalogBudynkiQueryInput" type="text" placeholder="Szukaj budynku, adresu, jednostki…" autocomplete="off" value="${esc(s.katalogBudynkiQuery)}" style="width:100%;margin-bottom:12px;">
            <div data-katalog-budynki-root>
              ${rows.slice(0, 300).map((b) => `
                <div class="usospp-list-row" style="align-items:flex-start;">
                  <div>
                    <div style="font-size:13.5px;font-weight:500;">${esc(b.name)}</div>
                    ${b.unitName ? `<div style="color:var(--ink-3);font-size:12px;margin-top:2px;">${esc(b.unitName)}</div>` : ''}
                    ${b.address ? `<div style="color:var(--ink-3);font-size:12px;margin-top:2px;">${esc(b.address)}</div>` : ''}
                  </div>
                  <div style="flex-shrink:0;">${b.kod ? `<a data-action="openMapaFocused" data-kod="${esc(b.kod)}" style="font-size:12px;font-weight:600;color:#d9773a;cursor:pointer;">Zobacz na mapie →</a>` : ''}</div>
                </div>
              `).join('')}
              ${rows.length > 300 ? `<div class="usospp-empty-hint">Pokazuję pierwszych 300 — doprecyzuj wyszukiwanie, aby zawęzić.</div>` : ''}
              ${!rows.length ? `<div class="usospp-empty-hint">Brak budynków spełniających filtr.</div>` : ''}
            </div>
          </div>
        </div>
      `;
    }

    renderPrzedmiotyLista() {
      const etapy = this.etapy;
      const stages = this.stageSubjects;
      return `
        <div class="usospp-view">
          ${backLink('przedmioty')}
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Przedmioty / etapy studiów</div>
              <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dla_stud/studia/podpiecia/lista&usospp_off=1">Podpięcia w USOS →</button>
            </div>
            ${etapy.length === 0 ? `
              <div class="usospp-empty-hint">Brak danych — lista zapisanych przedmiotów nie jest jeszcze obsługiwana, zajrzyj do „podpięć” w klasycznym USOS.</div>
            ` : etapy.map((e) => `
              <div class="usospp-list-row">
                <div>
                  <div style="font-size:14px;font-weight:600;">${esc(e.label)}</div>
                  <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(e.programLabel)} · cykl ${esc(e.cycle || '—')}</div>
                </div>
                <div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(e.status || '—')}</div>
              </div>
            `).join('')}
          </div>

          ${stages.length === 0 ? '' : stages.map((stage) => this.renderStageSubjectsCard(stage)).join('')}
        </div>
      `;
    }

    renderStageSubjectsCard(stage) {
      const sections = Array.isArray(stage.sections) ? stage.sections : [];
      return `
        <div class="usospp-card">
          <div class="usospp-card-head">
            <div class="usospp-card-title">Przedmioty — ${esc(stage.label || stage.directionName || 'etap studiów')}</div>
            <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=katalog2/programy/pokazEtapProgramu&prg_kod=${esc(stage.prgKod)}&etp_kod=${esc(stage.etpKod)}&usospp_off=1">Otwórz w USOS →</button>
          </div>
          ${!stage.supported || sections.length === 0 ? `
            <div class="usospp-empty-hint">Brak przedmiotów aktywnych w bieżącym cyklu dla tego etapu.</div>
          ` : sections.map((section) => `
            <div style="margin-bottom:16px;">
              <div class="usospp-eyebrow" style="margin-bottom:8px;">${esc(section.label)}${section.currentCycleLabel ? ` · ${esc(section.currentCycleLabel)}` : ''}</div>
              ${section.subjects.length === 0 ? `
                <div class="usospp-empty-hint">Brak przedmiotów aktywnych w bieżącym cyklu.</div>
              ` : section.subjects.map((s) => `
                <div class="usospp-list-row">
                  <div>
                    <div style="font-size:13.5px;font-weight:500;">${esc(s.name)}</div>
                    <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(s.code || '')}${s.status ? ' · ' + esc(s.status) : ''}</div>
                  </div>
                  ${s.detailsUrl ? `<a data-action="openSubjectPage" data-url="${esc(s.detailsUrl)}" style="font-size:12px;font-weight:600;white-space:nowrap;">szczegóły →</a>` : ''}
                </div>
              `).join('')}
            </div>
          `).join('')}
        </div>
      `;
    }

    renderSubjectPage() {
      const s = this.state;
      const backView = s.subjectBackView || 'przedmiotyLista';
      const header = backLink(backView);
      if (s.subjectLoading) {
        return `<div class="usospp-view">${header}
          <div class="usospp-card">
            <div class="usospp-skeleton" style="height:18px;width:55%;"></div>
            <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px;">
              <div class="usospp-skeleton" style="height:13px;width:90%;"></div>
              <div class="usospp-skeleton" style="height:13px;width:75%;"></div>
              <div class="usospp-skeleton" style="height:13px;width:60%;"></div>
            </div>
          </div>
          <div class="usospp-card">
            <div class="usospp-skeleton" style="height:16px;width:35%;"></div>
            <div class="usospp-skeleton" style="height:120px;margin-top:12px;"></div>
          </div>
        </div>`;
      }
      if (s.subjectError || !s.subjectData) {
        return `
          <div class="usospp-view">
            ${header}
            <div class="usospp-card">
              <div class="usospp-empty-hint">Nie udało się wczytać strony przedmiotu.</div>
              ${s.subjectUrl ? `<a data-action="openUsos" data-url="${esc(s.subjectUrl)}" style="font-size:12.5px;font-weight:600;">Otwórz w klasycznym USOS →</a>` : ''}
            </div>
          </div>
        `;
      }
      const d = s.subjectData;
      // Finished cycles are past semesters nobody registers into any more —
      // only show the current/upcoming one(s), with a fallback to "show
      // everything" if for some reason every cycle looks finished (e.g. an
      // unrecognized state string) so we never silently show an empty page.
      const relevantCycles = d.cycles.filter((c) => !/zakończon/i.test(c.cycleState || ''));
      const cyclesToShow = (relevantCycles.length ? relevantCycles : d.cycles)
        .map((c) => ({ c, i: d.cycles.indexOf(c) }));
      return `
        <div class="usospp-view">
          ${header}
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">${esc(d.subjectName || 'Przedmiot')}</div>
              <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(s.subjectUrl)}">Otwórz w USOS →</button>
            </div>
            ${d.generalInfo.map((f) => this.renderSubjectField(f)).join('')}
          </div>
          ${cyclesToShow.map(({ c, i }) => this.renderSubjectCycleCard(c, i)).join('')}
        </div>
      `;
    }

    // "Jednostki" search result — see adapter.getUnitDetail. Only the
    // ancestor chain and direct children of the org hierarchy are shown
    // (not the whole tree); staff/subject/programme listings for the unit
    // stay a link-out for now rather than replicating those full pages too.
    renderUnitPage() {
      const s = this.state;
      const header = this.catalogBackHeader();
      if (s.catalogLoading) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie…</div></div></div>`;
      }
      if (s.catalogError || !s.catalogData) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać danych jednostki.</div></div></div>`;
      }
      const d = s.catalogData;
      return `
        <div class="usospp-view">
          ${header}
          <div class="usospp-card">
            ${d.ancestors.length ? `
              <div style="font-size:12.5px;color:var(--ink-3);margin-bottom:10px;">
                ${d.ancestors.map((a) => `<span data-action="searchOpenUnit" data-kod="${esc(a.kod)}" style="text-decoration:underline;cursor:pointer;">${esc(a.name)}</span>`).join(' / ')}
              </div>
            ` : ''}
            <div class="usospp-card-title" style="margin-bottom:14px;">${esc(d.name)}</div>
            ${d.fields.length ? `
              <div class="usospp-field-stack">
                ${d.fields.map((f) => `
                  <div class="usospp-list-row"><div style="color:var(--ink-3);font-size:13px;">${esc(f.label)}</div><div style="font-weight:600;font-size:13px;text-align:right;">${esc(f.value)}</div></div>
                `).join('')}
              </div>
            ` : ''}
          </div>
          ${d.children.length ? this.renderUnitChildrenCards(d.children) : ''}
          ${this.renderCatalogProgramsSection()}
          ${this.renderCatalogSubjectsSection()}
          ${s.catalogBuildings.length ? `
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:14px;">Budynki jednostki</div>
              <div class="usospp-map-container" data-unit-map style="height:260px;border-radius:12px;overflow:hidden;margin-bottom:14px;"></div>
              ${s.catalogBuildings.map((b) => `
                <div class="usospp-list-row" style="align-items:flex-start;">
                  <div>
                    <div style="font-size:13.5px;font-weight:500;">${esc(b.name)}</div>
                    ${b.address ? `<div style="color:var(--ink-3);font-size:12px;margin-top:2px;">${esc(b.address)}</div>` : ''}
                  </div>
                  <div style="flex-shrink:0;">${b.kod ? `<a data-action="unitMapGoToBuilding" data-kod="${esc(b.kod)}" style="font-size:12px;font-weight:600;color:#d9773a;cursor:pointer;">Pokaż na mapie ↑</a>` : ''}</div>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }

    // A wydział's direct children mix teaching units (katedry, instytuty)
    // with administrative/support ones (Dziekanat, Zespół…, Centralne
    // Laboratorium…) — verified live on PWr W3 (9 katedry + 1 instytut vs
    // 20 pomocnicze) and PB. Only name prefixes seen live at BOTH
    // universities count as teaching here; everything else falls into the
    // neutral "Pozostałe jednostki" bucket, which is what made the old flat
    // "Jednostki podległe" list look like a random grab bag.
    renderUnitChildrenCards(children) {
      const isTeaching = (name) => /^(Katedra|Instytut)\b/.test(name || '');
      const row = (c) => `
        <div class="usospp-list-row" data-action="searchOpenUnit" data-kod="${esc(c.kod)}" style="cursor:pointer;">
          <div style="font-size:13.5px;font-weight:500;">${esc(c.name)}</div>
          <div style="color:var(--ink-3);">→</div>
        </div>`;
      const teaching = children.filter((c) => isTeaching(c.name));
      const other = children.filter((c) => !isTeaching(c.name));
      return `
          ${teaching.length ? `
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:14px;">Katedry i instytuty</div>
              ${teaching.map(row).join('')}
            </div>
          ` : ''}
          ${other.length ? `
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:14px;">Pozostałe jednostki</div>
              ${other.map(row).join('')}
            </div>
          ` : ''}
      `;
    }

    // The newest cycle year seen across the loaded rows — cdyd_kod values
    // look like "2024/25-Z" (PWr) or "2018Z" (PB), so the leading 4 digits
    // normalize both. This is deliberately data-driven rather than derived
    // from today's date: whatever the listing itself considers the newest
    // year IS the "aktualny rok" the toggle keeps.
    catalogSubjectsCurrentYear() {
      const years = new Set();
      this.state.catalogSubjects.forEach((r) => r.years.forEach((y) => years.add(y)));
      return years.size ? Math.max(...years) : null;
    }

    // "Przedmioty" — the unit's own subject offering (wydziały hold the
    // subjects at both verified universities; katedry return none, so the
    // section just doesn't render for them). Three patch zones — count
    // title, current-year toggle, rows — are kept apart from each other on
    // purpose (see setCatalogSubjectsSectionState): the <input> between
    // them never gets rebuilt, so neither section updates arriving while
    // the user types nor the patchers can drop its value or focus.
    renderCatalogSubjectsSection() {
      const s = this.state;
      if (!s.catalogSubjects.length && !s.catalogSubjectsLoading && !s.catalogSubjectsTotal) return '';
      return `
        <div class="usospp-card" data-catalog-subjects-card>
          <div class="usospp-card-head">
            <div class="usospp-card-title" data-catalog-subjects-title>${this.renderCatalogSubjectsTitle()}</div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">
            <input
              class="usospp-search-input"
              data-action="catalogSubjectQueryInput"
              type="text"
              placeholder="Szukaj po nazwie lub kodzie…"
              autocomplete="off"
              value="${esc(s.catalogSubjectQuery)}"
              style="flex:1;"
            >
            <span data-catalog-subjects-toggle-wrap style="flex:0 0 auto;">${this.renderCatalogSubjectsToggle()}</span>
          </div>
          <div data-catalog-subjects-root>${this.renderCatalogSubjectsSectionBody()}</div>
        </div>
      `;
    }

    // Patchable bits of the section above — see setCatalogSubjectsSectionState.
    renderCatalogSubjectsTitle() {
      const s = this.state;
      return `Przedmioty${s.catalogSubjects.length ? ` (${s.catalogSubjects.length}${s.catalogSubjectsTotal > s.catalogSubjects.length ? ` z ${s.catalogSubjectsTotal}` : ''})` : ''}`;
    }

    renderCatalogSubjectsToggle() {
      const s = this.state;
      const currentYear = this.catalogSubjectsCurrentYear();
      if (!currentYear || !s.catalogSubjects.length) return '';
      const yearLabel = `${currentYear}/${String((currentYear + 1) % 100).padStart(2, '0')}`;
      return `<a data-action="toggleCatalogSubjectsCurrentOnly" style="font-size:12px;font-weight:600;color:${s.catalogSubjectsCurrentOnly ? '#d9773a' : 'var(--ink-3)'};white-space:nowrap;cursor:pointer;">${s.catalogSubjectsCurrentOnly ? '●' : '○'} tylko ${yearLabel}</a>`;
    }

    // Patched part of the section above — see setCatalogSubjectsState. Rows
    // are click-through to our existing subject page via the subject's own
    // details URL. The 400-row render ceiling keeps a 3500+-row wydział
    // (verified live: W3 = 3576) from freezing the panel document; the
    // mini-search narrows within the loaded batch, "Wczytaj więcej" extends
    // it, and mass-scrolling is what the classic UI's pagination is for.
    renderCatalogSubjectsSectionBody() {
      const s = this.state;
      const currentYear = this.catalogSubjectsCurrentYear();
      const q = s.catalogSubjectQuery.trim().toLowerCase();
      const rows = s.catalogSubjects.filter((r) => {
        if (s.catalogSubjectsCurrentOnly && currentYear && !r.years.includes(currentYear)) return false;
        if (!q) return true;
        return (r.name || '').toLowerCase().includes(q) || (r.kod || '').toLowerCase().includes(q);
      });
      const visible = Math.min(rows.length, 400);
      return `
          ${rows.slice(0, 400).map((r) => `
            <div class="usospp-list-row" data-action="openSubjectPage" data-url="${esc(r.url)}" style="cursor:pointer;align-items:flex-start;">
              <div>
                <div style="font-size:13.5px;font-weight:500;">${esc(r.name)}</div>
                ${r.grupa ? `<div style="color:var(--ink-3);font-size:12px;margin-top:2px;">${esc(r.grupa)}</div>` : ''}
              </div>
              <div style="color:var(--ink-3);font-size:11.5px;font-family:ui-monospace,Menlo,monospace;flex-shrink:0;">${esc(r.kod)}</div>
            </div>
          `).join('')}
          ${rows.length > 400 ? `<div class="usospp-empty-hint">Pokazuję pierwszych 400 — doprecyzuj wyszukiwanie, aby zawęzić.</div>` : ''}
          ${!rows.length && !s.catalogSubjectsLoading ? `<div class="usospp-empty-hint">Brak przedmiotów${q || (s.catalogSubjectsCurrentOnly && currentYear) ? ' spełniających filtr' : ''}.</div>` : ''}
          ${s.catalogSubjectsLoading ? `<div class="usospp-empty-hint">Wczytywanie…</div>` : ''}
          ${!s.catalogSubjectsLoading ? `
            ${(rows.length && (s.catalogSubjectsTotal > s.catalogSubjects.length || q || (s.catalogSubjectsCurrentOnly && currentYear))) ? `<div style="font-size:12px;color:var(--ink-3);margin-top:10px;">${visible} z ${s.catalogSubjects.length}${s.catalogSubjectsTotal > s.catalogSubjects.length ? ` wczytanych (ogółem ${s.catalogSubjectsTotal})` : ' pasujących'}</div>` : ''}
            ${s.catalogSubjectsNextUrl ? `<a data-action="catalogSubjectsLoadMore" style="display:inline-block;margin-top:10px;font-size:13px;font-weight:600;color:#d9773a;cursor:pointer;">Wczytaj więcej →</a>` : ''}
          ` : ''}
      `;
    }

    // "Programy studiów" — every kierunek this unit offers, each listing its
    // program instances (full-time/Erasmus/…) as chips that open our own
    // program page. Hidden entirely while the first page loads empty or for
    // units without programmes (verified marker), same graceful rules as the
    // subjects section. Loaded chips stay visible while "Wczytaj więcej"
    // fetches — only the first, still-empty load shows "Wczytywanie…" — so
    // the in-place card swap (setCatalogProgramsState) doesn't flash.
    renderCatalogProgramsSection() {
      const s = this.state;
      if (!s.catalogPrograms.length && !s.catalogProgramsLoading) return '';
      const byKierunek = new Map();
      s.catalogPrograms.forEach((p) => {
        const key = p.kierunek || '—';
        if (!byKierunek.has(key)) byKierunek.set(key, []);
        byKierunek.get(key).push(p);
      });
      const chip = (p) => `<button class="usospp-mode-btn" style="flex:0 0 auto;border-radius:99px;padding:6px 13px;font-size:12.5px;" data-action="searchOpenProgram" data-kod="${esc(p.kod)}">${esc(p.name)}</button>`;
      return `
        <div class="usospp-card" data-catalog-programs-card>
          <div class="usospp-card-title" style="margin-bottom:14px;">Programy studiów (${s.catalogPrograms.length})</div>
          ${(s.catalogProgramsLoading && !s.catalogPrograms.length) ? `<div class="usospp-empty-hint">Wczytywanie…</div>` : `
            ${[...byKierunek.entries()].map(([kierunek, programs]) => `
              <div style="margin-bottom:10px;">
                ${kierunek !== '—' ? `<div style="font-size:12px;font-weight:600;color:var(--ink-3);margin-bottom:4px;">${esc(kierunek)}</div>` : ''}
                <div style="display:flex;flex-wrap:wrap;gap:6px;">${programs.map(chip).join('')}</div>
              </div>
            `).join('')}
            ${s.catalogProgramsNextUrl ? `<a data-action="catalogProgramsLoadMore" style="display:inline-block;margin-top:10px;font-size:13px;font-weight:600;color:#d9773a;cursor:pointer;">Wczytaj więcej →</a>` : ''}
          `}
        </div>
      `;
    }

    // Campus-wide building map — see ensureMapaData/mountMapaIfNeeded for
    // how data is fetched and how the Leaflet instance is (re)mounted.
    renderMapa() {
      const s = this.state;
      if (s.mapaLoading) {
        return `<div class="usospp-view"><div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie budynków kampusu…</div></div></div>`;
      }
      if (s.mapaError) {
        return `
          <div class="usospp-view">
            <div class="usospp-card">
              <div class="usospp-empty-hint">Nie udało się wczytać mapy budynków.</div>
              <div style="margin-top:10px;"><a data-action="mapaRefresh" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div>
            </div>
          </div>
        `;
      }
      if (!s.mapaBuildings.length) {
        return `<div class="usospp-view"><div class="usospp-card"><div class="usospp-empty-hint">Brak budynków z dostępnymi współrzędnymi.</div></div></div>`;
      }
      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Budynki kampusu (${s.mapaBuildings.length})</div>
              <a data-action="mapaRefresh" style="font-size:12px;color:var(--ink-3);text-decoration:underline;cursor:pointer;">odśwież</a>
            </div>
            <div class="usospp-search-wrap" style="width:100%;margin-bottom:12px;">
              <input
                class="usospp-search-input"
                data-action="mapaSearchInput"
                data-mapa-search-input
                type="text"
                placeholder="Szukaj budynku…"
                autocomplete="off"
                value="${esc(s.mapaSearchQuery)}"
              >
              <div data-mapa-search-results-root>${this.renderMapaSearchResults()}</div>
            </div>
            ${this.renderMapaFilterChips()}
            <div class="usospp-map-container" data-mapa-map style="height:520px;border-radius:12px;overflow:hidden;margin-top:12px;"></div>
          </div>
        </div>
      `;
    }

    // Its own top-level element carries data-mapa-filter-root so setMapaFilter
    // can replace just this chip strip (outerHTML) without touching the map
    // container next to it — same reasoning as setTopbarState et al. Chips
    // are keyed (data-unit) by unitKod, not display name — see
    // applyMapaFilter's comment for why name equality would be wrong.
    renderMapaFilterChips() {
      const s = this.state;
      const seen = new Map();
      s.mapaBuildings.forEach((b) => {
        if (b.unitKod && !seen.has(b.unitKod)) seen.set(b.unitKod, b.unitName || b.unitKod);
      });
      const units = [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pl'));
      const chipStyle = 'flex:0 0 auto;border-radius:99px;padding:6px 13px;font-size:12.5px;';
      return `
        <div data-mapa-filter-root style="display:flex;flex-wrap:wrap;gap:6px;">
          <button class="usospp-mode-btn${!s.mapaUnitFilter ? ' active' : ''}" style="${chipStyle}" data-action="mapaSetFilter" data-unit="">Wszystkie</button>
          ${units.map(([kod, name]) => `<button class="usospp-mode-btn${s.mapaUnitFilter === kod ? ' active' : ''}" style="${chipStyle}" data-action="mapaSetFilter" data-unit="${esc(kod)}">${esc(name)}</button>`).join('')}
        </div>
      `;
    }

    // "Programy studiów" search result — see adapter.getProgramDetail.
    // "Główne toki nauczania" stage links open our own stage subpage (see
    // openStagePage/renderStagePage) instead of bouncing out to USOS.
    renderProgramPage() {
      const s = this.state;
      const header = this.catalogBackHeader();
      if (s.catalogLoading) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie…</div></div></div>`;
      }
      if (s.catalogError || !s.catalogData) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać danych programu.</div></div></div>`;
      }
      const d = s.catalogData;
      return `
        <div class="usospp-view">
          ${header}
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:14px;">${esc(d.name)}</div>
            ${d.kierunki.length ? `
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;">
                ${d.kierunki.map((k) => `<span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(k)}</span>`).join('')}
              </div>
            ` : ''}
            <div class="usospp-field-stack">
              ${d.fields.map((f) => `
                <div class="usospp-list-row"><div style="color:var(--ink-3);font-size:13px;">${esc(f.label)}</div><div style="font-weight:600;font-size:13px;text-align:right;">${esc(f.value)}</div></div>
              `).join('')}
            </div>
          </div>
          ${d.units.length ? `
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:14px;">Jednostki oferujące ten program</div>
              ${d.units.map((u) => `
                <div class="usospp-list-row" data-action="searchOpenUnit" data-kod="${esc(u.kod)}" style="cursor:pointer;">
                  <div style="font-size:13.5px;font-weight:500;">${esc(u.name)}</div>
                  <div style="color:var(--ink-3);">→</div>
                </div>
              `).join('')}
            </div>
          ` : ''}
          ${d.stages.length ? `
            <div class="usospp-card">
              <div class="usospp-card-title" style="margin-bottom:14px;">Główne toki nauczania</div>
              ${d.stages.map((st) => `
                <div class="usospp-list-row">
                  <div style="font-size:13px;">${esc(st.label)}</div>
                  <a data-action="openStage" data-prg-kod="${esc(st.prgKod)}" data-etp-kod="${esc(st.etpKod)}" data-label="${esc(st.label)}" style="font-size:12px;font-weight:600;color:#d9773a;cursor:pointer;">szczegóły →</a>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }

    // A single "semestr" opened from a program's "Główne toki nauczania" —
    // reuses renderStageSubjectsCard verbatim (see the same card in
    // renderPrzedmiotyLista, for the user's own programme). "Back" reopens
    // the specific program this stage belongs to (catalogKod doubles as its
    // prg_kod) rather than the generic catalogBackView, which points
    // further back to wherever the program page itself was opened from.
    renderStagePage() {
      const s = this.state;
      const header = `<a data-action="searchOpenProgram" data-kod="${esc(s.catalogKod)}" class="usospp-back-link">← Wróć</a>`;
      if (s.catalogLoading) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Wczytywanie…</div></div></div>`;
      }
      if (s.catalogError || !s.catalogData) {
        return `<div class="usospp-view">${header}<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wczytać przedmiotów etapu.</div></div></div>`;
      }
      return `
        <div class="usospp-view">
          ${header}
          ${this.renderStageSubjectsCard(s.catalogData)}
        </div>
      `;
    }

    // A field's link is usually just "open this in classic USOS" — except a
    // link to a jednostka page, which we already have our own page for (see
    // renderUnitPage), so that one gets routed there instead.
    renderSubjectField(f) {
      // "Grupy:" and anything shaped like it can hold several links in one
      // cell — showing them squashed together as unclickable text loses
      // them, so this offers a pick-one modal instead.
      if (f.links && f.links.length > 1) {
        return `
          <div class="usospp-list-row">
            <div style="font-size:12.5px;color:var(--ink-2);">${esc(f.label)}</div>
            <a data-action="openLinksModal" data-links='${esc(JSON.stringify(f.links))}' data-title="${esc(f.label)}" style="font-size:12.5px;font-weight:600;cursor:pointer;">${f.links.length} opcje →</a>
          </div>
        `;
      }
      let actionAttrs = `data-action="openUsos" data-url="${esc(f.link)}"`;
      if (f.link && /pokazJednostke/.test(f.link)) {
        let kod = null;
        try { kod = new URL(f.link).searchParams.get('kod'); } catch (e) { /* fall back to openUsos */ }
        if (kod) actionAttrs = `data-action="searchOpenUnit" data-kod="${esc(kod)}"`;
      }
      return `
        <div class="usospp-list-row">
          <div style="font-size:12.5px;color:var(--ink-2);">${esc(f.label)}</div>
          <div style="font-size:12.5px;font-weight:600;text-align:right;max-width:60%;">${f.link ? `<a ${actionAttrs} style="cursor:pointer;">${esc(f.value)}</a>` : esc(f.value)}</div>
        </div>
      `;
    }

    renderSubjectCycleCard(c, idx) {
      return `
        <div class="usospp-card">
          <div class="usospp-card-head">
            <div class="usospp-card-title">${esc(c.cycleName)}</div>
            <div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(c.cycleState || '—')}</div>
          </div>
          <div style="font-size:12.5px;color:var(--ink-3);margin-bottom:14px;">${esc(c.period || '—')}</div>

          ${c.registrationStatus ? `
            <div class="usospp-list-row">
              <div style="font-size:13px;color:var(--ink-2);">Rejestracja</div>
              <div style="font-size:13px;font-weight:600;text-align:right;">
                ${esc(c.registrationStatus)}${c.registrationUrl ? ` · <a data-action="openUsos" data-url="${esc(c.registrationUrl)}">szczegóły →</a>` : ''}
              </div>
            </div>
          ` : ''}

          ${c.classTypes.length ? `
            <div class="usospp-eyebrow" style="margin-top:14px;margin-bottom:8px;">Typ zajęć</div>
            ${c.classTypes.map((ct) => `
              <div class="usospp-list-row">
                <div style="font-size:13px;">${esc(ct.label)}</div>
                ${ct.groupsUrl ? `<a data-action="openGroupsModal" data-url="${esc(ct.groupsUrl)}" data-title="${esc(ct.label)}" style="font-size:12px;font-weight:600;cursor:pointer;">grupy →</a>` : ''}
              </div>
            `).join('')}
          ` : ''}

          ${c.timetable && c.timetable.days.length ? this.renderSubjectTimetable(c.timetable) : (c.planUrl ? `
            <div data-cycle-timetable="${idx !== undefined ? idx : ''}">
              <div class="usospp-eyebrow" style="margin-top:14px;margin-bottom:8px;">Plan zajęć (wszystkie grupy)</div>
              <div class="usospp-skeleton" style="height:120px;"></div>
              <div style="font-size:11.5px;color:var(--ink-3);margin-top:6px;">Pobieranie planu…</div>
            </div>
          ` : '')}

          ${c.fields.length ? `
            <div class="usospp-eyebrow" style="margin-top:14px;margin-bottom:8px;">Szczegóły</div>
            ${c.fields.map((f) => this.renderSubjectField(f)).join('')}
          ` : ''}
        </div>
      `;
    }

    // Renders a real weekly-schedule grid (hour labels down the left, one
    // column per day, entries positioned by actual clock time) instead of
    // just stacking boxes per day — much easier to read at a glance than a
    // plain list of "start–end" text.
    renderSubjectTimetable(tt) {
      const days = tt.days;
      const allMins = days.flatMap((d) => d.entries.flatMap((e) => [toMin(e.start), toMin(e.end)])).filter((n) => n !== null);
      if (!allMins.length) return '';
      const hourStart = Number.isFinite(tt.hourStart) ? tt.hourStart : Math.floor(Math.min(...allMins) / 60);
      const hourEnd = Number.isFinite(tt.hourEnd) ? tt.hourEnd : Math.ceil(Math.max(...allMins) / 60);
      const ROW_H = 64; // px per hour — tall enough to fit type/teacher/room text
      const totalHeight = Math.max(1, hourEnd - hourStart) * ROW_H;
      const hours = [];
      for (let h = hourStart; h <= hourEnd; h++) hours.push(h);
      const sortedDays = [...days].sort((a, b) => DAY_KEYS.indexOf(shortDay(a.day)) - DAY_KEYS.indexOf(shortDay(b.day)));

      return `
        <div class="usospp-eyebrow" style="margin-top:14px;margin-bottom:8px;">Plan zajęć (wszystkie grupy)</div>
        <div class="usospp-timetable">
          <div class="usospp-tt-hours" style="height:${totalHeight}px;">
            ${hours.map((h) => `<div class="usospp-tt-hour" style="top:${(h - hourStart) * ROW_H}px;">${h}:00</div>`).join('')}
          </div>
          <div class="usospp-tt-days">
            ${sortedDays.map((d) => `
              <div class="usospp-tt-daycol">
                <div class="usospp-tt-daylabel">${esc(shortDay(d.day))}</div>
                <div class="usospp-tt-daybody" style="height:${totalHeight}px;background-size:100% ${ROW_H}px;">
                  ${d.entries.map((e) => {
                    const startMin = toMin(e.start);
                    const endMin = toMin(e.end);
                    if (startMin === null || endMin === null) return '';
                    const top = (startMin - hourStart * 60) * (ROW_H / 60);
                    const height = Math.max(40, (endMin - startMin) * (ROW_H / 60));
                    const weeksTag = weeksLabel(e.weeks);
                    const full = [e.label, e.teacher, e.place].filter(Boolean).join(' — ')
                      + (weeksTag ? ` — co drugi tydzień (${e.weeks === 'even' ? 'parzyste' : 'nieparzyste'})` : '');
                    return `
                      <div class="usospp-tt-entry" style="top:${top}px;height:${height}px;" title="${esc(full)}">
                        <div class="usospp-tt-entry-time">${esc(e.start)}–${esc(e.end)}${weeksTag ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:9.5px;padding:1px 5px;">${weeksTag}</span>` : ''}</div>
                        <div class="usospp-tt-entry-label">${esc(e.label || '')}</div>
                        ${e.teacher ? `<div class="usospp-tt-entry-meta">${esc(e.teacher)}</div>` : ''}
                        ${e.place ? `<div class="usospp-tt-entry-meta">${esc(e.place)}</div>` : ''}
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Tour time range: same day → date once ("28.09, 10:15 – 11:50"),
    // multi-day → full both sides ("28.09, 10:15 – 29.09, 16:00").
    fmtZapisRange(startsAt, endsAt) {
      const parts = (s) => {
        const m = (s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
        return m ? { day: `${m[1]}-${m[2]}-${m[3]}`, date: `${m[3]}.${m[2]}`, time: `${m[4]}:${m[5]}` } : null;
      };
      const start = parts(startsAt);
      if (!start) return null;
      const end = parts(endsAt);
      if (!end) return `${start.date}, ${start.time}`;
      if (end.day === start.day) return `${start.date}, ${start.time} – ${end.time}`;
      return `${start.date}, ${start.time} – ${end.date}, ${end.time}`;
    }

    // Relative tour status against now: "trwa teraz" / "zakończona" /
    // "dziś" / "jutro" / "za N dni". Day granularity (floor), so it reads
    // the same way USOSweb's own "rozpocznie się za X dni" does.
    relZapisTime(startsAt, endsAt) {
      const parse = (s) => {
        const m = (s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
      };
      const start = parse(startsAt);
      if (!start) return null;
      const now = new Date();
      const end = parse(endsAt);
      if (end && now >= start && now <= end) return 'trwa teraz';
      if ((end && now > end)) return 'zakończona';
      const dayMs = 86400000;
      const days = Math.floor((start - now) / dayMs);
      if (days < 0) return 'zakończona';
      if (days === 0) {
        // Under 24h away but on the next calendar day (e.g. tomorrow
        // morning seen tonight) reads as "jutro", not "dziś".
        const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return startDay > today ? 'jutro' : 'dziś';
      }
      if (days === 1) return 'jutro';
      return `za ${days} dni`;
    }

    // Single unified Zapisy list over get zapisRounds (personal calendar
    // primary, faculty fallback — never two lists). No "Tylko mój kierunek"
    // switch: the personal calendar is already student-filtered.
    renderZapisy() {
      const personal = this.data.personalCalendarResult || {};
      const rounds = this.zapisRounds;
      const filter = (this.state.zapisyFilter || '').trim().toLowerCase();
      const filtered = filter
        ? rounds.filter((r) => ((r.sectionTitle || '') + ' ' + (r.sectionCode || '')).toLowerCase().includes(filter))
        : rounds;

      // A faculty fallback can list well over a thousand rounds (1590 rows
      // seen live on W4N) — cap the unfiltered view and push people toward
      // the filter box instead.
      const RENDER_CAP = 50;
      const capped = !filter && filtered.length > RENDER_CAP;
      const toRender = capped ? filtered.slice(0, RENDER_CAP) : filtered;

      return `
        <div class="usospp-view">
          ${backLink('przedmioty')}
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Zapisy na przedmioty</div>
              <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dla_stud/rejestracja/kalendarz&usospp_off=1">Twój kalendarz w USOS →</button>
            </div>
            ${!personal.supported && rounds.length === 0 ? `
              <div class="usospp-empty-hint">Nie udało się odczytać Twoich rejestracji — sprawdź w klasycznym USOS.</div>
            ` : `
              <p class="usospp-muted-text" style="margin-bottom:14px;">
                ${personal.supported
                  ? 'Twoje tury zapisów z terminami — „przedmioty w turze” otwiera podgląd wewnątrz USOS++. Sam zapis odbywa się w USOSweb.'
                  : 'Kalendarz osobisty niedostępny — pokazuję tury wydziałowe (bez Twoich terminów i akcji).'}
              </p>
              <input class="usospp-input" style="margin-bottom:16px;" placeholder="Filtruj po nazwie / kodzie tury…" value="${esc(this.state.zapisyFilter || '')}" data-bind="zapisyFilter">
              ${toRender.length === 0 ? `
                <div class="usospp-empty-hint">${filter ? 'Brak tur pasujących do filtra.' : 'Brak tur zapisów w tej chwili.'}</div>
              ` : `
                ${capped ? `<div class="usospp-tag-muted" style="display:block;margin-bottom:10px;">Pokazano ${RENDER_CAP} z ${filtered.length} tur (najbliższe terminy). Zawęź filtrem powyżej.</div>` : ''}
                ${toRender.map((round) => this.renderRegistrationRound(round)).join('')}
              `}
            `}
          </div>
        </div>
      `;
    }

    renderRegistrationRound(round) {
      const accessBadge = round.hasAccess
        ? `<div class="usospp-badge usospp-badge-positive">masz dostęp</div>`
        : `<div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-3);">brak dostępu</div>`;
      const range = this.fmtZapisRange(round.startsAt, round.endsAt);
      const rel = this.relZapisTime(round.startsAt, round.endsAt);
      const attrs = [];
      if (round.attributes) {
        if (round.attributes['Czy giełda włączona']) attrs.push(`giełda: ${esc(String(round.attributes['Czy giełda włączona']).toLowerCase())}`);
        if (round.attributes['Czy podpięcia wymagane']) attrs.push(`podpięcia: ${esc(String(round.attributes['Czy podpięcia wymagane']).toLowerCase())}`);
        if (round.attributes['Rejestracja dedykowana']) attrs.push(`dedykowana: ${esc(String(round.attributes['Rejestracja dedykowana']).toLowerCase())}`);
      }
      const subjectsBtn = round.subjectsUrl
        ? `<button class="usospp-btn-ghost usospp-zapis-btn" data-action="viewSubjects" data-url="${esc(round.subjectsUrl)}" style="font-size:12px;padding:6px 10px;width:100%;">Przedmioty w turze</button>`
        : '';
      const registerBtn = round.registerUrl
        ? `<button class="usospp-btn-ghost usospp-zapis-btn" data-action="openUsos" data-url="${esc(round.registerUrl)}" style="font-size:12px;padding:6px 10px;width:100%;">Zapisz w USOS</button>`
        : '';
      return `
        <div class="usospp-list-row" style="align-items:flex-start;">
          <div style="min-width:0;">
            <div style="display:flex;align-items:flex-start;gap:8px;">
              <div style="font-size:13.5px;font-weight:600;min-width:0;">${esc(round.sectionTitle || '')}</div>
              <div style="flex-shrink:0;">${accessBadge}</div>
            </div>
            ${round.sectionCode ? `<div style="font-size:11.5px;color:var(--ink-3);">${esc(round.sectionCode)}</div>` : ''}
            <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(round.roundType || '')}${round.roundNote ? ' · ' + esc(round.roundNote) : ''}</div>
            <div style="font-size:12px;color:var(--ink-2);margin-top:4px;">${esc(round.state || '—')}</div>
            ${attrs.length ? `<div style="font-size:11.5px;color:var(--ink-3);margin-top:2px;">${attrs.join(' · ')}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;min-width:150px;text-align:right;">
            ${range ? `<div style="font-size:14px;font-weight:700;color:oklch(58% 0.15 45);white-space:nowrap;">${esc(range)}${rel ? ` <span style="font-size:11.5px;font-weight:500;color:var(--ink-3);">(${esc(rel)})</span>` : ''}</div>` : ''}
            ${subjectsBtn}
            ${registerBtn}
          </div>
        </div>
      `;
    }

    // In-panel tour view: header (term/attributes come from the Zapisy row),
    // subject list (fresh fetch), plan links and the USOS deep link as the
    // last step. Read-only — nothing here posts to USOS.
    renderZapisTura() {
      const s = this.state;
      const plans = Array.isArray(s.zapisTuraPlanUrls) ? s.zapisTuraPlanUrls : [];
      const subjects = Array.isArray(s.zapisTuraSubjects) ? s.zapisTuraSubjects : [];
      return `
        <div class="usospp-view">
          ${backLink('zapisy', '← Wróć do zapisów')}
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div>
                <div class="usospp-card-title">${esc(s.zapisTuraTitle || 'Tura zapisów')}</div>
                ${s.zapisTuraCode ? `<div style="font-size:11.5px;color:var(--ink-3);">${esc(s.zapisTuraCode)}</div>` : ''}
              </div>
              ${s.zapisTuraRegisterUrl ? `<button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(s.zapisTuraRegisterUrl)}">Zapisz w USOS →</button>` : ''}
            </div>
            ${plans.length ? `
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
                ${plans.map((p) => `<a data-action="openUsos" data-url="${esc(p.url)}" style="font-size:12px;font-weight:600;cursor:pointer;">Plan: ${esc(p.label || 'zajęć')} →</a>`).join('')}
              </div>
            ` : ''}
            ${s.zapisTuraLoading ? `
              ${[0, 1, 2, 3, 4].map(() => `
                <div class="usospp-list-row" style="align-items:flex-start;">
                  <div style="min-width:0;flex:1;">
                    <div class="usospp-skeleton" style="height:14px;width:70%;"></div>
                    <div class="usospp-skeleton" style="height:11px;width:45%;margin-top:6px;"></div>
                    <div class="usospp-skeleton" style="height:11px;width:30%;margin-top:6px;"></div>
                  </div>
                  <div style="display:flex;flex-direction:row;gap:8px;flex-shrink:0;">
                    <div class="usospp-skeleton" style="height:30px;width:72px;"></div>
                    <div class="usospp-skeleton" style="height:30px;width:88px;"></div>
                  </div>
                </div>
              `).join('')}
            ` : s.zapisTuraError ? `
              <div class="usospp-empty-hint">Nie udało się wczytać przedmiotów tej tury.</div>
              <div style="margin-top:10px;"><a data-action="zapisTuraRetry" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div>
            ` : subjects.length === 0 ? `
              <div class="usospp-empty-hint">Brak przedmiotów w tej turze.</div>
            ` : `
              ${subjects.map((subj) => `
                <div class="usospp-list-row" style="align-items:flex-start;">
                  <div style="min-width:0;">
                    <div style="font-size:13px;font-weight:500;">${esc(subj.name || '')}</div>
                    <div style="font-size:11.5px;color:var(--ink-3);">${esc(subj.kod || '')}${subj.jednostka ? ' · ' + esc(subj.jednostka) : ''}${subj.cycles && subj.cycles.length ? ' · ' + esc(subj.cycles.join(', ')) : ''}</div>
                    ${subj.occupancy ? `<div style="font-size:11.5px;color:var(--ink-3);margin-top:2px;">${esc(String(subj.occupancy.registered))}/${esc(String(subj.occupancy.limit))} zapisanych</div>` : ''}
                  </div>
                  <div style="display:flex;flex-direction:row;align-items:center;gap:8px;flex-shrink:0;">
                    ${subj.groupsUrl ? `<button class="usospp-btn-ghost usospp-zapis-btn" data-action="openZapisGrupy" data-tour="${esc(s.zapisTuraKey || '')}" data-kod="${esc(subj.kod || '')}" data-name="${esc(subj.name || '')}" data-cykl="${esc((subj.cycles && subj.cycles[0]) || '')}" data-occ="${esc(subj.occupancy ? JSON.stringify(subj.occupancy) : '')}" data-details="${esc(subj.url || '')}" data-url="${esc(subj.groupsUrl)}" data-register="${esc(s.zapisTuraRegisterUrl || '')}" style="font-size:12px;padding:6px 10px;white-space:nowrap;">Grupy →</button>` : ''}
                    <button class="usospp-btn-ghost usospp-zapis-btn" data-action="openSubjectPage" data-url="${esc(subj.url)}" style="font-size:12px;padding:6px 10px;white-space:nowrap;">Szczegóły →</button>
                  </div>
                </div>
              `).join('')}
            `}
          </div>
        </div>
      `;
    }

    // Subject's registration-context groups inside one tour: occupancy,
    // per-class-type sections with group numbers, teachers, times and
    // enrolled/limit counts (adapter.getRejGroups). Read-only — the header
    // keeps the general subject details and the USOS deep link; nothing here
    // posts to USOS.
    renderZapisGrupy() {
      const s = this.state;
      const sections = Array.isArray(s.zapisGrupySections) ? s.zapisGrupySections : [];
      const occ = s.zapisGrupyOccupancy;
      const totalGroups = sections.reduce((n, x) => n + (Array.isArray(x.groups) ? x.groups.length : 0), 0);
      const mainPlan = s.zapisGrupyMainPlan;
      const mainRows = (mainPlan && mainPlan.rows) || {};
      const highlightNr = s.zapisGrupyHighlightNr;
      const groupRow = (g, secType) => {
        const full = g.limitGorny !== null && g.limitGorny !== undefined
          && g.zapisanych !== null && g.zapisanych !== undefined && g.zapisanych >= g.limitGorny;
        const opis = g.opis && !/^brak$/i.test(g.opis.trim()) ? g.opis : null;
        const inPlan = mainRows[`${secType || ''}||${g.nr}`] || null;
        const highlighted = highlightNr !== null && highlightNr !== undefined && String(g.nr) === String(highlightNr);
        const planCell = inPlan
          ? `<span class="usospp-zapis-inplan-tag" title="${esc(inPlan.sessionMatch ? `Ta grupa jest w planie głównym „${mainPlan.planName}”` : `Grupa nr ${g.nr} jest w planie głównym „${mainPlan.planName}”, ale jej termin różni się od zapisanego w planie`)}">📅 ${esc(mainPlan.planName)}${inPlan.sessionMatch ? '' : ' ⚠'}</span>`
          : '';
        return `
          <tr${(inPlan || highlighted) ? ` class="${[inPlan ? 'usospp-zapis-inplan' : '', highlighted ? 'usospp-zapis-highlight' : ''].filter(Boolean).join(' ')}"` : ''}>
            <td>${esc(g.nr || '—')}</td>
            <td>${esc(g.termin || '—')}</td>
            <td>${esc(g.prowadzacy || '—')}${opis ? `<div style="font-size:11px;color:var(--ink-3);">${esc(opis)}</div>` : ''}</td>
            <td style="white-space:nowrap;${full ? 'font-weight:700;color:oklch(55% 0.19 25);' : ''}">${g.zapisanych !== null && g.zapisanych !== undefined ? esc(String(g.zapisanych)) : '—'}/${g.limitGorny !== null && g.limitGorny !== undefined ? esc(String(g.limitGorny)) : '—'}</td>
            <td>${planCell}</td>
          </tr>
        `;
      };
      return `
        <div class="usospp-view">
          ${s.zapisGrupyReturnView === 'planer'
            ? backLink('planer', '← Wróć do planu')
            : backLink('zapisTura', '← Wróć do tury')}
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div>
                <div class="usospp-card-title">${esc(s.zapisGrupyTitle || 'Grupy przedmiotu')}</div>
                <div style="font-size:11.5px;color:var(--ink-3);">${esc(s.zapisGrupyKod || '')}${s.zapisGrupyCykl ? ' · ' + esc(s.zapisGrupyCykl) : ''}</div>
                ${occ ? `<div style="font-size:12.5px;font-weight:700;color:oklch(58% 0.15 45);margin-top:4px;">${esc(String(occ.registered))}/${esc(String(occ.limit))} zapisanych</div>` : ''}
              </div>
              <div style="display:flex;gap:8px;flex-shrink:0;">
                ${s.zapisGrupyDetailsUrl ? `<button class="usospp-btn-ghost" data-action="openSubjectPage" data-url="${esc(s.zapisGrupyDetailsUrl)}">Szczegóły przedmiotu</button>` : ''}
                ${s.zapisGrupyRegisterUrl ? `<button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(s.zapisGrupyRegisterUrl)}">Zapisz w USOS →</button>` : ''}
              </div>
            </div>
            ${s.zapisGrupyLoading ? `
              <table class="usospp-table">
                <thead><tr><th>Grupa</th><th>Termin</th><th>Prowadzący</th><th>Zapisani</th><th>Plan</th></tr></thead>
                <tbody>
                  ${[0, 1, 2, 3].map(() => `<tr>${[0, 1, 2, 3, 4].map(() => `<td><div class="usospp-skeleton" style="height:13px;"></div></td>`).join('')}</tr>`).join('')}
                </tbody>
              </table>
            ` : s.zapisGrupyError ? `
              <div class="usospp-empty-hint">Nie udało się wczytać grup tego przedmiotu.</div>
              <div style="margin-top:10px;"><a data-action="zapisGrupyRetry" style="text-decoration:underline;cursor:pointer;font-size:13px;">Spróbuj ponownie</a></div>
            ` : totalGroups === 0 ? `
              <div class="usospp-empty-hint">Brak zdefiniowanych grup.</div>
            ` : `
              ${sections.map((sec) => `
                ${sec.type ? `<div class="usospp-eyebrow" style="margin-top:14px;margin-bottom:8px;">${esc(sec.type)}</div>` : ''}
                <table class="usospp-table">
                  <thead><tr><th>Grupa</th><th>Termin</th><th>Prowadzący</th><th>Zapisani</th><th>Plan</th></tr></thead>
                  <tbody>${(sec.groups || []).map((g) => groupRow(g, sec.type)).join('')}</tbody>
                </table>
              `).join('')}
            `}
          </div>
        </div>
      `;
    }

    // Lets a student assemble a what-if weekly schedule out of real group
    // data before/during registration — purely a local preview: nothing
    // here is ever submitted to USOS, and picks persist across sessions via
    // chrome.storage.local (see planner-store.js) so the draft survives
    // closing the panel or the browser.
    // The outer wrapper is only ever produced by the normal full-page
    // render path (navigating to this view). Everything that can change
    // afterwards (expanding a subject, loading its groups, picking one,
    // adding/removing a pick) goes through setPlannerState, which patches
    // just this node's innerHTML — see setPlannerState's own comment.
    renderPlanner() {
      return `
        <div class="usospp-view">
          ${backLink('przedmioty')}
          <div data-planner-root>${this.renderPlannerBody()}</div>
        </div>
      `;
    }

    renderPlannerBody() {
      const modeTabs = `
        <div style="display:flex;gap:6px;margin-bottom:16px;">
          <button class="usospp-mode-btn${this.state.plannerMode !== 'auto' ? ' active' : ''}" data-action="plannerSetMode" data-mode="manual">Manualny</button>
          <button class="usospp-mode-btn${this.state.plannerMode === 'auto' ? ' active' : ''}" data-action="plannerSetMode" data-mode="auto">Automatyczny</button>
        </div>
      `;
      if (this.state.plannerMode === 'auto') {
        return modeTabs + this.renderPlannerAutoIntro() + this.renderPlannerTourBanner() + this.renderPlannerAutoRest();
      }

      const { subjects, skippedStages } = this.plannerSubjectCandidates;
      const bySubject = this.plannerPicksBySubject;

      return `
        ${modeTabs}
        <div class="usospp-card">
          <div class="usospp-card-head">
            <div class="usospp-card-title">Generator planu</div>
          </div>
          <p class="usospp-muted-text">
            Ułóż sobie przykładowy plan zajęć na podstawie realnych grup — jeszcze przed zapisami albo w ich trakcie. To tylko podgląd: USOS++ nikogo nigdzie nie zapisuje, wybory zapisują się jedynie lokalnie w tym rozszerzeniu, żeby można było do nich wrócić później.
          </p>
        </div>
        ${this.renderPlannerTourBanner()}
        ${this.renderPlannerVersions()}

        <div class="usospp-planner-layout">
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:12px;">Dodaj przedmiot</div>
            ${skippedStages > 0 ? `<div class="usospp-tag-muted" style="display:block;margin-bottom:10px;">Pominięto ${skippedStages} etap(y) programu z późniejszego cyklu (np. kolejny semestr) — pokazujemy tylko przedmioty z bieżącego cyklu.</div>` : ''}
            ${subjects.length === 0 ? `
              <div class="usospp-empty-hint">${this.data && this.data.stageSubjectsResultLoaded ? 'Nie znaleźliśmy listy przedmiotów Twojego kierunku — sprawdź zakładkę „Przedmioty” albo dodaj przedmiot spoza listy poniżej.' : 'Wczytywanie przedmiotów Twojego kierunku…'}</div>
            ` : this.renderPlannerSubjectList(subjects)}
            ${this.renderPlannerCustomSearch()}
          </div>

          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:12px;">Twój plan (podgląd)</div>
            ${this.renderPlannerRejCheck()}
            ${this.renderPlannerGrid()}
          </div>
        </div>

        ${bySubject.length ? `
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:12px;">Wybrane przedmioty</div>
            <div class="usospp-planner-picks-grid">
              ${bySubject.map((entry) => this.renderPlannerPickGroup(entry)).join('')}
            </div>
          </div>
        ` : ''}
      `;
    }

    // "Dodaj przedmiot spoza listy" — collapsed to a plain ghost button;
    // expanded, a search box over the full catalog (same searchCatalog used
    // by the topbar search, see onPlannerSearchInput), so a student can add
    // a subject their programme stage didn't surface (WF, a language
    // elective, a course from another kierunek…).
    renderPlannerCustomSearch() {
      if (!this.state.plannerCustomSearchOpen) {
        return         `<button class="usospp-btn-ghost" style="margin-top:14px;margin-bottom:12px;" data-action="plannerToggleCustomSearch">+ Dodaj przedmiot spoza listy</button>`;
      }
      return `
        <div style="margin-bottom:14px;">
          <div class="usospp-search-wrap" style="width:100%;">
            <input class="usospp-search-input" type="text" placeholder="Szukaj przedmiotu po nazwie lub kodzie…" data-action="plannerSearchInput" value="${esc(this.state.plannerCustomSearchQuery)}">
            <div data-planner-search-results-root>${this.renderPlannerCustomSearchResults()}</div>
          </div>
          <a data-action="plannerToggleCustomSearch" style="display:inline-block;margin-top:8px;font-size:12px;font-weight:600;">Anuluj</a>
        </div>
      `;
    }

    renderPlannerCustomSearchResults() {
      const q = this.state.plannerCustomSearchQuery.trim();
      if (q.length < 3) return '';
      if (this.state.plannerCustomSearchLoading) {
        return `<div class="usospp-search-dropdown"><div class="usospp-empty-hint" style="padding:16px;">Szukanie…</div></div>`;
      }
      const results = this.state.plannerCustomSearchResults;
      if (!results) return '';
      if (results.length === 0) {
        return `<div class="usospp-search-dropdown"><div class="usospp-empty-hint" style="padding:16px;">Brak wyników dla „${esc(q)}”.</div></div>`;
      }
      return `
        <div class="usospp-search-dropdown">
          ${results.slice(0, 8).map((subj) => `
            <div class="usospp-search-item" data-action="plannerSelectSearchSubject" data-url="${esc(location.origin)}/kontroler.php?_action=katalog2/przedmioty/pokazPrzedmiot&prz_kod=${esc(subj.kod)}" data-name="${esc(subj.nazwa)}">
              <div class="usospp-search-item-title">${esc(subj.nazwa)}</div>
              <div class="usospp-search-item-sub">${esc(subj.jedn || '')}${subj.jedn ? ' · ' : ''}${esc(subj.kod)}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    renderPlannerAutoIntro() {
      return `
        <div class="usospp-card">
          <div class="usospp-card-title" style="margin-bottom:6px;">Generator automatyczny</div>
          <p class="usospp-muted-text">
            Wybierz przedmioty, ustaw ograniczenia i preferencje — USOS++ spróbuje ułożyć za Ciebie do 5 pasujących wariantów planu z realnych grup. To wciąż tylko podgląd czasowy: nie sprawdzamy, czy zapisy na dany cykl są otwarte.
          </p>
        </div>
      `;
    }

    renderPlannerAutoRest() {
      const { subjects } = this.plannerSubjectCandidates;
      // A subject picked via the search box below is checked into
      // plannerAutoSelected immediately (see plannerSelectSearchSubject),
      // but — unlike a manually-picked one — has no committed pick yet, so
      // plannerSubjectCandidates' pick-derived customSubjects list doesn't
      // know about it. Union it in here so it still shows up as a normal,
      // untickable-off-and-back-on row instead of only existing invisibly
      // in plannerAutoSelected.
      const knownIds = new Set(subjects.map((s) => subjectId(s.detailsUrl)));
      const extraSelected = Object.values(this.state.plannerAutoSelected)
        .filter((v) => !knownIds.has(subjectId(v.subjectUrl)))
        .map((v) => ({ name: v.subjectName, code: '', detailsUrl: v.subjectUrl }));
      const allRows = [...subjects, ...extraSelected];
      const selectedCount = Object.keys(this.state.plannerAutoSelected).length;
      const status = this.state.plannerAutoStatus;
      const busy = status === 'fetching' || status === 'generating';
      return `
        <div class="usospp-two-col">
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:12px;">Przedmioty do uwzględnienia (${selectedCount})</div>
            ${this.renderPlannerCustomSearch()}
            ${allRows.length === 0 ? `
              <div class="usospp-empty-hint">${this.data && this.data.stageSubjectsResultLoaded ? 'Nie znaleźliśmy listy przedmiotów Twojego kierunku — dodaj przedmiot spoza listy powyżej.' : 'Wczytywanie przedmiotów Twojego kierunku…'}</div>
            ` : allRows.map((s) => this.renderPlannerAutoSubjectRow(s)).join('')}
          </div>

          ${this.renderPlannerAutoPrefsForm()}
        </div>

        <button class="usospp-btn-primary" style="margin-top:16px;" data-action="plannerAutoGenerate" ${selectedCount === 0 || busy ? 'disabled' : ''}>
          ${status === 'fetching' ? 'Wczytywanie grup…' : status === 'generating' ? 'Generowanie…' : 'Generuj plan'}
        </button>

        <div style="margin-top:20px;">
          ${this.renderPlannerAutoResults()}
        </div>
      `;
    }

    renderPlannerAutoSubjectRow(s) {
      const id = subjectId(s.detailsUrl);
      const checked = !!this.state.plannerAutoSelected[id];
      return `
        <div class="usospp-list-row" data-action="plannerAutoToggleSubject" data-url="${esc(s.detailsUrl)}" data-name="${esc(s.name)}" style="cursor:pointer;">
          <div style="min-width:0;">
            <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.name)}</div>
            <div style="font-size:11.5px;color:var(--ink-3);">${esc(s.code || '')}</div>
          </div>
          <div class="usospp-switch${checked ? ' on' : ''}"><div class="usospp-switch-knob"></div></div>
        </div>
      `;
    }

    renderPlannerAutoPrefsForm() {
      const s = this.state;
      const dayOptions = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];
      return `
        <div class="usospp-card" data-planner-prefs-root>
          <div class="usospp-card-title" style="margin-bottom:12px;">Ograniczenia i preferencje</div>

          <div class="usospp-field-stack">
            <div>
              <label class="usospp-field-label">Najwcześniejsza godzina rozpoczęcia (twarde)</label>
              <input class="usospp-input" type="time" data-bind="plannerAutoEarliestStart" value="${esc(s.plannerAutoEarliestStart)}">
            </div>
            <div>
              <label class="usospp-field-label">Najpóźniejsza godzina zakończenia (twarde)</label>
              <input class="usospp-input" type="time" data-bind="plannerAutoLatestEnd" value="${esc(s.plannerAutoLatestEnd)}">
            </div>
          </div>

          <div style="margin-top:14px;">
            <label class="usospp-field-label">Zablokowane terminy (twarde)</label>
            ${s.plannerAutoBlockedWindows.map((b, i) => `
              <div class="usospp-list-row">
                <div style="font-size:12.5px;">${esc(shortDay(b.day))} ${esc(b.start)}–${esc(b.end)}</div>
                <a data-action="plannerAutoRemoveBlock" data-index="${i}" style="font-size:12px;font-weight:600;color:oklch(58% 0.19 25);">usuń</a>
              </div>
            `).join('')}
            <div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap;">
              <select class="usospp-input" style="width:auto;" data-bind="plannerAutoBlockDraftDay">
                ${dayOptions.map((d) => `<option value="${esc(d)}" ${s.plannerAutoBlockDraftDay === d ? 'selected' : ''}>${esc(shortDay(d))}</option>`).join('')}
              </select>
              <input class="usospp-input" style="width:auto;" type="time" data-bind="plannerAutoBlockDraftStart" value="${esc(s.plannerAutoBlockDraftStart)}">
              <span style="color:var(--ink-3);">–</span>
              <input class="usospp-input" style="width:auto;" type="time" data-bind="plannerAutoBlockDraftEnd" value="${esc(s.plannerAutoBlockDraftEnd)}">
              <button class="usospp-btn-ghost" data-action="plannerAutoAddBlock">+ Dodaj blokadę</button>
            </div>
          </div>

          <div class="usospp-field-stack" style="margin-top:14px;">
            <div>
              <label class="usospp-field-label">Maks. liczba zajęć dziennie (preferencja)</label>
              <input class="usospp-input" type="number" min="1" data-bind="plannerAutoMaxPerDay" value="${esc(s.plannerAutoMaxPerDay)}" placeholder="bez limitu">
            </div>
            <div>
              <label class="usospp-field-label">Preferowana liczba dni zajęciowych</label>
              <input class="usospp-input" type="number" min="1" max="7" data-bind="plannerAutoPreferredDays" value="${esc(s.plannerAutoPreferredDays)}" placeholder="bez preferencji">
            </div>
            <div class="usospp-list-row">
              <div style="font-size:13px;">Minimalizuj okienka między zajęciami</div>
              <div class="usospp-switch${s.plannerAutoMinimizeGaps ? ' on' : ''}" data-action="plannerAutoToggleMinimizeGaps"><div class="usospp-switch-knob"></div></div>
            </div>
            <div class="usospp-list-row">
              <div style="font-size:13px;">Tylko grupy z wolnymi miejscami (twarde, wg zapisów)</div>
              <div class="usospp-switch${s.plannerAutoOnlyFreeSeats ? ' on' : ''}" data-action="plannerAutoToggleOnlyFreeSeats"><div class="usospp-switch-knob"></div></div>
            </div>
          </div>
        </div>
      `;
    }

    renderPlannerAutoResults() {
      const status = this.state.plannerAutoStatus;
      if (status === 'idle') {
        return `<div class="usospp-card"><div class="usospp-empty-hint">Wybierz przedmioty i kliknij „Generuj plan”.</div></div>`;
      }
      if (status === 'fetching' || status === 'generating') {
        return `<div class="usospp-card"><div class="usospp-empty-hint">${status === 'fetching' ? 'Wczytywanie grup zajęć…' : 'Generowanie propozycji…'}</div></div>`;
      }
      if (status === 'failed') {
        return this.renderPlannerAutoFailure();
      }
      const candidates = this.state.plannerAutoCandidates;
      if (!candidates.length) {
        return `<div class="usospp-card"><div class="usospp-empty-hint">Brak propozycji.</div></div>`;
      }
      const activeIndex = Math.min(this.state.plannerAutoActiveCandidateIndex, candidates.length - 1);
      const active = candidates[activeIndex];
      return `
        <div class="usospp-card">
          <div class="usospp-card-head">
            <div class="usospp-card-title">Wygenerowane warianty</div>
            <button class="usospp-btn-primary" data-action="plannerUseGeneratedCandidate" data-index="${activeIndex}">Użyj tego planu</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;">
            ${candidates.map((c, i) => `
              <button class="usospp-mode-btn${i === activeIndex ? ' active' : ''}" data-action="plannerAutoSelectCandidate" data-index="${i}">Wariant ${i + 1}</button>
            `).join('')}
          </div>
          ${this.renderPlannerCandidateGrid(active)}
        </div>
      `;
    }

    renderPlannerAutoFailure() {
      const f = this.state.plannerAutoFailure;
      if (!f) return '';
      if (f.kind === 'plan-limit' || f.kind === 'fetch' || f.kind === 'error') {
        return `<div class="usospp-card"><div class="usospp-empty-hint">${esc(f.message)}</div></div>`;
      }
      if (f.reason === 'empty-domain') {
        return `
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:8px;color:oklch(55% 0.19 25);">Nie da się ułożyć planu</div>
            <p class="usospp-muted-text">Żadna dostępna grupa nie mieści się w Twoich ograniczeniach dla:</p>
            <ul style="margin:6px 0 0 18px;padding:0;font-size:13px;">
              ${f.emptyVariables.map((v) => `<li>${esc(v.subjectName)} — ${esc(v.classTypeLabel)}</li>`).join('')}
            </ul>
            <p class="usospp-muted-text" style="margin-top:8px;">Poluzuj godziny dostępności albo usuń kolidującą blokadę terminu i spróbuj ponownie.</p>
          </div>
        `;
      }
      if (f.reason === 'infeasible') {
        const hasRelaxations = f.helpfulRelaxations && f.helpfulRelaxations.length;
        const hasPairs = f.conflictingPairs && f.conflictingPairs.length;
        return `
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:8px;color:oklch(55% 0.19 25);">Nie da się ułożyć planu</div>
            <p class="usospp-muted-text">Każdy przedmiot z osobna ma jakieś dostępne grupy, ale żadna ich kombinacja nie mieści się bez kolizji.</p>
            ${hasRelaxations ? `
              <p style="font-size:13px;font-weight:600;margin-top:10px;margin-bottom:4px;">To by pomogło (sprawdzone):</p>
              <ul style="margin:0 0 0 18px;padding:0;font-size:13px;">
                ${f.helpfulRelaxations.map((r) => `<li>Zluzuj: ${esc(r)}</li>`).join('')}
              </ul>
            ` : ''}
            ${hasPairs ? `
              <p style="font-size:13px;font-weight:600;margin-top:10px;margin-bottom:4px;">Całkowicie skonfliktowane pary zajęć:</p>
              <ul style="margin:0 0 0 18px;padding:0;font-size:13px;">
                ${f.conflictingPairs.map((p) => `<li>${esc(p.a)} ↔ ${esc(p.b)}</li>`).join('')}
              </ul>
            ` : ''}
            ${!hasRelaxations && !hasPairs ? `<p class="usospp-muted-text" style="margin-top:8px;">Spróbuj usunąć jeden z przedmiotów z generowania albo poluzować preferencje.</p>` : ''}
          </div>
        `;
      }
      return `<div class="usospp-card"><div class="usospp-empty-hint">Nie udało się wygenerować planu.</div></div>`;
    }

    // Same pixel-positioned weekly grid as renderPlannerGrid (same classes:
    // .usospp-timetable/.usospp-tt-*), just sourced from one generated
    // candidate's assignment instead of state.plannerPicks — no draft-
    // ghosting, no pendingRemoval, no conflict detection needed, since the
    // CSP engine only ever returns candidates that are already internally
    // conflict-free by construction.
    renderPlannerCandidateGrid(candidate) {
      const dark = this.settings.darkMode;
      const flat = [];
      candidate.assignment.forEach(({ variable, group }) => {
        (group.sessions || []).forEach((s) => {
          if (!s.start || !s.end) return;
          flat.push({
            day: s.day, start: s.start, end: s.end, place: s.place, weeks: s.weeks,
            subjectName: variable.subjectName, classTypeShort: variable.classTypeShort, teacher: group.teacher,
            seed: this.plannerColorSeed(variable.subjectName),
          });
        });
      });
      if (!flat.length) return `<div class="usospp-empty-hint">Brak zajęć w tym wariancie.</div>`;

      const allMins = flat.flatMap((e) => [toMin(e.start), toMin(e.end)]).filter((n) => n !== null);
      const hourStart = Math.max(0, Math.floor(Math.min(...allMins) / 60));
      const hourEnd = Math.ceil(Math.max(...allMins) / 60);
      const ROW_H = 60;
      const totalHeight = Math.max(1, hourEnd - hourStart) * ROW_H;
      const hours = [];
      for (let h = hourStart; h <= hourEnd; h++) hours.push(h);

      const byDay = {};
      flat.forEach((e) => { const d = shortDay(e.day); (byDay[d] = byDay[d] || []).push(e); });
      const dayGroups = DAY_KEYS.map((dk) => ({ day: dk, entries: byDay[dk] || [] })).filter((d) => d.entries.length);

      return `
        <div class="usospp-timetable">
          <div class="usospp-tt-hours" style="height:${totalHeight}px;">
            ${hours.map((h) => `<div class="usospp-tt-hour" style="top:${(h - hourStart) * ROW_H}px;">${h}:00</div>`).join('')}
          </div>
          <div class="usospp-tt-days">
            ${dayGroups.map((d) => `
              <div class="usospp-tt-daycol">
                <div class="usospp-tt-daylabel">${esc(d.day)}</div>
                <div class="usospp-tt-daybody" style="height:${totalHeight}px;background-size:100% ${ROW_H}px;">
                  ${d.entries.map((e) => {
                    const startMin = toMin(e.start);
                    const endMin = toMin(e.end);
                    const top = (startMin - hourStart * 60) * (ROW_H / 60);
                    const height = Math.max(36, (endMin - startMin) * (ROW_H / 60));
                    const color = subjectColor(e.seed, dark);
                    const weeksTag = weeksLabel(e.weeks);
                    const full = [e.subjectName, e.teacher, e.place].filter(Boolean).join(' — ')
                      + (weeksTag ? ` — co drugi tydzień (${e.weeks === 'even' ? 'parzyste' : 'nieparzyste'})` : '');
                    return `
                      <div class="usospp-tt-entry" style="top:${top}px;height:${height}px;background:${color.bg};" title="${esc(full)}">
                        <div class="usospp-tt-entry-time" style="color:${color.time};">${esc(e.start)}–${esc(e.end)}${weeksTag ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:9.5px;padding:1px 5px;">${weeksTag}</span>` : ''}</div>
                        <div class="usospp-tt-entry-label" style="color:${color.label};">${esc(e.classTypeShort)} · ${esc(e.subjectName)}</div>
                        ${e.teacher ? `<div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(e.teacher)}</div>` : ''}
                        ${e.place ? `<div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(shortPlace(e.place))}</div>` : ''}
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // "Moje plany" — full-width version management above the generator:
    // rich cards (stats, main star, per-plan actions) instead of the old
    // tab strip that used to live in the left column. plannerPlansFull
    // carries every plan's picks so stats don't need extra storage reads.
    renderPlannerVersions() {
      const plans = this.state.plannerPlansFull;
      const activeId = this.state.plannerActivePlanId;
      const renamingId = this.state.plannerRenamingPlanId;
      const confirmId = this.state.plannerConfirmDeleteId;
      const planner = window.USOSPP_PLANNER;
      const maxPlans = (planner && planner.MAX_PLANS) || 4;
      const atLimit = plans.length >= maxPlans;
      const mainPlan = plans.find((p) => p.isMain);
      return `
        <div class="usospp-card">
          <div class="usospp-card-head">
            <div class="usospp-card-title">Moje plany</div>
            <div style="display:flex;gap:10px;align-items:center;">
              <span class="usospp-muted-text" style="font-size:12px;">${plans.length}/${maxPlans}</span>
              ${!atLimit ? `<button class="usospp-btn-ghost" style="font-size:12px;" data-action="plannerNewPlan">+ Nowy plan</button>` : `<span class="usospp-tag-muted">limit ${maxPlans} planów</span>`}
            </div>
          </div>
          ${!plans.length ? `
            <div class="usospp-empty-hint">Brak planów — utwórz pierwszy powyżej.</div>
          ` : `
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;">
            ${plans.map((p) => this.renderPlannerVersionCard(p, { activeId, renamingId, confirmId, atLimit, count: plans.length })).join('')}
          </div>`}
          ${mainPlan && mainPlan.id !== activeId ? `<div style="font-size:12px;color:var(--ink-3);margin-top:12px;">Oglądasz inny plan niż główny — podświetlenie „w planie” w Zapisach dotyczy planu <strong>${esc(mainPlan.name)}</strong>.</div>` : ''}
        </div>
      `;
    }

    renderPlannerVersionCard(p, { activeId, renamingId, confirmId, atLimit, count }) {
      const st = (p && p.stats) || { subjects: 0, groups: 0, hours: 0, collisions: 0 };
      const active = p.id === activeId;
      const renaming = renamingId === p.id;
      const confirming = confirmId === p.id;
      const hours = `${String(st.hours).replace('.', ',')} godz.`;
      const statsLine = `${st.subjects} ${pluralPl(st.subjects, 'przedmiot', 'przedmioty', 'przedmiotów')} · ${st.groups} ${pluralPl(st.groups, 'grupa', 'grupy', 'grup')}`;
      return `
        <div data-action="plannerSwitchPlan" data-id="${esc(p.id)}" title="${esc(active ? `Plan ${p.name} (otwarty)` : `Otwórz plan ${p.name}`)}" style="border:1px solid ${active ? '#d9773a' : 'var(--border)'};border-radius:14px;padding:14px 16px;background:${active ? 'var(--bg-subtle)' : 'var(--bg-card)'};cursor:pointer;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
            <span data-action="plannerSetMainPlan" data-id="${esc(p.id)}" title="${esc(p.isMain ? 'Plan główny — pokazywany w Zapisach' : 'Ustaw jako plan główny (pokazywany w Zapisach)')}" style="cursor:pointer;font-size:14px;color:${p.isMain ? '#d9773a' : 'var(--ink-3)'};flex-shrink:0;">${p.isMain ? '★' : '☆'}</span>
            ${renaming
              ? `<input data-plan-rename="${esc(p.id)}" data-action="plannerNoop" value="${esc(p.name)}" maxlength="40" style="flex:1;min-width:0;font-size:13px;font-weight:600;padding:4px 8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--ink);" /><span data-action="plannerCommitRename" data-id="${esc(p.id)}" title="Zapisz nazwę" style="cursor:pointer;font-weight:700;flex-shrink:0;">✓</span><span data-action="plannerCancelRename" title="Anuluj" style="cursor:pointer;color:var(--ink-3);flex-shrink:0;">✕</span>`
              : `<div style="font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${esc(p.name)}</div>
                 <span data-action="plannerStartRename" data-id="${esc(p.id)}" title="Zmień nazwę" style="cursor:pointer;color:var(--ink-3);font-size:12px;flex-shrink:0;">✎</span>`}
          </div>
          ${p.isMain ? `<div style="font-size:11px;font-weight:700;color:#d9773a;margin-bottom:8px;">PLAN GŁÓWNY</div>` : ''}
          <div style="font-size:12px;color:var(--ink-2);margin-bottom:4px;">${statsLine}</div>
          <div style="font-size:12px;color:var(--ink-2);margin-bottom:10px;">${hours} / tydz.${st.collisions ? ` · <span style="color:oklch(55% 0.19 25);font-weight:700;">kolizje: ${st.collisions}</span>` : ''}</div>
          ${!st.groups ? `<div class="usospp-empty-hint" style="padding:4px 0;margin-bottom:10px;">Pusty — dodaj przedmioty poniżej.</div>` : ''}
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
            ${active ? (!atLimit ? `<a data-action="plannerDuplicatePlan" data-id="${esc(p.id)}" style="font-size:12px;font-weight:600;">Duplikuj</a>` : '') : ''}
            ${active && count > 1 ? (confirming
              ? `<span style="font-size:12px;font-weight:700;">Usunąć?</span><a data-action="plannerDeletePlan" data-id="${esc(p.id)}" style="font-size:12px;font-weight:700;color:oklch(58% 0.19 25);">Tak</a><a data-action="plannerCancelDelete" style="font-size:12px;">Nie</a>`
              : `<a data-action="plannerDeletePlan" data-id="${esc(p.id)}" style="font-size:12px;font-weight:600;color:oklch(58% 0.19 25);">Usuń</a>`) : ''}
          </div>
        </div>
      `;
    }

    // Left-column subjects in Zapisy mode: free first, the rest dimmed
    // below with a reason tag (never hidden — unknown state never
    // filters). Planowanie mode renders the plain list.
    renderPlannerSubjectList(subjects) {
      if (!this.state.plannerZapisyMode) return subjects.map((s) => this.renderPlannerSubjectRow(s)).join('');
      const rank = { free: 0, unknown: 1, full: 2 };
      return subjects
        .map((s) => ({ s, seat: this.plannerCandidateSeatClass(s) }))
        .sort((a, b) => rank[a.seat.cls] - rank[b.seat.cls])
        .map(({ s, seat }) => this.renderPlannerSubjectRow(s, seat.cls === 'free' ? null : seat))
        .join('');
    }

    renderPlannerSubjectRow(s, seat = null) {
      const url = s.detailsUrl;
      const expanded = this.state.plannerExpandedUrl === url;
      const color = subjectColor(this.plannerColorSeed(s.name), this.settings.darkMode);
      const subjectPicks = this.state.plannerPicks.filter((p) => subjectId(p.subjectUrl) === subjectId(url));
      const already = subjectPicks.length > 0;
      // Fractional status dot: split across the subject's class types
      // (Wykład half-filled when Ćwiczenia are still missing, etc.).
      let dotBg = 'var(--border)';
      let dotTitle = '';
      if (already) {
        const progress = this.plannerSubjectTypeProgress(url);
        if (progress && progress.done < progress.total) {
          const pct = Math.round((progress.done / progress.total) * 100);
          dotBg = `conic-gradient(${color.time} ${pct}%, var(--border) 0)`;
        } else {
          dotBg = color.time;
        }
        if (progress) {
          dotTitle = progress.perType.map((t) => `${t.short}: ${t.nr ? `gr. ${t.nr}` : '—'}`).join(' • ');
        }
      }
      const dimmed = !!(seat && seat.cls !== 'free');
      return `
        <div class="usospp-planner-subject" data-planner-subject="${esc(url)}"${dimmed ? ' style="opacity:.55;"' : ''}>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;cursor:pointer;" data-action="plannerToggleSubject" data-url="${esc(url)}">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              <span title="${esc(dotTitle)}" style="width:12px;height:12px;border-radius:999px;flex-shrink:0;background:${dotBg};"></span>
              <div style="min-width:0;">
                <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.name)}</div>
                <div style="font-size:11.5px;color:var(--ink-3);">${esc(s.code || '')}${dimmed && seat.tag ? ` · ${esc(seat.tag)}` : ''}</div>
              </div>
            </div>
            <span style="font-size:12px;font-weight:600;color:var(--ink-3);flex-shrink:0;">${expanded ? '▲' : (already ? 'edytuj ▾' : 'dodaj ▾')}</span>
          </div>
          ${expanded ? this.renderPlannerSubjectPanel(url) : ''}
        </div>
      `;
    }

    renderPlannerSubjectPanel(url) {
      if (this.state.plannerSubjectLoading === url) {
        return `<div class="usospp-empty-hint" style="padding:10px 0;">Wczytywanie…</div>`;
      }
      const details = this.state.plannerSubjectCache[url];
      if (!details || !details.supported) {
        return `<div class="usospp-empty-hint" style="padding:10px 0;">Nie udało się wczytać zajęć tego przedmiotu. <a data-action="openUsos" data-url="${esc(url)}">Otwórz w USOS →</a></div>`;
      }
      const relevantCycles = details.cycles.filter((c) => !/zakończon/i.test(c.cycleState || ''));
      const cycle = (relevantCycles.length ? relevantCycles : details.cycles)[0];
      if (!cycle) {
        return `<div class="usospp-empty-hint" style="padding:10px 0;">Ten przedmiot nie ma aktywnego cyklu zajęć.</div>`;
      }
      if (!cycle.classTypes.length) {
        return `<div class="usospp-empty-hint" style="padding:10px 0;">Brak zdefiniowanych typów zajęć dla tego cyklu.</div>`;
      }
      // Class types whose draft points at a different group than the saved
      // pick: committing replaces them. Say so explicitly — on the grid the
      // old block is marked, but the button row is where the decision lands.
      const replacements = cycle.classTypes.map((ct) => {
        const key = classTypeKey(url, cycle.cycleName, ct.label);
        const draft = this.state.plannerDraftSelection[key];
        if (!draft || draft.removed || !draft.nr) return null;
        const pick = this.state.plannerPicks.find((p) => p.key === key);
        if (!pick || pick.nr === draft.nr) return null;
        return `${shortClassType(ct.label)}: gr. ${pick.nr} → gr. ${draft.nr}`;
      }).filter(Boolean);
      return `
        <div style="padding:2px 0 12px 0;">
          <div style="font-size:11.5px;color:var(--ink-3);margin-bottom:10px;">${esc(cycle.cycleName)}${cycle.period ? ` · ${esc(cycle.period)}` : ''}</div>
          ${cycle.classTypes.map((ct) => this.renderPlannerClassType(url, cycle.cycleName, ct)).join('')}
          ${replacements.length ? `<div style="font-size:11.5px;font-weight:600;margin-bottom:8px;">Po zapisaniu zastąpi: ${esc(replacements.join(' · '))}</div>` : ''}
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">
            <button class="usospp-btn-primary" data-action="plannerAddSubject" data-url="${esc(url)}" data-subject-name="${esc(details.subjectName)}" data-cycle-name="${esc(cycle.cycleName)}">
              Dodaj do planu
            </button>
          </div>
        </div>
      `;
    }

    renderPlannerClassType(url, cycleName, ct) {
      const key = classTypeKey(url, cycleName, ct.label);
      const selection = this.state.plannerDraftSelection[key];
      if (!ct.groupsUrl) {
        return `
          <div style="margin-bottom:14px;">
            <div style="font-size:12.5px;font-weight:600;margin-bottom:4px;">${esc(ct.label)}</div>
            <div class="usospp-empty-hint" style="padding:4px 0;">Brak listy grup do wyboru dla tego typu zajęć.</div>
          </div>
        `;
      }
      const cached = this.state.plannerGroupsCache[ct.groupsUrl];
      const pendingRemoval = !!(selection && selection.removed);
      const previewed = !!this.state.plannerPreviewKeys[key];
      return `
        <div style="margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;">
            <div style="font-size:12.5px;font-weight:600;">${esc(ct.label)}</div>
            <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
              ${selection && !pendingRemoval ? `<span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:11px;">grupa ${esc(selection.nr)}</span>` : ''}
              <a class="usospp-cand-toggle${previewed ? ' active' : ''}" data-action="plannerTogglePreview" data-key="${esc(key)}" data-groups-url="${esc(ct.groupsUrl)}" data-class-type-label="${esc(ct.label)}">${previewed ? 'ukryj podgląd' : 'podgląd w planie'}</a>
            </div>
          </div>
          ${previewed ? `<div style="font-size:11px;color:var(--ink-3);margin-bottom:6px;">Wszystkie grupy tego typu są widoczne w planie jako propozycje — każda na własnym pasie obok siebie; kliknij grupę, żeby ją wybrać.</div>` : ''}
          ${pendingRemoval ? `<div style="font-size:11.5px;color:oklch(55% 0.19 25);margin-bottom:6px;">Grupa ${esc(selection.nr)} zostanie usunięta z planu po zapisaniu — kliknij ją ponownie, aby to odwołać.</div>` : ''}
          ${!cached ? `
            <button class="usospp-btn-ghost" data-action="plannerLoadGroups" data-url="${esc(ct.groupsUrl)}">Pokaż grupy</button>
          ` : cached.loading ? `
            <div class="usospp-empty-hint" style="padding:4px 0;">Wczytywanie grup…</div>
          ` : !cached.data || !cached.data.supported || !cached.data.groups.length ? `
            <div class="usospp-empty-hint" style="padding:4px 0;">Nie udało się wczytać grup. <a data-action="openUsos" data-url="${esc(ct.groupsUrl)}">Otwórz w USOS →</a></div>
          ` : `
            <div style="max-height:220px;overflow-y:auto;">
              ${cached.data.groups.map((g) => this.renderPlannerGroupOption(key, ct.groupsUrl, ct.label, g, !pendingRemoval && !!(selection && selection.nr === g.nr))).join('')}
            </div>
          `}
        </div>
      `;
    }

    renderPlannerGroupOption(key, groupsUrl, classTypeLabel, g, selected) {
      const schedule = (g.sessions || []).map((sess) => `${esc(shortDay(sess.day))} ${esc(sess.start)}–${esc(sess.end)}${weeksLabel(sess.weeks) ? ` (${weeksLabel(sess.weeks)})` : ''}${sess.place ? `, ${esc(shortPlace(sess.place))}` : ''}`).join(' · ') || 'brak danych o terminie';
      const buildings = [...new Set((g.sessions || []).map((sess) => buildingCode(sess.place)).filter(Boolean))];
      return `
        <div class="usospp-radio-row${selected ? ' selected' : ''}" data-action="plannerSelectGroup" data-key="${esc(key)}" data-groups-url="${esc(groupsUrl)}" data-nr="${esc(g.nr)}" data-class-type-label="${esc(classTypeLabel)}">
          <div class="usospp-radio-dot"></div>
          <div style="min-width:0;flex:1;">
            <div style="font-size:12.5px;font-weight:600;">
              Grupa ${esc(g.nr)}
              ${buildings.length ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:10.5px;padding:2px 9px;">${esc(buildings.join(', '))}</span>` : ''}
              ${g.occupancy ? ` <span style="color:var(--ink-3);font-weight:500;">· ${esc(g.occupancy)}</span>` : ''}${this.seatTagHtml(key, classTypeLabel, g.nr)}
            </div>
            <div style="font-size:11.5px;color:var(--ink-3);margin-top:1px;">${schedule}</div>
            ${g.teacher ? `<div style="font-size:11.5px;color:var(--ink-3);">${esc(g.teacher)}</div>` : ''}
          </div>
        </div>
      `;
    }

    // Enroll target for one "Wybrane przedmioty" subject: the first pick's
    // badge when the seat check covered it (full meta + highlight), else a
    // tour-subject match from cache (list works, no highlight/register —
    // openZapisGrupy tolerates the gaps), else null (button renders
    // disabled with a "spoza tury" tag).
    plannerSubjectEnrollTarget(entry) {
      const badges = this.state.plannerRejBadges || {};
      const pick = (entry.picks || []).find((p) => (badges[p.key] || {}).groupsUrl);
      const hit = pick ? badges[pick.key] : null;
      if (hit) {
        return {
          tourKey: hit.tourKey || null, subjKod: hit.kod || null,
          title: hit.title || entry.subjectName, kod: hit.kod || '', cykl: hit.cykl || '',
          groupsUrl: hit.groupsUrl, registerUrl: hit.registerUrl || null, highlightNr: pick.nr,
        };
      }
      const subj = this.plannerMatchTourSubject(
        { name: entry.subjectName, detailsUrl: entry.subjectUrl }, this.plannerCachedTourSubjects());
      if (subj && subj.groupsUrl) {
        return {
          tourKey: null, subjKod: subj.kod || null,
          title: subj.name || entry.subjectName, kod: subj.kod || '', cykl: (subj.cycles && subj.cycles[0]) || '',
          groupsUrl: subj.groupsUrl, registerUrl: null, highlightNr: null,
        };
      }
      return null;
    }

    renderPlannerPickGroup(entry) {
      const color = subjectColor(this.plannerColorSeed(entry.subjectName), this.settings.darkMode);
      const enroll = this.plannerSubjectEnrollTarget(entry);
      const enrollBtn = enroll
        ? `<button class="usospp-btn-ghost" style="font-size:12px;flex-shrink:0;" data-action="plannerSubjectEnroll" data-tour="${esc(enroll.tourKey || '')}" data-kod="${esc(enroll.kod || '')}" data-name="${esc(enroll.title || '')}" data-cykl="${esc(enroll.cykl || '')}" data-url="${esc(enroll.groupsUrl || '')}" data-register="${esc(enroll.registerUrl || '')}" data-nr="${esc(enroll.highlightNr ?? '')}">Zapisz się →</button>`
        : `<span style="font-size:11.5px;color:var(--ink-3);flex-shrink:0;">spoza tury</span>`;
      return `
        <div class="usospp-planner-pick-card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="width:9px;height:9px;border-radius:999px;flex-shrink:0;background:${color.time};"></span>
            <div style="font-size:13px;font-weight:600;">${esc(entry.subjectName)}</div>
            <span style="flex:1;"></span>
            ${enrollBtn}
          </div>
          ${entry.picks.map((p) => `
            <div class="usospp-list-row">
              <div>
                <div style="font-size:12.5px;">${esc(p.classTypeLabel)} · grupa ${esc(p.nr)}</div>
                <div style="font-size:11.5px;color:var(--ink-3);margin-top:1px;">${(p.sessions || []).map((sess) => `${esc(shortDay(sess.day))} ${esc(sess.start)}–${esc(sess.end)}${weeksLabel(sess.weeks) ? ` (${weeksLabel(sess.weeks)})` : ''}`).join(' · ') || 'brak danych o terminie'}${p.teacher ? ' · ' + esc(p.teacher) : ''}</div>
              </div>
              <a data-action="plannerRemovePick" data-key="${esc(p.key)}" style="font-size:12px;font-weight:600;color:oklch(58% 0.19 25);">usuń</a>
            </div>
          `).join('')}
        </div>
      `;
    }

    // Builds the weekly-grid preview straight out of saved picks' sessions
    // (not out of any adapter timetable), and flags same-day overlapping
    // entries — a schedule the student assembled themselves can perfectly
    // well contain a conflict, so we surface it rather than silently
    // allowing or blocking any particular combination.
    renderPlannerGrid() {
      const dark = this.settings.darkMode;
      const draftSelection = this.state.plannerExpandedUrl ? this.state.plannerDraftSelection : {};
      // Sessions with no usable time can't be placed on the grid — count
      // them so the grid can say so instead of dropping them silently.
      let skippedNoTime = 0;
      // Per previewed class type filtered to zero by freeOnly: {label,
      // ownNr} — rendered as a "no free terms" note under the grid.
      const filteredOut = [];
      const flat = [];
      this.state.plannerPicks.forEach((p) => {
        const pendingRemoval = !!(draftSelection[p.key] && draftSelection[p.key].removed);
        // The draft for this class type points at a DIFFERENT group than
        // the committed pick: "Dodaj do planu" will silently REPLACE this
        // entry (plannerAddSubject replaces by key), so mark it as such
        // instead of letting it look like it stays.
        const draft = draftSelection[p.key];
        const willBeReplaced = !!(draft && !draft.removed && draft.nr && draft.nr !== p.nr);
        (p.sessions || []).forEach((s, i) => {
          if (!s.start || !s.end) { skippedNoTime++; return; }
          flat.push({
            day: s.day, start: s.start, end: s.end, place: s.place, weeks: s.weeks,
            subjectName: p.subjectName, classTypeShort: p.classTypeShort, teacher: p.teacher,
            seed: this.plannerColorSeed(p.subjectName), pickKey: `${p.key}::${i}`, key: p.key, nr: p.nr, draft: false, pendingRemoval,
            subjectUrl: p.subjectUrl,
            willBeReplaced, replacedByNr: willBeReplaced ? draft.nr : null, coveredBy: [],
          });
        });
      });

      // While a subject's configurator is open, mirror whatever's currently
      // selected there into the grid right away as a dashed placeholder —
      // without this, picking a group only shows up after "Dodaj do planu",
      // so there's no way to see whether a choice actually fits until it's
      // already been committed.
      const expandedUrl = this.state.plannerExpandedUrl;
      if (expandedUrl) {
        const cached = this.state.plannerSubjectCache[expandedUrl];
        const subjectName = (cached && cached.subjectName) || '…';
        Object.entries(this.state.plannerDraftSelection).forEach(([key, g]) => {
          // A draft selection that's prefilled straight from an already-
          // saved pick (reopening a subject shows its existing choice as
          // "selected" automatically) is already on the grid as a real,
          // solid entry — ghosting it too would just draw a second, dashed
          // copy on top of itself. Only draw the ghost when the draft
          // actually differs from what's committed (i.e. the student is
          // previewing a change before saving it).
          const matchesCommitted = this.state.plannerPicks.some((p) => p.key === key && p.nr === g.nr);
          if (matchesCommitted) return;
          (g.sessions || []).forEach((s, i) => {
            if (!s.start || !s.end) { skippedNoTime++; return; }
            flat.push({
              day: s.day, start: s.start, end: s.end, place: s.place, weeks: s.weeks,
              subjectName, classTypeShort: shortClassType(g.classTypeLabel), teacher: g.teacher,
              seed: this.plannerColorSeed(subjectName), pickKey: `${key}::draft::${i}`, key, draft: true,
              subjectUrl: expandedUrl,
            });
          });
        });

        // Previewed class types ("podgląd w planie", see
        // plannerTogglePreview): every not-yet-chosen group becomes a
        // lightweight ghost box for each of its sessions (renderPlannerCandDay).
        // They feed the hour range like real entries — the time axis has to
        // stretch to show them — but are deliberately excluded from the
        // conflict computation below: trying every group on for size is the
        // whole point of the preview.
        Object.entries(this.state.plannerPreviewKeys).forEach(([key, meta]) => {
          const groupsEntry = this.state.plannerGroupsCache[meta.groupsUrl];
          if (!groupsEntry || groupsEntry.loading || !groupsEntry.data || !groupsEntry.data.supported) return;
          const draft = this.state.plannerDraftSelection[key];
          const counter = { label: meta.classTypeLabel, total: 0, shown: 0, ownNr: null };
          groupsEntry.data.groups.forEach((g) => {
            // The class type's draft/committed choice is already on the
            // grid (dashed ghost / solid box) — ghosting the same group a
            // second time would just double-draw it on top of itself. An
            // exception: while the committed choice is pending removal
            // (draft.removed), it renders struck-through and the student
            // is re-picking, so its group belongs back in the candidates.
            if (draft && !draft.removed && draft.nr === g.nr) return;
            const removalPending = !!(draft && draft.removed);
            const committedPick = this.state.plannerPicks.find((p) => p.key === key && p.nr === g.nr);
            // The committed group of this class type stays visible in the
            // preview as a hybrid "current" ghost (solid subject colour +
            // dashed preview outline) — so the preview reads as "these are
            // this subject's terms, and THIS one is currently chosen". Only
            // while no diverging draft re-points the type elsewhere (then
            // the willBeReplaced marking + draft ghost already tell that
            // story and a hybrid would triple-draw), and never while the
            // pick is pending removal (it's on its way out).
            const isCurrent = !removalPending && !!committedPick
              && (!draft || draft.nr === committedPick.nr);
            if (committedPick && !isCurrent && !removalPending) return;
            // Groups with no timed sessions aren't a "full" verdict (their
            // sessions land in skippedNoTime) — keep them out of the
            // filtered-out accounting below.
            if (!(g.sessions || []).some((s) => s.start && s.end)) return;
            counter.total++;
            const own = (committedPick && committedPick.nr) || ((draft && !draft.removed && draft.nr) || null);
            if (!counter.ownNr && own) counter.ownNr = own;
            // Block-click preview ("wolne terminy") skips confirmed-full
            // groups, but only in Zapisy mode — Planowanie always shows
            // all. Unknown stays in both (never filter on unknown). The
            // configurator's own preview shows all and dims full ones.
            if (meta.freeOnly && this.state.plannerZapisyMode) {
              const freeSeats = this.plannerCandSeats(subjectName, meta.classTypeLabel, g.nr, expandedUrl, g.sessions);
              if (freeSeats && freeSeats.known && freeSeats.full) return;
            }
            let pushed = false;
            (g.sessions || []).forEach((s) => {
              if (!s.start || !s.end) { skippedNoTime++; return; }
              pushed = true;
              flat.push({
                day: s.day, start: s.start, end: s.end, place: s.place, weeks: s.weeks,
                subjectName, subjectUrl: expandedUrl, classTypeShort: shortClassType(meta.classTypeLabel), teacher: g.teacher,
                seed: this.plannerColorSeed(subjectName), pickKey: `cand::${key}::${g.nr}`, key,
                draft: false, pendingRemoval: false, candidate: true, candGroup: `${key}::${g.nr}`,
                current: isCurrent,
                candRef: { key, groupsUrl: meta.groupsUrl, classTypeLabel: meta.classTypeLabel, nr: g.nr, teacher: g.teacher },
              });
            });
            if (pushed && !isCurrent) counter.shown++;
          });
          if (meta.freeOnly && this.state.plannerZapisyMode && counter.total > 0 && counter.shown === 0) filteredOut.push(counter);
        });
      }

      // "No free terms" notes for previewed types filtered to zero —
      // shared by the empty and non-empty returns below (an all-filtered
      // preview leaves flat empty, so the early return must show them too).
      const filteredNotesHtml = filteredOut.map((c) => `<div style="font-size:12px;color:var(--ink-3);margin-bottom:10px;">${c.ownNr ? `${esc(c.label)}: Twój termin (gr. ${esc(String(c.ownNr))}) to jedyny wolny — pozostałe grupy pełne.` : `${esc(c.label)}: brak wolnych terminów — wszystkie grupy pełne.`}</div>`).join('');
      if (!flat.length) {
        return `${filteredNotesHtml}<div class="usospp-empty-hint">${filteredOut.length ? 'Podgląd nie ma nic do pokazania — wszystkie terminy pełne.' : `Dodaj przedmioty po lewej, żeby zobaczyć tu podgląd planu.${skippedNoTime ? ` Pominięto ${skippedNoTime} ${skippedNoTime === 1 ? 'termin' : 'terminów'} bez podanych godzin.` : ''}`}</div>`;
      }

      const allMins = flat.flatMap((e) => [toMin(e.start), toMin(e.end)]).filter((n) => n !== null);
      const hourStart = Math.max(0, Math.floor(Math.min(...allMins) / 60));
      const hourEnd = Math.ceil(Math.max(...allMins) / 60);
      const ROW_H = 60;
      const totalHeight = Math.max(1, hourEnd - hourStart) * ROW_H;
      const hours = [];
      for (let h = hourStart; h <= hourEnd; h++) hours.push(h);

      const byDay = {};
      flat.forEach((e) => {
        const d = shortDay(e.day);
        (byDay[d] = byDay[d] || []).push(e);
      });
      const conflicts = new Set();
      Object.values(byDay).forEach((list) => {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];
            if (a.candidate || b.candidate) continue;
            // A draft ghost always REPLACES the committed pick of the same
            // class type (same key) — flagging the pair as a conflict would
            // be a false alarm, they'd never coexist.
            if (a.key && a.key === b.key) continue;
            // Entries pending removal vanish on commit — overlapping them
            // is not a conflict either.
            if (a.pendingRemoval || b.pendingRemoval) continue;
            if (sessionsOverlap(a, b)) {
              conflicts.add(a.pickKey);
              conflicts.add(b.pickKey);
            }
          }
        }
      });

      // Which candidate groups would collide with the schedule as it
      // stands. Picks pending removal are exempt (the student is already
      // re-choosing there). Same-key entries are NOT exempt anymore: a
      // different group of the same class type replaces the current choice,
      // but the overlap has to stay visible so the two terms can be
      // compared — the candidate just gets a "replaces" note instead of the
      // generic warning. Purely candidate-vs-candidate overlap never
      // counts: parallel groups sharing one slot are the normal case.
      // Covered saved entries are collected too: a saved block overlapped
      // by previewed groups carries the list on its risk dot.
      const riskyGids = new Set();
      Object.values(byDay).forEach((list) => {
        list.forEach((c) => {
          // "Current" hybrids are display duplicates of their solid twin —
          // neither a risk themselves nor a reason to flag others.
          if (!c.candidate || c.current) return;
          list.forEach((r) => {
            if (r.candidate || r.pendingRemoval || r.draft) return;
            if (!sessionsOverlap(c, r)) return;
            riskyGids.add(c.candGroup);
            if (r.key === c.key) c.replaceNr = r.nr;
            r.coveredBy.push({ nr: c.candRef.nr, type: c.classTypeShort, sameKey: r.key === c.key });
          });
        });
      });

      const dayGroups = DAY_KEYS.map((dk) => ({ day: dk, entries: byDay[dk] || [] })).filter((d) => d.entries.length);
      // Side-by-side lanes shared by EVERYTHING on one day — saved, draft,
      // struck-through AND candidate ghosts in a single lane set, so two
      // terms in one slot render left/right instead of painting over each
      // other. Greedy interval partitioning per overlap group (connected
      // by any time overlap — same idea as planWeekGridLayout, but with a
      // per-group laneCount so a lone entry keeps full width). Insertion
      // order decides ties: committed picks first, then drafts, then
      // candidates — so the old term lands left, the replacement right.
      // Visual only; conflicts/risks above are untouched.
      Object.values(byDay).forEach((list) => {
        const sorted = [...list].sort((a, b) => (toMin(a.start) ?? Infinity) - (toMin(b.start) ?? Infinity) || (toMin(a.end) ?? Infinity) - (toMin(b.end) ?? Infinity));
        const groups = [];
        let cur = [];
        sorted.forEach((e) => {
          const s = toMin(e.start);
          if (cur.length && !cur.some((a) => toMin(a.end) > s)) { groups.push(cur); cur = []; }
          cur.push(e);
        });
        if (cur.length) groups.push(cur);
        groups.forEach((g) => {
          const laneEnds = [];
          g.forEach((e) => {
            const s = toMin(e.start);
            let lane = laneEnds.findIndex((end) => end !== null && s !== null && s >= end);
            if (lane === -1) { lane = laneEnds.length; laneEnds.push(null); }
            laneEnds[lane] = toMin(e.end);
            e.lane = lane;
          });
          g.forEach((e) => { e.laneCount = laneEnds.length; });
        });
      });
      const conflictInvolvesDraft = flat.some((e) => e.draft && conflicts.has(e.pickKey));

      return `
        ${conflicts.size ? `<div style="font-size:12px;font-weight:600;color:oklch(55% 0.19 25);margin-bottom:10px;">⚠ Wybrane zajęcia nakładają się w czasie — zaznaczone poniżej.${conflictInvolvesDraft ? ' (w tym Twój niezapisany wybór)' : ''}</div>` : ''}
        ${skippedNoTime ? `<div style="font-size:12px;color:var(--ink-3);margin-bottom:10px;">Pominięto ${skippedNoTime} ${skippedNoTime === 1 ? 'termin' : skippedNoTime % 10 >= 2 && skippedNoTime % 10 <= 4 && (skippedNoTime % 100 < 12 || skippedNoTime % 100 > 14) ? 'terminy' : 'terminów'} bez podanych godzin — nie pokazano ${skippedNoTime === 1 ? 'go' : 'ich'} na siatce.</div>` : ''}
        ${filteredNotesHtml}
        <div class="usospp-timetable" data-planner-grid>
          <div class="usospp-tt-hours" style="height:${totalHeight}px;">
            ${hours.map((h) => `<div class="usospp-tt-hour" style="top:${(h - hourStart) * ROW_H}px;">${h}:00</div>`).join('')}
          </div>
          <div class="usospp-tt-days">
            ${dayGroups.map((d) => `
              <div class="usospp-tt-daycol">
                <div class="usospp-tt-daylabel">${esc(d.day)}</div>
                <div class="usospp-tt-daybody" style="height:${totalHeight}px;background-size:100% ${ROW_H}px;">
                  ${this.renderPlannerCandDay(d.entries.filter((e) => e.candidate), hourStart, dark, riskyGids)}
                  ${d.entries.filter((e) => !e.candidate).map((e) => {
                    const startMin = toMin(e.start);
                    const endMin = toMin(e.end);
                    const top = (startMin - hourStart * 60) * (ROW_H / 60);
                    const height = Math.max(36, (endMin - startMin) * (ROW_H / 60));
                    const color = subjectColor(e.seed, dark);
                    const conflict = conflicts.has(e.pickKey);
                    const removeColor = 'oklch(55% 0.19 25)';
                    const weeksTag = weeksLabel(e.weeks);
                    // Direction A badge: seat state of this exact group in
                    // its tour (see plannerCheckRejSeats). Drafts have no
                    // committed group yet, so they never carry one. Badges
                    // (and counters) render only in Zapisy mode — Planowanie
                    // keeps clean blocks; the data stays cached underneath.
                    const badge = (this.state.plannerZapisyMode && !e.draft && e.key) ? (this.state.plannerRejBadges || {})[e.key] : null;
                    const rejLinked = !!(badge && badge.groupsUrl);
                    const rejClass = badge && badge.known ? (badge.full ? ' usospp-tt-entry--rej-full' : ' usospp-tt-entry--rej-ok') : '';
                    const rejClickHint = this.state.plannerZapisyMode ? ' — kliknij, aby pokazać wolne terminy' : '';
                    const rejTitle = rejLinked
                      ? ` — zapisy (${badge.tourKey}): ${badge.enrollment === 'registered' ? 'jesteś zapisany na przedmiot; ' : ''}${badge.seatsText ? `grupa ${badge.nr}: ${badge.full ? 'brak miejsc' : `zajęte ${badge.taken} z ${badge.cap}`}${rejClickHint}` : `grupy${rejClickHint}`}`
                      : '';
                    // A saved block whose class type is currently previewed
                    // gets the half-ghost mark (dashed outline, no layout
                    // shift): it reads as current AND as part of the set.
                    // (The hybrid ghost underneath is painted over by design,
                    // so the outline has to live on this block to be seen.)
                    const previewedType = !!(e.key && !e.draft && this.state.plannerPreviewKeys[e.key]);
                    const full = [e.subjectName, e.teacher, e.place].filter(Boolean).join(' — ')
                      + (weeksTag ? ` — co drugi tydzień (${e.weeks === 'even' ? 'parzyste' : 'nieparzyste'})` : '')
                      + (e.draft ? ' (jeszcze niedodane)' : e.pendingRemoval ? ' (zostanie usunięte po zapisaniu)' : e.willBeReplaced ? ` (zostanie zastąpione grupą ${e.replacedByNr} po zapisaniu)` : '')
                      + rejTitle + (previewedType ? ' — ten typ jest podglądany' : '');
                    const coveredBy = e.coveredBy || [];
                    const coveredTitle = coveredBy.length
                      ? `Podglądane grupy na ten termin: ${coveredBy.map((c) => `gr. ${c.nr}${c.sameKey ? ' (zastąpi obecną)' : ''}`).join(', ')}`
                      : '';
                    // NOTE: the lane suffix must apply to EVERY branch —
                    // parenthesize the whole ternary (`+` binds tighter
                    // than `?:`, otherwise only the solid branch gets it
                    // and draft/struck blocks stay full-width over lanes).
                    const entryStyle = (e.draft
                      ? `background:transparent;border:2px dashed ${color.time};opacity:0.85;`
                      : e.pendingRemoval
                        ? `background:transparent;border:2px dashed ${removeColor};opacity:0.55;`
                        : e.willBeReplaced
                          ? `background:transparent;border:2px dashed ${color.time};opacity:0.6;`
                          : `background:${color.bg};${previewedType ? `outline:2px dashed ${color.time};outline-offset:-2px;` : ''}`)
                      // Lane geometry (see the per-day assignment above):
                      // shared by both click-action branches below, since
                      // both compose their style from entryStyle.
                      + plannerLaneStyle(e.lane || 0, e.laneCount || 1);
                    const struck = e.pendingRemoval || e.willBeReplaced;
                    const labelStyle = `color:${e.pendingRemoval ? removeColor : color.label};${struck ? 'text-decoration:line-through;' : ''}`;
                    // Struck-through blocks (a committed pick shadowed by a
                    // diverging draft or pending removal) revert the decision
                    // on click instead of focusing/toggling ghosts — see
                    // plannerRevertDraft. Everything else keeps the
                    // focus+toggle behaviour below.
                    const { attr: rejAction, note: focusNote } = (struck && e.key)
                      ? {
                          attr: ` data-action="plannerRevertDraft" data-key="${esc(e.key)}" style="top:${top}px;height:${height}px;${entryStyle}cursor:pointer;"`,
                          note: ' — kliknij, aby cofnąć zmianę',
                        }
                      : this.plannerGridBlockAction({
                        top, height, entryStyle, key: e.key, subjectUrl: e.subjectUrl,
                      });
                    const rejBadgeHtml = rejLinked
                      ? ` <span class="usospp-tt-entry-rej${badge.full ? ' full' : ''}">${badge.enrollment === 'registered' ? '✓ ' : ''}${esc(badge.seatsText || 'zapisy')}</span>`
                      : '';
                    return `
                      <div class="usospp-tt-entry${conflict ? ' usospp-tt-entry--conflict' : ''}${rejClass}"${rejAction} title="${esc(full + (coveredTitle ? ` — ${coveredTitle}` : '') + focusNote)}">
                        <div class="usospp-tt-entry-time" style="color:${e.pendingRemoval ? removeColor : color.time};">${esc(e.start)}–${esc(e.end)}${weeksTag ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:9.5px;padding:1px 5px;">${weeksTag}</span>` : ''}${rejBadgeHtml}${coveredTitle ? ` <span class="usospp-cand-risk-dot" title="${esc(coveredTitle)}"></span>` : ''}</div>
                        <div class="usospp-tt-entry-label" style="${labelStyle}">${esc(e.classTypeShort)} · ${esc(e.subjectName)}${e.willBeReplaced ? ` → gr. ${esc(e.replacedByNr)}` : ''}</div>
                        ${e.teacher ? `<div class="usospp-tt-entry-meta" style="color:${e.pendingRemoval ? removeColor : color.meta};">${esc(e.teacher)}</div>` : ''}
                        ${e.place ? `<div class="usospp-tt-entry-meta" style="color:${e.pendingRemoval ? removeColor : color.meta};">${esc(shortPlace(e.place))}</div>` : ''}
                      </div>
                    `;
                  }).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Candidate ghosts for one day column of the preview grid — entries
    // from previewed class types ("podgląd w planie"). Every group renders
    // as its own directly-clickable box on its side-by-side lane (lanes
    // assigned over the whole day in renderPlannerGrid, shared with saved,
    // draft and struck blocks) — no "N grup" clusters, no hover popovers.
    renderPlannerCandDay(candEntries, hourStart, dark, riskyGids) {
      if (!candEntries.length) return '';
      const ROW_H = 60;
      return candEntries.map((e) => {
        const top = (toMin(e.start) - hourStart * 60) * (ROW_H / 60);
        const height = Math.max(36, (toMin(e.end) - toMin(e.start)) * (ROW_H / 60));
        // "Current" hybrids (the already-committed group of a previewed
        // type) render as standalone boxes so the chosen term stays
        // identifiable among the proposal ghosts.
        if (e.current) return this.renderPlannerCurrentBox(e, { top, height, dark });
        return this.renderPlannerCandBox(e, { top, height, dark, risky: riskyGids.has(e.candGroup) });
      }).join('');
    }

    // The hybrid "current" ghost: the already-committed group of a
    // previewed class type. Half solid (subject colour fill, full label —
    // this term IS in the plan) and half preview (dashed outline, lighter
    // than a saved block) so it reads as "this subject, currently chosen"
    // among the proposal ghosts. Deliberately not clickable (no
    // data-action): clicking would only be able to un-pick it, which is
    // what the list's radio rows are for.
    renderPlannerCurrentBox(e, { top, height, dark }) {
      const color = subjectColor(e.seed, dark);
      const weeksTag = weeksLabel(e.weeks);
      const full = `${e.subjectName} — ${e.candRef.classTypeLabel} — grupa ${e.candRef.nr}`
        + (e.teacher ? ` — ${e.teacher}` : '')
        + (e.place ? ` — ${e.place}` : '')
        + (weeksTag ? ` — co drugi tydzień (${e.weeks === 'even' ? 'parzyste' : 'nieparzyste'})` : '')
        + ' — obecnie wybrana grupa, ten termin jest w planie';
      return `
        <div class="usospp-tt-entry usospp-cand-current"
             style="top:${top}px;height:${height}px;background:${color.bg};border:2px dashed ${color.time};opacity:0.9;${plannerLaneStyle(e.lane || 0, e.laneCount || 1)}"
             title="${esc(full)}">
          <div class="usospp-tt-entry-time" style="color:${color.time};">${esc(e.start)}–${esc(e.end)}${weeksTag ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:9.5px;padding:1px 5px;">${weeksTag}</span>` : ''}</div>
          <div class="usospp-tt-entry-label" style="color:${color.label};">${esc(e.classTypeShort)} · grupa ${esc(e.candRef.nr)} · teraz</div>
          ${e.teacher ? `<div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(e.teacher)}</div>` : ''}
        </div>
      `;
    }

    // One candidate group's ghost box. Same visual family as a draft ghost
    // (dashed, subject colour) but visibly lighter — a "maybe", not a
    // choice. Clicking runs the very same plannerSelectGroup the radio rows
    // in the subject list use, so a group picked from the grid is
    // indistinguishable from one picked from the list afterwards. Every
    // group has its own box on its side-by-side lane — no hover popovers.
    renderPlannerCandBox(e, { top, height, dark, risky }) {
      const color = subjectColor(e.seed, dark);
      const weeksTag = weeksLabel(e.weeks);
      // Zapisy mode dims preview ghosts of confirmed-full groups (same
      // cached tour data as the subject list) so the eye lands on free ones.
      // The N/M counter shows whenever known — but, like dimming and
      // filtering, only in Zapisy mode: Planowanie ghosts stay clean
      // (no seat info at all). Auto-mode map wins when it has the group,
      // to avoid double tags.
      const zapSeats = this.state.plannerZapisyMode
        ? this.plannerCandSeats(e.subjectName, e.candRef.classTypeLabel, e.candRef.nr, e.subjectUrl, [e])
        : null;
      const dimFull = !!(zapSeats && zapSeats.known && zapSeats.full);
      const autoTag = this.seatTagHtml(e.candRef.key, e.candRef.classTypeLabel, e.candRef.nr);
      const seatsTag = (!autoTag && zapSeats && zapSeats.known && !zapSeats.full && zapSeats.seatsText)
        ? ` <span class="usospp-tt-entry-rej">${esc(zapSeats.seatsText)}</span>` : '';
      const riskyNote = risky
        ? (e.replaceNr ? ` — nachodzi na obecny termin (gr. ${e.replaceNr}) — wybór go zastąpi` : ' — nachodzi na zajęcia już wybrane w planie')
        : '';
      const full = `${e.subjectName} — ${e.candRef.classTypeLabel} — grupa ${e.candRef.nr}`
        + (e.teacher ? ` — ${e.teacher}` : '')
        + (e.place ? ` — ${e.place}` : '')
        + (weeksTag ? ` — co drugi tydzień (${e.weeks === 'even' ? 'parzyste' : 'nieparzyste'})` : '')
        + riskyNote
        + ' — propozycja, kliknij, aby wybrać';
      return `
        <div class="usospp-tt-entry usospp-tt-entry--cand${risky ? ' usospp-cand-risk' : ''}" data-action="plannerSelectGroup"
             data-key="${esc(e.candRef.key)}" data-groups-url="${esc(e.candRef.groupsUrl)}"
             data-nr="${esc(e.candRef.nr)}" data-class-type-label="${esc(e.candRef.classTypeLabel)}"
              style="top:${top}px;height:${height}px;border:2px dashed ${color.time};background:${color.bg};opacity:${dimFull ? '0.3' : '0.55'};${plannerLaneStyle(e.lane || 0, e.laneCount || 1)}"
              title="${esc(full)}">
           <div class="usospp-tt-entry-time" style="color:${color.time};">${esc(e.start)}–${esc(e.end)}${weeksTag ? ` <span class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);font-size:9.5px;padding:1px 5px;">${weeksTag}</span>` : ''}</div>
            <div class="usospp-tt-entry-label" style="color:${color.label};">${esc(e.classTypeShort)} · grupa ${esc(e.candRef.nr)}${risky ? ' ⚠' : ''}${autoTag}${dimFull ? ' <span class="usospp-tt-entry-rej full">pełna</span>' : ''}${seatsTag}</div>
          ${e.teacher ? `<div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(e.teacher)}</div>` : ''}
          ${e.place ? `<div class="usospp-tt-entry-meta" style="color:${color.meta};">${esc(shortPlace(e.place))}</div>` : ''}
        </div>
      `;
    }

    renderEgzaminy() {
      const exams = this.exams;
      const ex = this.data.examsResult || {};
      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Egzaminy</div>
              <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dla_stud/rejestracja/egzaminy&usospp_off=1">Otwórz zapisy w USOS →</button>
            </div>
            ${!ex.supported ? `
              <div class="usospp-empty-hint">Brak zaplanowanych egzaminów albo moduł zapisów jeszcze się nie wczytał — sprawdź w klasycznym USOS.</div>
            ` : `
              <div class="usospp-raw-dump">${esc(JSON.stringify(exams, null, 2))}</div>
            `}
          </div>
        </div>
      `;
    }

    // Tone badge for a classic "spełnione / niespełnione" requirement
    // status; unknown statuses fall back to the plain gray badge.
    etapStatusBadge(status) {
      if (status === 'spełnione') return `<div class="usospp-badge usospp-badge-positive">${esc(status)}</div>`;
      if (status === 'niespełnione') return `<div class="usospp-badge usospp-badge-negative">${esc(status)}</div>`;
      return `<div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);">${esc(status || '—')}</div>`;
    }

    // One stage card: the list-page header row plus, once the lazy
    // per-stage details arrive (see fetchEtapDetailsResult), the point
    // totals, conditional/full requirements, what's missing and a
    // collapsible subject-requirements list. Without details it degrades
    // to the plain header row it always was.
    renderEtapCard(e) {
      const details = (e.detailsId && this.etapDetails[e.detailsId]) || null;
      const detailsLoading = e.detailsId && !details && !this.data.etapDetailsResultLoaded;
      let body = '';
      if (details) {
        const p = details.punkty || {};
        const sumParts = [
          p.zEtapu !== null && p.zEtapu !== undefined ? `z etapu ${esc(p.zEtapu)}` : null,
          p.zPoprzednich !== null && p.zPoprzednich !== undefined ? `z poprzednich ${esc(p.zPoprzednich)}` : null,
        ].filter(Boolean);
        const reqLine = (label, req) => req ? `
          <div style="font-size:12.5px;margin-top:4px;">${esc(label)}: wymagane <strong>${esc(req.wymagane || '—')}</strong> ${req.status ? `— ${esc(req.status)}` : ''}</div>` : '';
        const missingLine = (label, items) => items.length ? `
          <div style="font-size:12.5px;margin-top:4px;">${esc(label)}: ${items.map((i) => esc(i)).join('; ')}</div>` : '';
        const reqs = Array.isArray(details.wymagania) ? details.wymagania : [];
        const pod = details.podsumowanie || {};
        body = `
          <div style="font-size:12.5px;margin-top:8px;">Punkty: <strong>${esc(p.razem ?? '—')}</strong>${sumParts.length ? ` (${sumParts.join(' + ')})` : ''}</div>
          ${reqLine('Zaliczenie warunkowe', p.warunkowe)}
          ${reqLine('Zaliczenie pełne', p.pelne)}
          ${missingLine('Do warunkowego brakuje', pod.brakujeWarunkowe || [])}
          ${missingLine('Do pełnego brakuje', pod.brakujePelne || [])}
          ${reqs.length ? `
          <details class="usospp-disclosure">
            <summary>Wymagania przedmiotowe (${reqs.length})</summary>
            <div class="usospp-disclosure-list">
              ${reqs.map((r) => `
              <div class="usospp-disclosure-row">
                <div><span class="usospp-disclosure-row-label">${esc(r.nazwa || '—')}</span>${r.kod ? `<span class="usospp-disclosure-row-range"> [${esc(r.kod)}]</span>` : ''}${r.podpiecie ? `<div style="font-size:12px;color:var(--ink-3);">Podpięcie: ${esc(r.podpiecie)}</div>` : ''}</div>
                ${this.etapStatusBadge(r.status)}
              </div>`).join('')}
            </div>
          </details>` : ''}`;
      } else if (detailsLoading) {
        body = `<div class="usospp-empty-hint" style="margin-top:8px;">Dociąganie szczegółów etapu…</div>`;
      }
      return `
        <div class="usospp-list-row" style="align-items:flex-start;flex-direction:column;">
          <div style="display:flex;justify-content:space-between;gap:10px;width:100%;align-items:baseline;">
            <div>
              <div style="font-size:14px;font-weight:600;">${esc(e.label)}</div>
              <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(e.programLabel)}</div>
              <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">Cykl: ${esc(e.cycle || '—')} · koniec: ${esc(e.endDate || '—')}</div>
            </div>
            <div class="usospp-badge" style="background:var(--bg-subtle);color:var(--ink-2);flex-shrink:0;">${esc(e.status || '—')}</div>
          </div>
          ${body}
        </div>`;
    }

    // Programme settlement state, grouped per programme (classic USOS shows
    // it in each programme frame's footer). Read-only here: the actual
    // "Zgłoś program do rozliczenia" action (confirm dialog + POST) stays
    // in classic USOS behind the deep link.
    renderRozliczenie() {
      const seen = new Map();
      this.etapy.forEach((e) => {
        if (e && e.programLabel && e.rozliczenie && !seen.has(e.programLabel)) {
          seen.set(e.programLabel, e.rozliczenie);
        }
      });
      if (!seen.size) return '';
      const rozliczenieUrl = `${location.origin}/kontroler.php?_action=dla_stud/studia/zaliczenia/index&usospp_off=1`;
      return `
        <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px;">
          ${[...seen].map(([program, r]) => `
          <div style="margin-bottom:10px;">
            <div style="font-size:13px;">Rozliczenie programu: <strong>${esc(r.stan || '—')}</strong></div>
            ${r.podpowiedz ? `<div class="usospp-muted-text" style="font-size:12px;margin-top:2px;">${esc(r.podpowiedz)}</div>` : ''}
            ${r.doZgloszenia ? `<button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(rozliczenieUrl)}" style="margin-top:8px;">Zgłoś program do rozliczenia w USOS →</button>` : ''}
            <div style="font-size:12px;color:var(--ink-3);margin-top:4px;">${esc(program)}</div>
          </div>`).join('')}
        </div>`;
    }

    renderEcts() {
      const etapy = this.etapy;
      const s = this.state;
      const avgNum = parseFloat((s.calcAvg || '').replace(',', '.'));
      const ectsNum = parseFloat((s.calcEcts || '').replace(',', '.'));
      const newGrade = parseFloat(s.calcGrade);
      const newEcts = parseFloat(s.calcNewEcts);
      const canProject = !Number.isNaN(avgNum) && !Number.isNaN(ectsNum) && ectsNum > 0;
      const projected = canProject ? ((avgNum * ectsNum + newGrade * newEcts) / (ectsNum + newEcts)).toFixed(2) : null;

      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-head">
              <div class="usospp-card-title">Zaliczenia etapów</div>
              <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dla_stud/studia/zaliczenia/index&usospp_off=1">Otwórz w USOS →</button>
            </div>
            ${etapy.length === 0 ? `<div class="usospp-empty-hint">Brak danych o etapach studiów.</div>` : etapy.map((e) => this.renderEtapCard(e)).join('')}
            ${this.renderRozliczenie()}
          </div>

          <div class="usospp-card">
            <div class="usospp-card-title">Kalkulator średniej</div>
            <div class="usospp-muted-text" style="margin-bottom:16px;">Podaj swoją obecną średnią i sumę ECTS (nie odczytujemy tego jeszcze automatycznie z USOS), żeby sprawdzić, jak wpłynie kolejna ocena.</div>
            <div class="usospp-calc-grid">
              <div>
                <label class="usospp-field-label">Obecna średnia</label>
                <input class="usospp-input" placeholder="np. 4.20" value="${esc(s.calcAvg)}" data-bind="calcAvg">
              </div>
              <div>
                <label class="usospp-field-label">Suma zaliczonych ECTS</label>
                <input class="usospp-input" placeholder="np. 90" value="${esc(s.calcEcts)}" data-bind="calcEcts">
              </div>
              <div>
                <label class="usospp-field-label">Spodziewana ocena</label>
                <select class="usospp-input" data-bind="calcGrade">
                  ${['5.0', '4.5', '4.0', '3.5', '3.0'].map((g) => `<option value="${g}" ${s.calcGrade === g ? 'selected' : ''}>${g}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="usospp-field-label">ECTS przedmiotu</label>
                <select class="usospp-input" data-bind="calcNewEcts">
                  ${['3', '4', '5', '6'].map((n) => `<option value="${n}" ${s.calcNewEcts === n ? 'selected' : ''}>${n}</option>`).join('')}
                </select>
              </div>
              <div class="usospp-calc-result">
                <div style="font-size:11px;color:var(--ink-3);font-weight:600;">nowa średnia</div>
                <div style="font-size:20px;font-weight:700;color:oklch(58% 0.15 45);">${projected || '—'}</div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // USOS spreads this across a hub + 5 sub-pages (należności nierozliczone
    // / rozliczone, plany ratalne, wpłaty wszystkie / nierozliczone) plus a
    // separate "konta bankowe" page under a different module entirely — see
    // scraping.js's PATHS.platnosci* comment for why "rozliczone" specifically
    // is folded away rather than shown as its own section here.
    renderPlatnosci() {
      const p = this.data.paymentsResult || {};
      const unpaid = p.unpaid || { groups: [] };
      const installments = p.installments || { groups: [] };
      const payments = p.payments || { groups: [] };
      const unsettled = p.unsettledPayments || { groups: [] };
      const accounts = (p.bankAccounts && p.bankAccounts.accounts) || [];

      return `
        <div class="usospp-view">
          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:14px;">Do zapłaty</div>
            ${installments.groups.length ? `
              <div class="usospp-notice">
                <span>Masz należności czekające na wybór planu ratalnego.</span>
                <a data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dodatki/platnosci/planyRatalne&usospp_off=1">Wybierz w USOS →</a>
              </div>
            ` : ''}
            ${unpaid.groups.length === 0 ? `
              <div class="usospp-empty-hint">Brak nierozliczonych należności — wszystko opłacone</div>
            ` : unpaid.groups.map(renderPaymentGroup).join('')}
            ${unpaid.grandTotal ? `<div style="font-size:12.5px;font-weight:600;text-align:right;">${esc(unpaid.grandTotal)}</div>` : ''}
          </div>

          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:14px;">Historia wpłat</div>
            ${unsettled.groups.length ? `
              <div class="usospp-notice">
                <span>Część wpłat nie została jeszcze w pełni rozliczona z należnościami.</span>
                <a data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dodatki/platnosci/wplatyNierozliczone&usospp_off=1">Otwórz w USOS →</a>
              </div>
            ` : ''}
            ${payments.groups.length === 0 ? `
              <div class="usospp-empty-hint">Brak zarejestrowanych wpłat.</div>
            ` : payments.groups.map(renderPaymentGroup).join('')}
            ${payments.grandTotal ? `<div style="font-size:12.5px;font-weight:600;text-align:right;">${esc(payments.grandTotal)}</div>` : ''}
          </div>

          <div class="usospp-card">
            <div class="usospp-card-title" style="margin-bottom:14px;">Konta bankowe do wpłat</div>
            ${accounts.length === 0 ? `
              <div class="usospp-empty-hint">Nie udało się odczytać numerów kont z USOS.</div>
            ` : accounts.map((a) => `
              <div class="usospp-list-row" style="align-items:flex-start;">
                <div>
                  <div style="font-size:13.5px;font-weight:600;">${esc(a.label)}</div>
                  <div style="font-size:13px;font-family:ui-monospace,monospace;margin-top:4px;">${esc(a.number)}</div>
                  <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(a.bankName || '—')}${a.currency ? ` · ${esc(a.currency)}` : ''}</div>
                </div>
                ${a.blankietUrl && isSafeOpenUrl(a.blankietUrl) ? `<a href="${esc(a.blankietUrl)}" target="_blank" rel="noopener" style="font-size:12.5px;font-weight:600;color:#d9773a;white-space:nowrap;flex-shrink:0;">blankiet →</a>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Shared shell for the four small "Moje studia" list pages — each is
    // just adapter.genericInfoTable's rows in one card, or an empty hint.
    renderInfoTableView(result, emptyText) {
      const rows = (result && Array.isArray(result.rows)) ? result.rows : [];
      return `
        <div class="usospp-view">
          <div class="usospp-card">
            ${rows.length === 0
              ? `<div class="usospp-empty-hint">${esc(emptyText)}</div>`
              : rows.map(renderInfoTableRow).join('')}
          </div>
        </div>
      `;
    }

    renderStypendia() {
      return this.renderInfoTableView(this.data.scholarshipsResult, 'Brak informacji o otrzymywanych stypendiach.');
    }

    renderSprawdziany() {
      return this.renderInfoTableView(this.data.testsResult, 'Nie jesteś zapisany na żadne zajęcia lub żaden z prowadzących nie zdefiniował elektronicznych zasad rozliczania swojego przedmiotu.');
    }

    renderPodania() {
      return this.renderInfoTableView(this.data.petitionsResult, 'Brak złożonych podań.');
    }

    renderAnkiety() {
      return this.renderInfoTableView(this.data.surveysResult, 'Brak ankiet do wypełnienia.');
    }

    // Manual "Sprawdź status" on the mLegitymacja view — same lazy pattern
    // as newsRetry: flip a loading flag (the card shows "Ładowanie…"),
    // re-fetch just this page (the same GET the classic "Sprawdź status
    // zamówienia" form sends), store it back and re-render. On failure
    // the previous result stays, so the card simply comes back.
    async mlegitymacjaRefresh() {
      if (this.state.mlegitymacjaRefreshing) return;
      this.setState({ mlegitymacjaRefreshing: true, mlegQrRevealed: false });
      const scrape = window.USOSPP_SCRAPE;
      const adapters = window.USOSPP_ADAPTERS;
      try {
        const adapter = adapters ? adapters.selectAdapter() : null;
        if (!scrape || !adapter || !scrape.fetchMlegitymacjaResult) throw new Error('no scraper');
        this.data.mlegitymacjaResult = await scrape.fetchMlegitymacjaResult(adapter, this.data, true);
      } catch (e) {
        // keep the previous result — the card stays
      }
      this.setState({ mlegitymacjaRefreshing: false });
    }

    // Copy-to-clipboard for the mLegitymacja pickup codes — direct DOM
    // feedback on the button, deliberately no re-render so the drawn QR
    // canvas underneath is left untouched.
    mlegCopy(el) {
      const text = (el && el.dataset && el.dataset.copy) || '';
      if (!text) return;
      const done = () => {
        const orig = el.innerHTML;
        el.textContent = 'Skopiowano ✓';
        setTimeout(() => { if (el.isConnected) el.innerHTML = orig; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => this.mlegCopyFallback(text, done));
      } else {
        this.mlegCopyFallback(text, done);
      }
    }
    mlegCopyFallback(text, done) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (e) { /* clipboard unavailable — the code stays selectable by hand */ }
    }

    // Post-render hook for the mLegitymacja "Do odbioru" QR (called from
    // render(), same slot as mountMapaIfNeeded): draws the scraped
    // qrText into [data-mleg-qr], lazy-loading vendor/qrcode on first
    // use. Every render() rebuilds the DOM from scratch, so a stale
    // canvas can never survive — same teardown discipline as the map.
    drawMlegQrIfNeeded() {
      if (this.state.view !== 'mlegitymacja') return;
      const canvas = this.root.querySelector('[data-mleg-qr]');
      if (!canvas) return; // pickup codes missing / lib-load error state shown instead
      const r = this.data.mlegitymacjaResult;
      const code = r && r.qrText;
      if (!code) return;
      if (canvas.dataset.drawnFor === code) return;
      if (!window.qrcode) {
        const loader = window.USOSPP_QRCODE;
        if (loader && !this._mlegQrLoading) {
          this._mlegQrLoading = true;
          loader.ensureQrCode().then(() => {
            this._mlegQrLoading = false;
            if (this.state.view === 'mlegitymacja') this.drawMlegQrIfNeeded();
          }).catch(() => {
            this._mlegQrLoading = false;
            this.state.mlegQrError = true;
            if (this.state.view === 'mlegitymacja') this.render();
          });
        }
        return;
      }
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(code);
        qr.make();
        const n = qr.getModuleCount();
        const quiet = 4, scale = 6;
        const size = (n + quiet * 2) * scale;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // quiet zone stays white in dark mode too — scanners need the contrast
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#000000';
        for (let row = 0; row < n; row++) {
          for (let col = 0; col < n; col++) {
            if (qr.isDark(row, col)) ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
          }
        }
        canvas.dataset.drawnFor = code;
      } catch (e) {
        this.state.mlegQrError = true;
        if (this.state.view === 'mlegitymacja') this.render();
      }
    }

    // mLegitymacja (Moje studia) — read-only order status. Writes stay in
    // classic USOS by project policy: ordering, cancelling and revoking
    // are link-outs, the panel only reads status + dates + pickup codes
    // (the "Do odbioru" QR is re-rendered in-panel from the scraped text
    // via vendor/qrcode — see drawMlegQrIfNeeded).
    renderMlegitymacja() {
      // Canonical view header, same as Plan/Oceny/Egzaminy: title +
      // status badge on the left, ghost "Otwórz w USOS →" top-right.
      // The URL hardcodes &usospp_off=1 like every other call-site.
      const head = (title, status) => `
        <div class="usospp-card-head">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <div class="usospp-card-title">${esc(title)}</div>
            ${mlegStatusBadge(status)}
          </div>
          <button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dla_stud/studia/mlegitymacja/index&usospp_off=1">Otwórz w USOS →</button>
        </div>
      `;
      const dates = (r) => {
        const parts = [];
        if (r.orderDate) parts.push(`Data zamówienia: ${esc(formatMlegDate(r.orderDate))}`);
        if (r.validUntil) parts.push(`Ważność do: ${esc(formatMlegDate(r.validUntil))}`);
        return parts.length ? `<div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${parts.join(' · ')}</div>` : '';
      };
      const actions = (buttons) => `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">${buttons}</div>`;
      const refreshBtn = `<button class="usospp-btn-ghost" data-action="mlegitymacjaRefresh">Sprawdź status</button>`;
      if (this.state.mlegitymacjaRefreshing || !this.data.mlegitymacjaResultLoaded) {
        return `<div class="usospp-view"><div class="usospp-card"><div class="usospp-empty-hint">Ładowanie statusu mLegitymacji…</div></div></div>`;
      }
      const r = this.data.mlegitymacjaResult;
      if (!r || !r.supported) {
        return `<div class="usospp-view"><div class="usospp-card">${head('mLegitymacja')}<div class="usospp-empty-hint">Nie udało się odczytać statusu mLegitymacji.</div>${actions(`<button class="usospp-btn-ghost" data-action="mlegitymacjaRefresh">Spróbuj ponownie</button>`)}</div></div>`;
      }
      if (r.pickupReady) {
        const code = r.qrText, pass = r.qrPass;
        if (!code) {
          // Status says "Do odbioru" but the codes aren't in the markup
          // (yet) — honest fallback instead of a QR of nothing.
          return `
            <div class="usospp-view">
              <div class="usospp-card">
                ${head('mLegitymacja', r.status)}
                <div class="usospp-empty-hint">Twoja mLegitymacja jest gotowa, ale nie udało się odczytać kodów odbioru — zeskanuj kod QR w klasycznym USOS.</div>
                ${actions(refreshBtn)}
              </div>
            </div>
          `;
        }
        // Privacy gate: the QR + activation code are sensitive pickup
        // credentials, so the view opens gated — status and dates stay
        // visible, but the codes (and their canvas) only render after an
        // explicit "Pokaż kod odbioru" click. Nothing secret ever sits in
        // the DOM before that, and leaving/refreshing hides it again.
        if (!this.state.mlegQrRevealed) {
          return `
            <div class="usospp-view">
              <div class="usospp-card">
                ${head('mLegitymacja', r.status)}
                ${dates(r)}
                <div style="font-size:13px;color:var(--ink-2);margin-top:6px;line-height:1.5;">Twoja mLegitymacja jest gotowa do dodania w aplikacji mObywatel.</div>
                <div class="usospp-notice" style="margin-top:12px;"><span>🔒 Kod QR i kod aktywacyjny to Twoje prywatne dane odbioru — pokaż je tylko wtedy, gdy nikt postronny nie patrzy w ekran.</span></div>
                ${actions(`<button class="usospp-btn-ghost" data-action="mlegToggleQr">Pokaż kod odbioru</button>${refreshBtn}`)}
              </div>
            </div>
          `;
        }
        return `
          <div class="usospp-view">
            <div class="usospp-card">
              ${head('mLegitymacja', r.status)}
              <div style="font-size:13px;color:var(--ink-2);margin-top:6px;line-height:1.5;">Uruchom aplikację mObywatel i dodaj nową legitymację, potem zeskanuj kod albo przepisz go razem z kodem aktywacyjnym.</div>
              <div style="display:flex;gap:16px;margin-top:12px;flex-wrap:wrap;align-items:flex-start;">
                <div style="background:#fff;border-radius:12px;padding:10px;line-height:0;flex-shrink:0;">
                  ${this.state.mlegQrError
                    ? `<div style="font-size:12px;color:var(--ink-2);line-height:1.5;">Nie udało się narysować kodu.<br>Otwórz go w USOS.</div>`
                    : `<canvas data-mleg-qr width="222" height="222" style="width:200px;height:200px;border-radius:4px;">${esc(code)}</canvas>`}
                </div>
                <div style="flex:1;min-width:200px;">
                  <div class="usospp-eyebrow" style="margin-bottom:4px;">Kod QR (tekstowo)</div>
                  <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
                    <code style="font-size:12.5px;word-break:break-all;flex:1;font-family:ui-monospace,monospace;">${esc(code)}</code>
                    <button class="usospp-btn-ghost" data-action="mlegCopy" data-copy="${esc(code)}">Kopiuj</button>
                  </div>
                  ${pass ? `
                    <div class="usospp-eyebrow" style="margin:10px 0 4px;">Kod aktywacyjny</div>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
                      <code style="font-size:14px;font-weight:700;flex:1;font-family:ui-monospace,monospace;letter-spacing:0.04em;">${esc(pass)}</code>
                      <button class="usospp-btn-ghost" data-action="mlegCopy" data-copy="${esc(pass)}">Kopiuj</button>
                    </div>
                  ` : ''}
                </div>
              </div>
              ${actions(`<button class="usospp-btn-ghost" data-action="mlegToggleQr">Ukryj kody</button>${refreshBtn}`)}
            </div>
          </div>
        `;
      }
      if (!r.hasOrder) {
        return `
          <div class="usospp-view">
            <div class="usospp-card">
              ${head('mLegitymacja')}
              <div style="font-size:13.5px;font-weight:600;">Nie masz jeszcze zamówienia mLegitymacji</div>
              <div style="font-size:13px;color:var(--ink-2);margin-top:6px;line-height:1.5;">mLegitymacja potwierdza Twoje uprawnienia studenta (studia I, II stopnia i jednolite magisterskie) — do korzystania z niej potrzebna jest aplikacja <strong>mObywatel</strong>.</div>
              <div class="usospp-eyebrow" style="margin:12px 0 6px;">Kto może otrzymać?</div>
              <ul style="font-size:13px;color:var(--ink-2);margin:0;padding-left:18px;line-height:1.6;">
                <li>status studenta studiów I, II st. lub jednolitych magisterskich,</li>
                <li>numer PESEL,</li>
                <li>zdjęcie do legitymacji w systemie USOS,</li>
                <li>numer albumu.</li>
              </ul>
              <div class="usospp-eyebrow" style="margin:12px 0 6px;">Jak zamówić?</div>
              <div style="font-size:13px;color:var(--ink-2);margin-top:4px;line-height:1.5;">Zamówienie składasz w aplikacji Mobilny USOS albo w USOSweb. Jeśli spełniasz kryteria, otrzymasz kod QR (również w wersji tekstowej) i kod aktywacyjny do wpisania w mObywatelu — wydanie kodów trwa zazwyczaj kilka minut.</div>
              ${actions(`<button class="usospp-btn-ghost" data-action="openUsos" data-url="${esc(location.origin)}/kontroler.php?_action=dla_stud/studia/mlegitymacja/index&usospp_off=1">Zamów w USOS →</button>`)}
            </div>
          </div>
        `;
      }
      const info = MLEG_STATUS_INFO.find(([re]) => re.test((r.status || '').trim()));
      return `
        <div class="usospp-view">
          <div class="usospp-card">
            ${head('Zamówienie mLegitymacji', r.status)}
            ${dates(r)}
            ${info ? `<div style="font-size:13px;color:var(--ink-2);margin-top:6px;line-height:1.5;">${esc(info[1])}</div>` : ''}
            ${actions(refreshBtn)}
          </div>
        </div>
      `;
    }

    renderUstawienia() {
      const u = this.data.user || {};
      const f = this.settings.features || {};
      const dark = this.settings.darkMode;
      // Grouped by *when* each feature actually does something — see
      // inject.js's applyIndependentFeatures for the code these describe.
      const featureGroups = [
        {
          label: 'Wymagają włączonego panelu USOS++',
          keys: {
            keyboardNav: ['Nawigacja klawiaturą', 'Skróty 1–9 do przełączania sekcji w USOS++'],
            autorefresh: ['Automatyczne odświeżanie danych', 'Dane odświeżają się bez przeładowania strony'],
            gradeBadge: ['Odznaka średniej na ikonie', 'Aktualizuje się, gdy panel USOS++ jest włączony'],
          },
        },
        {
          label: 'Działają niezależnie od panelu USOS++',
          keys: {
            quickbar: ['Szybkie akcje w toolbarze', 'Widoczne w klasycznym USOS, tylko gdy panel USOS++ jest wyłączony (znikają po włączeniu panelu)'],
            classicWidgets: ['Widżety na stronach klasycznych', 'Średnia w Ocenach, mini „Ten tydzień” w Planie i podsumowanie w Mój USOSweb — tylko gdy panel jest wyłączony; na pustym koncie pokazują stan pusty'],
          },
        },
      ];
      return `
        <div class="usospp-view">
          <div class="usospp-two-col">
            <div style="display:flex;flex-direction:column;gap:20px;">
              <div class="usospp-card">
                <div class="usospp-card-title" style="margin-bottom:18px;">Profil</div>
                <div class="usospp-field-stack">
                  <div>
                    <label class="usospp-field-label">Imię i nazwisko</label>
                    <input class="usospp-input" value="${esc(u.name || '—')}" readonly>
                  </div>
                  <div>
                    <label class="usospp-field-label">Numer albumu</label>
                    <input class="usospp-input" value="${esc(u.album || '—')}" readonly>
                  </div>
                  <div>
                    <label class="usospp-field-label">Jednostka</label>
                    <input class="usospp-input" value="${esc(u.faculty || '—')}" readonly>
                  </div>
                  <div>
                    <label class="usospp-field-label">Kierunek</label>
                    <input class="usospp-input" value="${esc(this.kierunek || '—')}" readonly>
                  </div>
                </div>
              </div>

              <div class="usospp-card">
                <div class="usospp-card-title" style="margin-bottom:6px;">Wygląd</div>
                <div class="usospp-muted-text" style="margin-bottom:16px;">Wybierz jasny lub ciemny motyw interfejsu USOS++.</div>
                <div style="display:flex;gap:10px;">
                  <button class="usospp-mode-btn ${!dark ? 'active' : ''}" data-action="setDark" data-value="false">☀ Jasny</button>
                  <button class="usospp-mode-btn ${dark ? 'active' : ''}" data-action="setDark" data-value="true">☾ Ciemny</button>
                </div>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:20px;">
              ${featureGroups.map((group) => `
                <div class="usospp-card">
                  <div class="usospp-card-title" style="margin-bottom:16px;">${esc(group.label)}</div>
                  <div class="usospp-field-stack">
                    ${Object.keys(group.keys).map((key) => `
                      <div class="usospp-list-row">
                        <div>
                          <div style="font-size:13.5px;font-weight:500;">${esc(group.keys[key][0])}</div>
                          <div style="font-size:12px;color:var(--ink-3);margin-top:2px;">${esc(group.keys[key][1])}</div>
                        </div>
                        <div class="usospp-switch ${f[key] ? 'on' : ''}" data-action="toggleFeature" data-key="${key}"><div class="usospp-switch-knob"></div></div>
                      </div>
                    `).join('')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;
    }

  }

  window.USOSPP_APP = {
    mount(root, data, settings) {
      const app = new App(root, data, settings);
      app.render();
      return app;
    },
  };
})();

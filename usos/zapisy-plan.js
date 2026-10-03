// Bridge between the schedule planner's main plan and the Zapisy
// (registration tour) data — pure matching helpers, no DOM, no fetching.
// Both sides identify a group the same way, just with different field
// names, so every match below reduces to one tuple:
//
//   (prz_kod, class-type label, group nr, day + start + end [+ weeks])
//
// Planner pick (see app.js's plannerAddSubject / pickFromAssignment):
//   { subjectUrl (?prz_kod=), cycleName, classTypeLabel, nr,
//     sessions: [{ day, start, end, weeks }] }
// Zapisy subject (adapters.js's getRejSubjects):
//   { kod (= prz_kod), cycles: [cdyd_kod...], enrollment: { [cdyd]: … } }
// Zapisy group (adapters.js's getRejGroups):
//   sections: [{ type, groups: [{ nr, zapisanych, limitGorny,
//     prowadzacy, session: { day, start, end, weeks } }] }]
//
// Nothing here guesses: nr and normalized (day,start,end) must agree; the
// class-type label only needs to agree after lowercasing + stripping Polish
// diacritics ("Ćwiczenia" vs "cwiczenia"). Weeks parity ('every' | 'odd' |
// 'even', see app.js's weeksLabel P/N convention) confirms when BOTH sides
// know it and disagree otherwise — a one-sided unknown never vetoes.
(function () {
  function przKodFromUrl(url) {
    try { return new URL(url, 'https://web.usos.pwr.edu.pl').searchParams.get('prz_kod'); }
    catch (e) { return null; }
  }

  function normType(label) {
    return (label || '').toLowerCase()
      .replace(/[ąćęłńóśźż]/g, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c] || c))
      .replace(/[^a-z]/g, '');
  }

  function normDay(day) {
    // Canonical day key: planner picks and catalog sessions use either the
    // PN..ND keys or full Polish names ("poniedziałek"), so map both to
    // the same key instead of comparing raw strings ("pn" !==
    // "poniedzialek" would veto every cross-source match).
    const n = normType(day);
    return {
      pn: 'PN', pon: 'PN', poniedzialek: 'PN',
      wt: 'WT', wto: 'WT', wtorek: 'WT',
      sr: 'ŚR', sro: 'ŚR', sroda: 'ŚR',
      czw: 'CZ', cz: 'CZ', czwartek: 'CZ',
      pt: 'PT', pia: 'PT', piatek: 'PT',
      so: 'SO', sob: 'SO', sobota: 'SO',
      nie: 'ND', niedz: 'ND', nd: 'ND', niedziela: 'ND',
    }[n] || n;
  }

  function normTime(t) {
    const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
    if (!m) return null;
    return `${m[1].padStart(2, '0')}:${m[2]}`;
  }

  function sessionsAgree(pickSession, rejSession) {
    if (!pickSession || !rejSession) return false;
    if (normDay(pickSession.day) !== normDay(rejSession.day)) return false;
    if (normTime(pickSession.start) !== normTime(rejSession.start)) return false;
    if (normTime(pickSession.end) !== normTime(rejSession.end)) return false;
    const pw = pickSession.weeks || 'every';
    const rw = rejSession.weeks || 'every';
    // A one-sided 'every'/'unknown' never vetoes; two known parities must agree.
    const known = (w) => w && w !== 'every' && w !== 'unknown';
    if (known(pw) && known(rw) && pw !== rw) return false;
    return true;
  }

  // How full a Zapisy group is. Unknown counts (null) stay unknown —
  // callers render "no data", never "free".
  function groupSeatState(group) {
    const taken = Number.isInteger(group.zapisanych) ? group.zapisanych : null;
    const cap = Number.isInteger(group.limitGorny) ? group.limitGorny : null;
    if (taken === null || cap === null || cap <= 0) {
      return { taken, cap, free: null, full: false, known: false };
    }
    const free = cap - taken;
    return { taken, cap, free, full: free <= 0, known: true };
  }

  // Planner picks of ONE subject (by its prz_kod) against one Zapisy
  // subject record: cycle overlap? personal enrollment state?
  function matchSubject(picks, rejSubject) {
    const kod = rejSubject && rejSubject.kod;
    if (!kod) return null;
    const mine = (picks || []).filter((p) => przKodFromUrl(p.subjectUrl) === kod);
    if (!mine.length) return null;
    const cycles = rejSubject.cycles || [];
    // Personal enrollment across the subject's cycles: 'registered' anywhere
    // wins (that IS the answer "am I enrolled"), then request, then
    // canRegister; unknown when the page showed no affordances.
    const enrollment = rejSubject.enrollment || {};
    const rank = { registered: 3, request: 2, canRegister: 1, unavailable: 0 };
    let best = null;
    let bestCycle = null;
    cycles.forEach((c) => {
      const st = enrollment[c];
      if (st && (best === null || (rank[st] || 0) > (rank[best] || 0))) { best = st; bestCycle = c; }
    });
    return { rejSubject, picks: mine, enrollment: best, enrollmentCycle: bestCycle };
  }

  // One planner pick against a getRejGroups result: every section whose
  // type matches contributes its same-nr group; sessionMatch says whether
  // the times also line up (nr alone can coincide across types). Type
  // matching is exact-first ("cwiczenia" === "cwiczenia"), with a
  // containment fallback for catalog-vs-tour label skew ("cwiczenia
  // audytoryjne" vs "cwiczenia", "laboratorium" vs "laboratoria") — a
  // fallback hit only counts with a confirmed sessionMatch, so a loose
  // label can never promote a wrong-time group. Group nr stays strict.
  function matchPickGroups(pick, rejGroupsResult) {
    const out = [];
    const sections = (rejGroupsResult && rejGroupsResult.sections) || [];
    const wantType = normType(pick.classTypeLabel);
    const wantNr = String(pick.nr);
    sections.forEach((section) => {
      const haveType = normType(section.type);
      const exact = !wantType || haveType === wantType;
      const soft = !exact && wantType && haveType
        && (wantType.includes(haveType) || haveType.includes(wantType));
      if (!exact && !soft) return;
      (section.groups || []).forEach((group) => {
        if (String(group.nr) !== wantNr) return;
        const sessionMatch = (pick.sessions || []).some((s) => sessionsAgree(s, group.session));
        if (soft && !sessionMatch) return;
        out.push({ sectionType: section.type, group, sessionMatch, seats: groupSeatState(group) });
      });
    });
    return out;
  }

  window.USOSPP_ZAPISY_PLAN = {
    przKodFromUrl,
    normType,
    groupSeatState,
    matchSubject,
    matchPickGroups,
  };
})();

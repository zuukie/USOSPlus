// Automatic schedule generator — pure constraint-satisfaction engine, no DOM,
// no scraping, no chrome.* calls. Takes already-fetched subject/group data
// (usos/app.js does the fetching, via the same adapter.getClassGroups shape
// used by the manual planner) and searches for up to 5 ranked, time-feasible
// combinations of one group per (subject, class type).
//
// Model: one CSP variable per {subjectUrl, subjectName, cycleName,
// classTypeLabel, classTypeShort, groups} the caller passes in — `groups` is
// exactly adapter.getClassGroups()'s `groups` array (each with `sessions:
// [{day, start, end, place, weeks}]`, see adapters.js). A variable's domain
// is its groups, filtered down to the ones compatible with the hard
// constraints. Backtracking search (dynamic MRV + forward checking) then
// picks one group per variable such that no two sessions ever collide.
//
// See the plan doc (docs/plan history) for the full design rationale — this
// file is the implementation of theory sections 1-5.
(function () {
  function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }

  // Sessions here always come straight from adapter.getClassGroups(), which
  // normalizes `day` to one of the 7 lowercase Polish day names — no alias
  // handling needed (unlike usos/app.js's shortDay(), which also has to cope
  // with uppercase/abbreviated day labels from other sources). Two sessions
  // on different days never conflict; same day + overlapping time conflict,
  // UNLESS both have known, opposite week parity (one 'odd', one 'even') —
  // those genuinely never land on the same real week.
  function sessionsConflict(a, b) {
    if (a.day !== b.day) return false;
    if ((a.weeks === 'odd' && b.weeks === 'even') || (a.weeks === 'even' && b.weeks === 'odd')) return false;
    return toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);
  }

  // A session with no parsed start/end (malformed/unrecognized "Termin(y)"
  // text) can't be validated against anything — excluded outright rather
  // than treated as conflict-free by default (see adapters.js's getClassGroups
  // comment: an unmatched chunk is already dropped as `null`, but a group
  // can still end up with an empty `sessions` array this way).
  function sessionAllowed(session, hc) {
    if (!session.start || !session.end) return false;
    if (hc.earliestStart && toMin(session.start) < toMin(hc.earliestStart)) return false;
    if (hc.latestEnd && toMin(session.end) > toMin(hc.latestEnd)) return false;
    if (hc.blockedWindows && hc.blockedWindows.some((b) => (
      b.day === session.day && toMin(session.start) < toMin(b.end) && toMin(b.start) < toMin(session.end)
    ))) return false;
    return true;
  }

  // A group is only a valid candidate if EVERY one of its sessions passes —
  // "half a group" (some sessions fine, one blocked) isn't a real option a
  // student could actually pick.
  function buildDomain(groups, hc) {
    return (groups || []).filter((g) => Array.isArray(g.sessions) && g.sessions.length > 0 && g.sessions.every((s) => sessionAllowed(s, hc)));
  }

  // Lower is better. Only ever computed for a COMPLETE, hard-feasible
  // assignment — never used to prune, only to rank the top-5.
  function scoreAssignment(assignment, prefs) {
    const byDay = {};
    assignment.forEach(({ variable, group }) => {
      const varKey = `${variable.subjectUrl}::${variable.classTypeLabel}`;
      group.sessions.forEach((s) => {
        (byDay[s.day] = byDay[s.day] || []).push({ start: s.start, end: s.end, varKey });
      });
    });
    let gapMinutes = 0;
    let overCapBlocks = 0;
    Object.values(byDay).forEach((list) => {
      const sorted = [...list].sort((a, b) => toMin(a.start) - toMin(b.start));
      for (let i = 1; i < sorted.length; i++) {
        const gap = toMin(sorted[i].start) - toMin(sorted[i - 1].end);
        if (gap > 0) gapMinutes += gap;
      }
      // "Zajęcia dziennie" = distinct (subject, classType) blocks that day,
      // not raw session count — two sessions of the same block on
      // alternating weeks still count as one block (confirmed with user).
      const blocks = new Set(list.map((e) => e.varKey)).size;
      if (prefs.maxPerDay && blocks > prefs.maxPerDay) overCapBlocks += (blocks - prefs.maxPerDay);
    });
    const daysUsed = Object.keys(byDay).length;
    const daysPenalty = prefs.preferredDays ? Math.abs(daysUsed - prefs.preferredDays) : 0;

    let score = 0;
    if (prefs.minimizeGaps) score += gapMinutes;
    score += daysPenalty * 60; // one "day off target" ~ as bad as an hour of gaps
    score += overCapBlocks * 120; // exceeding the soft daily cap is the costliest single factor
    return score;
  }

  // Backtracking DFS with dynamic MRV (pick the unassigned variable with the
  // fewest still-valid options first) + forward checking (that option count
  // already excludes anything conflicting with what's assigned so far) —
  // the standard approach for small-to-medium timetabling CSPs. Doesn't stop
  // at the first solution: keeps searching (bounded by `budget`) for up to 5
  // best-scoring complete assignments.
  function searchTopK(vars, prefs, budget) {
    const top = [];
    const state = { nodes: 0, start: Date.now(), exhausted: false };

    function insertCandidate(assignment) {
      const score = scoreAssignment(assignment, prefs);
      top.push({ assignment: assignment.map((a) => ({ ...a })), score });
      top.sort((a, b) => a.score - b.score);
      if (top.length > 5) top.length = 5;
    }

    function recurse(assigned, unassigned, flatSessions) {
      if (state.exhausted) return;
      state.nodes++;
      if (state.nodes > budget.nodeLimit) { state.exhausted = true; return; }
      if (state.nodes % 2000 === 0 && Date.now() - state.start > budget.timeLimitMs) { state.exhausted = true; return; }

      if (!unassigned.length) {
        insertCandidate(assigned);
        return;
      }

      const live = unassigned.map((v) => ({
        variable: v,
        options: v.domain.filter((g) => g.sessions.every((s) => flatSessions.every((fs) => !sessionsConflict(s, fs)))),
      }));
      live.sort((a, b) => a.options.length - b.options.length);
      const chosen = live[0];
      if (!chosen.options.length) return; // dead end — backtrack
      const restVars = live.slice(1).map((l) => l.variable);
      for (const group of chosen.options) {
        if (state.exhausted) return;
        recurse([...assigned, { variable: chosen.variable, group }], restVars, [...flatSessions, ...group.sessions]);
      }
    }

    recurse([], vars, []);
    return top;
  }

  // Same search shape as searchTopK, but stops at the FIRST complete
  // assignment (no ranking, no top-5) — used only by diagnose() below to
  // cheaply answer "does relaxing this one thing make ANY plan possible",
  // not "what's the best plan". Kept as a separate, smaller function rather
  // than parameterizing searchTopK, since bolting an early-exit + no-scoring
  // mode onto the ranked search would obscure both.
  function feasibilityCheck(vars, budget) {
    const state = { nodes: 0, start: Date.now(), exhausted: false, found: false };
    function recurse(unassigned, flatSessions) {
      if (state.found || state.exhausted) return;
      state.nodes++;
      if (state.nodes > budget.nodeLimit) { state.exhausted = true; return; }
      if (state.nodes % 1000 === 0 && Date.now() - state.start > budget.timeLimitMs) { state.exhausted = true; return; }
      if (!unassigned.length) { state.found = true; return; }
      const live = unassigned.map((v) => ({
        variable: v,
        options: v.domain.filter((g) => g.sessions.every((s) => flatSessions.every((fs) => !sessionsConflict(s, fs)))),
      }));
      live.sort((a, b) => a.options.length - b.options.length);
      const chosen = live[0];
      if (!chosen.options.length) return;
      const restVars = live.slice(1).map((l) => l.variable);
      for (const group of chosen.options) {
        if (state.found || state.exhausted) return;
        recurse(restVars, [...flatSessions, ...group.sessions]);
      }
    }
    recurse(vars, []);
    return state.found;
  }

  // Only called when every variable individually has options, but the full
  // search still found nothing — a real cross-variable scheduling conflict,
  // not a "nothing fits your hours at all" case (that's caught earlier, in
  // generate(), via an empty domain). Two cheap, fully-verified (not
  // guessed) diagnostics: which single hard-constraint relaxation would
  // unblock a plan, and which variable pairs conflict on every combination.
  function diagnose(vars, hc, budget) {
    const smallBudget = { nodeLimit: budget.diagnosticNodeLimit, timeLimitMs: budget.diagnosticTimeMs };

    const relaxations = [];
    if (hc.earliestStart) relaxations.push({ label: 'najwcześniejsza godzina rozpoczęcia', hc: { ...hc, earliestStart: null } });
    if (hc.latestEnd) relaxations.push({ label: 'najpóźniejsza godzina zakończenia', hc: { ...hc, latestEnd: null } });
    (hc.blockedWindows || []).forEach((b, i) => {
      relaxations.push({
        label: `blokada: ${b.day} ${b.start}–${b.end}`,
        hc: { ...hc, blockedWindows: hc.blockedWindows.filter((_, j) => j !== i) },
      });
    });

    const helpfulRelaxations = [];
    relaxations.forEach((r) => {
      const relaxedVars = vars.map((v) => ({ ...v, domain: buildDomain(v.groups, r.hc) }));
      if (relaxedVars.some((v) => v.domain.length === 0)) return; // still dead even relaxed — not the (sole) cause
      if (feasibilityCheck(relaxedVars, smallBudget)) helpfulRelaxations.push(r.label);
    });

    const conflictingPairs = [];
    for (let i = 0; i < vars.length; i++) {
      for (let j = i + 1; j < vars.length; j++) {
        const allConflict = vars[i].domain.every((ga) => vars[j].domain.every((gb) => (
          ga.sessions.some((sa) => gb.sessions.some((sb) => sessionsConflict(sa, sb)))
        )));
        if (allConflict) {
          conflictingPairs.push({
            a: `${vars[i].subjectName} / ${vars[i].classTypeLabel}`,
            b: `${vars[j].subjectName} / ${vars[j].classTypeLabel}`,
          });
        }
      }
    }

    return { helpfulRelaxations, conflictingPairs };
  }

  // Main entry point. `variables`: [{subjectUrl, subjectName, cycleName,
  // classTypeLabel, classTypeShort, groups}]. `hardConstraints`:
  // {earliestStart, latestEnd, blockedWindows: [{day, start, end}]}.
  // `preferences`: {maxPerDay, preferredDays, minimizeGaps}. Returns either
  // {ok: true, candidates: [{assignment, score}], ...} or {ok: false,
  // reason: 'empty-domain'|'infeasible', ...diagnostics}.
  function generate({ variables, hardConstraints, preferences, budget }) {
    const hc = { earliestStart: null, latestEnd: null, blockedWindows: [], ...(hardConstraints || {}) };
    const prefs = { maxPerDay: null, preferredDays: null, minimizeGaps: true, ...(preferences || {}) };
    const b = { nodeLimit: 100000, timeLimitMs: 250, diagnosticNodeLimit: 20000, diagnosticTimeMs: 100, ...(budget || {}) };

    if (!variables || !variables.length) {
      return { ok: false, reason: 'no-variables' };
    }

    const vars = variables.map((v) => ({ ...v, domain: buildDomain(v.groups, hc) }));

    const emptyVars = vars.filter((v) => v.domain.length === 0);
    if (emptyVars.length) {
      return {
        ok: false,
        reason: 'empty-domain',
        emptyVariables: emptyVars.map((v) => ({ subjectName: v.subjectName, classTypeLabel: v.classTypeLabel })),
      };
    }

    const candidates = searchTopK(vars, prefs, b);
    if (candidates.length) {
      return { ok: true, candidates };
    }

    const diagnostics = diagnose(vars, hc, b);
    return { ok: false, reason: 'infeasible', ...diagnostics };
  }

  window.USOSPP_GENERATOR = { generate };
})();

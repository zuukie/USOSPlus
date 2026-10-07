// Storage for somebody-else's timetables ("cudze plany") — shared student
// plans the user pastes in as a link, shown under their own plan with a
// "czyj plan" switcher (see renderPlan in usos/app.js).
//
// Two URL shapes land on the same shared-plan page (verified live):
//   A. .../pokazPlanZajecStudenta&token=...  (14-day public link, no login)
//   B. .../pokazPlanZajecStudenta&os_id=...   (needs the owner to enable
//      "udostępnij wszystkim zalogowanym" in Preferencje USOSweb)
// A page whose owner doesn't share renders "nie udostępnia swojego planu
// zajęć" instead of a timetable — that's the expiry detector.
//
// Kept in chrome.storage.local rather than .sync: entries hold secret-ish
// token URLs, and (like planner drafts) they don't need cross-device sync.
// Shape: { plans: [{ id, kind: 'token'|'osid', url, nickname, ownerName,
// addedAt }], activeId: 'self' | id }. 'self' is the user's own plan and is
// never stored — it's just the default active source.
(function () {
  const KEY = 'usospp:sharedPlans:' + location.origin;
  // Tokens die after 14 days, so piles of them accumulate — cap the list so
  // the plan-view switcher stays one row. Old entries are grandfathered
  // (never trimmed); only adding past the cap is blocked.
  const MAX_PLANS = 8;

  function genId() {
    return `shared_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // Accepts a pasted full URL or bare query string and normalizes it to the
  // canonical shared-plan page URL, or returns null when it's not one.
  // Never logs or echoes the token — it's a live access credential.
  function normalizeUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    let u;
    try {
      u = new URL(raw, location.origin);
    } catch (e) {
      return null;
    }
    if (!/pokazPlanZajecStudenta/i.test(u.searchParams.get('_action') || '')) return null;
    const token = u.searchParams.get('token');
    const osId = u.searchParams.get('os_id');
    if (token) {
      return {
        kind: 'token',
        url: `${location.origin}/kontroler.php?_action=katalog2/osoby/pokazPlanZajecStudenta&token=${encodeURIComponent(token)}`,
      };
    }
    if (osId && /^\d+$/.test(osId)) {
      return {
        kind: 'osid',
        url: `${location.origin}/kontroler.php?_action=katalog2/osoby/pokazPlanZajecStudenta&os_id=${encodeURIComponent(osId)}`,
      };
    }
    return null;
  }

  async function getData() {
    let data = null;
    try {
      const stored = await chrome.storage.local.get({ [KEY]: null });
      data = stored[KEY];
    } catch (e) { /* storage unavailable — fall through to empty */ }
    if (!data || !Array.isArray(data.plans)) data = { plans: [], activeId: 'self' };
    // Drop malformed rows, keep the rest — never nuke the whole list.
    data.plans = data.plans.filter((p) => p && p.id && p.url);
    if (data.activeId !== 'self' && !data.plans.some((p) => p.id === data.activeId)) {
      data = { ...data, activeId: 'self' };
    }
    return data;
  }

  async function setData(partialOrFn) {
    const current = await getData();
    const next = typeof partialOrFn === 'function' ? partialOrFn(current) : { ...current, ...partialOrFn };
    if (next !== current) {
      try {
        await chrome.storage.local.set({ [KEY]: next });
      } catch (e) { /* ignore quota errors */ }
    }
    return next;
  }

  function onDataChange(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      callback(changes[KEY].newValue || null);
    });
  }

  window.USOSPP_SHARED_PLANS = { getData, setData, onDataChange, genId, normalizeUrl, MAX_PLANS };
})();

// Storage for the schedule-planner draft(s) — a student's own what-if course
// schedules, built from real group data (see adapters.js's getClassGroups)
// but never submitted to USOS. Kept in chrome.storage.local rather than
// .sync: a full draft (many subjects, each with per-session day/time/room/
// teacher text), times up to MAX_PLANS of them, can outgrow the 8KB-per-item
// sync quota, and cross-device sync isn't worth that risk for something
// this disposable.
//
// Shape: { plans: [{ id, name, picks: [...] }, ...], activePlanId }. Capped
// at MAX_PLANS so a student comparing a few "what if" layouts (e.g. morning
// vs. evening lab group) doesn't end up with an unbounded pile of drafts.
(function () {
  const KEY = 'usospp_planner';
  const MAX_PLANS = 5;

  function genId() {
    return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  async function getData() {
    const stored = await chrome.storage.local.get({ [KEY]: null });
    let data = stored[KEY];
    // Migrate the pre-multi-plan shape ({ picks: [] }, or nothing yet) into
    // a single "Plan 1" — never drop an existing draft just because this
    // feature didn't exist when it was saved.
    if (!data || !Array.isArray(data.plans) || !data.plans.length) {
      const legacyPicks = (data && Array.isArray(data.picks)) ? data.picks : [];
      const plan = { id: genId(), name: 'Plan 1', picks: legacyPicks };
      data = { plans: [plan], activePlanId: plan.id };
      await chrome.storage.local.set({ [KEY]: data });
    }
    if (!data.plans.some((p) => p.id === data.activePlanId)) {
      data = { ...data, activePlanId: data.plans[0].id };
    }
    return data;
  }

  async function setData(partialOrFn) {
    const current = await getData();
    const next = typeof partialOrFn === 'function' ? partialOrFn(current) : { ...current, ...partialOrFn };
    if (next !== current) await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  function onDataChange(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      callback(changes[KEY].newValue || null);
    });
  }

  window.USOSPP_PLANNER = { getData, setData, onDataChange, genId, MAX_PLANS };
})();

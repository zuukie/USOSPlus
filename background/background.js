chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  if (msg.type === 'usospp:setBadge') {
    chrome.action.setBadgeText({ text: msg.text || '' });
    chrome.action.setBadgeBackgroundColor({ color: '#d9773a' });
    return undefined;
  }

  if (msg.type === 'usospp:registerUniversity') {
    registerModule(msg.originPattern, msg.module || 'usos').then(sendResponse);
    return true;
  }

  return undefined;
});

// File lists for each dynamically-registrable module — MUST be kept in sync
// with the matching static entry in manifest.json. popup.js's "Dodaj obsługę
// tej uczelni" flow can request either 'usos' or 'irk' (its own IRK
// detection decides which), via the exact same permission-request +
// registerModule call.
const MODULE_FILES = {
  usos: {
    css: ['fonts/fonts.css', 'core/ui/design-system.css', 'usos/usos.css'],
    js: [
      'core/state-bridge.js',
      'core/detect.js',
      'core/sanitize-html.js',
      'usos/planner-store.js',
      'usos/adapters.js',
      'usos/scraping.js',
      'usos/generator.js',
      'usos/app.js',
      'usos/inject.js',
    ],
  },
  irk: {
    css: ['fonts/fonts.css', 'core/ui/design-system.css'],
    js: [
      'core/state-bridge.js',
      'core/detect.js',
      'core/sanitize-html.js',
      'irk/detect.js',
      'irk/adapters.js',
      'irk/scraping.js',
      'irk/app.js',
      'irk/inject.js',
    ],
  },
};

// Our OWN record of which module was registered for which origin —
// { [originPattern]: moduleName }, in chrome.storage.local.
//
// chrome.scripting.registerContentScripts() is documented to persist across
// sessions, but that was observed live to NOT survive reloading an unpacked
// extension in developer mode (chrome.scripting.getRegisteredContentScripts()
// came back completely empty after a routine "Reload" click in
// chrome://extensions, despite an origin having been added and working
// minutes earlier — the granted chrome.permissions host permission DID
// survive, just not the registration built on top of it). chrome.storage
// does reliably survive that, so it — not chrome.scripting's own registry —
// is the source of truth restoreDynamicModuleScripts() rebuilds from on
// every service worker start.
const REGISTRY_KEY = 'usospp_dynamic_modules';

async function getRegistry() {
  const stored = await chrome.storage.local.get({ [REGISTRY_KEY]: {} });
  return stored[REGISTRY_KEY];
}

async function saveRegistryEntry(originPattern, moduleName) {
  const registry = await getRegistry();
  registry[originPattern] = moduleName;
  await chrome.storage.local.set({ [REGISTRY_KEY]: registry });
}

// Dynamically extends the extension to another installation once the user
// has granted permission for its origin (see popup.js's "Dodaj obsługę tej
// uczelni"). Same files as the matching static manifest.json entry, just
// scoped to whatever origin the user approved instead of the one hardcoded
// PWr host. Safe to call again for an origin that's already registered —
// refreshes it to the current MODULE_FILES instead of erroring, which is
// also how a stale file list (module gained new files after the domain was
// first added) gets picked up.
async function registerModule(originPattern, moduleName) {
  const files = MODULE_FILES[moduleName];
  if (!files) return { ok: false, error: `Unknown USOS++ module: ${moduleName}` };
  try {
    const id = `usospp-dynamic-${moduleName}-` + originPattern.replace(/[^a-z0-9]+/gi, '-');
    const entry = { id, matches: [originPattern], css: files.css, js: files.js, runAt: 'document_end' };
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length) await chrome.scripting.updateContentScripts([entry]);
    else await chrome.scripting.registerContentScripts([entry]);
    await saveRegistryEntry(originPattern, moduleName);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Re-registers every origin+module the user has ever added via the popup,
// on every service worker start (extension reload, browser restart, ...) —
// see REGISTRY_KEY's comment for why this can't just trust
// chrome.scripting.getRegisteredContentScripts() to still hold what it held
// before. Also adopts any live registration chrome.scripting DOES still
// have but our registry doesn't know about yet (from before this registry
// existed) — old pre-reorg ids with no 'usos-'/'irk-' prefix are treated as
// 'usos', since irk/ didn't exist when those were created.
async function restoreDynamicModuleScripts() {
  try {
    const registry = await getRegistry();
    const live = await chrome.scripting.getRegisteredContentScripts();
    live.forEach((s) => {
      const origin = s.matches && s.matches[0];
      if (!origin || registry[origin]) return;
      const m = s.id.match(/^usospp-dynamic-(usos|irk)-/);
      registry[origin] = m ? m[1] : (/^usospp-dynamic-/.test(s.id) ? 'usos' : null);
    });
    await Promise.all(
      Object.entries(registry)
        .filter(([, moduleName]) => moduleName)
        .map(([originPattern, moduleName]) => registerModule(originPattern, moduleName))
    );
  } catch (e) {
    // Best-effort: a failed restore just leaves those tabs needing the user
    // to re-add them from the popup, same as if this never ran.
  }
}
restoreDynamicModuleScripts();

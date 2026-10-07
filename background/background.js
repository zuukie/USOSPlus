chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  if (msg.type === 'usospp:setBadge') {
    chrome.action.setBadgeText({ text: msg.text || '' });
    chrome.action.setBadgeBackgroundColor({ color: '#d9773a' });
    return undefined;
  }

  if (msg.type === 'usospp:registerUniversity') {
    // Defense-in-depth: only the extension's own popup (or its own content
    // scripts) may register new university origins — never a web page.
    // Web pages can't send runtime messages without externally_connectable
    // (which we don't declare), but an explicit sender check costs nothing.
    if (sender && sender.id && sender.id !== chrome.runtime.id) return undefined;
    if (sender && sender.url && !sender.url.startsWith('chrome-extension://' + chrome.runtime.id + '/')) {
      return undefined;
    }
    registerModule(msg.originPattern, msg.module || 'usos').then(sendResponse);
    return true;
  }

  if (msg.type === 'usospp:ensureLeaflet') {
    // Lazy Leaflet injection (see usos/leaflet-loader.js): loads
    // vendor/leaflet into the tab's ISOLATED world — the same realm the
    // extension's content scripts (incl. usos/app.js) run in — so the
    // app's own `window.L` checks see it. A page-DOM
    // <script src="chrome-extension://…"> can't do that (it lands in the
    // page's own JS world, invisible to content scripts) and would
    // additionally need a web_accessible_resources entry plus the page's
    // CSP to allow it.
    if (sender && sender.id && sender.id !== chrome.runtime.id) return undefined;
    ensureLeafletInTab(sender && sender.tab && sender.tab.id).then(sendResponse);
    return true;
  }

  if (msg.type === 'usospp:ensureQrCode') {
    // Lazy QR generator injection (see usos/qrcode-loader.js): loads
    // vendor/qrcode into the tab's ISOLATED world — the same realm the
    // extension's content scripts run in, so the mLegitymacja pickup
    // view's `window.qrcode` checks see it. Same rationale as Leaflet
    // above: the pickup view is rarely opened, so parsing ~20 kB on
    // every USOS page would be pure waste.
    if (sender && sender.id && sender.id !== chrome.runtime.id) return undefined;
    ensureQrCodeInTab(sender && sender.tab && sender.tab.id).then(sendResponse);
    return true;
  }

  return undefined;
});

// Injects Leaflet (JS+CSS) into a tab's ISOLATED world on demand — the
// Mapa view and the unit-page preview are the only consumers, so bundling
// leaflet.js statically would parse ~150 kB on every USOS page for
// nothing. chrome.scripting execution is not subject to the page's CSP
// and needs no web_accessible_resources entry; ISOLATED (the default
// world) shares the realm with content scripts, hence the `window.L`
// checks in usos/app.js keep working unchanged.
async function ensureLeafletInTab(tabId) {
  try {
    if (!tabId) return { ok: false, error: 'no sender tab' };
    const hasIt = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.L,
    });
    if (hasIt && hasIt[0] && hasIt[0].result) return { ok: true, cached: true };
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['vendor/leaflet/leaflet.js'],
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['vendor/leaflet/leaflet.css'],
    });
    const verify = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!(window.L && window.L.map && window.L.marker),
    });
    if (verify && verify[0] && verify[0].result) return { ok: true };
    return { ok: false, error: 'leaflet unavailable after injection' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function ensureQrCodeInTab(tabId) {
  try {
    if (!tabId) return { ok: false, error: 'no sender tab' };
    const hasIt = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.qrcode,
    });
    if (hasIt && hasIt[0] && hasIt[0].result) return { ok: true, cached: true };
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['vendor/qrcode/qrcode.js'],
    });
    const verify = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => typeof window.qrcode === 'function',
    });
    if (verify && verify[0] && verify[0].result) return { ok: true };
    return { ok: false, error: 'qrcode unavailable after injection' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

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
      'usos/leaflet-loader.js',
      'usos/qrcode-loader.js',
      'usos/planner-store.js',
      'usos/shared-plans-store.js',
      'usos/adapters.js',
      'usos/scraping.js',
      'usos/generator.js',
      'usos/zapisy-plan.js',
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
  if (typeof originPattern !== 'string' || !/^\*:\/\/[^/*]+\/\*$/.test(originPattern)) {
    return { ok: false, error: `Rejected origin pattern: ${originPattern}` };
  }
  const id = `usospp-dynamic-${moduleName}-` + originPattern.replace(/[^a-z0-9]+/gi, '-');
  const entry = { id, matches: [originPattern], css: files.css, js: files.js, runAt: 'document_idle' };
  // A host permission granted moments earlier (popup.js's addUniversity calls
  // straight in here right after chrome.permissions.request resolves) was
  // observed live to sometimes not yet be visible to
  // chrome.scripting.registerContentScripts() in that same tick, making it
  // reject even though the permission really is granted. One retry after a
  // short delay clears that without meaningfully delaying a real,
  // non-transient failure (bad module name, malformed pattern) from
  // surfacing. Every failure is logged here — this used to fail completely
  // silently, with popup.js not checking the result either, so a failed
  // registration looked to the user like classic USOS just... not changing.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
      if (existing.length) await chrome.scripting.updateContentScripts([entry]);
      else await chrome.scripting.registerContentScripts([entry]);
      await saveRegistryEntry(originPattern, moduleName);
      return { ok: true };
    } catch (e) {
      if (attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      console.error('USOS++ registerModule failed:', originPattern, moduleName, e);
      return { ok: false, error: String(e) };
    }
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

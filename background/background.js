chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  if (msg.type === 'usospp:setBadge') {
    chrome.action.setBadgeText({ text: msg.text || '' });
    chrome.action.setBadgeBackgroundColor({ color: '#d9773a' });
    return undefined;
  }

  if (msg.type === 'usospp:registerUniversity') {
    registerUniversity(msg.originPattern).then(sendResponse);
    return true;
  }

  return undefined;
});

// Dynamically extends the extension to another USOSweb installation once the
// user has granted permission for its origin (see popup.js). Uses the same
// files as the static PWr content script entry in manifest.json.
async function registerUniversity(originPattern) {
  try {
    const id = 'usospp-dynamic-' + originPattern.replace(/[^a-z0-9]+/gi, '-');
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length) return { ok: true, alreadyRegistered: true };
    await chrome.scripting.registerContentScripts([
      {
        id,
        matches: [originPattern],
        css: ['fonts/fonts.css', 'content/redesign.css'],
        js: [
          'content/state-bridge.js',
          'content/adapters.js',
          'content/scraping.js',
          'content/app.js',
          'content/inject.js',
        ],
        runAt: 'document_end',
      },
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

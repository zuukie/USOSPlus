import { getState } from '../shared/state.js';

const GRADE_CHECK_ALARM = 'usospp:checkGrades';
const OCENY_PATH = 'kontroler.php?_action=dla_stud/studia/oceny/index';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(GRADE_CHECK_ALARM, { periodInMinutes: 15 });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  if (msg.type === 'usospp:setBadge') {
    chrome.action.setBadgeText({ text: msg.text || '' });
    chrome.action.setBadgeBackgroundColor({ color: '#c96b31' });
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

// Background grade check: no USOS API, no DOM parsing (service workers have
// no DOMParser) — just a lightweight fetch + text diff against the oceny
// page's own content, so a new/changed grade fires a plain OS notification.
// A future pass could use chrome.offscreen to parse the HTML into rows for a
// more precise "new grade in X" message; for now we only detect *that*
// something changed, not what.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== GRADE_CHECK_ALARM) return;
  const settings = await getState();
  if (!settings.features.notif) return;

  const origins = await chrome.permissions.getAll();
  const candidatePatterns = (origins.origins || []).filter((o) => /usos/i.test(o));
  for (const pattern of candidatePatterns) {
    // pattern looks like "*://web.usos.pwr.edu.pl/*" — turn it into a
    // concrete, fetchable origin.
    const m = pattern.match(/^\*:\/\/([^/]+)\//);
    if (!m) continue;
    await checkGradesForOrigin(`https://${m[1]}/`);
  }
});

async function checkGradesForOrigin(originBase) {
  try {
    const res = await fetch(originBase + OCENY_PATH, { credentials: 'include' });
    if (!res.ok) return;
    const html = await res.text();
    const m = html.match(/<usos-frame id="oceny"[\s\S]*?<\/usos-frame>/);
    const snippet = m ? m[0] : html.slice(0, 2000);
    const key = 'usospp:lastOcenyHash:' + originBase;
    const stored = await chrome.storage.local.get(key);
    const prev = stored[key];
    if (prev !== undefined && prev !== snippet) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'USOS++',
        message: 'Wykryto zmianę na stronie ocen w USOS — sprawdź szczegóły.',
      });
    }
    await chrome.storage.local.set({ [key]: snippet });
  } catch (e) {
    // network/session issue — silently skip this cycle
  }
}

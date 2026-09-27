// Shared HTML sanitizer for fetched (not executed) same-origin pages —
// extracted from usos/adapters.js's original sanitizeNewsHtml, which needed
// this exact logic for USOS's Aktualności; irk/adapters.js needs the
// identical thing for IRK's own Aktualności, so this is a genuine "both
// modules use it" case, not speculative sharing (see ARCHITECTURE.md).
//
// Walks parsed (inert, DOMParser-produced, non-executing) content and
// rebuilds it using only an allowlist of safe formatting tags, dropping
// everything else down to its text. Unknown wrapper tags (span/div/font from
// whatever CMS rendered the page) are unwrapped rather than dropped, so
// their text/links still come through.
(function () {
  const DEFAULT_ALLOWED_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'UL', 'OL', 'LI', 'A']);

  // News bodies (USOS + IRK Aktualności) may carry inline photos — posters,
  // pictograms, editor-inserted illustrations. IMG stays out of the default
  // set (message threads etc. remain text-only); news wrappers opt in by
  // passing NEWS_ALLOWED_TAGS explicitly.
  const NEWS_ALLOWED_TAGS = new Set([...DEFAULT_ALLOWED_TAGS, 'IMG']);

  function cleanImgSrc(src, doc) {
    const raw = (src || '').trim();
    if (!raw || /^data:/i.test(raw)) return null;
    try {
      // Relative CMS paths resolve against the fetched page, so the image
      // still loads once transplanted into the extension's own DOM.
      // https-only: plain http images are dropped to avoid mixed content
      // and silent image swaps on the wire.
      const abs = new URL(raw, doc.baseURI || undefined).href;
      return /^https:\/\//i.test(abs) ? abs : null;
    } catch {
      return null;
    }
  }

  function sanitizeNode(node, targetDoc, allowedTags) {
    if (node.nodeType === Node.TEXT_NODE) return targetDoc.createTextNode(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const isAllowed = allowedTags.has(node.tagName);
    const container = isAllowed ? targetDoc.createElement(node.tagName.toLowerCase()) : targetDoc.createDocumentFragment();
    if (isAllowed && node.tagName === 'A') {
      const href = (node.getAttribute('href') || '').trim();
      if (/^https:\/\//i.test(href) && !/[\r\n\t]/.test(href)) {
        container.setAttribute('href', href);
        container.setAttribute('target', '_blank');
        container.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (isAllowed && node.tagName === 'IMG') {
      // src + alt only: no srcset/sizes/event handlers survive, and a
      // relative/unresolvable/non-https src drops the whole image rather
      // than injecting a broken one. Sizing is CSS-capped at render time.
      const src = cleanImgSrc(node.getAttribute('src'), targetDoc);
      if (!src) return null;
      container.setAttribute('src', src);
      container.setAttribute('loading', 'lazy');
      container.setAttribute('decoding', 'async');
      const alt = node.getAttribute('alt');
      if (alt) container.setAttribute('alt', alt);
      return container; // void element — never has meaningful children
    }
    node.childNodes.forEach((child) => {
      const clean = sanitizeNode(child, targetDoc, allowedTags);
      if (clean) container.appendChild(clean);
    });
    return container;
  }

  function sanitizeHtml(nodes, doc, allowedTags = DEFAULT_ALLOWED_TAGS) {
    const wrap = doc.createElement('div');
    nodes.forEach((node) => {
      const clean = sanitizeNode(node, doc, allowedTags);
      if (clean) wrap.appendChild(clean);
    });
    return wrap.innerHTML;
  }

  window.USOSPP_CORE_SANITIZE = { sanitizeHtml, DEFAULT_ALLOWED_TAGS, NEWS_ALLOWED_TAGS };
})();

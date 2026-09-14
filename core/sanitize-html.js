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

  function sanitizeNode(node, targetDoc, allowedTags) {
    if (node.nodeType === Node.TEXT_NODE) return targetDoc.createTextNode(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const isAllowed = allowedTags.has(node.tagName);
    const container = isAllowed ? targetDoc.createElement(node.tagName.toLowerCase()) : targetDoc.createDocumentFragment();
    if (isAllowed && node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) {
        container.setAttribute('href', href);
        container.setAttribute('target', '_blank');
        container.setAttribute('rel', 'noopener noreferrer');
      }
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

  window.USOSPP_CORE_SANITIZE = { sanitizeHtml, DEFAULT_ALLOWED_TAGS };
})();

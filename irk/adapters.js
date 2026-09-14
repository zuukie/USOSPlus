// Reads data out of the live IRK DOM / fetched IRK pages. No IRK API calls
// anywhere here — everything below only looks at what the page already
// renders for the (anonymous or logged-in) visitor. Verified live
// (2026-09-14) against https://irk.usos.pwr.edu.pl (Politechnika
// Wrocławska) — every page checked here was plain server-rendered HTML
// (confirmed via fetch()+DOMParser, not just the live post-JS DOM), so this
// works the same way usos/adapters.js's static pages do.
//
// Like usos/adapters.js, this is written against one real installation —
// other universities' IRK is expected (not confirmed) to share the same
// MUCI-built template (see irk/detect.js's comment), so selectors here may
// need adjusting once a second installation is checked.
(function () {
  function textOf(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  }

  // Every page for a given recruitment campaign lives under
  // /pl/{home,offer,news}/<SLUG>/... — e.g. /pl/offer/R_2026_2027_LETNIA_I_ST/
  // or a programme sub-page /pl/offer/<SLUG>/programme/<CODE>/. This only
  // relies on that URL SHAPE, never a hardcoded slug — the slug format is
  // whatever this university's IRK installation assigned to this campaign.
  function recruitmentSlug(url = location.href) {
    try {
      const path = new URL(url, location.origin).pathname;
      const m = path.match(/^\/pl\/(?:home|offer|news)\/([^/]+)\//);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  // The current recruitment campaign's display name, from the header link
  // that also doubles as "go to its home page" (e.g. "REKRUTACJA studia
  // stacjonarne I stopnia" -> href="/pl/home/<slug>/").
  function recruitmentLabel(doc = document) {
    const link = doc.querySelector('a[href^="/pl/home/"]');
    return link ? textOf(link) : null;
  }

  function looksLikeOfferPage(doc = document) {
    return !!doc.querySelector('.offer-fields-list');
  }

  // Verified live at /pl/offer/<slug>/ — results render as one
  // <section class="section-box"> per starting letter, each with an
  // <h2 class="box-header"> (the letter) and a <ul> of
  // <li><a href="...">Name <small>(count)</small></a></li>.
  function getOfferList(doc = document) {
    const list = doc.querySelector('.offer-fields-list');
    if (!list) return { supported: false, verified: false, groups: [] };
    const groups = [...list.querySelectorAll('section.section-box')].map((section) => {
      const letter = textOf(section.querySelector('h2.box-header'));
      const items = [...section.querySelectorAll('ul > li > a[href]')].map((a) => {
        const small = a.querySelector('small');
        const countText = small ? textOf(small) : null;
        const countMatch = countText && countText.match(/\((\d+)\)/);
        const clone = a.cloneNode(true);
        clone.querySelectorAll('small').forEach((s) => s.remove());
        return { name: textOf(clone), count: countMatch ? parseInt(countMatch[1], 10) : null, url: a.href };
      });
      return { letter, items };
    });
    return { supported: groups.length > 0, verified: true, groups };
  }

  // Verified live at /pl/offer/<slug>/programme/<code>/ — a "Szczegóły" info
  // table (<table class="styled-table-alt tech-details"><tbody><tr>
  // <th>Label</th><td>Value</td></tr>...</tbody></table>), a registration-
  // status block, and free-text sections (OPIS KIERUNKU, ZASADY KWALIFIKACJI,
  // ...) each introduced by its own <h2>.
  function getProgrammeDetail(doc = document) {
    const name = textOf(doc.querySelector('main h1, #content h1'));
    const table = doc.querySelector('table.tech-details');
    // A kierunek offered in more than one variant (different campus/city or
    // study mode — see getOfferList's `count`) links to a /field/<code>/ hub
    // instead of straight to a /programme/<code>/ page; that hub has the
    // same <h1> but no "Szczegóły" table, so requiring the table here is
    // what actually distinguishes the two — see getFieldVariants for the
    // hub page itself.
    if (!name || !table) return { supported: false, verified: false, name, fields: [], status: null, sections: [] };

    const fields = table
      ? [...table.querySelectorAll('tbody > tr')].map((tr) => {
          const th = tr.querySelector('th');
          const td = tr.querySelector('td');
          const link = td ? td.querySelector('a') : null;
          return { label: textOf(th), value: textOf(td), link: link ? link.href : null };
        }).filter((f) => f.label)
      : [];

    // UNVERIFIED: only the "zapisy zamknięte" state (class "register-
    // disabled") has been observed live — no recruitment round was open at
    // verification time, so the markup for an OPEN round (deadline, a real
    // "zapisz się" button) is a guess based on the disabled variant's likely
    // sibling class name. It also embeds an inline <script> (the "pokaż
    // minione tury" toggle) whose source textContent would otherwise leak
    // into the status text — same fix as usos/adapters.js's getSubjectPage
    // cellText() applies for an analogous inline <script> elsewhere.
    const registerBox = doc.querySelector('.register-disabled, .register-enabled');
    const statusVerified = !!doc.querySelector('.register-disabled');
    let status = null;
    if (registerBox) {
      const clone = registerBox.cloneNode(true);
      clone.querySelectorAll('script').forEach((s) => s.remove());
      status = textOf(clone);
    }

    // Each content section is "<h2>TITLE</h2>" followed by sibling nodes up
    // to the next <h2> — same walk-the-siblings shape usos/adapters.js's
    // getStageSubjects uses for an unrelated USOS page; IRK's programme page
    // happens to follow the identical pattern.
    const sections = [];
    doc.querySelectorAll('#content h2, main h2').forEach((h2) => {
      const title = textOf(h2);
      if (!title) return;
      const bodyNodes = [];
      let el = h2.nextElementSibling;
      while (el && el.tagName !== 'H2') {
        bodyNodes.push(el);
        el = el.nextElementSibling;
      }
      sections.push({ title, html: window.USOSPP_CORE_SANITIZE.sanitizeHtml(bodyNodes, doc) });
    });

    return {
      supported: true,
      verified: true,
      name,
      fields,
      status,
      statusSupported: !!registerBox,
      statusVerified,
      sections,
    };
  }

  // Verified live at /pl/offer/<slug>/field/<code>/ — the hub page a
  // multi-variant kierunek's Oferta link points to (see getProgrammeDetail's
  // comment). Lists each variant as a plain a[href*="/programme/"] link;
  // nothing else on this page is specific enough to be worth parsing yet.
  function getFieldVariants(doc = document) {
    const name = textOf(doc.querySelector('main h1, #content h1'));
    const variants = [...doc.querySelectorAll('a[href*="/programme/"]')].map((a) => ({ name: textOf(a), url: a.href }));
    return { supported: variants.length > 0, verified: true, name, variants };
  }

  // Verified live at /pl/news/<slug>/ — categories are "<h2>Category</h2>"
  // followed by a "<ul>" of
  // "<li><span class="code_label">DATE |</span> <a href="...">Title</a></li>".
  function getNews(doc = document) {
    const content = doc.querySelector('#content, main');
    if (!content) return { supported: false, verified: false, categories: [] };
    const categories = [];
    content.querySelectorAll('h2').forEach((h2) => {
      const label = textOf(h2);
      const ul = h2.nextElementSibling;
      if (!label || !ul || ul.tagName !== 'UL') return;
      const items = [...ul.querySelectorAll(':scope > li')].map((li) => {
        const a = li.querySelector('a');
        const dateEl = li.querySelector('.code_label');
        return {
          date: dateEl ? textOf(dateEl).replace(/\|\s*$/, '').trim() : null,
          title: a ? textOf(a) : textOf(li),
          url: a ? a.href : null,
        };
      });
      categories.push({ label, items });
    });
    return { supported: categories.length > 0, verified: true, categories };
  }

  window.USOSPP_IRK_ADAPTERS = {
    recruitmentSlug,
    recruitmentLabel,
    looksLikeOfferPage,
    getOfferList,
    getProgrammeDetail,
    getFieldVariants,
    getNews,
  };
})();

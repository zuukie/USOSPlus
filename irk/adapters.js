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

  // Verified live — IRK's shared top-menu (`.top-menu-items`, present on
  // every page regardless of platform/university, same template as the
  // rest of this file) renders "zaloguj się" / "utwórz konto" (linking to
  // /pl/auth/login/ and /pl/auth/register/consent/) when nobody is signed
  // in, and swaps to "wiadomości" / "powiadomienia" / "moje konto" /
  // "wyloguj się" (linking to /auth/logout/) once a candidate is. The
  // logout link is the cheapest reliable signal — checked directly against
  // whatever page is already loaded, no extra fetch needed (unlike
  // getApplications, which needs the session to be logged in but doesn't
  // itself tell you whether it is).
  function isLoggedIn(doc = document) {
    return !!doc.querySelector('a[href*="/auth/logout/"]');
  }

  // The same top-menu's "zaloguj się" link is server-rendered with
  // `?next=<this exact page's own path>` already attached, so following it
  // and logging in lands the visitor right back where they were — nothing
  // for us to build here beyond reading the href IRK already generated.
  function getLoginUrl(doc = document) {
    const a = doc.querySelector('a[href*="/auth/login/"]');
    return a ? a.href : null;
  }

  // The register-disabled/-enabled box (see getProgrammeDetail) buries a long
  // "Minione tury w tej rekrutacji: Tura 1 (...) Tura 2 (...) ..." list right
  // inside the same block as the one-line headline ("Obecnie nie trwają
  // zapisy."), which is why a flat textContent read made the status balloon
  // into an unreadable, overflowing wall of text. Verified live: the past
  // rounds live in a hidden `#prev-turns` (revealed by the `(pokaż minione
  // tury)` toggle) as `<li>Tura N (start – end) <a href=".../criteria/preview/turn/N/">` —
  // pulled out here into structured rows so the UI can render them as a
  // collapsed, scannable list instead of one long paragraph.
  function parseRegisterBox(box) {
    if (!box) return null;
    const clone = box.cloneNode(true);
    clone.querySelectorAll('script').forEach((s) => s.remove());
    const prevTurnsEl = clone.querySelector('#prev-turns');
    let pastTurns = [];
    if (prevTurnsEl) {
      pastTurns = [...prevTurnsEl.querySelectorAll('ul > li')].map((li) => {
        const link = li.querySelector('a[href]');
        const liClone = li.cloneNode(true);
        liClone.querySelectorAll('a').forEach((a) => a.remove());
        const text = textOf(liClone);
        const m = text && text.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
        return {
          label: m ? m[1].trim() : text,
          range: m ? m[2].trim() : null,
          criteriaUrl: link ? link.href : null,
        };
      });
      prevTurnsEl.remove();
    }
    const trigger = clone.querySelector('#prev_turn_trigger');
    if (trigger) trigger.remove();
    clone.querySelectorAll('hr').forEach((hr) => hr.remove());
    return { headline: textOf(clone), pastTurns };
  }

  // Verified live at /pl/offer/registration-select/ — the university's own
  // "zmień rekrutację" picker (linked from every IRK page's header) renders
  // each parallel recruitment campaign as
  // <ul class="reg_select"><li><button data-href="/pl/offer/registration-select/<SLUG>/?next=...">
  //   <p>Name</p><p>Description</p>[<p class="reg-status-info">access-code notice</p>]
  // </button></li>...</ul> — this only reads that list; the actual switch
  // (a plain GET to that data-href, no form/POST — see irk/scraping.js's
  // switchRecruitmentUrl) stays a real navigation, not something this parser
  // triggers itself.
  function getRecruitmentOptions(doc = document) {
    const list = doc.querySelector('ul.reg_select');
    if (!list) return { supported: false, verified: false, options: [] };
    const options = [...list.querySelectorAll(':scope > li > button[data-href]')]
      .map((btn) => {
        const href = btn.getAttribute('data-href') || '';
        const m = href.match(/^\/pl\/offer\/registration-select\/([^/]+)\//);
        const paragraphs = btn.querySelectorAll('p');
        return {
          slug: m ? m[1] : null,
          name: textOf(paragraphs[0]),
          description: paragraphs[1] ? textOf(paragraphs[1]) : null,
          protectedAccess: !!btn.querySelector('.reg-status-info'),
        };
      })
      .filter((o) => o.slug && o.name);
    return { supported: options.length > 0, verified: true, options };
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
    // sibling class name. See parseRegisterBox for how the headline and any
    // past-rounds list embedded in the same box get pulled apart.
    const registerBox = doc.querySelector('.register-disabled, .register-enabled');
    const statusVerified = !!doc.querySelector('.register-disabled');
    const registerInfo = parseRegisterBox(registerBox);
    const status = registerInfo ? registerInfo.headline : null;
    const pastTurns = registerInfo ? registerInfo.pastTurns : [];

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
      pastTurns,
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

  // Verified live at /pl/offer/<slug>/units/ — one
  // <header class="right-panel"><table class="tech-details"><caption>Wydział
  // X</caption>...(a "Strona w USOSweb" row, sometimes a "Portal WWW"
  // row)...</table></header> immediately followed by its own
  // <div class="org-unit-tree"><h2><a href="/pl/offer/<slug>/units/<CODE>/">
  // Wydział X <small>(N)</small></a></h2></div> — repeated once per wydział
  // actually offering something in THIS recruitment (checked for every unit
  // on the page, not just one). N is how many kierunki it has here — the
  // same count getOfferList's per-kierunek small already parses elsewhere.
  function getUnitsList(doc = document) {
    const trees = [...doc.querySelectorAll('div.org-unit-tree')];
    if (!trees.length) return { supported: false, verified: false, units: [] };
    const units = trees.map((tree) => {
      const link = tree.querySelector('h2 > a[href]');
      if (!link) return null;
      const small = link.querySelector('small');
      const countText = small ? textOf(small) : null;
      const countMatch = countText && countText.match(/\((\d+)\)/);
      const clone = link.cloneNode(true);
      clone.querySelectorAll('small').forEach((s) => s.remove());
      const header = tree.previousElementSibling;
      let usosWebUrl = null;
      const links = [];
      if (header && header.matches('header.right-panel')) {
        header.querySelectorAll('tbody > tr').forEach((tr) => {
          const th = tr.querySelector('th');
          const a = tr.querySelector('td a[href]');
          if (!a) return;
          if (/USOSweb/i.test(textOf(th) || '')) usosWebUrl = a.href;
          else links.push({ label: textOf(th), url: a.href });
        });
      }
      return {
        name: textOf(clone),
        count: countMatch ? parseInt(countMatch[1], 10) : null,
        offerUrl: link.href,
        usosWebUrl,
        links,
      };
    }).filter((u) => u && u.name);
    return { supported: units.length > 0, verified: true, units };
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

  // Two different naming conventions for the same idea show up across IRK's
  // own pages — table cells on /pl/profile/applications/ use a
  // "*-background" suffix (see getApplications), while /pl/profile/'s photo
  // status table uses a plain "*-color" suffix instead — both recognized
  // here so callers don't need to know which page they're on.
  function toneOfCell(el) {
    if (!el) return null;
    if (el.classList.contains('positive-background') || el.classList.contains('positive-color')) return 'positive';
    if (el.classList.contains('negative-background') || el.classList.contains('negative-color') || el.classList.contains('red')) return 'negative';
    if (el.classList.contains('yellow-background')) return 'warning';
    if (el.classList.contains('neutral-background')) return 'neutral';
    return null;
  }

  // Splits a cell's leading "<span class="fa fa-...">" icon (the only thing
  // telling positive/negative states apart across this page) from its
  // trailing text, e.g. "<span class="fa fa-check-circle"></span> opłacono"
  // -> icon "fa-check-circle", text "opłacono".
  function iconOf(el) {
    const span = el ? el.querySelector('span[class*="fa-"]') : null;
    if (!span) return null;
    return [...span.classList].find((c) => c.startsWith('fa-')) || null;
  }

  // Verified live at /pl/profile/applications/ — the candidate's own "Moje
  // konto" account page, unreachable without a logged-in candidate session
  // (this is what ARCHITECTURE.md's older note called "Status zgłoszenia —
  // wymaga zalogowanego konta, niezweryfikowane"). One
  // <section class="section-box registrations-box"> per recruitment
  // campaign the candidate has EVER applied to (not just the currently
  // selected one — this page is account-wide), each holding a heading
  // ("[SLUG] Name (status)"), the academic year, an optional "Opis", and one
  // <table class="applications-table"> per kierunek applied to: a header
  // row (programme link), a main row (<tr id="application_<id>"> with
  // turn/priorytet/historia, opłata, wynik, status kwalifikacji, decyzja),
  // then optional rows — a plain 2-cell "Dokument uprawniający..." row, an
  // "Egzaminy wewnętrzne" block (one <td rowspan> label + one row per exam),
  // a ".comment" row, and a final "Dokumenty i dalsze kroki" link row (see
  // getApplicationNextSteps for that page). Only "opłacono" / "zakwalifikowany"
  // / "niezakwalifikowany" / "przyjęty" / "---" have actually been observed
  // for the payment/qualification/decision states — other IRK-standard
  // values (e.g. an unpaid or refunded fee, a rejected decision) are
  // UNVERIFIED and will just show through as plain, untranslated text since
  // nothing here hardcodes an enum of expected values.
  function getApplications(doc = document) {
    const boxes = [...doc.querySelectorAll('section.registrations-box')];
    if (!boxes.length) return { supported: false, verified: false, recruitments: [] };

    const recruitments = boxes.map((box) => {
      const heading = box.querySelector(':scope > h2.box-header');
      const codeEl = heading ? heading.querySelector('.code_label') : null;
      const code = codeEl ? textOf(codeEl).replace(/^\[|\]$/g, '') : null;
      const statusEl = heading ? heading.querySelector('.code_label.right-text') : null;
      const statusLabel = statusEl ? textOf(statusEl).replace(/^\(|\)$/g, '') : null;
      const headingClone = heading ? heading.cloneNode(true) : null;
      if (headingClone) headingClone.querySelectorAll('.code_label, .fa').forEach((el) => el.remove());
      const name = headingClone ? textOf(headingClone) : null;
      const yearEl = box.querySelector(':scope > div > small');
      const academicYear = yearEl ? textOf(yearEl) : null;
      const descriptionBody = box.querySelector('section.alt > div');
      const description = descriptionBody ? textOf(descriptionBody) : null;

      const applications = [...box.querySelectorAll('table.applications-table')].map((table) => {
        const programmeLink = table.querySelector('th a[href]');
        const codeSpan = programmeLink ? programmeLink.querySelector('.code_label') : null;
        const programmeCode = codeSpan ? textOf(codeSpan).replace(/^\[|\]$/g, '') : null;
        const programmeClone = programmeLink ? programmeLink.cloneNode(true) : null;
        if (programmeClone) programmeClone.querySelectorAll('.code_label').forEach((el) => el.remove());
        const programmeName = programmeClone ? textOf(programmeClone) : null;
        const programmeUrl = programmeLink ? programmeLink.href : null;

        const mainRow = table.querySelector('tr[id^="application_"]');
        if (!mainRow) return null;
        const applicationId = (mainRow.id.match(/^application_(\d+)$/) || [])[1] || null;
        const [turnCell, paymentCell, scoreCell, qualCell, decisionCell] = mainRow.querySelectorAll(':scope > td');

        const turnLabel = turnCell ? textOf(turnCell.querySelector('span')) : null;
        const dateRange = turnCell ? textOf(turnCell.querySelector('small')) : null;
        const criteriaLink = turnCell ? turnCell.querySelector('a[href*="/criteria/"]') : null;
        const historyLink = turnCell ? turnCell.querySelector('a[href*="/history/"]') : null;
        const prioMatch = turnCell ? textOf(turnCell).match(/Priorytet:\s*(\d+)/) : null;
        const priority = prioMatch ? parseInt(prioMatch[1], 10) : null;

        const payClone = paymentCell ? paymentCell.cloneNode(true) : null;
        if (payClone) payClone.querySelectorAll('small, span[class*="fa-"]').forEach((el) => el.remove());
        const payRaw = payClone ? textOf(payClone) : null;
        const amountMatch = payRaw && payRaw.match(/^([\d.,]+\s*zł)/);
        const paymentAmount = amountMatch ? amountMatch[1] : null;
        const paymentStatus = payRaw ? (amountMatch ? payRaw.slice(amountMatch[0].length).trim() : payRaw) : null;

        const score = scoreCell ? textOf(scoreCell.querySelector('strong')) : null;

        const positionMatch = qualCell ? textOf(qualCell).match(/Pozycja na liście:\s*(\d+)/) : null;
        const qualClone = qualCell ? qualCell.cloneNode(true) : null;
        if (qualClone) qualClone.querySelectorAll('small, span[class*="fa-"]').forEach((el) => el.remove());
        const qualificationStatus = qualClone ? textOf(qualClone) : null;

        const decisionDownload = decisionCell ? decisionCell.querySelector('a[href*="/decisions/download/"]') : null;
        const decisionsLink = decisionCell ? decisionCell.querySelector('a[href*="/decisions/"]:not([href*="download"])') : null;
        const lockSpan = decisionCell ? decisionCell.querySelector('span.fa-lock[title]') : null;
        const decisionClone = decisionCell ? decisionCell.cloneNode(true) : null;
        if (decisionClone) decisionClone.querySelectorAll('small, a, span[class*="fa-"]').forEach((el) => el.remove());
        const decisionStatus = decisionClone ? textOf(decisionClone) : null;

        let admissionDocument = null;
        const internalExams = [];
        let comment = null;
        let nextStepsUrl = null;
        const rows = [...table.querySelectorAll('tbody > tr')];
        const mainIdx = rows.indexOf(mainRow);
        for (let i = mainIdx + 1; i < rows.length; i++) {
          const tr = rows[i];
          if (tr.classList.contains('comment')) {
            const tds = tr.querySelectorAll(':scope > td');
            comment = tds[1] ? textOf(tds[1]) : null;
            continue;
          }
          const examAnchor = tr.querySelector(':scope > td.internal-exams');
          if (examAnchor) {
            const rowspan = parseInt(examAnchor.getAttribute('rowspan') || '1', 10);
            for (let j = 0; j < rowspan; j++) {
              const examRow = rows[i + j];
              if (!examRow) break;
              const tds = examRow.querySelectorAll(':scope > td');
              const nameTd = j === 0 ? tds[1] : tds[0];
              const scoreTd = j === 0 ? tds[2] : tds[1];
              const examScoreRaw = scoreTd ? textOf(scoreTd) : null;
              internalExams.push({
                name: nameTd ? textOf(nameTd) : null,
                score: examScoreRaw ? examScoreRaw.replace(/^Wynik:\s*/, '') : null,
              });
            }
            i += rowspan - 1;
            continue;
          }
          const nextLink = tr.querySelector('a[href*="/next/"]');
          if (nextLink) {
            nextStepsUrl = nextLink.href;
            continue;
          }
          const tds = tr.querySelectorAll(':scope > td');
          if (tds.length === 2 && !admissionDocument) {
            admissionDocument = { label: textOf(tds[0]), value: textOf(tds[1]) };
          }
        }

        return {
          applicationId,
          programmeCode,
          programmeName,
          programmeUrl,
          turnLabel,
          dateRange,
          priority,
          criteriaUrl: criteriaLink ? criteriaLink.href : null,
          historyUrl: historyLink ? historyLink.href : null,
          payment: { amount: paymentAmount, status: paymentStatus, icon: iconOf(paymentCell), tone: toneOfCell(paymentCell) },
          score,
          qualification: {
            status: qualificationStatus,
            icon: iconOf(qualCell),
            tone: toneOfCell(qualCell),
            position: positionMatch ? parseInt(positionMatch[1], 10) : null,
          },
          decision: {
            status: decisionStatus,
            icon: iconOf(decisionCell),
            tone: toneOfCell(decisionCell),
            downloadUrl: decisionDownload ? decisionDownload.href : null,
            decisionsUrl: decisionsLink ? decisionsLink.href : null,
            signedInfo: lockSpan ? lockSpan.getAttribute('title') : null,
          },
          admissionDocument,
          internalExams,
          comment,
          nextStepsUrl,
        };
      }).filter(Boolean);

      return { code, name, statusLabel, academicYear, description, applications };
    });

    return { supported: recruitments.some((r) => r.applications.length > 0), verified: true, recruitments };
  }

  // Verified live at /pl/profile/applications/<id>/next/ — the "Dokumenty i
  // dalsze kroki" page linked from each application row above (see
  // getApplications' nextStepsUrl). Two <table class="styled-table">:
  // "Dokumenty do pobrania" (blank templates to fill in by hand, one row per
  // document with pl/en download links) and "Lista dokumentów do złożenia"
  // (the actual checklist IRK/the faculty tracks, one row per required
  // document with its current status as a trailing "(status)" <small> — only
  // "(zatwierdzony)" [class "positive-color"] and "(nie dotyczy)" [no color
  // class] have been observed; other statuses a faculty might use (e.g.
  // "oczekuje"/"odrzucony") are UNVERIFIED and will just show through as
  // plain, uncoloured text).
  function getApplicationNextSteps(doc = document) {
    const tables = [...doc.querySelectorAll('table.styled-table')];
    const templatesTable = tables.find((t) => /Dokumenty do pobrania/i.test(textOf(t.querySelector('th'))));
    const checklistTable = tables.find((t) => /Lista dokumentów do złożenia/i.test(textOf(t.querySelector('th'))));
    if (!templatesTable && !checklistTable) return { supported: false, verified: false, templates: [], checklist: [] };

    const templates = templatesTable
      ? [...templatesTable.querySelectorAll('tbody > tr')].slice(1).map((tr) => {
          const nameCell = tr.querySelector('td');
          const links = [...tr.querySelectorAll('a[href]')].map((a) => {
            const cell = a.closest('td');
            const flag = cell ? cell.querySelector('img.flag') : null;
            return { url: a.href, language: flag ? flag.getAttribute('alt') : null };
          });
          return { name: nameCell ? textOf(nameCell) : null, links };
        }).filter((t) => t.name)
      : [];

    const checklist = checklistTable
      ? [...checklistTable.querySelectorAll('tbody > tr')].slice(1).map((tr) => {
          const small = tr.querySelector('small');
          const status = small ? textOf(small).replace(/^\(|\)$/g, '') : null;
          const positive = !!(small && small.classList.contains('positive-color'));
          const clone = tr.cloneNode(true);
          clone.querySelectorAll('small').forEach((s) => s.remove());
          return { name: textOf(clone), status, positive };
        }).filter((c) => c.name)
      : [];

    return { supported: templates.length > 0 || checklist.length > 0, verified: true, templates, checklist };
  }

  // Verified live at /pl/profile/ — the "Ustawienia konta" tab of "Moje
  // konto". Read-only, on purpose: this only surfaces what the page already
  // shows (photo status, identifying details, connected login method,
  // current notification preferences) — changing anything (e-mail,
  // password, deleting the account, notification settings, the account-
  // retention checkbox) stays a real link into IRK's own forms. USOS++
  // never submits an account change on the candidate's behalf.
  function getAccountProfile(doc = document) {
    const panel = doc.querySelector('.user-profile');
    if (!panel) return { supported: false, verified: false };

    const photoSection = panel.querySelector('section.user-panel');
    const photoImg = photoSection ? photoSection.querySelector('#user-photo') : null;
    const photoUrl = photoImg ? photoImg.getAttribute('src') : null;
    const photoStatus = photoSection
      ? [...photoSection.querySelectorAll('table tr')].map((tr) => {
          const tds = tr.querySelectorAll('td');
          if (tds.length < 2) return null;
          // "Proporcje" puts its tone class on the <td> itself; "Status"
          // puts it on a <span> nested inside instead — both checked here.
          const tone = toneOfCell(tds[1]) || toneOfCell(tds[1].querySelector('.positive-color, .negative-color, .red'));
          return { label: textOf(tds[0]), value: textOf(tds[1]), tone };
        }).filter(Boolean)
      : [];
    const actions = photoSection
      ? [...photoSection.querySelectorAll(':scope > div > a[href]')].map((a) => {
          const clone = a.cloneNode(true);
          clone.querySelectorAll('span').forEach((s) => s.remove());
          return { label: textOf(clone), url: a.href, destructive: toneOfCell(a) === 'negative' };
        })
      : [];

    const sections = [...panel.querySelectorAll('section.section-box')];
    const idSection = sections.find((s) => /Dane identyfikacyjne/i.test(textOf(s.querySelector('h2'))));
    let fullName = null;
    let pesel = null;
    let email = null;
    let irkId = null;
    if (idSection) {
      [...idSection.querySelectorAll(':scope > p')].forEach((p) => {
        const strong = p.querySelector('strong');
        const label = strong ? textOf(strong) : null;
        if (!label) return;
        const clone = p.cloneNode(true);
        const strongEl = clone.querySelector('strong');
        if (strongEl) strongEl.remove();
        const rest = textOf(clone);
        if (/^E-mail:?$/i.test(label)) email = rest;
        else if (/Identyfikator w systemie IRK:?/i.test(label)) irkId = rest;
        else {
          fullName = label;
          const m = rest && rest.match(/^\(([^)]+)\)$/);
          pesel = m ? m[1] : null;
        }
      });
    }

    const authSection = sections.find((s) => /Metody logowania/i.test(textOf(s.querySelector('h2'))));
    const authMethods = authSection
      ? [...authSection.querySelectorAll('table.auth-sources tbody > tr')].map((tr) => {
          const tds = tr.querySelectorAll('td');
          const method = tds[0] ? textOf(tds[0]) : null;
          return { method, detail: tds[1] ? textOf(tds[1]) : null };
        }).filter((m) => m.method)
      : [];

    const notifSection = sections.find((s) => /Ustawienia powiadomień/i.test(textOf(s.querySelector('h2'))));
    let notifications = null;
    if (notifSection) {
      const form = notifSection.querySelector('form');
      const langOption = notifSection.querySelector('#id_notification_language option[selected]');
      const msgCheckbox = notifSection.querySelector('#id_email_on_message');
      const notifCheckbox = notifSection.querySelector('#id_email_on_notification');
      notifications = {
        settingsUrl: form ? form.action : null,
        language: langOption ? textOf(langOption) : null,
        emailOnMessage: msgCheckbox ? msgCheckbox.hasAttribute('checked') : null,
        emailOnNotification: notifCheckbox ? notifCheckbox.hasAttribute('checked') : null,
      };
    }

    return {
      supported: !!(fullName || email),
      verified: true,
      photoUrl,
      photoStatus,
      actions,
      fullName,
      pesel,
      email,
      irkId,
      authMethods,
      notifications,
    };
  }

  // Verified live at /pl/profile/dataset/ — "Formularze osobowe", the hub
  // listing the (recruitment-scoped, /pl/profile/dataset/<slug>/<kind>/) forms
  // a candidate fills in: "Podstawowe dane osobowe", "Adres i dane
  // kontaktowe", "Zdjęcie", "Wykształcenie" (this last one only appears when
  // the recruitment actually requires it). <nav><ul class="dataset-list"> ->
  // one <li><a href> per form, each with a leading <span class="fa fa-...">
  // icon — its tone class (see toneOfCell) was always "neutral-color" on the
  // one account checked, so a filled-in/missing distinction (if IRK even
  // draws one this way) stays UNVERIFIED; still surfaced since toneOfCell
  // degrades to null harmlessly either way.
  function getPersonalFormsHub(doc = document) {
    const list = doc.querySelector('ul.dataset-list');
    if (!list) return { supported: false, verified: false, forms: [] };
    const forms = [...list.querySelectorAll(':scope > li > a[href]')].map((a) => {
      const iconEl = a.querySelector('span[class*="fa-"]');
      return {
        label: textOf(a),
        url: a.href,
        icon: iconEl ? [...iconEl.classList].find((c) => c.startsWith('fa-') && c !== 'fa') : null,
        tone: iconEl ? toneOfCell(iconEl) : null,
      };
    });
    return { supported: forms.length > 0, verified: true, forms };
  }

  // Shared by every /pl/profile/dataset/<slug>/<kind>/ form page (verified
  // live on all four: basic/contact/photo/education) — same
  // <form class="input-form [disabled]"><table class="input-table"><tr>
  // structure throughout, one row per field: <th><label> for the label (a
  // bare <th> with no <label>, e.g. a lone submit-button row or a checkbox
  // sub-field's row, is skipped/handled specially below), <td> holding
  // exactly one of: a text/date <input>, a <select>, a checkbox, a <textarea>
  // or (Zdjęcie only) a "Teraz: <a href>filename</a>" file link. A row shaped
  // like <tr><th colspan><h3>...</h3></th></tr> (Wykształcenie's "Szkoła
  // średnia" heading) is a section separator, not a field.
  function parseInputTableFields(form) {
    const rows = [...form.querySelectorAll('table.input-table > tbody > tr')];
    const fields = [];
    rows.forEach((tr) => {
      const sectionHeading = tr.querySelector('th[colspan] h3, th[colspan] h2');
      if (sectionHeading) {
        fields.push({ type: 'section', label: textOf(sectionHeading) });
        return;
      }
      const th = tr.querySelector('th');
      const td = tr.querySelector('td');
      if (!td) return;
      const label = th ? textOf(th.querySelector('label') || th) : null;
      const certTable = td.querySelector('table.certificate-table');
      if (certTable) {
        fields.push(parseCertificateCategory(label, certTable));
        return;
      }
      const select = td.querySelector('select');
      const fileLink = td.querySelector('.file a[href]');
      const checkbox = td.querySelector('input[type="checkbox"]');
      if (checkbox && !label) {
        // A sub-field checkbox (e.g. "Nie posiadam drugiego imienia",
        // "Adres korespondencyjny inny niż zamieszkania") carries its own
        // label inside the <td> instead of the row's <th>.
        const cbLabel = td.querySelector('label');
        fields.push({ type: 'checkbox', label: cbLabel ? textOf(cbLabel) : null, value: checkbox.hasAttribute('checked'), required: false });
        return;
      }
      if (!label) return;
      const required = !!td.querySelector('[required]');
      if (select) {
        const opt = select.querySelector('option[selected]');
        fields.push({ type: 'select', label, value: opt ? textOf(opt) : null, required });
      } else if (fileLink) {
        fields.push({ type: 'file', label, value: textOf(fileLink), required });
      } else if (checkbox) {
        fields.push({ type: 'checkbox', label, value: checkbox.hasAttribute('checked'), required });
      } else {
        const textarea = td.querySelector('textarea');
        const textInput = td.querySelector('input:not([type="checkbox"]):not([type="file"]):not([type="hidden"])');
        const value = textarea ? (textOf(textarea) || null) : (textInput ? textInput.getAttribute('value') : null);
        fields.push({ type: 'text', label, value, required });
      }
    });
    return fields;
  }

  // One already-added document inside a "Dokumenty" category on
  // /pl/profile/dataset/<slug>/education/ (e.g. a matura certificate) —
  // verified live at PWr (2026-09-14): <tr class="certificate"><th><div>
  // Name</div></th><td>[optional <a class="exam-scores">], then repeated
  // "Label:&nbsp;<strong>Value</strong><br>" pairs (some wrapped in an extra
  // <div>), then IRK's own "edytuj"/"usuń" links</td></tr>. Deliberately
  // walks the <td> to pull out the label/value pairs by hand rather than
  // regexing raw text, since the exact fields present vary by document type
  // (a matura has "Numer dokumentu"/"Data wydania"/..., others may not).
  function parseCertificateEntry(tr) {
    const nameEl = tr.querySelector('th > div');
    const name = nameEl ? textOf(nameEl) : null;
    const td = tr.querySelector('td');
    if (!td) return { name, fields: [], examScoresUrl: null, editUrl: null };
    const examScoresLink = td.querySelector('a.exam-scores');
    // The one other link IRK renders here ("edytuj") — everything but that
    // and "usuń" is stripped, which is also why "usuń" is never even read:
    // it's a plain GET link (verified live — class="delete", no confirm
    // step of its own visible in the markup) that a click on the REAL page
    // guards with a confirm() dialog; opening it the way our other links do
    // (window.open straight to the href) would skip that guard entirely and
    // could delete a real document. See renderFormularze in app.js — "edytuj"
    // and "Edytuj wyniki egzaminów" stay real navigations same as everywhere
    // else, "usuń" simply never appears.
    const editLink = [...td.querySelectorAll('a')].find((a) => a !== examScoresLink && !a.classList.contains('delete'));
    const clone = td.cloneNode(true);
    clone.querySelectorAll('a').forEach((a) => a.remove());
    const fields = [];
    let pendingLabel = '';
    function walk(nodes) {
      nodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'STRONG') {
          const fieldLabel = pendingLabel.replace(/:\s*$/, '').trim();
          if (fieldLabel) fields.push({ label: fieldLabel, value: textOf(node) });
          pendingLabel = '';
        } else if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'DIV' || node.tagName === 'SPAN')) {
          walk([...node.childNodes]);
        } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
          // Line break between pairs — nothing to collect.
        } else {
          pendingLabel += node.textContent || '';
        }
      });
    }
    walk([...clone.childNodes]);
    return { name, fields, examScoresUrl: examScoresLink ? examScoresLink.href : null, editUrl: editLink ? editLink.href : null };
  }

  // One "Dokumenty" category row on /pl/profile/dataset/<slug>/education/
  // (e.g. "Wykształcenie średnie", "Olimpiady i inne dokumenty..."), each its
  // own nested <table class="certificate-table"> — a short description row,
  // zero or more <tr class="certificate"> entries (see parseCertificateEntry),
  // and a trailing "Dodaj dokument" link.
  function parseCertificateCategory(label, table) {
    const rows = [...table.querySelectorAll(':scope > tbody > tr, :scope > tr')];
    const description = rows[0] ? textOf(rows[0]) : null;
    const documents = [...table.querySelectorAll('tr.certificate')].map(parseCertificateEntry);
    const addLink = [...table.querySelectorAll('a')].find((a) => /Dodaj dokument/i.test(textOf(a)));
    return { type: 'documents', label, description, documents, addUrl: addLink ? addLink.href : null };
  }

  // One /pl/profile/dataset/<slug>/<kind>/ page — read-only preview only.
  // IRK itself disables every input (form.input-form.disabled, verified live
  // on "Podstawowe dane osobowe" once a candidate already has an active
  // application — "Nie możesz edytować tego formularza, dopóki bierzesz
  // udział w procesie rekrutacyjnym.") for data it no longer lets the
  // candidate change; USOS++ mirrors that by never turning these fields into
  // an editable form of our own — see irk/app.js's renderFormularze, which
  // always links "Edytuj" out to this same real IRK page instead.
  function getPersonalForm(doc = document) {
    const form = [...doc.querySelectorAll('form')].find((f) => f.classList.contains('input-form'));
    if (!form) return { supported: false, verified: false };
    const lockNoticeEl = [...doc.querySelectorAll('#content p')].find((p) => /Nie możesz edytować/i.test(textOf(p)));
    return {
      supported: true,
      verified: true,
      locked: form.classList.contains('disabled'),
      lockReason: lockNoticeEl ? textOf(lockNoticeEl) : null,
      fields: parseInputTableFields(form),
    };
  }

  // The "Edytuj wyniki egzaminów" page a matura-type document's
  // examScoresUrl points to (see parseCertificateEntry) — verified live
  // (2026-09-14). Lists EVERY subject IRK recognizes (~50, most a candidate
  // never sat), one <tr class="exam_<ID> level_basic|advanced"> per
  // subject+level; the FIRST such row for a subject carries a
  // <td rowspan="1 or 2"><label>Subject name</label></td> that isn't
  // repeated on its "advanced" sibling row (same rowspan-anchor shape as
  // getApplications' internal-exams block), so the subject name is tracked
  // across rows rather than re-read on every one. Only rows whose
  // "<input class="exam-taken" ... checked>" is actually checked are kept —
  // otherwise this would surface ~50 empty rows of subjects nobody sat.
  function getExamScores(doc = document) {
    const rows = [...doc.querySelectorAll('tr[class*="exam_"]')];
    if (!rows.length) return { supported: false, verified: false, exams: [] };
    const exams = [];
    let currentSubject = null;
    rows.forEach((tr) => {
      const labelEl = tr.querySelector('td[rowspan] label');
      if (labelEl) currentSubject = textOf(labelEl);
      const takenCb = tr.querySelector('input.exam-taken');
      if (!takenCb || !takenCb.hasAttribute('checked')) return;
      const levelEl = tr.querySelector('th');
      const valueInput = tr.querySelector('input.exam-value');
      exams.push({
        subject: currentSubject,
        level: levelEl ? textOf(levelEl) : null,
        value: valueInput ? valueInput.getAttribute('value') : null,
      });
    });
    return { supported: exams.length > 0, verified: true, exams };
  }

  // Verified live at /pl/profile/payments/ — account-wide, like
  // getApplications/getAccountProfile. `.payment_summary > span` carries the
  // running total (its own "payment_balance_positive"/"...negative" class,
  // distinct from toneOfCell's "*-color"/"*-background" naming, so read
  // directly here rather than reused). One `<h3>Currency</h3>` +
  // `<table class="styled-table payment-details">` pair per currency IRK is
  // configured for (only PLN observed); each row's "Termin płatności" cell
  // packs two different deadlines together (payment deadline vs. the later
  // date a bank transfer must actually land by) — split apart the same way
  // getProgrammeDetail's parseRegisterBox splits headline from past-turns,
  // rather than left as one run-on string. Only the "opłacono" status label
  // has actually been observed (this account has no unpaid/refunded fee to
  // check against) — any other value UNVERIFIED and shown through as plain
  // text with no tone, same convention as getApplications' payment status.
  //
  // Deliberately NOT scraped: the "Szybka płatność: Autopay" quick-pay
  // widget and the bank transfer account details further down the page.
  // Showing a scraped bank account number carries real risk if a selector
  // ever mismatches (see the "Explicit permission required"/"Prohibited"
  // action categories — this project never reimplements anything that
  // moves money), so that whole area of the page stays behind a plain
  // "otwórz w IRK" link instead of being pulled into our own DOM.
  function getPayments(doc = document) {
    const summaryEl = doc.querySelector('.payment_summary');
    if (!summaryEl) return { supported: false, verified: false, currencies: [] };
    const balanceEl = summaryEl.querySelector('span');
    const totalBalance = balanceEl ? textOf(balanceEl) : null;
    const totalTone = balanceEl
      ? (/positive/.test(balanceEl.className) ? 'positive' : /negative/.test(balanceEl.className) ? 'negative' : null)
      : null;
    const priorityLink = [...doc.querySelectorAll('a')].find((a) => /Ustal priorytety/i.test(textOf(a)));
    // The subnav's own "Płatności" tab — its href IS this same page, used
    // as the "otwórz w IRK" target for the Autopay/bank-transfer area this
    // adapter deliberately doesn't scrape (see comment above).
    const selfLink = doc.querySelector('a[href*="/profile/payments/"]');
    const tables = [...doc.querySelectorAll('table.payment-details')];
    const currencies = tables.map((table) => {
      const heading = table.previousElementSibling;
      const currencyName = heading && heading.tagName === 'H3' ? textOf(heading) : null;
      const rows = [...table.querySelectorAll('tbody > tr')].map((tr) => {
        const tds = tr.querySelectorAll('td');
        const id = textOf(tds[0]);
        const descClone = tds[1] ? tds[1].cloneNode(true) : null;
        const programmeLink = descClone ? descClone.querySelector('a[href]') : null;
        const createdEl = descClone ? descClone.querySelector('small') : null;
        const created = createdEl ? textOf(createdEl).replace(/^Utworzono:\s*/, '') : null;
        if (descClone) descClone.querySelectorAll('ul, div').forEach((el) => el.remove());
        const description = descClone ? textOf(descClone) : null;
        const statusEl = tds[2] ? tds[2].querySelector('[title]') : null;
        const statusIconEl = tds[2] ? tds[2].querySelector('[class*="fa-"]') : null;
        const dueClone = tds[3] ? tds[3].cloneNode(true) : null;
        let dueDate = null;
        let dueBankDate = null;
        if (dueClone) {
          dueClone.querySelectorAll('.hint').forEach((el) => el.remove());
          const smallEl = dueClone.querySelector('small');
          dueBankDate = smallEl ? textOf(smallEl) : null;
          if (smallEl) smallEl.remove();
          dueDate = textOf(dueClone) || null;
        }
        const amountEl = tds[4] ? tds[4].querySelector('strong') : null;
        const amount = amountEl ? textOf(amountEl) : (tds[4] ? textOf(tds[4]) : null);
        return {
          id,
          description,
          programmeUrl: programmeLink ? programmeLink.href : null,
          created,
          status: statusEl ? statusEl.getAttribute('title') : null,
          statusIcon: statusIconEl ? [...statusIconEl.classList].find((c) => c.startsWith('fa-') && c !== 'fa') : null,
          dueDate,
          dueBankDate,
          amount,
          amountTone: toneOfCell(amountEl),
        };
      });
      return { name: currencyName, rows };
    });
    return {
      supported: currencies.some((c) => c.rows.length > 0),
      verified: true,
      totalBalance,
      totalTone,
      priorityUrl: priorityLink ? priorityLink.href : null,
      pageUrl: selfLink ? selfLink.href : null,
      currencies,
    };
  }

  // Verified live at /pl/profile/messages/ — account-wide, like
  // getApplications/getPayments. `table#messages-table > tbody > tr`, one row
  // per conversation: a checkbox column (skipped — bulk "Oznacz jako
  // przeczytane"/"Usuń wybrane" below the table are, deliberately, never
  // wired up here at all: marking read or deleting a conversation is a real
  // state change USOS++ never performs on the candidate's behalf), an icon
  // column whose legend (read straight off this same page) is:
  // fa-star = unread message in this conversation, fa-mail-reply = your own
  // message is the last one, fa-question-circle = started from the contact
  // form, fa-paperclip = has attachments. Only the first page (whatever the
  // account's default page length renders) is read — same scope as
  // getNews/getAktualnosci, no pagination follow-up.
  function getMessages(doc = document) {
    const table = doc.querySelector('table#messages-table');
    if (!table) return { supported: false, verified: false, conversations: [] };
    const conversations = [...table.querySelectorAll('tbody > tr')].map((tr) => {
      const tds = tr.querySelectorAll('td');
      const iconTd = tds[1];
      const icons = iconTd
        ? [...iconTd.querySelectorAll('span[class*="fa-"]')].map((s) => [...s.classList].find((c) => c.startsWith('fa-') && c !== 'fa'))
        : [];
      const interlocutor = tds[2] ? textOf(tds[2]) : null;
      const linkTd = tds[3];
      const link = linkTd ? linkTd.querySelector('a[href]') : null;
      const title = link ? textOf(link) : (linkTd ? textOf(linkTd) : null);
      const date = tds[4] ? textOf(tds[4]) : null;
      return {
        interlocutor,
        title,
        url: link ? link.href : null,
        date,
        unread: icons.includes('fa-star'),
        lastFromYou: icons.includes('fa-mail-reply'),
        fromContactForm: icons.includes('fa-question-circle'),
        hasAttachments: icons.includes('fa-paperclip'),
      };
    }).filter((c) => c.title);
    return { supported: conversations.length > 0, verified: true, conversations };
  }

  // One conversation's own page (a getMessages row's `url`) — verified live.
  // `#conversation > div.message` holds BOTH the real, already-sent messages
  // AND (as its very last child) the "Twoja odpowiedź" reply box — the two
  // are told apart by `.text.tinymce-content` (only real messages have it;
  // the reply box's own `.text` wraps a `<form>` instead), so filtering on
  // that class is also what keeps this function from ever touching the
  // reply `<form>`'s action/fields at all. Message bodies go through the
  // same `USOSPP_CORE_SANITIZE.sanitizeHtml` already used for Aktualności/
  // programme descriptions — same untrusted-but-fetched-not-executed HTML.
  function getMessageThread(doc = document) {
    const conv = doc.querySelector('#conversation');
    if (!conv) return { supported: false, verified: false, messages: [] };
    const messageDivs = [...conv.querySelectorAll(':scope > div.message')].filter((m) => m.querySelector('.text.tinymce-content'));
    const messages = messageDivs.map((m) => {
      const senderNameEl = m.querySelector('.sender > div');
      const senderName = senderNameEl ? textOf(senderNameEl) : null;
      const roleEl = m.querySelector('.sender small strong');
      const role = roleEl ? textOf(roleEl) : null;
      const emailEl = m.querySelector('.sender a[href^="mailto:"]');
      const email = emailEl ? textOf(emailEl) : null;
      const textDiv = m.querySelector('.text.tinymce-content');
      const dateEl = textDiv.querySelector('small');
      const date = dateEl ? textOf(dateEl) : null;
      const clone = textDiv.cloneNode(true);
      // Read attachments (each with its own nested size <small>) BEFORE
      // stripping <small> elements for the date below — doing it in the
      // other order wiped the size text out along with the date.
      const attachmentsUl = clone.querySelector('ul.attachments');
      const attachments = attachmentsUl
        ? [...attachmentsUl.querySelectorAll('a[href]')].map((a) => {
            const sizeEl = a.parentElement.querySelector('small');
            return { url: a.href, name: textOf(a), size: sizeEl ? textOf(sizeEl).replace(/^\(|\)$/g, '') : null };
          })
        : [];
      if (attachmentsUl) attachmentsUl.remove();
      // Only the date lives as a direct-child <small> of .text.tinymce-content.
      const dateSmall = clone.querySelector(':scope > small');
      if (dateSmall) dateSmall.remove();
      const bodyHtml = window.USOSPP_CORE_SANITIZE.sanitizeHtml([...clone.childNodes], doc);
      return { senderName, role, email, date, bodyHtml, attachments };
    });
    return { supported: messages.length > 0, verified: true, messages };
  }

  window.USOSPP_IRK_ADAPTERS = {
    recruitmentSlug,
    recruitmentLabel,
    looksLikeOfferPage,
    getOfferList,
    getProgrammeDetail,
    getFieldVariants,
    getNews,
    getRecruitmentOptions,
    getUnitsList,
    getApplications,
    getApplicationNextSteps,
    getAccountProfile,
    getPersonalFormsHub,
    getPersonalForm,
    getExamScores,
    getPayments,
    getMessages,
    getMessageThread,
    isLoggedIn,
    getLoginUrl,
  };
})();

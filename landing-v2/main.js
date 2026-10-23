// USOS++ landing-v2 — tylko progresywne usprawnienia, strona działa bez JS.
(function () {
  'use strict';

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* brak matchMedia */ }

  // ---------- Menu mobilne ----------
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Zamknij menu' : 'Otwórz menu');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Otwórz menu');
      }
    });
  }

  // ---------- Przełącznik motywu (ten sam klucz co landing v1) ----------
  var root = document.documentElement;
  var themeBtn = document.querySelector('.theme-toggle');
  function themeLabel(t) {
    return t === 'dark' ? 'Przełącz na tryb jasny' : 'Przełącz na tryb ciemny';
  }
  if (themeBtn) {
    themeBtn.setAttribute('aria-pressed', String(root.dataset.theme === 'dark'));
    themeBtn.setAttribute('aria-label', themeLabel(root.dataset.theme));
    themeBtn.addEventListener('click', function () {
      var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('usospp-landing-theme', next); } catch (e) { /* tryb prywatny */ }
      themeBtn.setAttribute('aria-pressed', String(next === 'dark'));
      themeBtn.setAttribute('aria-label', themeLabel(next));
    });
  }

  // ---------- Reveal on scroll (Blur Fade) ----------
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  }

  // ---------- Rotator słów w hero (Word Rotate) ----------
  var words = [
    'oceny i średnia',
    'plan zajęć',
    'płatności',
    'egzaminy',
    'mapa kampusu',
    'aktualności'
  ];
  var wordEl = document.getElementById('word-rotate');
  if (wordEl && !reduceMotion) {
    var idx = 0;
    setInterval(function () {
      wordEl.classList.add('swap');
      setTimeout(function () {
        idx = (idx + 1) % words.length;
        wordEl.textContent = words[idx];
        wordEl.classList.remove('swap');
      }, 250);
    }, 2600);
  }

  // ---------- Tickery liczb (Number Ticker) ----------
  var tickers = document.querySelectorAll('.ticker[data-count]');
  function runTicker(el) {
    var target = parseInt(el.getAttribute('data-count'), 10);
    if (isNaN(target) || reduceMotion) {
      el.textContent = String(isNaN(target) ? 0 : target);
      return;
    }
    var start = null;
    var dur = 900;
    function frame(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  if ('IntersectionObserver' in window) {
    var tio = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          runTicker(entry.target);
          tio.unobserve(entry.target);
        }
      });
    }, { threshold: 0.4 });
    tickers.forEach(function (el) { tio.observe(el); });
  } else {
    tickers.forEach(runTicker);
  }

  // ---------- Spotlight kart + glare (Magic Card) ----------
  function bindSpotlight(scope) {
    scope.addEventListener('pointermove', function (e) {
      var card = e.target.closest && e.target.closest('.magic-card, [data-glare]');
      if (!card) return;
      var rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', String(e.clientX - rect.left) + 'px');
      card.style.setProperty('--my', String(e.clientY - rect.top) + 'px');
    });
  }
  if (!reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    bindSpotlight(document);
  }

  // ---------- Aktualny rok w stopce ----------
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();

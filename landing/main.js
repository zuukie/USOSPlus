// USOS++ landing — tylko progresywne usprawnienia, strona działa bez JS.
(function () {
  'use strict';

  // Menu mobilne
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

  // Przełącznik motywu jasny/ciemny (startowy motyw ustawia skrypt w <head>)
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

  // Aktualny rok w stopce
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();

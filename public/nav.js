(function () {
  // Two header conventions in the repo:
  //   newer: <header class="site-header"> + .site-nav + .site-actions
  //   older: <header class="site"> with .left>nav + .right
  // nav.js handles both so every public page has a working mobile menu.
  var header = document.querySelector('header.site-header, header.site');
  if (!header) return;

  var isLegacy = header.classList.contains('site') && !header.classList.contains('site-header');
  var nav = isLegacy ? header.querySelector('.left nav, nav') : header.querySelector('.site-nav');
  var actions = isLegacy ? header.querySelector('.right') : header.querySelector('.site-actions');
  if (!nav || !actions) return;
  if (header.querySelector('.nav-toggle')) return;

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav-toggle';
  btn.setAttribute('aria-label', 'Toggle navigation');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span></span><span></span><span></span>';

  if (!nav.id) nav.id = 'site-nav';
  btn.setAttribute('aria-controls', nav.id);
  actions.insertBefore(btn, actions.firstChild);

  function setOpen(open) {
    btn.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
    document.body.classList.toggle('nav-open', open);
  }
  btn.addEventListener('click', function () {
    setOpen(btn.getAttribute('aria-expanded') !== 'true');
  });
  nav.addEventListener('click', function (e) {
    if (e.target && e.target.tagName === 'A') setOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) setOpen(false);
  });
  window.addEventListener('resize', function () {
    if (window.innerWidth > 920 && nav.classList.contains('is-open')) setOpen(false);
  });
})();

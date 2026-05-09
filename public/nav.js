(function () {
  var header = document.querySelector('header.site-header');
  if (!header) return;
  var nav = header.querySelector('.site-nav');
  var actions = header.querySelector('.site-actions');
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

// Builds the categorized left rail, on-this-page TOC, breadcrumbs, and
// prev/next pagination from /docs-manifest.json. The shell is purely
// additive — page content is preserved as-is and wrapped in a grid.
(function () {
  'use strict';

  var MANIFEST_URL = '/docs-manifest.json';
  var here = (location.pathname || '/').replace(/\.html$/, '').replace(/\/index$/, '/');
  if (here !== '/' && here.endsWith('/')) here = here.slice(0, -1);

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (children) for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (typeof c === 'string') n.appendChild(document.createTextNode(c));
      else if (c) n.appendChild(c);
    }
    return n;
  }

  function buildBreadcrumbs(manifest) {
    var trail = [{ url: '/', label: 'kolm.ai' }, { url: '/docs', label: 'docs' }];
    // Find which category contains the current page; if found, add it.
    for (var i = 0; i < manifest.categories.length; i++) {
      var cat = manifest.categories[i];
      var hit = cat.pages.find(function (p) {
        return p.url.replace(/\/$/, '') === here;
      });
      if (hit) {
        trail.push({ url: '#', label: cat.title.toLowerCase() });
        trail.push({ url: here, label: hit.label });
        break;
      }
    }
    var div = el('div', { class: 'ds-crumbs' });
    trail.forEach(function (t, idx) {
      if (idx > 0) div.appendChild(el('span', { class: 'sep' }, ['/']));
      if (t.url === '#') {
        div.appendChild(el('span', null, [t.label]));
      } else {
        div.appendChild(el('a', { href: t.url }, [t.label]));
      }
    });
    return div;
  }

  function buildRail(manifest) {
    var rail = el('aside', { class: 'ds-rail', 'aria-label': 'Documentation navigation' });

    // Search box (filter the rail in place)
    var searchWrap = el('div', { class: 'ds-rail-search' });
    var searchInput = el('input', {
      type: 'search',
      placeholder: 'Filter docs...',
      'aria-label': 'Filter documentation navigation',
    });
    searchWrap.appendChild(searchInput);
    rail.appendChild(searchWrap);

    manifest.categories.forEach(function (cat) {
      var box = el('div', { class: 'ds-cat', 'data-cat': cat.id });
      box.appendChild(el('h4', { class: 'ds-cat-h' }, [cat.title]));

      // CLI category: primary verbs pinned at top
      var primarySet = null;
      if (cat.primary && cat.primary.length) {
        primarySet = new Set(cat.primary.map(function (v) { return cat.id === 'cli' ? '/docs/cli/' + v : v; }));
        var ulPrim = el('ul');
        cat.primary.forEach(function (v) {
          var url = cat.id === 'cli' ? '/docs/cli/' + v : v;
          var p = cat.pages.find(function (pg) { return pg.url === url; });
          if (!p) return;
          var label = p.label || ('kolm ' + v);
          var li = el('li');
          li.appendChild(el('a', { href: p.url, 'data-label': label.toLowerCase() }, [label]));
          ulPrim.appendChild(li);
        });
        box.appendChild(ulPrim);
        box.appendChild(el('div', { class: 'ds-cat-sub' }, ['All commands']));
      }

      var ul = el('ul');
      cat.pages.forEach(function (p) {
        if (primarySet && primarySet.has(p.url)) return;
        var li = el('li');
        li.appendChild(el('a', { href: p.url, 'data-label': (p.label || p.url).toLowerCase() }, [p.label || p.url]));
        ul.appendChild(li);
      });
      box.appendChild(ul);
      box.appendChild(el('div', { class: 'ds-cat-empty' }, ['No matches']));
      rail.appendChild(box);
    });

    // Active highlight
    var hereNorm = here.replace(/\/$/, '');
    rail.querySelectorAll('a').forEach(function (a) {
      var href = (a.getAttribute('href') || '').replace(/\.html$/, '').replace(/\/$/, '');
      if (href === hereNorm) a.classList.add('is-active');
    });

    // Search filter
    searchInput.addEventListener('input', function () {
      var q = searchInput.value.toLowerCase().trim();
      rail.querySelectorAll('.ds-cat').forEach(function (cat) {
        var visible = 0;
        cat.querySelectorAll('a').forEach(function (a) {
          var label = a.getAttribute('data-label') || '';
          var match = !q || label.indexOf(q) >= 0;
          a.setAttribute('data-hidden', match ? '0' : '1');
          if (match) visible++;
        });
        var empty = cat.querySelector('.ds-cat-empty');
        if (empty) empty.style.display = (q && visible === 0) ? 'block' : 'none';
      });
    });

    return rail;
  }

  function buildToc(content) {
    var headings = content.querySelectorAll('h2[id], h3[id]');
    if (headings.length < 2) return null;
    var toc = el('aside', { class: 'ds-toc', 'aria-label': 'On this page' });
    toc.appendChild(el('h4', { class: 'ds-toc-h' }, ['On this page']));
    var ul = el('ul');
    headings.forEach(function (h) {
      var li = el('li');
      var a = el('a', { href: '#' + h.id }, [h.textContent || h.id]);
      if (h.tagName === 'H3') a.classList.add('is-h3');
      li.appendChild(a);
      ul.appendChild(li);
    });
    toc.appendChild(ul);
    // Scroll-spy
    var spy = function () {
      var y = window.scrollY + 100;
      var active = null;
      headings.forEach(function (h) {
        if (h.offsetTop <= y) active = h;
      });
      toc.querySelectorAll('a').forEach(function (a) {
        a.classList.toggle('is-active', active && a.getAttribute('href') === '#' + active.id);
      });
    };
    window.addEventListener('scroll', spy, { passive: true });
    setTimeout(spy, 50);
    return toc;
  }

  function buildPager(manifest) {
    // Flatten into a linear sequence honoring category order.
    var seq = [];
    manifest.categories.forEach(function (cat) {
      cat.pages.forEach(function (p) { seq.push(p); });
    });
    var idx = seq.findIndex(function (p) { return p.url.replace(/\/$/, '') === here; });
    if (idx < 0) return null;
    var prev = idx > 0 ? seq[idx - 1] : null;
    var next = idx < seq.length - 1 ? seq[idx + 1] : null;
    if (!prev && !next) return null;
    var div = el('nav', { class: 'ds-pager', 'aria-label': 'Documentation pagination' });
    if (prev) {
      var pa = el('a', { href: prev.url, class: 'prev' });
      pa.appendChild(el('div', { class: 'dir' }, ['<- Previous']));
      pa.appendChild(el('span', { class: 'label' }, [prev.label]));
      div.appendChild(pa);
    } else {
      div.appendChild(el('div'));
    }
    if (next) {
      var na = el('a', { href: next.url, class: 'next' });
      na.appendChild(el('div', { class: 'dir' }, ['Next ->']));
      na.appendChild(el('span', { class: 'label' }, [next.label]));
      div.appendChild(na);
    }
    return div;
  }

  function mount(manifest) {
    var main = document.querySelector('main#main') || document.querySelector('main');
    if (!main) return;

    // Wrap main's existing content. Keep original nodes intact so any
    // page-specific styles and scripts continue to work.
    var content = el('article', { class: 'ds-content' });
    while (main.firstChild) content.appendChild(main.firstChild);

    // Prepend breadcrumbs inside the content column for in-flow position.
    content.insertBefore(buildBreadcrumbs(manifest), content.firstChild);

    var layout = el('div', { class: 'ds-layout' });
    layout.appendChild(buildRail(manifest));
    layout.appendChild(content);
    var toc = buildToc(content);
    if (toc) layout.appendChild(toc);
    else {
      // Two-col layout when there's no on-this-page TOC.
      layout.style.gridTemplateColumns = 'var(--ds-rail-w) minmax(0, 1fr)';
    }

    // Mobile drawer toggle (above the layout, visible on small viewports).
    var toggle = el('button', { class: 'ds-rail-toggle', type: 'button', 'aria-controls': 'ds-rail' }, ['Menu']);
    var rail = layout.querySelector('.ds-rail');
    if (rail) rail.id = 'ds-rail';
    toggle.addEventListener('click', function () {
      if (rail) rail.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', rail && rail.classList.contains('is-open') ? 'true' : 'false');
    });

    main.appendChild(toggle);
    main.appendChild(layout);

    // Pager at the end of content.
    var pager = buildPager(manifest);
    if (pager) content.appendChild(pager);
  }

  function load() {
    // Skip the docs hub itself — it has a curated card grid.
    if (here === '/docs' || here === '/docs/') return;
    // Skip JSON / md files served as docs/
    if (/\.(json|md|txt)$/.test(location.pathname)) return;

    fetch(MANIFEST_URL, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) { if (m) mount(m); })
      .catch(function () { /* shell is additive; failure is silent */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();

// Magnetic CTAs, scroll-reveal, tilt cards, copy-to-clipboard.
// All motion gated on prefers-reduced-motion + pointer:fine.

(function () {
  'use strict';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;

  // 1. Scroll reveal — only animate on actual user scroll.
  // Default state is visible (CSS), so no-JS clients, crawlers, screenshot
  // tools (Playwright fullPage, archive.org, etc.) and direct-anchor loads
  // all see content. Only after the user starts scrolling do we install
  // the prep/reveal animation on still-below-fold elements. A 1500ms safety
  // timer also unprepes any prepped element that never intersected — so a
  // user who scrolls and then keeps scrolling fast can't strand sections.
  if (!reduce && 'IntersectionObserver' in window) {
    let armed = false;
    const arm = () => {
      if (armed) return;
      armed = true;
      window.removeEventListener('scroll', arm);
      window.removeEventListener('wheel', arm);
      window.removeEventListener('touchstart', arm);
      window.removeEventListener('keydown', arm);
      const vh = window.innerHeight || 800;
      const foldLine = vh + 80;
      const prepped = [];
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('fr-in');
            io.unobserve(e.target);
          }
        }
      }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
      document.querySelectorAll('.fr-reveal').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.top >= foldLine) {
          el.classList.add('fr-reveal--prep');
          prepped.push(el);
          io.observe(el);
        }
      });
      setTimeout(() => {
        prepped.forEach((el) => el.classList.add('fr-in'));
      }, 1500);
    };
    window.addEventListener('scroll', arm, { once: true, passive: true });
    window.addEventListener('wheel', arm, { once: true, passive: true });
    window.addEventListener('touchstart', arm, { once: true, passive: true });
    window.addEventListener('keydown', arm, { once: true });
  }

  // 2. Magnetic CTAs (pointer-tracking, subtle)
  if (!reduce && fine) {
    document.querySelectorAll('[data-fr-magnetic]').forEach((btn) => {
      btn.addEventListener('pointermove', (ev) => {
        const r = btn.getBoundingClientRect();
        const x = ev.clientX - r.left - r.width / 2;
        const y = ev.clientY - r.top - r.height / 2;
        btn.style.transform = 'translate(' + (x * 0.18) + 'px, ' + (y * 0.18) + 'px)';
      });
      btn.addEventListener('pointerleave', () => { btn.style.transform = ''; });
    });
  }

  // 3. 3D tilt cards
  if (!reduce && fine) {
    document.querySelectorAll('[data-fr-tilt]').forEach((card) => {
      const max = Number(card.dataset.frTilt) || 6;
      card.addEventListener('pointermove', (ev) => {
        const r = card.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width - 0.5;
        const y = (ev.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'perspective(900px) rotateY(' + (x * max) + 'deg) rotateX(' + (-y * max) + 'deg)';
      });
      card.addEventListener('pointerleave', () => { card.style.transform = ''; });
    });
  }

  // 4. CLI copy buttons (auto-inject)
  document.querySelectorAll('.fr-cli').forEach((cli) => {
    if (cli.querySelector('.fr-cli__copy')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fr-cli__copy';
    btn.textContent = 'copy';
    btn.setAttribute('aria-label', 'Copy CLI command');
    cli.appendChild(btn);
    btn.addEventListener('click', async () => {
      const txt = (cli.textContent || '').replace(/^copy|copy$/g, '').trim();
      try {
        await navigator.clipboard.writeText(txt);
        btn.textContent = 'copied';
        setTimeout(() => { btn.textContent = 'copy'; }, 1400);
      } catch (_) {
        btn.textContent = 'select+copy';
      }
    });
  });

  // 5. Parallax (rAF-batched, scroll-tied)
  if (!reduce && fine) {
    const items = Array.from(document.querySelectorAll('[data-fr-parallax]'));
    if (items.length) {
      let raf = 0;
      const update = () => {
        const vh = window.innerHeight;
        for (const el of items) {
          const r = el.getBoundingClientRect();
          const center = r.top + r.height / 2 - vh / 2;
          const k = Math.max(-1, Math.min(1, center / vh)) * -1;
          const amt = Number(el.dataset.frParallax) || 12;
          el.style.transform = 'translateY(' + (k * amt) + 'px)';
        }
        raf = 0;
      };
      window.addEventListener('scroll', () => {
        if (!raf) raf = requestAnimationFrame(update);
      }, { passive: true });
      update();
    }
  }

  // 6. Bit-width matrix interactive filtering (forge page)
  document.querySelectorAll('[data-fr-filter]').forEach((root) => {
    const target = root.dataset.frFilter;
    const cells = document.querySelectorAll('[data-fr-tag]');
    root.addEventListener('click', (ev) => {
      const tag = ev.target && ev.target.dataset && ev.target.dataset.frTag;
      if (!tag) return;
      root.querySelectorAll('[data-fr-tag]').forEach((c) => c.classList.remove('fr-in'));
      ev.target.classList.add('fr-in');
      cells.forEach((c) => {
        const cTag = c.dataset.frTag;
        c.style.display = (tag === 'all' || cTag === tag) ? '' : 'none';
      });
    });
  });
})();

// kolm-cinema.js - THE ARTIFACT CINEMA. The signed-report hero artifact boots
// like an instrument the first time it enters the viewport: the document
// chrome draws in, the log lines reveal one by one, the severity graticule
// fills left-to-right with a settle, the signature strip wipes on like ink
// being drawn, and the offline check stamps in with one phosphor flash. It
// plays ONCE (~5-6.5s), then rests in the exact static final state with a
// whisper-slow scan shimmer. Choreography lives in CSS (ART DEPTH v3.1 layer
// of kolm-2026.css); this script only assigns beat indices and classes.
//
// CONTRACTS (binding):
// - Every string stays in the DOM at full fidelity at all times. Reveal is
//   opacity / transform / clip-path on EXISTING containers; no text mutation,
//   no wrapping, no touching the signature strings.
// - The artifact's outer geometry never changes (CLS 0).
// - prefers-reduced-motion: the card simply appears in its final state.
// - No JS / no IntersectionObserver: the static card, unchanged.
// Mounted with defer on / and /report only. Zero dependencies.
(function () {
  'use strict';
  try {
    if (!window.matchMedia || !('IntersectionObserver' in window)) return;
    var mq = matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) return; // static final state, immediately
    var rep = document.querySelector('.hero .artifact .rep');
    if (!rep) return;

    // Stage the existing containers in document order, with grouped beats:
    // log lines, then graticule segments, then the signature strip, then the
    // stamp. The index feeds the CSS animation-delay; text is never touched.
    var lines = rep.querySelectorAll('.rep__head, .sev, .find, .find__more, .register__row');
    var segs = rep.querySelectorAll('.sev__bar i');
    var sigs = rep.querySelectorAll('.rep__sig .sig__row');
    if (!sigs.length) sigs = rep.querySelectorAll('[translate="no"]'); // /report machine footer
    var stamps = rep.querySelectorAll('.sig__ok');
    var ci = 0;
    function stage(list, role, gap) {
      ci += gap; // a held beat between groups - the instrument pauses, then continues
      for (var i = 0; i < list.length; i++) {
        list[i].setAttribute('data-cine', role);
        list[i].style.setProperty('--ci', String(ci++));
      }
    }
    stage(lines, 'line', 0);
    stage(segs, 'seg', 2);
    stage(sigs, 'sig', 2);
    stage(stamps, 'stamp', 2);
    if (!ci) return;

    // arm: the pre-boot state (opacity 0) exists ONLY under html.cine-armed,
    // so a parse error or missing file can never strand the card hidden
    document.documentElement.classList.add('cine-armed');
    rep.classList.add('cine');

    var played = false;
    var total = 500 + (ci - 1) * 240 + 1500; // last beat delay + longest tail
    function finish() {
      rep.classList.remove('cine-play');
      rep.classList.remove('cine');
      rep.classList.add('cine-done'); // the idle scan shimmer keys off this
    }
    function play() {
      if (played) return;
      played = true;
      rep.classList.add('cine-play');
      setTimeout(finish, total);
    }
    var io = new IntersectionObserver(function (es) {
      for (var i = 0; i < es.length; i++) {
        if (es[i].isIntersecting) { play(); io.disconnect(); break; }
      }
    }, { threshold: 0.3 });
    io.observe(rep);

    // failsafe: never leave the card in the pre-boot state forever
    setTimeout(function () { if (!played) { played = true; io.disconnect(); finish(); } }, 15000);

    // mid-flight reduced-motion switch: settle instantly into the final state
    var onchange = function () {
      if (!mq.matches) return;
      played = true; io.disconnect(); finish();
    };
    if (mq.addEventListener) mq.addEventListener('change', onchange);
  } catch (e) { /* fail open: the static card is the fallback */ }
})();

/* kolm-svg.js — W598 visual language: inline SVG icons + semantic illustrations.
   - Icons: Lucide-style 24x24, 1.5px stroke, currentColor. Use anywhere text + icon.
   - Illustrations: animated semantic diagrams that show what kolm actually does.
   Auto-renders elements with data-kolm-icon or data-kolm-illustration on DOMContentLoaded.
   Also exposes window.kolmIcon(name) and window.kolmIllustration(name) for programmatic use. */
(function () {
  'use strict';

  // ---- ICONS — 24x24 viewBox, 1.5 stroke, currentColor ----
  // Pure paths so they recolor with the surrounding text color.
  var ICON_PATHS = {
    gateway:       '<path d="M3 6h4M3 12h4M3 18h4"/><path d="M21 8h-4M21 12h-4M21 16h-4"/><rect x="8" y="6" width="8" height="12" rx="2"/><path d="M11 10v4M13 10v4"/>',
    capture:       '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2"/>',
    compile:       '<path d="M3 7l9-4 9 4M3 7v10l9 4M3 7l9 4M21 7l-9 4M12 11v10M21 7v10"/>',
    distill:       '<path d="M3 4h18l-7 9v6l-4 2v-8z"/>',
    deploy:        '<path d="M12 3l4 4M12 3l-4 4M12 3v12"/><path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/>',
    runtime:       '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9z"/><path d="M3 9v2M3 13v2M21 9v2M21 13v2M9 3h2M13 3h2M9 21h2M13 21h2"/>',
    device:        '<rect x="6" y="2" width="12" height="20" rx="2"/><circle cx="12" cy="18" r="1"/>',
    cloud:         '<path d="M17 18a4 4 0 000-8 6 6 0 00-11.5 1.5A4 4 0 006 18z"/>',
    shield:        '<path d="M12 2l8 3v7c0 5-4 8-8 10-4-2-8-5-8-10V5z"/><path d="M9 12l2 2 4-4"/>',
    check:         '<path d="M5 12l5 5L20 7"/>',
    alert:         '<path d="M12 3L2 20h20zM12 10v5M12 18v.5"/>',
    info:          '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 8v.5"/>',
    lock:          '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
    key:           '<circle cx="8" cy="14" r="4"/><path d="M11 12l9-9M16 7l3 3M19 4l2 2"/>',
    chart:         '<path d="M4 19V5M4 19h16"/><path d="M8 15l3-4 3 2 5-6"/>',
    table:         '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M9 5v14M15 5v14"/>',
    code:          '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6M14 4l-4 16"/>',
    file:          '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
    'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
    'arrow-up-right':'<path d="M7 17L17 7M9 7h8v8"/>',
    'external-link':'<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
    copy:          '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
    download:      '<path d="M12 3v12M7 11l5 5 5-5M5 19h14"/>',
    play:          '<path d="M6 4l14 8-14 8z"/>',
    pause:         '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
    search:        '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
    settings:      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
    user:          '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
    terminal:      '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M13 14h4"/>',
    spark:         '<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
    'chevron-right':'<path d="M9 6l6 6-6 6"/>',
    'chevron-down':'<path d="M6 9l6 6 6-6"/>',
    bolt:          '<path d="M13 2L4 14h7l-2 8 9-12h-7z"/>',
    refresh:       '<path d="M21 12a9 9 0 11-3-6.7M21 5v5h-5"/>',
    eye:           '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    layers:        '<path d="M12 2l10 6-10 6L2 8z"/><path d="M2 16l10 6 10-6M2 12l10 6 10-6"/>'
  };

  function buildIcon(name, opts) {
    opts = opts || {};
    var paths = ICON_PATHS[name];
    if (!paths) return '';
    var size = opts.size || 18;
    var stroke = opts.stroke || 1.5;
    var aria = opts.label ? ('aria-label="' + opts.label + '" role="img"') : 'aria-hidden="true" focusable="false"';
    var cls = opts.class ? (' class="' + opts.class + '"') : ' class="kolm-icon"';
    return '<svg' + cls + ' width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + stroke + '" stroke-linecap="round" stroke-linejoin="round" ' + aria + '>' + paths + '</svg>';
  }

  // ---- ILLUSTRATIONS — animated semantic SVG diagrams ----
  // Each is a self-contained SVG with CSS animations defined in kolm-svg.css.
  // currentColor + var(--brand-primary) for theming.

  function illGatewayRouter() {
    // Three provider sources fan into a central kolm router, which fans out
    // to one signed kolm output. Animated dots travel the paths.
    return '<svg class="kolm-ill kolm-ill--gateway" viewBox="0 0 480 320" role="img" aria-label="Gateway routes provider APIs through one kolm endpoint">' +
      '<defs>' +
      '<linearGradient id="kg-stroke" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="currentColor" stop-opacity=".25"/><stop offset="1" stop-color="currentColor" stop-opacity=".55"/></linearGradient>' +
      '</defs>' +
      // provider node 1 — OpenAI
      '<g class="kolm-ill-node kolm-ill-node--src" transform="translate(40,60)"><rect width="120" height="44" rx="10" fill="none" stroke="currentColor" stroke-opacity=".3"/><text x="60" y="27" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="currentColor" fill-opacity=".8">openai.com</text></g>' +
      // provider node 2 — Anthropic
      '<g class="kolm-ill-node kolm-ill-node--src" transform="translate(40,140)"><rect width="120" height="44" rx="10" fill="none" stroke="currentColor" stroke-opacity=".3"/><text x="60" y="27" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="currentColor" fill-opacity=".8">anthropic.com</text></g>' +
      // provider node 3 — local
      '<g class="kolm-ill-node kolm-ill-node--src" transform="translate(40,220)"><rect width="120" height="44" rx="10" fill="none" stroke="currentColor" stroke-opacity=".3"/><text x="60" y="27" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="currentColor" fill-opacity=".8">localhost</text></g>' +
      // connection lines into router
      '<path d="M160,82 C 200,82 200,160 220,160" stroke="url(#kg-stroke)" fill="none" stroke-width="1.5"/>' +
      '<path d="M160,162 C 200,162 200,160 220,160" stroke="url(#kg-stroke)" fill="none" stroke-width="1.5"/>' +
      '<path d="M160,242 C 200,242 200,160 220,160" stroke="url(#kg-stroke)" fill="none" stroke-width="1.5"/>' +
      // router (kolm core)
      '<g class="kolm-ill-router" transform="translate(220,128)">' +
        '<rect width="80" height="64" rx="12" fill="var(--brand-primary)" fill-opacity=".06" stroke="var(--brand-primary)" stroke-opacity=".55"/>' +
        '<text x="40" y="28" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" font-weight="600" fill="var(--brand-primary)">kolm</text>' +
        '<text x="40" y="46" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity=".7">:7402</text>' +
      '</g>' +
      // output line
      '<path d="M300,160 C 340,160 340,160 400,160" stroke="url(#kg-stroke)" fill="none" stroke-width="2"/>' +
      // signed kolm endpoint
      '<g class="kolm-ill-node kolm-ill-node--out" transform="translate(400,138)">' +
        '<rect width="64" height="44" rx="10" fill="var(--brand-primary)" fill-opacity=".10" stroke="var(--brand-primary)" stroke-opacity=".7"/>' +
        '<text x="32" y="20" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" font-weight="600" fill="var(--brand-primary)">SDK</text>' +
        '<text x="32" y="34" text-anchor="middle" font-family="ui-monospace, monospace" font-size="8" fill="currentColor" fill-opacity=".7">unchanged</text>' +
      '</g>' +
      // traveling dot 1
      '<circle class="kolm-ill-pulse kolm-ill-pulse-a" r="3" fill="var(--brand-primary)"><animateMotion dur="3.2s" repeatCount="indefinite" path="M160,82 C 200,82 200,160 220,160 L300,160 C 340,160 340,160 400,160"/></circle>' +
      '<circle class="kolm-ill-pulse kolm-ill-pulse-b" r="3" fill="var(--brand-primary)"><animateMotion dur="3.2s" begin="1.1s" repeatCount="indefinite" path="M160,162 C 200,162 200,160 220,160 L300,160 C 340,160 340,160 400,160"/></circle>' +
      '<circle class="kolm-ill-pulse kolm-ill-pulse-c" r="3" fill="var(--brand-primary)"><animateMotion dur="3.2s" begin="2.2s" repeatCount="indefinite" path="M160,242 C 200,242 200,160 220,160 L300,160 C 340,160 340,160 400,160"/></circle>' +
    '</svg>';
  }

  function illCompilePipeline() {
    // captures → distill → artifact (.kolm)
    return '<svg class="kolm-ill kolm-ill--compile" viewBox="0 0 480 280" role="img" aria-label="Compile pipeline: captures distill into a signed kolm artifact">' +
      '<defs>' +
      '<linearGradient id="kp-line" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="currentColor" stop-opacity=".25"/><stop offset="1" stop-color="var(--brand-primary)" stop-opacity=".8"/></linearGradient>' +
      '</defs>' +
      // stage 1 — captures (stacked rows)
      '<g class="kolm-ill-stage kolm-ill-stage-1" transform="translate(20,80)">' +
        '<text x="60" y="-12" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="currentColor" fill-opacity=".7" letter-spacing="1">CAPTURES</text>' +
        '<rect class="kolm-ill-row" x="0" y="0"  width="120" height="14" rx="3" fill="currentColor" fill-opacity=".10"/>' +
        '<rect class="kolm-ill-row" x="0" y="20" width="120" height="14" rx="3" fill="currentColor" fill-opacity=".10"/>' +
        '<rect class="kolm-ill-row" x="0" y="40" width="120" height="14" rx="3" fill="currentColor" fill-opacity=".10"/>' +
        '<rect class="kolm-ill-row" x="0" y="60" width="120" height="14" rx="3" fill="currentColor" fill-opacity=".10"/>' +
        '<rect class="kolm-ill-row" x="0" y="80" width="120" height="14" rx="3" fill="currentColor" fill-opacity=".10"/>' +
      '</g>' +
      // line 1
      '<path d="M150,140 L200,140" stroke="url(#kp-line)" stroke-width="1.5" fill="none"/>' +
      // stage 2 — distill funnel
      '<g class="kolm-ill-stage kolm-ill-stage-2" transform="translate(200,90)">' +
        '<text x="40" y="-2" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="currentColor" fill-opacity=".7" letter-spacing="1">DISTILL</text>' +
        '<path d="M0,10 L80,10 L52,46 L52,86 L28,86 L28,46 Z" fill="var(--brand-primary)" fill-opacity=".06" stroke="var(--brand-primary)" stroke-opacity=".55" stroke-width="1.5"/>' +
        '<text x="40" y="58" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" fill="var(--brand-primary)">K &gt; gate</text>' +
      '</g>' +
      // line 2
      '<path d="M290,140 L340,140" stroke="url(#kp-line)" stroke-width="1.5" fill="none"/>' +
      // stage 3 — artifact (.kolm seal)
      '<g class="kolm-ill-stage kolm-ill-stage-3" transform="translate(340,100)">' +
        '<text x="60" y="-12" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="currentColor" fill-opacity=".7" letter-spacing="1">ARTIFACT</text>' +
        '<rect width="120" height="80" rx="10" fill="var(--brand-primary)" fill-opacity=".10" stroke="var(--brand-primary)" stroke-opacity=".75" stroke-width="1.5"/>' +
        '<text x="60" y="34" text-anchor="middle" font-family="ui-monospace, monospace" font-size="13" font-weight="700" fill="var(--brand-primary)">.kolm</text>' +
        '<text x="60" y="52" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity=".75">signed</text>' +
        '<circle cx="100" cy="66" r="6" fill="none" stroke="var(--brand-primary)" stroke-opacity=".8" stroke-width="1.5"/>' +
        '<path d="M97,66 L99,68 L103,64" fill="none" stroke="var(--brand-primary)" stroke-width="1.5" stroke-linecap="round"/>' +
      '</g>' +
      // traveling pulses
      '<circle class="kolm-ill-pulse" r="3" fill="var(--brand-primary)"><animateMotion dur="2.6s" repeatCount="indefinite" path="M150,140 L200,140"/></circle>' +
      '<circle class="kolm-ill-pulse" r="3" fill="var(--brand-primary)"><animateMotion dur="2.6s" begin="1.3s" repeatCount="indefinite" path="M290,140 L340,140"/></circle>' +
    '</svg>';
  }

  function illDeviceSequence() {
    // Six runtime targets with active highlight cycling
    var devices = [
      { label: 'cpu',     glyph: '<rect x="14" y="14" width="36" height="36" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M22 22h20v20H22z M22 22l-6-6M42 22l6-6M22 42l-6 6M42 42l6 6" stroke="currentColor" stroke-width="1.5" fill="none"/>' },
      { label: 'cuda',    glyph: '<rect x="10" y="14" width="44" height="36" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="22" cy="32" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="42" cy="32" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
      { label: 'mobile',  glyph: '<rect x="20" y="8" width="24" height="48" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="32" cy="50" r="1.6" fill="currentColor"/>' },
      { label: 'browser', glyph: '<rect x="8" y="14" width="48" height="36" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 22h48" stroke="currentColor" stroke-width="1.5"/><circle cx="14" cy="18" r="1.4" fill="currentColor"/><circle cx="20" cy="18" r="1.4" fill="currentColor"/><circle cx="26" cy="18" r="1.4" fill="currentColor"/>' },
      { label: 'edge',    glyph: '<path d="M16 38a10 10 0 110-12 8 8 0 0114 6 10 10 0 010 14h-26a8 8 0 010-8z" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
      { label: 'vpc',     glyph: '<rect x="12" y="20" width="40" height="28" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M22 20v-4a10 10 0 0120 0v4" fill="none" stroke="currentColor" stroke-width="1.5"/>' }
    ];
    var slots = '';
    for (var i = 0; i < devices.length; i++) {
      var x = 20 + i * 75;
      slots += '<g class="kolm-ill-dev" style="--i:' + i + '" transform="translate(' + x + ',60)">' +
        '<rect width="64" height="76" rx="10" fill="currentColor" fill-opacity=".04" stroke="currentColor" stroke-opacity=".22"/>' +
        '<g transform="translate(0,4)">' + devices[i].glyph + '</g>' +
        '<text x="32" y="70" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" font-weight="600" fill="currentColor" fill-opacity=".85" letter-spacing="1">' + devices[i].label.toUpperCase() + '</text>' +
      '</g>';
    }
    return '<svg class="kolm-ill kolm-ill--device" viewBox="0 0 480 200" role="img" aria-label="Same signed kolm runs on CPU, CUDA, mobile, browser, edge, and VPC targets">' +
      '<text x="240" y="32" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" fill="currentColor" fill-opacity=".7" letter-spacing="1">ONE .kolm  ·  EVERY TARGET</text>' +
      slots +
      // cycling highlight bar
      '<rect class="kolm-ill-cycle" x="20" y="60" width="64" height="76" rx="10" fill="none" stroke="var(--brand-primary)" stroke-width="2"/>' +
    '</svg>';
  }

  function illArtifactAnatomy() {
    // .kolm internals — cutaway layers
    return '<svg class="kolm-ill kolm-ill--anatomy" viewBox="0 0 360 280" role="img" aria-label="The .kolm artifact contains weights, signature, K-score, and a receipt chain">' +
      '<rect x="30" y="30" width="300" height="220" rx="14" fill="var(--brand-primary)" fill-opacity=".05" stroke="var(--brand-primary)" stroke-opacity=".55" stroke-width="1.5"/>' +
      '<text x="180" y="58" text-anchor="middle" font-family="ui-monospace, monospace" font-size="14" font-weight="700" fill="var(--brand-primary)">deepseek-r1-32b.kolm</text>' +
      // layer rows
      '<g font-family="ui-monospace, monospace" font-size="10" fill="currentColor">' +
        '<rect x="50" y="80"  width="260" height="28" rx="6" fill="currentColor" fill-opacity=".06"/>' +
        '<text x="62" y="98" fill-opacity=".85">weights.int4</text><text x="296" y="98" text-anchor="end" fill-opacity=".55">17.9 GB</text>' +
        '<rect x="50" y="116" width="260" height="28" rx="6" fill="currentColor" fill-opacity=".06"/>' +
        '<text x="62" y="134" fill-opacity=".85">manifest.json</text><text x="296" y="134" text-anchor="end" fill-opacity=".55">1.4 KB</text>' +
        '<rect x="50" y="152" width="260" height="28" rx="6" fill="currentColor" fill-opacity=".06"/>' +
        '<text x="62" y="170" fill-opacity=".85">signature.ed25519</text><text x="296" y="170" text-anchor="end" fill-opacity=".55">64 B</text>' +
        '<rect x="50" y="188" width="260" height="28" rx="6" fill="currentColor" fill-opacity=".06"/>' +
        '<text x="62" y="206" fill-opacity=".85">receipt.json</text><text x="296" y="206" text-anchor="end" fill-opacity=".55">4 KB</text>' +
      '</g>' +
      // K-score badge top-right
      '<g transform="translate(258,18)">' +
        '<rect width="78" height="32" rx="16" fill="var(--brand-primary)" fill-opacity=".18" stroke="var(--brand-primary)" stroke-opacity=".7"/>' +
        '<text x="14" y="20" font-family="ui-monospace, monospace" font-size="10" fill="currentColor" fill-opacity=".7">K</text>' +
        '<text x="42" y="22" font-family="ui-monospace, monospace" font-size="14" font-weight="700" fill="var(--brand-primary)">88.2</text>' +
      '</g>' +
      // pulsing scan line
      '<rect class="kolm-ill-scan" x="48" y="78" width="264" height="2" fill="var(--brand-primary)" fill-opacity=".5"/>' +
    '</svg>';
  }

  function illVerifyChain() {
    // Receipt + signature + audit chain — three documents linked
    return '<svg class="kolm-ill kolm-ill--verify" viewBox="0 0 480 240" role="img" aria-label="Every artifact carries a signature, receipt, and audit chain">' +
      // doc 1 — signature
      '<g transform="translate(30,40)">' +
        '<rect width="120" height="160" rx="8" fill="currentColor" fill-opacity=".05" stroke="currentColor" stroke-opacity=".3"/>' +
        '<text x="12" y="24" font-family="ui-monospace, monospace" font-size="10" fill="currentColor" fill-opacity=".7" letter-spacing="1">SIGNATURE</text>' +
        '<path d="M12 44h96M12 56h80M12 68h96M12 80h70M12 92h96M12 104h60" stroke="currentColor" stroke-opacity=".2" stroke-width="1"/>' +
        '<g transform="translate(76,116)"><circle r="20" fill="var(--brand-primary)" fill-opacity=".15" stroke="var(--brand-primary)" stroke-opacity=".8" stroke-width="1.5"/><path d="M-6,0 L-1,5 L7,-5" fill="none" stroke="var(--brand-primary)" stroke-width="2" stroke-linecap="round"/></g>' +
      '</g>' +
      // doc 2 — receipt
      '<g transform="translate(180,40)">' +
        '<rect width="120" height="160" rx="8" fill="currentColor" fill-opacity=".05" stroke="currentColor" stroke-opacity=".3"/>' +
        '<text x="12" y="24" font-family="ui-monospace, monospace" font-size="10" fill="currentColor" fill-opacity=".7" letter-spacing="1">RECEIPT</text>' +
        '<text x="12" y="48" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity=".7">build_id</text>' +
        '<text x="108" y="48" text-anchor="end" font-family="ui-monospace, monospace" font-size="9" fill="var(--brand-primary)">a44b9ff…</text>' +
        '<text x="12" y="66" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity=".7">k_score</text>' +
        '<text x="108" y="66" text-anchor="end" font-family="ui-monospace, monospace" font-size="9" fill="var(--brand-primary)">87.4</text>' +
        '<text x="12" y="84" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity=".7">teacher</text>' +
        '<text x="108" y="84" text-anchor="end" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity=".85">claude-opus</text>' +
        '<text x="12" y="102" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity=".7">steps</text>' +
        '<text x="108" y="102" text-anchor="end" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity=".85">12,400</text>' +
        '<text x="12" y="120" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity=".7">eval_rows</text>' +
        '<text x="108" y="120" text-anchor="end" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity=".85">1,000</text>' +
        '<text x="12" y="138" font-family="ui-monospace, monospace" font-size="9" fill="currentColor" fill-opacity=".7">phi_leaks</text>' +
        '<text x="108" y="138" text-anchor="end" font-family="ui-monospace, monospace" font-size="9" fill="var(--brand-primary)">0</text>' +
      '</g>' +
      // doc 3 — audit chain
      '<g transform="translate(330,40)">' +
        '<rect width="120" height="160" rx="8" fill="currentColor" fill-opacity=".05" stroke="currentColor" stroke-opacity=".3"/>' +
        '<text x="12" y="24" font-family="ui-monospace, monospace" font-size="10" fill="currentColor" fill-opacity=".7" letter-spacing="1">AUDIT</text>' +
        '<g font-family="ui-monospace, monospace" font-size="9">' +
          '<circle cx="22" cy="48" r="4" fill="var(--brand-primary)" fill-opacity=".7"/><text x="34" y="51" fill="currentColor" fill-opacity=".85">capture · 12.4k</text>' +
          '<line x1="22" y1="52" x2="22" y2="68" stroke="var(--brand-primary)" stroke-opacity=".5" stroke-width="1.5"/>' +
          '<circle cx="22" cy="72" r="4" fill="var(--brand-primary)" fill-opacity=".7"/><text x="34" y="75" fill="currentColor" fill-opacity=".85">review · 100%</text>' +
          '<line x1="22" y1="76" x2="22" y2="92" stroke="var(--brand-primary)" stroke-opacity=".5" stroke-width="1.5"/>' +
          '<circle cx="22" cy="96" r="4" fill="var(--brand-primary)" fill-opacity=".7"/><text x="34" y="99" fill="currentColor" fill-opacity=".85">distill · ok</text>' +
          '<line x1="22" y1="100" x2="22" y2="116" stroke="var(--brand-primary)" stroke-opacity=".5" stroke-width="1.5"/>' +
          '<circle cx="22" cy="120" r="4" fill="var(--brand-primary)" fill-opacity=".7"/><text x="34" y="123" fill="currentColor" fill-opacity=".85">sign · ok</text>' +
          '<line x1="22" y1="124" x2="22" y2="140" stroke="var(--brand-primary)" stroke-opacity=".5" stroke-width="1.5"/>' +
          '<circle cx="22" cy="144" r="4" fill="var(--brand-primary)"/><text x="34" y="147" fill="var(--brand-primary)" font-weight="700">verified</text>' +
        '</g>' +
      '</g>' +
      // chain links between docs
      '<path d="M150,120 L180,120 M300,120 L330,120" stroke="var(--brand-primary)" stroke-opacity=".5" stroke-width="1.5" stroke-dasharray="3 3"/>' +
    '</svg>';
  }

  function illScaleHorizon() {
    // laptop → cluster → fleet
    return '<svg class="kolm-ill kolm-ill--scale" viewBox="0 0 480 240" role="img" aria-label="One signed artifact scales from laptop to enterprise fleet">' +
      // laptop
      '<g transform="translate(40,90)">' +
        '<rect x="0" y="0" width="80" height="50" rx="4" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-width="1.5"/>' +
        '<rect x="0" y="50" width="80" height="6" rx="2" fill="currentColor" fill-opacity=".15"/>' +
        '<text x="40" y="72" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="currentColor" fill-opacity=".7">laptop</text>' +
      '</g>' +
      // cluster (3 boxes)
      '<g transform="translate(180,80)">' +
        '<rect x="0"  y="6" width="34" height="48" rx="3" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="1.5"/>' +
        '<rect x="40" y="0" width="34" height="60" rx="3" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-width="1.5"/>' +
        '<rect x="80" y="6" width="34" height="48" rx="3" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="1.5"/>' +
        '<text x="57" y="82" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="currentColor" fill-opacity=".7">team cluster</text>' +
      '</g>' +
      // fleet (dot grid)
      '<g transform="translate(330,72)" class="kolm-ill-fleet">' +
        '<g fill="var(--brand-primary)" fill-opacity=".7">' +
          '<circle cx="6"  cy="6"  r="3"/><circle cx="22" cy="6"  r="3"/><circle cx="38" cy="6"  r="3"/><circle cx="54" cy="6"  r="3"/><circle cx="70" cy="6"  r="3"/><circle cx="86" cy="6"  r="3"/><circle cx="102" cy="6" r="3"/>' +
          '<circle cx="6"  cy="22" r="3"/><circle cx="22" cy="22" r="3"/><circle cx="38" cy="22" r="3"/><circle cx="54" cy="22" r="3"/><circle cx="70" cy="22" r="3"/><circle cx="86" cy="22" r="3"/><circle cx="102" cy="22" r="3"/>' +
          '<circle cx="6"  cy="38" r="3"/><circle cx="22" cy="38" r="3"/><circle cx="38" cy="38" r="3"/><circle cx="54" cy="38" r="3"/><circle cx="70" cy="38" r="3"/><circle cx="86" cy="38" r="3"/><circle cx="102" cy="38" r="3"/>' +
          '<circle cx="6"  cy="54" r="3"/><circle cx="22" cy="54" r="3"/><circle cx="38" cy="54" r="3"/><circle cx="54" cy="54" r="3"/><circle cx="70" cy="54" r="3"/><circle cx="86" cy="54" r="3"/><circle cx="102" cy="54" r="3"/>' +
        '</g>' +
        '<text x="54" y="90" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" fill="currentColor" fill-opacity=".7">enterprise fleet</text>' +
      '</g>' +
      // arrows between
      '<path d="M130,118 L175,118 M298,118 L325,118" stroke="var(--brand-primary)" stroke-opacity=".6" stroke-width="1.5" fill="none" marker-end="url(#kolm-arrow)"/>' +
      '<defs><marker id="kolm-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--brand-primary)" fill-opacity=".8"/></marker></defs>' +
      // floating .kolm token
      '<g class="kolm-ill-float" transform="translate(220,180)">' +
        '<rect width="40" height="20" rx="5" fill="var(--brand-primary)" fill-opacity=".15" stroke="var(--brand-primary)" stroke-opacity=".7"/>' +
        '<text x="20" y="14" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" font-weight="700" fill="var(--brand-primary)">.kolm</text>' +
      '</g>' +
    '</svg>';
  }

  var ILLUSTRATIONS = {
    'gateway-router':    illGatewayRouter,
    'compile-pipeline':  illCompilePipeline,
    'device-sequence':   illDeviceSequence,
    'artifact-anatomy':  illArtifactAnatomy,
    'verify-chain':      illVerifyChain,
    'scale-horizon':     illScaleHorizon
  };

  function buildIllustration(name) {
    var fn = ILLUSTRATIONS[name];
    return fn ? fn() : '';
  }

  // ---- BADGES — reusable visual stamps (W658). ----
  // K-score badge: medallion with the "K" mark, a score number, and a "verified by kolm.ai"
  // microtype on the bottom arc. currentColor for outer ring; mint accent on the K + score
  // so it sits on any background. opts.score (string, e.g. "0.91"), opts.size (px).
  function buildBadgeKScore(opts) {
    opts = opts || {};
    var score = (opts.score != null ? String(opts.score) : '0.91');
    var size = opts.size || 120;
    var label = 'K-Score ' + score + ' — verified by kolm.ai';
    return '<svg class="kolm-badge kolm-badge--kscore" width="' + size + '" height="' + size + '" viewBox="0 0 120 120" role="img" aria-label="' + label + '">' +
      '<defs>' +
        '<path id="kbadge-arc" d="M 14,60 A 46,46 0 0 0 106,60"/>' +
      '</defs>' +
      // outer ring (faint)
      '<circle cx="60" cy="60" r="58" fill="none" stroke="currentColor" stroke-opacity=".18" stroke-width="1"/>' +
      // inner ring (slightly stronger)
      '<circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" stroke-opacity=".28" stroke-width="1"/>' +
      // top arc label: "K-SCORE"
      '<text x="60" y="26" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="8.5" letter-spacing="0.18em" fill="currentColor" fill-opacity=".55">K-SCORE</text>' +
      // big "K" mark in mint accent
      '<text x="60" y="62" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="34" font-weight="700" fill="var(--ks-accent, #a3e7c7)">K</text>' +
      // divider
      '<line x1="34" y1="72" x2="86" y2="72" stroke="currentColor" stroke-opacity=".25" stroke-width="1"/>' +
      // score number
      '<text x="60" y="90" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="18" font-weight="540" fill="currentColor">' + score + '</text>' +
      // bottom-arc microtype
      '<text font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="7" letter-spacing="0.20em" fill="currentColor" fill-opacity=".55">' +
        '<textPath href="#kbadge-arc" startOffset="50%" text-anchor="middle">VERIFIED BY KOLM.AI</textPath>' +
      '</text>' +
      '</svg>';
  }

  var BADGES = {
    'kscore': buildBadgeKScore
  };

  function buildBadge(name, opts) {
    var fn = BADGES[name];
    return fn ? fn(opts) : '';
  }

  // ---- Auto-render on DOM ready ----
  function render() {
    var iconHosts = document.querySelectorAll('[data-kolm-icon]:not([data-kolm-rendered])');
    for (var i = 0; i < iconHosts.length; i++) {
      var host = iconHosts[i];
      var name = host.getAttribute('data-kolm-icon');
      var size = host.getAttribute('data-kolm-size') || 18;
      var label = host.getAttribute('data-kolm-label');
      host.innerHTML = buildIcon(name, { size: parseInt(size, 10), label: label });
      host.setAttribute('data-kolm-rendered', '1');
    }
    var illHosts = document.querySelectorAll('[data-kolm-illustration]:not([data-kolm-rendered])');
    for (var j = 0; j < illHosts.length; j++) {
      var host2 = illHosts[j];
      var iname = host2.getAttribute('data-kolm-illustration');
      host2.innerHTML = buildIllustration(iname);
      host2.setAttribute('data-kolm-rendered', '1');
    }
    var badgeHosts = document.querySelectorAll('[data-kolm-badge]:not([data-kolm-rendered])');
    for (var k = 0; k < badgeHosts.length; k++) {
      var host3 = badgeHosts[k];
      var bname = host3.getAttribute('data-kolm-badge');
      var bsize = host3.getAttribute('data-kolm-size');
      var bscore = host3.getAttribute('data-score');
      host3.innerHTML = buildBadge(bname, { size: bsize ? parseInt(bsize, 10) : undefined, score: bscore });
      host3.setAttribute('data-kolm-rendered', '1');
    }
  }

  // expose
  window.kolmIcon = buildIcon;
  window.kolmIllustration = buildIllustration;
  window.kolmBadge = buildBadge;
  window.kolmRenderSvg = render;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }
})();

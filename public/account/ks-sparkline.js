/*
 * ks-sparkline.js — dependency-free inline-SVG K-Score sparkline.
 *
 * No build step, no npm, no external fetches. Isomorphic: the pure render
 * function is attached to `window` (browser) and to `globalThis` (Node), and
 * is also exposed as `module.exports` when a CommonJS-ish shim is present, so
 * scripts/ks-sparkline-smoke.mjs can import-and-eval it headlessly.
 *
 * Data contract (kts-v1, from src/kscore-timeseries.js):
 *   points: [ { ts:<ms|iso>, kscore:<0..1>, artifact_id, run_id } ]  // ascending
 *
 * Public render signature:
 *   renderSparkline(points, opts) -> string   // SVG string; exactly one
 *                                              // <polyline> whose point count
 *                                              // === points.length (for N>=2)
 *
 * States:
 *   0 points -> friendly empty state (role="img"), NO <polyline>, no throw
 *   1 point  -> a single dot (NO <polyline>, point count of a line is < 2)
 *   N points -> <polyline> + optional last-value label
 *
 * Palette: cool-slate ONLY. Stroke uses slate ink (#1f2937); baseline/grid use
 * a hairline border token (#dde1e7). No warm/brown/tan/orange hues anywhere.
 */
(function (root, factory) {
  var api = factory();
  // Browser global
  if (typeof window !== 'undefined') {
    window.KolmSparkline = api;
    window.renderSparkline = api.renderSparkline;
  }
  // Node / headless global (used by the .mjs smoke after eval)
  if (typeof globalThis !== 'undefined') {
    globalThis.KolmSparkline = api;
    globalThis.renderSparkline = api.renderSparkline;
  }
  // CommonJS, if a shim exposes module.exports
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- cool-slate palette (no warm hues) ---------------------------------
  // Mirrors the page tokens: text-1 #1f2937, secondary #56606c,
  // hairlines #dde1e7 / #e6eaef, surfaces #f3f5f7 / white.
  var SLATE = {
    stroke: '#1f2937',   // line + dot fill (slate ink)
    text: '#1f2937',     // value label
    textMute: '#56606c', // secondary label
    grid: '#e6eaef',     // baseline / gridline hairline
    surface: '#f3f5f7',  // empty-state plate fill
    border: '#dde1e7',   // empty-state plate border
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Coerce one point to a finite kscore or return null. null/undefined/'' are
  // treated as "no measurement" (skipped), NOT as 0 — Number(null) === 0 would
  // otherwise inject a phantom dip into the line.
  function scoreOf(p) {
    if (p == null) return null;
    var raw = p.kscore;
    if (raw == null || raw === '') return null;
    var v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }

  // Round to a stable number of decimals without trailing-zero jitter.
  function fmtScore(v) {
    if (v == null || !Number.isFinite(v)) return '-';
    // K-Score lives in 0..1; 2 decimals is the product convention.
    return (Math.round(v * 100) / 100).toFixed(2);
  }

  // Build an aria-label that summarizes the trend, e.g.
  // "K-Score 0.71 to 0.83 over 12 runs".
  function ariaFor(scores) {
    var n = scores.length;
    if (n === 0) return 'K-Score chart: no runs recorded yet';
    if (n === 1) return 'K-Score ' + fmtScore(scores[0]) + ' over 1 run';
    var first = scores[0];
    var last = scores[n - 1];
    return 'K-Score ' + fmtScore(first) + ' → ' + fmtScore(last) +
      ' over ' + n + ' runs';
  }

  /**
   * renderSparkline(points, opts) -> SVG string.
   *
   * opts (all optional):
   *   width        number  px, default 220
   *   height       number  px, default 56
   *   pad          number  inner padding px, default 6
   *   showLabel    bool    render last-value text label, default true
   *   showBaseline bool    render a faint baseline rule, default true
   *   min,max      number  fix the value domain (else derived from data,
   *                        clamped to a 0..1 floor/ceil so flat series still
   *                        get a sane band)
   *   ariaLabel    string  override the computed aria-label
   *   className    string  extra class on the root <svg>
   */
  function renderSparkline(points, opts) {
    opts = opts || {};
    var W = opts.width != null ? Number(opts.width) : 220;
    var H = opts.height != null ? Number(opts.height) : 56;
    var pad = opts.pad != null ? Number(opts.pad) : 6;
    var showLabel = opts.showLabel !== false;
    var showBaseline = opts.showBaseline !== false;
    var cls = opts.className ? ' ' + esc(opts.className) : '';

    var pts = Array.isArray(points) ? points : [];
    var scores = [];
    for (var i = 0; i < pts.length; i++) {
      var s = scoreOf(pts[i]);
      if (s != null) scores.push(s);
    }
    var n = scores.length;
    var aria = opts.ariaLabel != null ? String(opts.ariaLabel) : ariaFor(scores);

    var svgOpen = '<svg class="ks-spark' + cls + '" role="img" aria-label="' +
      esc(aria) + '" viewBox="0 0 ' + W + ' ' + H + '" width="' + W +
      '" height="' + H + '" preserveAspectRatio="none" ' +
      'xmlns="http://www.w3.org/2000/svg" focusable="false">';

    // ---- 0 points: friendly empty state (NO polyline) --------------------
    if (n === 0) {
      var midY = (H / 2).toFixed(1);
      return svgOpen +
        '<title>' + esc(aria) + '</title>' +
        '<rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (H - 1) +
        '" rx="6" fill="' + SLATE.surface + '" stroke="' + SLATE.border +
        '" stroke-width="1"/>' +
        '<line x1="' + pad + '" y1="' + midY + '" x2="' + (W - pad) + '" y2="' +
        midY + '" stroke="' + SLATE.grid + '" stroke-width="1" ' +
        'stroke-dasharray="3 3"/>' +
        '<text x="' + (W / 2) + '" y="' + midY +
        '" fill="' + SLATE.textMute + '" font-size="10" text-anchor="middle" ' +
        'dominant-baseline="middle" font-family="ui-monospace, Menlo, monospace">' +
        'no runs yet</text>' +
        '</svg>';
    }

    // ---- value domain ----------------------------------------------------
    var lo = opts.min != null ? Number(opts.min) : Math.min.apply(null, scores);
    var hi = opts.max != null ? Number(opts.max) : Math.max.apply(null, scores);
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = 1;
    // Flat series (lo===hi) would divide by zero — pad the band symmetrically
    // and keep it inside a sensible 0..1 frame.
    if (hi - lo < 1e-9) {
      var c = lo;
      lo = Math.max(0, c - 0.05);
      hi = Math.min(1, c + 0.05);
      if (hi - lo < 1e-9) { lo = 0; hi = 1; }
    }

    var innerW = W - pad * 2;
    var innerH = H - pad * 2;

    function xAt(idx) {
      if (n === 1) return W / 2;
      return pad + (innerW * idx) / (n - 1);
    }
    function yAt(score) {
      var t = (score - lo) / (hi - lo); // 0..1, higher score = higher up
      if (!Number.isFinite(t)) t = 0.5;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      return pad + innerH * (1 - t);
    }

    var baseline = '';
    if (showBaseline) {
      var by = (H - pad).toFixed(1);
      baseline = '<line x1="' + pad + '" y1="' + by + '" x2="' + (W - pad) +
        '" y2="' + by + '" stroke="' + SLATE.grid + '" stroke-width="1"/>';
    }

    var lastX = xAt(n - 1);
    var lastY = yAt(scores[n - 1]);
    var lastScore = scores[n - 1];

    // ---- 1 point: a dot (NO polyline) ------------------------------------
    if (n === 1) {
      var dot1 = '<circle cx="' + xAt(0).toFixed(2) + '" cy="' +
        yAt(scores[0]).toFixed(2) + '" r="2.6" fill="' + SLATE.stroke + '"/>';
      var label1 = '';
      if (showLabel) {
        label1 = '<text x="' + (W - pad) + '" y="' + (pad + 8) +
          '" fill="' + SLATE.text + '" font-size="11" text-anchor="end" ' +
          'font-family="ui-monospace, Menlo, monospace" ' +
          'style="font-variant-numeric:tabular-nums">' + esc(fmtScore(scores[0])) +
          '</text>';
      }
      return svgOpen + '<title>' + esc(aria) + '</title>' + baseline + dot1 +
        label1 + '</svg>';
    }

    // ---- N points: polyline (+ end dot + optional label) -----------------
    var coords = [];
    for (var j = 0; j < n; j++) {
      coords.push(xAt(j).toFixed(2) + ',' + yAt(scores[j]).toFixed(2));
    }
    var polyline = '<polyline points="' + coords.join(' ') + '" fill="none" ' +
      'stroke="' + SLATE.stroke + '" stroke-width="1.5" ' +
      'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';

    var endDot = '<circle cx="' + lastX.toFixed(2) + '" cy="' + lastY.toFixed(2) +
      '" r="2.4" fill="' + SLATE.stroke + '"/>';

    var label = '';
    if (showLabel) {
      // Keep the label inside the box; flip anchor near the right edge.
      var lx = (W - pad);
      label = '<text x="' + lx + '" y="' + (pad + 8) + '" fill="' + SLATE.text +
        '" font-size="11" text-anchor="end" ' +
        'font-family="ui-monospace, Menlo, monospace" ' +
        'style="font-variant-numeric:tabular-nums">' + esc(fmtScore(lastScore)) +
        '</text>';
    }

    return svgOpen + '<title>' + esc(aria) + '</title>' + baseline + polyline +
      endDot + label + '</svg>';
  }

  // Convenience: render straight from a kts-v1 envelope { ok, points }.
  function renderFromEnvelope(env, opts) {
    var points = (env && Array.isArray(env.points)) ? env.points : [];
    return renderSparkline(points, opts);
  }

  // Pure trend summary (mirrors src/kscore-timeseries.js renderSeriesSummary)
  // so the panel can show min/max/latest/trend without a second import.
  function summarize(points) {
    var pts = Array.isArray(points)
      ? points
      : (points && Array.isArray(points.points) ? points.points : []);
    var scores = [];
    for (var i = 0; i < pts.length; i++) {
      var v = scoreOf(pts[i]);
      if (v != null) scores.push(v);
    }
    var n = scores.length;
    if (n === 0) return { min: null, max: null, latest: null, first: null, trend: 'flat', n: 0 };
    var min = Math.min.apply(null, scores);
    var max = Math.max.apply(null, scores);
    var first = scores[0];
    var latest = scores[n - 1];
    var trend = 'flat';
    if (n >= 2) {
      if (latest > first) trend = 'up';
      else if (latest < first) trend = 'down';
    }
    return { min: min, max: max, latest: latest, first: first, trend: trend, n: n };
  }

  return {
    renderSparkline: renderSparkline,
    renderFromEnvelope: renderFromEnvelope,
    summarize: summarize,
    fmtScore: fmtScore,
  };
});

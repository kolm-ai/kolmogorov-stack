// Client-side Sentry init shim.
//
// Opt-in. Pulls the DSN from one of:
//   1. <meta name="sentry-dsn" content="https://...">         (build-time inject)
//   2. window.__KOLM_SENTRY_DSN__ = 'https://...'             (runtime inject)
// If neither is present, OR if @sentry/browser is not available on the CDN,
// this script is a no-op. Same release/environment hooks as the server:
//   <meta name="sentry-release" content="...">
//   <meta name="sentry-environment" content="production">
//
// Caveats: this loads @sentry/browser lazily from a CDN (jsDelivr) ONLY if a
// DSN is found. No network request happens in the no-op path.

(function () {
  'use strict';

  function meta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el ? el.getAttribute('content') : null;
  }

  var dsn = (typeof window !== 'undefined' && window.__KOLM_SENTRY_DSN__) || meta('sentry-dsn');
  if (!dsn) return;

  var release = (typeof window !== 'undefined' && window.__KOLM_RELEASE__) || meta('sentry-release') || undefined;
  var environment = (typeof window !== 'undefined' && window.__KOLM_ENV__) || meta('sentry-environment') || 'production';

  var script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@sentry/browser@7/build/bundles/bundle.tracing.min.js';
  script.crossOrigin = 'anonymous';
  script.async = true;
  script.onload = function () {
    try {
      if (typeof window.Sentry === 'undefined' || typeof window.Sentry.init !== 'function') return;
      window.Sentry.init({
        dsn: dsn,
        environment: environment,
        release: release,
        tracesSampleRate: 0.1,
      });
    } catch (_err) {
      // Sentry load succeeded but init threw. Stay silent — Sentry must
      // never break the page it's supposed to be observing.
    }
  };
  script.onerror = function () {
    // CDN unreachable / blocked by client. No-op.
  };
  document.head.appendChild(script);
})();

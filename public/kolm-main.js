// Main product surface proof wiring. Static markup is the fallback.
(function () {
  'use strict';

  function text(el, value) {
    if (el && value != null) el.textContent = String(value);
  }

  function initCapabilities() {
    var root = document.querySelector('[data-capability-proof]');
    if (!root || !window.fetch) return;
    fetch('/v1/product/capabilities', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.ok) return;
        text(root.querySelector('[data-cap-version]'), data.version);
        text(root.querySelector('[data-cap-updated]'), data.generated_at ? data.generated_at.slice(0, 10) : '');
        var surfaces = Array.isArray(data.primary_surfaces) ? data.primary_surfaces : [];
        surfaces.forEach(function (surface) {
          var el = root.querySelector('[data-cap-status="' + surface.id + '"]');
          if (el) el.textContent = surface.status || 'mounted';
        });
      })
      .catch(function () {});
  }

  function readGraphCounts(data) {
    var graph = data && data.data && data.data.graph ? data.data.graph : data;
    return graph && graph.counts ? graph.counts : null;
  }

  function readReadinessCounts(data) {
    var readiness = data && data.data && data.data.readiness ? data.data.readiness : data;
    return readiness && readiness.counts ? readiness.counts : null;
  }

  function initHomepageProof() {
    var root = document.querySelector('[data-home-proof]');
    if (!root || !window.fetch) return;

    function setCount(name, value) {
      var el = root.querySelector('[data-home-count="' + name + '"]');
      text(el, value);
    }

    Promise.allSettled([
      fetch('/v1/product/graph', { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }),
      fetch('/product-readiness-closeout.json', { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); })
    ]).then(function (results) {
      var graphCounts = results[0].status === 'fulfilled' ? readGraphCounts(results[0].value) : null;
      var readinessCounts = results[1].status === 'fulfilled' ? readReadinessCounts(results[1].value) : null;
      if (graphCounts) {
        setCount('routes', graphCounts.routes);
        setCount('surfaces', graphCounts.route_surfaces);
        setCount('route-groups', graphCounts.route_groups);
        setCount('api-routes', graphCounts.api_routes);
      }
      if (readinessCounts) {
        setCount('open-gates', readinessCounts.open_requirements);
        var status = root.querySelector('[data-home-status="readiness"]');
        if (status) status.textContent = 'explicit open-readiness ledger';
      }
      var state = root.querySelector('[data-home-contract-state]');
      if (state) state.textContent = 'hydrated';
    }).catch(function () {});
  }

  function init() {
    initCapabilities();
    initHomepageProof();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCapabilities);
  else initCapabilities();
})();

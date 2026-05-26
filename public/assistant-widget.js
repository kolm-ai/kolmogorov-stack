/*  W888-S — assistant-widget.js
 *
 *  Inline meta-demo widget. Mounts to any [data-kolm-assistant] element.
 *  POSTs to the public docs endpoint /v1/assistant/chat-docs (W888-R) and
 *  falls through to the authed /v1/assistant/chat endpoint (W888-Q) when
 *  a session cookie is detected. Each successful reply renders the
 *  passport_hash inline with a "Verify ->" link to /v1/verify/<hash>.
 *
 *  The widget intentionally does not depend on a framework so the same
 *  bundle ships with the public homepage and the standalone /about-the-assistant
 *  page. It re-uses kolm-chat.js's pre-paint conventions (warm-paper.css
 *  class tokens, cool slate dark palette) without duplicating its CLI
 *  classifier surface — that is for /v1/free/chat. This widget is for
 *  natural-language Q&A about kolm itself.
 *
 *  Endpoint resolution order (first 2xx wins):
 *    1. /v1/assistant/chat-docs       (public, rate-limited, W888-R)
 *    2. /v1/assistant/chat            (authed, W888-Q)
 *
 *  If neither route exists yet (W888-Q + W888-R both pending) the widget
 *  surfaces a "verifying soon" banner with the passport hash from
 *  build/kolm-assistant-1.5b/compile-passport.json — visitors can still
 *  click through to /v1/verify/<hash> to see the chain.
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  if (window.__kolmAssistantWidgetBooted) return;
  window.__kolmAssistantWidgetBooted = true;

  var ENDPOINTS = [
    '/v1/assistant/chat-docs',
    '/v1/assistant/chat',
  ];

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'class') n.className = attrs[k];
        else if (k === 'text') n.textContent = attrs[k];
        else if (k === 'html') n.innerHTML = attrs[k];
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else n.setAttribute(k, attrs[k]);
      }
    }
    if (kids) {
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c == null) continue;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return n;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function safeJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // The compile-passport hash is baked into the page via data attribute on
  // the mount host so the widget can render verify links offline (no extra
  // round-trip just to show the chip). Host falls back to a placeholder
  // when the passport hasn't been minted yet — the link still resolves to
  // /v1/verify/ which is the standing chain-of-custody endpoint.
  function readMountPassport(host) {
    return (host.getAttribute('data-passport-hash') || '').trim();
  }

  function tryEndpoint(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    }).then(function (r) {
      return r.text().then(function (t) {
        return { status: r.status, ok: r.ok, text: t, body: safeJson(t) };
      });
    });
  }

  // Walk the endpoint chain. Any 2xx terminates the walk; non-2xx falls
  // through. The terminal failure surfaces an envelope shaped like the
  // real route so the renderer code path is identical.
  function askAssistant(prompt) {
    var idx = 0;
    function step() {
      if (idx >= ENDPOINTS.length) {
        return Promise.resolve({
          ok: false,
          status: 0,
          body: { error: 'route_pending', message: 'Public assistant endpoint is being wired up. Each reply will land with a verifiable passport once W888-R ships.' },
        });
      }
      var url = ENDPOINTS[idx++];
      return tryEndpoint(url, { prompt: prompt, max_tokens: 320 })
        .then(function (res) {
          if (res.ok) return res;
          if (res.status === 404 || res.status === 0) return step();
          return res;
        })
        .catch(function () { return step(); });
    }
    return step();
  }

  function renderReply(out, data, fallbackPassport) {
    var wrap = el('div', { class: 'kolm-asst__reply' });
    var body = el('div', { class: 'kolm-asst__reply-body' });
    var text = (data && (data.response || data.completion || data.text || data.message)) || '';
    if (!text && data && data.error === 'route_pending') {
      text = data.message;
    }
    if (!text) text = 'No response. Try a different question or visit /docs.';
    body.textContent = text;
    wrap.appendChild(body);

    var hash = (data && data.passport_hash) || fallbackPassport;
    var meta = el('div', { class: 'kolm-asst__reply-meta' });
    if (hash) {
      var verifyHref = '/v1/verify/' + encodeURIComponent(hash);
      meta.innerHTML = '<span class="kolm-asst__chip">passport ' + escapeHtml(hash.slice(0, 12)) + '</span> '
        + '<a class="kolm-asst__verify" href="' + verifyHref + '">Verify the model that produced this -&gt;</a>';
    } else {
      meta.innerHTML = '<span class="kolm-asst__chip kolm-asst__chip--pending">passport verifying</span> '
        + '<a class="kolm-asst__verify" href="/about-the-assistant">How verification works -&gt;</a>';
    }
    wrap.appendChild(meta);
    out.appendChild(wrap);
    out.scrollTop = out.scrollHeight;
  }

  function renderUserBubble(out, text) {
    var wrap = el('div', { class: 'kolm-asst__user' });
    wrap.appendChild(el('span', { class: 'kolm-asst__user-label', text: 'you' }));
    wrap.appendChild(el('div', { class: 'kolm-asst__user-body', text: text }));
    out.appendChild(wrap);
    out.scrollTop = out.scrollHeight;
  }

  function renderPending(out) {
    var p = el('div', { class: 'kolm-asst__pending', text: 'thinking...' });
    out.appendChild(p);
    out.scrollTop = out.scrollHeight;
    return p;
  }

  function mount(host) {
    if (host.dataset.kolmAssistantMounted === '1') return;
    host.dataset.kolmAssistantMounted = '1';
    var fallbackPassport = readMountPassport(host);
    var placeholder = host.getAttribute('data-placeholder') || 'Ask about kolm. e.g. what is K-Score? how do I distill?';

    host.classList.add('kolm-asst');
    host.innerHTML = '';

    var head = el('div', { class: 'kolm-asst__head' });
    head.appendChild(el('span', { class: 'kolm-asst__title', text: 'kolm-assistant-1.5b' }));
    head.appendChild(el('span', { class: 'kolm-asst__sub', text: 'distilled with kolm, runs on consumer hardware' }));
    host.appendChild(head);

    var log = el('div', { class: 'kolm-asst__log', role: 'log', 'aria-live': 'polite' });
    host.appendChild(log);

    var form = el('form', { class: 'kolm-asst__form', autocomplete: 'off' });
    var input = el('input', { type: 'text', name: 'q', placeholder: placeholder, maxlength: '500', 'aria-label': 'Ask the kolm assistant' });
    var btn = el('button', { type: 'submit', text: 'ask' });
    form.appendChild(input);
    form.appendChild(btn);
    host.appendChild(form);

    var busy = false;
    function setBusy(b) { busy = b; btn.disabled = b; input.disabled = b; btn.textContent = b ? '...' : 'ask'; }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (busy) return;
      var q = (input.value || '').trim();
      if (!q) return;
      input.value = '';
      renderUserBubble(log, q);
      var pending = renderPending(log);
      setBusy(true);
      askAssistant(q).then(function (res) {
        pending.remove();
        renderReply(log, res.body || {}, fallbackPassport);
        setBusy(false);
        input.focus();
      }).catch(function () {
        pending.remove();
        renderReply(log, { error: 'route_pending', message: 'Could not reach the assistant. Try again in a moment.' }, fallbackPassport);
        setBusy(false);
      });
    });

    var hint = el('p', { class: 'kolm-asst__hint' });
    hint.innerHTML = 'Every reply carries a passport hash. <a href="/about-the-assistant">Read how it was built -&gt;</a>';
    host.appendChild(hint);
  }

  function boot() {
    var hosts = document.querySelectorAll('[data-kolm-assistant]');
    for (var i = 0; i < hosts.length; i++) mount(hosts[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

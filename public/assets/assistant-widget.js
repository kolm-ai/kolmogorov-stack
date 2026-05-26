(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__assistantWidgetBooted) return;
  window.__assistantWidgetBooted = true;

  var MAX_CONVERSATION_TURNS = 6;
  var ENDPOINT = '/v1/assistant/chat';
  var KEY_NAMES = ['kolm-key', 'ks_api_key', 'kolm_api_key', 'KOLM_API_KEY'];

  var state = {
    open: false,
    mounted: false,
    busy: false,
    triggerEl: null,
    panelEl: null,
    bodyEl: null,
    statusEl: null,
    inputEl: null,
    submitEl: null,
    closeEl: null,
    clearEl: null,
    titleId: 'assistant-panel-title-' + Math.random().toString(36).slice(2, 8),
    history: [],
    previousFocus: null,
  };

  function getApiKey() {
    try {
      for (var i = 0; i < KEY_NAMES.length; i++) {
        var v = window.localStorage.getItem(KEY_NAMES[i]);
        if (v) return v;
      }
    } catch (_) {}
    return null;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderMarkdownBasic(s) {
    var esc = escapeHtml(s);
    esc = esc.replace(/```([\s\S]*?)```/g, function (_, body) {
      return '<pre><code>' + body + '</code></pre>';
    });
    esc = esc.replace(/`([^`]+)`/g, '<code>$1</code>');
    return esc;
  }

  function createTrigger() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'assistant-trigger';
    btn.setAttribute('aria-label', 'Open assistant (Ctrl+K)');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('data-assistant-trigger', '1');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path d="M20 12c0 4.418-3.582 8-8 8a8.03 8.03 0 0 1-3.16-.642L4 21l1.642-4.84A7.96 7.96 0 0 1 4 12c0-4.418 3.582-8 8-8s8 3.582 8 8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
        '<path d="M8.5 12h.01M12 12h.01M15.5 12h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '</svg>' +
      '<span class="assistant-trigger-kbd">' + (isMac() ? '⌘K' : 'Ctrl+K') + '</span>';
    btn.addEventListener('click', open);
    return btn;
  }

  function isMac() {
    try { return /Mac|iPod|iPhone|iPad/.test(navigator.platform || ''); } catch (_) { return false; }
  }

  function createPanel() {
    var panel = document.createElement('aside');
    panel.className = 'assistant-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', state.titleId);
    panel.setAttribute('data-open', 'false');
    panel.setAttribute('data-assistant-panel', '1');

    var header = document.createElement('header');
    header.className = 'assistant-header';
    header.innerHTML =
      '<div>' +
        '<h2 id="' + state.titleId + '">kolm assistant</h2>' +
        '<div class="assistant-subtitle">kolm-assistant-1.5b</div>' +
      '</div>' +
      '<div class="assistant-header-actions">' +
        '<button type="button" class="assistant-icon-btn" data-assistant-clear aria-label="Clear conversation">↻</button>' +
        '<button type="button" class="assistant-icon-btn" data-assistant-close aria-label="Close assistant">✕</button>' +
      '</div>';

    var body = document.createElement('div');
    body.className = 'assistant-body';
    body.setAttribute('data-assistant-body', '1');

    var footer = document.createElement('footer');
    footer.className = 'assistant-footer';
    footer.innerHTML =
      '<form class="assistant-form" data-assistant-form>' +
        '<textarea class="assistant-textarea" data-assistant-input rows="1" placeholder="Ask anything about kolm…" aria-label="Message"></textarea>' +
        '<button type="submit" class="assistant-submit" data-assistant-submit>Send</button>' +
      '</form>' +
      '<div class="assistant-footer-meta">' +
        '<span>Conversation kept in this tab.</span>' +
        '<a href="/account/api-keys" rel="nofollow">API key</a>' +
      '</div>';

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);
    return panel;
  }

  function mountWidget() {
    if (state.mounted) return;
    state.triggerEl = createTrigger();
    state.panelEl = createPanel();
    document.body.appendChild(state.triggerEl);
    document.body.appendChild(state.panelEl);
    state.bodyEl = state.panelEl.querySelector('[data-assistant-body]');
    state.inputEl = state.panelEl.querySelector('[data-assistant-input]');
    state.submitEl = state.panelEl.querySelector('[data-assistant-submit]');
    state.closeEl = state.panelEl.querySelector('[data-assistant-close]');
    state.clearEl = state.panelEl.querySelector('[data-assistant-clear]');

    state.closeEl.addEventListener('click', close);
    state.clearEl.addEventListener('click', clearConversation);
    state.panelEl.querySelector('[data-assistant-form]').addEventListener('submit', onSubmit);
    state.inputEl.addEventListener('keydown', onInputKey);
    state.inputEl.addEventListener('input', autosize);
    document.addEventListener('keydown', onDocKey);
    state.panelEl.addEventListener('keydown', trapFocus);

    renderEmpty();
    state.mounted = true;
  }

  function autosize() {
    var el = state.inputEl;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  function renderEmpty() {
    if (!state.bodyEl) return;
    state.bodyEl.innerHTML =
      '<div class="assistant-empty">' +
        '<strong>How can I help?</strong><br>' +
        'Ask about your captures, compile a model, troubleshoot a verb, or just say hi. ' +
        'Press <kbd>' + (isMac() ? '⌘K' : 'Ctrl+K') + '</kbd> to open from anywhere.' +
      '</div>';
  }

  function open() {
    if (!state.mounted) mountWidget();
    state.previousFocus = document.activeElement;
    state.open = true;
    state.panelEl.setAttribute('data-open', 'true');
    state.panelEl.setAttribute('aria-modal', 'true');
    state.triggerEl.setAttribute('aria-expanded', 'true');
    setTimeout(function () {
      if (state.inputEl) state.inputEl.focus();
    }, 50);
  }

  function close() {
    state.open = false;
    if (state.panelEl) {
      state.panelEl.setAttribute('data-open', 'false');
      state.panelEl.setAttribute('aria-modal', 'false');
    }
    if (state.triggerEl) state.triggerEl.setAttribute('aria-expanded', 'false');
    try {
      if (state.previousFocus && typeof state.previousFocus.focus === 'function') {
        state.previousFocus.focus();
      } else if (state.triggerEl) {
        state.triggerEl.focus();
      }
    } catch (_) {}
  }

  function clearConversation() {
    state.history = [];
    renderEmpty();
    if (state.inputEl) state.inputEl.focus();
  }

  function onDocKey(ev) {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      if (state.open) close(); else open();
      return;
    }
    if (state.open && ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }

  function trapFocus(ev) {
    if (ev.key !== 'Tab' || !state.open) return;
    var focusables = state.panelEl.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  function onInputKey(ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      onSubmit(ev);
    }
  }

  function onSubmit(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (state.busy) return;
    var prompt = (state.inputEl.value || '').trim();
    if (!prompt) return;
    var key = getApiKey();
    if (!key) {
      renderStatus('No API key found. ', '<a href="/signin?next=' + encodeURIComponent(location.pathname) + '">Sign in</a> to use the assistant.', 'locked');
      return;
    }
    appendTurn('user', prompt, null);
    state.inputEl.value = '';
    autosize();
    sendTurn(prompt, key);
  }

  function appendTurn(role, content, meta) {
    if (state.bodyEl.querySelector('.assistant-empty')) {
      state.bodyEl.innerHTML = '';
    }
    var wrap = document.createElement('div');
    wrap.className = 'assistant-turn';
    wrap.setAttribute('data-role', role);
    var roleLabel = role === 'user' ? 'You' : 'Assistant';
    var html = '<div class="assistant-turn-role">' + roleLabel + '</div>' +
               '<div class="assistant-turn-body">' + renderMarkdownBasic(content) + '</div>';
    if (meta) {
      if (meta.passport_hash) {
        html += '<div class="assistant-turn-passport">passport ' +
                '<a href="/v1/verify/' + encodeURIComponent(meta.passport_hash) + '" target="_blank" rel="noopener noreferrer">' +
                escapeHtml(meta.passport_hash) +
                '</a></div>';
      }
      var bits = [];
      if (meta.provider_used) bits.push('via ' + escapeHtml(meta.provider_used));
      if (typeof meta.latency_ms === 'number') bits.push(meta.latency_ms + 'ms');
      if (typeof meta.cost_usd === 'number') bits.push('$' + Number(meta.cost_usd).toFixed(4));
      if (bits.length) html += '<div class="assistant-turn-meta">' + bits.join(' · ') + '</div>';
    }
    wrap.innerHTML = html;
    state.bodyEl.appendChild(wrap);
    state.bodyEl.scrollTop = state.bodyEl.scrollHeight;
    state.history.push({ role: role, content: content });
    if (state.history.length > MAX_CONVERSATION_TURNS * 2) {
      state.history = state.history.slice(-MAX_CONVERSATION_TURNS * 2);
    }
  }

  function renderStatus(text, html, kind) {
    var existing = state.bodyEl.querySelector('.assistant-status');
    if (existing) existing.parentNode.removeChild(existing);
    var n = document.createElement('div');
    n.className = 'assistant-status';
    n.setAttribute('data-kind', kind || 'info');
    n.innerHTML = escapeHtml(text || '') + (html || '');
    state.bodyEl.appendChild(n);
    state.bodyEl.scrollTop = state.bodyEl.scrollHeight;
  }

  function sendTurn(prompt, key) {
    state.busy = true;
    if (state.submitEl) state.submitEl.disabled = true;
    renderStatus('Thinking…', '', 'info');
    var body = {
      prompt: prompt,
      max_tokens: 512,
      conversation: state.history.slice(0, -1).slice(-MAX_CONVERSATION_TURNS * 2),
    };
    fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + key,
      },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) {
        return { status: r.status, body: j };
      }).catch(function () {
        return { status: r.status, body: null };
      });
    }).then(function (res) {
      var bodyEl = state.bodyEl;
      var s = bodyEl ? bodyEl.querySelector('.assistant-status') : null;
      if (s) s.parentNode.removeChild(s);
      var j = res.body || {};
      if (res.status === 401) {
        renderStatus('Not signed in. ', '<a href="/signin?next=' + encodeURIComponent(location.pathname) + '">Sign in</a> to continue.', 'locked');
        return;
      }
      if (res.status === 402 && j.tier_locked) {
        var required = escapeHtml(j.required || 'a paid plan');
        renderStatus('', 'The kolm assistant requires <strong>' + required + '</strong> or higher. <a href="/pricing">View pricing →</a>', 'locked');
        return;
      }
      if (res.status === 429) {
        renderStatus('Rate limit reached. Try again in a minute.', '', 'warn');
        return;
      }
      if (res.status >= 400) {
        renderStatus('Request failed: ' + (j.error || j.message || ('HTTP ' + res.status)), '', 'error');
        return;
      }
      if (j.ok === false && j.reason === 'budget_exceeded') {
        var cap = j.cost_cap_usd != null ? ('$' + Number(j.cost_cap_usd).toFixed(2)) : '$0.01';
        renderStatus('Per-turn cost cap exceeded (' + cap + '). ' + (j.message || ''), '', 'warn');
        return;
      }
      var response = j.response || (j.envelope && j.envelope.response) || '';
      var meta = {
        passport_hash: j.passport_hash || (j.envelope && j.envelope.passport_hash) || null,
        provider_used: j.provider_used || (j.envelope && j.envelope.provider_used) || j.source || null,
        latency_ms: j.latency_ms != null ? j.latency_ms : ((j.envelope && j.envelope.latency_ms) || null),
        cost_usd: j.cost_usd != null ? j.cost_usd : ((j.envelope && j.envelope.cost_usd) || null),
      };
      if (!response) {
        renderStatus('Empty response from assistant.', '', 'warn');
        return;
      }
      appendTurn('assistant', response, meta);
    }).catch(function (e) {
      renderStatus('Network error: ' + (e && e.message ? e.message : 'fetch failed'), '', 'error');
    }).then(function () {
      state.busy = false;
      if (state.submitEl) state.submitEl.disabled = false;
    });
  }

  function boot() {
    if (window.__KOLM_ASSISTANT_NO_AUTOBOOT) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
      return;
    }
    mountWidget();
  }

  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K') && !state.mounted) {
      ev.preventDefault();
      open();
    }
  }, { once: false });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

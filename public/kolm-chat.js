/*  W844 — kolm-chat.js
 *  Pre-auth + post-auth chat console. Mounts to any [data-kolm-chat] element.
 *
 *  Pre-auth: anonymous, talks to POST /v1/free/chat (IP rate-limited 20/day).
 *  Post-auth: same endpoint; the route soft-auths the cookie/header and
 *  upgrades to a tenant-scoped snapshot when a real key is attached.
 *
 *  The component is intentionally framework-free — it ships alongside the
 *  static site (kolm.ai/index.html) and the post-auth dashboard. Same pipe,
 *  same DOM contract, so the chat box on the homepage IS the chat box in
 *  /account.
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  if (window.__kolmChatBooted) return;
  window.__kolmChatBooted = true;

  // W845: user feedback on W844 chips — "verify the receipt on this artifact"
  // and "show me my opportunities" were dropped. Both leaned on internal
  // jargon (CIDs, opportunity-detection) that a first-time visitor can't
  // act on. Replaced with concrete user-pain prompts where the next CLI is
  // obviously valuable.
  var EXAMPLES = [
    'where do I start?',
    'how do I cut my OpenAI bill in half?',
    'capture my anthropic traffic',
    'distill a 7B model from my support transcripts',
    'fit deepseek-r1-32b on a single 5090',
    'what runs on a Mac laptop?',
    'how do I prove to compliance the model didn’t change?',
    'how do I self-host this air-gapped?'
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

  function detectAuthed() {
    // Best-effort: a tenant key cookie sets either kolm_session or kolm_csrf.
    // If we see either we treat the caller as authed and skip the free-tier
    // counter render (the server will still validate; this is UX only).
    if (typeof document.cookie !== 'string') return false;
    return /(?:^|;\s*)(kolm_session|kolm_csrf|kolm_role)=/.test(document.cookie);
  }

  function mountOne(host) {
    if (host.dataset.kolmChatMounted === '1') return;
    host.dataset.kolmChatMounted = '1';
    var mode = host.getAttribute('data-kolm-chat-mode') || (detectAuthed() ? 'auth' : 'free');
    var heading = host.getAttribute('data-kolm-chat-heading') || (mode === 'auth' ? 'kolm console' : 'try kolm');
    var subtitle = host.getAttribute('data-kolm-chat-subtitle') || (mode === 'auth'
      ? 'ask in plain English. the console returns the exact CLI command.'
      : 'ask anything about kolm. the chat returns the exact CLI you would run, plus the why. 20 free messages a day, no account needed.');

    host.innerHTML = '';
    host.classList.add('ks-cli-chat__box');

    // header
    var head = el('div', { class: 'ks-cli-chat__head' });
    var dots = el('span', { class: 'dots' });
    for (var d = 0; d < 3; d++) dots.appendChild(el('span'));
    head.appendChild(dots);
    head.appendChild(el('b', { text: 'kolm ' + (mode === 'auth' ? 'console' : 'chat') }));
    var tag = el('span', { class: 'head-tag', text: mode === 'auth' ? 'authed' : 'free tier' });
    head.appendChild(tag);
    host.appendChild(head);

    // log
    var log = el('div', { class: 'ks-cli-chat__log', role: 'log', 'aria-live': 'polite' });

    function addMsg(who, body, extra) {
      var msg = el('div', { class: 'ks-cli-chat__msg ks-cli-chat__msg--' + who });
      msg.appendChild(el('span', { class: 'who', text: who === 'user' ? 'you' : 'kolm' }));
      var b = el('div', { class: 'body' });
      if (typeof body === 'string') b.innerHTML = body;
      else b.appendChild(body);
      msg.appendChild(b);
      if (extra) msg.appendChild(extra);
      log.appendChild(msg);
      log.scrollTop = log.scrollHeight;
      return msg;
    }

    // greeting
    var greet = mode === 'auth'
      ? 'tenant context loaded. ask in plain English &mdash; e.g. <code>distill my anthropic traffic</code> or <code>verify receipt cid:abc</code>. i return the exact CLI.'
      : 'hi. ask anything about kolm and i&rsquo;ll tell you the exact CLI to run plus the why. try <code>capture my openai calls</code> or click an example below.';
    addMsg('kolm', greet);

    // example chips
    var chips = el('div', { class: 'ks-cli-chat__chips' });
    for (var i = 0; i < EXAMPLES.length; i++) {
      (function (q) {
        var c = el('button', { type: 'button', class: 'ks-cli-chat__chip', text: q });
        c.addEventListener('click', function () { send(q); });
        chips.appendChild(c);
      })(EXAMPLES[i]);
    }
    log.appendChild(chips);

    host.appendChild(log);

    // form
    var form = el('form', { class: 'ks-cli-chat__form', autocomplete: 'off' });
    var input = el('input', { type: 'text', name: 'q', placeholder: 'ask kolm anything', maxlength: '600', 'aria-label': 'Ask kolm anything' });
    var btn = el('button', { type: 'submit', text: 'send' });
    form.appendChild(input);
    form.appendChild(btn);
    host.appendChild(form);

    // hint
    var hint = el('div', { class: 'ks-cli-chat__hint' });
    hint.textContent = mode === 'auth' ? 'authed · unlimited' : 'free tier · 20 messages / day · no account needed';
    host.appendChild(hint);

    var busy = false;
    // W848 — last workflow returned from the server. POSTed back as
    // previous_workflow on every subsequent turn so the classifier's
    // FOLLOWUP_AFFIRM_RE pre-pass can resolve "ok do it" / "run that"
    // against the recipe the user just saw. Cleared on low-confidence
    // / ask-fallback turns so a stray "yes" doesn't latch onto stale
    // context after the user has changed topic.
    var lastWorkflow = null;
    function setBusy(b) { busy = b; btn.disabled = b; input.disabled = b; btn.textContent = b ? '…' : 'send'; }

    function renderResponse(data) {
      var wrap = el('div', { class: 'ks-cli-chat__resp' });
      // W848 — if the classifier resolved via the affirmative-followup
      // path, tell the user explicitly so they don't think we hallucinated
      // a command out of "ok".
      if (data.source === 'followup') {
        wrap.appendChild(el('p', { class: 'ks-cli-chat__followup', html: '<b>got it.</b> running the previous recipe:' }));
      }
      // W848 — if the classifier fell through every layer and came back
      // below the confidence floor, we route to 'ask' and surface a soft
      // "i'm not sure" rather than pretending a substring match is real.
      if (data.source === 'low_confidence') {
        wrap.appendChild(el('p', { class: 'ks-cli-chat__softfail', html: '<b>i’m not sure what you meant.</b> closest guesses below; try rephrasing or pick one:' }));
      }
      // W847 — if the server returned a workflow recipe (multi-step), render
      // that INSTEAD of a single bare command. This is what makes "compile a
      // model to blur porn" useful: 4 numbered steps the user can actually run.
      if (data.workflow && data.workflow.steps && data.workflow.steps.length > 1) {
        if (data.workflow.summary) {
          wrap.appendChild(el('p', { class: 'ks-cli-chat__wf-summary', text: data.workflow.summary }));
        }
        var ol = el('ol', { class: 'ks-cli-chat__wf-steps' });
        for (var s = 0; s < data.workflow.steps.length; s++) {
          var step = data.workflow.steps[s];
          var li = el('li', { class: 'ks-cli-chat__wf-step' });
          var pre = el('pre', { class: 'ks-cli-chat__cmd' });
          pre.textContent = '$ ' + step.cmd;
          li.appendChild(pre);
          if (step.why) li.appendChild(el('span', { class: 'ks-cli-chat__wf-why', text: step.why }));
          ol.appendChild(li);
        }
        wrap.appendChild(ol);
        if (data.workflow.namespace_hint) {
          wrap.appendChild(el('p', { class: 'ks-cli-chat__why', html: '<b>tip:</b> replace <code>' + escapeHtml(data.workflow.namespace_hint) + '</code> with whatever namespace you want.' }));
        }
      } else {
        // single-command path (status verbs, fully-specified asks)
        var pre1 = el('pre', { class: 'ks-cli-chat__cmd' });
        pre1.textContent = '$ ' + (data.command || ('kolm ' + (data.verb || 'next')));
        wrap.appendChild(pre1);
        if (data.why) {
          wrap.appendChild(el('p', { class: 'ks-cli-chat__why', html: '<b>why:</b> ' + escapeHtml(data.why) + (data.confidence != null ? ' &middot; <span class="conf">confidence ' + (Math.round((data.confidence || 0) * 100)) + '%</span>' : '') }));
        }
      }
      // alternatives
      if (data.alternatives && data.alternatives.length) {
        var alts = el('div', { class: 'ks-cli-chat__alts' });
        alts.appendChild(el('span', { class: 'alts-label', text: 'also tried:' }));
        for (var j = 0; j < data.alternatives.length; j++) {
          var a = data.alternatives[j];
          alts.appendChild(el('code', { text: a.command }));
        }
        wrap.appendChild(alts);
      }
      // CTA — when free tier and quota getting low, surface signup link
      if (data.cta) {
        var cta = el('a', { class: 'ks-cli-chat__cta', href: data.cta.href, text: data.cta.label + ' →' });
        wrap.appendChild(cta);
      }
      // remaining (free tier UX)
      if (data.mode === 'free' && data.remaining != null) {
        hint.textContent = 'free tier · ' + data.remaining + ' messages left today · ' + (data.remaining <= 5 ? 'sign up free for unlimited' : 'no account needed');
      }
      return wrap;
    }

    function renderError(status, body) {
      var wrap = el('div', { class: 'ks-cli-chat__resp ks-cli-chat__resp--err' });
      if (status === 429 || (body && body.error === 'free_quota_exceeded')) {
        wrap.appendChild(el('p', { html: '<b>free quota used up.</b> you ran the 20 free messages for today.' }));
        var ctaHref = (body && body.cta && body.cta.href) || '/signup';
        var ctaLabel = (body && body.cta && body.cta.label) || 'Create a free account';
        wrap.appendChild(el('a', { class: 'ks-cli-chat__cta', href: ctaHref, text: ctaLabel + ' →' }));
        hint.textContent = 'free tier exhausted · sign up for unlimited';
      } else if (status === 413) {
        wrap.appendChild(el('p', { text: 'message too long — free tier caps each turn at 600 characters.' }));
      } else if (status === 400) {
        wrap.appendChild(el('p', { text: 'please type a question first.' }));
      } else {
        wrap.appendChild(el('p', { text: 'something broke on our side (' + status + '). try again in a moment.' }));
      }
      return wrap;
    }

    function send(q) {
      q = String(q || '').trim();
      if (!q || busy) return;
      addMsg('user', escapeHtml(q));
      // remove chips after first send
      if (chips.parentNode) chips.parentNode.removeChild(chips);
      input.value = '';
      setBusy(true);
      var placeholder = addMsg('kolm', '<span class="ks-cli-chat__thinking">thinking…</span>');
      // W848 — thread the previous workflow back to the server so the
      // classifier's followup pre-pass can resolve bare affirmatives.
      var payload = { question: q };
      if (lastWorkflow) payload.previous_workflow = lastWorkflow;
      var bodyJson = JSON.stringify(payload);
      fetch('/v1/free/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: bodyJson
      }).then(function (r) {
        return r.json().then(function (data) { return { status: r.status, data: data }; }).catch(function () { return { status: r.status, data: null }; });
      }).then(function (out) {
        placeholder.parentNode.removeChild(placeholder);
        if (out.status >= 200 && out.status < 300 && out.data && out.data.ok) {
          // W848 — retain the workflow for the next turn UNLESS the
          // classifier itself flagged low confidence (in which case the
          // user is probably changing topic and a stale "yes" should not
          // re-fire the last recipe).
          // W852 — belt-and-suspenders: when the server returned a usable
          // command but didn't ship a workflow envelope (older router build
          // or future skinny-response opt-in), synth a one-step workflow
          // from data.command so the FOLLOWUP_AFFIRM_RE pre-pass on the
          // next turn still has something to latch onto.
          if (out.data.source === 'low_confidence') {
            lastWorkflow = null;
          } else if (out.data.workflow && out.data.workflow.steps && out.data.workflow.steps.length) {
            lastWorkflow = out.data.workflow;
          } else if (out.data.command) {
            lastWorkflow = {
              summary: 'previous command',
              steps: [{ cmd: String(out.data.command).replace(/^\$\s*/, ''), why: '' }],
            };
          }
          addMsg('kolm', renderResponse(out.data));
        } else {
          addMsg('kolm', renderError(out.status, out.data));
        }
      }).catch(function () {
        placeholder.parentNode.removeChild(placeholder);
        addMsg('kolm', renderError(0, null));
      }).then(function () { setBusy(false); input.focus(); });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      send(input.value);
    });

    // expose for AT
    host.__kolmChatSend = send;
  }

  function mountAll() {
    var hosts = document.querySelectorAll('[data-kolm-chat]');
    for (var i = 0; i < hosts.length; i++) mountOne(hosts[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAll);
  } else {
    mountAll();
  }

  // Re-scan when nav.js or other scripts inject placeholders later in the
  // boot cycle (e.g. the account command center)
  setTimeout(mountAll, 600);
  setTimeout(mountAll, 1800);
})();

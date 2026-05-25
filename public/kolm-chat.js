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
    'kolm whoami',
    'kolm doctor',
    'kolm changelog',
    'kolm route doctor',
    'kolm federated peers',
    'distill from claude, gpt, and gemini together',
    'show me a regulatory packet for the EU AI Act',
    'how do I self-host this air-gapped?'
  ];

  // W854 — safe verbs are runnable inline. Mirrors the server-side allowlist
  // in src/router.js. Used to decide which workflow steps get a "▶ run" button.
  var RUNNABLE_VERBS = {
    whoami: true, doctor: true, version: true, '--version': true,
    help: true, '--help': true, '-h': true, changelog: true,
    catalog: true, list: true, route: true, federated: true,
    intent: true, verbs: true, gateway: true, envcheck: true,
  };

  function isRunnableCmd(cmd) {
    var s = String(cmd || '').trim().replace(/^\$\s*/, '');
    if (!/^kolm\s+/.test(s)) return false;
    var verb = s.split(/\s+/)[1] || '';
    return !!RUNNABLE_VERBS[verb];
  }

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
      ? 'type a kolm command or ask in plain English. read-only verbs run inline; write verbs return the recipe to copy.'
      : 'type a kolm command — `kolm whoami`, `kolm doctor`, `kolm changelog`. or ask in plain English and run the recipe. 20 free / day, no account needed.');

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
      ? 'tenant context loaded. type a kolm command (read-only verbs run inline) or ask in plain English to synth a recipe. <code>kolm whoami</code> · <code>kolm doctor</code> · <code>kolm changelog</code> all just work.'
      : 'this is the real kolm CLI &mdash; read-only verbs run live, write verbs return the recipe to copy. try <code>kolm whoami</code>, <code>kolm doctor</code>, <code>kolm route doctor</code>, or click a chip below.';
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
    var input = el('input', { type: 'text', name: 'q', placeholder: 'kolm whoami  ·  or ask in plain English', maxlength: '600', 'aria-label': 'Type a kolm command or ask a question' });
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
          var cmdRow = el('div', { class: 'ks-cli-chat__cmd-row' });
          var pre = el('pre', { class: 'ks-cli-chat__cmd' });
          pre.textContent = '$ ' + step.cmd;
          cmdRow.appendChild(pre);
          // W854 — actual CLI execution button for safe read-only verbs.
          // Anything else (distill, capture, compile, run) stays a
          // copy-and-paste suggestion because it would change tenant state.
          if (isRunnableCmd(step.cmd)) {
            (function (cmdText, mountInto) {
              var runBtn = el('button', { type: 'button', class: 'ks-cli-chat__run', text: '▶ run' });
              runBtn.addEventListener('click', function () { runCli(cmdText.replace(/^\$\s*/, ''), mountInto, runBtn); });
              cmdRow.appendChild(runBtn);
            })(step.cmd, li);
          }
          li.appendChild(cmdRow);
          if (step.why) li.appendChild(el('span', { class: 'ks-cli-chat__wf-why', text: step.why }));
          ol.appendChild(li);
        }
        wrap.appendChild(ol);
        if (data.workflow.namespace_hint) {
          wrap.appendChild(el('p', { class: 'ks-cli-chat__why', html: '<b>tip:</b> replace <code>' + escapeHtml(data.workflow.namespace_hint) + '</code> with whatever namespace you want.' }));
        }
      } else {
        // single-command path (status verbs, fully-specified asks)
        var cmdRow1 = el('div', { class: 'ks-cli-chat__cmd-row' });
        var pre1 = el('pre', { class: 'ks-cli-chat__cmd' });
        var singleCmd = data.command || ('kolm ' + (data.verb || 'next'));
        pre1.textContent = '$ ' + singleCmd;
        cmdRow1.appendChild(pre1);
        if (isRunnableCmd(singleCmd)) {
          (function (cmdText, mountInto) {
            var runBtn = el('button', { type: 'button', class: 'ks-cli-chat__run', text: '▶ run' });
            runBtn.addEventListener('click', function () { runCli(cmdText, mountInto, runBtn); });
            cmdRow1.appendChild(runBtn);
          })(singleCmd, wrap);
        }
        wrap.appendChild(cmdRow1);
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

    // W854 — render real stdout/stderr from /v1/free/cli into the chat log.
    function renderCliResult(data) {
      var wrap = el('div', { class: 'ks-cli-chat__resp ks-cli-chat__resp--cli' });
      var meta = el('p', { class: 'ks-cli-chat__cli-meta' });
      var statusOk = data.exit_code === 0;
      meta.innerHTML = (statusOk
        ? '<span class="ks-cli-chat__cli-ok">exit 0</span>'
        : '<span class="ks-cli-chat__cli-err">exit ' + data.exit_code + '</span>')
        + ' &middot; ' + data.duration_ms + 'ms'
        + (data.truncated ? ' &middot; <span class="ks-cli-chat__cli-truncated">output truncated</span>' : '');
      wrap.appendChild(meta);
      if (data.stdout && data.stdout.length) {
        var outPre = el('pre', { class: 'ks-cli-chat__cli-out', text: data.stdout });
        wrap.appendChild(outPre);
      }
      if (data.stderr && data.stderr.length) {
        var errPre = el('pre', { class: 'ks-cli-chat__cli-err-pre', text: data.stderr });
        wrap.appendChild(errPre);
      }
      if (!data.stdout && !data.stderr) {
        wrap.appendChild(el('p', { class: 'ks-cli-chat__cli-empty', text: '(no output)' }));
      }
      if (data.cta) {
        var cta = el('a', { class: 'ks-cli-chat__cta', href: data.cta.href, text: data.cta.label + ' →' });
        wrap.appendChild(cta);
      }
      if (data.mode === 'free' && data.remaining != null) {
        hint.textContent = 'free tier · ' + data.remaining + ' messages left today · ' + (data.remaining <= 5 ? 'sign up free for unlimited' : 'no account needed');
      }
      return wrap;
    }

    // W854 — execute a kolm command directly via /v1/free/cli. The button is
    // only emitted next to safe verbs; the server enforces the allowlist
    // independently so a forged client can't escalate.
    function runCli(cmdText, mountInto, btn) {
      if (busy) return;
      setBusy(true);
      if (btn) { btn.disabled = true; btn.textContent = 'running…'; }
      var placeholder = addMsg('kolm', '<span class="ks-cli-chat__thinking">running ' + escapeHtml(cmdText) + '…</span>');
      fetch('/v1/free/cli', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ command: cmdText })
      }).then(function (r) {
        return r.json().then(function (data) { return { status: r.status, data: data }; }).catch(function () { return { status: r.status, data: null }; });
      }).then(function (out) {
        placeholder.parentNode.removeChild(placeholder);
        if (out.status >= 200 && out.status < 300 && out.data && out.data.ok) {
          addMsg('kolm', renderCliResult(out.data));
        } else if (out.data && out.data.error) {
          var wrap = el('div', { class: 'ks-cli-chat__resp ks-cli-chat__resp--err' });
          wrap.appendChild(el('p', { html: '<b>can’t run that here:</b> ' + escapeHtml(out.data.message || out.data.error) }));
          if (out.data.error === 'verb_not_allowed' || out.data.error === 'subverb_not_allowed') {
            wrap.appendChild(el('a', { class: 'ks-cli-chat__cta', href: '/signup', text: 'Sign up free for the full CLI →' }));
          }
          addMsg('kolm', wrap);
        } else {
          addMsg('kolm', renderError(out.status, out.data));
        }
      }).catch(function () {
        placeholder.parentNode.removeChild(placeholder);
        addMsg('kolm', renderError(0, null));
      }).then(function () {
        setBusy(false);
        if (btn) { btn.disabled = false; btn.textContent = '▶ run again'; }
        input.focus();
      });
    }

    function send(q) {
      q = String(q || '').trim();
      if (!q || busy) return;
      addMsg('user', escapeHtml(q));
      // remove chips after first send
      if (chips.parentNode) chips.parentNode.removeChild(chips);
      input.value = '';
      // W854 — if the input is already a kolm command, skip the classifier
      // and execute it directly. This is what makes the chat box an actual
      // terminal rather than just a command synthesizer.
      if (/^kolm\s+/i.test(q)) {
        runCli(q, null, null);
        return;
      }
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

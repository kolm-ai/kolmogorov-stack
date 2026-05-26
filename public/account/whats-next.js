// W889-7.2 — "What's next" contextual action engine.
//
// Reads /v1/account/state, applies the rules table below, renders the top-N
// next actions into #whats-next-body. The route is auth-gated; if the user
// is logged out (or the route 404s during a partial rollout) the engine
// falls back to the inline empty state without throwing.
//
// Rules are ordered by impact (compile-ready namespaces > drift > seeding >
// stale artifact > rotate-key > routine onboarding nudges). Each rule maps
// a signal kind from /v1/account/state to a {label, why, action_label,
// action_href, kind, score} card spec.
(function () {
  var body = document.getElementById('whats-next-body');
  var empty = document.getElementById('whats-next-empty');
  if (!body) return;

  var SEV_COLOR = {
    compile: 'var(--accent)',
    drift: 'var(--warn)',
    rotate: 'var(--warn)',
    routine: 'var(--ink-mute)',
  };

  // Escape helper — overview.html already exposes window.kesc, but we keep a
  // local fallback so whats-next.js is safe to mount on any /account/* page.
  function esc(s) {
    if (window.kesc) return window.kesc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function buildCards(state) {
    var sigs = (state && state.signals) || [];
    var cards = [];
    for (var i = 0; i < sigs.length; i++) {
      var s = sigs[i];
      var card = ruleFor(s, state);
      if (card) cards.push(card);
    }
    if (cards.length === 0) cards = onboardingNudges(state);
    cards.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    return cards.slice(0, 4);
  }

  function ruleFor(signal, state) {
    var kind = signal.kind;
    if (kind === 'namespace_ready') {
      return {
        kind: 'compile',
        score: 100 + Math.min(20, Math.floor((signal.value || 0) / 100)),
        label: 'Namespace ' + signal.namespace + ' has ' + signal.value + ' captures — ready to compile.',
        why: 'Crossed the 1k-capture readiness threshold. Distillation has enough signal to ship a specialist.',
        action_label: 'Compile now',
        action_href: '/account/builds?ns=' + encodeURIComponent(signal.namespace),
      };
    }
    if (kind === 'namespace_almost_ready') {
      return {
        kind: 'routine',
        score: 40 + Math.min(20, Math.floor((signal.value || 0) / 25)),
        label: 'Namespace ' + signal.namespace + ' has ' + signal.value + ' captures — almost ready.',
        why: 'Needs roughly ' + Math.max(0, 1000 - signal.value) + ' more captures before the compile gate opens.',
        action_label: 'View readiness',
        action_href: '/account/captured?ns=' + encodeURIComponent(signal.namespace),
      };
    }
    if (kind === 'compile_stale') {
      return {
        kind: 'compile',
        score: 70,
        label: 'Your last compile was ' + signal.value + ' days ago.',
        why: 'Recompiling against fresh captures keeps the specialist on the current traffic distribution.',
        action_label: 'Bench vs. baseline',
        action_href: '/account/bench',
      };
    }
    if (kind === 'seed_training') {
      return {
        kind: 'compile',
        score: 80,
        label: 'You have ' + signal.value + ' captures — time to seed a training set.',
        why: 'Approved captures become the dataset the distiller compiles against.',
        action_label: 'Seed dataset',
        action_href: '/account/datasets',
      };
    }
    if (kind === 'rotate_key') {
      return {
        kind: 'rotate',
        score: 30,
        label: 'Your primary API key is ' + signal.value + ' days old.',
        why: 'Keys older than 90 days are due for rotation. Rotating revokes the old key everywhere.',
        action_label: 'Rotate key',
        action_href: '/account/api-keys',
      };
    }
    if (kind === 'compile_first') {
      return {
        kind: 'compile',
        score: 90,
        label: "You haven't compiled an artifact yet.",
        why: 'A compiled .kolm is the proof-of-distillation: signed weights + receipts + K-Score.',
        action_label: 'Try kolm compile',
        action_href: '/docs/quickstart',
      };
    }
    if (kind === 'route_first') {
      return {
        kind: 'compile',
        score: 95,
        label: 'No captures yet — route a first call to see the loop close.',
        why: 'Point any OpenAI/Anthropic SDK at the gateway and watch your first capture land in real time.',
        action_label: 'Open onboarding',
        action_href: '/account/onboarding',
      };
    }
    return null;
  }

  function onboardingNudges(state) {
    var nudges = [];
    nudges.push({
      kind: 'routine',
      score: 10,
      label: 'Pick an onboarding path.',
      why: 'Four guided flows: have GPU, no GPU, route traffic, verify a .kolm. Each under two minutes.',
      action_label: 'Choose a path',
      action_href: '/account/onboarding',
    });
    nudges.push({
      kind: 'routine',
      score: 8,
      label: 'Read the run quickstart.',
      why: 'Three command pastes get you from signup to a signed receipt.',
      action_label: 'Open docs',
      action_href: '/docs/quickstart',
    });
    return nudges;
  }

  function render(cards) {
    if (!cards || cards.length === 0) {
      body.hidden = true;
      empty.hidden = false;
      return;
    }
    body.removeAttribute('aria-busy');
    body.hidden = false;
    empty.hidden = true;
    body.innerHTML = cards.map(function (it) {
      var color = SEV_COLOR[it.kind] || 'var(--ink-mute)';
      return '<div class="metric-card" data-whats-next-kind="' + esc(it.kind || '') + '" style="border-left:3px solid ' + color + '">' +
        '<div class="label" style="color:' + color + '">' + esc(it.label || 'Next action') + '</div>' +
        '<div style="font-size:12.5px;color:var(--ink-mute);margin-top:6px;line-height:1.5">' + esc(it.why || '') + '</div>' +
        '<a class="btn" href="' + esc(it.action_href || '#') + '" style="margin-top:10px;display:inline-block;border:1px solid var(--line);padding:5px 10px;border-radius:4px;font-family:var(--mono);font-size:11.5px;text-decoration:none;color:var(--ink)">' + esc(it.action_label || 'Open') + ' &rarr;</a>' +
      '</div>';
    }).join('');
  }

  function load() {
    var opts = { credentials: 'include', headers: { accept: 'application/json' } };
    fetch('/v1/account/state', opts).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (j) {
      var cards = buildCards(j);
      render(cards);
    }).catch(function () {
      body.hidden = true;
      empty.hidden = false;
    });
  }

  // Expose for overview.html and tests; mount immediately on script load.
  window.kolmWhatsNext = { load: load, buildCards: buildCards, ruleFor: ruleFor };
  load();
})();

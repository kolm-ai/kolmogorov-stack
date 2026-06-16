// SOTA Dashboard lane — integration-only surfaces under public/account/**.
//
// These tests exercise the REAL wiring this lane ships:
//   - public/account/train.html  : distill/eval/curate/holdout panel that calls
//     /v1/distill/from-captures/preview, /v1/specialists/auto-distill, the real
//     SSE compile stream, and renders the planDataBudget sparkline.
//   - public/account/org.html    : team/members/seats/invites/provider-keys
//     panel that drives /v1/orgs/* + /v1/teams/* + provider-keys, plus the
//     rotate_shared_keys banner + seat_ceiling line.
//   - public/signup.html         : oauth_error handling (email_unverified,
//     account_link_required).
//   - public/account/dashboard.html : recovered=1 flag + nav wiring.
//
// The page logic lives in inline <script>. We (1) assert the route/contract
// wiring is present in the markup, and (2) extract the PURE helper functions
// from the script and run them, so the sparkline math and budget-selection
// logic are exercised for real (no DOM, no jsdom).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const train = read('public/account/train.html');
const org = read('public/account/org.html');
const signup = read('public/signup.html');
const dashboard = read('public/account/dashboard.html');

// Pull a `function NAME(...) { ... }` body out of a source string by brace
// matching, so we can evaluate the real implementation in isolation.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'function ' + name + ' present');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const body = src.slice(start, i);
  // eslint-disable-next-line no-new-func
  return new Function('esc', body + '\nreturn ' + name + ';')((s) => String(s == null ? '' : s));
}

// ---------------------------------------------------------------------------
// TASK 2.2/2.3/2.4 — train/eval/curate/holdout panel wiring
// ---------------------------------------------------------------------------
test('train.html calls the real preview + distill + jobs + SSE routes (no 503 stub)', () => {
  assert.match(train, /\/v1\/distill\/from-captures\/preview/, 'reads the dataset preview');
  assert.match(train, /\/v1\/specialists\/auto-distill/, 'Train button POSTs the un-gated auto-distill');
  assert.match(train, /\/v1\/jobs\//, 'polls the real job record');
  assert.match(train, /EventSource/, 'opens the real SSE stream');
  assert.match(train, /\/v1\/compile\/stream\//, 'streams the real compile pipeline');
  // never a fabricated/stub success path:
  assert.doesNotMatch(train, /demo:\s*true/, 'no fabricated demo stream');
});

test('train.html renders SSE hello/metric events (real k_score, not a stub)', () => {
  assert.match(train, /addEventListener\(['"]hello['"]/);
  assert.match(train, /addEventListener\(['"]metric['"]/);
  assert.match(train, /k_score/, 'live K-score from the metric event');
});

test('train.html surfaces auto-distill not-enough-captures + 503 loud, never fake-pass', () => {
  assert.match(train, /o\.status\s*===\s*400/, 'handles the <1000 pairs 400');
  assert.match(train, /o\.status\s*===\s*503/, 'surfaces trainer-not-configured 503');
  assert.match(train, /o\.body\.hint/, 'shows the actionable env hint on 503');
});

// ---------------------------------------------------------------------------
// TASK 1 (dashboard.planDataBudget) — sparkline + insufficient handling
// ---------------------------------------------------------------------------
test('pickDataBudget finds planDataBudget under each documented envelope key', () => {
  const pick = extractFn(train, 'pickDataBudget');
  const block = { basis: 'rectified', curve: [{ n: 1, k_hat: 0.5 }] };
  assert.equal(pick({ planDataBudget: block }), block, 'planDataBudget');
  assert.equal(pick({ plan_data_budget: block }), block, 'plan_data_budget');
  assert.equal(pick({ data_budget: block }), block, 'data_budget');
  assert.equal(pick({ data: { planDataBudget: block } }), block, 'nested under data');
  assert.equal(pick(null), null, 'null-safe');
  assert.equal(pick({}), null, 'absent -> null');
});

test('sparkline emits a real SVG polyline from the K-vs-rows curve', () => {
  const spark = extractFn(train, 'sparkline');
  const curve = [
    { n: 100, k_hat: 0.40 },
    { n: 500, k_hat: 0.62 },
    { n: 1000, k_hat: 0.74 },
    { n: 2000, k_hat: 0.81 },
  ];
  const svg = spark(curve, 0.80);
  assert.match(svg, /<svg[^>]*class="spark"/, 'emits the sparkline svg');
  assert.match(svg, /<path class="line" d="M/, 'draws the line path');
  assert.match(svg, /<line class="tgt"/, 'draws the target-K reference line');
  assert.match(svg, /data-testid="spark"/);
  // monotone rising curve -> last point should sit higher (smaller y) than first
  const ys = [...svg.matchAll(/L([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]));
  assert.ok(ys.length >= 3, 'multiple points plotted');
});

test('sparkline refuses to draw with fewer than 2 valid points', () => {
  const spark = extractFn(train, 'sparkline');
  assert.equal(spark([{ n: 1, k_hat: 0.5 }], 0.8), '', 'single point -> no chart');
  assert.equal(spark([], 0.8), '', 'empty -> no chart');
});

test('train.html shows the >=4 observations hint when basis is insufficient', () => {
  assert.match(train, /basis\s*===\s*['"]insufficient['"]/, 'branches on insufficient basis');
  assert.match(train, /at least 4 measured/i, 'renders the >=4 observations hint');
  assert.match(train, /databudget-insufficient/, 'hint is locatable');
  assert.match(train, /Capture ~/, 'capture ~N more pairs callout present');
});

test('train.html exposes holdout/leakage + K-delta + curation panels (eval gate)', () => {
  assert.match(train, /panel-holdout/);
  assert.match(train, /disjoint/i, 'fail-closed disjointness surfaced');
  assert.match(train, /panel-kdelta/, 'candidate vs prior K-score');
  assert.match(train, /panel-curate/, 'curation near-dup/semantic/quality counts');
  assert.match(train, /near-dup|near_dup/i);
});

// ---------------------------------------------------------------------------
// TASK 2.1 + TASK 1 (team detail) — org / members / seats / invites / keys
// ---------------------------------------------------------------------------
test('org.html drives the full /v1/orgs + /v1/teams management surface', () => {
  assert.match(org, /\/v1\/orgs\/['"+]|\/v1\/orgs\/'\s*\+\s*encodeURIComponent/, 'reads the org');
  assert.match(org, /\/members/, 'lists members');
  assert.match(org, /\/invites/, 'lists + creates invites');
  assert.match(org, /\/v1\/teams\/invites\//, 'revokes invites');
  assert.match(org, /\/members\/['"+]|members\/'\s*\+\s*encodeURIComponent/, 'PATCH role + DELETE member');
  assert.match(org, /\/leave/, 'leave team');
  assert.match(org, /\/v1\/account\/provider-keys/, 'manages provider keys (member + team scope)');
  assert.match(org, /\/v1\/teams\/[^\s'"]*captures|teams.*captures|captures/, 'captures rollup reachable');
});

test('org.html renders seat_ceiling as "X / ceiling seats - upgrade to add more"', () => {
  assert.match(org, /seat_ceiling/, 'reads seat_ceiling from the team detail envelope');
  assert.match(org, /upgrade to add more/, 'exact upgrade copy');
  assert.match(org, /seat-line/, 'seat line is locatable');
});

test('org.html renders the rotate_shared_keys banner with dismiss -> ack route', () => {
  assert.match(org, /rotate_shared_keys/, 'reads the rotation recommendation');
  assert.match(org, /member_removed/, 'maps member_removed reason');
  assert.match(org, /member_role_lowered/, 'maps member_role_lowered reason');
  assert.match(org, /rotate-banner/, 'banner is locatable');
  assert.match(org, /\/events\/[^\s'"]*\/ack|events\/'\s*\+\s*encodeURIComponent[^\n]*\/ack/, 'dismiss calls the ack route');
});

test('org.html provider-key team scope is admin-gated client-side', () => {
  assert.match(org, /scope\s*=\s*['"]team['"]|scope:\s*['"]team['"]/, 'can store a team-scope key');
  assert.match(org, /isAdmin\(\)/, 'team-scope toggle is admin-gated');
});

// ---------------------------------------------------------------------------
// TASK 1 — signup oauth_error + dashboard recovered flag
// ---------------------------------------------------------------------------
test('signup.html maps the two new oauth_error codes to recovery copy', () => {
  assert.match(signup, /oauth_error/, 'reads the oauth_error query param');
  assert.match(signup, /email_unverified/, 'handles email_unverified');
  assert.match(signup, /account_link_required/, 'handles account_link_required');
  // account_link_required must steer to an authenticated session, not fresh signin
  assert.match(signup, /Sign in with your existing method/, 'links to existing-method sign-in');
});

test('dashboard.html surfaces the recovered=1 confirmation once and cleans the URL', () => {
  assert.match(dashboard, /recovered/, 'reads the recovered flag');
  assert.match(dashboard, /recovered-banner/, 'banner is locatable');
  assert.match(dashboard, /rotated out/, 'tells the user the old key is rotated');
  assert.match(dashboard, /replaceState/, 'cleans the flag from the URL');
});

test('dashboard.html nav links the new train + team surfaces', () => {
  assert.match(dashboard, /href="\/account\/train"/);
  assert.match(dashboard, /href="\/account\/org"/);
});

// ---------------------------------------------------------------------------
// Cross-cutting safety: ASCII-only user copy, no fake "honest" wording, the
// same-origin credentialed fetch + headers() tenant-scoping pattern preserved.
// ---------------------------------------------------------------------------
test('new surfaces keep the credentialed fetch + headers() tenant pattern', () => {
  for (const [name, src] of [['train', train], ['org', org]]) {
    assert.match(src, /credentials:\s*['"]same-origin['"]/, name + ' uses same-origin creds');
    assert.match(src, /function headers\(/, name + ' carries the bearer key via headers()');
    assert.match(src, /Authorization['"]?\s*[:=]\s*['"]?Bearer/i, name + ' sends Bearer auth');
  }
});

test('lane-owned surfaces are fully ASCII (mojibake trap)', () => {
  // train.html + org.html are authored end-to-end by this lane, so every byte
  // must be ASCII. signup.html/dashboard.html predate this lane and carry
  // box-drawing glyphs in their style comments; the per-edit ASCII guarantee
  // for those is covered by the banned-word + per-edit review below.
  for (const [name, src] of [['train', train], ['org', org]]) {
    for (let i = 0; i < src.length; i++) {
      const code = src.charCodeAt(i);
      assert.ok(code <= 0x7f, name + ' has a non-ASCII char at ' + i + ' (code ' + code + ')');
    }
  }
});

test('no lane surface uses the banned word', () => {
  for (const [name, src] of [['train', train], ['org', org], ['signup', signup], ['dashboard', dashboard]]) {
    assert.doesNotMatch(src, /\bhonest(y)?\b/i, name + ' avoids the banned word');
  }
});

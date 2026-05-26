// W888-F — Account UI fleet dashboard + 4-path onboarding lock-ins.
//
// Pinned items:
//   1) Fleet dashboard exists and references /v1/fleet/status (auth+telemetry surface)
//   2) Fleet dashboard exists and references /v1/devices/list (registry surface)
//   3) Onboarding picker exists and links to all 4 path partials
//   4) Each of the 4 path partials exists on disk
//   5) Each path partial declares a "Step X of Y" progress indicator
//   6) Each path partial contains at least one copy-paste-ready <pre> or <code> block
//   7) Overview page exposes a "What's next" container the engine can mount into
//   8) Signup page redirects new accounts to /account/onboarding (not /dashboard)
//   9) Account sidebar (overview.html) exposes a Fleet entry between Devices and Storage
//  10) None of the new W888-F surfaces leak the banned warm-paper hex tokens
//       (#a5621e burnt sienna, #c2410c carrot, #92400e amber) in fill/bg roles
//  11) None of the new W888-F surfaces leak the banned word "honest"/"honesty"
//       (per the long-standing user directive logged 2026-05-26)
//  12) Each path partial persists progress to localStorage key "kolm-onboarding"
//       so the picker can surface a Resume nudge
//  13) Onboarding picker writes a "kolm-onboarding-started" timestamp on click
//       so the W888-F engine can score "still onboarding" cohorts
//  14) Path D (verify) computes a content hash in-browser via crypto.subtle.digest
//       so the verifier works fully offline with no account roundtrip
//  15) Fleet dashboard ships an "Add device" modal with SSH/local/Ollama/k8s types
//       so all four W888-C/D device registration paths have a UI entry point

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ACCOUNT_DIR = path.join(REPO_ROOT, 'public', 'account');
const ONBOARDING_DIR = path.join(ACCOUNT_DIR, 'onboarding');

const FLEET_HTML = path.join(ACCOUNT_DIR, 'fleet.html');
const ONBOARDING_HUB = path.join(ACCOUNT_DIR, 'onboarding.html');
const OVERVIEW_HTML = path.join(ACCOUNT_DIR, 'overview.html');
const SIGNUP_HTML = path.join(REPO_ROOT, 'public', 'signup.html');

const PATH_FILES = [
  { slug: 'gpu', file: path.join(ONBOARDING_DIR, 'path-gpu.html'), totalSteps: 3 },
  { slug: 'no-gpu', file: path.join(ONBOARDING_DIR, 'path-no-gpu.html'), totalSteps: 4 },
  { slug: 'route', file: path.join(ONBOARDING_DIR, 'path-route.html'), totalSteps: 3 },
  { slug: 'verify', file: path.join(ONBOARDING_DIR, 'path-verify.html'), totalSteps: 2 },
];

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

// ---------------------------------------------------------------------------
// 1) Fleet dashboard exists and references /v1/fleet/status
// ---------------------------------------------------------------------------
test('W888-F #1 — fleet.html exists and references /v1/fleet/status', () => {
  assert.ok(fs.existsSync(FLEET_HTML), `expected ${FLEET_HTML} to exist`);
  const body = read(FLEET_HTML);
  assert.match(body, /\/v1\/fleet\/status/, 'fleet.html must call /v1/fleet/status');
});

// ---------------------------------------------------------------------------
// 2) Fleet dashboard references /v1/devices/list
// ---------------------------------------------------------------------------
test('W888-F #2 — fleet.html references /v1/devices/list', () => {
  const body = read(FLEET_HTML);
  assert.match(body, /\/v1\/devices\/list/, 'fleet.html must call /v1/devices/list');
});

// ---------------------------------------------------------------------------
// 3) Onboarding hub exists and links to all 4 path partials
// ---------------------------------------------------------------------------
test('W888-F #3 — onboarding hub links to all 4 path partials', () => {
  assert.ok(fs.existsSync(ONBOARDING_HUB), `expected ${ONBOARDING_HUB} to exist`);
  const body = read(ONBOARDING_HUB);
  for (const p of PATH_FILES) {
    const needle = `/account/onboarding/path-${p.slug}.html`;
    assert.ok(
      body.includes(needle),
      `onboarding.html missing link to ${needle}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4) Each of the 4 path partials exists on disk
// ---------------------------------------------------------------------------
test('W888-F #4 — all 4 onboarding path partials exist', () => {
  for (const p of PATH_FILES) {
    assert.ok(fs.existsSync(p.file), `expected ${p.file} to exist`);
  }
});

// ---------------------------------------------------------------------------
// 5) Each path partial declares a "Step X of Y" indicator
// ---------------------------------------------------------------------------
test('W888-F #5 — each path partial has a "Step X of Y" indicator', () => {
  for (const p of PATH_FILES) {
    const body = read(p.file);
    const re = new RegExp(`Step\\s+\\d+\\s+of\\s+${p.totalSteps}\\b`);
    assert.match(
      body,
      re,
      `${path.basename(p.file)} must include "Step N of ${p.totalSteps}" indicator`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6) Each path partial contains at least one copy-paste-ready block
// ---------------------------------------------------------------------------
test('W888-F #6 — each path partial contains a <pre> or <code> block', () => {
  for (const p of PATH_FILES) {
    const body = read(p.file);
    const hasPre = /<pre[\s>]/i.test(body);
    const hasCode = /<code[\s>]/i.test(body);
    assert.ok(
      hasPre || hasCode,
      `${path.basename(p.file)} must contain a <pre> or <code> block`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7) Overview page exposes a "What's next" container
// ---------------------------------------------------------------------------
test('W888-F #7 — overview.html has a "What\'s next" container', () => {
  const body = read(OVERVIEW_HTML);
  assert.match(
    body,
    /What['’]s next/,
    'overview.html must contain a "What\'s next" heading or container',
  );
  assert.match(
    body,
    /id="whats-next-body"|data-w888f="whats-next"/,
    'overview.html must expose a mount point for the W888-F engine',
  );
});

// ---------------------------------------------------------------------------
// 8) Signup page redirects new signups to /account/onboarding
// ---------------------------------------------------------------------------
test('W888-F #8 — signup.html routes new accounts to /account/onboarding', () => {
  const body = read(SIGNUP_HTML);
  // The "cta-dashboard" button after a successful signup is the new-user entry
  // path; it must land on the onboarding picker, not the legacy /dashboard.
  assert.match(
    body,
    /persistThenGo\(['"]\/account\/onboarding['"]\)/,
    'signup.html cta-dashboard handler must redirect to /account/onboarding',
  );
});

// ---------------------------------------------------------------------------
// 9) Account sidebar exposes a Fleet entry
// ---------------------------------------------------------------------------
test('W888-F #9 — overview.html sidebar exposes a Fleet entry', () => {
  const body = read(OVERVIEW_HTML);
  assert.match(
    body,
    /<a\s+href="\/account\/fleet"[^>]*>Fleet<\/a>/,
    'overview.html sidebar must link to /account/fleet',
  );
});

// ---------------------------------------------------------------------------
// 10) None of the new W888-F surfaces leak banned warm-paper hex tokens
// ---------------------------------------------------------------------------
test('W888-F #10 — no banned warm-paper hex tokens in new surfaces', () => {
  const bannedHex = [/#a5621e/i, /#c2410c/i, /#92400e/i];
  const files = [
    FLEET_HTML,
    ONBOARDING_HUB,
    ...PATH_FILES.map((p) => p.file),
  ];
  for (const f of files) {
    const body = read(f);
    for (const re of bannedHex) {
      assert.ok(
        !re.test(body),
        `${path.basename(f)} must not contain banned warm-paper hex ${re.source}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 11) None of the new W888-F surfaces leak the banned word "honest"/"honesty"
// ---------------------------------------------------------------------------
test('W888-F #11 — no banned word "honest" in new surfaces', () => {
  const files = [
    FLEET_HTML,
    ONBOARDING_HUB,
    ...PATH_FILES.map((p) => p.file),
  ];
  for (const f of files) {
    const body = read(f);
    assert.ok(
      !/honest/i.test(body),
      `${path.basename(f)} must not contain "honest"/"honesty" — use Caveats/Constraints/Limitations`,
    );
  }
});

// ---------------------------------------------------------------------------
// 12) Each path partial persists progress to localStorage "kolm-onboarding"
// ---------------------------------------------------------------------------
test('W888-F #12 — each path partial persists progress via localStorage', () => {
  for (const p of PATH_FILES) {
    const body = read(p.file);
    assert.match(
      body,
      /kolm-onboarding/,
      `${path.basename(p.file)} must persist progress to localStorage key "kolm-onboarding"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 13) Onboarding picker writes a "kolm-onboarding-started" timestamp on click
// ---------------------------------------------------------------------------
test('W888-F #13 — onboarding hub records start timestamp', () => {
  const body = read(ONBOARDING_HUB);
  assert.match(
    body,
    /kolm-onboarding-started/,
    'onboarding.html must write a "kolm-onboarding-started" timestamp when a path card is clicked',
  );
});

// ---------------------------------------------------------------------------
// 14) Path D (verify) computes hashes in-browser via crypto.subtle.digest
// ---------------------------------------------------------------------------
test('W888-F #14 — verify path computes SHA-256 in-browser via crypto.subtle', () => {
  const verify = read(path.join(ONBOARDING_DIR, 'path-verify.html'));
  assert.match(
    verify,
    /crypto\.subtle\.digest/,
    'path-verify.html must compute the content hash with crypto.subtle.digest for offline operation',
  );
  assert.match(
    verify,
    /SHA-256/i,
    'path-verify.html must specify SHA-256 as the hash algorithm',
  );
});

// ---------------------------------------------------------------------------
// 15) Fleet dashboard ships an "Add device" modal with all 4 type entries
// ---------------------------------------------------------------------------
test('W888-F #15 — fleet.html "Add device" modal covers SSH/local/Ollama/k8s', () => {
  const body = read(FLEET_HTML);
  // The four canonical device types from W888-C device-registry.js. Each must
  // appear as a selectable option in the Add device form (case-insensitive
  // match on the type string anywhere in the modal markup).
  for (const t of ['ssh', 'local', 'ollama', 'k8s']) {
    const re = new RegExp(`["'>]\\s*${t}\\s*["'<]`, 'i');
    assert.ok(
      re.test(body),
      `fleet.html Add device modal must include the "${t}" device type`,
    );
  }
});

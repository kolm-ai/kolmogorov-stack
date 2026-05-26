// W889-7 — Onboarding (4 paths) + "What's next" engine + doctor 12-dep audit.
//
// Block 7 of PART J in KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md. Three
// sub-items:
//   7.1 — Four-path first-run onboarding (W888-F substrate verified)
//   7.2 — Dashboard "What's next" contextual action engine + /v1/account/state
//   7.3 — kolm doctor probes all 12 MCD-listed deps (node, npm, git, python3,
//         pip, docker, rustc, cargo, cc, make, huggingface-cli, llama-cli)
//
// 10 invariants pinned below. All file/string assertions are deterministic;
// the doctor JSON probe runs the real CLI under a scrubbed HOME so it stays
// reproducible across boxes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ACCOUNT_DIR = path.join(REPO_ROOT, 'public', 'account');
const ONBOARDING_DIR = path.join(ACCOUNT_DIR, 'onboarding');
const KOLM_CLI = path.join(REPO_ROOT, 'cli', 'kolm.js');

const ONBOARDING_HUB = path.join(ACCOUNT_DIR, 'onboarding.html');
const OVERVIEW_HTML = path.join(ACCOUNT_DIR, 'overview.html');
const WHATS_NEXT_JS = path.join(ACCOUNT_DIR, 'whats-next.js');
const ROUTER_JS = path.join(REPO_ROOT, 'src', 'router.js');
const AUTH_JS = path.join(REPO_ROOT, 'src', 'auth.js');
const KOLM_JS = path.join(REPO_ROOT, 'cli', 'kolm.js');

const PATH_FILES = [
  path.join(ONBOARDING_DIR, 'path-gpu.html'),
  path.join(ONBOARDING_DIR, 'path-no-gpu.html'),
  path.join(ONBOARDING_DIR, 'path-route.html'),
  path.join(ONBOARDING_DIR, 'path-verify.html'),
];

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

// ---------------------------------------------------------------------------
// 1) onboarding.html exists and has 4 path cards
// ---------------------------------------------------------------------------
test('W889-7 #1 — onboarding hub renders 4 path-card entries', () => {
  assert.ok(fs.existsSync(ONBOARDING_HUB), `expected ${ONBOARDING_HUB} to exist`);
  const body = read(ONBOARDING_HUB);
  const matches = body.match(/class="path-card"/g) || [];
  assert.ok(
    matches.length >= 4,
    `onboarding.html must include at least 4 .path-card elements; found ${matches.length}`,
  );
});

// ---------------------------------------------------------------------------
// 2) Each of the 4 path-*.html files exists
// ---------------------------------------------------------------------------
test('W889-7 #2 — all 4 path-*.html partials exist on disk', () => {
  for (const f of PATH_FILES) {
    assert.ok(fs.existsSync(f), `expected ${f} to exist`);
  }
});

// ---------------------------------------------------------------------------
// 3) Each path-*.html contains a multi-step wizard (>= 3 data-step markers)
// ---------------------------------------------------------------------------
test('W889-7 #3 — each path partial declares >= 3 step markers (or progress segs)', () => {
  for (const f of PATH_FILES) {
    const body = read(f);
    // Count data-step="N" markers (steps + progress segments). Path D
    // (verify) intentionally has 2 wizard steps but emits >= 3 data-step
    // markers across its progress bar + section blocks, matching the W888-F
    // contract that every wizard ships discoverable step anchors.
    const stepHits = (body.match(/data-step\s*=\s*["']?\d+/g) || []).length;
    assert.ok(
      stepHits >= 3,
      `${path.basename(f)} must have >= 3 step markers; found ${stepHits}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4) overview.html references whats-next.js
// ---------------------------------------------------------------------------
test('W889-7 #4 — overview.html loads whats-next.js', () => {
  const body = read(OVERVIEW_HTML);
  assert.match(
    body,
    /\/account\/whats-next\.js/,
    'overview.html must script-src /account/whats-next.js',
  );
});

// ---------------------------------------------------------------------------
// 5) whats-next.js exists and fetches /v1/account/state
// ---------------------------------------------------------------------------
test('W889-7 #5 — whats-next.js fetches /v1/account/state', () => {
  assert.ok(fs.existsSync(WHATS_NEXT_JS), `expected ${WHATS_NEXT_JS} to exist`);
  const body = read(WHATS_NEXT_JS);
  assert.match(
    body,
    /fetch\s*\(\s*['"]\/v1\/account\/state['"]/,
    'whats-next.js must fetch /v1/account/state',
  );
});

// ---------------------------------------------------------------------------
// 6) src/router.js has GET /v1/account/state
// ---------------------------------------------------------------------------
test('W889-7 #6 — router.js registers GET /v1/account/state', () => {
  const body = read(ROUTER_JS);
  assert.match(
    body,
    /r\.get\(\s*['"]\/v1\/account\/state['"]/,
    'router.js must register GET /v1/account/state',
  );
});

// ---------------------------------------------------------------------------
// 7) /v1/account/state is NOT in PUBLIC_API (auth-gated)
// ---------------------------------------------------------------------------
test('W889-7 #7 — /v1/account/state is auth-gated (not in PUBLIC_API)', () => {
  const auth = read(AUTH_JS);
  // PUBLIC_API is a function literal; the absence of the literal path
  // '/v1/account/state' in the allowlist is sufficient proof. We assert no
  // hard-coded entry references it.
  assert.ok(
    !/['"]\/v1\/account\/state['"]/.test(auth),
    "/v1/account/state must NOT appear in src/auth.js PUBLIC_API allowlist",
  );
  // Cross-check: the route handler itself short-circuits on req.tenant_record
  // missing with HTTP 401, which is the second leg of the auth contract.
  const router = read(ROUTER_JS);
  const handlerMatch = router.match(/r\.get\(\s*['"]\/v1\/account\/state['"][^)]*\)[^{]*\{[\s\S]{0,500}/);
  assert.ok(handlerMatch, '/v1/account/state handler block must be locatable');
  assert.match(
    handlerMatch[0],
    /tenant_record.*401/s,
    '/v1/account/state handler must 401 when req.tenant_record is missing',
  );
});

// ---------------------------------------------------------------------------
// 8) cli/kolm.js cmdDoctor probes >= 12 distinct deps
// ---------------------------------------------------------------------------
test('W889-7 #8 — cmdDoctor probes >= 12 deps (greppable presence of all 12 names)', () => {
  const body = read(KOLM_JS);
  // The 12 deps the MCD enumerates verbatim. We assert each is named in the
  // doctor probe section so a future refactor that drops a probe gets caught.
  const required = ['node', 'npm', 'git', 'python', 'pip', 'docker', 'rustc', 'cargo', 'cc', 'make', 'huggingface-cli', 'llama-cli'];
  for (const dep of required) {
    // Restrict the search to the doctor section to avoid false positives
    // elsewhere in the CLI (e.g., a docs example mentioning "make").
    const doctorStart = body.indexOf('async function cmdDoctor');
    assert.ok(doctorStart > 0, 'cmdDoctor must exist');
    const doctorEnd = body.indexOf('async function cmdLogs', doctorStart);
    const doctorSlice = body.slice(doctorStart, doctorEnd > 0 ? doctorEnd : doctorStart + 200_000);
    assert.ok(
      doctorSlice.toLowerCase().includes(dep.toLowerCase()),
      `cmdDoctor must probe "${dep}" (MCD-listed); the doctor body did not mention it`,
    );
  }
});

// ---------------------------------------------------------------------------
// 9) kolm doctor --json returns deps_probed >= 12
// ---------------------------------------------------------------------------
test('W889-7 #9 — kolm doctor --json reports deps_probed >= 12', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w889-7-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    KOLM_API_KEY: '',
    RUNPOD_API_KEY: '',
    MODAL_TOKEN_ID: '',
    MODAL_TOKEN_SECRET: '',
    KOLM_BASE_URL: 'http://127.0.0.1:1',
  };
  const r = spawnSync(process.execPath, ['--no-warnings', KOLM_CLI, 'doctor', '--json', '--allow-logged-out'], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  assert.ok(r.stdout, 'doctor --json must emit stdout');
  const body = JSON.parse(r.stdout.trim());
  assert.equal(typeof body.deps_probed, 'number', 'deps_probed must be a number');
  assert.ok(
    body.deps_probed >= 12,
    `doctor --json deps_probed must be >= 12; got ${body.deps_probed}`,
  );
  // Cross-check: every MCD-listed dep is also present as a check name (so
  // the count + the names agree). Some probes use display labels different
  // from the raw binary name (e.g., "C compiler (optional)" covers "cc"),
  // so the match is substring-lenient.
  const flat = body.checks.map((c) => c.name.toLowerCase()).join(' | ');
  for (const dep of ['node version', 'npm', 'git', 'python', 'pip', 'docker', 'rustc', 'cargo', 'c compiler', 'make', 'huggingface-cli', 'llama-cli']) {
    assert.ok(
      flat.includes(dep),
      `doctor --json checks[] must include a row mentioning "${dep}"; got: ${flat.slice(0, 400)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 10) None of the new HTML surfaces contain the banned word
// ---------------------------------------------------------------------------
test('W889-7 #10 — no banned word in onboarding HTML + whats-next.js', () => {
  const files = [ONBOARDING_HUB, ...PATH_FILES, WHATS_NEXT_JS];
  const banned = /\bhonest(y|ly)?\b/i;
  for (const f of files) {
    const body = read(f);
    assert.ok(
      !banned.test(body),
      `${path.basename(f)} must not contain "honest"/"honesty"/"honestly" — use Caveats/Constraints/Limitations`,
    );
  }
});

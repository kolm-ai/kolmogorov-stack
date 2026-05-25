// W869 - Forge umbrella + persona surface lock-in.
//
// Pins the W869 master roadmap deliverables:
//   - `kolm forge` top-level dispatcher (umbrella over hardware/fit/inspect/
//     experts/merge/serve/bench/quantize/export)
//   - Persona D admin: passport export, procurement, bundle airgap
//   - Persona F: bench --axes, bench --compare, spec-toml-reference docs
//
// W604 anti-brittleness: family lock uses regex + numeric threshold (never
// an explicit hard-coded sibling list).
//
// Items pinned:
//   1) cli/kolm.js wires case 'forge': to a dispatcher
//   2) cli/kolm.js carries persona D HTTP routes/CLI markers (W869 Persona D)
//   3) cli/kolm.js carries `--axes` flag in bench dispatcher (Persona F.5)
//   4) cli/kolm.js carries `--compare` flag in bench dispatcher (Persona F)
//   5) docs/spec-toml-reference.md exists and is non-trivial (Persona F.3)
//   6) src/router.js wires /v1/passport/* routes (Persona D.8)
//   7) src/router.js wires /v1/procurement/* routes (Persona D.2)
//   8) src/router.js wires /v1/bundle/airgap route (Persona D.5)
//   9) Family lock — at least one prior wave8xx test file exists

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = __dirname;
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const ROUTER_PATH = path.join(REPO_ROOT, 'src', 'router.js');

function readCli() { return fs.readFileSync(CLI_PATH, 'utf8'); }
function readRouter() { return fs.readFileSync(ROUTER_PATH, 'utf8'); }

// ----------------------------------------------------------------------------
// 1) `kolm forge` dispatcher wired
// ----------------------------------------------------------------------------
test("W869 #1 - cli/kolm.js wires case 'forge' to a dispatcher with sub-verbs", () => {
  const src = readCli();
  assert.ok(/case 'forge':/.test(src),
    `expected "case 'forge':" in main() switch; not found`);
  // The forge umbrella has an INNER switch over sub-verbs. We pin that the
  // inner switch references at least 5 of the documented sub-verbs by
  // searching for the "forge <sub>" withErrorContext labels (uniquely
  // identifying the forge dispatcher, not random `case 'hardware':` strings
  // that might live in unrelated top-level dispatchers).
  const subs = ['hardware', 'fit', 'inspect', 'experts', 'compile', 'quantize', 'merge', 'serve', 'bench', 'export'];
  const hits = subs.filter((sub) => new RegExp(`'forge ${sub}'`).test(src));
  assert.ok(hits.length >= 5,
    `forge dispatcher must wire >=5 sub-verbs via withErrorContext('forge <sub>', ...); found ${hits.length}: ${hits.join(', ')}`);
});

// ----------------------------------------------------------------------------
// 2) W869 Persona D markers
// ----------------------------------------------------------------------------
test('W869 #2 - cli/kolm.js carries W869 Persona D markers (passport/procurement/airgap)', () => {
  const src = readCli();
  // At least one of the persona-D verbs must be wired.
  const personaD = ['passport', 'procurement', 'bundle', 'airgap'];
  const wired = personaD.filter((v) => new RegExp(`case '${v}':`).test(src));
  assert.ok(wired.length >= 1,
    `expected at least 1 Persona D verb wired in cli/kolm.js; found 0 of ${personaD.join(', ')}`);
});

// ----------------------------------------------------------------------------
// 3) bench --axes flag
// ----------------------------------------------------------------------------
test('W869 #3 - cli/kolm.js bench dispatcher accepts --axes flag (Persona F.5)', () => {
  const src = readCli();
  assert.ok(/--axes/.test(src),
    `cli/kolm.js must reference --axes flag (Persona F.5 K-Score axes inspection)`);
});

// ----------------------------------------------------------------------------
// 4) bench --compare flag
// ----------------------------------------------------------------------------
test('W869 #4 - cli/kolm.js bench dispatcher accepts --compare flag (Persona F)', () => {
  const src = readCli();
  assert.ok(/--compare\b/.test(src),
    `cli/kolm.js must reference --compare flag (Persona F two-artifact diff)`);
});

// ----------------------------------------------------------------------------
// 5) docs/spec-toml-reference.md
// ----------------------------------------------------------------------------
test('W869 #5 - docs/spec-toml-reference.md exists and is non-trivial', () => {
  const docPath = path.join(REPO_ROOT, 'docs', 'spec-toml-reference.md');
  assert.ok(fs.existsSync(docPath), `${docPath} must exist (Persona F.3)`);
  const stat = fs.statSync(docPath);
  assert.ok(stat.size > 2_000,
    `docs/spec-toml-reference.md must be >2 KB (canonical, exhaustive); got ${stat.size} bytes`);
});

// ----------------------------------------------------------------------------
// 6) /v1/passport/* routes
// ----------------------------------------------------------------------------
test('W869 #6 - src/router.js wires /v1/passport routes (Persona D.8)', () => {
  const src = readRouter();
  assert.ok(/['"]\/v1\/passport/.test(src),
    `src/router.js must declare at least one /v1/passport route`);
});

// ----------------------------------------------------------------------------
// 7) /v1/procurement/* routes
// ----------------------------------------------------------------------------
test('W869 #7 - src/router.js wires /v1/procurement routes (Persona D.2)', () => {
  const src = readRouter();
  assert.ok(/['"]\/v1\/procurement/.test(src),
    `src/router.js must declare at least one /v1/procurement route`);
});

// ----------------------------------------------------------------------------
// 8) /v1/bundle/airgap route
// ----------------------------------------------------------------------------
test('W869 #8 - src/router.js wires /v1/bundle/airgap route (Persona D.5)', () => {
  const src = readRouter();
  assert.ok(/['"]\/v1\/bundle\/airgap/.test(src),
    `src/router.js must declare /v1/bundle/airgap route`);
});

// ----------------------------------------------------------------------------
// 9) Family lock (W604): regex + threshold, never explicit array.
// ----------------------------------------------------------------------------
test('W869 #9 - W604 family pattern: at least one prior wave8xx test file exists', () => {
  const re = /^wave(\d{3,4}).*\.test\.js$/;
  const files = fs.readdirSync(TESTS_DIR);
  const wave8xx = files.filter((f) => {
    const m = f.match(re);
    if (!m) return false;
    const n = Number(m[1]);
    return n >= 800 && n <= 999;
  });
  assert.ok(wave8xx.length >= 1,
    `expected at least 1 wave8xx test file (regex+threshold per W604); found ${wave8xx.length}`);
});

// W530 — pin the lint:refs gate inside scripts/release-verify.cjs.
//
// Why this lock-in: lint:refs is the first gate (cheapest, runs in seconds)
// and it's the canary that catches stale doc links, dead static asset refs,
// and broken cross-page hrefs before the slow gates burn 30 minutes. If a
// refactor lets a broken-href escape (e.g. by removing --strict on the href
// audit, or by dropping the regex that checks for "broken: 0"), the gate
// silently passes-open and bad links ship to production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const DRIVER = path.join(REPO, 'scripts', 'release-verify.cjs');
const SRC = fs.readFileSync(DRIVER, 'utf8');

test('W530 #1 — gateLintRefs is defined in release-verify.cjs', () => {
  assert.match(SRC, /async function gateLintRefs\(\)/,
    'gateLintRefs must exist; stale refs cannot regress silently');
});

test('W530 #2 — gate runs npm run lint:refs (not the individual scripts directly)', () => {
  // Going through `npm run lint:refs` means whatever the package.json maps
  // to is what runs — so a future maintainer can extend the lint:refs
  // pipeline without touching release-verify.cjs.
  assert.match(SRC, /\[\s*['"]run['"]\s*,\s*['"]lint:refs['"]\s*\]/,
    'gate must invoke npmBin run lint:refs (uses package.json mapping)');
});

test('W530 #3 — package.json lint:refs script runs both static-refs + href --strict', () => {
  // The npm script must do both audits. Drift here would let the gate pass
  // even with stale refs or broken hrefs.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const script = pkg.scripts && pkg.scripts['lint:refs'];
  assert.ok(script, 'package.json must declare a "lint:refs" script');
  assert.match(script, /audit-static-refs\.cjs/, 'lint:refs must include audit-static-refs.cjs');
  assert.match(script, /audit-href\.cjs/, 'lint:refs must include audit-href.cjs');
  assert.match(script, /--strict/, 'href audit must run in --strict mode (no warnings allowed)');
});

test('W530 #4 — gate checks BOTH "missing static refs: 0" AND "broken: 0" in stdout', () => {
  // Defense in depth: the npm script exits 0 only if both audits pass, but
  // the gate also greps the output as a second-line check. Drop one of
  // these regexes and the gate silently passes-open on a stale ref.
  assert.match(SRC, /missing static refs: 0/, 'gate must check for "missing static refs: 0"');
  assert.match(SRC, /broken: 0/, 'gate must check for "broken: 0"');
});

test('W530 #5 — gate combines exit code AND both audit signals into ok', () => {
  // Pin the AND-chain so removing any signal fails this test first.
  assert.match(SRC, /const\s+exitOk\s*=\s*r\.status\s*===\s*0/,
    'gate must derive exitOk from r.status === 0');
  assert.match(SRC, /const\s+missingOk\s*=/, 'gate must compute missingOk');
  assert.match(SRC, /const\s+brokenOk\s*=/, 'gate must compute brokenOk');
  assert.match(SRC, /const\s+ok\s*=\s*exitOk\s*&&\s*missingOk\s*&&\s*brokenOk/,
    'gate must AND all three signals (exit + missing + broken)');
});

test('W530 #6 — gate has explicit 120s timeout (refs audit shouldn\'t run for minutes)', () => {
  // If the regex on the page count blows up to seconds-per-page, an explicit
  // timeout caps the gate at 120s instead of hanging the whole release-verify.
  assert.match(SRC, /runSync\(npmBin,\s*\[\s*['"]run['"]\s*,\s*['"]lint:refs['"]\s*\][\s\S]{0,200}timeoutMs:\s*120_?000/,
    'lint:refs gate must declare timeoutMs:120000 (60-2x the typical 2s runtime)');
});

test('W530 #7 — gate records skipped:true when --skip=lint:refs', () => {
  assert.match(SRC, /if\s*\(\s*!shouldRun\(\s*['"]lint:refs['"]\s*\)\s*\)\s*return\s+recordResult\(\s*['"]lint:refs['"]\s*,\s*true\s*,\s*\{\s*skipped:\s*true\s*\}\s*\)/,
    'gate must short-circuit to skipped:true ok:true when shouldRun is false');
});

test('W530 #8 — main() awaits gateLintRefs as the FIRST gate', () => {
  // Cheapest gate first — design pattern. Pinning the position keeps it
  // honest: if a faster gate is added later, lint:refs may move to #2, but
  // it should never end up after the 30-minute test gate.
  const idxLintRefs = SRC.indexOf('await gateLintRefs()');
  const idxTests = SRC.indexOf('await gateTests()');
  const idxOpenapi = SRC.indexOf('await gateOpenapiSync()');
  assert.ok(idxLintRefs > 0, 'gateLintRefs must be awaited in main()');
  assert.ok(idxLintRefs < idxOpenapi, 'lint:refs must run before openapi-sync');
  assert.ok(idxLintRefs < idxTests, 'lint:refs must run before the test gate (cheap first)');
});

test('W530 #9 — gate calls progress() for user-visible status', () => {
  // Without progress(), users see release-verify "hang" on the lint:refs
  // step. Pin the call.
  assert.match(SRC, /progress\(\s*['"]lint:refs running['"]\s*\)/,
    'gate must emit "lint:refs running" progress signal');
});

test('W530 #10 — both audit scripts exist on disk and are executable as node modules', () => {
  // The package.json script names them; if they don't exist, lint:refs
  // fails opaquely. This test surfaces the missing-script case here.
  for (const script of ['audit-static-refs.cjs', 'audit-href.cjs']) {
    const fp = path.join(REPO, 'scripts', script);
    assert.ok(fs.existsSync(fp), `scripts/${script} must exist on disk`);
    const src = fs.readFileSync(fp, 'utf8');
    assert.ok(src.length > 100, `scripts/${script} must be non-trivial (> 100 bytes)`);
  }
});

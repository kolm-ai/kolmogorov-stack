// W442 lock-in: the blessed test command is `npm test` and it must run
// serially because the suite has unavoidable filesystem races (shared
// SQLite DB at ./data/kolm.sqlite, shared ~/.kolm config, shared
// artifact dirs). Parallel runs are valid for local debugging but never
// the official command.
//
// If you flip `test` back to parallel, this test fails — go fix the
// isolation racing in src/store.js / src/event-store.js / artifact dirs
// FIRST, then update this lock-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const pkgPath = path.join(REPO, 'package.json');

test('W442 #1 — `npm test` must be pinned to --test-concurrency=1 (serial)', () => {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.ok(pkg.scripts && pkg.scripts.test, 'package.json must define a test script');
  const cmd = String(pkg.scripts.test);
  assert.ok(cmd.includes('--test-concurrency=1'),
    `package.json scripts.test must include --test-concurrency=1 to avoid filesystem races. Got: ${cmd}`);
  assert.ok(cmd.includes('--test') && cmd.includes('tests/'),
    `package.json scripts.test must run node --test on tests/. Got: ${cmd}`);
});

test('W442 #2 — `npm run test:parallel` exists as the opt-in fast lane', () => {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.ok(pkg.scripts && pkg.scripts['test:parallel'],
    'package.json must define a test:parallel script for local-debug fast runs');
  const cmd = String(pkg.scripts['test:parallel']);
  assert.ok(!cmd.includes('--test-concurrency=1'),
    `package.json scripts.test:parallel must NOT pin --test-concurrency=1 — it's the explicit parallel fast lane. Got: ${cmd}`);
});

test('W442 #3 — README/docs reference `npm test` as the blessed command', () => {
  // Soft assertion: at least one user-facing doc mentions `npm test`.
  // If no doc references it, the blessed command is invisible to new contributors.
  const candidates = [
    path.join(REPO, 'README.md'),
    path.join(REPO, 'CONTRIBUTING.md'),
    path.join(REPO, 'docs', 'CONTRIBUTING.md'),
  ];
  let found = false;
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const body = fs.readFileSync(p, 'utf8');
    if (/\bnpm\s+test\b/.test(body)) { found = true; break; }
  }
  assert.ok(found, 'At least one of README.md / CONTRIBUTING.md / docs/CONTRIBUTING.md must reference `npm test` as the blessed command');
});

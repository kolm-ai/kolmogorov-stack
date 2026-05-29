// W921 NOW-4 — the autonomous deploy gate must REQUIRE the always-valid
// (mSPRT/GAVI) sequential decision BY DEFAULT when a real A/B test is in scope,
// closing the continuous-peeking Type-I hole. Opt-out via enforce_sequential
// ===false; N/A (does not block) when no A/B test is applicable. Source-level
// lock-in (the live path needs a provisioned tenant + A/B samples).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'autopilot-lifecycle.js'), 'utf8');

test('NOW4 #1 — sequential gate is enforced by default when an A/B test is applicable', () => {
  // Default-on: applicable OR explicitly enabled; opt-out only via ===false.
  assert.match(SRC, /enforce_sequential === false\)\s*\?\s*false\s*:\s*\(sequential\.applicable \|\| \(opts && opts\.enforce_sequential === true\)\)/,
    'the gate must default on when sequential.applicable, with an explicit ===false opt-out');
});

test('NOW4 #2 — when gated, EXECUTE requires the anytime-valid promote decision', () => {
  assert.match(SRC, /if \(_seqGated\) \{[\s\S]*?conditions\.sequential_promote = \(!sequential\.applicable\)[\s\S]*?sequential\.decision === 'promote'[\s\S]*?failed\.push\('sequential'\)/,
    'a gated, applicable, non-promote sequential decision must block the deploy');
});

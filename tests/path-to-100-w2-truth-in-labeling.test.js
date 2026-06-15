// W-2 (Path to 100%) — truth-in-labeling guard.
//
// "trained on your data" is the one unearned overclaim: the shipping product
// COMPILES a JS recipe (teacher-authored or pattern) — real weight-training is
// the opt-in, GPU-gated distill tier (ml_pipeline_run:true). The word "trained"
// must never be asserted as a product fact on a user-facing surface unless it is
// explicitly gated (GPU/money/real_run/"do not carry trained"/"actually trained").
//
// This guard fails CI if the unearned claim reappears in package.json or the
// top marketing pages — it is the regression fence for the W-2 sweep.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// The unearned assertion: "trained on (your|their|customer) data/examples/…".
// Honest, gated uses ("nothing was actually trained", "do not carry trained
// LoRA weights", GPU/money fine-tune disclosures) do NOT match this pattern.
const OVERCLAIM = /trained on (your|their|customer)/i;

function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

test('W-2: package.json description carries no unearned "trained" claim', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(
    !OVERCLAIM.test(pkg.description || ''),
    'package.json description must not claim "trained on your data": ' + pkg.description,
  );
});

test('W-2: top marketing surfaces carry no unearned "trained" claim', () => {
  const surfaces = [
    'public/index.html',
    'public/compiler-product.html',
    'public/how-it-works.html',
    'public/pricing.html',
    'README.md',
  ];
  const offenders = [];
  for (const rel of surfaces) {
    const text = read(rel);
    if (OVERCLAIM.test(text)) offenders.push(rel);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'unearned "trained on your data" claim found in: ' + offenders.join(', '),
  );
});

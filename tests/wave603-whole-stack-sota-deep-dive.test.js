import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const ROOT = path.resolve(process.cwd());
const LEDGER = path.join(ROOT, 'docs', 'whole-stack-sota-deep-dive-2026-06-17.json');
const doc = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));

const EXPECTED = [
  'distillation',
  'moe-distill-quant',
  'quantization',
  'kv-cache',
  'speculative-decoding',
  'finetune-frameworks',
  'synthetic-data-curation',
  'small-llm-students',
  'ondevice-inference',
  'llm-routing',
  'mcp-tool-gateway-receipts',
  'verifiable-inference',
  'model-signing-standards',
  'confidential-compute',
  'agent-security-eval',
  'compile-api-to-model-competitors',
];

test('W603 #1 - whole-stack SOTA ledger is generated from the current tree', () => {
  const out = execFileSync(process.execPath, ['scripts/build-stack-sota-deep-dive.mjs', '--check', '--summary'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true, parsed.failures.join('\n'));
  assert.equal(parsed.summary.category_count, EXPECTED.length);
});

test('W603 #2 - every expected SOTA category is present once', () => {
  assert.equal(doc.schema, 'kolm-whole-stack-sota-deep-dive-1');
  const ids = doc.categories.map((category) => category.id).sort();
  assert.deepEqual(ids, EXPECTED.slice().sort());
});

test('W603 #3 - every SOTA category has evidence, gaps, components, and verification', () => {
  for (const category of doc.categories) {
    assert.equal(category.deep_dive.status, 'whole_stack_sota_deep_dive_complete', category.id);
    assert.deepEqual(category.deep_dive.lenses, doc.review_lenses, category.id);
    assert.ok(category.source_stack_spec.line > 0, `${category.id}: stack spec line missing`);
    assert.equal(category.local_sota_review.has_as_built, true, `${category.id}: missing as-built review`);
    assert.equal(category.local_sota_review.has_frontier_delta, true, `${category.id}: missing frontier review`);
    assert.ok(category.local_sota_review.already_at_frontier_count >= 1, `${category.id}: no already-at-frontier evidence`);
    assert.ok(category.local_sota_review.improvement_count >= 1, `${category.id}: no improvement path`);
    assert.ok(category.atomic_components.count >= 3, `${category.id}: atomic mapping too thin`);
    assert.equal(category.atomic_components.missing_required_paths.length, 0, `${category.id}: missing required paths`);
    assert.ok(category.readiness.count >= 1, `${category.id}: readiness mapping missing`);
    assert.ok(category.improvement_track, `${category.id}: improvement track missing`);
    assert.ok(category.suggested_verification.includes('npm run verify:stack-sota'), `${category.id}: stack verification missing`);
  }
});

test('W603 #4 - summary keeps open frontier and external-gate state explicit', () => {
  assert.equal(doc.summary.category_count, EXPECTED.length);
  assert.ok(doc.summary.total_atomic_component_links >= 400);
  assert.equal(doc.summary.categories_with_critical_frontier_work_open, 0);
  assert.ok(doc.summary.categories_with_major_frontier_work_open >= 1);
  assert.equal(doc.summary.readiness_open_requirements.length, 8);
  assert.ok(doc.cross_stack_invention_themes.length >= 5);
});

test('W603 #5 - volatile SOTA areas keep primary-source freshness probes', () => {
  assert.equal(doc.external_freshness_probe.checked_at, doc.updated_at);
  assert.ok(doc.external_freshness_probe.sources.length >= 6);
  const probed = new Set(doc.external_freshness_probe.sources.map((source) => source.category));
  for (const category of ['distillation', 'quantization', 'speculative-decoding', 'confidential-compute']) {
    assert.ok(probed.has(category), `${category}: missing freshness probe`);
  }
  for (const source of doc.external_freshness_probe.sources) {
    assert.match(source.url, /^https:\/\//, `${source.id}: source URL must be HTTPS`);
    assert.ok(source.confirms.length >= 40, `${source.id}: source rationale too thin`);
  }
});

test('W603 #6 - new whole-stack SOTA source artifacts avoid banned legacy wording', () => {
  const banned = new RegExp(`\\b${['hon', 'est'].join('')}(?:y|ly)?\\b`, 'i');
  for (const rel of [
    'scripts/build-stack-sota-deep-dive.mjs',
    'docs/whole-stack-sota-deep-dive-2026-06-17.md',
    'tests/wave603-whole-stack-sota-deep-dive.test.js',
  ]) {
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(body, banned, rel);
  }
});

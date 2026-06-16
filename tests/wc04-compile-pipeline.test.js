// WC04 — test coverage close-out for src/compile-pipeline.js.
//
// Previously: 976 LOC, 0 tests anywhere in tests/.
// Pins the PUBLIC STRUCTURAL surface only. The compileFull async generator
// orchestrates capture→planner→tokenizer→distill→dataset→artifact→gates→
// device-install, so we deliberately do NOT drive the full pipeline
// (needs real corpora, GPUs, optional teacher API keys). We pin:
//   - exports exist + correct types
//   - PIPELINE_PHASES ordering + immutability invariants
//   - compileFull async-generator validation throw paths
//   - default export shape matches named exports
//
// End-to-end orchestration is covered by the wave381 / wave409c / wave411 /
// wave438 / wave439 / wave451 test families that exercise compileFull against
// seeded namespaces and rented teacher mocks. Here we only need to confirm
// the surface a route / CLI consumer relies on cannot silently drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIPELINE_PHASES,
  compileFull,
} from '../src/compile-pipeline.js';
import compilePipelineDefault from '../src/compile-pipeline.js';

test('WC04-cp #1 PIPELINE_PHASES is exported as an Array of strings', () => {
  assert.ok(Array.isArray(PIPELINE_PHASES), 'PIPELINE_PHASES must be an Array');
  assert.ok(PIPELINE_PHASES.length > 0, 'PIPELINE_PHASES must not be empty');
  for (const p of PIPELINE_PHASES) assert.equal(typeof p, 'string');
});

test('WC04-cp #2 PIPELINE_PHASES pins the canonical phase ordering', () => {
  // The phase names + ordering are part of the public contract — watchers
  // (CLI --watch, websocket, log tail) parse on these exact strings. The
  // original 11-phase chain grew by three emitted phases: 'curate' (W921 data-
  // engine curation, between corpus_prepare and dataset_split), 'distill_eval'
  // (holdout K-score eval, after distill) and 'regression_gate' (W808 promotion
  // gate, before install). Each yields its own {phase:...} event, so the
  // contract must enumerate all 14 in emission order.
  assert.deepEqual(PIPELINE_PHASES, [
    'plan',
    'tokenizer_train',
    'corpus_prepare',
    'curate',
    'dataset_split',
    'distill',
    'distill_eval',
    'quantize',
    'bundle',
    'sign',
    'verdict',
    'regression_gate',
    'install',
    'done',
  ]);
});

test('WC04-cp #3 PIPELINE_PHASES starts with plan and ends with done', () => {
  // These two are load-bearing: plan is the first watcher event, done is
  // the signal to release the iterator + show the artifact path.
  assert.equal(PIPELINE_PHASES[0], 'plan');
  assert.equal(PIPELINE_PHASES[PIPELINE_PHASES.length - 1], 'done');
});

test('WC04-cp #4 PIPELINE_PHASES contains no duplicate phase names', () => {
  const seen = new Set();
  for (const p of PIPELINE_PHASES) {
    assert.ok(!seen.has(p), 'duplicate phase: ' + p);
    seen.add(p);
  }
  assert.equal(seen.size, PIPELINE_PHASES.length);
});

test('WC04-cp #5 PIPELINE_PHASES orders bundle before sign before verdict before install', () => {
  // The strict-gate + force semantics in compileFull rely on this exact
  // ordering — verdict must run after bundle/sign so the receipt exists,
  // and install only fires after the gate verdict.
  const idx = (name) => PIPELINE_PHASES.indexOf(name);
  assert.ok(idx('bundle') < idx('sign'));
  assert.ok(idx('sign') < idx('verdict'));
  assert.ok(idx('verdict') < idx('install'));
  assert.ok(idx('install') < idx('done'));
});

test('WC04-cp #6 PIPELINE_PHASES orders plan→tokenizer→corpus→dataset_split→distill', () => {
  // Upstream ordering: planner runs first so backbone is chosen before the
  // tokenizer trains; corpus prep and dataset split feed the distill loop.
  const idx = (name) => PIPELINE_PHASES.indexOf(name);
  assert.ok(idx('plan') < idx('tokenizer_train'));
  assert.ok(idx('tokenizer_train') < idx('corpus_prepare'));
  assert.ok(idx('corpus_prepare') < idx('dataset_split'));
  assert.ok(idx('dataset_split') < idx('distill'));
});

test('WC04-cp #7 compileFull is exported as a function', () => {
  assert.equal(typeof compileFull, 'function');
});

test('WC04-cp #8 compileFull is an async-generator function (yields iterator)', () => {
  // Async generators have a constructor name of 'AsyncGeneratorFunction'.
  // We assert behavior rather than constructor identity to stay robust
  // across V8 versions: calling it must return an object that quacks like
  // an async iterator (has .next + Symbol.asyncIterator).
  // We pass a namespace so we get a fresh iterator instead of an
  // immediate throw (the throw on missing namespace is pinned in #10).
  const it = compileFull({ namespace: 'wc04-structural-probe', opts: {} });
  assert.equal(typeof it, 'object');
  assert.equal(typeof it.next, 'function');
  assert.equal(typeof it[Symbol.asyncIterator], 'function');
  // Don't drive it — the first .next() triggers real ML pipeline I/O.
});

test('WC04-cp #9 compileFull called with no args returns an iterator that rejects on .next()', async () => {
  // Async generators do NOT throw synchronously on invocation. The
  // namespace-required guard fires on the first .next() resolution.
  const it = compileFull();
  assert.equal(typeof it.next, 'function');
  await assert.rejects(
    () => it.next(),
    (err) => /compileFull requires \{namespace\}/.test(String(err && err.message)),
  );
});

test('WC04-cp #10 compileFull rejects when namespace is missing on opts-only call', async () => {
  const it = compileFull({ opts: {} });
  await assert.rejects(
    () => it.next(),
    (err) => /compileFull requires \{namespace\}/.test(String(err && err.message)),
  );
});

test('WC04-cp #11 compileFull rejects when namespace is empty string', async () => {
  // Empty string is falsy → trips the same required-namespace guard.
  const it = compileFull({ namespace: '', opts: {} });
  await assert.rejects(
    () => it.next(),
    (err) => /compileFull requires \{namespace\}/.test(String(err && err.message)),
  );
});

test('WC04-cp #12 compileFull rejects when namespace is null', async () => {
  const it = compileFull({ namespace: null, opts: {} });
  await assert.rejects(
    () => it.next(),
    (err) => /compileFull requires \{namespace\}/.test(String(err && err.message)),
  );
});

test('WC04-cp #13 compileFull rejects when namespace is undefined explicitly', async () => {
  const it = compileFull({ namespace: undefined });
  await assert.rejects(
    () => it.next(),
    (err) => /compileFull requires \{namespace\}/.test(String(err && err.message)),
  );
});

test('WC04-cp #14 default export is the union of compileFull + PIPELINE_PHASES', () => {
  assert.equal(typeof compilePipelineDefault, 'object');
  assert.equal(compilePipelineDefault.compileFull, compileFull);
  assert.equal(compilePipelineDefault.PIPELINE_PHASES, PIPELINE_PHASES);
});

test('WC04-cp #15 default export exposes exactly compileFull + PIPELINE_PHASES', () => {
  // Stability invariant: adding a new key to the default export bag is a
  // public-surface change that should require updating this test on
  // purpose. Catches accidental leakage of internal helpers via default.
  const keys = Object.keys(compilePipelineDefault).sort();
  assert.deepEqual(keys, ['PIPELINE_PHASES', 'compileFull']);
});

test('WC04-cp #16 PIPELINE_PHASES contains the optional skip-able phases (quantize, sign, install)', () => {
  // These three phases honor opts flags (opts.quantize, opts.no_sign,
  // opts.no_install). The phase name must still appear in PIPELINE_PHASES
  // even when skipped — the watcher emits {phase, skipped:true} so the
  // event-name catalog stays stable across configurations.
  assert.ok(PIPELINE_PHASES.includes('quantize'));
  assert.ok(PIPELINE_PHASES.includes('sign'));
  assert.ok(PIPELINE_PHASES.includes('install'));
});

test('WC04-cp #17 PIPELINE_PHASES has exactly 14 entries (W381 docblock invariant)', () => {
  // The original W381 docblock enumerated 11 phases (plan through done); the
  // chain since grew by three emitted phases (curate, distill_eval,
  // regression_gate). If a phase is added or removed, the docblock + downstream
  // watchers + this test must move together.
  assert.equal(PIPELINE_PHASES.length, 14);
});

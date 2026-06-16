// tests/finalized-c5-calibration-set-construction.test.js
//
// ATOM: Real calibration-set construction (domain-matched, deduped, length-
// bucketed) replacing the 32-line prose `_FALLBACK_CALIB` in quantize.py.
//
// Proves the builder (src/calibration-set.js):
//   1. FRONTIER-AWARE regime: each method gets its real seqlen/rows defaults;
//      calibration-free methods (int4/int8/hqq) return a recorded no-op.
//   2. SOURCE SELECTION: builds from real tenant-capture / eval / open-corpus
//      docs; NO toy sentences in the default path.
//   3. EXACT DEDUP: byte/whitespace-identical docs collapse.
//   4. SEMANTIC DEDUP: paraphrase near-dups (high embedding cosine) collapse,
//      and the local hash-bag embedder keeps text in-process (privacy).
//   5. LENGTH BUCKETING: output windows are packed to the quantizer's seqlen
//      (short docs concatenated, long docs windowed).
//   6. TOKEN BUDGET: rows cap honored; tokenBudget override; under-budget loud.
//   7. LANGUAGE BALANCING: multilingual targets are balanced across locales.
//   8. PROVENANCE HASH: deterministic + reproducible + sensitive to the regime;
//      receipt block carries the hash and no raw text.
//   9. FAIL-LOUD: a calibration-required method with NO real sources refuses
//      (does NOT silently ship toy sentences) unless allowFallback:true.
//  10. ENVELOPE: never throws on junk; unknown method => {ok:false}.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCalibrationSet,
  calibrationReceiptBlock,
  METHOD_REGIME,
  SOURCE_KINDS,
  CALIB_VERSION,
} from '../src/calibration-set.js';

// A reusable paragraph generator so we can fabricate long-enough source text.
function para(seed, n = 12) {
  const words = ('calibration corpus document ' + seed + ' provides representative domain text for the quantizer activation statistics over a realistic context window ').split(' ');
  let s = '';
  for (let i = 0; i < n; i++) s += words.join(' ') + ' ';
  return s.trim();
}

function bigCorpus(kind, count, salt = '') {
  const docs = [];
  for (let i = 0; i < count; i++) docs.push(para(`${salt}${i}`, 14));
  return { kind, label: `${kind}-${salt}`, docs };
}

test('regime: every method exposes a frontier-accurate seqlen/rows; calib-free methods are no-ops', () => {
  assert.equal(METHOD_REGIME.gptq.seqlen, 2048);
  assert.equal(METHOD_REGIME.gptq.rows, 128); // 128x2048 Hessian
  assert.equal(METHOD_REGIME.awq.rows, 512);  // 512-row activation scan
  assert.equal(METHOD_REGIME.awq.seqlen, 512);
  assert.equal(METHOD_REGIME.smoothquant.regime, 'migration-strength-scan');

  for (const free of ['int4', 'int8', 'hqq']) {
    const r = buildCalibrationSet({ method: free, sources: [bigCorpus('tenant-capture', 5)] });
    assert.equal(r.ok, true, `${free} ok`);
    assert.equal(r.calibration_required, false);
    assert.equal(r.regime, 'calibration-free');
    assert.equal(r.provenance_hash, null);
    assert.equal(r.windows.length, 0);
  }
});

test('source selection: builds from real tenant-capture docs, NO toy fallback in default path', () => {
  const captures = {
    kind: 'tenant-capture',
    label: 'prod-traffic',
    items: [
      { input: para('refund-policy'), output: 'resolved' },
      { input: para('shipping-delay'), output: 'escalated' },
      { input: para('invoice-question'), output: 'answered' },
    ],
  };
  const r = buildCalibrationSet({ method: 'gptq', sources: [captures], rows: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.calibration_required, true);
  assert.ok(r.windows.length >= 1);
  // No toy sentence leaked in.
  const joined = r.windows.map((w) => w.text).join(' ');
  assert.ok(!/quick brown fox/i.test(joined), 'no toy fallback text in real path');
  assert.equal(r.stats.fallback_used, false);
  // Sources are fingerprinted.
  assert.equal(r.sources[0].kind, 'tenant-capture');
  assert.equal(r.sources[0].label, 'prod-traffic');
  assert.ok(/^[0-9a-f]{64}$/.test(r.sources[0].content_hash));
});

test('exact dedup: byte/whitespace-identical docs collapse', () => {
  const d = para('dup-doc', 16);
  const sources = [{
    kind: 'open-corpus',
    docs: [d, d, '  ' + d.replace(/ /g, '   ') + '  ', para('unique', 16)],
  }];
  const r = buildCalibrationSet({ method: 'awq', sources, rows: 50, semEpsilon: 0 /* disable sem to isolate exact */ });
  assert.equal(r.ok, true);
  // 4 ingested -> 2 unique after exact (3 are whitespace-variants of the same doc).
  assert.equal(r.stats.n_ingested, 4);
  assert.equal(r.stats.exact_removed, 2);
  assert.equal(r.stats.n_after_exact, 2);
});

test('semantic dedup: high-cosine paraphrase near-dups collapse via local embedder', () => {
  // Inject a deterministic embedder so we can force two docs to be near-identical
  // in embedding space without relying on the hash-bag collision rate.
  const embedder = (text) => {
    // Map any doc that contains "ALPHA" to the same vector; everything else unique.
    if (/ALPHA/.test(text)) return [1, 0, 0];
    if (/BETA/.test(text)) return [0, 1, 0];
    return [0, 0, 1];
  };
  const sources = [{
    kind: 'task-domain',
    docs: [
      'ALPHA ' + para('a1', 16),
      'ALPHA ' + para('a2-different-words', 16), // paraphrase: same vector
      'BETA ' + para('b1', 16),
      para('gamma-unique', 16),
    ],
  }];
  const r = buildCalibrationSet({ method: 'awq', sources, rows: 50, embedder, semEpsilon: 0.05 });
  assert.equal(r.ok, true);
  assert.equal(r.stats.exact_removed, 0, 'these are not byte-identical');
  assert.equal(r.stats.semantic_removed, 1, 'the second ALPHA paraphrase is pruned');
  assert.equal(r.stats.semantic_backend, 'semdedup:injected');
});

test('semantic dedup default path keeps text local (no injected/remote embedder)', () => {
  const r = buildCalibrationSet({
    method: 'gptq',
    sources: [bigCorpus('open-corpus', 6)],
    rows: 8,
  });
  assert.equal(r.ok, true);
  assert.equal(r.stats.semantic_backend, 'semdedup:local-hashbag');
});

test('length bucketing: output windows are packed to the method seqlen', () => {
  // Many short docs => they get concatenated up to the seqlen window size.
  const shorts = [];
  for (let i = 0; i < 40; i++) shorts.push(`Short doc number ${i} about widgets.`);
  const r = buildCalibrationSet({
    method: 'awq', // seqlen 512 -> targetChars ~2048
    sources: [{ kind: 'open-corpus', docs: shorts }],
    rows: 50,
    semEpsilon: 0, // keep all shorts for the packing test
  });
  assert.equal(r.ok, true);
  // Each window's estimated token count must not exceed seqlen.
  for (const w of r.windows) {
    assert.ok(w.tokens_est <= r.seqlen, `window ${w.tokens_est} <= seqlen ${r.seqlen}`);
    assert.ok(/^[0-9a-f]{64}$/.test(w.content_hash));
  }
  // 40 short docs should pack into FEWER than 40 windows (concatenation worked).
  assert.ok(r.windows.length < 40, `packed ${r.windows.length} windows < 40 docs`);

  // A single very long doc gets WINDOWED into multiple seqlen windows.
  const longDoc = para('verylong', 400); // far exceeds 2048 chars
  const r2 = buildCalibrationSet({
    method: 'awq',
    sources: [{ kind: 'open-corpus', docs: [longDoc] }],
    rows: 50,
  });
  assert.equal(r2.ok, true);
  assert.ok(r2.windows.length > 1, 'long doc windowed into multiple windows');
});

test('token budget: rows cap honored; tokenBudget override computes rows; under-budget warns', () => {
  const big = bigCorpus('open-corpus', 200);
  const r = buildCalibrationSet({ method: 'gptq', sources: [big], rows: 5 });
  assert.equal(r.ok, true);
  assert.ok(r.windows.length <= 5, 'rows cap honored');
  assert.equal(r.requested_rows, 5);
  assert.equal(r.stats.token_budget, r.seqlen * 5);

  // tokenBudget override: budget / seqlen = rows.
  const r2 = buildCalibrationSet({ method: 'gptq', sources: [big], tokenBudget: 4096 });
  assert.equal(r2.ok, true);
  assert.equal(r2.requested_rows, Math.floor(4096 / r2.seqlen)); // 4096/2048 = 2

  // Under-budget: ask for more rows than the corpus can fill.
  const r3 = buildCalibrationSet({ method: 'gptq', sources: [bigCorpus('open-corpus', 1)], rows: 128 });
  assert.equal(r3.ok, true);
  assert.ok(r3.stats.shortfall > 0, 'shortfall recorded');
  assert.ok(r3.warnings.some((w) => /UNDER_BUDGET/.test(w)), 'loud under-budget warning');
});

test('language balancing: multilingual targets are balanced across locales', () => {
  // Build docs in three scripts; ask for a balanced latin/cjk/cyrillic mix.
  const latin = [];
  const cjk = [];
  const cyr = [];
  for (let i = 0; i < 10; i++) {
    latin.push(`English calibration document about commerce number ${i} with enough words here.`);
    cjk.push(`中文校准文档 ${i} 包含足够的词汇来填充上下文窗口这里`);
    cyr.push(`Русский калибровочный документ ${i}`);
  }
  const r = buildCalibrationSet({
    method: 'awq',
    sources: [{ kind: 'open-corpus', docs: [...latin, ...cjk, ...cyr] }],
    languages: ['latin', 'cjk', 'cyrillic'],
    rows: 50,
    semEpsilon: 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.stats.language_balanced, true);
  // All three target buckets contributed docs.
  assert.ok(r.stats.language_buckets.latin > 0);
  assert.ok(r.stats.language_buckets.cjk > 0);
  assert.ok(r.stats.language_buckets.cyrillic > 0);
  // The final window distribution should include each target language.
  const langs = Object.keys(r.stats.language_distribution);
  assert.ok(langs.includes('latin'));
  assert.ok(langs.includes('cjk') || langs.includes('cyrillic'));
});

test('provenance hash: deterministic, reproducible, regime-sensitive; receipt carries no raw text', () => {
  const sources = [bigCorpus('eval-set', 30, 'P')];
  const a = buildCalibrationSet({ method: 'gptq', sources, rows: 6 });
  const b = buildCalibrationSet({ method: 'gptq', sources, rows: 6 });
  assert.equal(a.ok, true);
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(a.provenance_hash));
  // Reproducible: same sources + opts => same hash.
  assert.equal(a.provenance_hash, b.provenance_hash, 'reproducible provenance');

  // Regime-sensitive: changing the method (different seqlen/rows) changes the hash.
  const c = buildCalibrationSet({ method: 'awq', sources, rows: 6 });
  assert.notEqual(a.provenance_hash, c.provenance_hash, 'method change => different hash');

  // Sensitive to the source content: a different corpus => different hash.
  const d = buildCalibrationSet({ method: 'gptq', sources: [bigCorpus('eval-set', 30, 'Q')], rows: 6 });
  assert.notEqual(a.provenance_hash, d.provenance_hash, 'source change => different hash');

  // Receipt block carries the hash + window hashes but NO raw window text.
  const receipt = calibrationReceiptBlock(a);
  assert.equal(receipt.version, CALIB_VERSION);
  assert.equal(receipt.provenance_hash, a.provenance_hash);
  assert.ok(Array.isArray(receipt.window_hashes));
  assert.equal(receipt.window_hashes.length, a.windows.length);
  const receiptStr = JSON.stringify(receipt);
  assert.ok(!/calibration corpus document/.test(receiptStr), 'no raw calibration text in receipt');
});

test('fail-loud: calibration-required method with NO real sources refuses unless allowFallback', () => {
  // Default: refuses (does NOT silently ship toy sentences).
  const refused = buildCalibrationSet({ method: 'gptq', sources: [] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /no real calibration source/i);
  assert.ok(refused.hint, 'actionable hint present');

  // Sources present but all-empty => still refuses.
  const refused2 = buildCalibrationSet({ method: 'awq', sources: [{ kind: 'open-corpus', docs: ['', '   ', null] }] });
  assert.equal(refused2.ok, false);

  // Opt-in toy fallback is loud + recorded.
  const fb = buildCalibrationSet({ method: 'gptq', sources: [], allowFallback: true, rows: 4 });
  assert.equal(fb.ok, true);
  assert.equal(fb.stats.fallback_used, true);
  assert.ok(fb.warnings.some((w) => /NO_REAL_SOURCES/.test(w)), 'loud fallback warning');
  // Provenance still computed, and records fallback_used in its knobs (so a
  // verifier sees the toy regime).
  assert.ok(/^sha256:/.test(fb.provenance_hash));
});

test('envelope: never throws on junk; unknown method => {ok:false}', () => {
  assert.equal(buildCalibrationSet({ method: 'not-a-method', sources: [bigCorpus('open-corpus', 2)] }).ok, false);
  // Junk sources do not throw.
  const r = buildCalibrationSet({ method: 'gptq', sources: [null, 42, { kind: 'x' }, { kind: 'tenant-capture', docs: [{}, 7, para('ok', 16)] }], rows: 4 });
  assert.equal(typeof r.ok, 'boolean');
  // No-arg call does not throw.
  assert.equal(buildCalibrationSet().ok, false);
  // SOURCE_KINDS exported + ordered (tenant-capture first = highest domain match).
  assert.equal(SOURCE_KINDS[0], 'tenant-capture');

  // jsonl output is valid {text} JSONL the python --calib loader consumes.
  const good = buildCalibrationSet({ method: 'awq', sources: [bigCorpus('open-corpus', 8)], rows: 3, semEpsilon: 0 });
  assert.equal(good.ok, true);
  const lines = good.jsonl.trim().split('\n');
  assert.equal(lines.length, good.windows.length);
  for (const line of lines) {
    const obj = JSON.parse(line);
    assert.equal(typeof obj.text, 'string');
    assert.ok(obj.text.length > 0);
  }
});

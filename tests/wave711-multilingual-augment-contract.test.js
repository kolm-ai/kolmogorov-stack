// W711 - direct contract tests for src/multilingual-augment.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  MULTI_AUGMENT_VERSION,
  MULTI_AUGMENT_CONTRACT_VERSION,
  MULTI_AUGMENT_LIMITS,
  identifyUnderrepresentedLangs,
  requestMultilingualAugmentation,
  mergeAugmentedRows,
} from '../src/multilingual-augment.js';

const ROOT = path.resolve('.');
const EN_TEXT = 'the and is in to of that with clean english sample';

function enRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    cid: `src-${i}`,
    input: `${EN_TEXT} ${i}`,
    output: `answer ${i}`,
  }));
}

function assertContract(env) {
  assert.equal(env.version, MULTI_AUGMENT_VERSION);
  assert.equal(env.contract_version, MULTI_AUGMENT_CONTRACT_VERSION);
}

test('W711 multilingual augment exposes bounded DI-only contract and depth verifier', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'multilingual-augment.js'), 'utf8');
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'kolm.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.equal(MULTI_AUGMENT_VERSION, 'w760-v1');
  assert.equal(MULTI_AUGMENT_CONTRACT_VERSION, 'w711-v1');
  assert.ok(Object.isFrozen(MULTI_AUGMENT_LIMITS));
  assert.equal(MULTI_AUGMENT_LIMITS.max_source_rows, 500);
  assert.equal(MULTI_AUGMENT_LIMITS.max_targets_per_row, 10);
  assert.equal(MULTI_AUGMENT_LIMITS.max_total_calls, 5000);
  assert.doesNotMatch(src, /node:child_process|spawn\(|execFile\(|exec\(/);
  assert.doesNotMatch(cli, /KOLM_TRANSLATOR_CMD/);
  assert.equal(
    pkg.scripts['verify:multilingual-augment'],
    'node --test --test-concurrency=1 tests/wave711-multilingual-augment-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:kscore-calibration && npm run verify:kscore-per-language && npm run verify:multilingual-augment && npm run verify:quality-calibration/,
  );
});

test('W711 identifyUnderrepresentedLangs returns versioned target-language gap contracts', () => {
  const env = identifyUnderrepresentedLangs({
    rows: [{ input: EN_TEXT }],
    target_langs: ['es', 'fr'],
    min_per_lang: 2,
  });

  assert.equal(env.ok, true);
  assert.equal(env.total, 1);
  assertContract(env);
  const byLang = new Map(env.underrepresented.map((r) => [r.lang, r]));
  assert.equal(byLang.get('es').current_count, 0);
  assert.equal(byLang.get('es').needed, 2);
  assert.equal(byLang.get('fr').current_count, 0);
  assert.equal(byLang.get('fr').needed, 2);
  assert.ok(byLang.get('en').needed >= 1);
});

test('W711 dry-run planning caps rows, de-dupes targets, and excludes self-translation calls', async () => {
  const targets = ['en', 'es', 'es', 'fr', 'xx', 'de', 'it', 'pt', 'nl', 'ru', 'zh', 'ja', 'ko', 'ar'];
  const env = await requestMultilingualAugmentation({
    source_rows: enRows(MULTI_AUGMENT_LIMITS.max_source_rows + 5),
    target_langs: targets,
  });

  assert.equal(env.ok, true);
  assert.equal(env.dry_run, true);
  assertContract(env);
  assert.equal(env.plan.n_source_rows_seen, MULTI_AUGMENT_LIMITS.max_source_rows + 5);
  assert.equal(env.plan.n_source_rows_used, MULTI_AUGMENT_LIMITS.max_source_rows);
  assert.equal(env.plan.source_rows_truncated, true);
  assert.equal(env.plan.n_targets, MULTI_AUGMENT_LIMITS.max_targets_per_row);
  assert.equal(env.plan.target_langs_truncated, true);
  assert.deepEqual(env.plan.invalid_target_langs, ['xx']);
  assert.equal(env.plan.skipped_self_translations, MULTI_AUGMENT_LIMITS.max_source_rows);
  assert.equal(env.plan.n_estimated_calls, MULTI_AUGMENT_LIMITS.max_source_rows * 9);
  assert.equal(env.plan.estimated_cost_usd, 9);
  assert.deepEqual(env.plan.targets, ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'zh', 'ja']);
  assert.equal(env.plan.limits.max_total_calls, MULTI_AUGMENT_LIMITS.max_total_calls);
});

test('W711 real augmentation requires an injected translator and does not mention command execution', async () => {
  const env = await requestMultilingualAugmentation({
    source_rows: enRows(1),
    target_langs: ['es'],
    dry_run: false,
  });

  assert.equal(env.ok, false);
  assert.equal(env.error, 'no_translator_configured');
  assertContract(env);
  assert.doesNotMatch(env.hint, /KOLM_TRANSLATOR_CMD|subprocess|shell/i);
  assert.equal(env.plan.n_estimated_calls, 1);
});

test('W711 injected translator execution is bounded, deterministic, and skips self targets', async () => {
  const seen = [];
  const longOutput = 'x'.repeat(MULTI_AUGMENT_LIMITS.max_text_chars + 50);
  const teacher = async (args) => {
    seen.push(args);
    return {
      input: `[${args.target_lang}] ${args.input}\u0000`,
      output: longOutput,
    };
  };
  const sourceRows = [
    { cid: 'cid/unsafe path', input: EN_TEXT, output: 'ok' },
    { cid: 'cid-es', input: 'el la que de los las pero una muestra', output: 'salida' },
  ];
  const env = await requestMultilingualAugmentation({
    source_rows: sourceRows,
    target_langs: ['es', 'fr'],
    teacher_caller: teacher,
    dry_run: false,
  });
  const env2 = await requestMultilingualAugmentation({
    source_rows: sourceRows,
    target_langs: ['es', 'fr'],
    teacher_caller: teacher,
    dry_run: false,
  });

  assert.equal(env.ok, true);
  assert.equal(env.n_calls, 3);
  assert.equal(env.n_success, 3);
  assert.equal(env.n_failed, 0);
  assert.equal(env.plan.skipped_self_translations, 1);
  assertContract(env);
  assert.equal(seen.length, 6);
  assert.ok(seen.every((call) => call.target_lang !== call.source_lang));
  assert.equal(env.augmented.length, 3);
  assert.deepEqual(
    env.augmented.map((r) => r.generation_id),
    env2.augmented.map((r) => r.generation_id),
  );
  for (const row of env.augmented) {
    assert.equal(row.source_type, 'synthetic');
    assert.equal(row.synthetic_kind, 'translation');
    assert.equal(row.contract_version, MULTI_AUGMENT_CONTRACT_VERSION);
    assert.match(row.generation_id, /^[a-f0-9]{16}$/);
    assert.ok(!row.input.includes('\u0000'));
    assert.equal(row.output.length, MULTI_AUGMENT_LIMITS.max_text_chars);
    assert.equal(row.translation_truncated, true);
    assert.notEqual(row.source_cid, 'cid/unsafe path');
  }
});

test('W711 translator failures are capped and digest-backed without raw message leakage', async () => {
  const teacher = async () => {
    const err = new Error('SECRET-CORPUS-ROW C:\\Users\\name\\private.txt');
    err.code = 'E_TRANSLATE';
    throw err;
  };
  const env = await requestMultilingualAugmentation({
    source_rows: enRows(MULTI_AUGMENT_LIMITS.max_errors + 5),
    target_langs: ['es'],
    teacher_caller: teacher,
    dry_run: false,
  });

  assert.equal(env.ok, true);
  assert.equal(env.n_success, 0);
  assert.equal(env.n_failed, MULTI_AUGMENT_LIMITS.max_errors + 5);
  assert.equal(env.errors.length, MULTI_AUGMENT_LIMITS.max_errors);
  assert.equal(env.errors_truncated, true);
  assert.equal(env.errors[0].error, 'E_TRANSLATE');
  assert.match(env.errors[0].error_digest, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(env.errors), /SECRET-CORPUS-ROW|private\.txt/);
  assertContract(env);
});

test('W711 mergeAugmentedRows emits deterministic synthetic rows with bounded provenance feedback', () => {
  const augmented = [{
    input: ' hola \n mundo ',
    output: ' respuesta ',
    target_lang: 'es',
    source_lang: 'en',
    source_cid: 'cid/unsafe path',
    generation_id: 'gen-1',
    namespace: 'ns/unsafe',
    translation_truncated: true,
    version: MULTI_AUGMENT_VERSION,
  }];

  const merged = mergeAugmentedRows([{ input: 'original', output: 'row' }], augmented);
  const mergedAgain = mergeAugmentedRows([{ input: 'original', output: 'row' }], augmented);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged, mergedAgain);
  const row = merged[1];
  assert.equal(row.input, 'hola mundo');
  assert.equal(row.output, 'respuesta');
  assert.equal(row.lang, 'es');
  assert.equal(row.source_type, 'synthetic');
  assert.match(row.cid, /^mau_[a-f0-9]{16}$/);
  const feedback = JSON.parse(row.feedback);
  assert.equal(feedback.synthetic_kind, 'translation');
  assert.equal(feedback.target_lang, 'es');
  assert.equal(feedback.source_lang, 'en');
  assert.equal(feedback.source_cid, 'cid_unsafe_path');
  assert.equal(feedback.generation_id, 'gen-1');
  assert.equal(feedback.translation_truncated, true);
  assert.equal(feedback.contract_version, MULTI_AUGMENT_CONTRACT_VERSION);
});

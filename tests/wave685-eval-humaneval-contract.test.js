import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HUMANEVAL_DATASET_ID,
  HUMANEVAL_LIMITS,
  HUMANEVAL_SCORER_ID,
  HUMANEVAL_VERSION,
  extractCodeFromResponse,
  loadHumanEvalPack,
  parseHumanEvalJsonl,
  runHumanEval,
} from '../src/eval-humaneval.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function jsonlRow(task_id, entry_point, prompt = 'Write a function.', testBody = 'def check(candidate):\n    pass') {
  return JSON.stringify({
    task_id,
    prompt,
    canonical_solution: `\ndef ${entry_point}():\n    return 1\n`,
    test: testBody,
    entry_point,
  });
}

function makePack(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w685-humaneval-'));
  fs.writeFileSync(path.join(dir, 'HumanEval.jsonl'), rows.join('\n') + '\n');
  return dir;
}

test('W685 HumanEval source pins frontier evidence, bounds, and depth wiring', () => {
  const source = read('src/eval-humaneval.js');
  const router = read('src/router.js');
  const pkg = readJson('package.json');

  assert.equal(HUMANEVAL_VERSION, 'w758-v2');
  assert.match(HUMANEVAL_VERSION, /^w758-/);
  assert.equal(HUMANEVAL_DATASET_ID, 'openai_humaneval');
  assert.equal(HUMANEVAL_SCORER_ID, 'openai_humaneval_pass_at_1_sandbox_v1');
  assert.equal(HUMANEVAL_LIMITS.MAX_TASKS, 164);
  assert.match(source, /HUMANEVAL_DATASET_REVISION_ENV/);
  assert.match(source, /MAX_PACK_BYTES: 25 \* 1024 \* 1024/);
  assert.match(source, /bench_pack_symlink_rejected/);
  assert.match(source, /task_manifest_sha256/);
  assert.match(source, /prompt_template_sha256/);
  assert.match(source, /result_sha256/);
  assert.match(source, /generation_timeout/);
  assert.match(source, /sandbox_timeout/);
  assert.match(source, /_stableJson/);
  assert.match(router, /dataset_revision: typeof body\.dataset_revision/);
  assert.match(router, /sandbox_timeout_ms: typeof body\.sandbox_timeout_ms/);
  assert.doesNotMatch(source, /eval\(/);
  assert.doesNotMatch(source, /new Function/);
  assert.doesNotMatch(source, /[^\x00-\x7F]/);

  assert.equal(pkg.scripts['verify:eval-humaneval'], 'node --test --test-concurrency=1 tests/wave685-eval-humaneval-contract.test.js');
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:drift-alert && npm run verify:drift-alert-w813 && npm run verify:failure-modes-w745 && npm run verify:openai-finetune-importer && npm run verify:poisoning-orchestrator && node --test --test-concurrency=1 tests\/wave409u-federated-foundation\.test\.js tests\/wave585-federated-robust-aggregation\.test\.js tests\/wave538-federated-route-docs\.test\.js && npm run verify:eval-humaneval && npm run verify:homebrew-formula/,
  );
});

test('W685 parser caps hostile JSONL rows and adds per-task hashes', () => {
  const hugePrompt = 'x'.repeat(HUMANEVAL_LIMITS.MAX_PROMPT_CHARS + 100);
  const rows = parseHumanEvalJsonl([
    '{not json',
    jsonlRow('HumanEval/0\ncontrol', 'solve\tit', hugePrompt),
    jsonlRow('HumanEval/1', 'second'),
  ].join('\n'), { max_tasks: 1 });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, 'HumanEval/0 control');
  assert.equal(rows[0].entry_point, 'solve it');
  assert.equal(rows[0].prompt.length, HUMANEVAL_LIMITS.MAX_PROMPT_CHARS);
  assert.match(rows[0].prompt_sha256, /^[a-f0-9]{64}$/);
  assert.match(rows[0].test_sha256, /^[a-f0-9]{64}$/);
  assert.match(rows[0].canonical_solution_sha256, /^[a-f0-9]{64}$/);
  assert.match(rows[0].task_sha256, /^[a-f0-9]{64}$/);
});

test('W685 pack loader rejects unsafe pack boundaries and returns provenance', () => {
  const invalid = loadHumanEvalPack({ pack_dir: 'bad\npath' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'bench_pack_invalid_path');

  const nonRegularDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w685-humaneval-dir-'));
  fs.mkdirSync(path.join(nonRegularDir, 'HumanEval.jsonl'));
  try {
    const nonRegular = loadHumanEvalPack({ pack_dir: nonRegularDir });
    assert.equal(nonRegular.ok, false);
    assert.equal(nonRegular.error, 'bench_pack_not_regular_file');
  } finally {
    fs.rmSync(nonRegularDir, { recursive: true, force: true });
  }

  const packDir = makePack([
    jsonlRow('HumanEval/0', 'add'),
    jsonlRow('HumanEval/1', 'mul'),
  ]);
  try {
    const pack = loadHumanEvalPack({ pack_dir: packDir, dataset_revision: 'fixture-rev-a' });
    assert.equal(pack.ok, true);
    assert.equal(pack.dataset_id, 'openai_humaneval');
    assert.equal(pack.dataset_revision, 'fixture-rev-a');
    assert.equal(pack.n, 2);
    assert.equal(pack.pack_bytes, fs.statSync(path.join(packDir, 'HumanEval.jsonl')).size);
    assert.match(pack.pack_sha256, /^[a-f0-9]{64}$/);
    assert.match(pack.task_manifest_sha256, /^[a-f0-9]{64}$/);
    assert.match(pack.prompt_template_sha256, /^[a-f0-9]{64}$/);
    assert.equal(pack.scorer_version, HUMANEVAL_VERSION);
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
});

test('W685 runner emits a bounded, digest-backed manifest without raw code or tests', async () => {
  const packDir = makePack([
    jsonlRow('HumanEval/0', 'add', 'Implement add.'),
    jsonlRow('HumanEval/1', 'mul', 'Implement mul.'),
  ]);
  try {
    const result = await runHumanEval({
      artifact_path: 'artifact.kolm',
      pack_dir: packDir,
      dataset_revision: 'fixture-rev-b',
      run_seed: 'seed-1',
      generation_timeout_ms: 1000,
      sandbox_timeout_ms: 1000,
      runOnArtifact: async (_artifact, prompt, ctx) => {
        assert.match(ctx.run_id, /^humaneval_[a-f0-9]{20}$/);
        assert.match(ctx.prompt_sha256, /^[a-f0-9]{64}$/);
        return prompt.includes('add')
          ? '```python\ndef add(a, b):\n    return a + b\n```'
          : 'def mul(a, b):\n    return 0';
      },
      sandbox_cmd: async (_code, _test, entryPoint, ctx) => {
        assert.match(ctx.code_sha256, /^[a-f0-9]{64}$/);
        assert.match(ctx.test_sha256, /^[a-f0-9]{64}$/);
        if (entryPoint === 'add') return { passed: true };
        return { passed: false, stderr: `failure\n${'x'.repeat(HUMANEVAL_LIMITS.MAX_ERROR_CHARS + 50)}` };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.n, 2);
    assert.equal(result.passed, 1);
    assert.equal(result.pass_at_1, 0.5);
    assert.equal(result.dataset_revision, 'fixture-rev-b');
    assert.match(result.run_id, /^humaneval_[a-f0-9]{20}$/);
    assert.match(result.result_sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.run_manifest.pass_metric, 'pass@1');
    assert.equal(result.run_manifest.generation_policy, 'single_sample_temperature_0');
    assert.equal(result.run_manifest.scorer_id, HUMANEVAL_SCORER_ID);
    assert.match(result.run_manifest.task_manifest_sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.by_task.length, 2);
    assert.equal(result.by_task[0].stage, 'pass');
    assert.equal(result.by_task[1].stage, 'test_fail');
    assert.match(result.by_task[0].code_sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.by_task[1].stderr.length <= HUMANEVAL_LIMITS.MAX_ERROR_CHARS);
    assert.doesNotMatch(result.by_task[1].stderr, /[\r\n]/);
    assert.doesNotMatch(JSON.stringify(result), /def add/);
    assert.doesNotMatch(JSON.stringify(result), /def check/);
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
});

test('W685 runner fails closed on sandbox timeout and caps extracted code', async () => {
  assert.equal(
    extractCodeFromResponse(`before\n\`\`\`python\n${'x'.repeat(20)}\n\`\`\``, { max_code_chars: 8 }),
    'xxxxxxxx',
  );

  const packDir = makePack([jsonlRow('HumanEval/0', 'hang', 'Implement hang.')]);
  try {
    const result = await runHumanEval({
      pack_dir: packDir,
      sandbox_timeout_ms: 5,
      generation_timeout_ms: 1000,
      runOnArtifact: async () => 'def hang():\n    return 1',
      sandbox_cmd: async () => new Promise(() => {}),
    });

    assert.equal(result.ok, true);
    assert.equal(result.passed, 0);
    assert.equal(result.by_task[0].stage, 'sandbox_timeout');
    assert.equal(result.by_task[0].passed, false);
    assert.match(result.by_task[0].stderr, /sandbox_timeout timed out after 5ms/);
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
});

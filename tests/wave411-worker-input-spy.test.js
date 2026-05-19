// Wave 411 — Addendum atom #7: spy the actual data passed into the distill
// worker. The previous bug (compile-pipeline.js:623 leaking corpusPairs and
// distill-pipeline.js:147 dropping metadata) was dangerous precisely because
// the *receipt* looked honest while the *training input* was not. Auditing
// the receipt alone cannot catch this class of regression.
//
// Strategy: substitute a no-op worker script via the `worker_cmd` parameter
// (recognized by distill()), let distill() stage spec.json + seeds.jsonl,
// then read those files directly off disk to assert what the real worker
// WOULD have seen. The stub exits 0 immediately; no torch, no spawn delay,
// no Windows event-loop hang.
//
// Assertions:
//   - seeds.jsonl contains only approved train rows when caller passes the
//     output of compile-pipeline's hydration step.
//   - seeds.jsonl contains zero holdout_only rows even when a malicious or
//     buggy caller slips one into pairs_override.
//   - seeds.jsonl is JSONL (one JSON object per line, trailing newline).
//   - spec.json includes namespace + student_base.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function _mkTmp(label = 'w411-spy') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_DISTILL_FULL: process.env.KOLM_DISTILL_FULL,
    KOLM_DISTILL_TEACHER: process.env.KOLM_DISTILL_TEACHER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    KOLM_DISTILL_WORKER_CMD: process.env.KOLM_DISTILL_WORKER_CMD,
  };
}

function _setEnv(tmp) {
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_STORE_DRIVER = 'jsonl';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.KOLM_DISTILL_FULL;
  delete process.env.KOLM_DISTILL_TEACHER;
  delete process.env.KOLM_DISTILL_WORKER_CMD;
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

// Write a no-op worker .mjs that, when spawned via `node <script>`, exits 0
// immediately. This lets distill() finish without the real torch worker
// running. The runDir + seeds.jsonl are written by distill() BEFORE the
// spawn, so we can read them after distill() resolves.
function _stubWorker(tmp) {
  const stubPath = path.join(tmp, 'stub-worker.mjs');
  // The stub also writes a manifest so distill() doesn't error on the
  // missing-manifest path. Minimal shape — just enough for the iterator to
  // emit its final done frame.
  fs.writeFileSync(stubPath, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "let out = null;",
    "for (const a of args) {",
    "  if (a.startsWith('--out=')) out = a.slice(6);",
    "}",
    "if (out) {",
    "  try { fs.mkdirSync(out, { recursive: true }); } catch {}",
    "  try { fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({mode:'stub', ok:true})); } catch {}",
    "}",
    "process.exit(0);",
    '',
  ].join('\n'));
  return stubPath;
}

async function _seedNamespace(namespace, n) {
  const { appendEvent, _resetForTests } = await import('../src/event-store.js');
  _resetForTests();
  for (let i = 0; i < n; i++) {
    await appendEvent({
      namespace,
      tenant_id: 'spy-tenant',
      prompt_redacted: 'spy prompt ' + i,
      response_redacted: 'spy response ' + i,
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
      source_type: 'capture',
    });
  }
}

// Read the most-recent distill runDir created by distill(). The path is
// `${KOLM_DATA_DIR}/distill-runs/run_<jobId>` — sort entries by mtime desc.
function _readLatestRun(tmp) {
  const root = path.join(tmp, 'distill-runs');
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root)
    .map((d) => ({ name: d, full: path.join(root, d), stat: fs.statSync(path.join(root, d)) }))
    .filter((e) => e.stat.isDirectory())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (dirs.length === 0) return null;
  const runDir = dirs[0].full;
  const seedsPath = path.join(runDir, 'seeds.jsonl');
  const specPath = path.join(runDir, 'spec.json');
  return {
    runDir,
    seedsPath,
    specPath,
    seeds: fs.existsSync(seedsPath)
      ? fs.readFileSync(seedsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [],
    spec: fs.existsSync(specPath)
      ? JSON.parse(fs.readFileSync(specPath, 'utf8'))
      : null,
  };
}

// Drive distill() far enough that seeds.jsonl + spec.json are written to disk
// WITHOUT awaiting the detached worker exit. distill() writes both files
// synchronously before the spawn, so calling .next() once + waiting a single
// macrotask is enough to materialize the run dir on disk. We then dispose of
// the iterator with .return() so the unref'd child handle doesn't keep the
// Node test runner alive (the Windows ERR_TEST_FAILURE "Promise resolution
// still pending" flake observed in W381 #16 + W409c #2-9).
async function _probeAndDispose(iter) {
  const nextPromise = iter.next();
  // 80ms is enough for distill() to mkdir runDir, write spec.json + seeds.jsonl,
  // and spawn the stub worker (which exits in <10ms). On slower CI we can bump.
  await new Promise((r) => setTimeout(r, 80));
  // Dispose of the iterator so the unref'd child doesn't keep us alive.
  if (typeof iter.return === 'function') {
    try { await Promise.race([iter.return(), new Promise((r) => setTimeout(r, 200))]); } catch {}
  }
  // Consume the in-flight next() (best-effort) so GC can reclaim it.
  try { await Promise.race([nextPromise, new Promise((r) => setTimeout(r, 200))]); } catch {}
  return [];
}

// ---------------------------------------------------------------------------
// #1 — Worker sees only the pairs the caller passed (no synthesis on the way).
test('W411 spy #1 — seeds.jsonl bytes == pairs_override (1:1, no reshuffle, no fill)', async () => {
  const tmp = _mkTmp('w411-spy-1');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const stub = _stubWorker(tmp);
    const { distill } = await import('../src/distill-pipeline.js');

    const injected = Array.from({ length: 7 }, (_, i) => ({
      prompt: 'INJ-prompt-' + i,
      response: 'INJ-response-' + i,
      event_id: 'evt_inj_' + i,
      source_type: 'capture',
      tenant_id: 'spy-tenant',
      approved: true,
      redaction_policy: 'phi-v1',
      holdout_only: false,
    }));

    const iter = distill({
      teacher_namespace: null,
      student_base: 'phi-mini',
      pairs_override: injected,
      max_steps: 5,
      emit_progress_every: 0,
      worker_cmd: stub,
    });
    await _probeAndDispose(iter);

    const run = _readLatestRun(tmp);
    assert.ok(run, 'distill() must create a run dir');
    assert.equal(run.seeds.length, injected.length,
      'seeds.jsonl must contain exactly the injected pairs (got ' + run.seeds.length + ', expected ' + injected.length + ')');
    for (let i = 0; i < injected.length; i++) {
      assert.equal(run.seeds[i].input, injected[i].prompt, 'pair[' + i + '].input must equal injected.prompt');
      assert.equal(run.seeds[i].output, injected[i].response, 'pair[' + i + '].output must equal injected.response');
      assert.equal(run.seeds[i].id, injected[i].event_id, 'pair[' + i + '].id must equal injected.event_id');
    }
    assert.ok(run.spec, 'spec.json must exist');
    assert.equal(run.spec.student_base, 'phi-mini', 'spec.student_base round-trips');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #2 — holdout_only rows are stripped at the distill() chokepoint EVEN when
//      the caller slips one into pairs_override. This is the fail-closed
//      defense at src/distill-pipeline.js:296 (the W411 P0 #8 lockdown).
test('W411 spy #2 — holdout_only:true rows are stripped before the worker sees seeds.jsonl', async () => {
  const tmp = _mkTmp('w411-spy-2');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const stub = _stubWorker(tmp);
    const { distill } = await import('../src/distill-pipeline.js');

    const trainRows = Array.from({ length: 5 }, (_, i) => ({
      prompt: 'train-' + i,
      response: 'reply-' + i,
      event_id: 'evt_train_' + i,
      source_type: 'capture',
      approved: true,
      holdout_only: false,
    }));
    const HOLDOUT_PROMPT = '!! HOLDOUT SECRET PROMPT !! must-never-train-on';
    const HOLDOUT_EVENT = 'evt_holdout_LEAK';
    const holdoutSneak = {
      prompt: HOLDOUT_PROMPT,
      response: 'holdout-reply',
      event_id: HOLDOUT_EVENT,
      source_type: 'capture',
      approved: true,
      holdout_only: true,  // <-- the smuggle attempt
    };
    const injected = [...trainRows, holdoutSneak];

    const iter = distill({
      teacher_namespace: null,
      student_base: 'phi-mini',
      pairs_override: injected,
      max_steps: 5,
      emit_progress_every: 0,
      worker_cmd: stub,
    });
    await _probeAndDispose(iter);

    const run = _readLatestRun(tmp);
    assert.ok(run, 'distill() must create a run dir');

    // The worker must NEVER see the holdout row.
    assert.equal(run.seeds.length, trainRows.length,
      'seeds.jsonl must drop the holdout_only row (got ' + run.seeds.length + ', expected ' + trainRows.length + ')');
    for (const seed of run.seeds) {
      assert.notEqual(seed.id, HOLDOUT_EVENT,
        'holdout event_id must not appear in seeds.jsonl');
      assert.notEqual(seed.input, HOLDOUT_PROMPT,
        'holdout prompt must not appear as any seed.input');
    }

    // Belt-and-braces: the holdout strings must not appear ANYWHERE in the
    // bytes of seeds.jsonl. Catches structural drift (e.g. someone adds a
    // wrapper field that re-includes the row).
    const bytes = fs.readFileSync(run.seedsPath, 'utf8');
    assert.ok(!bytes.includes(HOLDOUT_PROMPT),
      'seeds.jsonl bytes must not contain holdout prompt verbatim');
    assert.ok(!bytes.includes(HOLDOUT_EVENT),
      'seeds.jsonl bytes must not contain holdout event_id verbatim');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #3 — When the caller does NOT pass pairs_override AND a teacher_namespace
//      is given, the worker sees the prepareDistillCorpus(train-split) output
//      (NOT 'all' and NOT 'holdout'). This is the second leg of the P0 #1
//      defense — even if compile-pipeline never set pairs_override, the
//      distill() boundary still pulls the train split, never the full
//      corpus.
test('W411 spy #3 — when teacher_namespace is set and pairs_override is null, worker sees train-split corpus only', async () => {
  const tmp = _mkTmp('w411-spy-3');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const stub = _stubWorker(tmp);
    await _seedNamespace('spy-ns', 25);
    const { distill } = await import('../src/distill-pipeline.js');

    const iter = distill({
      teacher_namespace: 'spy-ns',
      student_base: 'phi-mini',
      pairs_override: null,
      max_steps: 5,
      emit_progress_every: 0,
      worker_cmd: stub,
      // W422 P0-4 — direct distill() now fences corpus by tenant. The
      // seed events above are stamped tenant_id='spy-tenant'; we must scope
      // the call to the same tenant or the new fence drops every row.
      tenant_id: 'spy-tenant',
    });
    await _probeAndDispose(iter);

    const run = _readLatestRun(tmp);
    assert.ok(run, 'distill() must create a run dir');

    // prepareDistillCorpus({split:'train'}) keeps 4 out of every 5 rows
    // (every 5th goes to holdout). 25 rows → 20 train. Allow exactly 20 or
    // 25-greedy; we want STRICTLY less than 25 to prove the train filter
    // ran.
    assert.ok(run.seeds.length > 0, 'must yield seeds');
    assert.ok(run.seeds.length < 25,
      'seeds.jsonl must be strictly less than the full corpus (train-split only, got ' + run.seeds.length + ')');
    // Allow some slack but require ~80% (20/25).
    assert.ok(run.seeds.length >= 15 && run.seeds.length <= 22,
      'seeds.jsonl size must be in the train-split band (15-22 of 25, got ' + run.seeds.length + ')');
  } finally {
    _restoreEnv(saved);
  }
});

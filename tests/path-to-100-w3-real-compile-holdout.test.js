// W-3 (Path to 100%) — the REAL compile pipeline (createJob + runJob, the one
// `kolm compile` uses) is non-self-citing: it refuses empty seeds and splits a
// real holdout BEFORE synthesis. This is the path the no-code wizard must adopt
// (the wizard's /v1/compile/start+stream are still a canned stub —
// compile-stream.js — whose UI rewire is render-coupled). This test locks A4 on
// the real pipeline so it can't regress.

import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { createJob, runJob } from '../src/compile.js';
import { synthesize } from '../src/synthesis.js';

test('W-3 A4: the real compile REFUSES empty seeds (no fabricated eval set)', async () => {
  const job = createJob({ task: 'classify', examples: [], tenant: 'w3a_' + process.pid });
  await runJob(job, {
    examples: [],
    synthesize,
    outDir: path.join(os.tmpdir(), 'kolm-w3a-' + process.pid),
  });
  assert.strictEqual(job.status, 'failed', 'a seed-less compile must fail, not fabricate');
  assert.strictEqual(job.error_code, 'KOLM_E_NO_SEEDS');
});

test('W-3 A4: a real compile from examples splits a real holdout before synthesis', async () => {
  const ex = [
    { input: 'this is urgent please help', output: true },
    { input: 'urgent: the server is down', output: true },
    { input: 'urgent deadline is today', output: true },
    { input: 'just saying hello there', output: false },
    { input: 'a normal update, no rush', output: false },
    { input: 'fyi for later, low priority', output: false },
  ];
  const job = createJob({ task: 'flag urgent messages', examples: ex, tenant: 'w3b_' + process.pid });
  await runJob(job, {
    examples: ex,
    synthesize,
    outDir: path.join(os.tmpdir(), 'kolm-w3b-' + process.pid),
  });

  // The W283 split runs BEFORE synthesis, so split.done is recorded regardless
  // of whether the recipe ultimately passed the gate — the anti-leakage core.
  const split = (job.stages || []).find((s) => s && s.name === 'split.done');
  assert.ok(
    split,
    'the real holdout split must run (not the stub); stages=' +
      JSON.stringify((job.stages || []).map((s) => s && s.name)),
  );
  assert.ok(split.holdout_count >= 1, 'a real holdout row was held back from synthesis');
  assert.ok(
    typeof split.synthesis_input_hash === 'string' && split.synthesis_input_hash.length > 0,
    'the train-only synthesis input is hashed for auditability',
  );
});

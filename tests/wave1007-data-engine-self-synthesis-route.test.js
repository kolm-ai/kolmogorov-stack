// W1007 - DATA ENGINE SELF-SYNTHESIS ROUTE.
//
// This locks the frontier-relevant orchestration seam, not the lower-level
// Magpie generator (covered by finalized-c1-live-magpie-autoevol...):
//   orchestratePipeline({ augment_strategy:'self-synthesis' })
// must route through src/self-synthesis-engine.js, keep the standard AUGMENT
// preview/apply cost gate, and write real filled instruction/response rows only
// after explicit approval. The teacher is a dependency-injected fake; no network,
// no GPU, no python, no real user data.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { orchestratePipeline } from '../src/data-engine.js';

let TMP_DIR;
let PRIOR_DATA_DIR;
let _tenantN = 0;

function tenant() {
  return `tenant_w1007_self_synth_${process.pid}_${++_tenantN}`;
}

function describeOpts(extra = {}) {
  return {
    describe: 'Answer support questions about account security.',
    describe_n: 4,
    ...extra,
  };
}

function magpieFake() {
  const seen = [];
  let i = 0;
  const caller = async (prompt, opts = {}) => {
    seen.push({ prompt, opts });
    if (opts.phase === 'magpie_instruction') {
      i += 1;
      return `How do I rotate my recovery codes ${i}?<|im_end|>`;
    }
    if (opts.phase === 'magpie_response') {
      return `Open Security, choose Recovery codes, and generate a fresh set.<|im_end|>`;
    }
    return '';
  };
  return { caller, seen };
}

function augmentPath(ns) {
  return path.join(TMP_DIR, '.kolm', 'data', ns, 'augment-pairs.jsonl');
}

before(() => {
  PRIOR_DATA_DIR = process.env.KOLM_DATA_DIR;
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w1007-self-synth-'));
  process.env.KOLM_DATA_DIR = TMP_DIR;
});

after(() => {
  if (PRIOR_DATA_DIR === undefined) delete process.env.KOLM_DATA_DIR;
  else process.env.KOLM_DATA_DIR = PRIOR_DATA_DIR;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test('self-synthesis route previews Magpie rows without writing and uses prompt-free prequery', async () => {
  const ns = 'ns-self-synth-preview';
  const fake = magpieFake();

  const out = await orchestratePipeline({
    tenant: tenant(),
    namespace: ns,
    opts: describeOpts({
      augment_strategy: 'self-synthesis',
      augment: { mode: 'magpie', generator_family: 'qwen', n: 2, salt: 'w1007-preview' },
      teacher_caller: fake.caller,
    }),
  });

  assert.equal(out.ok, true);
  const aug = out.stages.augment;
  assert.equal(aug.ok, true);
  assert.equal(aug.strategy, 'self-synthesis:magpie');
  assert.equal(aug.method, 'magpie');
  assert.equal(aug.n_candidates, 2);
  assert.equal(aug.applied, false);
  assert.equal(aug.approved, false);
  assert.notEqual(aug.wrote, true);
  assert.equal(typeof aug.cost_preview.est_cost_usd, 'number');
  assert.equal(aug.cost_preview.teacher_calls, 4);
  assert.equal(fs.existsSync(augmentPath(ns)), false);

  const instrCalls = fake.seen.filter((s) => s.opts.phase === 'magpie_instruction');
  assert.equal(instrCalls.length, 2);
  for (const c of instrCalls) {
    assert.equal(c.prompt, '<|im_start|>user\n');
    assert.equal(c.opts.mode, 'raw_completion');
  }
});

test('self-synthesis route applies only after approval and writes filled pairs', async () => {
  const ns = 'ns-self-synth-apply';
  const fake = magpieFake();

  const out = await orchestratePipeline({
    tenant: tenant(),
    namespace: ns,
    opts: describeOpts({
      augment_strategy: 'self-synthesis',
      augment: { mode: 'magpie', generator_family: 'qwen', n: 2, salt: 'w1007-apply' },
      teacher_caller: fake.caller,
      approve_cost_usd: 999,
    }),
  });

  assert.equal(out.ok, true);
  const aug = out.stages.augment;
  assert.equal(aug.ok, true);
  assert.equal(aug.approved, true);
  assert.equal(aug.applied, true);
  assert.equal(aug.wrote, true);
  assert.equal(aug.path, augmentPath(ns));

  const lines = fs.readFileSync(augmentPath(ns), 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  const rows = lines.map((line) => JSON.parse(line));
  for (const row of rows) {
    assert.match(row.input, /rotate my recovery codes/);
    assert.match(row.output, /Recovery codes/);
    assert.equal(row.source_type, 'augment');
    assert.equal(row.provenance.strategy, 'self-synthesis:magpie');
    assert.equal(row.provenance.method, 'magpie');
    assert.equal(row.provenance.parent_seed_cids.length, 0);
  }
});

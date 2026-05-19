// Wave 430 — Audit P1-6: distill bridge metadata pass-through.
//
// W411 P0 #2 pinned the 7 training-metadata fields (source_type, tenant_id,
// approved, redaction_policy, holdout_only, fixed_output, event_id) on every
// row that flows out of prepareDistillCorpus() in src/distill-pipeline.js.
// The 2026-05-19 audit (P1-6) called out src/distill-bridge.js as a SECOND
// path into the distill worker — the one used by /v1/distill/from-captures
// and /v1/specialists/auto-distill — that was still stripping every row down
// to {id, input, output} before writing seeds.jsonl. That silently undid the
// W411 guarantee for every tenant whose distill ran through the bridge.
//
// W430 fix (src/distill-bridge.js writeWorkerInputs):
//   - forward the 7 named metadata fields verbatim when present on each capture
//   - drop holdout_only=true rows defensively before the JSONL write so the
//     fail-closed W411 P0 #8 chokepoint also fires on the bridge path
//   - surface holdout_excluded on the job record meta for the receipt audit
//
// Assertions:
//   1. Static-source: writeWorkerInputs forwards the 7 metadata field names.
//   2. Static-source: NO `.pick()` and no `{prompt, response}` shape-strip
//      between the captures argument and the rows.map() that builds seeds.
//   3. Behavior: feed bridge captures with all 7 fields → spy seeds.jsonl
//      and assert every field survives the write verbatim.
//   4. Behavior: holdout_only=true capture is dropped before the worker
//      ever sees it; remaining rows are unchanged.
//   5. Behavior: holdout_excluded counter on job meta reflects the drop.
//   6. Behavior: absent metadata stays absent (no invented defaults).
//   7. Behavior: id falls back to event_id when no id provided.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'src/distill-bridge.js');
const BRIDGE_SRC = fs.readFileSync(MODULE_PATH, 'utf8');

const METADATA_FIELDS = [
  'source_type',
  'tenant_id',
  'approved',
  'redaction_policy',
  'holdout_only',
  'fixed_output',
  'event_id',
];

function freshImport() {
  return import(pathToFileURL(MODULE_PATH).href + '?t=' + Date.now());
}

function makeSpawnMock() {
  const calls = [];
  const fn = (cmd, args, spawnOpts) => {
    const child = new EventEmitter();
    child.pid = 42424;
    child.unref = () => {};
    child.kill = () => {};
    calls.push({ cmd, args, spawnOpts });
    return child;
  };
  return { fn, calls };
}

function withTmpDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w430-'));
  return { tmp, cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} } };
}

function withEnv(extra = {}) {
  const SAVED = {};
  const TARGETS = [
    'KOLM_DISTILL_FULL', 'KOLM_DISTILL_TEACHER', 'KOLM_DISTILL_MAX_ROWS',
    'KOLM_DISTILL_TMP_DIR', 'KOLM_JOBS_DIR', 'KOLM_JOBS_FILE',
    'KOLM_JOB_LOG_DIR', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  ];
  for (const k of TARGETS) {
    if (k in process.env) { SAVED[k] = process.env[k]; delete process.env[k]; }
  }
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  return () => {
    for (const k of TARGETS) delete process.env[k];
    for (const [k, v] of Object.entries(SAVED)) process.env[k] = v;
  };
}

// Read seeds.jsonl that the bridge wrote. The bridge places it under
// process.env.KOLM_DISTILL_TMP_DIR/kolm-distill-<hex>/seeds.jsonl — sort by mtime.
function readLatestSeeds(workspace) {
  if (!fs.existsSync(workspace)) return null;
  const dirs = fs.readdirSync(workspace)
    .map((d) => ({ name: d, full: path.join(workspace, d), stat: fs.statSync(path.join(workspace, d)) }))
    .filter((e) => e.stat.isDirectory())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (dirs.length === 0) return null;
  const dir = dirs[0].full;
  const seedsPath = path.join(dir, 'seeds.jsonl');
  const specPath = path.join(dir, 'spec.json');
  return {
    dir,
    seedsPath,
    specPath,
    bytes: fs.existsSync(seedsPath) ? fs.readFileSync(seedsPath, 'utf8') : '',
    seeds: fs.existsSync(seedsPath)
      ? fs.readFileSync(seedsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [],
    spec: fs.existsSync(specPath) ? JSON.parse(fs.readFileSync(specPath, 'utf8')) : null,
  };
}

// ---------------------------------------------------------------------------
// #1 — Static-source: writeWorkerInputs body mentions each of the 7 metadata
//      field names. A future refactor that silently drops one fails the test.
test('W430 #1 — static-source: writeWorkerInputs forwards all 7 metadata field names', () => {
  for (const f of METADATA_FIELDS) {
    assert.ok(BRIDGE_SRC.includes(f),
      `distill-bridge.js must reference "${f}" so the bridge forwards it to the worker`);
  }
});

// ---------------------------------------------------------------------------
// #2 — Static-source regression guard: NO `.pick(` and NO `{prompt, response}`
//      shape-stripping between the rows.map() and the JSONL write. The
//      original bug was a literal `{id, input, output}` object literal that
//      dropped all metadata. We pin against any future re-introduction of a
//      shape that is missing at least one metadata field.
test('W430 #2 — static-source: no .pick() / no {prompt, response}-only strip', () => {
  // No lodash-style pick on capture rows.
  assert.ok(!/\bcaptures?\.pick\s*\(/.test(BRIDGE_SRC),
    'distill-bridge.js must not .pick() fields off captures (would strip metadata)');
  assert.ok(!/\.map\(\s*\([^)]*\)\s*=>\s*\(?\s*\{\s*prompt\s*:[^}]*response\s*:[^}]*\}\s*\)?\s*\)/.test(BRIDGE_SRC),
    'distill-bridge.js must not collapse captures to a {prompt, response}-only shape');
  // Pin: the legacy 3-field-only literal must be replaced. The fix path
  // forwards the 7 fields conditionally — that means the source must
  // reference each one inside writeWorkerInputs.
  const fnStart = BRIDGE_SRC.indexOf('function writeWorkerInputs');
  assert.ok(fnStart > 0, 'writeWorkerInputs function must exist');
  const fnEnd = BRIDGE_SRC.indexOf('\n}', fnStart);
  assert.ok(fnEnd > fnStart, 'writeWorkerInputs must close with a } at column 0');
  const body = BRIDGE_SRC.slice(fnStart, fnEnd);
  for (const f of METADATA_FIELDS) {
    assert.ok(body.includes(f),
      `writeWorkerInputs body must mention "${f}" (audit P1-6 metadata pass-through)`);
  }
});

// ---------------------------------------------------------------------------
// #3 — Behavior: feed bridge captures with all 7 fields set. Spawn is mocked
//      so nothing runs. Read seeds.jsonl off disk and assert every field
//      survives verbatim on every row.
test('W430 #3 — behavior: all 7 metadata fields survive the seeds.jsonl write', async () => {
  const { tmp, cleanup } = withTmpDir();
  const workspace = path.join(tmp, 'workspace');
  const restore = withEnv({
    KOLM_DISTILL_TMP_DIR: workspace,
    KOLM_JOBS_DIR: path.join(tmp, 'jobs'),
    KOLM_JOBS_FILE: path.join(tmp, 'jobs.jsonl'),
    KOLM_JOB_LOG_DIR: path.join(tmp, 'logs'),
  });
  try {
    const { startDistillJob } = await freshImport();
    const mock = makeSpawnMock();
    const captures = Array.from({ length: 4 }, (_, i) => ({
      id: `cap_${i}`,
      variable_input: `prompt-${i}`,
      response: `reply-${i}`,
      event_id: `evt_${i}`,
      source_type: 'capture',
      tenant_id: 'tenant_w430',
      approved: true,
      redaction_policy: 'phi-v1',
      holdout_only: false,
      fixed_output: i === 0 ? 'corrected reply' : null,
    }));
    const job = await startDistillJob({
      tenant: 'tenant_w430',
      namespace: 'ns_w430',
      captures,
      spawnOverride: mock.fn,
    });
    assert.equal(job.kind, 'distill');
    assert.equal(mock.calls.length, 1, 'spawn must have been called once');

    const dump = readLatestSeeds(workspace);
    assert.ok(dump, 'workspace must contain a kolm-distill-<hex>/ dir with seeds.jsonl');
    assert.equal(dump.seeds.length, 4, 'all 4 train rows must reach seeds.jsonl');

    for (let i = 0; i < dump.seeds.length; i++) {
      const seed = dump.seeds[i];
      assert.equal(seed.input, `prompt-${i}`, `seed[${i}].input round-trips`);
      assert.equal(seed.output, `reply-${i}`, `seed[${i}].output round-trips`);
      // The 7 audit fields:
      assert.equal(seed.event_id, `evt_${i}`, `seed[${i}].event_id preserved`);
      assert.equal(seed.source_type, 'capture', `seed[${i}].source_type preserved`);
      assert.equal(seed.tenant_id, 'tenant_w430', `seed[${i}].tenant_id preserved`);
      assert.equal(seed.approved, true, `seed[${i}].approved preserved`);
      assert.equal(seed.redaction_policy, 'phi-v1', `seed[${i}].redaction_policy preserved`);
      assert.equal(seed.holdout_only, false, `seed[${i}].holdout_only preserved`);
      assert.equal(seed.fixed_output, i === 0 ? 'corrected reply' : null,
        `seed[${i}].fixed_output preserved verbatim`);
    }
  } finally {
    restore();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// #4 — Behavior: holdout_only=true capture is stripped before the worker
//      sees seeds.jsonl. Bytes-level check belt-and-braces.
test('W430 #4 — behavior: holdout_only:true rows are dropped before the JSONL write', async () => {
  const { tmp, cleanup } = withTmpDir();
  const workspace = path.join(tmp, 'workspace');
  const restore = withEnv({
    KOLM_DISTILL_TMP_DIR: workspace,
    KOLM_JOBS_DIR: path.join(tmp, 'jobs'),
    KOLM_JOBS_FILE: path.join(tmp, 'jobs.jsonl'),
    KOLM_JOB_LOG_DIR: path.join(tmp, 'logs'),
  });
  try {
    const { startDistillJob } = await freshImport();
    const mock = makeSpawnMock();
    const HOLDOUT_PROMPT = '!! HOLDOUT-LEAK-CANARY !!';
    const HOLDOUT_EVENT = 'evt_holdout_LEAK';
    const captures = [
      { id: 'c1', variable_input: 'train-1', response: 'r1', event_id: 'e1',
        source_type: 'capture', tenant_id: 't', approved: true, redaction_policy: 'phi-v1', holdout_only: false },
      { id: 'c2', variable_input: 'train-2', response: 'r2', event_id: 'e2',
        source_type: 'capture', tenant_id: 't', approved: true, redaction_policy: 'phi-v1', holdout_only: false },
      // Smuggle attempt:
      { id: 'cH', variable_input: HOLDOUT_PROMPT, response: 'rH', event_id: HOLDOUT_EVENT,
        source_type: 'capture', tenant_id: 't', approved: true, redaction_policy: 'phi-v1', holdout_only: true },
    ];
    await startDistillJob({
      tenant: 't', namespace: 'ns', captures, spawnOverride: mock.fn,
    });

    const dump = readLatestSeeds(workspace);
    assert.ok(dump, 'workspace dir must exist');
    assert.equal(dump.seeds.length, 2, 'holdout_only row must be dropped');
    for (const seed of dump.seeds) {
      assert.notEqual(seed.event_id, HOLDOUT_EVENT, 'holdout event_id must not survive');
      assert.notEqual(seed.input, HOLDOUT_PROMPT, 'holdout prompt must not survive');
    }
    assert.ok(!dump.bytes.includes(HOLDOUT_PROMPT),
      'seeds.jsonl bytes must not contain the holdout prompt verbatim');
    assert.ok(!dump.bytes.includes(HOLDOUT_EVENT),
      'seeds.jsonl bytes must not contain the holdout event_id verbatim');
  } finally {
    restore();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// #5 — Behavior: the job record meta carries holdout_excluded so the receipt
//      audit can prove the chokepoint fired on the bridge path.
test('W430 #5 — behavior: job.meta.holdout_excluded reflects the drop count', async () => {
  const { tmp, cleanup } = withTmpDir();
  const workspace = path.join(tmp, 'workspace');
  const restore = withEnv({
    KOLM_DISTILL_TMP_DIR: workspace,
    KOLM_JOBS_DIR: path.join(tmp, 'jobs'),
    KOLM_JOBS_FILE: path.join(tmp, 'jobs.jsonl'),
    KOLM_JOB_LOG_DIR: path.join(tmp, 'logs'),
  });
  try {
    const { startDistillJob } = await freshImport();
    const mock = makeSpawnMock();
    const captures = [
      { id: 'c1', variable_input: 'a', response: 'A', holdout_only: false },
      { id: 'c2', variable_input: 'b', response: 'B', holdout_only: true },
      { id: 'c3', variable_input: 'c', response: 'C', holdout_only: true },
      { id: 'c4', variable_input: 'd', response: 'D', holdout_only: false },
    ];
    const job = await startDistillJob({
      tenant: 't', namespace: 'ns', captures, spawnOverride: mock.fn,
    });
    assert.equal(job.meta.holdout_excluded, 2,
      `holdout_excluded must equal 2 (saw ${job.meta.holdout_excluded})`);
    assert.equal(job.meta.pair_count, 2,
      `pair_count must reflect post-strip seed count (saw ${job.meta.pair_count})`);
  } finally {
    restore();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// #6 — Behavior: absent metadata stays absent — the bridge MUST NOT invent
//      defaults that would be more convincing than the truth.
test('W430 #6 — behavior: absent metadata stays absent (no invented defaults)', async () => {
  const { tmp, cleanup } = withTmpDir();
  const workspace = path.join(tmp, 'workspace');
  const restore = withEnv({
    KOLM_DISTILL_TMP_DIR: workspace,
    KOLM_JOBS_DIR: path.join(tmp, 'jobs'),
    KOLM_JOBS_FILE: path.join(tmp, 'jobs.jsonl'),
    KOLM_JOB_LOG_DIR: path.join(tmp, 'logs'),
  });
  try {
    const { startDistillJob } = await freshImport();
    const mock = makeSpawnMock();
    // Captures without any audit metadata (legacy shape).
    const captures = [
      { id: 'c1', variable_input: 'i1', response: 'o1' },
      { id: 'c2', variable_input: 'i2', response: 'o2' },
    ];
    await startDistillJob({
      tenant: 't', namespace: 'ns', captures, spawnOverride: mock.fn,
    });
    const dump = readLatestSeeds(workspace);
    assert.ok(dump, 'workspace dir must exist');
    assert.equal(dump.seeds.length, 2);
    for (const seed of dump.seeds) {
      for (const f of METADATA_FIELDS) {
        assert.ok(!Object.prototype.hasOwnProperty.call(seed, f),
          `seed must NOT have "${f}" when caller did not supply it`);
      }
    }
  } finally {
    restore();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// #7 — Behavior: when id is missing, event_id is the fallback (preferred over
//      the synthetic cap_N counter so the receipt is event-traceable).
test('W430 #7 — behavior: id falls back to event_id when id is absent', async () => {
  const { tmp, cleanup } = withTmpDir();
  const workspace = path.join(tmp, 'workspace');
  const restore = withEnv({
    KOLM_DISTILL_TMP_DIR: workspace,
    KOLM_JOBS_DIR: path.join(tmp, 'jobs'),
    KOLM_JOBS_FILE: path.join(tmp, 'jobs.jsonl'),
    KOLM_JOB_LOG_DIR: path.join(tmp, 'logs'),
  });
  try {
    const { startDistillJob } = await freshImport();
    const mock = makeSpawnMock();
    const captures = [
      { variable_input: 'i', response: 'o', event_id: 'evt_traceable' },
    ];
    await startDistillJob({
      tenant: 't', namespace: 'ns', captures, spawnOverride: mock.fn,
    });
    const dump = readLatestSeeds(workspace);
    assert.equal(dump.seeds.length, 1);
    assert.equal(dump.seeds[0].id, 'evt_traceable',
      'seed.id must fall back to event_id when caller did not supply id');
  } finally {
    restore();
    cleanup();
  }
});

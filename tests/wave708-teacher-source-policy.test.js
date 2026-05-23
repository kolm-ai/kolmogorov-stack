// W708-2 — teacher-source policy enum: classification + _pickTeachers filter +
// manifest stamping. External reviewer flagged that distill needs a "safe by
// default" open-weights path so users can opt out of TOS-risky proprietary
// teachers structurally rather than by convention.
//
// Contract this test pins:
//   - classifyTeacher() returns 'open-weights' | 'proprietary' | 'unknown'.
//   - classifyTeacher honors `local:` / `hf:` prefix as open-weights.
//   - classifyTeacher honors `anthropic:` / `openai:` / `google:` prefix as
//     proprietary regardless of model name.
//   - With KOLM_TEACHER_SOURCE=open-weights set and only proprietary teachers
//     configured, _pickTeachers() throws no_open_weight_teacher_configured.
//   - With the policy set and at least one open-weights teacher configured,
//     _pickTeachers() returns the filtered list (proprietary teachers stripped).
//   - distill() stamps teacher_source + policy_enforced onto the run-meta and
//     the worker manifest so the .kolm receipt chain carries the policy enum.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// Stable cache-buster — each import() gets a fresh module copy so env mutation
// across tests does not bleed (the W459 tests use the same pattern).
function freshImport(suffix) {
  return import('../src/distill-pipeline.js?w708' + suffix + '=' + Date.now());
}

function writeAlwaysOkWorker(dir) {
  const p = path.join(dir, 'worker-always-ok.mjs');
  fs.writeFileSync(p, `
import fs from 'node:fs';
import path from 'node:path';
const out = (process.argv.find(a => a.startsWith('--out=')) || '').slice(6);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
  ok: true,
  attempt: process.env.KOLM_DISTILL_ATTEMPT || '1',
  finished_at: new Date().toISOString(),
}, null, 2));
process.exit(0);
`);
  return p;
}

// =============================================================================
// 1) classifyTeacher() — the open-weights / proprietary / unknown verdict.
// =============================================================================

test('W708 #1 — classifyTeacher: known open-weights slugs', async () => {
  const { classifyTeacher } = await freshImport('a');
  assert.equal(classifyTeacher('qwen2.5-7b'), 'open-weights');
  assert.equal(classifyTeacher('qwen2.5-3b-instruct'), 'open-weights');
  assert.equal(classifyTeacher('qwen3-32b'), 'open-weights');
  assert.equal(classifyTeacher('llama-3-8b'), 'open-weights');
  assert.equal(classifyTeacher('mistral-7b'), 'open-weights');
  assert.equal(classifyTeacher('mixtral-8x7b'), 'open-weights');
  assert.equal(classifyTeacher('deepseek-r1-distill-qwen-7b'), 'open-weights');
});

test('W708 #2 — classifyTeacher: known proprietary slugs', async () => {
  const { classifyTeacher } = await freshImport('b');
  assert.equal(classifyTeacher('claude-opus-4-7'), 'proprietary');
  assert.equal(classifyTeacher('claude-sonnet-4'), 'proprietary');
  assert.equal(classifyTeacher('gpt-4o-mini'), 'proprietary');
  assert.equal(classifyTeacher('gpt-5'), 'proprietary');
  assert.equal(classifyTeacher('gemini-2.5-pro'), 'proprietary');
  // Vendor-prefixed routes should also resolve to proprietary.
  assert.equal(classifyTeacher('anthropic:claude-opus-4-7'), 'proprietary');
  assert.equal(classifyTeacher('openai:gpt-4o-mini'), 'proprietary');
  assert.equal(classifyTeacher('google:gemini-2.5-pro'), 'proprietary');
});

test('W708 #3 — classifyTeacher: prefix + edge cases', async () => {
  const { classifyTeacher } = await freshImport('c');
  // Self-hosted prefixes count as open-weights regardless of model name.
  assert.equal(classifyTeacher('local:/srv/weights/foo'), 'open-weights');
  assert.equal(classifyTeacher('hf:Qwen/Qwen2.5-7B-Instruct'), 'open-weights');
  // Unknown slugs fall through to 'unknown' (safe-deny — policy filter rejects).
  assert.equal(classifyTeacher('totally-unknown-frontier-model'), 'unknown');
  assert.equal(classifyTeacher(''), 'unknown');
  assert.equal(classifyTeacher(null), 'unknown');
  assert.equal(classifyTeacher(undefined), 'unknown');
});

// =============================================================================
// 2) _pickTeachers() policy filter: empty → throws.
// =============================================================================

test('W708 #4 — KOLM_TEACHER_SOURCE=open-weights + only proprietary configured → throws', async () => {
  const saved = {
    K: process.env.KOLM_DISTILL_TEACHER,
    A: process.env.ANTHROPIC_API_KEY,
    O: process.env.OPENAI_API_KEY,
    S: process.env.KOLM_TEACHER_SOURCE,
  };
  try {
    delete process.env.KOLM_DISTILL_TEACHER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-anth';
    process.env.KOLM_TEACHER_SOURCE = 'open-weights';
    const { _pickTeachers } = await freshImport('d');
    let caught = null;
    try { _pickTeachers(); } catch (e) { caught = e; }
    assert.ok(caught, 'expected _pickTeachers to throw when only proprietary teacher is configured');
    assert.equal(caught.code, 'no_open_weight_teacher_configured');
    assert.match(caught.message, /no_open_weight_teacher_configured/);
    assert.ok(caught.hint && /KOLM_DISTILL_TEACHER/.test(caught.hint),
      'error must carry an actionable hint listing open-weight env vars');
  } finally {
    if (saved.K === undefined) delete process.env.KOLM_DISTILL_TEACHER; else process.env.KOLM_DISTILL_TEACHER = saved.K;
    if (saved.A === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.A;
    if (saved.O === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.O;
    if (saved.S === undefined) delete process.env.KOLM_TEACHER_SOURCE; else process.env.KOLM_TEACHER_SOURCE = saved.S;
  }
});

test('W708 #5 — KOLM_TEACHER_SOURCE=open-weights strips proprietary, keeps open-weights', async () => {
  const saved = {
    K: process.env.KOLM_DISTILL_TEACHER,
    A: process.env.ANTHROPIC_API_KEY,
    O: process.env.OPENAI_API_KEY,
    S: process.env.KOLM_TEACHER_SOURCE,
  };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Mix of proprietary (anthropic prefix) + open-weights (qwen2.5).
    process.env.KOLM_DISTILL_TEACHER = 'anthropic:claude-opus-4-7,qwen2.5-7b';
    process.env.KOLM_TEACHER_SOURCE = 'open-weights';
    const { _pickTeachers } = await freshImport('e');
    const list = _pickTeachers();
    assert.deepEqual(list, ['qwen2.5-7b'],
      'policy filter must strip claude-opus-4-7 and keep qwen2.5-7b');
  } finally {
    if (saved.K === undefined) delete process.env.KOLM_DISTILL_TEACHER; else process.env.KOLM_DISTILL_TEACHER = saved.K;
    if (saved.A === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.A;
    if (saved.O === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.O;
    if (saved.S === undefined) delete process.env.KOLM_TEACHER_SOURCE; else process.env.KOLM_TEACHER_SOURCE = saved.S;
  }
});

// =============================================================================
// 3) End-to-end: distill() stamps teacher_source + policy_enforced onto
// run-meta.json and the worker manifest so the .kolm receipt chain carries
// the policy enum.
// =============================================================================

test('W708 #6 — distill() stamps teacher_source + policy_enforced on run-meta and manifest', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w708-'));
  const saved = {
    H: process.env.HOME,
    U: process.env.USERPROFILE,
    D: process.env.KOLM_DATA_DIR,
    K: process.env.KOLM_DISTILL_TEACHER,
    A: process.env.ANTHROPIC_API_KEY,
    O: process.env.OPENAI_API_KEY,
    S: process.env.KOLM_TEACHER_SOURCE,
  };
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  process.env.KOLM_DATA_DIR = path.join(tmpdir, '.kolm');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.KOLM_DISTILL_TEACHER = 'qwen2.5-7b';
  process.env.KOLM_TEACHER_SOURCE = 'open-weights';
  try {
    const workerCmd = writeAlwaysOkWorker(tmpdir);
    const { distill } = await freshImport('f');
    const iter = distill({
      teacher_namespace: null,
      student_base: 'phi-3-mini',
      pairs_override: [
        { event_id: 'e1', prompt: 'hi', response: 'hello' },
      ],
      max_steps: 2,
      worker_cmd: workerCmd,
      tenant_id: 'tenant-w708',
    });
    let done = null;
    for await (const e of iter) {
      if (e && e.done) done = e;
    }
    assert.ok(done, 'iterator must yield a done envelope');
    assert.equal(done.teacher_source, 'open-weights',
      'done envelope must surface teacher_source classification');
    assert.equal(done.policy_enforced, true,
      'done envelope must report policy_enforced=true when env set');
    // Worker manifest was rewritten with the stamps.
    assert.ok(done.manifest, 'done envelope must carry the worker manifest');
    assert.equal(done.manifest.teacher_source, 'open-weights',
      'worker manifest must carry the teacher_source stamp');
    assert.equal(done.manifest.policy_enforced, true,
      'worker manifest must carry policy_enforced=true');
    // run-meta.json was written with the stamps.
    const runDir = done.artifact_path.replace(/[\\/]out$/, '');
    const metaPath = path.join(runDir, 'run-meta.json');
    assert.ok(fs.existsSync(metaPath), 'run-meta.json must exist');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.teacher_source, 'open-weights',
      'run-meta.json must carry teacher_source');
    assert.equal(meta.policy_enforced, true,
      'run-meta.json must carry policy_enforced=true');
  } finally {
    if (saved.H === undefined) delete process.env.HOME; else process.env.HOME = saved.H;
    if (saved.U === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.U;
    if (saved.D === undefined) delete process.env.KOLM_DATA_DIR; else process.env.KOLM_DATA_DIR = saved.D;
    if (saved.K === undefined) delete process.env.KOLM_DISTILL_TEACHER; else process.env.KOLM_DISTILL_TEACHER = saved.K;
    if (saved.A === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.A;
    if (saved.O === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.O;
    if (saved.S === undefined) delete process.env.KOLM_TEACHER_SOURCE; else process.env.KOLM_TEACHER_SOURCE = saved.S;
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

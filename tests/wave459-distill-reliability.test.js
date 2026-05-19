// W459 — distillation reliability: teacher fallback + partial-run resume.
//
// Closes the audit 2026-05-19 P1 Distillation cluster open item: a single
// teacher API failure (rate-limit, transient outage, revoked key) should not
// kill a compile run when a fallback teacher is wired. And a worker that
// crashed mid-iteration should be resumable from the run_<id> directory
// without re-writing seeds.jsonl or losing the progress.jsonl history.
//
// Contract this test pins:
//   - _pickTeachers() returns an ordered, deduplicated list.
//     KOLM_DISTILL_TEACHER may be comma-separated for explicit operator order.
//   - distill() with teacher_fallback=true rolls to the next teacher when the
//     worker exits non-zero OR writes a manifest with `teacher_error`.
//   - done envelope surfaces teacher_used + teacher_attempts[].
//   - resume_from=<run_id> reuses the prior runDir + appends to progress.jsonl
//     monotonically (step counter starts at the prior length).
//   - resume_from with a mismatched tenant throws (cross-tenant fence).
//   - resume_from with a malformed id throws (path traversal chokepoint).
//   - run-meta.json records teacher_planned (audit trail before any worker
//     has reported back).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// =============================================================================
// Helpers — stub workers expressed inline as small .mjs files written into a
// per-test tmpdir. The worker reads --out=<dir>, optionally checks
// KOLM_DISTILL_ATTEMPT, writes manifest.json, exits.
// =============================================================================

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
  job_id: process.env.KOLM_JOB_ID || null,
  finished_at: new Date().toISOString(),
}, null, 2));
process.exit(0);
`);
  return p;
}

function writeFailThenOkWorker(dir) {
  const p = path.join(dir, 'worker-fail-then-ok.mjs');
  fs.writeFileSync(p, `
import fs from 'node:fs';
import path from 'node:path';
const out = (process.argv.find(a => a.startsWith('--out=')) || '').slice(6);
fs.mkdirSync(out, { recursive: true });
const attempt = Number(process.env.KOLM_DISTILL_ATTEMPT || '1');
if (attempt === 1) {
  // Simulate a teacher rate-limit failure: write a manifest with teacher_error
  // (covers both the exit-clean-but-error and the unhealthy-manifest signal).
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
    teacher_error: { kind: 'rate_limit', vendor: 'anthropic', retry_after_s: 30 },
    finished_at: new Date().toISOString(),
  }, null, 2));
  process.exit(2);
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
  ok: true,
  attempt,
  finished_at: new Date().toISOString(),
}, null, 2));
process.exit(0);
`);
  return p;
}

function writeAlwaysFailWorker(dir) {
  const p = path.join(dir, 'worker-always-fail.mjs');
  fs.writeFileSync(p, `
import fs from 'node:fs';
import path from 'node:path';
const out = (process.argv.find(a => a.startsWith('--out=')) || '').slice(6);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
  teacher_error: { kind: 'auth_revoked', vendor: 'anthropic' },
  finished_at: new Date().toISOString(),
}, null, 2));
process.exit(3);
`);
  return p;
}

async function drain(iter) {
  const events = [];
  let done = null;
  for await (const e of iter) {
    if (e && e.done) { done = e; } else { events.push(e); }
  }
  return { events, done };
}

// =============================================================================
// 1) _pickTeachers ordering + dedup contract
// =============================================================================

test('W459 #1 — _pickTeachers returns ordered, deduplicated list', async () => {
  const saved = {
    K: process.env.KOLM_DISTILL_TEACHER,
    A: process.env.ANTHROPIC_API_KEY,
    O: process.env.OPENAI_API_KEY,
  };
  try {
    delete process.env.KOLM_DISTILL_TEACHER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { _pickTeachers } = await import('../src/distill-pipeline.js?w459a=' + Date.now());
    assert.deepEqual(_pickTeachers(), [], 'no env → empty list');

    process.env.ANTHROPIC_API_KEY = 'sk-anth';
    process.env.OPENAI_API_KEY = 'sk-openai';
    const { _pickTeachers: pick2 } = await import('../src/distill-pipeline.js?w459b=' + Date.now());
    const list2 = pick2();
    assert.equal(list2.length, 2, 'two keys → two teachers');
    assert.equal(list2[0], 'anthropic:claude-opus-4-7', 'anthropic first');
    assert.equal(list2[1], 'openai:gpt-4o-mini', 'openai second');

    // Explicit KOLM_DISTILL_TEACHER wins ordering and can be a comma list.
    process.env.KOLM_DISTILL_TEACHER = 'openai:gpt-4o-mini,anthropic:claude-opus-4-7';
    const { _pickTeachers: pick3 } = await import('../src/distill-pipeline.js?w459c=' + Date.now());
    const list3 = pick3();
    assert.deepEqual(list3, ['openai:gpt-4o-mini', 'anthropic:claude-opus-4-7'],
      'explicit comma list overrides default order + dedups against keys');
  } finally {
    if (saved.K === undefined) delete process.env.KOLM_DISTILL_TEACHER; else process.env.KOLM_DISTILL_TEACHER = saved.K;
    if (saved.A === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.A;
    if (saved.O === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.O;
  }
});

// =============================================================================
// 2) distill rolls to the second teacher when the first one's worker fails
// =============================================================================

test('W459 #2 — distill() retries with next teacher on worker_error', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w459-'));
  const home = tmpdir;
  const savedHome = process.env.HOME;
  const savedUser = process.env.USERPROFILE;
  const savedTeacher = process.env.KOLM_DISTILL_TEACHER;
  const savedAK = process.env.ANTHROPIC_API_KEY;
  const savedOK = process.env.OPENAI_API_KEY;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.KOLM_DISTILL_TEACHER = 'anthropic:claude-opus-4-7,openai:gpt-4o-mini';
  process.env.ANTHROPIC_API_KEY = 'sk-anth';
  process.env.OPENAI_API_KEY = 'sk-openai';
  try {
    const workerCmd = writeFailThenOkWorker(tmpdir);
    const { distill } = await import('../src/distill-pipeline.js?w459d=' + Date.now());
    const iter = distill({
      teacher_namespace: null,
      student_base: 'phi-3-mini',
      pairs_override: [
        { event_id: 'e1', prompt: 'hi', response: 'hello' },
        { event_id: 'e2', prompt: 'yo', response: 'sup' },
      ],
      max_steps: 4,
      worker_cmd: workerCmd,
      tenant_id: 'tenant-x',
    });
    const { done } = await drain(iter);
    assert.ok(done, 'iterator must yield a done envelope');
    assert.equal(done.teacher_used, 'openai:gpt-4o-mini',
      'after first teacher fails, the winner should be the second teacher');
    assert.equal(done.teacher, done.teacher_used,
      '`teacher` alias must mirror teacher_used for backward compat');
    assert.equal(done.teacher_attempts.length, 2, 'two attempts recorded');
    assert.equal(done.teacher_attempts[0].ok, false, 'first attempt ok=false');
    assert.equal(done.teacher_attempts[0].teacher_error.kind, 'rate_limit');
    assert.equal(done.teacher_attempts[1].ok, true, 'second attempt ok=true');
    assert.equal(done.teacher_attempts[1].teacher, 'openai:gpt-4o-mini');
    assert.equal(done.exit.code, 0, 'final exit reflects the winning attempt');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUser;
    if (savedTeacher === undefined) delete process.env.KOLM_DISTILL_TEACHER; else process.env.KOLM_DISTILL_TEACHER = savedTeacher;
    if (savedAK === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedAK;
    if (savedOK === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedOK;
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 3) Exhaustion path — all teachers fail, done envelope surfaces the chain
// =============================================================================

test('W459 #3 — exhausted attempts surface the failure chain', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w459-'));
  const savedHome = process.env.HOME;
  const savedUser = process.env.USERPROFILE;
  const savedTeacher = process.env.KOLM_DISTILL_TEACHER;
  const savedAK = process.env.ANTHROPIC_API_KEY;
  const savedOK = process.env.OPENAI_API_KEY;
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  process.env.KOLM_DISTILL_TEACHER = 'anthropic:opus,openai:mini';
  // Intentionally unset provider keys so the attempt list = the comma list
  // verbatim (no env-key bleed-through padding it to 4).
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const workerCmd = writeAlwaysFailWorker(tmpdir);
    const { distill } = await import('../src/distill-pipeline.js?w459e=' + Date.now());
    const iter = distill({
      teacher_namespace: null,
      student_base: 'phi-3-mini',
      pairs_override: [{ event_id: 'e1', prompt: 'a', response: 'b' }],
      max_steps: 2,
      worker_cmd: workerCmd,
      tenant_id: 'tenant-z',
    });
    const { done } = await drain(iter);
    assert.equal(done.teacher_used, null, 'no winner');
    assert.equal(done.teacher, null);
    assert.equal(done.teacher_attempts.length, 2, 'both planned teachers were tried');
    for (const a of done.teacher_attempts) {
      assert.equal(a.ok, false);
      assert.equal(a.teacher_error.kind, 'auth_revoked');
    }
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUser;
    if (savedTeacher === undefined) delete process.env.KOLM_DISTILL_TEACHER; else process.env.KOLM_DISTILL_TEACHER = savedTeacher;
    if (savedAK === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedAK;
    if (savedOK === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedOK;
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 4) teacher_fallback=false collapses the loop to one attempt
// =============================================================================

test('W459 #4 — teacher_fallback=false uses only the first teacher', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w459-'));
  const savedHome = process.env.HOME;
  const savedUser = process.env.USERPROFILE;
  const savedTeacher = process.env.KOLM_DISTILL_TEACHER;
  const savedAK = process.env.ANTHROPIC_API_KEY;
  const savedOK = process.env.OPENAI_API_KEY;
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  process.env.KOLM_DISTILL_TEACHER = 'anthropic:opus,openai:mini';
  process.env.ANTHROPIC_API_KEY = 'sk-anth';
  process.env.OPENAI_API_KEY = 'sk-openai';
  try {
    const workerCmd = writeAlwaysFailWorker(tmpdir);
    const { distill } = await import('../src/distill-pipeline.js?w459f=' + Date.now());
    const iter = distill({
      teacher_namespace: null,
      student_base: 'phi-3-mini',
      pairs_override: [{ event_id: 'e1', prompt: 'a', response: 'b' }],
      max_steps: 2,
      worker_cmd: workerCmd,
      tenant_id: 'tenant-q',
      teacher_fallback: false,
    });
    const { done } = await drain(iter);
    assert.equal(done.teacher_attempts.length, 1,
      'teacher_fallback=false → exactly one attempt (no retry)');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUser;
    if (savedTeacher === undefined) delete process.env.KOLM_DISTILL_TEACHER; else process.env.KOLM_DISTILL_TEACHER = savedTeacher;
    if (savedAK === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedAK;
    if (savedOK === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedOK;
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 5) resume_from — reuses runDir, appends progress, monotonic step counter
// =============================================================================

test('W459 #5 — resume_from reuses runDir and appends progress.jsonl', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w459-'));
  const savedHome = process.env.HOME;
  const savedUser = process.env.USERPROFILE;
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  try {
    const workerCmd = writeAlwaysOkWorker(tmpdir);
    const { distill } = await import('../src/distill-pipeline.js?w459g=' + Date.now());

    // First run — write progress + manifest.
    const iter1 = distill({
      teacher_namespace: null,
      student_base: 'phi-3-mini',
      pairs_override: [{ event_id: 'e1', prompt: 'a', response: 'b' }],
      max_steps: 3,
      worker_cmd: workerCmd,
      tenant_id: 'tenant-resume',
    });
    const { events: ev1, done: done1 } = await drain(iter1);
    assert.ok(done1.artifact_path.includes('run_'), 'first run wrote an artifact_path');
    const runDir = path.dirname(done1.artifact_path); // .../run_<id>/out → .../run_<id>
    const runId = path.basename(runDir);
    const progressBefore = fs.readFileSync(path.join(runDir, 'progress.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    assert.ok(progressBefore.length >= 1, 'first run produced progress rows');
    const lastStepBefore = JSON.parse(progressBefore[progressBefore.length - 1]).step;

    // Second run — resume.
    const iter2 = distill({
      teacher_namespace: null,
      student_base: 'phi-3-mini',
      pairs_override: [{ event_id: 'e1', prompt: 'a', response: 'b' }],
      max_steps: 3,
      worker_cmd: workerCmd,
      tenant_id: 'tenant-resume',
      resume_from: runId,
    });
    const { events: ev2, done: done2 } = await drain(iter2);
    assert.equal(done2.resumed_from, runId, 'done envelope echoes resumed_from');
    assert.equal(done2.resume_prior_steps, progressBefore.length,
      'resume_prior_steps reflects the prior progress.jsonl line count');
    assert.ok(done2.artifact_path.includes(runId),
      'artifact_path still points inside the resumed runDir');

    // Resume marker is yielded first.
    assert.ok(ev2.length > 0 && ev2[0].resume === true,
      'first event on a resumed run is the resume marker');

    // progress.jsonl now contains BOTH the prior rows AND the new ones.
    const progressAfter = fs.readFileSync(path.join(runDir, 'progress.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    assert.ok(progressAfter.length > progressBefore.length,
      'resume appends — never truncates — the existing progress.jsonl');
    // Step counter must be strictly monotonic across resume boundary.
    const lastStepAfter = JSON.parse(progressAfter[progressAfter.length - 1]).step;
    assert.ok(lastStepAfter > lastStepBefore,
      `resume step counter must advance past prior max (${lastStepBefore} → ${lastStepAfter})`);
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUser;
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 6) resume_from with a mismatched tenant throws (cross-tenant fence)
// =============================================================================

test('W459 #6 — resume_from with mismatched tenant throws', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w459-'));
  const savedHome = process.env.HOME;
  const savedUser = process.env.USERPROFILE;
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  try {
    // Seed an existing run owned by tenant-a.
    const runId = 'run_seed_for_mismatch';
    const runDir = path.join(tmpdir, '.kolm', 'distill-runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run-meta.json'), JSON.stringify({
      tenant_id: 'tenant-a', namespace: 'ns', student_base: 'phi-3-mini',
      pipeline_mode: 'kd_softmax', pair_count: 1, worker_mode: 'stub',
      teacher: null, teacher_planned: [], created_at: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(runDir, 'progress.jsonl'), '');
    fs.writeFileSync(path.join(runDir, 'spec.json'), '{}');
    fs.writeFileSync(path.join(runDir, 'seeds.jsonl'), '');

    const workerCmd = writeAlwaysOkWorker(tmpdir);
    const { distill } = await import('../src/distill-pipeline.js?w459h=' + Date.now());
    const iter = distill({
      teacher_namespace: null,
      student_base: 'phi-3-mini',
      pairs_override: [{ event_id: 'e1', prompt: 'a', response: 'b' }],
      max_steps: 1,
      worker_cmd: workerCmd,
      tenant_id: 'tenant-b',           // different tenant
      resume_from: runId,
    });
    await assert.rejects(drain(iter), /tenant mismatch/,
      'resuming a run owned by another tenant must throw — never silently rebind');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUser;
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 7) Malformed resume_from id throws (path-traversal chokepoint)
// =============================================================================

test('W459 #7 — malformed resume_from id throws', async () => {
  const { distill } = await import('../src/distill-pipeline.js?w459i=' + Date.now());
  // Empty string is treated as "no resume" by JS truthiness convention (same
  // as null/undefined) — only non-empty malformed ids must throw.
  for (const bad of ['../etc/passwd', 'run_../oops', 'plain_no_prefix', 'run_/escape']) {
    const iter = distill({
      teacher_namespace: null,
      student_base: 'phi-3-mini',
      pairs_override: [{ event_id: 'e1', prompt: 'a', response: 'b' }],
      max_steps: 1,
      resume_from: bad,
    });
    await assert.rejects(drain(iter), /resume_from/,
      `bad resume_from ${JSON.stringify(bad)} must be rejected at the chokepoint`);
  }
});

// =============================================================================
// 8) run-meta.json records teacher_planned (auditable before worker reports)
// =============================================================================

test('W459 #8 — run-meta.json records teacher_planned + first teacher', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w459-'));
  const savedHome = process.env.HOME;
  const savedUser = process.env.USERPROFILE;
  const savedTeacher = process.env.KOLM_DISTILL_TEACHER;
  const savedAK = process.env.ANTHROPIC_API_KEY;
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  process.env.KOLM_DISTILL_TEACHER = 'anthropic:opus,openai:mini';
  // Same as #3 — unset provider keys so the planned list reads back as the
  // comma list verbatim, not padded by the env-key defaults.
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const workerCmd = writeAlwaysOkWorker(tmpdir);
    const { distill } = await import('../src/distill-pipeline.js?w459j=' + Date.now());
    const iter = distill({
      teacher_namespace: null,
      student_base: 'phi-3-mini',
      pairs_override: [{ event_id: 'e1', prompt: 'a', response: 'b' }],
      max_steps: 1,
      worker_cmd: workerCmd,
      tenant_id: 'tenant-plan',
    });
    const { done } = await drain(iter);
    const runDir = path.dirname(done.artifact_path);
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'run-meta.json'), 'utf8'));
    assert.deepEqual(meta.teacher_planned, ['anthropic:opus', 'openai:mini'],
      'run-meta records the planned attempt list');
    assert.equal(meta.teacher, 'anthropic:opus', 'run-meta still records the first teacher for legacy readers');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUser;
    if (savedTeacher === undefined) delete process.env.KOLM_DISTILL_TEACHER; else process.env.KOLM_DISTILL_TEACHER = savedTeacher;
    if (savedAK === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedAK;
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});

// =============================================================================
// 9) Source pins — the worker spawn block lives inside an attempt loop
// =============================================================================

test('W459 #9 — distill-pipeline.js spawns inside an attempt loop with manifest fence', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'distill-pipeline.js'), 'utf8');
  assert.match(src, /for\s*\(\s*let\s+attemptIdx\b/,
    'worker spawn must iterate over attemptList by index');
  assert.match(src, /teacher_attempts\.push/,
    'every attempt is recorded into teacher_attempts');
  assert.match(src, /teacher_used\s*=\s*teacher;/,
    'a successful attempt sets teacher_used to the winning teacher');
  assert.match(src, /attemptIdx\s*>\s*0[\s\S]{0,80}unlinkSync\(manifestPath\)/,
    'retries must clear the prior attempt manifest before respawning');
  assert.match(src, /resume_from:[^,]+\|\|\s*null/,
    'run-meta records the resume_from field');
});

// =============================================================================
// 10) sw.js slug references wave459 family
// =============================================================================

test('W459 #10 — sw.js CACHE slug references the wave459 family', () => {
  const sw = fs.readFileSync(path.join(REPO_ROOT, 'public', 'sw.js'), 'utf8');
  // Family pattern: regex+threshold (never explicit-array). Any wave >= 459 counts.
  const wm = sw.match(/wave(\d{3,4})/);
  assert.ok(wm, 'sw.js CACHE must declare a waveNNN token');
  assert.ok(parseInt(wm[1], 10) >= 459,
    'sw.js CACHE must include wave459 or a successor in the family, got wave' + wm[1]);
});

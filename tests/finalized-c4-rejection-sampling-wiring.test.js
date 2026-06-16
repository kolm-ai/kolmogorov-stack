// FINALIZED-C4 - Rejection-sampling END-TO-END WIRING regression guards.
//
// The atom's module (selection/scoring/parity) was proven real by the C4 verify
// panel, but the panel ALSO found the atom was NOT wired end-to-end: the worker
// stamped distillation_method=rejection_sampling while actually running plain
// LoRA SFT, and the documented --rs-* flags were never forwarded. It also found a
// cross-language ledger_hash divergence on EMPTY candidate groups (JS 'deferred'
// vs Python 'reject'). These tests lock the fixes:
//   1. empty-candidate group -> 'reject' (n:0), byte-identical ledger_hash across
//      the JS selector and the Python trainer (the cross-language parity claim
//      must hold for this realistic case, not just non-empty groups);
//   2. the distill pipeline forwards --distillation-method=rejection_sampling +
//      every --rs-* knob to the worker (the documented flags are live, not dead).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { selectAcceptedSet } from '../src/distill-rejection-sampling.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const _repoRoot = path.resolve(__dirname, '..');

function _mkTmp(label = 'c4-rs-wire') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

// ---------------------------------------------------------------------------
// 1. Empty-candidate group: REJECT (n:0), and the JS<->Python ledger_hash match.
// ---------------------------------------------------------------------------
test('empty candidate group -> reject (n:0), not deferred', () => {
  const r = selectAcceptedSet([{ id: 'a', prompt: 'p', candidates: [] }], { family: 'kolm_verifier' });
  assert.equal(r.ledger.length, 1);
  assert.equal(r.ledger[0].decision, 'reject', 'empty group has nothing to accept AND nothing to defer -> reject');
  assert.equal(r.ledger[0].n, 0);
  assert.equal(r.ledger[0].best_score, null);
  assert.equal(r.stats.accepted, 0);
});

test('empty candidate group ledger_hash is byte-identical across JS and Python', () => {
  const groups = [{ id: 'a', prompt: 'p', candidates: [] }, { id: 'b', prompt: 'q', candidates: [] }];
  const js = selectAcceptedSet(groups.map((g) => ({ ...g })), { family: 'kolm_verifier' });

  // Reproduce the Python trainer's select-only path on the SAME input.
  const pyBin = (() => {
    for (const c of ['python', 'python3']) {
      const probe = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (probe.status === 0) return c;
    }
    return null;
  })();
  if (!pyBin) {
    // No interpreter on this box -> the cross-language assertion cannot run; the
    // sibling test above already locks the JS-side 'reject' (n:0) behavior, which
    // is the half of the parity fix that lives in JS. Assert the hash is at least
    // well-formed and skip the cross-check.
    assert.match(js.stats.ledger_hash, /^sha256:[0-9a-f]{64}$/);
    return;
  }
  const py = spawnSync(pyBin, ['-c', [
    'import sys, json',
    'sys.path.insert(0, ' + JSON.stringify(path.join(_repoRoot, 'apps', 'trainer')) + ')',
    'from reject_sample import select_accepted',
    'g = [{"id":"a","prompt":"p","candidates":[]},{"id":"b","prompt":"q","candidates":[]}]',
    'r = select_accepted(g, family="kolm_verifier")',
    'print(r["stats"]["ledger_hash"])',
  ].join('\n')], { encoding: 'utf8' });
  assert.equal(py.status, 0, 'python select_accepted must run: ' + (py.stderr || ''));
  const pyHash = (py.stdout || '').trim();
  assert.equal(js.stats.ledger_hash, pyHash,
    `JS ledger_hash (${js.stats.ledger_hash}) must equal Python (${pyHash}) on empty groups`);
});

// ---------------------------------------------------------------------------
// 2. The distill pipeline forwards the method + every --rs-* knob to the worker.
//    A stub worker captures process.argv; we assert the documented flags arrive.
// ---------------------------------------------------------------------------
function _argvCapturingStub(tmp) {
  const stubPath = path.join(tmp, 'argv-stub.mjs');
  fs.writeFileSync(stubPath, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "let out = null;",
    "for (const a of args) { if (a.startsWith('--out=')) out = a.slice(6); }",
    "if (out) {",
    "  try { fs.mkdirSync(out, { recursive: true }); } catch {}",
    "  try { fs.writeFileSync(path.join(out, 'worker-argv.json'), JSON.stringify(args)); } catch {}",
    "  try { fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ mode: 'stub', ok: true })); } catch {}",
    "}",
    "process.exit(0);",
    '',
  ].join('\n'));
  return stubPath;
}

function _readLatestArgv(tmp) {
  const root = path.join(tmp, 'distill-runs');
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root)
    .map((d) => ({ full: path.join(root, d), stat: fs.statSync(path.join(root, d)) }))
    .filter((e) => e.stat.isDirectory())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  for (const d of dirs) {
    // the worker's --out is the run's `out/` subdir; the stub writes argv there.
    for (const p of [path.join(d.full, 'out', 'worker-argv.json'), path.join(d.full, 'worker-argv.json')]) {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  return null;
}

test('distill pipeline forwards --distillation-method=rejection_sampling + every --rs-* knob', async () => {
  const tmp = _mkTmp('c4-rs-fwd');
  const saved = {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR, HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE, KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  try {
    process.env.KOLM_DATA_DIR = tmp;
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.KOLM_STORE_DRIVER = 'jsonl';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const stub = _argvCapturingStub(tmp);
    const { distill } = await import('../src/distill-pipeline.js');

    const injected = Array.from({ length: 4 }, (_, i) => ({
      prompt: 'rs-prompt-' + i, response: 'rs-response-' + i,
      event_id: 'evt_rs_' + i, source_type: 'capture', tenant_id: 'rs-tenant',
      approved: true, redaction_policy: 'phi-v1', holdout_only: false,
    }));

    const iter = distill({
      teacher_namespace: null,
      student_base: 'phi-mini',
      pairs_override: injected,
      max_steps: 4,
      emit_progress_every: 0,
      worker_cmd: stub,
      pipeline_mode: 'rejection_sampling',
      rs: { n: 6, temperature: 0.9, threshold: 0.7, threshold_mode: 'threshold', reward: 'math_checker' },
    });
    // Drive far enough to spawn the stub, then dispose.
    const nextP = iter.next();
    await new Promise((r) => setTimeout(r, 120));
    if (typeof iter.return === 'function') {
      try { await Promise.race([iter.return(), new Promise((r) => setTimeout(r, 200))]); } catch {}
    }
    try { await Promise.race([nextP, new Promise((r) => setTimeout(r, 200))]); } catch {}

    const argv = _readLatestArgv(tmp);
    assert.ok(argv, 'stub worker must have captured argv');
    assert.ok(argv.includes('--distillation-method=rejection_sampling'),
      'method must be forwarded: ' + JSON.stringify(argv));
    assert.ok(argv.includes('--rs-n=6'), '--rs-n forwarded');
    assert.ok(argv.includes('--rs-temperature=0.9'), '--rs-temperature forwarded');
    assert.ok(argv.includes('--rs-threshold=0.7'), '--rs-threshold forwarded');
    assert.ok(argv.includes('--rs-threshold-mode=threshold'), '--rs-threshold-mode forwarded');
    assert.ok(argv.includes('--rs-reward=math_checker'), '--rs-reward forwarded');
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

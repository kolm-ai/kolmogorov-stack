// FINALIZED-C4 - RLVR/GRPO frontier END-TO-END WIRING regression guards.
//
// The C4 deep-dive found the frontier path (DAPO/GSPO/vLLM) was ORPHANED: the JS
// builders emit --loss-type dapo / --dynamic-sampling / --use-vllm / etc., but
// train_grpo.py's argparse REJECTED every one of them (exit 2), no CLI caller
// passed `frontier`, and the fail-closed run-meta gate was unreachable because the
// trainer never wrote RUN_META_SCHEMA. These tests lock the fix: train_grpo.py
// accepts the flags, emits the GPU-free engaged map (read back from the REAL trl
// config, so a knob the installed trl drops is recorded applied=false not claimed),
// and a plain GRPO run stays byte-compatible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRAINER = path.resolve(__dirname, '..', 'workers', 'distill', 'scripts', 'train_grpo.py');

function _pyBin() {
  for (const c of ['python', 'python3']) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

function _preflight(extraArgs) {
  const py = _pyBin();
  if (!py) return { skipped: true };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-grpo-wire-'));
  fs.writeFileSync(path.join(d, 'p.jsonl'), JSON.stringify({ prompt: '2+2=' }) + '\n');
  const r = spawnSync(py, [
    TRAINER, '--prompts', path.join(d, 'p.jsonl'), '--student', 'gpt2',
    '--out', path.join(d, 'out'), '--reward', 'kolm_verifier', '--preflight-only',
    ...extraArgs,
  ], { encoding: 'utf8' });
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  // stdout may be preceded by torch warnings on some boxes; take the last JSON line.
  const line = (r.stdout || '').trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
  let json = null;
  try { json = line ? JSON.parse(line) : null; } catch {}
  return { status: r.status, json, stderr: r.stderr };
}

test('train_grpo.py ACCEPTS the frontier flags it used to reject with exit 2', () => {
  const r = _preflight([
    '--loss-type', 'dapo', '--dynamic-sampling', '--use-vllm', '--epsilon-high', '0.28',
    '--importance-sampling-level', 'sequence', '--mask-truncated-completions',
    '--overlong-reward-shaping', '--record-run-meta',
  ]);
  if (r.skipped) return;
  assert.equal(r.status, 0, 'frontier flags must no longer crash the trainer (was exit 2): ' + (r.stderr || '').slice(-300));
  assert.ok(r.json && r.json.ok, 'preflight must emit ok JSON');
  assert.equal(r.json.loss_type, 'dapo');
});

test('train_grpo.py preflight emits the engaged map (read back from real trl, not fabricated)', () => {
  const r = _preflight(['--loss-type', 'dapo', '--importance-sampling-level', 'sequence', '--epsilon-high', '0.28']);
  if (r.skipped) return;
  assert.equal(r.status, 0);
  const fp = r.json && r.json.frontier_preflight;
  assert.ok(fp, 'frontier_preflight engaged map must be present');
  assert.ok(typeof fp.trl_installed === 'boolean', 'must report whether trl is installed');
  const eng = fp.engaged || {};
  assert.ok(eng.loss_type, 'engaged map must include loss_type');
  // The map must REFLECT reality: each knob carries applied + reason (read back),
  // never a bare claim. When trl is installed the reason is read_back_from_trl_config;
  // when absent, applied=false reason=trl_not_installed (fail-closed, not over-claimed).
  for (const k of Object.keys(eng)) {
    assert.ok('applied' in eng[k] && 'reason' in eng[k],
      `engaged.${k} must carry applied+reason (provenance, not a bare claim)`);
    if (fp.trl_installed === false) assert.equal(eng[k].applied, false, `trl absent -> ${k} must not be claimed applied`);
  }
});

test('plain GRPO preflight is byte-compatible (no frontier_preflight key)', () => {
  const r = _preflight([]); // no frontier knobs
  if (r.skipped) return;
  assert.equal(r.status, 0);
  assert.ok(r.json && r.json.ok);
  assert.equal('frontier_preflight' in r.json, false,
    'a non-frontier run must NOT carry the frontier engaged map (default unchanged)');
});

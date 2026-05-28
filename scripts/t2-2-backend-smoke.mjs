#!/usr/bin/env node
// scripts/t2-2-backend-smoke.mjs
//
// T2.2 smoke test — verifies Unsloth conditional swap WITHOUT requiring Unsloth
// to be installed locally. Strategy: hit train_lora.py with a tiny Python probe
// that imports its module-level helpers (_select_backend, _is_unsloth_supported,
// _unsloth_importable, UNSLOTH_FAMILIES) and asserts the dispatch matrix.
//
//   1. _is_unsloth_supported() — every supported family slug passes; non-family bases reject
//   2. _select_backend('hf', any_base) -> ('hf', 'requested_hf')
//   3. _select_backend('auto', supported_base) -> ('unsloth', 'auto_family_match') iff unsloth importable,
//      else ('hf', 'auto_family_match_but_unsloth_not_installed')
//   4. _select_backend('auto', unsupported_base) -> ('hf', 'auto_family_unsupported')
//   5. _select_backend('unsloth', any_base) -> ('unsloth', 'requested_unsloth') iff importable,
//      else exit code 11 (sys.exit fires)
//   6. distill.mjs passThrough list contains 'backend' and 'neftune-noise-alpha' keys
//   7. train_lora.py --preflight-only reports unsloth_importable boolean + UNSLOTH_FAMILIES list
//   8. The Unsloth mirror file exists and parses as valid Python (compile check)
//   9. NEFTune kwarg lands in HF Trainer ta_kwargs when --neftune-noise-alpha > 0
//      (probe via static-grep — the runtime test requires actual training)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const _here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(_here, '..');
const TRAIN_LORA = path.join(REPO, 'workers', 'distill', 'scripts', 'train_lora.py');
const TRAIN_LORA_UNSLOTH = path.join(REPO, 'workers', 'distill', 'scripts', 'train_lora_unsloth.py');
const DISTILL_MJS = path.join(REPO, 'workers', 'distill', 'distill.mjs');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ok   ${label}`); }
function bad(label, detail) { fail++; console.log(`  FAIL ${label}: ${detail}`); }
function assert(cond, label, detail = '') {
  if (cond) ok(label); else bad(label, detail || 'condition false');
}

console.log('T2.2 — Unsloth conditional swap + NEFTune smoke');

// Pick a Python interpreter. Prefer `python3` on POSIX, `python` on Windows.
function findPython() {
  for (const cand of ['python3', 'python']) {
    const r = spawnSync(cand, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.trim() === '3') return cand;
  }
  return null;
}
const PY = findPython();
if (!PY) {
  console.log('  SKIP (no python3 in PATH)');
  process.exit(0);
}

// --- 1-5. _select_backend dispatch matrix --------------------------------
// Drive the matrix via a one-off Python probe that imports train_lora as a
// module. We add the script's dir to sys.path so `from _console import ...`
// resolves (every train_lora.py invocation needs the UTF-8 shim).
const probe = `
import sys, os, json
HERE = r"${path.join(REPO, 'workers', 'distill', 'scripts').replace(/\\/g, '\\\\')}"
sys.path.insert(0, HERE)
# Block stdout side-effect of train_lora.main() — we only want module load.
sys.argv = ['probe']
import importlib.util as _ilu
spec = _ilu.spec_from_file_location('train_lora_probe', os.path.join(HERE, 'train_lora.py'))
mod = _ilu.module_from_spec(spec)
spec.loader.exec_module(mod)
out = {
  "families": list(mod.UNSLOTH_FAMILIES),
  "qwen25_supported": mod._is_unsloth_supported("Qwen/Qwen2.5-7B-Instruct"),
  "llama3_supported": mod._is_unsloth_supported("meta-llama/Llama-3-8B"),
  "random_supported": mod._is_unsloth_supported("microsoft/DialoGPT-medium"),
  "empty_supported": mod._is_unsloth_supported(""),
  "unsloth_importable": mod._unsloth_importable(),
  "select_hf": list(mod._select_backend("hf", "Qwen/Qwen2.5-7B-Instruct")),
  "select_auto_supported": list(mod._select_backend("auto", "Qwen/Qwen2.5-7B-Instruct")),
  "select_auto_unsupported": list(mod._select_backend("auto", "microsoft/DialoGPT-medium")),
}
print(json.dumps(out))
`;
const r1 = spawnSync(PY, ['-c', probe], { encoding: 'utf-8' });
if (r1.status !== 0) {
  bad('1-5: probe ran', `status=${r1.status} stderr=${(r1.stderr || '').slice(0, 500)}`);
} else {
  let probeOut = null;
  try { probeOut = JSON.parse(r1.stdout.trim()); } catch (e) {
    bad('1-5: probe JSON parses', e.message + ' stdout=' + r1.stdout.slice(0, 200));
  }
  if (probeOut) {
    assert(Array.isArray(probeOut.families) && probeOut.families.length >= 8,
      '1: UNSLOTH_FAMILIES is populated (≥8 family prefixes)',
      `got ${probeOut.families?.length} families`);
    assert(probeOut.qwen25_supported === true,
      '1: Qwen2.5 supported');
    assert(probeOut.llama3_supported === true,
      '1: Llama-3 supported');
    assert(probeOut.random_supported === false,
      '1: random base (DialoGPT) NOT in family');
    assert(probeOut.empty_supported === false,
      '1: empty student_base rejected');

    assert(probeOut.select_hf[0] === 'hf' && probeOut.select_hf[1] === 'requested_hf',
      '2: --backend=hf -> (hf, requested_hf)',
      `got ${JSON.stringify(probeOut.select_hf)}`);

    if (probeOut.unsloth_importable) {
      assert(probeOut.select_auto_supported[0] === 'unsloth'
          && probeOut.select_auto_supported[1] === 'auto_family_match',
        '3: --backend=auto + supported + import OK -> (unsloth, auto_family_match)',
        `got ${JSON.stringify(probeOut.select_auto_supported)}`);
    } else {
      assert(probeOut.select_auto_supported[0] === 'hf'
          && probeOut.select_auto_supported[1] === 'auto_family_match_but_unsloth_not_installed',
        '3: --backend=auto + supported + no unsloth -> (hf, auto_family_match_but_unsloth_not_installed)',
        `got ${JSON.stringify(probeOut.select_auto_supported)}`);
    }

    assert(probeOut.select_auto_unsupported[0] === 'hf'
        && probeOut.select_auto_unsupported[1] === 'auto_family_unsupported',
      '4: --backend=auto + unsupported -> (hf, auto_family_unsupported)',
      `got ${JSON.stringify(probeOut.select_auto_unsupported)}`);
  }

  // 5: --backend=unsloth with no unsloth must hard-exit (code 11). Skip if
  // unsloth IS importable — that's a successful selection, not the error path.
  const probe5 = `
import sys, os
HERE = r"${path.join(REPO, 'workers', 'distill', 'scripts').replace(/\\/g, '\\\\')}"
sys.path.insert(0, HERE)
sys.argv = ['probe']
import importlib.util as _ilu
spec = _ilu.spec_from_file_location('train_lora_probe5', os.path.join(HERE, 'train_lora.py'))
mod = _ilu.module_from_spec(spec)
spec.loader.exec_module(mod)
if mod._unsloth_importable():
    print("UNSLOTH_PRESENT")
    sys.exit(0)
mod._select_backend("unsloth", "Qwen/Qwen2.5-7B-Instruct")  # must sys.exit(11)
print("DID_NOT_EXIT")
`;
  const r5 = spawnSync(PY, ['-c', probe5], { encoding: 'utf-8' });
  if ((r5.stdout || '').includes('UNSLOTH_PRESENT')) {
    ok('5: --backend=unsloth + import OK -> no hard-exit (Unsloth is installed)');
  } else {
    assert(r5.status === 11,
      '5: --backend=unsloth + no unsloth -> exit code 11',
      `status=${r5.status} stdout=${r5.stdout?.slice(0, 200)} stderr=${r5.stderr?.slice(0, 200)}`);
    assert(/install hint:.*unsloth/i.test(r5.stderr || ''),
      '5: stderr contains install hint',
      r5.stderr?.slice(0, 200));
  }
}

// --- 6. distill.mjs passThrough wiring ----------------------------------
const distillSrc = fs.readFileSync(DISTILL_MJS, 'utf-8');
assert(/\['backend',\s+spec\.backend\]/.test(distillSrc),
  '6: distill.mjs threads spec.backend -> --backend');
assert(/\['neftune-noise-alpha',\s+spec\.neftune_noise_alpha\]/.test(distillSrc),
  '6: distill.mjs threads spec.neftune_noise_alpha -> --neftune-noise-alpha');

// --- 7. Preflight surfaces Unsloth status -------------------------------
// The preflight is fully self-contained (it imports torch et al.) — only run
// it if torch is actually installed; otherwise the file-level _require would
// exit 3 and skew the test. We use a guarded import-check first.
const torchCheck = spawnSync(PY, ['-c', 'import torch; print("ok")'], { encoding: 'utf-8' });
if (torchCheck.status !== 0) {
  console.log('  SKIP 7: torch not installed; preflight requires torch');
} else {
  const r7 = spawnSync(PY, [TRAIN_LORA, '--preflight-only'], { encoding: 'utf-8' });
  // exit 0 (all green) or 10 (some checks failed but JSON still printed)
  assert(r7.status === 0 || r7.status === 10,
    '7: preflight exits 0 or 10', `status=${r7.status}`);
  let report = null;
  try { report = JSON.parse(r7.stdout || '{}'); } catch { /* leave null */ }
  assert(report && typeof report.checks?.unsloth_importable === 'boolean',
    '7: preflight reports unsloth_importable boolean',
    `got ${JSON.stringify(report?.checks?.unsloth_importable)}`);
  if (report?.checks?.unsloth_importable) {
    assert(Array.isArray(report.checks.unsloth_families) && report.checks.unsloth_families.length >= 8,
      '7: preflight reports unsloth_families list when importable');
  } else {
    assert(typeof report?.checks?.unsloth_skip_reason === 'string',
      '7: preflight reports unsloth_skip_reason when not importable');
  }
}

// --- 8. Unsloth mirror is valid Python ---------------------------------
assert(fs.existsSync(TRAIN_LORA_UNSLOTH),
  '8: train_lora_unsloth.py mirror exists');
const r8 = spawnSync(PY, ['-c', `import py_compile; py_compile.compile(r"${TRAIN_LORA_UNSLOTH.replace(/\\/g, '\\\\')}", doraise=True)`],
  { encoding: 'utf-8' });
assert(r8.status === 0,
  '8: train_lora_unsloth.py compiles cleanly',
  `status=${r8.status} stderr=${(r8.stderr || '').slice(0, 400)}`);

// --- 9. NEFTune kwarg wiring (static check) -----------------------------
const trainSrc = fs.readFileSync(TRAIN_LORA, 'utf-8');
assert(/ta_kwargs\["neftune_noise_alpha"\]\s*=\s*float\(args\.neftune_noise_alpha\)/.test(trainSrc),
  '9: train_lora.py wires --neftune-noise-alpha into TrainingArguments');
const unsSrc = fs.readFileSync(TRAIN_LORA_UNSLOTH, 'utf-8');
assert(/peft_kwargs\["neftune_noise_alpha"\]\s*=\s*float\(args\.neftune_noise_alpha\)/.test(unsSrc),
  '9: train_lora_unsloth.py wires --neftune-noise-alpha into get_peft_model kwargs');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

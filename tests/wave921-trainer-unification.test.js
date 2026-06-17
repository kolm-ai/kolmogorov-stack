// W921 — trainer-stack verification gate. Confirms the Python trainer scripts
// PARSE and their GPU-free dry-run/preflight paths succeed, so the shipping
// worker contract holds without a GPU. Skips gracefully when python is absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function pythonAvailable() {
  try { return spawnSync(PY, ['--version'], { stdio: 'pipe', timeout: 20000 }).status === 0; }
  catch { return false; }
}
const HAVE_PY = pythonAvailable();

function astParse(rel) {
  const abs = path.join(repoRoot, rel);
  const r = spawnSync(PY, ['-c', `import ast,sys; ast.parse(open(r'${abs}',encoding='utf-8').read()); print('ok')`], { stdio: 'pipe', timeout: 30000 });
  return r.status === 0 && /ok/.test((r.stdout || '').toString());
}

const PY_FILES = [
  'workers/distill/scripts/train_lora.py',
  'workers/distill/scripts/train_lora_unsloth.py',
  'workers/distill/scripts/lora_variants.py',
  'workers/distill/scripts/train_grpo.py',
  'workers/distill/scripts/train_gkd.py',
  'workers/distill/scripts/train_preference.py',
  'workers/distill/scripts/merge_adapters.py',
  'apps/trainer/distill.py',
  'apps/trainer/merge.py',
  'apps/trainer/grpo.py',
  'apps/trainer/test_distillm2_loss.py',
];

test('all touched Python files parse (syntax)', { skip: !HAVE_PY }, () => {
  for (const f of PY_FILES) {
    assert.ok(fs.existsSync(path.join(repoRoot, f)), `${f} exists`);
    assert.ok(astParse(f), `${f} parses`);
  }
});

test('requirements.txt shipped (closes audit fail)', () => {
  const req = path.join(repoRoot, 'workers/distill/requirements.txt');
  assert.ok(fs.existsSync(req), 'workers/distill/requirements.txt must exist');
  const txt = fs.readFileSync(req, 'utf8');
  assert.match(txt, /peft/);
  assert.match(txt, /trl/);
});

test('train_lora.py --help succeeds (GPU-free)', { skip: !HAVE_PY }, () => {
  const r = spawnSync(PY, [path.join(repoRoot, 'workers/distill/scripts/train_lora.py'), '--help'], { stdio: 'pipe', timeout: 60000 });
  assert.equal(r.status, 0);
  assert.match((r.stdout || '').toString(), /--preflight-only/);
  assert.match((r.stdout || '').toString(), /--backend/);
});

test('train_lora.py backend selector helpers are GPU-free', { skip: !HAVE_PY }, () => {
  const scriptDir = path.join(repoRoot, 'workers/distill/scripts');
  const probe = `
import importlib.util, json, os, sys
here = ${JSON.stringify(scriptDir)}
sys.path.insert(0, here)
spec = importlib.util.spec_from_file_location("train_lora_probe", os.path.join(here, "train_lora.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
out = {
  "families": list(mod.UNSLOTH_FAMILIES),
  "qwen_supported": mod._is_unsloth_supported("Qwen/Qwen2.5-7B-Instruct"),
  "llama_supported": mod._is_unsloth_supported("meta-llama/Llama-3.2-3B-Instruct"),
  "unsupported": mod._is_unsloth_supported("microsoft/DialoGPT-medium"),
  "unsloth_importable": mod._unsloth_importable(),
  "hf": list(mod._select_backend("hf", "Qwen/Qwen2.5-7B-Instruct")),
  "auto_unsupported": list(mod._select_backend("auto", "microsoft/DialoGPT-medium")),
  "auto_supported": list(mod._select_backend("auto", "Qwen/Qwen2.5-7B-Instruct")),
}
print(json.dumps(out))
`;
  const r = spawnSync(PY, ['-c', probe], { stdio: 'pipe', timeout: 60000 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  const got = JSON.parse((r.stdout || '').toString());
  assert.ok(got.families.length >= 5);
  assert.equal(got.qwen_supported, true);
  assert.equal(got.llama_supported, true);
  assert.equal(got.unsupported, false);
  assert.deepEqual(got.hf, ['hf', 'requested_hf']);
  assert.deepEqual(got.auto_unsupported, ['hf', 'auto_family_unsupported']);
  if (got.unsloth_importable) {
    assert.deepEqual(got.auto_supported, ['unsloth', 'auto_family_match']);
  } else {
    assert.deepEqual(got.auto_supported, ['hf', 'auto_family_match_but_unsloth_not_installed']);
    const forced = `
import importlib.util, os, sys
here = ${JSON.stringify(scriptDir)}
sys.path.insert(0, here)
spec = importlib.util.spec_from_file_location("train_lora_probe_forced", os.path.join(here, "train_lora.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod._select_backend("unsloth", "Qwen/Qwen2.5-7B-Instruct")
`;
    const rf = spawnSync(PY, ['-c', forced], { stdio: 'pipe', timeout: 60000 });
    assert.equal(rf.status, 11);
    assert.match((rf.stderr || '').toString(), /install hint: pip install unsloth/);
  }
});

test('train_lora.py --preflight-only (default + dora) GPU-free', { skip: !HAVE_PY }, () => {
  const pairs = path.join(os.tmpdir(), 'kolm-tu-pairs-' + Date.now() + '.jsonl');
  fs.writeFileSync(pairs, '{"input":"hi","teacher_output":"hello"}\n');
  const out = path.join(os.tmpdir(), 'kolm-tu-out-' + Date.now());
  const script = path.join(repoRoot, 'workers/distill/scripts/train_lora.py');
  const def = spawnSync(PY, [script, '--pairs', pairs, '--out', out, '--preflight-only'], { stdio: 'pipe', timeout: 60000 });
  assert.equal(def.status, 0, (def.stderr || '').toString());
  const defJson = JSON.parse((def.stdout || '').toString());
  assert.equal(defJson.ok, true);
  assert.ok(['hf', 'unsloth'].includes(defJson.backend.selected));
  assert.equal(typeof defJson.checks.unsloth_importable, 'boolean');
  const forcedHf = spawnSync(PY, [script, '--backend', 'hf', '--preflight-only'], { stdio: 'pipe', timeout: 60000 });
  assert.equal(forcedHf.status, 0, (forcedHf.stderr || '').toString());
  assert.equal(JSON.parse((forcedHf.stdout || '').toString()).backend.selected, 'hf');
  const dora = spawnSync(PY, [script, '--pairs', pairs, '--out', out, '--preflight-only'], {
    stdio: 'pipe', timeout: 60000, env: { ...process.env, KOLM_LORA_VARIANT: 'dora', KOLM_NEFTUNE_ALPHA: '5' },
  });
  assert.equal(dora.status, 0);
  const doraJson = JSON.parse((dora.stdout || '').toString());
  assert.equal(doraJson.config.lora_variant, 'dora');
  assert.equal(doraJson.backend.selected, 'hf');
});

test('W616 trainer backend wiring spans recipe, CLI, worker, and mirror', () => {
  const train = fs.readFileSync(path.join(repoRoot, 'workers/distill/scripts/train_lora.py'), 'utf8');
  assert.match(train, /UNSLOTH_FAMILIES/);
  assert.match(train, /def _exec_unsloth_backend/);
  assert.match(train, /_exec_unsloth_backend\(args, backend_plan\["reason"\]/);
  const worker = fs.readFileSync(path.join(repoRoot, 'workers/distill/distill.mjs'), 'utf8');
  assert.match(worker, /spec\.train\.backend/);
  assert.match(worker, /pyArgs\.push\('--backend'/);
  const cli = fs.readFileSync(path.join(repoRoot, 'cli/kolm.js'), 'utf8');
  assert.match(cli, /const trainerBackend = pick\('--backend'\)/);
  assert.match(cli, /--backend=\$\{trainerBackend\}/);
  const loader = fs.readFileSync(path.join(repoRoot, 'src/distill-recipe-loader.js'), 'utf8');
  assert.match(loader, /VALID_TRAIN_BACKENDS/);
  assert.match(loader, /train\.backend must be one of/);
});

test('train_grpo.py + train_gkd.py + train_preference.py preflights GPU-free', { skip: !HAVE_PY }, () => {
  // GRPO
  const gp = path.join(os.tmpdir(), 'kolm-tu-grpo-' + Date.now() + '.jsonl');
  fs.writeFileSync(gp, '{"prompt":"add","tests":["assert True"]}\n');
  const grpo = spawnSync(PY, [path.join(repoRoot, 'workers/distill/scripts/train_grpo.py'),
    '--prompts', gp, '--student', '/x', '--out', path.join(os.tmpdir(), 'g' + Date.now()),
    '--reward', 'code_exec,format', '--preflight-only'], { stdio: 'pipe', timeout: 60000 });
  assert.equal(grpo.status, 0, (grpo.stderr || '').toString());
  assert.match((grpo.stdout || '').toString(), /"ok": true/);
  // GKD
  const kp = path.join(os.tmpdir(), 'kolm-tu-gkd-' + Date.now() + '.jsonl');
  fs.writeFileSync(kp, '{"prompt":"hi"}\n');
  const gkd = spawnSync(PY, [path.join(repoRoot, 'workers/distill/scripts/train_gkd.py'),
    '--prompts', kp, '--student', '/s', '--teacher', '/t', '--out', path.join(os.tmpdir(), 'k' + Date.now()),
    '--beta', '0.5', '--lmbda', '0.5', '--preflight-only'], { stdio: 'pipe', timeout: 60000 });
  assert.equal(gkd.status, 0, (gkd.stderr || '').toString());
  assert.match((gkd.stdout || '').toString(), /"objective": "gkd"/);
  // preference
  const pp = path.join(os.tmpdir(), 'kolm-tu-pref-' + Date.now() + '.jsonl');
  fs.writeFileSync(pp, '{"prompt":"P","chosen":"good","rejected":"bad"}\n');
  const pref = spawnSync(PY, [path.join(repoRoot, 'workers/distill/scripts/train_preference.py'),
    '--pairs', pp, '--student', '/s', '--out', path.join(os.tmpdir(), 'p' + Date.now()),
    '--objective', 'simpo', '--preflight-only'], { stdio: 'pipe', timeout: 60000 });
  assert.equal(pref.status, 0, (pref.stderr || '').toString());
  assert.match((pref.stdout || '').toString(), /"objective": "simpo"/);
});

test('distillm2 python unit tests pass', { skip: !HAVE_PY }, () => {
  const r = spawnSync(PY, [path.join(repoRoot, 'apps/trainer/test_distillm2_loss.py')], { stdio: 'pipe', timeout: 120000 });
  const out = (r.stdout || '').toString();
  assert.equal(r.status, 0, (r.stderr || '').toString().slice(-1500) + '\n' + out.slice(-1500));
  assert.match(out, /passed/);
  assert.ok(!/FAIL/.test(out), out);
});

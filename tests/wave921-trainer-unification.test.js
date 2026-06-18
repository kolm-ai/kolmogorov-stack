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
  assert.match((r.stdout || '').toString(), /--holdout/);
  const u = spawnSync(PY, [path.join(repoRoot, 'workers/distill/scripts/train_lora_unsloth.py'), '--help'], { stdio: 'pipe', timeout: 60000 });
  assert.equal(u.status, 0);
  assert.match((u.stdout || '').toString(), /--holdout/);
});

test('W961 train_lora.py loads eval-only holdout rows GPU-free', { skip: !HAVE_PY }, () => {
  const scriptDir = path.join(repoRoot, 'workers/distill/scripts');
  const holdout = path.join(os.tmpdir(), 'kolm-tu-holdout-' + Date.now() + '.jsonl');
  fs.writeFileSync(holdout, [
    JSON.stringify({ id: 'a', input: 'A', output: 'OA' }),
    JSON.stringify({ id: 'b', input: 'B', expected: 'EB' }),
    JSON.stringify({ event_id: 'c', input: 'C', teacher_output: 'TC' }),
    JSON.stringify({ input: 'D' }),
    'not-json',
  ].join('\n') + '\n');
  const probe = `
import importlib.util, json, os, sys
here = ${JSON.stringify(scriptDir)}
holdout = ${JSON.stringify(holdout)}
sys.path.insert(0, here)
spec = importlib.util.spec_from_file_location("train_lora_holdout_probe", os.path.join(here, "train_lora.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
uspec = importlib.util.spec_from_file_location("train_lora_unsloth_holdout_probe", os.path.join(here, "train_lora_unsloth.py"))
umod = importlib.util.module_from_spec(uspec)
uspec.loader.exec_module(umod)
print(json.dumps({"hf": mod.load_holdout_rows(holdout), "unsloth": umod.load_holdout_rows(holdout)}))
`;
  const r = spawnSync(PY, ['-c', probe], { stdio: 'pipe', timeout: 60000 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  const got = JSON.parse((r.stdout || '').toString());
  const expected = [
    { id: 'a', input: 'A', expected: 'OA' },
    { id: 'b', input: 'B', expected: 'EB' },
    { id: 'c', input: 'C', expected: 'TC' },
  ];
  assert.deepEqual(got.hf, expected);
  assert.deepEqual(got.unsloth, expected);
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
os.environ["KOLM_USE_LIGER"] = "0"
out = {
  "families": list(mod.UNSLOTH_FAMILIES),
  "qwen_supported": mod._is_unsloth_supported("Qwen/Qwen2.5-7B-Instruct"),
  "llama_supported": mod._is_unsloth_supported("meta-llama/Llama-3.2-3B-Instruct"),
  "unsupported": mod._is_unsloth_supported("microsoft/DialoGPT-medium"),
  "unsloth_importable": mod._unsloth_importable(),
  "hf": list(mod._select_backend("hf", "Qwen/Qwen2.5-7B-Instruct")),
  "auto_unsupported": list(mod._select_backend("auto", "microsoft/DialoGPT-medium")),
  "auto_supported": list(mod._select_backend("auto", "Qwen/Qwen2.5-7B-Instruct")),
  "liger_qwen": list(mod._liger_api_for_model("Qwen/Qwen2.5-7B-Instruct")),
  "liger_qwen3": list(mod._liger_api_for_model("Qwen/Qwen3-8B-Instruct")),
  "liger_llama": list(mod._liger_api_for_model("meta-llama/Llama-3.2-3B-Instruct")),
  "liger_mistral": list(mod._liger_api_for_model("mistralai/Mistral-7B-Instruct-v0.3")),
  "liger_gemma": list(mod._liger_api_for_model("google/gemma-3-4b-it")),
  "liger_phi": list(mod._liger_api_for_model("microsoft/Phi-3-mini-4k-instruct")),
  "liger_unsupported": list(mod._liger_api_for_model("microsoft/DialoGPT-medium")),
  "liger_disabled": mod._maybe_apply_liger("Qwen/Qwen2.5-7B-Instruct", apply_patch=False),
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
  assert.deepEqual(got.liger_qwen, ['qwen2', 'apply_liger_kernel_to_qwen2']);
  assert.deepEqual(got.liger_qwen3, ['qwen3', 'apply_liger_kernel_to_qwen3']);
  assert.deepEqual(got.liger_llama, ['llama', 'apply_liger_kernel_to_llama']);
  assert.deepEqual(got.liger_mistral, ['mistral', 'apply_liger_kernel_to_mistral']);
  assert.deepEqual(got.liger_gemma, ['gemma3', 'apply_liger_kernel_to_gemma3_text']);
  assert.deepEqual(got.liger_phi, ['phi3', 'apply_liger_kernel_to_phi3']);
  assert.deepEqual(got.liger_unsupported, [null, null]);
  assert.equal(got.liger_disabled.requested, false);
  assert.equal(got.liger_disabled.skipped_reason, 'disabled');
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
  const noLigerEnv = { ...process.env, KOLM_USE_LIGER: '0' };
  const def = spawnSync(PY, [script, '--pairs', pairs, '--out', out, '--preflight-only'], { stdio: 'pipe', timeout: 60000, env: noLigerEnv });
  assert.equal(def.status, 0, (def.stderr || '').toString());
  const defJson = JSON.parse((def.stdout || '').toString());
  assert.equal(defJson.ok, true);
  assert.equal(defJson.config.lora_variant, 'rslora');
  assert.equal(defJson.backend.selected, 'hf');
  assert.ok(defJson.backend.hf_only_features.includes('lora_variant:rslora'));
  assert.equal(typeof defJson.checks.unsloth_importable, 'boolean');
  assert.equal(defJson.config.liger.requested, false);
  assert.equal(defJson.config.liger.skipped_reason, 'disabled');
  const forcedHf = spawnSync(PY, [script, '--backend', 'hf', '--preflight-only'], { stdio: 'pipe', timeout: 60000, env: noLigerEnv });
  assert.equal(forcedHf.status, 0, (forcedHf.stderr || '').toString());
  assert.equal(JSON.parse((forcedHf.stdout || '').toString()).backend.selected, 'hf');
  const dora = spawnSync(PY, [script, '--pairs', pairs, '--out', out, '--preflight-only'], {
    stdio: 'pipe', timeout: 60000, env: { ...process.env, KOLM_USE_LIGER: '0', KOLM_LORA_VARIANT: 'dora', KOLM_NEFTUNE_ALPHA: '5' },
  });
  assert.equal(dora.status, 0);
  const doraJson = JSON.parse((dora.stdout || '').toString());
  assert.equal(doraJson.config.lora_variant, 'dora');
  assert.equal(doraJson.backend.selected, 'hf');
  const liger = spawnSync(PY, [script, '--student-base', 'Qwen/Qwen2.5-0.5B-Instruct', '--preflight-only'], {
    stdio: 'pipe', timeout: 60000, env: {
      ...process.env,
      KOLM_USE_LIGER: '1',
      KOLM_LORA_VARIANT: 'lora',
      KOLM_LORA_INIT: 'default',
      KOLM_OPTIM: 'adamw_torch',
      KOLM_PACKING: '0',
      KOLM_NEFTUNE_ALPHA: '',
    },
  });
  assert.equal(liger.status, 0, (liger.stderr || '').toString());
  const ligerJson = JSON.parse((liger.stdout || '').toString());
  assert.equal(ligerJson.config.liger.requested, true);
  assert.equal(ligerJson.config.liger.model_family, 'qwen2');
  assert.equal(ligerJson.config.liger.api, 'apply_liger_kernel_to_qwen2');
  if (ligerJson.config.liger.available) {
    assert.equal(ligerJson.config.liger.would_apply, true);
  } else {
    assert.equal(ligerJson.config.liger.skipped_reason, 'liger_kernel_not_installed');
  }
  const strictUnsupported = spawnSync(PY, [script, '--student-base', 'microsoft/DialoGPT-medium', '--preflight-only'], {
    stdio: 'pipe', timeout: 60000, env: { ...process.env, KOLM_USE_LIGER: 'strict' },
  });
  assert.equal(strictUnsupported.status, 14);
  assert.match((strictUnsupported.stderr || '').toString(), /unsupported_model_family/);
});

test('W616 trainer backend wiring spans recipe, CLI, worker, and mirror', () => {
  const train = fs.readFileSync(path.join(repoRoot, 'workers/distill/scripts/train_lora.py'), 'utf8');
  assert.match(train, /UNSLOTH_FAMILIES/);
  assert.match(train, /def _exec_unsloth_backend/);
  assert.match(train, /_exec_unsloth_backend\(args, backend_plan\["reason"\]/);
  assert.match(train, /if args\.holdout:[\s\S]+--holdout/);
  assert.match(train, /LIGER_KERNEL_APIS/);
  assert.match(train, /def _maybe_apply_liger/);
  assert.match(train, /_maybe_apply_liger\(args\.student_base, apply_patch=True\)/);
  assert.match(train, /"liger_kernel": bool\(liger_plan\.get\("applied"\)\)/);
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

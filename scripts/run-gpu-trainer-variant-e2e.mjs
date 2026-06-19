#!/usr/bin/env node
// W1030 opt-in GPU evidence harness for the production Python trainer.
//
// Local CI verifies this harness without a GPU. Real claim promotion should run
// it with KOLM_RUN_GPU_TRAINER_E2E=1 and a local/cached base model path.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENABLE_ENV = 'KOLM_RUN_GPU_TRAINER_E2E';
const BASE_MODEL_ENV = 'KOLM_GPU_TRAINER_E2E_BASE_MODEL';
const ALLOW_DOWNLOAD_ENV = 'KOLM_GPU_TRAINER_E2E_ALLOW_DOWNLOAD';
const CASES_ENV = 'KOLM_GPU_TRAINER_E2E_CASES';
const PY = process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trainScript = path.join(repoRoot, 'workers', 'distill', 'scripts', 'train_lora.py');

function emit(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = code;
}

function fail(reason, extra = {}) {
  emit({ ok: false, skipped: false, reason, ...extra }, 1);
}

function tail(s, max = 5000) {
  const txt = String(s || '');
  return txt.length > max ? txt.slice(txt.length - max) : txt;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: Number(process.env.KOLM_GPU_TRAINER_E2E_TIMEOUT_MS || 30 * 60 * 1000),
    ...opts,
  });
}

function parseJson(txt, label) {
  try {
    return JSON.parse(txt);
  } catch (err) {
    throw new Error(`${label} was not valid JSON: ${err.message}`);
  }
}

function readSummary(caseOut) {
  const summaryPath = path.join(caseOut, 'training-summary.json');
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`missing ${summaryPath}`);
  }
  const summary = parseJson(fs.readFileSync(summaryPath, 'utf8'), summaryPath);
  if (!summary.variants || typeof summary.variants !== 'object') {
    throw new Error(`${summaryPath} missing variants block`);
  }
  return { summaryPath, summary };
}

function assertVariant(summary, expected) {
  const got = summary.variants;
  for (const [key, value] of Object.entries(expected)) {
    if (got[key] !== value) {
      throw new Error(`expected variants.${key}=${JSON.stringify(value)}, got ${JSON.stringify(got[key])}`);
    }
  }
}

const cases = [
  {
    id: 'pissa_dora_packing',
    env: {
      KOLM_LORA_VARIANT: 'dora',
      KOLM_LORA_INIT: 'pissa_niter_16',
      KOLM_PACKING: '1',
      KOLM_OPTIM: 'adamw_torch',
    },
    expect: {
      lora_variant: 'dora',
      lora_init: 'pissa_niter_16',
      packing: true,
      optim: 'adamw_torch',
    },
  },
  {
    id: 'galore_adamw',
    env: {
      KOLM_LORA_VARIANT: 'lora',
      KOLM_LORA_INIT: 'default',
      KOLM_PACKING: '0',
      KOLM_OPTIM: 'galore_adamw',
      KOLM_GALORE_ARGS: 'rank=4,update_proj_gap=50,scale=0.25',
      KOLM_GALORE_TARGETS: 'attn,mlp',
    },
    expect: {
      lora_variant: 'lora',
      lora_init: 'default',
      packing: false,
      optim: 'galore_adamw',
      galore_args: 'rank=4,update_proj_gap=50,scale=0.25',
    },
  },
];

if (process.env[ENABLE_ENV] !== '1') {
  emit({
    ok: true,
    skipped: true,
    reason: `set ${ENABLE_ENV}=1 to run the GPU trainer evidence harness`,
    required_env: [ENABLE_ENV, BASE_MODEL_ENV],
  });
} else {
  try {
    if (!fs.existsSync(trainScript)) {
      throw new Error(`missing trainer script: ${trainScript}`);
    }

    const cudaProbe = run(PY, ['-c', [
      'import json',
      'import torch',
      'print(json.dumps({',
      '"cuda": bool(torch.cuda.is_available()),',
      '"device_count": int(torch.cuda.device_count()) if torch.cuda.is_available() else 0,',
      '"torch": getattr(torch, "__version__", "unknown"),',
      '"devices": [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())] if torch.cuda.is_available() else []',
      '}))',
    ].join('; ')], { timeout: 120000 });
    if (cudaProbe.status !== 0) {
      fail('python_torch_cuda_probe_failed', {
        python: PY,
        stderr: tail(cudaProbe.stderr),
        stdout: tail(cudaProbe.stdout),
      });
    } else {
      const cuda = parseJson(cudaProbe.stdout, 'cuda probe');
      if (!cuda.cuda) {
        fail('cuda_not_available', { python: PY, cuda });
      } else {
        const allowDownload = process.env[ALLOW_DOWNLOAD_ENV] === '1';
        const configuredBase = String(process.env[BASE_MODEL_ENV] || '').trim();
        if (!configuredBase) {
          fail('missing_base_model', {
            required_env: BASE_MODEL_ENV,
            hint: `set ${BASE_MODEL_ENV} to a local model path, or set ${ALLOW_DOWNLOAD_ENV}=1 for a model id`,
          });
        } else {
          const baseModel = fs.existsSync(configuredBase) ? path.resolve(configuredBase) : configuredBase;
          if (!fs.existsSync(baseModel) && !allowDownload) {
            fail('base_model_not_local', {
              base_model: configuredBase,
              hint: `use a local/cached model path or set ${ALLOW_DOWNLOAD_ENV}=1`,
            });
          } else {
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-gpu-trainer-e2e-'));
            const pairs = path.join(tmp, 'pairs.jsonl');
            const rows = [
              { input: 'Classify: checkout is down for every customer', teacher_output: 'P0 outage' },
              { input: 'Classify: report export is slow but works', teacher_output: 'P2 degraded' },
              { input: 'Classify: typo in admin settings copy', teacher_output: 'P3 cosmetic' },
              { input: 'Classify: SSO login fails for one enterprise tenant', teacher_output: 'P1 blocker' },
            ];
            fs.writeFileSync(pairs, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

            const selected = String(process.env[CASES_ENV] || 'all')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            const runCases = selected.includes('all') ? cases : cases.filter((c) => selected.includes(c.id));
            if (runCases.length === 0) {
              fail('no_cases_selected', { requested: selected, available: cases.map((c) => c.id) });
            } else {
              const results = [];
              for (const c of runCases) {
                const out = path.join(tmp, c.id);
                const env = {
                  ...process.env,
                  ...c.env,
                  KOLM_USE_LIGER: '0',
                  KOLM_TORCH_COMPILE: '0',
                  KOLM_GRAD_CHECKPOINT: process.env.KOLM_GRAD_CHECKPOINT || '0',
                  KOLM_PRECISION: process.env.KOLM_GPU_TRAINER_E2E_PRECISION || process.env.KOLM_PRECISION || 'fp16',
                  TRANSFORMERS_OFFLINE: allowDownload ? process.env.TRANSFORMERS_OFFLINE || '' : '1',
                  HF_HUB_OFFLINE: allowDownload ? process.env.HF_HUB_OFFLINE || '' : '1',
                };
                const args = [
                  trainScript,
                  '--backend', 'hf',
                  '--pairs', pairs,
                  '--out', out,
                  '--student-base', baseModel,
                  '--epochs', String(process.env.KOLM_GPU_TRAINER_E2E_EPOCHS || 1),
                  '--batch-size', String(process.env.KOLM_GPU_TRAINER_E2E_BATCH_SIZE || 1),
                  '--lr', String(process.env.KOLM_GPU_TRAINER_E2E_LR || 0.0001),
                  '--max-length', String(process.env.KOLM_GPU_TRAINER_E2E_MAX_LENGTH || 64),
                  '--lora-rank', String(process.env.KOLM_GPU_TRAINER_E2E_LORA_RANK || 2),
                  '--lora-alpha', String(process.env.KOLM_GPU_TRAINER_E2E_LORA_ALPHA || 4),
                  '--gradient-accumulation-steps', '1',
                  '--save-total-limit', '1',
                ];
                const r = run(PY, args, { env });
                if (r.status !== 0) {
                  fail('trainer_case_failed', {
                    case: c.id,
                    status: r.status,
                    signal: r.signal,
                    stdout: tail(r.stdout),
                    stderr: tail(r.stderr),
                  });
                  break;
                }
                const { summaryPath, summary } = readSummary(out);
                assertVariant(summary, c.expect);
                results.push({
                  case: c.id,
                  summary_path: summaryPath,
                  backend: summary.backend?.selected,
                  variants: summary.variants,
                  massive: summary.massive,
                });
              }
              if (process.exitCode !== 1) {
                emit({
                  ok: true,
                  skipped: false,
                  version: 'w1030-gpu-trainer-variant-e2e-v1',
                  python: PY,
                  cuda,
                  base_model: baseModel,
                  cases: results,
                });
              }
            }
          }
        }
      }
    }
  } catch (err) {
    fail('gpu_trainer_e2e_exception', {
      error: err?.message || String(err),
      stack: process.env.KOLM_GPU_TRAINER_E2E_DEBUG === '1' ? err?.stack : undefined,
    });
  }
}

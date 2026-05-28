#!/usr/bin/env node
// scripts/trinity-2000-v2-export.mjs
//
// Post-training export pipeline for Trinity 2000 v2:
//   1. Merge LoRA adapter into base Qwen2.5-7B-Instruct (HF safetensors).
//   2. Convert merged HF model to F16 GGUF via llama.cpp convert_hf_to_gguf.py.
//   3. (Optional) Quantize to Q4_K_M / Q5_K_M / Q8_0 if llama-quantize is found.
//   4. Write an Ollama Modelfile pointing at the GGUF for `ollama create`.
//   5. Emit a HF model card markdown with training params + provenance.
//
// Outputs land under ~/.kolm/distill-runs/trinity-2000-v2-2026-05-28/export/.
//
// Usage:
//   node scripts/trinity-2000-v2-export.mjs              # full pipeline
//   node scripts/trinity-2000-v2-export.mjs --merge-only # just the safetensors merge
//   node scripts/trinity-2000-v2-export.mjs --skip-quant # F16 only (skip Q4/Q5/Q8)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}

const RUN = path.join(os.homedir(), '.kolm', 'distill-runs', 'trinity-2000-v2-2026-05-28');
const ADAPTER = path.join(RUN, 'student');
const EXPORT = path.join(RUN, 'export');
const MERGED_HF = path.join(EXPORT, 'merged-hf');
const GGUF_F16 = path.join(EXPORT, 'trinity-2000-v2-qwen2.5-7b-f16.gguf');
const SPEC = JSON.parse(fs.readFileSync(path.join(RUN, 'spec.json'), 'utf-8'));
const LLAMA_CPP = path.join(os.homedir(), '.kolm', 'deps', 'llama.cpp');

fs.mkdirSync(EXPORT, { recursive: true });

if (!fs.existsSync(ADAPTER)) {
  console.error(`[export] adapter not found at ${ADAPTER}; train first`);
  process.exit(1);
}

console.log(`[export] adapter:  ${ADAPTER}`);
console.log(`[export] base:     ${SPEC.student_base}`);
console.log(`[export] merged:   ${MERGED_HF}`);
console.log(`[export] gguf F16: ${GGUF_F16}`);

// Step 1 — merge LoRA into base via a one-shot Python program.
function step1Merge() {
  const py = `
import os, sys, json
from transformers import AutoModelForCausalLM, AutoTokenizer
import torch

BASE = ${JSON.stringify(SPEC.student_base)}
ADAPTER = ${JSON.stringify(ADAPTER)}
OUT = ${JSON.stringify(MERGED_HF)}

os.makedirs(OUT, exist_ok=True)
print(f"[merge] loading base {BASE} ...", flush=True)
base = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.float16, device_map="cpu")
tok = AutoTokenizer.from_pretrained(BASE)

from peft import PeftModel
print(f"[merge] loading adapter {ADAPTER} ...", flush=True)
model = PeftModel.from_pretrained(base, ADAPTER)

print("[merge] merge_and_unload() ...", flush=True)
merged = model.merge_and_unload()

print(f"[merge] saving to {OUT} ...", flush=True)
merged.save_pretrained(OUT, safe_serialization=True)
tok.save_pretrained(OUT)
print("[merge] done.", flush=True)
`;
  const tmp = path.join(EXPORT, '_merge.py');
  fs.writeFileSync(tmp, py);
  const r = spawnSync(process.env.KOLM_PYTHON || 'python', ['-X', 'utf8', tmp], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[export] merge failed with exit ${r.status}`);
    process.exit(2);
  }
}

// Step 2 — convert merged HF to F16 GGUF via llama.cpp.
function step2ConvertGGUF() {
  const converter = path.join(LLAMA_CPP, 'convert_hf_to_gguf.py');
  if (!fs.existsSync(converter)) {
    console.error(`[export] llama.cpp convert_hf_to_gguf.py not found at ${converter}`);
    console.error('         clone https://github.com/ggerganov/llama.cpp into ~/.kolm/deps/llama.cpp');
    return false;
  }
  const r = spawnSync(process.env.KOLM_PYTHON || 'python', [
    '-X', 'utf8', converter,
    MERGED_HF,
    '--outfile', GGUF_F16,
    '--outtype', 'f16',
  ], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[export] convert_hf_to_gguf.py failed with exit ${r.status}`);
    return false;
  }
  return true;
}

// Step 3 — quantize (best-effort). Looks for llama-quantize in common spots.
function step3Quantize() {
  if (args['skip-quant']) {
    console.log('[export] --skip-quant: keeping F16 only');
    return;
  }
  const candidates = [
    path.join(LLAMA_CPP, 'build', 'bin', 'Release', 'llama-quantize.exe'),
    path.join(LLAMA_CPP, 'build', 'bin', 'llama-quantize'),
    path.join(LLAMA_CPP, 'build', 'Release', 'llama-quantize.exe'),
    path.join(LLAMA_CPP, 'llama-quantize.exe'),
    path.join(LLAMA_CPP, 'llama-quantize'),
  ];
  const llamaQuantize = candidates.find((p) => fs.existsSync(p));
  if (!llamaQuantize) {
    console.warn('[export] llama-quantize not built; skipping Q4_K_M / Q5_K_M / Q8_0');
    console.warn('         build it: cd ~/.kolm/deps/llama.cpp && cmake -B build && cmake --build build --config Release -j');
    return;
  }
  const quants = [
    { tag: 'q4_k_m', flag: 'Q4_K_M' },
    { tag: 'q5_k_m', flag: 'Q5_K_M' },
    { tag: 'q8_0',   flag: 'Q8_0' },
  ];
  for (const q of quants) {
    const out = path.join(EXPORT, `trinity-2000-v2-qwen2.5-7b-${q.tag}.gguf`);
    console.log(`[export] quantize -> ${q.flag}`);
    const r = spawnSync(llamaQuantize, [GGUF_F16, out, q.flag], { stdio: 'inherit' });
    if (r.status !== 0) console.warn(`[export]   ${q.flag} failed (exit ${r.status})`);
    else console.log(`[export]   ${q.flag} -> ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

// Step 4 — Ollama Modelfile.
function step4OllamaModelfile() {
  const ggufPick = ['q4_k_m', 'q5_k_m', 'q8_0', 'f16']
    .map((t) => path.join(EXPORT, `trinity-2000-v2-qwen2.5-7b-${t}.gguf`))
    .find((p) => fs.existsSync(p));
  if (!ggufPick) {
    console.warn('[export] no GGUF found; skipping Ollama Modelfile');
    return;
  }
  const modelfile = `# trinity-2000-v2 — distilled from Claude+GPT-4o+DeepSeek council
# usage:
#   ollama create trinity-2000-v2 -f Modelfile
#   ollama run trinity-2000-v2 "I want to return an item from last week"

FROM ${ggufPick}

SYSTEM """${SPEC.system}"""

PARAMETER temperature 0.2
PARAMETER top_p 0.9
PARAMETER stop "<|user|>"
PARAMETER stop "<|assistant|>"
`;
  const out = path.join(EXPORT, 'Modelfile');
  fs.writeFileSync(out, modelfile);
  console.log(`[export] Ollama Modelfile -> ${out}`);
  console.log('         ollama create trinity-2000-v2 -f ' + out);
}

// Step 5 — HF model card.
function step5ModelCard() {
  const summary = (() => {
    const p = path.join(ADAPTER, 'training-summary.json');
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
  })();
  const ggufList = fs.readdirSync(EXPORT).filter((n) => n.endsWith('.gguf')).map((n) => {
    const sz = fs.statSync(path.join(EXPORT, n)).size / 1024 / 1024;
    return `- \`${n}\` (${sz.toFixed(1)} MB)`;
  }).join('\n');

  const card = `---
language: en
license: apache-2.0
base_model: ${SPEC.student_base}
tags:
  - customer-support
  - distilled
  - lora
  - qlora
  - kolm
  - trinity-2000-v2
datasets:
  - kolm-trinity-2000-v2
---

# Trinity 2000 v2 — Customer Support Distillation

A 7B customer-support specialist distilled from a 3-teacher council:

| Teacher | Rows | Share |
|---------|------|-------|
| Claude Sonnet 4.5 (anthropic) | 800 | 40% |
| GPT-4o (openai) | 600 | 30% |
| DeepSeek-R1-Distill-Qwen-32B (local) | 600 | 30% |

## Training

- Base model: \`${SPEC.student_base}\`
- Method: ${SPEC.distillation_method.toUpperCase()} (NF4 4-bit + double-quant)
- LoRA: r=${SPEC.lora.r}, alpha=${SPEC.lora.alpha}, dropout=${SPEC.lora.dropout}
- Max seq len: ${SPEC.max_seq_len}
- Epochs: ${SPEC.epochs}
- Batch size: ${SPEC.batch_size} × grad-accum ${SPEC.gradient_accumulation_steps} = effective ${SPEC.effective_batch_size}
- Learning rate: ${SPEC.lr} (warmup ${SPEC.warmup_ratio})
- Eval: ${SPEC.val_fraction * 100}% holdout, every ${SPEC.eval_steps} steps, save best on eval_loss
- Save policy: every ${SPEC.save_steps} steps, retain last ${SPEC.save_total_limit}
${summary && summary.massive ? `- Optimizer: ${summary.massive.optim || 'AdamW (default)'}` : ''}
${summary && summary.efficiency ? `- Precision: ${summary.efficiency.precision} (fp16=${summary.efficiency.fp16}, bf16=${summary.efficiency.bf16})` : ''}
${summary && summary.efficiency ? `- Gradient checkpointing: ${summary.efficiency.gradient_checkpointing}` : ''}

## Buckets

The 2000 training prompts are balanced across 8 customer-support buckets:

${Object.entries(SPEC.buckets).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n')}

## Artifacts

${ggufList || '(no GGUF emitted yet)'}

## System prompt

\`\`\`
${SPEC.system}
\`\`\`

## Reproducibility

\`\`\`
git clone https://github.com/Kolm-ai/kolm
cd kolm
node scripts/trinity-2000-v2-run.mjs
\`\`\`

Split seed: ${SPEC.split_seed}. Same seeds.jsonl + same teacher calls + same hyperparams = bit-identical adapter weights.

## Caveats

- Customer-support domain only. Not a general-purpose model.
- Optimized for English. Multilingual quality not measured.
- 4-bit QLoRA training introduces small numerical drift versus full-precision fine-tune.
- Three-teacher consensus reduces single-teacher bias but doesn't eliminate it; review training pairs before high-stakes deployment.
`;
  const out = path.join(EXPORT, 'README.md');
  fs.writeFileSync(out, card);
  console.log(`[export] model card -> ${out}`);
}

// ---------------------------------------------------------------- run

step1Merge();
if (args['merge-only']) {
  console.log('[export] --merge-only: stopping after HF safetensors merge');
  process.exit(0);
}
const ggufOk = step2ConvertGGUF();
if (ggufOk) step3Quantize();
step4OllamaModelfile();
step5ModelCard();
console.log('\n[export] done. artifacts under ' + EXPORT);

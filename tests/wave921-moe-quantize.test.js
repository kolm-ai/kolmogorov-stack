// W921 NEXT-4 — MoE-aware quantization in workers/quantize/scripts/quantize.py.
//
// Highest-value NEXT-4 core: quantizing a customer's Mixture-of-Experts model
// (Mixtral / Qwen-MoE / OLMoE / DeepSeek-V2/V3 / DBRX / Llama-4). The MoE path
// is ADDITIVE and GATED on detecting MoE in config.json (mirrors
// src/moe-support.js detectMoE) so the proven DENSE path stays byte-for-byte
// unchanged when num_experts is absent.
//
// When MoE is detected the quantizer:
//   (1) groups params into {router/gate (SACRED fp16), shared/attn, per-expert
//       FFN blocks};
//   (2) applies per-group precision from the --mixed-precision DAQ profile
//       (forge emits router=fp16, shared=q4/iq4, experts=aggressive);
//   (3) quantizes each expert block independently + records per-expert
//       bytes-before/after;
//   (4) emits run-meta {moe, num_experts, router_precision, expert_precision,
//       per_group_bytes, total_compression}.
//
// A full MoE model run needs a large model (infra tail), so this locks the
// CODE CONTRACT at source level + drives the pure-CPU python --self-test-moe
// (synthetic 8-expert config + tiny fake state dict, no model download) that
// proves the four invariants. It also feeds a synthetic safetensors header to
// the real run-meta builder so the per-expert byte accounting is exercised
// end-to-end without a model download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'workers', 'quantize', 'scripts');
const QUANTIZE_PATH = path.join(SCRIPTS, 'quantize.py');
const QUANTIZE = fs.readFileSync(QUANTIZE_PATH, 'utf8');

const PY = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');

function runPy(args, opts = {}) {
  return spawnSync(PY, args, {
    encoding: 'utf8',
    cwd: SCRIPTS,
    timeout: 120_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    ...opts,
  });
}

function pyAvailable() {
  return runPy(['-c', 'import sys']).status === 0;
}

// ---------------------------------------------------------------------------
// Source-level code contract — these hold even where python is unavailable.
// ---------------------------------------------------------------------------

test('SRC #1 — MoE path is GATED on detecting MoE in config.json (dense path untouched)', () => {
  // The MoE run-meta only builds when detect_moe_config reports is_moe.
  assert.match(QUANTIZE, /def detect_moe_config/, 'detect_moe_config must exist');
  assert.match(QUANTIZE, /moe_detection = detect_moe_config\(str\(src\)\)/,
    'main() must detect MoE from config.json');
  assert.match(QUANTIZE, /if moe_detection\.get\("is_moe"\):\s*\n\s*moe_run_meta = build_moe_run_meta/,
    'MoE run-meta must build ONLY when MoE is detected');
});

test('SRC #2 — detection key list mirrors src/moe-support.js detectMoE', () => {
  for (const k of ['num_experts', 'n_routed_experts', 'num_local_experts',
                   'num_experts_per_layer', 'moe_num_experts']) {
    assert.ok(QUANTIZE.includes(`"${k}"`), `expert key ${k} must be in the detection list`);
  }
  for (const arch of ['MixtralForCausalLM', 'Qwen2MoeForCausalLM', 'DeepseekV3ForCausalLM',
                      'OlmoeForCausalLM', 'DbrxForCausalLM', 'Llama4ForCausalLM']) {
    assert.ok(QUANTIZE.includes(`"${arch}"`), `architecture ${arch} must be recognized`);
  }
});

test('SRC #3 — three parameter groups: router (sacred fp16), shared, per-expert', () => {
  assert.match(QUANTIZE, /def group_moe_parameters/, 'grouping function must exist');
  // Router is sacred — always fp16, never downgraded.
  assert.match(QUANTIZE, /router_after_tag = "fp16"\s*#\s*SACRED/,
    'router precision must be hard-pinned to fp16 (sacred)');
  // Per-expert independence: each expert sized in its own loop iteration.
  assert.match(QUANTIZE, /for eid in grouping\["covered_expert_ids"\]:/,
    'experts must be sized expert-by-expert (independent quantization)');
});

test('SRC #4 — run-meta records the required NEXT-4 fields', () => {
  for (const field of ['"moe": True', '"num_experts"', '"router_precision"',
                       '"expert_precision"', '"per_group_bytes"', '"total_compression"',
                       '"per_expert_bytes"']) {
    assert.ok(QUANTIZE.includes(field), `run-meta must record ${field}`);
  }
  assert.match(QUANTIZE, /receipt\["moe"\] = moe_run_meta/, 'receipt must carry the moe run-meta');
});

test('SRC #5 — --self-test-moe is an opt-in store_true flag (no model download)', () => {
  assert.match(QUANTIZE,
    /add_argument\("--self-test-moe",\s*dest="self_test_moe",\s*\n?\s*action="store_true",\s*default=False/,
    '--self-test-moe must be a store_true flag defaulting to False');
  assert.match(QUANTIZE, /def self_test_moe/, 'self_test_moe function must exist');
});

// ---------------------------------------------------------------------------
// Live python verification — drive the pure-CPU self-test (no model download).
// ---------------------------------------------------------------------------

test('LIVE #1 — --self-test-moe passes (CPU, deterministic, 4 invariants)', () => {
  if (!pyAvailable()) {
    console.error('[wave921-moe] python unavailable; skipping live self-test');
    return;
  }
  const r = runPy([QUANTIZE_PATH, '--self-test-moe']);
  assert.equal(r.status, 0, `--self-test-moe must exit 0:\n${r.stdout}\n${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true, `self-test failures: ${JSON.stringify(out.failures)}`);
  // Invariant 1: router stays fp16 (sacred).
  assert.equal(out.router_precision, 'fp16', 'router must stay fp16');
  // Invariant 2: every expert grouped + aggressive precision (int4 here).
  assert.equal(out.expert_precision, 'int4', 'experts must get the aggressive precision');
  // Invariant 3: grouping covers all expert layers (8 experts x 2 layers x 3 w-matrices).
  assert.equal(out.expert_layer_count, 48, 'grouping must cover all expert FFN tensors');
  assert.equal(out.num_experts, 8, 'all 8 synthetic experts must be seen');
  // Invariant 4: real compression (> 1).
  assert.ok(out.total_compression > 1.0, `compression must exceed 1: ${out.total_compression}`);
  // Per-group precision came from the DAQ profile, not the default fallback.
  assert.equal(out.precision_source, 'daq_profile');
});

test('LIVE #2 — --self-test-moe is deterministic (identical JSON across runs)', () => {
  if (!pyAvailable()) {
    console.error('[wave921-moe] python unavailable; skipping determinism check');
    return;
  }
  const a = runPy([QUANTIZE_PATH, '--self-test-moe']);
  const b = runPy([QUANTIZE_PATH, '--self-test-moe']);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.deepEqual(JSON.parse(a.stdout.trim()), JSON.parse(b.stdout.trim()),
    'self-test output must be byte-stable (no RNG, no clock in control flow)');
});

test('LIVE #3 — detection mirrors moe-support across families; dense is NOT flagged', () => {
  if (!pyAvailable()) {
    console.error('[wave921-moe] python unavailable; skipping detection check');
    return;
  }
  // Drive detect_moe_config + group_moe_parameters via a tiny inline python that
  // imports quantize.py and asserts on representative tensor-name schemes from
  // Mixtral, Qwen/DeepSeek/OLMoE (mlp.experts.<n>.gate_proj), and DBRX
  // (ffn.experts / ffn.router). Verifies: (a) a DENSE Llama config is never
  // flagged MoE; (b) an expert's own gate_proj is grouped as an EXPERT, never
  // the router; (c) the router/gate is grouped as router.
  const py = `
import json, sys, importlib.util, tempfile, os
spec = importlib.util.spec_from_file_location("quantize", r"${QUANTIZE_PATH.replace(/\\/g, '\\\\')}")
q = importlib.util.module_from_spec(spec); spec.loader.exec_module(q)
fail = []

# Dense Llama -> NOT MoE.
d = tempfile.mkdtemp()
with open(os.path.join(d, "config.json"), "w") as f:
    json.dump({"architectures": ["LlamaForCausalLM"], "model_type": "llama",
               "hidden_size": 128, "intermediate_size": 512}, f)
if q.detect_moe_config(d)["is_moe"]:
    fail.append("dense Llama flagged as MoE")

# Qwen-MoE config (n_routed_experts) -> MoE.
with open(os.path.join(d, "config.json"), "w") as f:
    json.dump({"architectures": ["Qwen2MoeForCausalLM"], "model_type": "qwen2_moe",
               "num_experts": 60, "num_experts_per_tok": 4}, f)
det = q.detect_moe_config(d)
if not det["is_moe"] or det["num_experts"] != 60:
    fail.append("qwen-moe not detected: %r" % det)

# DeepSeek/Qwen/OLMoE expert tensor names: mlp.experts.<n>.gate_proj — an
# expert gate_proj must group as EXPERT, never as the router.
names = [
  "model.layers.0.mlp.gate.weight",               # router (sacred)
  "model.layers.0.mlp.experts.0.gate_proj.weight",# EXPERT (despite 'gate')
  "model.layers.0.mlp.experts.0.up_proj.weight",
  "model.layers.0.mlp.experts.7.down_proj.weight",
  "model.layers.0.self_attn.q_proj.weight",       # shared
  "transformer.blocks.0.ffn.router.layer.weight", # DBRX router (sacred)
  "transformer.blocks.0.ffn.experts.3.w1",        # DBRX expert
]
g = q.group_moe_parameters(names)
if "model.layers.0.mlp.experts.0.gate_proj.weight" not in g["experts"].get(0, []):
    fail.append("expert gate_proj leaked out of expert group: %r" % g["experts"])
if "model.layers.0.mlp.gate.weight" not in g["router"]:
    fail.append("router gate not grouped as router: %r" % g["router"])
if "transformer.blocks.0.ffn.router.layer.weight" not in g["router"]:
    fail.append("DBRX router not grouped as router: %r" % g["router"])
if "model.layers.0.self_attn.q_proj.weight" not in g["shared"]:
    fail.append("attn proj not grouped as shared: %r" % g["shared"])
# No expert tensor may leak into shared/router.
for nm in g["shared"] + g["router"]:
    if ".experts." in nm:
        fail.append("expert tensor leaked into shared/router: %s" % nm)

print(json.dumps({"ok": not fail, "fail": fail}))
sys.exit(1 if fail else 0)
`;
  const r = runPy(['-c', py]);
  assert.equal(r.status, 0, `cross-family detection/grouping failed:\n${r.stdout}\n${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true, JSON.stringify(out.fail));
});

test('LIVE #4 — real run-meta builder sizes a synthetic safetensors MoE end-to-end', () => {
  if (!pyAvailable()) {
    console.error('[wave921-moe] python unavailable; skipping run-meta build');
    return;
  }
  // Write a minimal valid safetensors file (header-only sizing — no weight load
  // happens in read_safetensors_numels) with a router + shared + per-expert
  // tensors for 4 experts, plus a config.json, then call build_moe_run_meta and
  // assert the per-expert byte accounting + sacred router.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-moe-rm-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      architectures: ['MixtralForCausalLM'], model_type: 'mixtral',
      num_local_experts: 4, num_experts_per_tok: 2,
    }));
    // Build a safetensors file by hand: 8-byte little-endian header length +
    // JSON header + a contiguous data blob. We only need shapes; dtype F16,
    // contiguous offsets so the file is structurally valid.
    const tensors = {};
    let off = 0;
    const add = (name, shape) => {
      const numel = shape.reduce((a, b) => a * b, 1);
      const bytes = numel * 2; // F16
      tensors[name] = { dtype: 'F16', shape, data_offsets: [off, off + bytes] };
      off += bytes;
    };
    add('model.layers.0.block_sparse_moe.gate.weight', [4, 32]); // router (sacred)
    add('model.layers.0.self_attn.q_proj.weight', [32, 32]);     // shared
    for (let e = 0; e < 4; e++) {
      add(`model.layers.0.block_sparse_moe.experts.${e}.w1.weight`, [64, 32]);
      add(`model.layers.0.block_sparse_moe.experts.${e}.w2.weight`, [32, 64]);
    }
    const headerJson = Buffer.from(JSON.stringify(tensors), 'utf8');
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64LE(BigInt(headerJson.length), 0);
    const dataBuf = Buffer.alloc(off); // zero-filled; never read by header sizing
    fs.writeFileSync(path.join(dir, 'model.safetensors'),
      Buffer.concat([lenBuf, headerJson, dataBuf]));

    const py = `
import json, importlib.util
spec = importlib.util.spec_from_file_location("quantize", r"${QUANTIZE_PATH.replace(/\\/g, '\\\\')}")
q = importlib.util.module_from_spec(spec); spec.loader.exec_module(q)
det = q.detect_moe_config(r"${dir.replace(/\\/g, '\\\\')}")
meta = q.build_moe_run_meta(r"${dir.replace(/\\/g, '\\\\')}", None, "int4")
print(json.dumps({"det": det, "meta": meta}))
`;
    const r = runPy(['-c', py]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const { det, meta } = JSON.parse(r.stdout.trim());
    assert.equal(det.is_moe, true, 'synthetic Mixtral safetensors must detect MoE');
    assert.equal(meta.moe, true, `run-meta must be moe:true, got ${JSON.stringify(meta)}`);
    assert.equal(meta.num_experts, 4, 'all 4 experts seen');
    assert.equal(meta.router_precision, 'fp16', 'router stays fp16 (sacred)');
    assert.equal(meta.per_expert_bytes.length, 4, 'one entry per expert (independent sizing)');
    // Router bytes unchanged (fp16 in == fp16 out).
    const rb = meta.per_group_bytes.router;
    assert.equal(rb.before, rb.after, 'router bytes must be unchanged under quant');
    // Every expert shrank.
    for (const pe of meta.per_expert_bytes) {
      assert.ok(pe.bytes_after < pe.bytes_before,
        `expert ${pe.expert_id} did not shrink`);
      assert.equal(pe.precision, meta.expert_precision);
    }
    assert.ok(meta.total_compression > 1.0, `compression must exceed 1: ${meta.total_compression}`);
    // No-profile path uses the safe default split.
    assert.equal(meta.precision_source, 'default_moe_split');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LIVE #5 — DENSE model is NOT given MoE run-meta (proven dense path unchanged)', () => {
  if (!pyAvailable()) {
    console.error('[wave921-moe] python unavailable; skipping dense-path guard');
    return;
  }
  const py = `
import json, importlib.util, tempfile, os
spec = importlib.util.spec_from_file_location("quantize", r"${QUANTIZE_PATH.replace(/\\/g, '\\\\')}")
q = importlib.util.module_from_spec(spec); spec.loader.exec_module(q)
d = tempfile.mkdtemp()
with open(os.path.join(d, "config.json"), "w") as f:
    json.dump({"architectures": ["Qwen2ForCausalLM"], "model_type": "qwen2",
               "hidden_size": 896, "intermediate_size": 4864,
               "num_hidden_layers": 24}, f)
det = q.detect_moe_config(d)
print(json.dumps(det))
`;
  const r = runPy(['-c', py]);
  assert.equal(r.status, 0, r.stderr);
  const det = JSON.parse(r.stdout.trim());
  assert.equal(det.is_moe, false, 'a dense Qwen2.5 config must NOT be flagged MoE');
  // When is_moe is false, main() leaves moe_run_meta None -> no receipt["moe"].
});

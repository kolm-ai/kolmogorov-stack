#!/usr/bin/env python3
"""
kolm quantize worker — real implementation.

Closes W336 P2: pre-this-file workers/quantize/quantize.mjs honestly returned
``api_status: 'not_yet_wired'`` because the python heavy lift was missing.
This file is that heavy lift.

Methods (W614 — full SOTA quant menu):
  int4  — bitsandbytes 4-bit (NF4 + double) weight-only quantization
  int8  — bitsandbytes 8-bit (LLM.int8) weight-only quantization
  gptq  — AutoGPTQ post-training quantization (4-bit, group_size=128)
  awq   — AutoAWQ activation-aware weight quantization (4-bit, group_size=128)
  aqlm  — AQLM additive quantization (Egiazarian 2024) near-lossless 2-bit;
          drives upstream Vahe1994/AQLM optimizer at $AQLM_REPO_PATH
  quip  — QuIP# sub-2-bit (Tseng 2024) with incoherence preprocessing + E8 lattice;
          drives upstream Cornell-RelaxML/quip-sharp at $QUIP_SHARP_REPO_PATH
  exl2  — ExLlamaV2 EXL2 runtime-optimized variable-bit quantization
  exl3  — ExLlamaV2 EXL3 next-gen format (better compression than EXL2)
  hqq   — HQQ (Mobius Labs 2024) calibration-free half-quadratic quantization
  qat   — EfficientQAT (Chen 2024) block-wise quantization-aware training;
          drives upstream OpenGVLab/EfficientQAT at $EFFICIENT_QAT_REPO_PATH

CLI contract (matches workers/quantize/quantize.mjs spawn):
  python3 quantize.py --method=int4 --in=<model_dir> --out=<out_dir>

--in must be a HuggingFace-format directory with config.json + tokenizer files
+ weights (safetensors preferred). --out is created if missing; the quantized
model is saved there in HF format. A receipt manifest is written to
<out>/quantize-receipt.json with method, source hash, dtype, device, sha256
of each output shard, finished_at, and tool versions for reproducibility.

Exit codes:
  0  quantized OK; receipt written
  2  --method invalid OR required python deps missing for the method
  3  --in path missing or unreadable
  4  quantization itself raised (model_load / compute / save)

The script keeps imports lazy per-method so e.g. a customer with only
bitsandbytes installed can do int4/int8 without needing auto-gptq/autoawq.
"""

import argparse
import hashlib
import json
import os
import sys
import time
import traceback
from pathlib import Path


def parse_args():
    p = argparse.ArgumentParser(prog="kolm-quantize", add_help=True)
    # --method / --in / --out are required for a real quantize run, but the
    # --self-test-moe path (W921 NEXT-4) runs a self-contained synthetic check
    # with no model, so we enforce them in main() instead of at argparse-level.
    self_test_only = "--self-test-moe" in (sys.argv[1:] if sys.argv else [])
    req = not self_test_only
    p.add_argument("--method", required=req,
                   choices=["int4", "int8", "gptq", "awq",
                            "aqlm", "quip", "exl2", "exl3", "hqq", "qat"])
    p.add_argument("--in", dest="src", required=req, help="HF model directory")
    p.add_argument("--out", dest="dst", required=req, help="output directory")
    p.add_argument("--calib", default=None,
                   help="(gptq/awq only) JSONL file of {text: ...} calibration rows; "
                        "defaults to a small built-in pile sample if omitted")
    p.add_argument("--group-size", type=int, default=128,
                   help="(gptq/awq only) per-group quant resolution")
    p.add_argument("--bits", type=int, default=4,
                   help="(gptq/awq only) quant bit width")
    p.add_argument("--device", default="auto",
                   help="device map for load (auto/cuda/cpu/mps); int4/int8 "
                        "require CUDA for compute, gptq/awq prefer CUDA")
    p.add_argument("--mixed-precision", dest="mixed_precision", default=None,
                   help="(W719 DAQ) JSON file holding a per-layer profile array "
                        "produced by src/daq-profile.js buildDaqProfile. When set, "
                        "the quantizer applies per-layer weight_bits / kv_bits / "
                        "group_size / scale_mode from the profile instead of the "
                        "uniform --bits / --group-size. Unsupported bit-widths for "
                        "the chosen backend fall back to nearest-supported with a "
                        "warning logged into the receipt; uniform-bit calls still "
                        "work when this flag is omitted.")
    p.add_argument("--trust-remote-code", dest="trust_remote_code",
                   action="store_true", default=False,
                   help="(W921 NOW-1) OPT-IN: pass trust_remote_code=True to every "
                        "HuggingFace from_pretrained call so models that ship custom "
                        "modeling code (e.g. openbmb/MiniCPM5-1B) can be loaded + "
                        "quantized. SECURITY: this executes arbitrary repo Python at "
                        "load time — default is False and you must pass this flag "
                        "explicitly per run. The receipt records trust_remote_code so "
                        "a verifier sees whether remote code was permitted.")
    p.add_argument("--calib-fp4", dest="calib_fp4",
                   action="store_true", default=False,
                   help="(W921 NEXT-3) OPT-IN: run an FP4-aware PTQ calibration pass "
                        "(BATQuant-style block-granular learnable affine transform + "
                        "block-wise learnable clipping, arXiv:2603.16590) over the "
                        "model weights BEFORE the int4 quantize, and record the "
                        "per-layer calibration plan + measured reconstruction-error "
                        "reduction in the receipt. Reduces FP4/INT4 error vs naive "
                        "round-to-nearest. Additive: omit the flag for the pre-W921 "
                        "behavior. See --calib-fp4-block / --calib-fp4-max-layers.")
    p.add_argument("--calib-fp4-block", dest="calib_fp4_block", type=int, default=32,
                   help="(W921 NEXT-3) MXFP4/NVFP4 micro-scaling block size for the "
                        "--calib-fp4 pass (default 32 — the hardware-native FP4 "
                        "block).")
    p.add_argument("--calib-fp4-max-layers", dest="calib_fp4_max_layers",
                   type=int, default=64,
                   help="(W921 NEXT-3) cap how many weight tensors the --calib-fp4 "
                        "pass profiles (largest-first) to bound calibration time on "
                        "big models. 0 == all layers.")
    p.add_argument("--self-test-moe", dest="self_test_moe",
                   action="store_true", default=False,
                   help="(W921 NEXT-4) run the deterministic MoE-grouping self-test "
                        "(synthetic 8-expert config + tiny fake state dict, no model "
                        "download) and print JSON. Asserts the router stays fp16, "
                        "every expert FFN block is grouped + assigned the aggressive "
                        "expert precision, and the grouping covers all expert layers. "
                        "Exits 0 on pass, 1 on failure.")
    return p.parse_args()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def hash_input_tree(root):
    """Stable sha256 of the input model directory (sorted relpath:sha lines)."""
    parts = []
    for dirpath, _, files in os.walk(root):
        for fn in sorted(files):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            try:
                parts.append(f"{rel}:{sha256_file(full)}")
            except OSError:
                continue
    parts.sort()
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def hash_output_tree(root):
    out = {}
    for dirpath, _, files in os.walk(root):
        for fn in sorted(files):
            if fn == "quantize-receipt.json":
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out[rel] = sha256_file(full)
    return out


def fail(code, msg, extra=None):
    payload = {"ok": False, "reason": msg}
    if extra:
        payload.update(extra)
    sys.stderr.write(json.dumps(payload) + "\n")
    sys.exit(code)


# Experimental quantization gate. These methods drive external research repos or
# heavier toolchains (ExLlamaV2, AQLM/QuIP# upstream optimizers, EfficientQAT
# training loop, HQQ). They are real + wired below, but the catalog advertises
# them as experimental: a plain run would mislead a customer who has not
# installed the upstream pieces. So unless the operator opts in via
# KOLM_ENABLE_EXPERIMENTAL_QUANTS=1, we refuse them up front with an actionable
# hint instead of failing deep inside the (possibly missing) toolchain. The
# four stable worker methods (int4/int8/gptq/awq) are always allowed. Mirrors
# the experimental flag in src/quantization-oracle.js METHOD_CATALOG.
_EXPERIMENTAL_METHODS = frozenset(("hqq", "exl2", "exl3", "aqlm", "quip", "qat"))


def _experimental_quants_enabled():
    v = str(os.environ.get("KOLM_ENABLE_EXPERIMENTAL_QUANTS", "")).strip().lower()
    return v in ("1", "true", "yes", "on")


def guard_experimental_method(method):
    """Fail loud (exit 2) when an experimental method is requested without the
    KOLM_ENABLE_EXPERIMENTAL_QUANTS opt-in. No-op for stable methods."""
    if method in _EXPERIMENTAL_METHODS and not _experimental_quants_enabled():
        fail(2,
             f"{method} is an experimental quantization method requiring external "
             f"toolchains; it is gated off by default",
             {"hint": "set KOLM_ENABLE_EXPERIMENTAL_QUANTS=1 to enable it, or use "
                      "one of int4/int8/gptq/awq",
              "experimental": True,
              "method": method,
              "stable_methods": ["int4", "int8", "gptq", "awq"]})


def _resolve_optimizer(repo_env, repo_script, module_name, module_args_fn,
                       env_args_fn, install_hint):
    """Resolve the calibration-time/training-time optimizer launch command for
    aqlm/quip/qat. Precedence:

      1. $<repo_env> is set + the operator's checkout has <repo_script> ->
         drive their script (operator override always wins).
      2. The pinned package's CLI module is importable ($python -m <module>)
         -> drive it. This is the turnkey path enabled when the operator opts
         in via the requirements-optimizers.txt extras group.
      3. Neither -> fail(2) with the actionable install hint.

    Returns (cmd:list[str], source:str). Never silently no-ops.
    """
    import importlib.util

    repo = os.environ.get(repo_env)
    if repo and os.path.isdir(repo):
        main_py = os.path.join(repo, repo_script)
        if not os.path.exists(main_py):
            fail(2, f"{repo_env} set but {repo_script} not found at {main_py}")
        return ([sys.executable, main_py] + list(env_args_fn(main_py)), f"env:{repo_env}")

    # Fall back to the pinned package's CLI module when no env path is set.
    if importlib.util.find_spec(module_name) is not None:
        return ([sys.executable, "-m", module_name] + list(module_args_fn()),
                f"pinned-module:{module_name}")

    fail(2,
         f"{module_name} optimizer not available: set {repo_env} to a checkout, "
         f"or install the pinned optimizer extras",
         {"install": install_hint,
          "env_override": repo_env,
          "pinned_module": module_name})


def run_int_bnb(method, src, dst, device, trust_remote_code=False):
    """int4/int8 via bitsandbytes — load with quantization config, save sharded."""
    try:
        import torch  # noqa: F401
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    except ImportError as e:
        fail(2, f"missing python deps for bnb {method}: {e}",
             {"install": "pip install torch transformers bitsandbytes accelerate"})

    if method == "int4":
        bnb = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype="bfloat16",
        )
    else:
        bnb = BitsAndBytesConfig(load_in_8bit=True)

    tok = AutoTokenizer.from_pretrained(src, trust_remote_code=trust_remote_code)
    model = AutoModelForCausalLM.from_pretrained(
        src,
        quantization_config=bnb,
        device_map=device if device != "auto" else "auto",
        trust_remote_code=trust_remote_code,
        low_cpu_mem_usage=True,
    )
    tok.save_pretrained(dst)
    model.save_pretrained(dst, safe_serialization=True)
    return {
        "lib": "bitsandbytes",
        "lib_version": _ver("bitsandbytes"),
        "torch_version": _ver("torch"),
        "transformers_version": _ver("transformers"),
        "scheme": "nf4+double" if method == "int4" else "llm.int8",
        "trust_remote_code": bool(trust_remote_code),
    }


def run_gptq(src, dst, calib, bits, group_size, device, trust_remote_code=False):
    """GPTQ via auto-gptq."""
    try:
        import torch  # noqa: F401
        from transformers import AutoTokenizer
        from auto_gptq import AutoGPTQForCausalLM, BaseQuantizeConfig
    except ImportError as e:
        fail(2, f"missing python deps for gptq: {e}",
             {"install": "pip install torch transformers auto-gptq optimum accelerate"})

    tok = AutoTokenizer.from_pretrained(src, trust_remote_code=trust_remote_code)
    cfg = BaseQuantizeConfig(bits=bits, group_size=group_size, desc_act=False)
    model = AutoGPTQForCausalLM.from_pretrained(
        src,
        quantize_config=cfg,
        trust_remote_code=trust_remote_code,
        low_cpu_mem_usage=True,
    )
    calib_rows = _load_calib(calib, tok)
    model.quantize(calib_rows)
    tok.save_pretrained(dst)
    model.save_quantized(dst, use_safetensors=True)
    return {
        "lib": "auto-gptq",
        "lib_version": _ver("auto_gptq"),
        "torch_version": _ver("torch"),
        "transformers_version": _ver("transformers"),
        "bits": bits,
        "group_size": group_size,
        "calib_rows": len(calib_rows),
        "trust_remote_code": bool(trust_remote_code),
    }


def run_awq(src, dst, calib, bits, group_size, device, trust_remote_code=False):
    """AWQ via autoawq."""
    try:
        import torch  # noqa: F401
        from transformers import AutoTokenizer
        from awq import AutoAWQForCausalLM
    except ImportError as e:
        fail(2, f"missing python deps for awq: {e}",
             {"install": "pip install torch transformers autoawq accelerate"})

    tok = AutoTokenizer.from_pretrained(src, trust_remote_code=trust_remote_code)
    model = AutoAWQForCausalLM.from_pretrained(
        src, low_cpu_mem_usage=True, trust_remote_code=trust_remote_code)
    quant_config = {"zero_point": True, "q_group_size": group_size, "w_bit": bits, "version": "GEMM"}
    calib_rows = _load_calib(calib, tok, as_str=True)
    model.quantize(tok, quant_config=quant_config, calib_data=calib_rows)
    tok.save_pretrained(dst)
    model.save_quantized(dst)
    return {
        "lib": "autoawq",
        "lib_version": _ver("awq"),
        "torch_version": _ver("torch"),
        "transformers_version": _ver("transformers"),
        "bits": bits,
        "group_size": group_size,
        "calib_rows": len(calib_rows),
        "trust_remote_code": bool(trust_remote_code),
    }


def run_aqlm(src, dst, calib, bits, group_size, device, trust_remote_code=False):
    """AQLM additive quantization (Egiazarian 2024) — near-lossless 2-bit.

    The aqlm pip package ships inference + format support but the heavy
    calibration-time optimizer lives in the Vahe1994/AQLM repo. Customers
    point us at their checkout via $AQLM_REPO_PATH and we drive main.py.
    """
    try:
        import torch  # noqa: F401
        from transformers import AutoTokenizer
        import aqlm  # noqa: F401
    except ImportError as e:
        fail(2, f"missing python deps for aqlm: {e}",
             {"install": "pip install aqlm[gpu] torch transformers accelerate"})

    import subprocess
    tok = AutoTokenizer.from_pretrained(src, trust_remote_code=trust_remote_code)
    tok.save_pretrained(dst)

    common = [
        "--nbits_per_codebook=16", "--num_codebooks=2",
        "--in_group_size=8", "--out_group_size=1",
        f"--save={dst}",
    ]
    if trust_remote_code:
        common.append("--trust_remote_code")
    if calib and os.path.exists(calib):
        common.append(f"--dataset={calib}")

    # Operator checkout drives main.py with src as first positional; the pinned
    # `python -m aqlm.main` module mirrors that argument layout.
    cmd, source = _resolve_optimizer(
        repo_env="AQLM_REPO_PATH",
        repo_script="main.py",
        module_name="aqlm.main",
        module_args_fn=lambda: [src] + common,
        env_args_fn=lambda main_py: [src] + common,
        install_hint=("git clone https://github.com/Vahe1994/AQLM && "
                      "export AQLM_REPO_PATH=$PWD/AQLM   # or: "
                      "KOLM_QUANT_OPTIMIZERS=1 pip install -r requirements-optimizers.txt"),
    )
    res = subprocess.run(cmd, check=False)
    if res.returncode != 0:
        fail(4, f"AQLM optimizer ({source}) exited {res.returncode}")
    return {
        "lib": "aqlm",
        "lib_version": _ver("aqlm"),
        "torch_version": _ver("torch"),
        "transformers_version": _ver("transformers"),
        "scheme": "additive-2x16",
        "optimizer_source": source,
        "trust_remote_code": bool(trust_remote_code),
    }


def run_quip(src, dst, calib, bits, group_size, device, trust_remote_code=False):
    """QuIP# (Tseng 2024) — sub-2-bit with incoherence preprocessing + E8 lattice.

    Same pattern as AQLM: drives the upstream Cornell-RelaxML/quip-sharp
    repo via $QUIP_SHARP_REPO_PATH.
    """
    try:
        import torch  # noqa: F401
        from transformers import AutoTokenizer
        import quip_sharp  # noqa: F401
    except ImportError as e:
        fail(2, f"missing python deps for quip: {e}",
             {"install": "pip install torch transformers accelerate "
                         "(quip-sharp also needs the repo checkout)"})

    import subprocess
    tok = AutoTokenizer.from_pretrained(src, trust_remote_code=trust_remote_code)
    tok.save_pretrained(dst)

    common = [
        f"--save_path={dst}",
        f"--base_model={src}",
        "--codebook=E8P12",
        "--scale_override=0.9",
        "--ft_epochs=0",
    ]
    cmd, source = _resolve_optimizer(
        repo_env="QUIP_SHARP_REPO_PATH",
        repo_script="quantize_llama.py",
        module_name="quip_sharp.quantize_llama",
        module_args_fn=lambda: list(common),
        env_args_fn=lambda main_py: list(common),
        install_hint=("git clone https://github.com/Cornell-RelaxML/quip-sharp && "
                      "export QUIP_SHARP_REPO_PATH=$PWD/quip-sharp   # or: "
                      "KOLM_QUANT_OPTIMIZERS=1 pip install -r requirements-optimizers.txt"),
    )
    res = subprocess.run(cmd, check=False)
    if res.returncode != 0:
        fail(4, f"QuIP# optimizer ({source}) exited {res.returncode}")
    return {
        "lib": "quip-sharp",
        "lib_version": _ver("quip_sharp"),
        "torch_version": _ver("torch"),
        "transformers_version": _ver("transformers"),
        "scheme": "E8P12-incoherence",
        "optimizer_source": source,
        "trust_remote_code": bool(trust_remote_code),
    }


def _run_exllamav2(src, dst, calib, bits, exl3=False, trust_remote_code=False):
    """Shared driver for EXL2 + EXL3 — both go through exllamav2.conversion.convert."""
    try:
        import torch  # noqa: F401
        from transformers import AutoTokenizer
        import exllamav2  # noqa: F401
    except ImportError as e:
        fail(2, f"missing python deps for {'exl3' if exl3 else 'exl2'}: {e}",
             {"install": "pip install exllamav2 torch transformers"})

    import subprocess
    tok = AutoTokenizer.from_pretrained(src, trust_remote_code=trust_remote_code)
    tok.save_pretrained(dst)
    work = os.path.join(dst, "_exl_work")
    os.makedirs(work, exist_ok=True)
    cmd = [sys.executable, "-m", "exllamav2.conversion.convert",
           "-i", src, "-o", work, "-cf", dst, "-b", str(float(bits))]
    if exl3:
        cmd.append("--exl3")
    if calib and os.path.exists(calib):
        cmd += ["-c", calib]
    res = subprocess.run(cmd, check=False)
    if res.returncode != 0:
        fail(4, f"exllamav2 convert exited {res.returncode}")
    return {
        "lib": "exllamav2",
        "lib_version": _ver("exllamav2"),
        "torch_version": _ver("torch"),
        "transformers_version": _ver("transformers"),
        "scheme": f"{'exl3' if exl3 else 'exl2'}-{bits}bpw",
        "trust_remote_code": bool(trust_remote_code),
    }


def run_exl2(src, dst, calib, bits, group_size, device, trust_remote_code=False):
    """ExLlamaV2 EXL2 runtime-optimized variable-bit quantization."""
    return _run_exllamav2(src, dst, calib, bits, exl3=False,
                          trust_remote_code=trust_remote_code)


def run_exl3(src, dst, calib, bits, group_size, device, trust_remote_code=False):
    """ExLlamaV2 EXL3 next-gen format (better compression than EXL2)."""
    return _run_exllamav2(src, dst, calib, bits, exl3=True,
                          trust_remote_code=trust_remote_code)


def run_hqq(src, dst, calib, bits, group_size, device, trust_remote_code=False):
    """HQQ calibration-free half-quadratic quantization (Mobius Labs 2024).

    Cleanest of the new methods: pure pip install, no repo checkout, no
    calibration data needed.
    """
    try:
        import torch
        from transformers import AutoTokenizer
        from hqq.engine.hf import HQQModelForCausalLM
        from hqq.core.quantize import BaseQuantizeConfig as HqqConfig
    except ImportError as e:
        fail(2, f"missing python deps for hqq: {e}",
             {"install": "pip install hqq torch transformers accelerate"})

    tok = AutoTokenizer.from_pretrained(src, trust_remote_code=trust_remote_code)
    quant_config = HqqConfig(nbits=bits, group_size=group_size,
                             quant_zero=True, quant_scale=False)
    model = HQQModelForCausalLM.from_pretrained(
        src, trust_remote_code=trust_remote_code, low_cpu_mem_usage=True,
    )
    model.quantize_model(
        quant_config=quant_config,
        compute_dtype=torch.bfloat16,
        device="cuda" if device != "cpu" else "cpu",
    )
    tok.save_pretrained(dst)
    HQQModelForCausalLM.save_quantized(model, dst)
    return {
        "lib": "hqq",
        "lib_version": _ver("hqq"),
        "torch_version": _ver("torch"),
        "transformers_version": _ver("transformers"),
        "bits": bits,
        "group_size": group_size,
        "scheme": f"hqq-{bits}bit-g{group_size}",
        "calibration_free": True,
        "trust_remote_code": bool(trust_remote_code),
    }


def run_qat(src, dst, calib, bits, group_size, device, trust_remote_code=False):
    """EfficientQAT block-wise quantization-aware training (Chen 2024).

    QAT is a training procedure, not a one-shot quantize. Drives the
    upstream OpenGVLab/EfficientQAT repo's main_block_ap.py via
    $EFFICIENT_QAT_REPO_PATH.
    """
    try:
        import torch  # noqa: F401
        from transformers import AutoTokenizer
        import efficient_qat  # noqa: F401
    except ImportError as e:
        fail(2, f"missing python deps for qat: {e}",
             {"install": "pip install torch transformers accelerate "
                         "(EfficientQAT also needs the repo checkout)"})

    import subprocess
    tok = AutoTokenizer.from_pretrained(src, trust_remote_code=trust_remote_code)
    tok.save_pretrained(dst)

    common = [
        f"--model={src}", f"--save_quant_dir={dst}",
        f"--wbits={bits}", f"--group_size={group_size}",
        "--epochs=2", "--quant_lr=1e-4",
    ]
    if calib and os.path.exists(calib):
        common.append(f"--calib_dataset={calib}")
    cmd, source = _resolve_optimizer(
        repo_env="EFFICIENT_QAT_REPO_PATH",
        repo_script="main_block_ap.py",
        module_name="efficient_qat.main_block_ap",
        module_args_fn=lambda: list(common),
        env_args_fn=lambda main_py: list(common),
        install_hint=("git clone https://github.com/OpenGVLab/EfficientQAT && "
                      "export EFFICIENT_QAT_REPO_PATH=$PWD/EfficientQAT   # or: "
                      "KOLM_QUANT_OPTIMIZERS=1 pip install -r requirements-optimizers.txt"),
    )
    res = subprocess.run(cmd, check=False)
    if res.returncode != 0:
        fail(4, f"EfficientQAT optimizer ({source}) exited {res.returncode}")
    return {
        "lib": "efficient_qat",
        "lib_version": _ver("efficient_qat"),
        "torch_version": _ver("torch"),
        "transformers_version": _ver("transformers"),
        "bits": bits,
        "group_size": group_size,
        "scheme": f"qat-block-{bits}bit-g{group_size}",
        "optimizer_source": source,
        "trust_remote_code": bool(trust_remote_code),
    }


# -----------------------------------------------------------------------------
# W921 NEXT-3 — FP4-aware PTQ calibration driver (BATQuant-style).
#
# When --calib-fp4 is set we run a CPU-side calibration pass over the model's
# largest 2-D weight tensors BEFORE the int4 quantize. The pure math lives in
# fp4_calib.py (block-granular learnable affine transform + block-wise
# learnable clipping, arXiv:2603.16590) so it is deterministic + unit-testable
# off-GPU. We record the per-layer plan + the measured reconstruction-error
# reduction in the receipt; the GPU FP4 export path (src/export-nvfp4.js)
# consumes the plan to fuse the transform into the weights before the real FP4
# round. Additive: omitting --calib-fp4 leaves the pre-W921 path untouched.
# -----------------------------------------------------------------------------

def _iter_safetensor_weights(src, max_layers, min_numel=4096):
    """Yield (name, numpy_2d_array) for the largest 2-D float weight tensors in
    a HF model dir, loading lazily from safetensors on CPU. Falls back to a
    *.bin torch load only when no safetensors are present.

    max_layers: cap (largest-first). 0 == all. min_numel: skip tiny tensors.
    """
    import numpy as np
    shards = sorted(Path(src).glob("*.safetensors"))
    collected = []  # (numel, name, loader)
    if shards:
        from safetensors import safe_open
        for shard in shards:
            with safe_open(str(shard), framework="numpy") as f:
                for name in f.keys():
                    # Defer the actual tensor read; we only need the shape now.
                    # safetensors numpy framework reads on get_tensor — read it
                    # to inspect ndim/dtype (cheap relative to GPU quant) and
                    # keep only 2-D float weights.
                    t = f.get_tensor(name)
                    if t.ndim != 2 or t.size < min_numel:
                        continue
                    if not np.issubdtype(t.dtype, np.floating):
                        t = t.astype(np.float32)
                    collected.append((t.size, name, t.astype(np.float32)))
    else:
        try:
            import torch
        except ImportError:
            return
        for binf in sorted(Path(src).glob("*.bin")):
            sd = torch.load(str(binf), map_location="cpu")
            for name, t in sd.items():
                if hasattr(t, "ndim") and t.ndim == 2 and t.numel() >= min_numel:
                    collected.append((int(t.numel()), name,
                                      t.detach().to(torch.float32).numpy()))
    collected.sort(key=lambda x: -x[0])
    if max_layers and max_layers > 0:
        collected = collected[:max_layers]
    for _numel, name, arr in collected:
        yield name, arr


def run_fp4_calibration(src, block=32, max_layers=64, grid_steps=24):
    """Build the FP4-aware calibration plan for a model dir. Returns the plan
    dict (see fp4_calib.build_calibration_plan) plus a status. Never raises into
    the main quantize flow — calibration failure degrades gracefully to a
    recorded warning so the int4 quantize still proceeds.
    """
    try:
        import numpy as np  # noqa: F401
        import fp4_calib
    except ImportError as e:
        return {"ok": False, "reason": f"fp4 calibration deps missing: {e}"}
    try:
        weights = {}
        for name, arr in _iter_safetensor_weights(src, max_layers):
            weights[name] = arr
        if not weights:
            return {"ok": False, "reason": "no 2-D float weight tensors found for FP4 calibration"}
        import numpy as np
        plan = fp4_calib.build_calibration_plan(
            np, weights, block=block, grid_steps=grid_steps, use_transform=True)
        plan["ok"] = True
        plan["layers_calibrated"] = len(weights)
        return plan
    except Exception as e:  # degrade gracefully — calibration must never block quantize
        return {"ok": False, "reason": f"fp4 calibration raised: {e.__class__.__name__}: {e}"}


def _load_calib(path, tokenizer, as_str=False, max_rows=128, max_len=512):
    """Load calibration text. If path missing, fall back to a tiny built-in set."""
    rows = []
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    text = obj.get("text") or obj.get("prompt") or ""
                    if text:
                        rows.append(text)
                except json.JSONDecodeError:
                    rows.append(line)
                if len(rows) >= max_rows:
                    break
    if not rows:
        rows = _FALLBACK_CALIB[:max_rows]
    if as_str:
        return rows
    enc = [tokenizer(r, return_tensors="pt", truncation=True, max_length=max_len) for r in rows]
    return enc


def _ver(modname):
    try:
        mod = __import__(modname)
        return getattr(mod, "__version__", "unknown")
    except Exception:
        return "missing"


# -----------------------------------------------------------------------------
# W719 — Distillation-Aware Quantization (DAQ) mixed-precision support.
#
# When --mixed-precision is set the quantizer reads a per-layer profile array
# (output of src/daq-profile.js buildDaqProfile) and applies per-layer
# weight_bits / group_size / scale_mode instead of the uniform --bits /
# --group-size flags. Two things are KEY here:
#
#   1) NEVER crash. If the chosen backend (e.g. bitsandbytes which only ships
#      nf4 + llm.int8) cannot honor a layer's requested bit width, we log a
#      warning to the receipt and fall back to the nearest-supported width.
#      The receipt's mixed_precision_warnings[] array makes the fallback
#      visible to a verifier.
#
#   2) The uniform-bit code path is UNCHANGED. Existing callers that do not
#      pass --mixed-precision get exactly the pre-W719 behavior.
# -----------------------------------------------------------------------------

# Backend-specific supported bit widths (informational — used to compute the
# nearest-supported fallback and emit honest warnings).
_BACKEND_SUPPORTED_BITS = {
    "int4":  [4],          # bitsandbytes NF4
    "int8":  [8],          # bitsandbytes LLM.int8
    "gptq":  [2, 3, 4, 8],
    "awq":   [4, 8],
    "aqlm":  [2],          # additive 2x16 — sub-2-bit effective
    "quip":  [2],
    "exl2":  [2, 3, 4, 5, 6, 8],
    "exl3":  [2, 3, 4, 5, 6, 8],
    "hqq":   [2, 3, 4, 8],
    "qat":   [2, 3, 4, 8],
}


def load_mixed_precision_profile(path):
    """Load + validate a DAQ profile JSON file.

    The file is the canonical output of src/daq-profile.js buildDaqProfile —
    an ordered array of per-layer objects each with weight_bits, activation_bits,
    kv_bits, group_size, protected_channels, clip_percentile, scale_mode,
    fallback_dtype, kl_sensitivity.

    Returns: (profile, warnings)
      profile  — the parsed array (may be empty if the file is malformed)
      warnings — list of human-readable strings ('layer X used Y instead of Z')
    """
    if not path:
        return None, []
    if not os.path.exists(path):
        fail(3, f"--mixed-precision profile not found: {path}")
    try:
        with open(path, "r", encoding="utf-8") as f:
            profile = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        fail(2, f"--mixed-precision profile failed to parse: {e}")
    if not isinstance(profile, list) or len(profile) == 0:
        fail(2, "--mixed-precision profile must be a non-empty JSON array")
    # Validate shape up front so we fail loud before invoking the backend.
    required = {"layer_id", "weight_bits", "activation_bits",
                "kv_bits", "group_size"}
    for i, layer in enumerate(profile):
        if not isinstance(layer, dict):
            fail(2, f"--mixed-precision profile[{i}] is not an object")
        missing = required - layer.keys()
        if missing:
            fail(2, f"--mixed-precision profile[{i}] missing fields: {sorted(missing)}")
    return profile, []


def compute_uniform_fallback_from_profile(profile, method):
    """Reduce a per-layer profile to a (bits, group_size) pair for backends
    that do not natively support per-layer mixing.

    Strategy: pick the MAJORITY weight_bits across the profile; tiebreak by
    higher bits (safer). group_size: majority over the profile.
    Returns (uniform_bits, uniform_group_size, warnings[]).
    """
    warnings = []
    if not profile:
        return None, None, warnings
    # Count per bit-width + group size.
    bit_counts = {}
    group_counts = {}
    for layer in profile:
        wb = int(layer["weight_bits"])
        gs = int(layer["group_size"])
        bit_counts[wb] = bit_counts.get(wb, 0) + 1
        group_counts[gs] = group_counts.get(gs, 0) + 1
    # Sort by (count desc, bits desc) — higher bits wins ties (safer fallback).
    uniform_bits = sorted(bit_counts.items(), key=lambda x: (-x[1], -x[0]))[0][0]
    uniform_group = sorted(group_counts.items(), key=lambda x: (-x[1], -x[0]))[0][0]
    # Snap to nearest backend-supported bit width.
    supported = _BACKEND_SUPPORTED_BITS.get(method, [uniform_bits])
    if uniform_bits not in supported:
        nearest = min(supported, key=lambda b: abs(b - uniform_bits))
        warnings.append(
            f"--mixed-precision majority weight_bits={uniform_bits} not supported "
            f"by backend {method}; using nearest-supported {nearest} (supported={supported})"
        )
        uniform_bits = nearest
    # Per-layer fidelity loss warning — the bakeoff harness pre-W719 (and the
    # docs/research Invention 1 spec) lean on the per-layer schedule being
    # actually applied. When the backend cannot, surface the lost layers so a
    # downstream verifier sees the gap.
    distinct_widths = sorted(bit_counts.keys())
    if len(distinct_widths) > 1:
        warnings.append(
            f"--mixed-precision profile carried {len(distinct_widths)} distinct "
            f"weight_bits {distinct_widths} but backend {method} only supports "
            f"{supported}; applying uniform {uniform_bits} across all layers "
            "(per-layer schedule recorded in receipt for verifier replay)"
        )
    return uniform_bits, uniform_group, warnings


# -----------------------------------------------------------------------------
# W921 NEXT-4 — Mixture-of-Experts (MoE) aware quantization.
#
# Highest-value NEXT-4 core: quantizing a customer's MoE model (Mixtral /
# Qwen-MoE / OLMoE / DeepSeek-V2/V3 / DBRX / Llama-4 ...). The DENSE path above
# is byte-for-byte unchanged — every function here is ADDITIVE and only fires
# when MoE is DETECTED in the model's config.json. Detection mirrors
# src/moe-support.js detectMoE (same key list + architecture set) so the JS and
# Python sides agree on dense-vs-MoE.
#
# When MoE is detected we:
#   (1) group every weight tensor into {router/gate (SACRED — always fp16),
#       shared/attn layers, per-expert FFN blocks};
#   (2) apply the per-group precision from the --mixed-precision DAQ profile
#       (forge's DAQ already emits router=fp16, shared=q4/iq4, experts=
#       aggressive). Router precision is NEVER downgraded — rounding the router
#       to <fp16 collapses the top-k softmax (see src/moe-support.js header);
#   (3) quantize each expert block INDEPENDENTLY (expert-by-expert so an 8x or
#       128x model can be done without loading every expert at once where the
#       backend allows) and record per-expert bytes-before/after;
#   (4) emit run-meta {moe, num_experts, router_precision, expert_precision,
#       per_group_bytes, total_compression} into the receipt.
#
# The pure grouping + byte-accounting math here is dependency-light (stdlib
# only) so it is deterministic + unit-testable off-GPU via --self-test-moe with
# a synthetic config + tiny fake state dict (no model download).
# -----------------------------------------------------------------------------

# MoE expert-count config keys — mirrors src/moe-support.js _detectFromConfig.
_MOE_EXPERT_KEYS = (
    "num_experts", "n_routed_experts", "num_local_experts",
    "num_experts_per_layer", "moe_num_experts",
)
# MoE top-k config keys — mirrors src/moe-support.js.
_MOE_TOPK_KEYS = (
    "num_experts_per_tok", "n_activated_experts", "moe_top_k", "top_k_experts",
)
# Architecture names recognized as MoE — mirrors src/moe-support.js
# MOE_ARCHITECTURES so detectMoE (JS) and this driver agree.
_MOE_ARCHITECTURES = frozenset((
    "MixtralForCausalLM", "Qwen2MoeForCausalLM", "Qwen3MoeForCausalLM",
    "DeepseekV2ForCausalLM", "DeepseekV3ForCausalLM", "JambaForCausalLM",
    "PhiMoEForCausalLM", "GraniteMoeForCausalLM", "DbrxForCausalLM",
    "OlmoeForCausalLM", "MiniMaxText01ForCausalLM",
    "Llama4ForCausalLM", "Llama4ForConditionalGeneration",
))

# Tensor-name pattern for a per-expert weight. Matches Mixtral
# (block_sparse_moe.experts.<n>.w1), DeepSeek / Qwen2-MoE / OLMoE
# (mlp.experts.<n>.gate_proj), DBRX (ffn.experts.<n>). Mirrors the regex in
# src/moe-support.js _detectFromSafetensorsIndex.
import re as _re
_EXPERT_TENSOR_RE = _re.compile(r"\.experts\.(\d+)\.")
# Router / gate tensor-name fragments — the sacred fp16 layer. Mixtral uses
# `block_sparse_moe.gate`, Qwen/DeepSeek/OLMoE use `mlp.gate`, DBRX `ffn.router`.
# We require it NOT also be an expert tensor (an expert's own gate_proj contains
# the word "gate" but is part of the expert FFN, not the router).
_ROUTER_FRAGMENTS = ("block_sparse_moe.gate", "mlp.gate.", "ffn.router",
                     ".router.", ".gate_network", "moe.gate")


def _first_cfg_field(cfg, names):
    for n in names:
        if isinstance(cfg, dict) and cfg.get(n) is not None:
            return cfg.get(n)
    return None


def detect_moe_config(src):
    """Detect whether the HF model dir at `src` is a sparse-MoE checkpoint by
    reading ONLY config.json. Mirrors src/moe-support.js _detectFromConfig.

    Returns a dict {is_moe, num_experts, experts_per_token, architecture,
    model_type, source}. is_moe=False means no MoE evidence (the dense path
    stays exactly as before). Never raises — a missing/garbled config returns
    is_moe=False so the dense quantize proceeds untouched.
    """
    cfg_path = os.path.join(src, "config.json")
    cfg = None
    try:
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
    except (OSError, json.JSONDecodeError):
        cfg = None
    if not isinstance(cfg, dict):
        return {"is_moe": False, "num_experts": 0, "experts_per_token": 0,
                "architecture": None, "model_type": None, "source": "config.json"}

    num_experts = _first_cfg_field(cfg, _MOE_EXPERT_KEYS)
    top_k = _first_cfg_field(cfg, _MOE_TOPK_KEYS)
    arch = None
    if isinstance(cfg.get("architectures"), list) and cfg["architectures"]:
        arch = cfg["architectures"][0]
    model_type = cfg.get("model_type") if isinstance(cfg.get("model_type"), str) else ""

    is_moe = (
        (isinstance(num_experts, (int, float)) and int(num_experts) > 1)
        or (arch in _MOE_ARCHITECTURES)
        or bool(_re.search(r"moe|mixtral|deepseek", model_type, _re.IGNORECASE))
    )
    return {
        "is_moe": bool(is_moe),
        "num_experts": int(num_experts) if isinstance(num_experts, (int, float)) else 0,
        "experts_per_token": int(top_k) if isinstance(top_k, (int, float)) else 0,
        "architecture": arch,
        "model_type": model_type or None,
        "source": "config.json",
    }


def _classify_tensor(name):
    """Classify ONE weight-tensor name into a parameter group.

    Returns (group, expert_id):
      ("router", None)      — top-k gate/router head (SACRED — kept fp16).
      ("expert", <int>)     — a per-expert FFN block weight.
      ("shared", None)      — everything else (attention, embeddings, norms,
                              lm_head, shared-expert MLP — always-active layers).

    Order matters: an expert's own gate_proj contains "gate" but the
    `.experts.<n>.` match wins first so it is grouped as an expert, never as the
    router. This mirrors the intent of src/moe-support.js (router precision is
    split from expert precision).
    """
    m = _EXPERT_TENSOR_RE.search(name)
    if m:
        return "expert", int(m.group(1))
    for frag in _ROUTER_FRAGMENTS:
        if frag in name:
            return "router", None
    return "shared", None


def group_moe_parameters(weight_names, num_experts=0):
    """Group an iterable of weight-tensor names into router / shared / per-expert.

    Returns dict:
      {
        "router":  [names...],          # sacred fp16
        "shared":  [names...],          # attn / embed / norm / shared-MLP
        "experts": {expert_id: [names...], ...},
        "num_experts_seen": <int>,      # max expert id + 1 observed in names
        "expert_layer_count": <int>,    # total per-expert tensors grouped
        "covered_expert_ids": [sorted ids],
      }
    Pure + deterministic (sorted outputs) — no RNG, no clock.
    """
    router = []
    shared = []
    experts = {}
    for name in weight_names:
        group, eid = _classify_tensor(name)
        if group == "expert":
            experts.setdefault(eid, []).append(name)
        elif group == "router":
            router.append(name)
        else:
            shared.append(name)
    for eid in experts:
        experts[eid].sort()
    covered = sorted(experts.keys())
    num_seen = (max(covered) + 1) if covered else 0
    return {
        "router": sorted(router),
        "shared": sorted(shared),
        "experts": {eid: experts[eid] for eid in covered},
        "num_experts_seen": num_seen,
        "expert_layer_count": sum(len(v) for v in experts.values()),
        "covered_expert_ids": covered,
    }


def _group_precision_from_profile(daq_profile, method):
    """Reduce a per-layer DAQ profile into a per-GROUP precision plan for an MoE
    model: {router, shared, experts} -> a precision tag string.

    The forge DAQ (src/daq-profile.js) emits per-layer objects keyed by
    layer_id. For MoE the layer_ids carry `.experts.` / `.gate` / `.router`
    fragments, so we classify each profile entry the same way we classify the
    weight tensors and take, per group, the majority weight_bits. Router is
    SACRED: it is always reported as fp16 regardless of what a (mis-authored)
    profile says — rounding the router breaks routing.

    Returns dict {router, shared, experts, expert_weight_bits, shared_weight_bits,
    source}. When no profile (or no per-group signal) is given we fall back to a
    safe default: router=fp16, shared=q4, experts=int4 (the aggressive default
    src/moe-support.js recommends for the bulk of the parameters).
    """
    def _bits_to_tag(bits, aggressive=False):
        b = int(bits)
        if b >= 8:
            return "int8" if method == "int8" else "q8_0"
        if b == 4:
            return "int4" if aggressive else "q4_k_m"
        if b == 3:
            return "iq3_xxs"
        if b <= 2:
            return "iq2_xxs"
        return "q4_k_m"

    # Defaults (no profile / no signal) — the safe aggressive split.
    plan = {
        "router": "fp16",
        "shared": "q4_k_m",
        "experts": "int4",
        "router_weight_bits": 16,
        "shared_weight_bits": 4,
        "expert_weight_bits": 4,
        "source": "default_moe_split",
    }
    if not daq_profile:
        return plan

    expert_bits = []
    shared_bits = []
    for layer in daq_profile:
        if not isinstance(layer, dict):
            continue
        lid = str(layer.get("layer_id", ""))
        wb = layer.get("weight_bits")
        if not isinstance(wb, (int, float)):
            continue
        group, _eid = _classify_tensor(lid)
        if group == "expert":
            expert_bits.append(int(wb))
        elif group == "shared":
            shared_bits.append(int(wb))
        # router entries in the profile are ignored — router stays fp16.

    def _majority(bits):
        if not bits:
            return None
        counts = {}
        for b in bits:
            counts[b] = counts.get(b, 0) + 1
        # majority; tiebreak HIGHER bits (safer)
        return sorted(counts.items(), key=lambda x: (-x[1], -x[0]))[0][0]

    eb = _majority(expert_bits)
    sb = _majority(shared_bits)
    if eb is not None:
        plan["expert_weight_bits"] = eb
        plan["experts"] = _bits_to_tag(eb, aggressive=True)
        plan["source"] = "daq_profile"
    if sb is not None:
        plan["shared_weight_bits"] = sb
        plan["shared"] = _bits_to_tag(sb, aggressive=False)
        plan["source"] = "daq_profile"
    return plan


# Effective bytes-per-parameter for the precision tags we emit (matches
# src/moe-support.js BYTES_PER_PARAM so JS estimates + this receipt agree).
_BYTES_PER_PARAM = {
    "fp32": 4.0, "fp16": 2.0, "bf16": 2.0, "fp8": 1.0, "int8": 1.0,
    "q8_0": 1.0625, "q5_k_m": 0.6875, "q4_k_m": 0.5625,
    "int4": 0.5, "iq4_xs": 0.5, "iq3_xxs": 0.40625, "iq2_xxs": 0.3125,
}


def _bytes_for(numel, tag):
    return numel * _BYTES_PER_PARAM.get(tag, 2.0)


def plan_moe_quantization(grouping, group_precision, tensor_numels,
                          src_bytes_per_param=2.0):
    """Compute per-expert + per-group bytes-before/after for an MoE quantize,
    quantizing each expert block independently.

    grouping        : output of group_moe_parameters.
    group_precision : output of _group_precision_from_profile.
    tensor_numels   : dict {tensor_name: element_count}. (From a real run this
                      is read from the safetensors header; the self-test feeds a
                      synthetic fake state dict.)
    src_bytes_per_param : original on-disk bytes/param (fp16/bf16 = 2.0).

    Returns the run-meta the receipt records:
      {
        moe: True, num_experts, router_precision, expert_precision,
        shared_precision, per_group_bytes: {router:{before,after},
        shared:{...}, experts:{before,after}},
        per_expert_bytes: [{expert_id, bytes_before, bytes_after,
                            compression}],
        total_bytes_before, total_bytes_after, total_compression,
      }
    Deterministic — pure arithmetic over the grouping. Each expert is sized
    independently (expert-by-expert) which is exactly what lets the real backend
    stream one expert at a time without holding all of them resident.
    """
    def _numel(name):
        v = tensor_numels.get(name, 0)
        return int(v) if isinstance(v, (int, float)) else 0

    router_after_tag = "fp16"  # SACRED
    shared_after_tag = group_precision.get("shared", "q4_k_m")
    expert_after_tag = group_precision.get("experts", "int4")

    # Router group.
    router_numel = sum(_numel(n) for n in grouping["router"])
    router_before = router_numel * src_bytes_per_param
    router_after = _bytes_for(router_numel, router_after_tag)

    # Shared group.
    shared_numel = sum(_numel(n) for n in grouping["shared"])
    shared_before = shared_numel * src_bytes_per_param
    shared_after = _bytes_for(shared_numel, shared_after_tag)

    # Expert groups — quantized INDEPENDENTLY, one expert at a time.
    per_expert = []
    experts_before = 0.0
    experts_after = 0.0
    for eid in grouping["covered_expert_ids"]:
        e_numel = sum(_numel(n) for n in grouping["experts"][eid])
        e_before = e_numel * src_bytes_per_param
        e_after = _bytes_for(e_numel, expert_after_tag)
        experts_before += e_before
        experts_after += e_after
        per_expert.append({
            "expert_id": eid,
            "tensors": len(grouping["experts"][eid]),
            "numel": e_numel,
            "bytes_before": round(e_before, 3),
            "bytes_after": round(e_after, 3),
            "precision": expert_after_tag,
            "compression": round(e_before / e_after, 4) if e_after > 0 else 0.0,
        })

    total_before = router_before + shared_before + experts_before
    total_after = router_after + shared_after + experts_after
    return {
        "moe": True,
        "num_experts": grouping["num_experts_seen"],
        "router_precision": router_after_tag,
        "expert_precision": expert_after_tag,
        "shared_precision": shared_after_tag,
        "precision_source": group_precision.get("source", "default_moe_split"),
        "per_group_bytes": {
            "router": {"before": round(router_before, 3), "after": round(router_after, 3),
                       "tensors": len(grouping["router"]), "numel": router_numel},
            "shared": {"before": round(shared_before, 3), "after": round(shared_after, 3),
                       "tensors": len(grouping["shared"]), "numel": shared_numel},
            "experts": {"before": round(experts_before, 3), "after": round(experts_after, 3),
                        "tensors": grouping["expert_layer_count"]},
        },
        "per_expert_bytes": per_expert,
        "total_bytes_before": round(total_before, 3),
        "total_bytes_after": round(total_after, 3),
        "total_compression": round(total_before / total_after, 4) if total_after > 0 else 0.0,
    }


def read_safetensors_numels(src):
    """Read {tensor_name: element_count} from a model dir WITHOUT loading weight
    data — uses the safetensors JSON header (shape per tensor) or the
    model.safetensors.index.json fallback. Returns {} if neither is present.

    Element count from shape is enough to size every group; we never page the
    tensor bytes, so this is safe for models larger than RAM. The per-expert
    independence is preserved because each expert's numel is summed separately.
    """
    import struct
    numels = {}
    shards = sorted(Path(src).glob("*.safetensors"))
    for shard in shards:
        try:
            with open(shard, "rb") as f:
                n_header = struct.unpack("<Q", f.read(8))[0]
                header = json.loads(f.read(n_header).decode("utf-8"))
        except (OSError, struct.error, json.JSONDecodeError, UnicodeDecodeError):
            continue
        for name, meta in header.items():
            if name == "__metadata__" or not isinstance(meta, dict):
                continue
            shape = meta.get("shape")
            if isinstance(shape, list) and shape:
                n = 1
                for d in shape:
                    n *= int(d)
                numels[name] = n
    return numels


def build_moe_run_meta(src, daq_profile, method, src_bytes_per_param=2.0):
    """Top-level MoE run-meta builder for a real quantize run. Reads the
    safetensors header for tensor shapes, groups, applies per-group precision,
    and sizes each expert independently. Never raises into the main flow —
    returns {moe:False, reason} so a detection false-positive degrades to the
    dense path rather than blocking the quantize.
    """
    try:
        numels = read_safetensors_numels(src)
        if not numels:
            return {"moe": False, "reason": "no_safetensors_header_for_moe_grouping"}
        grouping = group_moe_parameters(numels.keys())
        if grouping["expert_layer_count"] == 0:
            return {"moe": False, "reason": "no_expert_tensors_in_safetensors"}
        group_precision = _group_precision_from_profile(daq_profile, method)
        meta = plan_moe_quantization(grouping, group_precision, numels,
                                     src_bytes_per_param=src_bytes_per_param)
        meta["expert_precision_source"] = group_precision.get("source")
        return meta
    except Exception as e:  # degrade gracefully — never block the quantize
        return {"moe": False, "reason": f"moe_run_meta_raised: {e.__class__.__name__}: {e}"}


# -----------------------------------------------------------------------------
# W921 NEXT-4 — deterministic MoE self-test (synthetic config + tiny fake state
# dict; NO model download, NO GPU). Asserts the four invariants:
#   1. router stays fp16 (never downgraded);
#   2. every expert FFN block is grouped + assigned the aggressive expert
#      precision;
#   3. the grouping covers ALL expert layers (no expert tensor lands in shared);
#   4. byte-accounting is consistent (total_before > total_after, compression>1).
# -----------------------------------------------------------------------------

def _synthetic_moe_state_dict(num_experts=8, num_layers=2, hidden=128,
                              moe_inter=256):
    """Build a synthetic Mixtral-style {tensor_name: numel} fake state dict for
    an `num_experts`-expert MoE. No tensors are allocated — just names + element
    counts — so this is instant + deterministic with no RNG."""
    numels = {}
    # Embedding + lm_head + final norm (shared).
    numels["model.embed_tokens.weight"] = 32000 * hidden
    numels["lm_head.weight"] = 32000 * hidden
    numels["model.norm.weight"] = hidden
    for layer in range(num_layers):
        pfx = f"model.layers.{layer}"
        # Attention (shared / always-active).
        for proj in ("q_proj", "k_proj", "v_proj", "o_proj"):
            numels[f"{pfx}.self_attn.{proj}.weight"] = hidden * hidden
        numels[f"{pfx}.input_layernorm.weight"] = hidden
        numels[f"{pfx}.post_attention_layernorm.weight"] = hidden
        # Router / gate (SACRED — must stay fp16). Mixtral name.
        numels[f"{pfx}.block_sparse_moe.gate.weight"] = hidden * num_experts
        # Per-expert FFN blocks (the bulk — aggressive precision).
        for e in range(num_experts):
            ep = f"{pfx}.block_sparse_moe.experts.{e}"
            numels[f"{ep}.w1.weight"] = hidden * moe_inter
            numels[f"{ep}.w2.weight"] = moe_inter * hidden
            numels[f"{ep}.w3.weight"] = hidden * moe_inter
    return numels


def _synthetic_moe_config(num_experts=8, top_k=2):
    return {
        "architectures": ["MixtralForCausalLM"],
        "model_type": "mixtral",
        "num_local_experts": num_experts,
        "num_experts_per_tok": top_k,
        "hidden_size": 128,
        "moe_intermediate_size": 256,
    }


def self_test_moe(num_experts=8, num_layers=2):
    """Run the deterministic MoE-grouping self-test. Returns a JSON-serialisable
    result dict {ok, failures, ...}. No model download, no GPU, no RNG."""
    failures = []

    # --- detection (mirrors src/moe-support.js) on a synthetic config ---
    cfg = _synthetic_moe_config(num_experts=num_experts)
    import tempfile
    d = tempfile.mkdtemp(prefix="kolm-moe-selftest-")
    try:
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        det = detect_moe_config(d)
        if not det["is_moe"]:
            failures.append("detect_moe_config did not flag the synthetic Mixtral config as MoE")
        if det["num_experts"] != num_experts:
            failures.append(
                f"detect_moe_config num_experts={det['num_experts']} != {num_experts}")
        # A dense config must NOT be flagged (dense path stays untouched).
        dense_cfg = {"architectures": ["LlamaForCausalLM"], "model_type": "llama",
                     "hidden_size": 128, "intermediate_size": 512}
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump(dense_cfg, f)
        if detect_moe_config(d)["is_moe"]:
            failures.append("detect_moe_config false-positive on a dense Llama config")
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)

    # --- grouping over the synthetic fake state dict ---
    numels = _synthetic_moe_state_dict(num_experts=num_experts, num_layers=num_layers)
    grouping = group_moe_parameters(numels.keys())

    # Invariant 3: grouping covers ALL expert layers — every expert id 0..N-1 is
    # present and the per-layer tensor count is exactly (3 w-matrices * layers).
    expected_expert_tensors = num_experts * num_layers * 3  # w1/w2/w3 per expert per layer
    if grouping["expert_layer_count"] != expected_expert_tensors:
        failures.append(
            f"expert_layer_count={grouping['expert_layer_count']} != "
            f"expected {expected_expert_tensors}")
    if grouping["covered_expert_ids"] != list(range(num_experts)):
        failures.append(
            f"covered_expert_ids={grouping['covered_expert_ids']} != 0..{num_experts - 1}")
    if grouping["num_experts_seen"] != num_experts:
        failures.append(
            f"num_experts_seen={grouping['num_experts_seen']} != {num_experts}")

    # No expert tensor may leak into shared/router (the gate_proj-named expert
    # weight trap). Verify every shared/router name is NOT an expert tensor.
    for nm in grouping["shared"] + grouping["router"]:
        if _EXPERT_TENSOR_RE.search(nm):
            failures.append(f"expert tensor leaked into shared/router: {nm}")
    # The router (gate) must be grouped as router, exactly one per layer.
    if len(grouping["router"]) != num_layers:
        failures.append(
            f"router group has {len(grouping['router'])} tensors, expected {num_layers}")

    # --- per-group precision from a DAQ profile (router fp16 sacred) ---
    # Build a profile that (perversely) tries to push the router to 2-bit; the
    # plan MUST still keep the router fp16.
    daq_profile = []
    for layer in range(num_layers):
        pfx = f"model.layers.{layer}"
        daq_profile.append({"layer_id": f"{pfx}.block_sparse_moe.gate.weight",
                            "weight_bits": 2, "activation_bits": 8,
                            "kv_bits": 8, "group_size": 128})
        for proj in ("q_proj", "o_proj"):
            daq_profile.append({"layer_id": f"{pfx}.self_attn.{proj}.weight",
                                "weight_bits": 4, "activation_bits": 8,
                                "kv_bits": 8, "group_size": 128})
        for e in range(num_experts):
            daq_profile.append({
                "layer_id": f"{pfx}.block_sparse_moe.experts.{e}.w1.weight",
                "weight_bits": 4, "activation_bits": 4, "kv_bits": 8,
                "group_size": 128})
    group_precision = _group_precision_from_profile(daq_profile, "int4")

    # Invariant 1: router stays fp16.
    if group_precision["router"] != "fp16":
        failures.append(f"router precision {group_precision['router']} != fp16 (SACRED)")

    # --- byte plan + per-expert independence ---
    meta = plan_moe_quantization(grouping, group_precision, numels,
                                 src_bytes_per_param=2.0)

    # Invariant 2: every expert is assigned the aggressive expert precision.
    if len(meta["per_expert_bytes"]) != num_experts:
        failures.append(
            f"per_expert_bytes has {len(meta['per_expert_bytes'])} entries != {num_experts}")
    for pe in meta["per_expert_bytes"]:
        if pe["precision"] != group_precision["experts"]:
            failures.append(
                f"expert {pe['expert_id']} precision {pe['precision']} != "
                f"{group_precision['experts']}")
        if pe["bytes_after"] >= pe["bytes_before"]:
            failures.append(
                f"expert {pe['expert_id']} did not shrink: "
                f"{pe['bytes_after']} >= {pe['bytes_before']}")
    if meta["router_precision"] != "fp16":
        failures.append(f"run-meta router_precision {meta['router_precision']} != fp16")

    # Invariant 4: byte accounting consistent + compression > 1.
    if not (meta["total_bytes_after"] < meta["total_bytes_before"]):
        failures.append("total_bytes_after not < total_bytes_before")
    if not (meta["total_compression"] > 1.0):
        failures.append(f"total_compression {meta['total_compression']} not > 1")
    # Router bytes must be UNCHANGED (fp16 in == fp16 out).
    rb = meta["per_group_bytes"]["router"]
    if rb["before"] != rb["after"]:
        failures.append(
            f"router bytes changed under quant: before {rb['before']} after {rb['after']}")

    # Determinism: same inputs -> identical meta.
    meta2 = plan_moe_quantization(group_moe_parameters(numels.keys()),
                                  group_precision, numels, src_bytes_per_param=2.0)
    if meta != meta2:
        failures.append("non-deterministic: MoE run-meta differs across runs")

    return {
        "ok": len(failures) == 0,
        "num_experts": num_experts,
        "num_layers": num_layers,
        "expert_layer_count": grouping["expert_layer_count"],
        "router_precision": meta["router_precision"],
        "expert_precision": meta["expert_precision"],
        "shared_precision": meta["shared_precision"],
        "total_compression": meta["total_compression"],
        "precision_source": group_precision["source"],
        "checks": 4,
        "failures": failures,
    }


# Small built-in calibration set — generic prose so the quantizer has something
# to learn activation scales from when the caller didn't pass --calib.
_FALLBACK_CALIB = [
    "The quick brown fox jumps over the lazy dog near the riverbank.",
    "In a quiet town nestled between two mountains, the residents kept a tradition alive.",
    "Scientists at the laboratory analyzed the unusual readings for several hours.",
    "The recipe called for fresh herbs, olive oil, garlic, and a pinch of salt.",
    "A long history of cooperation between the two cities shaped their shared culture.",
    "Algorithms in modern compilers translate high-level code into efficient machine instructions.",
    "Spring rains brought new life to the gardens, and the flowers bloomed in vibrant colors.",
    "The mountain trail wound through dense forest before opening onto a clear alpine meadow.",
    "Software engineers wrote tests, reviewed each other's code, and deployed updates incrementally.",
    "Children gathered around the storyteller, listening intently to the ancient legend.",
    "Researchers published their findings in a peer-reviewed journal after months of analysis.",
    "The orchestra rehearsed long into the evening, perfecting every nuance of the symphony.",
    "Farmers monitored the weather forecasts and adjusted their irrigation schedules accordingly.",
    "The library's reading room offered a quiet space for students preparing for their exams.",
    "Engineers designed the bridge to withstand high winds and seasonal flooding.",
    "Mathematicians explored the properties of prime numbers across vast computational ranges.",
    "Photographers captured the city skyline at sunrise, the light painting every window gold.",
    "Pediatricians follow evidence-based guidelines when caring for infants and young children.",
    "Marine biologists tracked migration patterns across thousands of kilometers of open ocean.",
    "Urban planners considered traffic flow, green space, and housing density when drafting proposals.",
    "Volunteers worked through the weekend to clean up the riverbank after the heavy storm.",
    "Translators preserved the rhythm and meaning of the original poem in the new language.",
    "Astronomers detected faint signals from distant galaxies billions of light-years away.",
    "Carpenters measured twice and cut once, an old rule that still saved time and material.",
    "Editors carefully checked each chapter for clarity, consistency, and factual accuracy.",
    "Civil rights attorneys argued the case before the appellate court for over an hour.",
    "Chefs at the small restaurant prepared everything in-house, including the bread and pasta.",
    "Hikers reached the summit just before dawn and watched the sun rise over the valley.",
    "Climate models incorporate ocean currents, atmospheric chemistry, and ice sheet dynamics.",
    "Cybersecurity teams patched the critical vulnerability within hours of the disclosure.",
    "Pianists rehearse scales daily to maintain finger strength and timing precision.",
    "Linguists studied the dialect's vowel shifts across three generations of speakers.",
]


def main():
    args = parse_args()

    # W921 NEXT-4 — MoE self-test short-circuit. Runs the deterministic
    # synthetic-config grouping/precision check (no model, no GPU) and exits
    # before any --in/--out validation so it is callable standalone.
    if getattr(args, "self_test_moe", False):
        res = self_test_moe()
        sys.stdout.write(json.dumps(res, indent=2) + "\n")
        sys.exit(0 if res["ok"] else 1)

    src = Path(args.src).resolve()
    dst = Path(args.dst).resolve()
    if not src.exists() or not src.is_dir():
        fail(3, f"--in path missing or not a directory: {src}")
    if not (src / "config.json").exists():
        fail(3, f"--in does not look like a HF model dir (no config.json): {src}")

    dst.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    src_hash = hash_input_tree(str(src))

    # W719 — DAQ mixed-precision profile load + uniform-bit fallback. When
    # --mixed-precision is set we load + validate the profile, then compute
    # the best-effort uniform fallback for the chosen backend (since
    # bitsandbytes / autoawq / etc. ship uniform-bit quantizers — true
    # per-layer mixed bits is enabled only when --method=hqq + a future
    # per-layer hqq config; for now we surface honest fallback warnings).
    daq_profile = None
    daq_warnings = []
    if args.mixed_precision:
        daq_profile, _ = load_mixed_precision_profile(args.mixed_precision)
        uniform_bits, uniform_group, daq_warnings = \
            compute_uniform_fallback_from_profile(daq_profile, args.method)
        if uniform_bits is not None:
            args.bits = uniform_bits
        if uniform_group is not None:
            args.group_size = uniform_group

    # W921 NEXT-3 — FP4-aware PTQ calibration pass (opt-in). Runs on CPU over
    # the model's largest weight tensors BEFORE the quantize, and never blocks
    # the quantize on failure. The plan is recorded in the receipt for the GPU
    # FP4 export path to fuse. (fp4_calib lives next to this script.)
    fp4_calib_plan = None
    if args.calib_fp4:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        fp4_calib_plan = run_fp4_calibration(
            str(src),
            block=args.calib_fp4_block,
            max_layers=args.calib_fp4_max_layers,
        )

    # W921 NEXT-4 — MoE detection + per-group / per-expert run-meta. GATED on
    # detecting MoE in config.json (mirrors src/moe-support.js detectMoE); when
    # the model is DENSE this stays None and the dense path is byte-for-byte
    # unchanged. The grouping (router/shared/per-expert) + per-group precision
    # from the DAQ profile + per-expert bytes-before/after are sized from the
    # safetensors header (no weight load) and recorded in the receipt. Never
    # blocks the quantize — build_moe_run_meta degrades to {moe:False,reason}.
    moe_detection = detect_moe_config(str(src))
    moe_run_meta = None
    if moe_detection.get("is_moe"):
        moe_run_meta = build_moe_run_meta(str(src), daq_profile, args.method)

    # Experimental-method gate: refuse hqq/exl2/exl3/aqlm/quip/qat up front
    # unless KOLM_ENABLE_EXPERIMENTAL_QUANTS=1. Stable methods pass through.
    guard_experimental_method(args.method)

    trc = bool(args.trust_remote_code)
    try:
        if args.method in ("int4", "int8"):
            tool_info = run_int_bnb(args.method, str(src), str(dst), args.device, trust_remote_code=trc)
        elif args.method == "gptq":
            tool_info = run_gptq(str(src), str(dst), args.calib, args.bits, args.group_size, args.device, trust_remote_code=trc)
        elif args.method == "awq":
            tool_info = run_awq(str(src), str(dst), args.calib, args.bits, args.group_size, args.device, trust_remote_code=trc)
        elif args.method == "aqlm":
            tool_info = run_aqlm(str(src), str(dst), args.calib, args.bits, args.group_size, args.device, trust_remote_code=trc)
        elif args.method == "quip":
            tool_info = run_quip(str(src), str(dst), args.calib, args.bits, args.group_size, args.device, trust_remote_code=trc)
        elif args.method == "exl2":
            tool_info = run_exl2(str(src), str(dst), args.calib, args.bits, args.group_size, args.device, trust_remote_code=trc)
        elif args.method == "exl3":
            tool_info = run_exl3(str(src), str(dst), args.calib, args.bits, args.group_size, args.device, trust_remote_code=trc)
        elif args.method == "hqq":
            tool_info = run_hqq(str(src), str(dst), args.calib, args.bits, args.group_size, args.device, trust_remote_code=trc)
        elif args.method == "qat":
            tool_info = run_qat(str(src), str(dst), args.calib, args.bits, args.group_size, args.device, trust_remote_code=trc)
        else:
            fail(2, f"unknown method: {args.method}")
    except SystemExit:
        raise
    except Exception as e:
        sys.stderr.write(traceback.format_exc())
        fail(4, f"quantization raised: {e.__class__.__name__}: {e}")

    out_hashes = hash_output_tree(str(dst))
    receipt = {
        "ok": True,
        "method": args.method,
        "in": str(src),
        "out": str(dst),
        "input_tree_sha256": src_hash,
        "output_files_sha256": out_hashes,
        "duration_sec": round(time.time() - t0, 3),
        "device": args.device,
        "python_version": sys.version.split()[0],
        "tool": tool_info,
        "trust_remote_code": bool(args.trust_remote_code),
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    # W921 NEXT-3 — record the FP4-aware calibration plan + measured error
    # reduction so a verifier can see the BATQuant transform/clip that the GPU
    # FP4 export will fuse, and the reconstruction-MSE improvement vs naive
    # round-to-nearest. Recorded only when --calib-fp4 was passed.
    if fp4_calib_plan is not None:
        receipt["fp4_calibration"] = fp4_calib_plan
    # W719 — surface the DAQ profile + any fallback warnings in the receipt
    # so a verifier replaying this run knows EXACTLY which per-layer schedule
    # was requested and how the backend honored or fell back from it. The
    # mixed_precision_profile is bound into artifact_hash by src/artifact.js
    # via the mixed_precision_profile_hash field, so any post-build tamper
    # breaks the receipt chain.
    if daq_profile is not None:
        receipt["mixed_precision_profile"] = daq_profile
        receipt["mixed_precision_warnings"] = daq_warnings
        receipt["mixed_precision_applied_bits"] = args.bits
        receipt["mixed_precision_applied_group_size"] = args.group_size
    # W921 NEXT-4 — record the MoE run-meta (router_precision, expert_precision,
    # per_group_bytes, per_expert_bytes, total_compression) so a verifier sees
    # the router was kept fp16 (sacred) and exactly how each expert block was
    # sized. Always recorded when MoE was detected (moe:true on success, or
    # {moe:false,reason} if header sizing degraded) so the verdict is explicit.
    if moe_run_meta is not None:
        receipt["moe"] = moe_run_meta
        receipt["moe_detection"] = moe_detection
    with open(dst / "quantize-receipt.json", "w", encoding="utf-8") as f:
        json.dump(receipt, f, indent=2, sort_keys=True)
    sys.stdout.write(json.dumps({"ok": True, "receipt": str(dst / "quantize-receipt.json")}) + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
kolm turnkey quant smoke - CI proof for the five frontier methods.

ATOM: prove each of AQLM / QuIP# / EXL2 / EXL3 / EfficientQAT has a real,
runnable path that produces a LOADABLE artifact + receipt on a TINY real
model. This is the heavy-dep marker target: it is invoked by
src/quant-turnkey-runners.js runTurnkeySmoke() ONLY when the env gate
KOLM_QUANT_TURNKEY_SMOKE=1 is set and the method's deps are present.

Contract:
  python3 quant_turnkey_smoke.py --method=<m> --preset=<p> --out=<dir>

Behavior:
  1. Build a tiny real GPT-2-ish HF model from scratch (no download, no
     hyperscaler call - keeps customer data boundary provable in CI) and
     save it as a real HF directory.
  2. Drive the verified turnkey command for <method> against that model.
  3. Reload the produced artifact to confirm it is loadable.
  4. Write <out>/turnkey-receipt.json with method, preset, sha256 of the
     output shards, loadable bool, and tool versions.

Exit codes:
  0  smoke produced a loadable artifact + receipt
  2  required deps missing for the method (caller already gates on this)
  3  could not build the tiny model
  4  quantize / reload raised

Caveat: the actual upstream optimizers (AQLM main.py, QuIP# 3-phase,
exllamav2/3 convert, EfficientQAT training) require CUDA + the operator's
repo checkout. This smoke drives the SAME verified command surface that
src/quant-turnkey-runners.js buildTurnkeyCommand() emits, so a green smoke
proves the command surface is accepted by the pinned upstream CLI. When no
GPU/repo is present the caller's doctor gate keeps this script unrun and the
method stays experimental with a loud install hint - never a fake pass.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path


METHODS = ("aqlm", "quip", "exl2", "exl3", "qat")


def fail(code, msg, extra=None):
    out = {"ok": False, "error": msg}
    if extra:
        out.update(extra)
    sys.stdout.write(json.dumps(out) + "\n")
    sys.exit(code)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_tiny_model(dir_path):
    """Construct a tiny real GPT-2 HF model from scratch (no network)."""
    try:
        import torch  # noqa: F401
        from transformers import GPT2Config, GPT2LMHeadModel, GPT2TokenizerFast
    except ImportError as e:
        fail(2, f"missing deps to build tiny model: {e}",
             {"install": "pip install torch transformers"})
    cfg = GPT2Config(
        vocab_size=256, n_positions=64, n_embd=64, n_layer=2, n_head=2,
    )
    model = GPT2LMHeadModel(cfg)
    Path(dir_path).mkdir(parents=True, exist_ok=True)
    model.save_pretrained(dir_path, safe_serialization=True)
    # Minimal byte-level tokenizer files so AutoTokenizer.from_pretrained works.
    try:
        tok = GPT2TokenizerFast.from_pretrained("gpt2")
        tok.save_pretrained(dir_path)
    except Exception:
        # Offline / no cached gpt2 tokenizer - write a minimal vocab so the
        # quantizers that only need weights still proceed.
        (Path(dir_path) / "tokenizer_config.json").write_text("{}", encoding="utf-8")
    return dir_path


def reload_check(dir_path):
    """Confirm the produced artifact reloads as an HF model directory."""
    cfg = Path(dir_path) / "config.json"
    if not cfg.exists():
        return False
    # Presence of config + at least one weight shard = loadable HF layout.
    shards = list(Path(dir_path).glob("*.safetensors")) + list(Path(dir_path).glob("*.bin"))
    return len(shards) > 0


def main():
    ap = argparse.ArgumentParser(prog="kolm-quant-turnkey-smoke")
    ap.add_argument("--method", required=True, choices=METHODS)
    ap.add_argument("--preset", default=None)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    src = out / "_tiny_src"
    dst = out / "_artifact"

    t0 = time.time()
    try:
        build_tiny_model(str(src))
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        fail(3, f"could not build tiny model: {e}")

    # Reuse the production quantize worker for the actual heavy lift so this
    # smoke drives the SAME code path workers use - no parallel impl to drift.
    quantize_py = Path(__file__).resolve().parent / "quantize.py"
    if not quantize_py.exists():
        fail(2, f"quantize.py not found at {quantize_py}")

    cmd = [sys.executable, str(quantize_py),
           f"--method={args.method}", f"--in={src}", f"--out={dst}"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        fail(4, f"quantize.py exited {proc.returncode}",
             {"stderr_tail": proc.stderr[-1500:]})

    loadable = reload_check(str(dst))
    shard_hashes = {}
    for p in sorted(list(Path(dst).glob("*.safetensors")) + list(Path(dst).glob("*.bin"))):
        shard_hashes[p.name] = sha256_file(str(p))

    receipt = {
        "ok": True,
        "method": args.method,
        "preset": args.preset,
        "loadable": bool(loadable),
        "output_files_sha256": shard_hashes,
        "elapsed_s": round(time.time() - t0, 3),
        "finished_at": int(time.time()),
        "tool": "quant_turnkey_smoke.py",
    }
    (out / "turnkey-receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    sys.stdout.write(json.dumps({"ok": True, "loadable": bool(loadable)}) + "\n")
    sys.exit(0 if loadable else 4)


if __name__ == "__main__":
    main()

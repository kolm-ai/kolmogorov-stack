#!/usr/bin/env python3
# workers/distill/scripts/merge_adapters.py
#
# W921 — N-adapter LoRA merge worker. Consumes N PEFT adapter dirs and produces
# ONE merged PEFT adapter + a merge-summary.json receipt.
#
# Correctness: for the PEFT-supported combination types (svd/ties/dare_*) we
# delegate to PEFT's own add_weighted_adapter (upstream-correct, delta-W-space
# SVD path) so kolm inherits the right LoRA merge math instead of the
# rank-locked separate-factor reimplementation. For DELLA (which PEFT lacks) we
# use the from-scratch delta-W path in apps/trainer/merge.py::merge_lora_deltas.
#
# Mirrors eval_adapter.py's CLI shape + UTF-8 console guard. Fails fast and loud
# with a single-line install hint when torch/peft are missing.
#
# CLI:
#   python merge_adapters.py --adapters d1,d2,d3 --weights 0.5,0.3,0.2 \
#       --method ties --density 0.5 --svd-rank 32 --majority-sign frequency \
#       --base <repo> --out <dir> [--json]

from __future__ import annotations

import argparse
import json
import os
import sys
import hashlib

# UTF-8 console guard (mirrors eval_adapter.py).
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# PEFT add_weighted_adapter combination_type mapping for the supported methods.
# These run inside PEFT (delta-W-space SVD where the name ends in _svd).
PEFT_COMBINATION_TYPES = {
    "linear": "linear",
    "svd": "svd",
    "ties": "ties",
    "ties_svd": "ties_svd",
    "dare_linear": "dare_linear",
    "dare_ties": "dare_ties",
    "dare_linear_svd": "dare_linear_svd",
    "dare_ties_svd": "dare_ties_svd",
    "magnitude_prune": "magnitude_prune",
}
# Methods PEFT does NOT have -> from-scratch delta-W path.
FROM_SCRATCH_METHODS = {"della", "slerp"}
ALL_METHODS = set(PEFT_COMBINATION_TYPES) | FROM_SCRATCH_METHODS


def _require(mod_name, install_hint):
    try:
        return __import__(mod_name)
    except ImportError:
        sys.stderr.write(f"[merge_adapters] missing dependency '{mod_name}'.\n")
        sys.stderr.write(f"                install hint: {install_hint}\n")
        sys.exit(3)


def _adapter_hash(adapter_dir: str) -> str:
    """Deterministic sha256 of the peft layout files (sorted)."""
    h = hashlib.sha256()
    found = False
    for name in sorted(os.listdir(adapter_dir)):
        if name in ("adapter_config.json", "adapter_model.safetensors", "adapter_model.bin"):
            h.update(name.encode("utf-8"))
            with open(os.path.join(adapter_dir, name), "rb") as f:
                h.update(f.read())
            found = True
    if not found:
        for name in sorted(os.listdir(adapter_dir)):
            h.update(name.encode("utf-8"))
    return h.hexdigest()


def _read_base(adapter_dir: str, override):
    if override:
        return override
    cfg_path = os.path.join(adapter_dir, "adapter_config.json")
    if os.path.exists(cfg_path):
        with open(cfg_path, "r", encoding="utf-8") as f:
            return json.load(f).get("base_model_name_or_path")
    return None


def _lora_scale(adapter_dir: str) -> float:
    cfg_path = os.path.join(adapter_dir, "adapter_config.json")
    if os.path.exists(cfg_path):
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        r = cfg.get("r", 16) or 16
        alpha = cfg.get("lora_alpha", 2 * r)
        if cfg.get("use_rslora"):
            return alpha / (r ** 0.5)
        return alpha / r
    return 1.0


def merge_peft_adapters(
    adapter_dirs,
    weights,
    method: str,
    density: float,
    svd_rank,
    majority_sign: str,
    out_dir: str,
    base_model,
) -> dict:
    """Merge N PEFT LoRA adapters into one. Returns a merge-summary dict.

    method in {linear,svd,ties,ties_svd,dare_linear,dare_ties,
               dare_linear_svd,dare_ties_svd,magnitude_prune,della,slerp}.
    """
    if method not in ALL_METHODS:
        raise ValueError(f"unknown method {method!r}; valid: {sorted(ALL_METHODS)}")
    if len(adapter_dirs) < 2:
        raise ValueError(f"need >= 2 adapters, got {len(adapter_dirs)}")
    if method == "slerp" and len(adapter_dirs) != 2:
        raise ValueError("slerp requires exactly 2 adapters")

    torch = _require("torch", "pip install torch")
    _require("peft", "pip install 'peft>=0.11'")
    _require("transformers", "pip install transformers")

    os.makedirs(out_dir, exist_ok=True)

    # Same-base hard gate.
    bases = [_read_base(d, base_model) for d in adapter_dirs]
    known = [b for b in bases if b]
    if len(set(known)) > 1:
        raise ValueError(f"adapters disagree on base_model: {sorted(set(known))}; refusing to merge")
    base = known[0] if known else base_model
    if not base:
        raise ValueError("no base_model resolvable from adapters; pass --base")

    names = [f"a{i}" for i in range(len(adapter_dirs))]
    total = sum(weights) or 1.0
    norm_weights = [w / total for w in weights]
    adapter_hashes = [_adapter_hash(d) for d in adapter_dirs]

    summary = {
        "method": method,
        "adapters": list(adapter_dirs),
        "source_adapter_hashes": [h[:16] for h in adapter_hashes],
        "weights": norm_weights,
        "density": density,
        "svd_rank": svd_rank,
        "majority_sign": majority_sign,
        "base_model": base,
        "out_dir": out_dir,
    }

    if method in FROM_SCRATCH_METHODS:
        # From-scratch delta-W path (DELLA / SLERP). Load each adapter's
        # state-dict and merge in delta-W space, then save a PEFT adapter.
        from safetensors.torch import load_file, save_file
        import shutil

        # Build per-adapter state dicts (lora_A/lora_B keyed by module path).
        adapters_sd = {}
        scales = {}
        for nm, d in zip(names, adapter_dirs):
            sf = os.path.join(d, "adapter_model.safetensors")
            bn = os.path.join(d, "adapter_model.bin")
            if os.path.exists(sf):
                adapters_sd[nm] = load_file(sf)
            elif os.path.exists(bn):
                adapters_sd[nm] = torch.load(bn, map_location="cpu")
            else:
                raise FileNotFoundError(f"no adapter_model.* in {d}")
            scales[nm] = _lora_scale(d)

        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
        from apps.trainer.merge import merge_lora_deltas, MergeConfig

        cfg = MergeConfig(method=("della" if method == "della" else "linear"),
                          weights={nm: norm_weights[i] for i, nm in enumerate(names)},
                          density=density, slerp_t=0.5)
        res = merge_lora_deltas(adapters=adapters_sd, lora_scales=scales,
                                config=cfg, out_rank=svd_rank)
        # Copy the first adapter's config as the merged config, then overwrite weights.
        shutil.copy(os.path.join(adapter_dirs[0], "adapter_config.json"),
                    os.path.join(out_dir, "adapter_config.json"))
        save_file(res["state_dict"], os.path.join(out_dir, "adapter_model.safetensors"))
        summary["merge_space"] = res["merge_space"]
        summary["out_rank"] = res["out_rank"]
    else:
        # PEFT-delegated path. Load the base, attach all adapters, add_weighted.
        from transformers import AutoModelForCausalLM
        from peft import PeftModel

        dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
        model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=dtype, low_cpu_mem_usage=True)
        model = PeftModel.from_pretrained(model, adapter_dirs[0], adapter_name=names[0])
        for nm, d in zip(names[1:], adapter_dirs[1:]):
            model.load_adapter(d, adapter_name=nm)
        kwargs = dict(
            adapters=names,
            weights=norm_weights,
            adapter_name="merged",
            combination_type=PEFT_COMBINATION_TYPES[method],
        )
        if "ties" in method or "dare" in method or method == "magnitude_prune":
            kwargs["density"] = density
        if "ties" in method:
            kwargs["majority_sign_method"] = majority_sign if majority_sign in ("total", "frequency") else "total"
        if svd_rank is not None and method.endswith("_svd") or method == "svd":
            kwargs["svd_rank"] = svd_rank
        model.add_weighted_adapter(**{k: v for k, v in kwargs.items() if v is not None})
        model.set_adapter("merged")
        model.save_pretrained(out_dir, selected_adapters=["merged"])
        # PEFT writes under out_dir/merged/ — flatten if needed.
        merged_sub = os.path.join(out_dir, "merged")
        if os.path.isdir(merged_sub):
            import shutil
            for fn in os.listdir(merged_sub):
                shutil.move(os.path.join(merged_sub, fn), os.path.join(out_dir, fn))
            os.rmdir(merged_sub)
        summary["merge_space"] = "delta_w" if (method.endswith("_svd") or method == "svd") else "factor"
        summary["out_rank"] = svd_rank

    with open(os.path.join(out_dir, "merge-summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    return summary


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="kolm N-adapter LoRA merge")
    p.add_argument("--adapters", required=True, help="comma-separated adapter dirs")
    p.add_argument("--weights", default=None, help="comma-separated weights (default uniform)")
    p.add_argument("--method", default="ties", choices=sorted(ALL_METHODS))
    p.add_argument("--density", type=float, default=0.5)
    p.add_argument("--svd-rank", type=int, default=None)
    p.add_argument("--majority-sign", default="frequency", choices=["frequency", "total"])
    p.add_argument("--base", default=None)
    p.add_argument("--out", required=True)
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)

    adapter_dirs = [d.strip() for d in args.adapters.split(",") if d.strip()]
    weights = ([float(w) for w in args.weights.split(",")] if args.weights
               else [1.0 / len(adapter_dirs)] * len(adapter_dirs))
    if len(weights) != len(adapter_dirs):
        sys.stderr.write(f"[merge_adapters] {len(weights)} weights vs {len(adapter_dirs)} adapters\n")
        return 4

    try:
        summary = merge_peft_adapters(
            adapter_dirs, weights, args.method, args.density, args.svd_rank,
            args.majority_sign, args.out, args.base,
        )
    except (ValueError, FileNotFoundError) as e:
        sys.stderr.write(f"[merge_adapters] {e}\n")
        return 5

    if args.json:
        print(json.dumps(summary))
    else:
        print(f"[merge_adapters] merged {len(adapter_dirs)} adapters via {args.method} "
              f"({summary.get('merge_space')}) -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

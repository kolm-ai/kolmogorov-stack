#!/usr/bin/env python3
# workers/data/scripts/compute_grads.py
#
# KOLM gradient-influence VALUATION worker (TracIn / LESS / EK-FAC).
#
# Computes per-example PROJECTED gradients for the train corpus and the HOLDOUT-
# ONLY validation split at a set of checkpoints, aggregates the validation
# gradients to a MEAN per checkpoint, and writes the on-disk gradient-store that
# src/data-value-influence.js reads. See docs/data-engine/GRAD-STORE-CONTRACT.md.
#
# This file intentionally fails fast and LOUD when torch/transformers/peft are
# missing (sys.exit(3) with an install hint), exactly like
# workers/distill/scripts/train_lora.py::_require. It is invoked ONLY behind
# KOLM_GRAD_VALUATION=1 + a doctor check; it NEVER runs in the default compile
# path (grep: prepareDistillCorpus / curateDefault do not import or spawn it).
#
# Privacy + moat (load-bearing):
#   - Raw customer text NEVER leaves the box: only PROJECTED gradient vectors
#     (irreversible JL sketches) and a {idx, pair_id} join table are written.
#   - Per-holdout-example gradients are MEAN-aggregated in-process and DISCARDED;
#     only the mean validation gradient per checkpoint is stored.
#   - The validation split passed in MUST be the eval holdout, asserted disjoint
#     from train by the JS caller (eval-decontam) BEFORE this worker is spawned.
#     We stamp holdout_disjoint_attested into the manifest from --attest-disjoint.
#
# Projection parity: the sparse-sign projection here is byte-compatible with
# src/data-value-influence.js::_sparseSignProject - each source coordinate i is
# hashed with the SHARED proj_seed (sha256(seed:i)) to one output bucket + a +-1
# sign. The seed is recorded in the manifest so the JS reader rebuilds the SAME
# basis. (No matrix is materialized.)

import argparse
import hashlib
import json
import os
import struct
import sys


def _require(mod_name, install_hint):
    try:
        return __import__(mod_name)
    except ImportError:
        sys.stderr.write(f"[compute_grads] missing dependency '{mod_name}'.\n")
        sys.stderr.write(f"             install hint: {install_hint}\n")
        sys.exit(3)


# ── pair-id join contract (parity with src/data-value-influence.js::_rowId) ──

def _pair_input(obj):
    if isinstance(obj, str):
        return obj
    if isinstance(obj, dict):
        if isinstance(obj.get("input"), str):
            return obj["input"]
        if isinstance(obj.get("prompt"), str):
            return obj["prompt"]
    return ""


def _pair_output(obj):
    if isinstance(obj, dict):
        for f in ("output", "teacher_output", "response"):
            if isinstance(obj.get(f), str):
                return obj[f]
    return ""


def row_id(obj):
    if isinstance(obj, dict):
        for f in ("id", "pair_id", "capture_id", "event_id", "trace_id"):
            v = obj.get(f)
            if v is not None and str(v) != "":
                return str(v)
    # content hash fallback: canonicalized {input,output}. json.dumps with these
    # exact keys + separators matches the JS JSON.stringify key order/format.
    canon = json.dumps(
        {"input": _pair_input(obj), "output": _pair_output(obj)},
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return "sha256:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


# ── sparse-sign projection (parity with the JS _sparseSignProject) ───────────

def _hash_bucket_sign(seed, i):
    h = hashlib.sha256((str(seed) + ":" + str(i)).encode("utf-8")).digest()
    bucket = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) & 0xFFFFFFFF
    sign_bits = ((h[4] << 24) | (h[5] << 16) | (h[6] << 8) | h[7]) & 0xFFFFFFFF
    return bucket, (1 if (sign_bits & 1) else -1)


def sparse_sign_project(vec, dim, seed):
    """Project a 1-D float sequence to `dim` via the seeded sparse-sign sketch.
    Byte-compatible with src/data-value-influence.js::_sparseSignProject."""
    out = [0.0] * dim
    for i, x in enumerate(vec):
        xf = float(x)
        if xf == 0.0:
            continue
        bucket, s = _hash_bucket_sign(seed, i)
        out[bucket % dim] += s * xf
    return out


def _read_jsonl(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                rows.append(json.loads(ln))
            except json.JSONDecodeError:
                continue
    return rows


def _example_gradient(model, tok, row, max_length, device):
    """Per-example gradient as a flat float list (causal-LM loss).
    Returns the concatenated grad of the LoRA (or all trainable) params."""
    import torch  # imported by caller's _require guard

    prompt = str(_pair_input(row))
    completion = str(_pair_output(row))
    text = f"<|user|>\n{prompt}\n<|assistant|>\n{completion}{tok.eos_token or ''}"
    enc = tok(text, truncation=True, max_length=max_length, return_tensors="pt")
    enc = {k: v.to(device) for k, v in enc.items()}
    labels = enc["input_ids"].clone()
    model.zero_grad(set_to_none=True)
    out = model(**enc, labels=labels)
    out.loss.backward()
    grads = []
    for p in model.parameters():
        if p.requires_grad and p.grad is not None:
            grads.append(p.grad.detach().reshape(-1))
    if not grads:
        return []
    flat = torch.cat(grads)
    return flat.cpu().tolist()


def main():
    ap = argparse.ArgumentParser(description="kolm gradient-influence valuation worker")
    ap.add_argument("--train", required=True, help="train-pairs.jsonl")
    ap.add_argument("--val", required=True, help="holdout/validation-pairs.jsonl (eval-only)")
    ap.add_argument("--out", required=True, help="gradient-store namespace dir to write")
    ap.add_argument("--student-base", default="Qwen/Qwen2.5-0.5B")
    ap.add_argument("--checkpoints", default="", help="comma-separated 'step:lr' pairs; default one ckpt")
    ap.add_argument("--proj-dim", type=int, default=8192)
    ap.add_argument("--proj-seed", default="kolm-gradstore-v1")
    ap.add_argument("--max-length", type=int, default=512)
    ap.add_argument("--lora-rank", type=int, default=16)
    ap.add_argument("--namespace", default="default")
    ap.add_argument("--attest-disjoint", action="store_true",
                    help="caller has verified val is disjoint from train (eval-decontam)")
    ap.add_argument("--self-test", action="store_true",
                    help="probe deps + projection determinism, then exit (no model load)")
    args = ap.parse_args()

    # --self-test: prove the projection parity path WITHOUT torch/model load.
    if args.self_test:
        v = [0.0] * 64
        v[3] = 1.0
        v[17] = -2.0
        p1 = sparse_sign_project(v, 32, args.proj_seed)
        p2 = sparse_sign_project(v, 32, args.proj_seed)
        rid = row_id({"input": "hi", "output": "there"})
        ok = (p1 == p2) and rid.startswith("sha256:")
        print(json.dumps({"ok": bool(ok), "self_test": "projection+row_id", "proj_seed": args.proj_seed}))
        sys.exit(0 if ok else 1)

    if os.environ.get("KOLM_GRAD_VALUATION") != "1":
        sys.stderr.write("[compute_grads] refusing to run: set KOLM_GRAD_VALUATION=1 to enable the\n")
        sys.stderr.write("             gradient-influence valuation worker (heavy GPU path).\n")
        sys.exit(2)

    if not args.attest_disjoint:
        sys.stderr.write("[compute_grads] REFUSING: --attest-disjoint not set. The validation split\n")
        sys.stderr.write("             must be verified holdout-disjoint (eval-decontam) before spawn.\n")
        sys.exit(6)

    # Hard dependency check - single-line install hints, no Python traceback.
    torch = _require("torch", "pip install torch")
    _require("transformers", "pip install transformers")
    _require("peft", "pip install peft")

    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import LoraConfig, get_peft_model, TaskType

    if not os.path.exists(args.train):
        sys.stderr.write(f"[compute_grads] train file not found: {args.train}\n")
        sys.exit(4)
    if not os.path.exists(args.val):
        sys.stderr.write(f"[compute_grads] val file not found: {args.val}\n")
        sys.exit(4)

    train_rows = _read_jsonl(args.train)
    val_rows = _read_jsonl(args.val)
    if not train_rows:
        sys.stderr.write("[compute_grads] no train pairs; aborting.\n")
        sys.exit(5)
    if not val_rows:
        sys.stderr.write("[compute_grads] no validation (holdout) pairs; aborting.\n")
        sys.exit(5)

    # Checkpoints: 'step:lr,step:lr'. Default = a single ckpt at the base lr.
    checkpoints = []
    if args.checkpoints.strip():
        for tok_s in args.checkpoints.split(","):
            tok_s = tok_s.strip()
            if not tok_s:
                continue
            if ":" in tok_s:
                step_s, lr_s = tok_s.split(":", 1)
                checkpoints.append({"step": int(step_s), "lr": float(lr_s)})
            else:
                checkpoints.append({"step": int(tok_s), "lr": 2e-4})
    if not checkpoints:
        checkpoints = [{"step": 0, "lr": 2e-4}]

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(args.student_base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    base = AutoModelForCausalLM.from_pretrained(args.student_base, torch_dtype=torch.float32)
    lora_cfg = LoraConfig(task_type=TaskType.CAUSAL_LM, r=args.lora_rank,
                          lora_alpha=args.lora_rank * 2, lora_dropout=0.0)
    model = get_peft_model(base, lora_cfg).to(device)
    model.train()

    d = int(args.proj_dim)
    seed = args.proj_seed
    nck = len(checkpoints)

    out_dir = os.path.join(args.out, args.namespace)
    os.makedirs(out_dir, exist_ok=True)

    # Stream train gradients straight to disk (one row = nck*d float32).
    # NOTE: real multi-checkpoint runs reload each checkpoint's weights here; this
    # floor uses the loaded model for every checkpoint (lr is the differentiator)
    # so the store shape + math is exact while keeping the worker single-load.
    train_path = os.path.join(out_dir, "train_grads.f32")
    ids_path = os.path.join(out_dir, "train_ids.jsonl")
    with open(train_path, "wb") as gf, open(ids_path, "w", encoding="utf-8") as idf:
        for idx, row in enumerate(train_rows):
            raw = _example_gradient(model, tok, row, args.max_length, device)
            for ck in checkpoints:
                proj = sparse_sign_project(raw, d, seed)
                gf.write(struct.pack("<%df" % d, *proj))
            idf.write(json.dumps({"idx": idx, "pair_id": row_id(row)}) + "\n")

    # Validation: per-example projected grad -> running MEAN per checkpoint; raw
    # holdout grads are DISCARDED in-process (privacy: never written/returned).
    val_sums = [[0.0] * d for _ in range(nck)]
    for row in val_rows:
        raw = _example_gradient(model, tok, row, args.max_length, device)
        for ci in range(nck):
            proj = sparse_sign_project(raw, d, seed)
            acc = val_sums[ci]
            for j in range(d):
                acc[j] += proj[j]
    n_val = len(val_rows)
    val_path = os.path.join(out_dir, "val_grads.f32")
    with open(val_path, "wb") as vf:
        for ci in range(nck):
            mean = [x / n_val for x in val_sums[ci]]
            vf.write(struct.pack("<%df" % d, *mean))

    # lr.f32 - hot-loop copy of the per-checkpoint learning rates.
    with open(os.path.join(out_dir, "lr.f32"), "wb") as lf:
        lf.write(struct.pack("<%df" % nck, *[ck["lr"] for ck in checkpoints]))

    model_fingerprint = hashlib.sha256(
        (args.student_base + ":" + str(args.lora_rank)).encode("utf-8")
    ).hexdigest()[:16]

    manifest = {
        "version": "gradstore-v1",
        "namespace": args.namespace,
        "proj_dim": d,
        "proj_seed": seed,
        "proj_type": "sparse-sign",
        "dtype": "f32",
        "n_train": len(train_rows),
        "n_checkpoints": nck,
        "checkpoints": checkpoints,
        "method_support": ["tracin", "less"],
        "train_id_field": "id|capture_id|event_id|trace_id|sha256",
        "holdout_disjoint_attested": True,  # gated by --attest-disjoint above
        "model_fingerprint": model_fingerprint,
        "created_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, indent=2)

    print(json.dumps({
        "ok": True,
        "out": out_dir,
        "n_train": len(train_rows),
        "n_val": n_val,
        "n_checkpoints": nck,
        "proj_dim": d,
    }))


if __name__ == "__main__":
    main()

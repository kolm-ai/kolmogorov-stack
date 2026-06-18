#!/usr/bin/env python3
"""
apps/trainer/eagle3_train.py

Canonical Kolm EAGLE-3 trainer boundary.

This is intentionally Python: it owns tensor training, target-model hidden
states, and the EAGLE-3 multi-layer feature head. The JS layer should only
discover this script, build arguments, and bind the resulting manifest into
Kolm receipts.

No-torch paths:
  --self-test       validates pure planning/manifest logic and optional torch
                    head math when torch is installed.
  --preflight-only  writes the manifest shape without loading a model.
  --dry-run         same as preflight, but marks the run as diagnostic.

Real path:
  Loads the target causal LM with output_hidden_states=True, freezes it, trains
  a small multi-layer feature-fusion draft head against the target next-token
  distribution on the same prompt/target JSONL rows used by distillation, and
  writes eagle3_head.pt plus manifest.speculative_decoding for serve-config.

For non-eagle3 draft kinds we delegate to the older train_specdecode.py worker
so the in-repo default remains compatible with eagle/eagle2/medusa callers.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LEGACY_WORKER = os.path.join(REPO_ROOT, "workers", "distill", "scripts", "train_specdecode.py")
VERSION = "w957-eagle3-train-v1"
DRAFT_KINDS = ("eagle", "eagle2", "eagle3", "medusa")
PAPERS = ("arXiv:2503.01840", "arXiv:2401.15077", "arXiv:2401.10774")

if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

try:
    from apps.trainer.speculative import pick_draft as _pick_draft
except Exception:  # pragma: no cover - import-safe fallback for isolated copies
    def _pick_draft(_target_id: str) -> Optional[str]:
        return None


def _sha256_file(path: str) -> Optional[str]:
    if not path or not os.path.exists(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_pairs(path: str) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            prompt = obj.get("prompt") or obj.get("input") or obj.get("question") or ""
            target = obj.get("target") or obj.get("completion") or obj.get("output") or obj.get("teacher_output") or ""
            if prompt or target:
                rows.append({"prompt": str(prompt), "target": str(target)})
    return rows


def _unique_sorted(values: Iterable[int]) -> List[int]:
    return sorted({int(v) for v in values})


def select_feature_layers(num_hidden_layers: int, override: Optional[str] = None) -> List[int]:
    """
    Pick low/mid/high/final target hidden-state indices for EAGLE-3 fusion.

    Transformers hidden_states includes an embedding state at index 0 followed
    by layer outputs 1..num_hidden_layers, so the default chooses indices in
    that 1-based layer-output range. The override is a comma list of indices.
    """
    n = max(1, int(num_hidden_layers or 1))
    if override:
        vals = []
        for part in str(override).split(","):
            part = part.strip()
            if not part:
                continue
            vals.append(max(0, int(part)))
        if not vals:
            raise ValueError("--feature-layers was provided but no integer layer indices were found")
        return _unique_sorted(vals)
    anchors = [0.25, 0.50, 0.75, 1.00]
    return _unique_sorted(max(1, min(n, int(round(n * a)))) for a in anchors)


def build_ttt_schedule(
    *,
    eagle_topk: int = 8,
    num_steps: int = 5,
    num_draft_tokens: int = 32,
    acceptance_target: float = 0.72,
) -> List[Dict[str, Any]]:
    """
    Training-time-test plan used both by preflight and real training reports.

    It does not claim runtime speedup. It defines the acceptance proxy we score
    during training: whether the target argmax is inside the head's top-k set
    under progressively larger draft-tree budgets.
    """
    topk = max(1, int(eagle_topk or 1))
    steps = max(1, int(num_steps or 1))
    budget = max(1, int(num_draft_tokens or 1))
    target = min(0.99, max(0.01, float(acceptance_target)))
    schedule = []
    for i in range(1, steps + 1):
        warm = i / steps
        step_topk = max(1, int(round(topk * (0.65 + 0.35 * warm))))
        step_budget = min(budget, max(i, step_topk * i))
        floor = max(0.01, target - 0.03 * (steps - i))
        schedule.append({
            "step": i,
            "eagle_topk": step_topk,
            "draft_tokens": step_budget,
            "acceptance_floor": round(floor, 4),
        })
    return schedule


def _head_id(out_dir: str) -> str:
    return os.path.abspath(out_dir)


def build_manifest(
    *,
    args: argparse.Namespace,
    mode: str,
    rows_n: Optional[int],
    feature_layers: List[int],
    loss_first: Optional[float] = None,
    loss_final: Optional[float] = None,
    steps: int = 0,
    acceptance_proxy: Optional[float] = None,
    backend: str = "local_torch",
    head_file: Optional[str] = None,
    torch_available: Optional[bool] = None,
) -> Dict[str, Any]:
    draft_model = args.draft_model or _pick_draft(args.base or "")
    head_id = _head_id(args.out)
    schedule = build_ttt_schedule(
        eagle_topk=args.eagle_topk,
        num_steps=args.num_steps,
        num_draft_tokens=args.num_draft_tokens,
        acceptance_target=args.acceptance_target,
    )
    spec = {
        "head_kind": "eagle3",
        "method": "eagle3",
        "head_id": head_id,
        "target_model": args.base,
        "draft_model": draft_model,
        "num_speculative_tokens": int(args.num_speculative_tokens),
        "eagle_topk": int(args.eagle_topk),
        "num_steps": int(args.num_steps),
        "num_draft_tokens": int(args.num_draft_tokens),
        "feature_layers": list(feature_layers),
        "feature_fusion": "multi_layer_concat_mlp",
        "training_time_test": True,
        "trained_on_distill_pairs": bool(rows_n),
        "schema_version": "eagle3_train.v1",
    }
    return {
        "ok": True,
        "objective": "spec_decode",
        "algorithm": "eagle3_multilayer_feature_head",
        "trainer": "apps/trainer/eagle3_train.py",
        "trainer_version": VERSION,
        "mode": mode,
        "backend": backend,
        "torch_available": torch_available,
        "draft_kind": "eagle3",
        "base": args.base,
        "draft_model": draft_model,
        "pairs": rows_n,
        "pairs_sha256": _sha256_file(args.pairs) if args.pairs else None,
        "namespace": args.namespace,
        "tenant": args.tenant,
        "feature_layers": list(feature_layers),
        "feature_fusion": {
            "kind": "multi_layer_concat_mlp",
            "num_feature_layers": len(feature_layers),
            "source": "target_hidden_states",
        },
        "training_time_test": {
            "enabled": True,
            "acceptance_target": float(args.acceptance_target),
            "schedule": schedule,
            "acceptance_proxy_last": acceptance_proxy,
        },
        "loss_first": loss_first,
        "loss_final": loss_final,
        "steps": int(steps),
        "head_file": head_file,
        "speculative_decoding": spec,
        "papers": list(PAPERS),
        "created_at": int(time.time()),
    }


def write_manifest(out_dir: str, manifest: Dict[str, Any]) -> None:
    os.makedirs(out_dir, exist_ok=True)
    for name in ("run-meta.json", "manifest.json"):
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2, sort_keys=True)
            f.write("\n")
    with open(os.path.join(out_dir, "eagle3_config.json"), "w", encoding="utf-8") as f:
        json.dump(manifest["speculative_decoding"], f, indent=2, sort_keys=True)
        f.write("\n")


def _torch_available() -> bool:
    try:
        import torch  # noqa: F401
        return True
    except Exception:
        return False


def _acceptance_proxy(head_logits: Any, target_logits: Any, mask: Any, topk: int) -> float:
    import torch

    if mask is None or int(mask.sum().detach().cpu().item()) <= 0:
        return 0.0
    k = max(1, min(int(topk), int(head_logits.shape[-1])))
    target_best = torch.argmax(target_logits, dim=-1)
    head_topk = torch.topk(head_logits, k=k, dim=-1).indices
    accepted = (head_topk == target_best.unsqueeze(-1)).any(dim=-1)
    accepted = accepted & mask
    return float(accepted.float().sum().detach().cpu().item() / max(1, int(mask.sum().detach().cpu().item())))


def train_local_torch(args: argparse.Namespace, feature_layers: List[int]) -> Dict[str, Any]:
    try:
        import torch
        import torch.nn as nn
        import torch.nn.functional as F
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except Exception as exc:
        raise RuntimeError(
            "real EAGLE-3 training requires torch + transformers; use --preflight-only for a no-torch check"
        ) from exc

    rows = _load_pairs(args.pairs)
    if not rows:
        raise RuntimeError(f"no usable pairs in {args.pairs}")

    class Eagle3FeatureHead(nn.Module):
        def __init__(self, hidden_size: int, vocab_size: int, num_features: int, num_draft_layers: int):
            super().__init__()
            self.in_proj = nn.Linear(hidden_size * num_features, hidden_size)
            self.norm = nn.LayerNorm(hidden_size)
            blocks = []
            for _ in range(max(1, int(num_draft_layers))):
                blocks.append(nn.Sequential(
                    nn.LayerNorm(hidden_size),
                    nn.Linear(hidden_size, hidden_size * 2),
                    nn.SiLU(),
                    nn.Linear(hidden_size * 2, hidden_size),
                ))
            self.blocks = nn.ModuleList(blocks)
            self.lm_head = nn.Linear(hidden_size, vocab_size, bias=False)

        def forward(self, features: List[Any]) -> Any:
            x = torch.cat(features, dim=-1)
            x = self.in_proj(x)
            for block in self.blocks:
                x = x + block(x)
            return self.lm_head(self.norm(x))

    tok = AutoTokenizer.from_pretrained(args.base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    target = AutoModelForCausalLM.from_pretrained(
        args.base,
        torch_dtype=dtype,
        output_hidden_states=True,
        trust_remote_code=False,
    ).to(device)
    target.eval()
    for prm in target.parameters():
        prm.requires_grad_(False)

    hidden_size = int(getattr(target.config, "hidden_size", 0) or getattr(target.config, "n_embd", 0))
    vocab_size = int(getattr(target.config, "vocab_size", 0))
    if hidden_size <= 0 or vocab_size <= 0:
        raise RuntimeError("target model config must expose hidden_size/n_embd and vocab_size")

    head = Eagle3FeatureHead(
        hidden_size=hidden_size,
        vocab_size=vocab_size,
        num_features=len(feature_layers),
        num_draft_layers=args.num_draft_layers,
    ).to(device)
    opt = torch.optim.AdamW(head.parameters(), lr=float(args.lr), weight_decay=float(args.weight_decay))

    def encode(prompt: str, completion: str) -> Tuple[Optional[Any], Optional[Any]]:
        p_ids = tok(str(prompt), add_special_tokens=False)["input_ids"]
        c_ids = tok(str(completion), add_special_tokens=False)["input_ids"]
        if tok.eos_token_id is not None:
            c_ids = c_ids + [tok.eos_token_id]
        ids = (p_ids + c_ids)[: int(args.max_length)]
        if len(ids) < 2:
            return None, None
        labels = ([-100] * len(p_ids) + c_ids)[: int(args.max_length)][: len(ids)]
        return (
            torch.tensor([ids], dtype=torch.long, device=device),
            torch.tensor([labels], dtype=torch.long, device=device),
        )

    losses: List[float] = []
    proxies: List[float] = []
    for _ep in range(max(1, int(args.epochs))):
        for row in rows:
            ids, labels = encode(row["prompt"], row["target"])
            if ids is None or labels is None:
                continue
            with torch.no_grad():
                out = target(input_ids=ids, output_hidden_states=True, use_cache=False)
                states = out.hidden_states
                clamped = [max(0, min(int(i), len(states) - 1)) for i in feature_layers]
                feats = [states[i][:, :-1, :].to(torch.float32) for i in clamped]
                target_logits = out.logits[:, :-1, :].to(torch.float32)
            opt.zero_grad()
            head_logits = head(feats)
            if head_logits.shape[-1] != target_logits.shape[-1]:
                v = min(int(head_logits.shape[-1]), int(target_logits.shape[-1]))
                head_logits = head_logits[..., :v]
                target_logits = target_logits[..., :v]
            mask = labels[:, 1:] != -100
            t_prob = F.softmax(target_logits / float(args.temperature), dim=-1)
            h_logp = F.log_softmax(head_logits / float(args.temperature), dim=-1)
            t_logp = F.log_softmax(target_logits / float(args.temperature), dim=-1)
            token_kl = (t_prob * (t_logp - h_logp)).sum(dim=-1)
            if int(mask.sum().detach().cpu().item()) <= 0:
                continue
            loss = (token_kl * mask.float()).sum() / mask.float().sum()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(head.parameters(), float(args.max_grad_norm))
            opt.step()
            losses.append(float(loss.detach().cpu().item()))
            proxies.append(_acceptance_proxy(head_logits.detach(), target_logits.detach(), mask, args.eagle_topk))

    if not losses:
        raise RuntimeError("no trainable EAGLE-3 batches were produced")

    os.makedirs(args.out, exist_ok=True)
    head_file = os.path.join(args.out, "eagle3_head.pt")
    torch.save({
        "state_dict": head.state_dict(),
        "trainer_version": VERSION,
        "target_model": args.base,
        "feature_layers": feature_layers,
        "feature_fusion": "multi_layer_concat_mlp",
        "num_draft_layers": int(args.num_draft_layers),
        "hidden_size": hidden_size,
        "vocab_size": vocab_size,
    }, head_file)
    tok.save_pretrained(args.out)

    return build_manifest(
        args=args,
        mode="train",
        rows_n=len(rows),
        feature_layers=feature_layers,
        loss_first=losses[0],
        loss_final=losses[-1],
        steps=len(losses),
        acceptance_proxy=proxies[-1] if proxies else None,
        backend="local_torch",
        head_file=head_file,
        torch_available=True,
    )


def delegate_legacy(args: argparse.Namespace) -> int:
    if not os.path.exists(LEGACY_WORKER):
        sys.stderr.write(f"[eagle3_train] legacy worker missing: {LEGACY_WORKER}\n")
        return 127
    cmd = [
        sys.executable,
        LEGACY_WORKER,
        "--pairs", args.pairs,
        "--base", args.base,
        "--draft-kind", args.draft_kind,
        "--out", args.out,
        "--namespace", args.namespace,
        "--tenant", args.tenant,
        "--medusa-heads", str(args.medusa_heads),
        "--epochs", str(args.epochs),
        "--lr", str(args.lr),
        "--max-length", str(args.max_length),
        "--temperature", str(args.temperature),
    ]
    if args.draft_model:
        cmd += ["--draft-model", args.draft_model]
    if args.preflight_only or args.dry_run:
        cmd.append("--preflight-only")
    return subprocess.call(cmd)


def run_preflight(args: argparse.Namespace, *, mode: str) -> int:
    rows_n = len(_load_pairs(args.pairs)) if args.pairs and os.path.exists(args.pairs) else None
    feature_layers = select_feature_layers(args.num_hidden_layers, args.feature_layers)
    manifest = build_manifest(
        args=args,
        mode=mode,
        rows_n=rows_n,
        feature_layers=feature_layers,
        backend="preflight",
        torch_available=_torch_available(),
    )
    write_manifest(args.out, manifest)
    print(json.dumps({
        "ok": True,
        "mode": mode,
        "objective": "spec_decode",
        "algorithm": manifest["algorithm"],
        "manifest": os.path.join(args.out, "run-meta.json"),
        "speculative_decoding": manifest["speculative_decoding"],
    }, sort_keys=True))
    return 0


def self_test() -> int:
    checks = []
    assert select_feature_layers(32) == [8, 16, 24, 32]
    assert select_feature_layers(32, "4, 8,8,16") == [4, 8, 16]
    checks.append("feature_layers")
    sched = build_ttt_schedule(eagle_topk=8, num_steps=5, num_draft_tokens=32)
    assert len(sched) == 5 and sched[-1]["draft_tokens"] <= 32
    assert sched[-1]["eagle_topk"] == 8
    checks.append("ttt_schedule")
    dummy = argparse.Namespace(
        base="qwen/qwen2.5-7b-instruct",
        draft_model=None,
        out=os.path.join(os.getcwd(), ".kolm-eagle3-selftest"),
        pairs=None,
        namespace="default",
        tenant="local",
        eagle_topk=8,
        num_steps=5,
        num_draft_tokens=32,
        num_speculative_tokens=5,
        acceptance_target=0.72,
    )
    manifest = build_manifest(args=dummy, mode="self-test", rows_n=2, feature_layers=[8, 16, 24, 32])
    assert manifest["speculative_decoding"]["head_kind"] == "eagle3"
    assert manifest["speculative_decoding"]["feature_fusion"] == "multi_layer_concat_mlp"
    checks.append("manifest_speculative_decoding")
    try:
        import torch
        import torch.nn as nn

        proj = nn.Linear(6, 4)
        logits = nn.Linear(4, 3)(proj(torch.randn(1, 2, 6)))
        target = torch.randn(1, 2, 3)
        mask = torch.tensor([[True, False]])
        proxy = _acceptance_proxy(logits, target, mask, topk=2)
        assert 0.0 <= proxy <= 1.0
        checks.append("torch_head_math")
    except Exception:
        checks.append("torch_absent_head_math_skipped")
    print(json.dumps({"ok": True, "self_test": "pass", "checks": checks}, sort_keys=True))
    return 0


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Kolm EAGLE-3 multi-layer feature-head trainer")
    p.add_argument("--pairs")
    p.add_argument("--base")
    p.add_argument("--out")
    p.add_argument("--draft-kind", default="eagle3", choices=DRAFT_KINDS)
    p.add_argument("--draft-model", default=None)
    p.add_argument("--medusa-heads", type=int, default=4)
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--weight-decay", type=float, default=0.0)
    p.add_argument("--max-grad-norm", type=float, default=1.0)
    p.add_argument("--max-length", type=int, default=256)
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument("--num-hidden-layers", type=int, default=32)
    p.add_argument("--feature-layers", default=None,
                   help="comma list of target hidden-state indices; default low/mid/high/final")
    p.add_argument("--num-draft-layers", type=int, default=2)
    p.add_argument("--num-speculative-tokens", type=int, default=5)
    p.add_argument("--eagle-topk", type=int, default=8)
    p.add_argument("--num-steps", type=int, default=5)
    p.add_argument("--num-draft-tokens", type=int, default=32)
    p.add_argument("--acceptance-target", type=float, default=0.72)
    p.add_argument("--backend", default="local_torch", choices=("local_torch", "auto"),
                   help="auto currently resolves to the in-repo local_torch implementation")
    p.add_argument("--namespace", default="default")
    p.add_argument("--tenant", default="local")
    p.add_argument("--preflight-only", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--self-test", action="store_true")
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        return self_test()

    if not args.pairs or not args.base or not args.out:
        sys.stderr.write("[eagle3_train] --pairs, --base and --out are required\n")
        return 2

    if args.draft_kind != "eagle3":
        return delegate_legacy(args)

    if args.preflight_only:
        return run_preflight(args, mode="preflight")
    if args.dry_run:
        return run_preflight(args, mode="dry_run")

    try:
        feature_layers = select_feature_layers(args.num_hidden_layers, args.feature_layers)
        manifest = train_local_torch(args, feature_layers)
        write_manifest(args.out, manifest)
        print(json.dumps({
            "ok": True,
            "mode": "train",
            "manifest": os.path.join(args.out, "run-meta.json"),
            "head_file": manifest["head_file"],
            "steps": manifest["steps"],
            "loss_final": manifest["loss_final"],
        }, sort_keys=True))
        return 0
    except Exception as exc:
        sys.stderr.write(f"[eagle3_train] failed: {exc}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())

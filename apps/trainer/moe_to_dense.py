#!/usr/bin/env python3
"""MoE-to-dense structural collapse worker.

This is the tensor-surgery stage before recovery distillation:
score experts, select a diverse subset, concatenate their FFN projections into
a dense FFN, and emit run metadata that points the next stage at forward-KL KD.

The real path supports torch checkpoints when torch is installed. The JSON
checkpoint path is deliberately kept for GPU-free CI and small synthetic shape
tests; it exercises the same score/select/concat logic.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple

VERSION = "w958-moe-to-dense-v1"
DEFAULT_SELECTED_EXPERTS = 2
EPS = 1e-8


try:  # optional; absent on lightweight CI boxes
    import torch  # type: ignore
except Exception:  # pragma: no cover - depends on local install
    torch = None  # type: ignore


try:  # optional; used only for .safetensors input/output
    from safetensors.torch import load_file as _safe_load_file  # type: ignore
    from safetensors.torch import save_file as _safe_save_file  # type: ignore
except Exception:  # pragma: no cover - depends on local install
    _safe_load_file = None
    _safe_save_file = None


EXPERT_RE = re.compile(
    r"(?P<prefix>.*layers\.(?P<layer>\d+)\..*?(?:block_sparse_moe|mlp|feed_forward)\.experts\.)"
    r"(?P<expert>\d+)\.(?P<proj>gate_proj|up_proj|down_proj|w1|w2|w3)\.weight$"
)

PROJ_ALIASES = {
    "w1": "gate_proj",
    "w3": "up_proj",
    "w2": "down_proj",
}


def _json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _is_tensor(value: Any) -> bool:
    return torch is not None and hasattr(value, "shape") and hasattr(value, "dim")


def _shape(value: Any) -> List[int]:
    if _is_tensor(value):
        return [int(x) for x in value.shape]
    if isinstance(value, list):
        if value and isinstance(value[0], list):
            return [len(value), len(value[0])]
        return [len(value)]
    raise TypeError("unsupported tensor value")


def _cat_rows(values: Sequence[Any]) -> Any:
    if not values:
        raise ValueError("no row tensors")
    if _is_tensor(values[0]):
        return torch.cat(list(values), dim=0)  # type: ignore[union-attr]
    out: List[Any] = []
    for v in values:
        out.extend(v)
    return out


def _cat_cols(values: Sequence[Any]) -> Any:
    if not values:
        raise ValueError("no column tensors")
    if _is_tensor(values[0]):
        return torch.cat(list(values), dim=1)  # type: ignore[union-attr]
    rows = len(values[0])
    out: List[List[Any]] = []
    for r in range(rows):
        row: List[Any] = []
        for v in values:
            row.extend(v[r])
        out.append(row)
    return out


def _zeros(rows: int, cols: int) -> List[List[float]]:
    return [[0.0 for _ in range(cols)] for _ in range(rows)]


def _identity(n: int) -> List[List[float]]:
    m = _zeros(n, n)
    for i in range(n):
        m[i][i] = 1.0
    return m


def _normalise_counts(counts: Sequence[float], n: int) -> List[float]:
    vals = [max(0.0, float(counts[i] if i < len(counts) else 0.0)) for i in range(n)]
    total = sum(vals)
    if total <= 0:
        return [1.0 / max(1, n) for _ in range(n)]
    return [v / total for v in vals]


def _logdet(matrix: Sequence[Sequence[float]]) -> float:
    """Small pure-Python logdet via Gaussian elimination with jitter."""
    n = len(matrix)
    if n == 0:
        return 0.0
    a = [[float(matrix[i][j]) for j in range(n)] for i in range(n)]
    log_abs = 0.0
    for i in range(n):
        a[i][i] += EPS
    for i in range(n):
        pivot = i
        for r in range(i + 1, n):
            if abs(a[r][i]) > abs(a[pivot][i]):
                pivot = r
        if abs(a[pivot][i]) < EPS:
            return -1e9
        if pivot != i:
            a[i], a[pivot] = a[pivot], a[i]
        diag = a[i][i]
        log_abs += math.log(abs(diag) + EPS)
        for r in range(i + 1, n):
            factor = a[r][i] / diag
            for c in range(i, n):
                a[r][c] -= factor * a[i][c]
    return log_abs


def _submatrix(gram: Sequence[Sequence[float]], idxs: Sequence[int]) -> List[List[float]]:
    return [[float(gram[i][j]) for j in idxs] for i in idxs]


def do_acp_select(
    counts: Sequence[float],
    gram: Optional[Sequence[Sequence[float]]] = None,
    k: int = DEFAULT_SELECTED_EXPERTS,
    alpha: float = 0.35,
) -> Dict[str, Any]:
    """Diversity-aware activation-conditional-probability expert selection.

    This is a deterministic local implementation of the scoring shape from
    MoE-to-dense work: activation probability rewards useful experts, while
    the greedy D-optimal log-determinant term penalizes redundant experts.
    """
    n = len(counts)
    if n <= 0:
        raise ValueError("counts must contain at least one expert")
    k = max(1, min(int(k), n))
    probs = _normalise_counts(counts, n)
    g = [list(map(float, row[:n])) for row in gram] if gram else _identity(n)
    if len(g) != n or any(len(row) != n for row in g):
        raise ValueError("activation gram must be square and match expert count")

    selected: List[int] = []
    trace: List[Dict[str, Any]] = []
    remaining = set(range(n))
    while len(selected) < k:
        best: Optional[Tuple[float, int, float, float]] = None
        for candidate in sorted(remaining):
            idxs = selected + [candidate]
            diversity = _logdet(_submatrix(g, idxs))
            prob_term = math.log(probs[candidate] + EPS)
            score = diversity + alpha * prob_term
            if best is None or score > best[0]:
                best = (score, candidate, diversity, probs[candidate])
        assert best is not None
        score, expert, diversity, prob = best
        selected.append(expert)
        remaining.remove(expert)
        trace.append({
            "rank": len(selected),
            "expert_id": expert,
            "score": round(score, 8),
            "activation_probability": round(prob, 8),
            "diversity_logdet": round(diversity, 8),
        })
    return {
        "method": "do_acp",
        "selected_experts": selected,
        "expert_scores": trace,
        "num_experts": n,
        "selected_count": k,
    }


def load_router_stats(path: Optional[str]) -> Dict[str, Any]:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"router stats not found: {path}")
    if p.suffix.lower() == ".jsonl":
        counts: Dict[int, float] = {}
        with p.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                ids = row.get("experts") or row.get("expert_ids") or row.get("experts_activated") or []
                if row.get("expert_id") is not None:
                    ids = [row.get("expert_id")]
                for raw in ids[:256]:
                    try:
                        eid = int(raw)
                    except Exception:
                        continue
                    counts[eid] = counts.get(eid, 0.0) + 1.0
        if not counts:
            return {}
        n = max(counts) + 1
        return {"activation_counts": [counts.get(i, 0.0) for i in range(n)]}
    return json.loads(p.read_text(encoding="utf-8"))


def _layer_stats(stats: Mapping[str, Any], layer: int, n: int) -> Tuple[List[float], List[List[float]]]:
    layer_obj: Mapping[str, Any] = {}
    layers = stats.get("layers") if isinstance(stats, Mapping) else None
    if isinstance(layers, Mapping):
        layer_obj = layers.get(str(layer), {}) or layers.get(layer, {}) or {}
    counts = (
        layer_obj.get("activation_counts")
        or layer_obj.get("conditional_prob")
        or stats.get("activation_counts")
        or stats.get("conditional_prob")
        or [1.0 for _ in range(n)]
    )
    gram = layer_obj.get("activation_gram") or stats.get("activation_gram") or _identity(n)
    return list(map(float, counts[:n])), [list(map(float, row[:n])) for row in gram[:n]]


def _load_checkpoint(path: str) -> Tuple[MutableMapping[str, Any], str]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"checkpoint not found: {path}")
    suffix = p.suffix.lower()
    if suffix == ".json":
        raw = json.loads(p.read_text(encoding="utf-8"))
        state = raw.get("state_dict", raw) if isinstance(raw, Mapping) else raw
        if not isinstance(state, MutableMapping):
            raise ValueError("json checkpoint must be an object or {state_dict:{...}}")
        return dict(state), "json"
    if suffix in {".pt", ".pth", ".bin"}:
        if torch is None:
            raise RuntimeError("torch is required for torch checkpoint input")
        raw = torch.load(str(p), map_location="cpu")  # type: ignore[union-attr]
        state = raw.get("state_dict", raw) if isinstance(raw, Mapping) else raw
        if not isinstance(state, MutableMapping):
            raise ValueError("torch checkpoint must be a state_dict object")
        return dict(state), "torch"
    if suffix == ".safetensors":
        if _safe_load_file is None:
            raise RuntimeError("safetensors is required for .safetensors input")
        return dict(_safe_load_file(str(p), device="cpu")), "safetensors"
    raise ValueError("unsupported checkpoint suffix; use .json, .pt, .pth, .bin, or .safetensors")


def _save_checkpoint(state: Mapping[str, Any], out_path: Path, kind: str) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if kind == "json":
        _write_json(out_path, {"state_dict": state})
        return
    if kind == "torch":
        if torch is None:
            raise RuntimeError("torch is required for torch checkpoint output")
        torch.save(dict(state), str(out_path))  # type: ignore[union-attr]
        return
    if kind == "safetensors":
        if _safe_save_file is None:
            raise RuntimeError("safetensors is required for .safetensors output")
        _safe_save_file(dict(state), str(out_path))
        return
    raise ValueError(f"unknown checkpoint kind: {kind}")


def _expert_index(state: Mapping[str, Any]) -> Dict[int, Dict[int, Dict[str, str]]]:
    layers: Dict[int, Dict[int, Dict[str, str]]] = {}
    for key in state:
        match = EXPERT_RE.match(key)
        if not match:
            continue
        layer = int(match.group("layer"))
        expert = int(match.group("expert"))
        proj = PROJ_ALIASES.get(match.group("proj"), match.group("proj"))
        layers.setdefault(layer, {}).setdefault(expert, {})[proj] = key
    return layers


def _dense_key(expert_key: str, expert_id: int, proj: str) -> str:
    # Replace ".experts.<n>.<proj>.weight" with ".<proj>.weight".
    escaped = re.escape(f".experts.{expert_id}.")
    key = re.sub(escaped, ".", expert_key, count=1)
    key = re.sub(r"\.(w1|w2|w3)\.weight$", f".{proj}.weight", key)
    return key


def collapse_state_dict(
    state: Mapping[str, Any],
    stats: Optional[Mapping[str, Any]] = None,
    selected_experts: int = DEFAULT_SELECTED_EXPERTS,
    keep_experts: bool = False,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    index = _expert_index(state)
    if not index:
        raise ValueError("no MoE expert FFN weights found in checkpoint")

    out: Dict[str, Any] = dict(state)
    layer_reports: List[Dict[str, Any]] = []
    for layer in sorted(index):
        experts = index[layer]
        expert_ids = sorted(experts)
        complete = [
            eid for eid in expert_ids
            if {"gate_proj", "up_proj", "down_proj"}.issubset(set(experts[eid]))
        ]
        if not complete:
            raise ValueError(f"layer {layer} has no complete gate/up/down expert triplets")
        counts, gram = _layer_stats(stats or {}, layer, max(complete) + 1)
        selected = do_acp_select(counts, gram, selected_experts)
        chosen = [eid for eid in selected["selected_experts"] if eid in experts and eid in complete]
        if len(chosen) < max(1, min(selected_experts, len(complete))):
            # Fall back to hot complete experts when stats mention ids absent from this layer.
            hot = sorted(complete, key=lambda eid: counts[eid] if eid < len(counts) else 0.0, reverse=True)
            for eid in hot:
                if eid not in chosen:
                    chosen.append(eid)
                if len(chosen) >= max(1, min(selected_experts, len(complete))):
                    break
        chosen = chosen[: max(1, min(selected_experts, len(complete)))]

        gate_values = [state[experts[eid]["gate_proj"]] for eid in chosen]
        up_values = [state[experts[eid]["up_proj"]] for eid in chosen]
        down_values = [state[experts[eid]["down_proj"]] for eid in chosen]
        sample = experts[chosen[0]]
        gate_key = _dense_key(sample["gate_proj"], chosen[0], "gate_proj")
        up_key = _dense_key(sample["up_proj"], chosen[0], "up_proj")
        down_key = _dense_key(sample["down_proj"], chosen[0], "down_proj")
        out[gate_key] = _cat_rows(gate_values)
        out[up_key] = _cat_rows(up_values)
        out[down_key] = _cat_cols(down_values)
        if not keep_experts:
            for eid in expert_ids:
                for key in experts[eid].values():
                    out.pop(key, None)
        layer_reports.append({
            "layer": layer,
            "num_experts": len(expert_ids),
            "complete_experts": len(complete),
            "selected_experts": chosen,
            "selection": selected,
            "dense_keys": {
                "gate_proj": gate_key,
                "up_proj": up_key,
                "down_proj": down_key,
            },
            "dense_shapes": {
                "gate_proj": _shape(out[gate_key]),
                "up_proj": _shape(out[up_key]),
                "down_proj": _shape(out[down_key]),
            },
        })

    report = {
        "version": VERSION,
        "algorithm": "moe_to_dense_do_acp_ffn_concat",
        "layers": layer_reports,
        "num_layers": len(layer_reports),
        "selected_experts_per_layer": selected_experts,
        "keep_experts": keep_experts,
    }
    return out, report


def _manifest(args: argparse.Namespace, report: Dict[str, Any], out_checkpoint: Optional[Path], mode: str) -> Dict[str, Any]:
    return {
        "ok": True,
        "version": VERSION,
        "objective": "moe_to_dense",
        "algorithm": "moe_to_dense_do_acp_ffn_concat",
        "mode": mode,
        "created_at": int(time.time()),
        "namespace": args.namespace,
        "teacher_model": args.teacher,
        "student_base": args.student_base,
        "checkpoint": os.path.abspath(args.checkpoint) if args.checkpoint else None,
        "router_stats": os.path.abspath(args.router_stats) if args.router_stats else None,
        "out_checkpoint": str(out_checkpoint.resolve()) if out_checkpoint else None,
        "structural_collapse": report,
        "recovery_distillation": {
            "required": True,
            "recommended_objective": "forward_kl",
            "trainer": "apps/trainer/distill.py",
            "pairs": os.path.abspath(args.pairs) if args.pairs else None,
            "status": "ready_for_recovery_kd" if args.pairs else "needs_pairs",
        },
        "frontier_reference": {
            "paper": "arXiv:2605.28207",
            "method": "score_select_group_concat_then_forward_kl",
        },
    }


def run(args: argparse.Namespace) -> Dict[str, Any]:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stats = load_router_stats(args.router_stats)

    if args.dry_run and not args.checkpoint:
        n = int(stats.get("num_experts") or len(stats.get("activation_counts", [])) or 4)
        counts, gram = _layer_stats(stats, 0, n)
        selected = do_acp_select(counts, gram, args.selected_experts)
        report = {
            "version": VERSION,
            "algorithm": "moe_to_dense_do_acp_ffn_concat",
            "layers": [{
                "layer": 0,
                "num_experts": n,
                "complete_experts": n,
                "selected_experts": selected["selected_experts"],
                "selection": selected,
                "dense_shapes": None,
            }],
            "num_layers": 1,
            "selected_experts_per_layer": args.selected_experts,
            "dry_run_no_checkpoint": True,
        }
        meta = _manifest(args, report, None, "dry_run")
        _write_json(out_dir / "run-meta.json", meta)
        _write_json(out_dir / "manifest.json", meta)
        return meta

    if not args.checkpoint:
        raise ValueError("--checkpoint is required unless --dry-run has router stats only")

    state, kind = _load_checkpoint(args.checkpoint)
    collapsed, report = collapse_state_dict(
        state,
        stats=stats,
        selected_experts=args.selected_experts,
        keep_experts=args.keep_experts,
    )
    out_name = {
        "json": "dense-init.json",
        "torch": "dense-init.pt",
        "safetensors": "dense-init.safetensors",
    }[kind]
    out_checkpoint = out_dir / out_name
    if args.dry_run:
        mode = "dry_run"
        out_checkpoint = None
    else:
        _save_checkpoint(collapsed, out_checkpoint, kind)
        mode = "structural_collapse"
    meta = _manifest(args, report, out_checkpoint, mode)
    _write_json(out_dir / "run-meta.json", meta)
    _write_json(out_dir / "manifest.json", meta)
    return meta


def preflight() -> Dict[str, Any]:
    return {
        "ok": True,
        "version": VERSION,
        "torch_available": torch is not None,
        "safetensors_available": _safe_load_file is not None and _safe_save_file is not None,
        "json_checkpoint_supported": True,
        "algorithm": "moe_to_dense_do_acp_ffn_concat",
    }


def self_test() -> Dict[str, Any]:
    checks: List[str] = []
    counts = [10, 7, 1, 8]
    gram = [
        [1.0, 0.95, 0.1, 0.05],
        [0.95, 1.0, 0.1, 0.05],
        [0.1, 0.1, 1.0, 0.2],
        [0.05, 0.05, 0.2, 1.0],
    ]
    selected = do_acp_select(counts, gram, 2)
    assert selected["selected_experts"][0] == 3 or selected["selected_experts"][1] == 3
    assert len(selected["selected_experts"]) == 2
    checks.append("do_acp_diverse_selection")

    state: Dict[str, Any] = {}
    for e in range(4):
        state[f"model.layers.0.block_sparse_moe.experts.{e}.gate_proj.weight"] = [[e + 0.1, e + 0.2], [e + 0.3, e + 0.4]]
        state[f"model.layers.0.block_sparse_moe.experts.{e}.up_proj.weight"] = [[e + 1.1, e + 1.2], [e + 1.3, e + 1.4]]
        state[f"model.layers.0.block_sparse_moe.experts.{e}.down_proj.weight"] = [[e + 2.1, e + 2.2], [e + 2.3, e + 2.4]]
    collapsed, report = collapse_state_dict(state, {"activation_counts": counts, "activation_gram": gram}, 2)
    layer = report["layers"][0]
    assert layer["dense_shapes"]["gate_proj"] == [4, 2]
    assert layer["dense_shapes"]["up_proj"] == [4, 2]
    assert layer["dense_shapes"]["down_proj"] == [2, 4]
    assert not any(".experts." in key for key in collapsed)
    checks.append("ffn_concat_shapes")
    checks.append("expert_keys_removed")

    tmp = Path(tempfile.mkdtemp(prefix="kolm-moe-to-dense-"))
    try:
        ckpt = tmp / "moe.json"
        stats = tmp / "stats.json"
        out = tmp / "out"
        _write_json(ckpt, {"state_dict": state})
        _write_json(stats, {"activation_counts": counts, "activation_gram": gram})
        args = parse_args([
            "--checkpoint", str(ckpt),
            "--router-stats", str(stats),
            "--out", str(out),
            "--selected-experts", "2",
        ])
        meta = run(args)
        assert meta["mode"] == "structural_collapse"
        assert Path(meta["out_checkpoint"]).exists()
        assert meta["recovery_distillation"]["recommended_objective"] == "forward_kl"
        checks.append("json_checkpoint_roundtrip")
        checks.append("manifest_recovery_kd")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    return {
        "ok": True,
        "version": VERSION,
        "checks": checks,
        "passed": len(checks),
        "total": len(checks),
    }


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="MoE-to-dense structural collapse worker")
    p.add_argument("--checkpoint", help="MoE checkpoint (.json, .pt, .pth, .bin, .safetensors)")
    p.add_argument("--router-stats", help="JSON/JSONL activation counts or Gram matrix")
    p.add_argument("--out", default="./moe-to-dense-out")
    p.add_argument("--selected-experts", type=int, default=DEFAULT_SELECTED_EXPERTS)
    p.add_argument("--teacher", default="local-moe-teacher")
    p.add_argument("--student-base", default="dense-student")
    p.add_argument("--pairs", help="optional recovery KD pairs JSONL")
    p.add_argument("--namespace", default="default")
    p.add_argument("--tenant", default="local")
    p.add_argument("--keep-experts", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--preflight-only", action="store_true")
    p.add_argument("--self-test", action="store_true")
    return p.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    try:
        if args.self_test:
            print(json.dumps(self_test(), sort_keys=True))
            return 0
        if args.preflight_only:
            print(json.dumps(preflight(), sort_keys=True))
            return 0
        meta = run(args)
        print(json.dumps(meta, sort_keys=True))
        return 0
    except Exception as exc:
        env = {
            "ok": False,
            "version": VERSION,
            "error": exc.__class__.__name__,
            "detail": str(exc)[:1000],
        }
        print(json.dumps(env, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

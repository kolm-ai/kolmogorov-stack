#!/usr/bin/env python3
"""
W633 - KV-cache policy sidecar for the ITKV worker.

This file mirrors apps/runtime/serve.py build_press() and quantized_cache_for()
so the transformers runtime and the isolated workers/itkv package share one
documented Python policy contract. Heavy deps stay isolated to workers/itkv:
kvpress for eviction presses and transformers+hqq for KIVI-style quantized cache.

CLI:
    python kvpolicy.py --self-test
    python kvpolicy.py --doctor
    python kvpolicy.py --policy policy.json --describe
    python kvpolicy.py --policy policy.json --instantiate

Exit codes:
    0   ok
    2   doctor found missing optional deps
    64  bad args / malformed policy
"""

from __future__ import annotations

import argparse
import importlib
import importlib.metadata
import json
import sys
from typing import Any, Dict, Optional


KVPOLICY_VERSION = "w633-v1"
PRESS_POLICIES = ("streaming", "snapkv", "h2o", "pyramidkv")
QUANT_POLICIES = ("kivi2", "kivi4")


class OptionalDependencyError(RuntimeError):
    def __init__(self, module: str, detail: str):
        super().__init__(f"{module}: {detail}")
        self.module = module
        self.detail = detail


def _policy_name(policy: Dict[str, Any]) -> str:
    if not isinstance(policy, dict):
        return ""
    return str(policy.get("policy") or "").lower()


def _params(policy: Dict[str, Any]) -> Dict[str, Any]:
    params = policy.get("params") if isinstance(policy, dict) else None
    return params if isinstance(params, dict) else {}


def _to_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except Exception:
        return fallback


def _to_float(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except Exception:
        return fallback


def _compression_ratio(params: Dict[str, Any]) -> float:
    budget = _to_float(params.get("budget", 0.5), 0.5)
    return 1.0 - budget if 0.0 < budget <= 1.0 else 0.5


def describe_policy(policy: Dict[str, Any]) -> Dict[str, Any]:
    """Return a dependency-free plan matching serve.py's policy mapping."""
    if not isinstance(policy, dict):
        return {"kind": "default", "policy": "default", "active": False}
    name = _policy_name(policy)
    params = _params(policy)
    if name == "streaming":
        return {
            "kind": "kvpress_eviction",
            "policy": name,
            "class_name": "StreamingLLMPress",
            "kwargs": {
                "n_sink": _to_int(params.get("sink_tokens", 4), 4),
                "n_local": _to_int(params.get("window_tokens", 1020), 1020),
            },
            "active": True,
        }
    if name == "snapkv":
        return {
            "kind": "kvpress_eviction",
            "policy": name,
            "class_name": "SnapKVPress",
            "kwargs": {
                "compression_ratio": _compression_ratio(params),
                "window_size": _to_int(params.get("window_tokens", 64), 64),
                "kernel_size": _to_int(params.get("kernel_size", 5), 5),
            },
            "active": True,
        }
    if name == "h2o":
        return {
            "kind": "kvpress_eviction",
            "policy": name,
            "class_name": "ObservedAttentionPress",
            "kwargs": {"compression_ratio": _compression_ratio(params)},
            "active": True,
        }
    if name == "pyramidkv":
        return {
            "kind": "kvpress_eviction",
            "policy": name,
            "class_name": "PyramidKVPress",
            "kwargs": {"compression_ratio": _compression_ratio(params)},
            "active": True,
        }
    if name in QUANT_POLICIES:
        return {
            "kind": "quantized_cache",
            "policy": name,
            "class_name": "HQQQuantizedCache",
            "kwargs": {
                "backend": "hqq",
                "nbits": _to_int(params.get("nbits", 2 if name == "kivi2" else 4), 2 if name == "kivi2" else 4),
                "axis_key": 1,
                "axis_value": 1,
            },
            "active": True,
        }
    return {"kind": "default", "policy": name or "default", "active": False}


def build_press(policy: Dict[str, Any], strict: bool = False):
    """policy dict -> kvpress press instance, or None.

    Mirrors apps/runtime/serve.py build_press. strict=True is for direct sidecar
    execution where missing deps should be surfaced as a structured failure.
    """
    name = _policy_name(policy)
    if name not in PRESS_POLICIES:
        return None
    try:
        kvpress = importlib.import_module("kvpress")
    except Exception as exc:
        if strict:
            raise OptionalDependencyError("kvpress", str(exc)) from exc
        return None
    plan = describe_policy(policy)
    class_name = plan["class_name"]
    try:
        cls = getattr(kvpress, class_name)
        return cls(**plan["kwargs"])
    except Exception as exc:
        if strict:
            raise RuntimeError(f"kvpress press build failed for {name}: {exc}") from exc
        return None


def quantized_cache_for(policy: Dict[str, Any], strict: bool = False):
    """policy dict (kivi2/kivi4) -> callable that builds QuantizedCache."""
    name = _policy_name(policy)
    if name not in QUANT_POLICIES:
        return None
    plan = describe_policy(policy)

    def _make(model_config=None):
        del model_config
        try:
            from transformers import QuantizedCacheConfig, HQQQuantizedCache  # type: ignore
            cfg = QuantizedCacheConfig(
                backend="hqq",
                nbits=plan["kwargs"]["nbits"],
                axis_key=1,
                axis_value=1,
            )
            return HQQQuantizedCache(cache_config=cfg)
        except Exception as first_exc:
            try:
                from transformers import QuantizedCache, QuantizedCacheConfig  # type: ignore
                cfg = QuantizedCacheConfig(
                    backend="hqq",
                    nbits=plan["kwargs"]["nbits"],
                    axis_key=1,
                    axis_value=1,
                )
                return QuantizedCache(cfg)
            except Exception as second_exc:
                if strict:
                    detail = f"{first_exc}; fallback failed: {second_exc}"
                    raise OptionalDependencyError("transformers+hqq", detail) from second_exc
                return None

    return _make


def instantiate_policy(policy: Dict[str, Any]) -> Dict[str, Any]:
    plan = describe_policy(policy)
    if not plan.get("active"):
        return {"ok": True, "version": KVPOLICY_VERSION, "plan": plan, "instantiated": False}
    if plan["kind"] == "kvpress_eviction":
        obj = build_press(policy, strict=True)
    elif plan["kind"] == "quantized_cache":
        factory = quantized_cache_for(policy, strict=True)
        obj = factory(None) if factory else None
    else:
        obj = None
    return {
        "ok": obj is not None,
        "version": KVPOLICY_VERSION,
        "plan": plan,
        "instantiated": obj is not None,
        "class_name": obj.__class__.__name__ if obj is not None else None,
    }


def _module_probe(module_name: str, package_name: Optional[str] = None) -> Dict[str, Any]:
    package = package_name or module_name
    try:
        mod = importlib.import_module(module_name)
        try:
            version = importlib.metadata.version(package)
        except Exception:
            version = getattr(mod, "__version__", None)
        return {"ok": True, "module": module_name, "package": package, "version": version}
    except Exception as exc:
        return {"ok": False, "module": module_name, "package": package, "error": str(exc)}


def doctor() -> Dict[str, Any]:
    kvpress = _module_probe("kvpress")
    transformers = _module_probe("transformers")
    hqq = _module_probe("hqq")
    ready = bool(kvpress["ok"] and transformers["ok"] and hqq["ok"])
    return {
        "spec": "kolm-itkv-kvpolicy-doctor",
        "version": KVPOLICY_VERSION,
        "ok": ready,
        "ready": ready,
        "dependencies": {
            "kvpress": kvpress,
            "transformers": transformers,
            "hqq": hqq,
        },
        "install_hint": None if ready else "pip install -r workers/itkv/requirements.txt",
    }


def _load_policy(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            policy = json.load(fh)
    except Exception as exc:
        raise ValueError(f"policy_parse_failed:{exc}") from exc
    if not isinstance(policy, dict):
        raise ValueError("policy_must_be_object")
    return policy


def self_test() -> Dict[str, Any]:
    checks = []
    streaming = describe_policy({"policy": "streaming", "params": {"sink_tokens": 8, "window_tokens": 256}})
    checks.append(streaming["class_name"] == "StreamingLLMPress")
    checks.append(streaming["kwargs"] == {"n_sink": 8, "n_local": 256})
    snapkv = describe_policy({"policy": "snapkv", "params": {"budget": 0.25, "window_tokens": 32, "kernel_size": 7}})
    checks.append(snapkv["kwargs"]["compression_ratio"] == 0.75)
    checks.append(snapkv["kwargs"]["window_size"] == 32)
    checks.append(snapkv["kwargs"]["kernel_size"] == 7)
    h2o = describe_policy({"policy": "h2o", "params": {"budget": 0.6}})
    checks.append(h2o["class_name"] == "ObservedAttentionPress")
    kivi = describe_policy({"policy": "kivi4", "params": {}})
    checks.append(kivi["kind"] == "quantized_cache")
    checks.append(kivi["kwargs"]["nbits"] == 4)
    off = describe_policy({"policy": "off", "params": {}})
    checks.append(off["active"] is False)
    ok = all(checks)
    return {"ok": ok, "version": KVPOLICY_VERSION, "checks": len(checks)}


def main(argv):
    parser = argparse.ArgumentParser(prog="kolm-kvpolicy")
    parser.add_argument("--doctor", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--policy", default=None, help="path to KOLM_KV_POLICY JSON")
    parser.add_argument("--describe", action="store_true")
    parser.add_argument("--instantiate", action="store_true")
    args = parser.parse_args(argv)

    if args.self_test:
        out = self_test()
        sys.stdout.write(json.dumps(out, sort_keys=True) + "\n")
        return 0 if out["ok"] else 64

    if args.doctor:
        out = doctor()
        sys.stdout.write(json.dumps(out, sort_keys=True) + "\n")
        return 0 if out["ok"] else 2

    if not args.policy:
        sys.stderr.write(json.dumps({"ok": False, "error": "missing_policy"}) + "\n")
        return 64

    try:
        policy = _load_policy(args.policy)
        if args.instantiate:
            out = instantiate_policy(policy)
        else:
            out = {"ok": True, "version": KVPOLICY_VERSION, "plan": describe_policy(policy)}
        sys.stdout.write(json.dumps(out, sort_keys=True) + "\n")
        return 0 if out.get("ok") else 64
    except OptionalDependencyError as exc:
        sys.stderr.write(
            json.dumps(
                {
                    "ok": False,
                    "error": "missing_optional_dependency",
                    "module": exc.module,
                    "detail": exc.detail,
                    "install_hint": "pip install -r workers/itkv/requirements.txt",
                },
                sort_keys=True,
            )
            + "\n"
        )
        return 2
    except Exception as exc:
        sys.stderr.write(json.dumps({"ok": False, "error": "kvpolicy_failed", "detail": str(exc)}) + "\n")
        return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""
apps/runtime/backends/__init__.py

Backend registry. Single point of truth for the 14 compute backends shipped
with kolm. The CLI (`kolm compute list`, `kolm compute quote`) and the
server (POST /v1/compute/list) both consume this list.

The registry order is deliberate: locals first (fastest detect, no money),
remotes after (need credentials). Within each family, ordered by typical
preference.
"""

from __future__ import annotations

from typing import Dict, List, Type

from .base import BackendAdapter, BackendInfo, Detection, Quote
from .local_cpu import LocalCPUBackend
from .local_cuda import LocalCUDABackend
from .local_mps import LocalMPSBackend
from .local_mlx import LocalMLXBackend
from .local_rocm import LocalROCmBackend
from .local_directml import LocalDirectMLBackend
from .modal import ModalBackend
from .runpod import RunPodBackend
from .together import TogetherBackend
from .vast import VastBackend
from .lambda_cloud import LambdaCloudBackend
from .replicate import ReplicateBackend
from .fal import FalBackend
from .ssh import SSHBackend
from .vllm import VLLMBackend
from .sglang import SGLangBackend
from .tgi import TGIBackend
from .trt_llm import TRTLLMBackend


_REGISTRY: List[Type[BackendAdapter]] = [
    LocalCUDABackend,
    LocalROCmBackend,
    LocalMLXBackend,
    LocalMPSBackend,
    LocalDirectMLBackend,
    LocalCPUBackend,
    VLLMBackend,
    SGLangBackend,
    TGIBackend,
    TRTLLMBackend,
    ModalBackend,
    RunPodBackend,
    LambdaCloudBackend,
    TogetherBackend,
    ReplicateBackend,
    FalBackend,
    VastBackend,
    SSHBackend,
]


def all_backends() -> List[BackendAdapter]:
    return [cls() for cls in _REGISTRY]


def by_name(name: str) -> BackendAdapter:
    for cls in _REGISTRY:
        if cls.info.name == name:
            return cls()
    raise KeyError(f"unknown backend: {name}")


def list_for_cli() -> List[Dict]:
    """Return a JSON-serializable list of {name, family, description,
    available, reason, device_name} dicts for `kolm compute list`."""
    out: List[Dict] = []
    for adapter in all_backends():
        try:
            det: Detection = adapter.detect()
        except Exception as e:
            det = Detection(available=False, reason=f"detect crashed: {e}")
        out.append({
            "name": adapter.info.name,
            "family": adapter.info.family,
            "description": adapter.info.description,
            "available": det.available,
            "reason": det.reason,
            "device_name": det.device_name,
            "version": det.version,
            "requires_env": adapter.info.requires_env,
            "docs_url": adapter.info.docs_url,
        })
    return out


__all__ = [
    "BackendAdapter",
    "BackendInfo",
    "Detection",
    "Quote",
    "all_backends",
    "by_name",
    "list_for_cli",
]

"""
apps/runtime/multi_lora.py

Multi-LoRA serving. One base model, many adapters, switch per request.

The naive way to serve many fine-tuned variants of a base model is to load
each into its own GPU process. That gets expensive fast: each process holds
the base weights again. S-LoRA (Sheng et al 2023, arXiv:2311.03285) showed
you can keep one base model in memory and swap LoRA adapter weights per
request, because adapter swap is O(rank * num_layers * hidden) — kilobytes
to a few megabytes, dwarfed by the gigabytes of the base.

This module implements the routing layer on top of PEFT's PeftModel. The
expected stack:

    base model                Qwen2.5-3B-Instruct          ~6 GB bf16
    adapter pool              {refund-flagger, pii-redactor, ...}
        each adapter          ~5-50 MB on disk
    router                    MultiLoraRouter
        register(id, path)    extract LoRA weights, hold in CPU pool
        generate(id, prompt)  swap active adapter, run, swap back

For high-RPS deployments, this module exposes the building blocks; the
production server in apps/runtime/serve.py wires the router into the request
loop and adds queueing.

Surface:

    from apps.runtime.multi_lora import MultiLoraRouter

    router = MultiLoraRouter(base_model_id="Qwen/Qwen2.5-3B-Instruct")
    router.register("refund", "/var/kolm/adapters/refund/")
    router.register("pii", "/var/kolm/adapters/pii/")

    out = router.generate(adapter_id="refund", prompt="...", max_tokens=128)
    info = router.info()        # for the receipt block

The receipt records which adapter_id served the request and how long the
swap added; the K-score gate then verifies the adapter's signed artifact.

Citations:
  S-LoRA:          Sheng et al 2023, arXiv:2311.03285
  Punica:          Chen et al 2023, arXiv:2310.18547
  LoRAX:           Predibase, 2024
  vLLM multi-LoRA: vllm-project, 2024
"""

from __future__ import annotations

import dataclasses
import logging
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)


@dataclasses.dataclass(frozen=True)
class RouterConfig:
    """
    Router knobs.

    max_active_adapters     soft cap on adapters kept hot in the PEFT model.
                            When exceeded, LRU evicts the least-recently-used
                            and re-loads on demand.
    swap_log_threshold_ms   warn if adapter swap exceeds this; production
                            target is <10ms on a 3B model with rank=16.
    """

    max_active_adapters: int = 32
    swap_log_threshold_ms: float = 50.0
    default_generation: dict[str, Any] = dataclasses.field(
        default_factory=lambda: {
            "temperature": 0.7,
            "top_p": 0.95,
            "max_new_tokens": 512,
        }
    )


@dataclasses.dataclass
class AdapterInfo:
    """One entry in the registered-adapters pool."""

    adapter_id: str
    path: str
    loaded: bool = False
    requests_served: int = 0
    total_swap_ms: float = 0.0
    last_used_ns: int = 0


def _import_peft():
    try:
        import peft  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "peft is not installed. install with: pip install 'peft>=0.13.0'"
        ) from e
    return peft


def _import_transformers():
    try:
        import transformers  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "transformers is not installed. install with: "
            "pip install 'transformers>=4.45.0'"
        ) from e
    return transformers


class MultiLoraRouter:
    """
    One base model + many LoRA adapters + per-request switching.

    Thread-safe over the active-adapter pointer; concurrent generate calls
    serialize on a single lock. For higher concurrency, run multiple workers
    each holding their own router (S-LoRA-style sharded scheduling is the
    next step and lives in apps/runtime/serve.py).
    """

    def __init__(
        self,
        *,
        base_model_id: str,
        config: Optional[RouterConfig] = None,
        device_map: str = "auto",
        bf16: bool = True,
    ):
        self.base_model_id = base_model_id
        self.config = config or RouterConfig()
        self._device_map = device_map
        self._bf16 = bf16
        self._registry: "OrderedDict[str, AdapterInfo]" = OrderedDict()
        self._active_id: Optional[str] = None
        self._lock = threading.RLock()
        self._model = None
        self._tokenizer = None
        self._peft = None

    # --- lifecycle ---

    def _ensure_loaded(self):
        if self._model is not None:
            return
        transformers = _import_transformers()
        import torch

        dtype = torch.bfloat16 if self._bf16 else torch.float32
        self._tokenizer = transformers.AutoTokenizer.from_pretrained(
            self.base_model_id, trust_remote_code=True
        )
        if self._tokenizer.pad_token_id is None:
            self._tokenizer.pad_token_id = self._tokenizer.eos_token_id
        self._model = transformers.AutoModelForCausalLM.from_pretrained(
            self.base_model_id,
            torch_dtype=dtype,
            device_map=self._device_map,
            trust_remote_code=True,
        )
        self._peft = _import_peft()
        logger.info("MultiLoraRouter base model loaded: %s", self.base_model_id)

    # --- registration ---

    def register(self, adapter_id: str, path: str | Path) -> None:
        """Register a LoRA adapter directory under adapter_id."""
        if not adapter_id or "/" in adapter_id:
            raise ValueError(
                f"adapter_id must be a non-empty path-safe slug, got {adapter_id!r}"
            )
        p = str(path)
        if not Path(p).exists():
            raise FileNotFoundError(f"adapter path not found: {p}")
        with self._lock:
            self._registry[adapter_id] = AdapterInfo(adapter_id=adapter_id, path=p)
            logger.info("registered adapter id=%s path=%s", adapter_id, p)

    def unregister(self, adapter_id: str) -> None:
        with self._lock:
            info = self._registry.pop(adapter_id, None)
            if info is None:
                return
            # If it was the active one and is loaded in PEFT, detach.
            if self._model is not None and getattr(self._model, "peft_config", None):
                if adapter_id in self._model.peft_config:
                    self._model.delete_adapter(adapter_id)
            if self._active_id == adapter_id:
                self._active_id = None

    def list_adapters(self) -> list[AdapterInfo]:
        with self._lock:
            return [dataclasses.replace(v) for v in self._registry.values()]

    # --- swapping ---

    def _swap_active(self, adapter_id: str) -> float:
        """
        Make adapter_id the active adapter on the PEFT model. Loads from disk
        if not yet hot. Returns swap latency in ms.
        """
        if adapter_id not in self._registry:
            raise KeyError(f"adapter not registered: {adapter_id}")

        self._ensure_loaded()
        info = self._registry[adapter_id]
        t0_ns = time.monotonic_ns()

        # First time: turn the base into a PeftModel with this adapter as
        # the initial one. Subsequent calls use load_adapter + set_adapter.
        if not isinstance(self._model, self._peft.PeftModel):
            self._model = self._peft.PeftModel.from_pretrained(
                self._model, info.path, adapter_name=adapter_id
            )
            info.loaded = True
        elif adapter_id not in getattr(self._model, "peft_config", {}):
            self._evict_if_needed()
            self._model.load_adapter(info.path, adapter_name=adapter_id)
            info.loaded = True

        if self._active_id != adapter_id:
            self._model.set_adapter(adapter_id)
            self._active_id = adapter_id

        # LRU bump.
        self._registry.move_to_end(adapter_id)
        info.last_used_ns = time.monotonic_ns()

        swap_ms = (time.monotonic_ns() - t0_ns) / 1e6
        info.total_swap_ms += swap_ms
        if swap_ms > self.config.swap_log_threshold_ms:
            logger.warning(
                "slow adapter swap: %s took %.2fms (threshold %.2fms)",
                adapter_id,
                swap_ms,
                self.config.swap_log_threshold_ms,
            )
        return swap_ms

    def _evict_if_needed(self) -> None:
        if not isinstance(self._model, self._peft.PeftModel):
            return
        loaded_ids = list(getattr(self._model, "peft_config", {}).keys())
        if len(loaded_ids) < self.config.max_active_adapters:
            return
        # Evict the LRU entry that is NOT the active one.
        for aid in self._registry:
            if aid in loaded_ids and aid != self._active_id:
                logger.info("evicting LRU adapter from PEFT pool: %s", aid)
                self._model.delete_adapter(aid)
                info = self._registry.get(aid)
                if info is not None:
                    info.loaded = False
                return

    # --- inference ---

    def generate(
        self,
        *,
        adapter_id: str,
        prompt: str,
        max_new_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        top_p: Optional[float] = None,
        stop: Optional[Sequence[str]] = None,
        seed: Optional[int] = None,
    ) -> dict[str, Any]:
        """
        Generate text under adapter_id. Returns a dict with text + timing +
        the receipt sub-block so the calling server can record it.
        """
        with self._lock:
            swap_ms = self._swap_active(adapter_id)
            info = self._registry[adapter_id]
            gen_cfg = dict(self.config.default_generation)
            if max_new_tokens is not None:
                gen_cfg["max_new_tokens"] = int(max_new_tokens)
            if temperature is not None:
                gen_cfg["temperature"] = float(temperature)
            if top_p is not None:
                gen_cfg["top_p"] = float(top_p)
            if seed is not None:
                import torch

                torch.manual_seed(int(seed))

            t0_ns = time.monotonic_ns()
            inputs = self._tokenizer(prompt, return_tensors="pt").to(self._model.device)
            output_ids = self._model.generate(
                **inputs,
                do_sample=gen_cfg.get("temperature", 0.0) > 0,
                **{k: v for k, v in gen_cfg.items() if k in (
                    "max_new_tokens", "temperature", "top_p", "repetition_penalty"
                )},
                pad_token_id=self._tokenizer.pad_token_id,
            )
            gen_text = self._tokenizer.decode(
                output_ids[0][inputs["input_ids"].shape[1]:],
                skip_special_tokens=True,
            )
            generate_ms = (time.monotonic_ns() - t0_ns) / 1e6
            info.requests_served += 1

            if stop:
                for s in stop:
                    idx = gen_text.find(s)
                    if idx >= 0:
                        gen_text = gen_text[:idx]
                        break

            return {
                "text": gen_text,
                "adapter_id": adapter_id,
                "swap_ms": float(swap_ms),
                "generate_ms": float(generate_ms),
                "input_tokens": int(inputs["input_ids"].shape[1]),
                "output_tokens": int(output_ids.shape[1] - inputs["input_ids"].shape[1]),
            }

    # --- introspection ---

    def info(self) -> dict[str, Any]:
        """
        Snapshot of router state. Used by the receipt builder so an auditor
        can see how many adapters are in the pool and which one served.
        """
        with self._lock:
            return {
                "base_model_id": self.base_model_id,
                "active_adapter_id": self._active_id,
                "adapters_registered": len(self._registry),
                "adapters": [
                    {
                        "adapter_id": v.adapter_id,
                        "loaded": v.loaded,
                        "requests_served": v.requests_served,
                        "avg_swap_ms": (
                            v.total_swap_ms / v.requests_served
                            if v.requests_served
                            else 0.0
                        ),
                    }
                    for v in self._registry.values()
                ],
            }


def receipt_block(router: MultiLoraRouter, *, adapter_id: str, swap_ms: float) -> dict[str, Any]:
    """Stable receipt sub-block emitted per multi-LoRA request."""
    return {
        "algo": "multi_lora_serving",
        "base_model_id": router.base_model_id,
        "adapter_id": adapter_id,
        "swap_ms": float(swap_ms),
        "papers": [
            "arXiv:2311.03285",  # S-LoRA
            "arXiv:2310.18547",  # Punica
        ],
        "schema_version": "multi_lora.v1",
    }


__all__ = [
    "RouterConfig",
    "AdapterInfo",
    "MultiLoraRouter",
    "receipt_block",
]

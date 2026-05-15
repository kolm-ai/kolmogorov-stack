"""
apps/runtime/disagg.py

Disaggregated prefill / decode serving.

DistServe (Zhong et al, 2024, arXiv:2401.09670) and Mooncake (Qin et al,
2024, arXiv:2407.00079) showed that prefill (compute-bound) and decode
(memory-bound) have different optimal parallelism, so co-running them on the
same GPUs leaves throughput on the table. Splitting them across two GPU
pools (or two host fleets) with a KV-cache transport layer in between can
double goodput at the same latency budget.

vLLM 0.7+ implements this via --kv-transfer-config and the disagg_prefill
flag. This module:
  - detects whether the local host can run in-proc disagg (>=2 GPUs)
  - emits vLLM engine kwargs for both single-node and cross-host disagg
  - provides a small cross-host router (POST prefill to one fleet, then
    POST decode to a second fleet, passing the prefill KV by reference)

Selection guide:

    mode         when                       cost                expected gain
    -------------------------------------------------------------------------
    SINGLE       1 GPU                      baseline             1.0x
    INPROC       2+ GPUs, same host         free                 1.4-1.8x goodput
    CROSSHOST    multi-host fleets, IB/RDMA needs router         2.0-2.5x goodput

Spec field on a kolm artifact:

    "serve": {
      "disagg": {
        "mode": "single|inproc|crosshost",
        "prefill_devices": [0, 1],
        "decode_devices": [2, 3],
        "kv_transport": "nvlink|rdma|tcp",
        "prefill_url": "http://prefill-fleet:8000",
        "decode_url":  "http://decode-fleet:8000"
      }
    }
"""

from __future__ import annotations

import dataclasses
import enum
import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)


class DisaggMode(str, enum.Enum):
    SINGLE = "single"
    INPROC = "inproc"
    CROSSHOST = "crosshost"


class KVTransport(str, enum.Enum):
    NVLINK = "nvlink"
    RDMA = "rdma"
    TCP = "tcp"


@dataclasses.dataclass(frozen=True)
class DisaggConfig:
    mode: DisaggMode = DisaggMode.SINGLE
    prefill_devices: tuple[int, ...] = ()
    decode_devices: tuple[int, ...] = ()
    kv_transport: KVTransport = KVTransport.NVLINK
    prefill_url: Optional[str] = None
    decode_url: Optional[str] = None
    prefill_role: Optional[str] = None  # "kv_producer" | "kv_consumer" for vllm
    buffer_size: int = 1 << 30           # 1 GiB KV pipe buffer

    def is_off(self) -> bool:
        return self.mode is DisaggMode.SINGLE

    def for_vllm_engine_args(self) -> dict[str, Any]:
        """Return engine kwargs to pass into vllm.LLM(...) for this mode."""
        if self.mode is DisaggMode.SINGLE:
            return {}

        if self.mode is DisaggMode.INPROC:
            if not (self.prefill_devices and self.decode_devices):
                raise ValueError("INPROC disagg requires prefill_devices and decode_devices")
            overlap = set(self.prefill_devices) & set(self.decode_devices)
            if overlap:
                raise ValueError(f"prefill and decode devices overlap: {sorted(overlap)}")
            return {
                "kv_transfer_config": {
                    "kv_connector": "PyNcclConnector",
                    "kv_role": self.prefill_role or "kv_both",
                    "kv_buffer_size": self.buffer_size,
                    "kv_rank": 0,
                    "kv_parallel_size": 2,
                },
                "disable_async_output_proc": False,
            }

        if self.mode is DisaggMode.CROSSHOST:
            connector = {
                KVTransport.RDMA: "MooncakeConnector",
                KVTransport.NVLINK: "PyNcclConnector",
                KVTransport.TCP: "PyNcclConnector",
            }[self.kv_transport]
            role = self.prefill_role or "kv_producer"
            if role not in ("kv_producer", "kv_consumer", "kv_both"):
                raise ValueError(f"invalid prefill_role {role!r}")
            return {
                "kv_transfer_config": {
                    "kv_connector": connector,
                    "kv_role": role,
                    "kv_buffer_size": self.buffer_size,
                    "kv_rank": 0 if role == "kv_producer" else 1,
                    "kv_parallel_size": 2,
                    "kv_transport": self.kv_transport.value,
                },
            }

        raise ValueError(f"unhandled disagg mode {self.mode}")


def detect_inproc_capability() -> bool:
    """Return True iff the host has >=2 visible CUDA GPUs and KOLM_DISAGG=1."""
    if os.environ.get("KOLM_DISAGG", "").strip() not in ("1", "true", "True"):
        return False
    try:
        import torch
    except Exception:
        return False
    if not torch.cuda.is_available():
        return False
    return torch.cuda.device_count() >= 2


def auto_pick(*, has_remote_fleet: bool = False) -> DisaggConfig:
    """Pick a default DisaggConfig based on local hardware + env."""
    if has_remote_fleet and os.environ.get("KOLM_DISAGG_REMOTE"):
        # Caller signalled a known prefill+decode fleet pair available.
        return DisaggConfig(
            mode=DisaggMode.CROSSHOST,
            prefill_url=os.environ.get("KOLM_DISAGG_PREFILL_URL"),
            decode_url=os.environ.get("KOLM_DISAGG_DECODE_URL"),
            kv_transport=KVTransport(os.environ.get("KOLM_DISAGG_KV_TRANSPORT", "rdma")),
            prefill_role="kv_producer",
        )
    if detect_inproc_capability():
        try:
            import torch
            n = torch.cuda.device_count()
        except Exception:
            n = 0
        half = max(1, n // 2)
        return DisaggConfig(
            mode=DisaggMode.INPROC,
            prefill_devices=tuple(range(0, half)),
            decode_devices=tuple(range(half, n)),
            kv_transport=KVTransport.NVLINK,
        )
    return DisaggConfig(mode=DisaggMode.SINGLE)


def from_spec_field(field: Mapping[str, Any] | None) -> DisaggConfig:
    if not field:
        return DisaggConfig(mode=DisaggMode.SINGLE)
    mode = DisaggMode(field.get("mode", "single"))
    return DisaggConfig(
        mode=mode,
        prefill_devices=tuple(field.get("prefill_devices", []) or ()),
        decode_devices=tuple(field.get("decode_devices", []) or ()),
        kv_transport=KVTransport(field.get("kv_transport", "nvlink")),
        prefill_url=field.get("prefill_url"),
        decode_url=field.get("decode_url"),
        prefill_role=field.get("prefill_role"),
        buffer_size=int(field.get("buffer_size", 1 << 30)),
    )


# ----- cross-host router --------------------------------------------------


class CrossHostRouter:
    """
    Tiny urllib-based client that fan-routes a chat completion across a
    prefill fleet and a decode fleet.

    Wire shape:
      POST {prefill_url}/v1/disagg/prefill  body={messages, model, max_tokens, ...}
        -> {"prefill_session": "<id>", "kv_handle": {...}}
      POST {decode_url}/v1/disagg/decode    body={prefill_session, kv_handle, max_tokens}
        -> {"text": "...", "tokens": [...], "usage": {...}}

    Both fleets are vLLM 0.7+ servers configured with matching kv_transfer_config
    (kv_role=kv_producer on prefill, kv_role=kv_consumer on decode).
    """

    def __init__(self, cfg: DisaggConfig, *, timeout_s: float = 60.0):
        if cfg.mode is not DisaggMode.CROSSHOST:
            raise ValueError("CrossHostRouter requires mode=CROSSHOST")
        if not (cfg.prefill_url and cfg.decode_url):
            raise ValueError("CROSSHOST disagg needs prefill_url and decode_url")
        self.cfg = cfg
        self.timeout_s = timeout_s

    def chat(self, body: Mapping[str, Any]) -> dict:
        prefill = self._post(self.cfg.prefill_url, "/v1/disagg/prefill", dict(body))
        session = prefill.get("prefill_session")
        kv_handle = prefill.get("kv_handle")
        if not session:
            raise RuntimeError(f"prefill response missing prefill_session: {prefill!r}")
        decode_body: dict[str, Any] = {
            "prefill_session": session,
            "kv_handle": kv_handle,
            "max_tokens": body.get("max_tokens", 256),
            "temperature": body.get("temperature", 0.0),
        }
        if "tools" in body:
            decode_body["tools"] = body["tools"]
        return self._post(self.cfg.decode_url, "/v1/disagg/decode", decode_body)

    def _post(self, base: str, path: str, body: Mapping[str, Any]) -> dict:
        url = base.rstrip("/") + path
        data = json.dumps(dict(body)).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"content-type": "application/json", "accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                payload = resp.read()
        except urllib.error.HTTPError as exc:
            body_text = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{url} -> HTTP {exc.code}: {body_text[:300]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"{url} -> connection error: {exc}") from exc
        return json.loads(payload.decode("utf-8"))


def provenance(cfg: DisaggConfig) -> dict[str, Any]:
    """Receipt provenance dict for a request served via this config."""
    base: dict[str, Any] = {"mode": cfg.mode.value}
    if cfg.mode is DisaggMode.INPROC:
        base.update({
            "prefill_devices": list(cfg.prefill_devices),
            "decode_devices": list(cfg.decode_devices),
            "kv_transport": cfg.kv_transport.value,
        })
    elif cfg.mode is DisaggMode.CROSSHOST:
        base.update({
            "prefill_url": cfg.prefill_url,
            "decode_url": cfg.decode_url,
            "kv_transport": cfg.kv_transport.value,
        })
    return base


__all__ = [
    "DisaggMode",
    "KVTransport",
    "DisaggConfig",
    "detect_inproc_capability",
    "auto_pick",
    "from_spec_field",
    "CrossHostRouter",
    "provenance",
]

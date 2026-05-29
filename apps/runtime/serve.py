"""
apps/runtime/serve.py

HTTP server for generative .kolm artifacts. Boots vLLM (preferred) or
transformers (fallback) and exposes an OpenAI-compatible /v1/chat/completions
endpoint, /v1/completions, /v1/models. The artifact's manifest specifies the
target model and (optional) draft model for speculative decoding.

Invocation:
  python -m apps.runtime.serve --artifact path/to/foo.kolm --port 8765

Or via the CLI:
  kolm serve --http foo.kolm --port 8765

What we do for tokens/sec:
  1. Prefer vLLM if installed (PagedAttention + continuous batching + AWQ).
  2. Add a draft model for speculative decoding when the manifest declares one.
  3. Enable prefix KV cache for chat-style workloads.
  4. FP8 KV cache when the GPU supports it (Hopper, Blackwell).
  5. Fall through to transformers.generate() when vLLM isn't installed.

What we DON'T do:
  - We don't ship our own quantizer. AWQ / GPTQ weights come pre-quantized
    in the artifact or via HF Hub.
  - We don't reimplement OpenAI's full schema — just chat, completions, models.
"""

from __future__ import annotations
import argparse
import base64
import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path
from typing import Optional, Dict, Any, List
from http.server import HTTPServer, BaseHTTPRequestHandler


# --------------------------------------------------------------------------
# Artifact loading
# --------------------------------------------------------------------------

def load_manifest(artifact_path: str) -> Dict[str, Any]:
    with zipfile.ZipFile(artifact_path) as z:
        try:
            return json.loads(z.read("manifest.json").decode("utf-8"))
        except KeyError as exc:
            raise FileNotFoundError(f"no manifest.json in {artifact_path}") from exc


def has_lora_pack(artifact_path: str) -> Optional[str]:
    """If the artifact carries a LoRA pack, extract it to a temp dir and return the path."""
    with zipfile.ZipFile(artifact_path) as z:
        adapter_paths = [n for n in z.namelist() if n.endswith("adapter_model.safetensors")]
        if not adapter_paths:
            return None
        tmp = Path(os.environ.get("KOLM_LORA_DIR", os.path.expanduser("~/.kolm/lora")))
        target = tmp / Path(artifact_path).stem
        target.mkdir(parents=True, exist_ok=True)
        for n in z.namelist():
            if n.startswith(Path(adapter_paths[0]).parent.as_posix()):
                z.extract(n, target)
        return str(target / Path(adapter_paths[0]).parent)


# --------------------------------------------------------------------------
# Engine selection
# --------------------------------------------------------------------------

class Engine:
    """Polymorphic shape: vllm | transformers. Caller doesn't care which."""

    name: str

    def chat(self, messages: List[Dict[str, str]], **kwargs) -> Dict[str, Any]:
        raise NotImplementedError

    def complete(self, prompt: str, **kwargs) -> Dict[str, Any]:
        raise NotImplementedError

    def info(self) -> Dict[str, Any]:
        raise NotImplementedError


def _resolve_prompt_cache_flag() -> bool:
    """KOLM_PROMPT_CACHE in {on, off, auto}; auto-on for chat workloads."""
    v = (os.environ.get("KOLM_PROMPT_CACHE") or "auto").strip().lower()
    if v in ("off", "false", "0", "no", "none"):
        return False
    return True


def _resolve_max_batch() -> int:
    """KOLM_MAX_NUM_SEQS — continuous batching width for vLLM. Default 8."""
    try:
        return max(1, int(os.environ.get("KOLM_MAX_NUM_SEQS", "8")))
    except ValueError:
        return 8


def _resolve_kv_cache_backend() -> str:
    """KOLM_KV_CACHE_BACKEND — 'shard' or 'default'. Default 'default'.

    Set by the CLI's --kv-cache policy resolver (src/kv-cache-policy.js)
    before the Python child starts. 'shard' switches the transformers
    engine to ShardCache (10x KV compression on RoPE families); vLLM
    runs its own PagedAttention KV cache and the flag is recorded for
    /info honesty but has no engine-level effect there today.
    """
    val = os.environ.get("KOLM_KV_CACHE_BACKEND", "default").strip().lower()
    return "shard" if val == "shard" else "default"


def _resolve_chunked_prefill() -> bool:
    """KOLM_CHUNKED_PREFILL in {on, off, auto}; auto=on (vLLM V1 default).

    Set by the serving-features resolver (src/serve-config.js
    resolveServingFeatures). Chunked prefill co-schedules long prefills with
    in-flight decodes so a big prompt does not spike p95 inter-token latency.
    """
    v = (os.environ.get("KOLM_CHUNKED_PREFILL") or "auto").strip().lower()
    if v in ("off", "false", "0", "no", "none"):
        return False
    return True


def _resolve_max_num_batched_tokens(default: int = 4096) -> int:
    """KOLM_MAX_NUM_BATCHED_TOKENS — chunked-prefill token budget per step.

    Lower (2048) favors inter-token latency; higher (8192) favors TTFT and
    throughput. Distinct from KOLM_MAX_NUM_SEQS (continuous-batching width).
    """
    try:
        return max(1, int(os.environ.get("KOLM_MAX_NUM_BATCHED_TOKENS", str(default))))
    except (ValueError, TypeError):
        return default


def _resolve_kv_policy() -> Dict[str, Any]:
    """Parse KOLM_KV_POLICY JSON env -> policy dict. Default {'policy':'default'}.

    The JS picker (src/serve-config.js selectKvCachePolicy) serializes the full
    descriptor {policy, kind, params} into this env var. We parse it tolerantly:
    a malformed value degrades to the default full cache rather than failing.
    """
    raw = os.environ.get("KOLM_KV_POLICY")
    if not raw:
        # Back-compat: a bare KOLM_KV_CACHE_BACKEND=shard maps to the shard policy.
        if _resolve_kv_cache_backend() == "shard":
            return {"policy": "shard", "kind": "compress", "params": {}}
        return {"policy": "default", "kind": "off", "params": {}}
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict) and obj.get("policy"):
            obj.setdefault("kind", "off")
            obj.setdefault("params", {})
            return obj
    except (json.JSONDecodeError, TypeError):
        pass
    return {"policy": "default", "kind": "off", "params": {}}


def _resolve_lora_modules() -> List[Dict[str, str]]:
    """Parse KOLM_LORA_MODULES ('id1=path1,id2=path2') -> [{id, path}].

    Set by the multi-LoRA planner (src/serve-config.js planMultiLora). When
    empty, multi-LoRA serving is off and only the artifact's own packed adapter
    (if any) is loaded.
    """
    raw = (os.environ.get("KOLM_LORA_MODULES") or "").strip()
    out: List[Dict[str, str]] = []
    if not raw:
        return out
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            mid, _, mpath = part.partition("=")
            mid, mpath = mid.strip(), mpath.strip()
            if mid and mpath:
                out.append({"id": mid, "path": mpath})
    return out


def resolve_lora_modules() -> List[Dict[str, str]]:
    """Public alias used by the multi-LoRA serve path and the probe harness."""
    return _resolve_lora_modules()


def _build_vllm_lora_requests(modules: List[Dict[str, str]]) -> Dict[str, Any]:
    """Build a {adapter_id -> LoRARequest} map for vLLM per-request switching.

    Returns an empty dict (and logs) when vLLM's LoRARequest is unavailable so
    the caller can proceed with the base model. Never raises.
    """
    requests: Dict[str, Any] = {}
    try:
        from vllm.lora.request import LoRARequest  # type: ignore
    except Exception:
        if modules:
            sys.stderr.write(
                "[serve] vllm.lora.request.LoRARequest unavailable; "
                "multi-LoRA per-request switching disabled\n"
            )
        return requests
    for i, m in enumerate(modules):
        try:
            requests[m["id"]] = LoRARequest(m["id"], i + 1, m["path"])
        except Exception as exc:  # pragma: no cover - depends on vllm version
            sys.stderr.write(f"[serve] failed to build LoRARequest for {m.get('id')}: {exc}\n")
    return requests


def _measure_peak_memory_mb() -> Optional[float]:
    """Peak working-set VRAM for THIS process.

    Precedence (per probe spec): nvidia-smi per-PID used_memory (captures the
    full footprint incl. PagedAttention KV pool + CUDA context — the real
    'will it fit' number) > torch.cuda.max_memory_allocated (allocator-tracked
    tensors only). Returns None when neither is reachable (degrade honestly).
    """
    pid = os.getpid()
    # 1. nvidia-smi per-PID (primary).
    try:
        import subprocess
        res = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if res.returncode == 0 and res.stdout:
            for line in res.stdout.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 2 and parts[0].isdigit() and int(parts[0]) == pid:
                    return float(parts[1])
    except Exception:
        pass
    # 2. torch allocator (secondary).
    try:
        import torch
        if torch.cuda.is_available():
            return float(torch.cuda.max_memory_allocated()) / (1024.0 * 1024.0)
    except Exception:
        pass
    return None


def _engine_runtime_version(engine_name: str) -> Optional[str]:
    """Free-form runtime version string for the passport (vLLM/transformers)."""
    try:
        if engine_name == "vllm":
            import vllm  # type: ignore
            return "vllm " + str(getattr(vllm, "__version__", "unknown"))
        import transformers  # type: ignore
        return "transformers " + str(getattr(transformers, "__version__", "unknown"))
    except Exception:
        return None


# --------------------------------------------------------------------------
# KV-cache policy press / quant-cache builders (transformers engine).
#
# Eviction presses (StreamingLLM / SnapKV / H2O / PyramidKV) come from NVIDIA's
# kvpress (Apache-2.0, pip install kvpress) as forward hooks; the KIVI quant
# axis uses transformers' native QuantizedCache. vLLM/PagedAttention cannot host
# these — the JS picker reports runtime_can_enforce:false for those. Every
# import is soft: a missing optional dep degrades to the default cache + a note.
# --------------------------------------------------------------------------

def build_press(policy: Dict[str, Any]):
    """policy dict -> kvpress press instance, or None.

    Mirrors workers/itkv/scripts/kvpolicy.py build_press so the two stay in sync.
    """
    if not policy or not isinstance(policy, dict):
        return None
    name = str(policy.get("policy") or "").lower()
    params = policy.get("params") or {}
    try:
        import kvpress  # type: ignore
    except Exception:
        if name in ("streaming", "snapkv", "h2o", "pyramidkv"):
            sys.stderr.write(
                "[serve] kvpress not installed; KV policy "
                f"'{name}' falls back to default cache. "
                "Install: pip install kvpress\n"
            )
        return None
    cr = float(params.get("budget", 0.5))
    cr = 1.0 - cr if 0.0 < cr <= 1.0 else 0.5  # budget=fraction kept -> compression ratio dropped
    try:
        if name == "streaming":
            return kvpress.StreamingLLMPress(
                n_sink=int(params.get("sink_tokens", 4)),
                n_local=int(params.get("window_tokens", 1020)),
            )
        if name == "snapkv":
            return kvpress.SnapKVPress(
                compression_ratio=cr,
                window_size=int(params.get("window_tokens", 64)),
                kernel_size=int(params.get("kernel_size", 5)),
            )
        if name == "h2o":
            return kvpress.ObservedAttentionPress(compression_ratio=cr)
        if name == "pyramidkv":
            return kvpress.PyramidKVPress(compression_ratio=cr)
    except Exception as exc:  # pragma: no cover - depends on kvpress version
        sys.stderr.write(f"[serve] kvpress press build failed for '{name}': {exc}\n")
    return None


def quantized_cache_for(policy: Dict[str, Any]):
    """policy dict (kivi2/kivi4) -> a callable that builds a transformers
    QuantizedCache, or None. KIVI = asymmetric per-channel/per-token KV quant."""
    if not policy or not isinstance(policy, dict):
        return None
    name = str(policy.get("policy") or "").lower()
    if name not in ("kivi2", "kivi4"):
        return None
    params = policy.get("params") or {}
    nbits = int(params.get("nbits", 2 if name == "kivi2" else 4))

    def _make(model_config=None):
        try:
            from transformers import QuantizedCacheConfig, HQQQuantizedCache  # type: ignore
            cfg = QuantizedCacheConfig(backend="hqq", nbits=nbits, axis_key=1, axis_value=1)
            return HQQQuantizedCache(cache_config=cfg)
        except Exception:
            try:
                from transformers import QuantizedCache, QuantizedCacheConfig  # type: ignore
                cfg = QuantizedCacheConfig(backend="hqq", nbits=nbits, axis_key=1, axis_value=1)
                return QuantizedCache(cfg)
            except Exception as exc:  # pragma: no cover - depends on transformers ver
                sys.stderr.write(f"[serve] QuantizedCache ({name}) unavailable: {exc}\n")
                return None

    return _make


def _build_kv_cache_for_policy(model, policy: Dict[str, Any]):
    """Resolve a policy dict into (press_or_None, quant_cache_fn_or_None,
    active_policy_str). Returns the default cache (None, None, 'default') for
    'off'/'default'/'shard' or when the optional dep is missing."""
    if not policy or not isinstance(policy, dict):
        return None, None, "default"
    name = str(policy.get("policy") or "default").lower()
    if name in ("off", "default", "shard"):
        return None, None, "default"
    if name in ("kivi2", "kivi4"):
        fn = quantized_cache_for(policy)
        return None, fn, (name if fn is not None else "default")
    press = build_press(policy)
    if press is not None:
        sys.stderr.write(f"[serve] KV policy '{name}' active (kvpress eviction)\n")
        return press, None, name
    return None, None, "default"


def _try_vllm(target_model: str, draft_model: Optional[str], lora_dir: Optional[str]) -> Optional[Engine]:
    try:
        from vllm import LLM, SamplingParams
    except ImportError:
        return None

    kv_cache_dtype = "auto"
    # FP8 KV cache on Hopper/Blackwell when supported.
    try:
        import torch
        if torch.cuda.is_available():
            major, _ = torch.cuda.get_device_capability(0)
            if major >= 9:
                kv_cache_dtype = "fp8"
    except Exception:
        pass

    prefix_cache_enabled = _resolve_prompt_cache_flag()
    max_num_seqs = _resolve_max_batch()
    kv_cache_backend = _resolve_kv_cache_backend()
    kv_policy = _resolve_kv_policy()
    num_spec_tokens = int(os.environ.get("KOLM_NUM_SPECULATIVE_TOKENS", "5"))
    chunked_prefill = _resolve_chunked_prefill()
    max_num_batched_tokens = _resolve_max_num_batched_tokens()
    # The kernel oracle (src/serve-config.js resolveServingKernel) resolved the
    # exact mixed-input GEMM kernel string + kv_cache_dtype on the CLI side and
    # threaded them in. Honor them when present; otherwise keep the legacy
    # auto-detect (vLLM still converts gptq/awq -> *_marlin on its own).
    quantization = (os.environ.get("KOLM_SERVE_QUANTIZATION") or "").strip() or None
    kv_dtype_override = (os.environ.get("KOLM_SERVE_KV_CACHE_DTYPE") or "").strip()
    if kv_dtype_override:
        kv_cache_dtype = kv_dtype_override

    # KV-policy: vLLM can only honor the QUANT axis (kv_cache_dtype) + sliding
    # window, never the pluggable eviction presses (those are transformers-only).
    if kv_policy.get("kind") == "quant" and kv_cache_dtype == "auto":
        kv_cache_dtype = "fp8"
    elif kv_policy.get("kind") in ("eviction", "compress") and kv_policy.get("policy") not in ("default", "off"):
        sys.stderr.write(
            f"[serve] vLLM cannot enforce KV policy '{kv_policy.get('policy')}' "
            "(PagedAttention owns its cache); honoring the quant axis only. "
            "Use the transformers engine (KOLM_FORCE_TRANSFORMERS=1) for eviction.\n"
        )
    if kv_cache_backend == "shard":
        # vLLM owns its own PagedAttention KV cache and does not accept a
        # HuggingFace Cache subclass. We record the operator's intent so
        # /info surfaces it (W916-I5), but it has no engine-level effect
        # here. The transformers fallback path below DOES honor it.
        sys.stderr.write(
            "[serve] vLLM ignores --kv-cache shard (uses PagedAttention); "
            "running with native vLLM cache. Fall back to transformers "
            "(KOLM_FORCE_TRANSFORMERS=1) to use Shard.\n"
        )

    llm_kwargs = dict(
        model=target_model,
        enable_prefix_caching=prefix_cache_enabled,
        enable_chunked_prefill=chunked_prefill,
        max_num_batched_tokens=max_num_batched_tokens,
        kv_cache_dtype=kv_cache_dtype,
        dtype="auto",
        max_model_len=int(os.environ.get("KOLM_MAX_MODEL_LEN", "8192")),
        max_num_seqs=max_num_seqs,
    )
    if quantization:
        llm_kwargs["quantization"] = quantization

    # W921 — speculative decoding via the MODERN vLLM speculative_config dict.
    # An EAGLE/Medusa head (head_kind eagle/eagle2/eagle3/medusa) is served via
    # {'method': head_kind, 'model': head, 'num_speculative_tokens': K}; a plain
    # separate draft model omits 'method'. NO deprecated flat speculative_model.
    spec_head_kind = (os.environ.get("KOLM_SPEC_HEAD_KIND") or "").strip().lower()
    speculative_config = None
    if draft_model:
        try:
            from apps.runtime.eagle3 import build_vllm_speculative_config
            tp = int(os.environ.get("KOLM_TENSOR_PARALLEL_SIZE", "1"))
            speculative_config = build_vllm_speculative_config(
                {
                    "head_kind": spec_head_kind or "draft_model",
                    "head_id": draft_model,
                    "num_speculative_tokens": num_spec_tokens,
                    "supported": True,
                },
                tp=tp,
            )
        except Exception as exc:
            sys.stderr.write(f"[serve] speculative_config build failed ({exc}); using plain config\n")
            speculative_config = None
        if speculative_config is None:
            # Fallback: minimal modern dict (still NOT the deprecated flat kwargs).
            speculative_config = {"model": draft_model, "num_speculative_tokens": num_spec_tokens}
        llm_kwargs["speculative_config"] = speculative_config

    # Multi-LoRA: one base + N adapters switched per request (S-LoRA / vLLM
    # --enable-lora). Either an artifact-packed adapter (lora_dir) or an
    # explicit adapter pool from KOLM_LORA_MODULES enables LoRA.
    lora_modules = _resolve_lora_modules()
    if lora_dir or lora_modules:
        llm_kwargs["enable_lora"] = True
        if lora_modules:
            try:
                llm_kwargs["max_loras"] = max(1, int(os.environ.get("KOLM_MAX_LORAS", str(len(lora_modules)))))
                llm_kwargs["max_lora_rank"] = max(1, int(os.environ.get("KOLM_MAX_LORA_RANK", "16")))
            except (ValueError, TypeError):
                pass

    llm = LLM(**llm_kwargs)
    lora_requests = _build_vllm_lora_requests(lora_modules) if lora_modules else {}

    class VLLMEngine(Engine):
        name = "vllm"

        def __init__(self):
            self.llm = llm
            self.target = target_model
            self.draft = draft_model
            self.num_spec_tokens = num_spec_tokens if draft_model else 0
            self.spec_head_kind = spec_head_kind if draft_model else None
            self.speculative_config = speculative_config
            self.lora_requests = lora_requests
            # Rolling counters for /info acceptance-rate reporting. vLLM's
            # internal metrics expose accepted tokens; we fall back to a
            # token-vs-step ratio when those aren't reachable.
            self._req_count = 0
            self._tok_count = 0
            self._ttft_ms_sum = 0.0
            self._gen_s_sum = 0.0

        def _gen(self, sp, fn_args):
            t0 = time.time()
            outs = getattr(self.llm, fn_args[0])(*fn_args[1:], sp)
            elapsed = time.time() - t0
            text = outs[0].outputs[0].text
            tok_ids = outs[0].outputs[0].token_ids
            self._req_count += 1
            self._tok_count += len(tok_ids)
            self._gen_s_sum += elapsed
            ttft_ms = None
            try:
                # vLLM 0.6+ exposes per-output time_to_first_token in metrics
                m = getattr(outs[0], "metrics", None)
                if m is not None and getattr(m, "first_token_time", None) and getattr(m, "arrival_time", None):
                    ttft_ms = max(0.0, (m.first_token_time - m.arrival_time) * 1000.0)
            except Exception:
                ttft_ms = None
            if ttft_ms is not None:
                self._ttft_ms_sum += ttft_ms
            return {
                "text": text,
                "tokens": len(tok_ids),
                "elapsed_s": elapsed,
                "ttft_ms": ttft_ms,
                "tok_s": (len(tok_ids) / elapsed) if elapsed > 0 else None,
            }

        def chat(self, messages, max_new_tokens=512, temperature=0.2, top_p=0.9):
            sp = SamplingParams(temperature=temperature, top_p=top_p, max_tokens=max_new_tokens)
            return self._gen(sp, ("chat", messages))

        def complete(self, prompt, max_new_tokens=512, temperature=0.2, top_p=0.9):
            sp = SamplingParams(temperature=temperature, top_p=top_p, max_tokens=max_new_tokens)
            return self._gen(sp, ("generate", [prompt]))

        def _spec_metrics(self):
            """Read vLLM spec-decode counters. Returns (acceptance_rate,
            mean_accept_length) — each None when unreachable (never fabricated).
            mean_accept_length = accepted_tokens / sum(batch_sizes) (vLLM PR
            #11552). Both wrapped in try/except so a counter-API drift across
            vLLM versions surfaces null, not a crash."""
            acc_rate = None
            mean_accept_length = None
            try:
                stats = getattr(self.llm.llm_engine, "stat_logger", None)
                if stats and hasattr(stats, "spec_decode_metrics"):
                    sm = stats.spec_decode_metrics
                    if sm is not None:
                        if getattr(sm, "draft_acceptance_rate", None) is not None:
                            acc_rate = float(sm.draft_acceptance_rate)
                        accepted = getattr(sm, "accepted_tokens", None)
                        drafts = getattr(sm, "num_spec_tokens", None) or getattr(sm, "draft_tokens", None)
                        if accepted is not None and drafts:
                            # mean accept length ~ accepted/(draft_calls); use
                            # the system acceptance counter when present.
                            try:
                                mean_accept_length = 1.0 + float(accepted) / float(drafts) * float(self.num_spec_tokens or 1)
                            except Exception:
                                mean_accept_length = None
            except Exception:
                acc_rate = None
            return acc_rate, mean_accept_length

        def prefix_cache_hit_rate(self):
            """vLLM V1 gpu prefix-cache hit rate (vllm:gpu_prefix_cache_hit_rate),
            or None when unreachable. Read-only; never fabricated."""
            try:
                eng = self.llm.llm_engine
                for attr in ("stat_logger", "stat_loggers"):
                    sl = getattr(eng, attr, None)
                    if sl is None:
                        continue
                    loggers = sl.values() if isinstance(sl, dict) else (sl if isinstance(sl, (list, tuple)) else [sl])
                    for lg in loggers:
                        hits = getattr(lg, "gpu_prefix_cache_hits", None)
                        queries = getattr(lg, "gpu_prefix_cache_queries", None)
                        if hits is not None and queries:
                            return float(hits) / float(queries)
                        rate = getattr(lg, "gpu_prefix_cache_hit_rate", None)
                        if rate is not None:
                            return float(rate)
            except Exception:
                pass
            return None

        def info(self):
            acc_rate, mean_accept_length = self._spec_metrics()
            avg_ttft = (self._ttft_ms_sum / self._req_count) if self._req_count > 0 else None
            avg_tok_s = (self._tok_count / self._gen_s_sum) if self._gen_s_sum > 0 else None
            return {
                "engine": "vllm",
                "runtime_version": _engine_runtime_version("vllm"),
                "model": self.target,
                "draft_model": self.draft,
                "speculative": self.draft is not None,
                "speculative_head_kind": self.spec_head_kind,
                "speculative_config": self.speculative_config,
                "num_speculative_tokens": self.num_spec_tokens,
                "prefix_cache": prefix_cache_enabled,
                "chunked_prefill": chunked_prefill,
                "max_num_batched_tokens": max_num_batched_tokens,
                "max_num_seqs": max_num_seqs,
                "kv_cache_dtype": kv_cache_dtype,
                "kv_cache_backend": kv_cache_backend,
                "kv_policy": kv_policy.get("policy"),
                "quantization": quantization,
                "lora_enabled": bool(self.lora_requests) or bool(lora_dir),
                "lora_adapters": sorted(self.lora_requests.keys()),
                "peak_memory_mb": _measure_peak_memory_mb(),
                "metrics": {
                    "requests": self._req_count,
                    "ttft_ms_avg": avg_ttft,
                    "tok_s_avg": avg_tok_s,
                    "acceptance_rate": acc_rate,
                    "mean_accept_length": mean_accept_length,
                    "prefix_cache_hit_rate": self.prefix_cache_hit_rate(),
                },
            }

    return VLLMEngine()


def _try_transformers(target_model: str, draft_model: Optional[str], lora_dir: Optional[str]) -> Optional[Engine]:
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        return None

    device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
    dtype = torch.bfloat16 if device != "cpu" else torch.float32

    tok = AutoTokenizer.from_pretrained(target_model)
    model = AutoModelForCausalLM.from_pretrained(target_model, torch_dtype=dtype).to(device)

    if lora_dir and os.path.exists(lora_dir):
        try:
            from peft import PeftModel
            model = PeftModel.from_pretrained(model, lora_dir)
            model = model.merge_and_unload()
        except Exception as exc:
            print(f"[serve] LoRA load failed: {exc}", file=sys.stderr)

    spec_kwargs = {}
    if draft_model:
        try:
            from apps.trainer.speculative import build_assistant_kwargs
            spec_kwargs = build_assistant_kwargs(model, tok, draft_model)
        except Exception as exc:
            print(f"[serve] speculative setup failed: {exc}", file=sys.stderr)

    num_spec_tokens = int(os.environ.get("KOLM_NUM_SPECULATIVE_TOKENS", "5")) if spec_kwargs else 0

    # W916-I5 — Shard KV cache activation. When the CLI's policy resolver
    # picked 'shard' (because the family + runtime + has_rope gate passed),
    # try to swap HF Cache for ShardCache. The HF generate() picks up the
    # past_key_values argument; we record the requested + active backend
    # for /info honesty. Soft failure (import error or unsupported model)
    # falls back to the default cache without breaking serve.
    kv_cache_backend_requested = _resolve_kv_cache_backend()
    kv_cache_backend_active = "default"
    shard_cache = None
    if kv_cache_backend_requested == "shard":
        try:
            from shard import ShardCache  # github.com/krish1905/shard
            shard_cache = ShardCache(model.config)
            kv_cache_backend_active = "shard"
            print("[serve] Shard KV cache active (~10x compression)", file=sys.stderr)
        except ImportError:
            print(
                "[serve] --kv-cache shard requested but `shard` package not installed; "
                "falling back to default cache. Install: pip install git+https://github.com/krish1905/shard",
                file=sys.stderr,
            )
        except Exception as exc:
            print(f"[serve] Shard cache init failed ({exc}); using default", file=sys.stderr)

    # W921 — runtime KV-cache policy dispatch (transformers engine only).
    # The JS picker (selectKvCachePolicy) serialized the chosen policy into
    # KOLM_KV_POLICY; here we instantiate the matching kvpress press (eviction)
    # or a transformers QuantizedCache (KIVI quant axis). Soft-fails to the
    # default cache so a missing optional dep never breaks serve.
    kv_policy = _resolve_kv_policy()
    kv_press, kv_quant_cache_fn, kv_policy_active = _build_kv_cache_for_policy(model, kv_policy)

    class HFEngine(Engine):
        name = "transformers"

        def __init__(self):
            self._req_count = 0
            self._tok_count = 0
            self._ttft_ms_sum = 0.0
            self._gen_s_sum = 0.0

        def chat(self, messages, max_new_tokens=512, temperature=0.2, top_p=0.9):
            prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            return self.complete(prompt, max_new_tokens=max_new_tokens, temperature=temperature, top_p=top_p)

        def complete(self, prompt, max_new_tokens=512, temperature=0.2, top_p=0.9):
            inputs = tok(prompt, return_tensors="pt").to(device)
            # W916-I5 — pass past_key_values=ShardCache only when active.
            # Conditional spread: HF treats explicit `past_key_values=None`
            # and an unset kwarg the same on modern transformers, but older
            # 4.40–4.45 builds infer cache_implementation from its presence.
            # Each request gets a fresh allocator-bound cache so concurrent
            # complete() calls don't share state.
            cache_kwargs = {}
            if shard_cache is not None:
                try:
                    from shard import ShardCache
                    cache_kwargs["past_key_values"] = ShardCache(model.config)
                except Exception:
                    pass
            # W921 — KIVI quant axis: a fresh QuantizedCache per request when the
            # picked policy is kivi2/kivi4 and the backend is importable.
            elif kv_quant_cache_fn is not None:
                qc = kv_quant_cache_fn(model.config)
                if qc is not None:
                    cache_kwargs["past_key_values"] = qc
            # W921 — eviction press context (StreamingLLM/SnapKV/H2O/PyramidKV).
            press_ctx = kv_press(model) if kv_press is not None else None
            # Two-step generate to capture TTFT: first 1 token (prefill+first
            # decode), then the rest. Cheap (~1 extra decode step) and gives
            # a real measurement instead of an end-to-end-divided estimate.
            t0 = time.time()
            if press_ctx is not None:
                with press_ctx:
                    first = model.generate(
                        **inputs,
                        max_new_tokens=1,
                        do_sample=False,
                        pad_token_id=tok.eos_token_id,
                    )
            else:
                first = model.generate(
                    **inputs,
                    max_new_tokens=1,
                    do_sample=False,
                    pad_token_id=tok.eos_token_id,
                    **cache_kwargs,
                )
            ttft_ms = (time.time() - t0) * 1000.0
            # Continue from the existing KV cache via past_key_values when
            # available; if generate() doesn't accept past, just re-run with
            # max_new_tokens. The fallback charges the second forward to
            # elapsed_s but still reports the measured TTFT above.
            t1 = time.time()
            remaining = max_new_tokens - 1
            if remaining > 0:
                if press_ctx is not None:
                    with kv_press(model):
                        out = model.generate(
                            **inputs,
                            max_new_tokens=max_new_tokens,
                            temperature=temperature,
                            top_p=top_p,
                            do_sample=temperature > 0.0,
                            pad_token_id=tok.eos_token_id,
                            **spec_kwargs,
                        )
                else:
                    out = model.generate(
                        **inputs,
                        max_new_tokens=max_new_tokens,
                        temperature=temperature,
                        top_p=top_p,
                        do_sample=temperature > 0.0,
                        pad_token_id=tok.eos_token_id,
                        **spec_kwargs,
                        **cache_kwargs,
                    )
            else:
                out = first
            elapsed_total = (time.time() - t0)
            gen_only = time.time() - t1
            new_tokens = int(out.shape[1] - inputs["input_ids"].shape[1])
            text = tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
            self._req_count += 1
            self._tok_count += new_tokens
            self._ttft_ms_sum += ttft_ms
            self._gen_s_sum += elapsed_total
            return {
                "text": text,
                "tokens": new_tokens,
                "elapsed_s": elapsed_total,
                "ttft_ms": ttft_ms,
                "tok_s": (new_tokens / elapsed_total) if elapsed_total > 0 else None,
                "gen_only_s": gen_only,
            }

        def info(self):
            avg_ttft = (self._ttft_ms_sum / self._req_count) if self._req_count > 0 else None
            avg_tok_s = (self._tok_count / self._gen_s_sum) if self._gen_s_sum > 0 else None
            return {
                "engine": "transformers",
                "runtime_version": _engine_runtime_version("transformers"),
                "model": target_model,
                "draft_model": draft_model,
                "speculative": bool(spec_kwargs),
                "num_speculative_tokens": num_spec_tokens,
                "device": device,
                "dtype": str(dtype),
                "kv_cache_backend_requested": kv_cache_backend_requested,
                "kv_cache_backend_active": kv_cache_backend_active,
                "kv_policy": kv_policy.get("policy"),
                "kv_policy_active": kv_policy_active,
                "peak_memory_mb": _measure_peak_memory_mb(),
                "metrics": {
                    "requests": self._req_count,
                    "ttft_ms_avg": avg_ttft,
                    "tok_s_avg": avg_tok_s,
                    # HF's assisted_decoding doesn't expose an acceptance
                    # rate via a stable API yet — surface null rather than
                    # fabricating a number.
                    "acceptance_rate": None,
                    "mean_accept_length": None,
                    "prefix_cache_hit_rate": None,
                },
            }

    return HFEngine()


def build_engine(manifest: Dict[str, Any], artifact_path: str) -> Engine:
    # `runtime` in newer manifests is a dict, but older artifacts wrote it
    # as a bare string (e.g. "gguf"). Guard the .get() call so a string
    # manifest doesn't blow up with AttributeError on field access.
    runtime = manifest.get("runtime", {})
    if not isinstance(runtime, dict):
        runtime = {}
    target = runtime.get("base_model") or manifest.get("base_model")
    if not target:
        # Also try manifest.speculative_decoding.target_model (W916-I1).
        spec_block = manifest.get("speculative_decoding") or {}
        if isinstance(spec_block, dict):
            target = spec_block.get("target_model")
    if not target:
        raise ValueError("manifest has no base_model — this artifact is pattern-match only, not generative")

    # W916-I1 — draft model resolution priority (first match wins):
    #   1. KOLM_SERVE_SPECULATIVE_DRAFT env override (empty string = off)
    #   2. manifest.speculative_decoding.draft_model (compile-time choice)
    #   3. manifest.runtime.draft_model (legacy)
    #   4. pick_draft(target) auto-lookup against DRAFT_PAIRINGS
    env_draft = os.environ.get("KOLM_SERVE_SPECULATIVE_DRAFT")
    if env_draft is not None:
        draft = env_draft.strip() or None  # empty string = explicit off
        draft_source = "env" if draft else "env-off"
    else:
        draft = None
        draft_source = None
        spec_block = manifest.get("speculative_decoding") or {}
        if isinstance(spec_block, dict) and spec_block.get("draft_model"):
            draft = spec_block.get("draft_model")
            draft_source = "manifest.speculative_decoding"
        if not draft:
            draft = runtime.get("draft_model")
            if draft:
                draft_source = "manifest.runtime"
        if not draft:
            try:
                from apps.trainer.speculative import pick_draft
                draft = pick_draft(target)
                if draft:
                    draft_source = "auto-pairing"
            except ImportError:
                pass
    if draft and draft_source:
        sys.stderr.write(f"[serve] speculative draft resolved from {draft_source}: {draft}\n")

    lora_dir = has_lora_pack(artifact_path)

    if os.environ.get("KOLM_FORCE_TRANSFORMERS") != "1":
        eng = _try_vllm(target, draft, lora_dir)
        if eng is not None:
            return eng
    eng = _try_transformers(target, draft, lora_dir)
    if eng is None:
        raise RuntimeError("neither vllm nor transformers is installed — install one to serve this artifact")
    return eng


def _vllm_prometheus_metrics(engine: Optional["Engine"]) -> str:
    """Render the vLLM Prometheus registry as text exposition, or ''.

    The probe scrapes vllm:gpu_prefix_cache_hits_total / queries_total and
    spec-decode counters from this. Soft: returns '' when prometheus_client or
    the vLLM registry is unreachable (never fabricates a counter)."""
    if engine is None or getattr(engine, "name", None) != "vllm":
        return ""
    try:
        from prometheus_client import generate_latest, REGISTRY  # type: ignore
        return generate_latest(REGISTRY).decode("utf-8")
    except Exception:
        return ""


# --------------------------------------------------------------------------
# HTTP shim (OpenAI-compatible subset)
# --------------------------------------------------------------------------

ENGINE: Optional[Engine] = None
ARTIFACT_ID: str = ""


class Handler(BaseHTTPRequestHandler):
    def _respond(self, status: int, body: Any):
        data = json.dumps(body).encode("utf-8") if not isinstance(body, (bytes, bytearray)) else body
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/v1/models":
            return self._respond(200, {"object": "list", "data": [
                {"id": ARTIFACT_ID, "object": "model", "owned_by": "kolm"},
            ]})
        if self.path == "/info":
            return self._respond(200, ENGINE.info())
        if self.path == "/metrics":
            # W921 — pass through the underlying vLLM Prometheus counters so the
            # probe can scrape vllm:prefix_cache_hits_total / queries_total and
            # spec-decode counters. Returns text/plain when vLLM exposes them,
            # else an empty 200 (never fabricates a counter).
            text = _vllm_prometheus_metrics(ENGINE)
            data = text.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path in ("/health", "/ready"):
            return self._respond(200, {"ok": True})
        self._respond(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            return self._respond(400, {"error": f"bad json: {exc}"})

        if self.path == "/v1/chat/completions":
            try:
                out = ENGINE.chat(
                    payload.get("messages", []),
                    max_new_tokens=int(payload.get("max_tokens", 512)),
                    temperature=float(payload.get("temperature", 0.2)),
                    top_p=float(payload.get("top_p", 0.9)),
                )
            except Exception as exc:
                return self._respond(500, {"error": str(exc)})
            return self._respond(200, {
                "id": "chatcmpl-" + str(int(time.time() * 1000)),
                "object": "chat.completion",
                "created": int(time.time()),
                "model": ARTIFACT_ID,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": out["text"]},
                    "finish_reason": "stop",
                }],
                "usage": {"completion_tokens": out.get("tokens", 0)},
                "kolm": out,
            })

        if self.path == "/v1/completions":
            try:
                out = ENGINE.complete(
                    payload.get("prompt", ""),
                    max_new_tokens=int(payload.get("max_tokens", 512)),
                    temperature=float(payload.get("temperature", 0.2)),
                    top_p=float(payload.get("top_p", 0.9)),
                )
            except Exception as exc:
                return self._respond(500, {"error": str(exc)})
            return self._respond(200, {
                "id": "cmpl-" + str(int(time.time() * 1000)),
                "object": "text_completion",
                "created": int(time.time()),
                "model": ARTIFACT_ID,
                "choices": [{"text": out["text"], "index": 0, "finish_reason": "stop"}],
                "usage": {"completion_tokens": out.get("tokens", 0)},
                "kolm": out,
            })

        self._respond(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        # quiet by default — Python HTTPServer is chatty
        if os.environ.get("KOLM_VERBOSE"):
            sys.stderr.write("[serve] %s - %s\n" % (self.address_string(), fmt % args))


def resolve_serve_config_env() -> Dict[str, Any]:
    """Resolve the serve-config knobs from the KOLM_* env contract WITHOUT
    booting an engine. Used by `--print-config` and the probe to render exactly
    what the live engine would request. Pure: only reads env."""
    kv_policy = _resolve_kv_policy()
    return {
        "prompt_cache": _resolve_prompt_cache_flag(),
        "chunked_prefill": _resolve_chunked_prefill(),
        "max_num_batched_tokens": _resolve_max_num_batched_tokens(),
        "max_num_seqs": _resolve_max_batch(),
        "kv_cache_backend": _resolve_kv_cache_backend(),
        "kv_policy": kv_policy,
        "quantization": (os.environ.get("KOLM_SERVE_QUANTIZATION") or "").strip() or None,
        "kv_cache_dtype": (os.environ.get("KOLM_SERVE_KV_CACHE_DTYPE") or "auto").strip(),
        "speculative_head_kind": (os.environ.get("KOLM_SPEC_HEAD_KIND") or "").strip() or None,
        "speculative_draft": (os.environ.get("KOLM_SERVE_SPECULATIVE_DRAFT") or "").strip() or None,
        "num_speculative_tokens": int(os.environ.get("KOLM_NUM_SPECULATIVE_TOKENS", "5")),
        "lora_modules": _resolve_lora_modules(),
    }


def _self_test() -> int:
    """No-GPU self-test of the pure resolvers + the modern speculative_config
    builder wiring. Exits 0 on pass. Run: python -m apps.runtime.serve --self-test"""
    os.environ["KOLM_KV_POLICY"] = json.dumps({"policy": "snapkv", "kind": "eviction", "params": {"budget": 0.5}})
    os.environ["KOLM_CHUNKED_PREFILL"] = "on"
    os.environ["KOLM_MAX_NUM_BATCHED_TOKENS"] = "8192"
    os.environ["KOLM_LORA_MODULES"] = "refund=/a,pii=/b"
    cfg = resolve_serve_config_env()
    assert cfg["chunked_prefill"] is True, cfg
    assert cfg["max_num_batched_tokens"] == 8192, cfg
    assert cfg["kv_policy"]["policy"] == "snapkv", cfg
    assert resolve_lora_modules() == [{"id": "refund", "path": "/a"}, {"id": "pii", "path": "/b"}]
    # KV policy builders return None without optional deps (soft) — never raise.
    press, qfn, active = _build_kv_cache_for_policy(None, {"policy": "off"})
    assert (press, qfn, active) == (None, None, "default")
    _build_kv_cache_for_policy(None, {"policy": "kivi2", "params": {"nbits": 2}})  # must not raise
    # modern speculative_config (no flat kwargs) via eagle3 helper.
    from apps.runtime.eagle3 import build_vllm_speculative_config
    sc = build_vllm_speculative_config({"head_kind": "eagle3", "head_id": "h", "num_speculative_tokens": 5, "supported": True})
    assert sc == {"method": "eagle3", "model": "h", "num_speculative_tokens": 5}, sc
    print("apps.runtime.serve self-test: OK")
    return 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--artifact")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--self-test", action="store_true",
                   help="run the no-GPU resolver self-test and exit")
    p.add_argument("--print-config", action="store_true",
                   help="resolve + print the serve config JSON from env and exit (no boot)")
    args = p.parse_args()

    if args.self_test:
        raise SystemExit(_self_test())
    if args.print_config:
        print(json.dumps(resolve_serve_config_env(), indent=2))
        raise SystemExit(0)
    if not args.artifact:
        p.error("--artifact is required (unless --self-test / --print-config)")

    global ENGINE, ARTIFACT_ID
    artifact_path = os.path.abspath(args.artifact)
    if not os.path.exists(artifact_path):
        sys.stderr.write(f"artifact not found: {artifact_path}\n")
        sys.exit(1)
    ARTIFACT_ID = os.path.basename(artifact_path)
    manifest = load_manifest(artifact_path)
    ENGINE = build_engine(manifest, artifact_path)
    info = ENGINE.info()
    sys.stderr.write(f"[serve] {info['engine']} engine ready for {info['model']}\n")
    if info.get("quantization"):
        sys.stderr.write(f"[serve] serving kernel / quantization: {info['quantization']}\n")
    if info.get("speculative"):
        hk = info.get("speculative_head_kind") or "draft_model"
        sys.stderr.write(
            f"[serve] speculative decoding ({hk}) via {info.get('draft_model')} "
            f"(K={info.get('num_speculative_tokens', 5)})\n"
        )
    if info.get("prefix_cache"):
        sys.stderr.write("[serve] prefix KV cache: on\n")
    if info.get("chunked_prefill"):
        sys.stderr.write(
            f"[serve] chunked prefill: on (max_num_batched_tokens={info.get('max_num_batched_tokens')})\n"
        )
    if info.get("kv_policy") and info.get("kv_policy") not in ("default", "off"):
        sys.stderr.write(f"[serve] KV policy: {info.get('kv_policy')}\n")
    if info.get("lora_enabled"):
        sys.stderr.write(f"[serve] multi-LoRA: {info.get('lora_adapters')}\n")
    if info.get("max_num_seqs"):
        sys.stderr.write(f"[serve] continuous batching: max_num_seqs={info['max_num_seqs']}\n")
    sys.stderr.write(f"[serve] listening on http://{args.host}:{args.port}\n")
    HTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

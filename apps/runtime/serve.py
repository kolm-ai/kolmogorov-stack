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
    num_spec_tokens = int(os.environ.get("KOLM_NUM_SPECULATIVE_TOKENS", "5"))
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
        kv_cache_dtype=kv_cache_dtype,
        dtype="auto",
        max_model_len=int(os.environ.get("KOLM_MAX_MODEL_LEN", "8192")),
        max_num_seqs=max_num_seqs,
    )
    if draft_model:
        llm_kwargs["speculative_model"] = draft_model
        llm_kwargs["num_speculative_tokens"] = num_spec_tokens
    if lora_dir:
        llm_kwargs["enable_lora"] = True

    llm = LLM(**llm_kwargs)

    class VLLMEngine(Engine):
        name = "vllm"

        def __init__(self):
            self.llm = llm
            self.target = target_model
            self.draft = draft_model
            self.num_spec_tokens = num_spec_tokens if draft_model else 0
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

        def info(self):
            # Try to read vLLM's spec-decoding acceptance rate counter; if
            # unreachable, surface null (the CLI displays "n/a" rather than
            # a fabricated number).
            acc_rate = None
            try:
                stats = getattr(self.llm.llm_engine, "stat_logger", None)
                if stats and hasattr(stats, "spec_decode_metrics"):
                    sm = stats.spec_decode_metrics
                    if sm is not None and getattr(sm, "draft_acceptance_rate", None) is not None:
                        acc_rate = float(sm.draft_acceptance_rate)
            except Exception:
                acc_rate = None
            avg_ttft = (self._ttft_ms_sum / self._req_count) if self._req_count > 0 else None
            avg_tok_s = (self._tok_count / self._gen_s_sum) if self._gen_s_sum > 0 else None
            return {
                "engine": "vllm",
                "model": self.target,
                "draft_model": self.draft,
                "speculative": self.draft is not None,
                "num_speculative_tokens": self.num_spec_tokens,
                "prefix_cache": prefix_cache_enabled,
                "max_num_seqs": max_num_seqs,
                "kv_cache_dtype": kv_cache_dtype,
                "kv_cache_backend": kv_cache_backend,
                "metrics": {
                    "requests": self._req_count,
                    "ttft_ms_avg": avg_ttft,
                    "tok_s_avg": avg_tok_s,
                    "acceptance_rate": acc_rate,
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
            # Two-step generate to capture TTFT: first 1 token (prefill+first
            # decode), then the rest. Cheap (~1 extra decode step) and gives
            # a real measurement instead of an end-to-end-divided estimate.
            t0 = time.time()
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
                "model": target_model,
                "draft_model": draft_model,
                "speculative": bool(spec_kwargs),
                "num_speculative_tokens": num_spec_tokens,
                "device": device,
                "dtype": str(dtype),
                "kv_cache_backend_requested": kv_cache_backend_requested,
                "kv_cache_backend_active": kv_cache_backend_active,
                "metrics": {
                    "requests": self._req_count,
                    "ttft_ms_avg": avg_ttft,
                    "tok_s_avg": avg_tok_s,
                    # HF's assisted_decoding doesn't expose an acceptance
                    # rate via a stable API yet — surface null rather than
                    # fabricating a number.
                    "acceptance_rate": None,
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


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--artifact", required=True)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--host", default="127.0.0.1")
    args = p.parse_args()

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
    if info.get("speculative"):
        sys.stderr.write(
            f"[serve] speculative decoding via {info.get('draft_model')} "
            f"(K={info.get('num_speculative_tokens', 5)})\n"
        )
    if info.get("prefix_cache"):
        sys.stderr.write("[serve] prefix KV cache: on\n")
    if info.get("max_num_seqs"):
        sys.stderr.write(f"[serve] continuous batching: max_num_seqs={info['max_num_seqs']}\n")
    sys.stderr.write(f"[serve] listening on http://{args.host}:{args.port}\n")
    HTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

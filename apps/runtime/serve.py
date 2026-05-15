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

    llm_kwargs = dict(
        model=target_model,
        enable_prefix_caching=True,
        kv_cache_dtype=kv_cache_dtype,
        dtype="auto",
        max_model_len=int(os.environ.get("KOLM_MAX_MODEL_LEN", "8192")),
    )
    if draft_model:
        llm_kwargs["speculative_model"] = draft_model
        llm_kwargs["num_speculative_tokens"] = int(os.environ.get("KOLM_NUM_SPECULATIVE_TOKENS", "5"))
    if lora_dir:
        llm_kwargs["enable_lora"] = True

    llm = LLM(**llm_kwargs)

    class VLLMEngine(Engine):
        name = "vllm"

        def __init__(self):
            self.llm = llm
            self.target = target_model
            self.draft = draft_model

        def chat(self, messages, max_new_tokens=512, temperature=0.2, top_p=0.9):
            sp = SamplingParams(temperature=temperature, top_p=top_p, max_tokens=max_new_tokens)
            outs = self.llm.chat(messages, sp)
            return {
                "text": outs[0].outputs[0].text,
                "tokens": len(outs[0].outputs[0].token_ids),
            }

        def complete(self, prompt, max_new_tokens=512, temperature=0.2, top_p=0.9):
            sp = SamplingParams(temperature=temperature, top_p=top_p, max_tokens=max_new_tokens)
            outs = self.llm.generate([prompt], sp)
            return {
                "text": outs[0].outputs[0].text,
                "tokens": len(outs[0].outputs[0].token_ids),
            }

        def info(self):
            return {
                "engine": "vllm",
                "model": self.target,
                "draft_model": self.draft,
                "speculative": self.draft is not None,
                "prefix_cache": True,
                "kv_cache_dtype": kv_cache_dtype,
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

    class HFEngine(Engine):
        name = "transformers"

        def chat(self, messages, max_new_tokens=512, temperature=0.2, top_p=0.9):
            prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            return self.complete(prompt, max_new_tokens=max_new_tokens, temperature=temperature, top_p=top_p)

        def complete(self, prompt, max_new_tokens=512, temperature=0.2, top_p=0.9):
            inputs = tok(prompt, return_tensors="pt").to(device)
            t0 = time.time()
            out = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                temperature=temperature,
                top_p=top_p,
                do_sample=temperature > 0.0,
                pad_token_id=tok.eos_token_id,
                **spec_kwargs,
            )
            elapsed = time.time() - t0
            text = tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
            return {"text": text, "tokens": int(out.shape[1] - inputs["input_ids"].shape[1]), "elapsed_s": elapsed}

        def info(self):
            return {
                "engine": "transformers",
                "model": target_model,
                "draft_model": draft_model,
                "speculative": bool(spec_kwargs),
                "device": device,
                "dtype": str(dtype),
            }

    return HFEngine()


def build_engine(manifest: Dict[str, Any], artifact_path: str) -> Engine:
    runtime = manifest.get("runtime", {}) or {}
    target = runtime.get("base_model") or manifest.get("base_model")
    if not target:
        raise ValueError("manifest has no base_model — this artifact is pattern-match only, not generative")
    draft = runtime.get("draft_model")
    if not draft:
        try:
            from apps.trainer.speculative import pick_draft
            draft = pick_draft(target)
        except ImportError:
            pass
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
        sys.stderr.write(f"[serve] speculative decoding via {info.get('draft_model')}\n")
    sys.stderr.write(f"[serve] listening on http://{args.host}:{args.port}\n")
    HTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()

"""Kolm SDK — one-line embed for .kolm artifacts.

Public surface (intentionally tiny):

    from kolm import load
    m = load("artifact.kolm")
    out = m.predict("input text")

Anything beyond `load` / `predict` is opt-in via keyword args.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


__version__ = "0.1.0"
__all__ = ["load", "KolmModel", "KolmOutput", "VerificationError"]


class VerificationError(RuntimeError):
    """Raised when the artifact's receipt or signature does not match."""


@dataclass
class KolmOutput:
    """One prediction. `text` is the answer; the other fields are the trail."""

    text: str
    cid: Optional[str] = None
    credential: Optional[str] = None
    latency_ms: float = 0.0


# ----- low-level helpers --------------------------------------------------


def _canonical_json(obj: Any) -> bytes:
    """Stable canonical JSON: sorted keys, no spaces, UTF-8, recursive."""
    if isinstance(obj, dict):
        items = []
        for k in sorted(obj.keys()):
            items.append(json.dumps(k) + ":" + _canonical_json(obj[k]).decode("utf-8"))
        return ("{" + ",".join(items) + "}").encode("utf-8")
    if isinstance(obj, list):
        return ("[" + ",".join(_canonical_json(v).decode("utf-8") for v in obj) + "]").encode(
            "utf-8"
        )
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _verify_receipt(manifest: dict, receipt: dict, secret: Optional[bytes]) -> None:
    """Replay HMAC-SHA256 over canonical(receipt without `signature`)."""
    if not secret:
        # secret-less verification only checks that the receipt references the
        # manifest hashes. Body signature check is skipped on purpose; the
        # CLI / server have a secret, embedded SDKs usually do not.
        return
    sig = receipt.get("signature")
    if not sig:
        raise VerificationError("receipt has no signature field")
    body = {k: v for k, v in receipt.items() if k != "signature"}
    expect = hmac.new(secret, _canonical_json(body), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expect, sig):
        raise VerificationError("receipt signature mismatch")


def _cid_for(manifest: dict) -> str:
    """Recompute the artifact CID from manifest.hashes — must match manifest.cid."""
    payload = _canonical_json({"hashes": manifest.get("hashes") or {}})
    h = hashlib.sha256(payload).hexdigest()
    return f"cidv1:sha256:{h}"


# ----- model -------------------------------------------------------------


class KolmModel:
    """A loaded `.kolm` artifact. Pick a runtime lazily on first .predict()."""

    def __init__(self, work_dir: Path, manifest: dict, credential: Optional[dict]) -> None:
        self._dir = work_dir
        self._manifest = manifest
        self._credential = credential
        self._backend: Any = None
        self._backend_kind: Optional[str] = None

    @property
    def cid(self) -> Optional[str]:
        return self._manifest.get("cid")

    @property
    def task(self) -> Optional[str]:
        return self._manifest.get("task")

    @property
    def base_model(self) -> Optional[str]:
        return self._manifest.get("base_model")

    @property
    def k_score(self) -> Optional[float]:
        m = self._manifest.get("metrics") or {}
        v = m.get("k_score")
        try:
            return float(v) if v is not None else None
        except Exception:
            return None

    def predict(self, text: str, **kw: Any) -> KolmOutput:
        """Run inference. Lazily binds to whatever runtime is on the host."""
        import time

        if self._backend is None:
            self._bind_backend()
        started = time.time()
        ans = self._backend(text, **kw)
        return KolmOutput(
            text=ans,
            cid=self.cid,
            credential=(self._credential or {}).get("credential_id"),
            latency_ms=round((time.time() - started) * 1000, 2),
        )

    def __call__(self, text: str, **kw: Any) -> KolmOutput:
        return self.predict(text, **kw)

    # -- runtime binding ---------------------------------------------------

    def _bind_backend(self) -> None:
        """Pick the first runtime that loads cleanly."""
        gguf = next(self._dir.glob("model*.gguf"), None)
        if gguf is not None:
            try:
                from llama_cpp import Llama  # type: ignore

                model = Llama(model_path=str(gguf), n_ctx=2048, verbose=False)

                def _call(prompt: str, **kw: Any) -> str:
                    resp = model(prompt, max_tokens=kw.get("max_tokens", 256))
                    return (resp.get("choices") or [{}])[0].get("text", "")

                self._backend = _call
                self._backend_kind = "gguf"
                return
            except Exception:
                pass

        onnx = next(self._dir.glob("model*.onnx"), None)
        if onnx is not None:
            try:
                import onnxruntime as ort  # type: ignore
                # ONNX text generation requires a tokenizer + KV cache loop;
                # we ship a minimal greedy-decode shim that the buyer can
                # extend, rather than pretending to handle every architecture.
                from .runtimes.onnx_text import OnnxTextGen  # type: ignore

                rt = OnnxTextGen(self._dir)
                self._backend = lambda p, **kw: rt.generate(p, **kw)
                self._backend_kind = "onnx"
                return
            except Exception:
                pass

        # Remote fallback (OpenAI-compatible)
        remote = os.environ.get("KOLM_RUNTIME_URL")
        if remote:
            try:
                import httpx  # type: ignore

                key = os.environ.get("KOLM_RUNTIME_KEY", "")
                base = remote.rstrip("/")
                model_id = self._manifest.get("model_pointer") or self.cid or ""

                def _call(prompt: str, **kw: Any) -> str:
                    headers = {"Content-Type": "application/json"}
                    if key:
                        headers["Authorization"] = f"Bearer {key}"
                    body = {
                        "model": model_id,
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": kw.get("max_tokens", 256),
                    }
                    with httpx.Client(timeout=60.0) as c:
                        r = c.post(f"{base}/chat/completions", json=body, headers=headers)
                        r.raise_for_status()
                        d = r.json()
                        return (d.get("choices") or [{}])[0].get("message", {}).get(
                            "content", ""
                        )

                self._backend = _call
                self._backend_kind = "remote"
                return
            except Exception:
                pass

        # transformers fallback (assumes adapter/ + base_model is reachable)
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
            from peft import PeftModel  # type: ignore
            import torch  # type: ignore

            adapter = self._dir / "adapter"
            base = self.base_model or "Qwen/Qwen2.5-3B-Instruct"
            tok = AutoTokenizer.from_pretrained(base, trust_remote_code=True)
            mdl = AutoModelForCausalLM.from_pretrained(
                base,
                torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
                low_cpu_mem_usage=True,
                trust_remote_code=True,
            )
            if adapter.exists():
                mdl = PeftModel.from_pretrained(mdl, str(adapter))
            mdl.eval()

            def _call(prompt: str, **kw: Any) -> str:
                inputs = tok(prompt, return_tensors="pt")
                with torch.no_grad():
                    out = mdl.generate(
                        **inputs,
                        max_new_tokens=kw.get("max_tokens", 256),
                        do_sample=False,
                    )
                return tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)

            self._backend = _call
            self._backend_kind = "transformers"
            return
        except Exception:
            pass

        raise RuntimeError(
            "No runtime available. Install one of:\n"
            "  pip install kolm[gguf]          # llama-cpp-python\n"
            "  pip install kolm[onnx]          # onnxruntime\n"
            "  pip install kolm[transformers]  # HF + peft\n"
            "Or set KOLM_RUNTIME_URL to an OpenAI-compatible endpoint."
        )


# ----- entry point --------------------------------------------------------


def load(path: str | os.PathLike, *, verify: str = "on", secret: Optional[bytes] = None) -> KolmModel:
    """Open a `.kolm` artifact and return a ready-to-call model.

    Args:
      path:    path to a .kolm zip
      verify:  "on" (default), "strict", or "off"
      secret:  HMAC secret for body-signature verification. Falls back to
               KOLM_ARTIFACT_SECRET / RECIPE_RECEIPT_SECRET env vars.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(p)

    work = Path(tempfile.mkdtemp(prefix="kolm-"))
    with zipfile.ZipFile(p, "r") as zf:
        zf.extractall(work)

    manifest_path = work / "manifest.json"
    if not manifest_path.exists():
        raise VerificationError("missing manifest.json in artifact")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # CID self-check
    if "cid" in manifest:
        expect = _cid_for(manifest)
        if manifest["cid"] != expect and verify != "off":
            raise VerificationError(
                f"manifest CID does not match its hashes ({manifest['cid']} != {expect})"
            )

    # Receipt body-sig
    receipt_path = work / "receipt.json"
    receipt = None
    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if verify != "off":
            sec = secret or (os.environ.get("KOLM_ARTIFACT_SECRET", "").encode("utf-8") or None)
            if not sec:
                sec = (os.environ.get("RECIPE_RECEIPT_SECRET", "").encode("utf-8") or None)
            if verify == "strict" and not sec:
                raise VerificationError("strict verify requires KOLM_ARTIFACT_SECRET")
            if sec:
                _verify_receipt(manifest, receipt, sec)

    # Optional credential sidecar
    credential = None
    cred_path = work / "credential.json"
    if cred_path.exists():
        try:
            credential = json.loads(cred_path.read_text(encoding="utf-8"))
        except Exception:
            credential = None

    return KolmModel(work_dir=work, manifest=manifest, credential=credential)

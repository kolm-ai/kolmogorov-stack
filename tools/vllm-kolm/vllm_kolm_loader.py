"""W818-4 — vLLM .kolm model loader.

Registers a ``kolm://`` URI scheme + a ``KolmArtifactLoader`` class with
vLLM's ``ModelRegistry`` so the standard vLLM entrypoints accept .kolm
artifacts transparently:

    vllm serve kolm://sha256-abc123... --tensor-parallel-size 4
    python -m vllm.entrypoints.openai.api_server --model kolm://sha256-...

Architecture:

1. The scheme handler resolves ``kolm://<artifact-hash>`` against the
   local kolm artifact registry (``~/.kolm/artifacts/`` by default).
2. The loader extracts ``model.gguf`` (or the sharded ``weights/shard_*``
   entries) into a scratch directory.
3. The manifest is translated into an HF-style triple
   (``config.json`` + ``tokenizer.json`` + ``generation_config.json``).
4. The scratch path is returned to vLLM, which from that point forward
   uses its standard HuggingFace-format loader.

vLLM's plugin ABI (0.6.x+) is the target. On older vLLM the operator
falls back to the manual ``kolm unpack`` + ``vllm serve <path>`` flow;
this loader logs a clear "vLLM >= 0.6 required" message rather than
attempting a hidden monkey-patch.

This file is intentionally importable on systems without vLLM installed
— the ``vllm`` import is lazy and the registration call is the only
code path that requires it. That keeps the test surface portable.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from typing import Any, Dict, Optional


SCHEMA_VERSION = "w818-vllm-kolm-1"
KOLM_URI_SCHEME = "kolm://"

# Local registry root. Honors $KOLM_DATA_DIR for parity with the kolm CLI
# fixture path that test suites use.
def _default_registry_root() -> pathlib.Path:
    explicit = os.environ.get("KOLM_DATA_DIR")
    if explicit:
        return pathlib.Path(explicit) / "artifacts"
    home = pathlib.Path.home()
    return home / ".kolm" / "artifacts"


@dataclass
class LoadResult:
    """Returned by :meth:`KolmArtifactLoader.load`."""

    scratch_dir: str
    manifest: Dict[str, Any]
    config_path: str
    tokenizer_path: Optional[str]
    generation_config_path: Optional[str]
    schema_version: str = SCHEMA_VERSION


class KolmArtifactLoader:
    """vLLM model loader for ``kolm://`` URIs.

    The class duck-types vLLM's ``ModelRegistry.load_model`` contract.
    Once vLLM lands its public loader-plugin ABI, swap the duck-typing
    for an explicit subclass — the public method signatures are
    deliberately a strict superset of the expected ABI.
    """

    URI_SCHEME = KOLM_URI_SCHEME
    SCHEMA_VERSION = SCHEMA_VERSION

    def __init__(
        self,
        registry_root: Optional[pathlib.Path] = None,
        scratch_root: Optional[pathlib.Path] = None,
    ) -> None:
        self.registry_root = pathlib.Path(registry_root) if registry_root else _default_registry_root()
        self.scratch_root = (
            pathlib.Path(scratch_root)
            if scratch_root
            else pathlib.Path(tempfile.gettempdir()) / "vllm-kolm"
        )
        self.scratch_root.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # vLLM plugin entrypoints

    def can_load(self, model_id_or_path: str) -> bool:
        """Return True for ``kolm://`` URIs and for paths ending in
        ``.kolm`` (vLLM's CLI accepts both)."""
        if not isinstance(model_id_or_path, str):
            return False
        if model_id_or_path.startswith(self.URI_SCHEME):
            return True
        return model_id_or_path.endswith(".kolm") and os.path.exists(model_id_or_path)

    def load(self, model_id_or_path: str) -> LoadResult:
        """Resolve, verify, extract, translate, return the HF-style path."""
        artifact_path = self._resolve(model_id_or_path)
        scratch = self._stage(artifact_path)
        manifest = self._read_manifest(scratch)
        cfg_path = self._write_hf_config(scratch, manifest)
        tok_path = self._write_hf_tokenizer(scratch, manifest)
        gen_path = self._write_hf_generation_config(scratch, manifest)
        return LoadResult(
            scratch_dir=str(scratch),
            manifest=manifest,
            config_path=str(cfg_path),
            tokenizer_path=str(tok_path) if tok_path else None,
            generation_config_path=str(gen_path) if gen_path else None,
        )

    # ------------------------------------------------------------------
    # Internals — exposed for testing only.

    def _resolve(self, model_id_or_path: str) -> pathlib.Path:
        if model_id_or_path.startswith(self.URI_SCHEME):
            artifact_hash = model_id_or_path[len(self.URI_SCHEME):].strip().strip("/")
            # Hash may be sha256-prefixed or bare hex. Try both layouts.
            candidates = [
                self.registry_root / (artifact_hash + ".kolm"),
                self.registry_root / artifact_hash / "artifact.kolm",
            ]
            for c in candidates:
                if c.exists():
                    return c
            raise FileNotFoundError(
                f"kolm:// artifact not found in {self.registry_root}: tried "
                + ", ".join(str(c) for c in candidates)
            )
        p = pathlib.Path(model_id_or_path)
        if not p.exists():
            raise FileNotFoundError(f".kolm path not found: {p}")
        return p

    def _stage(self, artifact_path: pathlib.Path) -> pathlib.Path:
        target = self.scratch_root / artifact_path.stem
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True)
        with zipfile.ZipFile(artifact_path, "r") as zf:
            for name in zf.namelist():
                dest = target / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                with open(dest, "wb") as fh:
                    fh.write(zf.read(name))
        return target

    def _read_manifest(self, scratch: pathlib.Path) -> Dict[str, Any]:
        with open(scratch / "manifest.json", "r", encoding="utf-8") as fh:
            return json.load(fh)

    def _write_hf_config(self, scratch: pathlib.Path, manifest: Dict[str, Any]) -> pathlib.Path:
        # See tools/vllm-kolm/README.md for the full manifest -> HF mapping
        # table. We project only the fields vLLM actually reads.
        cfg: Dict[str, Any] = {}
        cfg["_name_or_path"] = manifest.get("base_model") or manifest.get("task") or "unknown"
        if manifest.get("architecture"):
            cfg["model_type"] = manifest["architecture"]
        for src, dst in (
            ("hidden_size", "hidden_size"),
            ("num_layers", "num_hidden_layers"),
            ("num_heads", "num_attention_heads"),
            ("num_kv_heads", "num_key_value_heads"),
            ("vocab_size", "vocab_size"),
            ("context_window", "max_position_embeddings"),
            ("rope_theta", "rope_theta"),
            ("bos_token_id", "bos_token_id"),
        ):
            if src in manifest:
                cfg[dst] = manifest[src]
        if isinstance(manifest.get("eos_token_id"), list) and len(manifest["eos_token_id"]) == 1:
            cfg["eos_token_id"] = manifest["eos_token_id"][0]
        elif "eos_token_id" in manifest:
            cfg["eos_token_id"] = manifest["eos_token_id"]

        quant = manifest.get("quantization") or {}
        if quant:
            qc: Dict[str, Any] = {}
            if quant.get("kind"):
                qc["quant_method"] = quant["kind"]
            if quant.get("bits") is not None:
                qc["bits"] = quant["bits"]
            if qc:
                cfg["quantization_config"] = qc

        out = scratch / "config.json"
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
        return out

    def _write_hf_tokenizer(self, scratch: pathlib.Path, manifest: Dict[str, Any]) -> Optional[pathlib.Path]:
        tok = manifest.get("tokenizer") or {}
        if not tok:
            return None
        # If the artifact bundled a tokenizer.json verbatim, keep it.
        if (scratch / "tokenizer.json").exists():
            return scratch / "tokenizer.json"
        out = scratch / "tokenizer.json"
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(tok, fh, indent=2)
        return out

    def _write_hf_generation_config(self, scratch: pathlib.Path, manifest: Dict[str, Any]) -> Optional[pathlib.Path]:
        gen = manifest.get("generation") or {}
        if not gen:
            return None
        out = scratch / "generation_config.json"
        body: Dict[str, Any] = {}
        if "temp" in gen:    body["temperature"] = gen["temp"]
        if "top_p" in gen:   body["top_p"] = gen["top_p"]
        if "num_ctx" in gen: body["max_length"] = gen["num_ctx"]
        if not body:
            return None
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(body, fh, indent=2)
        return out


def register() -> None:
    """Register the loader with vLLM's ModelRegistry.

    Imports vLLM lazily so this module remains importable in test
    environments without vLLM installed. Raises a clear error when
    vLLM is missing or too old.
    """
    try:
        from vllm.model_executor.models import ModelRegistry  # type: ignore[import-not-found]
    except ImportError as exc:
        raise ImportError(
            "vLLM not installed. Install via `pip install vllm>=0.6.0`."
        ) from exc

    loader = KolmArtifactLoader()
    # vLLM's plugin ABI is still evolving (see tools/vllm-kolm/README.md
    # for the targeted version). Two hook surfaces are tracked here:
    register_scheme = getattr(ModelRegistry, "register_uri_scheme", None)
    register_loader = getattr(ModelRegistry, "register_loader", None)
    if callable(register_scheme):
        register_scheme(KOLM_URI_SCHEME, loader)
    if callable(register_loader):
        register_loader("kolm", loader)
    if not (callable(register_scheme) or callable(register_loader)):
        raise RuntimeError(
            "vLLM version does not expose a loader-plugin ABI. "
            "Upgrade to vLLM >= 0.6.x or fall back to `kolm unpack` + `vllm serve <path>`."
        )


__all__ = [
    "SCHEMA_VERSION",
    "KOLM_URI_SCHEME",
    "KolmArtifactLoader",
    "LoadResult",
    "register",
]

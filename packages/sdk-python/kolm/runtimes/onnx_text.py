"""Minimal ONNX text-generation shim.

This is the boring greedy-decode loop that works for most autoregressive
causal LMs exported via `optimum-cli export onnx`. The exported folder
contains `model.onnx` (or `decoder_model.onnx`) plus `tokenizer.json` and
`config.json`.

Two assumptions:
  * The decoder has KV-cache inputs/outputs in the optimum naming scheme
    (`past_key_values.<i>.<key|value>` and `present.<i>.<key|value>`)
  * Position ids are computed as `range(seq_len)`

If your model exports a different naming, override these env vars:
  KOLM_ONNX_INPUT_IDS   default "input_ids"
  KOLM_ONNX_ATTN_MASK   default "attention_mask"
  KOLM_ONNX_POS_IDS     default "position_ids"
  KOLM_ONNX_PROVIDERS   default "CPUExecutionProvider"

Anything fancier (speculative decoding, KV reuse across calls) is out of
scope for the SDK on purpose; use the GGUF or remote backend for that.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from types import MappingProxyType
from typing import Any, Iterable, Optional


ONNX_TEXT_CONTRACT_VERSION = "w754-onnx-text-v1"
ONNX_TEXT_LIMITS = MappingProxyType({
    "default_max_tokens": 256,
    "max_new_tokens": 1024,
    "max_prompt_tokens": 8192,
    "max_env_name_chars": 128,
    "max_provider_chars": 64,
})
ONNX_TEXT_MODEL_CANDIDATES = (
    "model.onnx",
    "decoder_model.onnx",
    "decoder_with_past_model.onnx",
)
DEFAULT_ONNX_PROVIDERS = ("CPUExecutionProvider",)

_INPUT_NAME_RE = re.compile(r"^[A-Za-z0-9_.:/-]+$")
_PROVIDER_RE = re.compile(r"^[A-Za-z0-9_]+ExecutionProvider$")


def _bounded_env_name(key: str, default: str) -> str:
    value = os.environ.get(key, default)
    if not isinstance(value, str):
        value = str(value)
    if (
        not value
        or len(value) > ONNX_TEXT_LIMITS["max_env_name_chars"]
        or not _INPUT_NAME_RE.fullmatch(value)
    ):
        raise ValueError(f"invalid ONNX input env override {key}")
    return value


def _parse_providers(raw: Optional[str] = None) -> tuple[str, ...]:
    if raw is None:
        raw = os.environ.get("KOLM_ONNX_PROVIDERS")
    if raw is None or not raw.strip():
        return DEFAULT_ONNX_PROVIDERS

    providers: list[str] = []
    seen = set()
    for part in raw.split(","):
        name = part.strip()
        if not name:
            continue
        if (
            len(name) > ONNX_TEXT_LIMITS["max_provider_chars"]
            or not _PROVIDER_RE.fullmatch(name)
        ):
            raise ValueError("invalid ONNX execution provider in KOLM_ONNX_PROVIDERS")
        if name not in seen:
            seen.add(name)
            providers.append(name)
    return tuple(providers) if providers else DEFAULT_ONNX_PROVIDERS


def _first_non_bool_int(values: Iterable[Any]) -> Optional[int]:
    for value in values:
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and value >= 0:
            return value
    return None


def _eos_from_config(config: dict[str, Any], tok: Any) -> int:
    configured = config.get("eos_token_id")
    if isinstance(configured, list):
        eos = _first_non_bool_int(configured)
    else:
        eos = _first_non_bool_int([configured])
    if eos is not None:
        return eos

    tokenized = tok.token_to_id("</s>")
    eos = _first_non_bool_int([tokenized])
    return eos if eos is not None else 2


def _normalize_max_tokens(value: Any) -> int:
    if value is None:
        value = ONNX_TEXT_LIMITS["default_max_tokens"]
    if isinstance(value, bool):
        raise ValueError("max_tokens must be an integer")
    try:
        n = int(value)
    except (TypeError, ValueError) as e:
        raise ValueError("max_tokens must be an integer") from e
    if n <= 0:
        return 0
    return min(n, ONNX_TEXT_LIMITS["max_new_tokens"])


def _validate_logits_shape(logits: Any) -> None:
    shape = getattr(logits, "shape", None)
    if shape is None or len(shape) < 3:
        raise RuntimeError("ONNX session returned logits with invalid shape")
    try:
        vocab = int(shape[-1])
    except (TypeError, ValueError) as e:
        raise RuntimeError("ONNX session returned logits with invalid shape") from e
    if vocab <= 0:
        raise RuntimeError("ONNX session returned logits with invalid shape")


class OnnxTextGen:
    def __init__(self, root: Path) -> None:
        root = Path(root)
        from onnxruntime import InferenceSession, SessionOptions

        model_path = next((root / c for c in ONNX_TEXT_MODEL_CANDIDATES if (root / c).exists()), None)
        if model_path is None:
            raise FileNotFoundError("no ONNX model file found under artifact")

        self.in_ids = _bounded_env_name("KOLM_ONNX_INPUT_IDS", "input_ids")
        self.in_attn = _bounded_env_name("KOLM_ONNX_ATTN_MASK", "attention_mask")
        self.in_pos = _bounded_env_name("KOLM_ONNX_POS_IDS", "position_ids")
        self.providers = _parse_providers()

        opts = SessionOptions()
        self.sess = InferenceSession(str(model_path), opts, providers=list(self.providers))
        self._input_names = frozenset(str(i.name) for i in self.sess.get_inputs())
        if self._input_names and self.in_ids not in self._input_names:
            raise ValueError(f"ONNX input {self.in_ids!r} is not present in the exported model")

        tok_path = root / "tokenizer.json"
        if not tok_path.exists():
            raise FileNotFoundError("tokenizer.json missing under artifact")
        try:
            from tokenizers import Tokenizer  # type: ignore
        except ImportError as e:
            raise RuntimeError("install ONNX text dependencies with: pip install 'kolm[onnx]'") from e
        self.tok = Tokenizer.from_file(str(tok_path))

        config = root / "config.json"
        try:
            self.cfg = json.loads(config.read_text(encoding="utf-8")) if config.exists() else {}
        except json.JSONDecodeError as e:
            raise ValueError("config.json is not valid JSON") from e
        if not isinstance(self.cfg, dict):
            raise ValueError("config.json must contain a JSON object")
        self.eos = _eos_from_config(self.cfg, self.tok)

    def generate(self, prompt: str, **kw: Any) -> str:
        import numpy as np  # type: ignore

        if not isinstance(prompt, str):
            raise TypeError("prompt must be a string")
        max_new = _normalize_max_tokens(kw.get("max_tokens", None))
        if max_new == 0:
            return ""

        enc = self.tok.encode(prompt)
        if len(enc.ids) > ONNX_TEXT_LIMITS["max_prompt_tokens"]:
            raise ValueError(
                f"prompt token count exceeds limit {ONNX_TEXT_LIMITS['max_prompt_tokens']}"
            )
        ids = np.array([enc.ids], dtype=np.int64)
        attn = np.ones_like(ids)
        pos = np.arange(ids.shape[1], dtype=np.int64).reshape(1, -1)

        out_ids = list(enc.ids)
        for _ in range(max_new):
            feeds = {self.in_ids: ids, self.in_attn: attn, self.in_pos: pos}
            feeds = {k: v for k, v in feeds.items() if k in self._input_names}
            outputs = self.sess.run(None, feeds)
            if not outputs:
                raise RuntimeError("ONNX session returned no outputs")
            logits = outputs[0]
            _validate_logits_shape(logits)
            next_id = int(np.argmax(logits[0, -1, :]))
            if next_id == self.eos:
                break
            out_ids.append(next_id)
            ids = np.array([[next_id]], dtype=np.int64)
            attn = np.concatenate([attn, np.ones((1, 1), dtype=np.int64)], axis=1)
            pos = np.array([[pos[0, -1] + 1]], dtype=np.int64)

        return self.tok.decode(out_ids[len(enc.ids):], skip_special_tokens=True)

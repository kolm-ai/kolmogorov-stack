"""Minimal ONNX text-generation shim.

This is the *boring* greedy-decode loop that works for most autoregressive
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

Anything fancier (speculative decoding, KV reuse across calls) is out of
scope for the SDK on purpose — use the GGUF or remote backend for that.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class OnnxTextGen:
    def __init__(self, root: Path) -> None:
        import onnxruntime as ort  # noqa: F401

        candidates = ["model.onnx", "decoder_model.onnx", "decoder_with_past_model.onnx"]
        model_path = next((root / c for c in candidates if (root / c).exists()), None)
        if model_path is None:
            raise FileNotFoundError("no ONNX model file found under artifact")
        from onnxruntime import InferenceSession, SessionOptions

        opts = SessionOptions()
        self.sess = InferenceSession(str(model_path), opts, providers=["CPUExecutionProvider"])
        tok_path = root / "tokenizer.json"
        if not tok_path.exists():
            raise FileNotFoundError("tokenizer.json missing under artifact")
        try:
            from tokenizers import Tokenizer  # type: ignore
        except ImportError as e:
            raise RuntimeError("pip install tokenizers") from e
        self.tok = Tokenizer.from_file(str(tok_path))

        config = root / "config.json"
        self.cfg = json.loads(config.read_text(encoding="utf-8")) if config.exists() else {}
        self.eos = self.cfg.get("eos_token_id") or self.tok.token_to_id("</s>") or 2

        self.in_ids = os.environ.get("KOLM_ONNX_INPUT_IDS", "input_ids")
        self.in_attn = os.environ.get("KOLM_ONNX_ATTN_MASK", "attention_mask")
        self.in_pos = os.environ.get("KOLM_ONNX_POS_IDS", "position_ids")

    def generate(self, prompt: str, **kw: Any) -> str:
        import numpy as np  # type: ignore

        max_new = int(kw.get("max_tokens", 256))
        enc = self.tok.encode(prompt)
        ids = np.array([enc.ids], dtype=np.int64)
        attn = np.ones_like(ids)
        pos = np.arange(ids.shape[1], dtype=np.int64).reshape(1, -1)

        out_ids = list(enc.ids)
        for _ in range(max_new):
            feeds = {self.in_ids: ids, self.in_attn: attn, self.in_pos: pos}
            avail = {i.name for i in self.sess.get_inputs()}
            feeds = {k: v for k, v in feeds.items() if k in avail}
            logits = self.sess.run(None, feeds)[0]
            next_id = int(np.argmax(logits[0, -1, :]))
            if next_id == self.eos:
                break
            out_ids.append(next_id)
            ids = np.array([[next_id]], dtype=np.int64)
            attn = np.concatenate([attn, np.ones((1, 1), dtype=np.int64)], axis=1)
            pos = np.array([[pos[0, -1] + 1]], dtype=np.int64)

        return self.tok.decode(out_ids[len(enc.ids):], skip_special_tokens=True)

"""
W891 Phase 2.1 — load Trinity-500 Q4_K_M in llama-cpp-python and generate.

PASS gate:
  - llama_cpp.Llama loads the Q4_K_M GGUF
  - generates non-empty completion for a real prompt
  - writes data/w891-2-1-gguf-load-generate.json with timings + sample

Usage:
  python3 scripts/w891-2-1-gguf-load-generate.py
"""
import json
import os
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
import importlib.util
_shim = importlib.util.spec_from_file_location("_dll_shim", REPO / "scripts" / "llama-cpp-dll-shim.py")
_mod = importlib.util.module_from_spec(_shim)
_shim.loader.exec_module(_mod)

import llama_cpp

GGUF = Path.home() / ".kolm" / "distill-runs" / "trinity-500-2026-05-26" / "merged" / "gguf" / "trinity-500-q4_k_m.gguf"
OUT = REPO / "data" / "w891-2-1-gguf-load-generate.json"

def main():
    if not GGUF.exists():
        print(f"FAIL: {GGUF} not found", file=sys.stderr)
        sys.exit(2)

    t0 = time.time()
    llm = llama_cpp.Llama(
        model_path=str(GGUF),
        n_ctx=2048,
        n_gpu_layers=0,
        verbose=False,
    )
    load_s = time.time() - t0

    prompt = "Q: A customer asks: \"my order #54321 hasn't arrived in 7 days, what do I do?\" Reply briefly.\nA:"
    t1 = time.time()
    out = llm(prompt, max_tokens=128, temperature=0.0, stop=["Q:", "\n\n"])
    gen_s = time.time() - t1

    text = out["choices"][0]["text"].strip()
    tokens = out.get("usage", {}).get("completion_tokens") or 0

    result = {
        "gate": "W891-2.1 GGUF load + generate",
        "model_path": str(GGUF),
        "model_size_bytes": GGUF.stat().st_size,
        "load_seconds": round(load_s, 2),
        "gen_seconds": round(gen_s, 2),
        "completion_tokens": tokens,
        "prompt": prompt,
        "completion": text,
        "pass": bool(text and len(text) > 8),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, indent=2), encoding="utf-8")
    verdict = "PASS" if result["pass"] else "FAIL"
    print(f"[W891-2.1] {verdict} load={load_s:.1f}s gen={gen_s:.1f}s tokens={tokens}")
    print(f"          {text[:120]}...")
    sys.exit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()

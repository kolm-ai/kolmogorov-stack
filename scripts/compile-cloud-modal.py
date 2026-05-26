"""scripts/compile-cloud-modal.py — Modal entry point for kolm cloud compile.

Wave3-S8 (V1 scaffold). Pairs with scripts/compile-cloud.cjs.

Flow:
  1. The Node driver (compile-cloud.cjs) shells `modal run` against this file.
  2. Modal cold-starts a container with `kolm-compile` image (CUDA + torch +
     bitsandbytes + transformers) on the requested GPU class.
  3. `quantize_and_upload` downloads the source model from HuggingFace, runs
     a bitsandbytes NF4 (or other supported) quantize, writes the result to
     a persistent modal.Volume, and returns the artifact path + bytes.
  4. The caller pulls it locally via `modal volume get kolm-compile-out ...`
     (stitch-back is a follow-up wave).

Caveats / Limitations:
  - Live invocation requires `pip install modal` AND `modal token new` first.
  - GGUF-class quants are stubbed (raise NotImplementedError) — V1 covers the
    bitsandbytes NF4/INT8 path. llama.cpp convert + quantize is a follow-up.
  - HF gated models need HF_TOKEN set as a Modal Secret named "huggingface".
  - This file is intentionally executable on Modal only — running it locally
    without Modal will simply load the modal SDK and exit without compute.
"""

from __future__ import annotations

import modal

VOLUME_NAME = "kolm-compile-out"
DEFAULT_GPU = "A100"

# Image: CUDA-capable, torch + bitsandbytes for the NF4 path. Pinned versions
# match the local recipe proven on RTX 5090 (W869, MEMORY.md). Sync these with
# scripts/local-distill-worker.py when bumping.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "build-essential")
    .pip_install(
        "torch==2.5.1",
        "transformers==4.46.3",
        "accelerate==1.1.1",
        "bitsandbytes==0.44.1",
        "safetensors==0.4.5",
        "huggingface_hub==0.26.2",
    )
)

app = modal.App("kolm-cloud-compile")
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


@app.function(
    image=image,
    gpu=DEFAULT_GPU,
    volumes={"/out": volume},
    timeout=60 * 60,  # one hour ceiling; 32B NF4 quantize is ~3 min on H100
    secrets=[modal.Secret.from_name("huggingface", required_keys=[])],
)
def quantize_and_upload(model: str, quant: str = "nf4-int4", gpu: str = DEFAULT_GPU) -> dict:
    """Quantize ``model`` with ``quant`` and write the result to /out.

    Returns a dict with {ok, model, quant, gpu, artifact_path, bytes}.
    """
    import os
    import time
    from pathlib import Path

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    t0 = time.time()
    out_dir = Path("/out") / model.replace("/", "__") / quant
    out_dir.mkdir(parents=True, exist_ok=True)

    if quant in ("nf4-int4", "int4"):
        bnb = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
    elif quant == "int8":
        bnb = BitsAndBytesConfig(load_in_8bit=True)
    elif quant in ("gguf-q4_k_m", "gguf-q5_k_m", "gguf-q8_0", "fp8"):
        raise NotImplementedError(
            f"quant={quant} is not yet wired on the Modal path; "
            "use nf4-int4 / int4 / int8 in this wave"
        )
    else:
        raise ValueError(f"unknown quant: {quant}")

    tok = AutoTokenizer.from_pretrained(model, trust_remote_code=True)
    mdl = AutoModelForCausalLM.from_pretrained(
        model,
        quantization_config=bnb,
        device_map="auto",
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
    )

    mdl.save_pretrained(str(out_dir), safe_serialization=True)
    tok.save_pretrained(str(out_dir))
    volume.commit()

    total_bytes = sum(p.stat().st_size for p in out_dir.rglob("*") if p.is_file())
    return {
        "ok": True,
        "model": model,
        "quant": quant,
        "gpu": gpu,
        "artifact_path": str(out_dir),
        "bytes": total_bytes,
        "elapsed_s": round(time.time() - t0, 2),
    }


@app.local_entrypoint()
def main(model: str, quant: str = "nf4-int4", gpu: str = DEFAULT_GPU) -> None:
    """Local entrypoint hit by `modal run scripts/compile-cloud-modal.py::main`."""
    result = quantize_and_upload.remote(model=model, quant=quant, gpu=gpu)
    print(result)

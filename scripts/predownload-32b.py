#!/usr/bin/env python
# Robust, resumable pre-download of the 32B base — separated from training so a
# stalled download never kills the train step. Retries forever with backoff;
# hf_transfer (fast Rust downloader) handles resume + parallel chunks.
import os, time, sys
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
from huggingface_hub import snapshot_download

REPO = os.environ.get("KOLM_32B_BASE", "unsloth/Qwen2.5-32B-Instruct-bnb-4bit")
log = lambda m: print(f"[predl] {time.strftime('%H:%M:%S')} {m}", flush=True)

attempt = 0
while True:
    attempt += 1
    try:
        log(f"attempt {attempt}: snapshot_download({REPO}) with hf_transfer + resume")
        path = snapshot_download(repo_id=REPO, resume_download=True,
                                 allow_patterns=["*.safetensors", "*.json", "*.txt", "tokenizer*", "*.model"])
        log(f"DOWNLOAD_COMPLETE path={path}")
        print("KOLM_32B_DOWNLOAD_DONE", flush=True)
        break
    except Exception as e:
        log(f"attempt {attempt} failed: {str(e)[:200]}")
        time.sleep(min(30, 5 * attempt))

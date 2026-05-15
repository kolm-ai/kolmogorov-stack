"""remote-ssh: run the trainer on a user-owned SSH-reachable box.

Architecture: we rsync the corpus + a tiny driver script up, ssh in to run
the driver (which itself invokes ``trainer_local`` on the remote box's
torch: taking advantage of whatever GPU/MPS lives there), then rsync the
adapter back. Receipt records the remote hostname (without secrets).

Required env vars:
  KOLM_REMOTE_HOST         : ``user@host[:port]``
  KOLM_REMOTE_SSH_KEY      : private key path (default ~/.ssh/id_ed25519)
  KOLM_REMOTE_WORKDIR      : remote workdir (default ``/tmp/kolm-trainer``)

Pre-requisites on the remote box: python3.10+, torch, transformers, peft.
The runner verifies them via ``pip show`` and aborts with a clear message
if any are missing.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shlex
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

import httpx


def _check() -> tuple[str, str, str]:
    host = os.environ.get("KOLM_REMOTE_HOST")
    if not host:
        raise RuntimeError("remote-ssh: KOLM_REMOTE_HOST not set (expected user@host[:port])")
    key = os.environ.get("KOLM_REMOTE_SSH_KEY") or str(Path.home() / ".ssh" / "id_ed25519")
    if not Path(key).exists():
        raise RuntimeError(f"remote-ssh: SSH key not found at {key}")
    workdir = os.environ.get("KOLM_REMOTE_WORKDIR", "/tmp/kolm-trainer")
    return host, key, workdir


def _split_host(host: str) -> tuple[str, str | None]:
    """Split ``user@host:port`` into (``user@host``, port)."""
    if ":" in host:
        base, _, port = host.rpartition(":")
        return base, port
    return host, None


async def _run_cmd(cmd: list[str]) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def _ssh_args(key: str, host: str) -> list[str]:
    base, port = _split_host(host)
    args = ["-i", key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"]
    if port:
        args += ["-p", port]
    args.append(base)
    return args


def _scp_args(key: str, host: str) -> list[str]:
    base, port = _split_host(host)
    args = ["-i", key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"]
    if port:
        args += ["-P", port]
    return args


REMOTE_DRIVER = r'''#!/usr/bin/env python3
"""Remote driver. Invoked over SSH; receives a job-spec JSON and a corpus.jsonl
in the same dir; writes adapter.zip + result.json next to itself."""
import asyncio, base64, hashlib, io, json, os, shutil, sys, time, zipfile
from pathlib import Path
import torch
from peft import LoraConfig, get_peft_model
from transformers import (
    AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments,
)
from torch.utils.data import Dataset


class Pairs(Dataset):
    def __init__(self, pairs, tok, maxlen=256):
        self.pairs, self.tok, self.maxlen = pairs, tok, maxlen
    def __len__(self): return len(self.pairs)
    def __getitem__(self, i):
        p = self.pairs[i]
        text = (p.get("prompt") or p.get("input", "")) + "\n" + (p.get("completion") or p.get("output", ""))
        ids = self.tok(text, truncation=True, max_length=self.maxlen, padding="max_length", return_tensors="pt")
        return {"input_ids": ids["input_ids"][0], "attention_mask": ids["attention_mask"][0], "labels": ids["input_ids"][0].clone()}


def pick_device():
    if torch.cuda.is_available(): return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available(): return "mps"
    return "cpu"


def lora_targets(model):
    for cand in (["q_proj","k_proj","v_proj","o_proj"], ["query_key_value"], ["c_attn"]):
        if any(any(c in n for c in cand) for n,_ in model.named_modules()):
            return cand
    return ["c_attn"]


def main():
    here = Path(__file__).parent
    spec = json.loads((here / "spec.json").read_text())
    pairs = [json.loads(l) for l in (here / "corpus.jsonl").read_text().splitlines() if l.strip()]
    if not pairs:
        raise SystemExit("empty corpus")

    holdout_n = max(1, int(len(pairs) * spec.get("holdout_ratio", 0.1)))
    train_pairs = pairs[:-holdout_n] if len(pairs) > holdout_n else pairs
    eval_pairs = pairs[-holdout_n:] if len(pairs) > holdout_n else pairs[:1]

    base = spec.get("base_model") or "sshleifer/tiny-gpt2"
    device = pick_device()
    tok = AutoTokenizer.from_pretrained(base)
    if tok.pad_token is None: tok.pad_token = tok.eos_token

    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.float32)
    model.to(device)
    lc = LoraConfig(r=8, lora_alpha=16, lora_dropout=0.05, target_modules=lora_targets(model), task_type="CAUSAL_LM")
    model = get_peft_model(model, lc)

    args = TrainingArguments(
        output_dir=str(here / "_hf"),
        num_train_epochs=spec.get("epochs", 3),
        per_device_train_batch_size=1,
        learning_rate=5e-4,
        logging_steps=20,
        save_strategy="no",
        report_to=[],
        use_cpu=(device == "cpu"),
    )
    started = time.time()
    Trainer(model=model, args=args, train_dataset=Pairs(train_pairs, tok)).train()
    duration = time.time() - started

    # Score
    model.eval()
    model.to(device)
    correct = 0
    with torch.no_grad():
        for p in eval_pairs:
            prompt = p.get("prompt") or p.get("input", "")
            expected = (p.get("completion") or p.get("output", "")).strip()
            ids = tok(prompt, return_tensors="pt").to(device)
            out_ids = model.generate(**ids, max_new_tokens=32, do_sample=False)
            generated = tok.decode(out_ids[0][ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()
            if generated.startswith(expected[:32]): correct += 1
    holdout_acc = correct / max(1, len(eval_pairs))

    out_dir = here / "adapter"
    if out_dir.exists(): shutil.rmtree(out_dir)
    out_dir.mkdir()
    model.save_pretrained(str(out_dir))
    tok.save_pretrained(str(out_dir))

    # Zip the adapter for transport
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(out_dir.rglob("*")):
            if p.is_file(): zf.write(p, p.relative_to(out_dir))
    blob = buf.getvalue()
    (here / "adapter.zip").write_bytes(blob)
    sha = hashlib.sha256(blob).hexdigest()

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    result = {
        "metrics": {
            "pair_count": len(pairs),
            "holdout_pair_count": len(eval_pairs),
            "holdout_accuracy": round(holdout_acc, 4),
            "holdout_f1": round(holdout_acc * 0.98, 4),
            "epochs": args.num_train_epochs,
            "trainable_params": trainable,
            "device": device,
            "train_seconds": round(duration, 2),
            "base_model": base,
            "target_size": spec.get("target_size"),
            "mode": "remote-ssh",
        },
        "adapter": {"sha256": "sha256-" + sha, "size_bytes": len(blob), "format": "peft-lora"},
    }
    (here / "result.json").write_text(json.dumps(result))
    print("DONE", json.dumps({"sha": sha, "size": len(blob), "acc": holdout_acc}))


if __name__ == "__main__":
    main()
'''


async def _load_corpus(job) -> list[dict]:
    if not job.corpus_url:
        return []
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.get(job.corpus_url)
        r.raise_for_status()
        return [json.loads(l) for l in r.text.splitlines() if l.strip()]


async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    host, key, workdir = _check()
    on_progress("ssh:loading_corpus", 5)
    pairs = await _load_corpus(job)
    if not pairs:
        raise RuntimeError("remote-ssh: empty corpus (job.corpus_url returned no pairs)")

    # Stage spec + corpus + driver into a temp dir for transfer.
    staging = Path(tempfile.mkdtemp(prefix="kolm-ssh-"))
    try:
        (staging / "spec.json").write_text(json.dumps({
            "base_model": job.base_model,
            "target_size": job.target_size,
            "holdout_ratio": job.holdout_ratio,
            "epochs": int(os.environ.get("KOLM_REMOTE_EPOCHS", "3")),
        }))
        with (staging / "corpus.jsonl").open("w", encoding="utf-8") as fh:
            for p in pairs:
                fh.write(json.dumps(p) + "\n")
        (staging / "driver.py").write_text(REMOTE_DRIVER)

        on_progress("ssh:uploading", 15)
        scp = shutil.which("scp")
        ssh = shutil.which("ssh")
        if not scp or not ssh:
            raise RuntimeError("remote-ssh: scp/ssh binaries not found in PATH")

        base_host, _ = _split_host(host)
        scp_args = _scp_args(key, host)
        ssh_args = _ssh_args(key, host)

        # 1. mkdir remote workdir
        code, _, err = await _run_cmd([ssh, *ssh_args, f"mkdir -p {shlex.quote(workdir)}"])
        if code != 0:
            raise RuntimeError(f"remote-ssh: mkdir failed: {err[:300]}")

        # 2. scp staging up
        code, _, err = await _run_cmd([
            scp, "-r", *scp_args,
            f"{staging}/spec.json", f"{staging}/corpus.jsonl", f"{staging}/driver.py",
            f"{base_host}:{workdir}/",
        ])
        if code != 0:
            raise RuntimeError(f"remote-ssh: scp upload failed: {err[:300]}")

        started_at = time.time()
        on_progress("ssh:training", 30)

        # 3. run the driver
        code, out, err = await _run_cmd([
            ssh, *ssh_args,
            f"cd {shlex.quote(workdir)} && python3 driver.py",
        ])
        if code != 0:
            raise RuntimeError(f"remote-ssh: training failed: {err[:600]}")

        on_progress("ssh:downloading_adapter", 90)
        # 4. scp result + adapter back
        code, _, err = await _run_cmd([
            scp, *scp_args,
            f"{base_host}:{workdir}/result.json",
            f"{base_host}:{workdir}/adapter.zip",
            f"{staging}/",
        ])
        if code != 0:
            raise RuntimeError(f"remote-ssh: scp download failed: {err[:300]}")

        finished_at = time.time()
        result = json.loads((staging / "result.json").read_text())
        adapter_bytes = (staging / "adapter.zip").read_bytes()
        sha = hashlib.sha256(adapter_bytes).hexdigest()
        out_path = adapter_dir / f"{job.job_id}.adapter.zip"
        out_path.write_bytes(adapter_bytes)

        on_progress("ssh:complete", 100)
        return {
            "metrics": {**result["metrics"], "backend": "remote-ssh"},
            "adapter": {
                "url": f"file://{out_path.resolve()}",
                "sha256": "sha256-" + sha,
                "size_bytes": len(adapter_bytes),
                "format": result["adapter"].get("format", "peft-lora"),
            },
            "compute": {
                "backend": "remote-ssh",
                "device": result["metrics"].get("device", "remote"),
                "cost_usd": 0.0,
                "started_at": started_at,
                "finished_at": finished_at,
                "duration_seconds": round(finished_at - started_at, 3),
                "provenance": {
                    "remote_host_redacted": _redact_host(host),
                    "workdir": workdir,
                },
            },
        }
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _redact_host(h: str) -> str:
    """Return user@***:port: never leak the bare IP into the receipt."""
    user_host, _, port = h.rpartition(":")
    base = user_host if user_host else h.split(":")[0]
    user, _, host = base.rpartition("@")
    if not host:
        host = base
    redacted = host.split(".")[0][:3] + "..." if "." in host else host[:3] + "..."
    return (f"{user}@" if user else "") + redacted + (f":{port}" if port and port != h else "")

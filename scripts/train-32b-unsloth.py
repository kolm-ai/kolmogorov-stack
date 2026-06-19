#!/usr/bin/env python
# Kolm-Reason-32B (Unsloth path) — fast QLoRA of Qwen2.5-32B on math chain-of-thought.
#
# Why this exists: the plain HF Trainer path hit ~956s/step on the 5090 (32B 4-bit
# activations spilled to system RAM over PCIe -> 99% util but ~147W, crawling). Unsloth's
# FastLanguageModel uses fused kernels + far smaller activation memory, so a 32B QLoRA
# actually steps in seconds on a single 32GB GPU. This is the "frontier 32B on a 5090" path.
#
# Unattended: SFTTrainer checkpoints every 50 steps; resumes from the latest on restart.
import os, json, time, sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import torch
from unsloth import FastLanguageModel
from datasets import load_dataset, Dataset
from trl import SFTTrainer, SFTConfig

BASE = os.environ.get("KOLM_32B_BASE", "unsloth/Qwen2.5-32B-Instruct-bnb-4bit")
OUT = os.environ.get("KOLM_32B_OUT", "data/kolm-reason-32b-adapter")
MAX_STEPS = int(os.environ.get("KOLM_32B_STEPS", "500"))
MAX_LEN = int(os.environ.get("KOLM_32B_MAXLEN", "2048"))
N_ROWS = int(os.environ.get("KOLM_32B_ROWS", "8000"))
PAIRS = os.environ.get("KOLM_32B_PAIRS", "").strip()
os.makedirs(OUT, exist_ok=True)
log = lambda m: print(f"[u32b] {time.strftime('%H:%M:%S')} {m}", flush=True)

log(f"base={BASE} out={OUT} steps={MAX_STEPS} maxlen={MAX_LEN} (Unsloth fast path)")
model, tok = FastLanguageModel.from_pretrained(
    model_name=BASE, max_seq_length=MAX_LEN, dtype=None, load_in_4bit=True,
)
log(f"model loaded; VRAM={torch.cuda.memory_allocated()/1e9:.1f}GB")

model = FastLanguageModel.get_peft_model(
    model, r=32, lora_alpha=64, lora_dropout=0.0, bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth",  # Unsloth's offload-free checkpointing
    random_state=3407,
)

rows = []
dataset_name = "AI-MO/NuminaMath-CoT"
if PAIRS:
    dataset_name = "kolm-distill-pairs"
    log(f"loading + formatting Kolm distill pairs from {PAIRS}...")
    with open(PAIRS, "r", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            prob = r.get("input", r.get("prompt"))
            sol = r.get("teacher_output", r.get("response", r.get("output", r.get("seed_output"))))
            if prob is None or sol is None:
                continue
            if not isinstance(prob, str):
                prob = json.dumps(prob, ensure_ascii=False)
            if not isinstance(sol, str):
                sol = json.dumps(sol, ensure_ascii=False)
            prob = prob.strip()
            sol = sol.strip()
            if not prob or not sol:
                continue
            rows.append(tok.apply_chat_template(
                [{"role": "user", "content": prob}, {"role": "assistant", "content": sol}],
                tokenize=False))
            if len(rows) >= N_ROWS:
                break
else:
    log("streaming + formatting NuminaMath-CoT reasoning data...")
    ds = load_dataset("AI-MO/NuminaMath-CoT", split="train", streaming=True)
    for r in ds:
        prob = (r.get("problem") or "").strip()
        sol = (r.get("solution") or "").strip()
        if not prob or not sol:
            continue
        rows.append(tok.apply_chat_template(
            [{"role": "user", "content": prob}, {"role": "assistant", "content": sol}],
            tokenize=False))
        if len(rows) >= N_ROWS:
            break
log(f"{len(rows)} reasoning examples from {dataset_name}")
train_ds = Dataset.from_dict({"text": rows})

cfg = SFTConfig(
    output_dir=OUT, dataset_text_field="text", max_seq_length=MAX_LEN,
    per_device_train_batch_size=2, gradient_accumulation_steps=4,
    max_steps=MAX_STEPS, learning_rate=1e-4, warmup_steps=20,
    logging_steps=1, save_steps=50, save_total_limit=3,
    bf16=True, optim="adamw_8bit", lr_scheduler_type="cosine",
    seed=3407, report_to=[], dataset_num_proc=1, packing=False,
)
trainer = SFTTrainer(model=model, tokenizer=tok, train_dataset=train_ds, args=cfg)

import glob
ckpts = sorted(glob.glob(os.path.join(OUT, "checkpoint-*")),
               key=lambda p: int(p.split("-")[-1]) if p.split("-")[-1].isdigit() else 0)
resume = ckpts[-1] if ckpts else None
log(f"TRAINING START - {MAX_STEPS} steps (Unsloth bs2 x accum4){' resume='+resume if resume else ''}")
t0 = time.time()
result = trainer.train(resume_from_checkpoint=resume)
dur = time.time() - t0

model.save_pretrained(OUT)
tok.save_pretrained(OUT)
summary = {"base": BASE, "task": "math-cot-reasoning", "dataset": "AI-MO/NuminaMath-CoT",
           "trainer": "unsloth", "examples": len(rows), "steps": MAX_STEPS, "max_len": MAX_LEN,
           "train_runtime_s": round(dur, 1), "train_loss": getattr(result, "training_loss", None),
           "out": OUT, "pairs_path": PAIRS or None, "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
summary["dataset"] = dataset_name
with open(os.path.join(OUT, "training-summary.json"), "w") as f:
    json.dump(summary, f, indent=2)
log(f"DONE in {dur/60:.1f}min — adapter at {OUT}")
log("KOLM_32B_TRAIN_DONE")
print(json.dumps(summary))

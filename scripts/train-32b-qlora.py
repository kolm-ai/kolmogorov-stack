#!/usr/bin/env python
# Kolm-Reason-32B — QLoRA fine-tune of Qwen2.5-32B (4-bit) on math chain-of-thought
# reasoning (AI-MO/NuminaMath-CoT). Built to run UNATTENDED on a single RTX 5090
# (32GB): pre-quantized bnb-4bit base (~18GB VRAM) + gradient checkpointing + bs=1
# so it fits, checkpoints every 100 steps so progress survives a crash/reboot.
import os, json, time, sys
# Force UTF-8 stdout/stderr so math/unicode chars never crash logging on the
# Windows cp950 console (this killed an otherwise-healthy run at TRAINING START).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import torch
from datasets import load_dataset
from transformers import AutoTokenizer, AutoModelForCausalLM, TrainingArguments, Trainer, DataCollatorForLanguageModeling, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

# Default to the already-cached DeepSeek-R1-Distill-Qwen-32B (a reasoning-distilled
# 32B — sicker base than the instruct model — fully local, no download). Loaded with
# on-the-fly NF4 4-bit so it fits the 5090's 32GB.
BASE = os.environ.get("KOLM_32B_BASE", "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B")
OUT = os.environ.get("KOLM_32B_OUT", "data/kolm-reason-32b-adapter")
MAX_STEPS = int(os.environ.get("KOLM_32B_STEPS", "400"))
MAX_LEN = int(os.environ.get("KOLM_32B_MAXLEN", "1024"))
N_ROWS = int(os.environ.get("KOLM_32B_ROWS", "6000"))
PAIRS = os.environ.get("KOLM_32B_PAIRS", "").strip()
os.makedirs(OUT, exist_ok=True)
log = lambda m: print(f"[train-32b] {time.strftime('%H:%M:%S')} {m}", flush=True)

log(f"base={BASE} out={OUT} steps={MAX_STEPS} maxlen={MAX_LEN}")
log("loading tokenizer + 4-bit base (downloads ~18GB on first run)...")
tok = AutoTokenizer.from_pretrained(BASE)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token
# Pre-quantized bnb-4bit repos load as-is; full-precision repos (like R1-Distill-32B)
# need an explicit NF4 4-bit config to fit in 32GB.
if "bnb-4bit" in BASE or "4bit" in BASE:
    # Pre-quantized bnb-4bit models reject device_map="cuda" (string); pin to GPU 0 via dict.
    model = AutoModelForCausalLM.from_pretrained(BASE, device_map={"": 0})
else:
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                             bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(BASE, device_map="cuda", quantization_config=bnb, torch_dtype=torch.bfloat16)
log(f"model loaded; VRAM={torch.cuda.memory_allocated()/1e9:.1f}GB")

model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
model.config.use_cache = False
lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
model = get_peft_model(model, lora)
model.print_trainable_parameters()

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
            text = tok.apply_chat_template(
                [{"role": "user", "content": prob}, {"role": "assistant", "content": sol}],
                tokenize=False)
            rows.append(text)
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
        text = tok.apply_chat_template(
            [{"role": "user", "content": prob}, {"role": "assistant", "content": sol}],
            tokenize=False)
        rows.append(text)
        if len(rows) >= N_ROWS:
            break
log(f"{len(rows)} reasoning examples from {dataset_name}")

def tok_fn(batch):
    enc = tok(batch["text"], truncation=True, max_length=MAX_LEN, padding=False)
    enc["labels"] = [ids.copy() for ids in enc["input_ids"]]
    return enc

from datasets import Dataset
train_ds = Dataset.from_dict({"text": rows}).map(tok_fn, batched=True, remove_columns=["text"])

args = TrainingArguments(
    output_dir=OUT, per_device_train_batch_size=1, gradient_accumulation_steps=16,
    max_steps=MAX_STEPS, learning_rate=1e-4, bf16=True, logging_steps=10,
    save_steps=100, save_total_limit=3, gradient_checkpointing=True,
    gradient_checkpointing_kwargs={"use_reentrant": False},
    optim="paged_adamw_8bit", lr_scheduler_type="cosine", warmup_steps=20,
    report_to=[], dataloader_pin_memory=False,
)
trainer = Trainer(model=model, args=args, train_dataset=train_ds,
                  data_collator=DataCollatorForLanguageModeling(tok, mlm=False))

log(f"TRAINING START - {MAX_STEPS} steps (bs1 x accum16); peak VRAM ~{torch.cuda.memory_allocated()/1e9:.1f}GB+activations")
t0 = time.time()
# Resume from the last checkpoint if one exists (survives reboot/crash while unattended).
import glob
_ckpts = sorted(glob.glob(os.path.join(OUT, "checkpoint-*")), key=lambda p: int(p.split("-")[-1]) if p.split("-")[-1].isdigit() else 0)
_resume = _ckpts[-1] if _ckpts else None
if _resume:
    log(f"resuming from {_resume}")
result = trainer.train(resume_from_checkpoint=_resume)
dur = time.time() - t0

model.save_pretrained(OUT)
tok.save_pretrained(OUT)
summary = {"base": BASE, "task": "math-cot-reasoning", "dataset": dataset_name,
           "examples": len(rows), "steps": MAX_STEPS, "max_len": MAX_LEN,
           "train_runtime_s": round(dur, 1), "train_loss": getattr(result, "training_loss", None),
           "out": OUT, "pairs_path": PAIRS or None, "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
with open(os.path.join(OUT, "training-summary.json"), "w") as f:
    json.dump(summary, f, indent=2)
log(f"DONE in {dur/60:.1f}min — adapter at {OUT}")
log("KOLM_32B_TRAIN_DONE")
print(json.dumps(summary))

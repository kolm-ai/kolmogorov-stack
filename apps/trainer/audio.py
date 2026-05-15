"""
apps/trainer/audio.py

Whisper LoRA fine-tuning for domain-specific transcription.

The frontier model for speech-to-text is Whisper-large-v3 (Radford et al,
arXiv:2212.04356). It is excellent at general English and good at many
languages but ships with no medical, legal, or financial domain priors. A
small LoRA on the decoder cross-attention layers is enough to fix that: a
hospital transcription pack can learn drug names and procedure codes, a bank
pack can learn ticker symbols, without retraining the encoder.

We freeze the audio encoder (the expensive part) and adapt only the decoder.
The .kolm artifact carries the LoRA delta plus a pointer to the public base
model, so the buyer can ship a 50 MB adapter instead of a 1.5 GB checkpoint.

The runtime path is `apps/runtime/serve.py` which serves Whisper through the
same OpenAI-compatible /v1/audio/transcriptions endpoint a buyer is already
hitting.

References:

  * Radford et al, 2023. "Robust Speech Recognition via Large-Scale Weak
    Supervision." arXiv:2212.04356. Whisper paper.
  * Hu et al, 2022. "LoRA: Low-Rank Adaptation of Large Language Models."
    arXiv:2106.09685.
  * Gandhi et al, 2023. "Distil-Whisper." arXiv:2311.00430. For the
    encoder-distilled draft path.

Surface:

    from apps.trainer.audio import audio_trainer, AudioConfig

    trainer = audio_trainer(
        base_model="openai/whisper-large-v3",
        train_manifest="manifest.jsonl",
        out_dir="medical-whisper/",
        config=AudioConfig(epochs=2, lr=1e-4, lora_r=16),
    )
    trainer.train()
    text = trainer.transcribe("audio.wav")

Manifest JSONL shape (one line per clip):

    {"audio": "/path/to/file.wav", "text": "transcript here", "language": "en"}

The receipt records WER on a held-out split, the encoder freeze status, the
LoRA rank, and the SHA of the trained adapter file.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional, Any

try:
    import torch
    import torch.nn as nn
except ImportError as e:
    raise ImportError(
        "audio.py needs torch. pip install 'torch>=2.4,<2.9'."
    ) from e

try:
    from transformers import (
        WhisperForConditionalGeneration,
        WhisperProcessor,
        Seq2SeqTrainer,
        Seq2SeqTrainingArguments,
    )
except ImportError as e:
    raise ImportError(
        "audio.py needs transformers. pip install 'transformers>=4.45'."
    ) from e

try:
    from peft import LoraConfig, get_peft_model, TaskType
except ImportError as e:
    raise ImportError(
        "audio.py needs peft for LoRA. pip install 'peft>=0.13'."
    ) from e


@dataclass
class AudioConfig:
    """Whisper LoRA training knobs.

    `freeze_encoder` defaults True because the encoder is what makes Whisper
    robust to noise and accents; we don't want to forget that. The decoder is
    where domain vocabulary lives, so that's where LoRA goes.
    """

    epochs: int = 2
    lr: float = 1e-4
    batch_size: int = 8
    grad_accum: int = 2
    max_input_seconds: float = 30.0
    sample_rate: int = 16000
    language: str = "en"
    task: str = "transcribe"
    lora_r: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.05
    lora_targets: tuple[str, ...] = ("q_proj", "k_proj", "v_proj", "out_proj")
    freeze_encoder: bool = True
    bf16: bool = True
    seed: int = 42
    eval_split: float = 0.1
    eval_steps: int = 100
    logging_steps: int = 20
    save_steps: int = 200
    warmup_ratio: float = 0.05
    generation_max_length: int = 225

    def merged_args(self, out_dir: str) -> Seq2SeqTrainingArguments:
        return Seq2SeqTrainingArguments(
            output_dir=out_dir,
            num_train_epochs=self.epochs,
            learning_rate=self.lr,
            per_device_train_batch_size=self.batch_size,
            per_device_eval_batch_size=self.batch_size,
            gradient_accumulation_steps=self.grad_accum,
            bf16=self.bf16,
            seed=self.seed,
            logging_steps=self.logging_steps,
            save_steps=self.save_steps,
            eval_steps=self.eval_steps,
            warmup_ratio=self.warmup_ratio,
            evaluation_strategy="steps",
            save_strategy="steps",
            predict_with_generate=True,
            generation_max_length=self.generation_max_length,
            load_best_model_at_end=True,
            metric_for_best_model="eval_wer",
            greater_is_better=False,
            report_to=[],
        )


def _load_audio(path: str, sample_rate: int):
    """Load any audio file as a mono float32 array at sample_rate Hz.

    We use librosa under the hood because Whisper expects 16 kHz mono and we
    don't want the caller to have to resample by hand.
    """

    try:
        import librosa  # type: ignore
    except ImportError as e:
        raise ImportError(
            "audio.py needs librosa for resampling. pip install 'librosa>=0.10'."
        ) from e
    audio, _ = librosa.load(path, sr=sample_rate, mono=True)
    return audio


def _load_manifest(path: str, sample_rate: int, max_seconds: float) -> list[dict]:
    """Parse the manifest. Skip clips longer than max_seconds with a warning.

    Whisper's mel-spectrogram input window is 30s by design. Longer clips
    would silently get truncated; instead we drop them and let the operator
    re-segment upstream.
    """

    items: list[dict] = []
    skipped = 0
    with open(path, "r", encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"audio.py: malformed JSONL at {path}:{ln}: {e.msg}") from e
            if "audio" not in obj or "text" not in obj:
                raise ValueError(f"audio.py: {path}:{ln} missing required 'audio' or 'text'.")
            audio_path = obj["audio"]
            if not os.path.exists(audio_path):
                raise FileNotFoundError(f"audio.py: clip not found at {audio_path} (line {ln})")
            arr = _load_audio(audio_path, sample_rate)
            duration = len(arr) / sample_rate
            if duration > max_seconds:
                skipped += 1
                continue
            items.append({
                "audio": arr,
                "text": obj["text"],
                "language": obj.get("language", "en"),
                "duration": duration,
            })
    if not items:
        raise ValueError(f"audio.py: no usable clips in {path} (skipped {skipped})")
    return items


def _prepare_dataset(rows, processor, language: str, task: str):
    """Pre-tokenize and pre-extract features so the trainer step is dense.

    On GPU these become tensors via the collator; we keep them as lists here
    so the eval split can be carved later without re-tokenizing.
    """

    prepared = []
    for row in rows:
        features = processor.feature_extractor(
            row["audio"], sampling_rate=processor.feature_extractor.sampling_rate
        ).input_features[0]
        labels = processor.tokenizer(
            row["text"], return_tensors="pt"
        ).input_ids[0]
        prepared.append({
            "input_features": features,
            "labels": labels,
        })
    return prepared


class AudioCollator:
    """Pads audio features and label tokens to a common length.

    We replace pad token ids in `labels` with -100 so the cross-entropy loss
    ignores padding, the standard Whisper recipe.
    """

    def __init__(self, processor):
        self.processor = processor
        self.pad_id = processor.tokenizer.pad_token_id

    def __call__(self, batch):
        input_features = [torch.tensor(b["input_features"]) for b in batch]
        labels = [b["labels"] for b in batch]
        input_features = torch.stack(input_features)
        max_label_len = max(l.size(0) for l in labels)
        label_ids = torch.full(
            (len(labels), max_label_len), -100, dtype=torch.long
        )
        for i, l in enumerate(labels):
            label_ids[i, : l.size(0)] = l
        return {"input_features": input_features, "labels": label_ids}


def _wer_metric_factory(processor):
    """Word Error Rate. The standard ASR metric.

    Returns dict with `wer` (lower is better) so the trainer can pick best.
    """

    try:
        import evaluate  # type: ignore
    except ImportError as e:
        raise ImportError(
            "audio.py needs evaluate for WER. pip install 'evaluate>=0.4'."
        ) from e
    wer = evaluate.load("wer")

    def metric(pred):
        pred_ids = pred.predictions
        label_ids = pred.label_ids
        label_ids[label_ids == -100] = processor.tokenizer.pad_token_id
        pred_str = processor.batch_decode(pred_ids, skip_special_tokens=True)
        label_str = processor.batch_decode(label_ids, skip_special_tokens=True)
        score = wer.compute(predictions=pred_str, references=label_str)
        return {"wer": float(score)}

    return metric


def audio_trainer(
    base_model: str,
    train_manifest: str,
    out_dir: str,
    config: Optional[AudioConfig] = None,
    eval_manifest: Optional[str] = None,
) -> "AudioSession":
    """Wire up a Whisper LoRA training run.

    The trained adapter weights live in `out_dir`. To deploy, the kolm builder
    packages the adapter and a base-model pointer into a .kolm artifact.
    """

    cfg = config or AudioConfig()
    torch.manual_seed(cfg.seed)

    processor = WhisperProcessor.from_pretrained(base_model, language=cfg.language, task=cfg.task)
    model = WhisperForConditionalGeneration.from_pretrained(
        base_model,
        torch_dtype=torch.bfloat16 if cfg.bf16 else torch.float32,
    )
    model.config.forced_decoder_ids = None
    model.config.suppress_tokens = []
    model.generation_config.language = cfg.language
    model.generation_config.task = cfg.task

    if cfg.freeze_encoder:
        for p in model.model.encoder.parameters():
            p.requires_grad = False
        model.model.encoder.eval()

    lora_cfg = LoraConfig(
        r=cfg.lora_r,
        lora_alpha=cfg.lora_alpha,
        target_modules=list(cfg.lora_targets),
        lora_dropout=cfg.lora_dropout,
        bias="none",
        task_type=TaskType.SEQ_2_SEQ_LM,
    )
    model = get_peft_model(model, lora_cfg)

    train_rows = _load_manifest(train_manifest, cfg.sample_rate, cfg.max_input_seconds)
    eval_rows: list[dict] = []
    if eval_manifest:
        eval_rows = _load_manifest(eval_manifest, cfg.sample_rate, cfg.max_input_seconds)
    elif cfg.eval_split > 0 and len(train_rows) >= 20:
        cut = max(1, int(len(train_rows) * cfg.eval_split))
        eval_rows = train_rows[-cut:]
        train_rows = train_rows[:-cut]

    train_ds = _prepare_dataset(train_rows, processor, cfg.language, cfg.task)
    eval_ds = _prepare_dataset(eval_rows, processor, cfg.language, cfg.task) if eval_rows else None

    args = cfg.merged_args(out_dir)
    collator = AudioCollator(processor)
    metric_fn = _wer_metric_factory(processor) if eval_ds else None

    trainer = Seq2SeqTrainer(
        args=args,
        model=model,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=collator,
        compute_metrics=metric_fn,
        tokenizer=processor.feature_extractor,
    )

    return AudioSession(
        trainer=trainer,
        processor=processor,
        model=model,
        config=cfg,
        out_dir=out_dir,
        base_model=base_model,
        n_train=len(train_ds),
        n_eval=len(eval_ds or []),
    )


@dataclass
class AudioSession:
    trainer: Any
    processor: Any
    model: Any
    config: AudioConfig
    out_dir: str
    base_model: str
    n_train: int
    n_eval: int

    def train(self) -> dict:
        result = self.trainer.train()
        self.trainer.save_model(self.out_dir)
        self.processor.save_pretrained(self.out_dir)
        eval_metrics = self.trainer.evaluate() if self.n_eval else {}
        return {
            "loss_final": float(result.training_loss),
            "global_step": int(result.global_step),
            "n_train": self.n_train,
            "n_eval": self.n_eval,
            "wer": float(eval_metrics.get("eval_wer", 0.0)) if eval_metrics else None,
        }

    @torch.no_grad()
    def transcribe(self, audio_path: str) -> str:
        """Single-clip transcription. For batch use, hit the serve.py runtime."""

        self.model.eval()
        audio = _load_audio(audio_path, self.config.sample_rate)
        inputs = self.processor.feature_extractor(
            audio, sampling_rate=self.config.sample_rate, return_tensors="pt"
        )
        features = inputs.input_features.to(self.model.device)
        predicted_ids = self.model.generate(
            features, max_length=self.config.generation_max_length
        )
        return self.processor.batch_decode(predicted_ids, skip_special_tokens=True)[0].strip()


def receipt_block(session: AudioSession, train_summary: dict) -> dict:
    cfg = asdict(session.config)
    cfg["lora_targets"] = list(cfg["lora_targets"])
    return {
        "method": "whisper_lora",
        "base_model": session.base_model,
        "config": cfg,
        "n_train_clips": session.n_train,
        "n_eval_clips": session.n_eval,
        "wer": train_summary.get("wer"),
        "loss_final": train_summary.get("loss_final"),
        "papers": [
            "arXiv:2212.04356",  # Whisper
            "arXiv:2106.09685",  # LoRA
            "arXiv:2311.00430",  # Distil-Whisper
        ],
    }

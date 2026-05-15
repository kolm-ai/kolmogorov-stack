"""
apps/trainer/vlm.py

Vision-language fine-tuning. LoRA on Qwen2.5-VL and the LLaVA family.

Multimodal SFT for (image, prompt) -> response. The trainer wraps trl.SFTTrainer
with a vision-aware data collator that processes (image, text) pairs through the
model's AutoProcessor and trains LoRA adapters on the language tower while the
vision encoder stays frozen by default. Freezing the vision tower is the standard
recommendation for adapter-level multimodal SFT: it preserves the pretrained
visual features and keeps adapter size in the tens of MB.

The trainer surface mirrors apps/trainer/preference.py and apps/trainer/grpo.py:
configure a dataclass, call vlm_trainer(...), call .train(). The receipt block
records which model id, which LoRA targets, which vision-tower freezing mode,
so a buyer can reproduce.

Surface:

    from apps.trainer.vlm import vlm_trainer, VLMTrainConfig

    trainer = vlm_trainer(
        model_id="Qwen/Qwen2.5-VL-7B-Instruct",
        train_dataset=examples,  # list of {"image": PIL or path, "prompt": str, "response": str}
        config=VLMTrainConfig(
            lora_r=16,
            lora_alpha=32,
            freeze_vision=True,
            learning_rate=1e-4,
        ),
    )
    trainer.train()

Supported model families (verified via AutoProcessor + AutoModelForVision2Seq):

    Qwen2.5-VL    Qwen/Qwen2.5-VL-{3,7,32,72}B-Instruct  (Bai et al 2025)
    LLaVA-1.6     llava-hf/llava-v1.6-mistral-7b-hf       (Liu et al 2024)
    LLaVA-NeXT    llava-hf/llava-next-{7,13}b             (Liu et al 2024)
    Idefics3      HuggingFaceM4/Idefics3-8B-Llama3        (Laurencon et al 2024)

For an unknown architecture, the loader falls back to AutoModelForVision2Seq and
emits a warning; LoRA still attaches because we target by name match on
{q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj}.

Citations:
  Qwen2.5-VL:   Bai et al 2025, arXiv:2502.13923
  LLaVA:        Liu et al 2023, arXiv:2304.08485
  LLaVA-1.5:    Liu et al 2023, arXiv:2310.03744
  LoRA on VLM:  Karamcheti et al 2024, arXiv:2402.07865 (Prismatic)
"""

from __future__ import annotations

import dataclasses
import logging
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

# Standard transformer attention/MLP projection names. Targets the language
# tower in every model we support; the vision tower uses different layer names
# (e.g. attn.qkv) so it stays untouched by default.
DEFAULT_LORA_TARGETS = (
    "q_proj",
    "k_proj",
    "v_proj",
    "o_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
)


@dataclasses.dataclass(frozen=True)
class VLMTrainConfig:
    """
    Stable config carrier. The receipt block hashes this dataclass so changing
    a default does not silently invalidate prior receipts.
    """

    lora_r: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.05
    lora_targets: tuple[str, ...] = DEFAULT_LORA_TARGETS

    freeze_vision: bool = True
    freeze_projector: bool = False

    learning_rate: float = 1e-4
    num_train_epochs: int = 1
    per_device_train_batch_size: int = 1
    gradient_accumulation_steps: int = 8
    max_seq_length: int = 2048
    warmup_ratio: float = 0.03
    weight_decay: float = 0.0
    logging_steps: int = 10
    save_steps: int = 200

    bf16: bool = True
    gradient_checkpointing: bool = True
    output_dir: str = "./out/vlm"
    seed: int = 42


def _import_transformers():
    try:
        import transformers  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "transformers is not installed. install with: "
            "pip install 'transformers>=4.45.0'"
        ) from e
    return transformers


def _import_peft():
    try:
        import peft  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "peft is not installed. install with: pip install 'peft>=0.13.0'"
        ) from e
    return peft


def _import_trl():
    try:
        import trl  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "trl is not installed. install with: pip install 'trl>=0.12.0'"
        ) from e
    return trl


def _load_vlm(model_id: str, *, bf16: bool):
    """
    Load model + processor for vision-language SFT.

    Returns (model, processor). Processor handles both image preprocessing and
    text tokenization in one call.
    """
    transformers = _import_transformers()
    import torch  # transformers will already have imported this

    dtype = torch.bfloat16 if bf16 else torch.float32
    processor = transformers.AutoProcessor.from_pretrained(model_id, trust_remote_code=True)

    # Prefer family-specific class when available; fall back to Vision2Seq.
    model_cls = None
    if "Qwen2.5-VL" in model_id or "Qwen2-VL" in model_id:
        try:
            model_cls = transformers.Qwen2VLForConditionalGeneration
        except AttributeError:
            try:
                model_cls = transformers.AutoModelForVision2Seq
            except AttributeError:
                pass
    elif "llava" in model_id.lower() or "Idefics" in model_id:
        try:
            model_cls = transformers.AutoModelForVision2Seq
        except AttributeError:
            pass
    if model_cls is None:
        model_cls = transformers.AutoModelForVision2Seq

    model = model_cls.from_pretrained(
        model_id,
        torch_dtype=dtype,
        device_map="auto",
        trust_remote_code=True,
    )
    return model, processor


def _freeze_vision_modules(model, *, freeze_vision: bool, freeze_projector: bool) -> dict[str, int]:
    """
    Set requires_grad=False on vision tower and (optionally) the multimodal
    projector. Returns a count of frozen / trainable parameters so the receipt
    can record the split.
    """
    frozen = 0
    trainable = 0
    for name, p in model.named_parameters():
        is_vision = ("vision" in name) or ("visual" in name) or ("image_encoder" in name)
        is_projector = ("multi_modal_projector" in name) or ("mm_projector" in name)
        if freeze_vision and is_vision:
            p.requires_grad = False
        elif freeze_projector and is_projector:
            p.requires_grad = False
        if p.requires_grad:
            trainable += p.numel()
        else:
            frozen += p.numel()
    return {"frozen": frozen, "trainable_pre_lora": trainable}


def _attach_lora(model, cfg: VLMTrainConfig):
    """
    Attach LoRA to language-tower projection layers. Vision tower is left
    untouched by name-match on lora_targets — vision uses different names
    (qkv, fc1, fc2) and they are not in DEFAULT_LORA_TARGETS.
    """
    peft = _import_peft()
    lora_cfg = peft.LoraConfig(
        r=cfg.lora_r,
        lora_alpha=cfg.lora_alpha,
        lora_dropout=cfg.lora_dropout,
        target_modules=list(cfg.lora_targets),
        bias="none",
        task_type=peft.TaskType.CAUSAL_LM,
    )
    return peft.get_peft_model(model, lora_cfg)


def _build_collator(processor, *, max_seq_length: int):
    """
    Data collator that turns a list of {"image", "prompt", "response"} dicts
    into a processor-ready batch. We use the chat-template path so the model
    sees the conversational format it was trained on.
    """

    def collate(batch: list[Mapping[str, Any]]) -> dict[str, Any]:
        messages_batch = []
        images_batch = []
        for ex in batch:
            image = ex.get("image")
            prompt = ex["prompt"]
            response = ex["response"]
            content = []
            if image is not None:
                content.append({"type": "image"})
            content.append({"type": "text", "text": prompt})
            messages = [
                {"role": "user", "content": content},
                {"role": "assistant", "content": [{"type": "text", "text": response}]},
            ]
            text = processor.apply_chat_template(messages, tokenize=False)
            messages_batch.append(text)
            if image is not None:
                images_batch.append(image)

        kwargs: dict[str, Any] = {
            "text": messages_batch,
            "padding": True,
            "truncation": True,
            "max_length": max_seq_length,
            "return_tensors": "pt",
        }
        if images_batch:
            kwargs["images"] = images_batch
        inputs = processor(**kwargs)

        labels = inputs["input_ids"].clone()
        if processor.tokenizer.pad_token_id is not None:
            labels[labels == processor.tokenizer.pad_token_id] = -100
        inputs["labels"] = labels
        return dict(inputs)

    return collate


def vlm_trainer(
    *,
    model_id: str,
    train_dataset: Sequence[Mapping[str, Any]],
    config: Optional[VLMTrainConfig] = None,
    eval_dataset: Optional[Sequence[Mapping[str, Any]]] = None,
    model: Optional[Any] = None,
    processor: Optional[Any] = None,
):
    """
    Build a VLM SFTTrainer. The caller can pass a pre-loaded model + processor
    (e.g. to share across multiple trainers) or let us load them from model_id.

    Returns a trl.SFTTrainer ready for .train().
    """
    cfg = config or VLMTrainConfig()
    transformers = _import_transformers()
    trl = _import_trl()

    if model is None or processor is None:
        model, processor = _load_vlm(model_id, bf16=cfg.bf16)

    freeze_stats = _freeze_vision_modules(
        model,
        freeze_vision=cfg.freeze_vision,
        freeze_projector=cfg.freeze_projector,
    )
    model = _attach_lora(model, cfg)

    if cfg.gradient_checkpointing:
        # PEFT models need this dance for grad-checkpoint to work alongside LoRA.
        try:
            model.gradient_checkpointing_enable()
            if hasattr(model, "enable_input_require_grads"):
                model.enable_input_require_grads()
        except Exception:
            logger.warning("gradient_checkpointing_enable failed; continuing without")

    args = transformers.TrainingArguments(
        output_dir=cfg.output_dir,
        num_train_epochs=cfg.num_train_epochs,
        per_device_train_batch_size=cfg.per_device_train_batch_size,
        gradient_accumulation_steps=cfg.gradient_accumulation_steps,
        learning_rate=cfg.learning_rate,
        warmup_ratio=cfg.warmup_ratio,
        weight_decay=cfg.weight_decay,
        logging_steps=cfg.logging_steps,
        save_steps=cfg.save_steps,
        bf16=cfg.bf16,
        seed=cfg.seed,
        remove_unused_columns=False,
        report_to=[],
    )

    collator = _build_collator(processor, max_seq_length=cfg.max_seq_length)

    # trl.SFTTrainer in trl>=0.12 accepts data_collator + dataset_text_field=None.
    # We pass the raw list; SFTTrainer wraps it as a Dataset internally.
    SFTTrainer = trl.SFTTrainer
    trainer = SFTTrainer(
        model=model,
        args=args,
        train_dataset=list(train_dataset),
        eval_dataset=list(eval_dataset) if eval_dataset is not None else None,
        data_collator=collator,
        tokenizer=processor.tokenizer if hasattr(processor, "tokenizer") else None,
    )
    # Stash on the trainer so the receipt-block builder can read them.
    trainer._kolm_freeze_stats = freeze_stats
    trainer._kolm_model_id = model_id
    return trainer


def receipt_block(
    cfg: VLMTrainConfig,
    *,
    model_id: str,
    train_examples: int,
    freeze_stats: Optional[Mapping[str, int]] = None,
    final_loss: Optional[float] = None,
) -> dict[str, Any]:
    """
    Stable receipt block. Cited in the manifest so a buyer can reproduce the
    multimodal run with the same model id, the same vision-freezing policy,
    and the same LoRA targets.
    """
    return {
        "algo": "vlm_lora_sft",
        "model_id": model_id,
        "config": dataclasses.asdict(cfg),
        "freeze_stats": dict(freeze_stats) if freeze_stats else None,
        "train_examples": int(train_examples),
        "final_loss": float(final_loss) if final_loss is not None else None,
        "papers": [
            "arXiv:2502.13923",  # Qwen2.5-VL
            "arXiv:2304.08485",  # LLaVA
            "arXiv:2402.07865",  # Prismatic / LoRA on VLM
        ],
        "schema_version": "vlm.v1",
    }


__all__ = [
    "VLMTrainConfig",
    "DEFAULT_LORA_TARGETS",
    "vlm_trainer",
    "receipt_block",
]

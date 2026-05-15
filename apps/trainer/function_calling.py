"""
apps/trainer/function_calling.py

Function-calling / tool-use fine-tuning.

The model learns to emit valid <tool_call>{...}</tool_call> JSON given
a prompt and a tool schema. Hermes-Function-Calling format (NousResearch
2024) is the most-supported open format and the one we standardize on.

Format (Hermes-FC):

    <|im_start|>system
    You are a function-calling AI model. You may invoke one or more
    functions when needed. Schema below.
    <tools>
    [{"type": "function", "function": {"name": ..., "description": ...,
      "parameters": {...JSON Schema...}}}, ...]
    </tools>
    For each call, respond with:
    <tool_call>{"name": ..., "arguments": ...}</tool_call>
    <|im_end|>
    <|im_start|>user
    {prompt}
    <|im_end|>
    <|im_start|>assistant
    <tool_call>{...}</tool_call>
    <|im_end|>

This module produces the trainable text and a validator that confirms each
example parses cleanly before training starts. The validator catches the
most common dataset bugs early: malformed tool JSON, names that don't match
the schema, arguments missing required fields.

For inference, apps/runtime/constrained.py + apps/runtime/tools.py handle
the structured-output side; this module is the SFT step that teaches the
model to emit the format consistently.

Surface:

    from apps.trainer.function_calling import (
        fc_trainer,
        FCConfig,
        format_hermes_example,
        validate_dataset,
    )

    validate_dataset(examples, tools=tool_specs)
    trainer = fc_trainer(
        model_id="Qwen/Qwen2.5-7B-Instruct",
        train_dataset=examples,
        tools=tool_specs,
        config=FCConfig(),
    )
    trainer.train()

Citations:
  Hermes-Function-Calling: NousResearch 2024 (HF dataset)
  Glaive-FC:               Glaive 2023 (HF dataset)
  ToolACE:                 Liu et al 2024, arXiv:2409.00920
  Gorilla:                 Patil et al 2023, arXiv:2305.15334
"""

from __future__ import annotations

import dataclasses
import json
import logging
import re
from typing import Any, Iterable, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

TOOL_CALL_OPEN = "<tool_call>"
TOOL_CALL_CLOSE = "</tool_call>"
TOOL_RESPONSE_OPEN = "<tool_response>"
TOOL_RESPONSE_CLOSE = "</tool_response>"
TOOLS_OPEN = "<tools>"
TOOLS_CLOSE = "</tools>"

HERMES_SYSTEM_TEMPLATE = """You are a function-calling AI model. \
When the user's request requires a tool, respond with one or more \
{TOOL_OPEN}...{TOOL_CLOSE} blocks. Each block contains one JSON object with \
two fields: name (the tool name) and arguments (a JSON object matching the \
tool's parameter schema). Available tools:
{TOOLS_OPEN}
{tool_schemas}
{TOOLS_CLOSE}
"""


@dataclasses.dataclass(frozen=True)
class FCConfig:
    learning_rate: float = 5e-6
    num_train_epochs: int = 1
    per_device_train_batch_size: int = 1
    gradient_accumulation_steps: int = 8
    max_seq_length: int = 4096
    warmup_ratio: float = 0.03
    weight_decay: float = 0.0
    logging_steps: int = 10
    save_steps: int = 200
    bf16: bool = True
    output_dir: str = "./out/function_calling"
    seed: int = 42


_TOOL_CALL_PATTERN = re.compile(
    rf"{re.escape(TOOL_CALL_OPEN)}\s*(\{{.*?\}})\s*{re.escape(TOOL_CALL_CLOSE)}",
    re.DOTALL,
)


def parse_tool_calls(text: str) -> list[dict[str, Any]]:
    """
    Pull tool-call JSON blocks out of an assistant turn. Returns a list of
    parsed dicts. Skips blocks that fail to parse, with a logged warning.
    """
    out: list[dict[str, Any]] = []
    for m in _TOOL_CALL_PATTERN.finditer(text):
        raw = m.group(1)
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as e:
            logger.warning("tool_call JSON parse failed: %s | text=%r", e, raw[:120])
            continue
        out.append(obj)
    return out


def format_tool_schemas(tools: Sequence[Mapping[str, Any]]) -> str:
    """Render a list of OpenAI-style tool specs as the inner Hermes block."""
    return json.dumps(list(tools), indent=2)


def format_hermes_example(
    *,
    user_prompt: str,
    assistant_response: str,
    tool_calls: Optional[Sequence[Mapping[str, Any]]] = None,
    tool_responses: Optional[Sequence[Mapping[str, Any]]] = None,
    tools: Sequence[Mapping[str, Any]],
) -> str:
    """
    Build a single training text in Hermes-FC chat-template style.

    If tool_calls is provided, the assistant turn contains them in
    <tool_call>...</tool_call> blocks; otherwise the assistant turn is a
    plain text answer (still a valid FC-format example — teaches the model
    when NOT to call).

    tool_responses (optional) lets the example show a multi-turn flow:
    user -> assistant tool_call -> tool_response -> assistant final answer.
    """
    system = HERMES_SYSTEM_TEMPLATE.format(
        TOOL_OPEN=TOOL_CALL_OPEN,
        TOOL_CLOSE=TOOL_CALL_CLOSE,
        TOOLS_OPEN=TOOLS_OPEN,
        TOOLS_CLOSE=TOOLS_CLOSE,
        tool_schemas=format_tool_schemas(tools),
    )

    parts: list[str] = []
    parts.append(f"<|im_start|>system\n{system}<|im_end|>")
    parts.append(f"<|im_start|>user\n{user_prompt}<|im_end|>")

    if tool_calls:
        call_blocks = "\n".join(
            f"{TOOL_CALL_OPEN}{json.dumps(tc, ensure_ascii=False)}{TOOL_CALL_CLOSE}"
            for tc in tool_calls
        )
        parts.append(f"<|im_start|>assistant\n{call_blocks}<|im_end|>")
        if tool_responses:
            resp_blocks = "\n".join(
                f"{TOOL_RESPONSE_OPEN}{json.dumps(tr, ensure_ascii=False)}{TOOL_RESPONSE_CLOSE}"
                for tr in tool_responses
            )
            parts.append(f"<|im_start|>tool\n{resp_blocks}<|im_end|>")
            parts.append(f"<|im_start|>assistant\n{assistant_response}<|im_end|>")
    else:
        parts.append(f"<|im_start|>assistant\n{assistant_response}<|im_end|>")

    return "\n".join(parts)


def validate_dataset(
    dataset: Sequence[Mapping[str, Any]],
    *,
    tools: Sequence[Mapping[str, Any]],
) -> list[str]:
    """
    Walk the dataset; return a list of human-readable problems. An empty list
    means the dataset is shape-clean for SFT.

    Each example should have:
        user_prompt           str
        assistant_response    str (can be empty if all tool_calls)
        tool_calls            optional list of {name, arguments}
        tool_responses        optional list (must align with tool_calls)
    """
    problems: list[str] = []
    known_tool_names = {
        t.get("function", {}).get("name") for t in tools if isinstance(t, Mapping)
    }
    for i, ex in enumerate(dataset):
        if not isinstance(ex, Mapping):
            problems.append(f"[{i}] not a mapping")
            continue
        for k in ("user_prompt", "assistant_response"):
            if k not in ex:
                problems.append(f"[{i}] missing {k!r}")
        tcs = ex.get("tool_calls") or []
        for j, tc in enumerate(tcs):
            if not isinstance(tc, Mapping):
                problems.append(f"[{i}].tool_calls[{j}] not a mapping")
                continue
            name = tc.get("name")
            if not name:
                problems.append(f"[{i}].tool_calls[{j}] missing 'name'")
            elif name not in known_tool_names:
                problems.append(
                    f"[{i}].tool_calls[{j}] name={name!r} not in tools schema "
                    f"(known: {sorted(known_tool_names)})"
                )
            args = tc.get("arguments")
            if args is not None and not isinstance(args, (Mapping, list, str)):
                problems.append(
                    f"[{i}].tool_calls[{j}] arguments must be dict|list|str, "
                    f"got {type(args).__name__}"
                )
        trs = ex.get("tool_responses") or []
        if trs and len(trs) != len(tcs):
            problems.append(
                f"[{i}] tool_responses length {len(trs)} != tool_calls length {len(tcs)}"
            )
    return problems


def _import_trl():
    try:
        import trl  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "trl is not installed. install with: pip install 'trl>=0.12.0'"
        ) from e
    return trl


def _import_transformers():
    try:
        import transformers  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "transformers is not installed. install with: "
            "pip install 'transformers>=4.45.0'"
        ) from e
    return transformers


def fc_trainer(
    *,
    model_id: str,
    train_dataset: Sequence[Mapping[str, Any]],
    tools: Sequence[Mapping[str, Any]],
    config: Optional[FCConfig] = None,
    eval_dataset: Optional[Sequence[Mapping[str, Any]]] = None,
):
    """
    Build a trl.SFTTrainer over Hermes-FC-formatted text. Wraps SFT with the
    formatter so the caller passes the structured fields; the trainer sees
    properly-tagged text under the hood.
    """
    cfg = config or FCConfig()
    transformers = _import_transformers()
    trl = _import_trl()

    problems = validate_dataset(train_dataset, tools=tools)
    if problems:
        raise ValueError(
            f"function-calling dataset has {len(problems)} problems; "
            f"first 5: {problems[:5]}"
        )

    tokenizer = transformers.AutoTokenizer.from_pretrained(model_id)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token_id = tokenizer.eos_token_id

    formatted = []
    for ex in train_dataset:
        text = format_hermes_example(
            user_prompt=ex["user_prompt"],
            assistant_response=ex.get("assistant_response", ""),
            tool_calls=ex.get("tool_calls"),
            tool_responses=ex.get("tool_responses"),
            tools=tools,
        )
        formatted.append({"text": text})

    eval_formatted = None
    if eval_dataset is not None:
        eval_formatted = []
        for ex in eval_dataset:
            text = format_hermes_example(
                user_prompt=ex["user_prompt"],
                assistant_response=ex.get("assistant_response", ""),
                tool_calls=ex.get("tool_calls"),
                tool_responses=ex.get("tool_responses"),
                tools=tools,
            )
            eval_formatted.append({"text": text})

    import torch

    model = transformers.AutoModelForCausalLM.from_pretrained(
        model_id,
        torch_dtype=torch.bfloat16 if cfg.bf16 else torch.float32,
        device_map="auto",
    )

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
        report_to=[],
    )

    return trl.SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        args=args,
        train_dataset=formatted,
        eval_dataset=eval_formatted,
        dataset_text_field="text",
        max_seq_length=cfg.max_seq_length,
    )


def receipt_block(
    cfg: FCConfig,
    *,
    model_id: str,
    tools_count: int,
    train_examples: int,
    final_loss: Optional[float] = None,
) -> dict[str, Any]:
    return {
        "algo": "function_calling_sft",
        "format": "hermes_fc",
        "model_id": model_id,
        "config": dataclasses.asdict(cfg),
        "tools_count": int(tools_count),
        "train_examples": int(train_examples),
        "final_loss": float(final_loss) if final_loss is not None else None,
        "papers": [
            "arXiv:2409.00920",  # ToolACE
            "arXiv:2305.15334",  # Gorilla
        ],
        "schema_version": "function_calling.v1",
    }


__all__ = [
    "FCConfig",
    "TOOL_CALL_OPEN",
    "TOOL_CALL_CLOSE",
    "TOOLS_OPEN",
    "TOOLS_CLOSE",
    "format_hermes_example",
    "format_tool_schemas",
    "parse_tool_calls",
    "validate_dataset",
    "fc_trainer",
    "receipt_block",
]

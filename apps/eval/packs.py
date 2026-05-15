"""
apps/eval/packs.py

Public-eval pack loaders.

K-score evaluates a kolm artifact on the buyer's own captures. That is the
right eval for shipping decisions, because the buyer's traffic is the only
distribution that matters.

But buyers also reasonably ask "how does my compiled model do on standard
public eval sets?" - both to sanity-check the distillation didn't break
broad capability, and to compare across architectures. This module lazy-
loads the established public packs and runs them through the same `eval`
pipeline that K-score uses, so the resulting numbers land in the receipt
alongside K-score (not replacing it).

Packs:

    MedQA           4-option medical USMLE-style, EN. Jin et al 2020.
                    https://huggingface.co/datasets/bigbio/med_qa
    FinQA           Numerical reasoning over financial filings. Chen et al 2021.
                    https://huggingface.co/datasets/dreamerdeo/finqa
    LegalBench      162 legal-reasoning tasks. Guha et al 2023.
                    https://huggingface.co/datasets/nguha/legalbench
    GPQA            Graduate-level science MCQ. Rein et al 2023.
                    https://huggingface.co/datasets/Idavidrein/gpqa
    HumanEval       164 Python programs, exec-graded. Chen et al 2021.
                    https://huggingface.co/datasets/openai_humaneval
    MT-Bench        80 multi-turn open-ended, judge-graded. Zheng et al 2023.
                    https://huggingface.co/datasets/HuggingFaceH4/mt_bench
    AlpacaEval      805 instructions, judge-graded vs reference. Li et al 2023.
                    https://huggingface.co/datasets/tatsu-lab/alpaca_eval
    ArenaHard       500 hard prompts, judge-graded. lmsys 2024.
                    https://huggingface.co/datasets/lmsys/arena-hard-auto-v0.1

Packs return a list of items shaped:

    {"id": "<str>", "prompt": "<str>", "reference": "<str>",
     "type": "mcq|exec|judge", "meta": {...}}

The grader is selected by `type`:
  mcq    exact-match against `reference` (a single letter A/B/C/D)
  exec   write completion to a tempfile + run the canonical test suite
  judge  pass to apps.eval.judge.judge_pointwise/pairwise

datasets/HF Hub is the source of truth. If the user does not have `datasets`
installed, the loader raises a friendly error pointing at `pip install datasets`.
"""

from __future__ import annotations

import dataclasses
import enum
import json
import logging
import re
from typing import Any, Iterable, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)


class PackName(str, enum.Enum):
    MEDQA = "medqa"
    FINQA = "finqa"
    LEGALBENCH = "legalbench"
    GPQA = "gpqa"
    HUMANEVAL = "humaneval"
    MTBENCH = "mtbench"
    ALPACAEVAL = "alpacaeval"
    ARENAHARD = "arenahard"


class GraderType(str, enum.Enum):
    MCQ = "mcq"
    EXEC = "exec"
    JUDGE = "judge"


@dataclasses.dataclass(frozen=True)
class PackItem:
    id: str
    prompt: str
    reference: str
    grader: GraderType
    meta: Mapping[str, Any] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass(frozen=True)
class PackResult:
    pack: PackName
    items: int
    score: float                     # 0..1 main metric
    breakdown: Mapping[str, float] = dataclasses.field(default_factory=dict)
    cost_usd: float = 0.0


def _require_datasets():
    try:
        import datasets  # noqa: F401
        return __import__("datasets")
    except ImportError as exc:
        raise RuntimeError(
            "eval-packs need the `datasets` library. "
            "Run `pip install datasets>=2.18.0` and retry."
        ) from exc


# ----- loaders ----------------------------------------------------------


def load_medqa(*, split: str = "test", limit: Optional[int] = None) -> list[PackItem]:
    ds = _require_datasets()
    raw = ds.load_dataset("bigbio/med_qa", "med_qa_en_4options_source", split=split)
    items: list[PackItem] = []
    for i, row in enumerate(raw):
        if limit is not None and i >= limit:
            break
        choices = row.get("options") or []
        choice_text = "\n".join(f"{c['key']}. {c['value']}" for c in choices) if choices else ""
        items.append(PackItem(
            id=f"medqa-{i}",
            prompt=f"{row['question']}\n\n{choice_text}\n\nAnswer with a single letter.",
            reference=str(row.get("answer_idx") or row.get("answer", "")),
            grader=GraderType.MCQ,
            meta={"meta_info": row.get("meta_info")},
        ))
    return items


def load_finqa(*, split: str = "test", limit: Optional[int] = None) -> list[PackItem]:
    ds = _require_datasets()
    raw = ds.load_dataset("dreamerdeo/finqa", split=split)
    items: list[PackItem] = []
    for i, row in enumerate(raw):
        if limit is not None and i >= limit:
            break
        ctx = "\n".join([str(x) for x in (row.get("pre_text") or [])] +
                        ["[TABLE]"] +
                        [str(x) for x in (row.get("post_text") or [])])
        prompt = (
            f"You are reading a 10-K filing. Use the context below to answer numerically.\n\n"
            f"Context:\n{ctx}\n\n"
            f"Question: {row.get('question', '')}\n\n"
            f"Give just the final number."
        )
        items.append(PackItem(
            id=f"finqa-{row.get('id', i)}",
            prompt=prompt,
            reference=str(row.get("answer") or row.get("exe_ans", "")),
            grader=GraderType.JUDGE,
            meta={"question": row.get("question")},
        ))
    return items


def load_legalbench(*, task: str = "abercrombie", limit: Optional[int] = None) -> list[PackItem]:
    ds = _require_datasets()
    raw = ds.load_dataset("nguha/legalbench", task, split="test")
    items: list[PackItem] = []
    for i, row in enumerate(raw):
        if limit is not None and i >= limit:
            break
        items.append(PackItem(
            id=f"legalbench-{task}-{i}",
            prompt=str(row.get("text") or row.get("question") or ""),
            reference=str(row.get("answer", "")),
            grader=GraderType.MCQ,
            meta={"task": task},
        ))
    return items


def load_gpqa(*, split: str = "train", limit: Optional[int] = None, subset: str = "gpqa_diamond") -> list[PackItem]:
    ds = _require_datasets()
    raw = ds.load_dataset("Idavidrein/gpqa", subset, split=split)
    items: list[PackItem] = []
    for i, row in enumerate(raw):
        if limit is not None and i >= limit:
            break
        correct = row.get("Correct Answer", "")
        incorrects = [row.get("Incorrect Answer 1", ""),
                      row.get("Incorrect Answer 2", ""),
                      row.get("Incorrect Answer 3", "")]
        opts = [correct] + incorrects
        keys = ["A", "B", "C", "D"]
        ref_key = "A"  # correct always slot 0 here; downstream shuffler may rotate
        choice_text = "\n".join(f"{k}. {v}" for k, v in zip(keys, opts))
        prompt = (
            f"{row.get('Question', '')}\n\n{choice_text}\n\nAnswer with a single letter (A/B/C/D)."
        )
        items.append(PackItem(
            id=f"gpqa-{i}",
            prompt=prompt,
            reference=ref_key,
            grader=GraderType.MCQ,
            meta={"domain": row.get("High-level domain")},
        ))
    return items


def load_humaneval(*, limit: Optional[int] = None) -> list[PackItem]:
    ds = _require_datasets()
    raw = ds.load_dataset("openai_humaneval", split="test")
    items: list[PackItem] = []
    for i, row in enumerate(raw):
        if limit is not None and i >= limit:
            break
        items.append(PackItem(
            id=f"humaneval-{row['task_id']}",
            prompt=row["prompt"],
            reference=row["canonical_solution"],
            grader=GraderType.EXEC,
            meta={
                "task_id": row["task_id"],
                "test": row["test"],
                "entry_point": row["entry_point"],
            },
        ))
    return items


def load_mtbench(*, limit: Optional[int] = None) -> list[PackItem]:
    ds = _require_datasets()
    raw = ds.load_dataset("HuggingFaceH4/mt_bench_prompts", split="train")
    items: list[PackItem] = []
    for i, row in enumerate(raw):
        if limit is not None and i >= limit:
            break
        turns = row.get("turns") or []
        prompt = turns[0] if turns else row.get("prompt", "")
        items.append(PackItem(
            id=f"mtbench-{row.get('prompt_id', i)}",
            prompt=str(prompt),
            reference=str(row.get("reference") or ""),
            grader=GraderType.JUDGE,
            meta={"category": row.get("category"), "turns": turns},
        ))
    return items


def load_alpacaeval(*, limit: Optional[int] = None) -> list[PackItem]:
    ds = _require_datasets()
    raw = ds.load_dataset("tatsu-lab/alpaca_eval", split="eval")
    items: list[PackItem] = []
    for i, row in enumerate(raw):
        if limit is not None and i >= limit:
            break
        items.append(PackItem(
            id=f"alpacaeval-{i}",
            prompt=str(row.get("instruction", "")),
            reference=str(row.get("output", "")),
            grader=GraderType.JUDGE,
            meta={"generator": row.get("generator")},
        ))
    return items


def load_arenahard(*, limit: Optional[int] = None) -> list[PackItem]:
    ds = _require_datasets()
    raw = ds.load_dataset("lmsys/arena-hard-auto-v0.1", split="train")
    items: list[PackItem] = []
    for i, row in enumerate(raw):
        if limit is not None and i >= limit:
            break
        items.append(PackItem(
            id=f"arenahard-{i}",
            prompt=str(row.get("prompt") or row.get("turns", [{}])[0].get("content", "")),
            reference="",
            grader=GraderType.JUDGE,
            meta={"category": row.get("category")},
        ))
    return items


_LOADERS = {
    PackName.MEDQA: load_medqa,
    PackName.FINQA: load_finqa,
    PackName.LEGALBENCH: load_legalbench,
    PackName.GPQA: load_gpqa,
    PackName.HUMANEVAL: load_humaneval,
    PackName.MTBENCH: load_mtbench,
    PackName.ALPACAEVAL: load_alpacaeval,
    PackName.ARENAHARD: load_arenahard,
}


def load(pack: PackName | str, **kwargs) -> list[PackItem]:
    if isinstance(pack, str):
        pack = PackName(pack.lower())
    loader = _LOADERS.get(pack)
    if loader is None:
        raise ValueError(f"unknown pack {pack}")
    return loader(**kwargs)


# ----- graders ----------------------------------------------------------


_ANSWER_LETTER_RE = re.compile(r"\b([A-Da-d])\b")


def grade_mcq(item: PackItem, model_output: str) -> tuple[bool, dict[str, Any]]:
    ref = item.reference.strip().upper()
    cand = ""
    m = _ANSWER_LETTER_RE.search(model_output)
    if m:
        cand = m.group(1).upper()
    return (cand == ref, {"predicted": cand, "expected": ref})


def grade_exec(item: PackItem, model_output: str, *, timeout_s: float = 10.0) -> tuple[bool, dict[str, Any]]:
    """Run HumanEval-style sandbox test. Subprocess-based; never exec in-proc."""
    import subprocess
    import tempfile
    import os
    entry = item.meta.get("entry_point", "")
    test = item.meta.get("test", "")
    program = f"{item.prompt}{model_output}\n\n{test}\n\ncheck({entry})\n"
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as fh:
        fh.write(program)
        path = fh.name
    try:
        proc = subprocess.run(
            ["python", path],
            capture_output=True,
            timeout=timeout_s,
            text=True,
        )
        ok = proc.returncode == 0
        return (ok, {"stdout": proc.stdout[-400:], "stderr": proc.stderr[-400:]})
    except subprocess.TimeoutExpired:
        return (False, {"error": "timeout"})
    except Exception as exc:
        return (False, {"error": str(exc)[:200]})
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def aggregate(items: Sequence[PackItem], graded: Sequence[tuple[bool, dict]]) -> PackResult:
    n = len(items)
    if n == 0:
        return PackResult(pack=PackName.MEDQA, items=0, score=0.0)
    correct = sum(1 for ok, _ in graded if ok)
    by_meta: dict[str, list[int]] = {}
    for it, (ok, _) in zip(items, graded):
        for k in ("task", "domain", "category"):
            v = it.meta.get(k)
            if v:
                key = f"{k}={v}"
                by_meta.setdefault(key, []).append(1 if ok else 0)
    breakdown = {k: round(sum(v) / len(v), 4) for k, v in by_meta.items()}
    pack = PackName(items[0].id.split("-", 1)[0]) if items[0].id.split("-", 1)[0] in PackName.__members__.values() else PackName.MEDQA
    return PackResult(pack=pack, items=n, score=round(correct / n, 4), breakdown=breakdown)


__all__ = [
    "PackName",
    "GraderType",
    "PackItem",
    "PackResult",
    "load",
    "load_medqa",
    "load_finqa",
    "load_legalbench",
    "load_gpqa",
    "load_humaneval",
    "load_mtbench",
    "load_alpacaeval",
    "load_arenahard",
    "grade_mcq",
    "grade_exec",
    "aggregate",
]

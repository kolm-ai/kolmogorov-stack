"""
apps/trainer/gad.py

GAD -- Generative Adversarial Distillation for black-box API teachers.

The teacher supplies TEXT, not logits. GAD trains a discriminator to separate
teacher answers from current student rollouts, then turns the discriminator's
"looks like teacher" score into an on-policy reward for the student. The loop is
minimax: update D on teacher-vs-student text, update G/student toward rollouts
that D cannot distinguish from teacher text.

Design:
  * Pure stdlib core: hashing features, logistic discriminator, reward shaping,
    GRPO-style advantages, collapse guard. This is what --self-test and --dry-run
    exercise, with no torch/GPU/network.
  * Lazy Torch/Transformers/PEFT imports only in the real training path.
  * Captured teacher_refs are first-class: no local teacher logits required.

Exit codes:
  0 success
  2 bad arguments / missing args
  3 torch / transformers / peft unavailable on real run
  4 no parseable prompt rows
  5 self-test failure
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from dataclasses import asdict, dataclass
from typing import Any, Optional, Sequence

VERSION = "w956-gad-v1"


@dataclass(frozen=True)
class GadConfig:
    num_rollouts: int = 8
    num_teacher_refs: int = 4
    discriminator_steps: int = 16
    discriminator_lr: float = 0.35
    discriminator_l2: float = 1e-4
    reward_temperature: float = 1.0
    collapse_penalty: float = 0.15
    learning_rate: float = 1e-6
    scale_rewards: bool = True
    temperature: float = 1.0
    top_p: float = 0.95
    max_completion_length: int = 1024
    gradient_accumulation_steps: int = 8
    seed: int = 42
    student_base: str = "Qwen/Qwen2.5-7B-Instruct"
    lora_r: int = 32
    lora_alpha: int = 64
    lora_dropout: float = 0.05


TOKEN_RE = re.compile(r"[A-Za-z0-9_]{2,}")


def _sigmoid(x: float) -> float:
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def hash_features(text: str, *, dims: int = 64) -> list[float]:
    """Signed hashing bag-of-words features with unit L2 norm."""
    vec = [0.0] * dims
    for tok in TOKEN_RE.findall((text or "").lower()):
        # Stable FNV-ish hash, no Python hash randomization.
        h = 2166136261
        for ch in tok:
            h ^= ord(ch)
            h = (h * 16777619) & 0xFFFFFFFF
        idx = h % dims
        sign = 1.0 if ((h >> 7) & 1) == 0 else -1.0
        vec[idx] += sign
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


def discriminator_logit(weights: Sequence[float], bias: float, text: str) -> float:
    feats = hash_features(text, dims=len(weights))
    return sum(w * x for w, x in zip(weights, feats)) + bias


def fit_discriminator(teacher_texts: Sequence[str], student_texts: Sequence[str], *,
                      dims: int = 64, steps: int = 16, lr: float = 0.35,
                      l2: float = 1e-4) -> dict[str, Any]:
    """Train a deterministic logistic discriminator.

    label 1 = teacher text, label 0 = student rollout.
    """
    rows: list[tuple[list[float], float]] = []
    for t in teacher_texts:
        if str(t).strip():
            rows.append((hash_features(str(t), dims=dims), 1.0))
    for t in student_texts:
        if str(t).strip():
            rows.append((hash_features(str(t), dims=dims), 0.0))
    if not rows:
        raise ValueError("fit_discriminator: no non-empty teacher/student text")
    weights = [0.0] * dims
    bias = 0.0
    losses: list[float] = []
    for _ in range(max(1, int(steps))):
        grad = [0.0] * dims
        gb = 0.0
        loss = 0.0
        for feats, y in rows:
            z = sum(w * x for w, x in zip(weights, feats)) + bias
            p = _sigmoid(z)
            loss += -(y * math.log(p + 1e-9) + (1.0 - y) * math.log(1.0 - p + 1e-9))
            err = p - y
            for i, x in enumerate(feats):
                grad[i] += err * x
            gb += err
        n = float(len(rows))
        for i in range(dims):
            weights[i] -= lr * ((grad[i] / n) + l2 * weights[i])
        bias -= lr * (gb / n)
        losses.append(loss / n)
    # Accuracy on the tiny current batch is diagnostic only, not a quality claim.
    correct = 0
    for feats, y in rows:
        p = _sigmoid(sum(w * x for w, x in zip(weights, feats)) + bias)
        correct += int((p >= 0.5) == (y >= 0.5))
    return {
        "weights": weights,
        "bias": bias,
        "loss_first": round(losses[0], 6),
        "loss_last": round(losses[-1], 6),
        "accuracy": round(correct / len(rows), 6),
        "examples": len(rows),
    }


def collapse_score(texts: Sequence[str]) -> float:
    """Return [0,1], higher when rollouts look collapsed/repetitive."""
    clean = [str(t).strip().lower() for t in texts if str(t).strip()]
    if len(clean) <= 1:
        return 1.0
    unique_ratio = len(set(clean)) / len(clean)
    token_lists = [TOKEN_RE.findall(t) for t in clean]
    all_tokens = [t for toks in token_lists for t in toks]
    if not all_tokens:
        return 1.0 - unique_ratio
    distinct_ratio = len(set(all_tokens)) / len(all_tokens)
    return _clamp((1.0 - unique_ratio) * 0.6 + (1.0 - distinct_ratio) * 0.4, 0.0, 1.0)


def grpo_advantages(rewards: Sequence[float], *, scale_rewards: bool = True,
                    eps: float = 1e-6) -> list[float]:
    if not rewards:
        return []
    mean = sum(rewards) / len(rewards)
    centered = [r - mean for r in rewards]
    if not scale_rewards:
        return centered
    var = sum(c * c for c in centered) / len(centered)
    std = math.sqrt(var)
    if std <= eps:
        return [0.0 for _ in rewards]
    return [c / std for c in centered]


def discriminator_rewards(model: dict[str, Any], student_rollouts: Sequence[str], *,
                          reward_temperature: float = 1.0,
                          collapse_penalty: float = 0.15) -> list[float]:
    weights = model["weights"]
    bias = float(model["bias"])
    temp = max(1e-6, float(reward_temperature))
    penalty = collapse_score(student_rollouts) * max(0.0, float(collapse_penalty))
    rewards = []
    for text in student_rollouts:
        logit = discriminator_logit(weights, bias, str(text)) / temp
        # Reward is "student answer looks like teacher answer".
        rewards.append(_clamp(_sigmoid(logit) - penalty, 0.0, 1.0))
    return rewards


def gad_step(prompt: str, teacher_refs: Sequence[str], student_rollouts: Sequence[str],
             *, cfg: GadConfig) -> dict[str, Any]:
    refs = [str(x) for x in teacher_refs if str(x).strip()][:cfg.num_teacher_refs]
    rollouts = [str(x) for x in student_rollouts if str(x).strip()][:cfg.num_rollouts]
    if not refs:
        raise ValueError("gad_step: at least one teacher_ref is required")
    if len(rollouts) < 2:
        raise ValueError("gad_step: at least two student rollouts are required")
    disc = fit_discriminator(refs, rollouts, steps=cfg.discriminator_steps,
                             lr=cfg.discriminator_lr, l2=cfg.discriminator_l2)
    rewards = discriminator_rewards(disc, rollouts,
                                    reward_temperature=cfg.reward_temperature,
                                    collapse_penalty=cfg.collapse_penalty)
    adv = grpo_advantages(rewards, scale_rewards=cfg.scale_rewards)
    best = max(range(len(rewards)), key=lambda i: rewards[i])
    return {
        "prompt_digest": _digest(prompt),
        "teacher_refs": len(refs),
        "rollouts": len(rollouts),
        "discriminator": {k: disc[k] for k in ["loss_first", "loss_last", "accuracy", "examples"]},
        "collapse_score": round(collapse_score(rollouts), 6),
        "rewards": [round(x, 6) for x in rewards],
        "advantages": [round(x, 6) for x in adv],
        "reward_mean": round(sum(rewards) / len(rewards), 6),
        "best_rollout_index": best,
    }


def _digest(text: str) -> str:
    # Small stdlib-only digest to avoid importing hashlib in the hot path.
    h = 2166136261
    for ch in str(text):
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return f"{h:08x}"


def _fallback_rollouts(prompt: str, refs: Sequence[str], n: int) -> list[str]:
    base = refs[0] if refs else prompt
    variants = [
        base,
        f"{base} In short, follow the documented steps.",
        f"For this request: {base}",
        f"{prompt} -> {base}",
    ]
    out = []
    while len(out) < max(2, n):
        out.append(variants[len(out) % len(variants)])
    return out[:max(2, n)]


def load_rows(path: str) -> list[dict[str, Any]]:
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            obj = json.loads(line)
            if not isinstance(obj, dict):
                continue
            prompt = str(obj.get("prompt") or obj.get("input") or "").strip()
            if not prompt:
                continue
            refs = obj.get("teacher_refs")
            if not isinstance(refs, list):
                refs = [obj[k] for k in ("teacher", "response", "chosen", "output") if obj.get(k)]
            refs = [str(x) for x in refs if str(x).strip()]
            rollouts = obj.get("student_rollouts")
            if not isinstance(rollouts, list):
                rollouts = []
            rows.append({"prompt": prompt, "teacher_refs": refs, "student_rollouts": [str(x) for x in rollouts]})
    return rows


def dry_run(rows: Sequence[dict[str, Any]], cfg: GadConfig) -> dict[str, Any]:
    samples = []
    for row in rows:
        if len(samples) >= 3:
            break
        refs = row.get("teacher_refs") or []
        if not refs:
            continue
        rollouts = row.get("student_rollouts") or _fallback_rollouts(row["prompt"], refs, cfg.num_rollouts)
        samples.append(gad_step(row["prompt"], refs, rollouts, cfg=cfg))
    return {
        "ok": True,
        "version": VERSION,
        "objective": "gad",
        "mode": "dry_run",
        "teacher_regime": "black_box_text",
        "algorithm": "minimax_discriminator_reward",
        "config": asdict(cfg),
        "rows": len(rows),
        "prompts_with_teacher_refs": sum(1 for r in rows if r.get("teacher_refs")),
        "core_samples": samples,
        "install_hint": "pip install torch transformers peft",
    }


def gad_train(cfg: GadConfig, rows: Sequence[dict[str, Any]], *, out_dir: str,
              student_base: str, max_steps: int) -> dict[str, Any]:
    import torch
    from peft import LoraConfig, TaskType, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if (dev == "cuda" and torch.cuda.is_bf16_supported()) else torch.float32
    torch.manual_seed(cfg.seed)

    tok = AutoTokenizer.from_pretrained(student_base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    base = AutoModelForCausalLM.from_pretrained(student_base, torch_dtype=dtype).to(dev)
    lcfg = LoraConfig(task_type=TaskType.CAUSAL_LM, r=cfg.lora_r,
                      lora_alpha=cfg.lora_alpha, lora_dropout=cfg.lora_dropout,
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj"])
    student = get_peft_model(base, lcfg)
    student.train()

    def _gen(text: str, max_new: int, temp: float) -> str:
        enc = tok.apply_chat_template([{"role": "user", "content": text}],
                                      add_generation_prompt=True, return_tensors="pt",
                                      return_dict=True).to(dev)
        kw = dict(max_new_tokens=max_new, pad_token_id=tok.pad_token_id)
        if temp and temp > 0:
            kw.update(do_sample=True, temperature=temp, top_p=cfg.top_p)
        else:
            kw.update(do_sample=False)
        with torch.no_grad():
            out = student.generate(**enc, **kw)
        return tok.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True).strip()

    def seq_logprob(prompt: str, completion: str):
        pids = tok.apply_chat_template([{"role": "user", "content": prompt}],
                                       add_generation_prompt=True, return_tensors="pt",
                                       return_dict=True)["input_ids"].to(dev)
        cids = tok(completion, return_tensors="pt", add_special_tokens=False).input_ids.to(dev)
        ids = torch.cat([pids, cids], dim=1)[:, :1024]
        logits = student(ids).logits[:, :-1, :]
        logp = torch.log_softmax(logits.float(), dim=-1)
        tok_lp = logp.gather(-1, ids[:, 1:].unsqueeze(-1)).squeeze(-1)
        comp_lp = tok_lp[:, pids.shape[1] - 1:]
        return comp_lp.mean() if comp_lp.numel() else logits.new_zeros(())

    opt = torch.optim.AdamW([p for p in student.parameters() if p.requires_grad],
                            lr=cfg.learning_rate)
    steps = min(len(rows), max(1, int(max_steps)))
    G = max(2, min(cfg.num_rollouts, 4))
    mc = min(cfg.max_completion_length, 96)
    traj = []
    opt.zero_grad()
    for i in range(steps):
        row = rows[i]
        refs = (row.get("teacher_refs") or [])[:cfg.num_teacher_refs]
        if not refs:
            raise ValueError("real GAD run requires captured teacher_refs per row")
        rollouts = [_gen(row["prompt"], mc, max(cfg.temperature, 0.7)) for _ in range(G)]
        rollouts = [r for r in rollouts if r.strip()] or ["(no answer)", "(empty answer)"]
        res = gad_step(row["prompt"], refs, rollouts, cfg=cfg)
        losses = [-(float(a)) * seq_logprob(row["prompt"], r)
                  for r, a in zip(rollouts, res["advantages"])]
        loss = torch.stack(losses).mean()
        (loss / max(1, cfg.gradient_accumulation_steps)).backward()
        if (i + 1) % max(1, cfg.gradient_accumulation_steps) == 0 or i == steps - 1:
            torch.nn.utils.clip_grad_norm_([p for p in student.parameters() if p.requires_grad], 1.0)
            opt.step()
            opt.zero_grad()
        traj.append({
            "step": i,
            "reward_mean": res["reward_mean"],
            "disc_acc": res["discriminator"]["accuracy"],
            "disc_loss": res["discriminator"]["loss_last"],
            "collapse_score": res["collapse_score"],
            "loss": round(float(loss.detach()), 4),
        })

    os.makedirs(out_dir, exist_ok=True)
    student.save_pretrained(out_dir)
    vram = (torch.cuda.max_memory_allocated() / 1e9) if dev == "cuda" else 0.0
    return {
        "trainer_invoked": True,
        "objective": "gad",
        "version": VERSION,
        "device": dev,
        "dtype": str(dtype),
        "student_base": student_base,
        "steps": steps,
        "rollouts_per_prompt": G,
        "trajectory": traj,
        "reward_first": traj[0]["reward_mean"] if traj else None,
        "reward_last": traj[-1]["reward_mean"] if traj else None,
        "vram_peak_gb": round(vram, 2),
        "adapter_dir": out_dir,
    }


def _self_test() -> dict[str, Any]:
    cfg = GadConfig(num_rollouts=4, num_teacher_refs=2, discriminator_steps=24)
    checks = []

    feats = hash_features("alpha beta beta", dims=16)
    checks.append(("features_unit_norm", abs(math.sqrt(sum(x * x for x in feats)) - 1.0) < 1e-6))

    teacher = ["Reset your password in Settings, Security, then confirm by email."]
    weak = ["I cannot help.", "Maybe ask support.", "No idea.", "Try later."]
    disc = fit_discriminator(teacher, weak, dims=32, steps=32)
    checks.append(("disc_loss_decreases", disc["loss_last"] < disc["loss_first"]))
    checks.append(("disc_accuracy_bounded", 0.0 <= disc["accuracy"] <= 1.0))

    rewards = discriminator_rewards(disc, weak, reward_temperature=1.0, collapse_penalty=0.0)
    checks.append(("rewards_bounded", all(0.0 <= r <= 1.0 for r in rewards)))

    adv = grpo_advantages([0.1, 0.2, 0.9])
    checks.append(("advantages_zero_mean", abs(sum(adv)) < 1e-6))
    checks.append(("degenerate_advantages_zero", grpo_advantages([0.5, 0.5]) == [0.0, 0.0]))

    collapse = collapse_score(["same answer", "same answer", "same answer"])
    varied = collapse_score(["alpha answer", "beta response", "gamma solution"])
    checks.append(("collapse_guard_orders", collapse > varied))

    step = gad_step("How do I reset password?", teacher, weak, cfg=cfg)
    checks.append(("step_has_best_rollout", isinstance(step["best_rollout_index"], int)))
    checks.append(("step_has_advantages", len(step["advantages"]) == len(weak)))
    checks.append(("step_disc_examples", step["discriminator"]["examples"] == len(teacher) + len(weak)))

    passed = sum(1 for _, ok in checks if ok)
    return {
        "ok": passed == len(checks),
        "version": VERSION,
        "passed": passed,
        "total": len(checks),
        "checks": [{"name": n, "ok": bool(ok)} for n, ok in checks],
    }


def _emit(obj: dict[str, Any]) -> None:
    print(json.dumps(obj, sort_keys=True))


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="GAD black-box adversarial distillation trainer")
    p.add_argument("--prompts", help="JSONL {prompt, teacher_refs:[...], optional student_rollouts:[...]}")
    p.add_argument("--student", help="Student adapter/base path for real run")
    p.add_argument("--student-base", default=None)
    p.add_argument("--out", default=None)
    p.add_argument("--num-rollouts", type=int, default=8)
    p.add_argument("--num-teacher-refs", type=int, default=4)
    p.add_argument("--discriminator-steps", type=int, default=16)
    p.add_argument("--discriminator-lr", type=float, default=0.35)
    p.add_argument("--learning-rate", type=float, default=1e-6)
    p.add_argument("--reward-temperature", type=float, default=1.0)
    p.add_argument("--collapse-penalty", type=float, default=0.15)
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument("--max-completion-length", type=int, default=1024)
    p.add_argument("--max-steps", type=int, default=32)
    p.add_argument("--namespace", default="default")
    p.add_argument("--tenant", default="local")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--self-test", action="store_true")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    if args.self_test:
        try:
            env = _self_test()
            _emit(env)
            return 0 if env["ok"] else 5
        except Exception as e:
            _emit({"ok": False, "version": VERSION, "error": "self_test_failed", "detail": str(e)})
            return 5
    if not args.prompts:
        _build_argparser().print_usage(sys.stderr)
        return 2
    try:
        rows = load_rows(args.prompts)
    except Exception as e:
        _emit({"ok": False, "version": VERSION, "error": "prompts_parse_failed", "detail": str(e)})
        return 4
    if not rows:
        _emit({"ok": False, "version": VERSION, "error": "no_prompt_rows"})
        return 4
    cfg = GadConfig(
        num_rollouts=max(2, args.num_rollouts),
        num_teacher_refs=max(1, args.num_teacher_refs),
        discriminator_steps=max(1, args.discriminator_steps),
        discriminator_lr=args.discriminator_lr,
        learning_rate=args.learning_rate,
        reward_temperature=max(1e-6, args.reward_temperature),
        collapse_penalty=max(0.0, args.collapse_penalty),
        temperature=args.temperature,
        max_completion_length=max(1, args.max_completion_length),
        student_base=args.student_base or args.student or "Qwen/Qwen2.5-7B-Instruct",
    )
    if args.dry_run:
        _emit(dry_run(rows, cfg))
        return 0
    if not args.student or not args.out:
        _build_argparser().print_usage(sys.stderr)
        return 2
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        import peft  # noqa: F401
    except Exception as e:
        _emit({"ok": False, "version": VERSION, "error": "torch_not_available",
               "detail": str(e), "install_hint": "pip install torch transformers peft"})
        return 3
    try:
        meta = gad_train(cfg, rows, out_dir=args.out,
                         student_base=args.student_base or args.student,
                         max_steps=args.max_steps)
        meta.update({"ok": True, "mode": "train", "namespace": args.namespace, "tenant": args.tenant})
        with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=2, sort_keys=True)
        _emit(meta)
        return 0
    except Exception as e:
        _emit({"ok": False, "version": VERSION, "error": "trainer_failed", "detail": str(e)})
        return 3


if __name__ == "__main__":
    sys.exit(main())

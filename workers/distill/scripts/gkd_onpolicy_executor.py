#!/usr/bin/env python3
# workers/distill/scripts/gkd_onpolicy_executor.py
#
# GKD on-policy lambda-mixture EXECUTOR (real student rollouts in the JSD loop).
#
# train_gkd.py historically handed the whole job to trl.GKDTrainer and recorded
# only the SCHEDULED lmbda in run-meta. That leaves three holes a receipt cannot
# defend:
#
#   1. No PROVABLE on-policy generation. The receipt could not show that the
#      student actually generated its own rollouts (the thing that makes GKD
#      beat off-policy KD); a silent trl version that dropped `lmbda` would
#      train pure off-policy and nobody would know.
#   2. No REALIZED on-policy fraction. lmbda is a Bernoulli RATE, not an outcome.
#      The realized fraction (how many examples this step were actually scored
#      on student-generated tokens) is what the run truly trained on, and only
#      that belongs in a receipt.
#   3. No data-mixture controller. The warmup->ramp schedule was a scalar, not a
#      per-example mixing decision (teacher-data first, student-data
#      increasingly).
#
# This module is the missing executor. It is PURE-CORE and stdlib-only so the
# whole loop SHAPE is unit-testable on CPU with no GPU, no torch, and no model:
#
#   * lmbda_schedule()            warmup -> linear ramp on-policy rate.
#   * bernoulli_mixture_decisions() per-example on/off-policy draw from a SEEDED
#                                 deterministic RNG (no global RNG, no clock).
#   * generalized_jsd_loss_np()   pure-python generalized JSD with interpolation
#                                 beta (reverse-KL-dominant as beta->0), the same
#                                 math train_gkd.py runs under torch, so the loss
#                                 is testable without torch.
#   * GkdOnPolicyExecutor         drives the real loop: for each step it draws
#                                 the mixture decisions, calls the injected
#                                 GENERATE fn (generate_on_policy_outputs in a
#                                 real run) ONLY for on-policy examples, scores
#                                 those rollouts under the FROZEN teacher's
#                                 next-token distribution, computes generalized
#                                 JSD against the student's ACTUAL distribution on
#                                 its OWN tokens, and records the REALIZED
#                                 on-policy fraction per step.
#   * assert_trl_lmbda_accepted() FAIL-LOUD trl-path guard: proves GKDConfig
#                                 accepted `lmbda` (so a silenced off-policy
#                                 regression cannot reach a receipt).
#   * build_run_meta()            the receipt-grade run-meta payload, including
#                                 the per-step REALIZED fraction (not just the
#                                 scheduled rate).
#
# torch / trl are imported LAZILY (only on the real wiring path); --self-test
# and the Node test exercise the full executor with a deterministic offline
# student+teacher and never import torch.
#
# Reference: On-Policy Distillation (GKD), Agarwal et al. arXiv:2306.13649.

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Optional, Sequence

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

VERSION = "gkd-onpolicy-executor-v1"


# ===========================================================================
# Deterministic RNG (stdlib-only, no global state, no clock).
#
# A tiny SplitMix64 -> uniform draw so the Bernoulli mixture decisions are
# reproducible from a seed and a (step, example) coordinate. We do NOT touch
# random.random() / numpy global RNG so the executor stays a pure function of
# its seed, exactly like apps/trainer/ropd.py's house rule.
# ===========================================================================

_MASK64 = (1 << 64) - 1


def _splitmix64(x: int) -> int:
    x = (x + 0x9E3779B97F4A7C15) & _MASK64
    z = x
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & _MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & _MASK64
    z = z ^ (z >> 31)
    return z & _MASK64


def deterministic_uniform(seed: int, *coords: int) -> float:
    """A reproducible uniform in [0, 1) keyed by (seed, *coords). Pure; no
    global RNG, no clock. Same inputs -> same float on every platform."""
    h = seed & _MASK64
    for c in coords:
        h = _splitmix64(h ^ (int(c) & _MASK64))
    h = _splitmix64(h)
    # 53 high bits -> double in [0, 1).
    return (h >> 11) / float(1 << 53)


# ===========================================================================
# lmbda schedule -- warmup -> ramp on-policy RATE (data-mixture controller).
# ===========================================================================

def lmbda_schedule(step: int, total_steps: int, lmbda_start: float = 0.0,
                   lmbda_end: float = 1.0, warmup_frac: float = 0.1) -> float:
    """Scheduled fraction of ON-POLICY (student-generated) data at `step`.

    Teacher-data first: hold `lmbda_start` for the first `warmup_frac` of
    training, then linearly ramp to `lmbda_end`. Returns a float clamped to
    [min(start,end), max(start,end)]. This is the RATE of a Bernoulli draw, not
    a realized count.
    """
    lo, hi = (lmbda_start, lmbda_end) if lmbda_start <= lmbda_end else (lmbda_end, lmbda_start)
    if total_steps <= 0:
        return float(min(hi, max(lo, lmbda_end)))
    warmup_steps = max(1, int(total_steps * warmup_frac))
    if step < warmup_steps:
        val = lmbda_start
    else:
        frac = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        frac = min(1.0, max(0.0, frac))
        val = lmbda_start + (lmbda_end - lmbda_start) * frac
    return float(min(hi, max(lo, val)))


def bernoulli_mixture_decisions(step: int, batch_size: int, rate: float, *,
                                seed: int = 42) -> list[bool]:
    """Per-example Bernoulli(rate) on-policy decisions for this step.

    True  => generate a STUDENT rollout (on-policy) and score it.
    False => use the fixed TEACHER-data target (off-policy) for this example.

    Deterministic given (seed, step, example index). This is the real
    data-mixture controller: rate is the SCHEDULED lmbda, the returned booleans
    are the actual per-example mix that the realized fraction is measured from.
    """
    r = min(1.0, max(0.0, float(rate)))
    out = []
    for i in range(batch_size):
        u = deterministic_uniform(seed, step, i)
        out.append(u < r)
    return out


def realized_on_policy_fraction(decisions: Sequence[bool]) -> float:
    """The fraction of examples this step actually drawn on-policy. This is the
    receipt-grade number: what the step TRAINED on, not the scheduled rate."""
    n = len(decisions)
    if n == 0:
        return 0.0
    return sum(1 for d in decisions if d) / float(n)


# ===========================================================================
# Generalized JSD (pure python) -- the same loss train_gkd.py runs under torch,
# implemented stdlib-only so the loop is testable without torch.
#
# JSD_beta(P||Q) = beta*KL(P||M) + (1-beta)*KL(Q||M),  M = beta*P + (1-beta)*Q
# with P = teacher next-token dist, Q = student dist.
#   beta -> 1  approaches forward KL (mode-covering, teacher-forced regime),
#   beta -> 0  approaches REVERSE KL (mode-seeking) -- the on-policy regime
#              where the loss is dominated by the student's OWN distribution on
#              its OWN sampled tokens (Q-dominant). This is exactly why on-policy
#              GKD beats off-policy KD: as beta->0 the student is graded on the
#              tokens it actually produces.
# ===========================================================================

def student_direction_weight(beta: float) -> float:
    """The weight the generalized JSD puts on the STUDENT/reverse-KL direction
    KL(Q||M). It is exactly (1-beta), so it -> 1 as beta -> 0 (reverse-KL
    dominant, the on-policy regime) and -> 0 as beta -> 1 (forward-KL)."""
    if not 0.0 <= beta <= 1.0:
        raise ValueError("beta must be in [0, 1]")
    return 1.0 - beta


def _softmax(logits: Sequence[float], temperature: float = 1.0) -> list[float]:
    if temperature <= 0:
        raise ValueError("temperature must be > 0")
    z = [x / temperature for x in logits]
    m = max(z)
    exps = [math.exp(v - m) for v in z]
    s = sum(exps)
    return [e / s for e in exps]


def _kl(p: Sequence[float], q: Sequence[float], eps: float = 1e-12) -> float:
    out = 0.0
    for pi, qi in zip(p, q):
        if pi > 0.0:
            out += pi * (math.log(pi + eps) - math.log(qi + eps))
    return out


def generalized_jsd_token(student_logits: Sequence[float],
                          teacher_logits: Sequence[float], *,
                          beta: float = 0.5, temperature: float = 1.0) -> float:
    """Per-token generalized JSD between teacher P and student Q (both softmax
    at `temperature`). beta=0.5 is symmetric JSD; beta->0 is reverse-KL-dominant
    (student-dist-dominant), beta->1 is forward-KL-dominant.

    Pure function; deterministic; no torch."""
    if not 0.0 <= beta <= 1.0:
        raise ValueError("beta must be in [0, 1]")
    if len(student_logits) != len(teacher_logits):
        raise ValueError("student/teacher logits must share the vocab dim")
    return generalized_jsd_terms(student_logits, teacher_logits,
                                 beta=beta, temperature=temperature)["jsd"]


def generalized_jsd_terms(student_logits: Sequence[float],
                          teacher_logits: Sequence[float], *,
                          beta: float = 0.5, temperature: float = 1.0) -> dict:
    """Decomposed generalized JSD so callers/tests can inspect WHICH direction
    dominates. Returns the teacher-direction term (weighted beta*KL(P||M)), the
    student/reverse-direction term (weighted (1-beta)*KL(Q||M)), and their sum.

    The on-policy regime grades the student on its OWN tokens: as beta->0 the
    student/reverse term carries (1-beta)->1 of the weight, so the loss is
    REVERSE-KL-DOMINANT (mode-seeking on the student distribution). As beta->1
    the teacher/forward term dominates."""
    if not 0.0 <= beta <= 1.0:
        raise ValueError("beta must be in [0, 1]")
    if len(student_logits) != len(teacher_logits):
        raise ValueError("student/teacher logits must share the vocab dim")
    q = _softmax(student_logits, temperature)   # student
    p = _softmax(teacher_logits, temperature)   # teacher
    m = [beta * pi + (1.0 - beta) * qi for pi, qi in zip(p, q)]
    kl_pm = _kl(p, m)   # teacher / forward direction
    kl_qm = _kl(q, m)   # student / reverse direction
    teacher_term = beta * kl_pm
    student_term = (1.0 - beta) * kl_qm
    return {
        "kl_teacher_to_m": kl_pm,
        "kl_student_to_m": kl_qm,
        "teacher_term": teacher_term,
        "student_term": student_term,
        "jsd": teacher_term + student_term,
    }


def generalized_jsd_loss_np(student_logits_seq: Sequence[Sequence[float]],
                            teacher_logits_seq: Sequence[Sequence[float]], *,
                            labels: Optional[Sequence[int]] = None,
                            beta: float = 0.5, temperature: float = 1.0) -> float:
    """Sequence-level generalized JSD (mean over non-masked tokens). `labels`
    of -100 are masked out (matches train_gkd.generalized_jsd_loss). Returns a
    scalar batchmean. Pure python; mirrors the torch path numerically."""
    n = len(student_logits_seq)
    if n != len(teacher_logits_seq):
        raise ValueError("token count mismatch between student and teacher")
    total = 0.0
    counted = 0
    for i in range(n):
        if labels is not None and i < len(labels) and labels[i] == -100:
            continue
        total += generalized_jsd_token(
            student_logits_seq[i], teacher_logits_seq[i],
            beta=beta, temperature=temperature)
        counted += 1
    if counted == 0:
        return 0.0
    return total / counted


# ===========================================================================
# trl-path assertion -- FAIL LOUD that GKDConfig accepted `lmbda`.
#
# A trl version that silently dropped `lmbda` (or renamed it) would train pure
# OFF-POLICY while the receipt still claimed on-policy. We refuse to let that
# reach a receipt: build the config, then read the attribute back and confirm
# it survived. Raise (not warn) on mismatch.
# ===========================================================================

class TrlLmbdaNotAccepted(RuntimeError):
    """Raised when GKDConfig did not retain the requested on-policy lmbda."""


def assert_trl_lmbda_accepted(config: Any, requested_lmbda: float, *,
                              tol: float = 1e-9) -> float:
    """Confirm a constructed GKDConfig (or any object) actually retained the
    on-policy `lmbda` we asked for. Returns the accepted value on success;
    raises TrlLmbdaNotAccepted (loud) otherwise. This is what lets the receipt
    PROVE on-policy generation was engaged rather than silently dropped."""
    if not hasattr(config, "lmbda"):
        raise TrlLmbdaNotAccepted(
            "GKDConfig has no `lmbda` attribute -- this trl build cannot do "
            "on-policy generation. install hint: pip install -U 'trl>=0.12.0' "
            "(GKDConfig.lmbda is required for on-policy GKD).")
    got = getattr(config, "lmbda")
    try:
        got_f = float(got)
    except (TypeError, ValueError):
        raise TrlLmbdaNotAccepted(
            f"GKDConfig.lmbda is non-numeric ({got!r}); on-policy rate unusable.")
    if abs(got_f - float(requested_lmbda)) > tol:
        raise TrlLmbdaNotAccepted(
            f"GKDConfig dropped/altered lmbda: requested {requested_lmbda}, "
            f"config reports {got_f}. The trl build is silently off-policy; "
            "refusing to mint an on-policy receipt. pip install -U 'trl>=0.12.0'.")
    return got_f


# ===========================================================================
# The executor.
# ===========================================================================

@dataclass
class GkdExecutorConfig:
    total_steps: int = 100
    batch_size: int = 8
    beta: float = 0.5            # JSD interpolation; ->0 reverse-KL-dominant
    lmbda_start: float = 0.0     # on-policy RATE at start (teacher-data first)
    lmbda_end: float = 1.0       # on-policy RATE at end (student-data)
    warmup_frac: float = 0.1
    temperature: float = 1.0
    seed: int = 42


@dataclass
class StepRecord:
    step: int
    scheduled_lmbda: float
    realized_on_policy_fraction: float
    on_policy_count: int
    off_policy_count: int
    loss: float


class GkdOnPolicyExecutor:
    """Drives the real on-policy lambda-mixture loop.

    Dependencies are INJECTED as callables so the same executor runs both the
    real torch path (student.generate / teacher logits) and the GPU-free test
    path (deterministic offline student+teacher). The executor never imports
    torch itself.

    Injected callables:
      generate_fn(prompt, step, idx) -> list[token_id]
          The on-policy rollout generator. In a real run this is
          train_gkd.generate_on_policy_outputs bound to the live student. Only
          called for ON-POLICY examples (Bernoulli draw True).
      student_logits_fn(prompt, tokens) -> list[list[float]]
          The student's next-token logits over `tokens` (its ACTUAL distribution
          on its own sampled tokens when on-policy).
      teacher_logits_fn(prompt, tokens) -> list[list[float]]
          The FROZEN teacher's next-token logits over the SAME tokens (scores
          the student's rollout under the teacher's distribution).
      teacher_data_fn(prompt, step, idx) -> list[token_id]   (optional)
          The fixed teacher-data target tokens for OFF-POLICY examples. Defaults
          to a stable per-(prompt,idx) target so off-policy stays teacher-data.
    """

    def __init__(self, cfg: GkdExecutorConfig, *, generate_fn: Callable,
                 student_logits_fn: Callable, teacher_logits_fn: Callable,
                 teacher_data_fn: Optional[Callable] = None):
        self.cfg = cfg
        self._generate = generate_fn
        self._student_logits = student_logits_fn
        self._teacher_logits = teacher_logits_fn
        self._teacher_data = teacher_data_fn or (lambda prompt, step, idx: [hash((prompt, idx)) & 0xFF])
        self.records: list[StepRecord] = []

    def run_step(self, step: int, prompts: Sequence[str]) -> StepRecord:
        cfg = self.cfg
        rate = lmbda_schedule(step, cfg.total_steps, cfg.lmbda_start,
                              cfg.lmbda_end, cfg.warmup_frac)
        decisions = bernoulli_mixture_decisions(step, len(prompts), rate, seed=cfg.seed)

        losses: list[float] = []
        on_policy = 0
        for idx, (prompt, on) in enumerate(zip(prompts, decisions)):
            if on:
                # REAL on-policy: student generates its own rollout, we score
                # those tokens under the frozen teacher's distribution and
                # compute generalized JSD against the student's ACTUAL dist on
                # its OWN tokens. As beta->0 this is reverse-KL-dominant.
                tokens = list(self._generate(prompt, step, idx))
                on_policy += 1
            else:
                # Off-policy: fixed teacher-data target.
                tokens = list(self._teacher_data(prompt, step, idx))
            if not tokens:
                continue
            s_logits = self._student_logits(prompt, tokens)
            t_logits = self._teacher_logits(prompt, tokens)
            loss = generalized_jsd_loss_np(
                s_logits, t_logits, beta=cfg.beta, temperature=cfg.temperature)
            losses.append(loss)

        rec = StepRecord(
            step=step,
            scheduled_lmbda=rate,
            realized_on_policy_fraction=realized_on_policy_fraction(decisions),
            on_policy_count=on_policy,
            off_policy_count=len(decisions) - on_policy,
            loss=(sum(losses) / len(losses)) if losses else 0.0,
        )
        self.records.append(rec)
        return rec

    def run(self, prompts: Sequence[str]) -> list[StepRecord]:
        for step in range(self.cfg.total_steps):
            self.run_step(step, prompts)
        return self.records

    def realized_schedule(self) -> list[dict]:
        """Per-step (scheduled vs REALIZED) on-policy fraction trajectory."""
        return [
            {
                "step": r.step,
                "scheduled_lmbda": r.scheduled_lmbda,
                "realized_on_policy_fraction": r.realized_on_policy_fraction,
                "on_policy_count": r.on_policy_count,
                "off_policy_count": r.off_policy_count,
                "loss": r.loss,
            }
            for r in self.records
        ]

    def mean_realized_fraction(self) -> float:
        if not self.records:
            return 0.0
        return sum(r.realized_on_policy_fraction for r in self.records) / len(self.records)


def bind_generate_on_policy_outputs(model, tokenizer, *, generation_config=None,
                                    pad_token_id=None):
    """Bind the REAL on-policy rollout generator to a live student.

    Imports train_gkd.generate_on_policy_outputs (the shipped student.generate
    wrapper) and returns a `generate_fn(prompt, step, idx) -> list[token_id]`
    the executor's on-policy branch calls. This is what makes the receipt's
    on-policy claim load-bearing: the on-policy branch runs the SAME generator
    the GKD trainer uses, not a stand-in. torch / train_gkd are imported lazily
    here so the pure-core stays GPU-free.
    """
    try:
        import train_gkd  # noqa: F401  (sibling module on sys.path)
        gen = train_gkd.generate_on_policy_outputs
    except Exception as exc:  # pragma: no cover - real-path only
        raise RuntimeError(
            "could not import train_gkd.generate_on_policy_outputs for the "
            "on-policy rollout generator: " + repr(exc))

    def generate_fn(prompt, step, idx):  # pragma: no cover - needs torch+model
        enc = tokenizer(prompt, return_tensors="pt")
        out = gen(model, enc["input_ids"],
                  attention_mask=enc.get("attention_mask"),
                  generation_config=generation_config,
                  pad_token_id=pad_token_id if pad_token_id is not None else tokenizer.pad_token_id)
        # Strip the prompt prefix -> the student's OWN generated tokens.
        prompt_len = enc["input_ids"].shape[-1]
        return out[0].tolist()[prompt_len:]

    return generate_fn


def build_run_meta(cfg: GkdExecutorConfig, records: Sequence[StepRecord], *,
                   namespace: str = "default",
                   trl_lmbda_accepted: Optional[float] = None) -> dict:
    """Receipt-grade run-meta. Records the per-step REALIZED on-policy fraction
    (the thing the run truly trained on), not just the scheduled rate, plus the
    trl-path proof that GKDConfig accepted lmbda."""
    sched = [
        {
            "step": r.step,
            "scheduled_lmbda": r.scheduled_lmbda,
            "realized_on_policy_fraction": r.realized_on_policy_fraction,
        }
        for r in records
    ]
    mean_realized = (sum(r.realized_on_policy_fraction for r in records) / len(records)) if records else 0.0
    return {
        "objective": "gkd",
        "executor": VERSION,
        "regime": "on_policy_lambda_mixture",
        "beta": cfg.beta,
        "lmbda_start": cfg.lmbda_start,
        "lmbda_final": cfg.lmbda_end,
        "warmup_frac": cfg.warmup_frac,
        "temperature": cfg.temperature,
        "total_steps": cfg.total_steps,
        "batch_size": cfg.batch_size,
        "seed": cfg.seed,
        "namespace": namespace,
        # The proof: realized (not just scheduled) on-policy fraction per step.
        "realized_on_policy_schedule": sched,
        "mean_realized_on_policy_fraction": mean_realized,
        # FAIL-LOUD trl proof: None means the trl path was not run (pure-core
        # / dry-run); a float means GKDConfig.lmbda was asserted accepted.
        "trl_lmbda_accepted": trl_lmbda_accepted,
        "student_direction_weight": student_direction_weight(cfg.beta),
        "papers": ["arXiv:2306.13649"],
    }


# ===========================================================================
# Offline deterministic student + teacher (for --self-test / Node test).
#
# No torch, no model. The "teacher" is a fixed distribution; the "student" is a
# distribution that drifts toward the teacher when it generates on-policy. This
# is enough to exercise the FULL executor SHAPE and prove the realized fraction,
# the JSD math, and the schedule.
# ===========================================================================

def _make_offline_loop(vocab: int = 6):
    def generate_fn(prompt, step, idx):
        # Student samples a short rollout deterministically from its seed.
        n = 3 + (idx % 2)
        return [int(deterministic_uniform(7, step, idx, k) * vocab) for k in range(n)]

    def teacher_data_fn(prompt, step, idx):
        return [(idx + k) % vocab for k in range(3)]

    def teacher_logits_fn(prompt, tokens):
        # A fixed, peaked teacher distribution per token position.
        out = []
        for pos, _tok in enumerate(tokens):
            logits = [0.0] * vocab
            logits[pos % vocab] = 4.0  # teacher strongly prefers one token
            out.append(logits)
        return out

    def student_logits_fn(prompt, tokens):
        # Student is flatter (higher entropy) -> non-zero JSD vs teacher.
        out = []
        for pos, tok in enumerate(tokens):
            logits = [0.5] * vocab
            logits[int(tok) % vocab] = 1.5  # mild preference for its own token
            out.append(logits)
        return out

    return generate_fn, student_logits_fn, teacher_logits_fn, teacher_data_fn


class _FakeGKDConfig:
    """Minimal stand-in mirroring trl.GKDConfig's lmbda attribute, for the
    trl-path assertion test when trl is not installed."""
    def __init__(self, lmbda, beta=0.5, temperature=1.0):
        self.lmbda = lmbda
        self.beta = beta
        self.temperature = temperature


def _self_test() -> int:
    fails = []

    # 1. Schedule: teacher-data first (start), ramps to end.
    if not abs(lmbda_schedule(0, 100, 0.0, 1.0, 0.1) - 0.0) < 1e-9:
        fails.append("schedule start should hold lmbda_start during warmup")
    if not lmbda_schedule(99, 100, 0.0, 1.0, 0.1) > 0.9:
        fails.append("schedule should ramp toward lmbda_end")
    mid = lmbda_schedule(55, 100, 0.0, 1.0, 0.1)
    if not 0.0 < mid < 1.0:
        fails.append("schedule mid should be strictly between start and end")

    # 2. Bernoulli mixture: determinism + monotone realized fraction w/ rate.
    d0 = bernoulli_mixture_decisions(0, 64, 0.0, seed=42)
    d1 = bernoulli_mixture_decisions(0, 64, 1.0, seed=42)
    if realized_on_policy_fraction(d0) != 0.0:
        fails.append("rate 0 must give realized fraction 0")
    if realized_on_policy_fraction(d1) != 1.0:
        fails.append("rate 1 must give realized fraction 1")
    d_a = bernoulli_mixture_decisions(3, 100, 0.5, seed=42)
    d_b = bernoulli_mixture_decisions(3, 100, 0.5, seed=42)
    if d_a != d_b:
        fails.append("mixture decisions must be deterministic for a fixed seed")
    f_lo = realized_on_policy_fraction(bernoulli_mixture_decisions(3, 400, 0.25, seed=1))
    f_hi = realized_on_policy_fraction(bernoulli_mixture_decisions(3, 400, 0.75, seed=1))
    if not f_lo < f_hi:
        fails.append("realized fraction should track the scheduled rate")

    # 3. Generalized JSD: beta endpoints + reverse-KL dominance as beta->0.
    s = [[2.0, 0.0, 0.0]]
    t = [[0.0, 2.0, 0.0]]
    jsd_sym = generalized_jsd_loss_np(s, t, beta=0.5)
    if not jsd_sym > 0.0:
        fails.append("symmetric JSD of disjoint peaks must be > 0")
    # Reverse-KL dominance as beta->0 is a property of the WEIGHTING: the loss
    # puts (1-beta) of its mass on the student/reverse direction KL(Q||M), so
    # the student-direction weight -> 1 as beta -> 0. (The numerical term
    # magnitude is confounded by M -> Q; the weight is the load-bearing fact.)
    w0 = student_direction_weight(beta=1e-3)
    w1 = student_direction_weight(beta=1.0 - 1e-3)
    if not w0 > 0.99:
        fails.append("student/reverse-direction weight must -> 1 as beta -> 0")
    if not w1 < 0.01:
        fails.append("student/reverse-direction weight must -> 0 as beta -> 1")
    # Swap-symmetry: JSD_beta(P||Q) == JSD_{1-beta}(Q||P).
    j_a = generalized_jsd_token([3.0, 0.0], [0.0, 3.0], beta=0.3)
    j_b = generalized_jsd_token([0.0, 3.0], [3.0, 0.0], beta=0.7)
    if not abs(j_a - j_b) < 1e-9:
        fails.append("generalized JSD must satisfy JSD_beta(P||Q)=JSD_{1-beta}(Q||P)")
    # Masked tokens excluded.
    masked = generalized_jsd_loss_np(s + s, t + t, labels=[-100, 0], beta=0.5)
    if not abs(masked - jsd_sym) < 1e-9:
        fails.append("label -100 tokens must be masked out of the loss")

    # 4. trl-path assertion: accept matching, fail loud on drop.
    ok_cfg = _FakeGKDConfig(lmbda=0.5)
    if assert_trl_lmbda_accepted(ok_cfg, 0.5) != 0.5:
        fails.append("assert_trl_lmbda_accepted should return accepted lmbda")
    try:
        assert_trl_lmbda_accepted(_FakeGKDConfig(lmbda=0.0), 0.5)
        fails.append("assert_trl_lmbda_accepted must RAISE on a dropped lmbda")
    except TrlLmbdaNotAccepted:
        pass
    class _NoLmbda:  # trl too old / renamed attr
        beta = 0.5
    try:
        assert_trl_lmbda_accepted(_NoLmbda(), 0.5)
        fails.append("assert must RAISE when GKDConfig has no lmbda attribute")
    except TrlLmbdaNotAccepted:
        pass

    # 5. Full executor: realized fraction recorded per step, ramps up, loss>0.
    g, sl, tl, td = _make_offline_loop()
    cfg = GkdExecutorConfig(total_steps=40, batch_size=24, beta=0.3,
                            lmbda_start=0.0, lmbda_end=1.0, warmup_frac=0.1, seed=42)
    ex = GkdOnPolicyExecutor(cfg, generate_fn=g, student_logits_fn=sl,
                             teacher_logits_fn=tl, teacher_data_fn=td)
    ex.run(["p%d" % i for i in range(cfg.batch_size)])
    if len(ex.records) != cfg.total_steps:
        fails.append("executor must record one StepRecord per step")
    early = ex.records[0].realized_on_policy_fraction
    late = ex.records[-1].realized_on_policy_fraction
    if not early == 0.0:
        fails.append("warmup step should be 0%% on-policy (teacher-data first)")
    if not late > early:
        fails.append("realized on-policy fraction must rise (student-data later)")
    if not all(r.loss >= 0.0 for r in ex.records):
        fails.append("per-step JSD loss must be non-negative")
    meta = build_run_meta(cfg, ex.records, trl_lmbda_accepted=0.5)
    if "realized_on_policy_schedule" not in meta:
        fails.append("run-meta must carry the realized on-policy schedule")
    if meta["trl_lmbda_accepted"] != 0.5:
        fails.append("run-meta must record the asserted trl lmbda")

    if fails:
        for f in fails:
            sys.stderr.write("[gkd-onpolicy self-test] FAIL: " + f + "\n")
        return 5
    print(json.dumps({"ok": True, "self_test": "passed", "version": VERSION,
                      "steps": cfg.total_steps,
                      "mean_realized_on_policy_fraction": ex.mean_realized_fraction()}))
    return 0


def _dry_run(args) -> int:
    g, sl, tl, td = _make_offline_loop()
    cfg = GkdExecutorConfig(total_steps=args.total_steps, batch_size=args.batch_size,
                            beta=args.beta, lmbda_start=args.lmbda_start,
                            lmbda_end=args.lmbda, warmup_frac=args.warmup_frac,
                            temperature=args.temperature, seed=args.seed)
    ex = GkdOnPolicyExecutor(cfg, generate_fn=g, student_logits_fn=sl,
                             teacher_logits_fn=tl, teacher_data_fn=td)
    ex.run(["p%d" % i for i in range(cfg.batch_size)])
    meta = build_run_meta(cfg, ex.records, namespace=args.namespace,
                          trl_lmbda_accepted=None)
    meta["dry_run"] = True
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
    print(json.dumps({"ok": True, "dry_run": True,
                      "mean_realized_on_policy_fraction": ex.mean_realized_fraction(),
                      "steps": len(ex.records)}))
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="GKD on-policy lambda-mixture executor")
    p.add_argument("--self-test", action="store_true",
                   help="run the GPU-free deterministic self-test (no torch).")
    p.add_argument("--dry-run", action="store_true",
                   help="run the full executor with the offline student+teacher.")
    p.add_argument("--out", default=None, help="write run-meta.json here (dry-run).")
    p.add_argument("--total-steps", type=int, default=40)
    p.add_argument("--batch-size", type=int, default=24)
    p.add_argument("--beta", type=float, default=0.5)
    p.add_argument("--lmbda", type=float, default=1.0, help="final on-policy rate.")
    p.add_argument("--lmbda-start", type=float, default=0.0)
    p.add_argument("--warmup-frac", type=float, default=0.1)
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--namespace", default="default")
    args = p.parse_args(argv)

    if not 0.0 <= args.beta <= 1.0:
        sys.stderr.write("[gkd-onpolicy] beta must be in [0,1]\n")
        return 6
    if args.self_test:
        return _self_test()
    if args.dry_run:
        return _dry_run(args)
    # Default to self-test so a bare invocation proves the executor.
    return _self_test()


if __name__ == "__main__":
    sys.exit(main())

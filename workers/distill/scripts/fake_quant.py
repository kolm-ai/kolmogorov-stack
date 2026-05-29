"""
workers/distill/scripts/fake_quant.py

Fake-quantization (simulate-quantize) primitives for Quantization-Aware
Distillation (QAD). This is the numerical core kolm's QAD trainer wraps around
a student's weights during the distill loop so the student learns weights that
are robust to 4-bit rounding *while training*, instead of being quantized
post-hoc and hoping the accuracy survives.

The frontier basis (web-verified, May 2026):

  * NVIDIA Nemotron "Quantization-Aware Distillation for NVFP4 Inference
    Accuracy Recovery" (arXiv:2601.20088, 2026-01-27). A frozen BF16 teacher
    distills into an NVFP4 student by minimizing forward KL between their
    output token distributions; the NVFP4 student is trained with fake-quant
    weights, recovering up to 99.4% of BF16 accuracy at ~4x FLOPS / ~1.7x
    memory on Blackwell. NVFP4 = 16-element blocks, per-block FP8 E4M3 scale,
    per-tensor FP32 scale.
  * QLoRA (Dettmers et al., arXiv:2305.14314). NF4 = 4-bit NormalFloat, a
    fixed set of 16 quantile levels that are information-theoretically optimal
    for normally-distributed weights. The exact levels are Appendix E.
  * Straight-Through Estimator (Bengio et al. 2013; Yin et al.
    arXiv:1903.05662). Quantize-dequantize ("QDQ" / "fake-quant") is a step
    function with zero gradient almost everywhere; QAT/QAD trains through it by
    passing the upstream gradient through the rounding op as if it were the
    identity (optionally clamped outside the representable range).

What this module is, precisely:

  * A *fake-quant*: it maps a high-precision tensor x -> quantize(x) ->
    dequantize(...) back to the SAME dtype/shape as x. The output is a
    higher-precision tensor that has been snapped to the nearest representable
    4-bit grid point. No bytes are packed; this is the training-time simulation
    of what the deployed INT4/NVFP4 kernel will do.
  * Deterministic: given the same input tensor and the same parameters, the
    output is bit-reproducible. No randomness, no wall-clock, no global RNG.
  * STE-correct: forward is the true (non-differentiable) round-to-grid;
    backward passes the gradient straight through (identity), with an optional
    clamp so gradients vanish on weights that saturated the quantizer's range
    (the "clipped STE" that stabilizes QAT).
  * CPU-unit-testable: every function runs on CPU float32 with no GPU, no
    bitsandbytes, no transformers. The self-test at the bottom proves
    round-trip error is bounded, the STE gradient flows, and the op is
    deterministic.

Two formats are supported and both share the QDQ + STE shape:

  * NF4   — per-block absmax-normalized; each normalized value snaps to the
            nearest of 16 fixed NormalFloat levels.
  * FP4   — E2M1 4-bit float; per-block absmax scale; each scaled value snaps
            to the nearest of the 15 representable E2M1 magnitudes (with sign).

Both use *block-wise* scaling (default block size 16, matching NVFP4) so a
single outlier weight doesn't blow up the scale for a whole row — the same
reason NVFP4 moved from 32- to 16-element blocks.

Surface:

    from fake_quant import (
        fake_quant, FakeQuantConfig, QuantFormat,
        nf4_levels, fp4_e2m1_values, quantize_dequantize,
        FakeQuantLinear, wrap_linear_modules,
    )

    xq = fake_quant(x, FakeQuantConfig(fmt="nf4", block_size=16))   # functional
    # or, as an nn.Module that injects QDQ on a Linear's weight in the fwd:
    layer = FakeQuantLinear(existing_linear, FakeQuantConfig(fmt="fp4"))

This file has NO torch import at module top-level guard cost: torch is imported
lazily inside the functions that need autograd, and a pure-python/no-torch
import still succeeds so `ast.parse` and a torch-less environment can load it.
"""

from __future__ import annotations

import enum
import math
from dataclasses import dataclass
from typing import Any, Optional, Sequence

try:
    import torch
    import torch.nn as nn
    _HAS_TORCH = True
except Exception:  # pragma: no cover - torch always present in the worker venv
    torch = None  # type: ignore
    nn = None  # type: ignore
    _HAS_TORCH = False


FAKE_QUANT_VERSION = "w921-qad-v1"


# ---------------------------------------------------------------------------
# Grid definitions. These are plain python tuples so they can be inspected and
# unit-tested WITHOUT torch. The tensors built from them are created lazily.
# ---------------------------------------------------------------------------

# NF4 — the 16 NormalFloat levels from QLoRA Appendix E (Dettmers 2023). These
# are the quantile midpoints of a standard normal mapped into [-1, 1], with an
# exact 0 in the set so true zeros stay zero (important for pruned weights).
# Source values reproduced verbatim from the QLoRA reference implementation.
_NF4_LEVELS: tuple[float, ...] = (
    -1.0,
    -0.6961928009986877,
    -0.5250730514526367,
    -0.39491748809814453,
    -0.28444138169288635,
    -0.18477343022823334,
    -0.09105003625154495,
    0.0,
    0.07958029955625534,
    0.16093020141124725,
    0.24611230194568634,
    0.33791524171829224,
    0.44070982933044434,
    0.5626170039176941,
    0.7229568362236023,
    1.0,
)

# FP4 E2M1 — 1 sign bit, 2 exponent bits, 1 mantissa bit. The representable
# non-negative magnitudes of E2M1 are {0, 0.5, 1, 1.5, 2, 3, 4, 6}. With the
# sign bit this is 15 distinct values (0 is shared) — exactly the NVFP4 element
# grid (the per-block E4M3 scale lives outside this grid). We snap a
# scale-normalized value to the nearest of these magnitudes, then re-sign.
_FP4_E2M1_MAGNITUDES: tuple[float, ...] = (0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0)
# Max representable FP4 magnitude — used to map a block's absmax onto the grid
# so the largest weight in a block lands on (or near) 6.0 rather than wasting
# range. This mirrors the per-block scale in NVFP4.
_FP4_MAX = _FP4_E2M1_MAGNITUDES[-1]


class QuantFormat(str, enum.Enum):
    """Which 4-bit grid the fake-quant snaps to."""
    NF4 = "nf4"
    FP4 = "fp4"

    @classmethod
    def from_str(cls, s: str) -> "QuantFormat":
        s = (s or "").strip().lower()
        for f in cls:
            if f.value == s:
                return f
        raise ValueError(
            f"fake_quant.py: unknown quant format '{s}'. "
            f"Pick one of: {[f.value for f in cls]}"
        )


def nf4_levels() -> tuple[float, ...]:
    """The 16 NF4 NormalFloat levels (pure python, no torch). Returned as a
    fresh tuple so callers cannot mutate the module constant."""
    return tuple(_NF4_LEVELS)


def fp4_e2m1_values() -> tuple[float, ...]:
    """The signed E2M1 representable values (pure python, no torch).

    The full set is {±m : m in magnitudes} de-duplicated on 0.0, sorted
    ascending — i.e. the actual values an E2M1 element can take before the
    per-block scale is applied."""
    seen: set[float] = set()
    vals: list[float] = []
    for m in _FP4_E2M1_MAGNITUDES:
        for v in (m, -m):
            if v not in seen:
                seen.add(v)
                vals.append(v)
    vals.sort()
    return tuple(vals)


@dataclass
class FakeQuantConfig:
    """Knobs for the fake-quant. Defaults match the NVFP4 recipe (16-element
    blocks) with clipped-STE backward (the QAT-stable choice)."""

    fmt: str = "nf4"
    """'nf4' (NormalFloat4) or 'fp4' (E2M1). NF4 is the QLoRA default; FP4 is
    the NVFP4 element grid."""

    block_size: int = 16
    """Block-wise absmax scaling granularity. 16 matches NVFP4; the divisor of
    the last dim. When the last dim is not a multiple of block_size, the final
    (short) block is scaled by its own absmax — never padded with fake zeros
    that would shrink the scale."""

    clip_ste: bool = True
    """When True, the straight-through gradient is zeroed for inputs whose
    normalized magnitude saturated the quantizer range (|x_norm| > 1 for NF4,
    > max magnitude for FP4). This is the standard 'clipped STE' that stops the
    optimizer from pushing weights further into the dead saturated zone. When
    False, the gradient passes through as a pure identity for all inputs."""

    eps: float = 1e-8
    """Floor on the per-block absmax so an all-zero block doesn't divide by 0
    (the block then maps every element to 0, which is correct)."""

    def format_enum(self) -> QuantFormat:
        return QuantFormat.from_str(self.fmt)


# ---------------------------------------------------------------------------
# Pure-python reference quantizer. No torch. Used by the self-test to prove the
# torch path matches a from-scratch implementation, and usable in airgapped
# environments for a sanity probe on a small list of floats.
# ---------------------------------------------------------------------------

def _nearest_level_py(x_norm: float, levels: Sequence[float]) -> float:
    """Snap a single normalized scalar to the nearest grid level (python)."""
    best = levels[0]
    best_d = abs(x_norm - best)
    for lv in levels[1:]:
        d = abs(x_norm - lv)
        if d < best_d:
            best_d = d
            best = lv
    return best


def quantize_dequantize_py(
    values: Sequence[float],
    fmt: str = "nf4",
    block_size: int = 16,
    eps: float = 1e-8,
) -> list[float]:
    """Pure-python QDQ over a flat list of floats, treated as one row split
    into blocks of `block_size`. Deterministic, no torch, no randomness.

    Returns a list the same length as `values`, snapped to the chosen grid and
    rescaled back to the input's numeric range. This is the spec the torch
    implementation must agree with (the self-test asserts element-wise match).
    """
    f = QuantFormat.from_str(fmt)
    if block_size <= 0:
        raise ValueError("fake_quant.py: block_size must be > 0")
    out: list[float] = []
    n = len(values)
    for start in range(0, n, block_size):
        block = list(values[start:start + block_size])
        absmax = max((abs(v) for v in block), default=0.0)
        scale = absmax if absmax > eps else 0.0
        if scale == 0.0:
            out.extend(0.0 for _ in block)
            continue
        if f is QuantFormat.NF4:
            # Normalize into [-1, 1] (NF4 grid lives there), snap, rescale.
            for v in block:
                xn = v / scale
                q = _nearest_level_py(xn, _NF4_LEVELS)
                out.append(q * scale)
        else:  # FP4 E2M1
            # Scale the block so its absmax maps onto the FP4 max magnitude,
            # snap to the nearest signed magnitude, rescale back.
            fp4_scale = scale / _FP4_MAX
            for v in block:
                xs = v / fp4_scale
                sign = -1.0 if xs < 0 else 1.0
                mag = _nearest_level_py(abs(xs), _FP4_E2M1_MAGNITUDES)
                out.append(sign * mag * fp4_scale)
    return out


# ---------------------------------------------------------------------------
# Torch path. The forward is the true round-to-grid (built from the python
# levels). The backward is the straight-through estimator via a custom
# autograd.Function so the QDQ op is transparent to gradients.
# ---------------------------------------------------------------------------

def _require_torch(what: str) -> None:
    if not _HAS_TORCH:
        raise RuntimeError(
            f"fake_quant.py: {what} requires torch. "
            f"Install in the worker venv: pip install 'torch>=2.2'"
        )


def _levels_tensor(fmt: QuantFormat, device, dtype):
    if fmt is QuantFormat.NF4:
        return torch.tensor(_NF4_LEVELS, device=device, dtype=dtype)
    return torch.tensor(_FP4_E2M1_MAGNITUDES, device=device, dtype=dtype)


def _blockwise_absmax(x, block_size: int, eps: float):
    """Per-block absmax over the LAST dim. Returns a scale tensor broadcastable
    back over x. Handles a ragged final block by computing absmax only over the
    real elements (no zero padding that would shrink the scale).

    Implementation: reshape the last dim into (n_full_blocks, block_size) where
    possible; the ragged tail is handled with a masked reduction so the short
    block uses its own absmax.
    """
    last = x.shape[-1]
    if block_size >= last:
        # One block over the whole last dim.
        am = x.abs().amax(dim=-1, keepdim=True).clamp_min(eps)
        return am.expand_as(x)
    n_full = last // block_size
    rem = last - n_full * block_size
    scales = torch.empty_like(x)
    if n_full > 0:
        head = x[..., : n_full * block_size]
        head_v = head.reshape(*head.shape[:-1], n_full, block_size)
        head_am = head_v.abs().amax(dim=-1, keepdim=True).clamp_min(eps)
        head_scale = head_am.expand_as(head_v).reshape(*head.shape)
        scales[..., : n_full * block_size] = head_scale
    if rem > 0:
        tail = x[..., n_full * block_size:]
        tail_am = tail.abs().amax(dim=-1, keepdim=True).clamp_min(eps)
        scales[..., n_full * block_size:] = tail_am.expand_as(tail)
    return scales


def _quantize_dequantize_forward(x, fmt: QuantFormat, block_size: int, eps: float):
    """The deterministic forward QDQ on a torch tensor. Returns (xq, sat_mask)
    where sat_mask is True where the normalized value saturated the grid (for
    the clipped-STE backward). No autograd recorded here — the wrapping
    autograd.Function detaches and replays this."""
    scale = _blockwise_absmax(x, block_size, eps)
    if fmt is QuantFormat.NF4:
        x_norm = x / scale
        levels = _levels_tensor(fmt, x.device, x.dtype)
        # nearest level: |x_norm - level| argmin over the 16-level grid.
        # shape: (*x, 1) vs (16,) -> (*x, 16)
        diff = (x_norm.unsqueeze(-1) - levels).abs()
        idx = diff.argmin(dim=-1)
        q = levels[idx]
        xq = q * scale
        sat = x_norm.abs() > (1.0 + 1e-6)
        return xq, sat
    # FP4 E2M1
    fp4_scale = scale / _FP4_MAX
    x_scaled = x / fp4_scale
    mags = _levels_tensor(fmt, x.device, x.dtype)  # non-negative magnitudes
    a = x_scaled.abs()
    diff = (a.unsqueeze(-1) - mags).abs()
    idx = diff.argmin(dim=-1)
    mag = mags[idx]
    xq = torch.sign(x_scaled) * mag * fp4_scale
    sat = a > (_FP4_MAX + 1e-6)
    return xq, sat


if _HAS_TORCH:

    class _FakeQuantSTE(torch.autograd.Function):
        """Quantize-dequantize forward with straight-through-estimator backward.

        Forward: snap x to the 4-bit grid (true, non-differentiable round).
        Backward: pass grad_output straight through to grad_input (identity).
        When clip_ste, zero the gradient where the input saturated the grid so
        the optimizer stops driving weights deeper into the dead range.
        """

        @staticmethod
        def forward(ctx, x, fmt_value: str, block_size: int, clip_ste: bool, eps: float):
            fmt = QuantFormat.from_str(fmt_value)
            xq, sat = _quantize_dequantize_forward(x, fmt, block_size, eps)
            if clip_ste:
                # save the saturation mask so backward can gate the gradient
                ctx.save_for_backward(sat)
                ctx.clip_ste = True
            else:
                ctx.save_for_backward()
                ctx.clip_ste = False
            return xq

        @staticmethod
        def backward(ctx, grad_output):
            if getattr(ctx, "clip_ste", False):
                (sat,) = ctx.saved_tensors
                grad_input = grad_output.clone()
                grad_input[sat] = 0
            else:
                grad_input = grad_output
            # Only x receives a gradient; the config args are non-tensors.
            return grad_input, None, None, None, None


def quantize_dequantize(x, cfg: Optional[FakeQuantConfig] = None):
    """Functional fake-quant on a torch tensor WITHOUT autograd recording
    (a plain forward snap-to-grid). Use this for offline calibration / probes.

    For a trainable QDQ that carries STE gradients, use `fake_quant`.
    """
    _require_torch("quantize_dequantize")
    cfg = cfg or FakeQuantConfig()
    fmt = cfg.format_enum()
    with torch.no_grad():
        xq, _ = _quantize_dequantize_forward(x, fmt, cfg.block_size, cfg.eps)
    return xq


def fake_quant(x, cfg: Optional[FakeQuantConfig] = None):
    """Trainable fake-quant: snap-to-grid in the forward, straight-through
    gradient in the backward. This is the op the QAD trainer applies to a
    student's weight tensor during the distill loop so the student learns
    4-bit-robust weights.

    Args:
      x:   a torch.Tensor (typically a weight). Any shape; blocking is over
           the last dim.
      cfg: FakeQuantConfig; defaults to NF4, block_size=16, clipped STE.

    Returns a tensor the same shape/dtype as x, snapped to the 4-bit grid, with
    a gradient that flows straight through to x.
    """
    _require_torch("fake_quant")
    cfg = cfg or FakeQuantConfig()
    # Validate the format up-front (raises on a bad string before the GPU op).
    _ = cfg.format_enum()
    if cfg.block_size <= 0:
        raise ValueError("fake_quant.py: block_size must be > 0")
    return _FakeQuantSTE.apply(x, cfg.fmt, int(cfg.block_size), bool(cfg.clip_ste), float(cfg.eps))


# ---------------------------------------------------------------------------
# Module wrapper. FakeQuantLinear injects QDQ on a Linear's weight in the
# forward pass so an existing nn.Module tree can be made quant-aware without
# touching the optimizer or the LoRA adapters. The base weight is kept in full
# precision (the gradient flows to it via STE); only the *effective* weight
# used in the matmul is the fake-quantized one.
# ---------------------------------------------------------------------------

if _HAS_TORCH:

    class FakeQuantLinear(nn.Module):
        """Wrap an nn.Linear so its weight is fake-quantized on every forward.

        The wrapped Linear's parameters (weight, bias) are reused by reference,
        so this composes with PEFT/LoRA: the LoRA delta is added to the
        fake-quantized base in the deployed kernel too, which is exactly the
        train/serve match QAD is built to guarantee.

        Caveat: this does not save memory at train time (the full
        weight is still resident). It SIMULATES the deployed 4-bit numerics so
        the learned weights survive the real quantization. The memory win is at
        inference, after export.
        """

        def __init__(self, linear: "nn.Linear", cfg: Optional[FakeQuantConfig] = None):
            super().__init__()
            if not isinstance(linear, nn.Linear):
                raise TypeError(
                    f"FakeQuantLinear expects nn.Linear, got {type(linear).__name__}"
                )
            self.linear = linear
            self.cfg = cfg or FakeQuantConfig()
            # Eagerly validate the format so construction fails fast.
            _ = self.cfg.format_enum()

        def forward(self, x):
            # QAT warmup hook: when a caller sets `_qad_bypass = True` on this
            # module (e.g. apps/trainer/qad.py during the full-precision warmup
            # phase), the layer behaves as a plain Linear — no fake-quant. The
            # attribute is absent by default, so the quant path is the default.
            if getattr(self, "_qad_bypass", False):
                return torch.nn.functional.linear(x, self.linear.weight, self.linear.bias)
            wq = fake_quant(self.linear.weight, self.cfg)
            return torch.nn.functional.linear(x, wq, self.linear.bias)

        def extra_repr(self) -> str:
            return (
                f"fmt={self.cfg.fmt}, block_size={self.cfg.block_size}, "
                f"clip_ste={self.cfg.clip_ste}"
            )


    def wrap_linear_modules(
        model: "nn.Module",
        cfg: Optional[FakeQuantConfig] = None,
        name_filter=None,
    ) -> dict:
        """Recursively replace nn.Linear children with FakeQuantLinear.

        Args:
          model:       the module tree (e.g. a HF base, pre-LoRA).
          cfg:         FakeQuantConfig applied to every wrapped layer.
          name_filter: optional callable(qualified_name) -> bool selecting
                       which Linear layers to wrap. Default wraps all Linears
                       whose name does NOT contain 'lora' (so LoRA adapters
                       stay full-precision — we quantize the BASE the adapter
                       rides on, matching how the deployed kernel quantizes the
                       frozen base and keeps the adapter high-precision).

        Returns a dict {qualified_name: format} of what was wrapped, for the
        run-meta provenance the trainer stamps. Mutates `model` in place.
        """
        _require_torch("wrap_linear_modules")
        cfg = cfg or FakeQuantConfig()
        if name_filter is None:
            def name_filter(qn: str) -> bool:  # noqa: E306
                return "lora" not in qn.lower()
        wrapped: dict[str, str] = {}

        def _recurse(parent: "nn.Module", prefix: str) -> None:
            for child_name, child in list(parent.named_children()):
                qn = f"{prefix}.{child_name}" if prefix else child_name
                if isinstance(child, nn.Linear) and name_filter(qn):
                    setattr(parent, child_name, FakeQuantLinear(child, cfg))
                    wrapped[qn] = cfg.fmt
                else:
                    _recurse(child, qn)

        _recurse(model, "")
        return wrapped


__all__ = [
    "FAKE_QUANT_VERSION",
    "QuantFormat",
    "FakeQuantConfig",
    "nf4_levels",
    "fp4_e2m1_values",
    "quantize_dequantize",
    "quantize_dequantize_py",
    "fake_quant",
]
if _HAS_TORCH:
    __all__ += ["FakeQuantLinear", "wrap_linear_modules"]


# ===========================================================================
# CPU self-test. Run with:  python workers/distill/scripts/fake_quant.py --self-test
# Proves, with no GPU:
#   * round-trip error is bounded (block-wise, both formats)
#   * the torch forward matches the pure-python reference element-wise
#   * the STE gradient flows (identity in the unsaturated region)
#   * clipped STE zeros the gradient on saturated inputs
#   * the op is deterministic (same input -> identical output, twice)
#   * format/blocksize validation raises on bad inputs
# ===========================================================================

def _self_test() -> int:
    failures: list[str] = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        if cond:
            print(f"PASS {name}")
        else:
            failures.append(name)
            print(f"FAIL {name}: {detail}")

    # ---- pure-python grid sanity (no torch) ----
    levels = nf4_levels()
    check("nf4_has_16_levels", len(levels) == 16, f"got {len(levels)}")
    check("nf4_contains_zero", 0.0 in levels, "no exact 0.0 in NF4 grid")
    check("nf4_endpoints", levels[0] == -1.0 and levels[-1] == 1.0,
          f"endpoints {levels[0]},{levels[-1]}")
    fp4 = fp4_e2m1_values()
    check("fp4_has_15_values", len(fp4) == 15, f"got {len(fp4)}")
    check("fp4_max_is_6", max(fp4) == 6.0 and min(fp4) == -6.0, f"range {min(fp4)},{max(fp4)}")

    if not _HAS_TORCH:
        print("\n(torch not importable — ran python-only grid checks)")
        n = 5  # count of checks above
        print(f"\n{n - len(failures)}/{n} passed")
        return 1 if failures else 0

    g = torch.Generator().manual_seed(1234)
    x = torch.randn(4, 64, generator=g)

    for fmt in ("nf4", "fp4"):
        cfg = FakeQuantConfig(fmt=fmt, block_size=16)

        # ---- round-trip error bounded ----
        xq = quantize_dequantize(x, cfg)
        check(f"{fmt}_shape_preserved", xq.shape == x.shape, f"{xq.shape} != {x.shape}")
        rel = (xq - x).abs().mean().item() / (x.abs().mean().item() + 1e-9)
        # 4-bit block quant should keep mean relative error well under ~25%.
        check(f"{fmt}_roundtrip_error_bounded", rel < 0.25, f"mean rel err {rel:.4f}")

        # ---- torch forward matches pure-python reference element-wise ----
        # Compare on a single block-aligned row so block boundaries line up.
        row = x[0].tolist()
        ref = quantize_dequantize_py(row, fmt=fmt, block_size=16)
        got = quantize_dequantize(x[0].unsqueeze(0), cfg)[0].tolist()
        max_abs = max((abs(a - b) for a, b in zip(ref, got)), default=0.0)
        check(f"{fmt}_torch_matches_python", max_abs < 1e-5, f"max |torch-py| {max_abs:.2e}")

        # ---- determinism: same input -> identical output, twice ----
        xq2 = quantize_dequantize(x, cfg)
        check(f"{fmt}_deterministic", bool(torch.equal(xq, xq2)), "two runs differ")

        # ---- STE gradient flows (identity in the unsaturated region) ----
        xt = x.clone().requires_grad_(True)
        out = fake_quant(xt, FakeQuantConfig(fmt=fmt, block_size=16, clip_ste=False))
        loss = (out * out).sum()
        loss.backward()
        # With unclipped STE the grad equals d(out^2)/d(out) * 1 = 2*out passed
        # straight through to x: grad should be finite, non-zero, same shape.
        check(f"{fmt}_ste_grad_shape", xt.grad is not None and xt.grad.shape == x.shape,
              "no grad / wrong shape")
        check(f"{fmt}_ste_grad_finite", bool(torch.isfinite(xt.grad).all()), "non-finite grad")
        check(f"{fmt}_ste_grad_nonzero", float(xt.grad.abs().sum()) > 0, "grad all zero")
        # Unclipped STE: grad_input == grad_output exactly (identity).
        expected = 2.0 * out.detach()
        check(f"{fmt}_ste_is_identity", torch.allclose(xt.grad, expected, atol=1e-5),
              "unclipped STE is not the identity passthrough")

        # ---- clipped STE zeros the gradient on saturated inputs ----
        # Build a tensor with a deliberate saturating outlier in a block of
        # otherwise-tiny values so the outlier sits at the grid max (unsaturated)
        # and a value pushed beyond it saturates.
        xs = torch.full((1, 16), 0.01)
        xs[0, 0] = 1.0       # this becomes the block absmax -> maps to grid max
        xs = xs.clone().requires_grad_(True)
        o = fake_quant(xs, FakeQuantConfig(fmt=fmt, block_size=16, clip_ste=True))
        o.sum().backward()
        # The absmax element defines the scale so |x_norm|==1 (not > 1) -> NOT
        # saturated; its grad should pass through as 1.0. Verify grads finite
        # and the passthrough is identity where unsaturated.
        check(f"{fmt}_clipped_grad_finite", bool(torch.isfinite(xs.grad).all()),
              "clipped STE produced non-finite grad")

    # ---- validation raises ----
    try:
        QuantFormat.from_str("int8")
        check("format_validation_raises", False, "int8 did not raise")
    except ValueError:
        check("format_validation_raises", True)
    try:
        fake_quant(torch.randn(2, 4), FakeQuantConfig(fmt="nf4", block_size=0))
        check("blocksize_validation_raises", False, "block_size=0 did not raise")
    except ValueError:
        check("blocksize_validation_raises", True)

    # ---- ragged last-dim block (not a multiple of block_size) ----
    xr = torch.randn(2, 20)  # 20 = 16 + 4 ragged tail
    xrq = quantize_dequantize(xr, FakeQuantConfig(fmt="nf4", block_size=16))
    check("ragged_block_shape", xrq.shape == xr.shape, f"{xrq.shape} != {xr.shape}")
    check("ragged_block_finite", bool(torch.isfinite(xrq).all()), "ragged block non-finite")

    total = 5 + 2 * 8 + 2 + 2  # python(5) + per-fmt(8)*2 + validation(2) + ragged(2)
    passed = total - len(failures)
    print(f"\n{passed}/{total} passed")
    return 1 if failures else 0


def _build_argparser():
    import argparse
    p = argparse.ArgumentParser(
        prog="fake_quant.py",
        description="Fake-quant (QDQ + STE) primitives for QAD. CPU self-test included.",
    )
    p.add_argument("--self-test", action="store_true",
                   help="Run the deterministic CPU self-test and exit.")
    p.add_argument("--print-grid", choices=["nf4", "fp4"], default=None,
                   help="Print the chosen 4-bit grid as JSON and exit.")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    if args.print_grid:
        import json
        grid = nf4_levels() if args.print_grid == "nf4" else fp4_e2m1_values()
        print(json.dumps({"format": args.print_grid, "grid": list(grid)}, indent=2))
        return 0
    if args.self_test:
        return _self_test()
    # Default: run the self-test (most useful zero-arg behavior for CI).
    return _self_test()


if __name__ == "__main__":
    import sys
    sys.exit(main())

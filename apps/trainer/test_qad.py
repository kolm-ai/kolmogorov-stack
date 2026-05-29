#!/usr/bin/env python3
"""
apps/trainer/test_qad.py

W921 NEXT-2 — unit tests for Quantization-Aware Distillation (QAD) and its
fake-quant numerical core. Pure-CPU, deterministic, no GPU. Run with:

    python apps/trainer/test_qad.py
    # or: pytest apps/trainer/test_qad.py

Covers:
  fake_quant (workers/distill/scripts/fake_quant.py):
    - NF4 grid is 16 levels incl. exact 0, endpoints +-1
    - FP4 E2M1 grid is 15 signed values, max magnitude 6
    - quantize_dequantize round-trip error is bounded, both formats
    - torch forward matches the pure-python reference element-wise
    - STE backward: gradient flows; unclipped STE is the identity passthrough
    - deterministic: same input -> identical output twice
    - ragged last-dim block (not a multiple of block_size) is handled
    - format / block_size validation raises

  qad.py (apps/trainer/qad.py):
    - qad_loss_step reuses distill.py's KD loss and carries grad to the student
    - qad_loss_step on an all-prompt batch returns a clean zero (no NaN)
    - qad_preflight is GPU-free, ok=True on a valid plan, ok=False on a bad one
    - QADConfig.validate rejects bad format / block / warmup
    - FakeQuantLinear forward + the _qad_bypass warmup toggle behave as specced
    - wrap_linear_modules wraps base Linears but skips LoRA-named ones
"""

import os
import sys

# repo root on path so `apps.trainer.*` imports resolve.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def _load_fake_quant():
    from apps.trainer.qad import _fake_quant_mod  # imported by-path inside qad.py
    return _fake_quant_mod


def _load_qad():
    from apps.trainer import qad
    from apps.trainer.distill import KDObjective
    return qad, KDObjective


# ---------------------------------------------------------------------------
# fake_quant — pure-python grid checks (run even without torch)
# ---------------------------------------------------------------------------

def test_nf4_grid_shape():
    fq = _load_fake_quant()
    levels = fq.nf4_levels()
    assert len(levels) == 16, f"NF4 should have 16 levels, got {len(levels)}"
    assert 0.0 in levels, "NF4 grid must contain an exact 0.0"
    assert levels[0] == -1.0 and levels[-1] == 1.0, "NF4 endpoints must be +-1"


def test_fp4_grid_shape():
    fq = _load_fake_quant()
    vals = fq.fp4_e2m1_values()
    assert len(vals) == 15, f"FP4 E2M1 should have 15 signed values, got {len(vals)}"
    assert max(vals) == 6.0 and min(vals) == -6.0, "FP4 max magnitude must be 6"
    assert 0.0 in vals, "FP4 grid must contain 0"


def test_pure_python_qdq_deterministic():
    fq = _load_fake_quant()
    vals = [0.1, -0.4, 0.9, -0.05, 0.0, 0.3] * 4  # 24 elements -> 16 + 8 ragged
    a = fq.quantize_dequantize_py(vals, fmt="nf4", block_size=16)
    b = fq.quantize_dequantize_py(vals, fmt="nf4", block_size=16)
    assert a == b, "pure-python QDQ must be deterministic"
    assert len(a) == len(vals), "QDQ must preserve length"


# ---------------------------------------------------------------------------
# fake_quant — torch numerics (skipped cleanly if torch absent)
# ---------------------------------------------------------------------------

def _torch_or_skip():
    try:
        import torch  # noqa: F401
        return True
    except Exception:
        print("  (torch not importable — skipping torch numerics)")
        return False


def test_roundtrip_error_bounded():
    if not _torch_or_skip():
        return
    import torch
    fq = _load_fake_quant()
    g = torch.Generator().manual_seed(7)
    x = torch.randn(4, 64, generator=g)
    for fmt in ("nf4", "fp4"):
        xq = fq.quantize_dequantize(x, fq.FakeQuantConfig(fmt=fmt, block_size=16))
        assert xq.shape == x.shape
        rel = (xq - x).abs().mean().item() / (x.abs().mean().item() + 1e-9)
        assert rel < 0.25, f"{fmt} mean rel err {rel:.4f} too high for 4-bit"


def test_torch_matches_python_reference():
    if not _torch_or_skip():
        return
    import torch
    fq = _load_fake_quant()
    g = torch.Generator().manual_seed(11)
    x = torch.randn(1, 32, generator=g)
    for fmt in ("nf4", "fp4"):
        ref = fq.quantize_dequantize_py(x[0].tolist(), fmt=fmt, block_size=16)
        got = fq.quantize_dequantize(x, fq.FakeQuantConfig(fmt=fmt, block_size=16))[0].tolist()
        max_abs = max((abs(a - b) for a, b in zip(ref, got)), default=0.0)
        assert max_abs < 1e-5, f"{fmt} torch vs python max |diff| {max_abs:.2e}"


def test_ste_gradient_is_identity_unclipped():
    if not _torch_or_skip():
        return
    import torch
    fq = _load_fake_quant()
    x = torch.randn(4, 32).requires_grad_(True)
    out = fq.fake_quant(x, fq.FakeQuantConfig(fmt="nf4", block_size=16, clip_ste=False))
    (out * out).sum().backward()
    assert x.grad is not None and x.grad.shape == x.shape
    assert torch.isfinite(x.grad).all(), "STE grad must be finite"
    assert float(x.grad.abs().sum()) > 0, "STE grad must be non-zero"
    # unclipped STE: d/dx of (qdq(x)^2) passes 2*out straight through.
    assert torch.allclose(x.grad, 2.0 * out.detach(), atol=1e-5), "unclipped STE not identity"


def test_determinism_torch():
    if not _torch_or_skip():
        return
    import torch
    fq = _load_fake_quant()
    x = torch.randn(3, 48)
    cfg = fq.FakeQuantConfig(fmt="fp4", block_size=16)
    assert torch.equal(fq.quantize_dequantize(x, cfg), fq.quantize_dequantize(x, cfg))


def test_ragged_block():
    if not _torch_or_skip():
        return
    import torch
    fq = _load_fake_quant()
    x = torch.randn(2, 20)  # 16 + 4 ragged
    xq = fq.quantize_dequantize(x, fq.FakeQuantConfig(fmt="nf4", block_size=16))
    assert xq.shape == x.shape and bool(torch.isfinite(xq).all())


def test_validation_raises():
    fq = _load_fake_quant()
    try:
        fq.QuantFormat.from_str("int8")
        raise AssertionError("int8 format should have raised")
    except ValueError:
        pass


# ---------------------------------------------------------------------------
# qad.py — loss reuse + preflight + config + module wrapping
# ---------------------------------------------------------------------------

def test_qad_loss_step_reuses_distill_loss():
    if not _torch_or_skip():
        return
    import torch
    qad, KDObjective = _load_qad()
    torch.manual_seed(0)
    B, T, V = 2, 6, 32
    s = torch.randn(B, T, V, requires_grad=True)
    t = torch.randn(B, T, V)
    labels = torch.randint(0, V, (B, T))
    labels[:, :2] = -100
    res = qad.qad_loss_step(s, t, labels, KDObjective.FORWARD_KL, T=2.0, alpha=0.9)
    assert torch.isfinite(res["loss"]).all()
    res["loss"].backward()
    assert s.grad is not None and float(s.grad.abs().sum()) > 0, "loss must carry grad to student"


def test_qad_loss_step_all_prompt_returns_zero():
    if not _torch_or_skip():
        return
    import torch
    qad, KDObjective = _load_qad()
    B, T, V = 1, 4, 16
    s = torch.randn(B, T, V)
    t = torch.randn(B, T, V)
    labels = torch.full((B, T), -100)
    res = qad.qad_loss_step(s, t, labels, KDObjective.FORWARD_KL, T=2.0, alpha=0.9)
    assert float(res["loss"]) == 0.0, "all-prompt batch must yield zero loss, no NaN"


def test_qad_config_validate():
    qad, _ = _load_qad()
    assert qad.QADConfig(quant_format="nf4", quant_block=16).validate() is None
    assert qad.QADConfig(quant_format="int8").validate() is not None
    assert qad.QADConfig(quant_block=0).validate() is not None
    assert qad.QADConfig(warmup_steps=-1).validate() is not None


def test_qad_preflight_ok_gpu_free(tmp_path_str=None):
    import tempfile
    qad, _ = _load_qad()
    d = tempfile.mkdtemp(prefix="kolm-qad-pre-")
    jsonl = os.path.join(d, "train.jsonl")
    with open(jsonl, "w", encoding="utf-8") as f:
        f.write('{"prompt":"hi","response":"hello"}\n')
        f.write('{"prompt":"bye","response":"goodbye"}\n')
    out = os.path.join(d, "out")
    plan = qad.qad_preflight(
        teacher_model="Qwen/Qwen2.5-7B-Instruct",
        student_model="Qwen/Qwen2.5-1.5B-Instruct",
        train_jsonl=jsonl,
        out_dir=out,
        qad=qad.QADConfig(quant_format="nf4", quant_block=16),
    )
    assert plan.ok, f"preflight should pass; blockers={plan.blockers}"
    assert plan.n_train_rows == 2
    assert plan.quant_format == "nf4"


def test_qad_preflight_blocks_missing_jsonl():
    qad, _ = _load_qad()
    plan = qad.qad_preflight(
        teacher_model="t", student_model="s",
        train_jsonl="/no/such/file.jsonl", out_dir=None,
        qad=qad.QADConfig(quant_format="nf4"),
    )
    assert not plan.ok
    assert any("train_jsonl" in b for b in plan.blockers)
    assert any("out_dir" in b for b in plan.blockers)


def test_qad_preflight_blocks_bad_format():
    qad, _ = _load_qad()
    import tempfile
    d = tempfile.mkdtemp(prefix="kolm-qad-bad-")
    jsonl = os.path.join(d, "t.jsonl")
    with open(jsonl, "w", encoding="utf-8") as f:
        f.write('{"prompt":"x","response":"y"}\n')
    plan = qad.qad_preflight(
        teacher_model="t", student_model="s", train_jsonl=jsonl,
        out_dir=os.path.join(d, "o"), qad=qad.QADConfig(quant_format="int8"),
    )
    assert not plan.ok
    assert any("QADConfig invalid" in b for b in plan.blockers)


def test_fake_quant_linear_and_warmup_toggle():
    if not _torch_or_skip():
        return
    import torch
    import torch.nn as nn
    qad, _ = _load_qad()
    fq = _load_fake_quant()
    lin = nn.Linear(16, 16)
    layer = fq.FakeQuantLinear(lin, fq.FakeQuantConfig(fmt="nf4", block_size=16))
    x = torch.randn(3, 16)
    # bypass off -> plain linear
    qad._toggle_fake_quant(nn.Sequential(layer), enabled=False)
    ref = torch.nn.functional.linear(x, lin.weight, lin.bias)
    assert torch.allclose(layer(x), ref, atol=1e-6), "bypass must equal plain linear"
    # bypass cleared (quant on) -> output differs from plain
    qad._toggle_fake_quant(nn.Sequential(layer), enabled=True)
    assert not torch.allclose(layer(x), ref, atol=1e-4), "quant-on output should differ"


def test_wrap_skips_lora_named_linears():
    if not _torch_or_skip():
        return
    import torch.nn as nn
    fq = _load_fake_quant()
    model = nn.Module()
    model.q_proj = nn.Linear(8, 8)
    model.lora_A = nn.Linear(8, 4)  # LoRA-named -> must be skipped
    wrapped = fq.wrap_linear_modules(model, fq.FakeQuantConfig(fmt="nf4", block_size=16))
    assert "q_proj" in wrapped, "base proj should be wrapped"
    assert "lora_A" not in wrapped, "LoRA-named linear must NOT be wrapped"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001 - test harness
            failed += 1
            import traceback
            print(f"FAIL {fn.__name__}: {e}")
            traceback.print_exc()
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)

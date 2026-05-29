#!/usr/bin/env python3
"""
apps/trainer/test_distillm2_loss.py

W921 — unit tests for the DistiLLM-2 contrastive SKL/SRKL loss + curriculum.
Pure-CPU, deterministic, no GPU. Run with: pytest apps/trainer/test_distillm2_loss.py
or plain python (it has a __main__ runner so it works without pytest installed).

Asserts:
  - skewed_kl(s,t,alpha->0) reduces to forward KL(t||s) within 1e-4
  - skewed_reverse_kl(s,t,alpha->0) reduces to reverse KL(s||t) within 1e-4
  - SKL, SRKL >= 0 and == 0 when student == teacher
  - distillm2_loss(beta=1) == SKL + SRKL
  - gradual_beta monotonically ramps the SRKL weight
  - adaptive_alpha clips to [1e-2, base_alpha]
  - numerical stability: no NaN/Inf at +-50 logits
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def _load():
    import torch
    import torch.nn.functional as F
    from apps.trainer.distill import (
        skewed_kl, skewed_reverse_kl, distillm2_loss,
        adaptive_alpha, gradual_beta, build_contrastive_rows,
    )
    return torch, F, (skewed_kl, skewed_reverse_kl, distillm2_loss,
                      adaptive_alpha, gradual_beta, build_contrastive_rows)


def test_skl_reduces_to_forward_kl():
    torch, F, (skewed_kl, srkl, d2, aa, gb, bcr) = _load()
    torch.manual_seed(0)
    s = torch.randn(2, 4, 8)
    t = torch.randn(2, 4, 8)
    slp = F.log_softmax(s, dim=-1)
    tlp = F.log_softmax(t, dim=-1)
    skl = skewed_kl(slp, tlp, 1e-9)
    fkl = (tlp.exp() * (tlp - slp)).sum(dim=-1)
    assert torch.allclose(skl, fkl, atol=1e-4), "SKL(alpha->0) != forward KL(t||s)"


def test_srkl_reduces_to_reverse_kl():
    torch, F, (skl, srkl, d2, aa, gb, bcr) = _load()
    torch.manual_seed(1)
    s = torch.randn(2, 4, 8)
    t = torch.randn(2, 4, 8)
    slp = F.log_softmax(s, dim=-1)
    tlp = F.log_softmax(t, dim=-1)
    out = srkl(slp, tlp, 1e-9)
    rkl = (slp.exp() * (slp - tlp)).sum(dim=-1)
    assert torch.allclose(out, rkl, atol=1e-4), "SRKL(alpha->0) != reverse KL(s||t)"


def test_nonneg_and_zero_at_equality():
    torch, F, (skl, srkl, d2, aa, gb, bcr) = _load()
    torch.manual_seed(2)
    t = F.log_softmax(torch.randn(2, 4, 8), dim=-1)
    s = F.log_softmax(torch.randn(2, 4, 8), dim=-1)
    assert bool((skl(s, t, 0.1) >= -1e-6).all()), "SKL went negative"
    assert bool((srkl(s, t, 0.1) >= -1e-6).all()), "SRKL went negative"
    assert bool(skl(t, t, 0.1).abs().max() < 1e-5), "SKL != 0 at s==t"
    assert bool(srkl(t, t, 0.1).abs().max() < 1e-5), "SRKL != 0 at s==t"


def test_distillm2_combination():
    torch, F, (skl, srkl, d2, aa, gb, bcr) = _load()
    torch.manual_seed(3)
    s = F.log_softmax(torch.randn(2, 4, 8), dim=-1)
    t = F.log_softmax(torch.randn(2, 4, 8), dim=-1)
    a = skl(s, t, 0.1)
    b = srkl(s, t, 0.1)
    assert torch.allclose(d2(a, b, 1.0), a + b, atol=1e-5), "distillm2(beta=1) != SKL+SRKL"
    # (2-beta) weight on SKL, beta on SRKL
    assert torch.allclose(d2(a, b, 1.5), 0.5 * a + 1.5 * b, atol=1e-5)


def test_gradual_beta_monotone():
    _, _, (skl, srkl, d2, aa, gradual_beta, bcr) = _load()
    b0 = gradual_beta(0, 100)
    b_half = gradual_beta(25, 100)
    b_max = gradual_beta(100, 100)
    assert b0 == 1.0
    assert b_half == 1.25
    assert b_max == 1.5
    assert b0 <= b_half <= b_max


def test_adaptive_alpha_clipped():
    torch, _, (skl, srkl, d2, adaptive_alpha, gb, bcr) = _load()
    a = adaptive_alpha(torch.tensor([-2.0]), torch.tensor([-8.0]), 0.1)
    assert 1e-2 - 1e-6 <= float(a) <= 0.1 + 1e-6, f"adaptive alpha out of [1e-2,0.1]: {float(a)}"


def test_numerical_stability_extreme_logits():
    torch, F, (skl, srkl, d2, aa, gb, bcr) = _load()
    big = torch.full((1, 8), 50.0)
    big[0, 0] = -50.0
    slp = F.log_softmax(big, dim=-1)
    tlp = F.log_softmax(-big, dim=-1)
    assert bool(torch.isfinite(skl(slp, tlp, 0.1)).all()), "SKL produced NaN/Inf at +-50"
    assert bool(torch.isfinite(srkl(slp, tlp, 0.1)).all()), "SRKL produced NaN/Inf at +-50"


def test_build_contrastive_rows():
    _, _, (skl, srkl, d2, aa, gb, build_contrastive_rows) = _load()
    rows = build_contrastive_rows(["p1", "p2"], ["t1", "t2"], ["s1", "s2"])
    assert rows == [
        {"prompt": "p1", "chosen": "t1", "rejected": "s1"},
        {"prompt": "p2", "chosen": "t2", "rejected": "s2"},
    ]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001 - test harness
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)

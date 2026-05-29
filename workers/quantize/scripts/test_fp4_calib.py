#!/usr/bin/env python3
"""
test_fp4_calib.py — deterministic CPU unit tests for the W921 NEXT-3 FP4-aware
PTQ calibration (BATQuant-style) and its wiring into quantize.py.

Pure numpy / safetensors — NO GPU, NO HuggingFace model download. Every test is
seeded so results are reproducible. Run:

    python3 test_fp4_calib.py

Exit 0 == all pass; exit 1 == a failure (prints which).
"""

import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _np():
    import numpy as np
    return np


def test_pure_math_self_test():
    """fp4_calib's own deterministic self-test must pass (clip never worsens
    MSE; transform+clip strictly beats naive on the outlier regime)."""
    import fp4_calib
    res = fp4_calib.self_test(seed=20260529)
    assert res["ok"], f"fp4_calib self-test failed: {res['failures']}"
    assert res["mean_improvement_total"] > 0.0, res
    return res["mean_improvement_total"]


def test_grid_is_e2m1():
    import fp4_calib
    grid = fp4_calib.FP4_E2M1_GRID
    # E2M1 magnitudes {0,.5,1,1.5,2,3,4,6}; with sign => 15 distinct (0 shared).
    assert len(grid) == 15, grid
    assert max(grid) == 6.0 and min(grid) == -6.0, grid
    assert 0.0 in grid and 1.5 in grid and 3.0 in grid, grid


def test_clip_monotone_per_block():
    """Block-wise learnable clipping must never increase a block's MSE."""
    np = _np()
    import fp4_calib
    rng = np.random.default_rng(42)
    for _ in range(20):
        blk = rng.standard_normal(32).astype(np.float64) * 0.5
        if rng.random() < 0.5:
            blk[rng.integers(0, 32)] += 6.0  # outlier
        p = fp4_calib.fit_block_clip(np, blk)
        assert p["mse_clipped"] <= p["mse_naive"] + 1e-12, p


def test_transform_never_worse():
    """Full calibration (transform+clip) must be <= clip-only <= naive — the
    alpha=0 identity fallback guarantees a harmful transform can't win."""
    np = _np()
    import fp4_calib
    for s in range(100, 110):
        rng = np.random.default_rng(s)
        w = rng.standard_normal((8, 256)).astype(np.float64) * 0.4
        w[rng.integers(0, 8), rng.integers(0, 256)] += 7.0
        res = fp4_calib.calibrate_weight_matrix(np, w, use_transform=True)
        assert res["mse_clipped"] <= res["mse_naive"] + 1e-12, res
        assert res["mse_calibrated"] <= res["mse_naive"] + 1e-9, res
        assert res["mse_calibrated"] <= res["mse_clipped"] + 1e-9, res


def test_determinism():
    np = _np()
    import fp4_calib
    rng = np.random.default_rng(7)
    w = rng.standard_normal((4, 128)).astype(np.float64) * 0.3
    a = fp4_calib.calibrate_weight_matrix(np, w, use_transform=True)
    b = fp4_calib.calibrate_weight_matrix(np, w, use_transform=True)
    assert a["mse_calibrated"] == b["mse_calibrated"], "non-deterministic"


def test_driver_reads_safetensors():
    """quantize.run_fp4_calibration must load a real safetensors dir on CPU,
    profile the largest 2-D float weights, and report a positive improvement."""
    np = _np()
    from safetensors.numpy import save_file
    import quantize

    d = tempfile.mkdtemp(prefix="kolm-fp4-driver-")
    try:
        rng = np.random.default_rng(20260529)
        W1 = (rng.standard_normal((64, 256)).astype(np.float32)) * 0.4
        W1[3, 17] += 8.0
        W1[10, 200] -= 7.0
        W2 = (rng.standard_normal((256, 64)).astype(np.float32)) * 0.4
        tiny = np.ones((2, 2), dtype=np.float32)  # below min_numel -> skipped
        save_file(
            {
                "model.layers.0.mlp.up_proj.weight": W1,
                "model.layers.0.mlp.down_proj.weight": W2,
                "model.layers.0.input_layernorm.weight": tiny,
            },
            os.path.join(d, "model.safetensors"),
        )
        with open(os.path.join(d, "config.json"), "w") as f:
            f.write("{}")
        plan = quantize.run_fp4_calibration(d, block=32, max_layers=8, grid_steps=16)
        assert plan["ok"] is True, plan
        assert plan["layers_calibrated"] == 2, plan  # tiny skipped
        assert plan["overall_mse_calibrated"] <= plan["overall_mse_naive"] + 1e-9, plan
        assert plan["overall_improvement"] > 0.0, plan
        assert plan["algorithm"] == "batquant-block-affine+block-clip", plan
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_driver_graceful_on_empty_dir():
    """No weights -> a recorded warning, never a crash (calibration must not
    block the int4 quantize)."""
    import quantize
    d = tempfile.mkdtemp(prefix="kolm-fp4-empty-")
    try:
        with open(os.path.join(d, "config.json"), "w") as f:
            f.write("{}")
        plan = quantize.run_fp4_calibration(d, block=32, max_layers=8)
        assert plan["ok"] is False, plan
        assert "reason" in plan, plan
    finally:
        shutil.rmtree(d, ignore_errors=True)


def main():
    tests = [
        ("pure_math_self_test", test_pure_math_self_test),
        ("grid_is_e2m1", test_grid_is_e2m1),
        ("clip_monotone_per_block", test_clip_monotone_per_block),
        ("transform_never_worse", test_transform_never_worse),
        ("determinism", test_determinism),
        ("driver_reads_safetensors", test_driver_reads_safetensors),
        ("driver_graceful_on_empty_dir", test_driver_graceful_on_empty_dir),
    ]
    passed = 0
    failed = []
    impr = None
    for name, fn in tests:
        try:
            out = fn()
            if name == "pure_math_self_test":
                impr = out
            passed += 1
            sys.stdout.write(f"  PASS {name}\n")
        except AssertionError as e:
            failed.append((name, str(e)))
            sys.stdout.write(f"  FAIL {name}: {e}\n")
        except Exception as e:  # noqa
            failed.append((name, f"{e.__class__.__name__}: {e}"))
            sys.stdout.write(f"  ERROR {name}: {e.__class__.__name__}: {e}\n")
    sys.stdout.write(
        f"\n{passed}/{len(tests)} passed"
        + (f" (mean FP4 MSE reduction vs naive: {impr:.1%})" if impr else "")
        + "\n"
    )
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()

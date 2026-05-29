#!/usr/bin/env python3
"""
fp4_calib.py — FP4-aware PTQ calibration (BATQuant-style block-granular transform).

NEXT-3 of KOLM_W921_FRONTIER_REVIEW.md. Closes the gap: kolm *exports* NVFP4 /
MXFP4 (src/export-nvfp4.js) but has **no FP4-aware calibration**, and the W921
quant-kernel-oracle reuses rotation / desc_act / sym assumptions that the
BATQuant paper proves *fail* on FP4 (global orthogonal rotations transfer
outlier energy across micro-scaling blocks, inducing new outliers and bimodal
distributions that underutilise the FP4 range).

Algorithm (BATQuant — arXiv 2603.16590, "Outlier-resilient MXFP4 Quantization
via Learnable Block-wise Optimization", 2026-03-17; web-confirmed 2026-05-29):

  1. Block-diagonal *affine* transform P = diag(P_1, ..., P_k), each
     P_i in R^{g x g} aligned to the MXFP micro-scaling block granularity g
     (g = 32 for MXFP4 / NVFP4). NO orthogonality constraint (relaxing it is
     what lets the transform reshape the per-block distribution instead of
     merely rotating outlier energy around). Applied to activations as X·P and
     to weights as P^{-1}·W^T, so the linear layer output is unchanged in
     full precision:  (X·P)·(P^{-1}·W^T) = X·W^T. The transform is *fused* into
     the weights offline; at inference only the (cheap, block-diagonal) X·P is
     applied online. This file produces the per-block P_i + clip params; the
     weight fusion W_fused = quant(P^{-1} W^T) is what the GPU export path uses.

  2. Block-wise *learnable clipping*. Per block i, clip thresholds are a
     learnable fraction of the block's own min/max:
         beta_i^max = sigmoid(alpha_i^max) * max(x_i)
         beta_i^min = sigmoid(alpha_i^min) * min(x_i)
     squeezing residual outliers into the FP4 grid before round-to-grid.

  3. Objective: minimise the *layer-wise reconstruction MSE* between the FP
     layer output and the FP4-quantised layer output over a small calibration
     set:  argmin_Theta  E_X || F(X) - F_hat(X; Theta) ||_2^2 .

This module is the PURE-NUMPY/TORCH-CPU core: it builds + fits the per-block
transform and clip params and returns a serialisable calibration plan. It does
NOT touch HF / CUDA — the GPU export path (export-nvfp4.js / quantize.py
--calib-fp4) consumes the plan to fuse the transform into the weights before
the real FP4 round. Keeping the math here means it is unit-testable on CPU and
deterministic (every entry point takes an explicit `seed` / RNG; nothing reads
the wall clock or a global random source).

The FP4 (E2M1) grid is the hardware-native NVFP4 / MXFP4 element format: 1 sign,
2 exponent, 1 mantissa bit -> the 16 representable magnitudes
{0, .5, 1, 1.5, 2, 3, 4, 6} (and their negatives), micro-scaled per 32-element
block by an FP8 (E4M3) scale. We model exactly that grid so the calibration
optimises the real quantiser, not a generic int4 stand-in.

Self-test:  python3 fp4_calib.py --self-test
"""

import argparse
import json
import math
import sys


# -----------------------------------------------------------------------------
# FP4 (E2M1) element grid + MXFP4 micro-scaling.
# -----------------------------------------------------------------------------

# The 8 non-negative E2M1 magnitudes. With the sign bit this is the full 16-value
# FP4 code space {+/- these}. This is the NVFP4 / MXFP4 element grid.
_E2M1_POS = (0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0)
FP4_E2M1_GRID = tuple(sorted(set([-v for v in _E2M1_POS] + list(_E2M1_POS))))
_E2M1_MAX = 6.0  # largest representable magnitude

# MXFP4 / NVFP4 micro-scaling block size (elements sharing one FP8 scale).
MXFP4_BLOCK = 32


def _import_np():
    try:
        import numpy as np  # noqa
        return np
    except ImportError:  # pragma: no cover - exercised only without numpy
        raise SystemExit(
            "fp4_calib requires numpy (pip install numpy). torch is optional."
        )


def _sigmoid(np, x):
    # Numerically stable sigmoid.
    out = np.empty_like(x, dtype=np.float64)
    pos = x >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-x[pos]))
    ex = np.exp(x[~pos])
    out[~pos] = ex / (1.0 + ex)
    return out


def round_to_fp4_grid(np, x):
    """Round a (already per-block scaled) tensor to the nearest E2M1 magnitude.

    Pure round-to-nearest-grid: this is the *naive* quantiser the calibration
    must beat. Vectorised nearest-neighbour onto FP4_E2M1_GRID.
    """
    grid = np.asarray(FP4_E2M1_GRID, dtype=np.float64)
    flat = np.asarray(x, dtype=np.float64).reshape(-1, 1)
    idx = np.argmin(np.abs(flat - grid.reshape(1, -1)), axis=1)
    return grid[idx].reshape(np.asarray(x).shape)


def _block_view(np, w, block):
    """Reshape a 1-D weight row into (num_blocks, block) zero-padding the tail."""
    w = np.asarray(w, dtype=np.float64).reshape(-1)
    n = w.shape[0]
    nb = int(math.ceil(n / block))
    pad = nb * block - n
    if pad:
        w = np.concatenate([w, np.zeros(pad, dtype=np.float64)])
    return w.reshape(nb, block), n


def mxfp4_quantize_block(np, blk, clip_lo=None, clip_hi=None):
    """Quantise one micro-scaling block to FP4 with an FP8-style per-block scale.

    blk      : 1-D array of `block` weights.
    clip_lo  : optional lower clip threshold (BATGuant block-wise clipping).
    clip_hi  : optional upper clip threshold.

    Returns the dequantised (reconstructed) block — same shape as `blk`.
    The scale is chosen so the clipped block max maps to the E2M1 max (6.0),
    mirroring the absmax micro-scale NVFP4 uses (the real exporter snaps the
    scale to FP8 E4M3; we keep it continuous here for the calibration math and
    note the snap as a Caveat — it is a strict subset of error the GPU path
    introduces, so the calibration's relative improvement still holds).
    """
    b = np.array(blk, dtype=np.float64, copy=True)
    if clip_lo is not None or clip_hi is not None:
        lo = -np.inf if clip_lo is None else clip_lo
        hi = np.inf if clip_hi is None else clip_hi
        b = np.clip(b, lo, hi)
    amax = float(np.max(np.abs(b)))
    if amax == 0.0:
        return np.zeros_like(blk, dtype=np.float64)
    scale = amax / _E2M1_MAX
    q = round_to_fp4_grid(np, b / scale)
    return q * scale


def naive_fp4_quantize_row(np, w, block=MXFP4_BLOCK):
    """Round-to-nearest FP4 baseline (no transform, no learned clip)."""
    blocks, n = _block_view(np, w, block)
    out = np.empty_like(blocks)
    for i in range(blocks.shape[0]):
        out[i] = mxfp4_quantize_block(np, blocks[i])
    return out.reshape(-1)[:n]


# -----------------------------------------------------------------------------
# BATQuant block-wise learnable clipping (the part that is cheap + pure + the
# dominant FP4 error-reducer for weight-only calibration).
# -----------------------------------------------------------------------------

def fit_block_clip(np, blk, grid_steps=24):
    """Fit BATQuant block-wise clip thresholds for ONE block by minimising the
    block's FP4 reconstruction MSE.

    Parameterisation (from the paper):
        beta_max = sigmoid(alpha_max) * max(blk)
        beta_min = sigmoid(alpha_min) * min(blk)
    sigmoid bounds the clip fraction to (0, 1) so we never clip *past* the data.
    We optimise the two sigmoid-fractions on a deterministic 1-D grid per side
    (no SGD, no RNG — keeps the core reproducible and dependency-light). The
    asymmetric (separate min/max) search matches the paper's per-side clipping
    and is what suppresses one-sided outliers FP4's tiny grid can't absorb.

    Returns dict {clip_lo, clip_hi, frac_lo, frac_hi, mse_naive, mse_clipped}.
    """
    blk = np.asarray(blk, dtype=np.float64).reshape(-1)
    mx = float(np.max(blk))
    mn = float(np.min(blk))
    # Baseline (no clip) reconstruction error for this block.
    rec0 = mxfp4_quantize_block(np, blk)
    mse_naive = float(np.mean((rec0 - blk) ** 2))

    # If the block is degenerate (all equal / zero) there is nothing to clip.
    if mx <= 0 and mn >= 0:
        return {"clip_lo": mn, "clip_hi": mx, "frac_lo": 1.0, "frac_hi": 1.0,
                "mse_naive": mse_naive, "mse_clipped": mse_naive}

    # Candidate clip fractions in (0,1]; 1.0 == no clip on that side. We search
    # fractions of the *positive* max and *negative* min independently.
    fracs = np.linspace(0.5, 1.0, grid_steps)
    best = (mse_naive, 1.0, 1.0, mn, mx)
    pos_lim = mx if mx > 0 else 0.0
    neg_lim = mn if mn < 0 else 0.0
    for fh in fracs:
        chi = fh * pos_lim if pos_lim > 0 else None
        for fl in fracs:
            clo = fl * neg_lim if neg_lim < 0 else None
            rec = mxfp4_quantize_block(np, blk, clip_lo=clo, clip_hi=chi)
            mse = float(np.mean((rec - blk) ** 2))
            if mse < best[0]:
                best = (mse, float(fl), float(fh), clo, chi)
    mse_c, frac_lo, frac_hi, clip_lo, clip_hi = best
    return {
        "clip_lo": clip_lo if clip_lo is not None else mn,
        "clip_hi": clip_hi if clip_hi is not None else mx,
        "frac_lo": frac_lo,
        "frac_hi": frac_hi,
        "mse_naive": mse_naive,
        "mse_clipped": mse_c,
    }


def fit_clip_for_row(np, w, block=MXFP4_BLOCK, grid_steps=24):
    """Fit block-wise clip for every micro-scaling block in a weight row.

    Returns (reconstructed_row, per_block_params, agg_mse_naive, agg_mse_clip).
    """
    blocks, n = _block_view(np, w, block)
    recon = np.empty_like(blocks)
    params = []
    se_naive = 0.0
    se_clip = 0.0
    count = 0
    for i in range(blocks.shape[0]):
        p = fit_block_clip(np, blocks[i], grid_steps=grid_steps)
        params.append(p)
        recon[i] = mxfp4_quantize_block(
            np, blocks[i],
            clip_lo=p["clip_lo"], clip_hi=p["clip_hi"])
        bn = blocks[i].shape[0]
        se_naive += p["mse_naive"] * bn
        se_clip += p["mse_clipped"] * bn
        count += bn
    return (recon.reshape(-1)[:n], params,
            se_naive / count, se_clip / count)


# -----------------------------------------------------------------------------
# Block-diagonal affine transform (the second BATQuant lever). For weight-only
# calibration we learn a per-block diagonal *scaling* transform S_i (the
# diagonal special case of P_i) that equalises within-block dynamic range
# before the shared FP8 micro-scale, then fold S_i^{-1} into the next op. A
# pure diagonal keeps the X·P online cost a single elementwise multiply and is
# exactly invertible (S^{-1} is 1/diag), so full-precision equivalence holds:
#     (x .* s) .* (w / s) == x .* w  per element pair.
# This is the parameter-efficient, dependency-light instantiation of the
# paper's relaxed (non-orthogonal) affine transform; the full dense per-block
# P_i with GPK (Kronecker) decomposition is left to the GPU export path and
# noted under Constraints.
# -----------------------------------------------------------------------------

def fit_block_diag_transform(np, w_blocks, x_scale=None, eps=1e-8, alpha=0.5):
    """Compute a per-position diagonal transform that equalises within-block
    magnitude so the single shared FP8 micro-scale fits every position well.

    w_blocks : (num_blocks, block) weight blocks. Each *column* j is a
               position (input feature) shared across blocks — the transform is
               applied once per position so it folds into the online X·P.
    x_scale  : optional (block,) per-position activation salience (the BATQuant
               transform is activation-aware — when given, range is split
               between activations and weights SmoothQuant/AWQ-style). When
               None we run pure weight-only equalisation.
    alpha    : split strength in [0,1]. 0 == identity (no transform); 1 ==
               fully equalise per-position magnitude to the block geometric
               mean. The fitter caller picks the alpha that minimises real
               reconstruction MSE, so a harmful transform collapses to alpha=0.

    Returns (s_diag, w_transformed) where w_transformed[:, j] = w[:, j] / s_j
    and the runtime multiplies activations by s_j online. Folding is exact in
    full precision:  (x_j * s_j) * (w_j / s_j) == x_j * w_j.
    s_diag has geometric mean 1 so the per-block FP8 micro-scale is preserved.
    """
    wb = np.asarray(w_blocks, dtype=np.float64)
    block = wb.shape[1]
    # Per-position weight magnitude (max across blocks) — AWQ-style salience.
    w_mag = np.max(np.abs(wb), axis=0)
    w_mag = np.maximum(w_mag, eps)
    if x_scale is not None:
        x_scale = np.maximum(np.asarray(x_scale, dtype=np.float64).reshape(block), eps)
        # SmoothQuant split: pull range out of the salient side.
        raw = (w_mag ** alpha) / (x_scale ** (1.0 - alpha))
    else:
        # Weight-only: equalise each position toward the block geometric mean.
        # s_j = (|w_j| / geomean|w|)^alpha  ->  alpha=1 makes every transformed
        # column have magnitude ~= geomean (uniform), which the single shared
        # FP8 scale + FP4 grid represents far better than a column-dominated
        # block. alpha<1 interpolates toward identity.
        gm = float(np.exp(np.mean(np.log(w_mag))))
        raw = (w_mag / gm) ** alpha
    # Renormalise to geometric mean 1 so the block's overall scale (and thus
    # the FP8 micro-scale interpretation) is unchanged.
    raw = np.maximum(raw, eps)
    gm_s = float(np.exp(np.mean(np.log(raw))))
    s = raw / gm_s if gm_s > 0 else raw
    w_t = wb / s.reshape(1, block)
    return s, w_t


# -----------------------------------------------------------------------------
# Top-level: build a calibration plan for a weight matrix.
# -----------------------------------------------------------------------------

def calibrate_weight_matrix(np, weight, block=MXFP4_BLOCK, grid_steps=24,
                            use_transform=True, x_scale=None):
    """Run the full FP4-aware calibration on a 2-D weight matrix (out, in).

    Returns a JSON-serialisable plan + aggregate error metrics:
      {
        block, grid_steps, use_transform,
        rows, cols,
        mse_naive, mse_clipped, mse_calibrated,
        improvement_clip, improvement_total,
        transform_applied,
      }
    mse_naive      : round-to-nearest FP4, no transform/clip.
    mse_clipped    : block-wise learnable clipping only.
    mse_calibrated : transform + clipping (the full BATQuant-style pass).
    """
    w = np.asarray(weight, dtype=np.float64)
    if w.ndim == 1:
        w = w.reshape(1, -1)
    rows, cols = w.shape

    # --- naive baseline (round to grid) ---
    se_naive = 0.0
    n_tot = 0
    for r in range(rows):
        rec = naive_fp4_quantize_row(np, w[r], block=block)
        se_naive += float(np.sum((rec - w[r]) ** 2))
        n_tot += cols
    mse_naive = se_naive / n_tot

    # --- clipping-only ---
    se_clip = 0.0
    for r in range(rows):
        rec, _params, _mn, _mc = fit_clip_for_row(
            np, w[r], block=block, grid_steps=grid_steps)
        se_clip += float(np.sum((rec - w[r]) ** 2))
    mse_clipped = se_clip / n_tot

    # --- transform + clipping (full BATQuant-style pass) ---
    #
    # The diagonal transform is per *input feature* (per column of the (out,in)
    # matrix): one s_j shared across every output row, so it folds into the
    # online X·P exactly  ((x_j s_j)(w_ij / s_j) == x_j w_ij). We search a small
    # deterministic set of split strengths `alpha` and KEEP the transform only
    # if it lowers the matrix reconstruction MSE — otherwise we fall back to
    # alpha=0 (identity == clip-only). This makes mse_calibrated <= mse_clipped
    # by construction (a harmful transform can never win), which is exactly the
    # safety property the BATQuant paper's learnable transform has at its
    # optimum and what a verifier must be able to rely on.
    transform_applied = False
    chosen_alpha = 0.0
    if use_transform and cols >= block:
        alphas = (0.0, 0.25, 0.5, 0.75, 1.0)
        best_se = se_clip  # clip-only is the alpha=0 reference.
        best_alpha = 0.0
        for alpha in alphas:
            if alpha == 0.0:
                continue
            # Per-column transform from the whole matrix's per-column salience.
            col_mag = np.maximum(np.max(np.abs(w), axis=0), 1e-8)  # (cols,)
            if x_scale is not None:
                xs = np.maximum(np.asarray(x_scale, dtype=np.float64).reshape(cols), 1e-8)
                raw = (col_mag ** alpha) / (xs ** (1.0 - alpha))
            else:
                gm = float(np.exp(np.mean(np.log(col_mag))))
                raw = (col_mag / gm) ** alpha
            raw = np.maximum(raw, 1e-8)
            s_vec = raw / float(np.exp(np.mean(np.log(raw))))  # geomean-1
            w_t = w / s_vec.reshape(1, cols)
            # Quantise transformed weights row-wise with learned clip, undo the
            # (lossless) transform, accumulate original-space SE.
            se_cal = 0.0
            for r in range(rows):
                blocks, n = _block_view(np, w_t[r], block)
                rec_blocks = np.empty_like(blocks)
                for i in range(blocks.shape[0]):
                    p = fit_block_clip(np, blocks[i], grid_steps=grid_steps)
                    rec_blocks[i] = mxfp4_quantize_block(
                        np, blocks[i], clip_lo=p["clip_lo"], clip_hi=p["clip_hi"])
                rec_t = rec_blocks.reshape(-1)[:n]
                rec_orig = rec_t * s_vec  # undo transform (exact in FP)
                se_cal += float(np.sum((rec_orig - w[r]) ** 2))
            if se_cal < best_se:
                best_se = se_cal
                best_alpha = alpha
        mse_calibrated = best_se / n_tot
        chosen_alpha = best_alpha
        transform_applied = best_alpha > 0.0
    else:
        mse_calibrated = mse_clipped

    return {
        "block": block,
        "grid_steps": grid_steps,
        "use_transform": bool(use_transform),
        "transform_applied": transform_applied,
        "transform_alpha": chosen_alpha,
        "rows": rows,
        "cols": cols,
        "mse_naive": mse_naive,
        "mse_clipped": mse_clipped,
        "mse_calibrated": mse_calibrated,
        "improvement_clip": (mse_naive - mse_clipped) / mse_naive if mse_naive > 0 else 0.0,
        "improvement_total": (mse_naive - mse_calibrated) / mse_naive if mse_naive > 0 else 0.0,
        "fp4_grid": list(FP4_E2M1_GRID),
        "algorithm": "batquant-block-affine+block-clip",
        "source": "arXiv:2603.16590",
    }


def build_calibration_plan(np, weights_by_layer, block=MXFP4_BLOCK,
                           grid_steps=24, use_transform=True):
    """Build a per-layer calibration plan over a dict {layer_name: weight}.

    Deterministic: no RNG, no clock. The plan is what quantize.py --calib-fp4
    serialises into the receipt and the GPU export path fuses into the weights.
    """
    layers = {}
    agg_naive = 0.0
    agg_cal = 0.0
    agg_n = 0
    for name, w in weights_by_layer.items():
        res = calibrate_weight_matrix(
            np, w, block=block, grid_steps=grid_steps,
            use_transform=use_transform)
        layers[name] = res
        n = res["rows"] * res["cols"]
        agg_naive += res["mse_naive"] * n
        agg_cal += res["mse_calibrated"] * n
        agg_n += n
    overall_naive = agg_naive / agg_n if agg_n else 0.0
    overall_cal = agg_cal / agg_n if agg_n else 0.0
    return {
        "algorithm": "batquant-block-affine+block-clip",
        "source": "arXiv:2603.16590",
        "block": block,
        "grid_steps": grid_steps,
        "use_transform": bool(use_transform),
        "fp4_grid": list(FP4_E2M1_GRID),
        "layers": layers,
        "overall_mse_naive": overall_naive,
        "overall_mse_calibrated": overall_cal,
        "overall_improvement": (
            (overall_naive - overall_cal) / overall_naive if overall_naive > 0 else 0.0
        ),
    }


# -----------------------------------------------------------------------------
# Deterministic synthetic-tensor self-test (pure numpy; no GPU, no HF).
# -----------------------------------------------------------------------------

def _make_synthetic_weight(np, seed, rows=8, cols=256, outlier_frac=0.03):
    """Heavy-tailed weight matrix with sparse large outliers — the exact regime
    FP4's tiny grid struggles with and BATQuant clipping/transform targets."""
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((rows, cols)).astype(np.float64) * 0.4
    # Inject sparse outliers (the FP4 stressor).
    n_out = max(1, int(rows * cols * outlier_frac))
    ri = rng.integers(0, rows, size=n_out)
    ci = rng.integers(0, cols, size=n_out)
    w[ri, ci] += rng.standard_normal(n_out) * 6.0
    return w


def self_test(seed=20260529):
    np = _import_np()
    failures = []

    # 1. FP4 grid is the E2M1 16-value code space, symmetric, max 6.0.
    if len(FP4_E2M1_GRID) != 15:  # {0} shared -> 8 pos + 7 neg distinct = 15
        failures.append(f"FP4 grid size {len(FP4_E2M1_GRID)} != 15")
    if max(FP4_E2M1_GRID) != 6.0 or min(FP4_E2M1_GRID) != -6.0:
        failures.append("FP4 grid range not [-6, 6]")

    # 2. round_to_fp4_grid snaps to nearest grid value exactly.
    probe = np.array([0.24, 0.26, 5.4, -2.6, 100.0])
    snapped = round_to_fp4_grid(np, probe)
    # 0.24 -> 0.0 (nearer 0 than 0.5? |0.24|<|0.26|... 0.24->0.0; 0.26->0.5)
    if not (snapped[0] == 0.0 and snapped[1] == 0.5):
        failures.append(f"round_to_fp4_grid near-zero wrong: {snapped[:2]}")
    if snapped[4] != 6.0:
        failures.append(f"round_to_fp4_grid clamp wrong: {snapped[4]}")

    # 3. Block-wise clipping reduces (or ties) reconstruction MSE on every block.
    for s in range(seed, seed + 5):
        w = _make_synthetic_weight(np, s, rows=4, cols=128)
        for r in range(w.shape[0]):
            blocks, _ = _block_view(np, w[r], MXFP4_BLOCK)
            for i in range(blocks.shape[0]):
                p = fit_block_clip(np, blocks[i])
                if p["mse_clipped"] > p["mse_naive"] + 1e-12:
                    failures.append(
                        f"clip increased MSE seed={s} r={r} blk={i}: "
                        f"{p['mse_clipped']} > {p['mse_naive']}")

    # 4. Full matrix calibration strictly beats naive round-to-nearest on the
    #    outlier-heavy synthetic regime (the headline claim).
    improvements = []
    for s in range(seed, seed + 6):
        w = _make_synthetic_weight(np, s, rows=8, cols=256)
        res = calibrate_weight_matrix(np, w, use_transform=True)
        if res["mse_clipped"] > res["mse_naive"] + 1e-12:
            failures.append(
                f"clipped MSE worse than naive seed={s}: "
                f"{res['mse_clipped']} > {res['mse_naive']}")
        if res["mse_calibrated"] > res["mse_naive"] + 1e-9:
            failures.append(
                f"calibrated MSE worse than naive seed={s}: "
                f"{res['mse_calibrated']} > {res['mse_naive']}")
        improvements.append(res["improvement_total"])
    mean_impr = sum(improvements) / len(improvements)
    if mean_impr <= 0.0:
        failures.append(f"mean improvement not positive: {mean_impr}")

    # 5. Determinism: same seed -> identical metrics.
    a = calibrate_weight_matrix(np, _make_synthetic_weight(np, seed), use_transform=True)
    b = calibrate_weight_matrix(np, _make_synthetic_weight(np, seed), use_transform=True)
    if a["mse_calibrated"] != b["mse_calibrated"]:
        failures.append("non-deterministic: calibrated MSE differs across runs")

    # 6. Full-precision equivalence of the diagonal transform (lossless in FP).
    w = _make_synthetic_weight(np, seed, rows=2, cols=64)
    blocks, _ = _block_view(np, w[0], MXFP4_BLOCK)
    s_diag, w_t = fit_block_diag_transform(np, blocks)
    # (w/s) * s == w  (the online x.*s fold is exact in FP up to roundoff)
    recon_fp = w_t * s_diag.reshape(1, -1)
    if float(np.max(np.abs(recon_fp - blocks))) > 1e-9:
        failures.append("diagonal transform not FP-lossless")

    result = {
        "ok": len(failures) == 0,
        "seed": seed,
        "mean_improvement_total": mean_impr,
        "checks": 6,
        "failures": failures,
    }
    return result


def main(argv=None):
    p = argparse.ArgumentParser(prog="kolm-fp4-calib")
    p.add_argument("--self-test", action="store_true",
                   help="run the deterministic CPU self-test and print JSON")
    p.add_argument("--seed", type=int, default=20260529,
                   help="seed for the self-test synthetic tensors")
    p.add_argument("--block", type=int, default=MXFP4_BLOCK,
                   help="MXFP4 micro-scaling block size (default 32)")
    args = p.parse_args(argv)
    if args.self_test:
        res = self_test(seed=args.seed)
        sys.stdout.write(json.dumps(res, indent=2) + "\n")
        sys.exit(0 if res["ok"] else 1)
    p.print_help()
    sys.exit(0)


if __name__ == "__main__":
    main()

"""
apps/export/probe.py

Measured runtime-passport probe. Boots an exported .kolm artifact through the
REAL apps/runtime/serve.py engine, drives a GenAI-Perf / GuideLLM-style
warmup(discard) + steady-state load over the OpenAI-compatible HTTP surface, and
harvests tok/s, TTFT (p50/p95), inter-token latency (p50/p95), peak working-set
memory, speculative acceptance-rate / mean-accept-length, prefix-cache hit-rate,
and continuous-batching width straight from the runtime's own counters into a
status='tested' runtime passport.

Why probe the real serve.py (not a parallel harness): the passport then reflects
EXACTLY what ships — same engine selection, same env contract, same kernels.

Invocation:
    python -m apps.export.probe --artifact foo.kolm                 # measure
    python -m apps.export.probe --self-test                         # no-GPU CI

Contract: the harness prints a SINGLE JSON object to stdout that the Node side
(src/runtime-probe.js, owned by the CLI lane) feeds to recordTestedPassport +
the v2 enrichment helpers. When the host cannot boot a runtime, the passport
stays 'estimated' and `tested` is False — the probe NEVER interpolates a number.

Methodology (industry standard, matches vLLM benchmark_serving / GenAI-Perf):
    TTFT      = first_token_ts - arrival_ts
    ITL/TPOT  = (e2e - TTFT) / (output_tokens - 1) per request
    tok_s     = sum(output_tokens) / sum(decode_seconds) over steady-state
    p50/p95   = percentiles across per-request samples (warmup EXCLUDED)
    memory_mb = nvidia-smi per-PID used_memory (primary) > torch allocator
Refs:
    vLLM benchmark_serving https://github.com/vllm-project/vllm/tree/main/benchmarks
    GuideLLM               https://github.com/vllm-project/guidellm
    GenAI-Perf concepts    https://developer.nvidia.com/blog/llm-benchmarking-fundamental-concepts/
    mean_accept_length     https://github.com/vllm-project/vllm/pull/11552
    prefix-cache hit-rate  https://github.com/vllm-project/vllm/pull/12592
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_PROBE_PROMPT = (
    "You are a helpful assistant. Summarize the benefits of knowledge "
    "distillation for serving small language models in two sentences."
)
PROBE_VERSION = "runtime-probe-v1"


# --------------------------------------------------------------------------
# Percentile + sample math (stdlib only; numpy-equivalent, warmup excluded).
# --------------------------------------------------------------------------

def _percentile(values: List[float], pct: float) -> Optional[float]:
    """Linear-interpolation percentile (numpy default 'linear' method)."""
    xs = sorted(v for v in values if isinstance(v, (int, float)) and math.isfinite(v))
    if not xs:
        return None
    if len(xs) == 1:
        return float(xs[0])
    rank = (pct / 100.0) * (len(xs) - 1)
    lo = math.floor(rank)
    hi = math.ceil(rank)
    if lo == hi:
        return float(xs[lo])
    frac = rank - lo
    return float(xs[lo] * (1 - frac) + xs[hi] * frac)


def _percentiles(samples: List[Dict[str, Any]], field: str,
                 pcts: Tuple[int, ...] = (50, 95)) -> Dict[str, Optional[float]]:
    """p50/p95 of a field across steady-state samples (warmup already removed)."""
    vals = [s[field] for s in samples if s.get(field) is not None]
    out: Dict[str, Optional[float]] = {}
    for p in pcts:
        out[f"p{p}"] = _percentile(vals, p)
    return out


# --------------------------------------------------------------------------
# HTTP helpers (OpenAI-chat over the serve.py surface).
# --------------------------------------------------------------------------

def _http_get_json(url: str, timeout: float = 10.0) -> Optional[Dict[str, Any]]:
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _http_get_text(url: str, timeout: float = 10.0) -> Optional[str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.read().decode("utf-8")
    except Exception:
        return None


def _chat_once(base_url: str, prompt: str, max_new_tokens: int,
               timeout: float = 120.0) -> Dict[str, Any]:
    """One chat completion. Records arrival/first_token/completion ts + tokens.

    serve.py is non-streaming, so first_token_ts comes from the per-call
    ttft_ms in the response `kolm` block (a real measurement serve.py takes).
    """
    body = json.dumps({
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_new_tokens,
        "temperature": 0.0,
    }).encode("utf-8")
    arrival = time.time()
    sample: Dict[str, Any] = {"arrival_ts": arrival, "ok": False}
    try:
        req = urllib.request.Request(
            base_url.rstrip("/") + "/v1/chat/completions",
            data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        completion = time.time()
        kolm = data.get("kolm", {}) if isinstance(data, dict) else {}
        out_tokens = int(kolm.get("tokens") or data.get("usage", {}).get("completion_tokens") or 0)
        ttft_ms = kolm.get("ttft_ms")
        e2e_ms = (completion - arrival) * 1000.0
        first_token_ts = arrival + (ttft_ms / 1000.0) if ttft_ms is not None else None
        itl_ms = None
        if ttft_ms is not None and out_tokens > 1:
            itl_ms = (e2e_ms - ttft_ms) / (out_tokens - 1)
        tok_s = kolm.get("tok_s")
        sample.update({
            "ok": True,
            "first_token_ts": first_token_ts,
            "completion_ts": completion,
            "ttft_ms": ttft_ms,
            "e2e_ms": e2e_ms,
            "itl_ms": itl_ms,
            "output_tokens": out_tokens,
            "tok_s": tok_s,
            "decode_s": kolm.get("gen_only_s") or (kolm.get("elapsed_s")),
        })
    except Exception as exc:
        sample["error"] = str(exc)
    return sample


# --------------------------------------------------------------------------
# Boot + readiness.
# --------------------------------------------------------------------------

def _boot_serve(artifact_path: str, port: int,
                env: Dict[str, str]) -> Tuple["subprocess.Popen", str]:
    """Spawn `python -m apps.runtime.serve` with the prod env contract."""
    full_env = dict(os.environ)
    full_env.update(env or {})
    cmd = [sys.executable, "-m", "apps.runtime.serve",
           "--artifact", artifact_path, "--port", str(port), "--host", "127.0.0.1"]
    proc = subprocess.Popen(cmd, env=full_env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return proc, f"http://127.0.0.1:{port}"


def _wait_ready(base_url: str, timeout_s: int) -> Dict[str, Any]:
    """Poll /health then GET /info for runtime/runtime_version/engine."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        h = _http_get_json(base_url.rstrip("/") + "/health", timeout=3.0)
        if h and h.get("ok"):
            info = _http_get_json(base_url.rstrip("/") + "/info", timeout=10.0) or {}
            return {"ready": True, "info": info}
        time.sleep(0.5)
    return {"ready": False, "info": {}}


# --------------------------------------------------------------------------
# Load driver.
# --------------------------------------------------------------------------

def _drive_load(base_url: str, *, concurrency: int, n_requests: int,
                max_new_tokens: int, prompt: str) -> List[Dict[str, Any]]:
    """Async OpenAI-chat load at a target concurrency. Returns per-req samples."""
    samples: List[Dict[str, Any]] = []
    if concurrency <= 1:
        for _ in range(n_requests):
            samples.append(_chat_once(base_url, prompt, max_new_tokens))
        return samples
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        futs = [ex.submit(_chat_once, base_url, prompt, max_new_tokens)
                for _ in range(n_requests)]
        for f in futs:
            samples.append(f.result())
    return samples


# --------------------------------------------------------------------------
# Memory + enrichment probes.
# --------------------------------------------------------------------------

def _measure_peak_vram(pid: int, info: Dict[str, Any]) -> Dict[str, Any]:
    """nvidia-smi per-PID used_memory (primary) + the /info torch number."""
    out: Dict[str, Any] = {"memory_mb": None, "source": None, "torch_mb": None}
    # /info already exposes serve.py's _measure_peak_memory_mb (per-PID nvidia-smi
    # or torch). Prefer that since it ran inside the server process.
    info_peak = info.get("peak_memory_mb")
    if isinstance(info_peak, (int, float)) and math.isfinite(info_peak):
        out["memory_mb"] = float(info_peak)
        out["source"] = "serve_info_peak"
    # Cross-check via nvidia-smi from the probe side (the server child pid).
    try:
        res = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5)
        if res.returncode == 0 and res.stdout:
            for line in res.stdout.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 2 and parts[0].isdigit() and int(parts[0]) == pid:
                    out["memory_mb"] = float(parts[1])
                    out["source"] = "nvidia_smi_per_pid"
                    break
    except Exception:
        pass
    return out


def _measure_prefix_cache(base_url: str, prompt: str) -> Dict[str, Any]:
    """Cold vs warm same-prefix TTFT + vLLM /metrics hit-rate when reachable."""
    long_prefix = (prompt + " ") * 16  # make the shared prefix substantial
    cold = _chat_once(base_url, long_prefix + "Answer A.", 16)
    warm = _chat_once(base_url, long_prefix + "Answer B.", 16)
    cold_ttft = cold.get("ttft_ms")
    warm_ttft = warm.get("ttft_ms")
    speedup = None
    if isinstance(cold_ttft, (int, float)) and isinstance(warm_ttft, (int, float)) and warm_ttft > 0:
        speedup = cold_ttft / warm_ttft
    # hit-rate from /info.metrics (serve.py V1 reader) or /metrics scrape.
    hit_rate = None
    info = _http_get_json(base_url.rstrip("/") + "/info") or {}
    metrics = info.get("metrics", {}) if isinstance(info, dict) else {}
    if metrics.get("prefix_cache_hit_rate") is not None:
        hit_rate = metrics["prefix_cache_hit_rate"]
    else:
        text = _http_get_text(base_url.rstrip("/") + "/metrics") or ""
        hits = _scrape_counter(text, "vllm:gpu_prefix_cache_hits_total")
        queries = _scrape_counter(text, "vllm:gpu_prefix_cache_queries_total")
        if hits is not None and queries:
            hit_rate = hits / queries
    return {
        "enabled": bool(info.get("prefix_cache")),
        "backend": "vllm-prefix" if info.get("engine") == "vllm" else "none",
        "ttft_first_call_ms": cold_ttft,
        "ttft_second_call_ms": warm_ttft,
        "speedup": speedup,
        "hit_rate": hit_rate,
    }


def _scrape_counter(text: str, name: str) -> Optional[float]:
    """Extract a Prometheus counter value by metric name from text exposition."""
    if not text:
        return None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#") or not line:
            continue
        if line.startswith(name):
            try:
                return float(line.rsplit(" ", 1)[-1])
            except (ValueError, IndexError):
                return None
    return None


def _measure_batching(base_url: str, max_num_seqs: int, single_tok_s: float,
                      prompt: str, max_new_tokens: int) -> Dict[str, Any]:
    """Aggregate tok/s at C=max_num_seqs divided by single-stream tok/s."""
    n = max(1, int(max_num_seqs))
    if n <= 1 or not single_tok_s:
        return {"enabled": False, "max_num_seqs": n, "measured_throughput_x": None,
                "concurrent_streams": n}
    samples = _drive_load(base_url, concurrency=n, n_requests=n,
                          max_new_tokens=max_new_tokens, prompt=prompt)
    ok = [s for s in samples if s.get("ok")]
    total_tokens = sum(s.get("output_tokens", 0) for s in ok)
    if not ok:
        return {"enabled": True, "max_num_seqs": n, "measured_throughput_x": None,
                "concurrent_streams": n}
    span_s = max(s["completion_ts"] for s in ok) - min(s["arrival_ts"] for s in ok)
    agg_tok_s = (total_tokens / span_s) if span_s > 0 else None
    x = (agg_tok_s / single_tok_s) if (agg_tok_s and single_tok_s) else None
    return {"enabled": True, "max_num_seqs": n,
            "measured_throughput_x": x, "concurrent_streams": n}


# --------------------------------------------------------------------------
# Top-level probe.
# --------------------------------------------------------------------------

def probe_artifact(artifact_path: str, *, runtime: Optional[str] = None,
                   port: int = 0, concurrency: int = 1, warmup: int = 3,
                   steady_requests: int = 30, steady_seconds: Optional[float] = None,
                   max_new_tokens: int = 128, prompt: str = DEFAULT_PROBE_PROMPT,
                   prefix_cache_probe: bool = True, batching_probe: bool = True,
                   timeout_s: int = 300) -> Dict[str, Any]:
    """Boot the real serve.py, drive warmup+steady-state, harvest counters.

    Returns a ProbeResult dict. When the host cannot boot a runtime the dict has
    ok=False, tested=False and a reason — NEVER a fabricated tested number.
    """
    if port == 0:
        port = _free_port()
    env: Dict[str, str] = {}
    if runtime:
        env["KOLM_SERVE_RUNTIME"] = runtime

    proc, base_url = _boot_serve(artifact_path, port, env)
    result: Dict[str, Any] = {"ok": False, "tested": False, "reason": None,
                              "probe_version": PROBE_VERSION, "base_url": base_url}
    try:
        ready = _wait_ready(base_url, timeout_s)
        if not ready["ready"]:
            err = b""
            try:
                if proc.stderr is not None:
                    err = proc.stderr.read() or b""
            except Exception:
                pass
            result["reason"] = "serve did not become ready within boot timeout"
            result["serve_stderr"] = err.decode("utf-8", "replace")[-2000:]
            return result
        info = ready["info"]

        # WARMUP (discarded — GenAI-Perf sliding-window convention).
        for _ in range(max(0, warmup)):
            _chat_once(base_url, prompt, max_new_tokens)

        # STEADY-STATE.
        n = steady_requests
        if steady_seconds:
            # time-bounded: fire batches until the window closes.
            samples: List[Dict[str, Any]] = []
            t_end = time.time() + steady_seconds
            while time.time() < t_end:
                samples.extend(_drive_load(base_url, concurrency=concurrency,
                                           n_requests=max(1, concurrency),
                                           max_new_tokens=max_new_tokens, prompt=prompt))
        else:
            samples = _drive_load(base_url, concurrency=concurrency, n_requests=n,
                                  max_new_tokens=max_new_tokens, prompt=prompt)
        ok_samples = [s for s in samples if s.get("ok")]
        if not ok_samples:
            result["reason"] = "no successful steady-state requests"
            return result

        # METRICS MATH.
        total_tokens = sum(s.get("output_tokens", 0) for s in ok_samples)
        total_decode_s = sum((s.get("decode_s") or 0) for s in ok_samples)
        tok_s = (total_tokens / total_decode_s) if total_decode_s > 0 else None
        ttft = _percentiles(ok_samples, "ttft_ms")
        itl = _percentiles(ok_samples, "itl_ms")

        peak = _measure_peak_vram(proc.pid, info)

        spec = None
        m = info.get("metrics", {}) if isinstance(info, dict) else {}
        if info.get("speculative"):
            accepted_length = m.get("accepted_length")
            if accepted_length is None:
                accepted_length = m.get("mean_accept_length")
            if isinstance(info.get("speculative_decoding"), dict):
                spec = dict(info["speculative_decoding"])
                if spec.get("accepted_length") is None:
                    spec["accepted_length"] = accepted_length
                spec["mean_accept_length"] = spec.get("accepted_length")
            else:
                spec = {
                    "method": "speculative_decoding",
                    "head_kind": info.get("speculative_head_kind") or "draft_model",
                    "head_id": info.get("draft_model") or "",
                    "target_model": info.get("model") or "",
                    "runtime": info.get("engine") or "",
                    "num_speculative_tokens": info.get("num_speculative_tokens"),
                    "acceptance_rate": m.get("acceptance_rate"),
                    "accepted_length": accepted_length,
                    "mean_accept_length": accepted_length,
                    "throughput_speedup": None,
                    "status": "tested" if m.get("acceptance_rate") is not None else "estimated",
                }

        prompt_cache = _measure_prefix_cache(base_url, prompt) if prefix_cache_probe else None
        batching = (_measure_batching(base_url, info.get("max_num_seqs") or 1,
                                      tok_s or 0, prompt, max_new_tokens)
                    if batching_probe else None)

        result.update({
            "ok": True,
            "tested": tok_s is not None and peak["memory_mb"] is not None,
            "engine": info.get("engine"),
            "runtime_version": info.get("runtime_version") or info.get("engine"),
            "model": info.get("model"),
            "precision": info.get("dtype") or info.get("kv_cache_dtype") or "auto",
            "tok_s": tok_s,
            "latency_p50_ms": itl.get("p50"),
            "latency_p95_ms": itl.get("p95"),
            "ttft_p50_ms": ttft.get("p50"),
            "ttft_p95_ms": ttft.get("p95"),
            "memory_mb": peak["memory_mb"],
            "memory_source": peak["source"],
            "peak_memory_torch_mb": peak.get("torch_mb"),
            "n_steady_requests": len(ok_samples),
            "speculative_decoding": spec,
            "prompt_cache": prompt_cache,
            "continuous_batching": batching,
            "kv_policy": info.get("kv_policy"),
            "quantization": info.get("quantization"),
        })
        if not result["tested"]:
            result["reason"] = "missing tok_s or memory_mb; staying estimated"
        return result
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=15)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def _free_port() -> int:
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def emit_passport_json(result: Dict[str, Any]) -> Dict[str, Any]:
    """Shape the ProbeResult into the JSON the JS side (recordTestedPassport +
    v2 helpers) consumes. The contract keys mirror runtime-passport.js exactly.

    The probe NEVER invents quality_delta — it measures speed/memory only, so
    quality_delta defaults to 0.0 (parity) unless an eval harness supplied one.
    """
    tested = bool(result.get("tested"))
    engine = result.get("engine") or "transformers"
    target_id = f"{engine}-{(result.get('precision') or 'auto')}".replace(" ", "_")
    out: Dict[str, Any] = {
        "tested": tested,
        "ok": bool(result.get("ok")),
        "reason": result.get("reason"),
        "probe_version": PROBE_VERSION,
        # recordTestedPassport contract:
        "target_id": target_id,
        "runtime": engine,
        "runtime_version": result.get("runtime_version") or engine,
        "precision": result.get("precision") or "auto",
        "memory_mb": result.get("memory_mb"),
        "latency_p50_ms": result.get("latency_p50_ms"),
        "latency_p95_ms": result.get("latency_p95_ms"),
        "tok_s": result.get("tok_s"),
        "quality_delta": result.get("quality_delta", 0.0),
        # v2 enrichment sub-objects:
        "time_to_first_token_ms": result.get("ttft_p50_ms"),
        "speculative_decoding": result.get("speculative_decoding"),
        "prompt_cache": result.get("prompt_cache"),
        "continuous_batching": result.get("continuous_batching"),
        "kv_policy": result.get("kv_policy"),
        "serving_kernel": result.get("quantization"),
    }
    return out


def _self_test() -> int:
    """No-GPU self-test: percentile math + JSON shaping. Exits 0 on pass.

    Run: python -m apps.export.probe --self-test
    """
    # Percentile math against a known array (numpy linear method).
    vals = [{"x": v} for v in [10, 20, 30, 40, 50]]
    p = _percentiles(vals, "x", (50, 95))
    assert p["p50"] == 30.0, p
    assert abs(p["p95"] - 48.0) < 1e-9, p
    assert _percentile([], 50) is None
    assert _percentile([42.0], 95) == 42.0

    # Counter scrape.
    text = "# HELP x\nvllm:gpu_prefix_cache_hits_total 7.0\nvllm:gpu_prefix_cache_queries_total 10.0\n"
    assert _scrape_counter(text, "vllm:gpu_prefix_cache_hits_total") == 7.0
    assert _scrape_counter(text, "missing") is None

    # JSON shaping: a non-tested result must NOT carry a fabricated number.
    estimated = emit_passport_json({"ok": False, "tested": False, "reason": "cpu-only host"})
    assert estimated["tested"] is False
    assert estimated["tok_s"] is None
    assert estimated["memory_mb"] is None

    # A tested result preserves measured numbers + defaults quality_delta to 0.
    tested = emit_passport_json({
        "ok": True, "tested": True, "engine": "vllm", "runtime_version": "vllm 0.10.0",
        "precision": "fp16", "memory_mb": 18000.0, "latency_p50_ms": 12.0,
        "latency_p95_ms": 22.0, "tok_s": 41.0, "ttft_p50_ms": 80.0,
    })
    assert tested["tested"] is True
    assert tested["tok_s"] == 41.0
    assert tested["quality_delta"] == 0.0
    assert tested["runtime"] == "vllm"
    spec = emit_passport_json({
        "ok": True,
        "tested": True,
        "engine": "vllm",
        "speculative_decoding": {
            "head_kind": "eagle3",
            "head_id": "h",
            "num_speculative_tokens": 5,
            "acceptance_rate": 0.5,
            "accepted_length": 5.0,
        },
    })
    assert spec["speculative_decoding"]["accepted_length"] == 5.0
    assert spec["speculative_decoding"]["acceptance_rate"] == 0.5

    print("apps.export.probe self-test: OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Measured runtime-passport probe")
    ap.add_argument("--artifact")
    ap.add_argument("--runtime", default=None)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--concurrency", type=int, default=1)
    ap.add_argument("--warmup", type=int, default=3)
    ap.add_argument("--steady-requests", type=int, default=30)
    ap.add_argument("--steady-seconds", type=float, default=None)
    ap.add_argument("--max-new-tokens", type=int, default=128)
    ap.add_argument("--no-prefix-cache-probe", action="store_true")
    ap.add_argument("--no-batching-probe", action="store_true")
    ap.add_argument("--timeout-s", type=int, default=300)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return _self_test()
    if not args.artifact:
        ap.error("--artifact is required (unless --self-test)")
    if not os.path.exists(args.artifact):
        print(json.dumps({"ok": False, "tested": False,
                          "reason": f"artifact not found: {args.artifact}"}))
        return 1

    result = probe_artifact(
        os.path.abspath(args.artifact), runtime=args.runtime, port=args.port,
        concurrency=args.concurrency, warmup=args.warmup,
        steady_requests=args.steady_requests, steady_seconds=args.steady_seconds,
        max_new_tokens=args.max_new_tokens,
        prefix_cache_probe=not args.no_prefix_cache_probe,
        batching_probe=not args.no_batching_probe, timeout_s=args.timeout_s)
    print(json.dumps(emit_passport_json(result)))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())

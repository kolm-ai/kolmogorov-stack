# @kolmogorov/quantize-worker

Wave 195 (Q+5). Isolated kolm quantization worker. Lives in its own package so
the heavy ML deps (bitsandbytes, auto-gptq, optimum, torch, accelerate) NEVER
land in the root kolm install. The root `kolm` CLI invokes this worker only
when the tenant explicitly opts in via `kolm quantize --local-worker`.

## Install

Node side (no torch, no bitsandbytes; just the Node entrypoint):

```
cd workers/quantize
npm install
```

Python side (the heavy lifting; isolated venv, never bleeds into root):

```
cd workers/quantize
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Doctor

Confirm the toolchain is ready before quantizing:

```
node quantize.mjs --doctor
# or via the root CLI:
kolm quantize --local-worker --doctor
```

Exits 0 when at least one supported method is runnable. The JSON report includes
`ready_by_method` and `missing_by_method`, so operators can distinguish an
int4/int8 bitsandbytes install from a GPTQ or AWQ install.

## Supported methods

| method | backend       | notes                                       |
|--------|---------------|---------------------------------------------|
| int4   | bitsandbytes  | 4-bit weight quantization                   |
| int8   | bitsandbytes  | 8-bit weight quantization                   |
| gptq   | auto-gptq     | post-training quantization, calibration set |
| awq    | AutoAWQ       | activation-aware weight quantization        |

## Honest scope

kolm ships the quantization substrate: this Node entrypoint, method-specific
dependency detection, honest manifest emission, and the Python implementation
at `scripts/quantize.py`.

The heavy Python packages are still customer's opt-in. Running a quantization
method without the method's required Python stack writes a manifest with
`api_status: "toolchain_not_ready"` and exits 2. `--doctor` is the inspection
path; it exits 0 only when at least one method is ready, or when the requested
`--method` is ready.

The root `kolm` install has zero torch / bitsandbytes / auto-gptq deps. They
only enter the tree when an operator runs `npm install` + `pip install` inside
`workers/quantize/`. This is the opt-in, isolated-worker pattern shared with
`workers/distill/`.

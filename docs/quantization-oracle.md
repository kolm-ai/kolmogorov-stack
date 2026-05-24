# Kolm-Q Oracle

Kolm-Q is the quantization planner behind the compile/export/quantize surface.
It is not a benchmark and it does not claim a method is universally best.
It turns the user's constraints into a ranked, inspectable plan:

1. task risk: classification, extraction, redaction, chat, code, legal, medical, vision
2. model size and context length
3. target runtime and device memory
4. calibration availability
5. privacy mode and whether external research repos are allowed
6. quality floor and latency target

The current implementation lives in `src/quantization-oracle.js` and exposes:

- `rankQuantizationStrategies(profile)`
- `quantizationOracleCatalog()`

The CLI smoke harness is:

```bash
node scripts/quantization-oracle.mjs --task extraction --device rtx-4090-24gb --params-b 7 --context 8192 --calibration-rows 256
```

## Method Policy

| method | role | execution |
|---|---|---|
| fp16 | quality baseline | no worker |
| int8 | safe compression baseline | `kolm quantize --method=int8` |
| smoothquant | W8A8 serving plan | external toolchain |
| int4 | NF4 convenience path | `kolm quantize --method=int4` |
| gptq | calibration PTQ | `kolm quantize --method=gptq` |
| awq | activation-aware PTQ | `kolm quantize --method=awq` |
| hqq | calibration-free low-bit | `kolm quantize --method=hqq` |
| exl2 | CUDA runtime packing | `kolm quantize --method=exl2` |
| aqlm | low-bit research optimizer | worker plus repo checkout |
| quip | sub-2-bit research optimizer | worker plus repo checkout |
| qat | highest-quality trained quant | worker plus repo checkout |
| kivi_kv | KV-cache compression | runtime policy, not weight export |

## Promotion Rule

The oracle may recommend a method, but promotion still requires:

1. method-specific doctor passes
2. source model hash and calibration hash captured
3. output shard hashes captured
4. holdout eval passes after quantization
5. artifact manifest records method, bits, runtime, quality gate, and fallback

This is how we keep the product honest: the planner can optimize, but receipts
and holdout gates decide whether the artifact ships.

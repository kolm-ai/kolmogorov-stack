---
title: kolm runtime · kolm.ai
description: Per-call policy decider plus the runtime-target builder for cross-compile.
---

# kolm runtime

> Per-call policy decider plus the runtime-target builder for cross-compile. Two families: the policy ladder (W372) and the source-builder for `llama.cpp` (W219).

## Usage

### Policy ladder (W372)

```bash
kolm runtime status                                # current policy + 7d decision stats
kolm runtime policy   [--set key=value]            # inspect or tune the policy
kolm runtime start    [--policy <name>]            # switch policy
kolm runtime install  <art.kolm>                   # install a .kolm into the local runtime cache
kolm runtime decisions [--limit N]                 # recent per-call decisions
kolm runtime stats     [--since 7d]                # rolled-up stats
```

### Source-build (W219)

```bash
kolm runtime targets                               # list cross-compile targets
kolm runtime info <target>                         # target spec
kolm runtime doctor                                # toolchain check across all targets
kolm runtime build-from-source <target>            # compile llama.cpp from source
```

## Policy names

`local_first`, `frontier_first`, `cost_optimized`, `privacy_only`.

## Policy ladder

```
request -> privacy_check -> cache -> local_artifact -> cheaper_model -> frontier
```

Each rung either serves the call or passes. First non-skip wins. Decisions are written to `~/.kolm/runtime/decisions.jsonl` for replay and audit.

## Cross-compile targets

`cuda-89`, `cuda-90`, `cuda-100`, `cuda-120`, `rocm-gfx1100`, `rocm-gfx942`, `vulkan`, `metal`, `cpu-avx2`, `cpu-avx512`.

## Examples

```bash
kolm runtime status
kolm runtime policy --set cache_ttl_s=300
kolm runtime start --policy cost_optimized
kolm runtime decisions --limit 20

kolm runtime targets
kolm runtime doctor
kolm runtime build-from-source cuda-89
```

## See also

- [Quickstart](/quickstart)
- [Runtimes catalog](/runtimes)
- [Runtime guide](/docs/runtime)
- [kolm install-device](/docs/cli/install-device)

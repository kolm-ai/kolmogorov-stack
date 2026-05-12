# Sandbox Hardening Decision Memo

Date: 2026-05-12

Backlog target: RB-030, "What is the strongest near-term recipe sandbox?"

The row-level option matrix is `sandbox-option-matrix-2026-05-12.csv`.

## Current State

Kolm currently executes JS recipe code through `src/verifier.js` using `node:vm`, a denylist of dangerous strings, and a cooperative timeout. The code comments already warn that production should harden with `isolated-vm` or Wasmtime.

Official Node documentation is stronger: `node:vm` is not a security mechanism and should not be used for untrusted code.

## Decision

Short-term:

- Treat current JS recipes as trusted or curated code only.
- Keep `node:vm` for local/demo fixtures while adding claim gates that forbid "safe untrusted code" language.
- Add tests that prove forbidden identifiers are rejected, but do not treat those tests as sandbox proof.

Medium-term:

- Use a constrained recipe language or SES-style compartments for deterministic JS recipes where the artifact publisher is trusted.
- If JS compatibility must remain, evaluate `isolated-vm` only as a transitional improvement and run it under a separate worker process with memory limits and supervisor restart.

Long-term production trust boundary:

- Prefer Wasmtime/WASM for untrusted deterministic recipes.
- Use gVisor or Firecracker/Deno Sandbox for hosted arbitrary code, compile workers, or user-generated tool execution.

## Why Not Just `isolated-vm`

`isolated-vm` improves on `node:vm` but does not solve the whole threat model:

- it is still in-process relative to the Node host,
- its project page says it is in maintenance mode,
- V8 OOM or hostile workloads can crash the process,
- leaking host references can give untrusted code too much authority.

It can be a useful step only if paired with strict wrappers, no host-object leakage, resource limits, and an outer process/container boundary.

## Why Wasmtime Is The Better Artifact Boundary

Wasmtime and WebAssembly align with Kolm's artifact story:

- explicit imports,
- sandboxed linear memory,
- capability-based filesystem access through WASI,
- deterministic conformance testing,
- portable execution across local/server targets.

The cost is a recipe model change. Kolm would need to compile recipes to WASM, restrict recipes to a DSL, or embed a JS engine inside WASM. That is more work, but it is the right direction for public-registry or third-party recipe trust.

## Claim Implications

Safe wording:

- "Current recipe execution is suitable for curated recipe artifacts."
- "Production untrusted recipe execution requires a hardened runtime target."
- "WASM/Wasmtime is the preferred direction for public-registry untrusted recipes."

Unsafe wording today:

- "Run arbitrary customer code safely."
- "Public registry recipes are sandboxed."
- "No risk of code escape."
- "The JS sandbox is production-grade."

## Required Release Gates

1. Route all public-registry/user-submitted recipes through a trust policy before execution.
2. Add a recipe trust level to artifact metadata: `trusted`, `curated`, `customer-private`, `public-untrusted`.
3. For `public-untrusted`, require WASM or an external worker boundary before execution.
4. Add malicious recipe fixtures for process/env/fs/network/import/eval/constructor/async timeout attempts.
5. Add documentation that current v0 artifacts are recipe-tier and should run only trusted or curated recipe code.

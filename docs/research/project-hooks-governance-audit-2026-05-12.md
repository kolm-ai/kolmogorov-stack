# Project Hooks Governance Audit - 2026-05-12

## Executive Summary

`kolm.yaml` and lifecycle hooks are a powerful local automation surface. They can make Kolm feel native inside a repo: project-scoped artifacts, MCP naming, skill sidecars, run logs, compile hooks, run hooks, and benchmark hooks. They also execute arbitrary shell commands from a project file before and after compile/run/bench.

The current implementation is useful but should be treated as a preview-grade local automation layer, not as a governed policy layer. The schema, docs, and runtime disagree in several important places:

- The public schema requires fields and forbids unknown fields, but the runtime hand-parser accepts missing fields, ignores unknown fields, and performs no schema validation.
- The live schema says hook stdout JSON can modify the event, but the runtime only captures stdout for display and never applies `additionalContext` or `updatedInput`.
- Hooks run through `cmd /c` on Windows or `/bin/sh -c` on POSIX. Exit code `2` blocks, but all other failures, including timeout `124`, are advisory.
- `k_min` is defined as `0..1` in the schema, but current fixture K-score composites are in the hundreds. A documented `k_min: 0.85` does not meaningfully gate current artifacts.
- `allowed-tools` is parsed but not enforced. Generated skill sidecars hardcode `allowed-tools: []`.
- `mcp.transport` allows `sse`, while the implemented server supports stdio and optional HTTP JSON-RPC only.
- `kolm doctor` checks environment basics, but it does not verify installed harness config, MCP initialize/list, hook execution, `k_min`, or skill sidecar indexing despite live copy saying it verifies wiring.

## Primary Evidence

- Live `https://kolm.ai/build-your-own` returned HTTP 200 and describes `kolm.yaml` as the project mechanism for artifact globs, K-score gates, auto-attach paths, and hooks.
- Live `https://kolm.ai/docs/kolm-yaml-v0.1.json` returned HTTP 200. The schema requires `kolm_yaml_version`, `name`, and `artifacts`, sets `additionalProperties: false`, allows `mcp.transport` values `stdio`, `http`, and `sse`, caps artifact `k_min` at `1`, and defines hook items as strings.
- Local `src/project.js` hand-parses a subset of the schema. It defaults missing fields, ignores unknown fields, and parses only simple inline arrays for `paths` and `allowed_tools`.
- Local `src/hooks.js` hand-parses hooks and accepts strings, inline lists, and flow objects with `command` and `timeout_ms`.
- Local `src/hooks.js` executes hook commands through the platform shell with JSON on stdin. Only exit code `2` blocks; timeouts finish as exit code `124` and are treated as warnings by callers.
- Local `src/hooks.js` captures stdout/stderr but does not parse stdout JSON or mutate downstream hook payloads.
- Local `services/mcp/server.js` filters tools by `k_min`, but compares the floor directly to `info.k_score.composite`.
- Local `cli/kolm.js` emits `k_min: 0.85` in the generated `kolm.yaml` comments, while current fixture `kolm score` output reports composites in the hundreds.
- Local `cli/kolm.js` emits SKILL sidecars with `allowed-tools: []` and a guarantee that runtime egress is patched at the process boundary, but egress patching is currently benchmark-scoped, not `kolm run` scoped.
- `tests/` has no focused tests for `parseProjectYaml`, `parseHooksBlock`, `runHooks`, `kolm init`, `kolm doctor`, sidecar generation, `KOLM_HOOKS_OFF`, or `k_min` filtering.

## What Is Solid

The files are syntactically healthy. `node --check` passes for `src/hooks.js`, `src/project.js`, `services/mcp/server.js`, and `src/tune.js`.

The basic project bootstrap is real. `kolm init` writes `kolm.yaml`, creates `.kolm/artifacts` and `.kolm/skills`, and appends `.kolm/` to `.gitignore` in a git project. It does not create `examples/`, despite one public docs snippet saying that.

The hook executor has a clear minimal contract: JSON on stdin, project root as cwd, event name in `KOLM_HOOK_EVENT`, exit code `2` as block, and `KOLM_HOOKS_OFF=1` as an emergency bypass.

## Main Gaps

The largest governance issue is fail-open policy semantics. The product language uses hooks for enforcement, redaction, egress audit, staging promotion, and telemetry. In code, any hook failure except exit code `2` lets the operation proceed. That may be reasonable for notifications, but not for PreRun redaction, PreCompile policy, or compliance gating.

The second issue is contract drift. The schema is stricter than runtime in some places and weaker in others. Runtime supports hook flow objects that the schema rejects; schema advertises stdout event mutation that runtime ignores; schema allows SSE that runtime does not implement; schema caps `k_min` at a scale that current artifact scores do not use.

The third issue is untested side effects. Hooks are local arbitrary shell execution. That is acceptable only if the UX makes trust boundaries explicit, doctor can explain what will run, and CI has parser/executor tests to prevent drift.

## Recommended Policy

Treat `kolm.yaml` as a generated and validated contract:

- Add a schema validation command for project files.
- Use one parser for CLI, MCP, hooks, and sidecar generation.
- Split hook modes into `advisory` and `blocking`, or make all Pre* hook failures block by default.
- If stdout mutation is desired, define an explicit patch schema and test it. If not, remove the claim.
- Normalize K-score before applying `k_min`.
- Remove `sse` from the schema until implemented.
- Add `kolm doctor --hooks` or include hook/MCP/syntax/harness checks in normal doctor output.
- Emit skill sidecars from project artifact config, including `allowed-tools` if intentionally supported.

## Buyer Impact

Project hooks are an enterprise feature because they are where buyers enforce local policy. The near-term launch-safe framing is: "local hooks are preview automation; exit code 2 can block; review project files before running." The launch-ready version needs validated config, fail-closed policy modes, hook audit logs, and generated docs.


# Agent MCP Install Governance Audit

Date: 2026-05-12

Scope: local artifact MCP server, legacy SDK MCP server, `kolm serve --mcp`, `kolm install`, generated skill sidecars, hooks, local run logs, public docs, live integration pages, and tests.

## Executive Summary

Kolm has a real local MCP base: `services/mcp/server.js` can expose signed `.kolm` artifacts through JSON-RPC `tools/list` and `tools/call`, and a smoke run against `test/fixtures/sample.kolm` returned MCP text content plus a `_kolm` trailer. That is a good launchable core.

The governance problem is the surrounding integration claim surface. Live and local pages describe automatic discovery, SSE, token exchange, `.well-known/mcp.json`, repo-aware compiled specialists, zero runtime egress, K-score gates in a 0..1 scale, verified receipts on every call, and harness wiring that is broader than the current implementation. Several templates also point agents at commands that do not exist under the current root CLI.

The safe launch posture is narrower: "local stdio or localhost HTTP JSON-RPC MCP for signed artifact execution, installed manually through harness config, with signature verification on artifact load and per-call unsigned run metadata." Everything beyond that needs either implementation or explicit preview labeling.

## What Is Solid

- `kolm serve --mcp` is the only serve mode accepted by the CLI, and it imports `startMcpServer` from `services/mcp/server.js`.
- The MCP server implements `initialize`, `tools/list`, `tools/call`, and `ping`.
- `tools/list` discovers global `~/.kolm/artifacts` files and project `kolm.yaml` artifact globs.
- `tools/call` dispatches to `runArtifact` and returns output plus recipe id, latency, K-score, receipt metadata, and audit metadata.
- `kolm install` has preview and apply paths for `claude-code`, `cursor`, `continue`, and `cline`.
- `kolm init` emits `kolm.yaml`, `.kolm/artifacts`, `.kolm/skills`, and comments that align with the project-config loader.
- `PreCompile`, `PostCompile`, `PreRun`, `PostRun`, `PreBench`, and `PostBench` hooks exist and are invoked by the CLI.
- `node --check` passes for `services/mcp/server.js`, `cli/kolm.js`, and `src/project.js`.

## Evidence Highlights

### Artifact MCP Server

`services/mcp/server.js` is a direct JSON-RPC implementation. It has no dependency on the MCP SDK. It accepts line-delimited JSON over stdio, or HTTP POST to `/mcp` when `--http` is used. It binds HTTP to `127.0.0.1` and defaults to port `8765`.

The smoke command used the fixture directory as `KOLM_ARTIFACTS_DIR` and public fixture secret. `tools/list` returned five tools from `test/fixtures`, and `tools/call` for `sample` returned:

```json
{"content":[{"type":"text","text":"{\"upper\":\"HELLO\"}"}],"_kolm":{"recipe_id":"rcp_public_upper","latency_us":717}}
```

This proves the local MCP dispatch path exists.

### Install Harnesses

`kolm install claude-code` previews a write to `C:\Users\user\.claude\settings.json` with an `mcpServers.kolm` entry. `cursor` previews `.cursor/mcp.json`, `continue` previews an appended YAML block in `~/.continue/config.yaml`, and `cline` writes only an instructional Markdown rule.

That differs from several public docs that mention `~/.claude/mcp.json`, `.config/claude/mcp.json`, or automatic discovery.

### Skill Sidecars

`writeSkillSidecar` emits one Markdown sidecar per artifact. It uses Claude-style frontmatter and describes the backing MCP tool. W552 closed the no-project naming drift: global sidecars now use the plain `<artifact>` tool name, while project artifacts use `mcp__<project>__<artifact>`. `kolm compile --as-mcp` also creates a project `kolm.yaml` before writing the sidecar, so agent-indexed project skills point at the project-scoped MCP tool.

The sidecar frontmatter currently sets `allowed-tools: []` and `disable-model-invocation: false`. The `allowed_tools` field is parsed from `kolm.yaml` and surfaced in MCP metadata, but it is not enforced by the server.

### Public Claim Surface

The live integrations page says Claude Desktop MCP, Cursor, GitHub Actions, Python, Node, package-manager paths, and Claude Code skill are shipped. The live agentic-coding page says agents call a per-project signed artifact over MCP with zero runtime egress, K-score gating, deterministic behavior, and signed receipts. The local serve page goes further: automatic discovery without configuration, `127.0.0.1:7327`, `mcp/0.1 + sse`, `.well-known/mcp.json`, short-lived bearer-token exchange, and receipt output examples from `kolm serve --mcp support-triage.kolm`.

The implementation supports a smaller subset: stdio JSON-RPC and optional localhost HTTP JSON-RPC, no SSE, no `.well-known` file writer, no token exchange, no positional artifact argument handling, and no automatic discovery outside explicit client config.

## Highest-Risk Gaps

### Runtime Egress Claim

`src/benchmark.js` patches `fetch`, `http`, `https`, `net`, `tls`, and `dns`, but `services/mcp/server.js` calls `runArtifact` directly. `runArtifact` does not install the egress monitor. Recipe code still goes through `compileJs`, which blocks dangerous identifiers and runs in `node:vm`, but the public wording says the harness patches runtime egress before any recipe runs. That statement only matches the benchmark path.

### Per-Call Receipt Claim

The MCP `_kolm.receipt` object returned by `runArtifact` is an `rs-1-run` metadata object with artifact job id, recipe id, version id, and run time. It is not HMAC-signed per call. The signed artifact-level `receipt.json` exists in fixtures, but public copy that says every MCP answer carries a verified HMAC chain over the call is ahead of the runtime.

### K-Score Scale Drift

Public docs and project schema talk about a 0..1 K-score gate, commonly `0.85`. Fixture manifests exposed through MCP currently show `composite` values like `424.57`. The `k_min` filter compares those raw values directly against thresholds like `0.85`, so serve-time gating can appear to work while allowing scale-drifted scores.

### Missing MCP Logs

`cli/kolm.js` says `kolm logs` includes MCP `tools/call`, but `services/mcp/server.js` does not call `appendRunLog`. CLI `run` and `bench` append rows; MCP calls do not.

### CLI Verb Drift

The live Claude and Cursor templates mention `kolm query` and `kolm verify`. The root CLI dispatch has `rag query`, `inspect`, `eval`, `run`, and `score`, but no top-level `query` or `verify` commands. Agents following those templates will fail.

### Legacy MCP Package Drift

`sdk/mcp` is still a cloud-oriented MCP package that imports the legacy scoped cloud SDK, uses `RECIPE_API_KEY`, exposes `recipe_synthesize` and `recipe_run`, and includes specialist tools plus legacy naming. The live integration page points users to `kolm serve --mcp` for artifact MCP. These are different integration products and should be separated or retired.

## Test And Governance Gaps

Existing tests cover artifact load, eval, benchmark, egress in benchmark, and one audit callback shape. They do not cover:

- MCP `initialize`, `tools/list`, `tools/call`, error responses, or HTTP transport.
- `kolm install` output for each harness.
- `kolm doctor` validating installed harness config.
- `kolm.yaml` project artifact discovery and `k_min` gating with normalized K-score.
- MCP run logging.
- sidecar tool-name correctness.
- public docs templates using only existing CLI commands.

## Recommended Launch Contract

Use this wording until implementation catches up:

> `kolm serve --mcp` exposes local signed `.kolm` artifacts as MCP tools over stdio, with optional localhost HTTP JSON-RPC. Configure your MCP client with `kolm install <harness> --apply` or by adding the command manually. Artifact signatures are verified when loaded; each call returns deterministic output plus run metadata.

Avoid claiming:

- automatic discovery without configuration,
- SSE support,
- `.well-known/mcp.json`,
- short-lived bearer exchange,
- verified HMAC receipt chain on every MCP call,
- egress patching for MCP runtime calls,
- non-existent `kolm query` or `kolm verify` commands,
- a 0..1 K-score gate until fixture and manifest scoring are normalized.

## Validation Performed

- `node --check .\services\mcp\server.js`
- `node --check .\cli\kolm.js`
- `node --check .\src\project.js`
- `tools/list` smoke through `services/mcp/server.js` using `test/fixtures`
- `tools/call` smoke for `sample.kolm`
- `kolm install` preview for `claude-code`, `cursor`, `continue`, and `cline`
- live fetches of `https://kolm.ai/integrations`, `https://kolm.ai/use-cases/agentic-coding`, `https://kolm.ai/docs`, `https://kolm.ai/docs/claude-skill.md`, and `https://kolm.ai/docs/cursor-rules.txt`

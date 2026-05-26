# CLI policy (canonical) — W890-11

This document is the canonical reference for the `kolm` CLI surface. It is the
source of truth for: top-level `--help` shape, the `--json` contract, the
`--no-color` contract, exit codes, progress indicators, the `version` output,
shell completions, and the cold-start budget.

The W890-11 audit reads this document and the ten `data/w890-11-*.json`
artifacts to ratify the contract. Every lock-in in `tests/wave890-11-cli.test.js`
traces back to one of the eleven W890-11 directive items below.

## Scope

- The single CLI entrypoint at `cli/kolm.js` (51,995 LoC monolith — see
  `data/w890-1-loc-exceptions.json` row `cli/kolm.js`,
  `planned_split: "next-major"`).
- All top-level verbs listed in the `COMMANDS` section of `kolm --help`.
- The shell completion scripts emitted by `kolm completion <bash|zsh|fish>`.

Not in scope: the TUI surface (covered by W890-7) and the SDKs (W890-9).

## 1. Top-level `--help` shape

Running `kolm --help` (or `kolm` with no args) MUST print:

1. A one-line product description on the first line.
2. A `PRODUCT LOOP` section that describes the high-level pipeline.
3. A `USAGE` block: `kolm <command> [args...]`.
4. A `COMMANDS` block listing every top-level verb with a single-line
   description. Each line begins with two spaces and a verb token.
5. An `ENVIRONMENT` block listing the recognized `KOLM_*` env vars.

The W890-11 help-coverage audit
(`data/w890-11-help-coverage.json`) parses the `COMMANDS` block and asserts
`missing_help.length === 0` — every parsed verb must respond to `--help`.

**Snapshot:** 85 top-level verbs / 85 with help.

## 2. Per-verb `--help` shape

Every per-verb `kolm <verb> --help` SHOULD include:

- **Description** — `kolm <verb> - <one-line description>` on the first line.
- **USAGE** — at least one shape line `kolm <verb> [args]`.
- **Flags / Options** — either an explicit `OPTIONS` or `FLAGS` section, OR
  (for sub-verb dispatchers like `seeds`, `tunnel`, `ir`) a `SUBCOMMANDS`
  block, OR an enumeration of sub-verb lines.
- **Examples** — at least one runnable `kolm <verb> ...` line.

The W890-11 quality audit
(`data/w890-11-verb-help-quality.json`) samples 25 verbs and lists the
weakest entries. `weakest.length` must be ≤ 5 (some verbs are intentionally
terse because their entire surface is a one-shot scaffold or sub-dispatcher).

**Snapshot:** 25 sampled / weakest = 3.

## 3. The `--json` contract

A verb supports `--json` if either:

1. Passing `--json` directly emits a parseable JSON document to `stdout`, OR
2. A primary sub-verb (e.g. `kolm <verb> list --json`,
   `kolm <verb> status --json`) emits parseable JSON, OR
3. The verb's `--help` page explicitly documents `--json` support.

JSON output goes to `stdout`. Errors, progress, and human-readable
diagnostics go to `stderr`. The body MUST be valid UTF-8 JSON (pretty-printed
with 2-space indent is canonical; one-line compact is also acceptable for
stream-style verbs).

Verbs that intentionally **do not** support `--json` (and are exempt from the
audit's `candidates` set):

- Interactive: `tui`, `chat`, `repl`, `quickstart`, `login`, `signup`.
- Scaffolding/install: `init`, `init-agent`, `install`, `install-device`,
  `new`, `wrap`, `shell-init`, `completion`.
- Long-running compute that streams progress: `compile`, `distill`, `train`,
  `quantize`, `build`, `run`, `eval`, `bench`, `benchmark`, `serve`, `tune`,
  `instant`, `improve`, `verify`, `inspect`, `diff`, `export`, `publish`,
  `pull`, `import-chat`, `anonymize`, `score`, `fix`, `explain`,
  `sigstore-attest`, `attest`.
- Natural-language: `do`, `ask`, `nl`.
- Maintenance: `upgrade`, `update`, `self-update`.
- Spawn / repeat: `loop`, `agent`.

The W890-11 JSON-flag audit (`data/w890-11-json-flag.json`) asserts
`missing.length ≤ 5`. **Snapshot:** 42 of 44 candidates support `--json`; 2
missing (`ir`, `auditor`) — both are sub-dispatchers whose leaf verbs already
support `--json` (`kolm ir compile --json`, `kolm auditor verify --json`).

## 4. The `--no-color` contract

Every verb MUST suppress ANSI escape sequences when ANY of the following are
true:

1. `NO_COLOR=1` is set in the environment (the `no-color.org` convention).
2. `FORCE_COLOR=0` is set in the environment (Node-ecosystem opt-out).
3. The `--no-color` flag is present.
4. The output is not a TTY (e.g., piped or redirected).

Internally, the CLI strips `--no-color`, `--no-unicode`, and `--plain` from
`argv` before dispatch so verb code paths see a normalized argument list.

The W890-11 no-color audit (`data/w890-11-no-color-flag.json`) samples 12
verbs and asserts no ANSI escapes leak into `stdout` or `stderr` under
`NO_COLOR=1`. **Snapshot:** 0 verbs leaking color.

## 5. Exit codes

The canonical codes are exported in `cli/kolm.js` as the `EXIT` constant:

| Code | Symbol           | Meaning                                                                                                |
|------|------------------|--------------------------------------------------------------------------------------------------------|
| 0    | `OK`             | success                                                                                                |
| 1    | `BAD_ARGS`       | unknown command / unknown flag / missing required arg / usage error                                    |
| 2    | `GATE_FAIL`      | artifact built but K-score below gate (CI-actionable)                                                  |
| 3    | `MISSING_PREREQ` | environment-level miss (no docker, no api key, not logged in)                                          |
| 4    | `EXECUTION`      | the command ran but failed at runtime (run/eval/distill threw)                                         |
| 5    | `NOT_FOUND`      | file/artifact/resource not present on disk or server                                                   |
| 64   | `USAGE`          | sysexits-style alias of `BAD_ARGS` for code paths predating the canonical names                        |

**Contract:** success returns 0, every failure returns non-zero. The
W890-11 exit-code audit (`data/w890-11-exit-codes.json`) samples 10 success
cases and 5 failure cases and asserts
`all_success_zero === true && all_failure_nonzero === true`.

## 6. Progress indicators

Long-running verbs (compile, distill, bench, deploy, train, quantize, build)
MUST emit at least one progress signal so the user can tell the CLI is still
working. Acceptable signals (in order of preference):

1. Numbered step lines `[N/M] <stage>` (matches the `kolm build` pipeline).
2. A spinner driven by `process.stdout.write('\r' + state + char)` (matches
   `cmdCloud` polling).
3. `on_progress: ({ stage, pct }) => ...` callbacks from src/*.js workers
   (matches `cmdCompile` -> `compile-pipeline.js`).
4. Per-epoch / per-case status lines (matches `cmdBenchmark` ->
   `benchmarkArtifact` runs loop).

The W890-11 progress audit (`data/w890-11-progress-indicators.json`) scans
each long verb's body and the downstream `src/*.js` modules it dispatches to
for one of these signals.

**Snapshot:** 7 long verbs / 7 with progress signals.

`kolm run` is NOT a long verb — it executes a single artifact against a
single input and finishes sub-second; no progress required.

## 7. Ctrl+C handling

The CLI registers `SIGINT` and `unhandledRejection` handlers at the top of
`cli/kolm.js` (W890-3). On `Ctrl+C` the CLI MUST:

1. Print a single structured line (no half-rendered progress bar).
2. Clean up any orphan child processes spawned via `spawnSync` / `spawn`.
3. Exit with code 130 (`128 + SIGINT`) — the POSIX convention.
4. Not corrupt any on-disk state (config writes, artifact builds, etc. are
   transactional or use temp+rename).

W890-3 verified the handlers ship in `cli/kolm.js` lines 97-103. The Ctrl+C
behavior is exercised by `tests/wave890-3-process-handlers.test.js`.

## 8. `kolm version` output

The plain `kolm version` (no `--json`) emits one line per field:

```
  k o l m
  ─────── the private AI compiler

kolm cli   v<version>
spec       rs-1
node       <node-version>
git        <12-char-commit-sha>
python     <python-version-or-"(not installed)">
kolm cloud v<cloud-version>  (<base> lib=<lib-version> region=<region>)
```

`kolm version --json` emits a single JSON envelope with the same fields plus
`platform`, `arch`, `base`, `airgap`, and a `cloud` sub-object.

Resolution:

- **CLI version**: hard-coded `VERSION` constant in `cli/kolm.js`.
- **Git commit**: read from `<repo>/.git/HEAD` and the ref file it points
  to (no `git` binary required — the resolver also walks `packed-refs`).
- **Node version**: `process.versions.node`.
- **Python version**: `python --version` (Windows) or `python3 --version`
  (POSIX), parsed for the `Python X.Y.Z` line.

The W890-11 version audit (`data/w890-11-version-output.json`) asserts
`has_version && has_git && has_node && has_python`.

**Snapshot:** all four resolve on a developer box with `.git/` and Python on
PATH.

## 9. Shell completions

`kolm completion <bash|zsh|fish>` emits a completion script suitable for
shell-specific install paths:

- **Bash**: `kolm completion bash >> ~/.bashrc`
- **Zsh**: `kolm completion zsh > ~/.zsh/completions/_kolm` (ensure
  `~/.zsh/completions` is on `$fpath` and run `compinit`)
- **Fish**: `kolm completion fish > ~/.config/fish/completions/kolm.fish`

Each script covers all top-level verbs and the well-known sub-verbs (e.g.
`team create|list|invite|...`). The lists in the completion scripts are
hand-maintained — if you add a verb to `kolm`, add it to the three completion
scripts as well.

The W890-11 completions audit (`data/w890-11-completions.json`) emits each
shell's script and asserts the existence and shape of the completion verb
itself.

**Snapshot:** all three shells supported.

## 10. Cold start budget

`kolm --help` MUST complete in under 500 ms on a developer box. The W890-11
cold-start audit (`data/w890-11-cold-start.json`) runs five samples and
asserts `p95_ms < 500`.

**Snapshot:** mean=70ms, p95=77ms.

The cold-start budget is the user-visible response time for the most common
"what does this CLI do?" interaction. Anything heavier (network, file scans
beyond a single `--help` build) MUST be gated behind an explicit verb.

## 11. Missing-dependency error messages

When a verb requires a runtime dependency that isn't installed, the error
MUST contain at least one of:

- An `install:` instruction with a concrete command.
- A package-manager command (`pip install ...`, `npm install ...`,
  `brew install ...`, `apt install ...`, `winget install ...`).
- A URL to the dep's install page.
- A pointer to a kolm bootstrap verb (`kolm login`, `kolm signup`,
  `kolm init`, `kolm setup`, `kolm quickstart`, `kolm doctor`,
  `kolm gpu setup`).

Examples that satisfy the contract:

- `python not found on PATH — install: https://www.python.org/downloads/ (or `brew install python` / `apt install python3` / `winget install Python.Python.3.12`)`
- `not logged in. → Run: kolm login`
- `not on PATH (needed for: kolm bench --reproduce). install: winget install Docker.DockerDesktop`

The W890-11 dep-error audit
(`data/w890-11-dep-error-messages.json`) samples 4 scenarios and asserts
`includes_install_instruction === true` for every test row.

**Snapshot:** all 4 tests include install hints.

## Update procedure

1. Add or change a verb in `cli/kolm.js`.
2. If it's a new top-level verb, add it to all three completion scripts
   (`cmdCompletionBash`, `cmdCompletionZsh`, `cmdCompletionFish`).
3. Run `node scripts/w890-11-audit.cjs` to regenerate the 10 data artifacts.
4. Run `node --test tests/wave890-11-cli.test.js` to confirm no regressions.
5. Run the ship-gate (`kolm test ship-gate`) to confirm 52/52 still green.

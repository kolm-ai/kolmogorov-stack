# Code Quality Policy

Scope: every JavaScript / Python file under `src/`, `cli/`, `workers/`,
`scripts/`, and `tests/`. This policy is the canonical reference enforced by
the W890-2 sub-wave audit (ledger row in
`KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md` Part K-3) and the lock-in tests in
`tests/wave890-2-code-quality.test.js`.

## What the checkers run

### JavaScript / Node — ESLint flat config

- Config file: [`eslint.config.js`](../../eslint.config.js) at the repo root.
- Scope: `src/**/*.js`, `cli/**/*.js`, `tests/**/*.js`, `workers/**/*.{js,mjs}`,
  and `scripts/**/*.{cjs,js,mjs}`.
- Ignored: `public/`, `data/`, `coverage/`, `apps/trainer/` (Python),
  `packages/vscode-kolm-rag/` (TypeScript, separate config), `sdk/python/`,
  `sdk/rust/`, `sdk/c/`, `node_modules/`, `dist/`, `build/`, minified files.
- Rules (all `error`, no autofix): `no-undef`, `no-unused-vars` (with `_`
  prefix exempt), `eqeqeq` (with `null` ignore), `no-var`, `no-unreachable`,
  `no-dupe-keys`, `no-dupe-args`, `no-cond-assign`, `no-constant-condition`
  (with `checkLoops: false`).
- Style rules are intentionally OFF (no `semi`, `quotes`, `indent`).
  Style is a convention not a gate; if you want to enforce style, that
  belongs to a separate sub-wave (W890-3+).

Command (lint + autofix):

```
npx eslint --fix src/ cli/ workers/
```

Command (lint only, JSON output for the audit):

```
npx eslint src/ cli/ workers/ --format=json > data/_eslint.json
```

### Python — Ruff

- Config: defaults only (no `pyproject.toml` or `ruff.toml` in the repo).
- Scope: `workers/`, `scripts/`.
- Common findings: `F401` (unused import), `E401` (multiple imports on one
  line), `F841` (unused local variable).
- Availability-probe variables that bind the result of an import-availability
  check (e.g., `transformers = _require("transformers", ...)`) should annotate
  the binding with a `# noqa: F841 — <reason>` comment.

Command (lint + autofix):

```
ruff check --fix workers/ scripts/
```

Command (lint only):

```
ruff check workers/ scripts/ --output-format=json
```

## Style conventions

These conventions are **descriptive** of the dominant codebase style, not
ESLint-enforced. New code should follow them; existing code is migrated
incrementally.

| Rule | JS | Python |
| --- | --- | --- |
| Indentation | 2 spaces | 4 spaces |
| Strings | single quotes (dominant) | per PEP 8 |
| Semicolons | always (convention) | n/a |
| Function names | `camelCase` | `snake_case` |
| Constants | `UPPER_SNAKE_CASE` or grouped in a `const` object | `UPPER_SNAKE_CASE` |
| Private helpers | leading `_` prefix exempt from unused-var rule | leading `_` prefix exempt from unused-var rule |

Measured adherence at W890-2 ratification:

- JS naming (camelCase or constant style): 94.76% across a 20-file sample
- Python naming (snake_case or `UPPER_SNAKE_CASE`): 100% across the full
  Python population.

## Logging policy

The `src/log.js` module is the canonical structured-logging wrapper. New code
in `src/` should use `getLogger(tag)` from `src/log.js` rather than
`console.{log,warn,error}` directly. Existing `console.*` calls fall into one
of these acceptable categories (see `data/w890-2-console-log.json` for the
ratified classification):

- `cli_emit` — CLI / worker entry-point stdout output (legitimate; users
  parse this output);
- `service_lifecycle` — server startup or shutdown banner in
  `src/services/*` (legitimate; one print per process lifecycle event);
- `embedded_template` — `console.log` literal appears inside a string
  template that is emitted to a generated script (not actually executed in
  the host process);
- `module_load` — one-time banner at import time (e.g., schema migrations).

A console.log occurrence that does NOT fit one of those four categories is
classified `debug_print` and should be migrated to `getLogger(...)` in
W890-4 (logging sub-wave).

## Console.log gate

Counts at W890-2 ratification: 4258 console.log occurrences across 11 files
in `src/` + `cli/` + `workers/`. Zero classified as `debug_print`.

## TODO / FIXME / HACK / XXX policy

Every marker comment must have an owner reference, one of:

- `TODO(W<wave>-...)` — a wave reference (preferred);
- `TODO(@<github-handle>)` — a person reference;
- `TODO https://...` — a tracking-URL reference (acceptable when the
  upstream doc is the source of truth, e.g., a vendor API doc).

Orphan markers (no owner reference) are scrubbed each sub-wave audit. The
inventory lives in `data/w890-2-todos.json`. Inline string-template emissions
that contain "TODO" as part of user-facing generated content (e.g.,
docker-compose stubs) are classified `user_facing_template` and not counted
as orphans.

## Secrets gate

`production_real_keys` MUST be 0. The scanner at
`scripts/_w890-2-secrets-scan.cjs` classifies every match as one of:

- `review_required` — looks real; humans must verify;
- `placeholder` — `sk-test-`, `sk-xxx`, `sk-ant-...` with ellipsis, etc.;
- `docs_help_text` — instructional shell snippet inside CLI help / docs;
- `env_ref_nearby` — line uses `process.env` or `os.environ` to load;
- `eval_corpus_fixture` — synthetic PII-eval prompt in `src/bench-*`;
- `test_fixture` — under `tests/`.

The scanner output is `data/w890-2-secrets-scan.json`. If
`production_real_keys > 0` after the audit, the offending key must be
rotated and removed from version control before ship.

## Localhost / loopback gate

`production_unconfigured` MUST be 0 in `data/w890-2-localhost-scan.json`.
Acceptable classifications for matched hosts (`localhost`, `127.0.0.1`,
`0.0.0.0`) are:

- `loopback_allowlist` — explicit allowlist for airgap mode;
- `loopback_bind` — `server.listen(port, '127.0.0.1', ...)`;
- `derived_base_url` — base URL built from a bound port;
- `local_provider_default` — Ollama / vLLM / kolm-local-teacher default;
- `env_default` — second-arg fallback to `env('FOO', 'http://127.0.0.1:...')`;
- `env_configurable` — line dereferences `process.env.` or `os.environ`;
- `cli_default_arg` — CLI `--host` / `--port` / `--bind` default;
- `compose_template` — docker-compose YAML emitted to user;
- `docs_help_text` — CLI help string / curl example / TUI menu item;
- `comment` — comment line;
- `log_message` — embedded inside a status / hint / changelog string;
- `subprocess_call` — shell command run against the local device;
- `hostname_check` — equality test against the host string;
- `fn_default_param` — function-parameter default;
- `assertion_message` — refusal / "must be localhost" message.

## Adding a waiver

When ESLint flags a line that the code legitimately requires (a deferred
fix, a vendor SDK quirk, etc.), add a single-line disable directive with a
mandatory reason:

```
// eslint-disable-next-line no-unused-vars -- <wave-ref or short reason>
```

ESLint's `reportUnusedDisableDirectives` is implicit in the flat config; an
unused disable directive itself becomes a warning and is autofixed away on
the next `--fix` run. Do not write file-level disables without a wave
reference — the audit treats those as orphans.

For Ruff:

```
foo = _require("foo", "pip install foo")  # noqa: F841 — availability probe
```

## How the audit runs

The W890-2 sub-wave audit is mechanical and re-runnable:

```
# 1. Lint
npx eslint --fix src/ cli/ workers/
ruff check --fix workers/ scripts/

# 2. Inventory
node scripts/_w890-2-console-log-scan.cjs
node scripts/_w890-2-todo-scan.cjs
node scripts/_w890-2-secrets-scan.cjs
node scripts/_w890-2-localhost-scan.cjs
node scripts/_w890-2-style-scan.cjs

# 3. Lock-ins
node --test tests/wave890-2-code-quality.test.js
```

## Constraints / caveats

- No new dependencies are introduced by W890-2; lint runs only the tools
  already present (ESLint flat config, Ruff with defaults).
- No new lint rules are introduced; the existing seven correctness rules in
  `eslint.config.js` are the entire JS gate.
- The five monolith files documented in
  `data/w890-1-loc-exceptions.json` are NOT split by W890-2 (next-major
  scope per W890-1 ledger).
- The `no-unused-vars` error count (1012 at the W890-2 ratification point)
  is tracked but not auto-deleted by the autofixer; manual triage continues
  in a follow-up sub-wave.

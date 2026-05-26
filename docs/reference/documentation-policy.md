# Documentation Policy

Canonical reference for the W890-12 audit. Consolidates the README contract,
CHANGELOG cadence, LICENSE choice, CONTRIBUTING expectations, docs-accuracy
gate, code-example test policy, API-reference sync rules, and SDK coverage
expectations.

This document is generated alongside ten `data/w890-12-*.json` artifacts via
`node scripts/w890-12-documentation-audit.cjs`. The artifacts are the source
of truth; this file is the human-readable summary.

Cross-references:

- `docs/reference/codebase-organization.md` (W890-1)
- `docs/reference/code-quality-policy.md` (W890-2)
- `docs/reference/error-handling-policy.md` (W890-3)
- `docs/reference/logging-policy.md` (W890-4)
- `docs/reference/configuration-policy.md` (W890-7)
- `docs/reference/config-toml.md` (W889-12.1)
- `docs/reference/storage-policy.md` (W890-8)

## 1. README contract

`README.md` lives at the repository root. It is the single landing page a
new contributor or user reads first. Every release-eligible build must
satisfy the four README gates:

1. **What is kolm?** First paragraph names the product, the primary verb
   (compile / wrap / sign), and the artifact (`.kolm`).
2. **Quickstart.** First fenced code block contains at least three commands
   a user can copy-paste from a pristine shell. The first command installs
   or invokes the binary; the second produces an artifact; the third runs
   it. The audit shells out `node cli/kolm.js version` and verifies it
   prints a non-empty version string before declaring the quickstart
   working.
3. **Docs link.** A clickable path to `public/docs/` or `kolm.ai/docs`.
4. **License callout.** Apache-2.0 + link to `LICENSE`.

Anti-patterns that fail the README gate:

- "Coming soon" placeholders.
- Code blocks that reference a binary not on `bin/` or `cli/`.
- A quickstart that hard-depends on a remote secret (frontier API key)
  without saying so up front.
- A claim ("we ship", "we have") that does not trace to a tested file.

See `data/w890-12-readme.json` for the audit shape.

## 2. CHANGELOG cadence

Two surfaces:

| Surface                    | Audience               | Source of truth |
|----------------------------|------------------------|-----------------|
| `public/changelog.html`    | end-users + customers  | rendered from `data/changelog.json` |
| `CHANGELOG.md` (repo root) | contributors + GitHub  | hand-curated mirror |

Cadence: every shipped wave (W-number) appears in both surfaces before
the next wave starts. Each entry references:

- The wave id (`W888`, `W890-12`).
- The shipped artifact list (audit JSON paths, policy doc paths).
- The lock-in test file path.
- The visible user-facing change (one line, present tense).

The audit (`data/w890-12-changelog.json`) tracks `missing_waves[]`: any
wave from the recent batch (currently `W888-*`, `W889-*`, `W890-*`) that
does not appear in either surface. A non-empty `missing_waves[]` blocks
release unless the entry is annotated as deferred in
`deferred_note`. The root `CHANGELOG.md` is regenerated at the close of
each batch; sub-wave entries may lag the public HTML by up to one batch.

## 3. LICENSE

The project ships under **Apache-2.0**. Three places must agree:

1. `LICENSE` (full text, copyright notice).
2. `package.json` `"license"` field (SPDX id `Apache-2.0`).
3. `README.md` license callout.

The audit (`data/w890-12-license.json`) extracts the SPDX id from the
LICENSE body and compares it to `package.json.license`. A mismatch is a
shipping blocker. A contribution that introduces a file with a more
restrictive license (GPL, AGPL, proprietary) must be rejected — the audit
does not scan per-file headers but the CONTRIBUTING text covers the
intent.

## 4. CONTRIBUTING expectations

`CONTRIBUTING.md` lives at the repository root and covers four contracts:

- **Recipe submissions** — how to add a row to the public registry.
- **Bug + feature reports** — the issue intake template.
- **Code contributions** — discuss-first norms for CLI / spec / verifier
  changes, no new external deps without an Architecture note, em-dash
  ban in load-bearing copy.
- **Code of conduct** — Contributor Covenant 2.1 link.

The audit (`data/w890-12-contributing.json`) verifies the file exists and
includes a PR process, a test-instructions section, and a code-of-conduct
link.

## 5. Docs-accuracy gate

Every `kolm <verb>` mention in user-facing docs must trace to a real
verb dispatched by `cli/kolm.js`. The audit:

1. Lists known verbs by combining the COMMANDS section of `kolm --help`
   with every `case '<verb>':` label in `cli/kolm.js`.
2. Walks a curated sample of user-facing docs (README, `docs/PRODUCT.md`,
   `public/docs/quickstart.html`, `public/docs/api.html`,
   `docs/reference/*`, `AGENT_GUIDE.md`).
3. Extracts every \`kolm \<verb\>\` mention and validates the verb is
   real.

The accuracy gate is satisfied when `stale.length ≤ 8` (audit nits OK).
The remaining stale references in scope today are:

- `docs/PRODUCT.md` — explicit "Deferred (v7.6+)" annotation for
  `kolm tune`, `kolm registry`, `kolm bridge`. Forward-looking, not stale.
- `public/docs/api.html` — three references in route-source comments
  (`kolm connectors`, `kolm recall`, `kolm training`) that derive from
  `src/router.js` comments. Fix-up is W890-9 (api-policy) scope.

See `data/w890-12-docs-accuracy.json` for the full sample.

## 6. Code-example test policy

Every executable code block in a Markdown doc must either:

- Match a safe-runner pattern the audit can shell out, OR
- Be tagged with a comment indicating it is illustrative-only (e.g. requires
  a frontier API key, requires a GPU, requires a registered tenant).

Safe runners in scope today:

| Runner tag       | Match pattern                 | Expected to                          |
|------------------|-------------------------------|--------------------------------------|
| `kolm-version`   | `kolm version`                | exit 0, print a vX.Y.Z line          |
| `kolm-help`      | `kolm --help` or `kolm help`  | exit 0, contain `COMMANDS`           |
| `kolm-list`      | `kolm list`                   | exit 0 or `No artifacts`             |
| `kolm-doctor`    | `kolm doctor`                 | emit JSON with `ok` or `checks`      |
| `node-eval-1+1`  | `node -e "console.log(...)"`  | exit 0                               |

The audit gate is `broken_blocks.length ≤ 5`. The remaining executable
blocks (curl invocations against `localhost:8787`, frontier-key-gated
flows, multi-stage compile + run pipelines) are not in the safe-runner
set — they get a manual smoke pass during release-verify.

## 7. API reference sync

Two surfaces describe the HTTP API:

| Surface                            | Format            | Audience                |
|------------------------------------|-------------------|-------------------------|
| `public/openapi.json`              | OpenAPI 3.x       | machine-readable        |
| `public/docs/api.html`             | rendered HTML     | human-readable          |

The audit normalizes `:id` and `{id}` path-param styles and computes the
symmetric difference. As of W890-12 the openapi surface lists ~720 ops
and the api.html landing card lists ~150 curated ops — the bulk of the
gap is intentional curation (api.html is the curated subset; the full
table is rendered server-side from openapi.json by the `/api` endpoints).
The gap is tracked in `data/w890-12-api-ref-sync.json.gap[]` and is
deferred to W890-9 for closure.

## 8. SDK coverage

Six SDKs ship in `sdk/`:

| SDK     | README | Example                        |
|---------|--------|--------------------------------|
| node    | yes    | `sdk/node/test/sdk.test.mjs`   |
| python  | yes    | `sdk/python/tests/test_sdk.py` |
| rust    | yes    | `sdk/rust/examples/whoami.rs`  |
| c       | yes    | `sdk/c/kolm-cli.c` + Makefile  |
| mcp     | yes    | `sdk/mcp/server.mjs`           |
| vscode  | yes    | `sdk/vscode/src/`              |

The audit (`data/w890-12-sdk-coverage.json`) requires each SDK to have
a `README.md` and at least one example or test path. `gaps[].length` must
be 0 at ship gate.

## 9. ADR (Architecture Decision Records)

ADRs are optional. As of W890-12 we do not maintain a `docs/adr/` tree.
Major architectural decisions live in:

- `INTERNAL_BACKEND_SPEC.md`
- `STRATEGY.md`
- `KOLM_V1_LAUNCH_PLAN_2026_05_26.md`
- `docs/spec/dot-kolm-v1.0.md`
- the wave plan files (`KOLM_W888_RUN_FINAL_INTEGRATION_PLAN.md`)

When we adopt ADRs they will land at `docs/adr/NNN-<slug>.md` with the
[MADR](https://adr.github.io/madr/) template. The audit reports the dir
state in `data/w890-12-adr.json.adr_dir_exists`.

## 10. Stale-docs audit

The audit walks `docs/` and `public/docs/` and reports the mtime
distribution. The gate is informational, not blocking:

- `modified_in_last_30d` — recently-touched docs.
- `not_visited_180d_plus[]` — files older than 180 days; manual review.

See `data/w890-12-stale-docs.json`.

## 11. Banned vocabulary

Per the user directive recorded 2026-05-26, the H-word forms
(adjective + noun, references intentionally avoided in this file
to keep the audit self-clean) MUST NOT appear in any W890-* audit
artifact, policy doc, or generated changelog entry. Use Caveats /
Constraints / Limitations / Accuracy instead. The lock-in test scans
every W890-12 artifact for the banned token at runtime.

## 12. Audit artifact index

Ten data files materialize the gate state:

- `data/w890-12-readme.json`
- `data/w890-12-changelog.json`
- `data/w890-12-license.json`
- `data/w890-12-contributing.json`
- `data/w890-12-docs-accuracy.json`
- `data/w890-12-code-examples.json`
- `data/w890-12-api-ref-sync.json`
- `data/w890-12-sdk-coverage.json`
- `data/w890-12-adr.json`
- `data/w890-12-stale-docs.json`

Plus the ship-gate snapshot: `data/w890-12-ship-gate-snapshot.json`.

Regenerate the audit: `node scripts/w890-12-documentation-audit.cjs`.
Run the lock-ins: `node --test tests/wave890-12-documentation.test.js`.

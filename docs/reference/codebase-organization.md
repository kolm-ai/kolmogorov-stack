# Codebase organization

Canonical reference for the Kolmogorov-Stack source tree. This document is the
output of W890-1 (V1 production code audit, organization sub-wave) and is
re-validated by `tests/wave890-1-organization.test.js`.

## Top-level directory map

| Directory     | Purpose                                                                | Allowed contents                                              |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/`        | Backend modules (router, auth, artifact, compute, capture, billing).   | JS/TS only. Backend logic. No CLI dispatch, no test files.    |
| `cli/`        | CLI surface: `kolm` verb dispatcher, TUI, NL routing.                  | JS-ecosystem only (`.js`/`.mjs`/`.cjs`/`.ts`).                 |
| `scripts/`    | Build / audit / migration / corpus generation scripts.                 | Mostly `.cjs`/`.mjs`/`.js` + `.py` for build helpers.         |
| `workers/`    | Subprocess workers (distill, quantize, multimodal, redact).            | JS/Python entry points + their inline dependencies.           |
| `tests/`      | Test suite (lock-in + integration).                                    | `*.test.js`/`*.test.cjs`/`*.test.mjs` + `_*` helpers + `fixtures/`. |
| `public/`     | Static frontend assets shipped to kolm.ai (Vercel + Railway).          | HTML/CSS/JS/JSON/images. No server code.                      |
| `apps/`       | Separable runtime apps (export workers, replicate, modal, showcase).   | Per-app self-contained code.                                  |
| `docs/`       | Markdown documentation, generated docs manifests, research notes.      | `.md` + generated `.json` ledgers.                            |
| `data/`       | Generated config / audit / report JSON files (committed for receipts). | `.json` data files only; no executable code.                  |
| `packages/`   | Distributable language SDKs (Python/TS/Swift/Kotlin/RN + extensions).  | Per-package layouts (Cargo / npm / pip / etc.).               |
| `tools/`      | First-party integrations (Helm, Grafana, GHA, Ollama loader, etc.).    | Per-tool layouts.                                             |
| `services/`   | Out-of-process services (MCP server, etc.).                            | Service entry points.                                         |
| `audit-shots/` | QA screenshots captured by Playwright/probe scripts.                  | PNG/SVG image artifacts. NOT source code.                     |

## The 500-LoC rule

Per the W890 V1 production code audit directive, every source file SHOULD be
under 500 lines of code. Files that exceed 500 LoC are tracked as **exceptions**
in `data/w890-1-loc-exceptions.json` with two required fields:

1. `reason` — a substantive justification for why the file is not split. Generic
   reasons ("too big to split") are rejected; the reason must name the
   cohesion principle (shared middleware / atomic round-trip /
   single-product-surface / build-time linear pipeline) that splitting
   would break.
2. `planned_split` — one of:
   - `inline`: the file is intentionally a single linear script; no split is
     planned. Common for `scripts/build-*.cjs` generators.
   - `next-major`: the file will be split in the next major version (v1.1+).
     Common for `src/router.js` and `cli/kolm.js`, where the split is a
     multi-wave refactor that needs verb-count stability first.
   - `never`: the file is intentionally an append-only artifact. Common for
     lock-in test suites.

### Top-5 LoC exceptions at V1

| File                  | LoC     | planned_split |
| --------------------- | ------: | ------------- |
| `cli/kolm.js`         | ~52,000 | next-major    |
| `src/router.js`       | ~24,700 | next-major    |
| `src/binder.js`       |  ~2,700 | next-major    |
| `src/artifact.js`     |  ~2,350 | next-major    |
| `src/intent.js`       |  ~2,300 | next-major    |

The audit reports `data/w890-1-loc-report.json` for the full LoC distribution
and `data/w890-1-loc-exceptions.json` for every file above the cap.

## Boundary rules

- `src/` is **JS-ecosystem only**. Python files in `src/` are a high-severity
  boundary violation; move to `scripts/` or `workers/`.
- `cli/` is **JS-ecosystem only**. Shell scripts and Python belong in
  `scripts/`. Compiled binaries belong in `bin/`.
- `tests/` accepts **only** `*.test.{js,cjs,mjs}` files, helper files prefixed
  with `_` (e.g., `_spawn-helpers.js`), the `fixtures/` subdirectory, and the
  `_tmp_no_home_*` directories created by the `setIsolatedHome` chokepoint
  during test runs (these are test-runtime artifacts and are excluded from
  the audit scan).
- `public/` is static assets only. No server code; no dynamic JS that runs
  on the Node side.

## Orphan policy

A file is considered an **orphan** if no other JS/Python/JSON/Markdown source
in `src/`, `cli/`, `scripts/`, `tests/`, `workers/`, `services/`, or `apps/`
contains a reference to it via:

- an `import` or `require` of the file's path or quoted basename (with or
  without extension);
- a registry entry (e.g., `compute/registry.json` listing a backend whose
  adapter is loaded via dynamic `import(`./backends/${name}.js`)`);
- a documented entry-point name (`index`, `main`, `server`, `kolm`, `router`,
  `app`) that may be invoked by string elsewhere.

Orphans in `src/` are reviewed and either re-wired or removed.  Scripts,
workers, and CLI entry points are exempt from orphan checks because they
are routinely invoked by `package.json` scripts or directly by `node` /
`python` and never imported.

The audit reports orphans in `data/w890-1-orphans.json`.

## Binary blob policy

Files larger than 100 KB in `src/`, `cli/`, or `scripts/` are flagged for
review. Genuine source monoliths (`cli/kolm.js`, `src/router.js`, etc.)
are documented via the LoC exception list. Non-source blobs (screenshots,
binary assets) belong in `audit-shots/`, `public/`, or `data/`, not in source
directories.

The audit reports binary blobs in `data/w890-1-binary-blobs.json`.

## How to extend this

When you add a new file:

1. Place it under the directory that matches its function (see table above).
2. If it will exceed 500 LoC, add an entry to
   `data/w890-1-loc-exceptions.json` BEFORE merging.
3. If it changes a directory's purpose, update the table above and the
   companion lock-in test.
4. Re-run `node scripts/w890-1-organization-audit.cjs` and commit the
   refreshed `data/w890-1-*.json` files.

## Audit driver

The single command that regenerates every artifact this document references:

```
node scripts/w890-1-organization-audit.cjs
```

Outputs (all under `data/`):

- `w890-1-loc-report.json` — full LoC distribution and over-500 list.
- `w890-1-loc-exceptions.json` — substantive justifications for every file > 500 LoC.
- `w890-1-boundary-violations.json` — directory boundary violations (target: empty).
- `w890-1-orphans.json` — unused/dead files in `src/` (target: empty).
- `w890-1-binary-blobs.json` — files > 100 KB in source dirs (only monoliths expected).

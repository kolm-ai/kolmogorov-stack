# Kolm Codebase File Ledger Seed

Date: 2026-05-25

Purpose: seed Phase 1 of the P0 control-file buildout. This document captures the current repository shape and the classification rules needed to generate `docs/codebase-file-ledger.json`.

This is not the final machine-readable file ledger. It is the implementation seed for `scripts/build-codebase-file-ledger.cjs`.

## Current Census

| Measurement | Current value |
|---|---:|
| Git-tracked files | 3,651 |
| Top-level `src` files | 392 |
| Top-level `scripts` files | 343 total on disk, 267 tracked |
| Top-level `tests` files | 567 tracked wave/unit/integration files |
| Top-level `public` files | 1,132 total on disk, 1,088 tracked |
| Top-level `docs` files | 161 total on disk, 157 tracked |
| Top-level `sdk` files | 4,956 total on disk, 41 tracked |
| Top-level `workers` files | 1,030 total on disk, 43 tracked |
| Top-level `reports` files | 95,988 total on disk, 0 tracked |
| `.github` files | 16 tracked |

The tracked repository is moderate. The working directory is much larger because of reports, SDK Rust build outputs, temporary bundles, caches, and data snapshots.

## Tracked Top-Level Shape

| Top-level path | Tracked files | Ledger class |
|---|---:|---|
| `public` | 1,088 | release static surface, generated docs, product pages, assets |
| `tests` | 567 | verification surface |
| `archive` | 455 | historical/archive, not release authority unless explicitly referenced |
| `src` | 392 | product source |
| `scripts` | 267 | build/audit/smoke/generator source |
| `docs` | 157 | product truth, research, specifications, generated support docs |
| `apps` | 122 | app/package source |
| `packages` | 107 | package source and distribution manifests |
| `qa` | 92 | QA artifacts and proof snapshots |
| `audit-shots` | 54 | historical screenshot artifacts |
| `sdk` | 41 | SDK source tracked subset |
| `workers` | 43 | worker source tracked subset |
| `examples` | 42 | examples and fixtures |
| `tools` | 29 | developer tooling |
| `bin` | 18 | executable wrappers/tooling |
| `.github` | 16 | CI and GitHub metadata |
| `data` | 22 | tracked fixtures/state; needs scrutiny because `.gitignore` excludes many data runtime files |

## Tracked Extension Shape

| Extension | Tracked files | Ledger implication |
|---|---:|---|
| `.html` | 1,187 | public/docs/account route surface, generated docs, static pages |
| `.js` | 1,011 | product source, public runtime JS, generated/static scripts |
| `.md` | 230 | docs, specs, research, audits, roadmap |
| `.svg` | 188 | visual/OG/icon assets |
| `.json` | 179 | config, generated outputs, fixtures, product truth |
| `.png` | 165 | screenshots/assets; must distinguish product media from proof artifacts |
| `.mjs` | 162 | scripts and ESM modules |
| `.py` | 153 | scripts/tools/fixtures |
| `.cjs` | 84 | build/audit generators |
| `.csv` | 39 | research matrices and fixtures |
| `.kolm` | 32 | artifact fixtures/examples |
| `.jsonl` | 22 | datasets/seeds |
| `.css` | 21 | visual system source, generated CSS, transitional patches |

The extension scan hit one invalid-path exception when reading a tracked malformed path-like filename. The final script must not rely on `System.IO.Path.GetExtension` alone; it should catch invalid path strings and classify them as malformed path artifacts.

## Current Untracked Release-Relevant State

Current `git status --short --untracked-files=all` shows untracked artifacts:

| Path pattern | Current signal | Ledger classification |
|---|---|---|
| `.w850-shots/**` | 29 untracked screenshot/report files for account, docs, home, pricing, studio, wrapper, and W852 routes. | `report` or `visual-proof`; keep out of release unless archived under `reports/`. |
| `C...site-failures*.txt` | Two root path-like failure files with mojibake-style path prefix. | `quarantine`; should move under `reports/` or be ignored/removed by owner. |
| `data/observations.json.*.tmp` | Runtime temp observation snapshots. | `runtime-data`; never release; should be ignored and not tracked. |
| `docs/research/kolm-ai-100-percent-codebase-completion-blueprint-2026-05-25.md` | Untracked master archive. | `docs/spec-archive`; release decision required. |
| `docs/research/kolm-master-spec-consolidated-review-2026-05-25.md` | Untracked consolidation. | `docs/operating-spec`; should become tracked if accepted. |
| `docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md` | Untracked P0 implementation spec. | `docs/implementation-spec`; should become tracked if accepted. |
| `docs/research/kolm-p0-control-files-buildbook-2026-05-25.md` | Untracked buildbook. | `docs/buildbook`; should become tracked if accepted. |
| `docs/research/kolm-codebase-file-ledger-seed-2026-05-25.md` | This seed. | `docs/seed`; should become tracked if accepted. |

The file ledger generator must treat untracked files as first-class evidence. A clean release cannot ignore them unless they are classified as excluded, archived, or intentionally pending.

## Large Local Areas

| Path | Files | Bytes | Tracked files | Ledger decision |
|---|---:|---:|---:|---|
| `reports` | 95,988 | 11,302,406,649 | 0 | ignored evidence archive; release packets should write here but not track all outputs |
| `tmp` | 10,659 | 2,549,940,671 | 0 | scratch; never release |
| `sdk/rust/target` | 4,900 | 1,592,716,432 | 0 | build output; never release |
| `data` | 3,576 | 752,883,110 | 22 | mixed runtime data and tracked fixtures; needs per-file classification |
| `.npm-cache` | 6 | 443,427,084 | 0 | cache; never release |
| `.w850-shots` | 29 | 11,070,641 | 0 | visual proof; move under reports if retained |

The final file ledger must classify ignored but present paths because they can still affect local smoke, screenshots, release packaging, and operator confusion.

## Largest Non-Report Local Files

| Path | Bytes | Ledger decision |
|---|---:|---|
| `data/observations.json` | 173,777,512 | runtime data; not release source |
| `data/observations.json.bak` | 173,777,512 | backup runtime data; not release source |
| `data/observations.json.*.tmp` | about 173 MB each | runtime temp; not release source |
| `data/kolm.sqlite` | 37,629,952 | local runtime DB; not release source |
| `public/assets/hero-warm-paper-bg.png` | 7,031,506 | public asset; must be optimized/justified by visual proof |
| `eng.traineddata` | 5,199,098 | ignored OCR pack; not release source |
| `docs/research/kolm-billion-dollar-distillation-lab-2026-05-24.md` | 3,910,157 | research archive; not daily operating spec |
| `docs/research/kolm-ai-100-percent-codebase-completion-blueprint-2026-05-25.md` | 3,116,328 | master archive; should not be daily execution source |
| `data/tenants.json` and `.bak` | 3,048,740 each | local runtime/tenant data; must not leak |
| `qa/**/light-desktop-1440-full.png` | about 2.7-2.9 MB each | QA proof artifact; classify by report lineage |
| `scripts/qa-home-full-dark.png` | 2,644,603 | script-local screenshot artifact; should be moved to reports or ignored |

## Malformed Or Suspicious Tracked Paths

With `core.quotepath=false`, one tracked path has a path-like mojibake colon form:

```text
C[mojibake-colon]UsersuserDesktopkolmogorov-stackpublicjszip.min.js
```

The file ledger must flag this as `malformed_tracked_path`. It should not be silently treated as a normal source file. Node `43` owns cleanup; the file ledger owns detection and release-blocking classification.

## Generated Outputs Observed

| Path | Current bytes | Generator or likely source | Ledger class |
|---|---:|---|---|
| `public/openapi.json` | 579,772 | `scripts/build-openapi.cjs` | generated API spec |
| `public/docs/api-routes.json` | 296,285 | `scripts/build-api-ref.cjs` | generated API route inventory |
| `public/product-graph.json` | 141,724 | `scripts/build-product-graph.cjs` | generated product graph |
| `public/product-readiness-closeout.json` | 12,897 | `scripts/build-readiness-closeout.cjs` | generated readiness closeout |
| `docs/product-readiness-closeout.md` | 11,725 | `scripts/build-readiness-closeout.cjs` | generated/readiness doc |
| `public/sdk-current.json` | 162 | `scripts/build-sdk-version.js` | generated SDK version |
| `public/sitemap.xml` | 64,675 | `scripts/build-sitemap.cjs` | generated discovery artifact |
| `public/docs/cli/*.html` | many | `scripts/build-cli-docs.cjs` | generated CLI docs |
| `public/docs/cli/*.md` | many | CLI docs source/hand-authored or generated source; must classify per file | docs source or generated source |

The ledger must store both `generated_by` and `check_command`. It must also record generation order because API docs/OpenAPI/product graph/CLI docs can race if built concurrently.

## Initial Classification Rules

| Rule | Classification |
|---|---|
| `src/**` | `source/product` unless fixture or generated marker proves otherwise |
| `server.js`, `cli/**`, `scripts/**` | `source/runtime` or `source/tooling` |
| `public/**/*.html` | `release-static-route` or `generated-doc-route` |
| `public/docs/api-routes.json`, `public/openapi.json`, `public/product-graph.json`, `public/product-readiness-closeout.json`, `public/sdk-current.json`, `public/sitemap.xml` | `generated-release-artifact` |
| `docs/product-*.json`, `docs/product-readiness-closeout.md` | `product-truth` or `generated-product-truth` |
| `docs/research/**` | `research-archive`, `operating-spec`, `implementation-spec`, or `buildbook` |
| `tests/**` | `verification` |
| `test/**`, `examples/**`, `holdouts/**`, `models/**` | `fixture` or `example` |
| `reports/**`, `.w850-shots/**`, `tmp-screenshots/**`, `qa/**`, `audit-shots/**`, `screenshots/**` | `evidence-report` or `historical-proof`; release excluded unless specifically referenced |
| `tmp/**`, `.npm-cache/**`, `sdk/rust/target/**` | `scratch-cache-build-output`; release excluded |
| `data/*.json`, `data/*.sqlite`, `data/*.tmp`, `data/*.bak` | `runtime-data`; release excluded unless explicitly fixture-owned |
| malformed absolute/path-like filenames | `quarantine` |
| `.env*`, secrets, keys, certs | `secret-config`; never report values |

## MVP JSON Fields For The Real Ledger

The first generated ledger should include:

```json
{
  "path": "public/openapi.json",
  "tracked": true,
  "dirty_state": "clean|modified|untracked|ignored|unknown",
  "kind": "generated-release-artifact",
  "owner_node": "37",
  "owner_lane": "backend",
  "release_included": true,
  "generated": true,
  "generated_by": "scripts/build-openapi.cjs",
  "check_command": "node scripts/build-openapi.cjs --check",
  "consumed_by": ["public/docs/api-routes.json", "docs/api", "SDK examples"],
  "large_file": false,
  "secret_risk": false,
  "quarantine": false,
  "notes": []
}
```

## MVP Build Algorithm

1. Read `git ls-files -z` to avoid malformed-path parsing errors.
2. Read `git status --porcelain=v1 -z --untracked-files=all` for dirty and untracked state.
3. Walk the filesystem while excluding `.git`, `node_modules`, and known huge cache roots unless `--include-ignored-heavy` is passed.
4. Apply path classification rules.
5. Join `scripts/build-codegraph.mjs --json --full` when possible.
6. Attach generated artifact metadata from a static generator map.
7. Attach large-file flags by byte threshold.
8. Attach release inclusion by package `files`, public/static deployment rules, Docker/Vercel ignore rules, and explicit allowlists.
9. Emit `docs/codebase-file-ledger.json`.
10. In `--check` mode, compare stable JSON against the existing file.

## Warn Mode Gates

The first implementation should warn, not fail, on:

- untracked research specs;
- root screenshot/failure artifacts;
- runtime data files;
- generated output without check command;
- large docs/research files;
- tracked archive/proof artifacts;
- malformed tracked path.

It should fail even in MVP mode on:

- secret-like file included in release;
- generated file with invalid JSON;
- untracked release-static route under `public/`;
- dirty deploy config without active lane owner;
- path traversal or absolute path included as release source.

## Graduation To Fail Mode

The ledger can become release-blocking when:

1. every tracked path has `kind`, `owner_node`, and `release_included`;
2. every untracked path is classified or ignored;
3. generated release artifacts have generators and check commands;
4. malformed root/path-like artifacts are quarantined or removed by owner;
5. runtime data and caches are release-excluded;
6. large public assets have optimization/proof references;
7. final build redline consumes the ledger.

## Immediate Work Items

| Ticket | Work | Done when |
|---|---|---|
| `W-FILE-SEED-001` | Implement `git ls-files -z` and status parser. | Malformed paths do not crash extension or path parsing. |
| `W-FILE-SEED-002` | Add path classifier with current rules. | The current tree emits zero `unknown` for tracked files in warn mode. |
| `W-FILE-SEED-003` | Add generated artifact map. | OpenAPI, API routes, product graph, readiness closeout, SDK current, sitemap, CLI docs, and screenshots have generator/check metadata. |
| `W-FILE-SEED-004` | Add heavy-root inventory. | `reports`, `tmp`, `.npm-cache`, `sdk/rust/target`, `.w850-shots`, and `data` are summarized without dumping all files. |
| `W-FILE-SEED-005` | Add release-inclusion policy. | Vercel/public/package/Docker inclusion decisions are explicit. |
| `W-FILE-SEED-006` | Add initial `docs/codebase-file-ledger.json`. | Stable generated JSON exists and can be checked. |
| `W-FILE-SEED-007` | Wire `verify:file-ledger`. | The file ledger can run in warn mode under control-file verification. |

## Redline

The codebase cannot be called 100 percent complete until this seed is replaced by a generated, checked, release-blocking `docs/codebase-file-ledger.json` and the final build redline consumes it.

# Changelog

All notable changes to the kolm stack are recorded here. The public-facing
changelog at <https://kolm.ai/changelog> is the canonical surface for users;
this file is the GitHub-friendly mirror with one entry per ship-gate wave.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses Semantic Versioning. Each wave entry links to the
underlying audit artifacts in `data/wXXX-*.json` and the lock-in tests in
`tests/waveXXX-*.test.js`.

## [Unreleased]

### W890 — V1 production code audit (in progress)

Sixteen sub-waves that close the last gap between "shipped and demoed" and
"ready for paying customers". Each sub-wave produces audit artifacts under
`data/w890-*.json` and a lock-in test suite under `tests/wave890-*.test.js`.

- **W890-1 — Codebase organization.** 1411 source files scanned; 192
  documented monoliths > 500 LoC; 5 monoliths intentionally off-limits to
  splitting. Artifacts: `data/w890-1-loc-report.json`,
  `data/w890-1-orphans.json`, `data/w890-1-binary-blobs.json`,
  `data/w890-1-boundary-violations.json`,
  `data/w890-1-loc-exceptions.json`.
- **W890-2 — Code quality.** ESLint + Ruff + secret scan + localhost scan
  + console.log scan. Artifacts under `data/w890-2-*.json`. Policy:
  `docs/reference/code-quality-policy.md`.
- **W890-3 — Error handling.** Async coverage, empty catch survey, error
  message audit, HTTP status code audit, process handler audit, Sentry
  report. Policy: `docs/reference/error-handling-policy.md`.
- **W890-4 — Logging.** Logger inventory, log levels, request-id trace,
  rotation policy, sensitive-data scan, structured logging report. Policy:
  `docs/reference/logging-policy.md`.
- **W890-7 — Configuration.** Env-var inventory, defaults audit,
  zero-config doctor, hierarchy trace, secret-leak scan, .gitignore audit.
  Policy: `docs/reference/configuration-policy.md`. Reference:
  `docs/reference/config-toml.md` (8 sections / 25 keys, shipped in W889-12.1).
- **W890-8 — Storage.** SQLite index audit, migrations registry, backup
  strategy, retention policy, WAL mode, Postgres pool config, S3 IAM
  template. Policy: `docs/reference/storage-policy.md`.
- **W890-12 — Documentation (this wave).** README, CHANGELOG, LICENSE,
  CONTRIBUTING, docs-accuracy gate, code-example test, API-ref sync, SDK
  coverage, ADR audit, stale-docs audit. Policy:
  `docs/reference/documentation-policy.md`. Lock-ins:
  `tests/wave890-12-documentation.test.js`.
- **W890-5, W890-9, W890-11 — Testing / API / CLI policies.** Sibling
  sub-waves shipped in parallel batch B; produce
  `docs/reference/testing-policy.md`, `api-policy.md`, `cli-policy.md`.

Sub-waves W890-6, W890-10, W890-13..16 remain in flight (security,
frontend, deploy, perf, monitoring, final V1 ship gate).

### W889 — Spec + reference scaffolding

- **W889-9.1.** `.kolm` artifact spec landed at
  `docs/spec/dot-kolm-v1.0.md` — the canonical v1.0 reference for
  manifest, recipes, evals, receipt chain, signature.
- **W889-12.1.** `docs/reference/config-toml.md` — 8 sections, 25 keys,
  one line per key, defaults inlined.

### W888 — Run + Final integration

- **W888a — Font bleed.** Final pass on warm-paper typography drift;
  shipped at commit `781a08ef`.
- **W888-K — Docs sweep.** 22 new docs pages landed; every CLI verb and
  every Studio page now has a docs page. Closes the W869 T6 directive.

## [0.2.6] — 2026-05-26

Current published version per `package.json`. Ship gate 52/52 green.
Twelve smoke + 23 integration + 12 benchmark + 4 surface checks all
passing. SOTA quantize matrix verified across Qwen2.5-0.5B → DeepSeek-R1
32B INT4 on RTX 5090.

## [0.2.0] — Wave 144

- `kolm moe compose` — N expert composition with deterministic router.
- `kolm tokenize {train,encode,decode,inspect}` — pure-JS byte-level BPE.
- `kolm extract <file>` — text extraction front door (plain, JSON,
  HTML, PDF text layer; image via OCR or vision flag).
- `kolm doc check <file> --type <spec>` — multimodal document
  completeness gate with five built-in specs.

## License

This project is licensed under [Apache-2.0](LICENSE). See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute and what license
your contributions are made under.

## Wave Index

The wave numbering scheme is monotonic: each wave is one atomic ship,
typically a single commit (the body of the commit message references the
wave number). The auto-memory in `~/.claude/projects/.../MEMORY.md`
maintains a separate per-topic index.

Pre-W144 history is preserved in `docs/wave-archive/` (see
`ARCHIVE.md`-style indices in MEMORY.md for the legacy waves).

# Product Readiness Closeout Ledger

Generated from `docs/product-sota-readiness.json` schema `2026-05-21`.

This file is the DoD backstop for every readiness item that is not yet `shipped` or `implemented`. Open items are allowed only when the blocker is explicit and the next build/proof wave is named.

## Summary

| status | count |
|---|---:|
| needs_external_partner | 2 |
| needs_live_certification | 1 |
| needs_package_release | 4 |
| needs_public_benchmark_data | 4 |

## Open Requirements

### W574-quality-judge-calibration - quality-scoring

- Surface: `ai-ml-optimizer`
- Priority: `P0`
- Status: `needs_public_benchmark_data`
- Blocker: `judge_calibration_data`
- Current scope: Quality scoring exists for artifacts, bakeoffs, evals, and production-ready gates; per-call judge quality needs calibration before broad autonomous-quality claims.

Build or proof required:
- Publish judge calibration fixtures with human labels and deterministic expected scores.
- Report agreement, drift, and confidence thresholds by task class.
- Expose calibration version in quality-scoring responses and account UI.

Done when:
- Quality scoring docs link raw calibration reports and threshold guidance.
- Product copy distinguishes artifact eval score from calibrated per-call judge score.
- verify:sota passes with judge calibration evidence attached.

Verification:
- `npm run verify:sota`
- `node --test --test-concurrency=1 tests`

Evidence paths:
- `src/artifact.js`
- `src/bakeoff.js`
- `src/production-ready.js`
- `cli/kolm.js`

### W568-redaction-benchmarks - redaction-quality

- Surface: `capture-gateway-lake`
- Priority: `P0`
- Status: `needs_public_benchmark_data`
- Blocker: `public_redaction_benchmark`
- Current scope: The redaction membrane is implemented and class-counted; public per-class precision/recall/F1 claims are not done until benchmark fixtures and reports are published.

Build or proof required:
- Create public synthetic PII/PHI fixtures for SSN, MRN, DOB, address, email, phone, payer, diagnosis, and free-text note patterns.
- Run redaction precision, recall, and F1 by class.
- Publish false-positive and false-negative examples with mitigations.

Done when:
- /privacy and /benchmarks link the per-class redaction report.
- The account privacy UI can show class counts and benchmark scope without implying certification.
- verify:sota passes with public redaction benchmark evidence attached.

Verification:
- `npm run verify:sota`
- `node --test --test-concurrency=1 tests`

Evidence paths:
- `src/privacy-membrane.js`
- `src/phi-redactor.js`
- `src/router.js`
- `public/account/privacy-events.html`

### W567-k-score-calibration - k-score-calibration

- Surface: `compile-train-distill`
- Priority: `P0`
- Status: `needs_public_benchmark_data`
- Blocker: `public_reproducible_calibration`
- Current scope: K-score gates are implemented locally, but broad quality claims remain benchmark-scoped until a public calibration set and methodology are published.

Build or proof required:
- Publish the K-score axis definitions, weights, and task-specific thresholds.
- Run the public fixture suite across classification, extraction, generation, and redaction tasks.
- Attach raw JSON reports and explain known failure modes.

Done when:
- /benchmarks links reproducible K-score calibration data.
- The docs state which claims are proven by local fixtures versus live frontier-model runs.
- verify:sota passes with public benchmark evidence attached.

Verification:
- `npm run verify:sota`
- `node scripts/bench-compare.mjs --help`

Evidence paths:
- `src/artifact.js`
- `src/production-ready.js`
- `docs/PRODUCT.md`
- `public/spec.html`

### W571-public-leaderboard - benchmarking-infra

- Surface: `infrastructure-enterprise`
- Priority: `P0`
- Status: `needs_public_benchmark_data`
- Blocker: `public_leaderboard_data`
- Current scope: The benchmark harness and sample reference report exist; competitor and hardware leaderboard claims need reproducible public runs.

Build or proof required:
- Run public tasks against Kolm artifacts, OpenAI, Anthropic, Gemini, local GGUF, and at least one hosted open-model baseline.
- Publish raw JSON, command lines, model versions, hardware, latency, cost, and scoring method.
- Add freshness and retest cadence to /benchmarks.

Done when:
- /benchmarks contains reproducible multi-provider data and raw report links.
- Marketing copy cites only benchmarked claims and includes dataset/date context.
- verify:sota passes with public leaderboard evidence attached.

Verification:
- `npm run verify:sota`
- `node scripts/bench-compare.mjs --help`

Evidence paths:
- `src/benchmarks.js`
- `scripts/bench-compare.mjs`
- `public/benchmarks.html`
- `docs/benchmark-results-v0.1.0.md`

### W573-compliance-certification - compliance-certifications

- Surface: `infrastructure-enterprise`
- Priority: `P0`
- Status: `needs_live_certification`
- Blocker: `live_auditor_certification`
- Current scope: Security controls, BAA copy, and evidence hooks exist locally; formal compliance claims require auditor/certification artifacts and live production evidence.

Build or proof required:
- Collect SOC 2, ISO 27001, HIPAA BAA, GDPR DPA, FedRAMP boundary, SBOM, and SLSA evidence packets.
- Attach auditor reports or signed attestations when available.
- Update public trust pages to distinguish controls implemented from certifications awarded.

Done when:
- Trust pages link dated auditor/certification evidence or stay scoped to implemented controls.
- Enterprise readiness exports include the same evidence IDs.
- verify:sota passes with certification evidence attached or this item remains explicitly blocked.

Verification:
- `npm run verify:sota`
- `npm run lint:refs`

Evidence paths:
- `public/security.html`
- `public/baa.html`
- `docs/kolm-format-v1.md`
- `.github/workflows/sdk-c-rust.yml`

### W575-installer-release - one-line-install

- Surface: `developer-experience`
- Priority: `P1`
- Status: `needs_package_release`
- Blocker: `installer_channel_release`
- Current scope: Install scripts and package-manager manifests exist locally; Homebrew, winget, apt, and release-channel publication require signed release artifacts.

Build or proof required:
- Produce signed release artifacts and checksums for macOS, Windows, Linux, and container targets.
- Run install script smoke tests on clean hosts or CI images.
- Submit or publish Homebrew, winget, apt, Docker, and direct install channels.

Done when:
- Install docs link package-manager commands backed by published artifacts.
- CI verifies installer checksums and smoke tests.
- verify:sota passes with installer release evidence attached.

Verification:
- `npm run verify:sota`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -WhatIf`

Evidence paths:
- `scripts/install.ps1`
- `packages/homebrew`
- `packages/winget`

### W566-runtime-adapters - ecosystem-runtime-adoption

- Surface: `format-standard`
- Priority: `P1`
- Status: `needs_external_partner`
- Blocker: `external_runtime_adoption`
- Current scope: Kolm runtime and compute adapters exist locally; native third-party support is not claimable until external projects merge or publish support.

Build or proof required:
- Create adapter packets for Ollama, llama.cpp, ONNX/GGUF, and Hugging Face Hub.
- Submit or publish at least one external integration PR or plugin package.
- Document compatibility tests and supported artifact subset per runtime.

Done when:
- At least one external runtime can pull or execute a .kolm artifact without private Kolm code.
- The runtime support matrix links to external artifacts or merged code.
- verify:sota passes with third-party adoption evidence attached.

Verification:
- `npm run verify:sota`
- `npm run build:readiness-closeout -- --check`

Evidence paths:
- `docs/kolm-format-v1.md`
- `src/compute/registry.json`
- `public/runtimes.html`

### W565-format-governance - foundation-standardization

- Surface: `format-standard`
- Priority: `P1`
- Status: `needs_external_partner`
- Blocker: `external_partner_acceptance`
- Current scope: The public v1 spec is shipped locally; neutral stewardship is not claimable until an outside standards venue or foundation accepts the process.

Build or proof required:
- Publish the RFC packet and governance proposal from docs/kolm-format-v1.md.
- Record a public issue, mailing-list thread, or foundation intake artifact.
- Add the accepted governance venue and compatibility policy to /spec.

Done when:
- A neutral venue or foundation process is publicly linked.
- The spec has an external change-control path and versioning rules.
- verify:sota passes with this requirement promoted to implemented or shipped.

Verification:
- `npm run verify:sota`
- `npm run build:readiness-closeout -- --check`

Evidence paths:
- `docs/kolm-format-v1.md`
- `public/spec.html`

### W572-sdk-release-matrix - sdk-depth

- Surface: `infrastructure-enterprise`
- Priority: `P1`
- Status: `needs_package_release`
- Blocker: `sdk_package_release`
- Current scope: SDK source and metadata exist locally across languages; package manager availability is not complete until channel-specific release artifacts are published.

Build or proof required:
- Run build/check/package commands for every SDK with available toolchains.
- Add CI jobs for C, Rust, TypeScript, Python, VS Code, Swift, Kotlin, and React Native packages.
- Publish or attach signed release artifacts with install instructions.

Done when:
- Every SDK page links a tested package artifact or explicitly says local-source only.
- CI compile-verifies SDKs on every change.
- verify:sota passes with SDK release evidence attached.

Verification:
- `npm run verify:sota`
- `npm run verify:sdk-manifest`

Evidence paths:
- `sdk/node`
- `sdk/python`
- `sdk/mcp`
- `sdk/vscode`
- `sdk/c`
- `sdk/rust`
- `packages/sdk-ts`
- `packages/sdk-swift`
- `packages/sdk-kotlin`
- `packages/sdk-rn`

### W570-mobile-sdk-release - ios-android-sdk

- Surface: `runtime-compute`
- Priority: `P1`
- Status: `needs_package_release`
- Blocker: `mobile_package_release`
- Current scope: Swift, Kotlin, and React Native SDK sources exist locally; SwiftPM, Maven, and npm publication are not complete until release artifacts exist.

Build or proof required:
- Run SwiftPM, Gradle, and React Native package checks where toolchains are available.
- Create release tarballs or package dry-run artifacts.
- Link install commands and version badges from SDK docs.

Done when:
- iOS, Android, and React Native SDK docs link installable packages or signed release artifacts.
- CI verifies build/package checks for Swift, Kotlin, and React Native.
- verify:sota passes with mobile package release evidence attached.

Verification:
- `npm run verify:sota`
- `npm --prefix packages/sdk-rn run build`

Evidence paths:
- `packages/sdk-swift`
- `packages/sdk-kotlin`
- `packages/sdk-rn`

### W569-runtime-wasm-package - runtime-wasm

- Surface: `runtime-compute`
- Priority: `P1`
- Status: `needs_package_release`
- Blocker: `package_channel_release`
- Current scope: Browser runtime code exists locally; npm/CDN package publication remains an external release step.

Build or proof required:
- Build packages/sdk-ts and publish or dry-run the runtime package manifest.
- Add browser embed smoke tests for public/sdk.js and recipe-worker.js.
- Record npm package metadata, integrity hash, and CDN import URL.

Done when:
- A package tarball or registry URL is linked from /runtimes and SDK docs.
- The browser worker smoke test passes in CI.
- verify:sota passes with package release evidence attached.

Verification:
- `npm run verify:sota`
- `npm --prefix packages/sdk-ts run build`

Evidence paths:
- `public/sdk.js`
- `public/recipe-worker.js`
- `packages/sdk-ts`


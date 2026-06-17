# Product Readiness Closeout Ledger

Generated from `docs/product-sota-readiness.json` schema `2026-05-21`.

This file is the DoD backstop for every readiness item that is not yet `shipped` or `implemented`. Open items are allowed only when the blocker is explicit and the next build/proof wave is named.

## Summary

| status | count |
|---|---:|
| needs_external_partner | 2 |
| needs_live_certification | 1 |
| needs_package_release | 4 |
| needs_public_benchmark_data | 1 |

## Open Requirements

### W571-public-leaderboard - benchmarking-infra

- Surface: `infrastructure-enterprise`
- Priority: `P0`
- Status: `needs_public_benchmark_data`
- Blocker: `public_leaderboard_data`
- Current scope: The benchmark harness, local evidence contract, and sample reference report exist; competitor and hardware leaderboard claims need reproducible public runs.

Build or proof required:
- Run public tasks against Kolm artifacts, OpenAI, Anthropic, Gemini, local GGUF, browser worker, and at least one hosted open-model baseline.
- Publish raw JSON, command lines, model versions, hardware, latency, cost, and scoring method.
- Add freshness and retest cadence to /benchmarks.

Done when:
- /benchmarks contains reproducible multi-provider data and raw report links.
- Marketing copy cites only benchmarked claims and includes dataset/date context.
- verify:sota passes with public leaderboard evidence attached.

Verification:
- `npm run verify:benchmark-evidence`
- `npm run verify:sota`
- `node scripts/bench-compare.mjs --help`

Evidence paths:
- `src/benchmark-evidence.js`
- `scripts/benchmark-evidence.mjs`
- `docs/benchmark-evidence.md`
- `tests/wave589-benchmark-evidence-contract.test.js`
- `public/benchmarks/trinity-500-benchmark.json`

### W573-compliance-certification - compliance-certifications

- Surface: `infrastructure-enterprise`
- Priority: `P0`
- Status: `needs_live_certification`
- Blocker: `live_auditor_certification`
- Current scope: Security controls, BAA copy, and evidence hooks exist locally; formal compliance claims require auditor/certification artifacts and live production evidence.

Build or proof required:
- Collect SOC 2, ISO 27001, HIPAA BAA, GDPR DPA, FedRAMP boundary, SBOM, and SLSA evidence packets.
- Attach auditor reports or signed attestations through reports/compliance-certification-manifest.json.
- Update public trust pages to distinguish controls implemented from certifications awarded.

Done when:
- Trust pages link dated auditor/certification evidence or stay scoped to implemented controls.
- Enterprise readiness exports include the same evidence IDs and manifest hashes.
- verify:sota passes with certification evidence attached or this item remains explicitly blocked.

Verification:
- `npm run verify:sota`
- `npm run lint:refs`
- `npm run verify:compliance-packet`
- `node --test --test-concurrency=1 tests/wave592-compliance-certification-packet.test.js`

Evidence paths:
- `public/security.html`
- `public/baa.html`
- `docs/kolm-format-v1.md`
- `.github/workflows/sdk-c-rust.yml`
- `src/compliance-certification-packet.js`
- `scripts/compliance-certification-packet.mjs`
- `docs/compliance-certification-packet.md`
- `tests/wave592-compliance-certification-packet.test.js`

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
- `node scripts/package-release-readiness.mjs --smoke-installers --summary`
- `node scripts/package-release-readiness.mjs --run-local-checks --summary`
- `node scripts/build-deb.mjs --dry-run --json`
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -WhatIf`

Evidence paths:
- `scripts/install.ps1`
- `packages/homebrew`
- `packages/apt`
- `packages/winget`
- `src/package-release-readiness.js`
- `scripts/package-release-readiness.mjs`
- `docs/package-release-readiness.md`

### W566-runtime-adapters - ecosystem-runtime-adoption

- Surface: `format-standard`
- Priority: `P1`
- Status: `needs_external_partner`
- Blocker: `external_runtime_adoption`
- Current scope: Kolm runtime and compute adapters exist locally; native third-party support is not claimable until external projects merge or publish support.

Build or proof required:
- Create adapter packets for Ollama, llama.cpp, ONNX/GGUF, Hugging Face Hub, and hardware partners.
- Record merged or published external integration evidence in reports/runtime-adoption-manifest.json.
- Document compatibility tests and supported artifact subset per runtime.

Done when:
- Every required external target row has merged/published status and conformance-report hash.
- The runtime support matrix links to external artifacts, merged code, or package records.
- verify:sota passes with third-party adoption evidence attached.

Verification:
- `npm run verify:governance-packets`
- `npm run verify:sota`
- `npm run build:readiness-closeout -- --check`

Evidence paths:
- `docs/kolm-format-v1.md`
- `src/compute/registry.json`
- `public/runtimes.html`
- `src/runtime-adoption-packets.js`
- `scripts/runtime-adoption-packets.mjs`
- `docs/runtime-adoption-packets.md`

### W565-format-governance - foundation-standardization

- Surface: `format-standard`
- Priority: `P1`
- Status: `needs_external_partner`
- Blocker: `external_partner_acceptance`
- Current scope: The public v1 spec is shipped locally; neutral stewardship is not claimable until an outside standards venue or foundation accepts the process.

Build or proof required:
- Publish the RFC packet and governance proposal from docs/format-governance-packet.md.
- Record accepted public venue evidence in reports/format-governance-submission.json.
- Add the accepted governance venue and compatibility policy to /spec.

Done when:
- A neutral venue or foundation process is publicly linked and accepted.
- The spec has an external change-control path, versioning rules, and conformance-suite hash.
- verify:sota passes with this requirement promoted to implemented or shipped.

Verification:
- `npm run verify:governance-packets`
- `npm run verify:sota`
- `npm run build:readiness-closeout -- --check`

Evidence paths:
- `docs/kolm-format-v1.md`
- `public/spec.html`
- `src/format-governance-packet.js`
- `scripts/format-governance-packet.mjs`
- `docs/format-governance-packet.md`

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
- `node scripts/verify-sdk-dist.mjs sdk-ts --json`
- `node scripts/verify-sdk-dist.mjs sdk-rn --json`
- `npm run verify:package-release`
- `node scripts/build-browser-extension.mjs --dry-run --json`
- `node --test --test-concurrency=1 tests/wave591-package-local-build-contract.test.js`

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
- `src/package-release-readiness.js`
- `scripts/package-release-readiness.mjs`
- `scripts/verify-sdk-dist.mjs`
- `docs/package-release-readiness.md`
- `packages/sdk-ts/dist/index.js`
- `packages/sdk-rn/dist/index.js`
- `packages/attestation/tests/attestation.test.js`
- `scripts/build-browser-extension.mjs`
- `tests/wave591-package-local-build-contract.test.js`

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
- `node scripts/verify-sdk-dist.mjs sdk-rn --json`
- `npm run verify:package-release`
- `node --test --test-concurrency=1 tests/wave591-package-local-build-contract.test.js`

Evidence paths:
- `packages/sdk-swift`
- `packages/sdk-kotlin`
- `packages/sdk-rn`
- `src/package-release-readiness.js`
- `scripts/package-release-readiness.mjs`
- `scripts/verify-sdk-dist.mjs`
- `docs/package-release-readiness.md`
- `packages/sdk-rn/dist/index.js`
- `packages/sdk-rn/ios/KolmRN.swift`
- `packages/sdk-rn/android/src/main/java/ai/kolm/rn/KolmRNModule.kt`
- `packages/sdk-swift/Tests/KolmTests/KolmTests.swift`
- `packages/sdk-kotlin/src/main/AndroidManifest.xml`
- `tests/wave591-package-local-build-contract.test.js`

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
- `node scripts/verify-sdk-dist.mjs sdk-ts --json`
- `npm run verify:package-release`
- `node --test --test-concurrency=1 tests/wave591-package-local-build-contract.test.js`

Evidence paths:
- `public/sdk.js`
- `public/recipe-worker.js`
- `packages/sdk-ts`
- `src/package-release-readiness.js`
- `scripts/package-release-readiness.mjs`
- `scripts/verify-sdk-dist.mjs`
- `docs/package-release-readiness.md`
- `packages/sdk-ts/dist/index.js`
- `packages/sdk-ts/dist/index.d.ts`
- `tests/wave591-package-local-build-contract.test.js`


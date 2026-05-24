---
title: kolm packages | kolm.ai
description: SDK, runtime, and installer package release readiness without publishing.
---

# kolm packages

> Checks whether the SDK, runtime, adapter, and installer channels are locally release-ready. It never publishes packages, contacts registries, or prints secrets.

## Usage

```bash
kolm packages release-readiness [--summary|--json]
kolm packages release-readiness --catalog [--json]
kolm packages release-readiness --target=<id> --json
kolm packages release-readiness --smoke-installers [--summary|--json]
kolm packages release-readiness --run-local-checks [--target=<id>] [--summary|--json]
kolm packages release-readiness --template [--json]
kolm packages release-readiness --validate reports/package-release-manifest.json [--summary|--json]
```

## Targets

Package readiness covers TypeScript/browser runtime, React Native, attestation npm, LangChain, LlamaIndex, Python, Rust, SwiftPM, Android/Kotlin, Homebrew, apt, winget, direct installers, and the browser verifier extension.

## Examples

```bash
kolm packages release-readiness --summary --require-local-contract
kolm packages release-readiness --target=sdk-ts --json
kolm packages release-readiness --run-local-checks --summary
kolm packages release-readiness --template
kolm evidence package-release --summary --require-local-contract
```

## See also

- [kolm evidence](/docs/cli/evidence)
- [kolm runtime](/docs/cli/runtime)
- [SDKs](/sdks)
- [Runtimes](/runtimes)

---
title: kolm evidence | kolm.ai
description: Local proof packets for benchmark, package, partner, and certification readiness gates.
---

# kolm evidence

> Runs the same local evidence packets used by product-depth and release readiness checks. It does not publish packages, contact registries, claim external adoption, or claim live certification.

## Usage

```bash
kolm evidence [--summary|--json]
kolm evidence format-governance [--summary|--json|--catalog|--template]
kolm evidence runtime-adoption [--summary|--json|--catalog|--template]
kolm evidence compliance-certification [--summary|--json|--catalog|--template]
kolm evidence package-release [--summary|--json|--catalog|--template]
kolm evidence benchmark [--summary|--json|--catalog|--template]
kolm evidence quality [--summary|--json]
```

## Gates

- No subcommand returns the combined local evidence envelope across every gate.
- `format-governance` proves the local .kolm governance packet and names the external neutral-stewardship blockers.
- `runtime-adoption` proves runtime adapter packets and names the external merge/package blockers.
- `compliance-certification` proves local trust evidence and names missing auditor/legal certification artifacts.
- `package-release` proves SDK/runtime/installer package structure and names missing signed channel artifacts.
- `benchmark` proves benchmark evidence shape and names missing public provider data.
- `quality` proves quality calibration fixtures and keeps broad public claims scoped.

## Examples

```bash
kolm evidence --summary --require-local-contract
kolm evidence --json
kolm evidence format-governance --summary --require-local-contract
kolm evidence runtime-adoption --summary --require-local-contract
kolm evidence compliance-certification --template
kolm evidence package-release --summary --require-local-contract
kolm evidence benchmark --summary --require-local-contract
kolm evidence quality --summary
```

## See also

- [kolm surfaces](/docs/cli/surfaces)
- [kolm packages](/docs/cli/packages)
- [Product graph](/product-graph.json)
- [Readiness closeout](/product-readiness-closeout.json)

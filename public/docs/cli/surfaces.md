---
title: kolm surfaces | kolm.ai
description: Product journey, readiness, package, benchmark, and quality map for operators.
---

# kolm surfaces

> Prints the account, CLI, TUI, API, customization, and proof contract for every product journey. Use it before deploys or when validating that account, CLI, TUI, API, and docs still agree.

## Usage

```bash
kolm surfaces [--json]
kolm surfaces --graph --json
kolm surfaces --readiness
kolm surfaces --closeout --json
kolm surfaces --packages
kolm surfaces --benchmarks
kolm surfaces --quality
```

## What It Shows

- Product journeys and their account pages.
- CLI commands and TUI views that mirror each journey.
- API routes and customization dimensions.
- Readiness counts and named closeout waves for non-final gates.
- Package, benchmark, and quality evidence when requested.

## Examples

```bash
kolm surfaces --readiness
kolm surfaces --packages --benchmarks --quality
kolm surfaces --graph --json
kolm surfaces --closeout --json
```

## See also

- [kolm evidence](/docs/cli/evidence)
- [kolm packages](/docs/cli/packages)
- [Product graph](/product-graph.json)
- [Readiness closeout](/product-readiness-closeout.json)

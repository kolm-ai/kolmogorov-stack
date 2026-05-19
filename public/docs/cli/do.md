---
title: kolm do · kolm.ai
description: Natural-language intent dispatcher. Plain English in, kolm verb out.
---

# kolm do

> Natural-language intent dispatcher. Routes a plain-English instruction through `src/intent.js` and runs the inferred verb.

## Usage

```bash
kolm do "<plain-english instruction>" [--dry-run] [--json]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--dry-run` | off | print the inferred verb + args without running |
| `--json` | off | emit `{intent:{verb,args,confidence,source,alternatives}, ran:bool}` as the first stdout line |

## Examples

```bash
kolm do "show me captures in namespace support"
kolm do "build a redactor from ./notes/"
kolm do --dry-run "list my models"
kolm do --json "what next"
```

## Notes

The classifier is keyword + regex + optional LLM fallback. It returns the top inferred verb plus the next 2 alternatives so you can inspect why it routed the way it did. With `--dry-run`, no command runs.

## See also

- [Quickstart](/quickstart)
- [kolm what](/docs/cli/what)
- [kolm next](/docs/cli/next)
- [kolm explain](/docs/cli/explain)
- [kolm fix](/docs/cli/fix)

---
title: kolm run · kolm.ai
description: Execute a .kolm artifact locally against a JSON or string input.
---

# kolm run

> Execute a .kolm artifact locally. Default output is just the recipe result; pass `--json` for the full doc.

## Usage

```bash
kolm run <artifact.kolm> --input <file|->                # read input from file or stdin
kolm run <artifact.kolm> '<input-json>' [--params ...]   # inline JSON
cat input.json | kolm run <artifact.kolm>                # stdin auto-detect
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--input <file|->` | none | read input from a file path or `-` for stdin. Recommended on Windows |
| `--params <json|@file>` | none | tenant-runtime config passed to the recipe via `lib.params`. Never re-signed into the artifact |
| `--json` | off | emit the full document (output + recipe + latency_us + k_score + receipt + audit) as parseable JSON |

## Examples

```bash
kolm run redactor.kolm '{"text":"call 555-1212"}'
kolm run redactor.kolm --input @sample.json
cat sample.json | kolm run redactor.kolm
kolm run redactor.kolm '{"text":"call 555-1212"}' --json

# tenant runtime params
kolm run redactor.kolm '{"text":"id 12-345"}' \
  --params '{"extra_patterns":[{"name":"emp_id","regex":"\\b\\d{2}-\\d{3}\\b","replacement":"[ID]"}]}'

kolm run redactor.kolm '{"text":"..."}' --params @hospital-rules.json
```

## Windows quoting note

Windows `cmd.exe` does not honor single quotes, and PowerShell expands `$` inside double-quoted JSON. The portable form is `--input @sample.json` or piped stdin.

```powershell
PS> echo {"text":"hi"} > in.json
PS> kolm run x.kolm --input in.json
```

bash/zsh/git-bash users can keep single-quoted JSON.

## Notes

The input is parsed as JSON when possible; otherwise passed as a bare string. Default output is the recipe's output only (pretty JSON or string) with a one-line footer on stderr: `recipe: <id> latency`. Pipes cleanly:

```bash
kolm run x.kolm 'foo' | jq .
```

## See also

- [Quickstart](/quickstart)
- [API reference](/docs/api)
- [kolm eval](/docs/cli/eval) for the embedded eval re-run
- [kolm bench](/docs/cli/bench) for reproducible benchmarks

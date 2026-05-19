---
title: kolm capture · kolm.ai
description: Drop-in proxy for OpenAI and Anthropic that captures (input, output) pairs into a namespace.
---

# kolm capture

> Drop-in proxy for OpenAI / Anthropic. Captures every round trip into a namespace so you can distill later.

## Usage

```bash
kolm capture --provider <openai|anthropic> --as <task-name> [--namespace <n>]
kolm capture status [--namespace <n>]
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--provider <p>` | required | `openai` or `anthropic` |
| `--as <task-name>` | required | logical task name (used as filename under `~/.kolm/capture/`) |
| `--namespace <n>` | `default` | corpus namespace. The threshold for `kolm distill` is per-namespace |

## Examples

```bash
kolm capture --provider openai --as ticket-classifier --namespace tickets
# ... your app makes 1000 calls ...
kolm capture status --namespace tickets
kolm distill --namespace tickets
```

## Notes

The first form writes `~/.kolm/capture/<task>.json` with the upstream URL and the headers your app should send. Point `OPENAI_BASE_URL` or `ANTHROPIC_API_URL` at the proxy and your existing SDK keeps working. Every round-trip is captured into the namespace's corpus.

Pass your real OpenAI / Anthropic key in the `x-upstream-api-key` header on each request. The kolm api key goes in `Authorization: Bearer kolm_...` as usual.

The status form prints how many pairs have been captured and how many are needed before `kolm distill` is unlocked (default threshold: 1000 pairs).

## See also

- [Quickstart](/quickstart)
- [kolm distill](/docs/cli/distill)
- [kolm tail](/docs/cli/tail) for the live SSE feed
- [API reference](/docs/api)

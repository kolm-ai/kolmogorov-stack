# kolm inspection verbs

Use the read-only CLI verbs when you need to prove whether a tenant, artifact, or cloud path is healthy. These commands do not mutate account or artifact state.

| Verb | Use it when |
| ---- | ----------- |
| `kolm status` | Confirm login state, tenant, plan, and base URL. |
| `kolm health` | Check cloud health, readiness, auth, capture durability, and round-trip time. |
| `kolm metrics` | Review capture, job, and artifact counters for a selected window. |
| `kolm artifacts` | List, show, and compare compiled artifacts visible to your key. |
| `kolm support-bundle` | Export redacted environment, logs, config, and health evidence for support. |

## Status

```bash
kolm status
kolm status --json
```

`kolm status` is the fastest answer to "am I logged in, which tenant am I using, and where will commands send traffic?"

## Health

```bash
kolm health
kolm health --require-ready --require-auth --require-capture --json
```

Use strict health in CI after deployment so cloud readiness and authenticated capture are both proven.

## Metrics

```bash
kolm metrics
kolm metrics --since 1h --json
```

Metrics rolls up recent captures, jobs, artifacts, and failures so operators can see whether the value loop is moving.

## Artifacts

```bash
kolm artifacts list
kolm artifacts show <hash>
kolm artifacts diff <hash-a> <hash-b>
```

Artifact inspection pairs with `kolm verify` when you need the signed manifest and receipt chain for audit.

## Support Bundle

```bash
kolm support-bundle
kolm support-bundle --out ~/Desktop
```

The bundle redacts secrets before writing config, recent logs, health output, metrics, and doctor-loop evidence.

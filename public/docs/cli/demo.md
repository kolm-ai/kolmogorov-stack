# kolm demo

The canonical close-the-loop demo. Seeds the local event lake with ~150
synthetic log-triage events so `optimize`, `dataset`, `bakeoff`, `build`,
`run`, and `what` all have real data to chew on without you having to wire
a proxy first. Every event is tagged `source_type=simulated`, so the receipt
chain never claims this corpus came from production.

## Usage

```
kolm demo list available demo flows
kolm demo list same as the no-arg form
kolm demo seed-log-triage [--count N] seed N events (default 150)
kolm demo seed-log-triage --namespace foo override default namespace
kolm demo reset --confirm purge the demo-log-triage namespace
```

## Flags

- `--count N` events to append (clamped to 20..5000, default 150). 100+
 events sharing one template signature is the threshold that trips
 `local_replacement_candidate` in `kolm optimize`.
- `--namespace n` defaults to `demo-log-triage`. If you change it, the
 follow-on `kolm dataset create` / `kolm build` commands must use the
 same value.
- `--json` machine-readable output.
- `--confirm` required by `kolm demo reset` (the only destructive subverb).

## Examples

```
kolm demo seed-log-triage
kolm lake stats
kolm optimize
kolm dataset create demo-log-triage
kolm bakeoff demo-log-triage
kolm build demo-log-triage
kolm run demo-log-triage.kolm "ERROR db timeout on checkout"
kolm what
```

## What it seeds

- 21 log archetypes spanning 6 categories: `db`, `network`, `auth`,
 `deploy`, `app-bug`, `infra`.
- 2 premium model labels (`openai/gpt-4o`, `anthropic/claude-sonnet-4-5`)
 on every event so the cheaper-model and local-replacement detectors
 both have signal.
- First 5 events share a single `request_hash` so `cache_candidate`
 fires alongside `local_replacement_candidate`.
- Every prompt uses the same shape (`Triage this log line. Reply ... Log: "<body>"`)
 so `templateSignature()` collapses the corpus to one cluster.

## Honest scope

This is synthetic data for demo purposes. The events carry
`source_type=simulated` end-to-end; `kolm lake inspect <id>` and the
receipt chain reflect that. Reset before any real capture run if you
plan to ship an artifact from production traffic.

## See also

- `kolm lake stats` to see the seeded events grouped by namespace.
- `kolm optimize` to see the opportunity engine pick up the seeded clusters.
- `kolm bakeoff <name>` runs the candidate matrix before `build`.
- `/quickstart` walks the same loop with real captures instead of seeds.
- `/k-score-explained` covers the production gate the built artifact passes.

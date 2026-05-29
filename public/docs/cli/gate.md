# kolm gate

Explain the conformal gate decision for a compiled artifact. The gate turns a
single composite K-score into a ship / abstain / reject decision backed by a
calibrated interval, so a borderline artifact is held back instead of being
green-lit on a point estimate.

## Usage

```
kolm gate explain <artifact.kolm> [flags]   render the ship/abstain/reject decision
```

## Flags

- `--gate <0..1>` ship threshold (default `0.85`).
- `--alpha <0..1>` mis-coverage rate for the conformal interval (default `0.10`,
 i.e. a 90% interval).
- `--judge-spread <s>` standard deviation across a judge panel; high spread can
 downgrade a ship to abstain.
- `--n-judges <n>` number of completed judges; below quorum can downgrade a ship
 to abstain.
- `--json` full JSON envelope.

## Examples

```
kolm gate explain ./support.kolm
kolm gate explain ./support.kolm --gate 0.90 --json
kolm gate explain ./support.kolm --judge-spread 0.18 --n-judges 1
```

The decision uses the calibrated interval when the artifact manifest carries a
conformal block; otherwise it falls back to the legacy scalar gate
(`composite >= gate` ships). `abstain` and `reject` are informational, but a
`reject` exits non-zero so CI can fail closed.

## Constraints

The gate decision is only as trustworthy as the eval behind the K-score. A
narrow or stale holdout produces a confident interval over the wrong
distribution. Verify before ship: confirm the receipt chain with
`kolm verify <artifact>.kolm` and re-check the gate after any change to the
holdout. The composite is for this artifact, not the base model.

## See also

- `kolm verify <artifact>.kolm` to confirm the receipt chain.
- `kolm score <artifact>.kolm` to recompute the K-score the gate reads.
- `/frozen-eval` for the frozen holdout that anchors the gate.
- `/verify-prod` for verifying the gate decision against production.
- `/spec/rs-1` (RS-1 v2.1) for the receipt schema the gate decision rides in.

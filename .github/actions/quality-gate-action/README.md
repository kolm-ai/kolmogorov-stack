# kolm-ai/quality-gate-action

One-line CI gate for a `.kolm` artifact. Verifies the signature + receipt chain,
blocks on K-Score regression vs a baseline, and posts a PR comment when the gate
fails.

## Quick start

```yaml
name: quality-gate
on:
  pull_request:
    paths:
      - 'spec/**'
      - 'artifacts/**'

permissions:
  contents: read
  pull-requests: write

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kolm-ai/quality-gate-action@v1
        with:
          artifact: artifacts/my-skill.kolm
          threshold: '0.85'
          baseline: artifacts/main.kolm
          namespace: my-skill
          kolm-api-key: ${{ secrets.KOLM_API_KEY }}
```

## Inputs

| Input | Default | What it does |
|---|---|---|
| `artifact` | (required) | Path to the `.kolm` artifact to gate. |
| `threshold` | `0.85` | Minimum K-Score (0.0 - 1.0). |
| `baseline` | `""` | Path to a baseline `.kolm` (typically the artifact pinned on `main`). When set, the gate fails on regression. |
| `max-regression` | `0.01` | Max allowed K-Score regression vs baseline as a fraction (0.02 = 2 percentage points). |
| `namespace` | `""` | Namespace label for the receipt envelope. |
| `kolm-api-key` | `""` | Only needed for tenant-scoped verification (the default offline verify does not need it). |
| `comment-on-pr` | `"true"` | Post a comment on the PR when the gate fails. Requires `pull-requests: write`. |
| `github-token` | `${{ github.token }}` | Used for the PR comment. |

## Outputs

| Output | What it is |
|---|---|
| `k-score` | K-Score of the candidate artifact. |
| `baseline-k-score` | K-Score of the baseline artifact (empty when no baseline supplied). |
| `delta` | Candidate minus baseline (positive = improvement). |
| `passed` | `"true"` or `"false"`. |
| `receipt-id` | Receipt id for the verification call. |

## What "PASSED" means

Three things in sequence:

1. `kolm verify <artifact>` returns `ok: true` (signature valid, recipe round-trip clean, receipt chain unbroken).
2. The candidate's K-Score is at least `threshold`.
3. If `baseline` is set, the candidate's K-Score is not more than `max-regression` below the baseline.

If any of the three fails, the gate exits non-zero and the workflow fails.

## What it does NOT do

- It does not retrain. If you want a "retrain on failure" loop, run `kolm compile --refit` in a separate job that depends on this one.
- It does not push artifacts. Use `actions/upload-artifact` or the `kolm-ai/kolm-publish-action` for that.
- It does not run inference. If you want to gate on live behavior (rather than the eval set baked into the artifact), pair this with `kolm bench --compare`.

## Related

- [`kolm-ai/kolm-publish-action`](https://github.com/kolm-ai/kolm-publish-action) — push the artifact + GGUF exports to your model registry once the gate passes.
- [`kolm verify` docs](https://kolm.ai/docs/cli/verify) — what the underlying check does.
- [K-Score docs](https://kolm.ai/k-score) — what the score is and what changes move it.

## License

Apache-2.0. See [LICENSE](https://github.com/kolm-ai/kolmogorov-stack/blob/main/LICENSE).

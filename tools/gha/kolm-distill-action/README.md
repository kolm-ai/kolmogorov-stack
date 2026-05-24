# kolm/distill-action (GitHub Action) — W820 template

STATUS: TEMPLATE, 2026-05-24. Not published to GitHub Marketplace this wave;
ships in the kolm repo at `tools/gha/kolm-distill-action/` so downstream users
can either copy the directory into their own repo or reference it locally with
`uses: ./tools/gha/kolm-distill-action`. The path will become
`uses: kolm/distill-action@v1` once the action is published.

## What it does

A composite GitHub Action that, on each workflow run:

1. Installs the `kolm` CLI (`npm install -g kolm-stack`).
2. Runs `kolm bakeoff` against the namespace declared in `kolm.yaml` (or
   the namespace passed as an input), reads the resulting K-Score, and
   compares it against the `k-score-gate`.
3. If `redistill-on-drop` is true and the K-Score dropped below the gate,
   triggers `kolm distill` to produce a fresh `.kolm` artifact.
4. If `publish-release` is true and the workflow run was triggered by a
   `release` event, uploads the produced `.kolm` to that release.

## Inputs

| Name                | Required | Default                  | Description                                                                            |
| ------------------- | -------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `kolm-api-key`      | yes      | —                        | Tenant API key (`ks_...`). Pass via `${{ secrets.KOLM_API_KEY }}`.                     |
| `namespace`         | no       | (from `kolm.yaml`)       | kolm namespace to bench-gate. Overrides any `kolm.yaml` default.                       |
| `k-score-gate`      | no       | `0.85`                   | Minimum K-Score; if measured K-Score < this value, the gate fails.                     |
| `redistill-on-drop` | no       | `true`                   | If true, runs `kolm distill` when the gate fails.                                      |
| `publish-release`   | no       | `false`                  | If true, uploads the new `.kolm` to the triggering release as an asset.                |
| `kolm-yaml-path`    | no       | `./kolm.yaml`            | Path to `kolm.yaml` inside the repo. Useful for monorepos.                             |
| `kolm-base-url`     | no       | `https://kolm.ai`        | Override for self-hosted kolm installs.                                                |
| `artifact-out`      | no       | `${{ runner.temp }}/kolm`| Directory the produced `.kolm` lands in.                                               |

## Outputs

All outputs are strings (GitHub Action contract). Compare them as strings.

| Name             | Type     | Meaning                                                                          |
| ---------------- | -------- | -------------------------------------------------------------------------------- |
| `kscore`         | string   | Measured K-Score for this run, e.g. `"0.873"`.                                   |
| `kscore-passed`  | string   | `"true"` if measured K-Score >= `k-score-gate`, else `"false"`.                  |
| `distill-ran`    | string   | `"true"` if a re-distill ran this run, else `"false"`.                           |
| `artifact-path`  | string   | Filesystem path to the produced `.kolm` artifact. Empty when no re-distill ran. |
| `release-url`    | string   | URL of the GitHub Release the artifact was uploaded to. Empty otherwise.         |

## Minimal workflow

```yaml
name: kolm

on:
  push:
    branches: [main]
  pull_request:

jobs:
  kolm-gate:
    runs-on: ubuntu-latest
    if: ${{ secrets.KOLM_API_KEY != '' }}
    steps:
      - uses: actions/checkout@v4
      - uses: ./tools/gha/kolm-distill-action
        id: kolm
        with:
          kolm-api-key: ${{ secrets.KOLM_API_KEY }}
          k-score-gate: '0.85'
      - name: Fail merge on K-Score regression
        if: steps.kolm.outputs.kscore-passed != 'true'
        run: |
          echo "K-Score below threshold; failing the merge gate."
          echo "Measured K-Score: ${{ steps.kolm.outputs.kscore }}"
          exit 1
```

The `if: ${{ secrets.KOLM_API_KEY != '' }}` guard mirrors the W211/W405
fix pattern: forks that import this workflow do NOT show a red X on every
unrelated commit when they have not configured the secret.

## With publish-release on a release event

```yaml
name: kolm-release

on:
  release:
    types: [published]

jobs:
  publish-kolm:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: ./tools/gha/kolm-distill-action
        id: kolm
        with:
          kolm-api-key: ${{ secrets.KOLM_API_KEY }}
          k-score-gate: '0.85'
          publish-release: 'true'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Print release URL
        if: steps.kolm.outputs.release-url != ''
        run: echo "Uploaded .kolm to ${{ steps.kolm.outputs.release-url }}"
```

## Quality-delta CLI

After a `kolm distill` produces a new artifact, you can diff it locally
against the prior version:

```bash
kolm diff dist/support-bot-v1.2.kolm dist/support-bot-v1.3.kolm
kolm diff dist/support-bot-v1.2.kolm dist/support-bot-v1.3.kolm --json
```

The `--json` output is the schema CI tooling should consume; see
`src/artifact-diff.js` for the field list (k_score, capture_count, teacher,
student_arch, param_count, bench_pass_rate, signed).

## Honest status

- The action is a TEMPLATE: pinning against `kolm/distill-action@v1` will
  404 until the action is published to GitHub Marketplace. Until then,
  reference it via the local path `./tools/gha/kolm-distill-action`.
- The action expects `kolm-stack` to install cleanly via npm. Pre-publish
  the action falls back to `npm install -g .` from the current checkout.
- `publish-release` only fires on `release` events; on a `push` or
  `pull_request` event it is a no-op even when `true`. This is intentional
  — we never create a release as a side effect of a push.
- The action exits non-zero (3 = MISSING_PREREQ, 4 = EXECUTION) on
  failure. Snake_case error tokens are emitted on stderr so downstream
  workflow steps can branch on them.

## Pairs with

- `tools/gha/kolm-distill-action/action.yml` — the composite action manifest.
- `.github/workflows/kolm-template.yml` — copyable workflow for downstreams.
- `docs/spec/kolm-yaml-schema.md` — the kolm.yaml schema.
- `docs/cookbook/kolm.yaml` — a real example kolm.yaml.

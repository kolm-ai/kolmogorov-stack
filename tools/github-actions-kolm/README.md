# kolm/distill-action GitHub Action -- v1 scaffold

STATUS: DRAFT, 2026-05-24

This directory holds the scaffolding for the `kolm/distill-action@v1`
GitHub Action. The Action is not yet published to the GitHub Marketplace;
this README is the input/output contract reviewers can hold us to before
v1 ships.

## Inputs

| Name                | Required | Default                       | Description                                                                                                                  |
| ------------------- | -------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `kscore_threshold`  | yes      | -                             | Float in `[0.0, 1.0]`. The K-Score below which the gate fails and a re-distill triggers.                                     |
| `teacher_id`        | no       | (from `kolm.yaml`)            | Override the teacher declared in `kolm.yaml` for this run. Useful for one-off "what if we used a cheaper teacher" PRs.       |
| `namespace`         | no       | (from `kolm.yaml`)            | Override the namespace whose captures feed the distill loop.                                                                 |
| `artifact_name`     | no       | (from `kolm.yaml`)            | The .kolm artifact name to gate against.                                                                                     |
| `kolm_yaml_path`    | no       | `./kolm.yaml`                 | Path to the kolm.yaml inside the repo. Useful for monorepos with per-package configs.                                        |
| `publish_release`   | no       | `false`                       | If `true`, attaches the produced .kolm to a GitHub Release tagged `kolm-distill-<sha>`.                                      |
| `force_redistill`   | no       | `false`                       | Re-distill every namespace even when the gate passes. Useful for scheduled "refresh" runs.                                   |
| `comment_on_pr`     | no       | `true`                        | Post a K-Score delta comment on the PR thread. Idempotent (overwrites the prior comment).                                    |
| `kolm_base_url`     | no       | `https://kolm.ai`             | Self-hosted kolm install URL; honoured for air-gapped CI runners.                                                            |

## Outputs

| Name             | Type    | Meaning                                                                                                                       |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `kscore`         | float   | The measured K-Score for this run.                                                                                            |
| `kscore_passed`  | string  | `"true"` if K-Score >= `kscore_threshold`, otherwise `"false"`. GitHub Action outputs are stringified; compare as strings.   |
| `artifact_path`  | string  | Local path to the produced .kolm artifact. Empty string if no re-distill ran.                                                |
| `artifact_hash`  | string  | sha256 of the produced .kolm. Empty string if no re-distill ran.                                                              |
| `distill_ran`    | string  | `"true"` if a re-distill was triggered, `"false"` otherwise.                                                                  |
| `release_url`    | string  | URL of the GitHub Release the artifact landed in, when `publish_release: true`.                                                |

## Example usage

The minimal viable workflow:

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
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - uses: kolm/distill-action@v1
        id: kolm
        with:
          kscore_threshold: 0.85
        env:
          KOLM_API_KEY: ${{ secrets.KOLM_API_KEY }}
      - name: Fail merge on K-Score regression
        if: steps.kolm.outputs.kscore_passed != 'true'
        run: exit 1
```

With release publishing and a PR comment:

```yaml
- uses: kolm/distill-action@v1
  id: kolm
  with:
    kscore_threshold: 0.85
    publish_release: 'true'
    comment_on_pr: 'true'
  env:
    KOLM_API_KEY: ${{ secrets.KOLM_API_KEY }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Security model

- The Action reads the kolm API key from `KOLM_API_KEY` set in the
  workflow `env:` block. The Action does not have direct access to
  `secrets.*`; the workflow file decides which secret to map.
- The Action does not exfiltrate secrets. The only network call goes
  to `kolm_base_url` (defaults to `https://kolm.ai`). Logs redact the
  bearer token before stdout printing.
- The Action requires `GITHUB_TOKEN` only when `publish_release:
  true` or `comment_on_pr: true`. Both paths use the default
  workflow token's `contents:write` and `pull-requests:write`
  scopes; no PAT required.
- The Action does not write to your repository's git history. It
  produces artifacts on disk and attaches them to a Release; the
  source tree stays untouched.
- The Action does not call `kolm pull` against any URL outside
  `kolm_base_url`. Air-gapped runners with self-hosted kolm work
  without modification.

## Self-hosted runner notes for GPU workloads

The hosted GitHub runners do not have GPUs. For distill loops that
need teacher / student GPU time, point the Action at a self-hosted
runner:

```yaml
jobs:
  kolm-gate:
    runs-on: [self-hosted, gpu]
```

Required on the self-hosted runner:

- Node 18+ for the Action's own JavaScript shim.
- The kolm CLI on the PATH (`npm i -g kolm` or `pip install kolm`).
- A CUDA-capable GPU if `teacher_id` points at a local teacher.
- Network reach to `kolm_base_url` for replays against the hosted
  registry.

If the runner is air-gapped, set `kolm_base_url` to your in-network
kolm install. The Action does not try to fall back to `https://kolm.ai`
when the configured base URL is unreachable; it fails loud so a
silent re-route to the public hostname can't leak data outside the
air gap.

For runners that share storage across jobs (typical for self-hosted
clusters), the Action writes to `${{ runner.temp }}/kolm/` so cleanup
is automatic at the end of the job. Captures and intermediate distill
artifacts do NOT leak to the next job's workspace.

## Honest status

- Action not yet published to GitHub Marketplace.
- The above input / output contract is the spec we are building
  against; treat it as a versioned PR target rather than working code.
- The reference workflow at `.github/workflows/kolm.yml` ships in the
  kolm repo with `if: false` on the distill job so the file is
  reference-only until the user enables it.
- The Marketplace listing will pin against semver tags; pinning
  against `@main` is not supported.

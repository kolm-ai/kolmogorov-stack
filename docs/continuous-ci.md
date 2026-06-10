# Continuous CI: gate pull requests on signed-evidence deltas

The `kolm-agent-audit` GitHub Action scans your agent logs on every pull
request, computes the signed delta against the prior report for the same
subject, and leaves ONE comment on the PR showing what changed: readiness
movement, control transitions, and finding counts. Raw finding detail never
appears in the comment or the job summary - it stays in the private report.

A repo adopts this in about ten minutes. Questions: dev@kolm.ai.

---

## Minute 0-2: the API key

1. Create a kolm API key (`ks_...`) in your kolm account.
2. Add it to the repo as a secret named `KOLM_API_KEY`
   (Settings -> Secrets and variables -> Actions -> New repository secret).

The key is the only credential the scan needs. It is never printed by the
script or the Action.

## Minute 2-7: scan every PR (report-only)

Add one workflow file. `report-only` is the default gate mode: the scan runs,
the PR comment and the job summary post, and the build never fails on findings.
Run it this way for the first week so the team sees the evidence before any
gate can block a merge.

```yaml
# .github/workflows/agent-security.yml
name: agent security
on: [pull_request]

permissions:
  contents: read
  pull-requests: write   # lets the action upsert its one PR comment

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kolm-ai/kolm/.github/actions/kolm-agent-audit@main
        with:
          logs: ./agent-traces              # a file or a directory of log files
          api-key: ${{ secrets.KOLM_API_KEY }}
          gate-mode: report-only            # the default; spelled out here
          github-token: ${{ github.token }} # enables the PR comment
```

The very first run on a subject has no prior signed report to diff against.
It prints `baseline established` and passes in every mode; the next run
reports the delta against it.

`logs` points at whatever your agents already emit: Datadog LLM Observability,
LangSmith, or OpenTelemetry exports are auto-detected and normalized, and
provider-native logs (LiteLLM / Helicone / Portkey / OpenRouter) pass straight
through. See `docs/onramp.md` for the full input matrix.

## Minute 7-10: turning on the gate

When the team has seen a few PR comments, flip one line:

```yaml
          gate-mode: fail-on-new-high
```

From then on the build fails only when the delta against the prior signed
report adds a high or critical finding, or a control newly enters `blocking`.
Improvements, unchanged posture, and low/medium movement merge freely.

When you want the stricter contract - nothing gets worse, ever - use:

```yaml
          gate-mode: fail-on-regression
```

## The PR comment

The Action upserts a single comment (it edits the same comment on every push,
identified by an internal marker, so the PR never fills with duplicates):

- A header line with the verdict and the readiness direction, for example:
  `kolm agent audit: 7/8 controls pass (readiness +6 vs last signed report)`.
- A compact table of ONLY the controls that changed: control id, name, and the
  `from -> to` status transition. One line per control.
- A counts line with zero detail: `2 new findings (1 high or critical), 3 resolved`.
  Finding titles, descriptions, and ids never appear - they stay in the
  private report.
- A link to the session in the kolm dashboard and, when you set `trust-slug`,
  the public Trust link.
- A footer naming the signed report id and where a reviewer verifies it
  offline: `signed report asrr_... - verify offline at https://kolm.ai/verify`.

The same content is ALWAYS written to the job summary (`GITHUB_STEP_SUMMARY`),
including on non-PR runs, so scheduled and push builds keep the evidence too.
To keep the summary but skip the comment, set `comment: "false"`.

## Gate mode reference

| Mode                 | When the build fails                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| `report-only`        | Never on findings. Scan, comment, and summary still run. The default.                |
| `fail-on-new-high`   | The delta vs the prior signed report adds a high or critical finding, OR a control newly enters `blocking`. |
| `fail-on-regression` | The delta is a regression: `regressed` is true, OR any control status worsened (`pass -> attention`, `attention -> blocking`, ...), OR a new high/critical finding appeared. |
| `legacy`             | The absolute thresholds: readiness below `min-readiness` (default 80) or any blocking finding when `fail-on-blocking` is true. No delta involved. |

Control status vocabulary: `pass`, `attention`, `blocking`, `untested`.
"Worsened" follows that order, with `untested` between `pass` and `attention`.

## Failure-mode rules

- First run on a subject (no prior signed report): `baseline established`, the
  gate passes in all modes.
- kolm API unreachable mid-gate: `report-only` never fails the build.
  `fail-on-new-high` and `fail-on-regression` fail CLOSED with a clear message,
  because an unverifiable gate is not a passed gate. To let builds proceed when
  the API is unavailable, pass `--fail-open` to the script or set
  `KOLM_FAIL_OPEN: "true"` in the step `env`.
- Unsigned scans cannot be delta-gated (the delta compares signed reports).
  Leave `sign` at its default of `true` for the two failing modes.
- A PR-comment failure (missing token, missing permission) warns and never
  fails the build.

## Legacy absolute thresholds

`min-readiness` and `fail-on-blocking` are the original absolute gate and are
kept for backward compatibility:

- They are authoritative when `gate-mode: legacy` (and when you run the script
  directly with no gate mode set).
- Under the delta gate modes they are enforced as an additional layer only
  when you opt in with `KOLM_AUDIT_ABSOLUTE_GATE: "true"` in the step `env`.
- Under `report-only` they never fail the build.

## Running the same gate outside GitHub

The Action is a thin wrapper over `scripts/kolm-audit-ci.mjs` (Node 18+, no
dependencies). Any CI can run it:

```bash
export KOLM_API_KEY=ks_xxx
node scripts/kolm-audit-ci.mjs ./agent-traces --gate-mode=fail-on-new-high
# pipe logs in:        cat traces.jsonl | node scripts/kolm-audit-ci.mjs
# tolerate API outage: node scripts/kolm-audit-ci.mjs ./agent-traces --gate-mode=fail-on-regression --fail-open
```

Environment reference (the Action maps its inputs onto these):

| Env var                       | Action input       | Default            |
| ----------------------------- | ------------------ | ------------------ |
| `KOLM_API_URL`                | `api-url`          | `https://kolm.ai`  |
| `KOLM_API_KEY`                | `api-key`          | (required)         |
| `KOLM_AUDIT_LOGS`             | `logs`             | stdin              |
| `KOLM_AUDIT_SOURCE`           | `source`           | `auto`             |
| `KOLM_AUDIT_SUBJECT`          | `subject`          | `Agent fleet`      |
| `KOLM_GATE_MODE`              | `gate-mode`        | `report-only` via the Action; `legacy` when unset on the bare script |
| `KOLM_FAIL_OPEN`              | (step `env`)       | `false`            |
| `KOLM_GITHUB_TOKEN`           | `github-token`     | (empty = no comment) |
| `KOLM_AUDIT_COMMENT`          | `comment`          | `true`             |
| `KOLM_TRUST_SLUG`             | `trust-slug`       | (empty)            |
| `KOLM_AUDIT_MIN_READINESS`    | `min-readiness`    | `80` (legacy)      |
| `KOLM_AUDIT_FAIL_ON_BLOCKING` | `fail-on-blocking` | `true` (legacy)    |
| `KOLM_AUDIT_ABSOLUTE_GATE`    | (step `env`)       | `false`            |
| `KOLM_AUDIT_SIGN`             | `sign`             | `true`             |
| `KOLM_AUDIT_RETENTION_DAYS`   | `retention-days`   | (none)             |

Exit code: `0` when the gate passes, `1` when it fails. Outputs written for
the Action: `readiness`, `blocking-count`, `report-id`, `trust-url`,
`verify-url`, `passed`, `baseline`, and `gate-mode`.

## Pairing with Continuous

Gate the PR on the scan, then refresh your public Trust link on the deploy
with `POST /v1/audit/continuous/deploy-hook` (see `docs/onramp.md`, section 6).
Set `trust-slug` on the Action so every PR comment carries the public link a
buyer can pin.

Questions: dev@kolm.ai

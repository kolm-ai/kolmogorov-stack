# Cloud Compute Broker

The broker is the backend decision contract for users who do not want to think
in provider names. They describe the workload, privacy boundary, artifact size,
dataset size, budget, and storage state; Kolm returns the safest executable
compute path or the exact missing configuration.

It is intentionally a planner. It does not spend money, launch a GPU, upload
training data, or print secret values. Execution still goes through existing
commands such as `kolm cloud train`, `kolm remote plan training`,
`kolm cloud deploy-plan`, and `kolm cloud storage --smoke`.

## Inputs

```bash
node scripts/cloud-compute-broker.mjs \
  --workload train \
  --privacy standard \
  --params-b 7 \
  --rows 2000 \
  --seeds ./seeds.jsonl \
  --base-model Qwen/Qwen2.5-7B-Instruct \
  --no-local-gpu
```

Supported workloads:

- `train`
- `distill`
- `compile`
- `quantize`
- `inference`
- `serve`

Supported privacy modes:

- `standard`
- `regulated`
- `zero_retention`
- `airgap`

## Decision Rules

- Air-gapped work can only choose local or user-owned SSH lanes.
- Regulated work prefers local, user-owned SSH, or customer cloud lanes.
- Managed GPU lanes are allowed for `standard` and `zero_retention` plans but
  still require explicit customer credentials before execution.
- Cloud artifact storage is required before remote training, deploy, or edge
  serving can be called ready.
- A command is returned as `run_command` only when the lane is feasible and
  configured. Otherwise the broker returns `quote_command` plus missing env refs.
- Secret values are never included in the response.

## Smoke Simulations

The script includes fixture environments for CI and local verification:

```bash
node scripts/cloud-compute-broker.mjs --simulate runpod-r2 --workload train --params-b 7 --rows 2000 --no-local-gpu --summary --require-ready
node scripts/cloud-compute-broker.mjs --simulate ssh-s3 --workload distill --privacy regulated --params-b 13 --summary --require-ready
node scripts/cloud-compute-broker.mjs --simulate cloudflare-edge --workload serve --params-b 1 --artifact phi-redactor --summary --require-ready
node scripts/cloud-compute-broker.mjs --simulate empty --workload train --privacy airgap --no-local-gpu --summary
```

## Product Surfaces

- CLI: `kolm cloud broker ...`
- Script/CI: `node scripts/cloud-compute-broker.mjs ...`
- Storage dependency: `src/object-storage.js`
- Deploy dependency: `src/deployment-plans.js`
- Training dependency: `kolm cloud train`
- Remote planning dependency: `kolm remote plan training`

## Definition of Done

The broker is production-ready when:

- The catalog covers local, user-owned SSH, rented GPU, managed training,
  customer cloud, and edge-runtime lanes.
- The planner refuses fake success when privacy, storage, memory, or env
  prerequisites are not met.
- CI runs `npm run verify:cloud-broker`.
- Account/CLI/frontend surfaces render the same selected lane, blockers,
  missing env refs, and command without exposing secrets.

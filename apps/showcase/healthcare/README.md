# Healthcare showcase

A buildable end-to-end demonstration of the HIPAA PHI redactor pack on
real-shaped synthetic data. Buyer-facing: a finance / IT / compliance
team should be able to clone the repo, run one command, and have a
working `.kolm` artifact in under two minutes.

## What this builds

A pattern-mode `.kolm` artifact that redacts the 18 HIPAA Safe Harbor
identifier categories. Pattern-mode means it ships as compiled
JavaScript executing under V8 — no model weights, no GPU, no
dependencies, ~1µs per call (`docs/bench/tps-phi-redactor.json`).

The artifact carries:

- A real **receipt chain** signed with HMAC-SHA256
- A real **CID** computed from the canonical-JSON of `manifest.hashes`
- A `kolm-credential/0.1` provenance credential
- The K-score gate evaluation results
- The compliance pack metadata that proves it was built from the
  `hipaa-phi-redactor` pack

## Build

```sh
node apps/showcase/healthcare/build.mjs
```

Output: `apps/showcase/healthcare/dist/phi-redactor.kolm` (plus the
unpacked manifest / receipt / credential for inspection).

## Inspect

```sh
node cli/kolm.js inspect apps/showcase/healthcare/dist/phi-redactor.kolm --verify on
```

You should see the receipt body verify, the CID round-trip, and the
credential signature check.

## Use

```sh
node apps/showcase/healthcare/run.mjs "Patient John Doe, MRN 8847-21, called from 555-201-8842."
```

Output:

```
Patient [NAME], MRN [MRN], called from [PHONE].
```

## What it does NOT do

- It is **not** a fine-tuned LoRA model. It is a 17-pattern redactor.
  The fine-tuned LoRA path uses the same compliance pack but requires
  GPU + a labeled corpus and is the upgrade path past the 2-hour
  onboarding.
- It does **not** ship with PHI. Every example in
  `data/compliance-packs/hipaa-phi-redactor/examples/seed.jsonl` is
  synthesized.
- It is **not** an Expert Determination certifier. See `evidence.md`
  in the compliance pack for scope language.

# Distill Strategy Oracle

The distillation strategy oracle decides whether Kolm should train at all, and
if it should, which objective is justified by the evidence. It prevents the
bad product behavior where every workflow is pushed into a generic fine-tune.

The oracle is a planner only. It does not call a teacher model, upload data, or
start a paid job. It returns a ranked plan and emits a runnable command only
when the strategy is feasible under the data, holdout, privacy, and teacher
constraints.

## Strategies

- `collect_more_real_pairs`
- `rule_or_cache_first`
- `small_classifier`
- `lora_sft`
- `kd_top_k`
- `kd_softmax`
- `rejection_sampling`
- `preference_optimization`
- `onpolicy_distill`
- `speculative_decoding_train`

## Example

```bash
node scripts/distill-strategy.mjs \
  --task generation \
  --real-pairs 1500 \
  --holdout-pairs 300 \
  --simulate anthropic \
  --summary \
  --require-ready
```

For cold starts, synthetic-only data, missing holdout, missing teacher, or
air-gapped teacher use, the oracle will not claim a distillation plan is ready.
It returns collection/configuration actions instead.

## Product Contract

- Real pairs and holdout pairs are explicit gates.
- Synthetic-only datasets are not trainable for production claims.
- Teacher-required objectives require a configured teacher or local teacher URL.
- Air-gapped and regulated modes avoid external teacher objectives.
- Preference objectives require preference pairs.
- On-policy objectives are prioritized when an existing artifact can collect
  live feedback.
- Rejection sampling is prioritized for noisy labels or low teacher agreement.

## Verification

```bash
npm run verify:distill-strategy
node --test --test-concurrency=1 tests/wave584-distill-strategy.test.js
```

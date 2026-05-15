# Tune Evolution Governance Audit - 2026-05-12

## Executive Summary

`kolm tune` is an important product surface because it promises the loop buyers want: run an artifact locally, capture production signal, train a local adapter, evaluate it against the same K-score gate, promote only if it improves, and keep the whole loop airgapped.

The implementation has useful preview pieces, but it is not yet a governed closed loop:

- `tune init` creates a real per-artifact tune directory, config file, `HEAD`, and zero-init adapter skeleton.
- `tune capture-on` can append successful run inputs and outputs to a local `captures.jsonl` file.
- `tune step --airgap` sets offline environment flags and the Python trainer refuses missing or remote-looking base model paths.
- The Python trainer source parses, loads PEFT/Transformers when installed, trains, and writes adapter files.
- The public evolve page and `docs/TUNE.md` include honest body-copy caveats that the adapter does not yet influence deterministic recipe execution.

The gaps are launch-blocking for any claim that the system already learns, gates, and promotes adapter improvements:

- `evalRevision` asks `inspectArtifact()` for `info.evals`, but `inspectArtifact()` returns only `evals_n`, not the eval cases. A local probe against the verified sample artifact returned `pass: 0/0` and K-score `0.4415`.
- Even after that contract bug is fixed, `evalRevision` ignores the requested revision and does not run the trained adapter.
- `promoteRevision` does not enforce `require_improvement`; it only checks the candidate against `k_min` and writes `HEAD` plus `head.prev`.
- Promotion does not rewrite or re-sign the `.kolm` bundle, move an adapter into the artifact, or hot-reload a running server, despite comments and public wording implying a stronger promotion.
- Captures store raw inputs and outputs locally without redaction, encryption, consent metadata, retention controls, or purge hooks.
- Airgap mode is an environment and base-path guard, not an OS-level network sandbox. Non-airgap training can still use remote model ids.
- `tune watch` automates the same flawed eval/promotion path, ignores `sample_size`, and has no locking, durable supervision, or backoff policy.

## Primary Evidence

- Live `https://kolm.ai/evolve` returned HTTP 200. Its meta and hero copy describe local fine-tune, local lookup, K-score-gated promotion, and no phone-home behavior. The body also includes caveats that adapter-driven K-score improvement is target architecture, not shipped today.
- Local `public/evolve.html` contains a terminal-style sample with `K-score 0.93` and `pass 14/15`, but the current local tune eval path returned `pass: 0/0` and `K-score: 0.4415` for `test/fixtures/sample.kolm`.
- Local `src/tune.js` writes `~/.kolm/tune/<slug>/tune-config.json`, `revisions/v0/adapter_config.json`, and `HEAD` during init.
- Local `src/tune.js` appends `ts`, `input`, `output`, `recipe`, and `latency_us` to `captures.jsonl` when captures are on.
- Local `src/tune.js` sets `KOLM_AIRGAP=1`, `TRANSFORMERS_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`, and `HF_HUB_OFFLINE=1` before spawning the Python trainer when `--airgap` is used.
- Local `scripts/tune-step.py` sets the same offline flags in airgap mode, refuses a `base_model` that contains `://` or does not exist locally, imports PEFT/Transformers, trains, and saves adapter/tokenizer files.
- Local `src/tune.js:evalRevision` imports `inspectArtifact()` and reads `info.evals || []`; local `src/artifact-runner.js:inspectArtifact` returns `evals_n`, not eval cases.
- Local `src/tune.js:evalRevision` takes `revision` but does not use it to load or execute an adapter.
- Local `src/tune.js:promoteRevision` assigns `headK = candidate.k_score` and never compares to current head despite `require_improvement: true` in config.
- Local `src/tune.js:promoteRevision` writes `HEAD` and `head.prev`; it does not modify the artifact bundle, signature, manifest, or serve state.
- Local `cli/kolm.js` catches all `tune step` failures and exits `1`, even though `docs/TUNE.md` says missing Python deps exit `64`.
- Local `src/tune.js` error text says users can set `KOLM_TUNE_TRAINER`, but the implementation does not read that variable.
- Local `tests/` contains no focused tune, capture, adapter, promotion, watch, airgap, trainer, or evolve-copy tests.
- `node --check` passed for `src/tune.js`; `python -m py_compile scripts/tune-step.py` passed in the local environment where Python was available.

## What Is Solid

The tune file layout is real. Init and status can reason about a per-artifact local state directory, revisions, head pointer, gate config, watch config, and capture count.

The trainer source is a credible preview implementation. It uses standard PEFT and Transformers APIs, emits JSON stats, and has a clean dependency-missing path.

The airgap flag has meaningful guardrails when it is explicitly used: offline environment flags plus a local-path existence check before model loading.

The documentation has useful honesty in the body. Both the evolve page and `docs/TUNE.md` disclose that the adapter does not yet affect deterministic recipe execution. That caveat should govern the page metadata, hero, examples, and release labels.

## Main Gaps

The biggest gap is evaluation truth. The tune gate does not currently load eval cases through `inspectArtifact()`, and it does not exercise the trained adapter. That makes promotion a local state flip, not proof that the adapter improved behavior.

The second gap is promotion semantics. The code and docs talk about gated promotion and rollback, but the shipped action is only `HEAD` file mutation under `~/.kolm/tune`. There is no artifact mutation, signature renewal, manifest update, registry state, or server reload.

The third gap is capture governance. Raw production input and output are training data. For enterprise or regulated use, the capture file needs opt-in state, redaction, retention, purge, encryption-at-rest options, and audit events.

The fourth gap is airgap precision. `--airgap` is a useful mode, but "nothing phones home" is too broad unless every path in the loop is forced through that mode and backed by network denial at the process or OS layer.

The fifth gap is automation risk. `tune watch` can automatically train and promote from the same flawed signal path. It should not auto-promote until eval, improvement, capture governance, and process supervision are fixed.

## Recommended Policy

Treat local tune as preview until the closed loop is real:

- Fix `evalRevision` to load embedded eval cases from the artifact bundle or reuse `evalArtifact()` directly.
- Define an adapter-backed evaluation path before claiming adapter improvement. If deterministic recipes remain adapter-blind, label tune eval as artifact re-validation.
- Enforce `require_improvement` by comparing candidate and current head scores using the same eval set.
- Decide whether promotion means a local `HEAD` flip or a signed artifact revision. If it is only a local pointer, say so.
- Preserve trainer exit codes and either implement `KOLM_TUNE_TRAINER` or remove the hint.
- Add capture controls before positioning captures as production training signal.
- Make airgap wording conditional on `--airgap` and add a network-denial smoke if "no phone-home" remains a release claim.
- Disable watcher auto-promote by default until eval and improvement semantics are tested.
- Add CI coverage for init, capture, step error paths, airgap base checks, eval cases, promote gates, rollback, watch, and evolve public-copy claims.

## Buyer Impact

Tune can become a strong wedge only if buyers can trust the improvement gate. The current safe framing is: "local tune state, capture buffer, and PEFT trainer preview are present; adapter-driven runtime improvement and signed promotion are target architecture." The launch-ready framing needs a tested adapter-backed eval path, governed capture data, and promotion proof that is visible on the artifact or registry record.

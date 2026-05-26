# kolm spec reference

The spec is the **single input** to `kolm compile`. Author one as a JSON document
(`spec.json`), feed it in via `kolm compile --spec spec.json` (or `--spec -` from
stdin), and get a signed `.kolm` artifact out.

This page is the canonical field-by-field reference. Source of truth:
[`src/spec-compile.js`](../src/spec-compile.js) `validateSpec()` + `compileSpec()`.

A TOML front-end (`spec.toml`) is planned for v0.6 — the JSON shape below is the
stable contract; the TOML version will be a 1:1 mapping.

---

## Minimum viable spec

```json
{
  "job_id": "job_sentiment_demo",
  "task": "sentiment binary classifier",
  "recipes": [
    {
      "id": "rcp_sentiment_v1",
      "name": "sentiment v1",
      "source": "function generate(input, lib) { return { sentiment: input.length > 0 ? 'unknown' : null }; }"
    }
  ],
  "evals": {
    "spec": "rs-1-evals",
    "cases": [
      { "id": "p1", "input": "loved this", "expected": { "sentiment": "positive" } }
    ],
    "coverage": 1.0
  }
}
```

Five fields are mandatory: `job_id`, `task`, `recipes` (≥1), each recipe needs
`id` + `name` + (`source` OR `dsl`). Everything else has a sensible default.

---

## Top-level fields

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `job_id` | string | — | yes | Unique slug. Regex `/^job_[a-z0-9_-]+$/i`. Becomes the artifact filename `<job_id>.kolm` and the manifest job key. |
| `task` | string | — | yes | Human-readable description. Surfaced in `kolm inspect` and the model card. ≥1 char. |
| `base_model` | string | `"none"` | no | HF repo id (e.g. `"Qwen/Qwen2.5-3B-Instruct"`) or `"none"` for rule-only artifacts. Drives `kolm fit` / `kolm hardware` projections. |
| `artifact_class` | string | `"recipe"` | no | One of `"recipe"`, `"compiled_rule"`, `"lora_adapter"`, `"full_model"`. `compiled_rule` requires every recipe to provide a `dsl` block (no raw JS). |
| `recipes` | array | — | yes | One or more recipe objects (see below). Order is preserved and significant for fall-through chains. |
| `evals` | object | `null` | no (but strongly recommended) | Eval set the K-Score is computed against. See `Evals object` below. |
| `pack` | object | `null` | no | Optional KOLMPACK metadata (display name, tags, vendor, license). Surfaced in the model card. |
| `index` | object | `null` | no | Optional KOLMIDX block (search-time hints used by Workbench). |
| `training_stats` | object | `null` | no | Optional pre-recorded training metrics (`pass_rate_positive`, `latency_p50_us`, etc). Shown in the manifest verbatim. |
| `comparator` | string | `"exact"` | no | How `expected` is compared to recipe output. One of `exact`, `subset`, `regex`, `levenshtein`, `numeric_close`. See `comparators.js`. |
| `split_seed` | integer | random | no | Seed for the train/holdout split when `seeds.jsonl` is supplied. Pin this if you want byte-stable artifacts across recompiles. |
| `holdout_ratio` | number 0..1 | `0.2` | no | Fraction of seed pairs held back for eval (only when a seeds file is used). |
| `seeds_path` | string | — | no | Path to a seeds JSONL file (`{"prompt":"…","completion":"…"}` per line). Triggers the Q+2 seed-gate path. Mutually exclusive-ish with inline `evals.cases` — if both supplied, inline cases win. |
| `examples_path` | string | — | no | Alias for `seeds_path` (legacy). |
| `examples` | integer | `200` | no | Target example count for compute estimation only. Not a hard cap. |
| `epochs` | integer | `3` | no | Training epochs (for LoRA / full-model targets). Ignored by recipe-only artifacts. |
| `batch_size` | integer | `4` | no | Mini-batch size. |
| `seq_len` | integer | `1024` | no | Max sequence length. |
| `max_seq_length` | integer | `1024` | no | Alias for `seq_len`. |
| `weights_url` | string | — | no | When the recipe is a LoRA-style wrapper, the URL of the trained weights blob. |
| `weights_sha256` | string | — | no | SHA-256 of the weights blob — verified at load time. |
| `rank` | integer | `8` | no | LoRA rank (only when `artifact_class` is `lora_adapter`). |

---

## Per-`recipes[]` entry

Each entry in `recipes[]`:

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `id` | string | — | yes | Recipe slug. Convention: `rcp_<slug>`. Must be non-empty. |
| `name` | string | — | yes | Human-readable. Surfaced in `kolm inspect`. |
| `source` | string | — | one of source/dsl | A JS function body, e.g. `"function generate(input, lib) { return …; }"`. Must compile under `src/verifier.js` `compileJs()`. |
| `dsl` | object | — | one of source/dsl | rule-dsl-v1 AST. See `src/dsl.js` `DSL_SPEC`. Required when `artifact_class` is `compiled_rule`. Triggers native C / Rust codegen for that recipe. |
| `version_id` | string | `"ver_<id-without-prefix>_001"` | no | Pin for receipt diffing. Bump on every meaningful source edit. |
| `tags` | array of string | `[]` | no | Free-form labels. Used by `kolm find` and the Studio search. |
| `schema` | object | `null` | no | Optional `{ input: <jsonschema>, output: <jsonschema> }`. Surfaced in `kolm describe`. |
| `params` | object | `null` | no | Recipe-specific runtime knobs. Surfaced verbatim in the manifest. |

A recipe that supplies **both** `source` and `dsl` is honored verbatim (source
wins for the JS path; DSL still ships so a verifier can recompute the C/Rust
targets). This is the recommended pattern for advanced authors who want a
custom JS path kept in lock-step with a declared DSL contract.

---

## Evals object

```json
"evals": {
  "spec": "rs-1-evals",
  "cases": [
    { "id": "p1", "input": "loved this", "expected": { "sentiment": "positive" }, "params": { "comparator": "exact" } }
  ],
  "coverage": 1.0
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `spec` | string | `"rs-1-evals"` | Eval-set format version. `rs-1-evals` is the only published format today. |
| `cases` | array | `[]` | One eval case per entry. Each case must have `id`, `input`, `expected`. `params.comparator` overrides the spec-level `comparator`. |
| `coverage` | number 0..1 | `0` | Self-declared coverage of the input space. Surfaced in the manifest but not enforced. |
| `n` | integer | `cases.length` | Optional explicit count — useful when `cases` is a sample and the full set lives at `seeds_path`. |

A case's `expected` is compared to the recipe's output under the chosen
comparator. `exact` (the default) requires deep-equal; `subset` accepts any
output that contains the expected keys; `regex` treats `expected` as a regex
pattern; `levenshtein` accepts edit-distance ≤ params.max_distance; `numeric_close`
accepts ≤ params.tolerance absolute difference.

---

## Comparators

Implemented in [`src/comparators.js`](../src/comparators.js). Pass either at
spec level (`spec.comparator`) or per-case (`case.params.comparator`).

| Comparator | Match rule | Use for |
|---|---|---|
| `exact` | Strict deep-equal | Classifiers, structured extraction |
| `subset` | Output is a superset of expected | Tolerant structured extraction |
| `regex` | `expected` is a regex applied to stringified output | Pattern matching |
| `levenshtein` | Edit-distance ≤ params.max_distance | Fuzzy string match |
| `numeric_close` | |output - expected| ≤ params.tolerance | Forecasts, scores |

---

## CLI / opts overrides

These are not spec fields but are flags / env vars that override spec defaults:

| CLI flag | Env var | Overrides | Notes |
|---|---|---|---|
| `--workload-profile latency` | `KOLM_WORKLOAD_PROFILE` | (none — sets manifest only) | One of `latency`, `batching`, `auto`. Pinned in manifest for kernel selection at serve time. |
| `--comparator regex` | — | `spec.comparator` | |
| `--seeds path.jsonl` | — | `spec.seeds_path` | Triggers the seed-gate path. |
| `--split-seed 7` | — | `spec.split_seed` | |
| `--holdout-ratio 0.3` | — | `spec.holdout_ratio` | Must be 0..1. |
| `--target c` / `--target rust` / `--target wasm` | — | (none) | Adds native compile targets. Requires the corresponding toolchain (`kolm doctor`). |
| `--cloud modal` / `--cloud runpod` | `KOLM_CLOUD` | (none) | Routes the compile to a cloud GPU partner. Requires API key + budget confirmation. |
| `--no-fit-check` | — | (none) | Skips pre-compile VRAM gate. Use when you know the spec fits or when running on cloud. |
| `--refit` | — | (none) | Forces a retrain even when manifest hash hasn't changed. |
| `KOLM_ARTIFACT_SECRET` | env | (none) | Override the per-user receipt secret. Set on every machine that needs to verify each others' artifacts byte-stably. |
| `RECIPE_RECEIPT_SECRET` | env | (none) | Alias for `KOLM_ARTIFACT_SECRET`. |

---

## Constraints + invariants

These are enforced at validate-time; violating one is a hard fail (`KOLM_E_SPEC_INVALID`):

1. `job_id` matches `/^job_[a-z0-9_-]+$/i`.
2. `recipes.length >= 1`.
3. Every recipe has `id`, `name`, and **one of** `source` or `dsl`.
4. If `artifact_class === "compiled_rule"`, every recipe must have a `dsl` block (raw JS is not eligible for native codegen — the DSL is what gets compiled to C / Rust).
5. `dsl` blocks must validate against `validateDsl()` (`src/dsl.js`).
6. `source` strings must compile under `compileJs()`.
7. `evals.cases` (when present) must be an array.
8. `comparator` must be one of the SUPPORTED_COMPARATORS list.
9. `workload_profile` (CLI / env / opts) must be `latency`, `batching`, or `auto`.
10. `holdout_ratio` must be 0..1.

---

## What ends up in the .kolm

After validation, `compileSpec()` writes a ZIP at `~/.kolm/artifacts/<job_id>.kolm` containing:

| Entry | Purpose |
|---|---|
| `manifest.json` | Top-level metadata + receipt hashes + K-Score |
| `spec.json` | The exact spec you passed in (canonicalized) |
| `recipes/<id>.js` | Each recipe's source (auto-emitted from `dsl` when only DSL was supplied) |
| `recipes/<id>.dsl.json` | The DSL AST (when supplied) |
| `recipes/<id>.c` / `.rs` / `.wasm` | Native codegen output (when `--target` set) |
| `evals/spec.json` | Eval-set as supplied (frozen, replayable) |
| `evals/holdout.jsonl` | Holdout split (when seed-gate path) |
| `evals/leakage-report.json` | Seed-vs-holdout leakage check |
| `receipts/data.json` | Data ring receipt (seeds hash, split hash) |
| `receipts/train.json` | Train ring receipt (recipe hashes, source hashes) |
| `receipts/eval.json` | Eval ring receipt (per-case pass/fail) |
| `receipts/sigstore.json` | Sigstore ring (ed25519 signature, signer identity) |
| `sidecar.ed25519` | Detached signature over manifest.json |
| `provenance/distill.json` | (When teacher signals were used) teacher model + logprobs hash |
| `provenance/export.json` | (When `--target` was set) toolchain version + outputs |
| `provenance/moe.json` | (For MoE artifacts) expert activation distribution |
| `provenance/pretokenize.json` | (For pretokenize-cache artifacts) cache hash + ratio |

Verify any artifact offline: `kolm verify <artifact.kolm>` re-runs every ring
and emits `ok: true` only when all four seals replay clean.

---

## Examples

### Rule-only artifact (no model)

```json
{
  "job_id": "job_email_classifier",
  "task": "email subject -> {spam, ham}",
  "recipes": [{
    "id": "rcp_keyword_v1",
    "name": "keyword classifier v1",
    "source": "function generate(input, lib) { const subj = String(input.subject || '').toLowerCase(); return { label: /viagra|nigerian prince|wire transfer/.test(subj) ? 'spam' : 'ham' }; }"
  }],
  "evals": {
    "spec": "rs-1-evals",
    "cases": [
      { "id": "s1", "input": { "subject": "URGENT: nigerian prince wire transfer" }, "expected": { "label": "spam" } },
      { "id": "h1", "input": { "subject": "your invoice for May" }, "expected": { "label": "ham" } }
    ],
    "coverage": 0.85
  }
}
```

### Compiled-rule artifact (native C / Rust target)

```json
{
  "job_id": "job_ssn_redactor",
  "task": "redact US SSN from input string",
  "artifact_class": "compiled_rule",
  "recipes": [{
    "id": "rcp_ssn_v1",
    "name": "SSN redactor",
    "dsl": {
      "spec": "rule-dsl-v1",
      "op": "replace_regex",
      "pattern": "\\b\\d{3}-\\d{2}-\\d{4}\\b",
      "with": "[REDACTED-SSN]"
    }
  }],
  "evals": {
    "spec": "rs-1-evals",
    "cases": [
      { "id": "r1", "input": "my ssn is 123-45-6789", "expected": "my ssn is [REDACTED-SSN]" }
    ]
  }
}
```

Compile with `kolm compile --spec ssn.json --target c --target rust`.

### LoRA adapter artifact

```json
{
  "job_id": "job_customer_support_lora",
  "task": "customer support tone adapter for Qwen 2.5 3B",
  "artifact_class": "lora_adapter",
  "base_model": "Qwen/Qwen2.5-3B-Instruct",
  "rank": 16,
  "epochs": 3,
  "batch_size": 8,
  "seq_len": 2048,
  "weights_url": "https://hub.kolm.ai/blobs/sha256:abcdef0123...",
  "weights_sha256": "abcdef0123...",
  "recipes": [{
    "id": "rcp_lora_routing_v1",
    "name": "LoRA routing wrapper",
    "source": "function generate(input, lib) { return lib.lora.infer({ adapter: 'rcp_lora_routing_v1', prompt: input.prompt }); }"
  }],
  "evals": {
    "spec": "rs-1-evals",
    "cases": []
  },
  "seeds_path": "./customer-support-pairs.jsonl",
  "holdout_ratio": 0.2,
  "comparator": "subset"
}
```

---

## Authoring tools

- `kolm init` — interactive scaffold for a new spec
- `kolm spec validate <file>` — dry-run validate without compiling
- `kolm fit <spec>` — projects VRAM / disk / wall-clock for a spec
- `kolm inspect <artifact>` — round-trip view of any compiled spec
- `kolm explain <spec>` — render the spec as natural-language for review

See also:
- [`docs/AUTHORING.md`](AUTHORING.md) — recipe authoring guide
- [`docs/distill-strategy.md`](distill-strategy.md) — when to LoRA vs full-model vs rule
- [`docs/cookbook/`](cookbook/) — worked examples

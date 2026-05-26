# kolm spec reference (TOML)

> This document is the TOML mirror of [spec-reference.md](spec-reference.md). The
> JSON shape is the canonical contract; the TOML form is a 1:1 mapping handled by
> `kolm spec toml-to-json` (or by passing `--spec foo.toml` to `kolm compile`).

The spec is the **single input** to `kolm compile`. Author one as a TOML
document (`spec.toml`), feed it in via `kolm compile --spec spec.toml` (or
`--spec -` from stdin with `--format toml`), and get a signed `.kolm` artifact
out — byte-identical to one compiled from the equivalent `spec.json`.

This page is the canonical TOML field-by-field reference. Source of truth:
[`src/spec-compile.js`](../src/spec-compile.js) `validateSpec()` +
`compileSpec()`, fronted by the TOML→JSON adapter in
[`src/spec-toml.js`](../src/spec-toml.js). Strict TOML 1.0 (parser:
[`@iarna/toml`](https://www.npmjs.com/package/@iarna/toml)).

The JSON shape in [spec-reference.md](spec-reference.md) is the stable contract;
every TOML form below round-trips to it without loss.

---

## Minimum viable spec

```toml
job_id = "job_sentiment_demo"
task   = "sentiment binary classifier"

[[recipes]]
id     = "rcp_sentiment_v1"
name   = "sentiment v1"
source = '''
function generate(input, lib) {
  return { sentiment: input.length > 0 ? 'unknown' : null };
}
'''

[evals]
spec     = "rs-1-evals"
coverage = 1.0

[[evals.cases]]
id       = "p1"
input    = "loved this"
expected = { sentiment = "positive" }
```

> **Mapping to JSON** — see [spec-reference.md § Minimum viable spec](spec-reference.md#minimum-viable-spec).
> `[[recipes]]` becomes one entry of the `"recipes": [ … ]` JSON array;
> `[evals]` becomes the `"evals": { … }` object; `[[evals.cases]]` becomes one
> entry of `"evals": { "cases": [ … ] }`.

Five fields are mandatory: `job_id`, `task`, `recipes` (≥1), each recipe needs
`id` + `name` + (`source` OR `dsl`). Everything else has a sensible default.

---

## Top-level fields

All top-level fields live at the **root** of the TOML document (above any
`[table]` headers). Order at the root is free; place arrays of tables
(`[[recipes]]`) and nested tables (`[evals]`, `[pack]`, `[index]`,
`[training_stats]`) **after** the root scalars to avoid accidental capture.

| Field | TOML type | Default | Required | Notes |
|---|---|---|---|---|
| `job_id` | string | — | yes | Unique slug. Regex `/^job_[a-z0-9_-]+$/i`. Becomes the artifact filename `<job_id>.kolm` and the manifest job key. |
| `task` | string | — | yes | Human-readable description. Surfaced in `kolm inspect` and the model card. ≥1 char. |
| `base_model` | string | `"none"` | no | HF repo id (e.g. `"Qwen/Qwen2.5-3B-Instruct"`) or `"none"` for rule-only artifacts. Drives `kolm fit` / `kolm hardware` projections. |
| `artifact_class` | string | `"recipe"` | no | One of `"recipe"`, `"compiled_rule"`, `"lora_adapter"`, `"full_model"`. `compiled_rule` requires every recipe to provide a `dsl` block (no raw JS). |
| `recipes` | array of table (`[[recipes]]`) | — | yes | One or more recipe tables (see below). Order is preserved and significant for fall-through chains. |
| `evals` | table (`[evals]`) | omitted | no (but strongly recommended) | Eval set the K-Score is computed against. See `Evals table` below. |
| `pack` | table (`[pack]`) | omitted | no | Optional KOLMPACK metadata (display name, tags, vendor, license). Surfaced in the model card. |
| `index` | table (`[index]`) | omitted | no | Optional KOLMIDX block (search-time hints used by Workbench). |
| `training_stats` | table (`[training_stats]`) | omitted | no | Optional pre-recorded training metrics. Shown in the manifest verbatim. |
| `comparator` | string | `"exact"` | no | How `expected` is compared to recipe output. One of `exact`, `subset`, `regex`, `levenshtein`, `numeric_close`. |
| `split_seed` | integer | random | no | Seed for the train/holdout split when a seeds file is supplied. Pin this for byte-stable artifacts across recompiles. |
| `holdout_ratio` | float 0..1 | `0.2` | no | Fraction of seed pairs held back for eval (only when a seeds file is used). |
| `seeds_path` | string | — | no | Path to a seeds JSONL file (`{"prompt":"…","completion":"…"}` per line). Triggers the Q+2 seed-gate path. Mutually exclusive-ish with inline `[[evals.cases]]` — if both supplied, inline cases win. |
| `examples_path` | string | — | no | Alias for `seeds_path` (legacy). |
| `examples` | integer | `200` | no | Target example count for compute estimation only. Not a hard cap. |
| `epochs` | integer | `3` | no | Training epochs (for LoRA / full-model targets). Ignored by recipe-only artifacts. |
| `batch_size` | integer | `4` | no | Mini-batch size. |
| `seq_len` | integer | `1024` | no | Max sequence length. |
| `max_seq_length` | integer | `1024` | no | Alias for `seq_len`. |
| `weights_url` | string | — | no | When the recipe is a LoRA-style wrapper, the URL of the trained weights blob. |
| `weights_sha256` | string | — | no | SHA-256 of the weights blob — verified at load time. |
| `rank` | integer | `8` | no | LoRA rank (only when `artifact_class = "lora_adapter"`). |

### Root-level example

```toml
job_id         = "job_demo"
task           = "demo"
base_model     = "Qwen/Qwen2.5-3B-Instruct"
artifact_class = "recipe"
comparator     = "exact"
split_seed     = 7
holdout_ratio  = 0.2
examples       = 200
epochs         = 3
batch_size     = 4
seq_len        = 1024
```

> **Mapping to JSON** — equivalent to:
> ```json
> {
>   "job_id": "job_demo", "task": "demo",
>   "base_model": "Qwen/Qwen2.5-3B-Instruct",
>   "artifact_class": "recipe", "comparator": "exact",
>   "split_seed": 7, "holdout_ratio": 0.2,
>   "examples": 200, "epochs": 3, "batch_size": 4, "seq_len": 1024
> }
> ```

---

## `[[recipes]]` entries

Each `[[recipes]]` header opens one entry in the JSON `recipes[]` array. Order
is preserved — recipes earlier in the file are tried first by fall-through
chains.

| Field | TOML type | Default | Required | Notes |
|---|---|---|---|---|
| `id` | string | — | yes | Recipe slug. Convention: `rcp_<slug>`. Must be non-empty. |
| `name` | string | — | yes | Human-readable. Surfaced in `kolm inspect`. |
| `source` | multi-line string (`'''…'''`) | — | one of `source`/`dsl` | A JS function body, e.g. `function generate(input, lib) { return …; }`. Must compile under `src/verifier.js` `compileJs()`. **Always use a literal multi-line string (`'''…'''`) so backslashes and quotes are passed through verbatim — basic strings (`"…"`) interpret escapes and will mangle regex literals.** |
| `dsl` | inline table or `[recipes.dsl]` sub-table | — | one of `source`/`dsl` | rule-dsl-v1 AST. See `src/dsl.js` `DSL_SPEC`. Required when `artifact_class = "compiled_rule"`. Triggers native C / Rust codegen. |
| `version_id` | string | `"ver_<id-without-prefix>_001"` | no | Pin for receipt diffing. Bump on every meaningful source edit. |
| `tags` | array of string | `[]` | no | Free-form labels. Used by `kolm find` and the Studio search. |
| `schema` | inline table | omitted | no | `{ input = <jsonschema>, output = <jsonschema> }`. Surfaced in `kolm describe`. |
| `params` | inline table or `[recipes.params]` | omitted | no | Recipe-specific runtime knobs. Surfaced verbatim in the manifest. |

A recipe that supplies **both** `source` and `dsl` is honored verbatim (source
wins for the JS path; DSL still ships so a verifier can recompute the C/Rust
targets). This is the recommended pattern for advanced authors who want a
custom JS path kept in lock-step with a declared DSL contract.

### Two recipes with sub-tables

```toml
[[recipes]]
id         = "rcp_sentiment_v1"
name       = "sentiment v1"
version_id = "ver_sentiment_v1_003"
tags       = ["sentiment", "english"]
source     = '''
function generate(input, lib) {
  const s = String(input).toLowerCase();
  if (/love|great|awesome/.test(s)) return { sentiment: 'positive' };
  if (/hate|awful|terrible/.test(s)) return { sentiment: 'negative' };
  return { sentiment: 'neutral' };
}
'''

  [recipes.schema]
  input  = { type = "string" }
  output = { type = "object", required = ["sentiment"] }

  [recipes.params]
  threshold = 0.5

[[recipes]]
id   = "rcp_ssn_v1"
name = "SSN redactor"

  [recipes.dsl]
  spec    = "rule-dsl-v1"
  op      = "replace_regex"
  pattern = '\b\d{3}-\d{2}-\d{4}\b'
  with    = "[REDACTED-SSN]"
```

> **Mapping to JSON** — `[[recipes]]` produces:
> ```json
> "recipes": [
>   { "id": "rcp_sentiment_v1", "name": "sentiment v1",
>     "version_id": "ver_sentiment_v1_003",
>     "tags": ["sentiment", "english"],
>     "source": "function generate(input, lib) { … }",
>     "schema": { "input": { "type": "string" },
>                 "output": { "type": "object", "required": ["sentiment"] } },
>     "params": { "threshold": 0.5 } },
>   { "id": "rcp_ssn_v1", "name": "SSN redactor",
>     "dsl": { "spec": "rule-dsl-v1", "op": "replace_regex",
>              "pattern": "\\b\\d{3}-\\d{2}-\\d{4}\\b",
>              "with": "[REDACTED-SSN]" } }
> ]
> ```
> Note the leading two-space indent on `[recipes.schema]` is cosmetic — TOML
> ignores it. The header scopes the table to the **most recent** `[[recipes]]`.

---

## Evals table (`[evals]`)

```toml
[evals]
spec     = "rs-1-evals"
coverage = 1.0
n        = 1

[[evals.cases]]
id       = "p1"
input    = "loved this"
expected = { sentiment = "positive" }

  [evals.cases.params]
  comparator = "exact"
```

| Field | TOML type | Default | Notes |
|---|---|---|---|
| `spec` | string | `"rs-1-evals"` | Eval-set format version. `rs-1-evals` is the only published format today. |
| `cases` | array of table (`[[evals.cases]]`) | `[]` | One eval case per entry. Each case must have `id`, `input`, `expected`. `params.comparator` overrides the spec-level `comparator`. |
| `coverage` | float 0..1 | `0` | Self-declared coverage of the input space. Surfaced in the manifest but not enforced. |
| `n` | integer | `cases` length | Optional explicit count — useful when `cases` is a sample and the full set lives at `seeds_path`. |

### Per-case fields (each `[[evals.cases]]`)

| Field | TOML type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Case slug, unique within the eval set. |
| `input` | any (string, table, array, number, bool) | yes | Passed verbatim to the recipe's `generate(input, lib)`. |
| `expected` | any | yes | Reference value compared via the active comparator. |
| `params` | inline table or `[evals.cases.params]` | no | Per-case overrides. `params.comparator` is the most-used; `params.max_distance` (levenshtein) and `params.tolerance` (numeric_close) are also honored. |

A case's `expected` is compared to the recipe's output under the chosen
comparator. `exact` (the default) requires deep-equal; `subset` accepts any
output that contains the expected keys; `regex` treats `expected` as a regex
pattern; `levenshtein` accepts edit-distance ≤ `params.max_distance`;
`numeric_close` accepts `≤ params.tolerance` absolute difference.

> **Mapping to JSON** — the block above produces:
> ```json
> "evals": {
>   "spec": "rs-1-evals", "coverage": 1.0, "n": 1,
>   "cases": [
>     { "id": "p1", "input": "loved this",
>       "expected": { "sentiment": "positive" },
>       "params": { "comparator": "exact" } }
>   ]
> }
> ```

---

## Pack table (`[pack]`)

KOLMPACK metadata surfaced in the model card and registry index. Everything is
optional — the field set is open (any keys here are passed through verbatim to
`manifest.json` under `pack`).

| Field | TOML type | Notes |
|---|---|---|
| `display_name` | string | Human-friendly card title. |
| `vendor` | string | Publisher / organisation slug. |
| `license` | string | SPDX identifier (e.g. `"Apache-2.0"`, `"MIT"`). |
| `tags` | array of string | Card chips, used by Workbench search. |
| `homepage` | string | URL for the card "Learn more" link. |

```toml
[pack]
display_name = "Sentiment v1"
vendor       = "acme-ml"
license      = "Apache-2.0"
tags         = ["sentiment", "english", "binary"]
homepage     = "https://acme-ml.example.com/models/sentiment-v1"
```

> **Mapping to JSON**
> ```json
> "pack": {
>   "display_name": "Sentiment v1", "vendor": "acme-ml",
>   "license": "Apache-2.0",
>   "tags": ["sentiment", "english", "binary"],
>   "homepage": "https://acme-ml.example.com/models/sentiment-v1"
> }
> ```

---

## Index table (`[index]`)

KOLMIDX hints consumed by Workbench search and recommendation. Like `[pack]`,
field set is open.

| Field | TOML type | Notes |
|---|---|---|
| `domain` | string | Top-level domain bucket (e.g. `"nlp"`, `"vision"`, `"compliance"`). |
| `subdomain` | string | Free-form refinement. |
| `language` | array of string | BCP-47 language tags this artifact targets (`["en", "fr"]`). |
| `modality` | array of string | One or more of `text`, `image`, `audio`, `video`, `pdf`. |
| `latency_class` | string | `"sub_ms"`, `"ms"`, `"sub_sec"`, `"sec"`. |

```toml
[index]
domain        = "nlp"
subdomain     = "classification"
language      = ["en"]
modality      = ["text"]
latency_class = "sub_ms"
```

> **Mapping to JSON**
> ```json
> "index": {
>   "domain": "nlp", "subdomain": "classification",
>   "language": ["en"], "modality": ["text"],
>   "latency_class": "sub_ms"
> }
> ```

---

## Training-stats table (`[training_stats]`)

Pre-recorded training metrics, shown verbatim in the manifest. Any numeric
key is accepted; common ones below.

| Field | TOML type | Notes |
|---|---|---|
| `pass_rate_positive` | float 0..1 | Train-set positive-class accuracy. |
| `pass_rate_negative` | float 0..1 | Train-set negative-class accuracy. |
| `latency_p50_us` | integer | Median per-call latency, microseconds. |
| `latency_p99_us` | integer | 99th-percentile per-call latency, microseconds. |
| `train_examples` | integer | Number of train pairs actually used (post-split). |
| `holdout_examples` | integer | Number of holdout pairs actually used. |

```toml
[training_stats]
pass_rate_positive = 0.94
pass_rate_negative = 0.91
latency_p50_us     = 38
latency_p99_us     = 142
train_examples     = 160
holdout_examples   = 40
```

> **Mapping to JSON**
> ```json
> "training_stats": {
>   "pass_rate_positive": 0.94, "pass_rate_negative": 0.91,
>   "latency_p50_us": 38, "latency_p99_us": 142,
>   "train_examples": 160, "holdout_examples": 40
> }
> ```

---

## Comparators

Implemented in [`src/comparators.js`](../src/comparators.js). Set at spec level
via root-level `comparator = "…"`, or per-case via `params.comparator = "…"`
inside a `[[evals.cases]]` table.

| Comparator | Match rule | Use for |
|---|---|---|
| `exact` | Strict deep-equal | Classifiers, structured extraction |
| `subset` | Output is a superset of expected | Tolerant structured extraction |
| `regex` | `expected` is a regex applied to stringified output | Pattern matching |
| `levenshtein` | Edit-distance ≤ `params.max_distance` | Fuzzy string match |
| `numeric_close` | `|output - expected| ≤ params.tolerance` | Forecasts, scores |

---

## CLI / opts overrides

These are not spec fields but are flags / env vars that override TOML
defaults — identical to the JSON path:

| CLI flag | Env var | Overrides | Notes |
|---|---|---|---|
| `--workload-profile latency` | `KOLM_WORKLOAD_PROFILE` | (none — sets manifest only) | One of `latency`, `batching`, `auto`. Pinned in manifest for kernel selection at serve time. |
| `--comparator regex` | — | root-level `comparator` | |
| `--seeds path.jsonl` | — | `seeds_path` | Triggers the seed-gate path. |
| `--split-seed 7` | — | `split_seed` | |
| `--holdout-ratio 0.3` | — | `holdout_ratio` | Must be 0..1. |
| `--target c` / `--target rust` / `--target wasm` | — | (none) | Adds native compile targets. Requires the corresponding toolchain (`kolm doctor`). |
| `--cloud modal` / `--cloud runpod` | `KOLM_CLOUD` | (none) | Routes the compile to a cloud GPU partner. Requires API key + budget confirmation. |
| `--no-fit-check` | — | (none) | Skips pre-compile VRAM gate. Use when you know the spec fits or when running on cloud. |
| `--refit` | — | (none) | Forces a retrain even when manifest hash hasn't changed. |
| `--format toml` / `--format json` | — | (auto from extension) | Force the spec parser. Only needed when reading `--spec -` from stdin. |
| `KOLM_ARTIFACT_SECRET` | env | (none) | Override the per-user receipt secret. Set on every machine that needs to verify each others' artifacts byte-stably. |
| `RECIPE_RECEIPT_SECRET` | env | (none) | Alias for `KOLM_ARTIFACT_SECRET`. |

---

## Constraints + invariants

Enforced at validate-time on the TOML→JSON output; violating one is a hard
fail (`KOLM_E_SPEC_INVALID`):

1. `job_id` matches `/^job_[a-z0-9_-]+$/i`.
2. At least one `[[recipes]]` entry is present.
3. Every recipe has `id`, `name`, and **one of** `source` or `dsl`.
4. If `artifact_class = "compiled_rule"`, every recipe must have a `[recipes.dsl]` block (raw JS is not eligible for native codegen — the DSL is what gets compiled to C / Rust).
5. `dsl` tables must validate against `validateDsl()` (`src/dsl.js`).
6. `source` multi-line strings must compile under `compileJs()`.
7. `[[evals.cases]]` (when present) must be a valid array of tables.
8. `comparator` must be one of the SUPPORTED_COMPARATORS list.
9. `workload_profile` (CLI / env / opts) must be `latency`, `batching`, or `auto`.
10. `holdout_ratio` must be 0..1.

Additional TOML-only parse-time invariants (enforced by `@iarna/toml` before
validation runs):

- The document must be valid strict TOML 1.0 (no comments inside arrays of
  inline tables, no trailing commas, integers fit signed-64-bit, etc).
- `[[recipes]]` headers must appear after the root scalars — putting them
  before `job_id` accidentally hoists `job_id` into the first recipe.
- Multi-line literal strings (`'''…'''`) preserve the leading newline only if
  the opening delimiter is followed by a newline; trim with care if you embed
  source that must be byte-stable across editors.

---

## What ends up in the .kolm

After the TOML is converted to JSON and validated, `compileSpec()` writes a
ZIP at `~/.kolm/artifacts/<job_id>.kolm`. Output is identical to the JSON
path — see [spec-reference.md § What ends up in the .kolm](spec-reference.md#what-ends-up-in-the-kolm).

The original `spec.toml` is **also** archived under `spec.toml` next to
`spec.json` inside the artifact, so `kolm inspect` can round-trip back to
either form.

Verify any artifact offline: `kolm verify <artifact.kolm>` re-runs every ring
and emits `ok: true` only when all four seals replay clean.

---

## Examples

### Rule-only artifact (no model)

```toml
job_id = "job_email_classifier"
task   = "email subject -> {spam, ham}"

[[recipes]]
id     = "rcp_keyword_v1"
name   = "keyword classifier v1"
source = '''
function generate(input, lib) {
  const subj = String(input.subject || '').toLowerCase();
  return { label: /viagra|nigerian prince|wire transfer/.test(subj)
    ? 'spam' : 'ham' };
}
'''

[evals]
spec     = "rs-1-evals"
coverage = 0.85

[[evals.cases]]
id       = "s1"
input    = { subject = "URGENT: nigerian prince wire transfer" }
expected = { label = "spam" }

[[evals.cases]]
id       = "h1"
input    = { subject = "your invoice for May" }
expected = { label = "ham" }
```

> **Mapping to JSON** — see [spec-reference.md § Recipe-only artifact](spec-reference.md#recipe-only-artifact-no-model).

### Compiled-rule artifact (native C / Rust target)

```toml
job_id         = "job_ssn_redactor"
task           = "redact US SSN from input string"
artifact_class = "compiled_rule"

[[recipes]]
id   = "rcp_ssn_v1"
name = "SSN redactor"

  [recipes.dsl]
  spec    = "rule-dsl-v1"
  op      = "replace_regex"
  pattern = '\b\d{3}-\d{2}-\d{4}\b'
  with    = "[REDACTED-SSN]"

[evals]
spec = "rs-1-evals"

[[evals.cases]]
id       = "r1"
input    = "my ssn is 123-45-6789"
expected = "my ssn is [REDACTED-SSN]"
```

Compile with `kolm compile --spec ssn.toml --target c --target rust`.

> **Mapping to JSON** — note the regex pattern. A TOML **literal** string
> (single-quoted `'…'`) passes the backslashes through verbatim, so
> `'\b\d{3}-\d{2}-\d{4}\b'` becomes the JSON string `"\\b\\d{3}-\\d{2}-\\d{4}\\b"`
> — the exact form the DSL validator expects. **Do not** use a basic string
> (`"\b\d{3}…"`) here: TOML would interpret `\b` and `\d` as escape sequences
> and the regex would be mangled.

### LoRA adapter artifact

```toml
job_id         = "job_customer_support_lora"
task           = "customer support tone adapter for Qwen 2.5 3B"
artifact_class = "lora_adapter"
base_model     = "Qwen/Qwen2.5-3B-Instruct"
rank           = 16
epochs         = 3
batch_size     = 8
seq_len        = 2048
weights_url    = "https://hub.kolm.ai/blobs/sha256:abcdef0123..."
weights_sha256 = "abcdef0123..."
seeds_path     = "./customer-support-pairs.jsonl"
holdout_ratio  = 0.2
comparator     = "subset"

[[recipes]]
id     = "rcp_lora_routing_v1"
name   = "LoRA routing wrapper"
source = '''
function generate(input, lib) {
  return lib.lora.infer({
    adapter: 'rcp_lora_routing_v1',
    prompt: input.prompt
  });
}
'''

[evals]
spec  = "rs-1-evals"
cases = []
```

> **Mapping to JSON** — see [spec-reference.md § LoRA adapter artifact](spec-reference.md#lora-adapter-artifact).
> `cases = []` is an explicit empty array; the seed-gate path will populate
> the actual eval set from `seeds_path` at compile time.

### Full spec with pack + index + training_stats

```toml
job_id         = "job_sentiment_v1"
task           = "english sentiment classifier"
base_model     = "none"
artifact_class = "recipe"
comparator     = "exact"
split_seed     = 7
holdout_ratio  = 0.2

[[recipes]]
id         = "rcp_sentiment_v1"
name       = "sentiment v1"
version_id = "ver_sentiment_v1_003"
tags       = ["sentiment", "english"]
source     = '''
function generate(input, lib) {
  const s = String(input).toLowerCase();
  if (/love|great|awesome/.test(s)) return { sentiment: 'positive' };
  if (/hate|awful|terrible/.test(s)) return { sentiment: 'negative' };
  return { sentiment: 'neutral' };
}
'''

[evals]
spec     = "rs-1-evals"
coverage = 0.9

[[evals.cases]]
id       = "p1"
input    = "I love this"
expected = { sentiment = "positive" }

[[evals.cases]]
id       = "n1"
input    = "I hate this"
expected = { sentiment = "negative" }

[pack]
display_name = "Sentiment v1"
vendor       = "acme-ml"
license      = "Apache-2.0"
tags         = ["sentiment", "english", "binary"]

[index]
domain        = "nlp"
subdomain     = "classification"
language      = ["en"]
modality      = ["text"]
latency_class = "sub_ms"

[training_stats]
pass_rate_positive = 0.94
pass_rate_negative = 0.91
latency_p50_us     = 38
latency_p99_us     = 142
train_examples     = 160
holdout_examples   = 40
```

---

## TOML authoring tips

- **Always quote with literal strings (`'…'` / `'''…'''`) when the value
  contains backslashes** — regex patterns, Windows paths, JS source with `\n`
  templates. Basic strings (`"…"`) interpret `\` as the start of an escape.
- **Order matters at table boundaries.** A `[recipes.params]` sub-table scopes
  to the *most recent* `[[recipes]]`. Put your sub-tables immediately under
  the `[[recipes]]` header they belong to.
- **Inline tables vs sub-tables are equivalent.**
  `schema = { input = { type = "string" } }` and
  ```toml
  [recipes.schema]
    [recipes.schema.input]
    type = "string"
  ```
  produce identical JSON. Pick whichever reads better at the site.
- **Run `kolm spec toml-to-json spec.toml`** to see exactly what the validator
  sees; pipe to `jq` to inspect.
- **Round-trip check:** `kolm spec toml-to-json spec.toml | kolm spec json-to-toml -`
  should equal `spec.toml` up to comments and whitespace.

---

## Authoring tools

- `kolm init --format toml` — interactive scaffold for a new TOML spec
- `kolm spec validate <file>` — dry-run validate without compiling (auto-detects TOML vs JSON by extension)
- `kolm spec toml-to-json <file>` — emit the equivalent canonical JSON to stdout
- `kolm spec json-to-toml <file>` — round-trip the other way (for migration)
- `kolm fit <spec>` — projects VRAM / disk / wall-clock for a spec
- `kolm inspect <artifact>` — round-trip view of any compiled spec (renders TOML if the artifact was authored that way)
- `kolm explain <spec>` — render the spec as natural-language for review

See also:
- [`docs/spec-reference.md`](spec-reference.md) — the canonical JSON reference (this document mirrors it 1:1)
- [`docs/AUTHORING.md`](AUTHORING.md) — recipe authoring guide
- [`docs/distill-strategy.md`](distill-strategy.md) — when to LoRA vs full-model vs rule
- [`docs/cookbook/`](cookbook/) — worked examples (JSON; TOML translations forthcoming)

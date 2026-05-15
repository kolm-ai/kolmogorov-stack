# Reference model recipes

Three production-ready training recipes that exercise the full `kolm cloud train` pipeline end-to-end on real GPUs. Each lives in its own directory with a `spec.json` (the recipe) and `seeds.jsonl` (the training pairs). Run them as-is to smoke-test, or fork the spec + extend the seeds for your own task.

## What's here

| Directory | Task | Base model | Target | Pairs |
|---|---|---|---|---|
| `en-zh-translator/` | English → Simplified Mandarin translation | Qwen2.5-7B-Instruct | 7B | 100 |
| `general-qwen-3b/` | General instruction-following with JSON-schema compliance | Qwen2.5-3B-Instruct | 3B | 50 |
| `phi-redactor/` | PHI / PII redaction in clinical and customer-support notes | Qwen2.5-7B-Instruct | 7B | 100 |

Each `spec.json` declares: `base_model`, `epochs`, LoRA hyperparameters (`lora_r`, `lora_alpha`, `lora_dropout`, `lr`), `max_seq_len`, the K-score gate, and weighted components (`accuracy` / `size` / `latency` / `cost` / `coverage`). The `verifier` field describes what passing looks like in plain English.

## Run one

```bash
# Quote first (no API key required, prints estimated cost + duration)
kolm cloud train models/en-zh-translator

# Confirm + actually train (needs KOLM_TOGETHER_TOKEN or TOGETHER_API_KEY)
kolm cloud train models/en-zh-translator --confirm

# Same flow for the other two
kolm cloud train models/general-qwen-3b --confirm
kolm cloud train models/phi-redactor --confirm
```

The two-phase quote → confirm pattern means you always see the estimated cost (tokens × epochs × per-million price × size multiplier) before you spend a dollar. Without `--confirm`, no auth check, no network call, no charge — just a personalized quote based on your spec.

## What `kolm cloud train` does

1. Reads `<dir>/spec.json` and `<dir>/seeds.jsonl`.
2. Estimates cost: `(pairs × ~400 tok × epochs) / 1M × $0.50 × size_multiplier`. The size multiplier is 1x for 7B-and-under, 2x for 13–24B, 10x for 70B+.
3. With `--confirm`, uploads the seeds as a JSONL file to Together AI, kicks off a managed LoRA fine-tune with the spec's hyperparameters, polls every 15s for completion, then downloads the adapter weights.
4. Computes SHA-256 of the adapter, returns metrics + compute breakdown + the artifact path.

The adapter is yours. No proprietary file format, no platform lock-in — it's a standard PEFT LoRA adapter you can merge into the base model with `transformers` + `peft` and run anywhere.

## Cost expectations

These are real numbers, not marketing. At Together AI's $0.50 / 1M token rate for 7B models:

- **en-zh-translator** (100 pairs × ~400 tok × 3 epochs = 120k tok): **~$0.50** floor, ~$2 if pairs run long
- **general-qwen-3b** (50 pairs × ~400 tok × 2 epochs = 40k tok): **~$0.50** floor
- **phi-redactor** (100 pairs × ~400 tok × 3 epochs = 120k tok): **~$0.50** floor

The $0.50 floor is the minimum we report from the estimator; the actual provider bill matches the cost line you get back in the completion receipt. If a smoke-test recipe quotes a single dollar and the real bill comes in at $0.83, the receipt is the truth.

## Extending a recipe

These seed sets are starter sizes — enough to prove the pipeline end-to-end and get an honest K-score, not enough for production-grade quality on hard distributions. Ship-grade fine-tunes for these tasks typically use:

- **Translation:** 1–5k high-quality pairs, plus a domain glossary for technical text (medical, legal, finance)
- **General instruction-following:** 5–10k diverse pairs across reasoning, code, JSON, math, classification, structured output
- **PHI redaction:** 2–5k pairs with realistic synthetic identifiers, plus a regex pre-pass for SSN / phone / email guarantees

The seed JSONL format is one example per line: `{"prompt": "...", "completion": "..."}`. Add yours, bump `epochs` or `lora_r` if you need more capacity, then re-run.

## Why these three

Three different task shapes, three different K-score component weights, three honest difficulty levels:

- **Translation** is a closed-domain pure-text-in / text-out problem. Easy to verify (BLEU + character-ratio + source-language ban), hard to get to truly fluent on idiom and register.
- **General instruction-following** is the broadest task: it has to hold JSON-schema compliance, refuse cleanly, write code, do math, and not over-talk. The 3B size is the smallest base where this stays cohesive after light fine-tune.
- **PHI redaction** is the highest-stakes recipe: a missed identifier is a HIPAA incident. The K-score component weights reflect this — `accuracy` is bumped to 0.50 (vs 0.40 for the other two) and the gate is 0.90 (vs 0.85). You should reach harder for recall here.

## License

All three recipes ship under Apache-2.0. The base models (Qwen 2.5 family) are also Apache-2.0. Adapter weights you produce are yours under whatever license you choose.

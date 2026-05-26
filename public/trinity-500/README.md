<!-- mirrored from HF model card at huggingface.co/kolm/trinity-500 -->
---
license: apache-2.0
language:
  - en
library_name: transformers
base_model: Qwen/Qwen2.5-7B-Instruct
tags:
  - kolm
  - distilled
  - lora
  - bf16
  - teacher-council
  - qwen2.5
  - ollama
  - gguf
  - safetensors
datasets:
  - kolm/trinity-500-2026-05-26-seeds
metrics:
  - asks_one_question_rate
  - no_inventions_rate
  - on_policy_rate
  - all_three_rate
  - judge_clarifies_rate
  - judge_no_inventions_rate
  - judge_on_policy_rate
  - mean_latency_seconds
  - mean_response_chars
pipeline_tag: text-generation
model-index:
  - name: Trinity-500
    results:
      - task:
          type: text-generation
          name: Customer-support chat distillation
        dataset:
          name: kolm-distill-holdout
          type: kolm-distill-holdout
        metrics:
          - type: asks_one_question_rate
            value: 0.965
            name: Asks One Clarifying Question
          - type: no_inventions_rate
            value: 1
            name: No Fabricated Facts
          - type: on_policy_rate
            value: 0.965
            name: On-Policy Compliance
          - type: all_three_rate
            value: 0.965
            name: All-Three Combined Pass Rate
          - type: judge_clarifies_rate
            value: 1
            name: 'Judge: Necessary Clarification'
          - type: judge_no_inventions_rate
            value: 0.456
            name: 'Judge: No Fabricated Facts'
          - type: judge_on_policy_rate
            value: 1
            name: 'Judge: On-Policy'
          - type: mean_latency_seconds
            value: 1.24
            name: Mean Latency (seconds)
          - type: mean_response_chars
            value: 210.1
            name: Mean Response Length (chars)
---

# Trinity-500

## Model description

Trinity-500 is a distilled model produced by the open-source [Kolm](https://kolm.ai) stack.

- **Base model:** `Qwen/Qwen2.5-7B-Instruct`
- **Artifact kind:** `peft-lora-adapter`
- **Artifact sha256:** `c8d77117acf337c015f3cfeeee0849f6ae32b9c00598389eae749f927b5dbb5c`
- **Artifact size:** 19.26 MB
- **Available formats:** ollama, gguf, safetensors
- **Run ID:** `trinity-500-2026-05-26`

## Intended use

The intended use is the task captured in the training contract. See `passport.json` for the exact system prompt and recipe.

**Out-of-scope:** uses that depart from the captured training distribution. Multi-turn tool use is out-of-scope unless the training corpus included it.

## Training data

- **Seeds total:** 500
- **Pairs collected:** 410
- **Yield:** 82%

Teacher council:

| Teacher | Weight | Rows requested | Rows collected | Source |
|---|---:|---:|---:|---|
| `anthropic:claude-opus-4-7` | 0.60 | 300 | 243 | kolm-proxy |
| `openai:gpt-4o` | 0.30 | 150 | 124 | kolm-proxy |
| `kolm:deepseek-r1-distill-qwen-32b` | 0.10 | 50 | 43 | local:8765 |

## Training procedure

```yaml
base: Qwen/Qwen2.5-7B-Instruct
lora_rank: 16
lora_alpha: 32
lora_dropout: 0.05
epochs: 1
batch_size: 1
learning_rate: 0.0002
max_length: 384
precision: bf16
gradient_checkpointing: true
```

## Evaluation

| Model | N | 1-Q % | no-invent % | on-policy % | all-3 % | lat (s) | len (chars) |
|---|---|---|---|---|---|---|---|
| **trinity-500** | 57 | 96.5 | 100.0 | 96.5 | 96.5 | 1.24 | 210 |
| base-qwen2.5-7b | 57 | 84.2 | 100.0 | 100.0 | 84.2 | 1.74 | 375 |
| claude-haiku-4-5 | 57 | 64.9 | 100.0 | 100.0 | 64.9 | 2.72 | 640 |
| gpt-4o-mini | 57 | 96.5 | 100.0 | 98.2 | 96.5 | 1.74 | 287 |

Metrics promoted to HF frontmatter (`metrics`):

- `asks_one_question_rate`: 0.965 (Asks One Clarifying Question)
- `no_inventions_rate`: 1 (No Fabricated Facts)
- `on_policy_rate`: 0.965 (On-Policy Compliance)
- `all_three_rate`: 0.965 (All-Three Combined Pass Rate)
- `judge_clarifies_rate`: 1 (Judge: Necessary Clarification)
- `judge_no_inventions_rate`: 0.456 (Judge: No Fabricated Facts)
- `judge_on_policy_rate`: 1 (Judge: On-Policy)
- `mean_latency_seconds`: 1.24 (Mean Latency (seconds))
- `mean_response_chars`: 210.1 (Mean Response Length (chars))

Holdout verification:

- **N:** 5
- **On-recipe:** 5/5
- **Mean latency:** 1.77s
- **Sample ids:** sup_007, sup_008, sup_012, sup_014, sup_015

## Limitations

- Pilot-scale model. Benchmarks above are narrow (same-domain, same-distribution as training).
- Council weighting may be unbalanced — see the training-data table for actual row counts per teacher.
- Single-judge eval — LLM-judged axes use one judge model. Cross-validation with a second judge is on the roadmap.
- Throughput numbers on hardware other than the training device are forecasts, not measurements, unless explicitly noted.

Publishing status from the passport:

- `benchmark_vs_baselines`: not_yet_run
- `gguf_export`: blocked_on_llama_cpp_install
- `hf_model_card`: not_published
- `ollama_modelfile`: blocked_on_gguf

For full provenance see `passport.json` in this repository.

## Citation

```bibtex
@misc{kolm-trinity-500-2026-05-26,
  title  = {Trinity-500: distilled with the open-source kolm stack},
  author = {Kolm contributors},
  year   = {2026},
  url    = {https://huggingface.co/kolm/trinity-500},
  note   = {Run ID trinity-500-2026-05-26, adapter sha256 c8d77117}
}
```

## License

apache-2.0, inherited from base model `Qwen/Qwen2.5-7B-Instruct`.

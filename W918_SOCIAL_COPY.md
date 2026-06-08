# W918 — Social Copy Drafts

**Status:** drafts for user review. Not pushed. Gitignored.
**Date:** 2026-05-28
**Purpose:** announce kolm as the landing pad for OpenAI fine-tuning refugees ahead of the Jan 2027 cliff.

Post in this order: HN first (cold-launch is single-shot, post Tue-Thu 7-10am PT for best traction), then the X thread within 1 hour of HN going live, then r/ML the next morning (subreddit auto-mod is harsher when piggy-backing HN within the same day).

---

## 1. Hacker News — Show HN post

**Title** (78 chars):

```
Show HN: kolm – distill your OpenAI fine-tuning workflows to open-weight models
```

**URL field:**

```
https://kolm.ai/openai-migration
```

**Body** (plain text, no markdown, ~285 words):

```
kolm is an open-source distillation stack that takes your OpenAI fine_tuning_data.jsonl, trains an open-weight student model on your GPU (or any rented one), and exports the result to portable formats so you can run it anywhere.

Why now: OpenAI is sunsetting self-serve fine-tuning. Self-serve ft is already closed to new users; existing ft users have until January 2027. Tens of thousands of teams built workflows around client.fine_tuning.jobs.create(...) and need somewhere to land before the cutoff.

What we built:

  kolm import --from openai-finetune ./fine_tuning_data.jsonl
  kolm distill spec --base qwen2.5-7b --teachers claude,gpt-4o,cerebras:llama-3.3-70b
  kolm distill collect
  kolm distill train
  kolm export --format gguf,ollama,vllm,tgi,binary

Import parses the chat and completions JSONL formats OpenAI uses. Distill runs a 3-teacher council (Claude 4.7 + GPT-4o + Cerebras-hosted Llama-3.3-70B) so the student learns from a vote instead of a single teacher. Train is QLoRA on the base of your choice (Qwen2.5-7B or Llama-3.1-8B today). Export drops a GGUF for Ollama, a vLLM checkpoint, a TGI/TRT-LLM artifact, and a single-binary edge runtime in one pass.

Every step writes a signed Ed25519 receipt — distill input, training run, eval pass, inference call — so the lineage of any prediction is verifiable. Apache 2.0. Runs on your GPU, your cloud, or your laptop with quantization.

Caveats: a 7B distilled student will not match GPT-4 on every task. The included eval harness reports per-prompt agreement with your ft baseline so you migrate the safe workflows first and keep the long-tail on a frontier model.

Looking for early users with real OpenAI ft workloads to validate the recipe. Repo: https://github.com/kolm-ai/kolmogorov-stack
```

---

## 2. r/MachineLearning — [P] post

**Title** (98 chars, under the 300-char subreddit limit):

```
[P] Open-source distillation stack for OpenAI fine-tuning refugees (sunsetting Jan 2027)
```

**Body** (markdown, ~470 words):

```markdown
OpenAI is sunsetting self-serve fine-tuning. The API is already closed to new users; existing ft users have until January 2027. That puts a hard deadline on production workflows built around `client.fine_tuning.jobs.create(...)`. We've been building an open-source migration path and want code review and eval ideas before we push harder on it.

### Architecture

- **Import.** Parser for OpenAI ft JSONL (both `chat` and `completion` shapes) → kolm capture rows. Skip + log on malformed rows. Pure Node, zero deps beyond fs/path.
- **3-teacher council.** Claude 4.7 + GPT-4o + Cerebras-hosted Llama-3.3-70B. Per-token vote with weighted agreement; ties resolved by the larger model. Single-teacher distillation inherits the single teacher's failure modes; a council surfaces disagreement so we resolve it during training or escalate the row to a held-out eval.
- **Student + training.** QLoRA over Qwen2.5-7B or Llama-3.1-8B. 4-bit base, bf16 LoRA adapters, configurable rank/alpha. Reproducible on a single 24GB GPU.
- **Export.** One pass produces GGUF (Q4_K_M / Q5_K_M / Q8_0), Ollama Modelfile, vLLM checkpoint, TGI artifact, and a static-linked single-binary edge runtime.
- **Receipts.** Every step emits an Ed25519-signed receipt with content-addressed input hash. The lineage of any inference is verifiable against the public key.

### How we compare

- **Lamini Memory Tuning / MoME** indexes stored exemplars at training time and merges via a Mixture-of-Memory-Experts. kolm distills into a single dense student; we borrow the spirit of a non-parametric memory and expose it as an eval-time tool, not a training-time index.
- **distil labs** ships a 3-command CLI focused on chat distillation from a single teacher. We extend that surface to multi-teacher and add the export-fanout / receipts layer.
- **Pioneer Agent Mode** distills tool-use trajectories, not just chat turns. Our `--mode=agent` flag is Wave 2 (P2 in the plan), not shipped yet — flagging for fair scope comparison.

### Reproducibility

A distill run is described by `spec.json` (base, teachers, data hash, hparams, seed). Spec + capture corpus + holdout eval = bit-for-bit reproducible distillation. The receipt chain lets a third party verify a run was produced from the spec they were shown.

### Limitations

1. Sample-size floor: under ~500 training rows the council reduces to noise; we surface a warning.
2. Eval harness scope: agreement-rate vs ft baseline + held-out perplexity. Not yet running τ²-bench / Sierra-style multi-turn eval for agentic workloads.
3. A 7B student will not catch every GPT-4-class behavior; per-prompt agreement is reported so you migrate the safe slice first.
4. Training requires a GPU (24GB+ for 7B QLoRA). No hosted training — we point at RunPod, Modal, Vast.

### Links

- Landing page: https://kolm.ai/openai-migration
- Repo: https://github.com/kolm-ai/kolmogorov-stack
- Migration blog post: https://kolm.ai/blog/openai-finetuning-shutdown
- Benchmark page: https://kolm.ai/benchmarks

Asking for code review, eval ideas, or collaborators willing to bring a real ft workload. Happy to be told we're wrong about any of the above.
```

---

## 3. Twitter / X thread (8 tweets)

Each tweet is at or under 280 chars. No emojis (including the conventional thread marker — replaced with `(1/8)` numbering). Char counts in parens at the end of each tweet are bookkeeping only — strip them before posting.

### Tweet 1 — hook (260 chars)

```
OpenAI is sunsetting self-serve fine-tuning.

January 2027 cliff for existing ft users.
Already closed to new users.

If you have a fine_tuning.jobs.create(...) workflow in production, you need a landing pad before the cutoff.

Here's how to land on open-source. (1/8)
```

### Tweet 2 — what kolm is (210 chars)

```
kolm is an open-source stack that takes your OpenAI fine_tuning_data.jsonl, distills it into an open-weight student model on your own GPU, and exports it to GGUF, Ollama, vLLM, TGI, and a single-binary edge runtime. (2/8)
```

### Tweet 3 — the 6 commands (262 chars)

```
The migration is six commands:

kolm import --from openai-finetune data.jsonl
kolm distill spec --base qwen2.5-7b --teachers claude,gpt-4o,cerebras:llama-3.3-70b
kolm distill collect
kolm distill train
kolm eval --vs openai-baseline
kolm export --format gguf

(3/8)
```

### Tweet 4 — receipts (244 chars)

```
Every step writes a signed Ed25519 receipt: distill input, training run, eval pass, inference call. The lineage of any prediction is verifiable.

Example: rcpt_01KYC1ZVTGDCW3FX06JQSC at kolm.ai/v1/verify/rcpt_01KYC1ZVTGDCW3FX06JQSC

(4/8)
```

### Tweet 5 — council distillation (270 chars)

```
The OpenAI ft API only ever distilled from one model. We use a 3-teacher council:

- Claude 4.7 (reasoning)
- GPT-4o (instruction-following)
- Cerebras-hosted Llama-3.3-70B (open-weight + fastest tok/s teacher on the market)

Per-token vote, weighted by agreement. (5/8)
```

### Tweet 6 — portability (256 chars)

```
One export pass, five artifacts:

- GGUF (Q4_K_M / Q5_K_M / Q8_0) for llama.cpp + Ollama
- Ollama Modelfile
- vLLM checkpoint
- TGI / TRT-LLM artifact
- Single-binary edge runtime (Pi 5, Jetson, x86)

Pick your deploy target after training, not before. (6/8)
```

### Tweet 7 — caveats (264 chars)

```
Caveats:

A 7B distilled student will not match GPT-4 on every task. The eval harness reports per-prompt agreement with your ft baseline so you migrate the safe slice first and keep the long tail on a frontier model.

Council distillation needs ~500+ rows minimum. (7/8)
```

### Tweet 8 — CTA (192 chars)

```
Full migration guide, code, and repo:

kolm.ai/openai-migration
github.com/kolm-ai/kolmogorov-stack

Apache 2.0. Runs on your GPU. We're looking for early users with real OpenAI ft workloads. (8/8)
```

---

## Posting notes for the user

- HN: do not post on weekends; Tue-Thu 7-10am PT is the historical sweet spot for Show HN.
- HN body cannot be edited after 2 hours. Title can be edited briefly by HN mods on request.
- r/ML: the `[P]` tag is mandatory. Auto-mod removes posts without it. Wait until the morning after HN so it doesn't look like double-promotion.
- X: thread reach is mostly driven by tweet 1. Pin the thread on the @kolm_ai profile for 7 days.
- Cross-link from /openai-migration after the HN post goes live so first-time visitors see the conversation.

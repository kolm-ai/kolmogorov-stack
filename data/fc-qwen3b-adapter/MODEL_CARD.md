# Qwen2.5-3B Function-Calling LoRA (kolm)

A LoRA adapter that teaches **Qwen2.5-3B-Instruct** reliable agentic **tool / function calling** —
the #1 in-demand small-model distill in mid-2026 (per Grok analysis + the GitHub/HF agent-framework
wave: Google ADK, smolagents, goose, codex-cli). Trained with the kolm distill pipeline.

## What it does
Given tools (Qwen-native `tools` in the system prompt) + a user query, it:
- emits a valid Qwen-native `<tool_call>{"name","arguments"}</tool_call>` for in-scope requests,
- extracts multiple parameters correctly,
- answers naturally / declines (no hallucinated call) when no tool fits.

## Eval (held-out prompts, `scripts/eval-function-calling.py`) — 4/4 pass
| Prompt | Result |
|---|---|
| "What's the weather in Paris right now?" | `get_weather {"city":"Paris"}` ✓ |
| "Email john@example.com — meeting at 3pm, subject Meeting." | `send_email {"to","subject","body"}` (all 3 params) ✓ |
| "How much is AAPL trading at?" | `get_stock_price {"symbol":"AAPL"}` ✓ |
| "Write me a short poem about the ocean." (out-of-scope) | declines, **no hallucinated call** ✓ |

## Training
- Base: `Qwen/Qwen2.5-3B-Instruct`
- Data: `glaiveai/glaive-function-calling-v2` → 3000 Qwen-native pairs (670 tool-call / 2330 natural), via `scripts/prep-function-calling.py`
- Method: bf16 LoRA (r=32, α=64), 2 epochs, 1500 steps, lr 2e-4, max_len 1536
- Hardware: **RTX 5090 (local)**, ~29 min
- Recipe: `recipes/function-calling-qwen2.5-3b.json`

## Reproduce
```
python scripts/prep-function-calling.py 3000 Qwen/Qwen2.5-3B-Instruct data/fc-pairs.jsonl
python workers/distill/scripts/train_lora.py --pairs data/fc-pairs.jsonl --out data/fc-qwen3b-adapter \
  --student-base Qwen/Qwen2.5-3B-Instruct --lora-rank 32 --lora-alpha 64 --epochs 2 --batch-size 4 --max-length 1536
python scripts/eval-function-calling.py
```

## Cloud
The same recipe runs on a rented RunPod GPU via the **Vercel-key proxy** (`api/runpod.js`) — no local
RunPod token needed; the operator's key stays in Vercel. Verified read-only (the key authenticates to
RunPod's live API) and via a real L40S rental + teardown.

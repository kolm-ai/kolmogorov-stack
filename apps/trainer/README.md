# Kolm trainer bridge

Python FastAPI service that receives `/v1/specialists/auto-distill` jobs from
kolm.ai, runs a QLoRA training pass, and posts the result back. Two modes:

| mode | requires | use when |
|------|----------|----------|
| `mock` (default) | python + httpx + fastapi | local dev, e2e tests, CI smoke |
| `real` | `[gpu]` extra (torch + unsloth + peft + trl) | actual training on a CUDA box |

## Run locally (mock)

```bash
uv venv && uv pip install -e .
KOLM_TRAINER_MODE=mock uvicorn main:app --port 8000
```

Or with Docker:

```bash
docker build -t kolm-trainer .
docker run --rm -p 8000:8000 -v "$PWD/data:/data" kolm-trainer
```

## Run real training

```bash
uv pip install -e ".[gpu]"
KOLM_TRAINER_MODE=real uvicorn main:app --port 8000
```

## Wire to kolm.ai

On the kolm.ai side, set:

```
KOLM_TRAINER_BRIDGE=https://your-trainer.example.com
KOLM_TRAINER_BRIDGE_TOKEN=<shared-secret>
```

On this side, set:

```
KOLM_TRAINER_BRIDGE_TOKEN=<shared-secret>
```

The kolm.ai router posts `/distill` here; this service polls back to the
`callback_url` it was handed when training is done.

## Job lifecycle

1. `POST /distill {tenant, namespace, base_model, target_size, pair_count, callback_url, corpus_url?, holdout_ratio?}`
   → `202 {job_id, status: 'queued', status_url}`
2. Trainer streams status updates to `callback_url` as stages complete.
3. Final POST to `callback_url`:
   ```json
   {
     "job_id": "td_…",
     "status": "completed",
     "metrics": {"holdout_accuracy": 0.91, "training_loss_final": 0.18, …},
     "adapter": {"url": "file://…", "sha256": "sha256-…", "size_bytes": 12345678, "format": "peft-lora"}
   }
   ```

## Files

* `main.py` — FastAPI app + mock trainer + persistence
* `trainer_real.py` — Unsloth + PEFT path (lazy-imported)
* `Dockerfile` — slim Python image for mock mode
* `trainer-jobs.jsonl` — append-only job log (persists across restarts)
* `adapters/` — output directory for LoRA adapter files

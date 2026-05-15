# Compute providers exhaustive audit — 2026-05-14

Reference output from the compute-providers research agent.
Drives the v10c compute-backend abstraction wave.

> **Why this exists:** trainer_real.py requires CUDA. The dev box has no GPU.
> Apple silicon, Windows iGPUs, partner clouds, and user-owned GPUs are all
> first-class compute targets we should support — not a fallback story. This
> doc inventories every credible target and ranks them for Day 1 / Day 30
> integration.

---

## A. Local accelerators (no network required)

| Backend  | Hardware                | Train? | Infer? | Status       | Wheel/Lib                |
|----------|-------------------------|--------|--------|--------------|--------------------------|
| `cpu`    | any x86_64 / arm64      | yes    | yes    | shipping     | torch (CPU)              |
| `cuda`   | NVIDIA RTX/A/H/L series | yes    | yes    | shipping     | torch+cu121 / unsloth    |
| `mps`    | Apple Silicon (M1+)     | yes    | yes    | Day 1        | torch (mps)              |
| `mlx`    | Apple Silicon (M2+)     | yes    | yes    | Day 30       | mlx-lm                   |
| `rocm`   | AMD MI / RDNA3+         | yes    | yes    | Day 30       | torch+rocm6              |
| `directml` | Windows DX12          | yes\*  | yes    | maintenance  | torch-directml           |
| `vulkan` | any GPU                 | no     | yes    | inference    | llama.cpp / candle       |
| `oneapi` | Intel Arc / Max         | yes    | yes    | Day 60       | intel-extension-for-py   |
| `ane`    | Apple Neural Engine     | no     | yes    | inference    | coreml-tools             |

\* DirectML training works for small LoRA; not all ops covered.

**Tier 1 local (Day 1):** `cpu` (fallback, already shipping), `cuda` (already shipping via trainer_real.py), `mps` (priority — covers every Mac dev box).

**Tier 2 local (Day 30):** `mlx`, `rocm`, `directml`.

---

## B. Serverless GPU clouds (managed runners)

| Provider     | Auth        | SDK        | Cold start | Notes                                        |
|--------------|-------------|------------|------------|----------------------------------------------|
| Modal        | API key     | `modal`    | ~5s        | Best-in-class container persistence; volumes; web endpoints; serverless GPU H100/A100/L4. Pay per second. |
| RunPod       | API key     | `runpod`   | 30–120s    | Cheapest on-demand H100 / A100 / RTX 4090. Serverless or pod-based. Spot pricing aggressive. |
| Together AI  | API key     | `together` | n/a        | Fine-tune API (LoRA + full), serving. Higher abstraction. |
| Replicate    | API token   | `replicate`| 60s+       | Cog containers, predictable but slower cold starts. |
| fal.ai       | API key     | `fal-client` | ~5s      | Fast inference focus; some training. |
| Beam         | API key     | `beam`     | ~10s       | Functions-style; good MPS-shaped API. |
| Cerebras    | API key     | `cerebras_cloud_sdk` | n/a | Inference-only at LLM scale (very fast). |
| Groq         | API key     | `groq`     | n/a        | Inference-only LPU. |
| Anyscale     | API key     | `anyscale` | ~10s       | Managed Ray + GPU. |

**Tier 1 partners (Day 1):** Modal, RunPod, Together AI.

**Tier 2 partners (Day 30):** Replicate, fal.ai, Beam.

---

## C. GPU marketplaces (bare-ish metal, cheap)

| Provider     | Auth        | SDK / CLI         | Notes                                         |
|--------------|-------------|-------------------|-----------------------------------------------|
| Vast.ai      | API key     | `vast` (CLI + REST) | Cheapest on-demand H100 worldwide; SSH-based. Best for long jobs. |
| TensorDock   | API key     | REST              | Per-second billing; competitive pricing.      |
| Lambda Labs  | API key     | REST              | Reliable on-demand H100/A100; SSH; clusters.  |
| CoreWeave    | sales       | k8s               | Enterprise; reserved capacity.                |
| Crusoe       | sales       | REST              | Sustainable energy GPU; reserved + spot.      |
| FluidStack   | API key     | REST              | Spot-style H100 inventory.                    |
| SF Compute   | API key     | REST              | Marketplace clearinghouse for SF/Berkeley DCs.|
| Tensorwave   | API key     | REST              | AMD MI300X specialty.                         |
| Foundry      | sales       | k8s               | Compute reservation broker.                   |

**Tier 1 marketplaces (Day 1):** Vast.ai (price floor + SSH-only is simple).

**Tier 2 marketplaces (Day 30):** Lambda Labs, TensorDock, CoreWeave / SF Compute.

---

## D. Hyperscalers (enterprise / regulated)

| Provider | Auth         | SDK             | Notes                                       |
|----------|--------------|-----------------|---------------------------------------------|
| AWS      | IAM / SigV4  | `boto3`         | SageMaker / EC2 GPU; BAA + FedRAMP.         |
| GCP      | service acct | `google-cloud`  | Vertex / GCE GPU; BAA.                      |
| Azure    | OAuth        | `azure-mgmt-*`  | ML Studio / VMSS; BAA + GovCloud.           |

Day 60+ — most users go via BYOC for enterprise. Hyperscaler-direct is a separate ticket.

---

## E. Self-hosted (BYO GPU, BYO cluster)

| Target       | Auth     | Notes                                                    |
|--------------|----------|----------------------------------------------------------|
| `remote-ssh` | key+host | Run trainer over SSH on the user's box (private or cloud). |
| `slurm`      | sbatch   | HPC submission; Day 60.                                  |
| `k8s`        | kubeconfig | Helm chart + Job CRD; Day 60.                          |
| `ray`        | ray addr | Anyscale-compatible; Day 60.                            |

**Tier 1 self-hosted (Day 1):** `remote-ssh` covers 90% of "I have my own 4090".

---

## Auto-pick formula

Score per backend (higher = better):

```
S = 0.40 * available      // can we actually run right now? 0|1, fall back to capability score
  + 0.25 * cost_inv       // cheaper = higher
  + 0.20 * latency_inv    // lower cold start + queue = higher
  + 0.15 * repro          // determinism / pinning support
```

Constraints (hard filters before scoring):
- `train_required: true` removes inference-only backends.
- `airgap: true` removes all network backends.
- `min_vram_gb: N` removes backends with smaller cards.
- `budget_usd: N` removes paid backends if user has no key.

Picker output records:
```json
{
  "backend": "local-mps",
  "device": "mps:0",
  "reason": "cheapest available with train support; cuda absent",
  "score": 0.86,
  "alternatives": ["local-cpu (0.41)", "modal (0.78, requires KOLM_MODAL_TOKEN)"]
}
```

---

## Backend capability matrix

| Backend     | Train | Infer | Airgap | Cost/hr      | Cold start | VRAM cap | Auth        | Day |
|-------------|-------|-------|--------|--------------|------------|----------|-------------|-----|
| local-cpu   | yes   | yes   | yes    | $0           | 0s         | RAM      | none        | 1   |
| local-cuda  | yes   | yes   | yes    | $0 (own)     | 0s         | own      | none        | 1   |
| local-mps   | yes   | yes   | yes    | $0 (own)     | 0s         | shared   | none        | 1   |
| local-mlx   | yes   | yes   | yes    | $0 (own)     | 0s         | shared   | none        | 30  |
| modal       | yes   | yes   | no     | $1.05–4.10   | ~5s        | 80 GB    | API key     | 1   |
| runpod      | yes   | yes   | no     | $0.39–3.20   | 30–120s    | 80 GB    | API key     | 1   |
| together    | yes\* | yes   | no     | per-token    | 0s         | n/a      | API key     | 1   |
| vast        | yes   | yes   | no     | $0.20–2.00   | 60s        | 80 GB    | API key+SSH | 1   |
| remote-ssh  | yes   | yes   | yes\*\*| $0 (own)     | ~0s        | own      | SSH key     | 1   |
| replicate   | yes\* | yes   | no     | per-second   | ~60s       | varies   | API token   | 30  |
| lambda      | yes   | yes   | no     | $1.10–3.29   | 30–120s    | 80 GB    | API key     | 30  |
| local-rocm  | yes   | yes   | yes    | $0 (own)     | 0s         | own      | none        | 30  |

\* Together's training is fine-tune endpoint, not full PyTorch — limited model coverage.
\*\* Airgap when the SSH target itself is on a private network.

---

## Backend interface (canonical)

Every backend (local or remote) exposes the same interface:

```ts
interface ComputeBackend {
  name: string;                                  // "local-mps", "modal", ...
  detect(): Promise<{available: boolean, version?: string, devices?: string[]}>;
  pickScore(constraints): Promise<number>;       // 0..1
  run(spec: TrainSpec): Promise<TrainResult>;    // streams progress via callbacks
  info(): BackendInfo;                            // static metadata
}
```

`TrainSpec`:
```ts
{
  job_id: string,
  base_model: string,           // HF name or local path
  pairs: Array<{input, output}>,
  target_size: '0.5b' | '1.5b' | '3b' | '7b',
  holdout_ratio: number,
  hyperparams: { epochs, lr, lora_r, lora_alpha, ... },
  budget: { max_seconds, max_usd }
}
```

`TrainResult` (records into receipt):
```ts
{
  metrics: { holdout_accuracy, holdout_f1, training_loss_final, epochs, steps,
             pair_count, holdout_pair_count, trainable_params, lora_targets,
             device, train_seconds, backend, base_model, target_size, mode },
  adapter: { url, sha256, size_bytes, file_count, format: 'peft-lora' | 'mlx-lora' },
  compute: { backend, device, region?, cost_usd, started_at, finished_at,
             provenance: { sdk_version, container_digest?, instance_type? } }
}
```

`compute.provenance` lands in receipt.json so a third party can verify which
backend produced the artifact without re-running.

---

## Detection rules (local)

Run on `kolm compute detect`:

| Check                                       | Sets backend |
|---------------------------------------------|-------------|
| `torch.cuda.is_available()`                 | `local-cuda` |
| `torch.backends.mps.is_available()`         | `local-mps` |
| `mlx-lm` importable AND Apple Silicon       | `local-mlx` |
| `torch_directml` importable                 | `local-directml` |
| `torch.version.hip`                         | `local-rocm` |
| `mtl-info` reports ANE-capable               | `local-ane` (inference) |
| Always available                            | `local-cpu` |

Detection results cached at `~/.kolm/compute-detect.json` for 1 hour.

---

## Cost guardrails

- `KOLM_COMPUTE_BUDGET_USD=5` env var caps any single job.
- Picker rejects backends whose estimated cost exceeds the cap.
- Receipt records the actual cost from the partner API (if exposed).
- `kolm compute status --since 24h` shows running totals.

---

## Open verifications (next session)

- Modal H100 pricing 2026-Q2: verify `$4.10/hr` headline still accurate.
- Together AI fine-tune endpoint: confirm LoRA r/alpha exposure today.
- Vast.ai REST API auth header: bearer vs `?api_key=`.
- MLX-LM training API stability (was alpha in Q4'25).
- DirectML PEFT compatibility — last verified mid-2025.

---

## Summary

Day-1 set covers every realistic dev box (CPU+CUDA+MPS+remote-SSH) plus three
partner clouds (Modal+RunPod+Together) plus the cheap marketplace (Vast). That
is ~90% of real-world hospital/clinic/research-lab deployment surface. Day-30
adds MLX (Mac-native), ROCm (AMD), DirectML (Windows), Lambda Labs, Replicate,
fal.ai. Day-60 is hyperscalers and Slurm/k8s/Ray for HPC sites. No backend is
"the move"; **every backend is selectable, every job records provenance, and
the user keeps the artifact.**

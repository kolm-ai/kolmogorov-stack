# kolm.ai — Workbench Audit & 10000% Spec (2026-06-16)

Grounded answer to: *"Can people use this as a full training/distillation/compilation
workbench? What do we do re: training data? What is best-in-slot right now? Have we
truly atomized each component to 10000%?"*

Method: three read-only audit agents (training-data pipeline, distillation-engine depth,
promise-vs-reality + workbench UX) plus a live, proven LoRA train on RTX 5090 this session
(`workers/distill/distill.mjs --mode=full` → real `adapter_model.safetensors`,
`train_loss 3.82`, `ml_pipeline_run: true`).

---

## 1. Workbench reality: ~6/10 real vs ~8/10 promised

Three truths the surface conflates:

1. **The compiler works self-serve.** capture → split → distill → quantize → bundle →
   sign → run is real and wired into `kolm compile`. Ships every run.
2. **The trainer is real** (proven on the 5090). `train_lora.py` (PEFT/HF, 352 lines),
   `train_lora_unsloth.py`, `eval_adapter.py` (686), `merge_adapters.py` are
   production-grade.
3. **The self-serve product surface for distillation is gated.**
   - `kolm distill` → `/v1/specialists/auto-distill` → **503 `distill_bridge_not_configured`**
     (cli/kolm.js:22151).
   - `kolm tune` subcommands in `--help` have **no `cmdTune*` implementations**.
   - Dashboard has **no data-curation / eval / training UI**.

**The gap is wiring, not capability.** Local Python+torch user can train; a pure-SaaS user
clicking the product cannot. Highest-leverage fix in the repo.

### Strategy coverage (depth audit)

| Strategy | Trainer | Real? |
|---|---|---|
| `lora_sft` | `train_lora.py` | ✅ 90-95% |
| `kd_softmax`/`kd_top_k`/`rejection_sampling` | `train_gkd.py` | ⚠️ 40% — JSD loss correct (Agarwal 2306.13649), trainer dispatch incomplete |
| `preference_optimization` | `train_preference.py` | ⚠️ 50% — thin `trl` DPO/KTO/ORPO wrapper, no in-repo trainer |
| `onpolicy_distill` | `$KOLM_ONPOLICY_TRAINER` | ❌ 0% — plugin-only, fails loud |
| `speculative_decoding_train` | none | ❌ 0% — catalog-only |
| `small_classifier` | compile-time rules | ❌ not a trainer |

Quant: int4/int8/gptq/awq wired (~75%); aqlm/quip/exl2/exl3/hqq/qat scaffold (~15%).
Compute lanes real: local-cuda, remote-ssh, runpod. modal/lambda/together are thin proxies.
**Honesty note:** every stub fails loud with an install hint — not roadmap misrepresentation.

---

## 2. Training data

**Default `kolm compile`:** event-store (always) → `status=success` filter → tenant scope
(W411) → deterministic 80/20 `sha256(input+seed)` split → holdout fail-closed disjoint at
3 checkpoints (identity + row-hash) → floors 40 train / 10 holdout → heuristic quality
(length/CoT/refusal, threshold 0.35) → **3-gram bucket dedup (misses paraphrases)**.

**Frontier `kolm compile --auto` (W921):** real, tested six-stage CURATE — learned quality
classifier, MinHash + Python semantic dedup, embedding k-means cluster, Confident-Learning
label-error detection, CoT drop, PII redact, DSIR/diversity selection. Pure-JS or graceful
degrade. **Opt-in only; not in default path; doesn't feed back into default compile.**

**Provenance:** complete (source_type/source_ref/ingested_at per pair; teacher-source
policy open-weights vs proprietary; run-meta/progress/manifest lineage). **W808 regression
gate is advisory, not blocking.**

**Dead code:** `curriculum-sort.js` (W713) and `data-scaling-law.js` — authored, never called.

Candid line: training data is handled correctly but **conservatively by default; the
sophisticated machinery exists but is dark.**

---

## 3. Best-in-slot positioning

| Axis | kolm | Field leader |
|---|---|---|
| Core SFT/LoRA | 90% | Unsloth 98%, Axolotl 95% |
| Distillation | 65% | Together 90%, Predibase 80% |
| Preference (DPO/SimPO) | 50% | Together/Unsloth 90-95% |
| Online RL (GRPO/RLVR) | 20% | Together 95% |
| **Eval + K-score gating** | **80-85%** | **nobody packages this** |
| Quantization | 40% | Axolotl/Together 90%+ |

**Differentiator (the moat):** signed `.kolm` artifacts + K-score eval gating + fail-closed
holdout honesty + PHI-redacting AES-256-GCM teacher bridge, delivered as one verifiable
receipt. No competitor ships that bundle. Trainer *breadth* is not the moat and chasing
Unsloth/Together on breadth is a losing race — **double down on verifiable-compile.**

---

## 4. Atomization: NOT taken to 10000%

This program was **surgical repair of a working v1 spine**, not a ground-up per-component
10000% build. Done this session: auth fix, team-key sharing bug, fal-teacher synthesis,
real-loss surfacing, magic-link, distill worker, dashboard, proven real LoRA. 43/43 green.

What "10000% per component" actually requires (the spec):

### A. Un-gate self-serve distillation  *(P0 — closes the headline gap)*
- Implement the `/v1/specialists/auto-distill` bridge (replace 503) → enqueue real
  `distill()` job on a compute lane, stream progress over SSE.
- Implement `cmdTuneStart/Status/Pull` so `kolm tune` in `--help` is real.
- Dashboard: dataset view, holdout/leakage panel, K-score delta, "Train" button.

### B. Finish the half-wired trainers  *(P1)*
- `train_gkd.py`: wire `trl.GKDTrainer` to the existing JSD loss; end-to-end test.
- `train_grpo.py`: vendor a default GRPO trainer (or pin `trl`) so it's not external-only.
- Preference: promote to a first-class in-repo trainer with our K-score reward, not a
  pass-through `trl` shell.

### C. Curation on by default  *(P1)*
- Move MinHash + semantic dedup + learned quality into the default compile path (they're
  pure-JS / graceful-degrade already); keep heavy stages opt-in.
- Make the W808 regression gate **blocking** on promotion, not advisory.

### D. Real advanced quant + export  *(P2)*
- Wire aqlm/quip/exl3/hqq to actual quantizers or **remove from the catalog** (don't
  advertise scaffold).

### E. Kill dead code  *(P2)*
- Delete or wire `curriculum-sort.js` and `data-scaling-law.js`.

**Recommended order:** A (un-gate — turns "trainer exists" into "anyone can train") → C
(blocking gate + default dedup — protects quality) → B (trainer breadth) → D/E (polish).
A alone moves the workbench score from ~6/10 to ~8/10.

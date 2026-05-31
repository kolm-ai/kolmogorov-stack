# Speculative Decoding with a Kolm-Distilled Student as the Draft Model

Document status: Research roadmap, not for V1 launch.
Authors: kolm research / wave4-spec-dec-research
Last updated: 2026-05-26
Target audience: kolm core team, frontier-runtime partners, enterprise prospects evaluating self-hosted teacher deployments.

---

## 0. TL;DR

A kolm-distilled student is a near-perfect draft model for the teacher it was distilled from, on the namespace it was trained on. Routing through speculative decoding (spec-dec) with `draft = trinity-500.kolm`, `target = the same teacher that distilled it` should produce teacher-quality output at roughly an order of magnitude lower latency than calling the teacher alone, with no quality loss versus the teacher baseline.

This document describes the design, the math, the open questions, and the validation plan. No code is shipped here. The proposal is queued for V1.1 or V2 after the V1 distill / wrapper / studio surfaces are stable and after we have sustained per-namespace traffic to measure acceptance rates against real customer payloads.

---

## 1. Problem statement

Customers today face a binary choice:

- **Frontier-only.** Call Claude opus / GPT-5 / Gemini 2.5 Pro on every request. Output quality is high, but per-call latency is 1.5-3 s and per-1k-token cost sits in the $5-$15 range for the highest tier. Cost and latency scale linearly with traffic.
- **Local-only.** Run a small, fast, locally-served model (Qwen 2.5 7B Q4, Llama 3 8B, Phi-3, the trinity-500 family). Latency is excellent (sub-100 ms first token, 500-2000 tok/s) and marginal cost is near zero. Quality is acceptable for narrow tasks but visibly below frontier on edge cases, long-tail reasoning, and out-of-distribution prompts.

Most production teams cope by sharding: cheap requests routed to a local / small model, expensive requests routed to frontier. The route decision is itself a quality-cost trade and is opaque to the end user. Worse, when the small model is wrong, the team usually does not learn until the customer complains, and the per-request quality envelope is bounded above by whichever model handles the call.

What teams actually want: teacher-grade output on every request, at near-student latency, at near-student marginal cost. Speculative decoding is the only mainstream technique that delivers all three simultaneously, and a kolm-distilled student is the highest-leverage draft model anyone in the open ecosystem can build for that purpose.

---

## 2. Speculative decoding background

Speculative decoding (Leviathan et al. 2023, Chen et al. 2023, vLLM / SGLang implementations 2024-2025) is a lossless acceleration technique that uses a small "draft" model to propose token sequences and a large "target" model to verify them.

The core loop, per response:

1. **Draft.** The draft model generates `k` candidate tokens (`k` typically 4-8) starting from the current prefix. This is cheap because the draft model is small.
2. **Verify.** The target model is called once with the prefix-plus-`k`-candidates and returns logits for each of the `k+1` positions in a single forward pass. This is exactly one target forward pass regardless of `k`.
3. **Compare.** For each candidate token in order, compare the draft's sampled token to the target's distribution at that position. Accept the token with probability `min(1, p_target / p_draft)`. The standard Leviathan acceptance rule is provably lossless: the resulting distribution over generated tokens is identical to greedy or temperature sampling from the target alone.
4. **Correct.** At the first rejection, sample one replacement token from the residual distribution `(p_target - p_draft).clip(0)`, normalized. Discard the remaining candidates.
5. **Emit.** Emit the accepted tokens plus the one correction. Repeat.

Per accepted-prefix-of-length-N, the user spends one target forward pass (plus N+1 draft forward passes, which are cheap). If the draft is good enough that the target accepts most candidates, throughput goes up roughly proportional to the acceptance rate.

### 2.1 Speedup formula

Let:

- `k` = number of speculative tokens per round (typically 4-8).
- `a` = empirical acceptance rate per candidate token (a ∈ [0,1]).
- `c_t` = wall-clock cost of one target forward pass.
- `c_d` = wall-clock cost of one draft forward pass.
- `o` = correction / orchestration overhead per round (verify-pass marshalling, token compare, KV cache fixup).

Expected accepted tokens per round = sum over i=1..k of a^i = a * (1 - a^k) / (1 - a). For k large and a < 1 this approaches a / (1 - a).

Approximate per-token wall-clock cost:

  cost_per_token ≈ (c_t + k * c_d + o) / (accepted_per_round + 1)

The "+1" is the guaranteed correction token. The speedup vs target-alone is `c_t / cost_per_token`. In practice, when c_d << c_t and o is small, the speedup tracks `1 + a + a^2 + ... + a^k`, capped near `1/(1-a)`.

### 2.2 Industry baselines

Published numbers and observed open-source numbers for generic draft / target pairings:

| Draft | Target | Reported acceptance | Reported speedup |
| --- | --- | --- | --- |
| Llama 3 1B | Llama 3 70B | 0.55-0.65 | 2.2-2.6x |
| Qwen 2.5 1.5B | Qwen 2.5 32B | 0.45-0.60 | 2.0-2.5x |
| GPT-4-turbo (draft) | GPT-4 (target) | not public | reported "around 2x" by OpenAI engineers in talks |
| Claude haiku 3 | Claude opus 3 (vLLM-self-hosted) | reported 0.4-0.55 by integrators | 1.8-2.4x |
| MEDUSA heads | base model | 0.55-0.70 | 2.0-3.0x |
| EAGLE-2 | various | 0.65-0.80 | 2.5-3.5x |

The clear ceiling for generic-draft spec-dec is in the 2-3x range. EAGLE-style learned-head methods push higher but require modifying the target.

### 2.3 Why the ceiling is low

The draft and target were trained independently, on different data mixes, with different objectives. The draft's distribution over next tokens is broadly correlated with the target's but is biased in systematic ways: vocabulary frequency priors differ, system-prompt sensitivity differs, formatting habits differ. On long tails and domain-specific text, acceptance drops further. The draft has no awareness of the target's particular fine-tuning signal.

This is the bottleneck the kolm insight removes.

---

## 3. The kolm insight

A kolm-distilled student is not a generic draft model. By construction, it was trained:

- **From the same teacher.** The training signal is the teacher's own output distribution on real namespace prompts. The student's next-token distribution is shaped to match the teacher's wherever the student has capacity. For the prompts in the training distribution, the student's logits are explicitly optimized to be a low-divergence approximation of the teacher's logits.
- **On the same task distribution.** kolm distill recipes pull from real production traffic in the customer namespace. The vocabulary, format, reasoning patterns, prompt structure, and edge cases the student sees in training are exactly the ones it will see at inference.
- **In the same namespace.** Domain-specific terminology, brand voice, safety carve-outs, and policy constraints are baked into the student via the council pairs. The student does not need to discover them at inference.

Concretely: when you call the teacher with a customer support question for namespace `acme/support`, and ask the trinity-500-acme student trained on that namespace what the next token should be, the student's answer is much closer to the teacher's answer than any generic draft model could be, because the student was literally optimized for exactly this distribution. The student is, in effect, a learned compression of the teacher's behavior on this namespace.

### 3.1 Why acceptance should be high

Expected per-candidate acceptance for `(draft = trinity-500-acme, target = same teacher that distilled it)` on in-namespace traffic:

- On training-distribution prompts the student saw analogues of during distill: 0.80-0.92.
- On in-namespace prompts outside the distill set but still in-domain: 0.65-0.80.
- On out-of-domain prompts (user asks about something the namespace was not built for): 0.40-0.55 (degrades to generic-draft territory).

This document assumes a 0.70-0.85 working range as a target, with the understanding that real numbers must be measured per namespace before any product claim is made.

### 3.2 Why this is hard to copy

A competitor cannot replicate this benefit without:

1. Access to the teacher's logits during distill (kolm controls this via the teacher providers we run / proxy).
2. A namespace-scoped distill recipe that captures the same distribution (kolm artifact format encodes this).
3. The infrastructure to deploy a draft locally and a target with logit access (kolm runtime).
4. A receipt schema that proves which draft and which target ran on which request (kolm receipts).

Each of these is a piece of the kolm stack. The composition is the moat.

---

## 4. Architecture

### 4.1 ASCII diagram

```
[ user query in namespace acme/support ]
                  │
                  ▼
   ┌──────────────────────────────────┐
   │  kolm gateway                    │
   │  route_decision = 'spec_dec'     │
   └──────────────┬───────────────────┘
                  │
                  ▼
   ┌──────────────────────────────────┐
   │  kolm student (local, 7B Q4)     │
   │  trinity-500-acme.kolm           │
   │  draft = k candidate tokens      │
   └──────────────┬───────────────────┘
                  │  k tokens
                  ▼
   ┌──────────────────────────────────┐
   │  frontier teacher                │
   │  (Claude opus on vLLM /          │
   │   Llama 3 405B on vLLM)          │
   │  one verify forward pass         │
   │  returns k+1 logit positions     │
   └──────────────┬───────────────────┘
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
[ accept first N ]    [ correct token N+1 ]
       │                     │
       └──────────┬──────────┘
                  ▼
   ┌──────────────────────────────────┐
   │  stream merged tokens to user    │
   │  emit receipt:                   │
   │    route_decision: 'spec_dec'    │
   │    draft_id: trinity-500-acme    │
   │    teacher_id: claude-opus-4-7   │
   │    draft_acceptance_rate: 0.78   │
   │    teacher_calls: 1              │
   │    corrections: 1                │
   └──────────────────────────────────┘
```

### 4.2 Component responsibilities

- **kolm gateway.** Decides the route. Today it knows `local-only` and `frontier-only`. The new option is `spec_dec`. The decision can be set explicitly by the caller (`route: 'spec_dec'`) or learned by the router from latency-budget and quality-budget hints (see Section 5).
- **kolm student (draft).** A locally-served `.kolm` artifact. Quantized as Q4 / Q5 / Q8 depending on hardware. Must expose a `generate_with_logits(prefix, k) -> (tokens, logits)` interface so the verify pass can compare distributions, not just sampled tokens.
- **frontier teacher (target).** A teacher model served with logit access. In practice this means vLLM, SGLang, TGI, or TRT-LLM serving the teacher weights. Public chat-completions APIs from Anthropic and OpenAI do not currently expose token-level logits in the form required for the standard verify rule, which is the central caveat in Section 7.
- **verify pass.** The target accepts a (prefix, candidates) pair and returns logits for each of the k+1 positions. Standard Leviathan acceptance rule is applied client-side in the gateway.
- **receipt.** Standard kolm receipt plus the spec-dec fields. The receipt is the audit trail for "was the output teacher-quality" — because the spec-dec acceptance rule is lossless when applied correctly, the receipt fields plus a teacher-id are sufficient to make the quality claim.

### 4.3 KV cache and orchestration

Two complications worth flagging early.

- **KV cache reuse across rounds.** Both draft and target keep KV caches. After a round, the accepted tokens stay in the cache and the rejected candidates must be evicted. Most modern serving stacks (vLLM, SGLang) support this primitive directly. Calling the teacher via HTTP without cache reuse defeats most of the speedup, because each verify pass would re-read the prefix from scratch. The teacher must be served with a stateful session, which is another reason the teacher path is self-hosted vLLM rather than the public chat-completions endpoint.
- **Streaming.** End users expect token-by-token streaming. Spec-dec emits in bursts of N+1 tokens per round, so the perceived stream is bursty but still feels live at reasonable acceptance rates. We may want to add a small smoothing buffer at the gateway to even out the perceived stream rate.

---

## 5. The new routing tier

### 5.1 Current routes

- `local-only`: call only the local student. Cheapest, fastest, lower quality.
- `frontier-only`: call only the frontier teacher. Highest quality, slowest, most expensive.

### 5.2 New route

- `spec_dec` (working name; final name TBD): call the student to draft, the teacher to verify. Output is teacher-quality (subject to the lossless guarantee in Section 6.3); latency and cost are bounded between local-only and frontier-only and approach local-only as acceptance rate approaches 1.

### 5.3 Caller surface

Explicit form, set by the caller in the gateway request body:

```
POST /v1/gateway/dispatch
{
  "namespace": "acme/support",
  "messages": [...],
  "route": "spec_dec",
  "spec_dec": {
    "draft_artifact": "trinity-500-acme.kolm",
    "teacher_id": "claude-opus-4-7-vllm",
    "k": 6
  }
}
```

Hint-based form, where the router picks `spec_dec` if both quality and latency budgets are tight:

```
POST /v1/gateway/dispatch
{
  "namespace": "acme/support",
  "messages": [...],
  "quality_floor": "teacher",
  "latency_budget_ms": 600
}
```

The router picks `spec_dec` because `frontier-only` cannot meet the latency budget and `local-only` cannot meet the quality floor.

### 5.4 Receipt extension

Every spec-dec response carries a receipt with at minimum:

- `route_decision`: `'spec_dec'`
- `draft_artifact_cid`: the kolm artifact content id
- `teacher_id`: the target model id and version
- `draft_acceptance_rate`: per-request acceptance rate, in [0, 1]
- `teacher_forward_passes`: the number of verify calls actually made
- `corrections`: the number of correction tokens emitted (always == teacher_forward_passes minus end-of-stream)
- `k`: the speculative window used
- `quality_claim`: `'teacher_equivalent_lossless'` if the standard Leviathan acceptance rule was used end-to-end; otherwise the schema requires a degraded label and a reason

---

## 6. Implementation plan (phased)

No code is being written in this document. The phases below describe the order of work, the gating criteria, and the surface contracts that would change. Each phase is independently shippable and independently measurable.

### 6.1 Phase 1: Standalone spec-dec runner (offline measurement)

- Use HuggingFace `transformers` `model.generate(assistant_model=student)` or vLLM `--spec-dec` flag.
- Inputs: a held-out namespace eval set (e.g. 500 acme/support prompts), the teacher checkpoint, the trinity-500-acme student checkpoint.
- Outputs:
  - per-prompt acceptance rate
  - per-prompt latency vs teacher-alone vs student-alone
  - quality parity check vs teacher-alone (greedy and temperature)
- Goal: confirm the 0.70-0.85 acceptance hypothesis on real prompts.
- Gating: if acceptance < 0.55 on representative namespaces, the rest of the plan is paused pending recipe improvements to the distill.

### 6.2 Phase 2: Acceptance rate measurement on real namespace traffic

- For 2-4 design-partner namespaces, replay a week of real production traffic through:
  - student-only baseline
  - teacher-only baseline
  - kolm-student-as-draft spec-dec
  - generic-draft spec-dec (Claude haiku as draft for Claude opus, Qwen 7B as draft for Qwen 72B)
- Goal: confirm the differential — kolm-as-draft should beat generic-draft by 15-30 points of acceptance rate.
- Outputs: a research artifact comparing acceptance rates per namespace, per prompt-type, per token-position. This is what we publish.

### 6.3 Phase 3: Wrap as a kolm runtime command

- New runtime command (working name; not built yet): `kolm serve --spec-dec --teacher claude-opus-4-vllm --draft trinity-500-acme.kolm --k 6 --port 8765`.
- Behavior: bind a local endpoint that accepts standard chat-completions-style requests and runs the spec-dec loop internally. Returns a token stream plus a receipt.
- This is the unit-of-deployment for self-hosted customers. They run it on the same box as their vLLM teacher.

### 6.4 Phase 4: Wire into /v1/gateway/dispatch as a route option

- Gateway learns the `spec_dec` route per Section 5.
- Router learns the quality-floor + latency-budget heuristic.
- Public-API teachers (Anthropic, OpenAI) are rejected at the route level with a clear error (`teacher_does_not_expose_logits_for_spec_dec`) and a fallback suggestion (use `frontier-only` instead).

### 6.5 Phase 5: Receipt schema extension + verify endpoint update

- Receipt schema gains the fields in Section 5.4.
- `/v1/verify/:cid` understands the new fields and emits them in the verifier.
- Public verifier UI gets a one-line spec-dec block when the receipt has `route_decision == 'spec_dec'`.

### 6.6 Out-of-scope for the first cut

- Multi-draft / tree spec-dec (Medusa, EAGLE, ReDrafter). These are interesting but require modifying the target and are a separate research thread.
- Multi-tier (draft -> medium -> teacher). Useful when the gap between draft and teacher is huge; for kolm-student-as-draft the gap is small enough that single-tier should already be near-optimal.
- Cross-namespace draft sharing. A trinity-500-acme draft for an acme prompt is great; using it for a different namespace is not necessarily better than generic.

---

## 7. Caveats / Limitations

### 7.1 Logit access requirement on the teacher

Speculative decoding requires the target model to expose token-level logit distributions over its vocabulary for the verify positions, not just the sampled token or top-k logprobs.

- **vLLM, SGLang, TGI, TRT-LLM self-hosted**: yes, full logit access. Spec-dec works end-to-end.
- **Anthropic public chat-completions API**: no token-level logits exposed in the response shape required for the verify rule. Anthropic's API does not currently return full vocabulary distributions per position.
- **OpenAI chat.completions API**: returns top-k logprobs when `logprobs: true` is requested, but only the top 20 by default and even at expanded settings does not return the full vocabulary distribution required for the lossless acceptance rule.
- **Gemini public API**: similar restriction; no full-vocab logits per position.

Practical consequence: the spec-dec route is only viable when the teacher is self-hosted on a logit-exposing runtime. This restricts the addressable customer set to enterprise customers running their own teacher (Llama 3 405B on vLLM, fine-tuned open weights on vLLM, BYOC Claude/GPT-via-Bedrock-or-equivalent on a stack that exposes logits).

For SaaS customers calling the public Anthropic / OpenAI / Gemini APIs, the route returns `frontier-only` with an explicit reason. This is the plain accounting of what the technique can and cannot do.

### 7.2 Top-k-logprob fallback (degraded mode)

It is theoretically possible to run a degraded spec-dec mode using only top-k logprobs from a public API:

- For each candidate token, check whether the public-API top-k contains the draft's sampled token.
- If present at a high enough logprob, accept.
- If absent, reject and use the public API's sampled token as the correction.

This is **not lossless**. The acceptance rule cannot be proven distribution-equivalent to teacher-alone. The output distribution is biased toward in-top-k tokens. We may explore this as a separate "near-lossless" mode with a distinct receipt label (`quality_claim: 'teacher_approximate_topk'`), but it cannot share the lossless-quality claim with the standard mode and must be marked accordingly.

### 7.3 Latency assumption: co-located draft and target

The speedup math assumes the draft and target share a host or sit on a low-latency local network. If the verify pass goes over a public internet hop, the per-round network RTT can dwarf the verify compute and erase the speedup. This is another reason the deployment unit is self-hosted: draft and target on the same box, the same rack, or at minimum the same VPC.

### 7.4 KV cache compatibility and tokenizer alignment

The standard verify rule assumes the draft and target use compatible tokenizers. If the trinity-500-acme student was trained from a teacher with a different tokenizer (rare, since the student is initialized from a base related to the teacher family, but possible across vendor lines), spec-dec is not directly applicable without re-tokenization at each round, which is too expensive.

The kolm distill recipe should record the tokenizer id of both the source teacher and the student artifact, and the spec-dec router should refuse the route if the tokenizers do not match (error: `tokenizer_mismatch`).

### 7.5 Recipe drift over time

A student distilled at month M may have falling acceptance against the same teacher at month M+6 if the teacher has been updated. The kolm registry already tracks teacher checkpoint ids; the spec-dec route should pin the teacher version that the student was distilled from, or warn loudly if a newer teacher is being used.

### 7.6 Cold start

At the start of a session, neither the draft nor the target has a warm KV cache. The first few rounds will not see the steady-state speedup. For short responses (under, say, 30 tokens) the spec-dec overhead may not amortize and we should route to teacher-only.

### 7.7 Sampling temperature

The standard Leviathan acceptance rule is defined per sampling distribution. Greedy decoding is the cleanest case. Temperature sampling works but requires the draft and target to sample at the same temperature, and the acceptance probability formula adjusts accordingly. Top-p / top-k sampling complicates the proof; current open implementations (vLLM, SGLang) handle this, but the spec-dec route should document the supported sampling modes precisely.

### 7.8 Not a substitute for a better draft

If acceptance rates are low, the right fix is to improve the distill recipe (more council pairs, better preference data, longer training, etc.), not to lower the spec-dec acceptance threshold. Lowering the threshold sacrifices the lossless guarantee.

---

## 8. Validation plan

The thesis "kolm-student-as-draft beats generic-draft and matches teacher quality" is testable. The validation plan is the gate for any public claim.

### 8.1 Acceptance-rate measurement

- For each of 2-4 design-partner namespaces:
  - 500 held-out prompts per namespace.
  - Three drafts compared: (a) trinity-500-namespace student, (b) generic Qwen 7B base, (c) generic Claude haiku (or equivalent for the target family).
  - Same teacher target across all three.
  - Acceptance rate measured per candidate position (positions 1..k).
- Expected outcome: trinity-500 acceptance 0.70-0.85, generic-draft acceptance 0.40-0.55. Differential is the headline.

### 8.2 End-to-end latency

- p50 and p95 time-to-first-token and total time on the same 500-prompt set:
  - teacher-only
  - student-only
  - kolm spec-dec
  - generic spec-dec
- Expected outcome: kolm spec-dec p50 within 1.5-2x of student-only, and roughly 5-10x faster than teacher-only at the working acceptance range.

### 8.3 Cost per 1k tokens

- Per 1k generated tokens:
  - teacher-only: full teacher token cost (current vLLM amortized $ per 1k or current vendor price per 1k).
  - student-only: amortized local infra cost (electricity + amortized GPU + amortized box).
  - kolm spec-dec: (1 student inference cost per generated token) + (1 teacher verify call per round). At a=0.75 and k=6, this is roughly 1 teacher call per ~3-4 generated tokens, versus 1 teacher call per 1 token under teacher-only.
- Expected outcome: kolm spec-dec cost roughly 25-35% of teacher-only at the working acceptance range, with the marginal cost trending toward student-only as acceptance approaches 1.

### 8.4 Quality parity check

- K-Score (kolm's internal quality metric) on the same 500-prompt set:
  - teacher-only vs kolm spec-dec: should be statistically indistinguishable under the standard Leviathan rule.
  - student-only vs kolm spec-dec: should show kolm spec-dec strictly better (by a meaningful margin) on the prompts where the student-only baseline diverges from the teacher.
- This is the central quality claim. If it fails, the lossless guarantee is broken somewhere in the pipeline (wrong acceptance rule, tokenizer drift, sampling-mode bug) and we do not ship until it is fixed.

### 8.5 Comparison framing

The research artifact (Section 6.2 output) should publish all four bars side by side: teacher-only, student-only, kolm spec-dec, generic-draft spec-dec. The headline is the kolm-vs-generic differential. The supporting figures are the quality-parity check and the latency / cost numbers.

### 8.6 Per-namespace publication

Acceptance rates and speedups must be reported per namespace, not aggregated. Aggregation hides the cases where the technique works extremely well and the cases where it degrades to generic-draft territory. Customers want to know: "for my distribution, what should I expect?" not "for the average distribution, what was reported?"

---

## 9. Back-of-envelope math

Working numbers. These are illustrative; real measurements supersede.

### 9.1 Latency

| Path | Tokens | Wall-clock | Effective tok/s |
| --- | --- | --- | --- |
| Teacher alone (Claude opus on vLLM, single A100/H100 partition) | 50 | ~1500 ms | ~33 tok/s |
| Student alone (trinity-500 7B Q4 on RTX 5090) | 50 | ~25 ms | ~2000 tok/s |
| Spec-dec at a=0.75, k=6 | 50 | ~80 ms | ~625 tok/s |
| Spec-dec at a=0.85, k=8 | 50 | ~55 ms | ~900 tok/s |
| Generic-draft spec-dec at a=0.50, k=6 | 50 | ~330 ms | ~150 tok/s |

Speedup of kolm spec-dec vs teacher alone: ~19x at a=0.75; ~27x at a=0.85.

### 9.2 Where the math comes from

At a=0.75, k=6:
- Expected accepted tokens per round = sum_{i=1..6} 0.75^i ≈ 2.46
- Plus 1 correction token = ~3.46 tokens per round.
- 50 tokens / 3.46 tokens-per-round ≈ 14.5 rounds.
- Each round costs ~1 verify pass (~5-6 ms of teacher GPU time on a small verify because the verify is one pass over the prefix-plus-k, but the per-step verify is still a single forward pass) + k draft forward passes (~0.3 ms each at student speeds).
- 14.5 rounds * (~5 ms verify + ~2 ms draft work) ≈ ~100 ms; we round up to ~80-100 ms to account for orchestration.
- This assumes the verify pass is run with KV cache reuse on a co-located vLLM teacher. Without cache reuse, the verify-pass cost increases dramatically.

### 9.3 Cost

| Path | Teacher calls per 1k tokens | Student calls per 1k tokens |
| --- | --- | --- |
| Teacher alone | 1k (one per token; teacher does all the work) | 0 |
| Student alone | 0 | 1k |
| Spec-dec at a=0.75, k=6 | ~290 (one verify per 3.46 accepted tokens) | ~1k (student drafts every token) |
| Spec-dec at a=0.85, k=8 | ~170 | ~1k |

At current public vendor prices (illustrative): teacher-only might cost $5-15 per 1k generated tokens at the top tier; kolm spec-dec at a=0.75 would cost roughly 25-35% of that, since the teacher contributes ~290 forward-pass-equivalents per 1k rather than 1k. Self-hosted teacher pricing depends on amortized GPU hours and is namespace-specific.

### 9.4 Sensitivity

The acceptance rate `a` is the single most important parameter. A swing from a=0.60 to a=0.80 roughly triples the throughput. This is why Phase 2 (per-namespace acceptance measurement) is the most important data-gathering step in the plan.

---

## 10. Decision and queue

This is a research roadmap, not a V1 launch item. The reasons are:

- **Self-hosted teacher dependency.** Spec-dec requires a logit-exposing teacher. Today, kolm's customer base spans public-API and self-hosted; pushing spec-dec as a V1 feature would force a self-hosted prerequisite that not all customers can or want to meet. We should let the self-hosted teacher path mature (BYOC vLLM, BYOC SGLang, Bedrock-via-logits if available) before making spec-dec a headline route.
- **Acceptance rate is unproven on customer data.** The 0.70-0.85 hypothesis is grounded in the structure of the distill but not yet measured at scale on real customer traffic. We do not want to publish a speedup number until Phase 2 confirms it. Headlines without numbers age badly.
- **vLLM rollout breadth.** Customers running their own vLLM with stateful sessions, KV cache reuse, and prefix-cache-aware spec-dec are still a minority. As vLLM 0.7+ and SGLang adoption broadens, the addressable set grows.
- **V1 is wrapper-first.** The V1 wave (W887 wrapper / trinity-500 distill / studio surfaces) is the right focal point now. Spec-dec is additive on top of that foundation and benefits from V1 receipts, V1 artifacts, and V1 namespace plumbing already being in place.

Queued for: V1.1 or V2, depending on how fast Phase 1 and Phase 2 measurements land and on design-partner demand.

Trigger to move from "queued" to "in flight":

- At least one paying design partner running a self-hosted teacher (vLLM or equivalent) in production.
- A trinity-500-namespace distill artifact for that customer's namespace, with a held-out eval set ready.
- A Phase 1 standalone measurement showing acceptance >= 0.65 on that namespace.

If any of those gates fails, the work remains queued and we revisit when vLLM-class self-hosting becomes more common in our customer base.

---

## STATUS

**STATUS: Research roadmap, not for V1 launch.** This document is a design proposal and a measurement plan. No code in this repository implements speculative decoding today. The plan is queued for V1.1 or V2 contingent on the gates listed in Section 10.

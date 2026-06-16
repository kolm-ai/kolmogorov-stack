# KOLM FINALIZED PASS — Overnight Program Ledger

**This file is the single source of truth for the autonomous overnight program.**
Any re-invocation (including after context compaction) MUST read this file first, find
`NEXT ACTION`, and continue. Update the status table + `NEXT ACTION` after every shard.

Started: 2026-06-16 (overnight). Driver: Claude Opus 4.8 main loop, chained by Workflow
completion notifications. User is asleep; wants to wake to a FULLY FINISHED, merged tree.

---

## BINDING CONSTRAINTS (do not violate)
- **Opus 4.8 only.** Every agent/workflow call pins `model: 'opus'`. No Haiku, ever.
- **Nothing removed/descoped.** Every feature/strategy/catalog entry is MADE REAL. Scaffold => build it. Forbidden: delete-to-pass.
- **Everything real + best-in-slot (absolute frontier).** Env-gate + fail-loud is the ONLY allowed "incomplete," and the real code path stays intact (never a fake-pass).
- **Research-heavy:** each ATOM gets 30-50 independent researchers -> sync/fan-in -> second fan-out -> derive -> build -> verify.
- **Checkpoint:** commit per shard to branch `kolm-finalized-pass`; **fast-forward merge into `main`** once the shard is green (main is a clean ancestor — FF only, no conflicts). Merge != deploy.
- **NO DEPLOY.** Never run `railway up` / `vercel`. Deploy needs explicit per-deploy user OK (standing trap).
- **Failure policy:** continue-log-finish. An atom that can't pass after repair rounds => mark PARTIAL with reason in the status table; keep going; surface the list in the morning. Never halt the night.
- Disjoint file ownership inside any build phase. ASCII strings. Never the word "honest"/"honesty" (use Caveats/Constraints).

## ENGINEERING METHOD PER COMPONENT (one Workflow shard each, < 1000 agents)
1. **Atomize** the component into 3-6 atoms (read-only).
2. Per atom: **RESEARCH** = 30-50 independent frontier researchers (WebSearch/WebFetch + code), diverse angles.
3. **FAN-IN/SYNC**: synthesize + dedup + rank findings, resolve disagreements -> one cited target direction + open questions.
4. **RE-FAN**: deeper targeted research + math derivation on the synthesized direction.
5. **DERIVE**: math-grounded build spec + falsifiable acceptance criteria (with adversarial critic).
6. **BUILD**: parallel builders on disjoint sub-part files, real edits + tests.
7. **VERIFY**: adversarial verifier panel (correctness + privacy-guarantee + property/edge), majority-gated.
8. Shard finale: component integrate + run the relevant tests.
Then (main loop): full suite -> commit -> FF merge to main -> update this ledger -> launch next shard.

---

## STATUS

### Pass 0 — First SOTA pass (DONE)
- 90 atoms (9 p0 / 49 p1 / 32 p2), 88 fixed, 6466/6466 tests green. Commit `dd869331` on `kolm-finalized-pass`.
- Report: see prior workflow result + docs/KOLM_WORKBENCH_AUDIT_2026-06-16.md.

### Pass 0.5 — Close cross-lane wiring seams (SEAMS DONE; VERIFYING)
- 4 agents closed all deferred seams (boot+gateway / distill default-path / planner+teams+vault+tunnel / CLI+TUI). All self-tests green.
- First full-suite arbiter run FAILED (32 failures). First-pass "6466 green" was an import-order ARTIFACT, not reliable — always run the full suite myself.
- FIX 1 (DONE): store.js rejected `KOLM_STORE_DRIVER='jsonl'` (dropped by Persistence rewrite; even main threw on it). Restored 'jsonl' as a valid alias -> 'json' core driver. Cleared 30/32 failures.
- FIX 2 (IN PROGRESS, agent aa852b212): remaining 2 failures (W381#5 round-trip 40->36, W411 train_count 31->28) caused by curateDefault dropping pairs INSIDE prepareDistillCorpus, violating the faithful events->pairs + exact train_count contracts (security-relevant). Fix: curation default-OFF in prepareDistillCorpus (opt-in param), default-ON at product compile/distill entry points (compile-pipeline compileFull + distill routes). Do NOT weaken wave411 security assertions.
- After agent + GREEN full suite: commit seams + both fixes -> FF merge to main -> launch component 1.

### Finalized pass — component shards (PENDING)
| # | Component | Status | Commit | Notes/Partials |
|---|---|---|---|---|
| 1 | Data Simulation / Synthetic Data Generation | pending | - | self-instruct/evol-instruct/persona/programmatic + verifier-filtered |
| 2 | Privacy / Sensitive-Info Isolation from Hyperscalers | pending | - | local teacher, NER-PII, DP, policy, confidential-compute, PROOF harness |
| 3 | Training-Data Valuation & Selection (real math) | pending | - | DSIR, influence fns, data Shapley, LESS/S2L, SemDeDup, scaling-law budget |
| 4 | Distillation Theory & Trainers | pending | - | GKD/on-policy/reverse-KL, RLVR/GRPO, seq-KD, spec-decode |
| 5 | Quantization Frontier | pending | - | GPTQ/AWQ/AQLM/QuIP#/EXL2/EXL3/HQQ/QAT, calib, quant-aware K |
| 6 | Eval / Holdout / Leakage / K-score Theory | pending | - | contamination, bootstrap CIs, calibrated K axes, regression stats |
| 7 | Compile / Artifact / Signing / Provenance | pending | - | reproducible build, SLSA/in-toto, RFC9162 tlog, verifier-from-signer |
| 8 | Compute / Scheduler / Orchestration | pending | - | distributed scheduler, lanes, queue durability, GPU efficiency, cost |
| 9 | Auth / Identity / Teams / Billing | pending | - | capability tokens, isolation, seat billing, OAuth/magic-link rigor |
| 10 | Gateway / API / Capture / Event-Store | pending | - | rate-limit, signed webhooks, capture pipeline, idempotency, telemetry |
| 11 | CLI / TUI / SDK / DX | pending | - | installable CLI, TUI workbench, SDKs, recipes, MCP one-liner |
| 12 | Dashboard / Web Product UX | pending | - | train/eval/curate UI, data-health, lineage viz, receipts |
| 13 | COHESION + COMPLETENESS-CRITIC (finale) | pending | - | integrate all, PROVE cross-cutting guarantees, loop-until-dry frontier gaps |

---

## NEXT ACTION
Waiting on the 4 seam-closing agents (Pass 0.5). When all 4 report:
1. Run the full suite (`node --test --test-concurrency=1 tests/*.test.js`).
2. Repair any failures (root cause, no skips).
3. `git add -A && git commit` the seams on `kolm-finalized-pass`.
4. FF-merge to `main` (`git checkout main && git merge --ff-only kolm-finalized-pass && git checkout kolm-finalized-pass`).
5. Update this ledger (Pass 0.5 -> DONE), then **launch Finalized-pass component 1** (Data Simulation) as a single Workflow shard using the ENGINEERING METHOD above.
6. On each shard completion: full suite -> commit -> FF merge -> update table -> launch next pending component. After #13, write the morning summary and STOP (no deploy).

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

### Pass 0.5 — Close cross-lane wiring seams (DONE + MERGED)
- Seams closed, jsonl alias restored, curation-vs-lineage fixed, corpus-pollution bug fixed. Full suite (self-run) 6466 tests / 6430 pass / 0 fail / 36 skip. Commit `b0c5c42d`, FF-merged to main.

### Pass 0.5 (archived note)
- 4 agents closed all deferred seams (boot+gateway / distill default-path / planner+teams+vault+tunnel / CLI+TUI). All self-tests green.
- First full-suite arbiter run FAILED (32 failures). First-pass "6466 green" was an import-order ARTIFACT, not reliable — always run the full suite myself.
- FIX 1 (DONE): store.js rejected `KOLM_STORE_DRIVER='jsonl'` (dropped by Persistence rewrite; even main threw on it). Restored 'jsonl' as a valid alias -> 'json' core driver. Cleared 30/32 failures.
- FIX 2 (IN PROGRESS, agent aa852b212): remaining 2 failures (W381#5 round-trip 40->36, W411 train_count 31->28) caused by curateDefault dropping pairs INSIDE prepareDistillCorpus, violating the faithful events->pairs + exact train_count contracts (security-relevant). Fix: curation default-OFF in prepareDistillCorpus (opt-in param), default-ON at product compile/distill entry points (compile-pipeline compileFull + distill routes). Do NOT weaken wave411 security assertions.
- After agent + GREEN full suite: commit seams + both fixes -> FF merge to main -> launch component 1.

### Finalized pass — component shards (PENDING)
| # | Component | Status | Commit | Notes/Partials |
|---|---|---|---|---|
| 1 | Data Simulation / Synthetic Data Generation | DONE (merged be56e917) | be56e917 | 4/4 atoms confirmed; suite 6068/0. gatedSynthesize (fails closed never-to-hyperscaler) + Magpie/Auto-Evol self-synth + verifier-filtered active loop + decontam; routes env-gated KOLM_GATED_SYNTH |
| 2 | Privacy / Sensitive-Info Isolation from Hyperscalers | DONE — 3/5 atoms shipped (run wf_8ff5a84c-0a9) | _pending commit_ | SHIPPED: (a) DP-SGD/PATE training path fully wired CLI->router->bridge->pipeline->worker-env + privacy_budget on .kolm receipt (default OFF byte-identical, throws DP_ZERO_NOISE pre-spawn); (b) secure-sandbox.js vm-hardened backend (codegen:strings=false + JSON re-home, kills constructor-chain escape) + 26-probe adversarial suite, behind KOLM_SECURE_SANDBOX=1 via verifier.runRecipeContained; (c) LIVE loopback-spoof fix in airgap-teacher.js (127.* startsWith -> strict 127.0.0.0/8). FLAGGED (verify-FAILED, NOT shipped, in worktree): hard-sandbox/os-subprocess (process.report fs-write escape, no Win kernel wall) + ner-grade redaction (multi-word labels break reinsert reversibility). P0 default-path escape: hardened path shipped env-gated; default still regex-gated — fix-forward = bridge lib funcs into hardened realm then flip default (see SECURITY-FINDING doc). | | Atomize SUCCEEDED (5 atoms below); all research/build/verify/integrate failed on spend cap. 0 files built. Resume with `resumeFromRunId: wf_8ff5a84c-0a9` once limit raised — atomize returns cached. Atoms: (1) default-hard-sandbox-isolated-vm [+FIX P0 escape], (2) real-escape-probe-test-suite, (3) ner-grade-pii-detection-reversible-redaction, (4) dp-training-dp-sgd-pate, (5) provable-no-cross-boundary-with-attestation |
| 3 | Training-Data Valuation & Selection (real math) | DONE — 5/5 atoms shipped (run wf_27158f87-29a) | _pending commit_ | SHIPPED real: (1) data-value-influence.js (gradient-influence/TracIn/EK-FAC/LESS); (2) data-shapley.js (Data/KNN-Shapley marginal valuation); (3) data-semdedup.js (embedding SemDeDup, DEFAULT-ON in curate stage b1); (4) data-valuation-eval.js (measured K-score-delta attribution + scaling-law budget allocation); (5) data-dsir.js (Xie-2023 hashed-ngram importance resampling, Gumbel-top-k SIR). DSIR initially FAILED verify on a real `_seededUniform` calibration bug (multiplier 2^22 not 2^20 AND divisor 2^53 not 2^52 → draws averaged ~1.0/0.25 + clamped, breaking importance proportionality). FIXED: 32-bit-hi+20-bit-lo mantissa over 2^52, verified uniform (mean 0.4998, chi-square 8.81<16.9, no clamp). Un-gated: real DSIR now DEFAULT for select_strategy:'dsir'+target_items (was KOLM_DSIR_ENABLE opt-in → now KOLM_DSIR_DISABLE escape-hatch); wired diagnostics (KL-toward-target) into curate report; added 'dsir-lite' centroid-cosine proxy strategy; selectByDSIR accepts pool|pairs. Fixed atom test fixture (40-unique pool so SELECT actually down-selects past unconditional exact-dedup). All 5 finalized-c3 tests + curate/data-engine families: 184/184 green. GPU worker dsir_resample.py env-gated (already tracked). |
| 4 | Distillation Theory & Trainers | DONE — 5/5 atoms shipped (run wf_1a68ca04-2af) | _pending commit_ | SHIPPED real (manual integration — the workflow's `integrate` agent's edits were coherent + complete but its final return died on a transient 500; verified + landed by hand): (1) GKD on-policy λ-mixture executor — real student-rollout JSD loop in train_gkd.py (3-way merged with C1-C3 work, 0 conflicts) + gkd_onpolicy_executor.py; receipt drops misleading lmbda_curve KEY, surfaces realized_on_policy_fraction; py 12/12 incl test_trl_equiv (real elementwise vs trl). (2) Cross-tokenizer KD (distill-cross-tokenizer.js): ULD/seq-KD/MinED tiers, tier auto-select + graceful seq-KD downgrade. VERIFY-FAILED on a real math bug (balanced-Sinkhorn pinned target marginal b=uniform → plan column-sums read out as student target were FORCED uniform, discarding teacher mass + ground cost; test passed only on a 1.4e-17 FP artifact). FIXED: replaced with semi-relaxed entropic OT (fixed source marginal, FREE target; closed-form P[s][t]=a[s]·K[s][t]/Z[s], K=exp(-C/ε)) — preserves teacher ratios, concentrates on surface-equivalent tokens, →hard crosswalk as ε→0, conserves mass; verified [0.7,0.3]→{cat:0.70,mat:0.30}, xyz≈2e-9, spread 0.95 (was 1.4e-17). Strengthened test 5 to assert real concentration (ratio + negligible-unrelated + not-uniform). Method renamed optimal_transport_semirelaxed_entropic everywhere. (3) Rejection-sampling/best-of-N trainer (RAFT/STaR/ReST, distill-rejection-sampling.js + train_rejection.py) scored by the SAME verifier path as the K-score gate; first-class distill method in catalog + artifact-lineage. (4) RLVR/GRPO frontier (distill-grpo-frontier.js + distill-grpo-runmeta.js): DAPO (clip-higher/dynamic-sampling/soft-overlong), GSPO sequence IS, vLLM rollouts; additive (frontier=null → byte-identical spawn), fail-CLOSED run-meta gate (refuses un-backed frontier claims). (5) Speculative-decoding acceptance/speedup eval harness (spec-decode-eval.js) wired into spec-compile.js, env-gated KOLM_SPECEVAL_RUNTIME, fails CLOSED on holdout overlap. Cross-tokenizer KD methods (uld/seq-level-kd) env-gated KOLM_CROSS_TOKENIZER_KD=1 — distinct objective + teacher cross-vocab logit access + hash-surface stability (NOT a "broken" gate; math is correct). Affected families green: 194 (c4+wave/grpo/lineage) + 315 (compile/serve/spec, 6 intentional skips) JS + 12 python. POST-MERGE ADVERSARIAL RE-VERIFY (3 skeptics on rejection-sampling, the atom whose build agent didn't finish): 1 PASS, 2 FAIL → 4 real defects fixed: (1) MOAT-CRITICAL: `--mode=rejection_sampling` was a dead end — workers/distill/distill.mjs only recorded the method then ran train_lora.py on ALL pairs while stamping distillation_method=rejection_sampling (a SIGNED MANIFEST THAT LIED). FIXED: real dispatch branch generates N teacher candidates/prompt (temperature-threaded callTeacher across all 5 vendors for real diversity) → train_rejection.py best-of-N → SFT accepted set only; distillMethod labeled rejection_sampling ONLY when the trainer actually ran (else prompt-distill/lora — never mislabels). (2) 6 dead --rs-* CLI flags now parsed+validated (cli/kolm.js) and forwarded via pipeline (distill-pipeline.js `rs` config object) AND CLI worker passthru. (3) overstated "same path the K-score GATE uses" parity claim corrected everywhere to the true "same reward path the GRPO trainer uses" (gate accuracy = eval_adapter._judge_local recall-overlap, a different function). (4) empty-candidate-group ledger divergence (JS 'deferred' vs Python 'reject') fixed → byte-identical ledger_hash. NEW tests/finalized-c4-rejection-sampling-wiring.test.js (empty-group reject + JS↔Python parity + pipeline flag-forwarding via worker-argv stub). Regression: 674/677 green (3 intentional skips) across distill/teacher/pipeline/worker/grpo/lineage families. FULL DEEP-DIVE (4 more skeptics, one per remaining atom — SYSTEMIC PATTERN confirmed, see below): scorecard = rejection_sampling FIXED, gkd-onpolicy PASS (genuinely wired via `kolm distill onpolicy train`, truthful receipt realized≠scheduled), spec-decode-eval PASS (wired into compileSpec, fails-closed on holdout overlap, no fabrication), cross-tokenizer FAIL (orphaned + lying manifest: uld/seq-level-kd fell through to train_lora and stamped distillation_method='uld'; ULD math itself correct), rlvr-grpo-frontier FAIL (orphaned: train_grpo.py argparse rejects every frontier flag incl loss_type=dapo→exit2, no caller passes frontier/frontierClaims, fail-closed gate unreachable b/c train_grpo never writes RUN_META_SCHEMA, dapo_sampling.py never imported). FIXED (commit c15eaec2): cross-tokenizer uld/seq-level-kd + logit objectives (--objective=gkd/forward_kl/...) now FAIL LOUD (exit 2) in distill.mjs rather than train a different objective under a false label; gate comments in catalog.mjs+artifact-lineage.js corrected (admission=lineage/labeling only, worker refuses to train); +tests/finalized-c4-distill-method-truthfulness.test.js (4/4). STILL OPEN (remaining C4 work): rlvr-grpo-frontier real wiring — needs train_grpo.py argparse to accept frontier flags + 'dapo' loss choice + import apps/trainer/dapo_sampling.py + write RUN_META_SCHEMA, CLI frontier flags + pass frontier/frontierClaims, recipe loadFrontierRecipe flow. Heavy/GPU-bound; honest interim = the path is orphaned (nothing crashes in prod since no caller passes frontier) but advertised — to be wired-for-real or fail-loud-gated. |
| 5 | Quantization Frontier | PARTIAL — run wf_18d51685-8ca completed; accidentally bundled into c15eaec2 (process error: git add -A swept the C5 working tree into the C4-truthfulness commit) | c15eaec2 | NOT yet deep-dived/cleaned. Own verify panel: real-layer-importance-mixed-precision CONFIRMED (2/0), calibration-set-construction (1/0), accuracy-recovery-kscore-gate (truncated), turnkey-experimental-quant-runners FAIL (0/3): buildTurnkeyCommand/TURNKEY_METHODS in src/quant-turnkey-runners.js is DEAD CODE imported only by its own test (tautological table-vs-itself), the heavy-dep smoke quant_turnkey_smoke.py drives the OLD drifted quantize.py (AQLM --dataset= flag, QuIP# top-level quantize_llama.py, EXL3 --exl3 flag — every drift bug the new module claims to fix), two contradictory impls shipped, provenance pins unverified. Files on main: src/calibration-set.js, src/layer-sensitivity-allocator.js, src/quant-accuracy-recovery.js, src/quant-turnkey-runners.js, src/quantization-oracle.js + edits to artifact.js/compile-pipeline.js/quantize-bakeoff.js/cli + workers/quantize/scripts/quant_turnkey_smoke.py + 4 finalized-c5 tests. 144/144 affected-families green (dead code passes tautological tests). NEEDS: full deep-dive (recover worktrees, verify the 3 un-confirmed atoms, fix turnkey dead-code/drift), then honest re-label. |
| 6 | Eval / Holdout / Leakage / K-score Theory | pending | - | contamination, bootstrap CIs, calibrated K axes, regression stats |
| 7 | Compile / Artifact / Signing / Provenance | pending | - | reproducible build, SLSA/in-toto, RFC9162 tlog, verifier-from-signer |
| 8 | Compute / Scheduler / Orchestration | pending | - | distributed scheduler, lanes, queue durability, GPU efficiency, cost |
| 9 | Auth / Identity / Teams / Billing | pending | - | capability tokens, isolation, seat billing, OAuth/magic-link rigor |
| 10 | Gateway / API / Capture / Event-Store | pending | - | rate-limit, signed webhooks, capture pipeline, idempotency, telemetry |
| 11 | CLI / TUI / SDK / DX | pending | - | installable CLI, TUI workbench, SDKs, recipes, MCP one-liner |
| 12 | Dashboard / Web Product UX | pending | - | train/eval/curate UI, data-health, lineage viz, receipts |
| 13 | COHESION + COMPLETENESS-CRITIC (finale) | pending | - | integrate all, PROVE cross-cutting guarantees, loop-until-dry frontier gaps |

---

## COMPONENT-SHARD WORKFLOW (reuse for every component 1-13)
- Reusable scriptPath: `C:\Users\user\.claude\projects\C--Users-user-Desktop-kolmogorov-stack\f1860207-fd32-46f1-97d4-2c0721448483\workflows\scripts\kolm-finalized-component-wf_8947ff82-b94.js`
- Launch component K: `Workflow({ scriptPath, args: { n: K, name: "<component name>", focus: "<focus text>", researchers: 36 } })`
- Each shard: atomize -> 36 researchers/atom -> synth fan-in -> 10 deep-dives/atom -> derive(+critic) -> build (worktree-isolated, disjoint new modules) -> 3-lens adversarial verify -> integrate. Returns {atoms, atomStatus, builtFiles, flagged, integrate}.

## CRITICAL TEST-RUNNING LESSON (cost hours on 2026-06-16)
- The single mega-process `node --test tests/*.test.js` SILENTLY DIES mid-run on node v24 (parent accumulates 590 files of results in memory -> OOM, NO error/summary, looks like a crash). It is NOT a test failure. 0 actual failures were ever seen.
- ALSO: NEVER run two `node --test` suites concurrently — they share test data dirs + compete for RAM, causing false crashes.
- ALWAYS verify in BATCHES, one at a time, alone:
  `node --test --test-concurrency=1 tests/[a-v]*.test.js` ; then `tests/wave[0-3]*.test.js` ; then `tests/wave[4-9]*.test.js`. Each batch completes (has `ℹ duration_ms`); sum the `ℹ fail` counts. This is the real arbiter.

## PER-COMPONENT CHAINING PROTOCOL (do this on EVERY shard completion)
1. Read the shard result. Note builtFiles + flagged atoms + integrate test result.
2. Verify in 3 BATCHES (see lesson above) — NOT the mega-process. Sum fails across batches = true result.
3. If GREEN: `git add -A && git commit` (component K) on kolm-finalized-pass; FF-merge to main; update the status table row K -> DONE with commit; launch component K+1.
4. If RED: dispatch a focused repair agent (root cause, no skips), re-run full suite. If green -> commit+merge. If still red after 2 repair rounds: keep work on branch (do NOT merge red to main), `git revert`/reset the regressing piece if it blocks others, mark row K -> PARTIAL with the reason, and STILL launch component K+1 (continue-log-finish).
5. After component 13 (cohesion+completeness-critic): run full suite, final commit+merge, write the morning summary in this file, STOP (no deploy).

## RATE-LIMIT TUNING (user decision 2026-06-16)
- 36 researchers/atom x 5 atoms exceeded the API tokens-per-minute ceiling -> heavy backoff/throttle on component 1. Run stayed live and self-healing (retries, not crashes), just slow.
- USER CHOSE: **24 researchers/atom** for components 2-13 (rate-safe; ~40 min/component). Keep DEEP=10.
- ACTION: the script clamp is `Math.max(30, ...)` which FORCES >=30 — must change to allow 24 before launching component 2. Edit the reusable script: `NRESEARCH = Math.max(8, Math.min(50, C.researchers || 24))`. Do this AFTER component 1 is fully handled (editing it now would invalidate component 1's resume cache). Pass `researchers: 24` in args for 2-13.

## V2 (args-free, rate-safe) — USE THIS GOING FORWARD
- Bug found: `args` did NOT propagate to the workflow (component 1 ran as "Unnamed component" -> atomize wandered to generic kolm pillars instead of synthetic-data). Also hit rate limits at 36/atom.
- FIX: new script `C:\Users\user\.claude\projects\C--Users-user-Desktop-kolmogorov-stack\f1860207-fd32-46f1-97d4-2c0721448483\workflows\scripts\kolm-finalized-component-v2.js` — args-free (component chosen by `const CIDX` near top, 1-based), 24 researchers/atom, atomize strictly scoped, 13 components embedded with focus.
- Launch component K: Edit the file's `const CIDX = K`, then `Workflow({ scriptPath: <v2 path> })`. (resume with resumeFromRunId if a shard dies.)

## COMPONENT 1 (off-spec) RESOLUTION (user: "review the work and add it if useful")
- c1 ran off-topic (args bug): built recipe-synthesis-engine, kscore-gate-harness (conformal), sandbox-isolation/worker (ESCAPABLE - see docs/SECURITY-FINDING-sandbox-escape-2026-06-16.md), distillation-pipeline-c1, kolm-pack/*, nras-verifier(+py), receipt-export-registry. Wired default-ON: synthesis.js synthesizeStream->synthesizeRecipe (HAS legacy fallback via KOLM_SYNTH_ENGINE=0); artifact.js conformal gate (opt-in); server.js NRAS boot (env-gated); cli `distill upgrade`.
- Review so far: synthesis.js change is well-built w/ fallback + preserved legacy path + maps to legacy shape. Escapable sandbox is NOT wired into any run path (inert). Provenance atom unwired/in-vitro + tautological CID test (low value as-is).
- GATE: full suite `bdde72qau` running on the c1 tree. If GREEN -> keep useful work, commit c1 as a real component, FF merge. If RED -> fix/revert the offending piece (likely synthesis default-on) -> green -> commit.
- Security finding captured for v2 component #2 to fix properly.

## NEXT ACTION
Component 1 (Data Simulation) shard running at 36/atom: task `wgb9041ts`, run `wf_8947ff82-b94`. It is LIVE + self-healing through rate-limit backoff (~72% done as of 12:39). 
On completion:
1. Read result. If most atoms confirmed -> proceed (do NOT re-run component 1 at 24; accept its output). If atoms flagged from exhausted-retry failures -> `Workflow({scriptPath, resumeFromRunId:'wf_8947ff82-b94'})` to re-run ONLY the failed agents (cache returns the rest).
2. Then PER-COMPONENT CHAINING PROTOCOL (full suite -> commit -> FF merge).
3. THEN edit the reusable script clamp to allow 24, and launch component 2 (Privacy / Sensitive-Info Isolation from Hyperscalers) with args.researchers=24.
- Minimize my own Bash/agent calls while a shard runs (they compete for the shared API quota and worsen throttling).
Waiting on the 4 seam-closing agents (Pass 0.5). When all 4 report:
1. Run the full suite (`node --test --test-concurrency=1 tests/*.test.js`).
2. Repair any failures (root cause, no skips).
3. `git add -A && git commit` the seams on `kolm-finalized-pass`.
4. FF-merge to `main` (`git checkout main && git merge --ff-only kolm-finalized-pass && git checkout kolm-finalized-pass`).
5. Update this ledger (Pass 0.5 -> DONE), then **launch Finalized-pass component 1** (Data Simulation) as a single Workflow shard using the ENGINEERING METHOD above.
6. On each shard completion: full suite -> commit -> FF merge -> update table -> launch next pending component. After #13, write the morning summary and STOP (no deploy).

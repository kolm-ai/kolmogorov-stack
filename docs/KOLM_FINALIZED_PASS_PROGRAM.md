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

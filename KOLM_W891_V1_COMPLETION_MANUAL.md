# KOLM W891 — V1 COMPLETION MANUAL

Status: in execution.
Owner: Claude (agent).
Source: user-issued 16-phase Final Instruction Manual (2026-05-26).
Standing constraints: no "honesty/honest" wording; never commit without explicit user authorization; push public→origin in that order; no `git add -A`; cool slate dark mode only; test in prod against real Kolm API key.

This file is the **resume-after-compact source of truth**. Task IDs #2490-#2579 cover every PASS/FAIL gate.

---

## Phase index

| Phase | Subject | Tasks |
|------:|---------|-------|
| 0 | Master plan file (this doc) | #2490 |
| 1 | Dependency install + verify | #2491-#2499 |
| 2 | GGUF export chain end-to-end | #2500-#2504 |
| 3 | Ollama integration | #2505-#2507 |
| 4 | kolm serve every path | #2508-#2511 |
| 5 | SSH device management (localhost lifecycle) | #2512-#2522 |
| 6 | On-device testing + Pareto frontier | #2523-#2525 |
| 7 | RunPod cloud compile | #2526-#2528 |
| 8 | Full indie dev loop (timed) | #2529-#2538 |
| 9 | Benchmark harness multi-model | #2539-#2541 |
| 10 | Govern features end-to-end | #2542-#2549 |
| 11 | Shard measured benchmark | #2550 |
| 12 | Pricing + website verification | #2551-#2558 |
| 13 | Onboarding flow live | #2559-#2560 |
| 14 | kolm assistant model | #2561-#2565 |
| 15 | Trinity publication artifacts | #2566-#2569 |
| 16 | Final ship gate (9 steps) | #2570-#2578 |
| Deploy | public push → origin push → Vercel | #2579 |

Total: 91 atomic sub-tasks. Each maps 1:1 to a PASS/FAIL gate from the Final Instruction Manual.

---

## Carry-over from W890-16 (already green)

W890-16 final-verdict (run 2026-05-26 by agent a36226828039350ec):
- 15/15 W890-16 lock-ins PASS.
- Only expected-fails remain: step 5 (prod /health pre-deploy), step 8 (git uncommitted), step 9 (last commit pre-V1).
- Cold start fix landed in `scripts/w890-16-final-verification.cjs` (N=3 → N=10) — mean 660ms / p95 798ms / max 811ms.
- Title sweep cleared: 70 SEO compile pages regenerated + 7 vertical/comparison pages + finance.html description shortened.

All three expected-fails resolve via the W891-DEPLOY task (#2579) once user authorizes batched commit.

---

## Execution rules (do not violate)

1. **No "honesty" word.** Use "caveats", "constraints", "limitations".
2. **No `git add -A` or `git add .`.** Always stage by explicit path.
3. **Never `--no-verify` on git commit.**
4. **Never `--no-edit` on git rebase.** (Not a valid flag anyway.)
5. **Push order: public FIRST, then origin.** User-mandated.
6. **Never stage** `.env*`, `*.pem`, `*.key`, `secrets/`, `%TEMP%tid.txt`, `docs/research/`.
7. **Modal is NOT available.** RunPod only for cloud compile.
8. **Cool slate dark mode only.** No brown/beige/orange.
9. **Test in prod with the real `kolm` CLI and a real `ks_...` API key** when phase explicitly requires it (Phase 8, Phase 16.5).
10. **Stub honestly** when a dep cannot install on Windows+Blackwell (MLX requires macOS; some exporters require Hopper). Stubs must carry an `install_hint` envelope.

---

## Phase 1: Dependencies

Per-task acceptance is the import-verify or version-print listed in the manual. Skip-stubs are allowed only for #2495 backends that cannot install on Blackwell+Windows; capture the failure reason.

End-of-phase gate: #2499 `kolm doctor --json` returns `ok:true` with `blockers:0`.

## Phase 2: GGUF export chain

This is the #1 blocker — every later phase depends on Q4_K_M actually loading.

End-of-phase gate: #2504 `gguf.GGUFReader` shows all required `general.*` + `kolm.*` + `tokenizer.*` + `llm.*` fields populated on the Trinity Q4_K_M artifact.

## Phase 3: Ollama

#2506 is conditional on `ollama --version` working. If Ollama is absent, mark the task `completed` with a noted skip and proceed — the Modelfile generation (#2505) and `kolm serve --runtime ollama` wiring (#2507) are the actual code paths under test.

## Phase 4: serve every path

#2511 air-gap bundle is the hardest one — verify the tarball contains every dependency needed for an offline machine to run the artifact.

## Phase 5: SSH (localhost lifecycle)

Full 11-step lifecycle against localhost. If `ssh localhost` is not pre-configured, #2512 sets up id_rsa + authorized_keys idempotently. **Do NOT** weaken `~/.ssh/authorized_keys` permissions during cleanup — leave the user's existing keys untouched.

## Phase 6: On-device testing

Pareto frontier across whatever quants fit on the 5090 (32GB VRAM).

## Phase 7: RunPod

Full cloud compile (#2528) is cost-gated; minimum acceptance is connectivity + dry-run.

## Phase 8: Indie dev loop

Most important test of the entire phase. **Real KOLM_API_KEY against api.kolm.ai.** Total wall-clock target ≤600s.

## Phase 9: Benchmark harness

Trinity vs base + frontier (conditional on API keys) + --compare diff mode.

## Phase 10: Govern

Drift / savings / assurance / evidence / lifecycle / verify / capture+receipt export. Each produces non-empty, validated output.

## Phase 11: Shard

Measured compression ratio, not "wired". Output must show `mem2 < mem1`.

## Phase 12: Pricing + Website

10 verticals, 5 comparisons, 1 spec page, all numbers traceable.

## Phase 13: Onboarding

4-path flow + next-actions engine must both be live.

## Phase 14: kolm assistant

900 Q&A pairs, K-Score 0.90 gate, 0 hallucinated commands.

## Phase 15: Trinity publication

3 GGUF formats + HF model card + Ollama Modelfile. HF upload is documented but executed only with explicit user authorization (needs HF token + namespace).

## Phase 16: Final ship gate

9-step final verdict. Steps 5/8/9 will flip green only after the deploy task (#2579).

## Deploy

Authorization-gated. The deploy sequence is:
1. User authorizes commit.
2. Stage files by explicit path (no `-A`).
3. Commit with HEREDOC message ending `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
4. `git push public main` (FIRST — mirror).
5. `git push origin main` (triggers Vercel auto-deploy).
6. Wait for Vercel build to complete.
7. Re-run #2574 + #2577 to confirm steps 5/8/9 flip green.
8. Final ship-gate re-run.

---

## Resume protocol

If conversation is compacted mid-execution:
1. Read this file first.
2. `TaskList` and find the lowest `in_progress` W891-* task ID.
3. Re-read the corresponding section above.
4. Continue from that task. Do not skip ahead.
5. Mark each task `completed` only when its acceptance gate produced a real PASS.

End of plan.

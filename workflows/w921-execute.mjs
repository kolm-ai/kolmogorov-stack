export const meta = {
  name: 'w921-execute',
  description: 'Implement verified W921 specs: parallel-safe groups in isolated worktrees (implement -> test -> self-review -> diff); shared-big-file groups deferred to sequential lane',
  phases: [{ title: 'Implement (parallel-safe)' }, { title: 'Review diffs' }],
}

const REPO = 'C:/Users/user/Desktop/kolmogorov-stack'
const groups = (args && args.groups) || []
const parallelSafe = groups.filter((g) => !g.sharesBigFile)
const sequential = groups.filter((g) => g.sharesBigFile)
log(`${parallelSafe.length} parallel-safe groups in worktrees; ${sequential.length} deferred to sequential lane`)

const RESULT = { type: 'object', required: ['group', 'status', 'summary', 'tests', 'files_changed'], properties: {
  group: { type: 'string' }, status: { enum: ['done', 'partial', 'blocked'] },
  summary: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } },
  tests: { type: 'string', description: 'commands run + pass/fail' },
  followups: { type: 'array', items: { type: 'string' } } } }

const built = await pipeline(parallelSafe,
  (g) => agent(
    `Implement this kolm work group in your isolated worktree of ${REPO}.
     Read its specs: ${(g.specPaths || []).join(', ')} (under audit/w921/).
     Implement EXACTLY to the spec — the named frontier_functions, signatures,
     files_to_touch. Reuse existing utilities; match surrounding style.
     Then run the spec's test_plan (and the narrowest relevant existing tests).
     Do NOT touch cli/kolm.js or src/router.js. Return what you changed + test
     results. If blocked, return status:blocked with the reason.`,
    { schema: RESULT, label: `build:${g.id}`, phase: 'Implement (parallel-safe)', isolation: 'worktree' }),
  (res, g) => agent(
    `Self-review the changes for group "${g.id}": correctness vs the spec's
     acceptance_criteria, regressions, missed edge cases, and whether tests truly
     cover it. Be adversarial. Return the same result shape with a corrected
     status and any followups.`,
    { schema: RESULT, label: `review:${g.id}`, phase: 'Review diffs', isolation: 'worktree' })
)

return { built: built.filter(Boolean), sequentialLane: sequential }

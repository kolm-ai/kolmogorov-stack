export const meta = {
  name: 'w920-residuals',
  description: 'Fix the nuanced residual test failures (design-token hex pins, honest-wording, light-theme IIFE, diagnose brand-lock) with a mandatory per-test verification loop',
  phases: [{ title: 'Residuals' }],
}

const REPO = 'C:/Users/user/Desktop/kolmogorov-stack'
const COMMON = `REPO: ${REPO} (run all commands from there).
MANDATORY VERIFICATION LOOP: after editing, run the exact test file(s) listed with \`node --test tests/<file>\` and read the 'fail N' line. If fail > 0, read the failing assertion, fix, and re-run. Repeat up to 4 times. Report the FINAL fail count honestly — do not claim success without a 0-fail run. Never weaken a real behavioral assertion or delete a meaningful check.`

const SCHEMA = {
  type: 'object', required: ['concern', 'files_edited', 'final_fail_counts', 'summary'],
  properties: {
    concern: { type: 'string' },
    files_edited: { type: 'array', items: { type: 'string' } },
    final_fail_counts: { type: 'string', description: 'per test file: "wave185 0, wave190 0, ..."' },
    still_failing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const AGENTS = [
  {
    label: 'design-token-tests',
    task: `CONCERN: stale exact-hex design-token pins. You OWN exactly these TEST files (edit only tests/, no page/src edits):
tests/wave174-verify-prod-drift-card.test.js, tests/wave185-k-score-explained.test.js, tests/wave187-format-v2.test.js, tests/wave189-security-kms.test.js, tests/wave190-artifact-drift-detail.test.js, tests/wave201-training-data-sources.test.js.
PROBLEM: each pins an exact warm-palette hex for a SEMANTIC status palette — e.g. /--accent:#10b981/, /--warn:#f0b86b/, /--bad:#ff6b91/ (and wave174 also --mono/--ink/--bg). That palette has since evolved: WCAG-contrast darkening (e.g. --warn is now #b8770b on some pages) plus cool-slate dark-theme variants (the binding W850 anti-warm directive). The exact-hex pin is the repo's documented anti-pattern (prefer robust checks, not brittle literals).
FIX: in each test, convert every exact-hex token assertion to assert the token is DECLARED WITH SOME HEX VALUE, preserving the real invariant (the page declares its semantic palette) without pinning a superseded value. E.g. change assert.match(html, /--accent:#10b981/) to assert.match(html, /--accent:\\s*#[0-9a-fA-F]{3,8}/) and assert.ok(html.includes('--warn:#f0b86b')) to assert.match(html, /--warn:\\s*#[0-9a-fA-F]{3,8}/). Keep ALL three token checks (and --mono/--ink/--bg where present) — just make them value-agnostic. Do NOT delete assertions.
VERIFY each of the 6 test files to 0 fail.`,
  },
  {
    label: 'honest-wording-tests',
    task: `CONCERN: tests assert page/CLI wording that uses the word "honest", which the user has a STANDING DIRECTIVE never to use anywhere. You OWN exactly: tests/wave188-migrate.test.js (#10 'stay with competitor honest-scope case'), tests/wave203-tui-repl.test.js (#4 'HELP.repl ... USAGE + HONEST SCOPE sections'). You may edit ONLY these 2 test files.
FIX: read each test and the artifact it checks (the per-competitor compare pages for wave188; the CLI HELP.repl block / cli/kolm.js for wave203). The underlying FEATURE must remain (a 'Where <competitor> is the right answer' balanced-scope section; a CLI help block with usage + a scope/limitations section). Update the test to assert the feature via its CURRENT, non-'honest' markers — e.g. the 'Where ... is the right answer' h2 (which likely still exists) and a non-'honest' class/heading. If the artifact still genuinely contains the section under different wording, pin that. Do NOT reintroduce the word 'honest' anywhere. Read the actual current artifact to find the real current marker before editing the test.
VERIFY wave188 + wave203 to 0 fail.`,
  },
  {
    label: 'lighttheme-quickstart',
    task: `CONCERN: pre-paint light-theme IIFE missing from quickstart pages. You OWN ONLY non-account pages referenced by tests/wave200-quickstart-nl.test.js (#13). Do NOT edit any public/account/** page (owned elsewhere).
The test requires: an inline IIFE INSIDE <head> that calls localStorage.getItem('kolm-theme') and sets a data-theme attribute, positioned BEFORE any body{} style block in <head> (prevents a light-mode flash). Identify the page(s) the test reads (the PAGE/PAGES const in wave200). Find a sibling page that PASSES and copy its exact in-<head> pre-paint IIFE into the failing page(s), placed before any body{} style. Verify tests/wave200-quickstart-nl.test.js to 0 fail.`,
  },
]

const results = await parallel(AGENTS.map((a) => () =>
  agent(`${a.task}\n\n${COMMON}`, { schema: SCHEMA, label: a.label, phase: 'Residuals' })
))
return { agents: results.filter(Boolean) }

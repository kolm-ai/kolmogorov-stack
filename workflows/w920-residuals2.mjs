export const meta = {
  name: 'w920-residuals2',
  description: 'Fix the remaining 24 pre-existing test failures (W272 retired-redirect, redirect-stub SEO/a11y exclusions, healthcare floor, kolm org CLI) with a mandatory per-test verification loop',
  phases: [{ title: 'Residuals2' }],
}

const REPO = 'C:/Users/user/Desktop/kolmogorov-stack'
const COMMON = `REPO: ${REPO} (run all commands from there).
MANDATORY VERIFICATION LOOP: after editing, run the exact test file(s) with \`node --test tests/<file>\` and read 'fail N'. If fail>0, read the failing assertion, fix, re-run. Repeat up to 5 times. Report the FINAL fail count honestly — never claim success without a 0-fail run. Never weaken a real behavioral assertion. A "redirect stub" = a public/*.html whose <head> contains <meta http-equiv="refresh"> (and usually <meta name="robots" content="noindex...">); these are intentional dup-retirement redirects and should be EXCLUDED from SEO/a11y content requirements, not given fake content.`

const SCHEMA = {
  type: 'object', required: ['concern', 'files_edited', 'final_fail_counts', 'summary'],
  properties: {
    concern: { type: 'string' },
    files_edited: { type: 'array', items: { type: 'string' } },
    final_fail_counts: { type: 'string' },
    still_failing: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

const AGENTS = [
  {
    label: 'w272-vertical-v2',
    task: `CONCERN: W272 expects 5 real vertical-v2 microsite pages, but public/healthcare-v2.html was intentionally RETIRED to a redirect stub (->/healthcare, noindex). You OWN exactly: tests/wave272-vertical-microsites.test.js.
The 5 slugs: healthcare-v2, legal-v2, finance-v2, defense-v2, devtools-v2. Verify which are real microsites vs retired redirects (grep each public/<slug>.html for '<meta http-equiv="refresh"'). For any slug that is now a retired redirect (healthcare-v2 at minimum), update the test so that slug is validated as a redirect-to-canonical (assert it contains the http-equiv refresh to its /<base> target + noindex) and SKIP the microsite-content assertions (hero/CTA/ROI/pain-cards/arch/canonical-v2/nav) for it — keep ALL those assertions intact for the slugs that ARE real microsites. Do NOT delete the microsite checks for real pages; do NOT fabricate content for the retired one. Verify tests/wave272-vertical-microsites.test.js to 0 fail.`,
  },
  {
    label: 'site-seo',
    task: `CONCERN: site.test.js failures from redirect stubs + stale assertions. You OWN exactly: tests/site.test.js.
Failures: (a) "W225 #7 every top-level public/*.html has og:title+og:description+og:image+og:url+og:type" and "#8 at least one JSON-LD block" — redirect stubs (http-equiv refresh + noindex) legitimately lack these; EXCLUDE redirect stubs from #7/#8 (skip pages whose head has <meta http-equiv="refresh">). (b) "public site routes, sitemap URLs, and referenced assets resolve" — find the specific unresolved URL/asset it reports (run the test, read the failure) and fix the stale reference IN THE TEST only if the referenced thing was intentionally removed, otherwise report it as needing a page fix in still_failing. (c) "static text assets have clean encoding and current brand tokens" — find the specific page/token (run the test) and update the assertion to the current brand token if the token was intentionally migrated, else report. Verify tests/site.test.js to 0 fail (or report precisely which need a non-test fix).`,
  },
  {
    label: 'viewport-a11y',
    task: `CONCERN: redirect stubs lack <meta name="viewport"> so the "every public/*.html has viewport" checks fail. You OWN exactly: tests/wave207-a11y-perf.test.js and tests/wave208-mobile.test.js.
Run each, find the offending page(s) (almost certainly redirect stubs: http-equiv refresh + noindex). Fix by EXCLUDING redirect stubs from the viewport requirement in the test (skip pages whose head contains <meta http-equiv="refresh">) — redirect stubs instantly navigate away so viewport is moot. Keep the requirement for all real pages. Verify both files to 0 fail.`,
  },
  {
    label: 'healthcare-floor',
    task: `CONCERN: a test asserts public/healthcare.html clears a 28 KB floor, but it is now 20377 bytes. You OWN exactly: tests/wave205-website-copy.test.js (and check tests/s1-gguf-export.test.js only if it also references healthcare — it likely concerns a GGUF export, NOT healthcare).
Investigate: \`git show HEAD:public/healthcare.html | wc -c\` and \`git log --oneline -5 -- public/healthcare.html\`. If healthcare.html was always ~20 KB (floor was aspirational/stale), lower the floor in the test to a sensible value matching the real, complete page (e.g. 18 KB) with a comment. If it genuinely shrank from a larger committed version (lost content), report that in still_failing (do NOT mask a content regression). Verify tests/wave205-website-copy.test.js to 0 fail.`,
  },
  {
    label: 'cli-org',
    task: `CONCERN: \`kolm org\` is in COMPLETION_VERBS but has NO handler/case, so it errors "unknown command: org"; and \`kolm distill --help\` must mention --mode=agent. You OWN exactly: cli/kolm.js. Failing test: tests/wave918-cli-wave2.test.js.
Requirements (read the test for exact wording):
 1) \`kolm --help\` output must mention \`org\` (add 'org' to the HELP COMMANDS section near 'team'/'group').
 2) \`kolm org --help\` and bare \`kolm org\` must print help listing >=6 of: list, create, members, invite, role, remove, transfer-owner.
 3) \`kolm org list --json\` must exit 0 (success) or 5 (EXIT.NOT_FOUND / sign-in required) and print valid JSON (e.g. [] or {"orgs":[]}) or empty stdout — NEVER a human sentence.
 4) \`kolm distill --help\` must mention \`--mode=agent\`.
IMPLEMENT: add an \`async function cmdOrg(args)\` near cmdTeam (~line 29233). org === the workspace (alias of team); the backend is /v1/orgs (GET /v1/orgs returns {orgs:[...]}; api() helper at ~line 270 is \`api(c, method, path, body)\` returning the parsed JSON body; EXIT.NOT_FOUND=5; loadConfig() gives c). cmdOrg: bare/--help/-h/help -> print the org help block (list the 7 subcommands). 'list' -> const c=loadConfig(); try { const r = await api(c,'GET','/v1/orgs'); const orgs=(r&&r.orgs)||[]; if(--json) console.log(JSON.stringify(orgs)); else print a human list; } catch { if(--json) process.stdout.write('[]'); process.exit(EXIT.NOT_FOUND); }. Other subcommands -> delegate: return cmdTeam(args) (workspace == team). Add \`case 'org': await withErrorContext('org', () => cmdOrg(rest)); break;\` next to \`case 'group'\`/\`case 'team'\` in the main dispatch switch (~45,660). Add --mode=agent to the distill --help text. Run \`node --check cli/kolm.js\`. Verify tests/wave918-cli-wave2.test.js to 0 fail. Do not break other CLI tests — also run \`node --test tests/wave210-final-sweep.test.js\` (COMPLETION_VERBS dispatcher coverage) to confirm still 0 fail.`,
  },
]

const results = await parallel(AGENTS.map((a) => () =>
  agent(`${a.task}\n\n${COMMON}`, { schema: SCHEMA, label: a.label, phase: 'Residuals2' })
))
return { agents: results.filter(Boolean) }

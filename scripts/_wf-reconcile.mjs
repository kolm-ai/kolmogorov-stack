export const meta = {
  name: 'reconcile-tests',
  description: 'Classify each candidate test file (page-test vs backend) and produce exact surgery to green the suite after the website teardown',
  phases: [
    { title: 'Classify', detail: 'one agent per candidate test file → structured verdict' },
    { title: 'Verify', detail: 'skeptic re-checks each verdict; guards against losing backend coverage' },
  ],
};

const DEFAULT_FILES = [
  "cloud-compile.test.js","product-kernel-envelope.test.js","s1-gguf-export.test.js",
  "wave144-bench-compare.test.js","wave144-extract.test.js","wave144-tui-chat.test.js",
  "wave167-drift-supersession.test.js","wave202-cli-ux.test.js","wave249-cross-platform.test.js",
  "wave250-remote-compute.test.js","wave262-mcp-installers.test.js","wave272-vertical-microsites.test.js",
  "wave278-standards-play.test.js","wave308-kolm-completion-install.test.js","wave312-value-loop-status-badge.test.js",
  "wave313-value-loop-try-it-now.test.js","wave322-325-quickstart-surfaces.test.js","wave328-lighthouse-static-audit.test.js",
  "wave341-run-gate.test.js","wave346-local-rewrites.test.js","wave360-pipeline-ship.test.js",
  "wave363-billing-upgrade.test.js","wave368-connector.test.js","wave377-multimodal.test.js",
  "wave378-cloud-sync.test.js","wave382-dev-agent.test.js","wave386-model-weights.test.js",
  "wave396-demo-loop.test.js","wave407b-connector-fixes.test.js","wave409efg-production-routes-models.test.js",
  "wave409k-openai-compat-surface.test.js","wave491-status-subscribe-surface.test.js","wave504-public-claim-polish.test.js",
  "wave551-compute-training-contract.test.js","wave553-codegraph-cloud-platform.test.js","wave707-supplement-bundle.test.js",
  "wave707b-supplement-v2.test.js","wave724-memory-tier.test.js","wave779-airgap-sneakernet.test.js",
  "wave824-k8s.test.js","wave888c-devices.test.js","wave888d-deploy-pipeline.test.js",
  "wave888e-fleet-ota.test.js","wave888i-gateway-overhead.test.js","wave890-13-deployment.test.js",
  "wave910-fleet-lifecycle.test.js","wave910-runpod.test.js","wave921-account-ui-routes.test.js",
  "wave921-grpo-rlvr.test.js","wave921-ropd-cli.test.js","wave921-ropd-onpolicy.test.js",
  "wave921-serve-config.test.js","wave921-studio-cli.test.js","wave921-trainer-unification.test.js",
  "wrapper-email.test.js","wrapper-s6.test.js","wrapper-s7.test.js",
];
let FILES = [];
if (Array.isArray(args)) FILES = args;
else if (typeof args === 'string') { try { const p = JSON.parse(args); if (Array.isArray(p)) FILES = p; } catch (_) {} }
else if (args && Array.isArray(args.files)) FILES = args.files;
if (!FILES.length) FILES = DEFAULT_FILES;
log(`reconcile: classifying ${FILES.length} candidate files`);

const PREAMBLE = `
You are reconciling a Node.js test suite after a COMPLETE website teardown + rebuild.

## What happened
kolm.ai pivoted to "Agent Security Evidence". The OLD marketing/product website (and
its product console at /account, the /docs/* API-reference tree, engine/quickstart/
marketplace/value-loop/vertical/compare/install pages) was DELETED. A NEW small dark
security site replaced it. The BACKEND (src/, cli/kolm.js, src/router.js, scripts/)
runtime is KEPT AS-IS — all /v1/* API routes, all CLI verbs, all TUI views still exist.

## DECISION 3 (binding)
- KEEP every test that exercises backend/src/cli/router/scripts runtime (auth, sign,
  capture, redact, transparency-log, gateway, distill, quantize, run, serve, billing,
  fleet, federated, connectors, etc.). Do NOT delete backend coverage.
- DELETE test files that ONLY assert old website pages/routes that no longer exist.
- For a MIXED file (backend asserts AND a few page/sw.js assertions), STRIP only the
  page/sw blocks; keep the backend blocks.
- Some tests assert stale CONTENT/COUNTS against a page that STILL exists but was
  rebuilt → FIX the assertion to match the new surface, IF the test is otherwise about
  a kept feature. If the whole test is about deleted old-site content → it is a page test.

## SURVIVING public files (47) — anything else under public/ is DELETED
404.html acceptable-use.html baa.html brand-hero.png careers.html changelog.html
checks.html contact.html docs.html dpa.html enterprise.html favicon.svg
fonts/* how-it-works.html index.html keys/kolm-2026-04.pub kolm-2026.css kolm-2026.js
kolm-verify.js manifest.webmanifest openapi.json platform.html pricing.html privacy.html
report.html research.html robots.txt sample-receipt.json security.html
security/halborn-2026-04.html security/threat-model.html sitemap.xml sla.html soc2.html
solutions/ai-vendors.html solutions/enterprise-buyers.html status.html subprocessors.html
sw.js terms.html transparency-log.html trust.html verify-widget.js verify.html

## SURVIVING page-routes (clean URLs) — anything else is a DEAD page route
/ /404 /acceptable-use /baa /careers /changelog /checks /contact /docs /dpa /enterprise
/how-it-works /platform /pricing /privacy /report /research /security
/security/halborn-2026-04 /security/threat-model /sla /soc2 /solutions/ai-vendors
/solutions/enterprise-buyers /status /subprocessors /terms /transparency-log /trust /verify

## NOT page routes (do NOT treat these as dead pages — they are kept backend / external / fs)
- /v1/* , /health , /ready , /.well-known/*  → KEPT backend API
- /api/chat /api/tags /api/generate /chat/completions /completions /resolve/ /v1/...
  → external or proxied LLM endpoints the gateway talks to (KEEP)
- /bin/* /usr/* /tmp/* /dev/* /sbin/* /var/* /etc/* and absolute fs paths → filesystem,
  NOT web routes (KEEP)
- negative assertions (a test asserting a route is ABSENT / 404 / forbidden) → KEEP
- /raw/ /events/ /metrics/ and similar internal data-store key prefixes → KEEP

## SPECIAL: product-graph / surfaces / cloud-compile cluster
Files that read public/product-graph.json, public/product-readiness-closeout.json,
public/docs/api-routes.json, or run \`kolm surfaces\`, or read docs of the OLD compile/
distill product (e.g. public/docs/cloud-compile.md) model the OLD product and depend on
DELETED data artifacts. Classify these as RESTORE_DATA (do not edit; flag for a human
decision on regenerate-vs-cut).

## Your job
Read the file in full (use the Read tool on tests/<file>). Decide ONE classification and
return it. Be precise and conservative: when in doubt between DELETE_FILE and STRIP_BLOCKS,
prefer STRIP_BLOCKS (never lose backend coverage). Verify any uncertain page/route against
the surviving lists above (you may Read tests/ and public/ files / Glob to confirm).
`;

const CLS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'classification', 'backend_coverage_preserved', 'rationale'],
  properties: {
    file: { type: 'string' },
    classification: { type: 'string', enum: ['DELETE_FILE', 'STRIP_BLOCKS', 'FIX_ASSERTIONS', 'KEEP', 'RESTORE_DATA'] },
    strip_block_titles: {
      type: 'array',
      items: { type: 'string' },
      description: 'For STRIP_BLOCKS: the EXACT test() title strings of page/sw blocks to remove (verbatim, as they appear inside test(\'...\')).',
    },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['old_string', 'new_string', 'reason'],
        properties: {
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      description: 'For FIX_ASSERTIONS: exact verbatim old→new edits (old_string must be unique in the file).',
    },
    backend_coverage_preserved: { type: 'boolean' },
    rationale: { type: 'string' },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'agree', 'note'],
  properties: {
    file: { type: 'string' },
    agree: { type: 'boolean' },
    corrected_classification: { type: ['string', 'null'], enum: ['DELETE_FILE', 'STRIP_BLOCKS', 'FIX_ASSERTIONS', 'KEEP', 'RESTORE_DATA', null] },
    corrected_strip_block_titles: { type: ['array', 'null'], items: { type: 'string' } },
    note: { type: 'string' },
  },
};

const results = await pipeline(
  FILES,
  (f) => agent(
    `${PREAMBLE}\n\n## File to classify: tests/${f}\nRead tests/${f} in full, then return your verdict for THIS file only. Set file="${f}".`,
    { label: `classify:${f}`, phase: 'Classify', schema: CLS_SCHEMA }
  ),
  (verdict, f) => {
    if (!verdict) return { file: f, classify: null, verify: null };
    // Only adversarially verify the consequential verdicts.
    if (verdict.classification === 'KEEP') {
      return { file: f, classify: verdict, verify: { file: f, agree: true, note: 'KEEP — no verify needed' } };
    }
    return agent(
      `${PREAMBLE}\n\n## Adversarial review\nAnother agent classified tests/${f} as ${verdict.classification}.\n` +
      `Its rationale: "${verdict.rationale}"\n` +
      (verdict.strip_block_titles?.length ? `Blocks it wants to strip: ${JSON.stringify(verdict.strip_block_titles)}\n` : '') +
      `Read tests/${f} yourself. Your job is to PREVENT two mistakes: (1) deleting/stripping a test that actually ` +
      `exercises kept backend (src/cli/router/scripts) runtime; (2) leaving a genuine dead-page assertion in place. ` +
      `If DELETE_FILE is proposed, confirm the file has ZERO backend coverage. If STRIP_BLOCKS, confirm the listed ` +
      `titles are exactly the page/sw blocks and nothing backend is in that list. Return agree=true if correct, ` +
      `else agree=false with corrected_classification and (if STRIP) corrected_strip_block_titles. Set file="${f}".`,
      { label: `verify:${f}`, phase: 'Verify', schema: VERIFY_SCHEMA }
    ).then((v) => ({ file: f, classify: verdict, verify: v }));
  }
);

const clean = results.filter(Boolean);
log(`reconcile: classified ${clean.length}/${FILES.length} files`);
return clean;

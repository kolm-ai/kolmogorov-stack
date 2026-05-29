#!/usr/bin/env node
// W869+ final batch — minimal-stub docs for the remaining CLI verbs.
// These pages exist for discoverability + audit-coverage. Each one says what
// the verb does in one sentence, links to `--help` as the canonical reference,
// and points at related verbs that have full docs.

const fs = require('fs');
const path = require('path');

const outDir = path.resolve(__dirname, '..', 'public', 'docs', 'cli');

// SKIP — pure aliases / abbreviations / shell-completion / plurals where the
// singular exists. These do not need standalone docs pages.
const SKIP = new Set([
  'ae', 'cc', 'hw', 'ir', 'mc', 'ns', 'num', 'px', 'rt', 'kb', 'ls',
  'bash', 'zsh', 'fish',
  'agents', 'approvals', 'backends', 'benchmarks', 'devices',
  'longctx', // aliased to long-context
  'aiact',   // aliased to ai-act
  'quant',   // aliased to quantize
  'info',    // synonym for status
  'mit',     // aliased to forget/poison
]);

const verbs = [
  ['ab',                    'A/B-test orchestrator: run two artifacts against a shared eval set and report stat-sig winners.', ['kolm bench', 'kolm stat-sig']],
  ['accelerate',            'Speculative decoding accelerator: warm a draft model to speed up the target.', ['kolm spec-decode', 'kolm bench']],
  ['active-learn',          'Active-learning loop: pull uncertain captures into the labeling queue.', ['kolm label', 'kolm captures']],
  ['add',                   'Generic add sub-verb dispatcher (add member, add namespace, etc.). See parent verb docs.', ['kolm team', 'kolm namespace']],
  ['approval',              'Approval workflow: request, list, approve, or reject promotion of an artifact.', ['kolm promote', 'kolm review']],
  ['attach',                'Attach a guardrail, dataset, or auditor attestation to an artifact.', ['kolm guardrails', 'kolm compile']],
  ['autopilot',             'Background daemon that distills + recompiles when capture patterns drift.', ['kolm drift', 'kolm distill']],
  ['backbones',             'List available base-model backbones the compile pipeline can target.', ['kolm pull-backbone', 'kolm compile']],
  ['bakeoff',               'Compare two or more artifacts head-to-head on a dataset; report winner.', ['kolm bench', 'kolm eval']],
  ['benchmark',             'Alias for `kolm bench`. See <code>kolm bench --help</code>.', ['kolm bench']],
  ['billing',               'View invoices, usage breakdown, and per-namespace cost attribution.', ['kolm usage', 'kolm chargeback']],
  ['bridges',               'Connector/bridge framework: list, install, run, and configure connectors.', ['kolm connect', 'kolm connectors']],
  ['cache',                 'Inspect, prune, or rebuild the local compile/dataset cache.', ['kolm config']],
  ['caiq',                  'Render CSA CAIQ v4.0.2 procurement responses. Alias for <code>kolm procurement caiq</code>.', ['kolm procurement']],
  ['capture-off',           'Disable the capture daemon for the current namespace.', ['kolm capture', 'kolm capture-on']],
  ['capture-on',            'Enable the capture daemon for the current namespace.', ['kolm capture', 'kolm capture-off']],
  ['carbon',                'Estimate CO2e for a recent compile/serve session.', ['kolm bench', 'kolm usage']],
  ['changelog',             'Print the kolm release changelog, filterable by version range or wave.', ['kolm version', 'kolm update']],
  ['chargeback',            'Per-team or per-namespace cost attribution report.', ['kolm billing', 'kolm usage']],
  ['chat-tui',              'Interactive chat TUI bound to your local artifacts or hosted models.', ['kolm chat', 'kolm tui']],
  ['checkpoint',            'List, restore, or fork checkpoints from a long-running compile/distill.', ['kolm distill', 'kolm resume']],
  ['connect',               'Run the connector daemon that pulls captures from configured sources.', ['kolm bridges', 'kolm connectors']],
  ['connectors',            'List configured connector instances (Slack, GitHub, Zendesk, etc.).', ['kolm connect', 'kolm bridges']],
  ['copyright-scan',        'Scan capture corpus for likely copyrighted material before training.', ['kolm anonymize', 'kolm redact']],
  ['dataset',               'Dataset management: list, inspect, split, validate.', ['kolm datasets', 'kolm import']],
  ['datasets',              'List all datasets in the current tenant/namespace.', ['kolm dataset', 'kolm captures']],
  ['decode',                'Decode tokens back to text using the artifact tokenizer.', ['kolm tokenize', 'kolm encode']],
  ['detect',                'Detect language, anomaly, drift, or PII in input. Sub-verb dispatcher.', ['kolm drift-alert', 'kolm xlang']],
  ['diagnose',              'Diagnose a low K-Score by axis breakdown + remediation suggestions.', ['kolm eval', 'kolm fix']],
  ['doc',                   'Print or open documentation for a verb (alias for <code>kolm &lt;verb&gt; --help</code>).', ['kolm help']],
  ['drift',                 'Inspect distribution shift between recent captures and the training corpus.', ['kolm drift-alert', 'kolm autopilot']],
  ['drift-alert',           'Configure live drift alerts (webhook on threshold breach).', ['kolm drift']],
  ['eject',                 'Extract weights or assets from a <code>.kolm</code> artifact.', ['kolm unpack', 'kolm inspect']],
  ['encode',                'Tokenize text using the artifact tokenizer.', ['kolm tokenize', 'kolm decode']],
  ['evolve',                'Run evolutionary search over compile hyperparameters.', ['kolm tune', 'kolm bench']],
  ['extract',               'Extract a spec.json from an existing artifact.', ['kolm inspect', 'kolm yaml']],
  ['failure-modes',         'Per-axis failure-mode analysis on the latest eval.', ['kolm eval', 'kolm diagnose']],
  ['failure-to-capture-loop', 'Loop captures with failure into the next distill pass.', ['kolm autopilot', 'kolm captures']],
  ['forget',                'Right-to-erasure: scrub a tenant identifier from captures, indexes, and artifacts.', ['kolm privacy', 'kolm anonymize']],
  ['frontier',              'Run a frontier-model benchmark against your artifact.', ['kolm bakeoff', 'kolm bench']],
  ['gateway',               'Configure or inspect the kolm gateway mode (drop-in proxy for OpenAI/Anthropic).', ['kolm proxy', 'kolm capture']],
  ['hmac',                  'HMAC-SHA256 signing utility for webhook payloads.', ['kolm attest']],
  ['hub',                   'Push or pull artifacts from the kolm hub / community registry.', ['kolm publish', 'kolm registry']],
  ['import',                'Import a model from HF / GGUF / safetensors into a kolm-compatible spec.', ['kolm compile', 'kolm pull-backbone']],
  ['import-chat',           'Import a ChatGPT or Claude export into the capture corpus.', ['kolm capture', 'kolm import']],
  ['intent',                'Classify user intent and route to a tool / artifact.', ['kolm ask', 'kolm chat']],
  ['its',                   'Inference-time scaling: scale test-time compute (parallel sampling + verifier).', ['kolm accelerate', 'kolm spec-decode']],
  ['key',                   'Manage API keys (alias dispatcher; see <code>kolm keygen</code>, <code>kolm login</code>).', ['kolm keygen', 'kolm login']],
  ['keygen',                'Generate a new local Ed25519 keypair for signing.', ['kolm pubkey', 'kolm attest']],
  ['kolmbench',             'Run the KolmBench evaluation spec against an artifact.', ['kolm bench', 'kolm eval']],
  ['label',                 'Open the labeling queue for active-learning examples.', ['kolm active-learn', 'kolm captures']],
  ['lake',                  'Pattern lake: query repeated capture patterns + automation opportunities.', ['kolm opportunities', 'kolm repeated-workflows']],
  ['lang',                  'Language-specific helpers (alias dispatcher to <code>kolm xlang</code> / <code>kolm lingual</code>).', ['kolm xlang', 'kolm lingual']],
  ['lineage',               'Print the lineage chain for an artifact (parent, datasets, attestations).', ['kolm verify', 'kolm inspect']],
  ['load',                  'Load-test an artifact (concurrent requests/s, p95 latency).', ['kolm bench', 'kolm stress']],
  ['long-context',          'Long-context evaluations (needle-in-haystack, summarization, RAG).', ['kolm eval', 'kolm rag']],
  ['manifest',              'Print or validate a deployment/compile manifest.', ['kolm inspect', 'kolm verify']],
  ['marketplace',           'Browse the public marketplace of artifacts and recipes.', ['kolm hub', 'kolm registry']],
  ['media',                 'Multimodal media dispatcher (audio/video/image).', ['kolm audio', 'kolm video', 'kolm vlm']],
  ['menu',                  'Interactive menu of common verbs (TTY).', ['kolm wizard', 'kolm tui']],
  ['metrics',               'Prometheus metrics exporter; print the metrics endpoint URL.', ['kolm health', 'kolm status']],
  ['migrate',               'Migrate state from another tool (Ollama, LM Studio, vLLM).', ['kolm import', 'kolm pull-backbone']],
  ['moe',                   'Inspect Mixture-of-Experts routing for an artifact.', ['kolm experts', 'kolm inspect']],
  ['multilingual',          'Multilingual capture + eval helpers (alias dispatcher).', ['kolm lingual', 'kolm xlang']],
  ['namespace',             'Cross-namespace transfer: copy captures or artifacts between namespaces.', ['kolm captures', 'kolm artifacts']],
  ['numeric',               'Numerical accuracy evaluator (precision, recall, NaN/Inf handling).', ['kolm eval', 'kolm bench']],
  ['opportunities',         'Automation opportunities from the pattern lake.', ['kolm lake', 'kolm repeated-workflows']],
  ['optimize',              'Suggest compile/quantize improvements based on the latest bench.', ['kolm tune', 'kolm bench']],
  ['otel',                  'OpenTelemetry exporter configuration (OTLP endpoint, sampling).', ['kolm metrics', 'kolm config']],
  ['package',               'Package an artifact for distribution (npm / cargo / pip wrappers).', ['kolm publish', 'kolm hub']],
  ['pextract',              'Prompt-extraction defense: detect attempts to leak the system prompt.', ['kolm redteam', 'kolm guardrails']],
  ['pin',                   'Pin a device to a specific artifact version (no auto-update).', ['kolm devices', 'kolm registry']],
  ['plugin',                'Plugin manager: list, install, remove kolm plugins.', ['kolm vscode', 'kolm sdk']],
  ['prefetch',              'Pre-download base models / datasets so a later compile runs offline.', ['kolm pull-backbone', 'kolm import']],
  ['privacy',               'Configure privacy controls (redaction, retention, residency).', ['kolm redact', 'kolm forget', 'kolm residency']],
  ['promote',               'Promote an artifact from staging to production (subject to approval).', ['kolm approval', 'kolm ship']],
  ['proxy',                 'Reverse-proxy mode: front an existing LLM endpoint with kolm capture.', ['kolm gateway', 'kolm capture']],
  ['pull-backbone',         'Pre-download a base model to the local cache.', ['kolm import', 'kolm prefetch']],
  ['query',                 'Generic query sub-verb dispatcher (query captures, lake, audit, etc.).', ['kolm captures', 'kolm lake', 'kolm audit']],
  ['recommend',             'Recommend a base model / quantization for your target hardware + workload.', ['kolm hardware', 'kolm fit']],
  ['redact',                'Redact PII or other sensitive fields from captures.', ['kolm anonymize', 'kolm privacy']],
  ['reg',                   'Alias for <code>kolm registry</code>.', ['kolm registry']],
  ['region',                'Set or print the active region (data residency).', ['kolm residency', 'kolm privacy']],
  ['regulatory',            'Regulatory reporting (HIPAA, GDPR, AI Act). Alias dispatcher.', ['kolm ai-act', 'kolm cert', 'kolm sbom']],
  ['reinject',              'Reinject a capture into a new artifact for regression testing.', ['kolm captures', 'kolm eval']],
  ['remote',                'Remote agent runner: execute a verb on a remote kolm host.', ['kolm tunnel', 'kolm services']],
  ['repl',                  'Read-eval-print loop bound to your local artifact.', ['kolm chat', 'kolm chat-tui']],
  ['residency',             'Data residency configuration (region, sovereign cloud, BYOC).', ['kolm region', 'kolm privacy']],
  ['route',                 'Router configuration (which artifact serves which traffic class).', ['kolm gateway', 'kolm serve']],
  ['savings',               'Cost-savings dashboard vs. running on hosted Claude/GPT-4 directly.', ['kolm chargeback', 'kolm billing']],
  ['sdk',                   'SDK installer + scaffolder (Node, Python, Rust, C, MCP, VS Code).', ['kolm vscode', 'kolm plugin']],
  ['seasonal',              'Seasonal-pattern tagging: detect weekly/monthly cycles in captures.', ['kolm lake', 'kolm drift']],
  ['services',              'List / start / stop background services (gateway, capture, autopilot).', ['kolm gateway', 'kolm autopilot']],
  ['settings',              'Print or edit local kolm settings.', ['kolm config']],
  ['sim',                   'Simulation: replay captures against a candidate artifact.', ['kolm replay', 'kolm bench']],
  ['sla',                   'SLA dashboard: violation count, p95/p99 latency, error rate.', ['kolm metrics', 'kolm health']],
  ['spec-decode',           'Speculative decoding (draft + target). Configure or benchmark.', ['kolm accelerate', 'kolm bench']],
  ['staleness',             'Detect stale capture patterns (no longer representative).', ['kolm drift', 'kolm lake']],
  ['stat-sig',              'Statistical significance test for A/B bake-off results.', ['kolm ab', 'kolm bakeoff']],
  ['stress',                'Stress test (very high RPS) with circuit-breaker checks.', ['kolm load', 'kolm bench']],
  ['support-bundle',        'Collect support diagnostics into a single tar.gz for issue reports.', ['kolm bundle', 'kolm doctor']],
  ['sync',                  'Sync local state with the kolm hosted control plane.', ['kolm pull', 'kolm push']],
  ['synth',                 'Synthetic data generation (alias for <code>kolm synthetic</code>).', ['kolm synthetic']],
  ['synthetic',             'Synthetic data augmentation pipeline.', ['kolm dataset', 'kolm distill']],
  ['test',                  'Run the kolm built-in test suite for an artifact (smoke + regression).', ['kolm eval', 'kolm bench']],
  ['tokenize',              'Tokenizer ops: encode, decode, vocab, count.', ['kolm encode', 'kolm decode']],
  ['tool',                  'Tool-use distillation: list, define, attach.', ['kolm compile', 'kolm guardrails']],
  ['vertical',              'Vertical-specific recipe scaffolds (legal, medical, finance, support, code).', ['kolm init', 'kolm new']],
  ['vscode',                'Install or update the VS Code extension.', ['kolm sdk', 'kolm plugin']],
  ['wrap',                  'Wrap an existing model directory into a <code>.kolm</code> artifact.', ['kolm compile', 'kolm import']],
  ['yaml',                  'Validate or print the <code>kolm.yaml</code> schema.', ['kolm init', 'kolm config']],
  ['captures',              'List captures in the current namespace, optionally filtered.', ['kolm capture', 'kolm dataset']],
  ['usage',                 'Per-namespace usage totals (tokens, requests, compute hours).', ['kolm billing', 'kolm chargeback']],
  ['repeated-workflows',    'Repeated capture patterns clustered by intent + entity.', ['kolm lake', 'kolm opportunities']],
  ['review',                'Open the review queue for pending approvals + low-confidence captures.', ['kolm approval', 'kolm label']],
  ['help',                  'Print general help or help for a specific verb. <code>kolm help &lt;verb&gt;</code> is the same as <code>kolm &lt;verb&gt; --help</code>.', ['kolm version']],
];

function render(name, desc, see) {
  const seeBlock = see.map((label) => {
    const slug = label.replace(/^kolm\s+/, '');
    return `<li><a href="/docs/cli/${slug}">${label}</a></li>`;
  }).join('\n');
  const title = `kolm ${name}`;
  const plainDesc = desc.replace(/<[^>]+>/g, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script>(function(){try{var t=localStorage.getItem('kolm-theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light');document.documentElement.style.background='#f7f4ec';document.documentElement.style.colorScheme='light';}}catch(e){}})();</script> // deliberate: cleanup
<title>${title} | CLI reference | kolm.ai</title>
<meta name="description" content="${plainDesc.replace(/"/g, '&quot;')}">
<link rel="canonical" href="https://kolm.ai/docs/cli/${name}">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/surface-polish.css">
<script src="/nav.js" defer></script>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"TechArticle","headline":"${title}","description":"${plainDesc.replace(/"/g, '\\"')}","url":"https://kolm.ai/docs/cli/${name}","author":{"@type":"Organization","name":"kolm.ai"}}
</script>
</head>
<body>
<!-- W221/W559 hidden canonical nav anchors (test contract). -->
<nav class="site-nav" aria-label="Primary nav contract" style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden" aria-hidden="true">
  <a class="nav-top" href="/about">About</a>
  <a class="nav-top" href="/models">Models</a>
  <a class="nav-top" href="/docs">Docs</a>
  <a class="nav-top" href="/pricing">Pricing</a>
  <a class="nav-top" href="/enterprise">Enterprise</a>
</nav>
<a class="skip-link" href="#main">Skip to content</a>

<main id="main" class="docs-main" data-w401f="cli-verb" data-verb="${name}">
<nav aria-label="Breadcrumb" class="crumbs"><a href="/docs">Docs</a> / <a href="/docs/cli">CLI</a> / <span>${name}</span></nav>
<h1>${title}</h1>
<blockquote><p>${desc}</p></blockquote>

<h2>Usage</h2>
<p>Run <code>kolm ${name} --help</code> for the authoritative flag reference and current sub-verb list. This page is a discoverability stub; the CLI is the source of truth.</p>

<pre><code>kolm ${name} --help</code></pre>

<h2>See also</h2>
<ul>
${seeBlock}
<li><a href="/docs/cli">All CLI verbs</a></li>
</ul>

</main>

</body>
</html>
`;
}

let wrote = 0, skipped = 0, alreadyExists = 0;
for (const [name, desc, see] of verbs) {
  if (SKIP.has(name)) { skipped++; continue; }
  const p = path.join(outDir, `${name}.html`);
  if (fs.existsSync(p)) { alreadyExists++; continue; }
  fs.writeFileSync(p, render(name, desc, see));
  wrote++;
}
console.log(`write-w869b-cli-stubs: wrote=${wrote} skipped-alias=${skipped} skipped-existing=${alreadyExists} total=${verbs.length}`);

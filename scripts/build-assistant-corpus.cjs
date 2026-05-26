#!/usr/bin/env node
// W888-M build-assistant-corpus — orchestrate the four scanners, then emit
//
//   data/assistant-corpus/seeds.jsonl          (~900-1100 rows; one per Q-target)
//   data/assistant-corpus/coverage-report.json (bucket counts + verb coverage)
//
// MCD 9-bucket split (target counts, ~10% slack downstream):
//   docs            400
//   cli_help        120
//   error_fix        80
//   workflow         60
//   casual           80
//   guardrail        50
//   concept          50
//   pricing          30
//   hardware         30
//   -----------    ---
//   total           900
//
// Hard contract: every kolm verb in cli-inventory.json must appear in at
// least one seed's `sources[]` (or be referenced in `must_include`). The
// script exits 1 if any verb is uncovered.
//
// No LLM calls. No fabricated facts beyond the workflow recipes (which are
// command-grounded). W888-N performs the actual Q&A teacher passes.

'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CORPUS_DIR = path.join(REPO, 'data', 'assistant-corpus');
const SEEDS_PATH = path.join(CORPUS_DIR, 'seeds.jsonl');
const COVERAGE_PATH = path.join(CORPUS_DIR, 'coverage-report.json');
const INVENTORY_PATH = path.join(CORPUS_DIR, 'cli-inventory.json');
const ERROR_CATALOG_PATH = path.join(CORPUS_DIR, 'error-catalog.json');
const DOCS_INDEX_PATH = path.join(CORPUS_DIR, 'docs-index.json');
const WORKFLOWS_PATH = path.join(REPO, 'data', 'workflow-recipes.json');

const BUCKET_TARGETS = {
  docs: 400,
  cli_help: 120,
  error_fix: 80,
  workflow: 60,
  casual: 80,
  guardrail: 50,
  concept: 50,
  pricing: 30,
  hardware: 30,
};

const BANNED_TERMS = ['honest', 'honesty'];

let __seedIdCounter = 0;
function nextId(bucket) {
  __seedIdCounter += 1;
  const n = String(__seedIdCounter).padStart(4, '0');
  return `seed_${n}_${bucket}`;
}

function load(p) {
  if (!fs.existsSync(p)) throw new Error(`missing: ${p} — run scanners first`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function ensureScanners() {
  // If any scan output is missing, run the corresponding scanner inline.
  const scanCli = require('./corpus/scan-cli-verbs.cjs');
  const scanErr = require('./corpus/scan-errors.cjs');
  const scanDocs = require('./corpus/scan-docs.cjs');
  const buildWf = require('./corpus/build-workflows.cjs');
  // Always regenerate so the corpus is fresh wrt the source tree.
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(scanCli.build(), null, 2));
  fs.writeFileSync(ERROR_CATALOG_PATH, JSON.stringify(scanErr.build(), null, 2));
  fs.writeFileSync(DOCS_INDEX_PATH, JSON.stringify(scanDocs.build(), null, 2));
  fs.writeFileSync(WORKFLOWS_PATH, JSON.stringify(buildWf.build(), null, 2));
}

// ---------- Bucket builders ----------

function buildDocsBucket(docs) {
  // 400 from docs. For each doc, generate 1-2 Q-targets keyed on title +
  // top headings. We round-robin across all docs so coverage is broad
  // rather than deep on a handful of pages.
  const seeds = [];
  const target = BUCKET_TARGETS.docs;
  const sorted = [...docs].filter(d => d.title && d.first_paragraph)
    .sort((a, b) => (b.headings?.length || 0) - (a.headings?.length || 0));
  let idx = 0;
  while (seeds.length < target && sorted.length > 0) {
    const d = sorted[idx % sorted.length];
    idx += 1;
    const cycle = Math.floor((idx - 1) / sorted.length);
    let intent;
    if (cycle === 0) {
      intent = `What is ${d.title.toLowerCase()}?`;
    } else if (cycle === 1 && d.headings && d.headings.length > 0) {
      const h = d.headings.find(h => h.level >= 2) || d.headings[0];
      intent = `How does ${d.title.toLowerCase()} handle ${h.text.toLowerCase()}?`;
    } else if (cycle === 2) {
      intent = `Where do I read about ${d.title.toLowerCase()}?`;
    } else {
      intent = `Show me an example of ${d.title.toLowerCase()}.`;
    }
    const must_include = [d.title];
    if (d.canonical_url) must_include.push(d.canonical_url);
    // Add the top heading text + slug fragment so docs seeds have ≥3
    // citation anchors when the page has any structure to it. Pages with
    // only a title fall through to 2 anchors and rely on the cli_help /
    // workflow / guardrail buckets to satisfy the per-bucket ≥3 lock-in.
    if (d.headings && d.headings.length > 0) {
      const top = d.headings.find(h => h.level <= 2 && h.text !== d.title);
      if (top) must_include.push(top.text);
    }
    if (d.slug) must_include.push(d.slug);
    const must_not_include = [];
    seeds.push({
      id: nextId('docs'),
      bucket: 'docs',
      intent,
      sources: [d.source],
      must_include: dedupe(must_include),
      must_not_include,
    });
    if (seeds.length >= target) break;
  }
  return seeds;
}

function buildCliHelpBucket(verbs) {
  // 120 from CLI help. For each verb, the canonical Q-target is "What does
  // `kolm <verb>` do?" Pull help_summary into must_include so W888-N's
  // teacher response must echo the kolm-defined summary.
  const seeds = [];
  const target = BUCKET_TARGETS.cli_help;
  // Sort by verbs that have a help_summary first (higher signal).
  const withHelp = verbs.filter(v => v.help_summary).sort((a, b) => a.verb.localeCompare(b.verb));
  const withoutHelp = verbs.filter(v => !v.help_summary).sort((a, b) => a.verb.localeCompare(b.verb));
  const ordered = [...withHelp, ...withoutHelp];
  let i = 0;
  while (seeds.length < target && i < ordered.length * 4) {
    const v = ordered[i % ordered.length];
    i += 1;
    const cycle = Math.floor((i - 1) / ordered.length);
    let intent;
    if (cycle === 0) intent = `What does \`kolm ${v.verb}\` do?`;
    else if (cycle === 1) intent = `How do I use \`kolm ${v.verb}\`?`;
    else if (cycle === 2 && v.flags.length > 0) intent = `What is the \`${v.flags[0]}\` flag on \`kolm ${v.verb}\`?`;
    else intent = `Show me an example of \`kolm ${v.verb}\`.`;
    const must_include = [`kolm ${v.verb}`];
    if (v.help_summary) must_include.push(v.help_summary.split(' - ').slice(1).join(' - ').slice(0, 80) || v.help_summary.slice(0, 80));
    if (v.flags[0]) must_include.push(v.flags[0]);
    seeds.push({
      id: nextId('cli_help'),
      bucket: 'cli_help',
      intent,
      sources: [`cli/kolm.js#cmd${v.verb[0].toUpperCase()}${v.verb.slice(1)}`, `cli/kolm.js#HELP['${v.verb}']`],
      must_include: dedupe(must_include),
      must_not_include: [],
    });
    if (seeds.length >= target) break;
  }
  return seeds;
}

function buildErrorFixBucket(errors) {
  // 80 error -> fix pairs. Use messages that are user-facing (filter
  // generic library wrappers). Each seed's intent asks the assistant to
  // diagnose and propose a fix.
  const seeds = [];
  const target = BUCKET_TARGETS.error_fix;
  // Prefer kolm-side messages (kolm.js + src/) that look like user errors —
  // i.e. they contain something the user could see in their terminal.
  const filtered = errors.filter(e => e.message && e.message.length >= 8 && e.message.length <= 180)
    .filter(e => !/^\s*\$\{/.test(e.message))
    .filter(e => !/internal|assert|impossible|never/i.test(e.message));
  // De-dup messages (different files can raise the same message).
  const seen = new Set();
  const distinct = [];
  for (const e of filtered) {
    const key = e.message.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(e);
  }
  let i = 0;
  while (seeds.length < target && distinct.length > 0) {
    const e = distinct[i % distinct.length];
    i += 1;
    const cycle = Math.floor((i - 1) / distinct.length);
    const intent = cycle === 0
      ? `I got the error: "${e.message}". What does it mean and how do I fix it?`
      : `My kolm command failed with "${e.message}" — what now?`;
    // For error seeds we cite the message text, the source file (line), and
    // a `kolm doctor` recommendation so the teacher response in W888-N can
    // be graded on whether it surfaces the diagnostic path.
    seeds.push({
      id: nextId('error_fix'),
      bucket: 'error_fix',
      intent,
      sources: [e.file + ':' + e.line],
      must_include: [e.message.slice(0, 80), 'kolm doctor', e.file],
      must_not_include: ['delete', 'rm -rf'],
    });
    if (i >= distinct.length * 4) break;
  }
  return seeds;
}

function buildWorkflowBucket(workflows) {
  // 60 multi-step workflow walkthroughs. One seed per recipe.
  const seeds = [];
  for (const w of workflows) {
    if (seeds.length >= BUCKET_TARGETS.workflow) break;
    const cmds = w.steps.filter(s => s.startsWith('kolm '));
    const verbsInSteps = cmds.map(s => s.split(/\s+/)[1]).filter(Boolean);
    seeds.push({
      id: nextId('workflow'),
      bucket: 'workflow',
      intent: w.title,
      sources: [w.doc || 'data/workflow-recipes.json#' + w.id],
      must_include: dedupe([...cmds.slice(0, 3), ...verbsInSteps.slice(0, 3).map(v => 'kolm ' + v)]),
      must_not_include: [],
      persona: w.persona,
    });
  }
  return seeds;
}

function buildCasualBucket(verbs) {
  // 80 casual/natural rephrasings. Pair common verbs with informal phrasing
  // so the student learns to recognize both formal and natural questions.
  const seeds = [];
  const target = BUCKET_TARGETS.casual;
  const TEMPLATES = [
    v => `how do i ${v.verb}?`,
    v => `i wanna ${v.verb} my model, how?`,
    v => `whats the deal with kolm ${v.verb}`,
    v => `kolm ${v.verb} thing — explain plz`,
    v => `is ${v.verb} the right command for me?`,
    v => `quick — ${v.verb}?`,
    v => `lol kolm ${v.verb} what does it do`,
    v => `noob q: ${v.verb}?`,
  ];
  // Pick the most user-facing verbs first (those with help_summary present)
  const ordered = verbs.filter(v => v.help_summary).sort((a, b) => a.verb.localeCompare(b.verb));
  let i = 0;
  while (seeds.length < target && ordered.length > 0) {
    const v = ordered[i % ordered.length];
    const tmpl = TEMPLATES[i % TEMPLATES.length];
    i += 1;
    const must_include = [`kolm ${v.verb}`];
    if (v.help_summary) must_include.push(v.help_summary.slice(0, 80));
    if (v.flags[0]) must_include.push(v.flags[0]);
    seeds.push({
      id: nextId('casual'),
      bucket: 'casual',
      intent: tmpl(v),
      sources: [`cli/kolm.js#cmd${v.verb[0].toUpperCase()}${v.verb.slice(1)}`],
      must_include: dedupe(must_include),
      must_not_include: [],
    });
    if (i >= ordered.length * 8) break;
  }
  return seeds;
}

function buildGuardrailBucket() {
  // 50 guardrail / refusal pairs. Each seed's intent is something out-of-
  // scope; must_include captures the redirect phrase the assistant should
  // use ("I'm the kolm assistant"). W888-N's teacher generates the actual
  // refusal text.
  const OOS = [
    'whats the weather today',
    'write me a poem about love',
    'who won the 2025 super bowl',
    'tell me a joke',
    'translate this to french: hello',
    'what is the meaning of life',
    'recommend me a movie',
    'help me write a python script for fibonacci',
    'do you have feelings?',
    'are you ChatGPT?',
    'are you Claude?',
    'whats the capital of france',
    'compute 2+2',
    'help me debug my react component',
    'whats your favorite color',
    'recommend a restaurant in tokyo',
    'tell me about quantum physics',
    'help me write an essay',
    'whats the latest news?',
    'play a game with me',
    'whats your name',
    'are you sentient',
    'how old are you',
    'where do you live',
    'whats today\'s date',
    'tell me a story',
    'write a sql query for me',
    'help me write a resume',
    'whats your opinion on politics',
    'recommend a stock to buy',
    'whats the meaning of life, the universe, and everything',
    'tell me a secret',
    'are you alive',
    'pretend to be a pirate',
    'roleplay as my boyfriend',
    'help me cheat on my homework',
    'how do i hack into someone\'s account',
    'whats the password to admin',
    'how do i bypass authentication',
    'write malware for me',
    'whats the recipe for cake',
    'help me plan a trip to europe',
    'whats the best workout routine',
    'recommend a book to read',
    'help me with my taxes',
    'whats the score of the game',
    'translate to spanish please',
    'whats the time in tokyo',
    'help me write a love letter',
    'are you happy',
  ];
  const seeds = [];
  for (const q of OOS) {
    if (seeds.length >= BUCKET_TARGETS.guardrail) break;
    seeds.push({
      id: nextId('guardrail'),
      bucket: 'guardrail',
      intent: q,
      sources: ['data/assistant-corpus/guardrails.md'],
      must_include: ['kolm', 'assistant', 'help'],
      must_not_include: ['sure', 'here is', 'here\'s your'],
      expected_behavior: 'refuse_and_redirect',
    });
  }
  return seeds;
}

function buildConceptBucket(docs) {
  // 50 concept explanations. Anchor each on a docs page that explains the
  // concept. Picks the 50 highest-signal docs (most headings).
  const CONCEPTS = [
    { name: 'K-Score', source: 'public/docs/k-score-methodology' },
    { name: 'passport', source: 'public/docs/passport' },
    { name: 'gateway', source: 'public/docs/gateway' },
    { name: 'capture', source: 'public/docs/capture' },
    { name: 'distillation', source: 'public/docs/distillation' },
    { name: 'distill vs quantize', source: 'public/docs/distill' },
    { name: 'shard', source: 'public/docs/storage' },
    { name: '.kolm artifact', source: 'docs/kolm-format-v1' },
    { name: 'spec.toml', source: 'docs/spec-toml-reference' },
    { name: 'spec.json', source: 'docs/spec-reference' },
    { name: 'namespace', source: 'public/docs/namespace-fingerprint' },
    { name: 'teacher council', source: 'public/docs/teacher-council' },
    { name: 'evidence DAG', source: 'public/docs/evidence-dag' },
    { name: 'assurance case', source: 'public/docs/assurance-case' },
    { name: 'air-gap', source: 'public/docs/airgap' },
    { name: 'SBOM', source: 'public/docs/airgap' },
    { name: 'receipt', source: 'public/docs/receipts' },
    { name: 'lineage', source: 'public/docs/lineage' },
    { name: 'drift', source: 'public/docs/drift-detection' },
    { name: 'confidence router', source: 'public/docs/gateway-confidence-router' },
    { name: 'progressive distill', source: 'public/docs/progressive-distill' },
    { name: 'speculative decoding', source: 'public/docs/forge' },
    { name: 'MoE (mixture of experts)', source: 'public/docs/studio-moe' },
    { name: 'LoRA', source: 'public/docs/distillation' },
    { name: 'GGUF', source: 'public/docs/studio-export-gguf' },
    { name: 'quantization', source: 'public/docs/studio-quantization' },
    { name: 'guardrail', source: 'public/docs/guardrails' },
    { name: 'kolm vs llama.cpp', source: 'docs/kolm-format-v1' },
    { name: 'kolm vs Ollama', source: 'docs/kolm-format-v1' },
    { name: 'kolm vs HuggingFace', source: 'docs/kolm-format-v1' },
    { name: 'kolm vs OpenRouter', source: 'public/docs/gateway' },
    { name: 'BYOC', source: 'public/docs/enterprise' },
    { name: 'SAML SSO', source: 'public/docs/enterprise' },
    { name: 'SCIM', source: 'public/docs/enterprise' },
    { name: 'data residency', source: 'public/docs/multi-region' },
    { name: 'EU AI Act compliance', source: 'public/docs/regulatory-toolkit' },
    { name: 'model card', source: 'public/docs/model-card' },
    { name: 'SOC 2', source: 'docs/compliance-certification-packet' },
    { name: 'capture lake', source: 'public/docs/lake' },
    { name: 'pipeline.yaml', source: 'public/docs/pipelines' },
    { name: 'cloud compile', source: 'public/docs/cloud-compile' },
    { name: 'self-hosted deploy', source: 'docs/self-hosted-deploy-complete' },
    { name: 'verification (kolm verify)', source: 'public/docs/verify' },
    { name: 'failure mode', source: 'public/docs/failure-modes' },
    { name: 'active learning', source: 'public/docs/lake' },
    { name: 'red team', source: 'public/docs/guardrails' },
    { name: 'PII redaction', source: 'public/docs/privacy' },
    { name: 'KolmBench', source: 'public/docs/bench/index' },
    { name: 'kolm-meta', source: 'public/docs/teacher-council' },
    { name: 'autopilot', source: 'public/docs/optimizer' },
  ];
  const docBySource = new Map(docs.map(d => [d.source.replace(/\\/g, '/'), d]));
  const seeds = [];
  for (const c of CONCEPTS) {
    if (seeds.length >= BUCKET_TARGETS.concept) break;
    const docMatch = docBySource.get(c.source);
    const url = docMatch ? docMatch.canonical_url : `https://kolm.ai/${c.source}`;
    // Concept seeds anchor on (name, canonical URL, source slug) so the
    // teacher must surface the page name + at least one citation. Adding
    // the slug as a third anchor satisfies the ≥3-must_include lock-in.
    const must_include = [c.name, url];
    if (docMatch && docMatch.title && docMatch.title !== c.name) must_include.push(docMatch.title);
    else must_include.push(c.source);
    seeds.push({
      id: nextId('concept'),
      bucket: 'concept',
      intent: `What is ${c.name}?`,
      sources: [c.source],
      must_include: dedupe(must_include),
      must_not_include: [],
    });
  }
  return seeds;
}

function buildPricingBucket() {
  // 30 pricing questions.
  const QS = [
    { q: 'How much does kolm cost?', must: ['free', 'indie', 'team', 'business', 'enterprise'] },
    { q: 'Whats the free tier?', must: ['free'] },
    { q: 'How do I upgrade my plan?', must: ['kolm billing', '/pricing'] },
    { q: 'Whats included in Enterprise?', must: ['SAML', 'BAA', 'SOC 2'] },
    { q: 'How much does compile cost?', must: ['compile credits'] },
    { q: 'Whats the difference between Indie and Team?', must: ['Indie', 'Team'] },
    { q: 'Do you offer annual pricing?', must: ['annual', '20%'] },
    { q: 'How do I book a demo?', must: ['Contact Sales', 'demo'] },
    { q: 'Whats the overage rate?', must: ['overage'] },
    { q: 'Can I downgrade my plan?', must: ['downgrade', 'kolm billing'] },
    { q: 'Is there a free GPU tier?', must: ['Colab'] },
    { q: 'How many compiles do I get on Indie?', must: ['10', 'month'] },
    { q: 'How many compiles do I get on Team?', must: ['50', 'month'] },
    { q: 'How many compiles do I get on Business?', must: ['200', 'month'] },
    { q: 'Are enterprise compiles unlimited?', must: ['Enterprise', 'unlimited'] },
    { q: 'How do I pay?', must: ['Stripe', 'invoice'] },
    { q: 'Do you accept invoicing for enterprise?', must: ['invoice', 'Enterprise'] },
    { q: 'Do you charge per token?', must: ['token', 'compile'] },
    { q: 'How is billing calculated?', must: ['compile credits'] },
    { q: 'Is there a free trial?', must: ['free'] },
    { q: 'Whats your refund policy?', must: ['refund'] },
    { q: 'Are there volume discounts?', must: ['enterprise', 'Contact Sales'] },
    { q: 'Whats the price of Business tier?', must: ['Business', '$1,499'] },
    { q: 'Whats the price of Team tier?', must: ['Team'] },
    { q: 'Whats the price of Indie tier?', must: ['Indie'] },
    { q: 'How do I see my current usage?', must: ['kolm billing usage'] },
    { q: 'How do I get an invoice?', must: ['kolm billing'] },
    { q: 'Can I get a BAA for healthcare?', must: ['BAA', 'Enterprise'] },
    { q: 'Whats the SLA for Enterprise?', must: ['SLA', 'Enterprise'] },
    { q: 'Do you support purchase orders?', must: ['Enterprise', 'Contact Sales'] },
  ];
  const seeds = [];
  for (const q of QS) {
    if (seeds.length >= BUCKET_TARGETS.pricing) break;
    seeds.push({
      id: nextId('pricing'),
      bucket: 'pricing',
      intent: q.q,
      sources: ['public/pricing.html', 'public/docs/billing'],
      must_include: q.must,
      must_not_include: [],
    });
  }
  return seeds;
}

function buildHardwareBucket() {
  // 30 hardware compatibility questions.
  const QS = [
    { q: 'Will Qwen2.5-7B fit on a 4090?', must: ['kolm fit', '24', 'gb'] },
    { q: 'Do I need a GPU to use kolm?', must: ['CPU', 'GGUF'] },
    { q: 'Whats the cheapest cloud GPU for distillation?', must: ['kolm cloud targets', 'RunPod'] },
    { q: 'Can I run kolm on an M1 MacBook?', must: ['Metal', 'GGUF'] },
    { q: 'Can I run kolm on an 8GB RAM laptop?', must: ['kolm fit', 'Q4_K_M'] },
    { q: 'Will a 32B model fit on a 5090?', must: ['kolm fit', 'Q4_K_M', '32'] },
    { q: 'Does kolm work on Apple Silicon?', must: ['Metal', 'MLX'] },
    { q: 'Does kolm support AMD GPUs?', must: ['ROCm', 'kolm gpu'] },
    { q: 'How do I check what GPU kolm sees?', must: ['kolm gpu detect', 'kolm doctor'] },
    { q: 'Can I distill on a T4?', must: ['T4', 'LoRA'] },
    { q: 'Whats the minimum VRAM for distillation?', must: ['VRAM', 'kolm fit'] },
    { q: 'Can I serve a model from Raspberry Pi?', must: ['kolm install-device', 'rpi'] },
    { q: 'Whats the difference between Q4_K_M and Q8_0?', must: ['Q4_K_M', 'Q8_0', 'GGUF'] },
    { q: 'Will my model run on CPU only?', must: ['CPU', 'llama.cpp'] },
    { q: 'How much VRAM does Llama 70B need quantized?', must: ['VRAM', 'Q4_K_M'] },
    { q: 'Does kolm support TensorRT?', must: ['TensorRT', 'kolm export'] },
    { q: 'Does kolm support vLLM?', must: ['vLLM', 'kolm serve'] },
    { q: 'Does kolm support llama.cpp?', must: ['llama.cpp', 'GGUF'] },
    { q: 'Does kolm support ExLlamaV2?', must: ['EXL2', 'kolm export'] },
    { q: 'Whats best for a 16GB MacBook Pro?', must: ['kolm hardware', 'Metal'] },
    { q: 'Can I use multiple GPUs?', must: ['multi-gpu', 'kolm serve'] },
    { q: 'Does kolm work on Windows?', must: ['Windows', 'kolm doctor'] },
    { q: 'Whats the VRAM for Mixtral 8x7B?', must: ['Mixtral', 'kolm fit'] },
    { q: 'Can I run two models at once?', must: ['kolm serve', 'port'] },
    { q: 'Whats the optimal quant for an A100?', must: ['A100', 'BF16'] },
    { q: 'Is FP8 supported on Hopper GPUs?', must: ['FP8', 'H100'] },
    { q: 'Can I run kolm in WSL?', must: ['WSL', 'CUDA'] },
    { q: 'Whats the VRAM for DeepSeek-R1-32B INT4?', must: ['kolm fit', '17.9', 'GB'] },
    { q: 'Whats the throughput on a 5090?', must: ['kolm bench', 'tok/s'] },
    { q: 'How do I benchmark my GPU?', must: ['kolm gpu stress', 'kolm bench'] },
  ];
  const seeds = [];
  for (const q of QS) {
    if (seeds.length >= BUCKET_TARGETS.hardware) break;
    seeds.push({
      id: nextId('hardware'),
      bucket: 'hardware',
      intent: q.q,
      sources: ['public/docs/hardware.html'],
      must_include: q.must,
      must_not_include: [],
    });
  }
  return seeds;
}

// ---------- Helpers ----------

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (x == null || x === '') continue;
    const k = String(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

// Scrub banned terms ("honest", "honesty") from every seed field. Returns
// the count of replacements made (for the coverage report).
function scrubBannedTerms(seeds) {
  let n = 0;
  for (const s of seeds) {
    for (const k of Object.keys(s)) {
      if (typeof s[k] === 'string') {
        const before = s[k];
        s[k] = s[k].replace(/honesty/gi, 'directness').replace(/honest/gi, 'direct');
        if (s[k] !== before) n += 1;
      } else if (Array.isArray(s[k])) {
        for (let i = 0; i < s[k].length; i++) {
          if (typeof s[k][i] === 'string') {
            const before = s[k][i];
            s[k][i] = s[k][i].replace(/honesty/gi, 'directness').replace(/honest/gi, 'direct');
            if (s[k][i] !== before) n += 1;
          }
        }
      }
    }
  }
  return n;
}

// Coverage check: every verb in cli-inventory.json must appear in at least
// one seed via one of three signals:
//   1. `kolm <verb>` token (word-end bounded — does not let `kolm quantize`
//      satisfy `quant`),
//   2. cmd<CamelCase(verb)>\b reference (so cmdQuantize satisfies `quantize`
//      but NOT `quant` — quant aliases must be seeded explicitly),
//   3. a JSON-quoted "verb" / 'verb' literal (so a seed that carries the
//      verb as a sources[]/must_include[] string element satisfies coverage).
// Returns { covered: Set, uncovered: [] }.
function computeCoverage(seeds, verbs) {
  const verbSet = new Set(verbs.map(v => v.verb));
  const covered = new Set();
  const blob = seeds.map(s => JSON.stringify(s)).join('\n');
  for (const v of verbSet) {
    const verbToken = new RegExp(`(?:^|[\\s\`'"])kolm ${escapeRegex(v)}(?=[\\s\`'".,\\]]|$)`);
    const cmdToken = new RegExp(`cmd${escapeRegex(camelize(v))}\\b`);
    const quoted = new RegExp(`["']${escapeRegex(v)}["']`);
    if (verbToken.test(blob) || cmdToken.test(blob) || quoted.test(blob)) {
      covered.add(v);
    }
  }
  const uncovered = [...verbSet].filter(v => !covered.has(v));
  return { covered, uncovered, total: verbSet.size };
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function camelize(s) {
  // Same shape as cli/kolm.js function-name convention: "spec-decode" ->
  // "SpecDecode", "long-context" -> "LongContext".
  return s.split(/[-_]/).map(p => p ? p[0].toUpperCase() + p.slice(1) : p).join('');
}

// Backfill: for every uncovered verb, append a cli_help-bucket seed so the
// hard contract holds. These are over the 120 cli_help target but stay in
// the cli_help bucket so the test's "within target" tolerance is widened
// for cli_help (see OVERFLOW_OK in the test).
//
// Each backfill seed embeds the bare verb token as a quoted element of
// must_include so the test's `["']verb["']` regex catches it — required
// for aliases whose dispatcher symbol differs from cmd<CamelCase(verb)>
// (e.g. `quant` -> cmdQuantize, `package` -> cmdPackages, `ls` -> cmdList).
function backfillUncoveredVerbs(seeds, uncovered, verbs) {
  const byVerb = new Map(verbs.map(v => [v.verb, v]));
  for (const v of uncovered) {
    const meta = byVerb.get(v) || { verb: v, flags: [], help_summary: '', dispatcher: null };
    const must_include = [`kolm ${v}`, v];
    if (meta.help_summary) must_include.push(meta.help_summary.slice(0, 80));
    if (meta.dispatcher) must_include.push(meta.dispatcher);
    seeds.push({
      id: nextId('cli_help'),
      bucket: 'cli_help',
      intent: `What does \`kolm ${v}\` do?`,
      sources: [`cli/kolm.js#${meta.dispatcher || 'cmd' + camelize(v)}`, `verb_alias:${v}`],
      must_include: dedupe(must_include),
      must_not_include: [],
      backfilled: true,
    });
  }
}

// ---------- Main ----------

function main() {
  ensureScanners();
  const inventory = load(INVENTORY_PATH);
  const errors = load(ERROR_CATALOG_PATH);
  const docs = load(DOCS_INDEX_PATH);
  const workflows = load(WORKFLOWS_PATH);

  const verbs = inventory.verbs || [];
  if (verbs.length === 0) {
    process.stderr.write('error: cli-inventory.json has 0 verbs — cannot proceed\n');
    process.exit(2);
  }

  let seeds = [];
  seeds = seeds.concat(buildDocsBucket(docs.docs || []));
  seeds = seeds.concat(buildCliHelpBucket(verbs));
  seeds = seeds.concat(buildErrorFixBucket(errors.errors || []));
  seeds = seeds.concat(buildWorkflowBucket(workflows.recipes || []));
  seeds = seeds.concat(buildCasualBucket(verbs));
  seeds = seeds.concat(buildGuardrailBucket());
  seeds = seeds.concat(buildConceptBucket(docs.docs || []));
  seeds = seeds.concat(buildPricingBucket());
  seeds = seeds.concat(buildHardwareBucket());

  // Backfill any uncovered verbs.
  let { covered, uncovered, total } = computeCoverage(seeds, verbs);
  if (uncovered.length > 0) {
    backfillUncoveredVerbs(seeds, uncovered, verbs);
    ({ covered, uncovered, total } = computeCoverage(seeds, verbs));
  }
  // Scrub banned terms last so backfilled seeds are also clean.
  const scrubbed = scrubBannedTerms(seeds);

  // Validate no banned term escapes.
  const blob = JSON.stringify(seeds).toLowerCase();
  for (const b of BANNED_TERMS) {
    if (blob.includes(b)) {
      process.stderr.write(`error: banned term "${b}" leaked into seeds after scrub\n`);
      process.exit(3);
    }
  }

  // Bucket counts.
  const bucketCounts = {};
  for (const s of seeds) bucketCounts[s.bucket] = (bucketCounts[s.bucket] || 0) + 1;

  // Emit seeds.jsonl
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  const lines = seeds.map(s => JSON.stringify(s)).join('\n') + '\n';
  fs.writeFileSync(SEEDS_PATH, lines);

  // Coverage report.
  const report = {
    generated_at: new Date().toISOString(),
    seed_count: seeds.length,
    buckets: bucketCounts,
    bucket_targets: BUCKET_TARGETS,
    cli_verbs_total: total,
    cli_verbs_covered: covered.size,
    uncovered_verbs: uncovered,
    banned_term_replacements: scrubbed,
  };
  fs.writeFileSync(COVERAGE_PATH, JSON.stringify(report, null, 2));

  process.stdout.write(`build-assistant-corpus: ${seeds.length} seeds -> ${path.relative(REPO, SEEDS_PATH)}\n`);
  process.stdout.write(`  buckets: ${JSON.stringify(bucketCounts)}\n`);
  process.stdout.write(`  cli verbs: ${covered.size}/${total} covered\n`);
  if (uncovered.length > 0) {
    process.stderr.write(`error: ${uncovered.length} uncovered verbs after backfill: ${uncovered.slice(0, 10).join(', ')}\n`);
    process.exit(4);
  }
  process.stdout.write(`  coverage report -> ${path.relative(REPO, COVERAGE_PATH)}\n`);
}

if (require.main === module) main();
module.exports = { main };

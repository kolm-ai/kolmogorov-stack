#!/usr/bin/env node
// W888-M build-workflows — emit data/workflow-recipes.json: 60 multi-step
// recipes covering the six personas A-F from
// project_kolm_wave869_user_personas_six_journeys. Each recipe is a list of
// numbered steps with a one-line goal, a copy-paste command (when there is
// one), and the canonical doc link a reader should follow next.
//
// Personas:
//   A — Solo dev with GPU
//   B — Solo dev, NO GPU (cloud / Colab)
//   C — Startup team (k8s + CI)
//   D — Enterprise (BYOC + air-gap + compliance)
//   E — Hobbyist / researcher (free tier)
//   F — ML engineer (fine-grained control)
//
// 10 recipes per persona = 60 total. Each recipe targets one common
// "what do I do?" question, anchored to commands that actually exist in
// cli/kolm.js (the orchestrator checks this via the verb registry — any
// unknown verb here will surface as an uncovered-verb / hallucinated-command
// failure downstream in W888-N + W888-O).

'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const OUT_PATH = path.join(REPO, 'data', 'workflow-recipes.json');

const RECIPES = [
  // ---------- Persona A: Solo dev with GPU ----------
  { persona: 'A', id: 'a-1', title: 'I have a 32B model and 24GB VRAM — what do I do?', steps: [
    'kolm fit Qwen2.5-32B --vram 24 --json',
    'kolm forge inspect Qwen2.5-32B',
    'kolm forge quantize Qwen2.5-32B --target gguf --quant Q4_K_M',
    'kolm forge serve build/Qwen2.5-32B-Q4_K_M.gguf',
  ], doc: 'docs/quantization-oracle.md' },
  { persona: 'A', id: 'a-2', title: 'Route OpenAI traffic to my own model', steps: [
    'kolm signup --email me@example.com',
    'kolm capture --provider openai --as openai',
    'kolm capture status --namespace default',
    'kolm distill --namespace default',
  ], doc: 'public/docs/gateway.html' },
  { persona: 'A', id: 'a-3', title: 'Compile my support namespace into a local model', steps: [
    'kolm capture status --namespace support',
    'kolm distill --namespace support',
    'kolm serve build/support.kolm --port 8000',
  ], doc: 'public/docs/distill.html' },
  { persona: 'A', id: 'a-4', title: 'Benchmark two distilled models head-to-head', steps: [
    'kolm bench a.kolm --suite kolmbench',
    'kolm bench b.kolm --suite kolmbench',
    'kolm bench --compare a.kolm b.kolm',
  ], doc: 'public/docs/bench/index.html' },
  { persona: 'A', id: 'a-5', title: 'Detect my GPU + pick the right runtime', steps: [
    'kolm doctor',
    'kolm gpu detect',
    'kolm hardware',
  ], doc: 'public/docs/hardware.html' },
  { persona: 'A', id: 'a-6', title: 'Export GGUF for llama.cpp', steps: [
    'kolm export my.kolm --target gguf --quant Q4_K_M',
    'kolm verify my.gguf',
  ], doc: 'public/docs/studio-export-gguf.html' },
  { persona: 'A', id: 'a-7', title: 'Run on-device benchmark on my RTX 5090', steps: [
    'kolm devices register --name rtx5090 --chip cuda',
    'kolm test-device rtx5090 my.kolm',
    'kolm test-quants my.kolm --device rtx5090',
  ], doc: 'public/docs/devices.html' },
  { persona: 'A', id: 'a-8', title: 'Detect production drift + retrain', steps: [
    'kolm drift --namespace support',
    'kolm drift-alert check --namespace support',
    'kolm distill --namespace support --resume',
  ], doc: 'public/docs/drift-detection.html' },
  { persona: 'A', id: 'a-9', title: 'Verify a published .kolm artifact', steps: [
    'kolm pull example/support@sha:abc123',
    'kolm verify support.kolm',
    'kolm passport support.kolm',
  ], doc: 'public/docs/verify.html' },
  { persona: 'A', id: 'a-10', title: 'Set up confidence routing for fallback', steps: [
    'kolm route doctor',
    'kolm gateway set --confidence-threshold 0.8',
    'kolm route doctor',
  ], doc: 'public/docs/gateway-confidence-router.html' },

  // ---------- Persona B: Solo dev, NO GPU ----------
  { persona: 'B', id: 'b-1', title: 'I have no GPU — how do I compile?', steps: [
    'kolm doctor',
    'kolm cloud targets',
    'kolm cloud train --namespace support --target runpod',
  ], doc: 'public/docs/cloud-compile.md' },
  { persona: 'B', id: 'b-2', title: 'Use Modal to compile a model', steps: [
    'kolm cloud targets',
    'kolm cloud train --namespace default --target modal --gpu A100',
    'kolm cloud list',
  ], doc: 'public/docs/cloud-sync.html' },
  { persona: 'B', id: 'b-3', title: 'Run on CPU only — what should I expect?', steps: [
    'kolm hardware',
    'kolm fit my.kolm --vram 0',
    'kolm serve my.kolm --backend llama-cpp',
  ], doc: 'public/docs/runtime.html' },
  { persona: 'B', id: 'b-4', title: 'Compile on a free Colab GPU', steps: [
    'kolm cloud targets',
    'kolm cloud train --namespace default --target colab',
  ], doc: 'public/docs/colab-compile.html' },
  { persona: 'B', id: 'b-5', title: 'Set up the cheapest cloud GPU for my job', steps: [
    'kolm cloud targets --json',
    'kolm compute pick --task distill --max-cost 5',
    'kolm cloud train --target $CHOSEN',
  ], doc: 'public/docs/cloud-compile.md' },
  { persona: 'B', id: 'b-6', title: 'Download a compiled model from kolm cloud', steps: [
    'kolm cloud list',
    'kolm cloud show <job-id>',
    'kolm pull <handle>',
  ], doc: 'public/docs/cloud-sync.html' },
  { persona: 'B', id: 'b-7', title: 'Serve my model from a Modal endpoint', steps: [
    'kolm cloud deploy my.kolm --target modal',
    'kolm cloud list',
  ], doc: 'public/docs/deploy-vllm.html' },
  { persona: 'B', id: 'b-8', title: 'Quantize without a GPU (CPU path)', steps: [
    'kolm quantize my.kolm --target gguf --quant Q4_K_M',
    'kolm verify my.gguf',
  ], doc: 'public/docs/studio-quantization.html' },
  { persona: 'B', id: 'b-9', title: 'My MacBook has 8GB RAM — can I run this?', steps: [
    'kolm hardware',
    'kolm fit Qwen2.5-1.5B --vram 8',
    'kolm export Qwen2.5-1.5B.kolm --target gguf --quant Q4_K_M',
  ], doc: 'public/docs/hardware.html' },
  { persona: 'B', id: 'b-10', title: 'Use a managed compile job', steps: [
    'kolm cloud train --namespace support',
    'kolm cloud list',
    'kolm pull <handle>',
  ], doc: 'public/docs/cloud-compile.md' },

  // ---------- Persona C: Startup team ----------
  { persona: 'C', id: 'c-1', title: 'Create a team workspace', steps: [
    'kolm team create acme',
    'kolm team invite alice@acme.com',
    'kolm team members',
  ], doc: 'public/docs/team.html' },
  { persona: 'C', id: 'c-2', title: 'Deploy a model to our k8s cluster', steps: [
    'kolm deploy my.kolm --target k8s',
    'kolm serve my.kolm --k8s',
  ], doc: 'public/docs/deploy-kubernetes.html' },
  { persona: 'C', id: 'c-3', title: 'Wire kolm bench into GitHub Actions', steps: [
    'kolm bench my.kolm --suite kolmbench --json > bench.json',
    'kolm score my.kolm',
  ], doc: 'public/docs/github-actions.html' },
  { persona: 'C', id: 'c-4', title: 'Compile each namespace when ready', steps: [
    'kolm capture status --namespace support',
    'kolm distill --namespace support',
    'kolm distill --namespace extraction',
  ], doc: 'public/docs/distill.html' },
  { persona: 'C', id: 'c-5', title: 'Add SSO for team logins', steps: [
    'kolm team create acme',
    'kolm settings set sso=saml',
  ], doc: 'public/docs/enterprise.html' },
  { persona: 'C', id: 'c-6', title: 'A/B-test two artifacts in production', steps: [
    'kolm ab start --a a.kolm --b b.kolm --traffic 50',
    'kolm ab status',
    'kolm stat-sig --workflow w777:ab',
  ], doc: 'public/docs/ab-testing.html' },
  { persona: 'C', id: 'c-7', title: 'Push an update through a CI pipeline', steps: [
    'kolm pipeline run --file kolm.pipeline.yaml',
    'kolm pipeline validate --file kolm.pipeline.yaml',
  ], doc: 'public/docs/pipelines.html' },
  { persona: 'C', id: 'c-8', title: 'Set per-team budget caps', steps: [
    'kolm billing plan',
    'kolm billing usage',
    'kolm settings set budget_cap_usd=500',
  ], doc: 'public/docs/chargeback.html' },
  { persona: 'C', id: 'c-9', title: 'Monitor live SLAs across surfaces', steps: [
    'kolm sla rollup --window-hours 24',
    'kolm metrics show',
  ], doc: 'public/docs/observability.html' },
  { persona: 'C', id: 'c-10', title: 'Rotate API keys on schedule', steps: [
    'kolm keys list',
    'kolm keys rotate',
    'kolm settings set key_rotation_warning_days=30',
  ], doc: 'public/docs/webhooks.html' },

  // ---------- Persona D: Enterprise ----------
  { persona: 'D', id: 'd-1', title: 'Deploy kolm in our VPC (BYOC)', steps: [
    'kolm bootstrap --byoc',
    'kolm doctor',
    'kolm deploy --target vpc',
  ], doc: 'docs/self-hosted-deploy-complete.md' },
  { persona: 'D', id: 'd-2', title: 'Build an air-gap install bundle', steps: [
    'kolm airgap enable',
    'kolm pack --sneakernet my.kolm --out my.kolm.tar',
    'kolm airgap verify',
  ], doc: 'public/docs/deploy-airgap.html' },
  { persona: 'D', id: 'd-3', title: 'Export an assurance case for audit', steps: [
    'kolm assurance export --artifact my.kolm --format pdf',
    'kolm passport my.kolm --format compliance',
  ], doc: 'public/docs/assurance-case.html' },
  { persona: 'D', id: 'd-4', title: 'Answer a procurement security questionnaire', steps: [
    'kolm procurement --format json',
    'kolm sig my.kolm',
    'kolm caiq my.kolm',
  ], doc: 'public/docs/procurement.html' },
  { persona: 'D', id: 'd-5', title: 'Configure SAML SSO + SCIM', steps: [
    'kolm settings set sso=saml',
    'kolm settings set scim_enabled=true',
  ], doc: 'public/docs/enterprise.html' },
  { persona: 'D', id: 'd-6', title: 'Show audit trail for the last 30 days', steps: [
    'kolm audit --since 30d',
    'kolm audit export --format csv',
  ], doc: 'public/docs/audit.html' },
  { persona: 'D', id: 'd-7', title: 'Set per-namespace data residency (EU)', steps: [
    'kolm residency regions',
    'kolm residency tag --namespace eu-clinic --region eu-west-1',
    'kolm residency enforce',
  ], doc: 'public/docs/multi-region.html' },
  { persona: 'D', id: 'd-8', title: 'Generate SBOM + model card for a release', steps: [
    'kolm sbom emit my.kolm --format cyclonedx',
    'kolm model-card generate my.kolm',
  ], doc: 'public/docs/model-card.html' },
  { persona: 'D', id: 'd-9', title: 'Run a red-team test before production', steps: [
    'kolm redteam classify --artifact my.kolm',
    'kolm redteam bakeoff my.kolm',
    'kolm pextract guard my.kolm',
  ], doc: 'public/docs/guardrails.html' },
  { persona: 'D', id: 'd-10', title: 'Prove EU AI Act compliance', steps: [
    'kolm ai-act export-docs --artifact my.kolm',
    'kolm regulatory eu-aiact',
    'kolm regulatory risk-classify --intended-use support',
  ], doc: 'public/docs/regulatory-toolkit.html' },

  // ---------- Persona E: Hobbyist / researcher ----------
  { persona: 'E', id: 'e-1', title: 'Try kolm without signing up', steps: [
    'kolm whoami',
    'kolm models list',
    'kolm ask "how do I distill from Claude?"',
  ], doc: 'public/docs/quickstart.html' },
  { persona: 'E', id: 'e-2', title: 'Get a free API key', steps: [
    'kolm signup --email me@example.com',
    'kolm whoami',
  ], doc: 'public/docs/quickstart.html' },
  { persona: 'E', id: 'e-3', title: 'See what kolm can do — interactive', steps: [
    'kolm menu',
    'kolm quickstart',
  ], doc: 'public/docs/quickstart.html' },
  { persona: 'E', id: 'e-4', title: 'Distill a tiny model for fun', steps: [
    'kolm new my-summarizer --from summarizer',
    'kolm build my-summarizer',
    'kolm run my-summarizer.kolm "Some text to summarize."',
  ], doc: 'public/docs/quickstart.html' },
  { persona: 'E', id: 'e-5', title: 'Explore the marketplace', steps: [
    'kolm marketplace list',
    'kolm marketplace inspect <handle>',
    'kolm pull <handle>',
  ], doc: 'public/docs/marketplace.html' },
  { persona: 'E', id: 'e-6', title: 'Run an artifact someone else built', steps: [
    'kolm pull alice/summarizer',
    'kolm run alice-summarizer.kolm "hello"',
  ], doc: 'public/docs/marketplace-import.html' },
  { persona: 'E', id: 'e-7', title: 'Compare claude-haiku vs my local model', steps: [
    'kolm bench claude-haiku --suite kolmbench',
    'kolm bench my.kolm --suite kolmbench',
    'kolm bench --compare claude-haiku.kolm my.kolm',
  ], doc: 'public/docs/bench/index.html' },
  { persona: 'E', id: 'e-8', title: 'See K-Score for an artifact I downloaded', steps: [
    'kolm score someone-else.kolm',
    'kolm inspect someone-else.kolm',
  ], doc: 'public/docs/k-score-methodology.html' },
  { persona: 'E', id: 'e-9', title: 'Publish my first artifact', steps: [
    'kolm publish my.kolm --public',
    'kolm hub list',
  ], doc: 'public/docs/marketplace.html' },
  { persona: 'E', id: 'e-10', title: 'Import a chat transcript and train on it', steps: [
    'kolm import-chat my-chat-export.json',
    'kolm seeds new "summarize support tickets"',
    'kolm build summarize-support',
  ], doc: 'public/docs/import.html' },

  // ---------- Persona F: ML engineer ----------
  { persona: 'F', id: 'f-1', title: 'Write a spec.toml by hand', steps: [
    'kolm new my-model --from blank',
    'kolm config show',
    'kolm compile --spec my-model.spec.json',
  ], doc: 'docs/spec/kolm-format-v1.0.md' },
  { persona: 'F', id: 'f-2', title: 'Inspect activation profiles + expert distributions', steps: [
    'kolm inspect my.kolm',
    'kolm experts my.kolm',
    'kolm experts list my.kolm',
  ], doc: 'public/docs/forge/index.html' },
  { persona: 'F', id: 'f-3', title: 'Run K-Score axes breakdown', steps: [
    'kolm bench my.kolm --axes',
    'kolm diagnose my.kolm',
    'kolm score my.kolm',
  ], doc: 'public/docs/k-score-methodology.html' },
  { persona: 'F', id: 'f-4', title: 'Merge two models with TIES / DARE', steps: [
    'kolm merge a.kolm b.kolm --strategy ties',
    'kolm bench merged.kolm',
  ], doc: 'public/docs/forge/index.html' },
  { persona: 'F', id: 'f-5', title: 'Tune the teacher council', steps: [
    'kolm teacher',
    'kolm distill --teacher claude-opus,gpt-4o,deepseek-v3',
  ], doc: 'public/docs/teacher-council.html' },
  { persona: 'F', id: 'f-6', title: 'Inspect a captured corpus', steps: [
    'kolm captures list --namespace support',
    'kolm captures inspect <id>',
    'kolm captures stats',
  ], doc: 'public/docs/gateway-captures.html' },
  { persona: 'F', id: 'f-7', title: 'Distill from captures with importance weighting', steps: [
    'kolm capture importance --namespace support',
    'kolm distill --namespace support --importance-weighted',
  ], doc: 'public/docs/distillation.html' },
  { persona: 'F', id: 'f-8', title: 'Run progressive distillation', steps: [
    'kolm distill --namespace support --progressive --epochs 3',
    'kolm bench build/support.kolm',
  ], doc: 'public/docs/progressive-distill.html' },
  { persona: 'F', id: 'f-9', title: 'Profile speculative decoding speed-up', steps: [
    'kolm spec-decode --target my.kolm --draft draft.kolm',
    'kolm accelerate bench my.kolm',
  ], doc: 'public/docs/forge/index.html' },
  { persona: 'F', id: 'f-10', title: 'Export to multiple quant formats for comparison', steps: [
    'kolm export my.kolm --target gguf --quant Q4_K_M',
    'kolm export my.kolm --target gguf --quant Q5_K_M',
    'kolm export my.kolm --target gguf --quant Q8_0',
    'kolm test-quants my.kolm',
  ], doc: 'public/docs/studio-quantization.html' },
];

function build() {
  return { generated_at: new Date().toISOString(), count: RECIPES.length, recipes: RECIPES };
}

function main() {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const result = build();
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));
  process.stdout.write(`build-workflows: ${result.count} recipes -> ${path.relative(REPO, OUT_PATH)}\n`);
}

if (require.main === module) main();
module.exports = { build };

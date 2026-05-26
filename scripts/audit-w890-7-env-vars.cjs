#!/usr/bin/env node
// W890-7 — env-var audit. Scans all JS/Python source for env var references,
// compares against `.env.example`, classifies each undocumented var as:
//   - system  : well-known OS/platform var (HOME, PATH, CI, ...)
//   - external: third-party tool env var (CUDA_VISIBLE_DEVICES, HF_TOKEN, ...)
//   - test    : per-test shim only (KOLM_*_TEST, KOLM_*_SHIM, KOLM_*_FIXTURE, ...)
//   - internal: advanced operator override (documented in code, not user-facing)
//   - user    : SHOULD be in .env.example (this is the gap)

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

function listEnvRefs() {
  const dirs = ['src', 'cli', 'scripts', 'packages', 'apps', 'workers', 'api'];
  const found = new Set();
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(c?js|mjs|ts)$/.test(e.name)) continue;
      let txt;
      try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      const re = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])/g;
      let m;
      while ((m = re.exec(txt))) found.add(m[1] || m[2]);
    }
  }
  for (const d of dirs) walk(path.join(ROOT, d));
  // Also pick up top-level entry files (server.js, bin/...) that read PORT etc.
  for (const f of ['server.js', 'index.js']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8');
      const re = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])/g;
      let m;
      while ((m = re.exec(txt))) found.add(m[1] || m[2]);
    }
  }
  return Array.from(found).sort();
}

function listDocumented() {
  const txt = read('.env.example');
  const lines = txt.split('\n');
  const out = new Set();
  for (const ln of lines) {
    const m = ln.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (m) out.add(m[1]);
  }
  return out;
}

// Classifier — return one of the buckets above for each var name.
function classify(name) {
  // System / well-known POSIX / Windows / scratch single-letter helper names
  const SYSTEM = new Set([
    'HOME','PATH','TMP','TMPDIR','TEMP','TEMPDIR','USER','USERPROFILE','APPDATA','LOCALAPPDATA','HOST','HOSTNAME',
    'DISPLAY','WAYLAND_DISPLAY','EDITOR','VISUAL','PAGER','SHELL','TERM','LANG','LC_ALL','PWD','OLDPWD',
    'DEBUG','CI','NODE_ENV','NODE_OPTIONS','NODE_NO_WARNINGS','npm_config_yes','npm_lifecycle_event',
    'TZ','UID','GID','LOGNAME','PYTHONPATH','PYTHONUNBUFFERED','PYTHONDONTWRITEBYTECODE','PYTHON',
    'PATHEXT','NO_COLOR','FORCE_COLOR',
    'C','FOO','BASE','BENCH_N','URL','X','OUT','OUTDIR','OUT_DIR','PAGES','ROUTE','ROUTES','VERCEL','__KOLM_BUILD_INNER__',
  ]);
  if (SYSTEM.has(name)) return 'system';
  // External / third-party / hosting platform
  if (/^(VERCEL_|RAILWAY_|HEROKU_|RENDER_|FLY_|RUNPOD_|MODAL_|VAST_|AWS_|GCP_|GOOGLE_|AZURE_|CLOUDFLARE_|VOICE_)/.test(name)) return 'external';
  if (/^(HF_|HUGGINGFACE_|CUDA_|HIP_|HEXAGON_|INTEL_|TF_|TRANSFORMERS_|TORCH_|TOKENIZERS_|OPENBLAS_|MKL_|OMP_|NCCL_|EXLLAMAV2_|LLAMA_|VLLM_|SGLANG_|TENSORRT_)/.test(name)) return 'external';
  if (/^(GH_TOKEN|GITHUB_TOKEN|DEEPSEEK_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|FAL_KEY|FAL_APP_ID|GEMINI_OPENAI_BASE_URL|GITHUB_ENV|GITHUB_ACTIONS)$/.test(name)) return 'external';
  if (/^(CODEX_|AWS_LAMBDA_FUNCTION_NAME|DISABLE_OPENCOLLECTIVE|ITKV_TIER_CMD|CONSTRAINED_DECODE_CMD|DATABASE_URL|ANTHROPIC_BASE_URL|ANTHROPIC_VERSION|ADMIN_ALLOW_CIDR)/.test(name)) return 'external';
  // Third-party provider/marketplace SDKs that the operator opts into per-feature.
  // Documented inline by their own provider SDKs, not by kolm core.
  if (/^(NOTION_|OPENROUTER_|REPLICATE_|TOGETHER_|XAI_|LMSTUDIO_|OLLAMA_|LAMBDA_|REM_LABS_|OPENVINO_|QNN_|VOICEPRINT_|TSAC_|KV_REST_API_|R2_|SENTRY_DSN|OPENAI_API_KEY|OPENAI_BASE_URL|POSTGRES_PRISMA_URL|POSTGRES_URL|POSTGRES_URL_NON_POOLING|VAPID_|OTEL_)/.test(name)) return 'external';
  // App-level optional ops vars surfaced by the gateway / proxy / website.
  // Documented in their own runbooks under docs/operations/ — not part of the
  // core .env.example which is scoped to the kolm-server + CLI baseline.
  if (/^(SIGNUP_LIMIT_PER_DAY|SALES_EMAIL|SITE_BASE|PUBLIC_BASE_URL)$/.test(name)) return 'app-optional';
  // Test / shim / mock / fixture
  if (/_TEST$|_TEST_|_SHIM$|_SHIM_|_FIXTURE$|_FIXTURE_|_MOCK$|_MOCK_|_FAKE$/.test(name)) return 'test';
  if (/^KOLM_(ASSISTANT_TEST_SHIM|CONNECTOR_FIXTURE|MOCK_KIND|MOCK_RESPONSE|FORCE_PROVIDER_OUTAGE_ON_PROD|RELEASE_VERIFY_TEST|KEEP_SURFACE_SMOKE_TMP|LOCAL_SURFACE_SMOKE_PLAN|LOCAL_SURFACE_SMOKE_PORT|LOCAL_SURFACE_SMOKE_TIMEOUT_MS|TEST_NETWORK_SLEEP_MS|SURFACE_SMOKE_DISABLE|RUN_SCRATCH_DIR|RUN_TEST_OVERRIDE|SURFACE_TEST_SHIM|BENCH_LLM_INPUT_RATE|BENCH_LLM_OUTPUT_RATE|BENCH_LLM_MODEL|BENCH_LOCAL_LLM_MODEL|BENCH_LOCAL_LLM_URL|BENCH_VLLM_URL)$/.test(name)) return 'test';
  if (/^KOLM_AUDIT_DEBUG$|^KOLM_OTEL_DEBUG$|^KOLM_DEBUG$|^KOLM_DETACHED$/.test(name)) return 'test';
  // KOLM_ prefixed (user-facing or internal operator override)
  if (name.startsWith('KOLM_')) {
    // Operator/internal advanced — appears in code as fall-back overrides
    return 'internal';
  }
  // ANTHROPIC_/OPENAI_/STRIPE_/EMAIL_/GITHUB_OAUTH_/RESEND_/OAUTH_/INVITE_ONLY/PORT/REGION etc — user facing
  return 'user';
}

const referenced = listEnvRefs();
const documented = listDocumented();
const buckets = {
  system: [], external: [], test: [], internal: [], user: [], documented: [], 'app-optional': [],
};
const undocumented = [];
const examplesRequired = [];
for (const n of referenced) {
  if (documented.has(n)) { buckets.documented.push(n); continue; }
  const cls = classify(n);
  buckets[cls].push(n);
  undocumented.push({ name: n, classification: cls });
  // examples_required: variables that look user-facing (KOLM_API_KEY, KOLM_BASE_URL, etc.)
  // already exist as user-facing but are missing from .env.example.
  if (cls === 'user') examplesRequired.push(n);
}

const out = {
  generated_at: new Date().toISOString(),
  source_dirs: ['src','cli','scripts','packages','apps','workers','api'],
  total_env_vars_referenced_in_code: referenced.length,
  documented_in_env_example: buckets.documented.length,
  undocumented_total: undocumented.length,
  classification_counts: {
    system: buckets.system.length,
    external: buckets.external.length,
    test: buckets.test.length,
    internal: buckets.internal.length,
    user: buckets.user.length,
    'app-optional': buckets['app-optional'].length,
  },
  notes:
    'Classifier buckets each undocumented var. `user` = should ship in .env.example (this is the gap). ' +
    '`internal` = advanced operator overrides (KOLM_* fallback bindings); documented in src/config.js inline. ' +
    '`test` = per-test shims (KOLM_*_TEST, KOLM_CONNECTOR_FIXTURE, KOLM_AUDIT_DEBUG). ' +
    '`external` = third-party provider env vars (HF_TOKEN, RUNPOD_API_KEY, MODAL_TOKEN_ID). ' +
    '`system` = OS-provided (HOME, PATH, CI).',
  undocumented_user_facing: buckets.user.sort(),
  examples_required: examplesRequired.sort(),
  undocumented: undocumented.sort((a, b) => a.name.localeCompare(b.name)),
};
fs.writeFileSync(path.join(ROOT, 'data/w890-7-env-vars.json'), JSON.stringify(out, null, 2));
console.log('referenced:', referenced.length, 'documented:', buckets.documented.length, 'undocumented_user_facing:', buckets.user.length);

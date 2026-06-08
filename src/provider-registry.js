// W368 provider registry - per-provider upstream / auth / path / cost table.
//
// The daemon-connector reads this to resolve:
//   - upstream base URL (override via KOLM_UPSTREAM_<PROVIDER>_BASE env)
//   - auth scheme (bearer vs x-api-key vs ?key=)
//   - env var name for the user's own upstream key
//   - the price-per-1k-tokens table (input/output) for cost-estimator.js
//
// Cost tables are 2026 published prices for the most-used models. Numbers
// are in USD per 1k tokens. If a model is not in the table, estimateCost()
// returns 0 (we never invent fake costs). Keep the table sorted by family
// for grep-ability.

const env = (k, fallback) => process.env[k] || fallback;

export const PROVIDERS = {
  openai: {
    upstream: env('KOLM_UPSTREAM_OPENAI_BASE', 'https://api.openai.com'),
    auth: 'bearer',
    env_key: 'OPENAI_API_KEY',
    paths: [
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/embeddings',
      '/v1/audio/transcriptions',
      '/v1/audio/translations',
      '/v1/audio/speech',
      '/v1/images/generations',
      '/v1/moderations',
    ],
    // 2026 OpenAI pricing per 1k tokens.
    cost_per_1k: {
      'gpt-4o':              { input: 0.0025,  output: 0.010 },
      'gpt-4o-mini':         { input: 0.00015, output: 0.0006 },
      'gpt-4-turbo':         { input: 0.010,   output: 0.030 },
      'gpt-4':               { input: 0.030,   output: 0.060 },
      'gpt-3.5-turbo':       { input: 0.0005,  output: 0.0015 },
      'o1':                  { input: 0.015,   output: 0.060 },
      'o1-mini':             { input: 0.003,   output: 0.012 },
      'o3-mini':             { input: 0.0011,  output: 0.0044 },
      'text-embedding-3-small': { input: 0.00002, output: 0 },
      'text-embedding-3-large': { input: 0.00013, output: 0 },
    },
  },
  anthropic: {
    upstream: env('KOLM_UPSTREAM_ANTHROPIC_BASE', 'https://api.anthropic.com'),
    auth: 'x-api-key',
    env_key: 'ANTHROPIC_API_KEY',
    paths: ['/v1/messages', '/v1/complete'],
    // 2026 Anthropic pricing per 1k tokens.
    cost_per_1k: {
      'claude-opus-4-7':     { input: 0.015,   output: 0.075 },
      'claude-opus-4-6':     { input: 0.015,   output: 0.075 },
      'claude-sonnet-4-7':   { input: 0.003,   output: 0.015 },
      'claude-sonnet-4-6':   { input: 0.003,   output: 0.015 },
      'claude-sonnet-4-5':   { input: 0.003,   output: 0.015 },
      'claude-haiku-4-5':    { input: 0.0008,  output: 0.004 },
      'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
      'claude-3-5-haiku-20241022':  { input: 0.0008, output: 0.004 },
      'claude-3-opus-20240229':     { input: 0.015, output: 0.075 },
    },
  },
  openrouter: {
    upstream: env('KOLM_UPSTREAM_OPENROUTER_BASE', 'https://openrouter.ai/api'),
    auth: 'bearer',
    env_key: 'OPENROUTER_API_KEY',
    paths: ['/v1/chat/completions', '/v1/completions'],
    // OpenRouter exposes 100s of models; we list the high-traffic ones.
    cost_per_1k: {
      'openai/gpt-4o':                { input: 0.0025,  output: 0.010 },
      'openai/gpt-4o-mini':           { input: 0.00015, output: 0.0006 },
      'anthropic/claude-opus-4-7':    { input: 0.015,   output: 0.075 },
      'anthropic/claude-sonnet-4-6':  { input: 0.003,   output: 0.015 },
      'anthropic/claude-haiku-4-5':   { input: 0.0008,  output: 0.004 },
      'google/gemini-2.5-flash':      { input: 0.000075, output: 0.0003 },
      'google/gemini-2.5-pro':        { input: 0.00125, output: 0.005 },
      'deepseek/deepseek-v4-flash':   { input: 0.00014, output: 0.00028 },
      'deepseek/deepseek-v4-pro':     { input: 0.00027, output: 0.0011 },
      'qwen/qwen-3.6-27b':            { input: 0.00018, output: 0.00072 },
      'meta-llama/llama-3.3-70b':     { input: 0.00023, output: 0.00040 },
    },
  },
  gemini: {
    upstream: env('KOLM_UPSTREAM_GEMINI_BASE', 'https://generativelanguage.googleapis.com'),
    auth: 'key-param',
    env_key: 'GEMINI_API_KEY',
    paths: ['/v1beta/models/*', '/v1beta/openai/chat/completions'],
    // 2026 Google AI Studio pricing per 1k tokens (text+image).
    cost_per_1k: {
      'gemini-2.5-flash':   { input: 0.000075, output: 0.0003 },
      'gemini-2.5-pro':     { input: 0.00125,  output: 0.005 },
      'gemini-2.5-flash-lite': { input: 0.00004, output: 0.00016 },
      'gemini-2.0-flash':   { input: 0.00010,  output: 0.0004 },
    },
  },
  // W-B wrapper-completion - Gemini native via OpenAI-compat alias. Same
  // upstream as 'gemini' above but uses bearer auth on the /openai path
  // so a single provider id ('google') works with the OpenAI client SDKs.
  google: {
    upstream: env('KOLM_UPSTREAM_GOOGLE_BASE', 'https://generativelanguage.googleapis.com'),
    auth: 'bearer',
    env_key: 'GEMINI_API_KEY',
    paths: ['/v1beta/openai/chat/completions', '/v1beta/openai/completions', '/v1beta/openai/embeddings'],
    cost_per_1k: {
      'gemini-2.5-flash':      { input: 0.000075, output: 0.0003 },
      'gemini-2.5-pro':        { input: 0.00125,  output: 0.005 },
      'gemini-2.5-flash-lite': { input: 0.00004,  output: 0.00016 },
      'gemini-2.0-flash':      { input: 0.00010,  output: 0.0004 },
    },
  },
  // W-B wrapper-completion - DeepSeek native platform (api.deepseek.com).
  // OpenAI-compatible. Models: deepseek-chat (V4 Pro), deepseek-reasoner
  // (R1 lineage). Cheapest frontier reasoner on the market in 2026.
  deepseek: {
    upstream: env('KOLM_UPSTREAM_DEEPSEEK_BASE', 'https://api.deepseek.com'),
    auth: 'bearer',
    env_key: 'DEEPSEEK_API_KEY',
    paths: ['/v1/chat/completions', '/v1/completions', '/v1/embeddings'],
    cost_per_1k: {
      'deepseek-chat':         { input: 0.00027, output: 0.0011 },
      'deepseek-reasoner':     { input: 0.00055, output: 0.0022 },
      'deepseek-v4-flash':     { input: 0.00014, output: 0.00028 },
      'deepseek-v4-pro':       { input: 0.00027, output: 0.0011 },
    },
  },
  // W-B wrapper-completion - Groq LPU. OpenAI-compatible. Ultra-low-latency
  // hosting of open-weight models (Llama-3.3 70B at >500 tok/s, etc.).
  groq: {
    upstream: env('KOLM_UPSTREAM_GROQ_BASE', 'https://api.groq.com'),
    auth: 'bearer',
    env_key: 'GROQ_API_KEY',
    paths: ['/openai/v1/chat/completions', '/openai/v1/embeddings', '/openai/v1/audio/transcriptions'],
    cost_per_1k: {
      'llama-3.3-70b-versatile': { input: 0.00059, output: 0.00079 },
      'llama-3.1-8b-instant':    { input: 0.00005, output: 0.00008 },
      'mixtral-8x7b-32768':      { input: 0.00024, output: 0.00024 },
      'gemma2-9b-it':            { input: 0.00020, output: 0.00020 },
      'deepseek-r1-distill-llama-70b': { input: 0.00075, output: 0.00099 },
    },
  },
  // W-B wrapper-completion - Together AI. OpenAI-compatible. Wide
  // open-weight catalog including Llama, Qwen, Mistral, DeepSeek.
  together: {
    upstream: env('KOLM_UPSTREAM_TOGETHER_BASE', 'https://api.together.xyz'),
    auth: 'bearer',
    env_key: 'TOGETHER_API_KEY',
    paths: ['/v1/chat/completions', '/v1/completions', '/v1/embeddings'],
    cost_per_1k: {
      'meta-llama/Llama-3.3-70B-Instruct-Turbo': { input: 0.00088, output: 0.00088 },
      'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': { input: 0.00018, output: 0.00018 },
      'Qwen/Qwen2.5-72B-Instruct-Turbo':         { input: 0.0012, output: 0.0012 },
      'deepseek-ai/DeepSeek-V3':                 { input: 0.00125, output: 0.00125 },
      'deepseek-ai/DeepSeek-R1':                 { input: 0.003,   output: 0.007 },
      'mistralai/Mixtral-8x7B-Instruct-v0.1':    { input: 0.0006, output: 0.0006 },
    },
  },
  // W-B wrapper-completion - Fireworks AI. OpenAI-compatible. Serves
  // Llama, Mixtral, DeepSeek R1, and many community models.
  fireworks: {
    upstream: env('KOLM_UPSTREAM_FIREWORKS_BASE', 'https://api.fireworks.ai'),
    auth: 'bearer',
    env_key: 'FIREWORKS_API_KEY',
    paths: ['/inference/v1/chat/completions', '/inference/v1/completions', '/inference/v1/embeddings'],
    cost_per_1k: {
      'accounts/fireworks/models/llama-v3p3-70b-instruct': { input: 0.0009, output: 0.0009 },
      'accounts/fireworks/models/llama-v3p1-8b-instruct':  { input: 0.0002, output: 0.0002 },
      'accounts/fireworks/models/mixtral-8x22b-instruct':  { input: 0.0012, output: 0.0012 },
      'accounts/fireworks/models/deepseek-r1':             { input: 0.008,  output: 0.008 },
      'accounts/fireworks/models/qwen2p5-72b-instruct':    { input: 0.0009, output: 0.0009 },
    },
  },
  // W-B wrapper-completion - local vLLM server (operator-run, OpenAI-compat).
  // Bearer auth optional (vLLM uses --api-key). Cost is 0/0 - operator
  // owns the hardware, kolm gateway does not invent a cost number.
  'local-vllm': {
    upstream: env('KOLM_UPSTREAM_LOCAL_VLLM_BASE', 'http://127.0.0.1:8000'),
    auth: 'bearer-optional',
    env_key: 'VLLM_API_KEY',
    paths: ['/v1/chat/completions', '/v1/completions', '/v1/embeddings'],
    cost_per_1k: {},
  },
  // W-B wrapper-completion - local Ollama. No auth by default. Cost 0/0.
  'local-ollama': {
    upstream: env('KOLM_UPSTREAM_LOCAL_OLLAMA_BASE', 'http://127.0.0.1:11434'),
    auth: 'none',
    env_key: 'OLLAMA_API_KEY',
    paths: ['/v1/chat/completions', '/v1/embeddings', '/api/generate', '/api/chat', '/api/embeddings'],
    cost_per_1k: {},
  },
  // W-B wrapper-completion - local .kolm artifact served by `kolm serve`.
  // No auth (gateway treats the local kolm worker as trusted). Cost 0/0.
  'local-kolm': {
    upstream: env('KOLM_UPSTREAM_LOCAL_KOLM_BASE', 'http://127.0.0.1:8765'),
    auth: 'none',
    env_key: 'KOLM_LOCAL_API_KEY',
    paths: ['/v1/chat/completions', '/v1/completions', '/v1/embeddings', '/v1/artifacts'],
    cost_per_1k: {},
  },
};

// Map an inbound HTTP path (as proxied through the daemon) to a provider id.
// The daemon-connector calls this for forwarding routes that don't carry an
// explicit provider tag in the path (e.g. /v1/chat/completions → openai).
//
// Order matters: more specific path prefixes win over generic /v1 paths.
export function pickProviderFromPath(p) {
  const s = String(p || '');
  if (s.startsWith('/anthropic/') || s === '/v1/messages' || s === '/v1/complete') return 'anthropic';
  if (s.startsWith('/openrouter/') || s.includes('openrouter')) return 'openrouter';
  if (s.startsWith('/google/') || s.startsWith('/v1beta/openai/')) return 'google';
  if (s.startsWith('/v1beta/models') || s.startsWith('/gemini/')) return 'gemini';
  if (s.startsWith('/deepseek/')) return 'deepseek';
  if (s.startsWith('/groq/') || s.startsWith('/openai/v1/')) return 'groq';
  if (s.startsWith('/together/')) return 'together';
  if (s.startsWith('/fireworks/') || s.startsWith('/inference/v1/')) return 'fireworks';
  if (s.startsWith('/local-vllm/') || s.startsWith('/vllm/')) return 'local-vllm';
  if (s.startsWith('/local-ollama/') || s.startsWith('/ollama/') || s.startsWith('/api/generate') || s.startsWith('/api/chat')) return 'local-ollama';
  if (s.startsWith('/local-kolm/') || s.startsWith('/kolm-local/')) return 'local-kolm';
  return 'openai';
}

// Resolve a provider id to its forward() adapter. Returns null if no
// adapter is wired (callers should fail-soft with "provider not yet wired").
//
// Imports are deferred (dynamic) so that loading this module doesn't pay
// the cost of every adapter's IO surface on every CLI invocation. The
// gateway calls resolveAdapter once per request after pickProviderFromPath.
const _ADAPTER_LOADERS = Object.freeze({
  groq:           () => import('./providers/groq.js'),
  fireworks:      () => import('./providers/fireworks.js'),
  deepseek:       () => import('./providers/deepseek-native.js'),
  together:       () => import('./providers/together-hosted.js'),
  google:         () => import('./providers/google-native.js'),
  'local-vllm':   () => import('./providers/local-vllm.js'),
  'local-ollama': () => import('./providers/local-ollama.js'),
  'local-kolm':   () => import('./providers/local-kolm.js'),
});

export async function resolveAdapter(providerId) {
  const loader = _ADAPTER_LOADERS[providerId];
  if (!loader) return null;
  const mod = await loader();
  return mod && typeof mod.forward === 'function' ? mod : null;
}

// Provider ids the wrapper officially supports. Mirrors the 11-adapter
// list in the wrapper completion directive. Single source of truth for
// /v1/gateway/providers + the CLI `kolm gateway providers` command.
export const SUPPORTED_PROVIDER_IDS = Object.freeze([
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'groq',
  'together',
  'fireworks',
  'openrouter',
  'local-vllm',
  'local-ollama',
  'local-kolm',
]);

// Helper for the doctor verb: return a short summary keyed by provider id.
export function summarizeProviders() {
  const out = {};
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    const k = process.env[cfg.env_key] || '';
    out[id] = {
      env_key_set: !!k,
      env_key_name: cfg.env_key,
      upstream: cfg.upstream,
      auth: cfg.auth,
      paths: cfg.paths,
      model_count: Object.keys(cfg.cost_per_1k || {}).length,
    };
  }
  return out;
}

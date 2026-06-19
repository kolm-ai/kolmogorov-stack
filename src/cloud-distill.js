// W785 - Managed-distill cloud expansion.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 737-742):
//   [W785-1] Upload captures -> distill on Kolm-hosted infra -> download .kolm
//   [W785-2] Pay per distillation run, not per inference (separate metering)
//   [W785-3] Useful for users with inference HW but not training HW (landing)
//   [W785-4] /cloud.html landing page
//
// Honesty contract (W347 pattern, also applied W604):
//   Until a real Kolm-hosted worker pool is deployed and KOLM_CLOUD_DISTILL_ENDPOINT
//   points at it, submitJob returns state='queued' + cloud_backend_status='no_pool_configured'
//   unless KOLM_TRAINER_BRIDGE_URL points at an operator-managed trainer bridge.
//   We NEVER pretend a job ran when no backend exists. The TUI / landing page must
//   surface this state honestly so a user paying for a managed distill run knows
//   whether their bytes are actually moving.
//
// Why this is separate from src/distill-pipeline.js:
//   distill-pipeline.js runs LOCALLY on the operator's machine (consumes local
//   GPU, writes artifact to ~/.kolm/artifacts). cloud-distill.js QUEUES a job
//   for a remote pool to consume - the operator's machine never sees the GPU.
//   The two pipelines share the same .kolm output shape but the billing
//   meter is fundamentally different: training $/gpu-hr vs. inference $/1k-tokens.
//
// Why this is separate from src/cloud-compute-broker.js:
//   broker.js is a PLANNER (which lane should I rent?). cloud-distill.js is
//   the RUNTIME orchestrator that actually submits / polls / cancels jobs once
//   the operator has chosen the Kolm-hosted lane or configured a trainer bridge.
//
// Why this is separate from src/cloud-sync.js:
//   sync pushes captured rows to a shared namespace for team retrieval.
//   cloud-distill submits a TRAINING JOB - completely different lifecycle,
//   different billing meter, different durability story.
//
// Persistence:
//   ~/.kolm/cloud-distill-jobs.jsonl - append-only. Tenant-scoped reads.
//   Honors KOLM_DATA_DIR override (used by tests + airgap-mode).
//
// W604 anti-brittleness: consumers match /^w785-/ on the version stamp.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { planRemoteDistill } from './distill-runners/index.js';
import {
  submitSchedulerJob,
  cancelSchedulerJob,
  advanceSchedulerJobState,
  _resetSchedulerForTests,
} from './compute-scheduler.js';

export const CLOUD_DISTILL_VERSION = 'w785/w989-v2';

// Closed set of legal job lifecycle states. Frozen so a refactor cannot
// quietly add a new state without bumping the version stamp. queued is the
// initial state; succeeded / failed / cancelled are terminal.
export const CLOUD_DISTILL_STATES = Object.freeze([
  'queued', 'running', 'succeeded', 'failed', 'cancelled',
]);

// Backend status surfaces whether a real Kolm-hosted worker pool is
// reachable. 'no_pool_configured' is the honest default for self-hosted
// installs; 'reachable' requires KOLM_CLOUD_DISTILL_ENDPOINT to be set.
// 'reachable_via_bridge' means an operator-managed trainer bridge is
// configured: not a Kolm-hosted fleet, but a real dispatch target.
// 'simulated' is reserved for development envs that wire a stub pool.
export const CLOUD_BACKEND_STATUSES = Object.freeze([
  'no_pool_configured', 'reachable', 'reachable_via_bridge', 'reachable_via_provider', 'simulated', 'unreachable',
]);

export const MANAGED_DISTILL_PROVIDERS = Object.freeze(['runpod', 'modal', 'together']);

// Training meter is FUNDAMENTALLY different from inference meter:
//   - inference is per-1k-tokens (continuous, low-amplitude)
//   - training is per-gpu-hour (bursty, high-amplitude, single charge)
// Mixing them on one ledger is the bookkeeping trap that bit half the
// hyperscalers. Keep the rate table separate, document the unit, and
// emit a clearly-labeled meter row per run.
export const CLOUD_METER_RATES = Object.freeze({
  // USD per GPU-hour. Calibrated to mid-market managed-train pricing
  // (Together $1.20-2.00/hr H100, Modal $1.10/hr A100, Lambda $1.99/hr H100).
  // We expose the rate at the catalog level so the landing page can quote
  // honestly without reaching into Kolm's internal cost model.
  training_per_gpu_hour_usd: Object.freeze({
    'A100-40GB': 1.10,
    'A100-80GB': 1.65,
    'H100-80GB': 1.99,
    'H100-80GB-NVL': 2.40,
    'L40S-48GB': 1.10,
    'RTX-4090': 0.40,
    'RTX-5090': 0.55,
  }),
  // VRAM tier multipliers used when the chosen recipe needs higher
  // memory than the base SKU (e.g. context_tokens > 32k, batch > 8).
  vram_tier_multiplier: Object.freeze({
    '1x': 1.00,
    '2x': 1.85,  // sub-linear scaling - two GPUs share PCIe + scheduler overhead
    '4x': 3.50,
    '8x': 6.80,
  }),
  // Inference meter is documented here ONLY to make explicit that it is
  // a different ledger; the actual inference rates live in src/usage.js.
  inference_per_1k_tokens_usd_documented_in: 'src/usage.js',
  unit_training: 'gpu_hour',
  unit_inference: '1k_tokens',
});

// =============================================================================
// Filesystem layout
// =============================================================================

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _baseDir() {
  return process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
}

function _jobsPath() {
  return path.join(_baseDir(), 'cloud-distill-jobs.jsonl');
}

function _meterPath() {
  return path.join(_baseDir(), 'cloud-distill-meter.jsonl');
}

function _ensureDir() {
  const dir = _baseDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _appendLine(p, row) {
  _ensureDir();
  fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
}

function _readLines(p) {
  if (!fs.existsSync(p)) return [];
  let text;
  try { text = fs.readFileSync(p, 'utf8'); }
  catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return rows;
}

// _findRowsForTenant - reads append-only jobs.jsonl, returns rows for one
// tenant with status transitions collapsed (last write per job_id wins).
// W411 defense-in-depth: per-row tenant_id check after the read.
function _findRowsForTenant(tenant) {
  const rows = _readLines(_jobsPath()).filter((r) => r && r.tenant_id === tenant);
  // Status transitions are appended as fresh rows sharing job_id; the most
  // recent row per job_id wins. Walk forward and overwrite.
  const byId = new Map();
  for (const r of rows) {
    if (!r || !r.job_id) continue;
    byId.set(r.job_id, r);
  }
  // Newest first (createdAt descending).
  const out = Array.from(byId.values());
  out.sort((a, b) => {
    const ta = Date.parse(a.updated_at || a.created_at || '') || 0;
    const tb = Date.parse(b.updated_at || b.created_at || '') || 0;
    return tb - ta;
  });
  return out;
}

function _findOne(tenant, job_id) {
  if (!tenant || !job_id) return null;
  return _findRowsForTenant(tenant).find((r) => r.job_id === job_id) || null;
}

function _now() { return new Date().toISOString(); }
function _newJobId() { return 'cdj_' + crypto.randomBytes(8).toString('hex'); }

function _cleanBaseUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s ? s.replace(/\/+$/, '') : '';
}

function _publicBase() {
  return _cleanBaseUrl(process.env.PUBLIC_BASE || process.env.KOLM_PUBLIC_BASE || 'https://kolm.ai');
}

function _trainerBridgeUrl(opts) {
  const o = opts || {};
  return _cleanBaseUrl(o.trainer_bridge_url || process.env.KOLM_TRAINER_BRIDGE_URL || process.env.REM_LABS_BRIDGE_URL || '');
}

function _trainerBridgeToken(opts) {
  const o = opts || {};
  const token = o.trainer_bridge_token || process.env.KOLM_TRAINER_BRIDGE_TOKEN || process.env.REM_LABS_BRIDGE_TOKEN || '';
  return typeof token === 'string' && token.trim() ? token.trim() : '';
}

function _bridgePollUrl(base, body) {
  if (body && typeof body.status_url === 'string' && body.status_url.trim()) return body.status_url.trim();
  if (body && typeof body.poll_url === 'string' && body.poll_url.trim()) return body.poll_url.trim();
  if (body && typeof body.job_id === 'string' && body.job_id.trim()) {
    return _cleanBaseUrl(base) + '/jobs/' + encodeURIComponent(body.job_id.trim());
  }
  return null;
}

function _canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(_canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) =>
      JSON.stringify(k) + ':' + _canonicalJson(value[k])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function _sha256Json(value) {
  return crypto.createHash('sha256').update(_canonicalJson(value)).digest('hex');
}

function _managedProviderRaw(opts) {
  const o = opts || {};
  const raw = o.managed_provider || o.provider || process.env.KOLM_MANAGED_DISTILL_PROVIDER
    || process.env.KOLM_CLOUD_DISTILL_PROVIDER || '';
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
}

function _optOrEnv(opts, optKeys, envKeys) {
  const o = opts || {};
  for (const key of optKeys || []) {
    if (typeof o[key] === 'string' && o[key].trim()) return o[key].trim();
  }
  for (const key of envKeys || []) {
    if (typeof process.env[key] === 'string' && process.env[key].trim()) return process.env[key].trim();
  }
  return '';
}

function _managedProviderConfig(opts) {
  const provider = _managedProviderRaw(opts);
  if (!provider) return null;
  if (!MANAGED_DISTILL_PROVIDERS.includes(provider)) {
    return {
      provider,
      status: 'unreachable',
      error: 'invalid_managed_provider',
      missing_env: [],
      hint: 'managed provider must be one of ' + MANAGED_DISTILL_PROVIDERS.join(','),
    };
  }

  if (provider === 'runpod') {
    const token = _optOrEnv(opts, ['runpod_token', 'provider_token'], ['KOLM_RUNPOD_TOKEN', 'RUNPOD_API_KEY']);
    const endpointId = _optOrEnv(opts, ['runpod_endpoint_id', 'provider_endpoint_id'], [
      'KOLM_RUNPOD_DISTILL_ENDPOINT_ID',
      'KOLM_RUNPOD_ENDPOINT_ID',
      'RUNPOD_ENDPOINT_ID',
    ]);
    const missing = [];
    if (!token) missing.push('KOLM_RUNPOD_TOKEN');
    if (!endpointId) missing.push('KOLM_RUNPOD_DISTILL_ENDPOINT_ID');
    return {
      provider,
      status: missing.length ? 'unreachable' : 'reachable_via_provider',
      endpoint: endpointId || null,
      token,
      missing_env: missing,
      hint: missing.length
        ? 'set KOLM_RUNPOD_TOKEN and KOLM_RUNPOD_DISTILL_ENDPOINT_ID for managed cloud-distill dispatch'
        : 'RunPod managed distill endpoint configured',
    };
  }

  if (provider === 'modal') {
    const token = _optOrEnv(opts, ['modal_token', 'provider_token'], ['KOLM_MODAL_TOKEN', 'MODAL_TOKEN_ID']);
    const endpoint = _optOrEnv(opts, ['modal_distill_url', 'provider_endpoint'], ['KOLM_MODAL_DISTILL_URL']);
    const missing = [];
    if (!token) missing.push('KOLM_MODAL_TOKEN');
    if (!endpoint) missing.push('KOLM_MODAL_DISTILL_URL');
    return {
      provider,
      status: missing.length ? 'unreachable' : 'reachable_via_provider',
      endpoint: endpoint || null,
      token,
      missing_env: missing,
      hint: missing.length
        ? 'set KOLM_MODAL_TOKEN and KOLM_MODAL_DISTILL_URL for managed cloud-distill dispatch'
        : 'Modal distill HTTPS endpoint configured',
    };
  }

  const token = _optOrEnv(opts, ['together_token', 'provider_token'], ['KOLM_TOGETHER_TOKEN', 'TOGETHER_API_KEY']);
  const missing = [];
  if (!token) missing.push('KOLM_TOGETHER_TOKEN');
  return {
    provider,
    status: missing.length ? 'unreachable' : 'reachable_via_provider',
    endpoint: 'https://api.together.xyz/v1/fine-tunes',
    token,
    missing_env: missing,
    hint: missing.length
      ? 'set KOLM_TOGETHER_TOKEN for managed Together fine-tune dispatch'
      : 'Together managed fine-tune API configured; submit requires training_file_id or corpus_url',
  };
}

function _runnerGpuFromSku(gpuSku) {
  const sku = String(gpuSku || '').toUpperCase();
  if (sku.includes('H100')) return 'H100';
  if (sku.includes('H200')) return 'H200';
  if (sku.includes('B200') || sku.includes('GB200')) return 'B200';
  if (sku.includes('A100-40')) return 'A100-40GB';
  if (sku.includes('A100')) return 'A100-80GB';
  if (sku.includes('L40')) return 'L40S';
  if (sku.includes('4090')) return 'RTX4090';
  return null;
}

function _numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function _managedRecipe(opts, recipe_id) {
  const o = opts || {};
  const paramsB = _numOrNull(o.student_params_b ?? o.params_b ?? o.paramsB);
  return {
    id: recipe_id,
    student: typeof o.student === 'string' && o.student.trim()
      ? o.student.trim()
      : (typeof o.base_model === 'string' && o.base_model.trim() ? o.base_model.trim() : undefined),
    teacher: typeof o.teacher === 'string' && o.teacher.trim() ? o.teacher.trim() : undefined,
    mode: typeof o.mode === 'string' && o.mode.trim() ? o.mode.trim() : undefined,
    student_params_b: paramsB || undefined,
    params_b: paramsB || undefined,
  };
}

function _buildManagedProviderLaunch({ config, opts, recipe_id, gpu_sku, job_id }) {
  const provider = config && config.provider;
  const recipe = _managedRecipe(opts, recipe_id);
  const artifactOut = '/workspace/out/' + job_id;
  if (provider === 'runpod' || provider === 'modal') {
    const plan = planRemoteDistill({
      recipe,
      provider,
      gpu: _runnerGpuFromSku(gpu_sku),
      image: opts?.image,
      timeout_s: _numOrNull(opts?.timeout_s) || _numOrNull(opts?.timeout_seconds) || 3600,
      extraEnv: {
        KOLM_CLOUD_DISTILL_JOB_ID: job_id,
      },
    });
    const spec = plan && plan.spec ? { ...plan.spec } : null;
    if (spec && provider === 'runpod') spec.artifact_out = artifactOut;
    if (spec && provider === 'modal' && spec.function) {
      spec.function = { ...spec.function, env: { ...(spec.function.env || {}), KOLM_OUT_DIR: artifactOut } };
    }
    return {
      ok: !!(plan && plan.ok && spec),
      provider,
      recipe,
      plan_reason: plan?.reason || null,
      launch_spec: spec,
      launch_spec_hash: spec ? _sha256Json(spec) : null,
      error: plan && !plan.ok ? 'managed_provider_plan_not_fit' : null,
    };
  }
  const trainingFileId = _optOrEnv(opts, ['training_file_id', 'together_training_file_id'], ['KOLM_TOGETHER_TRAINING_FILE_ID']);
  const corpusUrl = _optOrEnv(opts, ['corpus_url', 'training_corpus_url'], ['KOLM_TRAINING_CORPUS_URL']);
  const spec = {
    provider: 'together',
    version: CLOUD_DISTILL_VERSION,
    training_file_id: trainingFileId || null,
    corpus_url: corpusUrl || null,
    model: recipe.student || opts?.base_model || 'Qwen/Qwen2.5-7B-Instruct',
    suffix: String(recipe_id || job_id).replace(/[^a-z0-9-]/gi, '').slice(0, 32) || 'kolm',
    n_epochs: Math.max(1, Math.trunc(Number(opts?.epochs || 3) || 3)),
    lora: true,
  };
  return {
    ok: !!(trainingFileId || corpusUrl),
    provider,
    recipe,
    plan_reason: trainingFileId || corpusUrl
      ? 'Together managed fine-tune request has a training file or corpus URL'
      : 'Together managed fine-tune requires training_file_id or corpus_url',
    launch_spec: spec,
    launch_spec_hash: _sha256Json(spec),
    error: trainingFileId || corpusUrl ? null : 'together_training_file_required',
  };
}

function _providerPollUrl(config, body) {
  if (body && typeof body.status_url === 'string' && body.status_url.trim()) return body.status_url.trim();
  if (body && typeof body.poll_url === 'string' && body.poll_url.trim()) return body.poll_url.trim();
  const jobId = body && (body.id || body.job_id || body.run_id || body.fine_tune_id);
  if (!jobId) return null;
  if (config.provider === 'runpod') {
    return 'https://api.runpod.ai/v2/' + encodeURIComponent(config.endpoint) + '/status/' + encodeURIComponent(String(jobId));
  }
  if (config.provider === 'together') {
    return 'https://api.together.xyz/v1/fine-tunes/' + encodeURIComponent(String(jobId));
  }
  return _cleanBaseUrl(config.endpoint) + '/jobs/' + encodeURIComponent(String(jobId));
}

async function _postTrainerBridge({ backend, token, job_id, scheduler_job_id, tenant, namespace, capture_window, recipe_id, gpu_sku, vram_tier, fetchImpl }) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  if (typeof doFetch !== 'function') {
    return { ok: false, error: 'fetch_unavailable', detail: 'global fetch is unavailable for trainer bridge submission' };
  }
  if (!token) {
    return {
      ok: false,
      error: 'trainer_bridge_token_missing',
      detail: 'KOLM_TRAINER_BRIDGE_URL is set but KOLM_TRAINER_BRIDGE_TOKEN (or REM_LABS_BRIDGE_TOKEN) is missing.',
    };
  }
  const endpoint = _cleanBaseUrl(backend.endpoint) + '/distill';
  const payload = {
    tenant,
    namespace,
    source: 'cloud-distill',
    cloud_distill_job_id: job_id,
    scheduler_job_id,
    capture_window,
    recipe_id,
    gpu_sku,
    vram_tier,
    callback_url: _publicBase() + '/v1/cloud/distill/' + encodeURIComponent(job_id),
  };
  let res;
  try {
    res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, error: 'trainer_bridge_unreachable', detail: String((e && e.message) || e) };
  }
  const text = await res.text().catch(() => '');
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { _raw: text }; }
  if (!res.ok) {
    return {
      ok: false,
      error: 'trainer_bridge_rejected',
      status: res.status,
      detail: (body && (body.error || body.detail || body.message)) || text || ('HTTP ' + res.status),
    };
  }
  return {
    ok: true,
    bridge_job_id: body && typeof body.job_id === 'string' && body.job_id ? body.job_id : null,
    bridge_status_url: _bridgePollUrl(backend.endpoint, body),
    bridge_response: body || {},
  };
}

async function _postManagedProvider({
  config,
  launch,
  job_id,
  scheduler_job_id,
  tenant,
  namespace,
  capture_window,
  recipe_id,
  gpu_sku,
  vram_tier,
  fetchImpl,
}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  if (typeof doFetch !== 'function') {
    return { ok: false, error: 'fetch_unavailable', detail: 'global fetch is unavailable for managed provider submission' };
  }
  if (!config || config.status !== 'reachable_via_provider') {
    return {
      ok: false,
      error: config?.error || 'managed_provider_not_configured',
      missing_env: config?.missing_env || [],
      detail: config?.hint || null,
    };
  }
  if (!launch || !launch.ok) {
    return {
      ok: false,
      error: launch?.error || 'managed_provider_plan_invalid',
      detail: launch?.plan_reason || null,
      launch_spec_hash: launch?.launch_spec_hash || null,
    };
  }

  const common = {
    tenant,
    namespace,
    source: 'cloud-distill',
    cloud_distill_job_id: job_id,
    scheduler_job_id,
    capture_window,
    recipe_id,
    gpu_sku,
    vram_tier,
    callback_url: _publicBase() + '/v1/cloud/distill/' + encodeURIComponent(job_id),
    launch_spec_hash: launch.launch_spec_hash,
    launch_spec: launch.launch_spec,
    expected_artifact: 'signed .kolm',
  };
  let endpoint;
  let init;
  if (config.provider === 'runpod') {
    endpoint = 'https://api.runpod.ai/v2/' + encodeURIComponent(config.endpoint) + '/run';
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ input: common }),
    };
  } else if (config.provider === 'modal') {
    endpoint = _cleanBaseUrl(config.endpoint);
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify(common),
    };
  } else {
    endpoint = 'https://api.together.xyz/v1/fine-tunes';
    const spec = launch.launch_spec || {};
    if (!spec.training_file_id && !spec.corpus_url) {
      return {
        ok: false,
        error: 'together_training_file_required',
        detail: 'Together managed fine-tune dispatch requires training_file_id or corpus_url.',
        launch_spec_hash: launch.launch_spec_hash,
      };
    }
    const body = {
      training_file: spec.training_file_id || spec.corpus_url,
      model: spec.model,
      n_epochs: spec.n_epochs,
      lora: true,
      suffix: spec.suffix,
      metadata: {
        source: 'cloud-distill',
        cloud_distill_job_id: job_id,
        scheduler_job_id,
        launch_spec_hash: launch.launch_spec_hash,
      },
    };
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
    };
  }

  let res;
  try {
    res = await doFetch(endpoint, init);
  } catch (e) {
    return { ok: false, error: 'managed_provider_unreachable', detail: String((e && e.message) || e) };
  }
  const text = await res.text().catch(() => '');
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { _raw: text }; }
  if (!res.ok) {
    return {
      ok: false,
      error: 'managed_provider_rejected',
      provider: config.provider,
      status: res.status,
      detail: (body && (body.error || body.detail || body.message)) || text || ('HTTP ' + res.status),
      launch_spec_hash: launch.launch_spec_hash,
    };
  }
  const providerJobId = body && (body.id || body.job_id || body.run_id || body.fine_tune_id) || null;
  return {
    ok: true,
    managed_provider: config.provider,
    provider_job_id: providerJobId ? String(providerJobId) : null,
    provider_status_url: _providerPollUrl(config, body),
    poll_url: _providerPollUrl(config, body),
    launch_spec_hash: launch.launch_spec_hash,
    provider_response_keys: body && typeof body === 'object' ? Object.keys(body).sort().slice(0, 30) : [],
  };
}

// _backendStatus - the honesty check. Returns the current backend status
// based on env vars + opts (DI seam for tests). If KOLM_CLOUD_DISTILL_ENDPOINT
// is unset, but KOLM_TRAINER_BRIDGE_URL is set, the job can dispatch through
// that operator-managed trainer bridge. If both are unset, status is
// 'no_pool_configured' and submitJob queues the work but flags it openly. If
// the env var is set to 'simulated://...', we surface 'simulated' so tests +
// dev can route work without pretending it ran.
export function getCloudBackendStatus(opts) {
  const o = opts || {};
  const explicit = (typeof o.backend_endpoint === 'string' && o.backend_endpoint)
    ? o.backend_endpoint
    : (process.env.KOLM_CLOUD_DISTILL_ENDPOINT || '');
  const bridge = _trainerBridgeUrl(o);
  if (!explicit) {
    const managed = _managedProviderConfig(o);
    if (managed) {
      return {
        status: managed.status,
        endpoint: managed.endpoint || null,
        hint: managed.hint,
        managed_provider: managed.provider,
        provider_source: 'managed_distill_provider',
        missing_env: managed.missing_env || [],
        error: managed.error || null,
        version: CLOUD_DISTILL_VERSION,
      };
    }
    if (bridge) {
      const hasToken = !!_trainerBridgeToken(o);
      return {
        status: hasToken ? 'reachable_via_bridge' : 'unreachable',
        endpoint: bridge,
        hint: hasToken
          ? 'operator-managed trainer bridge configured; not a Kolm-hosted worker pool'
          : 'set KOLM_TRAINER_BRIDGE_TOKEN when KOLM_TRAINER_BRIDGE_URL is configured',
        bridge_source: 'remote_trainer',
        version: CLOUD_DISTILL_VERSION,
      };
    }
    return {
      status: 'no_pool_configured',
      endpoint: null,
      hint: 'set KOLM_CLOUD_DISTILL_ENDPOINT to enable the managed pool, or KOLM_TRAINER_BRIDGE_URL to use an operator-managed trainer bridge',
      version: CLOUD_DISTILL_VERSION,
    };
  }
  if (explicit.startsWith('simulated://')) {
    return {
      status: 'simulated',
      endpoint: explicit,
      hint: 'simulated backend - jobs lifecycle is in-process only',
      version: CLOUD_DISTILL_VERSION,
    };
  }
  return {
    status: 'reachable',
    endpoint: explicit,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// submitJob
//
// Creates a queued job row. Returns the job_id + initial meter row + the
// honest backend status. The job remains in 'queued' state until either
//   (a) a real backend POSTs a /v1/cloud/distill/:job_id status update, or
//   (b) advanceJobState is called locally (for tests / simulated backends).
// =============================================================================
export async function submitJob(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const namespace = (typeof o.namespace === 'string' && o.namespace) ? o.namespace : 'default';
  const capture_window = (typeof o.capture_window === 'string' && o.capture_window)
    ? o.capture_window
    : '7d';
  const recipe_id = (typeof o.recipe_id === 'string' && o.recipe_id)
    ? o.recipe_id
    : 'default-distill';
  const billing_token = (typeof o.billing_token === 'string' && o.billing_token)
    ? o.billing_token
    : null;
  // Optional cost-quote knobs. We do NOT charge here - submitJob is
  // 'reserve a slot'. The actual meter row is written by meterRun once
  // the backend reports gpu_seconds.
  const gpu_sku = (typeof o.gpu_sku === 'string' && o.gpu_sku) ? o.gpu_sku : 'H100-80GB';
  const vram_tier = (typeof o.vram_tier === 'string' && o.vram_tier) ? o.vram_tier : '1x';

  if (!CLOUD_METER_RATES.training_per_gpu_hour_usd[gpu_sku]) {
    return {
      ok: false,
      error: 'unknown_gpu_sku',
      hint: 'gpu_sku must be one of ' + Object.keys(CLOUD_METER_RATES.training_per_gpu_hour_usd).join(','),
      supported: Object.keys(CLOUD_METER_RATES.training_per_gpu_hour_usd),
      version: CLOUD_DISTILL_VERSION,
    };
  }
  if (!CLOUD_METER_RATES.vram_tier_multiplier[vram_tier]) {
    return {
      ok: false,
      error: 'unknown_vram_tier',
      hint: 'vram_tier must be one of ' + Object.keys(CLOUD_METER_RATES.vram_tier_multiplier).join(','),
      supported: Object.keys(CLOUD_METER_RATES.vram_tier_multiplier),
      version: CLOUD_DISTILL_VERSION,
    };
  }

  const backend = getCloudBackendStatus(o);
  if (backend.status === 'unreachable' && backend.bridge_source === 'remote_trainer') {
    return {
      ok: false,
      error: 'trainer_bridge_token_missing',
      detail: 'KOLM_TRAINER_BRIDGE_URL is set but KOLM_TRAINER_BRIDGE_TOKEN (or REM_LABS_BRIDGE_TOKEN) is missing.',
      cloud_backend_status: backend.status,
      cloud_backend_endpoint: backend.endpoint,
      version: CLOUD_DISTILL_VERSION,
    };
  }
  if (backend.status === 'unreachable' && backend.provider_source === 'managed_distill_provider') {
    return {
      ok: false,
      error: backend.error || 'managed_provider_not_configured',
      detail: backend.hint || null,
      missing_env: backend.missing_env || [],
      managed_provider: backend.managed_provider || null,
      cloud_backend_status: backend.status,
      cloud_backend_endpoint: backend.endpoint,
      version: CLOUD_DISTILL_VERSION,
    };
  }
  const now = _now();
  const job_id = _newJobId();
  const usesBridge = backend.status === 'reachable_via_bridge';
  const usesManagedProvider = backend.status === 'reachable_via_provider';
  const managedProviderConfig = usesManagedProvider ? _managedProviderConfig(o) : null;
  const managedLaunch = usesManagedProvider
    ? _buildManagedProviderLaunch({ config: managedProviderConfig, opts: o, recipe_id, gpu_sku, job_id })
    : null;
  if (usesManagedProvider && (!managedLaunch || !managedLaunch.ok)) {
    return {
      ok: false,
      error: managedLaunch?.error || 'managed_provider_plan_invalid',
      detail: managedLaunch?.plan_reason || null,
      managed_provider: backend.managed_provider || managedProviderConfig?.provider || null,
      launch_spec_hash: managedLaunch?.launch_spec_hash || null,
      version: CLOUD_DISTILL_VERSION,
    };
  }
  const scheduler_idempotency_key = (typeof o.idempotency_key === 'string' && o.idempotency_key)
    ? o.idempotency_key
    : null;
  const schedulerLane = backend.status === 'no_pool_configured'
    ? 'managed-distill-pool-unconfigured'
    : (usesBridge ? 'managed-distill-trainer-bridge'
      : (usesManagedProvider ? 'managed-distill-provider-' + managedProviderConfig.provider : 'managed-distill-pool'));
  const scheduler = submitSchedulerJob({
    tenant,
    family: 'cloud-distill',
    operation: 'distill',
    idempotency_key: scheduler_idempotency_key,
    priority: o.priority || o.plan_tier,
    lane: schedulerLane,
    estimated_cost_usd: o.estimated_cost_usd,
    budget_usd: o.budget_usd,
    max_attempts: o.max_attempts || 3,
    payload: {
      namespace,
      capture_window,
      recipe_id,
      gpu_sku,
      vram_tier,
      cloud_backend_status: backend.status,
      cloud_backend_endpoint: backend.endpoint,
      managed_provider: managedProviderConfig?.provider || null,
      managed_provider_launch_spec_hash: managedLaunch?.launch_spec_hash || null,
      managed_provider_launch_spec: managedLaunch?.launch_spec || null,
    },
    labels: {
      source: 'cloud-distill',
      backend_status: backend.status,
      managed_provider: managedProviderConfig?.provider || null,
    },
    lineage: {
      cloud_distill_job_id: job_id,
      meter_ledger: 'training',
      managed_provider_launch_spec_hash: managedLaunch?.launch_spec_hash || null,
    },
  });
  if (!scheduler.ok) {
    return {
      ok: false,
      error: scheduler.error || 'scheduler_rejected',
      scheduler,
      version: CLOUD_DISTILL_VERSION,
    };
  }
  if (scheduler.idempotent_replay) {
    const existing_id = scheduler.job?.lineage?.cloud_distill_job_id || null;
    const existing = existing_id ? _findOne(tenant, existing_id) : null;
    if (existing) {
      return {
        ok: true,
        created: false,
        idempotent_replay: true,
        job_id: existing.job_id,
        state: existing.state,
        cloud_backend_status: existing.cloud_backend_status,
        cloud_backend_endpoint: existing.cloud_backend_endpoint,
        bridge_source: existing.bridge_source || null,
        bridge_job_id: existing.bridge_job_id || null,
        bridge_status_url: existing.bridge_status_url || null,
        managed_provider: existing.managed_provider || null,
        provider_job_id: existing.provider_job_id || null,
        provider_status_url: existing.provider_status_url || null,
        managed_provider_launch_spec_hash: existing.managed_provider_launch_spec_hash || null,
        poll_url: existing.poll_url || existing.provider_status_url || existing.bridge_status_url || null,
        scheduler_job_id: scheduler.job_id,
        scheduler_state: scheduler.job?.state || null,
        namespace: existing.namespace,
        capture_window: existing.capture_window,
        recipe_id: existing.recipe_id,
        gpu_sku: existing.gpu_sku,
        vram_tier: existing.vram_tier,
        rate_per_gpu_hour_usd: CLOUD_METER_RATES.training_per_gpu_hour_usd[existing.gpu_sku]
          * CLOUD_METER_RATES.vram_tier_multiplier[existing.vram_tier],
        created_at: existing.created_at,
        version: CLOUD_DISTILL_VERSION,
      };
    }
  }
  let bridge = null;
  if (usesBridge) {
    bridge = await _postTrainerBridge({
      backend,
      token: _trainerBridgeToken(o),
      job_id,
      scheduler_job_id: scheduler.job_id,
      tenant,
      namespace,
      capture_window,
      recipe_id,
      gpu_sku,
      vram_tier,
      fetchImpl: o.fetchImpl,
    });
  }
  let providerDispatch = null;
  if (usesManagedProvider) {
    providerDispatch = await _postManagedProvider({
      config: managedProviderConfig,
      launch: managedLaunch,
      job_id,
      scheduler_job_id: scheduler.job_id,
      tenant,
      namespace,
      capture_window,
      recipe_id,
      gpu_sku,
      vram_tier,
      fetchImpl: o.fetchImpl,
    });
  }
  const row = {
    job_id,
    tenant_id: tenant,
    namespace,
    capture_window,
    recipe_id,
    billing_token,  // we never echo back the secret; persisted for audit only
    gpu_sku,
    vram_tier,
    state: 'queued',
    cloud_backend_status: (bridge && !bridge.ok) || (providerDispatch && !providerDispatch.ok) ? 'unreachable' : backend.status,
    cloud_backend_endpoint: backend.endpoint,
    bridge_source: usesBridge ? 'remote_trainer' : null,
    bridge_job_id: bridge && bridge.ok ? bridge.bridge_job_id : null,
    bridge_status_url: bridge && bridge.ok ? bridge.bridge_status_url : null,
    managed_provider: managedProviderConfig?.provider || null,
    provider_job_id: providerDispatch && providerDispatch.ok ? providerDispatch.provider_job_id : null,
    provider_status_url: providerDispatch && providerDispatch.ok ? providerDispatch.provider_status_url : null,
    managed_provider_launch_spec_hash: managedLaunch?.launch_spec_hash || null,
    poll_url: providerDispatch && providerDispatch.ok
      ? providerDispatch.poll_url
      : (bridge && bridge.ok ? bridge.bridge_status_url : null),
    scheduler_job_id: scheduler.job_id,
    scheduler_state: scheduler.job?.state || 'queued',
    artifact_url: null,
    error: bridge && !bridge.ok
      ? (bridge.error || 'trainer_bridge_error')
      : (providerDispatch && !providerDispatch.ok ? (providerDispatch.error || 'managed_provider_error') : null),
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
    submitted_by: typeof o.submitted_by === 'string' ? o.submitted_by : tenant,
    version: CLOUD_DISTILL_VERSION,
  };
  if ((bridge && !bridge.ok) || (providerDispatch && !providerDispatch.ok)) {
    row.state = 'failed';
    row.finished_at = now;
    try {
      advanceSchedulerJobState({
        tenant,
        job_id: scheduler.job_id,
        state: 'dead_letter',
        error: row.error,
        reason: providerDispatch && !providerDispatch.ok ? 'managed_provider_submit_failed' : 'trainer_bridge_submit_failed',
      });
      row.scheduler_state = 'dead_letter';
    } catch (_) {
      // The cloud-distill failure row remains authoritative.
    }
  }
  _appendLine(_jobsPath(), row);

  // Initial meter row - $0 reserved, units to be filled in by meterRun once
  // the backend reports gpu_seconds. We write this NOW so the meter ledger
  // is paired 1:1 with the job ledger from the start (auditability).
  const meter_initial = {
    job_id: row.job_id,
    tenant_id: tenant,
    namespace,
    kind: 'training_reservation',
    gpu_sku,
    vram_tier,
    gpu_seconds: 0,
    cost_usd: 0,
    rate_per_gpu_hour_usd: CLOUD_METER_RATES.training_per_gpu_hour_usd[gpu_sku]
      * CLOUD_METER_RATES.vram_tier_multiplier[vram_tier],
    ts: now,
    version: CLOUD_DISTILL_VERSION,
  };
  _appendLine(_meterPath(), meter_initial);

  if ((bridge && !bridge.ok) || (providerDispatch && !providerDispatch.ok)) {
    const failed = providerDispatch && !providerDispatch.ok ? providerDispatch : bridge;
    return {
      ok: false,
      error: failed.error || (providerDispatch ? 'managed_provider_error' : 'trainer_bridge_error'),
      detail: failed.detail || null,
      status: failed.status || null,
      job_id: row.job_id,
      state: row.state,
      cloud_backend_status: row.cloud_backend_status,
      cloud_backend_endpoint: row.cloud_backend_endpoint,
      managed_provider: row.managed_provider,
      launch_spec_hash: row.managed_provider_launch_spec_hash,
      scheduler_job_id: scheduler.job_id,
      scheduler_state: row.scheduler_state,
      version: CLOUD_DISTILL_VERSION,
    };
  }

  return {
    ok: true,
    job_id: row.job_id,
    state: 'queued',
    cloud_backend_status: backend.status,
    cloud_backend_endpoint: backend.endpoint,
    bridge_source: row.bridge_source,
    bridge_job_id: row.bridge_job_id,
    bridge_status_url: row.bridge_status_url,
    managed_provider: row.managed_provider,
    provider_job_id: row.provider_job_id,
    provider_status_url: row.provider_status_url,
    managed_provider_launch_spec_hash: row.managed_provider_launch_spec_hash,
    poll_url: row.poll_url,
    scheduler_job_id: scheduler.job_id,
    scheduler_state: scheduler.job?.state || 'queued',
    meter_initial,
    namespace,
    capture_window,
    recipe_id,
    gpu_sku,
    vram_tier,
    rate_per_gpu_hour_usd: meter_initial.rate_per_gpu_hour_usd,
    created_at: now,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// getJobStatus
//
// Tenant-fenced read. Returns the latest row for one job_id or
// {ok:false, error:'not_found'}. Foreign-tenant lookups return not_found
// (never reveal that a job exists under another tenant).
// =============================================================================
export function getJobStatus(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const job_id = (typeof o.job_id === 'string' && o.job_id) ? o.job_id : null;
  if (!job_id) {
    return { ok: false, error: 'job_id_required', version: CLOUD_DISTILL_VERSION };
  }
  const row = _findOne(tenant, job_id);
  if (!row) {
    return { ok: false, error: 'not_found', version: CLOUD_DISTILL_VERSION };
  }
  return {
    ok: true,
    job_id,
    tenant_id: row.tenant_id,
    namespace: row.namespace,
    state: row.state,
    cloud_backend_status: row.cloud_backend_status,
    cloud_backend_endpoint: row.cloud_backend_endpoint,
    bridge_source: row.bridge_source || null,
    bridge_job_id: row.bridge_job_id || null,
    bridge_status_url: row.bridge_status_url || null,
    managed_provider: row.managed_provider || null,
    provider_job_id: row.provider_job_id || null,
    provider_status_url: row.provider_status_url || null,
    managed_provider_launch_spec_hash: row.managed_provider_launch_spec_hash || null,
    poll_url: row.poll_url || row.provider_status_url || row.bridge_status_url || null,
    scheduler_job_id: row.scheduler_job_id || null,
    scheduler_state: row.scheduler_state || null,
    artifact_url: row.artifact_url,
    error: row.error,
    gpu_sku: row.gpu_sku,
    vram_tier: row.vram_tier,
    capture_window: row.capture_window,
    recipe_id: row.recipe_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// cancelJob
//
// Tenant-fenced. Cancels a queued/running job by appending a cancelled row.
// Cannot cancel terminal states (succeeded/failed/already-cancelled).
// =============================================================================
export function cancelJob(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const job_id = (typeof o.job_id === 'string' && o.job_id) ? o.job_id : null;
  if (!job_id) {
    return { ok: false, error: 'job_id_required', version: CLOUD_DISTILL_VERSION };
  }
  const current = _findOne(tenant, job_id);
  if (!current) {
    return { ok: false, error: 'not_found', version: CLOUD_DISTILL_VERSION };
  }
  if (current.state === 'succeeded' || current.state === 'failed' || current.state === 'cancelled') {
    return {
      ok: false,
      error: 'invalid_transition',
      hint: 'job is already ' + current.state + '; only queued or running jobs can be cancelled',
      current_state: current.state,
      version: CLOUD_DISTILL_VERSION,
    };
  }
  const now = _now();
  const reason = (typeof o.reason === 'string' && o.reason) ? o.reason.slice(0, 500) : '';
  const next = Object.assign({}, current, {
    state: 'cancelled',
    updated_at: now,
    finished_at: now,
    cancel_reason: reason,
  });
  _appendLine(_jobsPath(), next);
  if (current.scheduler_job_id) {
    try {
      cancelSchedulerJob({
        tenant,
        job_id: current.scheduler_job_id,
        reason,
      });
    } catch (_) {
      // The cloud-distill cancellation remains authoritative for this ledger;
      // scheduler cancellation is best-effort if the scheduler file was pruned.
    }
  }
  return {
    ok: true,
    job_id,
    state: 'cancelled',
    cancelled_at: now,
    reason,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// listJobs
//
// Tenant-fenced list with optional status + namespace filter + limit. Newest
// first. status filter must be one of CLOUD_DISTILL_STATES.
// =============================================================================
export function listJobs(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const status = (typeof o.status === 'string' && o.status) ? o.status : null;
  if (status && !CLOUD_DISTILL_STATES.includes(status)) {
    return {
      ok: false,
      error: 'invalid_status_filter',
      hint: 'status must be one of ' + CLOUD_DISTILL_STATES.join(','),
      supported: CLOUD_DISTILL_STATES,
      version: CLOUD_DISTILL_VERSION,
    };
  }
  const namespace = (typeof o.namespace === 'string' && o.namespace) ? o.namespace : null;
  const limitRaw = Number(o.limit);
  const limit = (Number.isFinite(limitRaw) && limitRaw > 0)
    ? Math.min(500, Math.trunc(limitRaw))
    : 100;

  let rows = _findRowsForTenant(tenant);
  if (namespace) rows = rows.filter((r) => r.namespace === namespace);
  if (status) rows = rows.filter((r) => r.state === status);
  const sliced = rows.slice(0, limit);
  return {
    ok: true,
    tenant_id: tenant,
    count: sliced.length,
    total_for_tenant: rows.length,
    status_filter: status,
    namespace_filter: namespace,
    jobs: sliced,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// meterRun
//
// Append a meter row for a completed (or partial) run. Computes cost from
// gpu_seconds * rate_per_gpu_hour. Tenant-fenced. NEVER auto-charges - this
// is a ledger write only; downstream billing reconciles against it.
//
// Charges are kept SEPARATE from inference meter (src/usage.js) so a finance
// team can pivot training spend vs inference spend without re-categorizing.
// =============================================================================
export function meterRun(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const job_id = (typeof o.job_id === 'string' && o.job_id) ? o.job_id : null;
  if (!job_id) {
    return { ok: false, error: 'job_id_required', version: CLOUD_DISTILL_VERSION };
  }
  const gpu_seconds_raw = Number(o.gpu_seconds);
  if (!Number.isFinite(gpu_seconds_raw) || gpu_seconds_raw < 0) {
    return {
      ok: false,
      error: 'invalid_gpu_seconds',
      hint: 'gpu_seconds must be a non-negative number',
      version: CLOUD_DISTILL_VERSION,
    };
  }
  const job = _findOne(tenant, job_id);
  if (!job) {
    return { ok: false, error: 'not_found', version: CLOUD_DISTILL_VERSION };
  }
  const rate = CLOUD_METER_RATES.training_per_gpu_hour_usd[job.gpu_sku]
    * CLOUD_METER_RATES.vram_tier_multiplier[job.vram_tier];
  const cost_usd = (gpu_seconds_raw / 3600) * rate;

  // vram_gb is informational - we record it but do not charge on it
  // separately (cost is gpu_sku * vram_tier * gpu_seconds).
  const vram_gb_raw = Number(o.vram_gb);
  const vram_gb = Number.isFinite(vram_gb_raw) ? vram_gb_raw : null;

  const row = {
    job_id,
    tenant_id: tenant,
    namespace: job.namespace,
    kind: 'training_run',
    gpu_sku: job.gpu_sku,
    vram_tier: job.vram_tier,
    gpu_seconds: gpu_seconds_raw,
    vram_gb,
    cost_usd,
    rate_per_gpu_hour_usd: rate,
    ts: _now(),
    version: CLOUD_DISTILL_VERSION,
  };
  _appendLine(_meterPath(), row);
  return {
    ok: true,
    job_id,
    gpu_seconds: gpu_seconds_raw,
    vram_gb,
    cost_usd,
    rate_per_gpu_hour_usd: rate,
    unit: CLOUD_METER_RATES.unit_training,
    ledger: 'training',  // explicit separator from 'inference' ledger
    ts: row.ts,
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// readMeter
//
// Tenant-fenced read of all meter rows for one job. Returns the aggregate
// (sum of cost_usd + sum of gpu_seconds) so the dashboard can show
// "spent so far: $4.12 over 12 GPU-min".
// =============================================================================
export function readMeter(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const job_id = (typeof o.job_id === 'string' && o.job_id) ? o.job_id : null;
  if (!job_id) {
    return { ok: false, error: 'job_id_required', version: CLOUD_DISTILL_VERSION };
  }
  // Tenant fence: only count rows whose tenant_id matches AND whose job_id matches.
  const rows = _readLines(_meterPath()).filter((r) =>
    r && r.tenant_id === tenant && r.job_id === job_id);
  let total_gpu_seconds = 0;
  let total_cost_usd = 0;
  for (const r of rows) {
    total_gpu_seconds += Number(r.gpu_seconds) || 0;
    total_cost_usd += Number(r.cost_usd) || 0;
  }
  return {
    ok: true,
    job_id,
    rows,
    total_gpu_seconds,
    total_cost_usd,
    unit: CLOUD_METER_RATES.unit_training,
    ledger: 'training',
    version: CLOUD_DISTILL_VERSION,
  };
}

// =============================================================================
// advanceJobState
//
// Test seam + simulated-backend hook. The real backend pushes status via
// HTTP; for now we expose this so tests can drive the lifecycle. Tenant-fenced.
// =============================================================================
export function advanceJobState(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return { ok: false, error: 'tenant_required', version: CLOUD_DISTILL_VERSION };
  }
  const job_id = (typeof o.job_id === 'string' && o.job_id) ? o.job_id : null;
  if (!job_id) {
    return { ok: false, error: 'job_id_required', version: CLOUD_DISTILL_VERSION };
  }
  const next_state = (typeof o.state === 'string' && o.state) ? o.state : null;
  if (!next_state || !CLOUD_DISTILL_STATES.includes(next_state)) {
    return {
      ok: false,
      error: 'invalid_state',
      hint: 'state must be one of ' + CLOUD_DISTILL_STATES.join(','),
      version: CLOUD_DISTILL_VERSION,
    };
  }
  const current = _findOne(tenant, job_id);
  if (!current) {
    return { ok: false, error: 'not_found', version: CLOUD_DISTILL_VERSION };
  }
  const now = _now();
  const next = Object.assign({}, current, {
    state: next_state,
    updated_at: now,
    started_at: current.started_at || (next_state === 'running' ? now : current.started_at),
    finished_at: (next_state === 'succeeded' || next_state === 'failed' || next_state === 'cancelled')
      ? now
      : current.finished_at,
    artifact_url: typeof o.artifact_url === 'string' ? o.artifact_url : current.artifact_url,
    error: typeof o.error === 'string' ? o.error : current.error,
    scheduler_state: next_state === 'running'
      ? 'running'
      : (next_state === 'succeeded' ? 'succeeded'
        : (next_state === 'failed' ? 'dead_letter'
          : (next_state === 'cancelled' ? 'cancelled' : current.scheduler_state))),
  });
  _appendLine(_jobsPath(), next);
  if (current.scheduler_job_id) {
    const schedulerState = next_state === 'failed' ? 'dead_letter' : next.scheduler_state;
    try {
      advanceSchedulerJobState({
        tenant,
        job_id: current.scheduler_job_id,
        state: schedulerState,
        result: next_state === 'succeeded' ? { artifact_url: next.artifact_url } : null,
        error: next.error || null,
        reason: 'cloud_distill_state_update',
      });
    } catch (_) {
      // Keep the cloud-distill transition append-only even if the scheduler
      // file was pruned or repaired separately.
    }
  }
  return {
    ok: true,
    job_id,
    state: next_state,
    updated_at: now,
    version: CLOUD_DISTILL_VERSION,
  };
}

// Reset hook for tests - wipes only the W785 ledgers, never the broader
// .kolm data dir.
export function _resetForTests() {
  for (const p of [_jobsPath(), _meterPath()]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
  try { _resetSchedulerForTests(); } catch { /* ignore */ }
}

export default {
  CLOUD_DISTILL_VERSION,
  CLOUD_DISTILL_STATES,
  CLOUD_BACKEND_STATUSES,
  CLOUD_METER_RATES,
  MANAGED_DISTILL_PROVIDERS,
  getCloudBackendStatus,
  submitJob,
  getJobStatus,
  cancelJob,
  listJobs,
  meterRun,
  readMeter,
  advanceJobState,
  _resetForTests,
};

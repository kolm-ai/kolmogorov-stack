// Edge runtime: query planner → vector first-pass → parallel WASM/JS executor → composer → cache.

import { getVersion, getHead, searchSimilar } from './registry.js';
import { compileJs, compileWasm } from './verifier.js';
import { compose } from './composer.js';
import * as cache from './cache.js';
import { insert } from './store.js';
import { appendEvent } from './event-store.js';
import { detectMemoryHierarchy, placementDecision, PLACEMENT_VERSION } from './runtime-placement.js';
import { analyzeInferencePatterns, preloadDecision, PRELOAD_VERSION } from './runtime-preload.js';
import { estimatePerformance, PERF_VERSION } from './runtime-perf-estimate.js';

const compiledCache = new Map();
let cleanupTimer = null;
const COMPILED_TTL_MS = 10 * 60 * 1000;
let runtimeHierarchyPromise = null;

export const RUNTIME_PLANNING_VERSION = 'w976-runtime-planning-v1';

function getCompiled(version) {
  const k = version.id;
  const now = Date.now();
  if (compiledCache.has(k)) {
    const entry = compiledCache.get(k);
    entry.touchedAt = now;
    return entry.fn;
  }
  let fn;
  if (version.source.startsWith('WASM:')) {
    // base64 wasm bytes after WASM:
    fn = null; // resolved async via runVersion
  } else {
    fn = compileJs(version.source);
  }
  compiledCache.set(k, { fn, touchedAt: now });
  scheduleCleanup();
  return fn;
}

function runtimeFallbackHierarchy(reason = 'runtime_detection_failed') {
  return {
    gpu: [],
    system_ram_gb: 0,
    system_ram_free_gb: 0,
    nvme_bandwidth_mbps_estimate: null,
    source: reason,
    version: PLACEMENT_VERSION,
  };
}

async function detectRuntimeHierarchy({ diskProbe = process.env.KOLM_RUNTIME_DISK_PROBE === '1' } = {}) {
  const prior = Object.prototype.hasOwnProperty.call(process.env, 'KOLM_NO_DISK_PROBE')
    ? process.env.KOLM_NO_DISK_PROBE
    : undefined;
  if (!diskProbe && prior === undefined) process.env.KOLM_NO_DISK_PROBE = '1';
  try {
    return await detectMemoryHierarchy();
  } finally {
    if (!diskProbe && prior === undefined) delete process.env.KOLM_NO_DISK_PROBE;
    else if (!diskProbe) process.env.KOLM_NO_DISK_PROBE = prior;
  }
}

export async function getRuntimeHierarchy(opts = {}) {
  if (!runtimeHierarchyPromise || opts.refresh === true) {
    runtimeHierarchyPromise = detectRuntimeHierarchy(opts).catch(() => runtimeFallbackHierarchy());
  }
  return runtimeHierarchyPromise;
}

export function resetRuntimePlanningForTests() {
  runtimeHierarchyPromise = null;
}

function versionArtifactSizeGb(version = {}) {
  const evaluation = version.evaluation && typeof version.evaluation === 'object'
    ? version.evaluation
    : {};
  const direct = [
    version.artifact_size_gb,
    version.size_gb,
    evaluation.artifact_size_gb,
    evaluation.size_gb,
  ].map(Number).find((n) => Number.isFinite(n) && n > 0);
  if (direct != null) return Number(direct.toFixed(6));

  const bytes = [
    version.size_bytes,
    version.artifact_size_bytes,
    evaluation.size_bytes,
    evaluation.artifact_size_bytes,
  ].map(Number).find((n) => Number.isFinite(n) && n > 0);
  if (bytes != null) return Number((bytes / 1024 / 1024 / 1024).toFixed(6));

  const sourceBytes = Buffer.byteLength(String(version.source || ''), 'utf8');
  return Number(Math.max(0.000001, sourceBytes / 1024 / 1024 / 1024).toFixed(6));
}

function versionArtifactId(version = {}) {
  const evaluation = version.evaluation && typeof version.evaluation === 'object'
    ? version.evaluation
    : {};
  return version.model_id
    || version.model
    || version.base_model
    || evaluation.model_id
    || evaluation.model
    || version.id
    || null;
}

function versionQuant(version = {}) {
  const evaluation = version.evaluation && typeof version.evaluation === 'object'
    ? version.evaluation
    : {};
  return version.quant
    || version.quantization
    || evaluation.quant
    || evaluation.quantization
    || null;
}

function emptyPreloadAnalysis(reason, window_hours = 24) {
  return {
    top_artifacts: [],
    confidence: 0,
    transition_count: 0,
    window_hours,
    reason,
    version: PRELOAD_VERSION,
  };
}

export async function buildRuntimeExecutionPlan(opts = {}) {
  const version = opts.version || {};
  const tenant = opts.tenant || null;
  const namespace = opts.namespace || version.concept_id || 'runtime';
  const current_artifact_id = opts.current_artifact_id || version.id || null;
  const hierarchy = opts.hierarchy || await getRuntimeHierarchy(opts);
  const artifact_size_gb = versionArtifactSizeGb(version);
  const placement = placementDecision({ artifact_size_gb, hierarchy });

  let preloadAnalysis = opts.preloadAnalysis || null;
  if (!preloadAnalysis) {
    if (!tenant) {
      preloadAnalysis = emptyPreloadAnalysis('no_tenant', opts.window_hours || 24);
    } else {
      try {
        preloadAnalysis = await analyzeInferencePatterns({
          tenant,
          namespace,
          window_hours: opts.window_hours || 24,
        });
      } catch {
        preloadAnalysis = emptyPreloadAnalysis('event_store_error', opts.window_hours || 24);
      }
    }
  }
  const preload_plan = preloadDecision({
    current_artifact_id,
    hierarchy,
    top_artifacts: preloadAnalysis.top_artifacts || [],
  });
  const perf_estimate = estimatePerformance({
    artifact_id: versionArtifactId(version),
    placement: placement.decision,
    hierarchy,
    quant: versionQuant(version),
  });

  return {
    version: RUNTIME_PLANNING_VERSION,
    artifact_id: current_artifact_id,
    artifact_size_gb,
    hierarchy,
    placement,
    preload: {
      analysis: preloadAnalysis,
      plan: preload_plan,
    },
    perf_estimate,
    component_versions: {
      placement: PLACEMENT_VERSION,
      preload: PRELOAD_VERSION,
      perf: PERF_VERSION,
    },
  };
}

export async function recordRuntimePerfSample(opts = {}) {
  if (process.env.KOLM_RUNTIME_PERF_EVENTS === '0') return null;
  const version = opts.version || {};
  const concept = opts.concept || {};
  const tenant = opts.tenant || 'local-tenant';
  const namespace = opts.namespace || concept.id || version.concept_id || 'runtime';
  const model = version.id || opts.artifact_id || 'unknown-runtime-artifact';
  const latency_us = Number.isFinite(Number(opts.latency_us))
    ? Math.max(0, Math.round(Number(opts.latency_us)))
    : 0;
  try {
    return await appendEvent({
      tenant_id: tenant,
      namespace,
      provider: 'kolm',
      vendor: 'kolm',
      model,
      status: opts.error ? 'error' : 'ok',
      error: opts.error || null,
      workflow_id: 'runtime_perf_sample',
      cache_hit: opts.cache_hit === true,
      latency_us,
      latency_ms: Math.round(latency_us / 1000),
      source_type: 'real',
      redaction_policy: 'redact',
      created_at: new Date().toISOString(),
    });
  } catch {
    return null;
  }
}

function scheduleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - COMPILED_TTL_MS;
    for (const [k, v] of compiledCache) if (v.touchedAt < cutoff) compiledCache.delete(k);
  }, 60_000);
  cleanupTimer.unref?.();
}

async function instantiate(version) {
  if (version.source.startsWith('WASM:')) {
    const b64 = version.source.slice(5);
    return await compileWasm(b64);
  }
  return getCompiled(version);
}

export async function runVersion({ version_id, input, tenant, use_cache = true }) {
  const found = getVersion(version_id, tenant);
  if (!found) throw new Error('version not found or not authorized');
  const { version, concept } = found;

  const source_hash = version.evaluation?.source_hash || null;

  if (use_cache) {
    const c = cache.get(version.id, input);
    if (c.hit) {
      logInvocation({ version_id, concept_id: concept.id, tenant, latency_us: 0, cache_hit: c.hit });
      await recordRuntimePerfSample({ version, concept, tenant, latency_us: 0, cache_hit: true });
      return { output: c.value, cache: c.hit, version_id, concept: concept.name, source_hash, runtime_plan: null };
    }
  }

  let runtime_plan = null;
  try {
    runtime_plan = await buildRuntimeExecutionPlan({ version, tenant, namespace: concept.id });
  } catch {
    runtime_plan = null;
  }

  const fn = await instantiate(version);
  const t0 = process.hrtime.bigint();
  let output, error;
  try { output = fn(input); } catch (e) { error = String(e.message || e); }
  const us = Number(process.hrtime.bigint() - t0) / 1000;

  logInvocation({ version_id, concept_id: concept.id, tenant, latency_us: us, cache_hit: null, error });
  await recordRuntimePerfSample({
    version,
    concept,
    tenant,
    latency_us: us,
    error,
  });

  if (error) throw new Error(error);
  if (use_cache) cache.put(version.id, input, output);

  return { output, cache: null, latency_us: Math.round(us), version_id, concept: concept.name, source_hash, runtime_plan };
}

export async function runConcept({ concept_id, input, tenant }) {
  const head = getHead(concept_id, tenant);
  if (!head) throw new Error('concept has no published version');
  return runVersion({ version_id: head.id, input, tenant });
}

export async function composeRun({ query, input, tenant, k = 5, strategy = 'attention', tag }) {
  const matches = searchSimilar({ query, tenant, k, tag });
  if (matches.length === 0) return { output: null, dispatched: [], reason: 'no candidates' };

  const dispatched = [];
  for (const m of matches) {
    try {
      const r = await runVersion({ version_id: m.version_id, input, tenant });
      dispatched.push({
        concept_id: m.concept_id, name: m.name, version_id: m.version_id,
        score: m.score, output: r.output, cache: r.cache, latency_us: r.latency_us || 0,
      });
    } catch (e) {
      dispatched.push({ concept_id: m.concept_id, name: m.name, error: String(e.message || e) });
    }
  }

  const composed = compose(strategy, dispatched.filter(d => !d.error));
  return { output: composed, dispatched, strategy };
}

function logInvocation(row) {
  insert('invocations', { id: 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), ...row, ts: new Date().toISOString() });
}

export function compiledCacheSize() { return compiledCache.size; }
export { cache };

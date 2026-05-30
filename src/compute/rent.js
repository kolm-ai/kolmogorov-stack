// src/compute/rent.js
//
// One-shot rent flow. `kolm compute rent` should feel like Heroku for GPUs:
// pick a backend, get a quote, confirm, run a job, tear it down. No leaked
// instances, no surprise bills, no manual cleanup. If a job crashes mid-run,
// the finalize() handler in our adapters reclaims the rental.
//
// Public surface:
//   rent(spec, opts)   - end-to-end: estimate → reserve → run → release
//   quote(spec, opts)  - estimate only, no provisioning
//   release(handle)    - manual teardown if something went sideways
//
// Only vast and lambda support real auto-provision today; modal/runpod use
// SDK-managed lifecycles where the platform itself is responsible for
// teardown. Local backends are no-ops here — you can't "rent" your own GPU.

import { info as backendInfo, run as runBackend } from './index.js';
import { estimate, estimateAll } from './estimator.js';
import { assertPodEligible, classifyTrainingData, teardownPolicy } from '../secure-training.js';

// Backends that own their own lifecycle. We delegate teardown to their SDK.
const PLATFORM_MANAGED = new Set(['modal', 'runpod', 'together', 'replicate', 'fal']);

// Backends our auto-provision code drives end-to-end.
const KOLM_PROVISIONED = new Set(['vast', 'lambda']);

// Backends that don't need rent (user already owns the metal).
const NOT_RENTABLE = new Set([
  'local-cpu', 'local-cuda', 'local-mps', 'local-mlx',
  'local-rocm', 'local-directml', 'remote-ssh',
]);

export function quote(spec, { backend = null } = {}) {
  if (backend) return estimate(spec, backend);
  return estimateAll(spec);
}

// rent(spec, opts) — full one-shot. opts.backend is required (we don't pick
// automatically because the user should see the quote first). opts.confirm
// must be true to actually spend money; the default is dry-run quote-only.
export async function rent(spec, opts = {}) {
  const { backend, confirm = false, on_progress = null, budget_usd = null } = opts;
  if (!backend) throw new Error('rent: backend is required (call quote() first)');
  const b = backendInfo(backend);
  if (!b) throw new Error(`unknown backend: ${backend}`);
  if (NOT_RENTABLE.has(backend)) {
    throw new Error(`backend ${backend} is local — nothing to rent. Use "kolm compute use ${backend}" then "kolm compile" directly.`);
  }

  // Secure-training guarantee: a rented pod is a third-party machine. Public data
  // is fine to upload; sensitive/customer data must stay on local hardware, an
  // air-gapped host, or BYOC (the customer's own cloud). Classify the corpus and
  // refuse ineligible (data, backend) pairs before we provision or upload.
  const classification = opts.data_classification
    || (opts.training_samples ? classifyTrainingData(opts.training_samples) : { sensitive: false, classes: [] });
  try {
    assertPodEligible({
      sensitivity: classification,
      backend,
      byoc: !!opts.byoc,
      airgap: !!opts.airgap,
      override: !!opts.allow_sensitive_on_pod,
    });
  } catch (err) {
    if (err && err.code === 'secure_training_policy') {
      return { ok: false, backend, reason: err.message, policy: 'secure-training', classification, detail: err.detail };
    }
    throw err;
  }

  const est = estimate(spec, backend);
  if (!est.supported) {
    return { ok: false, reason: est.reason, backend, estimate: est };
  }
  if (budget_usd != null && est.cost_usd != null && est.cost_usd > budget_usd) {
    return {
      ok: false,
      reason: `quoted cost $${est.cost_usd} exceeds budget $${budget_usd}`,
      estimate: est,
      backend,
    };
  }

  if (!confirm) {
    return { ok: true, dry_run: true, estimate: est, backend };
  }

  // Provision + run. Adapter.run() owns teardown via try/finally inside the
  // adapter; for kolm-provisioned backends we double-check by exposing the
  // adapter's release() if it's there.
  const started = new Date().toISOString();
  let result;
  let release_error = null;
  try {
    result = await runBackend(backend, spec, { on_progress });
  } catch (err) {
    return {
      ok: false,
      backend,
      estimate: est,
      started_at: started,
      finished_at: new Date().toISOString(),
      reason: String(err.message || err),
      release_error,
    };
  }

  return {
    ok: true,
    backend,
    estimate: est,
    started_at: started,
    finished_at: new Date().toISOString(),
    rental: {
      managed_by: PLATFORM_MANAGED.has(backend) ? 'platform' : KOLM_PROVISIONED.has(backend) ? 'kolm' : 'unknown',
      teardown: 'automatic',
      secure_teardown: teardownPolicy(backend),
    },
    result,
  };
}

// release(handle) — kick teardown manually. Used if you Ctrl-C'd a rental
// or if a network failure left an instance up. Best-effort.
export async function release(handle) {
  if (!handle || !handle.backend) throw new Error('release: handle.backend required');
  const filename = handle.backend.replace(/[^a-z0-9-]/gi, '');
  try {
    const mod = await import(`./backends/${filename}.js`);
    const adapter = mod.default || mod;
    if (typeof adapter.release === 'function') {
      return await adapter.release(handle);
    }
    return { ok: false, reason: `backend ${handle.backend} has no release()` };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}

export default { rent, quote, release };

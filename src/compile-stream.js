// W910 Track B - compile-stream.js
// Server-Sent Events helper for /v1/compile/stream/:job. Provides a
// reload-safe SSE writer + a deterministic stub event stream so the no-code
// /account/create-model compile overlay has something to render without
// depending on a real GPU job. Real compile-jobs.js will eventually wrap
// this with live progress; the contract is the same either way.
//
// Event sequence (stubbed):
//   1. step.preparing - pending → running → done
//   2. step.train.pass1 - pending → running → done (k_score emitted)
//   3. step.train.pass2 - pending → running → done (k_score emitted)
//   4. step.train.pass3 - pending → running → done (k_score emitted)
//   5. step.quantize - pending → running → done
//   6. step.sign - pending → running → done
//   7. done - { slug, artifact_url, k_score, duration_s }
//
// Reattach: clients can re-connect with ?cursor=N and skip already-seen
// events. The stub emits 22 events over ~5 seconds (300ms cadence) so the UI
// can prove every step transition without waiting on actual training.

import { setTimeout as delay } from 'node:timers/promises';

// =============================================================================
// Atom 4 (CA-04) - the legacy fabricated-metric stub is DEMO-ONLY and gated.
//
// The functions below stream INVENTED per-pass K-scores (0.71/0.83/0.91) with
// no real training. That directly contradicts the holdout-eval contract the
// rest of CompileArtifact enforces, so they must never be reachable from a
// production import path. Per the no-delete rule we keep the capability (a
// deterministic demo stream for UI prototyping) but:
//   1. rename it to demoEventLog / streamDemoCompile so no caller binding the
//      production symbol (streamRealCompile) can resolve it by mistake;
//   2. ONLY export it when process.env.KOLM_COMPILE_STREAM_DEMO === '1'. When
//      the flag is unset the exports are undefined, so router.js / the wizard
//      cannot import a fabricated-metric streamer.
// The REAL path is streamRealCompile (below), which only ever emits the holdout
// K-score the pipeline actually measured (job.k_score).
// =============================================================================

const COMPILE_STREAM_DEMO_ENABLED = process.env.KOLM_COMPILE_STREAM_DEMO === '1';

// step labels for the demo stream - keep in sync with create-model.html
const _DEMO_COMPILE_STEPS = [
  { id: 'preparing',   label: 'Preparing dataset' },
  { id: 'train.pass1', label: 'Train pass 1' },
  { id: 'train.pass2', label: 'Train pass 2' },
  { id: 'train.pass3', label: 'Train pass 3' },
  { id: 'quantize',    label: 'Quantize INT4' },
  { id: 'sign',        label: 'Sign + receipt' },
];

// Deterministic K-Score progression per pass - FABRICATED, demo legibility only.
const _DEMO_K_SCORE_BY_PASS = { 1: 0.71, 2: 0.83, 3: 0.91 };

// Build the canonical demo event log for a job id. Used both for SSE replay AND
// reattach (cursor skip). Pure - no I/O, no Date.now(). The emitted k_scores are
// FABRICATED; this function is demo-only and not exported unless
// KOLM_COMPILE_STREAM_DEMO=1.
function demoEventLog(jobId) {
  const events = [];
  let seq = 0;
  const push = (event, data) => { events.push({ seq: ++seq, event, data }); };

  push('hello', { job: jobId, demo: true, steps: _DEMO_COMPILE_STEPS.map(s => ({ id: s.id, label: s.label, status: 'pending' })) });
  for (const step of _DEMO_COMPILE_STEPS) {
    push('step.start', { step: step.id, status: 'running' });
    if (step.id.startsWith('train.pass')) {
      const passNum = parseInt(step.id.split('pass')[1], 10);
      // demo:true + k_source:'demo' so any consumer can see the score is NOT a
      // real holdout metric.
      push('metric', { step: step.id, k_score: _DEMO_K_SCORE_BY_PASS[passNum] || 0, demo: true, k_source: 'demo' });
    }
    push('step.end', { step: step.id, status: 'done' });
  }
  push('done', {
    job: jobId,
    demo: true,
    slug: `art_${jobId.slice(0, 12)}`,
    artifact_url: `/account/artifacts/art_${jobId.slice(0, 12)}`,
    k_score: 0.91,
    k_source: 'demo',
    duration_s: 6.6,
    quant: 'int4',
    file_size_gb: 1.9,
  });
  return events;
}

// Write SSE headers + emit deterministic DEMO events at the requested cadence.
// Demo-only; not exported unless KOLM_COMPILE_STREAM_DEMO=1.
async function streamDemoCompile(req, res, jobId, opts = {}) {
  const cadenceMs = Math.max(50, Math.min(5000, Number(opts.cadenceMs) || 300));
  const cursor = Math.max(0, parseInt(req.query.cursor || '0', 10) || 0);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx/Vercel buffering
  });
  // First chunk so the browser knows the stream is open.
  res.write(': kolm-compile-stream-demo ' + jobId + '\n\n');

  const log = demoEventLog(jobId);
  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  for (const ev of log) {
    if (cancelled) return;
    if (ev.seq <= cursor) continue;
    const payload = JSON.stringify({ seq: ev.seq, ...ev.data });
    res.write(`event: ${ev.event}\n`);
    res.write(`id: ${ev.seq}\n`);
    res.write(`data: ${payload}\n\n`);
    if (typeof res.flush === 'function') {
      try { res.flush(); } catch (_) { /* flush is optional */ }
    }
    // shorter cadence after 'hello' so the UI shows movement quickly
    await delay(ev.event === 'hello' ? 80 : cadenceMs);
  }
  if (!cancelled) res.end();
}

// Demo-only exports. These names resolve to `undefined` unless the operator
// explicitly sets KOLM_COMPILE_STREAM_DEMO=1, so no production import path can
// pull a fabricated-metric stream. The production streamer is streamRealCompile.
export const COMPILE_STREAM_DEMO = COMPILE_STREAM_DEMO_ENABLED
  ? { demoEventLog, streamDemoCompile, DEMO_COMPILE_STEPS: _DEMO_COMPILE_STEPS }
  : null;

// =============================================================================
// W-3 (Path to 100%) - REAL compile streaming. The functions above are the
// legacy deterministic STUB (fabricated k_scores, GPU-training-themed steps that
// never run). The functions below stream an actual compile job (compile.js
// createJob + runJob): real W283 holdout split, real synthesized recipe, the
// REAL holdout K-score, and a link to the real signed .kolm. A failed job emits
// an honest `error` event - never a fake `done`. The overlay renders steps from
// the `hello` event, so emitting the real pipeline's steps needs no UI change.
// =============================================================================

export const REAL_COMPILE_STEPS = [
  { id: 'prepare', label: 'Prepare + hold out evaluation set' },
  { id: 'synthesize', label: 'Synthesize recipe (train split only)' },
  { id: 'evaluate', label: 'Score on unseen holdout' },
  { id: 'package', label: 'Package + sign .kolm' },
];

// Map a real compile job to the wizard SSE contract using REAL data only. Pure:
// no I/O, no Date.now(). The only score emitted is the holdout K-score the
// pipeline actually measured (job.k_score); artifact_url points at the real
// signed .kolm. A non-completed job ends in `error`, not `done`.
export function buildRealEventLog(job) {
  const events = [];
  let seq = 0;
  const push = (event, data) => { events.push({ seq: ++seq, event, data }); };
  const reached = new Set((job.stages || []).map((s) => s && s.name).filter(Boolean));

  push('hello', { job: job.id, steps: REAL_COMPILE_STEPS.map((s) => ({ id: s.id, label: s.label, status: 'pending' })) });

  const done = {
    prepare: reached.has('split.done'),
    synthesize: reached.has('distill.done'),
    evaluate: reached.has('package.done'),
    package: job.status === 'completed',
  };
  for (const step of REAL_COMPILE_STEPS) {
    push('step.start', { step: step.id, status: 'running' });
    if (step.id === 'evaluate' && typeof job.k_score === 'number') {
      // The REAL holdout K-score - not a fabricated per-pass progression.
      push('metric', { step: step.id, k_score: job.k_score, source: 'holdout' });
    }
    push('step.end', { step: step.id, status: done[step.id] ? 'done' : 'skipped' });
    if (!done[step.id] && job.status !== 'completed') break; // stop at the failure point
  }

  if (job.status === 'completed') {
    push('done', {
      job: job.id,
      slug: job.cid || `art_${String(job.id).slice(0, 12)}`,
      artifact_url: `/v1/compile/${job.id}/.kolm`,
      k_score: typeof job.k_score === 'number' ? job.k_score : null,
      k_source: 'holdout',
      holdout_count: (job.seed_provenance && job.seed_provenance.holdout_count) || null,
      artifact_class: (job.manifest && job.manifest.artifact_class) || null,
    });
  } else {
    push('error', {
      job: job.id,
      error_code: job.error_code || 'KOLM_E_COMPILE_FAILED',
      error: job.error || 'compile failed',
    });
  }
  return events;
}

// Stream a real compile job. `getJob` is injected (compile.js) to avoid a
// circular import. Waits for the job to reach a terminal state (heartbeats
// meanwhile), then emits the real event log. Reload-safe via ?cursor.
export async function streamRealCompile(req, res, jobId, getJob, opts = {}) {
  const cadenceMs = Math.max(50, Math.min(5000, Number(opts.cadenceMs) || 250));
  const cursor = Math.max(0, parseInt(req.query.cursor || '0', 10) || 0);
  const maxWaitMs = Math.max(1000, Number(opts.maxWaitMs) || 120000);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': kolm-compile-stream ' + jobId + '\n\n');

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  const t0 = Date.now();
  let job = getJob(jobId);
  while (job && job.status !== 'completed' && job.status !== 'failed' && (Date.now() - t0) < maxWaitMs) {
    if (cancelled) return;
    res.write(': working\n\n');
    await delay(200);
    job = getJob(jobId);
  }
  if (!job) {
    res.write('event: error\n');
    res.write('data: ' + JSON.stringify({ error: 'job_not_found', job: jobId }) + '\n\n');
    return res.end();
  }

  for (const ev of buildRealEventLog(job)) {
    if (cancelled) return;
    if (ev.seq <= cursor) continue;
    res.write(`event: ${ev.event}\n`);
    res.write(`id: ${ev.seq}\n`);
    res.write(`data: ${JSON.stringify({ seq: ev.seq, ...ev.data })}\n\n`);
    if (typeof res.flush === 'function') { try { res.flush(); } catch (_) { /* optional */ } }
    await delay(ev.event === 'hello' ? 80 : cadenceMs);
  }
  if (!cancelled) res.end();
}

// Estimate dollars + minutes for a describe-tab payload. Pure heuristic so
// the cost-confirm modal has a number to render before a real estimator
// is wired in. Token count is rough: chars/4. Cost rolls up describe
// length + recipe template + target VRAM.
export function estimateCompile({ describe = '', recipe = 'default', target_vram_gb = 24 } = {}) {
  const chars = String(describe || '').length;
  const tokens = Math.round(chars / 4);
  const baseUsd = 0.40; // floor - covers smallest job
  const perTokenUsd = 0.00008;
  const recipeMultiplier = { default: 1.0, support: 1.0, code: 1.4, medical: 1.8, legal: 1.6, financial: 1.5 }[recipe] || 1.0;
  const vramMultiplier = target_vram_gb >= 80 ? 3.2 : target_vram_gb >= 48 ? 2.1 : target_vram_gb >= 24 ? 1.0 : 0.6;
  const usd = Math.round((baseUsd + tokens * perTokenUsd) * recipeMultiplier * vramMultiplier * 100) / 100;
  const minutes = Math.max(2, Math.round((tokens / 800) * recipeMultiplier * vramMultiplier));
  return {
    ok: true,
    estimated_usd: usd,
    estimated_minutes: minutes,
    inputs: { chars, tokens, recipe, target_vram_gb },
    method: 'heuristic_v1',
    note: 'Heuristic estimate; final cost depends on dataset size + actual GPU SKU.',
  };
}

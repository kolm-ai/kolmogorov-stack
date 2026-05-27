// W910 Track B — compile-stream.js
// Server-Sent Events helper for /v1/compile/stream/:job. Provides a
// reload-safe SSE writer + a deterministic stub event stream so the no-code
// /account/create-model compile overlay has something to render without
// depending on a real GPU job. Real compile-jobs.js will eventually wrap
// this with live progress; the contract is the same either way.
//
// Event sequence (stubbed):
//   1. step.preparing   — pending → running → done
//   2. step.train.pass1 — pending → running → done (k_score emitted)
//   3. step.train.pass2 — pending → running → done (k_score emitted)
//   4. step.train.pass3 — pending → running → done (k_score emitted)
//   5. step.quantize    — pending → running → done
//   6. step.sign        — pending → running → done
//   7. done             — { slug, artifact_url, k_score, duration_s }
//
// Reattach: clients can re-connect with ?cursor=N and skip already-seen
// events. The stub emits 22 events over ~5 seconds (300ms cadence) so the UI
// can prove every step transition without waiting on actual training.

import { setTimeout as delay } from 'node:timers/promises';

// step labels exposed in the UI — keep in sync with create-model.html
export const COMPILE_STEPS = [
  { id: 'preparing',   label: 'Preparing dataset' },
  { id: 'train.pass1', label: 'Train pass 1' },
  { id: 'train.pass2', label: 'Train pass 2' },
  { id: 'train.pass3', label: 'Train pass 3' },
  { id: 'quantize',    label: 'Quantize INT4' },
  { id: 'sign',        label: 'Sign + receipt' },
];

// Deterministic K-Score progression per pass — keeps the stub UI legible.
const K_SCORE_BY_PASS = { 1: 0.71, 2: 0.83, 3: 0.91 };

// Build the canonical event log for a job id. Used both for SSE replay AND
// reattach (cursor skip). Pure — no I/O, no Date.now() — so the same job
// always produces the same log shape.
export function buildEventLog(jobId) {
  const events = [];
  let seq = 0;
  const push = (event, data) => { events.push({ seq: ++seq, event, data }); };

  push('hello', { job: jobId, steps: COMPILE_STEPS.map(s => ({ id: s.id, label: s.label, status: 'pending' })) });
  for (const step of COMPILE_STEPS) {
    push('step.start', { step: step.id, status: 'running' });
    if (step.id.startsWith('train.pass')) {
      const passNum = parseInt(step.id.split('pass')[1], 10);
      push('metric', { step: step.id, k_score: K_SCORE_BY_PASS[passNum] || 0 });
    }
    push('step.end', { step: step.id, status: 'done' });
  }
  push('done', {
    job: jobId,
    slug: `art_${jobId.slice(0, 12)}`,
    artifact_url: `/account/artifacts/art_${jobId.slice(0, 12)}`,
    k_score: 0.91,
    duration_s: 6.6,
    quant: 'int4',
    file_size_gb: 1.9,
  });
  return events;
}

// Write SSE headers + emit deterministic events at the requested cadence.
// `cursor` (int) skips events whose seq <= cursor so the browser can
// resume after a reload. Returns when the stream completes or the client
// disconnects.
export async function streamCompile(req, res, jobId, opts = {}) {
  const cadenceMs = Math.max(50, Math.min(5000, Number(opts.cadenceMs) || 300));
  const cursor = Math.max(0, parseInt(req.query.cursor || '0', 10) || 0);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx/Vercel buffering
  });
  // First chunk so the browser knows the stream is open.
  res.write(': kolm-compile-stream ' + jobId + '\n\n');

  const log = buildEventLog(jobId);
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

// Estimate dollars + minutes for a describe-tab payload. Pure heuristic so
// the cost-confirm modal has a number to render before a real estimator
// is wired in. Token count is rough: chars/4. Cost rolls up describe
// length + recipe template + target VRAM.
export function estimateCompile({ describe = '', recipe = 'default', target_vram_gb = 24 } = {}) {
  const chars = String(describe || '').length;
  const tokens = Math.round(chars / 4);
  const baseUsd = 0.40; // floor — covers smallest job
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

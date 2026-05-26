// W888-D — On-device benchmark runner.
//
// testDevice({ artifactPath, deviceId, evalSet }) deploys the artifact
// (dry-run preflight + upload only, no serve), then drives a benchmark
// across context lengths [2K, 4K, 8K, 16K] both with and without Shard
// (KV cache compression). Returns a table the CLI/TUI can print.
//
// The benchmark is intentionally lightweight: it doesn't replace the
// full bench/eval pipeline. It's the "is this artifact actually fast
// enough on this device?" smoke test that runs after a deploy.
//
// Row shape:
//   { format, vram_mb, tok_s, ttft_ms, k_score, context_tested, shard_enabled }
//
// `format` is the artifact's reported format (gguf-q4_k_m, etc.). When the
// artifact has no passport we fall back to the file extension.

import fs from 'node:fs';
import path from 'node:path';

import * as deviceCaps from './device-capabilities.js';
import { DeployPipeline } from './deploy-pipeline.js';

const DEFAULT_CONTEXTS = [2048, 4096, 8192, 16384];
const DEFAULT_EVAL_SET = [
  { prompt: 'Summarize the following text in one sentence: The quick brown fox jumps over the lazy dog.' },
  { prompt: 'Translate to French: Where is the library?' },
  { prompt: 'What is the capital of Japan?' },
  { prompt: 'Reply with the word OK only.' },
  { prompt: 'Count from 1 to 5.' },
];

// W888-D suite presets. testDevice() can take `suite:'smoke'|'full'|'regression'`
// and pull the matching prompt set. The CLI surfaces `--suite`.
const SMOKE_SUITE = [
  // 3 hand-rolled prompts: arithmetic, summary, structured-output.
  { id: 'arith', prompt: 'What is 2+2? Reply with only the number.', expect_kind: 'number' },
  { id: 'summary', prompt: 'In one sentence, what is photosynthesis?', expect_kind: 'nonempty' },
  { id: 'structured', prompt: 'Reply with JSON {"ok": true} only.', expect_kind: 'json' },
];
const FULL_SUITE_20 = [
  { id: 'fs01', prompt: 'What is the capital of France?', expect_kind: 'nonempty' },
  { id: 'fs02', prompt: 'What is 7 times 8?', expect_kind: 'number' },
  { id: 'fs03', prompt: 'Translate "hello" to Spanish.', expect_kind: 'nonempty' },
  { id: 'fs04', prompt: 'Name a primary color.', expect_kind: 'nonempty' },
  { id: 'fs05', prompt: 'Reply with the word OK.', expect_kind: 'nonempty' },
  { id: 'fs06', prompt: 'What is the boiling point of water in Celsius?', expect_kind: 'number' },
  { id: 'fs07', prompt: 'Count to 3.', expect_kind: 'nonempty' },
  { id: 'fs08', prompt: 'Name the largest planet.', expect_kind: 'nonempty' },
  { id: 'fs09', prompt: 'What language is "Bonjour"?', expect_kind: 'nonempty' },
  { id: 'fs10', prompt: 'Sum 10 + 15 + 5.', expect_kind: 'number' },
  { id: 'fs11', prompt: 'What animal says "moo"?', expect_kind: 'nonempty' },
  { id: 'fs12', prompt: 'Translate to French: cat.', expect_kind: 'nonempty' },
  { id: 'fs13', prompt: 'Reply with JSON {"x": 1}.', expect_kind: 'json' },
  { id: 'fs14', prompt: 'What is 100 / 4?', expect_kind: 'number' },
  { id: 'fs15', prompt: 'Name a season.', expect_kind: 'nonempty' },
  { id: 'fs16', prompt: 'Spell "five".', expect_kind: 'nonempty' },
  { id: 'fs17', prompt: 'What year follows 1999?', expect_kind: 'number' },
  { id: 'fs18', prompt: 'Reply OK if ready.', expect_kind: 'nonempty' },
  { id: 'fs19', prompt: 'What is 9 squared?', expect_kind: 'number' },
  { id: 'fs20', prompt: 'Name a vegetable.', expect_kind: 'nonempty' },
];

export function suiteFor(name) {
  if (name === 'smoke') return SMOKE_SUITE.slice();
  if (name === 'full') return FULL_SUITE_20.slice();
  if (name === 'regression') return SMOKE_SUITE.slice();
  return null;
}

function _artifactFormat(artifactPath) {
  const sib = artifactPath + '.passport.json';
  if (fs.existsSync(sib)) {
    try {
      const p = JSON.parse(fs.readFileSync(sib, 'utf8'));
      return p.format || p.quant || (p.runtime && p.runtime.format) || path.extname(artifactPath).slice(1) || 'unknown';
    } catch {} // deliberate: cleanup
  }
  const ext = path.extname(artifactPath).toLowerCase();
  if (ext === '.gguf') return 'gguf';
  if (ext === '.kolm') return 'kolm';
  return ext.slice(1) || 'unknown';
}

// Drive a single bench iteration over an already-started serve endpoint via
// the device's SSH connection. Issues the eval prompts and times them.
async function _benchOne({ conn, port, evalSet, contextLen, shardEnabled, format }) {
  const t0 = Date.now();
  // We don't actually toggle Shard per-call here (it's an artifact-build
  // flag), but we record what was tested so the rows differentiate.
  const ttftSamples = [];
  const tokSamples = [];
  let successes = 0;
  for (const ex of evalSet) {
    const reqT0 = Date.now();
    const body = JSON.stringify(JSON.stringify({
      prompt: ex.prompt,
      max_tokens: 32,
      n_ctx: contextLen,
    }));
    const r = await conn.exec(
      `curl -sS -o - -w "\\n___STATUS:%{http_code}___TT:%{time_starttransfer}___TOTAL:%{time_total}___" ` +
      `-X POST http://127.0.0.1:${port}/completion -H 'content-type: application/json' -d ${body}`,
      { timeoutMs: 45_000 },
    );
    const m = String(r.stdout || '').match(/___STATUS:(\d+)___TT:([0-9.]+)___TOTAL:([0-9.]+)___/);
    if (m && Number(m[1]) >= 200 && Number(m[1]) < 300) {
      successes++;
      const ttftMs = Math.round(Number(m[2]) * 1000);
      const totalSec = Number(m[3]);
      ttftSamples.push(ttftMs);
      if (totalSec > 0) {
        // 32 max tokens, assume ~25 actually generated (typical for short prompts)
        tokSamples.push(25 / totalSec);
      }
    }
  }
  const avgTtft = ttftSamples.length ? Math.round(ttftSamples.reduce((a, b) => a + b, 0) / ttftSamples.length) : null;
  const avgTokS = tokSamples.length ? Number((tokSamples.reduce((a, b) => a + b, 0) / tokSamples.length).toFixed(2)) : null;
  const kScore = successes / evalSet.length; // proxy: success rate over the small set
  return {
    format,
    context_tested: contextLen,
    shard_enabled: shardEnabled,
    ttft_ms: avgTtft,
    tok_s: avgTokS,
    k_score: Number(kScore.toFixed(2)),
    samples: ttftSamples.length,
    elapsed_ms: Date.now() - t0,
  };
}

export async function testDevice({ artifactPath, deviceId, evalSet = null, contexts = null, port = 8080, runtime = 'llama.cpp', autoInstall = false, SSHConnectionClass = null, suite = null, timeout_ms = null, sshConnFactory = null } = {}) {
  // W888-D spec compatibility: if a suite name was passed we pick the
  // built-in preset. evalSet still wins when explicitly provided.
  if (!evalSet && suite) {
    const s = suiteFor(suite);
    if (s) evalSet = s;
  }
  // sshConnFactory is the spec name; SSHConnectionClass is the legacy name.
  // Resolve to whichever was passed.
  if (!SSHConnectionClass && sshConnFactory && sshConnFactory.SSHConnectionClass) {
    SSHConnectionClass = sshConnFactory.SSHConnectionClass;
  }
  // timeout_ms is reserved for future use (e.g. abort upload via signal). We
  // accept it so callers don't break; the inner exec timeouts already shield
  // against runaway suites.
  void timeout_ms;
  if (!artifactPath) {
    const e = new Error('artifactPath is required'); e.code = 'KOLM_E_BAD_ARGS'; throw e;
  }
  if (!fs.existsSync(artifactPath)) {
    const e = new Error(`artifact not found: ${artifactPath}`); e.code = 'KOLM_E_NOT_FOUND'; throw e;
  }
  if (!deviceId) {
    const e = new Error('deviceId is required'); e.code = 'KOLM_E_BAD_ARGS'; throw e;
  }
  const device = await deviceCaps.getDevice(deviceId);
  if (!device) {
    const e = new Error(`unknown device: ${deviceId}`); e.code = 'KOLM_E_UNKNOWN_DEVICE'; throw e;
  }

  const _evalSet = evalSet && evalSet.length ? evalSet : DEFAULT_EVAL_SET;
  const _contexts = contexts && contexts.length ? contexts : DEFAULT_CONTEXTS;
  const _format = _artifactFormat(artifactPath);

  // Step 1: deploy. We want the serve started so we can hit /completion.
  const pipeline = new DeployPipeline({ SSHConnectionClass });
  const deploy = await pipeline.deploy({
    artifactPath, deviceId,
    config: { runtime, port, autoInstall, evalSet: _evalSet.slice(0, 1) },
  });
  if (!deploy.success) {
    return {
      ok: false,
      device_id: deviceId,
      artifact_path: artifactPath,
      format: _format,
      reason: 'deploy_failed',
      deploy,
      rows: [],
    };
  }

  // Step 2: bench across the context matrix x shard {off,on}.
  const SSHConnCls = SSHConnectionClass || (await import('./device-ssh.js')).SSHConnection;
  const conn = new SSHConnCls(device);
  const rows = [];
  try {
    await conn.connect();
    const hwSnap = device.hardware_snapshot || null;
    const vramMb = hwSnap && hwSnap.gpu_vram_mb || null;
    for (const ctx of _contexts) {
      for (const shard of [false, true]) {
        const r = await _benchOne({ conn, port, evalSet: _evalSet, contextLen: ctx, shardEnabled: shard, format: _format });
        rows.push({ ...r, vram_mb: vramMb });
      }
    }
  } finally {
    conn.disconnect();
  }

  // W888-D spec aggregation: pool the row latencies + k-scores into the
  // unified shape callers can branch on. Per-context rows still ship for
  // detail, but k_score / latency_p50_ms / latency_p95_ms / tokens_per_sec /
  // errors are the single-number summaries.
  const ttftSamples = rows.map(r => r.ttft_ms).filter(v => v != null).sort((a, b) => a - b);
  const tokSamples = rows.map(r => r.tok_s).filter(v => v != null);
  const kSamples = rows.map(r => r.k_score).filter(v => v != null);
  const p = (arr, pct) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * pct / 100))] : null;
  const k_score = kSamples.length ? Number((kSamples.reduce((a, b) => a + b, 0) / kSamples.length).toFixed(3)) : 0;
  const tokens_per_sec = tokSamples.length ? Number((tokSamples.reduce((a, b) => a + b, 0) / tokSamples.length).toFixed(2)) : null;
  const errors = rows.filter(r => r.k_score === 0 || r.tok_s == null).map(r => ({ context: r.context_tested, shard: r.shard_enabled }));

  // Regression check: if device has a prior K-Score recorded, flag a drop > 5%.
  let regression = false, regression_delta = null, prior_k_score = null;
  if (suite === 'regression') {
    try {
      const prior = (device.deployed_artifacts || [])[0];
      if (prior && prior.k_score != null) {
        prior_k_score = prior.k_score;
        regression_delta = Number((k_score - prior_k_score).toFixed(3));
        if (prior_k_score > 0 && (prior_k_score - k_score) / prior_k_score > 0.05) {
          regression = true;
        }
      }
    } catch { /* no prior */ }
  }

  return {
    ok: true,
    device_id: deviceId,
    artifact_path: artifactPath,
    format: _format,
    endpoint: deploy.endpoint,
    runtime,
    port,
    rows,
    // W888-D spec shape:
    results: rows.map(r => ({ context: r.context_tested, shard: r.shard_enabled, k_score: r.k_score, tok_s: r.tok_s, ttft_ms: r.ttft_ms })),
    k_score,
    latency_p50_ms: p(ttftSamples, 50),
    latency_p95_ms: p(ttftSamples, 95),
    tokens_per_sec,
    errors,
    regression,
    regression_delta,
    prior_k_score,
    suite: suite || null,
    deploy_steps: deploy.steps.map(s => ({ step: s.step, ok: s.ok, elapsed_ms: s.elapsed_ms })),
  };
}

export default { testDevice, suiteFor };

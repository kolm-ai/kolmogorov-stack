// R-3 — kolm serve metrics sidecar.
//
// Thin /metrics endpoint that surfaces basic counters parsed from the runtime
// child process's stdout/stderr. llama-server, vLLM, and ollama all log a line
// per completion that we can grep for request count + token throughput.
//
// We DO NOT proxy /v1/chat/completions — the runtime handles that natively
// (llama.cpp's --server, vLLM's OpenAI-compat). The sidecar runs on a side
// port (default: runtime_port + 1) and just answers /metrics + /health.
//
// Counters surfaced:
//   request_count   — total completion requests seen in the log stream
//   latency_p50_ms  — median wall-clock latency across the rolling window
//   tok_s_p50       — median tokens/sec across the rolling window
//   memory_mb       — RSS of the runtime PID (best-effort; 0 if PID unknown)
//
// Format: Prometheus text exposition. Anyone with a scrape config can wire
// this in without a custom translator.

import http from 'node:http';
import fs from 'node:fs';

const ROLLING_WINDOW = 512;

export const METRICS_SIDECAR_VERSION = 'serve-metrics-sidecar-v1';

// Parse a log line for one of the supported runtime formats. Returns
// { tokens, latency_ms } when the line is a completion-finish record,
// otherwise null. We accept three shapes (one per runtime):
//
//   llama.cpp : "slot release: ... n_decoded = N, latency = Lms"
//   vLLM      : "Generation finished: prompt=... tokens=N tps=T duration=L"
//   ollama    : "eval count: N, eval duration: L ms"
//
// New runtimes need their own regex here; unknown lines return null.
export function parseRuntimeLogLine(line) {
  if (!line || typeof line !== 'string') return null;
  // llama.cpp
  let m = line.match(/n_decoded\s*=\s*(\d+).*?latency\s*=\s*([\d.]+)\s*ms/);
  if (m) {
    return { tokens: parseInt(m[1], 10), latency_ms: parseFloat(m[2]) };
  }
  // vLLM
  m = line.match(/tokens\s*=\s*(\d+).*?duration\s*=\s*([\d.]+)/);
  if (m) {
    return { tokens: parseInt(m[1], 10), latency_ms: parseFloat(m[2]) * 1000 };
  }
  // ollama
  m = line.match(/eval count:\s*(\d+),\s*eval duration:\s*([\d.]+)\s*ms/);
  if (m) {
    return { tokens: parseInt(m[1], 10), latency_ms: parseFloat(m[2]) };
  }
  return null;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function readRssMb(pid) {
  if (!pid) return 0;
  try {
    if (process.platform === 'linux') {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/VmRSS:\s*(\d+)\s*kB/);
      if (m) return Math.round(parseInt(m[1], 10) / 1024);
    }
    return 0;
  } catch { return 0; }
}

/**
 * Start the metrics sidecar HTTP server.
 *
 * @param {Object} opts
 * @param {number} opts.port       — sidecar HTTP port
 * @param {number} [opts.runtimePid] — PID of the runtime child for /proc lookup
 * @param {string} [opts.runtime]  — runtime name for the metric label
 * @returns {Object} { server, ingest(line), counters }
 *   counters is a live ref; ingest(line) updates it.
 */
export function startMetricsSidecar(opts = {}) {
  const { port, runtimePid, runtime = 'unknown' } = opts;
  const latencies = [];
  const tps = [];
  const counters = {
    request_count: 0,
    started_at: Date.now(),
  };

  function ingest(line) {
    const parsed = parseRuntimeLogLine(line);
    if (!parsed) return false;
    counters.request_count += 1;
    if (parsed.latency_ms > 0) {
      latencies.push(parsed.latency_ms);
      if (latencies.length > ROLLING_WINDOW) latencies.shift();
    }
    if (parsed.tokens > 0 && parsed.latency_ms > 0) {
      const t = parsed.tokens / (parsed.latency_ms / 1000);
      tps.push(t);
      if (tps.length > ROLLING_WINDOW) tps.shift();
    }
    return true;
  }

  function renderPrometheus() {
    const p50 = percentile(latencies, 0.5);
    const p50tps = percentile(tps, 0.5);
    const rss = readRssMb(runtimePid);
    const uptime = Math.round((Date.now() - counters.started_at) / 1000);
    const lines = [
      `# HELP kolm_serve_request_count Total completion requests served`,
      `# TYPE kolm_serve_request_count counter`,
      `kolm_serve_request_count{runtime="${runtime}"} ${counters.request_count}`,
      `# HELP kolm_serve_latency_p50_ms Median wall-clock latency in milliseconds`,
      `# TYPE kolm_serve_latency_p50_ms gauge`,
      `kolm_serve_latency_p50_ms{runtime="${runtime}"} ${Number(p50.toFixed(2))}`,
      `# HELP kolm_serve_tok_s_p50 Median tokens per second across rolling window`,
      `# TYPE kolm_serve_tok_s_p50 gauge`,
      `kolm_serve_tok_s_p50{runtime="${runtime}"} ${Number(p50tps.toFixed(2))}`,
      `# HELP kolm_serve_memory_mb Runtime resident-set memory in megabytes`,
      `# TYPE kolm_serve_memory_mb gauge`,
      `kolm_serve_memory_mb{runtime="${runtime}"} ${rss}`,
      `# HELP kolm_serve_uptime_seconds Sidecar uptime in seconds`,
      `# TYPE kolm_serve_uptime_seconds gauge`,
      `kolm_serve_uptime_seconds{runtime="${runtime}"} ${uptime}`,
    ];
    return lines.join('\n') + '\n';
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(renderPrometheus());
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, runtime, uptime_s: Math.round((Date.now() - counters.started_at) / 1000) }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found — try /metrics or /health\n');
  });
  if (port) server.listen(port);

  return { server, ingest, counters, renderPrometheus };
}

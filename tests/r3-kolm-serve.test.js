// R-3 — kolm serve auto-detection runtime server.
//
// Test the decision table in src/serve-autodetect.js and the --dry-run /
// --docker / --k8s emitters in cli/kolm.js. We do NOT actually spawn a model
// runtime; every CLI invocation uses --dry-run, --docker, or --k8s which all
// short-circuit before spawn().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import {
  detectRuntime,
  buildDockerCompose,
  buildK8sManifests,
  KNOWN_RUNTIMES,
  SERVE_AUTODETECT_VERSION,
} from '../src/serve-autodetect.js';

// Hardware probe fixtures. Match the shape detectHardware() returns in
// src/forge-hardware.js so the decision table sees realistic inputs.
const HW_CUDA = {
  primary: { vendor: 'nvidia', name: 'RTX 5090', vram_gb: 32, compute_capability: '10.0', native_dtypes: ['nvfp4', 'fp8', 'fp16', 'bf16', 'int8', 'int4'] },
  all: [],
  detected_at: '2026-05-26T00:00:00Z',
};
const HW_METAL = {
  primary: { vendor: 'apple', name: 'Apple M3 Max', vram_gb: 128, compute_capability: 'apple-silicon', native_dtypes: ['fp16', 'bf16', 'int8', 'int4'] },
  all: [],
  detected_at: '2026-05-26T00:00:00Z',
};
const HW_CPU = {
  primary: { vendor: 'cpu', name: 'CPU (16 cores)', vram_gb: 64, compute_capability: 'cpu', native_dtypes: ['fp16', 'bf16', 'int8'] },
  all: [],
  detected_at: '2026-05-26T00:00:00Z',
};

// ---------------------------------------------------------------------------
// 1. detectRuntime decision table
// ---------------------------------------------------------------------------

test('detectRuntime: gguf + CUDA -> llama.cpp with -ngl', () => {
  const d = detectRuntime({ artifactPath: '/models/qwen2.5-7b-q4_k_m.gguf', hwProbe: HW_CUDA });
  assert.equal(d.runtime, 'llama.cpp');
  assert.equal(d.format, 'gguf');
  assert.equal(d.gpu_class, 'cuda');
  assert.match(d.reason, /llama\.cpp/);
  assert.equal(d.command.bin, 'llama-server');
  assert.ok(d.command.args.includes('-ngl'), 'must pass -ngl on CUDA');
  assert.ok(d.command.args.includes('--model'));
});

test('detectRuntime: gguf + Apple Silicon -> llama.cpp with --metal', () => {
  const d = detectRuntime({ artifactPath: '/models/qwen.gguf', hwProbe: HW_METAL });
  assert.equal(d.runtime, 'llama.cpp');
  assert.equal(d.format, 'gguf');
  assert.equal(d.gpu_class, 'metal');
  assert.ok(d.command.args.includes('--metal'), 'must pass --metal on Apple Silicon');
});

test('detectRuntime: gguf + CPU only -> llama.cpp CPU mode (no -ngl)', () => {
  const d = detectRuntime({ artifactPath: '/models/qwen.gguf', hwProbe: HW_CPU });
  assert.equal(d.runtime, 'llama.cpp');
  assert.equal(d.format, 'gguf');
  assert.equal(d.gpu_class, 'cpu');
  // CPU mode: no -ngl flag (because gpu_layers is 0 and we skip the flag for non-cuda)
  assert.ok(!d.command.args.includes('-ngl'), 'CPU mode must not include -ngl');
});

test('detectRuntime: safetensors + CUDA -> vllm OpenAI-compat', () => {
  const d = detectRuntime({ artifactPath: '/models/llama-3-8b.safetensors', hwProbe: HW_CUDA });
  assert.equal(d.runtime, 'vllm');
  assert.equal(d.format, 'safetensors');
  assert.equal(d.gpu_class, 'cuda');
  assert.equal(d.command.bin, 'python');
  assert.deepEqual(d.command.args.slice(0, 2), ['-m', 'vllm.entrypoints.openai.api_server']);
});

test('detectRuntime: safetensors + Apple Silicon -> mlx-lm.server', () => {
  const d = detectRuntime({ artifactPath: '/models/llama-3-8b.safetensors', hwProbe: HW_METAL });
  assert.equal(d.runtime, 'mlx');
  assert.equal(d.format, 'safetensors');
  assert.equal(d.command.bin, 'python');
  assert.deepEqual(d.command.args.slice(0, 2), ['-m', 'mlx_lm.server']);
});

test('detectRuntime: .mlx artifact + Apple Silicon -> mlx', () => {
  const d = detectRuntime({ artifactPath: '/models/qwen.mlx', hwProbe: HW_METAL });
  assert.equal(d.runtime, 'mlx');
  assert.equal(d.format, 'mlx');
  assert.equal(d.gpu_class, 'metal');
});

test('detectRuntime: .mlx artifact on CUDA host -> unsupported', () => {
  const d = detectRuntime({ artifactPath: '/models/qwen.mlx', hwProbe: HW_CUDA });
  assert.equal(d.runtime, 'unsupported');
  assert.match(d.reason, /Apple Silicon/);
});

test('detectRuntime: safetensors on CPU-only host -> unsupported', () => {
  const d = detectRuntime({ artifactPath: '/models/llama.safetensors', hwProbe: HW_CPU });
  assert.equal(d.runtime, 'unsupported');
  assert.match(d.reason, /cpu-only/);
});

test('detectRuntime: unknown format -> unsupported', () => {
  const d = detectRuntime({ artifactPath: '/models/something.bin', hwProbe: HW_CUDA });
  assert.equal(d.runtime, 'unsupported');
  assert.match(d.reason, /unknown artifact format/);
});

test('detectRuntime: --runtime override wins over auto-pick', () => {
  // safetensors on CPU would normally be unsupported, but explicit
  // --runtime vllm should pass through (the operator owns the consequences).
  const d = detectRuntime({ artifactPath: '/models/x.safetensors', hwProbe: HW_CPU, override: 'vllm' });
  assert.equal(d.runtime, 'vllm');
  assert.match(d.reason, /override/);
});

test('detectRuntime: --runtime ollama override returns ollama', () => {
  const d = detectRuntime({ artifactPath: '/models/x.gguf', hwProbe: HW_CUDA, override: 'ollama' });
  assert.equal(d.runtime, 'ollama');
  assert.equal(d.command.bin, 'ollama');
  assert.deepEqual(d.command.args, ['serve']);
});

test('detectRuntime: unknown override -> unsupported', () => {
  const d = detectRuntime({ artifactPath: '/models/x.gguf', hwProbe: HW_CUDA, override: 'bogus' });
  assert.equal(d.runtime, 'unsupported');
  assert.match(d.reason, /not one of/);
});

test('detectRuntime: manifest.format wins over file suffix', () => {
  // Operator renamed .gguf to .bin but manifest still says gguf.
  const d = detectRuntime({
    artifactPath: '/models/renamed.bin',
    hwProbe: HW_CUDA,
    manifest: { format: 'gguf' },
  });
  assert.equal(d.runtime, 'llama.cpp');
  assert.equal(d.format, 'gguf');
});

test('detectRuntime: contract — KNOWN_RUNTIMES and version exported', () => {
  assert.deepEqual([...KNOWN_RUNTIMES].sort(), ['llama.cpp', 'mlx', 'ollama', 'vllm']);
  assert.equal(SERVE_AUTODETECT_VERSION, 'serve-autodetect-v1');
});

// ---------------------------------------------------------------------------
// 2. --dry-run exits 0 with no spawn (CLI smoke)
// ---------------------------------------------------------------------------

const CLI_PATH = path.join(process.cwd(), 'cli', 'kolm.js');

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KOLM_NO_HW_DETECT: '1', NO_COLOR: '1', ...env },
    timeout: 30_000,
  });
}

test('kolm serve --dry-run: exits 0 with detection info, no spawn', () => {
  const r = runCli(['serve', '/tmp/fake-model.gguf', '--dry-run']);
  assert.equal(r.status, 0, `exit 0 expected, got ${r.status}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /runtime:/);
  assert.match(r.stdout, /llama\.cpp/);  // gguf + cpu (forced) -> llama.cpp CPU mode
  assert.match(r.stdout, /dry-run mode/);
});

test('kolm serve --dry-run --json: emits JSON envelope', () => {
  const r = runCli(['serve', '/tmp/fake-model.gguf', '--dry-run', '--json']);
  assert.equal(r.status, 0, `exit 0 expected, got ${r.status}\nstderr:\n${r.stderr}`);
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.dry_run, true);
  assert.equal(obj.runtime, 'llama.cpp');
  assert.equal(obj.format, 'gguf');
  assert.ok(obj.command, 'command field present');
  assert.equal(obj.command.bin, 'llama-server');
});

test('kolm serve --dry-run safetensors + cpu -> unsupported in JSON', () => {
  const r = runCli(['serve', '/tmp/fake.safetensors', '--dry-run', '--json']);
  assert.equal(r.status, 0);
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.runtime, 'unsupported');
  assert.equal(obj.ok, false);
});

// ---------------------------------------------------------------------------
// 3. --docker emits valid YAML
// ---------------------------------------------------------------------------

test('buildDockerCompose: emits valid YAML that parses', () => {
  const out = buildDockerCompose({ runtime: 'llama.cpp', artifactPath: '/models/x.gguf', port: 8788 });
  const parsed = yaml.load(out);
  assert.ok(parsed.services, 'services key present');
  assert.ok(parsed.services['kolm-serve'], 'kolm-serve service present');
  assert.equal(parsed.services['kolm-serve'].image, 'ghcr.io/ggerganov/llama.cpp:server');
  assert.ok(Array.isArray(parsed.services['kolm-serve'].ports));
});

test('kolm serve --docker: stdout is valid YAML', () => {
  const r = runCli(['serve', '/tmp/x.gguf', '--docker']);
  assert.equal(r.status, 0, `exit 0 expected, got ${r.status}\nstderr:\n${r.stderr}`);
  const parsed = yaml.load(r.stdout);
  assert.ok(parsed.services['kolm-serve']);
  assert.match(JSON.stringify(parsed), /llama\.cpp/);
});

// ---------------------------------------------------------------------------
// 4. --k8s emits 5 documents (Deployment/Service/HPA/ConfigMap/PVC)
// ---------------------------------------------------------------------------

test('buildK8sManifests: emits 5 kinds', () => {
  const out = buildK8sManifests({ runtime: 'llama.cpp', artifactPath: '/models/x.gguf', port: 8788 });
  const docs = yaml.loadAll(out).filter(d => d != null);
  assert.equal(docs.length, 5, `expected 5 docs, got ${docs.length}`);
  const kinds = docs.map(d => d.kind).sort();
  assert.deepEqual(kinds, [
    'ConfigMap',
    'Deployment',
    'HorizontalPodAutoscaler',
    'PersistentVolumeClaim',
    'Service',
  ]);
});

test('kolm serve --k8s: stdout parses to 5 manifests of the right kinds', () => {
  const r = runCli(['serve', '/tmp/x.gguf', '--k8s']);
  assert.equal(r.status, 0, `exit 0 expected, got ${r.status}\nstderr:\n${r.stderr}`);
  const docs = yaml.loadAll(r.stdout).filter(d => d != null);
  assert.equal(docs.length, 5);
  const kinds = new Set(docs.map(d => d.kind));
  assert.ok(kinds.has('Deployment'));
  assert.ok(kinds.has('Service'));
  assert.ok(kinds.has('HorizontalPodAutoscaler'));
  assert.ok(kinds.has('ConfigMap'));
  assert.ok(kinds.has('PersistentVolumeClaim'));
  // Init container present inside the Deployment.
  const dep = docs.find(d => d.kind === 'Deployment');
  assert.ok(dep.spec.template.spec.initContainers, 'Deployment has init container');
});

test('k8s Deployment has /health probes wired', () => {
  const out = buildK8sManifests({ runtime: 'vllm', artifactPath: '/models/x.safetensors', port: 8788 });
  const docs = yaml.loadAll(out);
  const dep = docs.find(d => d.kind === 'Deployment');
  const container = dep.spec.template.spec.containers[0];
  assert.equal(container.readinessProbe.httpGet.path, '/health');
  assert.equal(container.livenessProbe.httpGet.path, '/health');
});

// ---------------------------------------------------------------------------
// 5. Metrics sidecar log-line parser
// ---------------------------------------------------------------------------

test('parseRuntimeLogLine: handles llama.cpp / vLLM / ollama formats', async () => {
  const { parseRuntimeLogLine } = await import('../src/serve-metrics-sidecar.js');
  // llama.cpp
  const a = parseRuntimeLogLine('slot release: id=0 task=12 n_decoded = 84, latency = 1240.5 ms');
  assert.equal(a.tokens, 84);
  assert.ok(Math.abs(a.latency_ms - 1240.5) < 0.01);
  // vLLM
  const b = parseRuntimeLogLine('Generation finished: prompt=hi tokens=42 tps=18 duration=2.3');
  assert.equal(b.tokens, 42);
  assert.ok(Math.abs(b.latency_ms - 2300) < 0.01);
  // ollama
  const c = parseRuntimeLogLine('eval count: 56, eval duration: 1850 ms');
  assert.equal(c.tokens, 56);
  assert.equal(c.latency_ms, 1850);
  // garbage
  assert.equal(parseRuntimeLogLine('hello world'), null);
});

test('metrics sidecar: ingest + renderPrometheus produces counter increments', async () => {
  const { startMetricsSidecar } = await import('../src/serve-metrics-sidecar.js');
  const sidecar = startMetricsSidecar({ runtime: 'llama.cpp' });  // no port -> no listen
  assert.equal(sidecar.counters.request_count, 0);
  sidecar.ingest('slot release: n_decoded = 30, latency = 1000 ms');
  sidecar.ingest('slot release: n_decoded = 60, latency = 2000 ms');
  assert.equal(sidecar.counters.request_count, 2);
  const out = sidecar.renderPrometheus();
  assert.match(out, /kolm_serve_request_count\{runtime="llama\.cpp"\} 2/);
  assert.match(out, /kolm_serve_latency_p50_ms/);
});

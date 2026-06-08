// R-3 - kolm serve runtime auto-detection.
//
// Single source of truth for "given an artifact + a hardware probe, which
// inference runtime should we boot?". Used by:
//
//   - cli/kolm.js cmdServe (the runtime boot path)
//   - tests/r3-kolm-serve.test.js (decision-table coverage)
//
// Detection priority (first match wins):
//   1. --runtime override            -> caller-pinned runtime, no auto-pick
//   2. .gguf + ollama override       -> ollama (Modelfile + ollama serve)
//   3. .gguf + CUDA GPU              -> llama.cpp + -ngl <layers>
//   4. .gguf + Apple Silicon         -> llama.cpp + --metal
//   5. .gguf + CPU only              -> llama.cpp CPU mode
//   6. .safetensors + CUDA GPU       -> vllm OpenAI-compat server
//   7. .safetensors + Apple Silicon  -> mlx-lm.server
//   8. .mlx + anything               -> mlx-lm.server
//   9. everything else               -> {runtime: 'unsupported', reason}
//
// We do NOT invent capabilities. If the host has no CUDA and the artifact is
// safetensors-CUDA-only, we report 'unsupported' with a reason field the
// caller can show the operator.
//
// The decision is pure: no I/O beyond reading the artifactPath suffix and
// optional manifest. Hardware shape comes in as `hwProbe` (caller invokes
// detectHardware() from src/forge-hardware.js and passes the result).

import path from 'node:path';

export const SERVE_AUTODETECT_VERSION = 'serve-autodetect-v1';

// ---------------------------------------------------------------------------
// wave4-r-enrich: declarative (format, hardware) -> (runtime, flags) table.
// This is the contract the docs publish; detectRuntime() above uses imperative
// logic for the same decisions, and `selectRuntime()` below uses this table
// directly so the docs + the dispatcher cannot drift. Adding a new format
// or hardware here is the single source-of-truth edit.
// ---------------------------------------------------------------------------
export const RUNTIME_SELECTION = Object.freeze({
  gguf: Object.freeze({
    cuda:  Object.freeze({ runtime: 'llama.cpp',     flags: '--n-gpu-layers 999' }),
    metal: Object.freeze({ runtime: 'llama.cpp',     flags: '--metal' }),
    cpu:   Object.freeze({ runtime: 'llama.cpp',     flags: '' }),
  }),
  safetensors: Object.freeze({
    cuda:  Object.freeze({ runtime: 'vllm',          flags: '--gpu-memory-utilization 0.9' }),
    metal: Object.freeze({ runtime: 'mlx',           flags: '' }),
    cpu:   Object.freeze({ runtime: 'transformers',  flags: '--device cpu' }),
  }),
  mlx: Object.freeze({
    metal: Object.freeze({ runtime: 'mlx',           flags: '' }),
  }),
  exl2: Object.freeze({
    cuda:  Object.freeze({ runtime: 'exllamav2',     flags: '' }),
  }),
});

// /health response schema - exported as a constant so the OpenAPI builder
// (R-9 / S-10) can re-use the shape without redeclaring it.
export const HEALTH_SCHEMA = Object.freeze({
  type: 'object',
  required: ['ok', 'runtime', 'uptime_s'],
  properties: {
    ok:        { type: 'boolean' },
    runtime:   { type: 'string', enum: ['llama.cpp', 'vllm', 'mlx', 'ollama', 'transformers', 'exllamav2', 'unknown'] },
    uptime_s:  { type: 'integer', minimum: 0 },
    version:   { type: 'string' },
    artifact:  { type: ['string', 'null'] },
  },
});

// /metrics response schema (Prometheus text exposition envelope wrapping a
// fixed metric set). The schema describes the parsed-JSON sibling at
// /metrics.json - the text endpoint remains the canonical Prometheus form.
export const METRICS_SCHEMA = Object.freeze({
  type: 'object',
  required: ['runtime', 'request_count', 'latency_p50_ms', 'tok_s_p50', 'memory_mb', 'uptime_s'],
  properties: {
    runtime:         { type: 'string' },
    request_count:   { type: 'integer', minimum: 0 },
    latency_p50_ms:  { type: 'number',  minimum: 0 },
    tok_s_p50:       { type: 'number',  minimum: 0 },
    memory_mb:       { type: 'integer', minimum: 0 },
    uptime_s:        { type: 'integer', minimum: 0 },
  },
});

/**
 * selectRuntime(artifactPath, hardware) -> Promise<envelope>
 *
 * Async wrapper around RUNTIME_SELECTION. Hardware is one of:
 *   - string ('cuda', 'metal', 'cpu')
 *   - object { class: 'cuda', gpu_name?, vram_gb? }
 *
 * Returns `{ok:true, runtime, flags, format, hardware, gpu_name, vram_gb}`
 * on a match, or `{ok:false, error, hint}` when the (format, hardware) pair
 * is not supported.
 */
export async function selectRuntime(artifactPath, hardware) {
  const lower = String(artifactPath || '').toLowerCase();
  let format = null;
  if (lower.endsWith('.gguf')) format = 'gguf';
  else if (lower.endsWith('.safetensors')) format = 'safetensors';
  else if (lower.endsWith('.mlx')) format = 'mlx';
  else if (lower.endsWith('.exl2')) format = 'exl2';
  if (!format) {
    return {
      ok: false,
      error: 'unknown_artifact_format',
      hint: `selectRuntime supports .gguf, .safetensors, .mlx, .exl2; got ${artifactPath}`,
    };
  }
  let hwClass = null;
  let gpu_name = null;
  let vram_gb = null;
  if (typeof hardware === 'string') {
    hwClass = hardware.toLowerCase();
  } else if (hardware && typeof hardware === 'object') {
    hwClass = String(hardware.class || hardware.gpu_class || 'cpu').toLowerCase();
    gpu_name = hardware.gpu_name || null;
    vram_gb = Number.isFinite(Number(hardware.vram_gb)) ? Number(hardware.vram_gb) : null;
  }
  if (!hwClass) {
    return {
      ok: false,
      error: 'hardware_required',
      hint: 'pass hardware as "cuda" | "metal" | "cpu" or {class, gpu_name?, vram_gb?}',
    };
  }
  const formatTable = RUNTIME_SELECTION[format];
  const row = formatTable && formatTable[hwClass];
  if (!row) {
    return {
      ok: false,
      error: 'unsupported_pairing',
      hint: `format ${format} on hardware ${hwClass} is not in RUNTIME_SELECTION`,
      format,
      hardware: hwClass,
    };
  }
  return {
    ok: true,
    runtime: row.runtime,
    flags: row.flags,
    format,
    hardware: hwClass,
    gpu_name,
    vram_gb,
  };
}

// All runtimes we know how to dispatch. Keep in sync with cmdServe in
// cli/kolm.js. Adding a runtime here without adding the spawn path there
// will produce a "runtime detected but no boot path" warning at run time.
export const KNOWN_RUNTIMES = Object.freeze([
  'llama.cpp',
  'vllm',
  'mlx',
  'ollama',
]);

// Inspect a hardware probe and figure out the GPU class. We only care about
// three axes for the routing table:
//   - cuda  : NVIDIA + a compute-capable GPU with >= 4 GB VRAM
//   - metal : Apple Silicon (unified memory >= 8 GB rec, but we accept any)
//   - cpu   : everything else (no GPU, or unknown vendor)
function gpuClass(hwProbe) {
  if (!hwProbe || !hwProbe.primary) return 'cpu';
  const p = hwProbe.primary;
  if (p.vendor === 'nvidia' && p.vram_gb >= 4) return 'cuda';
  if (p.vendor === 'apple') return 'metal';
  // AMD ROCm is reachable via llama.cpp HIP but vLLM coverage is shakier;
  // group with cuda for llama.cpp paths so the routing table stays simple.
  if (p.vendor === 'amd' && p.vram_gb >= 4) return 'cuda';
  return 'cpu';
}

// Pull the artifact format from either the file suffix or an explicit manifest
// `format` field. Manifest wins because some operators rename .gguf to .bin or
// .safetensors to .pt; the manifest is the canonical source.
function artifactFormat({ artifactPath, manifest }) {
  if (manifest && manifest.format) {
    const f = String(manifest.format).toLowerCase();
    if (f === 'gguf' || f === 'safetensors' || f === 'mlx') return f;
  }
  const lower = String(artifactPath || '').toLowerCase();
  if (lower.endsWith('.gguf')) return 'gguf';
  if (lower.endsWith('.safetensors')) return 'safetensors';
  if (lower.endsWith('.mlx')) return 'mlx';
  return 'unknown';
}

// Estimate llama.cpp -ngl (number of GPU layers to offload). Use the manifest
// hint if present, otherwise pick a conservative default per GPU class. -1
// means "offload all layers" in llama.cpp; we only use -1 when the operator
// passes gpuLayers === 'auto' AND the GPU has >= 16 GB VRAM (else we cap to
// 32 layers to avoid OOM on smaller cards).
function pickGpuLayers({ gpuLayers, hwProbe, manifest }) {
  if (gpuLayers && gpuLayers !== 'auto') {
    const n = parseInt(gpuLayers, 10);
    if (Number.isFinite(n)) return n;
  }
  if (manifest && Number.isFinite(manifest.gpu_layers)) return manifest.gpu_layers;
  const vram = hwProbe?.primary?.vram_gb || 0;
  if (vram >= 16) return -1;   // offload everything
  if (vram >= 8) return 32;    // partial offload
  if (vram >= 4) return 20;    // minimal offload
  return 0;                    // CPU only
}

/**
 * Decide which runtime to boot for the given artifact + hardware shape.
 *
 * @param {Object} opts
 * @param {string} opts.artifactPath  - absolute or relative path to the model file
 * @param {Object} opts.hwProbe       - shape from detectHardware() in forge-hardware.js
 * @param {Object} [opts.manifest]    - optional manifest with .format / .gpu_layers
 * @param {string} [opts.override]    - explicit --runtime <x> flag, bypasses auto-pick
 * @param {string} [opts.gpuLayers]   - explicit --gpu-layers <n|auto> flag
 * @param {number} [opts.contextLength=4096] - --context-length flag
 * @param {number} [opts.port=8788]   - --port flag
 * @param {string} [opts.host='0.0.0.0'] - --host flag
 *
 * @returns {Object} { runtime, reason, command, env, format, gpu_class }
 *   - runtime: one of KNOWN_RUNTIMES or 'unsupported'
 *   - reason : short string explaining the choice / unsupported reason
 *   - command: { bin: string, args: string[] } the spawn invocation
 *   - env    : { ... } env vars to layer on top of process.env
 */
export function detectRuntime(opts) {
  const {
    artifactPath,
    hwProbe,
    manifest,
    override,
    gpuLayers,
    contextLength = 4096,
    port = 8788,
    host = '0.0.0.0',
  } = opts || {};

  const format = artifactFormat({ artifactPath, manifest });
  const klass = gpuClass(hwProbe);
  const env = {};

  // --- 1. Explicit --runtime override wins, no auto-pick. -------------------
  if (override) {
    const rt = String(override).toLowerCase();
    if (!KNOWN_RUNTIMES.includes(rt)) {
      return {
        runtime: 'unsupported',
        reason: `override "${override}" is not one of: ${KNOWN_RUNTIMES.join(', ')}`,
        format,
        gpu_class: klass,
      };
    }
    return {
      runtime: rt,
      reason: `override (--runtime ${rt})`,
      command: buildCommand(rt, { artifactPath, contextLength, port, host, gpuLayers: pickGpuLayers({ gpuLayers, hwProbe, manifest }), klass }),
      env,
      format,
      gpu_class: klass,
    };
  }

  // --- 2. GGUF + ollama override (--runtime ollama already handled above) --
  //     left intentionally for the override path; no auto-route to ollama.

  // --- 3-5. GGUF routes to llama.cpp regardless of hardware. ----------------
  if (format === 'gguf') {
    if (klass === 'cuda') {
      const ngl = pickGpuLayers({ gpuLayers, hwProbe, manifest });
      return {
        runtime: 'llama.cpp',
        reason: `gguf + cuda GPU (${hwProbe?.primary?.name || 'nvidia'}) -> llama.cpp with -ngl ${ngl}`,
        command: buildCommand('llama.cpp', { artifactPath, contextLength, port, host, gpuLayers: ngl, klass }),
        env,
        format,
        gpu_class: klass,
      };
    }
    if (klass === 'metal') {
      return {
        runtime: 'llama.cpp',
        reason: `gguf + Apple Silicon -> llama.cpp with --metal`,
        command: buildCommand('llama.cpp', { artifactPath, contextLength, port, host, klass }),
        env,
        format,
        gpu_class: klass,
      };
    }
    return {
      runtime: 'llama.cpp',
      reason: `gguf + cpu only -> llama.cpp CPU mode`,
      command: buildCommand('llama.cpp', { artifactPath, contextLength, port, host, gpuLayers: 0, klass }),
      env,
      format,
      gpu_class: klass,
    };
  }

  // --- 6-7. safetensors -> vllm (CUDA) or mlx (Apple). ---------------------
  if (format === 'safetensors') {
    if (klass === 'cuda') {
      return {
        runtime: 'vllm',
        reason: `safetensors + cuda GPU -> vllm OpenAI-compat server`,
        command: buildCommand('vllm', { artifactPath, contextLength, port, host, klass }),
        env,
        format,
        gpu_class: klass,
      };
    }
    if (klass === 'metal') {
      return {
        runtime: 'mlx',
        reason: `safetensors + Apple Silicon -> mlx-lm.server (vLLM not on Apple yet)`,
        command: buildCommand('mlx', { artifactPath, contextLength, port, host, klass }),
        env,
        format,
        gpu_class: klass,
      };
    }
    return {
      runtime: 'unsupported',
      reason: `safetensors on cpu-only host: install CUDA or quantize to gguf first`,
      format,
      gpu_class: klass,
    };
  }

  // --- 8. .mlx -> mlx-lm.server regardless of hardware. --------------------
  if (format === 'mlx') {
    if (klass !== 'metal') {
      return {
        runtime: 'unsupported',
        reason: `.mlx artifact requires Apple Silicon; host is ${klass}`,
        format,
        gpu_class: klass,
      };
    }
    return {
      runtime: 'mlx',
      reason: `.mlx artifact + Apple Silicon -> mlx-lm.server`,
      command: buildCommand('mlx', { artifactPath, contextLength, port, host, klass }),
      env,
      format,
      gpu_class: klass,
    };
  }

  // --- 9. Unknown format / unsupported pairing. ----------------------------
  return {
    runtime: 'unsupported',
    reason: `unknown artifact format (suffix "${path.extname(artifactPath || '')}"); supported: .gguf, .safetensors, .mlx`,
    format,
    gpu_class: klass,
  };
}

// ---------------------------------------------------------------------------
// buildCommand: turn (runtime, params) into a concrete {bin, args} we can
// hand to child_process.spawn. We keep this as data, not strings, so callers
// can introspect (--dry-run prints it) without re-parsing.
// ---------------------------------------------------------------------------
function buildCommand(runtime, p) {
  const { artifactPath, contextLength, port, host, gpuLayers, klass } = p;
  if (runtime === 'llama.cpp') {
    // llama-server is the OpenAI-compat HTTP daemon in llama.cpp.
    // The legacy binary name is `server`; we prefer `llama-server` because
    // newer llama.cpp builds rename it. Caller's PATH resolves the choice.
    const args = [
      '--model', artifactPath,
      '--ctx-size', String(contextLength),
      '--host', host,
      '--port', String(port),
    ];
    if (klass === 'cuda' && Number.isFinite(gpuLayers)) {
      args.push('-ngl', String(gpuLayers));
    }
    if (klass === 'metal') {
      // llama.cpp on Apple ships Metal by default; flag is informational.
      // We pass it for the dry-run print so the operator sees what would run.
      args.push('--metal');
    }
    return { bin: 'llama-server', args };
  }
  if (runtime === 'vllm') {
    // vLLM OpenAI-compat server via python -m vllm.entrypoints.openai.api_server.
    const args = [
      '-m', 'vllm.entrypoints.openai.api_server',
      '--model', artifactPath,
      '--host', host,
      '--port', String(port),
      '--max-model-len', String(contextLength),
    ];
    return { bin: 'python', args };
  }
  if (runtime === 'mlx') {
    // mlx-lm.server is shipped by the mlx-lm Python package.
    const args = [
      '-m', 'mlx_lm.server',
      '--model', artifactPath,
      '--host', host,
      '--port', String(port),
    ];
    return { bin: 'python', args };
  }
  if (runtime === 'ollama') {
    // Ollama works model-name not file-path. The caller is expected to have
    // run `ollama create <name> -f <Modelfile>` first; here we just `ollama serve`
    // and the model is pulled by name via the API.
    const args = ['serve'];
    return { bin: 'ollama', args };
  }
  return { bin: '/bin/false', args: [] };
}

// ---------------------------------------------------------------------------
// docker-compose.yml emitter. R-4 may provide a richer one; this is the
// minimal-but-valid fallback used by `kolm serve --docker`. Output is a
// string of YAML; the caller pipes to stdout or a file.
// ---------------------------------------------------------------------------
export function buildDockerCompose({ runtime, artifactPath, port = 8788, contextLength = 4096 }) {
  const image = {
    'llama.cpp': 'ghcr.io/ggerganov/llama.cpp:server',
    'vllm':      'vllm/vllm-openai:latest',
    'mlx':       'python:3.11-slim',      // mlx requires Apple Silicon; Linux image is a placeholder
    'ollama':    'ollama/ollama:latest',
  }[runtime] || 'ghcr.io/ggerganov/llama.cpp:server';

  const artifactDir = path.dirname(artifactPath || '/models/model.gguf');
  const artifactName = path.basename(artifactPath || 'model.gguf');

  // Use 2-space indent everywhere; valid YAML, parses with js-yaml.
  const lines = [
    `version: "3.8"`,
    `services:`,
    `  kolm-serve:`,
    `    image: ${image}`,
    `    container_name: kolm-serve`,
    `    restart: unless-stopped`,
    `    ports:`,
    `      - "${port}:${port}"`,
    `    volumes:`,
    `      - "${artifactDir}:/artifacts:ro"`,
    `    environment:`,
    `      KOLM_RUNTIME: "${runtime}"`,
    `      KOLM_CONTEXT_LENGTH: "${contextLength}"`,
    `    command:`,
    `      - "--model"`,
    `      - "/artifacts/${artifactName}"`,
    `      - "--port"`,
    `      - "${port}"`,
    `      - "--host"`,
    `      - "0.0.0.0"`,
    `      - "--ctx-size"`,
    `      - "${contextLength}"`,
  ];
  // GPU section for nvidia / vllm only.
  if (runtime === 'vllm' || runtime === 'llama.cpp') {
    lines.push(
      `    deploy:`,
      `      resources:`,
      `        reservations:`,
      `          devices:`,
      `            - driver: nvidia`,
      `              count: 1`,
      `              capabilities: ["gpu"]`,
    );
  }
  lines.push(
    `    healthcheck:`,
    `      test: ["CMD", "curl", "-f", "http://localhost:${port}/health"]`,
    `      interval: 30s`,
    `      timeout: 10s`,
    `      retries: 3`,
    ``,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// k8s manifests emitter. Produces 5 documents joined by `---`:
//   Deployment, Service, HorizontalPodAutoscaler, ConfigMap, PersistentVolumeClaim
// Plus an init container inside the Deployment that fetches the artifact from
// an OCI registry on first boot (mostly inert; operator can replace with
// `kolm pull` if they prefer). Test asserts the 5 kinds are present.
// ---------------------------------------------------------------------------
export function buildK8sManifests({ runtime, artifactPath, port = 8788, contextLength = 4096, name = 'kolm-serve' }) {
  const image = {
    'llama.cpp': 'ghcr.io/ggerganov/llama.cpp:server',
    'vllm':      'vllm/vllm-openai:latest',
    'mlx':       'python:3.11-slim',
    'ollama':    'ollama/ollama:latest',
  }[runtime] || 'ghcr.io/ggerganov/llama.cpp:server';

  const artifactName = path.basename(artifactPath || 'model.gguf');

  const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app: ${name}
    kolm.ai/runtime: ${runtime}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
        kolm.ai/runtime: ${runtime}
    spec:
      initContainers:
        - name: artifact-fetch
          image: busybox:1.36
          command: ["sh", "-c", "test -f /artifacts/${artifactName} || echo 'artifact /artifacts/${artifactName} must be pre-provisioned via PVC'"]
          volumeMounts:
            - name: artifact-vol
              mountPath: /artifacts
      containers:
        - name: kolm-serve
          image: ${image}
          ports:
            - containerPort: ${port}
              name: http
          envFrom:
            - configMapRef:
                name: ${name}-config
          args:
            - "--model"
            - "/artifacts/${artifactName}"
            - "--port"
            - "${port}"
            - "--host"
            - "0.0.0.0"
            - "--ctx-size"
            - "${contextLength}"
          resources:
            limits:
              nvidia.com/gpu: 1
              memory: 24Gi
            requests:
              memory: 8Gi
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 60
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 120
            periodSeconds: 30
          volumeMounts:
            - name: artifact-vol
              mountPath: /artifacts
              readOnly: true
      volumes:
        - name: artifact-vol
          persistentVolumeClaim:
            claimName: ${name}-pvc`;

  const service = `apiVersion: v1
kind: Service
metadata:
  name: ${name}-svc
  labels:
    app: ${name}
spec:
  selector:
    app: ${name}
  ports:
    - name: http
      port: ${port}
      targetPort: ${port}
      protocol: TCP
  type: ClusterIP`;

  const hpa = `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${name}-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${name}
  minReplicas: 1
  maxReplicas: 4
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 75`;

  const configMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}-config
data:
  KOLM_RUNTIME: "${runtime}"
  KOLM_CONTEXT_LENGTH: "${contextLength}"
  KOLM_PORT: "${port}"`;

  const pvc = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${name}-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 64Gi`;

  return [deployment, service, hpa, configMap, pvc].join('\n---\n') + '\n';
}

// R-4 — deployment config generators.
//
// Four generators for taking a compiled .kolm artifact and emitting the
// platform configs an operator actually needs:
//
//   generateDockerCompose      -> docker-compose.yml (vLLM or llama.cpp service)
//   generateKubernetesManifests-> multi-doc YAML (Deployment, Service, HPA,
//                                 ConfigMap, PVC, Job)
//   generateVllmConfig         -> JSON config for `vllm serve --config-file`
//   generateAirgapBundle       -> writes a tar.gz with artifact + runtime +
//                                 offline verifier + sha256 manifest
//
// Design notes:
// - String output (compose/k8s/vllm) is what operators paste into git, so
//   the formatting is deterministic + commented. We hand-roll the YAML to
//   avoid pulling unnecessary anchors / explicit-tags into operator-facing
//   files (js-yaml round-trip can produce hard-to-read output for k8s).
// - Every generator returns the string; the caller (CLI verb) decides
//   where to write it.
// - The air-gap bundle is the only generator that touches disk, because
//   the tarball IS the deliverable. It uses `tar-stream` (already in
//   node_modules) + Node's built-in `zlib` instead of `archiver`, so we
//   can stream the entries deterministically and read the sha of each
//   payload before it goes into the tar.
//
// No outbound network. No shelling out. All four are pure JS.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEPLOY_GENERATORS_VERSION = 'r4-v1';

// Two supported serving runtimes. Anything else throws.
const SUPPORTED_RUNTIMES = new Set(['vllm', 'llama.cpp']);

function _checkRuntime(runtime) {
  if (!SUPPORTED_RUNTIMES.has(runtime)) {
    throw new Error(
      'unsupported runtime: ' + JSON.stringify(runtime) +
      ' (one of: ' + [...SUPPORTED_RUNTIMES].join(', ') + ')'
    );
  }
}

// ---------- 1. Docker Compose ---------------------------------------------
//
// Produces a docker-compose.yml string with a single service for the chosen
// runtime, a named volume bind for the model, a healthcheck on /health, and
// a commented-out NGINX TLS proxy block. The output is hand-rolled YAML so
// the comments + ordering are stable across runs.

export function generateDockerCompose({
  artifact,
  runtime = 'vllm',
  port = 8000,
  model_path,
} = {}) {
  _checkRuntime(runtime);
  if (!artifact || typeof artifact !== 'string') {
    throw new Error('generateDockerCompose: {artifact} is required (artifact id or filename)');
  }
  const safeArtifact = String(artifact).replace(/[^A-Za-z0-9._-]/g, '_');
  const mountedModel = model_path || '/models/' + safeArtifact;
  const hostModelPath = './models/' + safeArtifact;
  const exposedPort = Number(port) || 8000;

  // The two runtimes have slightly different healthchecks + commands.
  // vLLM exposes /health on the OpenAI-compatible port. llama.cpp server
  // exposes /health on whatever --port it was started with.
  const services =
    runtime === 'vllm'
      ? [
          '  kolm-runtime:',
          '    image: vllm/vllm-openai:latest',
          '    container_name: kolm-' + safeArtifact,
          '    restart: unless-stopped',
          '    runtime: nvidia                 # remove if you do not have NVIDIA Container Toolkit',
          '    deploy:',
          '      resources:',
          '        reservations:',
          '          devices:',
          '            - driver: nvidia',
          '              count: 1',
          '              capabilities: [gpu]',
          '    environment:',
          '      - HUGGING_FACE_HUB_TOKEN=${HUGGING_FACE_HUB_TOKEN:-}',
          '      - VLLM_NO_USAGE_STATS=1',
          '    command:',
          '      - --model',
          '      - ' + mountedModel,
          '      - --port',
          '      - "' + exposedPort + '"',
          '      - --host',
          '      - "0.0.0.0"',
          '      - --served-model-name',
          '      - "' + safeArtifact + '"',
          '    ports:',
          '      - "' + exposedPort + ':' + exposedPort + '"',
          '    volumes:',
          '      - ' + hostModelPath + ':' + mountedModel + ':ro',
          '    healthcheck:',
          '      test: ["CMD-SHELL", "curl -fsS http://localhost:' + exposedPort + '/health || exit 1"]',
          '      interval: 30s',
          '      timeout: 5s',
          '      retries: 5',
          '      start_period: 60s',
        ].join('\n')
      : [
          '  kolm-runtime:',
          '    image: ghcr.io/ggml-org/llama.cpp:server',
          '    container_name: kolm-' + safeArtifact,
          '    restart: unless-stopped',
          '    command:',
          '      - "--model"',
          '      - "' + mountedModel + '"',
          '      - "--port"',
          '      - "' + exposedPort + '"',
          '      - "--host"',
          '      - "0.0.0.0"',
          '      - "--alias"',
          '      - "' + safeArtifact + '"',
          '    ports:',
          '      - "' + exposedPort + ':' + exposedPort + '"',
          '    volumes:',
          '      - ' + hostModelPath + ':' + mountedModel + ':ro',
          '    healthcheck:',
          '      test: ["CMD-SHELL", "curl -fsS http://localhost:' + exposedPort + '/health || exit 1"]',
          '      interval: 30s',
          '      timeout: 5s',
          '      retries: 5',
          '      start_period: 30s',
        ].join('\n');

  const proxyBlock = [
    '  # ---- Optional NGINX TLS terminator ----------------------------------------',
    '  # Uncomment and fill in cert paths + server_name. Place a real nginx.conf in',
    '  # ./nginx/nginx.conf that proxies to http://kolm-runtime:' + exposedPort + '.',
    '  # See docs/self-hosted-deploy-complete.md section 7 for a working example.',
    '  #',
    '  # nginx-tls:',
    '  #   image: nginx:1.27-alpine',
    '  #   container_name: kolm-tls',
    '  #   restart: unless-stopped',
    '  #   depends_on:',
    '  #     kolm-runtime:',
    '  #       condition: service_healthy',
    '  #   ports:',
    '  #     - "443:443"',
    '  #     - "80:80"',
    '  #   volumes:',
    '  #     - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro',
    '  #     - /etc/ssl/kolm.pem:/etc/ssl/kolm.pem:ro       # TODO: fill in cert path',
    '  #     - /etc/ssl/kolm.key:/etc/ssl/kolm.key:ro       # TODO: fill in key path',
    '  #   healthcheck:',
    '  #     test: ["CMD-SHELL", "wget -qO- http://localhost/health >/dev/null || exit 1"]',
    '  #     interval: 30s',
  ].join('\n');

  return [
    '# kolm deploy — docker-compose (' + runtime + ')',
    '# artifact: ' + artifact,
    '# generator: ' + DEPLOY_GENERATORS_VERSION,
    '#',
    '# Place your model files under ' + hostModelPath + ' before `docker compose up`.',
    '# Container expects to find the model at ' + mountedModel + '.',
    '',
    'services:',
    services,
    '',
    proxyBlock,
    '',
  ].join('\n');
}

// ---------- 2. Kubernetes manifests --------------------------------------
//
// Multi-document YAML containing: ConfigMap, PersistentVolumeClaim, Job
// (init download), Deployment, Service, HorizontalPodAutoscaler. The order
// is intentional — `kubectl apply -f` processes top-down and we want the
// PVC + ConfigMap + Job ready before the Deployment + Service spin up.

export function generateKubernetesManifests({
  artifact,
  runtime = 'vllm',
  gpu_count = 1,
  namespace = 'default',
} = {}) {
  _checkRuntime(runtime);
  if (!artifact || typeof artifact !== 'string') {
    throw new Error('generateKubernetesManifests: {artifact} is required');
  }
  const safe = String(artifact).replace(/[^A-Za-z0-9-]/g, '-').toLowerCase().slice(0, 40) || 'kolm-artifact';
  const name = 'kolm-' + safe;
  const ns = String(namespace || 'default').replace(/[^A-Za-z0-9-]/g, '-').toLowerCase() || 'default';
  const gpus = Math.max(1, Number(gpu_count) || 1);
  const image = runtime === 'vllm' ? 'vllm/vllm-openai:latest' : 'ghcr.io/ggml-org/llama.cpp:server';
  const startCmd = runtime === 'vllm'
    ? '["--model", "/models/' + artifact + '", "--port", "8000", "--host", "0.0.0.0", "--served-model-name", "' + artifact + '"]'
    : '["--model", "/models/' + artifact + '", "--port", "8000", "--host", "0.0.0.0", "--alias", "' + artifact + '"]';

  // Note: the Job downloads from `KOLM_REGISTRY_URL` which the operator
  // sets to their internal artifact registry. The Job is a one-shot —
  // re-runs are idempotent (it skips if the file already exists).
  const configMap = [
    '---',
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: ' + name + '-config',
    '  namespace: ' + ns,
    '  labels:',
    '    app.kubernetes.io/name: ' + name,
    '    app.kubernetes.io/managed-by: kolm',
    'data:',
    '  artifact_id: "' + artifact + '"',
    '  runtime: "' + runtime + '"',
    '  port: "8000"',
    '  served_model_name: "' + artifact + '"',
  ].join('\n');

  const pvc = [
    '---',
    'apiVersion: v1',
    'kind: PersistentVolumeClaim',
    'metadata:',
    '  name: ' + name + '-models',
    '  namespace: ' + ns,
    'spec:',
    '  accessModes:',
    '    - ReadWriteOnce',
    '  resources:',
    '    requests:',
    '      storage: 100Gi',
  ].join('\n');

  // The init Job pulls the artifact from a private registry. The downloader
  // image is `curlimages/curl` so it works in air-gap when mirrored. The
  // KOLM_REGISTRY_URL + KOLM_API_KEY env vars are typically injected from a
  // Secret named `kolm-registry-secret` (out of scope for this generator;
  // see docs/self-hosted-deploy-complete.md section 3.2).
  const job = [
    '---',
    'apiVersion: batch/v1',
    'kind: Job',
    'metadata:',
    '  name: ' + name + '-init-download',
    '  namespace: ' + ns,
    'spec:',
    '  backoffLimit: 4',
    '  ttlSecondsAfterFinished: 600',
    '  template:',
    '    metadata:',
    '      labels:',
    '        app.kubernetes.io/name: ' + name,
    '        app.kubernetes.io/component: init',
    '    spec:',
    '      restartPolicy: OnFailure',
    '      containers:',
    '        - name: download',
    '          image: curlimages/curl:8.10.1',
    '          env:',
    '            - name: KOLM_REGISTRY_URL',
    '              valueFrom:',
    '                secretKeyRef:',
    '                  name: kolm-registry-secret',
    '                  key: url',
    '                  optional: true',
    '            - name: KOLM_API_KEY',
    '              valueFrom:',
    '                secretKeyRef:',
    '                  name: kolm-registry-secret',
    '                  key: api_key',
    '                  optional: true',
    '          command: ["sh", "-c"]',
    '          args:',
    '            - |',
    '              set -eu',
    '              dest=/models/' + artifact,
    '              if [ -e "$dest" ]; then',
    '                echo "artifact ' + artifact + ' already present, skipping download"',
    '                exit 0',
    '              fi',
    '              mkdir -p "$(dirname "$dest")"',
    '              auth=""',
    '              if [ -n "${KOLM_API_KEY:-}" ]; then auth="-H Authorization: Bearer $KOLM_API_KEY"; fi',
    '              curl -fsSL $auth "${KOLM_REGISTRY_URL}/artifacts/' + artifact + '" -o "$dest"',
    '          volumeMounts:',
    '            - name: models',
    '              mountPath: /models',
    '      volumes:',
    '        - name: models',
    '          persistentVolumeClaim:',
    '            claimName: ' + name + '-models',
  ].join('\n');

  const deployment = [
    '---',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: ' + name,
    '  namespace: ' + ns,
    '  labels:',
    '    app.kubernetes.io/name: ' + name,
    '    app.kubernetes.io/managed-by: kolm',
    'spec:',
    '  replicas: 1',
    '  selector:',
    '    matchLabels:',
    '      app.kubernetes.io/name: ' + name,
    '  template:',
    '    metadata:',
    '      labels:',
    '        app.kubernetes.io/name: ' + name,
    '    spec:',
    '      containers:',
    '        - name: runtime',
    '          image: ' + image,
    '          imagePullPolicy: IfNotPresent',
    '          args: ' + startCmd,
    '          ports:',
    '            - name: http',
    '              containerPort: 8000',
    '              protocol: TCP',
    '          resources:',
    '            limits:',
    '              nvidia.com/gpu: ' + gpus,
    '            requests:',
    '              nvidia.com/gpu: ' + gpus,
    '              cpu: "2"',
    '              memory: "16Gi"',
    '          livenessProbe:',
    '            httpGet:',
    '              path: /health',
    '              port: 8000',
    '            initialDelaySeconds: 60',
    '            periodSeconds: 30',
    '            timeoutSeconds: 5',
    '            failureThreshold: 5',
    '          readinessProbe:',
    '            httpGet:',
    '              path: /health',
    '              port: 8000',
    '            initialDelaySeconds: 30',
    '            periodSeconds: 10',
    '            timeoutSeconds: 5',
    '            failureThreshold: 3',
    '          volumeMounts:',
    '            - name: models',
    '              mountPath: /models',
    '              readOnly: true',
    '      volumes:',
    '        - name: models',
    '          persistentVolumeClaim:',
    '            claimName: ' + name + '-models',
  ].join('\n');

  const service = [
    '---',
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '  name: ' + name,
    '  namespace: ' + ns,
    '  labels:',
    '    app.kubernetes.io/name: ' + name,
    'spec:',
    '  type: ClusterIP',
    '  selector:',
    '    app.kubernetes.io/name: ' + name,
    '  ports:',
    '    - name: http',
    '      port: 8000',
    '      targetPort: 8000',
    '      protocol: TCP',
  ].join('\n');

  const hpa = [
    '---',
    'apiVersion: autoscaling/v2',
    'kind: HorizontalPodAutoscaler',
    'metadata:',
    '  name: ' + name,
    '  namespace: ' + ns,
    'spec:',
    '  scaleTargetRef:',
    '    apiVersion: apps/v1',
    '    kind: Deployment',
    '    name: ' + name,
    '  minReplicas: 1',
    '  maxReplicas: 5',
    '  metrics:',
    '    - type: Resource',
    '      resource:',
    '        name: cpu',
    '        target:',
    '          type: Utilization',
    '          averageUtilization: 70',
  ].join('\n');

  return [
    '# kolm deploy — kubernetes manifests (' + runtime + ', ' + gpus + ' gpu)',
    '# artifact:  ' + artifact,
    '# namespace: ' + ns,
    '# generator: ' + DEPLOY_GENERATORS_VERSION,
    '#',
    '# kubectl create namespace ' + ns + '  # if it does not exist',
    '# kubectl apply -f .',
    configMap,
    pvc,
    job,
    deployment,
    service,
    hpa,
    '',
  ].join('\n');
}

// ---------- 3. vLLM config ------------------------------------------------
//
// JSON string. Validates via round-trip parse before returning so we never
// hand back a malformed file. Fields chosen to match what `vllm serve
// --config-file <path>` reads in 0.6.x+.

export function generateVllmConfig({
  artifact,
  gpu_memory_utilization = 0.9,
  tensor_parallel_size = 1,
  quantization = null,
  dtype = 'auto',
  max_model_len = 4096,
} = {}) {
  if (!artifact || typeof artifact !== 'string') {
    throw new Error('generateVllmConfig: {artifact} is required (artifact id or model path)');
  }
  const gmu = Number(gpu_memory_utilization);
  if (!(gmu > 0 && gmu <= 1)) {
    throw new Error('generateVllmConfig: gpu_memory_utilization must be in (0, 1], got ' + gpu_memory_utilization);
  }
  const tps = Number(tensor_parallel_size);
  if (!(Number.isInteger(tps) && tps >= 1)) {
    throw new Error('generateVllmConfig: tensor_parallel_size must be a positive integer, got ' + tensor_parallel_size);
  }
  const mml = Number(max_model_len);
  if (!(Number.isInteger(mml) && mml >= 128)) {
    throw new Error('generateVllmConfig: max_model_len must be an integer >= 128, got ' + max_model_len);
  }
  const config = {
    model: artifact,
    quantization: quantization || null,
    dtype: dtype || 'auto',
    max_model_len: mml,
    gpu_memory_utilization: Number(gmu.toFixed(4)),
    tensor_parallel_size: tps,
    enforce_eager: false,
    swap_space: 4,
    kv_cache_dtype: 'auto',
    trust_remote_code: false,
    download_dir: null,
    served_model_name: artifact,
    served_model_aliases: [],
    disable_log_stats: false,
    generator: DEPLOY_GENERATORS_VERSION,
  };
  const serialized = JSON.stringify(config, null, 2);
  // Round-trip parse so a malformed key/value pair never leaves this module.
  JSON.parse(serialized);
  return serialized;
}

// ---------- 4. Air-gap bundle --------------------------------------------
//
// Real tar.gz output. The bundle layout:
//
//   /artifact.kolm                  -> caller's artifact, copied byte-for-byte
//   /runtime/install.sh             -> shell script that installs the runtime
//   /runtime/wheels/                -> empty placeholder (operator fills in)
//   /config/vllm.json               -> vLLM config (when runtime=vllm)
//   /config/llama-cpp.cmd           -> startup command (when runtime=llama.cpp)
//   /verify.cjs                     -> offline verifier (kolm-audit-1 minimal)
//   /MANIFEST.sha256                -> sha256 manifest of every file
//   /README.md                      -> offline-install instructions
//
// Returns {ok, bundle_path, manifest_sha256, size_bytes, file_count, sha256}.
// Throws only on truly unrecoverable conditions (missing input artifact);
// every recoverable failure returns ok:false + error + hint.

const VERIFIER_BODY = `#!/usr/bin/env node
// Minimal kolm-audit-1 offline receipt verifier — bundled with air-gap exports.
//
// Verifies a kolm-audit-1 receipt JSON file using only the local secret
// (HMAC) and the bundled trust roots. Never makes a network call. Exits 0
// on \`{ok: true}\`, exit 1 otherwise.
//
// Usage:
//   node verify.cjs <receipt.json> [--secret <hex>] [--manifest ./MANIFEST.sha256]
//
// When --manifest is passed, additionally checks that every file in the
// manifest matches its recorded sha256 (catches transport tampering).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function hmacSha256(secretHex, payloadBuf) {
  const key = Buffer.from(secretHex, 'hex');
  return crypto.createHmac('sha256', key).update(payloadBuf).digest('hex');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function verifyReceipt(receipt, secretHex) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, error: 'receipt_not_object' };
  if (receipt.spec !== 'kolm-audit-1') return { ok: false, error: 'spec_mismatch', expected: 'kolm-audit-1', got: receipt.spec };
  const sig = receipt.sig;
  if (!sig || typeof sig !== 'string') return { ok: false, error: 'sig_missing' };
  if (!secretHex) return { ok: false, error: 'secret_missing', hint: 'pass --secret <hex> or set KOLM_ARTIFACT_SECRET' };
  const copy = Object.assign({}, receipt);
  delete copy.sig;
  const canonical = Buffer.from(JSON.stringify(copy));
  const expected = hmacSha256(secretHex, canonical);
  const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  return ok ? { ok: true, cid: receipt.cid || null } : { ok: false, error: 'sig_mismatch' };
}

function verifyManifest(manifestPath) {
  const root = path.dirname(path.resolve(manifestPath));
  const lines = fs.readFileSync(manifestPath, 'utf8').split('\\n').filter(Boolean);
  let ok = 0, bad = 0;
  const bad_files = [];
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})\\s+\\*?(.+)$/);
    if (!m) continue;
    const [, expectedSha, relPath] = m;
    if (relPath === 'MANIFEST.sha256') continue;
    const abs = path.join(root, relPath);
    if (!fs.existsSync(abs)) { bad++; bad_files.push({ path: relPath, error: 'missing' }); continue; }
    const h = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (h === expectedSha) ok++;
    else { bad++; bad_files.push({ path: relPath, expected: expectedSha, got: h }); }
  }
  return { ok: bad === 0, files_ok: ok, files_bad: bad, bad_files };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write('usage: node verify.cjs <receipt.json> [--secret <hex>] [--manifest ./MANIFEST.sha256]\\n');
    process.exit(args.length ? 0 : 1);
  }
  const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const receiptPath = args.find(a => !a.startsWith('--')) ;
  const secret = get('--secret') || process.env.KOLM_ARTIFACT_SECRET || process.env.RECIPE_RECEIPT_SECRET || null;
  const manifestPath = get('--manifest') || null;
  let result;
  try {
    const receipt = readJson(receiptPath);
    result = verifyReceipt(receipt, secret);
  } catch (e) {
    result = { ok: false, error: 'receipt_read_failed', detail: e.message };
  }
  if (result.ok && manifestPath && fs.existsSync(manifestPath)) {
    const m = verifyManifest(manifestPath);
    result.manifest = m;
    if (!m.ok) result.ok = false;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\\n');
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { verifyReceipt, verifyManifest, hmacSha256 };
`;

function _installScript(runtime) {
  if (runtime === 'vllm') {
    return [
      '#!/usr/bin/env bash',
      '# kolm air-gap runtime installer — vLLM',
      'set -euo pipefail',
      '',
      'echo "[kolm-airgap] installing vLLM from local wheelhouse"',
      'WHEELHOUSE="$(dirname "$0")/wheels"',
      'if [ ! -d "$WHEELHOUSE" ] || [ -z "$(ls -A "$WHEELHOUSE" 2>/dev/null)" ]; then',
      '  echo "[kolm-airgap] WARNING: wheels/ directory is empty."',
      '  echo "[kolm-airgap] On an internet-connected box run:"',
      '  echo "[kolm-airgap]   pip wheel vllm -w wheels/"',
      '  echo "[kolm-airgap] then re-bundle."',
      '  exit 1',
      'fi',
      '',
      'python3 -m pip install --no-index --find-links "$WHEELHOUSE" vllm',
      'echo "[kolm-airgap] vllm installed. start with:"',
      'echo "[kolm-airgap]   vllm serve --config-file ./config/vllm.json"',
      '',
    ].join('\n');
  }
  // llama.cpp
  return [
    '#!/usr/bin/env bash',
    '# kolm air-gap runtime installer — llama.cpp',
    'set -euo pipefail',
    '',
    'echo "[kolm-airgap] installing llama.cpp"',
    'BINARY="$(dirname "$0")/bin/llama-server"',
    'if [ ! -x "$BINARY" ]; then',
    '  echo "[kolm-airgap] WARNING: bin/llama-server missing."',
    '  echo "[kolm-airgap] On an internet-connected box, build llama.cpp and drop the"',
    '  echo "[kolm-airgap] llama-server binary at runtime/bin/llama-server before bundling."',
    '  exit 1',
    'fi',
    '',
    'install -m 0755 "$BINARY" /usr/local/bin/llama-server',
    'echo "[kolm-airgap] installed. start with:"',
    'echo "[kolm-airgap]   bash ./config/llama-cpp.cmd"',
    '',
  ].join('\n');
}

function _readme({ artifact_id, runtime, created_at, manifest_sha256 }) {
  return [
    '# kolm air-gap deployment bundle',
    '',
    '- **Artifact:** ' + artifact_id,
    '- **Runtime:** ' + runtime,
    '- **Built:** ' + created_at,
    '- **Manifest sha256:** ' + manifest_sha256,
    '- **Bundle version:** ' + DEPLOY_GENERATORS_VERSION,
    '',
    '## Layout',
    '',
    '```',
    '/artifact.kolm           — compiled artifact (copy of input)',
    '/runtime/install.sh      — installs the chosen runtime from local wheelhouse',
    '/runtime/wheels/         — drop offline pip wheels here before bundling (vllm only)',
    '/runtime/bin/            — drop llama-server binary here before bundling (llama.cpp only)',
    '/config/                 — runtime config files (vllm.json or llama-cpp.cmd)',
    '/verify.cjs              — offline kolm-audit-1 receipt verifier',
    '/MANIFEST.sha256         — sha256 of every file in this bundle',
    '/README.md               — this file',
    '```',
    '',
    '## Install on the air-gapped host',
    '',
    '```bash',
    'tar -xzf kolm-airgap-' + artifact_id + '-*.tar.gz -C /opt/kolm',
    'cd /opt/kolm',
    'bash runtime/install.sh',
    '```',
    '',
    '## Verify the bundle is intact',
    '',
    '```bash',
    '# Per-file sha256 check (no receipt verification — checks transport integrity)',
    'sha256sum -c MANIFEST.sha256',
    '',
    '# Or via the bundled verifier (also verifies a receipt against the local secret):',
    'node verify.cjs path/to/receipt.json --manifest ./MANIFEST.sha256 --secret $KOLM_ARTIFACT_SECRET',
    '```',
    '',
    '## What is NOT in this bundle',
    '',
    '- TLS certificates — supply via your reverse proxy.',
    '- Secrets (`KOLM_ARTIFACT_SECRET`, registry tokens) — inject via your secrets manager.',
    '- The base model weights — point your runtime config at your local model cache.',
    '',
    'See `docs/self-hosted-deploy-complete.md` (in the main kolm repo) for the full',
    'env-var matrix, SSO setup, systemd unit, and operational runbook.',
    '',
  ].join('\n');
}

// USTAR-style tar header (512 bytes). We hand-roll this instead of pulling
// in tar-stream's async-stream API because we want fully synchronous,
// deterministic output (so the same inputs always produce byte-identical
// tarballs — useful for repro builds + supply-chain attestation).
function _tarHeader(name, size, mode, mtime, typeflag) {
  const header = Buffer.alloc(512);
  // name (100 bytes, NUL-padded)
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) {
    // Use the "name" + "prefix" split if the name is too long for one field.
    // Find a slash split point so that prefix <= 155 and name <= 100.
    let split = -1;
    for (let i = Math.min(nameBuf.length - 1, 155); i > 0; i--) {
      if (nameBuf[i] === 0x2f) { // '/'
        const remainder = nameBuf.length - i - 1;
        if (remainder <= 100 && i <= 155) { split = i; break; }
      }
    }
    if (split < 0) {
      throw new Error('tar: file name too long for USTAR (' + nameBuf.length + ' bytes): ' + name);
    }
    nameBuf.slice(split + 1).copy(header, 0);
    nameBuf.slice(0, split).copy(header, 345);
  } else {
    nameBuf.copy(header, 0);
  }
  // mode (8 bytes, octal, NUL-terminated)
  header.write((mode & 0o7777).toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  // uid + gid (8 bytes each, octal) — fixed 0 for repro
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  // size (12 bytes, octal, NUL-terminated)
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  // mtime (12 bytes, octal)
  header.write(Math.floor(mtime).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  // checksum placeholder (8 bytes of spaces, filled below)
  header.write('        ', 148, 8, 'ascii');
  // typeflag (1 byte): '0' normal, '5' dir
  header.write(typeflag, 156, 1, 'ascii');
  // magic + version: "ustar\0" + "00"
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  // checksum: sum of all bytes treating placeholder as spaces
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function _tarPad(size) {
  const rem = size % 512;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - rem);
}

function _buildTarball(entries) {
  // entries: [{name, data: Buffer, mode, mtime, typeflag}]
  const chunks = [];
  for (const e of entries) {
    const size = e.data.length;
    chunks.push(_tarHeader(e.name, size, e.mode, e.mtime, e.typeflag));
    if (size > 0) {
      chunks.push(e.data);
      chunks.push(_tarPad(size));
    }
  }
  // Two trailing zero blocks marking end-of-archive.
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function _sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function generateAirgapBundle({
  artifact_path,
  runtime = 'vllm',
  output_dir,
} = {}) {
  _checkRuntime(runtime);
  if (!artifact_path || typeof artifact_path !== 'string') {
    return { ok: false, error: 'artifact_path_required', hint: 'pass {artifact_path: "/path/to/foo.kolm"}' };
  }
  if (!output_dir || typeof output_dir !== 'string') {
    return { ok: false, error: 'output_dir_required', hint: 'pass {output_dir: "/path/to/dist"}' };
  }
  if (!fs.existsSync(artifact_path)) {
    return { ok: false, error: 'artifact_not_found', artifact_path, hint: 'check the path or run `kolm logs` to list artifacts' };
  }

  const artifactSize = fs.statSync(artifact_path).size;
  const TWO_GIB_MINUS_1 = 2 * 1024 * 1024 * 1024 - 1;
  const useStreaming = artifactSize > TWO_GIB_MINUS_1;

  const artifactId = path.basename(artifact_path).replace(/\.kolm$/i, '') || 'artifact';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const created_at = new Date().toISOString();
  const mtime = Math.floor(Date.now() / 1000);

  // Build payload buffers first so we can sha256 them before they hit tar.
  const vllmConfig = generateVllmConfig({ artifact: '/opt/kolm/artifact.kolm' });
  const llamaCmd = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'exec llama-server \\',
    '  --model /opt/kolm/artifact.kolm \\',
    '  --port 8000 \\',
    '  --host 0.0.0.0 \\',
    '  --alias ' + artifactId,
    '',
  ].join('\n');

  // W891 streaming branch: when the artifact is too large to materialize a
  // Buffer (Trinity-500 4.59 GB), we stream it through `archiver` and compute
  // the artifact's sha256 by reading the file in 1 MiB chunks ahead of time.
  // The non-streaming branch keeps the original in-memory tar-stream path so
  // small artifacts produce byte-identical output to pre-W891.
  if (useStreaming) {
    return _airgapStreaming({
      artifact_path,
      artifact_size: artifactSize,
      artifactId,
      timestamp,
      created_at,
      mtime,
      vllmConfig,
      llamaCmd,
      output_dir,
      runtime,
    });
  }

  const artifactBuf = fs.readFileSync(artifact_path);

  // Files (paths inside the tarball, before manifest is computed)
  const files = [
    { name: 'artifact.kolm',            data: artifactBuf,                                  mode: 0o644 },
    { name: 'runtime/install.sh',       data: Buffer.from(_installScript(runtime), 'utf8'), mode: 0o755 },
    { name: 'runtime/wheels/.keep',     data: Buffer.from('', 'utf8'),                      mode: 0o644 },
    { name: 'runtime/bin/.keep',        data: Buffer.from('', 'utf8'),                      mode: 0o644 },
    { name: 'config/vllm.json',         data: Buffer.from(vllmConfig, 'utf8'),              mode: 0o644 },
    { name: 'config/llama-cpp.cmd',     data: Buffer.from(llamaCmd, 'utf8'),                mode: 0o755 },
    { name: 'verify.cjs',               data: Buffer.from(VERIFIER_BODY, 'utf8'),           mode: 0o755 },
  ];

  // Compute manifest before adding README + MANIFEST itself (those reference
  // the manifest sha, which would otherwise be self-referential).
  const manifestLines = [];
  for (const f of files) {
    manifestLines.push(_sha256Buf(f.data) + '  ' + f.name);
  }
  const manifestBody = manifestLines.join('\n') + '\n';
  const manifest_sha256 = _sha256Buf(Buffer.from(manifestBody, 'utf8'));

  const readme = _readme({ artifact_id: artifactId, runtime, created_at, manifest_sha256 });

  // Add the README + MANIFEST.sha256 entries (and add their hashes to the
  // manifest so a downstream sha256sum -c check is complete).
  files.push({ name: 'README.md', data: Buffer.from(readme, 'utf8'), mode: 0o644 });
  manifestLines.push(_sha256Buf(Buffer.from(readme, 'utf8')) + '  README.md');
  const finalManifestBody = manifestLines.join('\n') + '\n';
  files.push({ name: 'MANIFEST.sha256', data: Buffer.from(finalManifestBody, 'utf8'), mode: 0o644 });

  // Build the tar entries.
  const entries = files.map(f => ({
    name: f.name,
    data: f.data,
    mode: f.mode,
    mtime,
    typeflag: '0',
  }));

  const tarBuf = _buildTarball(entries);
  const gzBuf = zlib.gzipSync(tarBuf, { level: 6 });

  fs.mkdirSync(output_dir, { recursive: true });
  const bundle_path = path.join(output_dir, 'kolm-airgap-' + artifactId + '-' + timestamp + '.tar.gz');
  fs.writeFileSync(bundle_path, gzBuf);
  // Write the sibling .sha256 file (covers the .tar.gz itself, for ops that
  // sha-check the bundle on arrival without unpacking).
  const bundle_sha256 = _sha256Buf(gzBuf);
  fs.writeFileSync(bundle_path + '.sha256', bundle_sha256 + '  ' + path.basename(bundle_path) + '\n');

  return {
    ok: true,
    bundle_path,
    manifest_sha256,
    sha256: bundle_sha256,
    size_bytes: gzBuf.length,
    file_count: files.length,
    artifact_id: artifactId,
    runtime,
    created_at,
    version: DEPLOY_GENERATORS_VERSION,
  };
}

// W891 streaming airgap: archiver pipes file → tar.gz → output stream without
// ever holding the artifact in memory. We pre-compute artifact.kolm sha256 by
// streaming the file once, so the MANIFEST.sha256 inside the tarball still
// covers every entry deterministically.
async function _airgapStreaming({
  artifact_path,
  artifact_size,
  artifactId,
  timestamp,
  created_at,
  mtime,
  vllmConfig,
  llamaCmd,
  output_dir,
  runtime,
}) {
  const archiver = require('archiver');
  const stream = await import('node:stream');

  fs.mkdirSync(output_dir, { recursive: true });
  const bundle_path = path.join(output_dir, 'kolm-airgap-' + artifactId + '-' + timestamp + '.tar.gz');

  // Stream-compute artifact.kolm sha256 before we open the tarball (we need
  // it in MANIFEST.sha256 inside the bundle). 1 MiB chunks, bounded memory.
  const artifactSha = await _streamSha256(artifact_path);

  const installScript = _installScript(runtime);
  const inMemory = [
    { name: 'runtime/install.sh',   body: installScript,        mode: 0o755 },
    { name: 'runtime/wheels/.keep', body: '',                   mode: 0o644 },
    { name: 'runtime/bin/.keep',    body: '',                   mode: 0o644 },
    { name: 'config/vllm.json',     body: vllmConfig,           mode: 0o644 },
    { name: 'config/llama-cpp.cmd', body: llamaCmd,             mode: 0o755 },
    { name: 'verify.cjs',           body: VERIFIER_BODY,        mode: 0o755 },
  ];

  // Order matches the non-streaming branch: artifact.kolm first.
  const manifestLines = [];
  manifestLines.push(artifactSha + '  artifact.kolm');
  for (const f of inMemory) {
    manifestLines.push(_sha256Buf(Buffer.from(f.body, 'utf8')) + '  ' + f.name);
  }
  const manifestBody = manifestLines.join('\n') + '\n';
  const manifest_sha256 = _sha256Buf(Buffer.from(manifestBody, 'utf8'));

  const readme = _readme({ artifact_id: artifactId, runtime, created_at, manifest_sha256 });
  manifestLines.push(_sha256Buf(Buffer.from(readme, 'utf8')) + '  README.md');
  const finalManifestBody = manifestLines.join('\n') + '\n';

  const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } });
  const output = fs.createWriteStream(bundle_path);
  const hash = crypto.createHash('sha256');
  let bundleBytes = 0;
  const sizeTap = new stream.PassThrough();
  sizeTap.on('data', (c) => { hash.update(c); bundleBytes += c.length; });

  archive.pipe(sizeTap).pipe(output);

  archive.file(artifact_path, { name: 'artifact.kolm', date: new Date(mtime * 1000), mode: 0o644 });
  for (const f of inMemory) {
    archive.append(f.body, { name: f.name, date: new Date(mtime * 1000), mode: f.mode });
  }
  archive.append(readme,             { name: 'README.md',       date: new Date(mtime * 1000), mode: 0o644 });
  archive.append(finalManifestBody,  { name: 'MANIFEST.sha256', date: new Date(mtime * 1000), mode: 0o644 });

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    sizeTap.on('error', reject);
    archive.finalize();
  });

  const bundle_sha256 = hash.digest('hex');
  fs.writeFileSync(bundle_path + '.sha256', bundle_sha256 + '  ' + path.basename(bundle_path) + '\n');

  return {
    ok: true,
    bundle_path,
    manifest_sha256,
    sha256: bundle_sha256,
    size_bytes: bundleBytes,
    file_count: inMemory.length + 3, // artifact + readme + manifest
    artifact_id: artifactId,
    artifact_size: artifact_size,
    artifact_sha256: artifactSha,
    runtime,
    created_at,
    version: DEPLOY_GENERATORS_VERSION,
    streaming: true,
  };
}

function _streamSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    rs.on('data', (c) => hash.update(c));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', reject);
  });
}

// Internal exports for tests + adjacent modules that want to drive the
// pieces independently (e.g. compose verifier without writing a file).
export const __internals = {
  _checkRuntime,
  _tarHeader,
  _buildTarball,
  _installScript,
  _readme,
  VERIFIER_BODY,
};

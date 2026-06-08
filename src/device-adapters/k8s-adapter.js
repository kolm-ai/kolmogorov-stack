// W888-C - Kubernetes adapter: deploy(device, artifactPath, opts).
//
// Renders a minimal Deployment + Service manifest for the artifact, then
// either prints it (--dry-run / stdout-only) or shells out to `kubectl apply`.
// We deliberately do NOT pull in @kubernetes/client-node - `kubectl` on PATH
// + a kubeconfig is the de-facto contract.
//
// Adapter contract (uniform across src/device-adapters/*):
//   async deploy(device, artifactPath, opts) → { ok, deployment_id, message, raw }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

function _renderManifest({ name, image, port, artifactPath, namespace }) {
  // Minimal Deployment+Service that mounts a hostPath at the artifact's local
  // path. For real prod use the operator would push the artifact into a
  // PersistentVolumeClaim or bake it into an image; this template is the
  // SIMPLEST shape that smoke-tests `kubectl apply --dry-run=client`.
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    app: ${name}
    kolm/managed: "true"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: kolm-runtime
        image: ${image}
        args: ["-m", "/artifact/${path.basename(artifactPath)}", "--port", "${port}", "--host", "0.0.0.0"]
        ports:
        - containerPort: ${port}
        volumeMounts:
        - name: artifact
          mountPath: /artifact
      volumes:
      - name: artifact
        hostPath:
          path: ${path.dirname(artifactPath)}
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  selector:
    app: ${name}
  ports:
  - port: ${port}
    targetPort: ${port}
`;
}

function _spawnKubectl(args, stdin) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('kubectl', args); }
    catch (e) { return resolve({ code: -1, stdout: '', stderr: e && e.message ? e.message : String(e), missing: true }); }
    let out = ''; let err = '';
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', (e) => resolve({ code: -1, stdout: out, stderr: (err + (e && e.message ? e.message : String(e))), missing: true }));
    child.on('close', code => resolve({ code: typeof code === 'number' ? code : 1, stdout: out, stderr: err, missing: false }));
    if (stdin) { try { child.stdin.write(stdin); child.stdin.end(); } catch {} } // deliberate: cleanup
  });
}

export async function deploy(device, artifactPath, opts = {}) {
  const deployment_id = 'dep_' + crypto.randomBytes(8).toString('hex');
  const raw = { steps: [] };
  if (!device || device.type !== 'k8s') {
    return { ok: false, deployment_id, message: 'k8s-adapter requires device.type === "k8s"', raw };
  }
  if (!artifactPath || !fs.existsSync(artifactPath)) {
    return { ok: false, deployment_id, message: `artifact not found: ${artifactPath}`, raw };
  }
  const name = (opts.name || `kolm-${path.basename(artifactPath).replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`).slice(0, 53);
  const image = opts.image || 'ghcr.io/ggml-org/llama.cpp:server';
  const port = Number(opts.port || 8080);
  const namespace = opts.namespace || 'default';
  const dryRun = opts.dryRun !== false; // default to dry-run for safety
  const printOnly = !!opts.printOnly;

  const manifest = _renderManifest({ name, image, port, artifactPath, namespace });
  raw.steps.push({ step: 'render_manifest', ok: true, name, namespace });
  raw.manifest = manifest;

  if (printOnly) {
    return { ok: true, deployment_id, message: `manifest rendered (${manifest.split('\n').length} lines)`, raw };
  }

  // Spawn kubectl - graceful skip if not on PATH.
  const args = ['apply', '-f', '-'];
  if (dryRun) args.push('--dry-run=client', '-o', 'yaml');
  if (namespace) { args.push('-n', namespace); }
  const r = await _spawnKubectl(args, manifest);
  raw.steps.push({ step: 'kubectl_apply', ok: r.code === 0, exit_code: r.code, missing: r.missing });
  if (r.missing) {
    return {
      ok: false,
      deployment_id,
      message: 'kubectl not on PATH; manifest rendered but not applied. Install kubectl or pass --print-only.',
      raw,
    };
  }
  if (r.code !== 0) {
    return { ok: false, deployment_id, message: `kubectl apply failed: ${r.stderr.slice(0, 400)}`, raw };
  }
  return {
    ok: true,
    deployment_id,
    message: `kubectl ${dryRun ? 'apply --dry-run' : 'apply'} succeeded for ${namespace}/${name}`,
    raw,
  };
}

export default { deploy };

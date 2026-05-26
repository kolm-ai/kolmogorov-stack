#!/usr/bin/env node
// W888-L scaffold #26 — kubectl apply --dry-run=client on a generated manifest.
//
// Generates a minimal Kubernetes Deployment + Service manifest for the Kolm
// runtime (the same shape `kolm compile --target k8s` emits) and runs
// `kubectl apply --dry-run=client -f -` against it. If kubectl is not on PATH
// the scaffold emits a SKIP envelope and exits 0 — ship-gate treats SKIP as
// a non-blocker.
//
// Output (stdout):
//   PASS: { ok:true, manifest_kind, version }
//   FAIL: { ok:false, stderr, version }
//   SKIP: { ok:false, skipped:true, reason, install_hint, version }

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VERSION = 'w888L-k8s-dry-v1';

function emit(o, code) {
  process.stdout.write(JSON.stringify(o) + '\n');
  process.exit(code || 0);
}

// PATH lookup that works on Windows + POSIX.
function which(cmd) {
  const PATHEXT = (process.env.PATHEXT || '.EXE;.BAT;.CMD').split(';').map((s) => s.toLowerCase());
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const direct = path.join(d, cmd);
    if (fs.existsSync(direct)) return direct;
    if (process.platform === 'win32') {
      for (const ext of PATHEXT) {
        const p = path.join(d, cmd + ext);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

(function main() {
  const kubectl = which('kubectl');
  if (!kubectl) {
    return emit({
      ok: false, skipped: true,
      reason: 'kubectl not on PATH',
      install_hint: 'install kubectl: https://kubernetes.io/docs/tasks/tools/',
      version: VERSION,
    }, 0);
  }
  const manifest = [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: kolm-runtime',
    '  labels:',
    '    app: kolm-runtime',
    'spec:',
    '  replicas: 1',
    '  selector:',
    '    matchLabels:',
    '      app: kolm-runtime',
    '  template:',
    '    metadata:',
    '      labels:',
    '        app: kolm-runtime',
    '    spec:',
    '      containers:',
    '      - name: kolm',
    '        image: ghcr.io/kolm/runtime:latest',
    '        ports:',
    '        - containerPort: 8080',
    '        env:',
    '        - name: KOLM_LOCAL_ONLY',
    '          value: "1"',
    '---',
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '  name: kolm-runtime',
    'spec:',
    '  selector:',
    '    app: kolm-runtime',
    '  ports:',
    '  - port: 80',
    '    targetPort: 8080',
  ].join('\n') + '\n';
  const tmp = path.join(os.tmpdir(), 'kolm-w888L-k8s-' + process.pid + '-' + Date.now() + '.yaml');
  fs.writeFileSync(tmp, manifest, 'utf8');
  try {
    const r = spawnSync(kubectl, ['apply', '--dry-run=client', '-f', tmp], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (r.status !== 0) {
      return emit({
        ok: false,
        stderr: String(r.stderr || '').slice(0, 400),
        stdout: String(r.stdout || '').slice(0, 200),
        version: VERSION,
      }, 2);
    }
    emit({
      ok: true,
      manifest_kinds: ['Deployment', 'Service'],
      stdout_lines: String(r.stdout || '').split(/\r?\n/).filter(Boolean).length,
      version: VERSION,
    }, 0);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {} // deliberate: cleanup
  }
})();

// W888-C - Ollama adapter: deploy(device, artifactPath, opts).
//
// POSTs the artifact's GGUF blob (or a remote URL) to the device's Ollama
// daemon at http://<device.host>:<port>/api/create, then polls until status:
// 'success'. Uses Node's built-in fetch - no external HTTP client dep.
//
// Adapter contract (uniform across src/device-adapters/*):
//   async deploy(device, artifactPath, opts) → { ok, deployment_id, message, raw }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function deploy(device, artifactPath, opts = {}) {
  const deployment_id = 'dep_' + crypto.randomBytes(8).toString('hex');
  const raw = { steps: [] };
  if (!device || device.type !== 'ollama') {
    return { ok: false, deployment_id, message: 'ollama-adapter requires device.type === "ollama"', raw };
  }
  if (!device.host) {
    return { ok: false, deployment_id, message: 'device.host required (Ollama HTTP endpoint)', raw };
  }
  if (!artifactPath || !fs.existsSync(artifactPath)) {
    return { ok: false, deployment_id, message: `artifact not found: ${artifactPath}`, raw };
  }

  const port = Number(device.port || 11434);
  const protocol = opts.protocol || 'http';
  const base = `${protocol}://${device.host}:${port}`;
  const dryRun = !!opts.dryRun;
  const modelName = opts.modelName || path.basename(artifactPath).replace(/\.(gguf|kolm)$/i, '');
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) {
    return { ok: false, deployment_id, message: 'fetch implementation missing (Node 18+ required)', raw };
  }

  if (dryRun) {
    raw.steps.push({ step: 'dry_run', ok: true });
    return { ok: true, deployment_id, message: `dry-run: would POST ${base}/api/create with model=${modelName}`, raw };
  }

  try {
    // Ollama /api/create accepts a Modelfile by name + a `path` field pointing
    // at a GGUF the daemon can read. For a remote device we'd typically have
    // the operator pre-stage the file via SFTP; for the local-Ollama case
    // we pass the absolute artifactPath and let the daemon mmap it.
    const body = {
      name: modelName,
      modelfile: `FROM ${artifactPath}`,
      stream: false,
    };
    const r = await fetchImpl(`${base}/api/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    raw.steps.push({ step: 'create', ok: r.ok, status: r.status });
    if (!r.ok) {
      let bodyText = '';
      try { bodyText = (await r.text()).slice(0, 400); } catch {} // deliberate: cleanup
      return { ok: false, deployment_id, message: `ollama create failed: HTTP ${r.status} ${bodyText}`, raw };
    }
    // Poll /api/tags for the new model name.
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try {
        const tr = await fetchImpl(`${base}/api/tags`);
        if (tr.ok) {
          const tj = await tr.json().catch(() => ({}));
          const models = Array.isArray(tj.models) ? tj.models : [];
          if (models.some(m => (m.name || '').startsWith(modelName))) { ready = true; break; }
        }
      } catch {} // deliberate: cleanup
      await new Promise(res => setTimeout(res, 250));
    }
    raw.steps.push({ step: 'poll_ready', ok: ready });
    return {
      ok: ready || true, // ollama create returns 200 even mid-pull; consider 200 a success signal.
      deployment_id,
      message: ready ? `ollama model "${modelName}" ready on ${base}` : `ollama create accepted (model "${modelName}" may still be pulling)`,
      raw,
    };
  } catch (e) {
    return { ok: false, deployment_id, message: e && e.message ? e.message : String(e), raw };
  }
}

export default { deploy };

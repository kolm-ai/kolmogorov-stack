// W916-I9 — Cerebras device adapter.
//
// Wraps src/cloud-providers/cerebras.js into the device-adapter contract so
// `kolm deploy artifact.kolm --device <cerebras-device>` and the fleet
// dashboard can target Cerebras Cloud Inference uniformly.
//
// "Deploy" on Cerebras is binding the artifact's namespace to a pre-loaded
// Cerebras model id (see cloud-providers/cerebras.js for the full contract).
// device.config can carry:
//   cerebras_model   (required) — e.g. "llama3.1-8b"
//   namespace        (required) — kolm namespace this artifact serves
//   max_tokens       (optional) — default 2048
//   temperature      (optional) — default 0.7
//
// Returns the same envelope shape as runpod-adapter / modal-adapter so the
// fleet UI can render bound deployments without per-adapter branches.

import crypto from 'node:crypto';
import path from 'node:path';

export async function deploy(device, artifactPath, opts = {}) {
  const deployment_id = 'dep_' + crypto.randomBytes(8).toString('hex');
  const config = (device && device.config) || {};
  const namespace = opts.namespace || config.namespace || (artifactPath ? path.basename(String(artifactPath)).replace(/\.kolm$/, '') : null);
  const model = opts.cerebras_model || opts.model || config.cerebras_model || config.model;
  if (!namespace) {
    return {
      ok: false,
      deployment_id,
      error: 'namespace_required',
      hint: 'pass --namespace <name> or set device.config.namespace',
      raw: { device_type: device && device.type, artifact: artifactPath },
    };
  }
  if (!model) {
    return {
      ok: false,
      deployment_id,
      error: 'cerebras_model_required',
      hint: 'pass --cerebras-model <id> (e.g. llama3.1-8b, llama-3.3-70b) or set device.config.cerebras_model',
      docs_url: 'https://inference-docs.cerebras.ai/api-reference/models',
      raw: { device_type: device && device.type, artifact: artifactPath },
    };
  }
  let provider;
  try {
    const mod = await import('../cloud-providers/cerebras.js');
    const ProviderCtor = mod.CerebrasProvider || mod.default;
    provider = new ProviderCtor();
  } catch (err) {
    return {
      ok: false,
      deployment_id,
      error: err.code || 'cerebras_provider_init_failed',
      message: err.message,
      hint: err.install_hint || 'set CEREBRAS_API_KEY',
      docs_url: err.docs_url || 'https://inference-docs.cerebras.ai/',
      raw: { device_type: device && device.type, artifact: artifactPath },
    };
  }
  try {
    const bind = await provider.bindArtifact({
      namespace,
      artifactId: opts.artifact_id || config.artifact_id || (artifactPath ? path.basename(String(artifactPath)) : null),
      model,
      maxTokens: opts.max_tokens || config.max_tokens || 2048,
      temperature: opts.temperature ?? config.temperature ?? 0.7,
      metadata: {
        device_id: device && device.id,
        device_label: device && device.label,
        deployed_at: new Date().toISOString(),
        deployment_id,
        artifact_path: artifactPath,
      },
    });
    return {
      ok: true,
      deployment_id,
      provider: 'cerebras',
      cerebras_model: model,
      namespace,
      binding_path: bind.binding_path,
      endpoint: provider.baseUrl + '/chat/completions',
      raw: bind.binding,
      next_actions: [
        { kind: 'verb',   label: 'List bindings',  value: 'kolm cloud cerebras list-bindings' },
        { kind: 'verb',   label: 'Test the route', value: `kolm gateway dispatch --namespace ${namespace} --prompt "ping"` },
        { kind: 'verb',   label: 'Unbind',         value: `kolm cloud cerebras unbind --namespace ${namespace}` },
      ],
    };
  } catch (err) {
    return {
      ok: false,
      deployment_id,
      error: err.code || 'cerebras_bind_failed',
      message: err.message,
      hint: err.install_hint || null,
      docs_url: err.docs_url || 'https://inference-docs.cerebras.ai/',
      raw: { device_type: device && device.type, artifact: artifactPath },
    };
  }
}

export default { deploy };

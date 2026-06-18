// W916-I9 - Cerebras device adapter.
//
// Wraps src/cloud-providers/cerebras.js into the device-adapter contract so
// `kolm deploy artifact.kolm --device <cerebras-device>` and the fleet
// dashboard can target Cerebras Cloud Inference uniformly.
//
// "Deploy" on Cerebras is binding the artifact's namespace to a pre-loaded
// Cerebras model id (see cloud-providers/cerebras.js for the full contract).
// device.config can carry:
//   cerebras_model   (required) - e.g. "llama3.1-8b"
//   namespace        (required) - kolm namespace this artifact serves
//   max_tokens       (optional) - default 2048
//   temperature      (optional) - default 0.7
//
// Returns the same envelope shape as runpod-adapter / modal-adapter so the
// fleet UI can render bound deployments without per-adapter branches.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export const CEREBRAS_ADAPTER_CONTRACT_VERSION = 'w697-v1';

const SAFE_NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/;
const DEFAULT_BASE_URL = 'https://api.cerebras.ai/v1';

function _pickString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function _artifactIdFromPath(artifactPath) {
  return artifactPath ? path.basename(String(artifactPath)) : '';
}

function _namespaceFromArtifact(artifactPath) {
  const artifact = _artifactIdFromPath(artifactPath);
  return artifact ? artifact.replace(/\.kolm$/i, '') : '';
}

function _validateNamespace(namespace) {
  if (!namespace) {
    const err = new Error('namespace required');
    err.code = 'namespace_required';
    err.hint = 'pass --namespace <name> or set device.config.namespace';
    throw err;
  }
  if (!SAFE_NAMESPACE_RE.test(namespace)) {
    const err = new Error('namespace must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/');
    err.code = 'invalid_namespace';
    err.hint = 'use a shell-safe capture namespace such as support-prod or team.alpha';
    throw err;
  }
  return namespace;
}

function _validateModel(model) {
  if (!model) {
    const err = new Error('cerebras model required');
    err.code = 'cerebras_model_required';
    err.hint = 'pass --cerebras-model <id> (e.g. llama3.1-8b, llama-3.3-70b) or set device.config.cerebras_model';
    err.docs_url = 'https://inference-docs.cerebras.ai/api-reference/models';
    throw err;
  }
  if (!SAFE_MODEL_RE.test(model)) {
    const err = new Error('cerebras model id contains unsupported characters');
    err.code = 'invalid_cerebras_model';
    err.hint = 'model id must be a compact provider slug, for example llama3.1-8b';
    err.docs_url = 'https://inference-docs.cerebras.ai/api-reference/models';
    throw err;
  }
  return model;
}

function _positiveInteger(value, fallback, label) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 131072) {
    const err = new Error(`${label} must be an integer from 1 to 131072`);
    err.code = 'invalid_generation_config';
    throw err;
  }
  return n;
}

function _temperature(value, fallback = 0.7) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    const err = new Error('temperature must be a number from 0 to 2');
    err.code = 'invalid_generation_config';
    throw err;
  }
  return n;
}

function _nowIso(opts = {}) {
  if (typeof opts.now_iso === 'string' && opts.now_iso.trim()) return new Date(opts.now_iso).toISOString();
  if (typeof opts.now === 'string' && opts.now.trim()) return new Date(opts.now).toISOString();
  if (Number.isFinite(Number(opts.now_ms))) return new Date(Number(opts.now_ms)).toISOString();
  return new Date().toISOString();
}

function _redact(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:csk|sk|rk|pk|rp|ghp|gho|glpat)[-_][A-Za-z0-9._-]{8,}\b/gi, '[redacted-secret]')
    .replace(/\b[A-Za-z0-9_]*API_KEY\s*=\s*[^\s]+/gi, 'API_KEY=[redacted]');
}

function _shellArg(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

function _canonicalize(value) {
  if (Array.isArray(value)) return value.map(_canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = _canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function _sha256Canonical(value) {
  return crypto.createHash('sha256').update(JSON.stringify(_canonicalize(value))).digest('hex');
}

function _proofFields(fields) {
  const manifest = {
    adapter_contract_version: CEREBRAS_ADAPTER_CONTRACT_VERSION,
    provider: 'cerebras',
    deployment_id: fields.deployment_id,
    namespace: fields.namespace,
    artifact_id: fields.artifact_id,
    cerebras_model: fields.model,
    max_tokens: fields.maxTokens,
    temperature: fields.temperature,
    base_url: fields.baseUrl,
    endpoint: `${fields.baseUrl}/chat/completions`,
    binding_path: fields.bindingPath || null,
    deployed_at: fields.deployedAt,
  };
  return {
    adapter_contract_version: CEREBRAS_ADAPTER_CONTRACT_VERSION,
    manifest_sha256: _sha256Canonical(manifest),
    manifest,
  };
}

function _failure(deployment_id, code, err, raw = {}) {
  return {
    ok: false,
    deployment_id,
    adapter_contract_version: CEREBRAS_ADAPTER_CONTRACT_VERSION,
    error: code,
    message: _redact(err && err.message ? err.message : err || code),
    hint: err && err.hint ? _redact(err.hint) : (err && err.install_hint ? _redact(err.install_hint) : null),
    docs_url: err && err.docs_url ? err.docs_url : 'https://inference-docs.cerebras.ai/',
    raw,
  };
}

export async function deploy(device, artifactPath, opts = {}) {
  const deployment_id = 'dep_' + crypto.randomBytes(8).toString('hex');
  const raw = { device_type: device && device.type, artifact: artifactPath };
  if (!device || device.type !== 'cerebras') {
    return _failure(deployment_id, 'invalid_device_type', 'cerebras-adapter requires device.type === "cerebras"', raw);
  }
  const config = (device && device.config && typeof device.config === 'object') ? device.config : {};
  let namespace;
  let model;
  let maxTokens;
  let temperature;
  let deployedAt;
  let artifactId;
  try {
    namespace = _validateNamespace(_pickString(opts.namespace, config.namespace, _namespaceFromArtifact(artifactPath)));
    model = _validateModel(_pickString(opts.cerebras_model, opts.model, config.cerebras_model, config.model));
    maxTokens = _positiveInteger(opts.max_tokens ?? opts.maxTokens ?? config.max_tokens ?? config.maxTokens, 2048, 'max_tokens');
    temperature = _temperature(opts.temperature ?? config.temperature, 0.7);
    deployedAt = _nowIso(opts);
    artifactId = _pickString(opts.artifact_id, opts.artifactId, config.artifact_id, config.artifactId, _artifactIdFromPath(artifactPath));
    if (!artifactId) {
      const err = new Error('artifact id required');
      err.code = 'artifact_required';
      err.hint = 'pass an artifact path or opts.artifact_id';
      throw err;
    }
    if (artifactPath && !opts.skip_artifact_check && !fs.existsSync(String(artifactPath))) {
      const err = new Error(`artifact not found: ${artifactPath}`);
      err.code = 'artifact_not_found';
      throw err;
    }
  } catch (err) {
    return _failure(deployment_id, err.code || 'invalid_cerebras_deploy_request', err, raw);
  }
  let provider;
  if (opts.provider && typeof opts.provider.bindArtifact === 'function') {
    provider = opts.provider;
  } else {
    try {
      const mod = await import('../cloud-providers/cerebras.js');
      const ProviderCtor = opts.ProviderClass || mod.CerebrasProvider || mod.default;
      provider = new ProviderCtor(opts.apiKey || opts.api_key, opts.provider_opts || opts.providerOptions || {});
    } catch (err) {
      return _failure(deployment_id, err.code || 'cerebras_provider_init_failed', err, raw);
    }
  }
  try {
    const baseUrl = String(provider.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const bind = await provider.bindArtifact({
      namespace,
      artifactId,
      model,
      maxTokens,
      temperature,
      metadata: {
        device_id: device && device.id,
        device_label: device && device.label,
        deployed_at: deployedAt,
        deployment_id,
        artifact_path: artifactPath,
        adapter_contract_version: CEREBRAS_ADAPTER_CONTRACT_VERSION,
      },
    });
    const proof = _proofFields({
      deployment_id,
      namespace,
      artifact_id: artifactId,
      artifactId,
      model,
      maxTokens,
      temperature,
      baseUrl,
      bindingPath: bind.binding_path,
      deployedAt,
    });
    return {
      ok: true,
      deployment_id,
      adapter_contract_version: CEREBRAS_ADAPTER_CONTRACT_VERSION,
      provider: 'cerebras',
      cerebras_model: model,
      namespace,
      artifact_id: artifactId,
      deployed_at: deployedAt,
      binding_path: bind.binding_path,
      endpoint: baseUrl + '/chat/completions',
      proof,
      raw: bind.binding,
      next_actions: [
        { kind: 'verb',   label: 'List bindings',  value: 'kolm cloud cerebras list-bindings' },
        { kind: 'verb',   label: 'Test the route', value: `kolm gateway dispatch --namespace ${_shellArg(namespace)} --prompt ${_shellArg('ping')}` },
        { kind: 'verb',   label: 'Unbind',         value: `kolm cloud cerebras unbind --namespace ${_shellArg(namespace)}` },
      ],
    };
  } catch (err) {
    return _failure(deployment_id, err.code || 'cerebras_bind_failed', err, raw);
  }
}

export default { deploy };

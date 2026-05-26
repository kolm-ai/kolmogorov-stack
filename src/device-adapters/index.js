// W888-C — Adapter index: maps device.type → adapter module.
//
// Usage:
//   import { adapterFor } from './device-adapters/index.js';
//   const adapter = await adapterFor(device.type);
//   const result = await adapter.deploy(device, artifactPath, opts);

const ADAPTER_PATHS = {
  ssh:    './ssh-adapter.js',
  local:  './local-adapter.js',
  ollama: './ollama-adapter.js',
  k8s:    './k8s-adapter.js',
  runpod: './runpod-adapter.js',
  modal:  './modal-adapter.js',
};

export async function adapterFor(type) {
  const p = ADAPTER_PATHS[type];
  if (!p) {
    const e = new Error(`no adapter for device type: ${type}`); e.code = 'KOLM_E_NO_ADAPTER'; throw e;
  }
  const mod = await import(p);
  return { deploy: mod.deploy || (mod.default && mod.default.deploy) };
}

export const ADAPTER_TYPES = Object.keys(ADAPTER_PATHS);

export default { adapterFor, ADAPTER_TYPES };

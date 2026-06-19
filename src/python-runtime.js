// Shared Python interpreter selection for Node-owned control-plane modules.
//
// Python owns ML/proof workloads; Node owns validation, receipts, and worker
// dispatch. Keep the interpreter precedence in one place so distill/runtime
// shells do not drift.

export const PYTHON_RUNTIME_CONTRACT_VERSION = 'w975-python-runtime-v1';

export const PYTHON_ENV_PRECEDENCE = Object.freeze([
  'KOLM_PYTHON',
  'KOLM_PYTHON_BIN',
  'PYTHON',
  'KOLM_PY',
]);

export function defaultPythonExecutable(platform = process.platform) {
  return platform === 'win32' ? 'python' : 'python3';
}

export function resolvePythonRuntime({ env = process.env, platform = process.platform, explicit = null } = {}) {
  if (explicit) {
    return {
      command: String(explicit),
      source: 'explicit',
      contract_version: PYTHON_RUNTIME_CONTRACT_VERSION,
    };
  }
  for (const key of PYTHON_ENV_PRECEDENCE) {
    if (env && env[key]) {
      return {
        command: String(env[key]),
        source: key,
        contract_version: PYTHON_RUNTIME_CONTRACT_VERSION,
      };
    }
  }
  return {
    command: defaultPythonExecutable(platform),
    source: platform === 'win32' ? 'platform_win32_default' : 'platform_posix_default',
    contract_version: PYTHON_RUNTIME_CONTRACT_VERSION,
  };
}

export function pythonBin(opts = {}) {
  return resolvePythonRuntime(opts).command;
}

export default {
  PYTHON_RUNTIME_CONTRACT_VERSION,
  PYTHON_ENV_PRECEDENCE,
  defaultPythonExecutable,
  resolvePythonRuntime,
  pythonBin,
};

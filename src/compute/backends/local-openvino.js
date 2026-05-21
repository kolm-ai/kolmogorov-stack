import { createOpenAICompatibleAdapter } from './openai-compatible.js';

const adapter = createOpenAICompatibleAdapter({
  name: 'local-openvino',
  urlEnv: ['KOLM_OPENVINO_URL', 'OVMS_URL'],
  keyEnv: ['KOLM_OPENVINO_API_KEY', 'OVMS_API_KEY'],
  device: 'intel-openvino',
  docs: 'https://docs.openvino.ai/',
});

async function detect() {
  const out = await adapter.detect();
  if (out.available) return out;
  if (process.env.OPENVINO_HOME || process.env.INTEL_OPENVINO_DIR) {
    return {
      available: false,
      reason: 'OpenVINO runtime detected, but KOLM_OPENVINO_URL is not set to an OpenAI-compatible serving endpoint',
      device: 'intel-openvino',
      docs: 'https://docs.openvino.ai/',
    };
  }
  return out;
}

export default {
  ...adapter,
  detect,
};

export { detect };
export const test = adapter.test;
export const run = adapter.run;

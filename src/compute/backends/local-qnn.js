import { createOpenAICompatibleAdapter } from './openai-compatible.js';

const adapter = createOpenAICompatibleAdapter({
  name: 'local-qnn',
  urlEnv: ['KOLM_QNN_URL', 'KOLM_HEXAGON_URL'],
  keyEnv: ['KOLM_QNN_API_KEY', 'KOLM_HEXAGON_API_KEY'],
  device: 'qualcomm-qnn-hexagon',
  docs: 'https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html',
});

async function detect() {
  const out = await adapter.detect();
  if (out.available) return out;
  if (process.env.QNN_SDK_ROOT || process.env.HEXAGON_SDK_ROOT) {
    return {
      available: false,
      reason: 'Qualcomm QNN/Hexagon SDK detected, but KOLM_QNN_URL is not set to an OpenAI-compatible serving endpoint',
      device: 'qualcomm-qnn-hexagon',
      docs: 'https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html',
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

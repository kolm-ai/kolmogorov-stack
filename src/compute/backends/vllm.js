import { createOpenAICompatibleAdapter } from './openai-compatible.js';

const adapter = createOpenAICompatibleAdapter({
  name: 'vllm',
  urlEnv: 'KOLM_VLLM_URL',
  keyEnv: ['KOLM_VLLM_API_KEY', 'VLLM_API_KEY'],
  device: 'vllm-openai-compatible',
  docs: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server/',
});

export const { detect, test, run } = adapter;
export default adapter;

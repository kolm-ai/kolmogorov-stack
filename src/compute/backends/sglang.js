import { createOpenAICompatibleAdapter } from './openai-compatible.js';

const adapter = createOpenAICompatibleAdapter({
  name: 'sglang',
  urlEnv: 'KOLM_SGLANG_URL',
  keyEnv: ['KOLM_SGLANG_API_KEY', 'SGLANG_API_KEY'],
  device: 'sglang-openai-compatible',
  docs: 'https://docs.sglang.ai/',
});

export const { detect, test, run } = adapter;
export default adapter;

import { createOpenAICompatibleAdapter } from './openai-compatible.js';

const adapter = createOpenAICompatibleAdapter({
  name: 'trt-llm',
  urlEnv: 'KOLM_TRT_LLM_URL',
  keyEnv: ['KOLM_TRT_LLM_API_KEY', 'TRT_LLM_API_KEY'],
  device: 'tensorrt-llm-openai-compatible',
  docs: 'https://nvidia.github.io/TensorRT-LLM/commands/trtllm-serve/trtllm-serve.html',
});

export const { detect, test, run } = adapter;
export default adapter;

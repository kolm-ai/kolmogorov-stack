import { createOpenAICompatibleAdapter } from './openai-compatible.js';

const adapter = createOpenAICompatibleAdapter({
  name: 'tgi',
  urlEnv: 'KOLM_TGI_URL',
  keyEnv: ['KOLM_TGI_API_KEY', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'],
  device: 'tgi-openai-compatible',
  docs: 'https://huggingface.co/docs/text-generation-inference/reference/api_reference',
});

export const { detect, test, run } = adapter;
export default adapter;

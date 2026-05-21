export const STREAMING_PROVIDERS = Object.freeze([
  {
    id: 'openai',
    label: 'OpenAI-compatible chat/completions',
    request_field: 'stream: true',
    event_shape: 'data: {"choices":[{"delta":{"content":"..."}}]}',
    routes: ['/v1/chat/completions', '/v1/responses'],
    supports_model_stream: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic Messages',
    request_field: 'stream: true',
    event_shape: 'event: content_block_delta',
    routes: ['/v1/messages', '/anthropic/v1/messages'],
    supports_model_stream: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter OpenAI-compatible stream',
    request_field: 'stream: true',
    event_shape: 'OpenAI-compatible data chunks',
    routes: ['/v1/capture/openrouter', '/v1/openrouter/chat/completions'],
    supports_model_stream: true,
  },
  {
    id: 'kolm-capture-sse',
    label: 'Kolm capture live tail',
    request_field: 'GET text/event-stream',
    event_shape: 'event: capture',
    routes: ['/v1/capture/stream'],
    supports_model_stream: false,
  },
  {
    id: 'local-artifact',
    label: 'Local .kolm artifact runtime',
    request_field: 'runtime chunk callback',
    event_shape: 'kolm runtime chunk envelope',
    routes: ['kolm run', 'kolm serve'],
    supports_model_stream: true,
  },
]);

export function streamingCapabilities() {
  return {
    ok: true,
    spec: 'kolm-streaming-contract/1',
    providers: STREAMING_PROVIDERS.map((p) => ({ ...p })),
    normalized_event: {
      provider: 'openai|anthropic|openrouter|kolm-capture-sse|local-artifact',
      type: 'delta|message_start|message_stop|error|capture|done',
      text: 'string chunk when available',
      raw: 'original provider event',
    },
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
    secret_values_included: false,
  };
}

export function normalizeStreamChunk(provider, chunk = {}) {
  const p = String(provider || '').toLowerCase();
  if (p === 'openai' || p === 'openrouter') {
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    const text = choice?.delta?.content ?? choice?.message?.content ?? '';
    const done = choice?.finish_reason != null || chunk === '[DONE]';
    return { provider: p, type: done ? 'done' : 'delta', text: String(text || ''), raw: chunk };
  }
  if (p === 'anthropic') {
    const type = chunk.type || chunk.event || 'delta';
    const text = chunk.delta?.text ?? chunk.content_block?.text ?? chunk.message?.content?.[0]?.text ?? '';
    return { provider: p, type: type === 'message_stop' ? 'done' : type, text: String(text || ''), raw: chunk };
  }
  if (p === 'kolm-capture-sse') {
    return { provider: p, type: 'capture', text: chunk.prompt_head || chunk.response_head || '', raw: chunk };
  }
  if (p === 'local-artifact') {
    return { provider: p, type: chunk.done ? 'done' : 'delta', text: String(chunk.text || chunk.output || ''), raw: chunk };
  }
  return { provider: p || 'unknown', type: 'delta', text: String(chunk.text || ''), raw: chunk };
}

export function streamingReadiness({ providers = STREAMING_PROVIDERS } = {}) {
  const rows = providers.map((p) => ({
    id: p.id,
    supports_model_stream: !!p.supports_model_stream,
    routes: p.routes || [],
    normalized: true,
  }));
  return {
    ok: rows.every((r) => r.routes.length > 0 && r.normalized),
    spec: 'kolm-streaming-readiness/1',
    providers: rows,
    model_stream_provider_count: rows.filter((r) => r.supports_model_stream).length,
    capture_sse: rows.some((r) => r.id === 'kolm-capture-sse'),
    secret_values_included: false,
  };
}

export default {
  STREAMING_PROVIDERS,
  streamingCapabilities,
  normalizeStreamChunk,
  streamingReadiness,
};

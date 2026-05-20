// Anthropic / Claude native Messages API inference backend.
// This is not OpenAI-compatible protocol emulation; it speaks Anthropic's
// /v1/messages shape with x-api-key + anthropic-version headers.

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_VERSION = '2023-06-01';

function token() {
  return process.env.KOLM_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
}

function baseUrl() {
  return String(process.env.KOLM_ANTHROPIC_URL || process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function version() {
  return process.env.KOLM_ANTHROPIC_VERSION || process.env.ANTHROPIC_VERSION || DEFAULT_VERSION;
}

function messagesEndpoint() {
  const base = baseUrl();
  return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

async function timedFetch(url, init = {}, timeoutMs = 60_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMessages(messages, prompt) {
  if (Array.isArray(messages) && messages.length) {
    return messages
      .filter((m) => m && m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      }));
  }
  return [{ role: 'user', content: String(prompt || '') }];
}

function extractSystem(messages, system) {
  if (system) return system;
  if (!Array.isArray(messages)) return undefined;
  const text = messages
    .filter((m) => m && m.role === 'system')
    .map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
    .join('\n\n');
  return text || undefined;
}

export async function detect() {
  if (!token()) {
    return {
      available: false,
      reason: 'ANTHROPIC_API_KEY env var not set',
      docs: 'https://docs.anthropic.com/en/api/overview',
    };
  }
  return {
    available: true,
    device: 'anthropic-managed',
    endpoint: baseUrl(),
    auth: 'x-api-key',
    docs: 'https://docs.anthropic.com/en/api/messages',
  };
}

export async function test() {
  const t0 = Date.now();
  const det = await detect();
  if (!det.available) return { ok: false, latency_ms: Date.now() - t0, ...det };
  return { ok: true, latency_ms: Date.now() - t0, ...det };
}

export async function run({
  model,
  messages = null,
  prompt = null,
  system = null,
  max_tokens = 1024,
  temperature = undefined,
  body = null,
  timeoutMs = 60_000,
} = {}) {
  const t0 = Date.now();
  const apiKey = token();
  if (!apiKey) {
    return {
      ok: false,
      exit_code: 1,
      reason: 'ANTHROPIC_API_KEY not set',
      next_step: 'export ANTHROPIC_API_KEY=... or KOLM_ANTHROPIC_API_KEY=...',
    };
  }

  const requestBody = body || {
    model: model || process.env.KOLM_ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    max_tokens,
    messages: normalizeMessages(messages, prompt),
    ...(extractSystem(messages, system) ? { system: extractSystem(messages, system) } : {}),
    ...(temperature == null ? {} : { temperature }),
  };

  let res;
  let text;
  try {
    res = await timedFetch(messagesEndpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': version(),
      },
      body: JSON.stringify(requestBody),
    }, timeoutMs);
    text = await res.text();
  } catch (err) {
    return { ok: false, exit_code: 1, reason: String(err.message || err), latency_ms: Date.now() - t0 };
  }

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* stdout carries raw text */ }
  const outputText = parsed && Array.isArray(parsed.content)
    ? parsed.content.map((block) => block?.text || '').join('')
    : '';

  return {
    ok: res.ok,
    exit_code: res.ok ? 0 : 1,
    stdout: text,
    stderr: res.ok ? '' : text.slice(0, 1000),
    latency_ms: Date.now() - t0,
    backend: 'anthropic',
    endpoint: messagesEndpoint(),
    response: parsed,
    text: outputText,
    usage: parsed?.usage || null,
  };
}

export default { detect, test, run };

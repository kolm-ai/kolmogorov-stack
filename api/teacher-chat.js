// Vercel serverless function for /v1/teacher/chat (POST relay) and
// /v1/teacher/chat/health (GET status). Lives on Vercel rather than the
// Railway router so it can read sensitive env vars (anthropic_api_key,
// openai_key, google_api_key, xai_api_key) that exist only at the kolm.ai
// Vercel runtime. The user wired the Trinity distill worker to fall back
// to ${KOLM_BASE_URL}/v1/teacher/chat when the local env lacks teacher
// keys — this function is the server-side half of that path.
//
// Vercel env vars are case-sensitive and operators have been adding the
// keys with mixed casing. Read every reasonable form so the function
// never silently misses a configured key.

const VENDOR_KEYS = Object.freeze({
  anthropic: ['ANTHROPIC_API_KEY', 'anthropic_api_key', 'ANTHROPIC_KEY', 'anthropic_key'],
  openai:    ['OPENAI_API_KEY', 'openai_api_key', 'OPENAI_KEY', 'openai_key'],
  google:    ['GOOGLE_API_KEY', 'google_api_key', 'GOOGLE_KEY', 'google_key', 'GEMINI_API_KEY', 'gemini_api_key'],
  xai:       ['XAI_API_KEY', 'xai_api_key', 'XAI_KEY', 'xai_key'],
});

function firstEnv(envs) {
  for (const k of envs) {
    const v = process.env[k];
    if (v && String(v).trim().length > 0) return { key: v, var: k };
  }
  return null;
}

// Bearer-token authn against the kolm Railway router. Caches good keys
// for 5 minutes per cold start so we don't burn a /v1/whoami round trip
// on every teacher call.
const _keyCache = new Map();
async function authenticate(req) {
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  const bearer = m ? m[1] : (req.headers['x-api-key'] || '');
  if (!bearer) return { ok: false, status: 401, error: 'auth_required', detail: 'set Authorization: Bearer <kolm-key>' };
  if (!/^(ks_|kao_)[A-Za-z0-9_-]{6,256}$/.test(String(bearer))) {
    return { ok: false, status: 401, error: 'auth_invalid', detail: 'expected ks_ or kao_ prefix' };
  }
  const cached = _keyCache.get(bearer);
  if (cached && cached.expires > Date.now()) return { ok: true, tenant: cached.tenant };
  try {
    const r = await fetch('https://kolmogorov-stack-production.up.railway.app/v1/whoami', {
      headers: { authorization: 'Bearer ' + bearer },
    });
    if (!r.ok) {
      return { ok: false, status: 401, error: 'auth_invalid', detail: 'kolm key rejected by tenant store' };
    }
    const j = await r.json();
    const tenant = (j && j.tenant) || (j && j.tenant_id) || 'unknown';
    _keyCache.set(bearer, { tenant, expires: Date.now() + 5 * 60 * 1000 });
    return { ok: true, tenant };
  } catch (e) {
    return { ok: false, status: 502, error: 'auth_upstream_failed', detail: String(e && e.message || e) };
  }
}

async function relayAnthropic({ key, model, system, messages, maxTokens }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, status: 502, error: 'upstream_error', upstream_status: r.status, upstream_body: t.slice(0, 800) };
  }
  const j = await r.json();
  const block = (j.content || []).find(b => b && b.type === 'text');
  // Anthropic returns usage = {input_tokens, output_tokens}; preserve so the
  // Railway gateway's cost_usd estimate is non-zero when the proxy is in
  // play. Without this the receipt would always show 0 tokens for the
  // Vercel-fallback path.
  return { ok: true, text: block ? block.text : '', usage: j.usage || {}, upstream_id: j.id || null };
}

async function relayOpenAILike({ url, key, model, system, messages, maxTokens }) {
  const oaMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: oaMessages, max_tokens: maxTokens }),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, status: 502, error: 'upstream_error', upstream_status: r.status, upstream_body: t.slice(0, 800) };
  }
  const j = await r.json();
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  // OpenAI returns usage = {prompt_tokens, completion_tokens, total_tokens}.
  return { ok: true, text, usage: j.usage || {}, upstream_id: j.id || null };
}

async function relayGoogle({ key, model, system, messages, maxTokens }) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(model) + ':generateContent';
  const gBody = {
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system) gBody.systemInstruction = { role: 'system', parts: [{ text: system }] };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(gBody),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, status: 502, error: 'upstream_error', upstream_status: r.status, upstream_body: t.slice(0, 800) };
  }
  const j = await r.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  // Google returns usageMetadata = {promptTokenCount, candidatesTokenCount,
  // totalTokenCount}; normalize to the OpenAI-compat shape the gateway
  // receipt reader looks for so cost math works for all 4 vendors.
  const um = j.usageMetadata || {};
  const usage = {
    prompt_tokens:     um.promptTokenCount || 0,
    completion_tokens: um.candidatesTokenCount || 0,
    total_tokens:      um.totalTokenCount || 0,
  };
  return { ok: true, text: parts.map(p => p.text || '').join(''), usage };
}

export default async function handler(req, res) {
  // GET → health probe. No auth (publishes only booleans).
  if (req.method === 'GET') {
    const status = {};
    const sources = {};
    for (const [v, envs] of Object.entries(VENDOR_KEYS)) {
      const hit = firstEnv(envs);
      status[v] = !!hit;
      if (hit) sources[v] = hit.var;
    }
    return res.status(200).json({
      ok: true,
      vendors: status,
      sources,
      any_configured: Object.values(status).some(Boolean),
      served_by: 'vercel-function',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // POST → relay. Auth required.
  const a = await authenticate(req);
  if (!a.ok) return res.status(a.status).json({ ok: false, error: a.error, detail: a.detail });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const vendor = String(body.vendor || '').toLowerCase();
  const envs = VENDOR_KEYS[vendor];
  if (!envs) {
    return res.status(400).json({
      ok: false, error: 'unknown_vendor',
      detail: 'vendor must be one of: ' + Object.keys(VENDOR_KEYS).join(', '),
    });
  }
  const model = String(body.model || '').slice(0, 128);
  if (!model) return res.status(400).json({ ok: false, error: 'missing_model' });
  const messagesIn = Array.isArray(body.messages) ? body.messages : null;
  const inputText = typeof body.input === 'string' ? body.input : '';
  if (!messagesIn && !inputText) {
    return res.status(400).json({ ok: false, error: 'missing_messages_or_input' });
  }
  const system = typeof body.system === 'string' ? body.system.slice(0, 8000) : '';
  let maxTokens = Number(body.max_tokens);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) maxTokens = 1024;
  if (maxTokens > 4096) maxTokens = 4096;

  let messages = [];
  if (messagesIn) {
    for (const m of messagesIn) {
      if (!m || typeof m !== 'object') continue;
      const role = String(m.role || 'user').slice(0, 16);
      const c = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content)
          ? m.content.map(x => (x && (x.text || x.content)) || '').join('\n')
          : '';
      if (!c) continue;
      messages.push({ role, content: String(c).slice(0, 16000) });
    }
  } else {
    messages.push({ role: 'user', content: inputText.slice(0, 16000) });
  }
  const totalChars = messages.reduce((a, m) => a + m.content.length, 0);
  if (totalChars > 32000) {
    return res.status(413).json({ ok: false, error: 'messages_too_large' });
  }

  const hit = firstEnv(envs);
  if (!hit) {
    return res.status(503).json({
      ok: false, error: 'key_not_configured',
      vendor,
      detail: `none of ${envs.join(' / ')} is set on this kolm.ai Vercel instance; ask the operator to add one (or use vendor=local).`,
    });
  }

  let result;
  try {
    if (vendor === 'anthropic') {
      result = await relayAnthropic({ key: hit.key, model, system, messages, maxTokens });
    } else if (vendor === 'openai') {
      result = await relayOpenAILike({ url: 'https://api.openai.com/v1/chat/completions', key: hit.key, model, system, messages, maxTokens });
    } else if (vendor === 'xai') {
      result = await relayOpenAILike({ url: 'https://api.x.ai/v1/chat/completions', key: hit.key, model, system, messages, maxTokens });
    } else if (vendor === 'google') {
      result = await relayGoogle({ key: hit.key, model, system, messages, maxTokens });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'proxy_failed', detail: String(e && e.message || e) });
  }
  if (!result.ok) return res.status(result.status || 502).json(result);

  return res.status(200).json({
    ok: true,
    vendor, model,
    choices: [{ message: { role: 'assistant', content: result.text } }],
    usage: {
      // Merge upstream token counts (when present) with always-known char
      // counts. Token counts feed the receipt's cost_usd estimate;
      // char counts are the no-key-required floor.
      ...(result.usage || {}),
      input_chars:  totalChars + system.length,
      output_chars: result.text.length,
    },
    upstream_id: result.upstream_id || null,
    proxy_key_source: hit.var,
    tenant: a.tenant,
    served_by: 'vercel-function',
  });
}

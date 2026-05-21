import crypto from 'node:crypto';

const WORD_RE = /[a-z0-9_@./:-]+/gi;

export function promptText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (Buffer.isBuffer(input)) return input.toString('utf8');
  if (Array.isArray(input)) return input.map(promptText).filter(Boolean).join('\n');
  if (typeof input === 'object') {
    if (Array.isArray(input.messages)) {
      return input.messages.map((m) => {
        if (!m || typeof m !== 'object') return promptText(m);
        return [m.role, promptText(m.content)].filter(Boolean).join(': ');
      }).filter(Boolean).join('\n');
    }
    const fields = ['prompt', 'input', 'text', 'query', 'content', 'body'];
    const parts = [];
    for (const f of fields) {
      if (input[f] != null) parts.push(promptText(input[f]));
    }
    if (parts.length) return parts.filter(Boolean).join('\n');
    try { return JSON.stringify(input); } catch { return String(input); }
  }
  return String(input);
}

export function tokenizeForSimilarity(input) {
  const text = promptText(input).toLowerCase();
  const words = text.match(WORD_RE) || [];
  return words
    .map((w) => w.replace(/^https?:\/\//, '').replace(/[.,;!?)]$/, ''))
    .filter((w) => w.length >= 2 && w.length <= 96);
}

export function estimateTokens(input) {
  const text = promptText(input);
  if (!text) return 0;
  const words = tokenizeForSimilarity(text).length;
  const charEstimate = Math.ceil(text.length / 4);
  return Math.max(words, charEstimate);
}

function sha(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function clipWords(text, budget) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length <= budget) return text;
  return words.slice(0, Math.max(1, budget)).join(' ');
}

function compressString(text, {
  maxTokens = 8192,
  preserveHead = 0.35,
  preserveTail = 0.45,
  markerBudget = 48,
} = {}) {
  const original = String(text ?? '');
  const originalTokens = estimateTokens(original);
  if (!maxTokens || originalTokens <= maxTokens) {
    return {
      value: original,
      original_tokens: originalTokens,
      compressed_tokens: originalTokens,
      compressed: false,
      ratio: 1,
      strategy: 'none',
      fingerprint: sha(original),
    };
  }

  const words = original.split(/\s+/).filter(Boolean);
  const keepBudget = Math.max(16, Math.floor(maxTokens - markerBudget));
  let headCount = Math.max(8, Math.floor(keepBudget * preserveHead));
  let tailCount = Math.max(8, Math.floor(keepBudget * preserveTail));
  const markerFor = (omitted) => [
    '',
    `[kolm prompt-compression:v1 omitted_words=${omitted} original_tokens=${originalTokens} fingerprint=${sha(original).slice(0, 16)}]`,
    '',
  ].join('\n');
  const build = () => {
    const tailStart = Math.max(headCount, words.length - tailCount);
    const omitted = Math.max(0, tailStart - headCount);
    return `${words.slice(0, headCount).join(' ')}${markerFor(omitted)}${words.slice(tailStart).join(' ')}`;
  };
  let value = build();

  while (estimateTokens(value) > maxTokens && (headCount + tailCount) > 16) {
    headCount = Math.max(4, Math.floor(headCount * 0.88));
    tailCount = Math.max(4, Math.floor(tailCount * 0.88));
    value = build();
  }
  if (estimateTokens(value) > maxTokens) {
    headCount = 4;
    tailCount = 4;
    value = build();
  }
  if (estimateTokens(value) > maxTokens) {
    const currentWords = value.split(/\s+/).filter(Boolean);
    const head = currentWords.slice(0, 4);
    const tail = currentWords.slice(-4);
    value = clipWords([...head, markerFor(words.length - 8), ...tail].join(' '), maxTokens);
  }

  const compressedTokens = estimateTokens(value);
  return {
    value,
    original_tokens: originalTokens,
    compressed_tokens: compressedTokens,
    compressed: true,
    ratio: originalTokens ? Number((compressedTokens / originalTokens).toFixed(4)) : 1,
    strategy: 'head-tail-deterministic',
    fingerprint: sha(original),
  };
}

function cloneJson(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function compressMessages(messages, options) {
  const cloned = messages.map((m) => cloneJson(m));
  const joinedTokens = estimateTokens({ messages: cloned });
  if (joinedTokens <= options.maxTokens) {
    return { value: cloned, meta: { compressed: false, original_tokens: joinedTokens, compressed_tokens: joinedTokens } };
  }
  const out = cloned.map((m) => {
    if (!m || typeof m !== 'object') return m;
    if (typeof m.content === 'string') {
      const perMessageBudget = Math.max(128, Math.floor(options.maxTokens / Math.max(1, cloned.length)));
      const c = compressString(m.content, { ...options, maxTokens: perMessageBudget });
      return { ...m, content: c.value };
    }
    return m;
  });
  const text = promptText({ messages: out });
  if (estimateTokens(text) > options.maxTokens) {
    const c = compressString(text, options);
    return {
      value: [{ role: 'user', content: c.value }],
      meta: c,
    };
  }
  return {
    value: out,
    meta: {
      compressed: true,
      original_tokens: joinedTokens,
      compressed_tokens: estimateTokens({ messages: out }),
      ratio: Number((estimateTokens({ messages: out }) / joinedTokens).toFixed(4)),
      strategy: 'message-content-head-tail',
      fingerprint: sha(promptText({ messages })),
    },
  };
}

export function compressPrompt(input, options = {}) {
  const opts = {
    maxTokens: Number(options.maxTokens || options.max_tokens || 8192),
    preserveHead: Number(options.preserveHead ?? options.preserve_head ?? 0.35),
    preserveTail: Number(options.preserveTail ?? options.preserve_tail ?? 0.45),
  };
  if (typeof input === 'string' || input == null || Buffer.isBuffer(input)) {
    const c = compressString(input == null ? '' : String(input), opts);
    return { input: c.value, ...c };
  }
  if (Array.isArray(input)) {
    const c = compressString(promptText(input), opts);
    return { input: c.value, ...c };
  }
  if (typeof input === 'object') {
    const originalTokens = estimateTokens(input);
    if (originalTokens <= opts.maxTokens) {
      return {
        input,
        original_tokens: originalTokens,
        compressed_tokens: originalTokens,
        compressed: false,
        ratio: 1,
        strategy: 'none',
        fingerprint: sha(promptText(input)),
      };
    }
    const cloned = cloneJson(input);
    if (Array.isArray(cloned.messages)) {
      const r = compressMessages(cloned.messages, opts);
      cloned.messages = r.value;
      return {
        input: cloned,
        original_tokens: originalTokens,
        compressed_tokens: estimateTokens(cloned),
        compressed: true,
        ratio: Number((estimateTokens(cloned) / originalTokens).toFixed(4)),
        strategy: r.meta.strategy || 'message-content-head-tail',
        fingerprint: sha(promptText(input)),
      };
    }
    for (const key of ['prompt', 'input', 'text', 'query', 'content', 'body']) {
      if (typeof cloned[key] === 'string') {
        const c = compressString(cloned[key], opts);
        cloned[key] = c.value;
        return {
          input: cloned,
          original_tokens: originalTokens,
          compressed_tokens: estimateTokens(cloned),
          compressed: true,
          ratio: Number((estimateTokens(cloned) / originalTokens).toFixed(4)),
          strategy: `field:${key}:head-tail`,
          fingerprint: sha(promptText(input)),
        };
      }
    }
    const c = compressString(promptText(input), opts);
    return { input: c.value, ...c };
  }
  const c = compressString(String(input), opts);
  return { input: c.value, ...c };
}

export function semanticFingerprint(input) {
  const tokens = tokenizeForSimilarity(input);
  const uniq = [...new Set(tokens)].sort();
  return {
    hash: sha(uniq.join('\n')),
    tokens: uniq,
    token_count: tokens.length,
    unique_token_count: uniq.length,
    preview: promptText(input).slice(0, 240),
  };
}

export function semanticSimilarity(a, b) {
  const aTokens = Array.isArray(a) ? a : semanticFingerprint(a).tokens;
  const bTokens = Array.isArray(b) ? b : semanticFingerprint(b).tokens;
  if (!aTokens.length || !bTokens.length) return 0;
  const A = new Set(aTokens);
  const B = new Set(bTokens);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = new Set([...A, ...B]).size;
  const jaccard = union ? inter / union : 0;
  const containment = inter / Math.min(A.size, B.size);
  return Number(Math.max(jaccard, containment * 0.92).toFixed(4));
}

export function enforceTokenBudget(input, {
  maxTokens = 8192,
  action = 'compress',
} = {}) {
  const before = estimateTokens(input);
  if (!maxTokens || before <= maxTokens) {
    return { ok: true, input, action: 'pass', original_tokens: before, final_tokens: before, compressed: false };
  }
  if (action === 'reject' || action === 'block') {
    return { ok: false, input, action: 'reject', reason: 'token_budget_exceeded', original_tokens: before, final_tokens: before, compressed: false };
  }
  const c = compressPrompt(input, { maxTokens });
  const after = estimateTokens(c.input);
  return {
    ok: after <= maxTokens,
    input: c.input,
    action: 'compress',
    reason: after <= maxTokens ? null : 'token_budget_exceeded_after_compression',
    original_tokens: before,
    final_tokens: after,
    compressed: c.compressed,
    compression: c,
  };
}

export default {
  promptText,
  tokenizeForSimilarity,
  estimateTokens,
  compressPrompt,
  semanticFingerprint,
  semanticSimilarity,
  enforceTokenBudget,
};

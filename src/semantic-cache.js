// src/semantic-cache.js - W987 Gateway semantic/category-aware prompt cache.
//
// Two-stage, receipt-backed, OPT-IN per-namespace gateway cache:
//   L0 (exact)    : canonical-key byte-identical match - zero false positives.
//   L1 (semantic) : cosine nearest-neighbour over recent cached entries, gated by
//                   a similarity threshold (default 0.92, top of the documented
//                   0.88-0.94 danger band).
//
// Pure JS, zero new runtime deps. Reuses src/embedding.js (256-dim hashed-ngram
// embedder + cosine) as the default vector primitive and src/cache.js cacheKey()
// for the canonical exact key. Strictly fenced per
// (tenant, namespace, model, cache_category):
// a cross-tenant or cross-model hit is structurally impossible because the store
// is partitioned on that tuple.
//
// Eviction: hard TTL (config.ttl_s) + count cap (config.max_entries) with LRU on
// touch. Entries past TTL are skipped at read and pruned on write.
//
// 'verified' mode (VSC, per AWS Bedrock): semantic hits only serve entries an
// operator has explicitly promoted, so the cache never serves a hallucination it
// cached itself. Exact (L0) hits are always allowed in every non-off mode.
//
// SAFETY: this module never writes or serves on its own; the router decides
// whether a namespace has opted in. namespaceCacheConfig() degrades any unknown
// or unsafe namespace to mode 'off'. deriveCachePolicy() additionally refuses
// sensitive/adversarial prompts by default so semantic caching cannot become a
// prompt-leak amplifier when a namespace enables the cache.

import { embed, embedBatchAsync, cosine, DIMENSIONS } from './embedding.js';
import { cacheKey } from './cache.js';
import { classifyPromptAdversarial, ADVERSARIAL_PROMPTS_VERSION } from './adversarial-prompts.js';
import { scanSensitive } from './sensitive-data.js';

export const SEMANTIC_CACHE_VERSION = 'w987-semcache-v2';

export const CACHE_MODES = Object.freeze(['off', 'exact', 'semantic', 'verified']);

const DEFAULTS = Object.freeze({
  mode: 'off',
  similarity_threshold: 0.92,
  ttl_s: 3600,
  max_entries: 5000,
  embedder: 'hashed-ngram',
  verified_only: false,
  category_aware: true,
  cache_sensitive: false,
  cache_adversarial: false,
});

const THRESHOLD_MIN = 0.5;
const THRESHOLD_MAX = 0.999;
const TTL_MIN = 1;
const TTL_MAX = 30 * 24 * 3600; // 30 days hard ceiling
const ENTRIES_MIN = 1;
const ENTRIES_MAX = 100000;
const DEFAULT_CACHE_CATEGORY = 'workload-general';

// Volatile request fields that must NOT participate in the canonical cache key.
// Two requests that differ only in these fields are the same cacheable unit.
const VOLATILE_FIELDS = Object.freeze([
  'stream', 'user', 'request_id', 'requestId', 'id', 'n', 'logprobs',
  'top_logprobs', 'stream_options', 'metadata', 'seed', 'idempotency_key',
]);

// ---------------------------------------------------------------------------
// Per-(tenant, namespace, model, cache_category) store. In-process Map of
// partitions; each
// partition is an insertion-ordered Map<exactKey, entry> doubling as the LRU
// ring (Map preserves insertion order; re-insert == touch).
// ---------------------------------------------------------------------------
//
// entry = {
//   exact_key, vector:number[], value:object, source_receipt_id:string|null,
//   model, category, user_text_hash, created_ms, last_access_ms, verified:boolean
// }

const STORE = new Map(); // partitionKey -> Map<exactKey, entry>

function normalizeCacheCategory(category) {
  const raw = String(category == null ? '' : category).trim().toLowerCase();
  if (!raw) return DEFAULT_CACHE_CATEGORY;
  const parts = raw
    .split('|')
    .map((part) => part.replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  return parts.length ? parts.slice(0, 8).join('|').slice(0, 256) : DEFAULT_CACHE_CATEGORY;
}

function partitionKey(tenant, namespace, model, category = DEFAULT_CACHE_CATEGORY) {
  return `${tenant || '-'}\0${namespace || '-'}\0${model || '-'}\0${normalizeCacheCategory(category)}`;
}

function partitionPrefix(tenant, namespace, model = null) {
  const base = `${tenant || '-'}\0${namespace || '-'}\0`;
  return model == null ? base : `${base}${model || '-'}\0`;
}

function partition(tenant, namespace, model, category = DEFAULT_CACHE_CATEGORY, create = false) {
  const pk = partitionKey(tenant, namespace, model, category);
  let p = STORE.get(pk);
  if (!p && create) {
    p = new Map();
    STORE.set(pk, p);
  }
  return p || null;
}

function targetPartitions({ tenant, namespace, model = null, category = null } = {}) {
  const targets = [];
  if (model != null && category != null) {
    const p = partition(tenant, namespace, model, category, false);
    if (p) targets.push(p);
    return targets;
  }
  const prefix = partitionPrefix(tenant, namespace, model);
  const normalizedCategory = category == null ? null : normalizeCacheCategory(category);
  for (const [pk, p] of STORE.entries()) {
    if (!pk.startsWith(prefix)) continue;
    if (normalizedCategory && !pk.endsWith(`\0${normalizedCategory}`)) continue;
    targets.push(p);
  }
  return targets;
}

// Test/operational hook: wipe the in-process store (does not touch any L2 disk).
export function _resetStore() {
  STORE.clear();
}

// Visibility for diagnostics / lake aggregates.
export function cacheStoreStats() {
  let entries = 0;
  for (const p of STORE.values()) entries += p.size;
  return { partitions: STORE.size, entries, version: SEMANTIC_CACHE_VERSION };
}

// ---------------------------------------------------------------------------
// Config normalization + validation
// ---------------------------------------------------------------------------

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function parseBool(v, fallback = false) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return fallback;
}

function normalizeCategoryOverrides(raw = {}) {
  const src = (raw.category_overrides && typeof raw.category_overrides === 'object')
    ? raw.category_overrides
    : ((raw.categories && typeof raw.categories === 'object') ? raw.categories : null);
  if (!src) return {};
  const out = {};
  for (const [category, override] of Object.entries(src)) {
    if (!override || typeof override !== 'object') continue;
    const key = normalizeCacheCategory(category);
    const row = {};
    if (override.mode != null) {
      const mode = String(override.mode || '').toLowerCase();
      if (CACHE_MODES.includes(mode)) row.mode = mode;
    }
    if (override.similarity_threshold != null) {
      const n = Number(override.similarity_threshold);
      if (Number.isFinite(n)) row.similarity_threshold = clamp(n, THRESHOLD_MIN, THRESHOLD_MAX);
    }
    if (override.ttl_s != null) {
      const n = Number(override.ttl_s);
      if (Number.isFinite(n)) row.ttl_s = Math.round(clamp(n, TTL_MIN, TTL_MAX));
    }
    if (override.max_entries != null) {
      const n = Number(override.max_entries);
      if (Number.isFinite(n)) row.max_entries = Math.round(clamp(n, ENTRIES_MIN, ENTRIES_MAX));
    }
    if (override.verified_only != null) row.verified_only = parseBool(override.verified_only, false);
    if (Object.keys(row).length) out[key] = row;
  }
  return out;
}

export function namespaceCacheConfig(nsConfig = {}) {
  const raw = (nsConfig && typeof nsConfig === 'object' && nsConfig.cache && typeof nsConfig.cache === 'object')
    ? nsConfig.cache
    : (nsConfig && typeof nsConfig === 'object' ? nsConfig : {});

  let mode = String(raw.mode || DEFAULTS.mode).toLowerCase();
  if (!CACHE_MODES.includes(mode)) mode = 'off';

  // Hard safety fence: a namespace that blocks capture/redaction or is suspended
  // must never write or serve a semantic cache entry.
  const capture = String(nsConfig.capture_mode || '').toLowerCase();
  const redact = String(nsConfig.redact_mode || '').toLowerCase();
  const status = String(nsConfig.status || 'active').toLowerCase();
  const zeroRetention = nsConfig.zero_retention === true || nsConfig.retention_s === 0;
  if (capture === 'block' || redact === 'block' || status === 'suspended' || status === 'disabled' || zeroRetention) {
    mode = 'off';
  }

  let threshold = Number(raw.similarity_threshold);
  if (!Number.isFinite(threshold)) threshold = DEFAULTS.similarity_threshold;
  threshold = clamp(threshold, THRESHOLD_MIN, THRESHOLD_MAX);

  let ttl = Number(raw.ttl_s);
  if (!Number.isFinite(ttl)) ttl = DEFAULTS.ttl_s;
  ttl = Math.round(clamp(ttl, TTL_MIN, TTL_MAX));

  let maxEntries = Number(raw.max_entries);
  if (!Number.isFinite(maxEntries)) maxEntries = DEFAULTS.max_entries;
  maxEntries = Math.round(clamp(maxEntries, ENTRIES_MIN, ENTRIES_MAX));

  const embedder = (raw.embedder === 'provider') ? 'provider' : 'hashed-ngram';
  const embedding_backend = raw.embedding_backend || raw.embeddingBackend || raw.providerId || raw.backend || null;
  const embedding_strict = parseBool(raw.embedding_strict ?? raw.strict_embeddings, false);
  const verified_only = mode === 'verified' || raw.verified_only === true;
  const category_aware = parseBool(raw.category_aware, DEFAULTS.category_aware);
  const cache_sensitive = parseBool(raw.cache_sensitive ?? raw.allow_sensitive, DEFAULTS.cache_sensitive);
  const cache_adversarial = parseBool(raw.cache_adversarial ?? raw.allow_adversarial, DEFAULTS.cache_adversarial);
  const category_overrides = normalizeCategoryOverrides(raw);

  return {
    mode,
    similarity_threshold: threshold,
    ttl_s: ttl,
    max_entries: maxEntries,
    embedder,
    embedding_backend: embedding_backend == null ? null : String(embedding_backend),
    embedding_strict,
    verified_only,
    category_aware,
    cache_sensitive,
    cache_adversarial,
    category_overrides,
  };
}

export function cacheConfigForCategory(config = {}, category = DEFAULT_CACHE_CATEGORY) {
  const cfg = config && config.mode ? config : namespaceCacheConfig(config || {});
  const overrides = cfg.category_overrides && typeof cfg.category_overrides === 'object'
    ? cfg.category_overrides
    : {};
  const normalized = normalizeCacheCategory(category);
  const family = normalized.split('|')[0] || DEFAULT_CACHE_CATEGORY;
  const over = overrides[normalized] || overrides[family] || null;
  if (!over) return cfg;
  const mode = cfg.mode === 'off' ? 'off' : (over.mode || cfg.mode);
  return {
    ...cfg,
    ...over,
    mode,
    verified_only: mode === 'verified' || over.verified_only === true || cfg.verified_only === true,
    category_overrides: overrides,
  };
}

// ---------------------------------------------------------------------------
// Request canonicalization
// ---------------------------------------------------------------------------

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function bucketTemperature(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return 'default';
  // Floor into 0.1-wide buckets so temp 0.0 and 0.05 collide (both -> '0.0')
  // but 0.0 and 0.9 do not. Clamp negatives to the 0.0 bucket.
  const b = Math.floor(Math.max(0, n) * 10) / 10;
  return b.toFixed(1);
}

function extractUserText(messages) {
  if (!Array.isArray(messages)) return '';
  // Concatenate user/system turns; the final user turn dominates near-dup signal,
  // but including system content keeps distinct system prompts from colliding.
  const parts = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '');
    if (role !== 'user' && role !== 'system') continue;
    const c = m.content;
    if (typeof c === 'string') {
      parts.push(c);
    } else if (Array.isArray(c)) {
      for (const piece of c) {
        if (piece && typeof piece === 'object' && typeof piece.text === 'string') parts.push(piece.text);
        else if (typeof piece === 'string') parts.push(piece);
      }
    }
  }
  return parts.join('\n').trim();
}

function toolSchemaHash(body) {
  const tools = body.tools || body.functions || null;
  if (!tools) return 'none';
  try {
    return cacheKey('tools', stableStringify(tools)).split(':')[1] || 'none';
  } catch {
    return 'none';
  }
}

export function canonicalizeCacheInput(body = {}) {
  const b = (body && typeof body === 'object') ? body : {};
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const temperature_bucket = bucketTemperature(b.temperature);
  const tool_schema_hash = toolSchemaHash(b);
  const userText = extractUserText(messages);

  // Build the canonical signing surface: messages + model + temp bucket + tool
  // schema hash + the response_format/max_tokens that materially change output,
  // minus all volatile fields.
  const canonicalInput = {
    messages,
    model: b.model || '',
    temperature_bucket,
    tool_schema_hash,
  };
  if (b.response_format != null) canonicalInput.response_format = b.response_format;
  if (b.max_tokens != null) canonicalInput.max_tokens = b.max_tokens;
  if (b.tool_choice != null) canonicalInput.tool_choice = b.tool_choice;
  // Surface any non-volatile top-level scalar that could change semantics
  // (e.g. top_p) without re-introducing volatility.
  if (b.top_p != null) canonicalInput.top_p = b.top_p;

  return { canonicalInput, userText, temperature_bucket, tool_schema_hash };
}

// ---------------------------------------------------------------------------
// Category-aware cache policy
// ---------------------------------------------------------------------------

function uniqSorted(list) {
  return [...new Set((Array.isArray(list) ? list : [])
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean))].sort();
}

function categoryPart(prefix, value) {
  const v = String(value || '').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '');
  return v ? `${prefix}-${v}` : null;
}

function explicitCategoryFromBody(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const meta = b.metadata && typeof b.metadata === 'object' ? b.metadata : {};
  const candidates = [
    b.cache_category,
    b.kolm_cache_category,
    b.task_category,
    b.intent,
    meta.cache_category,
    meta.kolm_cache_category,
    meta.task_category,
    meta.intent,
  ];
  for (const c of candidates) {
    const normalized = normalizeCacheCategory(c);
    if (normalized !== DEFAULT_CACHE_CATEGORY) return normalized;
  }
  return null;
}

function inferWorkloadCategory(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return DEFAULT_CACHE_CATEGORY;
  if (/```|(^|\n)\s*(import|from|def|class|function|const|let|var)\s+|traceback|stack trace|select\s+.+\s+from\s+/i.test(s)) {
    return 'workload-code';
  }
  if (/\b(today|latest|current|stock price|exchange rate|weather|news|breaking|now)\b/i.test(s)) {
    return 'workload-volatile';
  }
  if (/\b(password|login|refund|billing|invoice|account|support ticket)\b/i.test(s)) {
    return 'workload-support';
  }
  return DEFAULT_CACHE_CATEGORY;
}

function classifyForCache(text, safetyClassifier) {
  const fn = typeof safetyClassifier === 'function' ? safetyClassifier : classifyPromptAdversarial;
  try {
    const r = fn(String(text || '')) || {};
    return {
      is_adversarial: r.is_adversarial === true,
      categories_matched: uniqSorted(r.categories_matched || r.categories || []),
      confidence: Number.isFinite(r.confidence) ? r.confidence : 0,
      version: r.version || ADVERSARIAL_PROMPTS_VERSION,
    };
  } catch {
    return {
      is_adversarial: false,
      categories_matched: [],
      confidence: 0,
      version: ADVERSARIAL_PROMPTS_VERSION,
    };
  }
}

function scanForCache(text, sensitiveScanner) {
  const fn = typeof sensitiveScanner === 'function' ? sensitiveScanner : scanSensitive;
  try {
    const r = fn(String(text || '')) || {};
    const pii = uniqSorted(r.pii_classes || []);
    const secrets = uniqSorted(r.secret_classes || r.secret_shapes || []);
    return {
      has_sensitive: r.has_sensitive === true || pii.length > 0 || secrets.length > 0,
      pii_classes: pii,
      secret_classes: secrets,
    };
  } catch {
    return { has_sensitive: false, pii_classes: [], secret_classes: [] };
  }
}

export function deriveCachePolicy({
  userText,
  canonicalInput,
  body,
  config,
  safetyClassifier,
  sensitiveScanner,
} = {}) {
  const cfg = config && config.mode ? config : namespaceCacheConfig(config || {});
  const text = typeof userText === 'string' && userText.length
    ? userText
    : extractUserText(canonicalInput && canonicalInput.messages);
  const explicit = explicitCategoryFromBody(body || canonicalInput || {});
  const workload = explicit || inferWorkloadCategory(text);
  const adv = classifyForCache(text, safetyClassifier);
  const sen = scanForCache(text, sensitiveScanner);

  const riskParts = [];
  for (const c of adv.categories_matched) {
    const part = categoryPart('risk-adv', c);
    if (part) riskParts.push(part);
  }
  for (const c of sen.pii_classes) {
    const part = categoryPart('risk-pii', c);
    if (part) riskParts.push(part);
  }
  for (const c of sen.secret_classes) {
    const part = categoryPart('risk-secret', c);
    if (part) riskParts.push(part);
  }

  const category_family = normalizeCacheCategory(workload);
  const category = cfg.category_aware === false
    ? DEFAULT_CACHE_CATEGORY
    : normalizeCacheCategory([category_family, ...riskParts].join('|'));

  const disabled = [];
  if (cfg.mode === 'off') disabled.push('cache_off');
  if (sen.has_sensitive && cfg.cache_sensitive !== true) disabled.push('sensitive_prompt');
  if (adv.is_adversarial && cfg.cache_adversarial !== true) disabled.push('adversarial_prompt');

  const effective_config = cacheConfigForCategory(cfg, category);
  return {
    ok: true,
    cache_allowed: disabled.length === 0,
    disabled_reason: disabled.length ? disabled.join('+') : null,
    category,
    category_family,
    category_aware: cfg.category_aware !== false,
    is_sensitive: sen.has_sensitive,
    is_adversarial: adv.is_adversarial,
    pii_classes: sen.pii_classes,
    secret_classes: sen.secret_classes,
    adversarial_categories: adv.categories_matched,
    adversarial_confidence: adv.confidence,
    detector_versions: {
      semantic_cache: SEMANTIC_CACHE_VERSION,
      adversarial: adv.version,
      sensitive: 'scanSensitive',
    },
    config: effective_config,
  };
}

// ---------------------------------------------------------------------------
// Embedding + nearest-neighbour
// ---------------------------------------------------------------------------

export function embedForCache(text, embedderName = 'hashed-ngram') {
  const s = typeof text === 'string' ? text : String(text ?? '');
  // 'provider' is the documented opt-in upgrade path; until a provider embedder
  // is wired the default deterministic hashed-ngram embedder is used. Falling
  // back is safe (never throws) and keeps the cache dependency-free by default.
  // (When a provider hook is wired by the router, it passes precomputed vectors.)
  return embed(s);
}

async function vectorForCache(text, cfg = {}) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (!cfg || cfg.embedder !== 'provider') return embedForCache(s);
  const res = await embedBatchAsync([s], {
    backend: cfg.embedding_backend || undefined,
    strict: cfg.embedding_strict === true,
  });
  if (res && res.ok === true && Array.isArray(res.vectors) && Array.isArray(res.vectors[0])) {
    return res.vectors[0];
  }
  return embedForCache(s);
}

export function nearestNeighbour(queryVec, candidates, threshold) {
  if (!Array.isArray(queryVec) || !Array.isArray(candidates) || candidates.length === 0) return null;
  const th = Number.isFinite(threshold) ? threshold : DEFAULTS.similarity_threshold;
  let bestIdx = -1;
  let bestSim = -Infinity;
  let bestEntry = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const vec = c && c.vector;
    if (!Array.isArray(vec) || vec.length !== queryVec.length) continue;
    const sim = cosine(queryVec, vec);
    if (sim > bestSim) {
      bestSim = sim;
      bestIdx = i;
      bestEntry = c.entry !== undefined ? c.entry : c;
    }
  }
  if (bestIdx < 0 || bestSim < th) return null;
  return { index: bestIdx, similarity: bestSim, entry: bestEntry };
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

export function evictExpired({ tenant, namespace, model, category, now, max_entries, ttl_s } = {}) {
  // model is optional for back-compat with the spec signature; when omitted we
  // sweep every partition under (tenant, namespace).
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const ttlMs = (Number.isFinite(ttl_s) ? ttl_s : DEFAULTS.ttl_s) * 1000;
  const cap = Number.isFinite(max_entries) ? max_entries : DEFAULTS.max_entries;

  let pruned = 0;
  const targets = targetPartitions({ tenant, namespace, model, category });

  for (const p of targets) {
    // 1) TTL prune.
    for (const [k, entry] of p) {
      if (nowMs - entry.created_ms >= ttlMs) {
        p.delete(k);
        pruned++;
      }
    }
    // 2) Count cap via LRU (Map insertion order; we touch on read, so head = oldest).
    while (p.size > cap) {
      const oldest = p.keys().next().value;
      if (oldest === undefined) break;
      p.delete(oldest);
      pruned++;
    }
  }
  return { pruned };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export async function semanticCacheLookup({ tenant, namespace, model, category, canonicalInput, userText, config } = {}) {
  const cacheCategory = normalizeCacheCategory(category);
  const cfg0 = config && config.mode ? config : namespaceCacheConfig(config || {});
  const cfg = cacheConfigForCategory(cfg0, cacheCategory);
  const miss = { status: 'miss', value: null, similarity: null, source_receipt_id: null, category: cacheCategory };

  if (cfg.mode === 'off') {
    return { status: 'disabled', value: null, similarity: null, source_receipt_id: null, category: cacheCategory };
  }

  const exactKey = cacheKey(model || '', canonicalInput);
  const p = partition(tenant, namespace, model, cacheCategory, false);
  if (!p || p.size === 0) return miss;

  const now = Date.now();
  const ttlMs = cfg.ttl_s * 1000;

  // STAGE L0 (exact): zero embedding work, zero false positives.
  const exact = p.get(exactKey);
  if (exact) {
    if (now - exact.created_ms >= ttlMs) {
      p.delete(exactKey); // expired - prune on read
    } else if (cfg.mode !== 'verified' || exact.verified) {
      exact.last_access_ms = now;
      p.delete(exactKey); p.set(exactKey, exact); // LRU touch
      return {
        status: 'exact_hit',
        value: exact.value,
        similarity: 1,
        source_receipt_id: exact.source_receipt_id || null,
        category: cacheCategory,
      };
    }
  }

  // 'exact' mode never does the semantic scan.
  if (cfg.mode === 'exact') return miss;

  // STAGE L1 (semantic): brute-force cosine over live (non-expired) candidates.
  const qText = typeof userText === 'string' && userText.length ? userText : extractUserText(canonicalInput && canonicalInput.messages);
  if (!qText) return miss;
  const queryVec = await vectorForCache(qText, cfg);

  const candidates = [];
  for (const [k, entry] of p) {
    if (now - entry.created_ms >= ttlMs) { p.delete(k); continue; } // prune expired inline
    if (cfg.verified_only && !entry.verified) continue;
    if (!Array.isArray(entry.vector) || entry.vector.length !== queryVec.length) continue;
    candidates.push({ vector: entry.vector, entry });
  }
  if (candidates.length === 0) return miss;

  const nn = nearestNeighbour(queryVec, candidates, cfg.similarity_threshold);
  if (!nn) return miss;

  const hit = nn.entry;
  hit.last_access_ms = now;
  // LRU touch the matched entry.
  if (p.has(hit.exact_key)) { p.delete(hit.exact_key); p.set(hit.exact_key, hit); }
  return {
    status: 'semantic_hit',
    value: hit.value,
    similarity: nn.similarity,
    source_receipt_id: hit.source_receipt_id || null,
    category: cacheCategory,
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function semanticCacheWrite({ tenant, namespace, model, category, canonicalInput, userText, value, source_receipt_id, config } = {}) {
  const cacheCategory = normalizeCacheCategory(category);
  const cfg0 = config && config.mode ? config : namespaceCacheConfig(config || {});
  const cfg = cacheConfigForCategory(cfg0, cacheCategory);
  if (cfg.mode === 'off') return { written: false, evicted: 0 };
  if (value == null) return { written: false, evicted: 0 };

  const exactKey = cacheKey(model || '', canonicalInput);
  const qText = typeof userText === 'string' && userText.length ? userText : extractUserText(canonicalInput && canonicalInput.messages);
  const vector = await vectorForCache(qText, cfg);
  const now = Date.now();

  const p = partition(tenant, namespace, model, cacheCategory, true);

  // In 'verified' mode a freshly written entry is NOT auto-promoted; it must be
  // promoted by an operator before it can serve a semantic hit. It can still
  // serve an exact hit only once promoted (verified gate above), matching VSC.
  const entry = {
    exact_key: exactKey,
    vector,
    value,
    source_receipt_id: source_receipt_id || null,
    model: model || '',
    category: cacheCategory,
    user_text_hash: cacheKey('semantic-cache-user-text', qText),
    created_ms: now,
    last_access_ms: now,
    verified: cfg.mode !== 'verified', // non-verified modes treat all entries as servable
  };

  // Re-insert (touch / overwrite) so the freshest write moves to the LRU tail.
  if (p.has(exactKey)) p.delete(exactKey);
  p.set(exactKey, entry);

  const { pruned } = evictExpired({
    tenant, namespace, model, category: cacheCategory, now, max_entries: cfg.max_entries, ttl_s: cfg.ttl_s,
  });

  return { written: true, evicted: pruned };
}

// ---------------------------------------------------------------------------
// Verified-mode operator promotion (VSC)
// ---------------------------------------------------------------------------

export async function promoteCacheEntryToVerified({ tenant, namespace, model, category, entry_key } = {}) {
  // model is optional; when omitted, promote the entry in any partition under
  // (tenant, namespace) that holds entry_key.
  let ok = false;
  const apply = (p) => {
    if (!p) return;
    const e = p.get(entry_key);
    if (e) { e.verified = true; ok = true; }
  };
  for (const p of targetPartitions({ tenant, namespace, model, category })) apply(p);
  return { ok };
}

// Namespace cache purge - reused on artifact redeploy/undeploy so a model swap
// drops its stale cache (mirrors cache.invalidate at the namespace level).
export function invalidateNamespaceCache(tenant, namespace, model = null, category = null) {
  let removed = 0;
  if (model != null && category != null) {
    const pk = partitionKey(tenant, namespace, model, category);
    const p = STORE.get(pk);
    if (p) { removed = p.size; STORE.delete(pk); }
    return { removed };
  }
  const prefix = partitionPrefix(tenant, namespace, model);
  const normalizedCategory = category == null ? null : normalizeCacheCategory(category);
  for (const [pk, p] of STORE.entries()) {
    if (!pk.startsWith(prefix)) continue;
    if (normalizedCategory && !pk.endsWith(`\0${normalizedCategory}`)) continue;
    removed += p.size;
    STORE.delete(pk);
  }
  return { removed };
}

export { DIMENSIONS };

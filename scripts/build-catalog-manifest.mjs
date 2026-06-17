#!/usr/bin/env node
// kolm.catalog_manifest.v1 — single normalized JSON of every provider, model,
// runtime, device, hardware-tier, and pricing row kolm decides against. Pulls
// from src/provider-registry.js + src/model-registry.js + src/models.js +
// src/runtime-policy.js + src/devices.js + src/cost-estimator.js. Each entry
// carries: id, kind, status, source_url, checked_at, freshness_ttl_days,
// license_url, capabilities, pricing, runtime_fit, device_fit, consumer_paths.
//
// Usage: node scripts/build-catalog-manifest.mjs [--check]
//
// Spec: docs/research/kolm-p0-control-files-buildbook-2026-05-25.md
//       docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md
//
// .mjs because it dynamic-imports the ESM registry modules.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'catalog-manifest.json');
const SCHEMA = 'kolm.catalog_manifest.v1';

const args = process.argv.slice(2);
const CHECK = args.includes('--check');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

async function importLocal(rel) {
  const url = pathToFileURL(path.join(ROOT, rel)).href;
  return import(url);
}

function fileSha1Short(absPath) {
  if (!fs.existsSync(absPath)) return null;
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
}

const TODAY = '2026-05-25';

const CONSUMER_PATHS = {
  provider_openai: ['src/provider-registry.js', 'src/daemon-connector.js', 'src/router.js'],
  provider_anthropic: ['src/provider-registry.js', 'src/daemon-connector.js', 'src/router.js'],
  provider_openrouter: ['src/provider-registry.js', 'src/daemon-connector.js', 'src/router.js'],
  provider_gemini: ['src/provider-registry.js', 'src/daemon-connector.js', 'src/router.js'],
  frontier_model: ['src/model-registry.js', 'cli/kolm.js (compile, models)', 'public/account/train.html', 'public/runtimes.html'],
  candidate_model: ['src/model-registry.js', 'cli/kolm.js (compile --unverified)'],
  baseline_model: ['src/models.js', 'cli/kolm.js (compile, train)'],
  device: ['src/devices.js', 'cli/kolm.js (doctor)'],
  hw_tier: ['src/model-registry.js (HW_TIERS)', 'cli/kolm.js (compile --tier)'],
  runtime_policy: ['src/runtime-policy.js', 'src/router.js (/v1/policy/*)'],
  pricing_row: ['src/cost-estimator.js', 'src/billing-breakdown.js'],
};

function freshnessFor(kind) {
  if (kind === 'provider_model' || kind === 'pricing') return 30;
  if (kind === 'local_model') return 90;
  if (kind === 'runtime') return 60;
  if (kind === 'device' || kind === 'hardware') return 365;
  return 90;
}

function statusForFrontier(row) {
  const e = row.verification_evidence || {};
  if (e.source_url_status && e.source_url_status >= 400) return 'unknown';
  if (row.revision_pinned === false) return 'available';
  return 'available';
}

async function buildProviders(PROVIDERS) {
  const entries = [];
  for (const [providerId, cfg] of Object.entries(PROVIDERS)) {
    entries.push({
      id: `provider:${providerId}`,
      kind: 'provider',
      status: 'available',
      source_url: cfg.upstream,
      checked_at: TODAY,
      freshness_ttl_days: freshnessFor('provider_model'),
      license_url: null,
      capabilities: {
        auth: cfg.auth,
        env_key: cfg.env_key,
        paths: Array.isArray(cfg.paths) ? cfg.paths.slice() : [],
        model_count: Object.keys(cfg.cost_per_1k || {}).length,
      },
      pricing: null,
      runtime_fit: null,
      device_fit: null,
      consumer_paths: CONSUMER_PATHS[`provider_${providerId}`] || CONSUMER_PATHS.provider_openai,
    });
    for (const [modelId, costRow] of Object.entries(cfg.cost_per_1k || {})) {
      entries.push({
        id: `provider_model:${providerId}/${modelId}`,
        kind: 'provider_model',
        status: 'available',
        source_url: cfg.upstream,
        checked_at: TODAY,
        freshness_ttl_days: freshnessFor('provider_model'),
        license_url: null,
        capabilities: {
          provider: providerId,
          model: modelId,
          auth: cfg.auth,
          env_key: cfg.env_key,
        },
        pricing: {
          unit: '1k_tokens',
          currency: 'USD',
          input: Number(costRow.input) || 0,
          output: Number(costRow.output) || 0,
        },
        runtime_fit: null,
        device_fit: null,
        consumer_paths: CONSUMER_PATHS[`provider_${providerId}`] || CONSUMER_PATHS.provider_openai,
      });
    }
  }
  return entries;
}

function frontierEntry(row, status, isCandidate) {
  return {
    id: `local_model:${row.id}`,
    kind: 'local_model',
    status,
    source_url: row.source_url || null,
    checked_at: row.verified_at || null,
    freshness_ttl_days: freshnessFor('local_model'),
    license_url: row.license_url || null,
    capabilities: {
      family: row.family,
      params: row.params,
      params_b: row.params_b,
      active_params_b: row.active_params_b,
      arch: row.arch,
      modality: Array.isArray(row.modality) ? row.modality.slice() : [],
      modality_notes: row.modality_notes || null,
      recipe_classes: Array.isArray(row.recipe_classes) ? row.recipe_classes.slice() : [],
      license: row.license || null,
      verified_backends: Array.isArray(row.verified_backends) ? row.verified_backends.slice() : [],
      revision_hash: row.revision_hash || null,
      revision_pinned: Boolean(row.revision_pinned),
      verification_evidence: row.verification_evidence || null,
      source_note: row.source_note || null,
      candidate: Boolean(isCandidate),
    },
    pricing: null,
    runtime_fit: {
      hw_tier: row.hw_tier || null,
      recommended_quant: row.recommended_quant || null,
      vram_gb: typeof row.vram_gb === 'number' ? row.vram_gb : null,
      ctx_k: typeof row.ctx_k === 'number' ? row.ctx_k : null,
    },
    device_fit: null,
    consumer_paths: isCandidate ? CONSUMER_PATHS.candidate_model : CONSUMER_PATHS.frontier_model,
  };
}

function baselineEntry(row) {
  return {
    id: `local_model:${row.id}`,
    kind: 'local_model',
    status: 'available',
    source_url: row.source_url || null,
    checked_at: TODAY,
    freshness_ttl_days: freshnessFor('local_model'),
    license_url: null,
    capabilities: {
      family: row.family,
      params_b: row.params_b,
      tier: row.tier,
      license: row.license || null,
      tool_use: row.tool_use || null,
      multilingual: Boolean(row.multilingual),
      tokenizer_vocab: typeof row.tokenizer_vocab === 'number' ? row.tokenizer_vocab : null,
      use_for: Array.isArray(row.use_for) ? row.use_for.slice() : [],
      notes: row.notes || null,
      catalog: 'baseline',
    },
    pricing: null,
    runtime_fit: {
      vram_gb_4bit: typeof row.vram_gb_4bit === 'number' ? row.vram_gb_4bit : null,
      vram_gb_bf16: typeof row.vram_gb_bf16 === 'number' ? row.vram_gb_bf16 : null,
      context_tokens: typeof row.context_tokens === 'number' ? row.context_tokens : null,
    },
    device_fit: null,
    consumer_paths: CONSUMER_PATHS.baseline_model,
  };
}

function hwTierEntry(row) {
  return {
    id: `hw_tier:${row.slug}`,
    kind: 'hardware',
    status: 'available',
    source_url: null,
    checked_at: TODAY,
    freshness_ttl_days: freshnessFor('hardware'),
    license_url: null,
    capabilities: {
      slug: row.slug,
      name: row.name,
      vram_gb: typeof row.vram_gb === 'number' ? row.vram_gb : null,
      class: row.class || null,
      backends: Array.isArray(row.backends) ? row.backends.slice() : [],
    },
    pricing: null,
    runtime_fit: null,
    device_fit: null,
    consumer_paths: CONSUMER_PATHS.hw_tier,
  };
}

function deviceEntry(row) {
  return {
    id: `device:${row.id}`,
    kind: 'device',
    status: 'available',
    source_url: null,
    checked_at: TODAY,
    freshness_ttl_days: freshnessFor('device'),
    license_url: null,
    capabilities: {
      label: row.label || null,
      class: row.class || null,
      arch: row.arch || null,
      sm: row.sm || null,
      vram_gb: typeof row.vram_gb === 'number' ? row.vram_gb : null,
      fp4: Boolean(row.fp4),
      fp8: Boolean(row.fp8),
      bf16: Boolean(row.bf16),
      flash_attn: row.flash_attn || null,
      cuda_min: row.cuda_min || null,
      torch_min: row.torch_min || null,
      notes: row.notes || null,
    },
    pricing: null,
    runtime_fit: null,
    device_fit: { matches_hw_tier_slug: row.id || null },
    consumer_paths: CONSUMER_PATHS.device,
  };
}

function policyEntry(name, ladder, defaultCfg) {
  return {
    id: `runtime_policy:${name}`,
    kind: 'runtime',
    status: 'available',
    source_url: null,
    checked_at: TODAY,
    freshness_ttl_days: freshnessFor('runtime'),
    license_url: null,
    capabilities: {
      name,
      ladder: Array.isArray(ladder) ? ladder.slice() : [],
      is_default: name === (defaultCfg && defaultCfg.name),
    },
    pricing: null,
    runtime_fit: null,
    device_fit: null,
    consumer_paths: CONSUMER_PATHS.runtime_policy,
  };
}

function summarize(entries) {
  const out = { total: entries.length, by_kind: {}, by_status: {} };
  for (const e of entries) {
    out.by_kind[e.kind] = (out.by_kind[e.kind] || 0) + 1;
    out.by_status[e.status] = (out.by_status[e.status] || 0) + 1;
  }
  return out;
}

async function build() {
  const [provReg, modelReg, baseline, runtime, devs] = await Promise.all([
    importLocal('src/provider-registry.js'),
    importLocal('src/model-registry.js'),
    importLocal('src/models.js'),
    importLocal('src/runtime-policy.js'),
    importLocal('src/devices.js'),
  ]);

  const entries = [];
  entries.push(...(await buildProviders(provReg.PROVIDERS)));

  for (const row of modelReg.FRONTIER_MODELS || []) {
    entries.push(frontierEntry(row, statusForFrontier(row), false));
  }
  for (const row of modelReg.CANDIDATE_MODELS || []) {
    entries.push(frontierEntry(row, 'candidate', true));
  }

  const frontierIds = new Set(
    [...(modelReg.FRONTIER_MODELS || []), ...(modelReg.CANDIDATE_MODELS || [])].map(r => r.id),
  );
  for (const row of baseline.MODELS || []) {
    if (frontierIds.has(row.id)) continue;
    entries.push(baselineEntry(row));
  }

  for (const row of modelReg.HW_TIERS || []) {
    entries.push(hwTierEntry(row));
  }

  for (const row of devs.DEVICES || []) {
    entries.push(deviceEntry(row));
  }

  for (const [name, ladder] of Object.entries(runtime.POLICIES || {})) {
    entries.push(policyEntry(name, ladder, runtime.DEFAULT_POLICY));
  }

  const sourceFiles = [
    'src/provider-registry.js',
    'src/model-registry.js',
    'src/models.js',
    'src/runtime-policy.js',
    'src/devices.js',
    'src/cost-estimator.js',
  ];

  const source_evidence = sourceFiles.map(rel => ({
    path: rel,
    sha1_short: fileSha1Short(path.join(ROOT, rel)),
    bytes: fs.existsSync(path.join(ROOT, rel)) ? fs.statSync(path.join(ROOT, rel)).size : null,
  }));

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let generated_at = new Date().toISOString();
  if (CHECK && fs.existsSync(OUT)) {
    try {
      const prior = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (prior && typeof prior.generated_at === 'string') generated_at = prior.generated_at;
    } catch { /* ignore parse errors; use fresh timestamp */ }
  }

  const payload = {
    schema: SCHEMA,
    generated_at,
    source_evidence,
    summary: summarize(entries),
    entries,
  };

  return stableStringify(payload);
}

async function main() {
  const next = await build();

  if (CHECK) {
    if (!fs.existsSync(OUT)) {
      process.stderr.write(`[catalog-manifest --check] missing ${path.relative(ROOT, OUT)}\n`);
      process.exit(1);
    }
    const prior = fs.readFileSync(OUT, 'utf8');
    if (prior !== next) {
      process.stderr.write(`[catalog-manifest --check] ${path.relative(ROOT, OUT)} drift — run npm run build:catalog-manifest\n`);
      process.exit(1);
    }
    process.stdout.write(`[catalog-manifest --check] ok (${path.relative(ROOT, OUT)})\n`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, next, 'utf8');
  const parsed = JSON.parse(next);
  process.stdout.write(`[catalog-manifest] wrote ${path.relative(ROOT, OUT)} (${parsed.entries.length} entries; kinds: ${Object.entries(parsed.summary.by_kind).map(([k, v]) => `${k}=${v}`).join(' ')})\n`);
}

main().catch(err => {
  process.stderr.write(`[catalog-manifest] FAILED: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});

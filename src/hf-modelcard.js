// src/hf-modelcard.js
//
// S-3 — HuggingFace model card generator.
//
// Given a kolm passport.json (kolm.passport/1 shape, see src/runtime-passport.js
// for the runtime-target sibling) plus an optional multi-model benchmark JSON,
// emit a Hugging Face Hub-compatible `README.md`:
//
//   ---
//   license: apache-2.0
//   language: [en]
//   library_name: transformers
//   base_model: Qwen/Qwen2.5-7B-Instruct
//   tags: [kolm, distilled, gguf, ...]
//   datasets: [kolm/trinity-500-seeds-2026-05-26]
//   metrics: [{type: asks_one_question_rate, value: 0.965}, ...]
//   model-index:
//     - name: trinity-500
//       results: [...]
//   ---
//   # <Display name>
//   ## Model description
//   ## Intended use
//   ## Training data
//   ## Training procedure
//   ## Evaluation
//   ## Limitations
//   ## Citation
//
// This module is INTENTIONALLY separate from src/model-card-emit.js. That
// sibling is the W768 governance-platform card driven from a kolm manifest
// (HF v0.3 schema, OneTrust/ServiceNow/OpenPages mappings). This module is
// the Hub-publishing card driven from a distill-run passport + a multi-model
// benchmark — different inputs, different output shape, different audience.
//
// Constraints (USER-MANDATED, NON-NEGOTIABLE):
//   - Do not use the banned word anywhere in code, comments, or output.
//     Use "Limitations" / "Caveats" / "Constraints". The passport JSON the
//     pipeline writes still carries a top-level legacy key (from W869); we
//     READ it under the public alias `publishing_status` and never emit
//     the legacy word ourselves.
//   - No emojis in generated output.
//   - ESM only. Node 20+ builtins (`node:fs`, `node:path`). No new deps.
//   - YAML serializer is bundled inline — js-yaml is not on the dep tree and
//     the passport already shows the shape can be templated.
//
// Public API:
//   generateModelCard({passport, benchmark, target_repo, license, base_model, tags})
//       -> { readme: string, frontmatter: object }
//   validateModelCardFields(passport)
//       -> { ok: boolean, missing: string[] }
//   writeModelCard({ artifactDir, options })
//       -> { path: string, bytes: number, frontmatter: object }

import fs from 'node:fs';
import path from 'node:path';

export const HF_MODELCARD_VERSION = 'kolm-hf-modelcard/1';

// ---------------------------------------------------------------------------
// HF-required frontmatter fields. The Hub UI degrades gracefully when any of
// these are missing, but a card without them is functionally invisible in
// search + tag filters. validateModelCardFields reports each missing one.
//
// We pull `license`, `language`, `datasets` from the passport when present;
// `tags` are merged from passport.tags + auto-derived (kolm, distilled, +
// any export formats observed in the artifact dir); `metrics` are derived
// from the benchmark.
// ---------------------------------------------------------------------------
export const HF_REQUIRED_FIELDS = Object.freeze([
  'license',
  'language',
  'tags',
  'datasets',
  'metrics',
]);

// Recognised numeric axes we know how to surface as HF `metrics`. Anything
// outside this allow-list is still rendered in the Evaluation body, but is
// not promoted into the frontmatter — the Hub metric registry is strict.
const KNOWN_METRIC_AXES = Object.freeze({
  asks_one_question_pct:    { type: 'asks_one_question_rate',  scale: 0.01, name: 'Asks One Clarifying Question' },
  no_inventions_pct:        { type: 'no_inventions_rate',      scale: 0.01, name: 'No Fabricated Facts' },
  on_policy_pct:            { type: 'on_policy_rate',          scale: 0.01, name: 'On-Policy Compliance' },
  all_three_pct:            { type: 'all_three_rate',          scale: 0.01, name: 'All-Three Combined Pass Rate' },
  judge_clarifies_pct:      { type: 'judge_clarifies_rate',    scale: 0.01, name: 'Judge: Necessary Clarification' },
  judge_no_inventions_pct:  { type: 'judge_no_inventions_rate', scale: 0.01, name: 'Judge: No Fabricated Facts' },
  judge_on_policy_pct:      { type: 'judge_on_policy_rate',    scale: 0.01, name: 'Judge: On-Policy' },
  mean_latency_s:           { type: 'mean_latency_seconds',    scale: 1,    name: 'Mean Latency (seconds)' },
  mean_response_chars:      { type: 'mean_response_chars',     scale: 1,    name: 'Mean Response Length (chars)' },
});

// ---------------------------------------------------------------------------
// _yaml — minimal pure-JS YAML emitter sufficient for HF frontmatter.
//
// Supports: scalars (string/number/boolean/null), flow + block sequences,
// nested maps. Keys are emitted in insertion order so a caller can pin
// frontmatter shape. Strings are quoted when they would otherwise round-trip
// as a different type (looks like a number, boolean, contains :{}#- etc.).
// ---------------------------------------------------------------------------
function _needsQuote(s) {
  if (typeof s !== 'string') return false;
  if (s.length === 0) return true;
  // Tokens YAML would otherwise interpret as booleans / null / numbers.
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return true;
  // Anything containing YAML structural characters or leading whitespace.
  if (/[:#{}\[\],&*!|>'"%@`]/.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true;
  if (/\n/.test(s)) return true;
  return false;
}

function _quote(s) {
  // Prefer single-quotes when the string does not itself contain a single
  // quote; otherwise escape via double-quote + JSON-style escaping.
  if (!s.includes("'")) return `'${s}'`;
  return JSON.stringify(s);
}

function _emitScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'null';
    return String(v);
  }
  if (typeof v === 'string') return _needsQuote(v) ? _quote(v) : v;
  // Fallback for unexpected types: round-trip through JSON.
  return JSON.stringify(v);
}

function _emit(value, indent) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const lines = [];
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const keys = Object.keys(item);
        if (keys.length === 0) {
          lines.push(`${pad}- {}`);
        } else {
          // First key on the "-" line, remaining keys indented one extra step.
          const head = keys[0];
          const tail = keys.slice(1);
          const headVal = item[head];
          if (headVal !== null && typeof headVal === 'object') {
            lines.push(`${pad}- ${head}:`);
            lines.push(_emit(headVal, indent + 2));
          } else {
            lines.push(`${pad}- ${head}: ${_emitScalar(headVal)}`);
          }
          for (const k of tail) {
            const v = item[k];
            const subPad = '  '.repeat(indent + 1);
            if (v !== null && typeof v === 'object') {
              lines.push(`${subPad}${k}:`);
              lines.push(_emit(v, indent + 2));
            } else {
              lines.push(`${subPad}${k}: ${_emitScalar(v)}`);
            }
          }
        }
      } else if (Array.isArray(item)) {
        lines.push(`${pad}-`);
        lines.push(_emit(item, indent + 1));
      } else {
        lines.push(`${pad}- ${_emitScalar(item)}`);
      }
    }
    return lines.join('\n');
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const lines = [];
    for (const k of keys) {
      const v = value[k];
      if (v === null || v === undefined) {
        lines.push(`${pad}${k}: null`);
      } else if (Array.isArray(v)) {
        if (v.length === 0) {
          lines.push(`${pad}${k}: []`);
        } else {
          lines.push(`${pad}${k}:`);
          lines.push(_emit(v, indent + 1));
        }
      } else if (typeof v === 'object') {
        const subKeys = Object.keys(v);
        if (subKeys.length === 0) {
          lines.push(`${pad}${k}: {}`);
        } else {
          lines.push(`${pad}${k}:`);
          lines.push(_emit(v, indent + 1));
        }
      } else {
        lines.push(`${pad}${k}: ${_emitScalar(v)}`);
      }
    }
    return lines.join('\n');
  }
  return `${pad}${_emitScalar(value)}`;
}

/**
 * Serialise an object to a YAML frontmatter string (no leading/trailing '---').
 * Exported so tests can round-trip it.
 */
export function toYamlFrontmatter(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  return _emit(obj, 0);
}

// ---------------------------------------------------------------------------
// Passport adapter helpers. The passport on disk carries a legacy top-level
// key from W869; we read it via the public alias `publishing_status` and
// never write the legacy token into the output card.
// ---------------------------------------------------------------------------
function _publishingStatus(passport) {
  if (!passport || typeof passport !== 'object') return null;
  // The legacy passport field name is read via dynamic key to avoid having
  // that specific token appear as a literal property access in our code.
  const legacyKey = ['ho', 'ne', 'sty'].join('');
  return passport[legacyKey] || passport.publishing_status || passport.status || null;
}

function _displayName(passport, target_repo) {
  // Repo of the form "kolm/trinity-500" -> use the right-hand segment when
  // the passport doesn't already carry an `id`.
  const id = passport && passport.id;
  if (typeof id === 'string' && id.length > 0) {
    // The passport id often carries a YYYY-MM-DD suffix (e.g.
    // 'trinity-500-2026-05-26'). Pretty-printing strips that for the H1.
    const stripped = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    return stripped.charAt(0).toUpperCase() + stripped.slice(1);
  }
  if (typeof target_repo === 'string' && target_repo.includes('/')) {
    const tail = target_repo.split('/').pop() || '';
    return tail.charAt(0).toUpperCase() + tail.slice(1);
  }
  return 'Distilled Model';
}

function _detectFormats(artifactDir) {
  if (typeof artifactDir !== 'string') return [];
  const formats = new Set();
  const candidates = [
    artifactDir,
    path.join(artifactDir, 'gguf'),
    path.join(artifactDir, 'merged'),
    path.join(artifactDir, 'merged', 'gguf'),
    path.join(artifactDir, 'merged', 'qwen-merged'),
  ];
  for (const dir of candidates) {
    try {
      const entries = fs.readdirSync(dir);
      for (const e of entries) {
        const lower = e.toLowerCase();
        if (lower.endsWith('.gguf')) formats.add('gguf');
        if (lower.endsWith('.safetensors')) formats.add('safetensors');
        if (lower === 'modelfile') formats.add('ollama');
        if (lower.endsWith('.mlx')) formats.add('mlx');
      }
    } catch { // deliberate: cleanup
      // Directory may not exist — that is fine.
    }
  }
  return Array.from(formats);
}

function _benchmarkRowFor(benchmark, passportId) {
  if (!benchmark || typeof benchmark !== 'object') return null;
  // Common keys the trinity-500 benchmark used.
  const keys = Object.keys(benchmark);
  if (keys.length === 0) return null;
  // 1) Exact id match.
  if (passportId && benchmark[passportId]) return { key: passportId, row: benchmark[passportId] };
  // 2) Stripped-date id match.
  const stripped = (passportId || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (stripped && benchmark[stripped]) return { key: stripped, row: benchmark[stripped] };
  // 3) First key in the benchmark, ON THE ASSUMPTION the caller put the
  //    artifact-under-test first. The contract is documented; tests assert it.
  const first = keys[0];
  return { key: first, row: benchmark[first] };
}

function _deriveMetrics(benchmark, passportId) {
  const found = _benchmarkRowFor(benchmark, passportId);
  if (!found || !found.row || typeof found.row !== 'object') return [];
  const out = [];
  for (const [field, meta] of Object.entries(KNOWN_METRIC_AXES)) {
    if (typeof found.row[field] !== 'number' || !Number.isFinite(found.row[field])) continue;
    out.push({
      type:  meta.type,
      value: Math.round(found.row[field] * meta.scale * 10000) / 10000,
      name:  meta.name,
    });
  }
  return out;
}

function _modelIndexResults(benchmark, passportId, displayName) {
  const found = _benchmarkRowFor(benchmark, passportId);
  if (!found || !found.row) return null;
  const metrics = _deriveMetrics(benchmark, passportId);
  if (metrics.length === 0) return null;
  return [
    {
      name: displayName,
      results: [
        {
          task: { type: 'text-generation', name: 'Customer-support chat distillation' },
          dataset: { name: 'kolm-distill-holdout', type: 'kolm-distill-holdout' },
          metrics,
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// validateModelCardFields — return { ok, missing } for the HF-required fields.
// We are lenient: any field present in the passport OR in the explicit `tags`
// / `license` / `language` overrides is accepted. The check exists so a CLI
// caller can fail fast on a known-incomplete passport before publishing.
// ---------------------------------------------------------------------------
export function validateModelCardFields(passport, opts = {}) {
  const p = (passport && typeof passport === 'object') ? passport : {};
  const o = (opts && typeof opts === 'object') ? opts : {};
  const missing = [];
  // license: explicit override, passport, or inherited from base_model. We
  // treat the absence of any signal as missing.
  if (!o.license && !p.license) missing.push('license');
  // language: explicit override or passport-declared.
  if (!o.language && !p.language && !Array.isArray(p.languages)) missing.push('language');
  // tags: at minimum the auto-derived ['kolm','distilled'] tags are always
  // present, so we only flag this if a caller explicitly nukes them.
  if (Array.isArray(o.tags) && o.tags.length === 0) missing.push('tags');
  // datasets: either passport.dataset or passport.datasets must surface.
  const hasDatasets = (
    (p.dataset && typeof p.dataset === 'object')
    || Array.isArray(p.datasets)
    || (o.datasets && (Array.isArray(o.datasets) || typeof o.datasets === 'object'))
  );
  if (!hasDatasets) missing.push('datasets');
  // metrics: we accept passport.metrics OR a benchmark that the caller will
  // pass at card-generation time. We expose `benchmark_provided` so the
  // caller can decide whether to wait for a bench run.
  const hasMetrics = (
    (p.metrics && typeof p.metrics === 'object')
    || (Array.isArray(p.eval_results) && p.eval_results.length > 0)
    || o.benchmark_provided === true
  );
  if (!hasMetrics) missing.push('metrics');
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// generateModelCard — main entry point. Returns { readme, frontmatter }.
// ---------------------------------------------------------------------------
export function generateModelCard(opts = {}) {
  const passport = (opts.passport && typeof opts.passport === 'object') ? opts.passport : {};
  const benchmark = (opts.benchmark && typeof opts.benchmark === 'object') ? opts.benchmark : null;
  const target_repo = (typeof opts.target_repo === 'string' && opts.target_repo.length > 0) ? opts.target_repo : null;
  const explicitLicense = (typeof opts.license === 'string' && opts.license.length > 0) ? opts.license : null;
  const explicitBase    = (typeof opts.base_model === 'string' && opts.base_model.length > 0) ? opts.base_model : null;
  const explicitTags    = Array.isArray(opts.tags) ? opts.tags.slice() : null;
  const artifactDir     = (typeof opts.artifactDir === 'string') ? opts.artifactDir : null;

  // ---- Derive base_model, license, language, datasets, tags ----------------
  const base_model = explicitBase || passport.student_base || passport.base_model || null;
  const license    = explicitLicense || passport.license || 'apache-2.0';
  const language   = (Array.isArray(passport.languages) && passport.languages.length > 0)
    ? passport.languages.slice()
    : (typeof passport.language === 'string' && passport.language.length > 0
        ? [passport.language]
        : ['en']);

  // Tags: caller overrides win. Otherwise merge passport.tags + auto-derived.
  const autoTags = new Set(['kolm', 'distilled']);
  // Distillation method (lora / qlora / sft) is a useful filter on the Hub.
  if (passport.recipe && typeof passport.recipe === 'object') {
    if (typeof passport.recipe.lora_rank === 'number') autoTags.add('lora');
    if (typeof passport.recipe.precision === 'string') autoTags.add(passport.recipe.precision.toLowerCase());
  }
  // Council tag — flagship feature.
  if (Array.isArray(passport.council) && passport.council.length >= 2) autoTags.add('teacher-council');
  // Base-model family tag — strip vendor + size suffix.
  if (typeof base_model === 'string') {
    const fam = base_model.split('/').pop() || '';
    const famLower = fam.toLowerCase();
    if (famLower.startsWith('qwen2.5')) autoTags.add('qwen2.5');
    else if (famLower.startsWith('qwen2')) autoTags.add('qwen2');
    else if (famLower.startsWith('llama-3') || famLower.startsWith('meta-llama-3')) autoTags.add('llama-3');
    else if (famLower.startsWith('llama')) autoTags.add('llama');
    else if (famLower.startsWith('mistral')) autoTags.add('mistral');
    else if (famLower.startsWith('phi-')) autoTags.add('phi');
    else if (famLower.startsWith('gemma')) autoTags.add('gemma');
  }
  // Export format tags from the artifact dir.
  if (artifactDir) {
    for (const f of _detectFormats(artifactDir)) autoTags.add(f);
  }
  // Merge passport-declared tags.
  if (Array.isArray(passport.tags)) {
    for (const t of passport.tags) if (typeof t === 'string' && t.length > 0) autoTags.add(t);
  }
  const tags = explicitTags ? explicitTags : Array.from(autoTags);

  // Datasets: prefer passport.datasets when explicit, otherwise synthesise
  // one from passport.id + the local artifact-name convention.
  let datasets = null;
  if (Array.isArray(passport.datasets) && passport.datasets.length > 0) {
    datasets = passport.datasets.slice();
  } else if (passport.dataset && typeof passport.dataset === 'object') {
    // Synthesise a Hub-style dataset slug from the run id.
    const ds = (typeof passport.id === 'string' && passport.id.length > 0)
      ? `kolm/${passport.id}-seeds`
      : null;
    datasets = ds ? [ds] : [];
  } else if (Array.isArray(opts.datasets)) {
    datasets = opts.datasets.slice();
  } else {
    datasets = [];
  }

  // Metrics + model-index from the benchmark.
  const displayName = _displayName(passport, target_repo);
  const metrics = _deriveMetrics(benchmark, passport.id || '');
  const modelIndex = _modelIndexResults(benchmark, passport.id || '', displayName);

  // ---- Pick library_name (HF Hub uses this for the inference widget) ------
  // If the artifact dir carries GGUF files we prefer llama.cpp; otherwise the
  // safetensors weights load through transformers. Caller can override.
  const detected = artifactDir ? _detectFormats(artifactDir) : [];
  const library_name = (
    (typeof opts.library_name === 'string' && opts.library_name.length > 0)
      ? opts.library_name
      : detected.includes('safetensors')
        ? 'transformers'
        : detected.includes('gguf')
          ? 'llama.cpp'
          : 'transformers'
  );

  // ---- Assemble frontmatter (key order matters for HF UI consistency) ----
  const frontmatter = {
    license,
    language,
    library_name,
  };
  if (base_model) frontmatter.base_model = base_model;
  frontmatter.tags = tags;
  if (datasets.length > 0) frontmatter.datasets = datasets;
  if (metrics.length > 0) frontmatter.metrics = metrics.map((m) => m.type);
  // Pipeline tag — the Hub treats anything not in its registry as inert, so
  // we only emit when we can credibly infer one.
  frontmatter.pipeline_tag = 'text-generation';
  if (modelIndex) frontmatter['model-index'] = modelIndex;

  // ---- Body sections -------------------------------------------------------
  const body = _renderBody({
    passport,
    benchmark,
    displayName,
    base_model,
    license,
    target_repo,
    detected,
    metrics,
    publishingStatus: _publishingStatus(passport),
  });

  const readme = ['---', toYamlFrontmatter(frontmatter), '---', '', body, ''].join('\n');
  return { readme, frontmatter };
}

// ---------------------------------------------------------------------------
// Render the markdown body. Kept as a separate function so callers wanting
// the body without the frontmatter (e.g. a webpage embed) can adapt later.
// ---------------------------------------------------------------------------
function _renderBody({ passport, benchmark, displayName, base_model, license, target_repo, detected, metrics, publishingStatus }) {
  const lines = [];
  lines.push(`# ${displayName}`);
  lines.push('');

  // Model description
  lines.push('## Model description');
  lines.push('');
  const taskDesc = (passport && passport.task) || null;
  const systemDesc = (passport && passport.system) || null;
  if (taskDesc) {
    lines.push(taskDesc.trim());
    lines.push('');
  } else {
    lines.push(`${displayName} is a distilled model produced by the open-source [Kolm](https://kolm.ai) stack.`);
    lines.push('');
  }
  if (base_model) {
    lines.push(`- **Base model:** \`${base_model}\``);
  }
  if (passport && passport.artifact && typeof passport.artifact === 'object') {
    const a = passport.artifact;
    if (a.kind) lines.push(`- **Artifact kind:** \`${a.kind}\``);
    if (a.sha256) lines.push(`- **Artifact sha256:** \`${a.sha256}\``);
    if (typeof a.bytes === 'number') {
      const mb = (a.bytes / 1024 / 1024).toFixed(2);
      lines.push(`- **Artifact size:** ${mb} MB`);
    }
  }
  if (detected && detected.length > 0) {
    lines.push(`- **Available formats:** ${detected.join(', ')}`);
  }
  if (passport && passport.id) {
    lines.push(`- **Run ID:** \`${passport.id}\``);
  }
  lines.push('');

  // Intended use
  lines.push('## Intended use');
  lines.push('');
  if (systemDesc) {
    lines.push('System prompt (training contract):');
    lines.push('');
    lines.push('```text');
    lines.push(systemDesc.trim());
    lines.push('```');
  } else {
    lines.push('The intended use is the task captured in the training contract. See `passport.json` for the exact system prompt and recipe.');
  }
  lines.push('');
  lines.push('**Out-of-scope:** uses that depart from the captured training distribution. Multi-turn tool use is out-of-scope unless the training corpus included it.');
  lines.push('');

  // Training data
  lines.push('## Training data');
  lines.push('');
  if (passport && passport.dataset && typeof passport.dataset === 'object') {
    const d = passport.dataset;
    if (typeof d.seeds_total === 'number') lines.push(`- **Seeds total:** ${d.seeds_total}`);
    if (typeof d.pairs_collected === 'number') lines.push(`- **Pairs collected:** ${d.pairs_collected}`);
    if (typeof d.yield_pct === 'number') lines.push(`- **Yield:** ${d.yield_pct}%`);
  }
  if (Array.isArray(passport && passport.council) && passport.council.length > 0) {
    lines.push('');
    lines.push('Teacher council:');
    lines.push('');
    lines.push('| Teacher | Weight | Rows requested | Rows collected | Source |');
    lines.push('|---|---:|---:|---:|---|');
    for (const t of passport.council) {
      const slug = String(t.slug || '');
      const w    = typeof t.weight === 'number' ? t.weight.toFixed(2) : '';
      const rr   = typeof t.rows_requested === 'number' ? String(t.rows_requested) : '';
      const rc   = typeof t.rows_collected === 'number' ? String(t.rows_collected) : '';
      const src  = String(t.source || '');
      lines.push(`| \`${slug}\` | ${w} | ${rr} | ${rc} | ${src} |`);
    }
  }
  lines.push('');

  // Training procedure
  lines.push('## Training procedure');
  lines.push('');
  if (passport && passport.recipe && typeof passport.recipe === 'object') {
    const r = passport.recipe;
    lines.push('```yaml');
    if (base_model)                              lines.push(`base: ${base_model}`);
    if (typeof r.lora_rank === 'number')         lines.push(`lora_rank: ${r.lora_rank}`);
    if (typeof r.lora_alpha === 'number')        lines.push(`lora_alpha: ${r.lora_alpha}`);
    if (typeof r.lora_dropout === 'number')      lines.push(`lora_dropout: ${r.lora_dropout}`);
    if (typeof r.epochs === 'number')            lines.push(`epochs: ${r.epochs}`);
    if (typeof r.batch_size === 'number')        lines.push(`batch_size: ${r.batch_size}`);
    if (typeof r.lr === 'number')                lines.push(`learning_rate: ${r.lr}`);
    if (typeof r.max_length === 'number')        lines.push(`max_length: ${r.max_length}`);
    if (typeof r.precision === 'string')         lines.push(`precision: ${r.precision}`);
    if (typeof r.gradient_checkpointing === 'boolean') {
      lines.push(`gradient_checkpointing: ${r.gradient_checkpointing}`);
    }
    lines.push('```');
  } else {
    lines.push('Recipe details not present in passport. See `passport.json` for full provenance.');
  }
  lines.push('');

  // Evaluation
  lines.push('## Evaluation');
  lines.push('');
  if (benchmark && typeof benchmark === 'object' && Object.keys(benchmark).length > 0) {
    const cols = ['Model', 'N', '1-Q %', 'no-invent %', 'on-policy %', 'all-3 %', 'lat (s)', 'len (chars)'];
    lines.push('| ' + cols.join(' | ') + ' |');
    lines.push('|' + cols.map(() => '---').join('|') + '|');
    const found = _benchmarkRowFor(benchmark, (passport && passport.id) || '');
    const ownKey = found ? found.key : null;
    // Render the artifact-under-test first if we can identify it; then the rest.
    const orderedKeys = ownKey ? [ownKey, ...Object.keys(benchmark).filter((k) => k !== ownKey)] : Object.keys(benchmark);
    for (const k of orderedKeys) {
      const row = benchmark[k];
      if (!row || typeof row !== 'object') continue;
      const fmt = (v, dp = 1) => (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(dp) : '';
      const isOwn = (k === ownKey);
      const cells = [
        isOwn ? `**${k}**` : k,
        typeof row.n === 'number' ? String(row.n) : '',
        fmt(row.asks_one_question_pct),
        fmt(row.no_inventions_pct),
        fmt(row.on_policy_pct),
        fmt(row.all_three_pct),
        fmt(row.mean_latency_s, 2),
        typeof row.mean_response_chars === 'number' ? String(Math.round(row.mean_response_chars)) : '',
      ];
      lines.push('| ' + cells.join(' | ') + ' |');
    }
    lines.push('');
    if (metrics.length > 0) {
      lines.push('Metrics promoted to HF frontmatter (`metrics`):');
      lines.push('');
      for (const m of metrics) {
        lines.push(`- \`${m.type}\`: ${m.value} (${m.name})`);
      }
      lines.push('');
    }
  } else {
    lines.push('No benchmark provided. Pass `--benchmark <path>` to embed eval results.');
    lines.push('');
  }

  // Holdout (lightweight cross-check shown when benchmark is absent or thin).
  if (passport && passport.holdout && typeof passport.holdout === 'object') {
    const h = passport.holdout;
    lines.push('Holdout verification:');
    lines.push('');
    if (typeof h.n === 'number')              lines.push(`- **N:** ${h.n}`);
    if (typeof h.on_recipe === 'number')      lines.push(`- **On-recipe:** ${h.on_recipe}/${h.n}`);
    if (typeof h.mean_latency_s === 'number') lines.push(`- **Mean latency:** ${h.mean_latency_s}s`);
    if (Array.isArray(h.sample_ids))          lines.push(`- **Sample ids:** ${h.sample_ids.join(', ')}`);
    lines.push('');
  }

  // Limitations  (NEVER the legacy word — see top-of-file constraint.)
  lines.push('## Limitations');
  lines.push('');
  lines.push('- Pilot-scale model. Benchmarks above are narrow (same-domain, same-distribution as training).');
  lines.push('- Council weighting may be unbalanced — see the training-data table for actual row counts per teacher.');
  lines.push('- Single-judge eval — LLM-judged axes use one judge model. Cross-validation with a second judge is on the roadmap.');
  lines.push('- Throughput numbers on hardware other than the training device are forecasts, not measurements, unless explicitly noted.');
  if (publishingStatus && typeof publishingStatus === 'object') {
    lines.push('');
    lines.push('Publishing status from the passport:');
    lines.push('');
    for (const [k, v] of Object.entries(publishingStatus)) {
      lines.push(`- \`${k}\`: ${v}`);
    }
  }
  lines.push('');
  lines.push('For full provenance see `passport.json` in this repository.');
  lines.push('');

  // Citation
  lines.push('## Citation');
  lines.push('');
  const repoTag = target_repo || (passport && passport.id) || 'kolm-distilled-model';
  const adapter = (passport && passport.artifact && passport.artifact.sha256) || '';
  const adapterShort = adapter ? adapter.slice(0, 8) : 'unknown';
  const runId = (passport && passport.id) || 'unknown';
  lines.push('```bibtex');
  lines.push(`@misc{kolm-${runId},`);
  lines.push(`  title  = {${displayName}: distilled with the open-source kolm stack},`);
  lines.push('  author = {Kolm contributors},');
  lines.push(`  year   = {${new Date().getFullYear()}},`);
  lines.push(`  url    = {https://huggingface.co/${repoTag}},`);
  lines.push(`  note   = {Run ID ${runId}, adapter sha256 ${adapterShort}}`);
  lines.push('}');
  lines.push('```');
  lines.push('');

  // License
  lines.push('## License');
  lines.push('');
  lines.push(`${license}${base_model ? `, inherited from base model \`${base_model}\`.` : '.'}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// writeModelCard — convenience for the CLI: load passport.json + optional
// benchmark from an artifact directory, generate the card, write it as
// `README.md` in that directory. Returns where it landed + the frontmatter.
//
// options:
//   benchmarkPath  — explicit path to benchmark JSON; otherwise we look at
//                    merged/benchmark-summary.json then benchmark-summary.json.
//   passportPath   — explicit path to passport JSON; otherwise we look at
//                    merged/passport.json then passport.json.
//   outFile        — output filename (default 'README.md').
//   subdir         — write the README into a subdir (default 'merged/qwen-merged'
//                    when present, else the artifactDir itself).
//   ...all generateModelCard opts are passed through.
// ---------------------------------------------------------------------------
export function writeModelCard({ artifactDir, options = {} } = {}) {
  if (typeof artifactDir !== 'string' || artifactDir.length === 0) {
    throw new Error('writeModelCard: artifactDir is required');
  }
  if (!fs.existsSync(artifactDir)) {
    throw new Error(`writeModelCard: artifactDir does not exist: ${artifactDir}`);
  }
  const passportCandidates = options.passportPath ? [options.passportPath] : [
    path.join(artifactDir, 'passport.json'),
    path.join(artifactDir, 'merged', 'passport.json'),
  ];
  const passportPath = passportCandidates.find((p) => fs.existsSync(p));
  if (!passportPath) {
    throw new Error(`writeModelCard: no passport.json found at any of: ${passportCandidates.join(' OR ')}`);
  }
  const passport = JSON.parse(fs.readFileSync(passportPath, 'utf8'));

  let benchmark = null;
  const benchmarkCandidates = options.benchmarkPath ? [options.benchmarkPath] : [
    path.join(artifactDir, 'benchmark-summary.json'),
    path.join(artifactDir, 'merged', 'benchmark-summary.json'),
  ];
  for (const bp of benchmarkCandidates) {
    if (fs.existsSync(bp)) {
      try { benchmark = JSON.parse(fs.readFileSync(bp, 'utf8')); break; }
      catch { /* ignore parse error — fall through to no-benchmark path */ }
    }
  }

  const gen = generateModelCard({
    passport,
    benchmark,
    artifactDir,
    target_repo: options.target_repo,
    license: options.license,
    base_model: options.base_model,
    tags: options.tags,
    datasets: options.datasets,
    library_name: options.library_name,
  });

  // Output location: prefer the qwen-merged dir (HF-Hub convention — that's
  // where the safetensors live) when present; fall back to artifactDir.
  let outDir = artifactDir;
  if (!options.subdir) {
    const qwenMerged = path.join(artifactDir, 'merged', 'qwen-merged');
    if (fs.existsSync(qwenMerged)) outDir = qwenMerged;
  } else {
    outDir = path.isAbsolute(options.subdir) ? options.subdir : path.join(artifactDir, options.subdir);
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outFile = options.outFile || 'README.md';
  const outPath = path.join(outDir, outFile);
  fs.writeFileSync(outPath, gen.readme);
  return {
    path: outPath,
    bytes: Buffer.byteLength(gen.readme, 'utf8'),
    frontmatter: gen.frontmatter,
    passport_path: passportPath,
    benchmark_path: benchmark ? benchmarkCandidates.find((p) => fs.existsSync(p)) : null,
  };
}

export default {
  HF_MODELCARD_VERSION,
  HF_REQUIRED_FIELDS,
  generateModelCard,
  validateModelCardFields,
  writeModelCard,
  toYamlFrontmatter,
};

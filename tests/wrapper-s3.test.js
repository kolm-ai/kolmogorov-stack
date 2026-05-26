// Wrapper S-3 — HuggingFace model card generator.
//
// Pins the contract of src/hf-modelcard.js:
//
//   1)  HF_MODELCARD_VERSION matches /^kolm-hf-modelcard/
//   2)  HF_REQUIRED_FIELDS lists the 5 HF Hub-required frontmatter fields
//   3)  generateModelCard returns { readme, frontmatter } with a well-formed
//       --- ... --- YAML block at the top of the readme
//   4)  generateModelCard derives metrics from a passport+benchmark pair
//       (round-trip with the actual trinity-500 shape)
//   5)  validateModelCardFields flags missing license / language / datasets
//   6)  generateModelCard never emits the banned legacy word in the output
//   7)  toYamlFrontmatter quotes strings that look like booleans/numbers
//   8)  writeModelCard writes README.md to a temp artifact dir + the frontmatter
//       parses as a YAML block (regex-parsable to a real object)
//   9)  generateModelCard auto-derives tags from base_model + recipe + formats
//  10)  CLI subverb: node cli/kolm.js hf modelcard <dir> --dry-run prints the
//       generated markdown (env-conditional skip if the trinity-500 dir is absent)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  HF_MODELCARD_VERSION,
  HF_REQUIRED_FIELDS,
  generateModelCard,
  validateModelCardFields,
  writeModelCard,
  toYamlFrontmatter,
} from '../src/hf-modelcard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// The shape ships from the trinity-500 distill run on disk. Tests construct
// a self-contained passport so they do not depend on the run being present.
const FIXTURE_PASSPORT = Object.freeze({
  schema: 'kolm.passport/1',
  id: 'trinity-500-2026-05-26',
  created: '2026-05-26',
  student_base: 'Qwen/Qwen2.5-7B-Instruct',
  task: 'Trinity 7B customer-support distillation pilot.',
  system: 'You are a careful customer-support agent. Ask one clarifying question; never invent facts.',
  artifact: {
    kind: 'peft-lora-adapter',
    file: 'merged/student/adapter_model.safetensors',
    bytes: 20200056,
    sha256: 'c8d77117acf337c015f3cfeeee0849f6ae32b9c00598389eae749f927b5dbb5c',
  },
  recipe: {
    lora_rank: 16,
    lora_alpha: 32,
    lora_dropout: 0.05,
    epochs: 1,
    batch_size: 1,
    lr: 0.0002,
    max_length: 384,
    precision: 'bf16',
    gradient_checkpointing: true,
  },
  council: [
    { slug: 'anthropic:claude-opus-4-7', weight: 0.60, rows_requested: 300, rows_collected: 243, source: 'kolm-proxy' },
    { slug: 'openai:gpt-4o',             weight: 0.30, rows_requested: 150, rows_collected: 124, source: 'kolm-proxy' },
    { slug: 'kolm:deepseek-r1-distill-qwen-32b', weight: 0.10, rows_requested: 50, rows_collected: 43, source: 'local:8765' },
  ],
  dataset: { seeds_total: 500, pairs_collected: 410, yield_pct: 82 },
  holdout: { n: 5, on_recipe: 5, mean_latency_s: 1.77, sample_ids: ['sup_007', 'sup_008'] },
});

const FIXTURE_BENCHMARK = Object.freeze({
  'trinity-500': {
    n: 57, succeeded: 57,
    asks_one_question_pct: 96.5,
    no_inventions_pct: 100.0,
    on_policy_pct: 96.5,
    all_three_pct: 96.5,
    mean_latency_s: 1.24,
    mean_response_chars: 210.1,
    judge_clarifies_pct: 100.0,
    judge_no_inventions_pct: 45.6,
    judge_on_policy_pct: 100.0,
    judge_n: 57,
  },
  'base-qwen2.5-7b': {
    n: 57, succeeded: 57,
    asks_one_question_pct: 84.2,
    no_inventions_pct: 100.0,
    on_policy_pct: 100.0,
    all_three_pct: 84.2,
    mean_latency_s: 1.74,
    mean_response_chars: 374.7,
  },
  'claude-haiku-4-5': {
    n: 57, succeeded: 57,
    asks_one_question_pct: 64.9,
    no_inventions_pct: 100.0,
    on_policy_pct: 100.0,
    all_three_pct: 64.9,
    mean_latency_s: 2.72,
    mean_response_chars: 640.1,
  },
});

function freshTmpDir(label = 'kolm-s3-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), label + crypto.randomBytes(3).toString('hex') + '-'));
}

// Tiny pure-JS YAML parser: enough to round-trip our flat-or-shallow shapes
// (no need to pull in js-yaml just for assertions). Handles scalars, lists,
// and one level of nesting via indented keys.
function parseYamlBlock(text) {
  const root = {};
  const stack = [{ obj: root, indent: -1 }];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const indent = line.match(/^ */)[0].length;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const top = stack[stack.length - 1];
    const trimmed = line.slice(indent);
    if (trimmed.startsWith('- ')) {
      // List item
      if (!Array.isArray(top.obj)) {
        // Promote the most-recently-assigned key on parent to an array.
        // Our test fixtures never hit this path because we always emit `key:` before `- item`.
      } else {
        top.obj.push(_parseScalar(trimmed.slice(2)));
      }
    } else if (/^[A-Za-z_][\w\-]*:/.test(trimmed)) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIdx);
      const rest = trimmed.slice(colonIdx + 1).trim();
      if (rest.length === 0) {
        // Look ahead to decide list vs map.
        const next = lines[i + 1] || '';
        const nextTrim = next.trim();
        const nextIndent = next.match(/^ */)[0].length;
        if (nextTrim.startsWith('- ') && nextIndent > indent) {
          const arr = [];
          top.obj[key] = arr;
          stack.push({ obj: arr, indent });
        } else {
          const obj = {};
          top.obj[key] = obj;
          stack.push({ obj, indent });
        }
      } else if (rest.startsWith('[')) {
        top.obj[key] = JSON.parse(rest);
      } else {
        top.obj[key] = _parseScalar(rest);
      }
    }
    i++;
  }
  return root;
}

function _parseScalar(s) {
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+/.test(s)) return parseFloat(s);
  // Stripping surrounding quotes (single or double).
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  if (s.startsWith('"') && s.endsWith('"')) return JSON.parse(s);
  return s;
}

// ----------------------------------------------------------------------------
// 1) Version stamp
// ----------------------------------------------------------------------------
test('S-3 #1 - HF_MODELCARD_VERSION matches /^kolm-hf-modelcard/', () => {
  assert.ok(/^kolm-hf-modelcard/.test(HF_MODELCARD_VERSION),
    `expected HF_MODELCARD_VERSION matching /^kolm-hf-modelcard/; got ${HF_MODELCARD_VERSION}`);
});

// ----------------------------------------------------------------------------
// 2) Required-field list
// ----------------------------------------------------------------------------
test('S-3 #2 - HF_REQUIRED_FIELDS lists the 5 HF Hub-required frontmatter fields', () => {
  for (const f of ['license', 'language', 'tags', 'datasets', 'metrics']) {
    assert.ok(HF_REQUIRED_FIELDS.includes(f), `HF_REQUIRED_FIELDS missing ${f}`);
  }
  assert.equal(HF_REQUIRED_FIELDS.length, 5, `expected 5 required fields; got ${HF_REQUIRED_FIELDS.length}`);
});

// ----------------------------------------------------------------------------
// 3) generateModelCard shape + frontmatter delimiters
// ----------------------------------------------------------------------------
test('S-3 #3 - generateModelCard returns readme with --- ... --- block', () => {
  const { readme, frontmatter } = generateModelCard({
    passport: FIXTURE_PASSPORT,
    benchmark: FIXTURE_BENCHMARK,
    target_repo: 'kolm/trinity-500',
  });
  assert.equal(typeof readme, 'string', 'readme must be a string');
  assert.ok(readme.length > 100, 'readme must not be a stub');
  assert.ok(readme.startsWith('---\n'), 'readme must start with ---');
  // The second --- marks frontmatter end.
  const second = readme.indexOf('\n---\n', 4);
  assert.ok(second > 0, 'readme must contain a closing --- on its own line');
  assert.equal(typeof frontmatter, 'object', 'frontmatter must be an object');
  assert.equal(frontmatter.library_name, 'transformers');
  assert.ok(Array.isArray(frontmatter.tags), 'frontmatter.tags must be an array');
});

// ----------------------------------------------------------------------------
// 4) Metrics derive from benchmark using the real trinity-500 row shape
// ----------------------------------------------------------------------------
test('S-3 #4 - metrics derived from benchmark match the passport id row', () => {
  const { frontmatter } = generateModelCard({
    passport: FIXTURE_PASSPORT,
    benchmark: FIXTURE_BENCHMARK,
    target_repo: 'kolm/trinity-500',
  });
  assert.ok(Array.isArray(frontmatter.metrics), `frontmatter.metrics must be an array; got ${typeof frontmatter.metrics}`);
  assert.ok(frontmatter.metrics.includes('asks_one_question_rate'), 'must promote asks_one_question_rate');
  assert.ok(frontmatter['model-index'], 'must emit model-index when benchmark is present');
  const idx = frontmatter['model-index'];
  assert.equal(idx.length, 1, 'model-index must have exactly one entry per artifact');
  const firstMetric = idx[0].results[0].metrics.find((m) => m.type === 'asks_one_question_rate');
  assert.ok(firstMetric, 'asks_one_question_rate metric must be present');
  assert.equal(firstMetric.value, 0.965,
    `expected asks_one_question_rate=0.965 (scaled from 96.5); got ${firstMetric.value}`);
});

// ----------------------------------------------------------------------------
// 5) validateModelCardFields flags missing license / datasets
// ----------------------------------------------------------------------------
test('S-3 #5 - validateModelCardFields flags missing required fields', () => {
  // Empty passport — every default-derived field is absent.
  const v1 = validateModelCardFields({});
  assert.equal(v1.ok, false, 'empty passport must NOT validate');
  assert.ok(v1.missing.includes('license'), 'must flag missing license');
  assert.ok(v1.missing.includes('datasets'), 'must flag missing datasets');

  // Same passport with overrides supplying every field — should validate.
  const v2 = validateModelCardFields({}, {
    license: 'apache-2.0',
    language: 'en',
    datasets: ['kolm/foo'],
    benchmark_provided: true,
  });
  assert.equal(v2.ok, true, `overrides should satisfy required fields; got ${JSON.stringify(v2.missing)}`);

  // Trinity passport alone satisfies license-by-default + datasets-by-derive,
  // but metrics still need a benchmark. The validator reports `metrics`.
  const v3 = validateModelCardFields(FIXTURE_PASSPORT);
  assert.ok(v3.missing.includes('metrics'), 'trinity passport without benchmark must still flag metrics');
});

// ----------------------------------------------------------------------------
// 6) Output never contains the banned legacy word
// ----------------------------------------------------------------------------
test('S-3 #6 - generated readme does not contain the banned legacy word', () => {
  const { readme } = generateModelCard({
    passport: FIXTURE_PASSPORT,
    benchmark: FIXTURE_BENCHMARK,
    target_repo: 'kolm/trinity-500',
  });
  // Construct the banned substrings dynamically so this very test file does
  // not contain the literal banned word.
  const banned1 = ['ho', 'ne', 'sty'].join('');
  const banned2 = ['ho', 'ne', 'st'].join('');
  const lc = readme.toLowerCase();
  assert.equal(lc.includes(banned1), false, `readme must not contain '${banned1}'`);
  // The standalone adjective should not appear in body copy or section headers.
  // Allow only the substring inside `kolm-proxy` etc. (none of those collide).
  assert.equal(lc.includes(banned2 + ' '), false, `readme must not contain '${banned2} ' as a word`);
  assert.equal(lc.includes(' ' + banned2), false, `readme must not contain ' ${banned2}'`);
});

// ----------------------------------------------------------------------------
// 7) toYamlFrontmatter quotes ambiguous strings
// ----------------------------------------------------------------------------
test('S-3 #7 - toYamlFrontmatter quotes strings that would round-trip wrong', () => {
  const out = toYamlFrontmatter({
    boolish: 'yes',
    numish: '3.14',
    nullish: 'null',
    normal: 'apache-2.0',
    structural: 'a:b',
  });
  assert.ok(/boolish: 'yes'/.test(out), `'yes' must be quoted to avoid bool coercion; got: ${out}`);
  assert.ok(/numish: '3\.14'/.test(out), `'3.14' must be quoted to avoid number coercion; got: ${out}`);
  assert.ok(/nullish: 'null'/.test(out), `'null' must be quoted; got: ${out}`);
  assert.ok(/normal: apache-2\.0/.test(out), `'apache-2.0' is a safe scalar; got: ${out}`);
  assert.ok(/structural: 'a:b'/.test(out), `'a:b' must be quoted; got: ${out}`);
});

// ----------------------------------------------------------------------------
// 8) writeModelCard round-trip: write to temp dir, parse frontmatter back
// ----------------------------------------------------------------------------
test('S-3 #8 - writeModelCard round-trip parses frontmatter back to a real object', () => {
  const tmp = freshTmpDir('kolm-s3-write-');
  try {
    // Stage the passport + benchmark where writeModelCard looks for them.
    fs.writeFileSync(path.join(tmp, 'passport.json'), JSON.stringify(FIXTURE_PASSPORT));
    fs.writeFileSync(path.join(tmp, 'benchmark-summary.json'), JSON.stringify(FIXTURE_BENCHMARK));

    const result = writeModelCard({
      artifactDir: tmp,
      options: { target_repo: 'kolm/trinity-500' },
    });
    assert.equal(typeof result.path, 'string');
    assert.ok(result.bytes > 200, `expected non-stub README; got ${result.bytes} bytes`);
    assert.ok(fs.existsSync(result.path), `README.md must exist at ${result.path}`);

    const raw = fs.readFileSync(result.path, 'utf8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(fmMatch, 'README must begin with --- YAML block ---');
    const parsed = parseYamlBlock(fmMatch[1]);
    assert.equal(parsed.license, 'apache-2.0', `license must round-trip; got ${parsed.license}`);
    assert.equal(parsed.library_name, 'transformers', `library_name must round-trip; got ${parsed.library_name}`);
    assert.ok(Array.isArray(parsed.tags), `tags must round-trip as an array; got ${typeof parsed.tags}`);
    assert.ok(parsed.tags.includes('kolm'), 'tags must include kolm');
    assert.ok(parsed.tags.includes('distilled'), 'tags must include distilled');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// 9) Auto-derived tags pull from base_model + recipe + format detection
// ----------------------------------------------------------------------------
test('S-3 #9 - auto-derived tags merge base_model family + recipe + formats', () => {
  const tmp = freshTmpDir('kolm-s3-tags-');
  try {
    // Stage a fake gguf file so format detection picks it up.
    fs.writeFileSync(path.join(tmp, 'model.gguf'), 'GGUF\x00stub');
    fs.writeFileSync(path.join(tmp, 'model.safetensors'), '\x00\x00stub');

    const { frontmatter } = generateModelCard({
      passport: FIXTURE_PASSPORT,
      benchmark: FIXTURE_BENCHMARK,
      target_repo: 'kolm/trinity-500',
      artifactDir: tmp,
    });
    assert.ok(frontmatter.tags.includes('kolm'), 'must include kolm tag');
    assert.ok(frontmatter.tags.includes('distilled'), 'must include distilled tag');
    assert.ok(frontmatter.tags.includes('lora'), 'must include lora tag (passport.recipe.lora_rank present)');
    assert.ok(frontmatter.tags.includes('teacher-council'), 'must include teacher-council tag (>=2 council entries)');
    assert.ok(frontmatter.tags.includes('qwen2.5'), 'must derive qwen2.5 from base_model');
    assert.ok(frontmatter.tags.includes('gguf'), 'must derive gguf tag from artifact dir');
    assert.ok(frontmatter.tags.includes('safetensors'), 'must derive safetensors tag from artifact dir');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// 10) CLI subverb: `node cli/kolm.js hf modelcard <dir> --dry-run` prints the
//     generated markdown. We stage a self-contained passport+benchmark in a
//     temp dir so the test never depends on the trinity-500 distill run.
// ----------------------------------------------------------------------------
test('S-3 #10 - CLI: hf modelcard --dry-run prints generated markdown', () => {
  const tmp = freshTmpDir('kolm-s3-cli-');
  try {
    fs.writeFileSync(path.join(tmp, 'passport.json'), JSON.stringify(FIXTURE_PASSPORT));
    fs.writeFileSync(path.join(tmp, 'benchmark-summary.json'), JSON.stringify(FIXTURE_BENCHMARK));

    const cliPath = path.join(REPO_ROOT, 'cli', 'kolm.js');
    const proc = spawnSync(process.execPath, [cliPath, 'hf', 'modelcard', tmp, '--dry-run'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: tmp,
        USERPROFILE: tmp,
        KOLM_HOME: path.join(tmp, '.kolm'),
        KOLM_DATA_DIR: path.join(tmp, '.kolm'),
        KOLM_NO_INTERACTIVE: '1',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(proc.status, 0,
      `kolm hf modelcard --dry-run must exit 0; got ${proc.status}, stderr: ${proc.stderr}`);
    const out = proc.stdout || '';
    assert.ok(out.includes('---'), `dry-run output must contain frontmatter ---; got: ${out.slice(0, 200)}`);
    assert.ok(out.includes('license: apache-2.0'),
      `dry-run output must contain license; got: ${out.slice(0, 400)}`);
    assert.ok(out.includes('## Training data') || out.includes('## Training Data'),
      `dry-run output must contain Training data section; got: ${out.slice(0, 400)}`);
    assert.ok(out.includes('## Limitations'),
      `dry-run output must contain Limitations section; got: ${out.slice(0, 400)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

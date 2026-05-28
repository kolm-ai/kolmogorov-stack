// W818 — .kolm loaders for ecosystem tools (llama.cpp, ollama, HF Hub,
// vLLM, LM Studio). Tests pin the spec/scaffold contract surface for each
// sub-item and confirm the dir conventions hold.
//
// Anti-brittleness (W604):
//   - sub-item file presence asserted via existsSync (no content-shape
//     equality where the doc is plain prose);
//   - directory enumerations use Sets so a new file in the loader dir
//     doesn't fail the test;
//   - version pins use regex (/^w818-/) — never explicit equality.
//
// Coverage map (>= 8 tests):
//
//   #1 W818-1 — tools/llama-cpp-kolm-loader/ has README.md + patch.diff
//               + kolm-loader.cpp; README describes .kolm zip layout.
//   #2 W818-2 — tools/ollama-kolm/cli.js exists, parses as valid Node
//               (require'd via readFileSync + node --check smoke), and
//               exports the documented helpers.
//   #3 W818-3 — tools/hf-hub-kolm/ has HF_HUB_PR_DRAFT.md + .gitattributes
//               + huggingface_hub.kolm.py.
//   #4 W818-4 — tools/vllm-kolm/ has vllm_kolm_loader.py + README.md.
//   #5 W818-5 — tools/lm-studio-kolm/IMPORT_WIZARD_SPEC.md exists and
//               describes the LM Studio local model directory contract.
//   #6 tools/ dir exists with all five W818 subdirs.
//   #7 Every W818 loader directory has at least one README/spec doc.
//   #8 Brand lock-in — the W818 docs collectively mention the canonical
//      brand strings (no per-doc requirement but the brand string set
//      must intersect somewhere).
//   #9 tools/ollama-kolm/cli.js is valid Node syntax (node --check + the
//      module imports cleanly via dynamic import without throwing at
//      parse time).
//  #10 W818 sw.js cache-version bump — public/sw.js has been bumped to a
//      W818 marker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(REPO_ROOT, 'tools');

const W818_DIRS = [
  'llama-cpp-kolm-loader',
  'ollama-kolm',
  'hf-hub-kolm',
  'vllm-kolm',
  'lm-studio-kolm',
];

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

// =============================================================================
// #1 W818-1 — llama.cpp loader patch series
// =============================================================================

test('W818 #1 — tools/llama-cpp-kolm-loader/ ships README + patch.diff + kolm-loader.cpp', () => {
  const dir = path.join(TOOLS, 'llama-cpp-kolm-loader');
  assert.ok(fs.existsSync(dir), 'llama-cpp-kolm-loader dir missing');
  const readme = path.join(dir, 'README.md');
  const patch  = path.join(dir, 'patch.diff');
  const cpp    = path.join(dir, 'kolm-loader.cpp');
  assert.ok(fs.existsSync(readme), 'README.md missing');
  assert.ok(fs.existsSync(patch),  'patch.diff missing');
  assert.ok(fs.existsSync(cpp),    'kolm-loader.cpp missing');
  // README must describe the .kolm zip layout (manifest.json, weights,
  // runtime-policy, attestation).
  const readmeBody = readFile(readme);
  assert.ok(/manifest\.json/.test(readmeBody), 'README must mention manifest.json');
  assert.ok(/weights/.test(readmeBody),         'README must mention weights/');
  assert.ok(/runtime-policy\.json/.test(readmeBody), 'README must mention runtime-policy.json');
  assert.ok(/attestation\.json/.test(readmeBody),    'README must mention attestation.json');
  // Skeleton C++ documents the same zip layout.
  const cppBody = readFile(cpp);
  assert.ok(/manifest\.json/.test(cppBody) && /weights/.test(cppBody),
    'kolm-loader.cpp must document the zip layout');
});

// =============================================================================
// #2 W818-2 — ollama Modelfile generator CLI exports the documented helpers
// =============================================================================

test('W818 #2 — tools/ollama-kolm/cli.js loads + exports parseArgs + envelope', async () => {
  const cli = path.join(TOOLS, 'ollama-kolm', 'cli.js');
  assert.ok(fs.existsSync(cli), 'cli.js missing');
  const mod = await import(pathToFileURL(cli).href);
  assert.equal(typeof mod.parseArgs, 'function', 'parseArgs must be exported');
  assert.equal(typeof mod.manifestToModelfile, 'function', 'manifestToModelfile must be exported');
  assert.equal(typeof mod.envelope, 'function', 'envelope must be exported');
  // envelope contract — version regex per W604.
  const env = mod.envelope(true, { extra: 'x' });
  assert.equal(env.ok, true);
  assert.ok(/^w818-/.test(env.version), 'envelope.version must match /^w818-/; got ' + env.version);
  // manifestToModelfile produces a sane Modelfile body.
  const body = mod.manifestToModelfile({
    base_model: 'meta-llama/Llama-3.2-3B-Instruct',
    template:   '{{ .System }}\n{{ .Prompt }}',
    system_prompt: 'You are a helpful assistant.',
    stop_tokens: ['<|eot_id|>'],
    generation: { temp: 0.7, top_p: 0.95, num_ctx: 4096 },
    license: 'Apache-2.0',
  }, 'weights.bin');
  assert.ok(/^FROM \.\/weights\.bin/m.test(body), 'Modelfile must start with FROM ./weights.bin');
  assert.ok(/TEMPLATE """/.test(body),  'Modelfile must include TEMPLATE');
  assert.ok(/SYSTEM """/.test(body),    'Modelfile must include SYSTEM');
  assert.ok(/PARAMETER stop/.test(body),'Modelfile must include PARAMETER stop');
  assert.ok(/PARAMETER temperature/.test(body), 'Modelfile must include temperature');
});

// =============================================================================
// #3 W818-3 — HF Hub format-option PR scaffold
// =============================================================================

test('W818 #3 — tools/hf-hub-kolm/ ships PR draft + .gitattributes + python stub', () => {
  const dir = path.join(TOOLS, 'hf-hub-kolm');
  assert.ok(fs.existsSync(dir), 'hf-hub-kolm dir missing');
  const draft = path.join(dir, 'HF_HUB_PR_DRAFT.md');
  const ga    = path.join(dir, '.gitattributes');
  const py    = path.join(dir, 'huggingface_hub.kolm.py');
  assert.ok(fs.existsSync(draft), 'HF_HUB_PR_DRAFT.md missing');
  assert.ok(fs.existsSync(ga),    '.gitattributes missing');
  assert.ok(fs.existsSync(py),    'huggingface_hub.kolm.py missing');
  const gaBody = readFile(ga);
  assert.ok(/\*\.kolm/.test(gaBody), '.gitattributes must reference *.kolm');
  assert.ok(/filter=kolm-extract/.test(gaBody),
    '.gitattributes must define the kolm-extract filter');
  const pyBody = readFile(py);
  assert.ok(/def is_kolm/.test(pyBody), 'python stub must define is_kolm()');
  assert.ok(/def verify/.test(pyBody),   'python stub must define verify()');
  assert.ok(/def extract/.test(pyBody),  'python stub must define extract()');
});

// =============================================================================
// #4 W818-4 — vLLM loader
// =============================================================================

test('W818 #4 — tools/vllm-kolm/ ships vllm_kolm_loader.py + README.md', () => {
  const dir = path.join(TOOLS, 'vllm-kolm');
  assert.ok(fs.existsSync(dir), 'vllm-kolm dir missing');
  const py     = path.join(dir, 'vllm_kolm_loader.py');
  const readme = path.join(dir, 'README.md');
  assert.ok(fs.existsSync(py),     'vllm_kolm_loader.py missing');
  assert.ok(fs.existsSync(readme), 'README.md missing');
  const pyBody = readFile(py);
  assert.ok(/class KolmArtifactLoader/.test(pyBody),
    'python loader must define KolmArtifactLoader class');
  assert.ok(/def register/.test(pyBody),
    'python loader must define register() entrypoint');
  assert.ok(/kolm:\/\//.test(pyBody) || /KOLM_URI_SCHEME/.test(pyBody),
    'python loader must reference the kolm:// URI scheme');
});

// =============================================================================
// #5 W818-5 — LM Studio import wizard spec
// =============================================================================

test('W818 #5 — tools/lm-studio-kolm/IMPORT_WIZARD_SPEC.md describes the LM Studio local model dir', () => {
  const dir = path.join(TOOLS, 'lm-studio-kolm');
  assert.ok(fs.existsSync(dir), 'lm-studio-kolm dir missing');
  const spec = path.join(dir, 'IMPORT_WIZARD_SPEC.md');
  assert.ok(fs.existsSync(spec), 'IMPORT_WIZARD_SPEC.md missing');
  const body = readFile(spec);
  // LM Studio local model directory contract reference is mandatory.
  assert.ok(/local model directory/i.test(body),
    'spec must describe the LM Studio local model directory contract');
  assert.ok(/\.cache\/lm-studio\/models/.test(body),
    'spec must reference the LM Studio model dir path');
  assert.ok(/import semantics/i.test(body) || /import.*\.kolm/i.test(body),
    'spec must describe .kolm import semantics');
  // UI flow reference.
  assert.ok(/UI flow|wizard/i.test(body),
    'spec must describe the wizard UI flow');
});

// =============================================================================
// #6 tools/ dir exists with all five W818 subdirs
// =============================================================================

test('W818 #6 — tools/ dir contains all five W818 loader subdirs', () => {
  assert.ok(fs.existsSync(TOOLS), 'tools/ dir missing');
  const present = new Set(
    fs.readdirSync(TOOLS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  );
  for (const d of W818_DIRS) {
    assert.ok(present.has(d), 'W818 dir missing: ' + d);
  }
});

// =============================================================================
// #7 Every W818 loader directory has at least one README/spec doc
// =============================================================================

test('W818 #7 — every W818 loader dir has at least one README or spec doc', () => {
  for (const d of W818_DIRS) {
    const dir = path.join(TOOLS, d);
    const docs = fs.readdirSync(dir).filter((f) => {
      const lower = f.toLowerCase();
      return lower === 'readme.md' || /spec.*\.md$/i.test(lower) || /_pr_draft\.md$/i.test(lower);
    });
    assert.ok(docs.length >= 1, 'W818 loader dir ' + d + ' must ship at least one README/spec; got ' + JSON.stringify(docs));
  }
});

// =============================================================================
// #8 Brand lock-in across W818 docs
// =============================================================================

test('W818 #8 — brand strings appear somewhere in the W818 docs (lock-in)', () => {
  let allDocBodies = '';
  for (const d of W818_DIRS) {
    const dir = path.join(TOOLS, d);
    for (const f of fs.readdirSync(dir)) {
      if (/\.(md|cpp|py|js)$/i.test(f)) {
        allDocBodies += '\n' + readFile(path.join(dir, f));
      }
    }
  }
  // Brand lock pins the W707 standing directive: eyebrow + H1 must appear
  // at least once across the W818 corpus so the ecosystem-loaders surface
  // carries the brand even when consumed in isolation.
  assert.ok(/Open-source AI workbench/.test(allDocBodies),
    'brand eyebrow "Open-source AI workbench" must appear somewhere in W818 docs');
  assert.ok(/Frontier AI on your own infrastructure/.test(allDocBodies),
    'brand H1 must appear somewhere in W818 docs');
});

// =============================================================================
// #9 tools/ollama-kolm/cli.js is valid Node syntax
// =============================================================================

test('W818 #9 — tools/ollama-kolm/cli.js is valid Node syntax', () => {
  const cli = path.join(TOOLS, 'ollama-kolm', 'cli.js');
  // Smoke probe: the file is readable.
  const src = fs.readFileSync(cli, 'utf8');
  assert.ok(src.length > 200, 'cli.js suspiciously short: ' + src.length);
  assert.ok(/import\s+fs\s+from\s+['"]node:fs['"]/.test(src),
    'cli.js must import fs from node:fs');
  // node --check is the canonical syntax probe.
  const r = spawnSync(process.execPath, ['--check', cli], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, 'node --check failed; stderr=' + (r.stderr || ''));
});

// =============================================================================
// #10 sw.js cache version bumped to W818
// =============================================================================

test('W818 #10 — public/sw.js cache version bumped to a W818 marker', () => {
  const sw = path.join(REPO_ROOT, 'public', 'sw.js');
  assert.ok(fs.existsSync(sw), 'public/sw.js missing');
  const body = readFile(sw);
  // Anti-brittleness (W604/W829 convention) — regex+threshold, never a
  // literal wave-slug equality. sw.js is bumped every wave; W818 only
  // requires the cache marker to be at or beyond W818, so later bumps
  // (W829/W835/W918/...) keep passing without touching this test.
  const waves = [...body.matchAll(/wave(\d{3,4})/g)].map((m) => +m[1]);
  assert.ok(waves.length > 0,
    'public/sw.js must carry a wave marker; got first 200 chars: '
      + body.slice(0, 200));
  assert.ok(Math.max(...waves) >= 818,
    'public/sw.js cache version must be bumped to >= wave818; got max wave '
      + Math.max(...waves));
});

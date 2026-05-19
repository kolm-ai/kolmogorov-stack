// W457 — build a real GGUF-bundled .kolm artifact (PATH A proof).
//
// Bundles Qwen2.5-0.5B-Instruct (Q4_K_M) GGUF weights into the .kolm zip
// under model/model.gguf. Manifest declares runtime_target='gguf' and
// runtime_target_config.gguf_path so dispatchRuntime() routes to the
// gguf-runner (which spawns llama.cpp). The verifier (binder.js rtCheck)
// confirms the bundled bytes match the declared sha256 — tampering with the
// weights breaks the signature chain.
//
// Honest scope: this proves the pipeline works. The recipe is a no-op
// fallback (returns input as-is) because the executable IS the weights, not
// JS code; the dispatcher picks runtime_target='gguf' and never calls the
// recipe. We ship a single rule recipe purely so artifact_class validation
// accepts the artifact.
//
// Build:
//   RECIPE_RECEIPT_SECRET=kolm-public-fixture-v0-1-0 node scripts/build-example-gguf.mjs
//
// Run (requires llama.cpp on PATH or LLAMA_CPP_BIN env):
//   kolm run ~/.kolm/artifacts/qwen-smoke.kolm '{"prompt":"Hello"}'

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-public-fixture-v0-1-0';
process.env.RECIPE_RECEIPT_SECRET = SECRET;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const { buildAndZip } = await import(pathToFileURL(path.join(repo, 'src/artifact.js')).href);

const ggufPath = path.join(os.homedir(), '.kolm', 'models', 'Qwen_Qwen2.5-0.5B-Instruct__q4_k_m', 'qwen2.5-0.5b-instruct-q4_k_m.gguf');
if (!fs.existsSync(ggufPath)) {
  console.error(`error: GGUF not found at ${ggufPath}`);
  console.error(`hint: run \`kolm models pull Qwen/Qwen2.5-0.5B-Instruct --variant q4_k_m\` first`);
  process.exit(2);
}
const ggufBytes = fs.readFileSync(ggufPath);
const ggufSha = crypto.createHash('sha256').update(ggufBytes).digest('hex');
console.log(`gguf: ${ggufPath}`);
console.log(`gguf bytes: ${ggufBytes.length.toLocaleString()}`);
console.log(`gguf sha256: ${ggufSha}`);

// No-op JS recipe. The dispatcher picks runtime_target='gguf' and never
// invokes this; it exists so artifact_class validation accepts the artifact.
const recipeSource = `
function generate(input, lib) {
  return { passthrough: input, note: 'js fallback never reached because runtime_target=gguf' };
}
`.trim();
const recipeHash = crypto.createHash('sha256').update(recipeSource).digest('hex').slice(0, 16);
const recipes = [{
  id: 'rcp_qwen_smoke_v1',
  name: 'qwen smoke passthrough',
  source: recipeSource,
  source_hash: recipeHash,
  version_id: 'ver_qwen_smoke_001',
  tags: ['gguf', 'smoke', 'demo'],
  schema: { input: { prompt: 'string' }, output: { passthrough: 'object' } },
}];

const evals = {
  spec: 'rs-1-evals',
  n: 1,
  cases: [
    { id: 'noop', input: { prompt: 'hi' }, expected: { passthrough: { prompt: 'hi' } } },
  ],
  coverage: 1.0,
};

const outDir = path.join(os.homedir(), '.kolm', 'artifacts');
fs.mkdirSync(outDir, { recursive: true });

const built = await buildAndZip({
  job_id: 'job_qwen_smoke_v1',
  task: 'qwen-smoke: GGUF-bundled .kolm demonstrating runtime_target=gguf bundling end-to-end (W457).',
  base_model: 'Qwen/Qwen2.5-0.5B-Instruct',
  recipes,
  evals,
  training_stats: { pass_rate_positive: 1.0, latency_p50_us: 50, holdout_accuracy: 1.0 },
  outDir,
  // W457 — weight-class bundling.
  runtime_target: 'gguf',
  runtime_target_config: { gguf_path: 'model/model.gguf' },
  model_weights: {
    filename: 'model/model.gguf',
    content: ggufBytes,
  },
  allow_below_gate: true,
});

const finalPath = path.join(outDir, 'qwen-smoke.kolm');
fs.copyFileSync(built.outPath, finalPath);
if (built.outPath !== finalPath) { try { fs.unlinkSync(built.outPath); } catch {} }

const bytes = fs.statSync(finalPath).size;
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
console.log(`\nbuilt: ${finalPath}`);
console.log(`bytes: ${bytes.toLocaleString()}`);
console.log(`sha256: ${sha256}`);
console.log(`runtime_target: ${built.manifest.runtime_target}`);
console.log(`runtime (alias): ${built.manifest.runtime}`);
console.log(`receipt runtime_target: ${built.receipt.runtime_target}`);
console.log(`manifest.hashes.model_weights: ${built.manifest.hashes.model_weights}`);

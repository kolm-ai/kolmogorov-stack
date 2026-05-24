#!/usr/bin/env node
// W818-2 — ollama .kolm Modelfile generator.
//
// Usage:
//   node tools/ollama-kolm/cli.js <path-to.kolm> [--out-dir <dir>] [--name <model-name>]
//
// Takes a .kolm artifact, unpacks it to a staging directory, and emits:
//   <out-dir>/Modelfile           — ollama Modelfile pointing at extracted weights
//   <out-dir>/kolm_metadata.json  — sidecar with full manifest + lineage receipts
//   <out-dir>/weights.bin         — extracted weights (only when the artifact ships
//                                   real bytes; rule-tier artifacts skip this).
//
// Re-uses the canonical `loadArtifact` helper from src/artifact-runner.js so the
// signature-verify and entry-parse paths stay one piece of code. We deliberately
// do NOT shell out to `kolm unpack` here — direct module import keeps the CLI
// resilient against PATH issues and makes the test path self-contained.
//
// Exit codes:
//   0  success — Modelfile + sidecar written
//   2  bad usage — missing artifact path or unreadable file
//   3  artifact missing real weights (rule-tier / compiled-rule tier)
//   4  signature verification failed — never silent passthrough
//
// Honest envelope: when --json is set, all stdout is a single JSON object so
// callers can branch on { ok, error, modelfile_path, sidecar_path } without
// parsing free-form text.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use process.argv directly so the file stays valid as a require() target for
// the test smoke probe (which doesn't actually execute the CLI's main path).
const ARGS = process.argv.slice(2);

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out-dir' && argv[i + 1]) { out.flags.outDir = argv[++i]; continue; }
    if (a === '--name'    && argv[i + 1]) { out.flags.name   = argv[++i]; continue; }
    if (a === '--json')                    { out.flags.json   = true;     continue; }
    if (a === '--help' || a === '-h')      { out.flags.help   = true;     continue; }
    if (a.startsWith('--')) continue;
    out.positional.push(a);
  }
  return out;
}

function printHelp() {
  // Plain text — caller can render this however they want.
  process.stdout.write([
    'ollama-kolm CLI (W818-2)',
    '',
    'Usage: node tools/ollama-kolm/cli.js <path-to.kolm> [--out-dir <dir>]',
    '                                                    [--name <model-name>]',
    '                                                    [--json]',
    '',
    'Emits a Modelfile + kolm_metadata.json sidecar under --out-dir',
    '(default: ./ollama-staging/<artifact-basename>/) so `ollama create` can',
    'be pointed at the staging directory.',
    '',
  ].join('\n'));
}

function envelope(ok, extra) {
  return Object.assign({ ok, version: 'w818-ollama-kolm-1' }, extra || {});
}

function manifestToModelfile(manifest, weightsRel) {
  const lines = [];
  // FROM directive — ollama expects either a base model name or a path. We
  // hand it the extracted weights when present; rule-tier artifacts fail
  // earlier and never reach this function.
  lines.push('FROM ./' + weightsRel);

  if (manifest && manifest.base_model) {
    lines.push('# kolm-base: ' + String(manifest.base_model));
  }

  // Template / system prompt — quoted as-is. The kolm template format is a
  // strict subset of Modelfile templates so this is a literal pass-through.
  if (manifest && typeof manifest.template === 'string' && manifest.template.length) {
    lines.push('TEMPLATE """' + manifest.template + '"""');
  }
  if (manifest && typeof manifest.system_prompt === 'string' && manifest.system_prompt.length) {
    lines.push('SYSTEM """' + manifest.system_prompt + '"""');
  }

  // Stop tokens — one directive per token.
  if (manifest && Array.isArray(manifest.stop_tokens)) {
    for (const tok of manifest.stop_tokens) {
      lines.push('PARAMETER stop "' + String(tok).replace(/"/g, '\\"') + '"');
    }
  }

  // Generation params.
  const g = (manifest && manifest.generation) || {};
  if (Number.isFinite(Number(g.temp)))   lines.push('PARAMETER temperature ' + Number(g.temp));
  if (Number.isFinite(Number(g.top_p)))  lines.push('PARAMETER top_p '       + Number(g.top_p));
  if (Number.isFinite(Number(g.num_ctx)))lines.push('PARAMETER num_ctx '     + Math.floor(Number(g.num_ctx)));

  if (manifest && manifest.license) {
    lines.push('# kolm-license: ' + String(manifest.license));
  }
  // Honest drop note — attestation block is NOT projected into ollama.
  if (manifest && manifest.attestation) {
    lines.push('# kolm-attestation: manifest-verify-only (ollama has no enforcement hook)');
  }

  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(ARGS);
  if (args.flags.help || args.positional.length === 0) {
    printHelp();
    process.exit(args.positional.length === 0 ? 2 : 0);
  }
  const artifactPath = path.resolve(args.positional[0]);
  if (!fs.existsSync(artifactPath)) {
    const env = envelope(false, { error: 'artifact_not_found', path: artifactPath });
    process.stdout.write(JSON.stringify(env) + '\n');
    process.exit(2);
  }

  // Dynamic import so the CLI loads at all even when the kolm src tree isn't
  // wired into NODE_PATH — the loader is reached through a relative path.
  let loadArtifact;
  try {
    const mod = await import(path.join(__dirname, '..', '..', 'src', 'artifact-runner.js'));
    loadArtifact = mod.loadArtifact;
  } catch (e) {
    const env = envelope(false, { error: 'loader_import_failed', detail: e.message });
    process.stdout.write(JSON.stringify(env) + '\n');
    process.exit(4);
  }

  let bundle;
  try {
    bundle = loadArtifact(artifactPath);
  } catch (e) {
    const env = envelope(false, { error: 'signature_invalid_or_malformed', detail: e.message });
    process.stdout.write(JSON.stringify(env) + '\n');
    process.exit(4);
  }

  const manifest = bundle.manifest || {};
  const artifactClass = manifest.artifact_class || 'rule';
  const ggufEntry = bundle.entries && bundle.entries['model.gguf'];
  // For 'rule' / 'compiled_rule' artifacts the model.gguf entry is a JSON
  // pointer record, NOT a real GGUF byte range. Refuse loud — ollama can't
  // run a rule-tier artifact.
  const hasRealWeights = artifactClass === 'distilled_model' && ggufEntry && ggufEntry.length > 256;
  if (!hasRealWeights) {
    const env = envelope(false, {
      error: 'artifact_has_no_real_weights',
      artifact_class: artifactClass,
      hint: 'ollama requires a distilled_model artifact with real GGUF bytes. Run `kolm run` for rule-tier artifacts instead.',
    });
    process.stdout.write(JSON.stringify(env) + '\n');
    process.exit(3);
  }

  const baseName = path.basename(artifactPath, path.extname(artifactPath));
  const outDir = path.resolve(args.flags.outDir || path.join('.', 'ollama-staging', baseName));
  fs.mkdirSync(outDir, { recursive: true });
  const weightsRel = 'weights.bin';
  const weightsPath = path.join(outDir, weightsRel);
  fs.writeFileSync(weightsPath, ggufEntry);

  const modelfileBody = manifestToModelfile(manifest, weightsRel);
  const modelfilePath = path.join(outDir, 'Modelfile');
  fs.writeFileSync(modelfilePath, modelfileBody, 'utf8');

  const sidecar = {
    version: 'w818-ollama-kolm-1',
    artifact_path: artifactPath,
    artifact_class: artifactClass,
    manifest: manifest,
    receipt: bundle.receipt || null,
    signature_mode: bundle.signature_mode || 'unknown',
    signature_valid: bundle.signature_valid === true,
    generated_at: new Date().toISOString(),
  };
  const sidecarPath = path.join(outDir, 'kolm_metadata.json');
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');

  const env = envelope(true, {
    modelfile_path: modelfilePath,
    sidecar_path: sidecarPath,
    weights_path: weightsPath,
    out_dir: outDir,
    next_command: 'ollama create ' + (args.flags.name || baseName) + ' -f ' + modelfilePath,
  });
  process.stdout.write(JSON.stringify(env, null, 2) + '\n');
  process.exit(0);
}

// Top-level await is fine in modern Node ESM — but we guard execution so the
// file can be `require`d safely by the W818 test smoke probe (which checks
// only that the file parses as valid Node code).
const isDirectInvocation = (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || ''); }
  catch { return false; }
})();

if (isDirectInvocation) {
  main().catch((e) => {
    const env = envelope(false, { error: 'unhandled', detail: e && e.message });
    process.stdout.write(JSON.stringify(env) + '\n');
    process.exit(1);
  });
}

export { parseArgs, manifestToModelfile, envelope };

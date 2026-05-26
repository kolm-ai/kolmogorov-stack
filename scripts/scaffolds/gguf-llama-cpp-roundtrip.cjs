#!/usr/bin/env node
// W888-L scaffold #15 — GGUF round-trip via llama-cpp-python.
//
// Loads a GGUF artifact in `llama-cpp-python` (if available + a fixture GGUF
// is on disk) and generates 10 tokens. On every "missing dep / missing
// fixture" path we emit a structured SKIP envelope and exit 0 — ship-gate
// counts SKIP as a non-blocker.
//
// Inputs (env):
//   KOLM_GGUF_PATH — absolute path to a small GGUF model fixture. Optional.
//   PYTHON         — python binary; defaults to `python3` (Linux/macOS) or
//                    `python` (Windows).
//
// Output (stdout): one JSON line.
//   On PASS:  { ok:true, tokens_generated, model, version }
//   On SKIP:  { ok:false, skipped:true, reason, install_hint, version }
//   On FAIL:  { ok:false, error, version }

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VERSION = 'w888L-gguf-rt-v1';

function emit(o, code) {
  process.stdout.write(JSON.stringify(o) + '\n');
  process.exit(code || 0);
}

function skip(reason, hint) {
  emit({ ok: false, skipped: true, reason, install_hint: hint, version: VERSION }, 0);
}

(function main() {
  const ggufPath = process.env.KOLM_GGUF_PATH;
  if (!ggufPath || !fs.existsSync(ggufPath)) {
    return skip(
      'no GGUF fixture available (set KOLM_GGUF_PATH to a small .gguf model)',
      'kolm compile --target gguf-q4km --out fixture.gguf; export KOLM_GGUF_PATH=$PWD/fixture.gguf',
    );
  }
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  // Detect llama-cpp-python.
  const probe = spawnSync(python, ['-c', 'import llama_cpp; print(llama_cpp.__version__)'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (probe.status !== 0) {
    return skip(
      'llama-cpp-python not importable in ' + python,
      'pip install llama-cpp-python',
    );
  }
  const llamaVersion = String(probe.stdout || '').trim();
  // Run a 10-token generation in a subprocess so we never block.
  const code = [
    'import json, sys',
    'from llama_cpp import Llama',
    'llm = Llama(model_path=' + JSON.stringify(ggufPath) + ', n_ctx=512, n_threads=2, verbose=False)',
    'out = llm("hello", max_tokens=10)',
    'choices = out.get("choices", [{}])',
    'text = choices[0].get("text", "") if choices else ""',
    'tok = out.get("usage", {}).get("completion_tokens", len(text.split()))',
    'print(json.dumps({"text": text, "tokens": tok}))',
  ].join('\n');
  const run = spawnSync(python, ['-c', code], { encoding: 'utf8', timeout: 180_000 });
  if (run.status !== 0) {
    emit({
      ok: false,
      error: 'llama_cpp_python_call_failed',
      stderr: String(run.stderr || '').slice(0, 400),
      llama_cpp_version: llamaVersion,
      version: VERSION,
    }, 2);
  }
  let parsed = null;
  try { parsed = JSON.parse(String(run.stdout || '').trim().split(/\r?\n/).pop()); }
  catch (_) {} // deliberate: cleanup
  const tokens = parsed && Number.isFinite(parsed.tokens) ? Number(parsed.tokens) : 0;
  emit({
    ok: tokens > 0,
    tokens_generated: tokens,
    model_path: ggufPath,
    llama_cpp_version: llamaVersion,
    sample_text: parsed && String(parsed.text || '').slice(0, 80),
    version: VERSION,
  }, tokens > 0 ? 0 : 2);
})();

// S-2 — Generic Ollama integration.
//
// Pins the shape of src/export-ollama.js so:
//   * generateModelfile() produces a valid Modelfile string with FROM,
//     TEMPLATE, SYSTEM, PARAMETER stanzas all present
//   * Defaults work for a bare-minimum artifact (only ggufPath supplied)
//   * Custom chat_template overrides the ChatML default
//   * stop_tokens propagate as PARAMETER stop lines
//   * generic artifact (no Trinity-specific fields) is accepted
//   * probeOllama() returns structured envelope (never throws)
//   * exportOllama() with skipCreate writes a Modelfile + returns a stub
//     runtime_passport row
//
// Real `ollama create` invocation is env-conditional: opt in via
// KOLM_S2_REAL_CREATE=1 AND ollama-on-PATH. Default test only writes the
// Modelfile to disk and reads it back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OLLAMA_EXPORT_VERSION,
  generateModelfile,
  probeOllama,
  exportOllama,
} from '../src/export-ollama.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------------------
// 1) Version constant
// ----------------------------------------------------------------------------
test('S-2 #1 - OLLAMA_EXPORT_VERSION matches export-ollama-vN tag', () => {
  assert.ok(/^export-ollama-v\d+$/.test(OLLAMA_EXPORT_VERSION),
    `OLLAMA_EXPORT_VERSION must match /^export-ollama-v\\d+$/; got ${OLLAMA_EXPORT_VERSION}`);
});

// ----------------------------------------------------------------------------
// 2) generateModelfile — minimal artifact
// ----------------------------------------------------------------------------
test('S-2 #2 - generateModelfile produces FROM + TEMPLATE + SYSTEM + PARAMETER lines', () => {
  const body = generateModelfile({
    artifact: {
      name: 'kolm-s2-min',
      artifact_hash: 'sha256:' + 'a'.repeat(64),
      system_prompt: 'You are a careful agent.',
    },
    ggufPath: './model-q4km.gguf',
  });
  // FROM
  assert.ok(/^FROM \.\/model-q4km\.gguf$/m.test(body),
    `body must contain a FROM line; got:\n${body}`);
  // TEMPLATE block (defaults to ChatML)
  assert.ok(/TEMPLATE """/m.test(body),
    `body must contain TEMPLATE """`);
  assert.ok(/<\|im_start\|>/.test(body),
    `body's default TEMPLATE must use ChatML markers (<|im_start|>)`);
  // SYSTEM block
  assert.ok(/SYSTEM """You are a careful agent\.""/.test(body),
    `body must contain SYSTEM "...You are a careful agent..."`);
  // PARAMETER lines (at least temperature + num_ctx from defaults)
  assert.ok(/^PARAMETER temperature /m.test(body), 'body must have PARAMETER temperature');
  assert.ok(/^PARAMETER top_p /m.test(body), 'body must have PARAMETER top_p');
  assert.ok(/^PARAMETER num_ctx /m.test(body), 'body must have PARAMETER num_ctx');
  // Header comment carries kolm-artifact tag
  assert.ok(/# kolm-artifact: kolm-s2-min/.test(body),
    `body must carry kolm-artifact comment`);
});

// ----------------------------------------------------------------------------
// 3) generateModelfile — custom chat_template overrides default
// ----------------------------------------------------------------------------
test('S-2 #3 - custom chat_template overrides ChatML default', () => {
  const body = generateModelfile({
    artifact: {
      name: 'custom-tpl',
      chat_template: '[INST] {{ .Prompt }} [/INST]\n{{ .Response }}',
    },
    ggufPath: '/abs/path/to/model.gguf',
  });
  assert.ok(/\[INST\] \{\{ \.Prompt \}\} \[\/INST\]/.test(body),
    `body must contain the custom template; got:\n${body}`);
  assert.ok(!/<\|im_start\|>/.test(body),
    `body must NOT contain ChatML markers when custom template supplied`);
});

// ----------------------------------------------------------------------------
// 4) Stop tokens propagate as PARAMETER stop lines
// ----------------------------------------------------------------------------
test('S-2 #4 - stop_tokens emit PARAMETER stop lines with proper quoting', () => {
  const body = generateModelfile({
    artifact: {
      name: 'with-stops',
      stop_tokens: ['<|im_start|>', '<|im_end|>', '</s>'],
    },
    ggufPath: './x.gguf',
  });
  assert.ok(/^PARAMETER stop "<\|im_start\|>"/m.test(body),
    `body must contain stop "<|im_start|>"; got:\n${body}`);
  assert.ok(/^PARAMETER stop "<\|im_end\|>"/m.test(body),
    `body must contain stop "<|im_end|>"`);
  assert.ok(/^PARAMETER stop "<\/s>"/m.test(body),
    `body must contain stop "</s>"`);
});

// ----------------------------------------------------------------------------
// 5) Override parameters merge over defaults
// ----------------------------------------------------------------------------
test('S-2 #5 - override parameters merge over defaults', () => {
  const body = generateModelfile({
    artifact: { name: 'override' },
    ggufPath: './o.gguf',
    parameters: { temperature: 0.7, num_ctx: 32768 },
  });
  assert.ok(/^PARAMETER temperature 0\.7$/m.test(body),
    `body must contain PARAMETER temperature 0.7; got:\n${body}`);
  assert.ok(/^PARAMETER num_ctx 32768$/m.test(body),
    `body must contain PARAMETER num_ctx 32768`);
});

// ----------------------------------------------------------------------------
// 6) ggufPath is mandatory; missing it raises
// ----------------------------------------------------------------------------
test('S-2 #6 - missing ggufPath raises', () => {
  assert.throws(() => generateModelfile({ artifact: { name: 'x' } }),
    /ggufPath required/);
});

// ----------------------------------------------------------------------------
// 7) probeOllama returns envelope (no throws)
// ----------------------------------------------------------------------------
test('S-2 #7 - probeOllama returns envelope', () => {
  const p = probeOllama();
  assert.equal(typeof p, 'object');
  assert.equal(typeof p.ok, 'boolean');
  if (!p.ok) {
    assert.ok(Array.isArray(p.missing));
    assert.ok(typeof p.hint === 'string');
  } else {
    assert.equal(typeof p.binary, 'string');
  }
});

// ----------------------------------------------------------------------------
// 8) exportOllama with skipCreate writes Modelfile + returns passport hint
// ----------------------------------------------------------------------------
test('S-2 #8 - exportOllama({skipCreate:true}) writes a Modelfile + passport hint', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-s2-export-'));
  // Fake gguf bytes — just need a real file on disk for the staging path.
  const fakeGguf = path.join(tmpDir, 'fake.gguf');
  fs.writeFileSync(fakeGguf, Buffer.alloc(1024, 0));
  const result = await exportOllama({
    artifact: {
      name: 'kolm-s2-export-test',
      artifact_hash: 'sha256:' + 'b'.repeat(64),
      system_prompt: 'You are helpful.',
      passport: {},
    },
    ggufPath: fakeGguf,
    outputDir: tmpDir,
    skipCreate: true,
  });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.modelfile_path), `Modelfile must be written: ${result.modelfile_path}`);
  const body = fs.readFileSync(result.modelfile_path, 'utf8');
  assert.ok(/FROM /.test(body));
  assert.ok(/TEMPLATE """/.test(body));
  assert.ok(/SYSTEM """You are helpful\."""/.test(body));
  // Stub runtime passport row
  assert.ok(result.runtime_passport_hint);
  assert.equal(result.runtime_passport_hint.runtime, 'ollama');
  assert.equal(result.runtime_passport_hint.status, 'estimated');
});

// ----------------------------------------------------------------------------
// 9) Generic artifact path (no Trinity-specific fields)
// ----------------------------------------------------------------------------
test('S-2 #9 - generic artifact (zero Trinity-isms) produces a clean Modelfile', () => {
  // The arg shape is purely formal. No teacher_council, no trinity-500, no
  // distill-run-specific keys. If this test ever fails it means a Trinity
  // assumption crept into export-ollama.js.
  const body = generateModelfile({
    artifact: {
      name: 'my-org/my-model-7b',
      artifact_hash: 'sha256:' + 'c'.repeat(64),
      base_model: 'Mistral-7B-Instruct-v0.3',
      license: 'apache-2.0',
    },
    ggufPath: './my-model-7b-q5km.gguf',
  });
  assert.ok(body.includes('# kolm-artifact: my-org/my-model-7b'));
  assert.ok(body.includes('# kolm-base-model: Mistral-7B-Instruct-v0.3'));
  assert.ok(body.includes('# kolm-license: apache-2.0'));
  assert.ok(!/trinity/i.test(body), 'generic body must not contain "trinity"');
});

// ----------------------------------------------------------------------------
// 10) [env-conditional] real `ollama create` invocation
// ----------------------------------------------------------------------------
const REAL_OPT_IN = process.env.KOLM_S2_REAL_CREATE === '1';
const ollamaP = probeOllama();
const REAL_SKIP_REASON = !REAL_OPT_IN
  ? 'env-skip: set KOLM_S2_REAL_CREATE=1 to opt in to live `ollama create`'
  : (!ollamaP.ok ? `env-skip: ollama binary missing — ${ollamaP.hint}` : false);

test('S-2 #10 - [env] real ollama create with a tiny model', { skip: REAL_SKIP_REASON }, async () => {
  // This test requires KOLM_S2_TEST_GGUF=/path/to/tiny-model.gguf
  const realGguf = process.env.KOLM_S2_TEST_GGUF;
  if (!realGguf || !fs.existsSync(realGguf)) {
    return;  // soft skip — outer KOLM_S2_REAL_CREATE was set but test gguf missing
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-s2-real-'));
  const stagedGguf = path.join(tmpDir, path.basename(realGguf));
  fs.copyFileSync(realGguf, stagedGguf);
  const name = 'kolm-s2-real-' + Date.now();
  const result = await exportOllama({
    artifact: { name, artifact_hash: 'sha256:' + 'd'.repeat(64) },
    ggufPath: stagedGguf,
    outputDir: tmpDir,
    modelName: name,
    skipCreate: false,
  });
  assert.equal(result.ok, true);
  assert.ok(result.create_result, 'create_result must be set');
  assert.equal(result.create_result.ok, true, `ollama create must succeed: ${JSON.stringify(result.create_result)}`);
});

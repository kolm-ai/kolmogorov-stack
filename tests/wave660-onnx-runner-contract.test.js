// W660 - direct contract for src/runners/onnx-runner.js.
//
// The test uses an injected fake ORT module so root installs do not need the
// native onnxruntime-node optional dependency.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import AdmZip from 'adm-zip';

import { runtimeAvailable } from '../src/artifact-runner.js';
import {
  onnxRuntimeConfigAvailable,
  runOnnxTarget,
} from '../src/runners/onnx-runner.js';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function captureError(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

function makeBundle(onnxPath = 'models/model.onnx', bytes = Buffer.from('fake-onnx-model')) {
  return {
    manifest: {
      runtime_target: 'onnx',
      runtime_target_config: { onnx_path: onnxPath },
      entrypoint: {
        input_schema: { name: 'features', dtype: 'float32' },
      },
    },
    entries: { [onnxPath]: bytes },
  };
}

function fakeOrt(record = {}) {
  record.tensors = [];
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
      record.tensors.push({ type, data, dims });
    }
  }
  return {
    Tensor,
    InferenceSession: {
      create: async (modelPath) => {
        record.modelPath = modelPath;
        record.modelDir = path.dirname(modelPath);
        record.modelBytes = fs.readFileSync(modelPath);
        return {
          inputNames: record.inputNames || ['features'],
          run: async (feeds) => {
            record.feeds = feeds;
            if (record.run) return record.run(feeds);
            return {
              logits: { dims: [1, 2], type: 'float32', data: new Float32Array([0.25, 0.75]) },
              token_ids: { dims: [2], type: 'int64', data: new BigInt64Array([7n, 9n]) },
            };
          },
        };
      },
    },
  };
}

test('W660 onnx config probe rejects unsafe manifest paths before runtime probing', () => {
  for (const onnxPath of ['../model.onnx', '/tmp/model.onnx', 'models\\model.onnx', 'models/model.bin']) {
    const direct = onnxRuntimeConfigAvailable({ onnx_path: onnxPath });
    assert.equal(direct.ok, false, onnxPath);
    assert.match(direct.reason, /onnx_path|unsafe|relative|\.onnx/i);

    const viaDispatcher = runtimeAvailable({
      runtime_target: 'onnx',
      runtime_target_config: { onnx_path: onnxPath },
    });
    assert.equal(viaDispatcher.ok, false, onnxPath);
    assert.match(viaDispatcher.reason, /onnx_path|unsafe|relative|\.onnx/i);
  }
});

test('W660 onnx runner reports missing optional runtime without native dependency', async () => {
  const err = await captureError(() => runOnnxTarget(
    makeBundle(),
    [1, 2],
    { loadOrt: async () => null },
  ));
  assert.ok(err);
  assert.equal(err.code, 'KOLM_E_ONNX_RUNTIME_MISSING');
  assert.match(err.message, /onnxruntime-node/);
});

test('W660 onnx runner executes injected ORT, hashes model bytes, and cleans temp dir', async () => {
  const bytes = Buffer.from('fake-onnx-model-v1');
  const record = {};
  const r = await runOnnxTarget(
    makeBundle('models/classifier.onnx', bytes),
    { data: new Float32Array([1, 2, 3, 4]) },
    { ort: fakeOrt(record), shape: [2, 2], timeoutMs: 1000 },
  );

  assert.equal(r.runtime, 'onnx');
  assert.equal(r.model_sha256, sha256Hex(bytes));
  assert.deepEqual(r.output.logits, { dims: [1, 2], type: 'float32', data: [0.25, 0.75] });
  assert.deepEqual(r.output.token_ids, { dims: [2], type: 'int64', data: ['7', '9'] });
  assert.equal(path.basename(record.modelPath), 'model.onnx');
  assert.deepEqual(record.tensors[0].dims, [2, 2]);
  assert.equal(record.tensors[0].type, 'float32');
  assert.deepEqual(Array.from(record.tensors[0].data), [1, 2, 3, 4]);
  assert.equal(fs.existsSync(record.modelDir), false, 'onnx temp dir must be removed after run');
});

test('W660 onnx runner supports string tensors and explicit inputName override', async () => {
  const record = {};
  const bundle = makeBundle('models/string.onnx', Buffer.from('string-model'));
  bundle.manifest.entrypoint.input_schema = { name: 'ignored_by_opts', dtype: 'float32' };

  const r = await runOnnxTarget(
    bundle,
    { text: 'hello' },
    {
      ort: fakeOrt(record),
      inputName: 'prompt',
      dtype: 'string',
    },
  );

  assert.equal(r.runtime, 'onnx');
  assert.ok(record.feeds.prompt, 'opts.inputName should choose the feed key');
  assert.equal(record.tensors[0].type, 'string');
  assert.deepEqual(record.tensors[0].dims, [1]);
  assert.deepEqual(record.tensors[0].data, [JSON.stringify({ text: 'hello' })]);
});

test('W660 onnx runner fails closed on size, shape, dtype, output, and timeout limits', async () => {
  const tooLarge = await captureError(() => runOnnxTarget(
    makeBundle('models/large.onnx', Buffer.from('12345')),
    [1],
    { ort: fakeOrt({}), maxModelBytes: 4 },
  ));
  assert.equal(tooLarge.code, 'KOLM_E_TARGET_TOO_LARGE');

  const badShape = await captureError(() => runOnnxTarget(
    makeBundle(),
    [1, 2, 3],
    { ort: fakeOrt({}), shape: [2, 2] },
  ));
  assert.equal(badShape.code, 'KOLM_E_ONNX_RUNTIME');
  assert.match(badShape.message, /expects 4 values, got 3/);

  const badDtype = await captureError(() => runOnnxTarget(
    makeBundle(),
    [1],
    { ort: fakeOrt({}), dtype: 'float16' },
  ));
  assert.equal(badDtype.code, 'KOLM_E_ONNX_RUNTIME');
  assert.match(badDtype.message, /unsupported/);

  const outputTooLarge = await captureError(() => runOnnxTarget(
    makeBundle(),
    [1],
    {
      ort: fakeOrt({
        run: async () => ({
          big: { dims: [3], type: 'float32', data: new Float32Array([1, 2, 3]) },
        }),
      }),
      maxOutputElements: 2,
    },
  ));
  assert.equal(outputTooLarge.code, 'KOLM_E_ONNX_RUNTIME');
  assert.match(outputTooLarge.message, /output tensor too large/);

  const timedOut = await captureError(() => runOnnxTarget(
    makeBundle(),
    [1],
    {
      ort: fakeOrt({ run: async () => new Promise(() => {}) }),
      timeoutMs: 1,
    },
  ));
  assert.equal(timedOut.code, 'KOLM_E_RECIPE_TIMEOUT');
});

test('W660 onnx runner streams large_entries through artifact_path', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w660-onnx-zip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const artifactPath = path.join(dir, 'model.kolm');
  const onnxPath = 'models/stream.onnx';
  const bytes = Buffer.from('streamed-onnx-bytes');
  const zip = new AdmZip();
  zip.addFile(onnxPath, bytes);
  zip.writeZip(artifactPath);

  const record = {};
  const r = await runOnnxTarget(
    {
      manifest: {
        runtime_target: 'onnx',
        runtime_target_config: { onnx_path: onnxPath },
        entrypoint: { input_schema: { name: 'features', dtype: 'float32' } },
      },
      entries: {},
      large_entries: { [onnxPath]: { uncompressed_size: bytes.length, compressed_size: bytes.length } },
      artifact_path: artifactPath,
    },
    [5, 6],
    { ort: fakeOrt(record), shape: [1, 2] },
  );

  assert.equal(r.model_sha256, sha256Hex(bytes));
  assert.deepEqual(record.modelBytes, bytes);
  assert.deepEqual(Array.from(record.tensors[0].data), [5, 6]);
});

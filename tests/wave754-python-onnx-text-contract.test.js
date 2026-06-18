// W754 - direct contract test for packages/sdk-python/kolm/runtimes/onnx_text.py.
//
// This pins the Python ONNX text runtime atom: declared optional deps, bounded
// generation, sanitized env overrides, provider allowlisting, cached session
// inputs, deterministic EOS handling, and logits shape validation.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function runPython(script) {
  const py = process.env.PYTHON || 'python';
  const res = spawnSync(py, ['-c', script], {
    cwd: ROOT,
    env: { ...process.env, KOLM_REPO: ROOT },
    encoding: 'utf8',
  });
  return { ...res, command: py };
}

test('W754 Python ONNX text runtime is wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const source = read('packages/sdk-python/kolm/runtimes/onnx_text.py');
  const pyproject = read('packages/sdk-python/pyproject.toml');

  assert.equal(
    pkg.scripts['verify:python-onnx-text'],
    'node --test --test-concurrency=1 tests/wave754-python-onnx-text-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:zip-large && npm run verify:python-onnx-text && npm run verify:fal-backend && npm run verify:vast-backend && npm run verify:browser-extension-popup && npm run verify:langchain-package-manifest && npm run verify:llamaindex-package-manifest && npm run verify:runtime-rs-build-scripts && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(source, /ONNX_TEXT_CONTRACT_VERSION = "w754-onnx-text-v1"/);
  assert.match(source, /ONNX_TEXT_LIMITS = MappingProxyType/);
  assert.match(source, /KOLM_ONNX_PROVIDERS/);
  assert.match(source, /_parse_providers/);
  assert.match(source, /_bounded_env_name/);
  assert.match(source, /self\._input_names = frozenset/);
  assert.match(source, /_validate_logits_shape/);
  assert.match(pyproject, /onnx = \["onnxruntime>=1\.18", "numpy>=1\.26", "tokenizers>=0\.19"\]/);
});

test('W754 Python ONNX text runtime enforces hermetic runtime boundaries', (t) => {
  const script = String.raw`
import json
import os
import pathlib
import sys
import tempfile
import types

repo = pathlib.Path(os.environ["KOLM_REPO"])
sys.path.insert(0, str(repo / "packages" / "sdk-python"))

class FakeArray:
    def __init__(self, rows):
        self.rows = [list(row) for row in rows]
        self.shape = (len(self.rows), len(self.rows[0]) if self.rows else 0)
    def reshape(self, rows, cols):
        flat = [v for row in self.rows for v in row]
        if rows != 1 or cols != -1:
            raise AssertionError("unexpected reshape")
        return FakeArray([flat])
    def __getitem__(self, key):
        if isinstance(key, tuple):
            row, col = key
            return self.rows[row][col]
        return self.rows[key]

class FakeLogits:
    shape = (1, 1, 10)
    def __init__(self, next_id):
        self.next_id = next_id
    def __getitem__(self, key):
        row, col, slc = key
        if row != 0 or col != -1 or slc != slice(None, None, None):
            raise AssertionError("unexpected logits index")
        scores = [0] * 10
        scores[self.next_id] = 100
        return scores

class BadLogits:
    shape = (1, 0)

fake_np = types.ModuleType("numpy")
fake_np.int64 = "int64"
def np_array(value, dtype=None):
    return FakeArray(value)
def np_ones_like(arr):
    return FakeArray([[1 for _ in row] for row in arr.rows])
def np_arange(n, dtype=None):
    return FakeArray([list(range(n))])
def np_ones(shape, dtype=None):
    rows, cols = shape
    return FakeArray([[1 for _ in range(cols)] for _ in range(rows)])
def np_concatenate(arrays, axis=0):
    if axis != 1:
        raise AssertionError("unexpected concat axis")
    left, right = arrays
    return FakeArray([left.rows[0] + right.rows[0]])
def np_argmax(values):
    return max(range(len(values)), key=lambda i: values[i])
fake_np.array = np_array
fake_np.ones_like = np_ones_like
fake_np.arange = np_arange
fake_np.ones = np_ones
fake_np.concatenate = np_concatenate
fake_np.argmax = np_argmax
sys.modules["numpy"] = fake_np

fake_ort = types.ModuleType("onnxruntime")
class SessionOptions:
    pass
class FakeInput:
    def __init__(self, name):
        self.name = name
class InferenceSession:
    created = []
    invalid_shape = False
    def __init__(self, model_path, opts, providers):
        self.model_path = model_path
        self.providers = providers
        self.get_inputs_calls = 0
        self.runs = 0
        InferenceSession.created.append(self)
    def get_inputs(self):
        self.get_inputs_calls += 1
        return [FakeInput("input_ids"), FakeInput("attention_mask"), FakeInput("position_ids")]
    def run(self, names, feeds):
        if "input_ids" not in feeds:
            raise AssertionError("input_ids feed missing")
        self.runs += 1
        if self.invalid_shape:
            return [BadLogits()]
        return [FakeLogits(4 if self.runs == 1 else 9)]
fake_ort.SessionOptions = SessionOptions
fake_ort.InferenceSession = InferenceSession
sys.modules["onnxruntime"] = fake_ort

fake_tok_mod = types.ModuleType("tokenizers")
class Encoded:
    def __init__(self, ids):
        self.ids = ids
class FakeTokenizer:
    def encode(self, prompt):
        if prompt == "long":
            return Encoded(list(range(8193)))
        return Encoded([1, 2])
    def decode(self, ids, skip_special_tokens=True):
        return ",".join(str(i) for i in ids)
    def token_to_id(self, token):
        return 9
class Tokenizer:
    @staticmethod
    def from_file(path):
        return FakeTokenizer()
fake_tok_mod.Tokenizer = Tokenizer
sys.modules["tokenizers"] = fake_tok_mod

from kolm.runtimes.onnx_text import (
    ONNX_TEXT_CONTRACT_VERSION,
    ONNX_TEXT_LIMITS,
    OnnxTextGen,
)

assert ONNX_TEXT_CONTRACT_VERSION == "w754-onnx-text-v1"
assert ONNX_TEXT_LIMITS["max_new_tokens"] == 1024

root = pathlib.Path(tempfile.mkdtemp(prefix="kolm-w754-onnx-"))
(root / "model.onnx").write_bytes(b"fake")
(root / "tokenizer.json").write_text("{}", encoding="utf-8")
(root / "config.json").write_text(json.dumps({"eos_token_id": [True, 9]}), encoding="utf-8")

os.environ["KOLM_ONNX_PROVIDERS"] = "CPUExecutionProvider,CUDAExecutionProvider,CPUExecutionProvider"
for key in ("KOLM_ONNX_INPUT_IDS", "KOLM_ONNX_ATTN_MASK", "KOLM_ONNX_POS_IDS"):
    os.environ.pop(key, None)

rt = OnnxTextGen(root)
sess = InferenceSession.created[-1]
assert rt.providers == ("CPUExecutionProvider", "CUDAExecutionProvider")
assert sess.providers == ["CPUExecutionProvider", "CUDAExecutionProvider"]
assert rt.eos == 9
assert rt._input_names == frozenset({"input_ids", "attention_mask", "position_ids"})
assert sess.get_inputs_calls == 1
assert rt.generate("hello", max_tokens=4) == "4"
assert sess.runs == 2
assert sess.get_inputs_calls == 1
assert rt.generate("hello", max_tokens=0) == ""
assert sess.runs == 2

try:
    rt.generate(123)
    raise AssertionError("non-string prompt accepted")
except TypeError as e:
    assert "prompt must be a string" in str(e)

try:
    rt.generate("long")
    raise AssertionError("oversized prompt accepted")
except ValueError as e:
    assert "prompt token count exceeds limit" in str(e)

rt.sess.invalid_shape = True
try:
    rt.generate("hello", max_tokens=1)
    raise AssertionError("bad logits shape accepted")
except RuntimeError as e:
    assert "invalid shape" in str(e)
rt.sess.invalid_shape = False

os.environ["KOLM_ONNX_INPUT_IDS"] = "bad name"
try:
    OnnxTextGen(root)
    raise AssertionError("invalid input env accepted")
except ValueError as e:
    assert "KOLM_ONNX_INPUT_IDS" in str(e)

os.environ["KOLM_ONNX_INPUT_IDS"] = "missing_input"
try:
    OnnxTextGen(root)
    raise AssertionError("missing model input accepted")
except ValueError as e:
    assert "not present" in str(e)

os.environ["KOLM_ONNX_INPUT_IDS"] = "input_ids"
os.environ["KOLM_ONNX_PROVIDERS"] = "CPUExecutionProvider,bad provider"
try:
    OnnxTextGen(root)
    raise AssertionError("invalid provider accepted")
except ValueError as e:
    assert "KOLM_ONNX_PROVIDERS" in str(e)

print("w754 ok")
`;

  const res = runPython(script);
  if (res.error?.code === 'ENOENT') {
    t.skip(`${res.command} is not available`);
    return;
  }
  assert.equal(
    res.status,
    0,
    `python ONNX contract failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
  assert.match(res.stdout, /w754 ok/);
});

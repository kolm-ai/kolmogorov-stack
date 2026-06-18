// W693 - direct contract/security tests for Python framework adapters.
//
// Covered atoms:
// - packages/python-langchain-kolm/kolm_langchain/llm.py
// - packages/python-llamaindex-kolm/kolm_llamaindex/llm.py
//
// These package-distribution adapters cross env config, HTTP, and subprocess
// boundaries. Pin them against URL normalization, artifact validation,
// construction-time env reads, timeout defaults, redaction, bounded errors,
// and receipt preservation without requiring LangChain or LlamaIndex to be
// installed in the local test environment.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PYTHON = process.env.PYTHON || 'python';

const ADAPTERS = [
  {
    name: 'langchain',
    packageRel: 'packages/python-langchain-kolm',
    module: 'kolm_langchain',
    llmRel: 'packages/python-langchain-kolm/kolm_langchain/llm.py',
    initRel: 'packages/python-langchain-kolm/kolm_langchain/__init__.py',
    pyprojectRel: 'packages/python-langchain-kolm/pyproject.toml',
  },
  {
    name: 'llamaindex',
    packageRel: 'packages/python-llamaindex-kolm',
    module: 'kolm_llamaindex',
    llmRel: 'packages/python-llamaindex-kolm/kolm_llamaindex/llm.py',
    initRel: 'packages/python-llamaindex-kolm/kolm_llamaindex/__init__.py',
    pyprojectRel: 'packages/python-llamaindex-kolm/pyproject.toml',
  },
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function runPython(adapter, code) {
  const result = spawnSync(PYTHON, ['-c', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, adapter.packageRel),
    },
  });
  assert.equal(
    result.status,
    0,
    [
      `${adapter.name} python snippet failed`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`,
    ].join('\n'),
  );
  return result.stdout;
}

function py(strings, ...values) {
  return String.raw({ raw: strings }, ...values);
}

test('W693 static contracts are wired into source, versions, and depth verifier', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.scripts['verify:python-framework-adapters'], /wave693-python-framework-adapters-contract\.test\.js/);
  assert.match(packageJson.scripts['verify:depth'], /verify:python-framework-adapters/);

  for (const adapter of ADAPTERS) {
    const source = read(adapter.llmRel);
    const init = read(adapter.initRel);
    const pyproject = read(adapter.pyprojectRel);
    const version = pyproject.match(/version\s*=\s*"([^"]+)"/)?.[1];

    assert.equal(init.match(/__version__\s*=\s*"([^"]+)"/)?.[1], version);
    assert.match(source, /MAX_STDERR_CHARS\s*=\s*8192/);
    assert.match(source, /MAX_PROMPT_CHARS\s*=\s*1_000_000/);
    assert.match(source, /def _normalize_base_url/);
    assert.match(source, /def _require_http_artifact/);
    assert.match(source, /def _redact_secrets/);
    assert.match(source, /quote\(_require_http_artifact/);
    assert.match(source, /os\.environ\.get\("KOLM_BIN"\)/);
    assert.doesNotMatch(source, /HTTP mode\) is required\r?\n\s*super\(\).__init__[\s\S]*self\._base_url: Optional\[str\] = base_url/);
  }
});

test('W693 Python adapters validate config and read env at construction', () => {
  for (const adapter of ADAPTERS) {
    runPython(adapter, py`
import os
from ${adapter.module} import KolmLLM, __version__

assert __version__ == "0.2.6"

try:
    KolmLLM()
    raise AssertionError("missing config should fail")
except ValueError as exc:
    assert "either artifact_path" in str(exc)

for bad_url in ("file:///tmp/runtime", "https://token@example.test"):
    try:
        KolmLLM(base_url=bad_url)
        raise AssertionError("bad URL should fail")
    except ValueError as exc:
        assert "base_url" in str(exc)

llm = KolmLLM(base_url="https://runtime.example///?token=leak#frag", timeout_s=-1)
assert llm._base_url == "https://runtime.example"
assert llm._timeout_s == 30.0

try:
    KolmLLM(base_url="https://runtime.example", artifact_path="../secret")
    raise AssertionError("traversal artifact should fail")
except ValueError as exc:
    assert "traverse" in str(exc)

os.environ["KOLM_BIN"] = "env-kolm"
subprocess_llm = KolmLLM(artifact_path="artifact.kolm")
assert subprocess_llm._bin == "env-kolm"

try:
    llm.invoke_with_receipt({"role": "user", "content": "not a string"})
    raise AssertionError("non-string prompt should fail")
except TypeError as exc:
    assert "prompt must be a string" in str(exc)
`);
  }
});

test('W693 Python adapters preserve HTTP receipts and redact provider errors', () => {
  for (const adapter of ADAPTERS) {
    runPython(adapter, py`
import io
import json
from urllib.error import HTTPError
import ${adapter.module}.llm as adapter_mod
from ${adapter.module} import KolmLLM

calls = []
api_key = "ks_live_http_secret_abcdef123456"

class Response:
    def __init__(self, body):
        self.body = body
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False
    def read(self, amt=-1):
        if amt is None or amt < 0:
            return self.body
        return self.body[:amt]

def ok_urlopen(req, timeout):
    calls.append({
        "url": req.full_url,
        "headers": dict(req.header_items()),
        "data": req.data,
        "timeout": timeout,
    })
    return Response(json.dumps({
        "text": "compiled answer",
        "receipt": {"cid": "cidv1:abc", "k_score": 0.98},
    }).encode("utf-8"))

adapter_mod._urllib_request.urlopen = ok_urlopen
llm = KolmLLM(
    base_url="https://runtime.example/api/",
    artifact_path="models/private artifact.kolm",
    api_key=api_key,
)
out = llm.invoke_with_receipt("hello")
headers = {key.lower(): value for key, value in calls[0]["headers"].items()}
assert calls[0]["url"] == "https://runtime.example/api/v1/run/models%2Fprivate%20artifact.kolm"
assert headers["authorization"] == "Bearer " + api_key
assert json.loads(calls[0]["data"].decode("utf-8")) == {"prompt": "hello"}
assert out == {"text": "compiled answer", "receipt": {"cid": "cidv1:abc", "k_score": 0.98}}
assert llm.last_receipt["cid"] == "cidv1:abc"

def err_urlopen(req, timeout):
    body = json.dumps({
        "error": "bad key " + api_key + " and Bearer " + api_key + " and sk-super-secret-abcdef",
    }).encode("utf-8")
    raise HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(body))

adapter_mod._urllib_request.urlopen = err_urlopen
try:
    llm.invoke_with_receipt("hello")
    raise AssertionError("HTTPError should fail")
except RuntimeError as exc:
    message = str(exc)
    assert "kolm http 401:" in message
    assert "secret_abcdef" not in message
    assert "Bearer ks_live" not in message
    assert "sk-super-secret" not in message
    assert "[redacted]" in message

def plain_urlopen(req, timeout):
    return Response(b"plain answer")

adapter_mod._urllib_request.urlopen = plain_urlopen
plain = KolmLLM(base_url="https://runtime.example").invoke_with_receipt("hello")
assert plain == {"text": "plain answer", "receipt": None}
`);
  }
});

test('W693 Python adapters preserve subprocess receipts and cap stderr failures', () => {
  for (const adapter of ADAPTERS) {
    runPython(adapter, py`
import json
import os
import pathlib
import sys
import tempfile
from ${adapter.module} import KolmLLM

script = """
import json
import sys

prompt = sys.stdin.read()
artifact = sys.argv[1]
if artifact == "bad-artifact":
    sys.stderr.write("bad ks_live_subprocess_secret_abcdef123456 " + ("x" * 20000))
    sys.exit(7)
sys.stdout.write(json.dumps({
    "text": "stdin:" + prompt,
    "receipt": {"artifact": artifact, "json": "--json" in sys.argv},
}))
"""

with tempfile.TemporaryDirectory(prefix="kolm-python-adapter-") as tmp:
    cwd = os.getcwd()
    os.chdir(tmp)
    try:
        pathlib.Path("run").write_text(script, encoding="utf-8")
        llm = KolmLLM(artifact_path="local-artifact.kolm", bin_path=sys.executable, timeout_s=5)
        out = llm.invoke_with_receipt("hello subprocess")
        assert out == {
            "text": "stdin:hello subprocess",
            "receipt": {"artifact": "local-artifact.kolm", "json": True},
        }
        assert llm.last_receipt["artifact"] == "local-artifact.kolm"

        failing = KolmLLM(artifact_path="bad-artifact", bin_path=sys.executable, timeout_s=5)
        try:
            failing.invoke_with_receipt("hello")
            raise AssertionError("failing subprocess should raise")
        except RuntimeError as exc:
            message = str(exc)
            assert "kolm run exited 7:" in message
            assert len(message) < 8400
            assert "secret_abcdef" not in message
            assert "[redacted]" in message
    finally:
        os.chdir(cwd)
`);
  }
});

test('W693 LlamaIndex chat path normalizes roles and carries receipt metadata', () => {
  const adapter = ADAPTERS.find((candidate) => candidate.name === 'llamaindex');
  runPython(adapter, py`
import json
import os
import pathlib
import sys
import tempfile
from kolm_llamaindex import KolmLLM

script = """
import json
import sys

prompt = sys.stdin.read()
sys.stdout.write(json.dumps({
    "text": prompt,
    "receipt": {"artifact": sys.argv[1], "json": "--json" in sys.argv},
}))
"""

with tempfile.TemporaryDirectory(prefix="kolm-llamaindex-chat-") as tmp:
    cwd = os.getcwd()
    os.chdir(tmp)
    try:
        pathlib.Path("run").write_text(script, encoding="utf-8")
        llm = KolmLLM(artifact_path="chat-artifact.kolm", bin_path=sys.executable, context_window="bad")
        assert llm.metadata["context_window"] == 4096
        response = llm.chat([
            {"role": "system", "content": "Be concise."},
            {"role": "hacker", "content": "Escalate."},
        ])
        assert response["message"]["content"] == "SYSTEM: Be concise.\\n\\nUSER: Escalate."
        assert response["raw"]["receipt"]["artifact"] == "chat-artifact.kolm"
    finally:
        os.chdir(cwd)
`);
});

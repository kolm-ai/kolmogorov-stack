// W654 - direct contract/security test for services/mcp/server.js.
//
// The local MCP server is the agent-facing package-distribution boundary for
// compiled .kolm tools. Exercise real signed fixtures and JSON-RPC behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';

import {
  createMcpHttpServer,
  handleRpc,
  hashJson,
  listTools,
  safeToolSegment,
} from '../services/mcp/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const TARGET = 'services/mcp/server.js';

function makeWorkspace() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-mcp-w654-'));
  const home = path.join(tmp, '.kolm-home');
  const globalArtifacts = path.join(home, 'artifacts');
  const project = path.join(tmp, 'project');
  const projectArtifacts = path.join(project, 'artifacts');
  fs.mkdirSync(globalArtifacts, { recursive: true });
  fs.mkdirSync(projectArtifacts, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'redactor.kolm'), path.join(globalArtifacts, 'redact pii!!.kolm'));
  fs.copyFileSync(path.join(FIXTURES, 'redactor.kolm'), path.join(projectArtifacts, 'assist tool!!.kolm'));
  fs.writeFileSync(path.join(project, 'kolm.yaml'), [
    'name: Team Alpha/../../Root',
    'description: Project scoped MCP tools',
    'k_min: 0',
    'artifacts:',
    '  - path: ./artifacts/assist tool!!.kolm',
    '    description: Project helper',
    '    paths: [src/**/*.js]',
    '    allowed_tools: [run]',
    '',
  ].join('\n'));
  return { tmp, home, globalArtifacts, project };
}

function setIsolatedHome(home) {
  process.env.KOLM_HOME = home;
  process.env.KOLM_DATA_DIR = home;
}

function readRunLogs(home) {
  const p = path.join(home, 'logs', 'runs.jsonl');
  return fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

function httpRequest(port, method, route, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method,
      headers: body == null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

test('W654 mcp server lists sanitized local/project tools without leaking _kolm metadata', async () => {
  assert.equal(TARGET, 'services/mcp/server.js');
  const src = fs.readFileSync(path.join(ROOT, TARGET), 'utf8');
  assert.match(src, /export async function handleRpc/);
  assert.match(src, /createMcpHttpServer/);

  const ws = makeWorkspace();
  setIsolatedHome(ws.home);
  const ctx = { artifactsDir: ws.globalArtifacts, projectCwd: ws.project };

  assert.equal(hashJson({ b: 1, a: 2 }), hashJson({ a: 2, b: 1 }), 'run-log hashes must be canonical');
  assert.match(safeToolSegment('Team Alpha/../../Root'), /^[a-zA-Z0-9_-]+$/);

  const internal = listTools(ctx);
  assert.ok(internal.some((t) => t.name === 'redact_pii'), 'global artifact is discoverable with sanitized name');
  const projectTool = internal.find((t) => t.name.startsWith('mcp__'));
  assert.ok(projectTool, 'project artifact is discoverable');
  assert.match(projectTool.name, /^mcp__[a-zA-Z0-9_-]+__assist_tool$/);
  assert.ok(projectTool._kolm.artifact_path.endsWith(path.join('artifacts', 'assist tool!!.kolm')));

  const listed = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx);
  assert.equal(listed.id, 1);
  assert.equal(Array.isArray(listed.result.tools), true);
  const wireProject = listed.result.tools.find((t) => t.name === projectTool.name);
  assert.ok(wireProject);
  assert.equal('_kolm' in wireProject, false, 'wire tools/list must strip private metadata');
  assert.deepEqual(wireProject.inputSchema.required, ['input']);
});

test('W654 mcp server tools/call runs a signed fixture and logs only stable hashes', async () => {
  const ws = makeWorkspace();
  setIsolatedHome(ws.home);
  const ctx = { artifactsDir: ws.globalArtifacts, projectCwd: ws.project };
  const input = { text: 'mail me at foo@example.com' };
  const params = { extra_patterns: [{ name: 'EMAIL2', regex: 'foo@example\\.com', replacement: '[EMAIL]' }] };

  const res = await handleRpc({
    jsonrpc: '2.0',
    id: 'call-1',
    method: 'tools/call',
    params: { name: 'redact_pii', arguments: { input, params } },
  }, ctx);

  assert.equal(res.id, 'call-1');
  assert.equal(res.error, undefined);
  assert.match(res.result.content[0].text, /redacted/);
  assert.equal(res.result._kolm.receipt.spec, 'rs-1-run');

  const logText = fs.readFileSync(path.join(ws.home, 'logs', 'runs.jsonl'), 'utf8');
  assert.doesNotMatch(logText, /foo@example\.com/, 'run logs must not persist raw input');
  assert.doesNotMatch(logText, /EMAIL2/, 'run logs must not persist raw tenant params');

  const rows = readRunLogs(ws.home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].surface, 'mcp');
  assert.equal(rows[0].tool, 'redact_pii');
  assert.equal(rows[0].input_hash, hashJson(input));
  assert.equal(rows[0].params_hash, hashJson(params));
  assert.match(rows[0].output_hash, /^[0-9a-f]{64}$/);

  const missing = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'missing' } }, ctx);
  assert.equal(missing.error.code, -32602);
  assert.match(missing.error.message, /no such tool/);
});

test('W654 mcp HTTP transport returns JSON-RPC envelopes for health, parse errors, and size limits', async () => {
  const ws = makeWorkspace();
  setIsolatedHome(ws.home);
  const server = createMcpHttpServer({ artifactsDir: ws.globalArtifacts, projectCwd: ws.project });
  const port = await listen(server);
  try {
    const health = await httpRequest(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.ok(health.json.tools >= 2);

    const init = await httpRequest(port, 'POST', '/mcp', JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize' }));
    assert.equal(init.status, 200);
    assert.equal(init.json.id, 7);
    assert.equal(init.json.result.protocolVersion, '2024-11-05');

    const bad = await httpRequest(port, 'POST', '/mcp', '{bad json');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.jsonrpc, '2.0');
    assert.equal(bad.json.error.code, -32700);

    const huge = await httpRequest(port, 'POST', '/mcp', 'x'.repeat(1024 * 1024 + 1));
    assert.equal(huge.status, 413);
    assert.equal(huge.json.jsonrpc, '2.0');
    assert.equal(huge.json.error.code, -32600);
    assert.match(huge.json.error.message, /too large/);
  } finally {
    await closeServer(server);
  }
});

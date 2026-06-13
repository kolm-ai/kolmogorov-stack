import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { killAndWait, rmSyncBestEffort } from './_spawn-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, retries = 100) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) return;
    } catch {} // deliberate: cleanup
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not come up: ' + base);
}

async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

test('compiler-first product contract covers public catalog, signup, and account overview', async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = path.join(os.tmpdir(), `kolm-compiler-contract-${process.pid}-${Date.now()}`);
  rmSyncBestEffort(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => rmSyncBestEffort(dataDir));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: '',
      RESEND_API_KEY: '',
      KOLM_DATA_DIR: dataDir,
      KOLM_STORE_DRIVER: 'json',
      KOLM_REATTEST_DISABLE: '1',
      KOLM_BACKUP_DISABLE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (data) => process.stderr.write(data));
  t.after(() => killAndWait(child));

  await waitForHealth(base);

  const caps = await jsonFetch(base + '/v1/product/capabilities');
  assert.equal(caps.res.status, 200);
  assert.equal(caps.body.ok, true);
  assert.equal(caps.body.product, 'kolm AI compiler');
  assert.deepEqual(caps.body.primary_surfaces.map((s) => s.id), ['capture', 'compile', 'compose', 'deploy']);
  assert.equal(caps.body.secondary_surfaces[0].id, 'audit');
  assert.equal(caps.body.account_surfaces[0].id, 'api-control-center');
  assert.equal(caps.body.account_surfaces[0].api, '/v1/account/api-control-center');
  assert.match(caps.body.positioning, /API collection wrapper/i);
  assert.equal(caps.body.competitive_research.unique_mapped_players, 293);
  assert.equal(caps.body.competitive_research.public_copy_count, '290+');
  assert.equal(caps.body.competitive_research.clusters, 17);
  assert.equal(caps.body.api_control_coverage.data_channel_families, 17);
  assert.equal(caps.body.api_control_coverage.policy_layers, 8);
  assert.equal(caps.body.api_control_coverage.api, '/v1/account/api-control-center');

  const graph = await jsonFetch(base + '/v1/product/graph');
  assert.equal(graph.res.status, 200);
  assert.equal(graph.body.ok, true);
  assert.equal(graph.body.data.graph.counts.routes, 922);
  assert.equal(graph.body.data.graph.counts.route_surfaces, 7);
  assert.equal(graph.body.data.secret_values_included, false);

  const plans = await jsonFetch(base + '/v1/plans');
  assert.equal(plans.res.status, 200);
  assert.equal(plans.body.product, 'kolm AI compiler');
  assert.ok(plans.body.plans.some((p) => p.id === 'pro' && p.product === 'compiler'));
  const free = plans.body.plans.find((p) => p.id === 'free');
  assert.equal(free.audit_module.primary, false);
  assert.equal(free.billing_unit, 'gateway calls plus compile credits');

  const email = `compiler-contract-${Date.now()}@example.com`;
  const signup = await jsonFetch(base + '/v1/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, plan: 'pro' }),
  });
  assert.ok([200, 201].includes(signup.res.status), 'signup should create or return a tenant');
  assert.equal(signup.body.ok, true);
  assert.equal(signup.body.product, 'kolm AI compiler');
  assert.match(signup.body.api_key, /^ks_/);
  assert.equal(signup.body.onboarding.primary_surface, 'compiler');
  assert.equal(signup.body.onboarding.dashboard_url, '/account/overview');
  assert.ok(signup.body.onboarding.routes.compile.includes('/v1/compile'));
  assert.match(signup.body.message, /compiler/i);

  const overview = await jsonFetch(base + '/v1/account/compiler-overview', {
    headers: { authorization: 'Bearer ' + signup.body.api_key },
  });
  assert.equal(overview.res.status, 200);
  assert.equal(overview.body.ok, true);
  assert.equal(overview.body.product, 'kolm AI compiler');
  assert.equal(overview.body.version, 'kolm-compiler-overview-1');
  assert.ok(overview.body.primary_surfaces.some((s) => s.id === 'compile' && s.routes.includes('/v1/compile')));
  assert.equal(overview.body.secondary_surfaces[0].host, 'audit.kolm.ai');
  assert.match(overview.body.empty_state.curl, /\/v1\/route\/chat\/completions/);

  const control = await jsonFetch(base + '/v1/account/api-control-center', {
    headers: { authorization: 'Bearer ' + signup.body.api_key },
  });
  assert.equal(control.res.status, 200);
  assert.equal(control.body.ok, true);
  assert.equal(control.body.version, 'kolm-api-control-center-4');
  assert.equal(control.body.product, 'kolm AI compiler');
  assert.equal(control.body.secret_values_included, false);
  assert.equal(control.body.posture.default_egress_mode, 'deny-until-provider-or-destination-is-declared');
  const channelIds = control.body.coverage.data_channels.map((c) => c.id);
  assert.deepEqual(channelIds, [
    'rest-json',
    'streaming',
    'webhooks',
    'batch-jsonl',
    'otel',
    'mcp',
    'a2a',
    'browser-events',
    'file-blob',
    'custom-adapter',
    'graphql-rpc',
    'message-queues',
    'warehouse-lakehouse',
    'database-cdc',
    'siem-log-drain',
    'collab-ticketing',
    'registry-packages',
  ]);
  for (const channel of control.body.coverage.data_channels) {
    assert.ok(channel.directions.length >= 1, `${channel.id} should declare data direction`);
    assert.ok(channel.styles.length >= 1, `${channel.id} should declare data styles`);
    assert.ok(channel.controls.length >= 1, `${channel.id} should declare controls`);
  }
  assert.equal(control.body.coverage.collection_modes.length, 12);
  assert.equal(control.body.coverage.export_modes.length, 10);
  assert.equal(control.body.coverage.governance_stages.length, 8);
  assert.ok(control.body.coverage.collection_modes.some((m) => m.id === 'custom-observe' && m.direction === 'ingress'));
  assert.ok(control.body.coverage.export_modes.some((m) => m.id === 'governance-packet' && m.direction === 'egress'));
  assert.deepEqual(control.body.coverage.governance_stages.map((s) => s.id), [
    'accept',
    'classify',
    'redact',
    'route',
    'evaluate',
    'compile',
    'target',
    'export',
  ]);
  assert.match(control.body.operational_contract.unknown_schema_rule, /opaque events/i);
  assert.match(control.body.operational_contract.egress_rule, /declared/i);
  assert.ok(control.body.coverage.protocols.includes('MCP'));
  assert.ok(control.body.coverage.protocols.includes('A2A'));
  assert.ok(control.body.coverage.protocols.includes('GraphQL'));
  assert.ok(control.body.coverage.protocols.includes('Kafka/event stream'));
  assert.ok(control.body.coverage.protocols.includes('warehouse/lakehouse'));
  assert.ok(control.body.coverage.lifecycle_states.includes('compile'));
  assert.ok(control.body.integration_map.some((c) => c.cluster === 'Data movement and event streams'));
  assert.ok(control.body.integration_map.some((c) => c.cluster === 'Runtime and package targets'));
  assert.ok(control.body.enterprise_controls.some((c) => c.id === 'provider-vault'));
  assert.ok(control.body.enterprise_controls.some((c) => c.id === 'egress-policy'));
  assert.equal(control.body.closed_loop_improvement.status, 'readiness-gated');
  assert.match(control.body.closed_loop_improvement.summary, /Captured API failures/);
  assert.ok(control.body.closed_loop_improvement.minimum_inputs.includes('judged failures'));
  assert.ok(control.body.closed_loop_improvement.minimum_inputs.includes('protected regression set'));
  assert.ok(control.body.closed_loop_improvement.promotion_gates.includes('no protected-slice degradation'));
  assert.ok(control.body.closed_loop_improvement.promotion_gates.includes('declared egress destination'));
  assert.deepEqual(control.body.closed_loop_improvement.stages.map((s) => s.id), [
    'observe-failures',
    'taxonomize',
    'build-curriculum',
    'replay-regression',
    'compile-artifact',
    'promote-export',
  ]);
  for (const stage of control.body.closed_loop_improvement.stages) {
    assert.ok(stage.trigger, `${stage.id} should declare the trigger`);
    assert.ok(stage.evidence, `${stage.id} should declare evidence`);
    assert.ok(stage.output, `${stage.id} should declare the output`);
    assert.ok(stage.gate, `${stage.id} should declare the promotion gate`);
  }
  assert.equal(control.body.operator_workbench.label, 'Operator workbench');
  assert.match(control.body.operator_workbench.summary, /source declaration to policy gates/);
  assert.match(control.body.operator_workbench.source_to_proof_rule, /source, policy gate, output object, and verifier path/);
  assert.deepEqual(control.body.operator_workbench.next_actions.map((s) => s.id), [
    'declare-source-schema',
    'set-egress-policy',
    'diagnose-failure-loop',
    'compile-target-receipt',
    'export-governance-packet',
  ]);
  assert.ok(control.body.operator_workbench.intake_priorities.includes('OpenTelemetry/GenAI spans'));
  assert.ok(control.body.operator_workbench.intake_priorities.includes('custom opaque adapters'));
  assert.ok(control.body.operator_workbench.export_priorities.includes('governance packet'));
  assert.ok(control.body.operator_workbench.export_priorities.includes('runtime target recipe'));
  assert.ok(control.body.operator_workbench.competitive_pressure.some((x) => /gateways now normalize/.test(x)));
  for (const step of control.body.operator_workbench.next_actions) {
    assert.ok(step.trigger, `${step.id} should declare trigger`);
    assert.ok(step.action, `${step.id} should declare operator action`);
    assert.ok(step.proof, `${step.id} should declare proof`);
    assert.ok(step.route, `${step.id} should declare route`);
  }
  assert.equal(control.body.recommended_ui.route, '/account/api-control-center');
});

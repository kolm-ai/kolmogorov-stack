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
  assert.equal(caps.body.product_research.mapped_inputs, 293);
  assert.equal(caps.body.product_research.public_copy_rule, 'first-party Kolm positioning only');
  assert.equal(caps.body.product_research.clusters, 17);
  assert.equal(caps.body.api_control_coverage.data_channel_families, 17);
  assert.equal(caps.body.api_control_coverage.policy_layers, 8);
  assert.equal(caps.body.api_control_coverage.api, '/v1/account/api-control-center');

  const graph = await jsonFetch(base + '/v1/product/graph');
  assert.equal(graph.res.status, 200);
  assert.equal(graph.body.ok, true);
  assert.equal(graph.body.data.graph.counts.routes, 929);
  assert.equal(graph.body.data.graph.counts.route_surfaces, 7);
  assert.equal(graph.body.data.secret_values_included, false);

  const plans = await jsonFetch(base + '/v1/plans');
  assert.equal(plans.res.status, 200);
  assert.equal(plans.body.product, 'kolm AI compiler');
  assert.ok(plans.body.plans.some((p) => p.id === 'pro' && p.product === 'compiler'));
  const free = plans.body.plans.find((p) => p.id === 'free');
  assert.equal(free.audit_module.primary, false);
  assert.equal(free.billing_unit, 'gateway calls plus compile credits');

  const proEstimate = await jsonFetch(base + '/v1/pricing/estimate?gateway_calls=500000&compile_credits=50&seats=1');
  assert.equal(proEstimate.res.status, 200);
  assert.equal(proEstimate.body.ok, true);
  assert.equal(proEstimate.body.product, 'kolm AI compiler');
  assert.equal(proEstimate.body.source, 'PLAN_CATALOG');
  assert.equal(proEstimate.body.recommended_plan_id, 'pro');
  assert.equal(proEstimate.body.recommended_plan.price_label, '$49/mo');
  assert.equal(proEstimate.body.secret_values_included, false);
  assert.ok(proEstimate.body.reasons.some((r) => /500,000 gateway calls/.test(r)));
  assert.equal(proEstimate.body.next_step.href, '/signup?plan=pro');

  const businessEstimate = await jsonFetch(base + '/v1/pricing/estimate?gateway_calls=25000000&compile_credits=200&seats=20&controls=governed&sso=true');
  assert.equal(businessEstimate.res.status, 200);
  assert.equal(businessEstimate.body.recommended_plan_id, 'business');
  assert.equal(businessEstimate.body.recommended_plan.price_label, '$499/mo');
  assert.ok(businessEstimate.body.reasons.some((r) => /Business or higher/.test(r)));

  const enterpriseEstimate = await jsonFetch(base + '/v1/pricing/estimate?gateway_calls=1000000&compile_credits=25&seats=4&private_deployment=true');
  assert.equal(enterpriseEstimate.res.status, 200);
  assert.equal(enterpriseEstimate.body.recommended_plan_id, 'enterprise');
  assert.equal(enterpriseEstimate.body.recommended_plan.contact_sales, true);
  assert.match(enterpriseEstimate.body.next_step.href, /^mailto:/);
  assert.equal(enterpriseEstimate.body.readiness_boundary.production_final, false);

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
  assert.equal(control.body.version, 'kolm-api-control-center-7');
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
  assert.equal(control.body.operational_contract.universal_intake_route, 'POST /v1/account/api-control-center/events');
  assert.match(control.body.operational_contract.universal_intake_rule, /canonical control-event envelope/i);
  assert.equal(control.body.operational_contract.adapter_manifest_route, 'POST /v1/account/api-control-center/adapter-manifests/validate');
  assert.match(control.body.operational_contract.adapter_manifest_rule, /semantic understanding is promoted only/i);
  assert.equal(control.body.operational_contract.export_declaration_route, 'POST /v1/account/api-control-center/exports');
  assert.equal(control.body.operational_contract.export_declaration_list_route, 'GET /v1/account/api-control-center/exports');
  assert.match(control.body.operational_contract.export_declaration_rule, /delivery-ledger declarations/i);
  assert.ok(control.body.coverage.protocols.includes('MCP'));
  assert.ok(control.body.coverage.protocols.includes('A2A'));
  assert.ok(control.body.coverage.protocols.includes('GraphQL'));
  assert.ok(control.body.coverage.protocols.includes('Kafka/event stream'));
  assert.ok(control.body.coverage.protocols.includes('warehouse/lakehouse'));
  assert.ok(control.body.coverage.lifecycle_states.includes('compile'));
  assert.ok(control.body.coverage.first_class_objects.some((g) => g.group === 'Traffic and traces' && g.objects.includes('tool call')));
  assert.ok(control.body.coverage.first_class_objects.some((g) => g.group === 'Artifacts and exports' && g.objects.includes('governance packet')));
  assert.deepEqual(control.body.coverage.adapter_states.map((s) => s.id), [
    'opaque',
    'schema-hinted',
    'manifest-declared',
    'native-connector',
    'verified-runtime-target',
  ]);
  assert.equal(control.body.coverage.adapter_states[0].semantic_claim, 'none');
  assert.match(control.body.coverage.adapter_states[0].operator_action, /block semantic dashboards/);
  assert.equal(control.body.coverage.event_envelope.version, 'kolm-control-event-envelope-1');
  assert.ok(control.body.coverage.event_envelope.required_fields.includes('policy_decision_id'));
  assert.ok(control.body.coverage.event_envelope.required_fields.includes('receipt_id'));
  assert.ok(control.body.coverage.event_envelope.optional_links.includes('compile_run_id'));
  assert.ok(control.body.coverage.event_envelope.invariants.some((x) => /unknown vendor fields remain opaque/.test(x)));
  assert.ok(control.body.coverage.egress_destination_recipes.some((r) => r.id === 'governance-grc' && r.declarations_required.includes('open readiness gates')));
  assert.ok(control.body.coverage.egress_destination_recipes.some((r) => r.id === 'package-runtime' && /signed artifact receipt/.test(r.receipt)));
  assert.ok(control.body.coverage.readiness_scoreboard.some((r) => r.id === 'artifact-release' && r.status === 'needs_package_release'));
  assert.ok(control.body.coverage.readiness_scoreboard.some((r) => r.id === 'certifications' && r.status === 'needs_live_certification'));
  assert.ok(control.body.integration_map.some((c) => c.cluster === 'Data movement and event streams'));
  assert.ok(control.body.integration_map.some((c) => c.cluster === 'Runtime and package targets'));
  assert.ok(control.body.enterprise_controls.some((c) => c.id === 'provider-vault'));
  assert.ok(control.body.enterprise_controls.some((c) => c.id === 'egress-policy'));
  assert.ok(control.body.enterprise_controls.some((c) => c.routes.includes('/v1/account/api-control-center/events')));
  assert.ok(control.body.enterprise_controls.some((c) => c.routes.includes('/v1/account/api-control-center/exports')));
  assert.ok(control.body.enterprise_controls.some((c) => c.routes.includes('/v1/account/api-control-center/adapter-manifests/validate')));
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
  assert.ok(control.body.operator_workbench.market_pressure.some((x) => /gateways now normalize/.test(x)));
  for (const step of control.body.operator_workbench.next_actions) {
    assert.ok(step.trigger, `${step.id} should declare trigger`);
    assert.ok(step.action, `${step.id} should declare operator action`);
    assert.ok(step.proof, `${step.id} should declare proof`);
    assert.ok(step.route, `${step.id} should declare route`);
  }
  assert.equal(control.body.recommended_ui.route, '/account/api-control-center');

  const intake = await jsonFetch(base + '/v1/account/api-control-center/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signup.body.api_key },
    body: JSON.stringify({
      source_id: 'salesforce.case.updated',
      channel_family: 'webhooks',
      direction: 'ingress',
      schema: { type: 'object', required: ['case_id', 'summary'] },
      payload: {
        case_id: 'CASE-100',
        summary: 'Need refund for ops@example.com',
        priority: 'high',
      },
      retention_class: 'tenant-default',
      trace_id: 'trace_control_contract',
    }),
  });
  assert.equal(intake.res.status, 201);
  assert.equal(intake.body.ok, true);
  assert.equal(intake.body.secret_values_included, false);
  assert.equal(intake.body.control_event_envelope.version, 'kolm-control-event-envelope-1');
  assert.equal(intake.body.control_event_envelope.source_id, 'salesforce.case.updated');
  assert.equal(intake.body.control_event_envelope.channel_family, 'webhooks');
  assert.equal(intake.body.control_event_envelope.direction, 'ingress');
  assert.equal(intake.body.control_event_envelope.schema_status, 'schema-hinted');
  assert.equal(intake.body.control_event_envelope.secret_values_included, false);
  assert.deepEqual(intake.body.control_event_envelope.required_field_status.missing, []);
  assert.equal(intake.body.control_event_envelope.optional_links.trace_id, 'trace_control_contract');
  assert.match(intake.body.control_event_envelope.receipt_id, /^rcpt_/);
  assert.match(intake.body.persisted.redaction_result, /^redacted:/);
  assert.ok(intake.body.universal_intake.accepted_shapes.includes('payload'));
  assert.doesNotMatch(JSON.stringify(intake.body), /ops@example\.com/);

  const manifest = await jsonFetch(base + '/v1/account/api-control-center/adapter-manifests/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signup.body.api_key },
    body: JSON.stringify({
      adapter_manifest: {
        id: 'salesforce-case-webhook',
        version: '2026.06.13',
        channel_family: 'webhooks',
        direction: 'ingress',
        input_schema: {
          type: 'object',
          properties: {
            case_id: { type: 'string' },
            summary: { type: 'string' },
            priority: { type: 'string' },
          },
        },
        redaction_map: ['summary', 'customer_email'],
        egress_destinations: [{ id: 'governance-packet', type: 'grc' }],
        test_fixture: {
          payload: {
            case_id: 'CASE-100',
            summary: 'Need refund for ops@example.com',
          },
        },
      },
    }),
  });
  assert.equal(manifest.res.status, 200);
  assert.equal(manifest.body.ok, true);
  assert.equal(manifest.body.secret_values_included, false);
  assert.equal(manifest.body.adapter_manifest_validation.version, 'kolm-adapter-manifest-validation-1');
  assert.equal(manifest.body.adapter_manifest_validation.adapter_state, 'manifest-declared');
  assert.equal(manifest.body.adapter_manifest_validation.semantic_claim, 'adapter-owned field mapping');
  assert.deepEqual(manifest.body.adapter_manifest_validation.required_evidence.missing, []);
  assert.ok(manifest.body.adapter_manifest_validation.normalized_manifest.input_fields.includes('case_id'));
  assert.ok(manifest.body.adapter_manifest_validation.normalized_manifest.redaction_fields.includes('customer_email'));
  assert.match(manifest.body.adapter_manifest_validation.receipt_id, /^rcpt_adapter_/);
  assert.equal(manifest.body.adapter_manifest_validation.fixture_redaction.secret_values_included, false);
  assert.doesNotMatch(JSON.stringify(manifest.body), /ops@example\.com/);

  const exportDeclaration = await jsonFetch(base + '/v1/account/api-control-center/exports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signup.body.api_key },
    body: JSON.stringify({
      export_mode: 'governance-packet',
      destination_class: 'governance-grc',
      destination: { id: 'grc-evidence-vault', type: 'governance-grc', system: 'assurance-case' },
      processor: 'security-review',
      payload_class: 'governance_packet',
      redaction_mode: 'redacted-fields-only',
      evidence: {
        summary: 'Need refund for ops@example.com',
        control: 'egress-policy',
        open_readiness_gates: ['certifications'],
      },
      namespace: 'prod-ai-loop',
      governance_packet_id: 'gp_control_contract',
    }),
  });
  assert.equal(exportDeclaration.res.status, 201);
  assert.equal(exportDeclaration.body.ok, true);
  assert.equal(exportDeclaration.body.secret_values_included, false);
  assert.equal(exportDeclaration.body.delivery_ledger.version, 'kolm-delivery-ledger-1');
  assert.equal(exportDeclaration.body.delivery_ledger.status, 'declared_not_delivered');
  assert.equal(exportDeclaration.body.delivery_ledger.destination.class, 'governance-grc');
  assert.equal(exportDeclaration.body.delivery_ledger.export_mode, 'governance-packet');
  assert.equal(exportDeclaration.body.delivery_ledger.redaction_mode, 'redacted-fields-only');
  assert.match(exportDeclaration.body.delivery_ledger.receipt_id, /^rcpt_export_/);
  assert.equal(exportDeclaration.body.delivery_ledger.control_event_envelope.direction, 'egress');
  assert.equal(exportDeclaration.body.delivery_ledger.control_event_envelope.optional_links.export_job_id, exportDeclaration.body.delivery_ledger.export_id);
  assert.equal(exportDeclaration.body.delivery_ledger.control_event_envelope.optional_links.governance_packet_id, 'gp_control_contract');
  assert.equal(exportDeclaration.body.persisted.delivery_status, 'declared_not_delivered');
  assert.doesNotMatch(JSON.stringify(exportDeclaration.body), /ops@example\.com/);

  const exportList = await jsonFetch(base + '/v1/account/api-control-center/exports', {
    headers: { authorization: 'Bearer ' + signup.body.api_key },
  });
  assert.equal(exportList.res.status, 200);
  assert.equal(exportList.body.ok, true);
  assert.ok(exportList.body.exports.some((row) => row.delivery_ledger.export_id === exportDeclaration.body.delivery_ledger.export_id));
  assert.doesNotMatch(JSON.stringify(exportList.body), /ops@example\.com/);

  const exportDetail = await jsonFetch(base + '/v1/account/api-control-center/exports/' + exportDeclaration.body.delivery_ledger.export_id, {
    headers: { authorization: 'Bearer ' + signup.body.api_key },
  });
  assert.equal(exportDetail.res.status, 200);
  assert.equal(exportDetail.body.export.delivery_ledger.receipt_id, exportDeclaration.body.delivery_ledger.receipt_id);

  const missingExport = await jsonFetch(base + '/v1/account/api-control-center/exports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signup.body.api_key },
    body: JSON.stringify({ export_mode: 'governance-packet' }),
  });
  assert.equal(missingExport.res.status, 422);
  assert.equal(missingExport.body.ok, false);
  assert.equal(missingExport.body.delivery_ledger.status, 'missing_declarations');
  assert.ok(missingExport.body.delivery_ledger.required_declarations.missing.includes('destination'));
  assert.ok(missingExport.body.delivery_ledger.required_declarations.missing.includes('processor'));
  assert.equal(missingExport.body.secret_values_included, false);

  const missingManifest = await jsonFetch(base + '/v1/account/api-control-center/adapter-manifests/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signup.body.api_key },
    body: JSON.stringify({
      adapter_manifest: {
        id: 'partial-webhook',
        channel_family: 'webhooks',
        input_schema: { type: 'object', properties: { id: { type: 'string' } } },
      },
    }),
  });
  assert.equal(missingManifest.res.status, 422);
  assert.equal(missingManifest.body.ok, false);
  assert.ok(missingManifest.body.adapter_manifest_validation.required_evidence.missing.includes('adapter_version'));
  assert.ok(missingManifest.body.adapter_manifest_validation.required_evidence.missing.includes('egress_destinations'));
  assert.equal(missingManifest.body.secret_values_included, false);
});

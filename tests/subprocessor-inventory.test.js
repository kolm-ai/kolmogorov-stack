// Agent Security-Review audit - Sub-Processor Inventory lock-in tests (Offer #8).
//
// Pins src/subprocessor-inventory.js: an empty audit result yields empty arrays
// plus an untested-style bounding caveat (never a silent "no sub-processors"
// claim); a realistic result yields a deduped, deterministically sorted
// inventory with per-host call counts and sensitivity flags; and two builds over
// the same input are byte-identical so the inventory is safe to fold into the
// signed report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSubprocessorInventory } from '../src/subprocessor-inventory.js';

// A realistic-ish audit result projection: only the sub-objects this module
// reads. Casing is intentionally mixed to exercise case-insensitive dedup.
function sampleResult() {
  return {
    spec_version: 'audit/2',
    evidence_tier: { grade: 'B' },
    model_provenance: {
      models: [
        { slug: 'gpt-4o-2024-08-06', pinned: true, provider: 'openai', calls: 5, hosts: ['api.openai.com'] },
        { slug: 'GPT-4o-2024-08-06', pinned: true, provider: 'OpenAI', calls: 2, hosts: ['api.openai.com'] },
        { slug: 'claude-opus-4', pinned: true, provider: 'anthropic', calls: 3, hosts: ['api.anthropic.com'] },
      ],
      providers: [
        { name: 'OpenAI', calls: 7, models: 1, pinned: 1, unpinned: 0 },
        { name: 'anthropic', calls: 3, models: 1, pinned: 1, unpinned: 0 },
        { name: 'openrouter', calls: 4, models: 2, pinned: 1, unpinned: 1 },
      ],
      mcp_servers: [
        { name: 'github', calls: 2, pinned: false },
        { name: 'GitHub', calls: 1, pinned: false },
      ],
    },
    egress: {
      destinations: [
        { host: 'api.openai.com', calls: 7, sensitive_calls: 0, secret_calls: 0 },
        { host: 'API.OpenAI.com', calls: 1, sensitive_calls: 1, secret_calls: 0 },
        { host: 'hooks.slack.com', calls: 3, sensitive_calls: 0, secret_calls: 2 },
        { host: 'api.anthropic.com', calls: 3, sensitive_calls: 0, secret_calls: 0 },
      ],
    },
    ingest: { stats: { distinct_hosts: 5 }, distinct_hosts: 5 },
  };
}

test('empty input -> empty arrays + untested-style caveat', () => {
  const inv = buildSubprocessorInventory({});
  assert.deepEqual(inv.models, []);
  assert.deepEqual(inv.providers, []);
  assert.deepEqual(inv.mcp_servers, []);
  assert.deepEqual(inv.hosts, []);
  assert.deepEqual(inv.counts, {
    models: 0,
    providers: 0,
    mcp_servers: 0,
    hosts: 0,
    sensitive_hosts: 0,
  });
  assert.equal(inv.spec_version, 'subproc-inventory/1');
  // The bounding caveat is always present, plus an untested-style caveat.
  assert.ok(inv.caveats.some((c) => /supplied (audit )?window only/i.test(c)));
  assert.ok(inv.caveats.some((c) => /untested/i.test(c)));
  // Never a clean "no sub-processors" claim.
  assert.ok(!inv.caveats.some((c) => /no sub-processors/i.test(c)));
});

test('fully absent argument is tolerated (never throws)', () => {
  const inv = buildSubprocessorInventory(undefined);
  assert.equal(inv.counts.models, 0);
  assert.equal(inv.generated_from.spec_version, null);
  assert.equal(inv.generated_from.evidence_tier, null);
});

test('realistic result -> deduped, sorted inventory with host flags', () => {
  const inv = buildSubprocessorInventory(sampleResult());

  // Models deduped case-insensitively (gpt-4o + GPT-4o -> one), sorted by slug.
  // Display casing is chosen deterministically (smallest string form).
  assert.deepEqual(inv.models.map((m) => m.slug.toLowerCase()), ['claude-opus-4', 'gpt-4o-2024-08-06']);
  const gpt = inv.models.find((m) => m.slug.toLowerCase() === 'gpt-4o-2024-08-06');
  assert.equal(gpt.calls, 7); // 5 + 2 merged
  assert.equal(gpt.provider, 'openai');
  assert.equal(gpt.pinned, true);

  // Providers sorted; openrouter flagged as a gateway/routed provider.
  assert.deepEqual(inv.providers.map((p) => p.name.toLowerCase()), ['anthropic', 'openai', 'openrouter']);
  const orouter = inv.providers.find((p) => p.name.toLowerCase() === 'openrouter');
  assert.equal(orouter.gateway, true);
  assert.equal(inv.providers.find((p) => p.name.toLowerCase() === 'openai').gateway, false);

  // MCP servers deduped (github + GitHub -> one) with summed calls.
  assert.equal(inv.mcp_servers.length, 1);
  assert.equal(inv.mcp_servers[0].calls, 3);

  // Hosts deduped case-insensitively, sorted, with call counts and flags.
  assert.deepEqual(inv.hosts.map((h) => h.host.toLowerCase()), [
    'api.anthropic.com',
    'api.openai.com',
    'hooks.slack.com',
  ]);
  const openai = inv.hosts.find((h) => h.host.toLowerCase() === 'api.openai.com');
  assert.equal(openai.call_count, 8); // 7 + 1 merged
  assert.equal(openai.sensitivity_flag, true); // one merged row had sensitive_calls
  const slack = inv.hosts.find((h) => h.host.toLowerCase() === 'hooks.slack.com');
  assert.equal(slack.sensitivity_flag, true); // secret_calls > 0
  const anthropic = inv.hosts.find((h) => h.host.toLowerCase() === 'api.anthropic.com');
  assert.equal(anthropic.sensitivity_flag, false);

  // Counts reconcile.
  assert.equal(inv.counts.models, 2);
  assert.equal(inv.counts.providers, 3);
  assert.equal(inv.counts.mcp_servers, 1);
  assert.equal(inv.counts.hosts, 3);
  assert.equal(inv.counts.sensitive_hosts, 2);

  // generated_from is bound.
  assert.equal(inv.generated_from.spec_version, 'audit/2');
  assert.equal(inv.generated_from.evidence_tier, 'B');

  // Window-bounding caveat present; no untested caveat (we have evidence).
  assert.ok(inv.caveats.some((c) => /supplied (audit )?window only/i.test(c)));
  assert.ok(!inv.caveats.some((c) => /untested/i.test(c)));
  // distinct_hosts (5) > enumerated egress hosts (3) -> reconciliation caveat.
  assert.ok(inv.caveats.some((c) => /distinct host/i.test(c)));
});

test('deterministic: two builds over the same input are byte-identical', () => {
  const input = sampleResult();
  const a = buildSubprocessorInventory(input);
  const b = buildSubprocessorInventory(input);
  assert.equal(JSON.stringify(a), JSON.stringify(b));

  // And independent of source array order: shuffle the inputs, same output.
  const shuffled = sampleResult();
  shuffled.model_provenance.models.reverse();
  shuffled.model_provenance.providers.reverse();
  shuffled.egress.destinations.reverse();
  const c = buildSubprocessorInventory(shuffled);
  assert.equal(JSON.stringify(a), JSON.stringify(c));
});

// Agent Security-Review audit — AuditEvent schema lock-in tests.
//
// Pins the contract of src/audit-event.js: stable ids, scope tokenisation,
// privilege-tier classification, wildcard detection, and the never-throw
// normalizer the ingest layer and analyzers depend on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eventId,
  scopeToken,
  classifyScopeTier,
  isWildcardScope,
  normalizeEvent,
  normalizeEvents,
} from '../src/audit-event.js';

test('eventId is deterministic and 16 hex chars', () => {
  const a = eventId({ x: 1, y: 'z' });
  const b = eventId({ x: 1, y: 'z' });
  assert.equal(a, b, 'same input → same id');
  assert.match(a, /^[0-9a-f]{16}$/, 'id is 16 lowercase hex chars');
  assert.notEqual(a, eventId({ x: 2 }), 'different input → different id');
});

test('scopeToken derives resource:action form from an action', () => {
  assert.equal(scopeToken({ tool: 'Send_Email' }), 'tool:send_email');
  assert.equal(scopeToken({ host: 'API.X.com', method: 'GET' }), 'api.x.com:get');
  assert.equal(scopeToken({ host: 'api.x.com' }), 'api.x.com:access');
  assert.equal(scopeToken({ server: 'GitHub' }), 'mcp:github');
  assert.equal(scopeToken({}), null);
  assert.equal(scopeToken(null), null);
});

test('classifyScopeTier ranks privilege 1-4 with wildcard = 4', () => {
  assert.equal(classifyScopeTier('*'), 4, 'bare wildcard is tier 4');
  assert.equal(classifyScopeTier('db:*'), 4, 'resource wildcard is tier 4');
  assert.equal(classifyScopeTier('tool:delete_user'), 4, 'destructive verb is tier 4');
  assert.equal(classifyScopeTier('tool:send_email'), 4, 'send/egress is tier 4');
  assert.equal(classifyScopeTier('tool:admin_panel'), 3, 'admin is tier 3');
  assert.equal(classifyScopeTier('tool:create_doc'), 2, 'write is tier 2');
  assert.equal(classifyScopeTier('tool:get_weather'), 1, 'read/get is tier 1');
  assert.equal(classifyScopeTier('tool:mystery'), 2, 'unknown defaults to tier 2');
  assert.equal(classifyScopeTier(null), 2, 'null defaults to tier 2');
});

test('isWildcardScope recognises the three wildcard forms only', () => {
  assert.equal(isWildcardScope('*'), true);
  assert.equal(isWildcardScope('db:*'), true);
  assert.equal(isWildcardScope('path/*'), true);
  assert.equal(isWildcardScope('tool:read'), false);
  assert.equal(isWildcardScope(''), false);
  assert.equal(isWildcardScope(null), false);
});

test('normalizeEvent never throws and fills the canonical shape', () => {
  for (const bad of [undefined, null, 42, 'str', [], {}]) {
    const e = normalizeEvent(bad);
    assert.equal(typeof e, 'object');
    assert.ok('id' in e && 'ts' in e && 'namespace' in e, 'has top-level keys');
    assert.ok(e.actor && 'key_id' in e.actor && 'agent' in e.actor, 'actor shape');
    assert.ok(e.action && 'type' in e.action && 'tool' in e.action, 'action shape');
    assert.ok(e.scopes && 'granted' in e.scopes && Array.isArray(e.scopes.used), 'scopes shape');
    assert.ok(e.data && typeof e.data.has_sensitive === 'boolean', 'data shape');
    assert.equal(typeof e.id, 'string');
    assert.equal(e.namespace, 'default', 'namespace defaults to "default"');
  }
});

test('normalizeEvent derives a used scope from the action when none given', () => {
  const e = normalizeEvent({ action: { tool: 'Lookup' } });
  assert.deepEqual(e.scopes.used, ['tool:lookup'], 'used derived from tool');
  assert.equal(e.action.type, 'tool', 'type inferred as tool');
});

test('normalizeEvent infers egress from a host and respects explicit egress', () => {
  const withHost = normalizeEvent({ action: { host: 'api.acme.com' } });
  assert.equal(withHost.data.egress, true, 'host implies egress');
  assert.equal(withHost.action.type, 'api', 'type inferred as api');
  const noEgress = normalizeEvent({ action: { host: 'api.acme.com' }, data: { egress: false } });
  assert.equal(noEgress.data.egress, false, 'explicit egress=false honoured');
});

test('normalizeEvent preserves a supplied granted list and meta passthrough', () => {
  const e = normalizeEvent({
    scopes: { granted: ['tool:a', 'TOOL:A', 'tool:b'], used: [] },
    meta: { kind: 'tool_call', source: 'litellm' },
  });
  assert.deepEqual(e.scopes.granted, ['tool:a', 'tool:b'], 'granted lowercased + deduped');
  assert.equal(e.meta.kind, 'tool_call', 'meta passthrough preserved');
});

test('normalizeEvents drops non-objects and normalizes the rest', () => {
  const out = normalizeEvents([{ action: { tool: 'x' } }, null, 5, 'y', { ts: '2026-01-01' }]);
  assert.equal(out.length, 2, 'only the 2 objects survive');
  assert.equal(normalizeEvents('nope').length, 0, 'non-array → empty');
});

// Regression: read verbs that NAME a sensitive resource were promoted to tier-4
// "destructive/egress" by substring matching, producing a false
// high-privilege-action finding in the signed report. Rank on the leading verb.
test('classifyScopeTier ranks on the leading verb, not substrings of resource nouns', () => {
  for (const read of [
    'tool:list_payments', 'tool:get_charge', 'tool:list_charges', 'tool:read_emails',
    'tool:search_emails', 'tool:get_sender', 'tool:get_wireframe', 'tool:get_deleted_users',
  ]) {
    assert.equal(classifyScopeTier(read), 1, `${read} is a read (tier 1)`);
  }
  // True destructive/egress verbs stay tier 4, including a verb that is not first.
  assert.equal(classifyScopeTier('tool:send_email'), 4, 'send → tier 4');
  assert.equal(classifyScopeTier('tool:delete_user'), 4, 'delete → tier 4');
  assert.equal(classifyScopeTier('tool:charge_card'), 4, 'charge as the action verb → tier 4');
  assert.equal(classifyScopeTier('tool:bulk_delete'), 4, 'destructive verb escalates when leading token is unknown');
});

// Regression: distinct actions sharing {ts, ns, key, action} (parallel tool
// calls, two calls in the same one-second bucket) collapsed to one id, firing a
// false "duplicate-event-ids" finding against the buyer's trail. A caller-supplied
// discriminator must split them while a true byte-identical replay still collapses.
test('a content discriminator distinguishes otherwise-identical events', () => {
  const base = { ts: '2026-01-01T00:00:00Z', namespace: 'audit', actor: { key_id: 'k1' }, action: { type: 'tool', tool: 'web_search' } };
  const a = normalizeEvent({ ...base, disc: 'q=alpha' });
  const b = normalizeEvent({ ...base, disc: 'q=beta' });
  const c = normalizeEvent({ ...base }); // no disc
  const d = normalizeEvent({ ...base }); // no disc — must equal c (real replay still collapses)
  assert.notEqual(a.id, b.id, 'different disc → different id');
  assert.equal(c.id, d.id, 'absent disc → deterministic legacy id');
  assert.notEqual(a.id, c.id, 'disc participates in the id');
});

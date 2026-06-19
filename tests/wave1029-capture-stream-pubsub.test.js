// W1029 - capture stream cross-instance pubsub bridge.
//
// Durable replay already protects reconnects. This closes the local live-tail
// gap by adding an opt-in filesystem pubsub bridge so two independent capture
// brokers can fan out live captures across process boundaries.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CAPTURE_STREAM_PUBSUB_VERSION,
  createCaptureBroker,
  subscribe,
  pollCapturePubsubOnce,
  _resetSubscribers,
} from '../src/capture-stream.js';

function freshBus(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w1029-capture-pubsub-'));
  const bus = path.join(tmp, 'capture-bus.jsonl');
  t.after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    delete process.env.KOLM_CAPTURE_PUBSUB_DRIVER;
    delete process.env.KOLM_CAPTURE_STREAM_PUBSUB;
    delete process.env.KOLM_CAPTURE_PUBSUB_PATH;
    delete process.env.KOLM_CAPTURE_PUBSUB_DIR;
    _resetSubscribers();
  });
  return { tmp, bus };
}

test('W1029 file pubsub delivers a capture from replica B to a subscriber on replica A', async (t) => {
  const { bus } = freshBus(t);
  const replicaA = createCaptureBroker({ driver: 'fs', bus_path: bus, poll_interval_ms: 0 });
  const replicaB = createCaptureBroker({ driver: 'fs', bus_path: bus, poll_interval_ms: 0 });
  t.after(() => { replicaA.close(); replicaB.close(); });

  const seen = [];
  replicaA.subscribe('tenant_a', 'support', (obs) => seen.push(obs));
  const deliveredLocal = replicaB.publishCapture({
    id: 'cap-cross-replica',
    tenant: 'tenant_a',
    corpus_namespace: 'support',
    prompt: 'captured on replica B',
    response: 'tailed on replica A',
  });
  assert.equal(deliveredLocal, 0, 'replica B has no local subscriber');

  const poll = await replicaA.pollOnce();
  assert.equal(poll.ok, true);
  assert.equal(poll.driver, 'fs');
  assert.equal(poll.read, 1);
  assert.equal(poll.delivered, 1);
  assert.deepEqual(seen.map((x) => x.id), ['cap-cross-replica']);
  assert.equal(seen[0].prompt, 'captured on replica B');
  assert.equal(replicaA.version, CAPTURE_STREAM_PUBSUB_VERSION);
});

test('W1029 file pubsub keeps tenant and namespace isolation across replicas', async (t) => {
  const { bus } = freshBus(t);
  const replicaA = createCaptureBroker({ driver: 'fs', bus_path: bus, poll_interval_ms: 0 });
  const replicaB = createCaptureBroker({ driver: 'fs', bus_path: bus, poll_interval_ms: 0 });
  t.after(() => { replicaA.close(); replicaB.close(); });

  const seen = [];
  replicaA.subscribe('tenant_a', 'support', (obs) => seen.push(obs.id));
  replicaB.publishCapture({ id: 'cap-foreign-tenant', tenant: 'tenant_b', corpus_namespace: 'support' });
  replicaB.publishCapture({ id: 'cap-wrong-namespace', tenant: 'tenant_a', corpus_namespace: 'sales' });
  replicaB.publishCapture({ id: 'cap-allowed', tenant: 'tenant_a', corpus_namespace: 'support' });

  const poll = await replicaA.pollOnce();
  assert.equal(poll.read, 3);
  assert.equal(poll.delivered, 1);
  assert.deepEqual(seen, ['cap-allowed']);
});

test('W1029 file pubsub does not duplicate events back to the publishing broker', async (t) => {
  const { bus } = freshBus(t);
  const replica = createCaptureBroker({ driver: 'fs', bus_path: bus, poll_interval_ms: 0 });
  t.after(() => { replica.close(); });

  const seen = [];
  replica.subscribe('tenant_a', '*', (obs) => seen.push(obs.id));
  const local = replica.publishCapture({ id: 'cap-local', tenant: 'tenant_a', corpus_namespace: 'support' });
  assert.equal(local, 1);

  const poll = await replica.pollOnce();
  assert.equal(poll.read, 0);
  assert.equal(poll.delivered, 0);
  assert.deepEqual(seen, ['cap-local']);
});

test('W1029 default capture-stream exports can be env-configured for file pubsub', async (t) => {
  const { bus } = freshBus(t);
  process.env.KOLM_CAPTURE_PUBSUB_DRIVER = 'fs';
  process.env.KOLM_CAPTURE_PUBSUB_PATH = bus;
  _resetSubscribers();

  const remote = createCaptureBroker({ driver: 'fs', bus_path: bus, poll_interval_ms: 0 });
  t.after(() => { remote.close(); });
  const seen = [];
  subscribe('tenant_default', 'default', (obs) => seen.push(obs.id));

  remote.publishCapture({ id: 'cap-default-env', tenant: 'tenant_default', corpus_namespace: 'default' });
  const poll = await pollCapturePubsubOnce();
  assert.equal(poll.ok, true);
  assert.equal(poll.delivered, 1);
  assert.deepEqual(seen, ['cap-default-env']);
});

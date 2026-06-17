// W729 - load queue contract.
//
// This file was referenced by the W729 implementation comments but was missing
// locally. It pins the existing hot-path queue behavior without changing the
// implementation: disabled mode, priority drain order, timeout, overflow, and
// bounded queue-full rejection.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOAD_QUEUE_VERSION,
  PRIORITY_LANES,
  _resetForTests,
  enqueue,
  getQueueStats,
  setCapacity,
} from '../src/load-queue.js';

function cleanupEnv() {
  delete process.env.KOLM_LOAD_QUEUE_DISABLED;
  delete process.env.KOLM_TEACHER_OVERFLOW_URL;
}

test('W729 load queue exports version and priority lanes', () => {
  assert.equal(LOAD_QUEUE_VERSION, 'w729-v1');
  assert.deepEqual(PRIORITY_LANES, ['enterprise', 'business', 'starter', 'free']);
});

test('W729 disabled mode is an immediate no-op slot', async (t) => {
  _resetForTests();
  cleanupEnv();
  t.after(cleanupEnv);
  process.env.KOLM_LOAD_QUEUE_DISABLED = '1';

  const slot = await enqueue({ priority: 'enterprise' });
  assert.equal(slot.ok, true);
  assert.equal(slot.queued, false);
  assert.equal(slot.reason, 'disabled');
  assert.equal(typeof slot.release, 'function');
  assert.equal(getQueueStats().depth, 0);
});

test('W729 priority lanes drain enterprise before older free tickets', async (t) => {
  _resetForTests();
  cleanupEnv();
  t.after(cleanupEnv);
  setCapacity(1);

  const active = await enqueue({ priority: 'free' });
  const freeTicket = enqueue({ priority: 'free', timeout_ms: 1000 });
  const enterpriseTicket = enqueue({ priority: 'enterprise', timeout_ms: 1000 });
  assert.equal(getQueueStats().depth, 3);

  active.release();
  const enterpriseSlot = await enterpriseTicket;
  assert.equal(enterpriseSlot.priority, 'enterprise');
  enterpriseSlot.release();

  const freeSlot = await freeTicket;
  assert.equal(freeSlot.priority, 'free');
  freeSlot.release();
  assert.equal(getQueueStats().depth, 0);
});

test('W729 timeout rejects a queued request with retry metadata', async (t) => {
  _resetForTests();
  cleanupEnv();
  t.after(cleanupEnv);
  setCapacity(1);

  const active = await enqueue({ priority: 'free' });
  await assert.rejects(
    enqueue({ priority: 'starter', timeout_ms: 5 }),
    (err) => {
      assert.equal(err.code, 'queue_timeout');
      assert.equal(err.retry_after_seconds, 1);
      assert.ok(err.waited_ms >= 0);
      return true;
    },
  );
  active.release();
});

test('W729 overflow callback handles saturated capacity when configured', async (t) => {
  _resetForTests();
  cleanupEnv();
  t.after(cleanupEnv);
  setCapacity(1);
  process.env.KOLM_TEACHER_OVERFLOW_URL = 'https://teacher.invalid/overflow';

  const active = await enqueue({ priority: 'free' });
  const overflow = await enqueue({
    priority: 'business',
    req: { id: 'r1' },
    onOverflow: async (req) => ({ echoed: req.id }),
  });
  assert.equal(overflow.ok, true);
  assert.equal(overflow.overflowed, true);
  assert.equal(overflow.teacher_url, 'https://teacher.invalid/overflow');
  assert.deepEqual(overflow.result, { echoed: 'r1' });
  active.release();
});

test('W729 queue_full rejects before unbounded memory growth', async (t) => {
  _resetForTests();
  cleanupEnv();
  t.after(cleanupEnv);
  setCapacity(1);

  const active = await enqueue({ priority: 'free' });
  const q1 = enqueue({ priority: 'free', timeout_ms: 1000 });
  const q2 = enqueue({ priority: 'free', timeout_ms: 1000 });
  const q3 = enqueue({ priority: 'free', timeout_ms: 1000 });

  await assert.rejects(
    enqueue({ priority: 'free', timeout_ms: 1000 }),
    (err) => {
      assert.equal(err.code, 'queue_full');
      assert.equal(err.capacity, 1);
      return true;
    },
  );

  active.release();
  const s1 = await q1; s1.release();
  const s2 = await q2; s2.release();
  const s3 = await q3; s3.release();
  assert.equal(getQueueStats().depth, 0);
});

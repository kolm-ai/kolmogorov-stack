// Secure-training guarantee — policy gate tests.
//
// Contract: a rented pod is a third-party machine. Public data may be uploaded;
// sensitive/customer data must stay local / air-gapped / BYOC (or explicit
// override). The gate classifies the corpus and refuses ineligible pairs before
// any provisioning or upload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTrainingData,
  assertPodEligible,
  teardownPolicy,
  isThirdPartyBackend,
  isLocalBackend,
  SecureTrainingError,
} from '../src/secure-training.js';
import { rent } from '../src/compute/rent.js';

const SENSITIVE = 'Patient contact john.doe@example.com, SSN 123-45-6789, card 4111 1111 1111 1111, phone (555) 123-4567.';
const PUBLIC = 'Summarize the French Revolution in three concise bullet points for a high-school history class.';

test('ST #1 - classifier flags a corpus carrying PII as sensitive', () => {
  const c = classifyTrainingData([SENSITIVE]);
  assert.equal(c.sensitive, true, 'PII corpus must be classified sensitive');
  assert.ok(Array.isArray(c.classes), 'classes is an array');
});

test('ST #2 - classifier treats public/open text as not sensitive', () => {
  const c = classifyTrainingData([PUBLIC]);
  assert.equal(c.sensitive, false, 'public text must not be sensitive');
});

test('ST #3 - public data on a rented pod is allowed', () => {
  const r = assertPodEligible({ sensitivity: { sensitive: false, classes: [] }, backend: 'runpod' });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'rented-pod-public-data');
});

test('ST #4 - sensitive data on a rented pod is REFUSED', () => {
  assert.throws(
    () => assertPodEligible({ sensitivity: { sensitive: true, classes: ['ssn', 'email'] }, backend: 'runpod' }),
    (err) => err instanceof SecureTrainingError && err.code === 'secure_training_policy',
    'must throw SecureTrainingError for sensitive data on a third-party pod',
  );
});

test('ST #5 - sensitive data is allowed local / air-gapped / BYOC', () => {
  assert.equal(assertPodEligible({ sensitivity: { sensitive: true }, backend: 'local-cuda' }).mode, 'local');
  assert.equal(assertPodEligible({ sensitivity: { sensitive: true }, backend: 'runpod', airgap: true }).mode, 'airgap');
  assert.equal(assertPodEligible({ sensitivity: { sensitive: true }, backend: 'runpod', byoc: true }).mode, 'byoc');
});

test('ST #6 - sensitive data on a rented pod allowed only with explicit override (carries a warning)', () => {
  const r = assertPodEligible({ sensitivity: { sensitive: true, classes: ['ssn'] }, backend: 'runpod', override: true });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'rented-pod-override');
  assert.match(r.warning, /override/i);
});

test('ST #7 - teardown policy: third-party pod encrypts + wipes; local is a no-op', () => {
  const pod = teardownPolicy('runpod');
  assert.equal(pod.encrypt_at_rest, true);
  assert.equal(pod.wipe_on_teardown, true);
  assert.match(pod.wipe_command, /shred|rm -rf/);
  const local = teardownPolicy('local-cuda');
  assert.equal(local.wipe_on_teardown, false);
  assert.equal(local.wipe_command, null);
});

test('ST #8 - backend classification helpers', () => {
  assert.equal(isThirdPartyBackend('runpod'), true);
  assert.equal(isThirdPartyBackend('local-cuda'), false);
  assert.equal(isLocalBackend('local-cuda'), true);
  assert.equal(isLocalBackend('runpod'), false);
});

test('ST #9 - rent() refuses sensitive data on a rented pod before provisioning', async () => {
  const res = await rent({ model: 'qwen2.5-7b' }, {
    backend: 'runpod',
    confirm: true,
    data_classification: { sensitive: true, classes: ['ssn'] },
  });
  assert.equal(res.ok, false, 'rent must refuse');
  assert.equal(res.policy, 'secure-training');
  assert.match(res.reason, /sensitive/i);
});

test('ST #10 - rent() lets sensitive data through when BYOC keeps it in the customer boundary', async () => {
  // confirm:false so we stop at the dry-run quote (no real provisioning) but
  // still prove the secure-training gate did not block the BYOC path.
  const res = await rent({ model: 'qwen2.5-7b' }, {
    backend: 'runpod',
    confirm: false,
    byoc: true,
    data_classification: { sensitive: true, classes: ['ssn'] },
  });
  assert.notEqual(res.policy, 'secure-training', 'BYOC must not be blocked by the secure-training gate');
});

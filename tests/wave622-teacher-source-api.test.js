// W622 - teacher-source TOS-risk verdict at the capture->distill API edge.
//
// The classifier existed in src/distill-pipeline.js, but /v1/distill/from-captures
// and its preview endpoint did not expose it. This pins the externally visible
// compliance signal without starting a trainer or calling a hosted teacher.

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function makeAppAndTenant() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  return { app, apiKey: t.api_key };
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

function withTeacherPolicy(value) {
  const prev = process.env.KOLM_TEACHER_SOURCE;
  if (value == null) delete process.env.KOLM_TEACHER_SOURCE;
  else process.env.KOLM_TEACHER_SOURCE = value;
  return () => {
    if (prev == null) delete process.env.KOLM_TEACHER_SOURCE;
    else process.env.KOLM_TEACHER_SOURCE = prev;
  };
}

test('W622 - from-captures preview + job responses expose teacher-source TOS risk', async () => {
  const restore = withTeacherPolicy('open-weights');
  try {
    const { app, apiKey } = await makeAppAndTenant();
    await withServer(app, async (base) => {
      const namespace = 'w622_tos_' + Date.now().toString(36);
      const items = Array.from({ length: 5 }, (_, i) => ({
        input: 'refund status for order 123',
        output: `refund answer ${i}`,
      }));
      const cap = await fetch(base + '/v1/capture/log', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          namespace,
          items,
          provider: 'openai',
          model: 'gpt-4o-mini',
        }),
      });
      assert.equal(cap.status, 201);

      const preview = await fetch(
        base + `/v1/distill/from-captures/preview?namespace=${encodeURIComponent(namespace)}`,
        { headers: { authorization: 'Bearer ' + apiKey } }
      );
      assert.equal(preview.status, 200);
      const previewBody = await preview.json();
      assert.equal(previewBody.teacher_source, 'proprietary');
      assert.equal(previewBody.teacher_source_tos_risk, 'high');
      assert.equal(previewBody.policy_enforced, true);
      assert.equal(previewBody.teacher_source_policy, 'open-weights');
      assert.equal(previewBody.teacher_source_counts.proprietary, 5);
      assert.ok(previewBody.teacher_models.some((m) => /gpt-4o-mini/i.test(m)));

      const run = await fetch(base + '/v1/distill/from-captures', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ namespace, mode: 'recipe', min_pairs: 4 }),
      });
      assert.ok(run.status === 200 || run.status === 422,
        `expected recipe response 200 or 422, got ${run.status}`);
      const runBody = await run.json();
      assert.equal(runBody.teacher_source, 'proprietary');
      assert.equal(runBody.teacher_source_tos_risk, 'high');
      assert.equal(runBody.policy_enforced, true);
      assert.equal(runBody.teacher_source_policy, 'open-weights');
      assert.equal(runBody.teacher_source_counts.proprietary, 5);
    });
  } finally {
    restore();
  }
});

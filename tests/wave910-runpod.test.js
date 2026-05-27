// W910-D — RunPod cloud module tests.
//
// All HTTP traffic goes through an injectable `fetch` so we never hit RunPod
// in CI. The mock is constructed per-test so each pinned item is independent.
//
// Pinned items:
//   1) provisionPod throws structured error when API key missing
//   2) provisionPod returns {ok, pod_id, status, cost_per_hr, openai_url_pending}
//   3) provisionPod surfaces "no_gpu_available" code with alternative GPUs
//   4) tearDownPod attempts stop then terminate, returns {stopped, terminated}
//   5) getPodStatus returns ready=true + openai_url when port mapping is public
//   6) getPodStatus returns ready=false when status != RUNNING
//   7) getPodLogs returns tailed lines + truncated flag when >tail
//   8) testConnection({ apiKey }) returns ok:true for valid mock response
//   9) testConnection() with no key returns ok:false + action_url
//  10) priceForGpu resolves common labels (RTX A4000, A100, H100)
//  11) provisionPod includes KOLM_MODEL_URL in env list
//  12) GraphQL errors are tagged with op + docs_url

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  provisionPod,
  tearDownPod,
  getPodStatus,
  getPodLogs,
  testConnection,
  priceForGpu,
  RUNPOD_GPU_PRICING_USD_HR,
} from '../src/cloud/runpod.js';

// ---------------------------------------------------------------------------
// Mock fetch builders
// ---------------------------------------------------------------------------

function jsonResp(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

function fetchSequence(responses) {
  let i = 0;
  return async function mockFetch(url, opts) {
    const r = responses[i] || responses[responses.length - 1];
    i++;
    if (typeof r === 'function') return r(url, opts);
    return r;
  };
}

// Default deploy-pod response
function deployPodOk(podId = 'pod_abc123', extras = {}) {
  return jsonResp({
    data: {
      podFindAndDeployOnDemand: {
        id: podId,
        imageName: 'kolm/serve:latest',
        machineId: 'm-1',
        desiredStatus: 'PROVISIONING',
        costPerHr: 0.30,
        gpuCount: 1,
        memoryInGb: 16,
        vcpuCount: 4,
        ...extras,
      },
    },
  });
}

// ---------------------------------------------------------------------------

test('W910-D-RP #1 — provisionPod throws structured error when API key missing', async () => {
  // Clear env keys for this test
  const prevA = process.env.RUNPOD_API_KEY;
  const prevB = process.env.KOLM_RUNPOD_TOKEN;
  delete process.env.RUNPOD_API_KEY;
  delete process.env.KOLM_RUNPOD_TOKEN;
  try {
    await assert.rejects(
      () => provisionPod({ gpu_type: 'A100', artifact_url: 'https://example.com/a.kolm' }),
      (e) => {
        assert.equal(e.code, 'runpod_api_key_missing');
        assert.equal(e.action_url, '/account/settings/integrations');
        return true;
      },
    );
  } finally {
    if (prevA != null) process.env.RUNPOD_API_KEY = prevA;
    if (prevB != null) process.env.KOLM_RUNPOD_TOKEN = prevB;
  }
});

test('W910-D-RP #2 — provisionPod returns pod_id, status, cost_per_hr', async () => {
  const fetch = fetchSequence([deployPodOk('pod_xyz')]);
  const r = await provisionPod({
    apiKey: 'rp_test',
    gpu_type: 'RTX A4000',
    artifact_url: 'https://kolm.ai/registry/art_1.kolm',
    fetch,
  });
  assert.equal(r.ok, true);
  assert.equal(r.pod_id, 'pod_xyz');
  assert.equal(r.provider, 'runpod');
  assert.equal(r.cost_per_hr, 0.30);
  assert.equal(r.openai_url_pending, true);
  assert.equal(r.gpu_type, 'RTX A4000');
});

test('W910-D-RP #3 — provisionPod surfaces no_gpu_available with alternatives', async () => {
  const fetch = fetchSequence([jsonResp({
    data: null,
    errors: [{ message: 'No GPU available for this configuration' }],
  })]);
  await assert.rejects(
    () => provisionPod({ apiKey: 'rp_test', gpu_type: 'H100', artifact_url: 'https://x/a.kolm', fetch }),
    (e) => {
      assert.equal(e.code, 'runpod_no_gpu_available');
      assert.ok(Array.isArray(e.alternatives) && e.alternatives.length > 0, 'should suggest alternatives');
      return true;
    },
  );
});

test('W910-D-RP #4 — tearDownPod attempts stop then terminate', async () => {
  const calls = [];
  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.query.match(/mutation\s+(\w+)/)?.[1] || body.query.slice(0, 30));
    if (/podStop/.test(body.query)) return jsonResp({ data: { podStop: { id: 'pod_x', desiredStatus: 'STOPPED' } } });
    if (/podTerminate/.test(body.query)) return jsonResp({ data: { podTerminate: true } });
    return jsonResp({ data: {} });
  };
  const r = await tearDownPod('pod_x', { apiKey: 'rp_test', fetch });
  assert.equal(r.ok, true);
  assert.equal(r.stopped, true);
  assert.equal(r.terminated, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], 'StopPod');
  assert.equal(calls[1], 'TerminatePod');
});

test('W910-D-RP #5 — getPodStatus ready=true + openai_url when port mapped', async () => {
  const fetch = fetchSequence([jsonResp({
    data: {
      pod: {
        id: 'pod_x',
        name: 'kolm-serve',
        imageName: 'kolm/serve:latest',
        desiredStatus: 'RUNNING',
        lastStatusChange: '2026-05-28T00:00:00Z',
        costPerHr: 0.30,
        runtime: {
          uptimeInSeconds: 320,
          ports: [{ ip: '1.2.3.4', isIpPublic: true, privatePort: 8000, publicPort: 41234, type: 'http' }],
          gpus: [{ id: 'g-1', gpuUtilPercent: 12, memoryUtilPercent: 5 }],
          container: { cpuPercent: 1.2, memoryPercent: 8.0 },
        },
        machine: { gpuTypeId: 'NVIDIA RTX A4000', podHostId: 'h-1' },
      },
    },
  })]);
  const r = await getPodStatus('pod_x', { apiKey: 'rp_test', fetch });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'RUNNING');
  assert.equal(r.ready, true);
  assert.match(r.openai_url, /proxy\.runpod\.net\/v1$/);
  assert.equal(r.uptime_seconds, 320);
});

test('W910-D-RP #6 — getPodStatus ready=false when status != RUNNING', async () => {
  const fetch = fetchSequence([jsonResp({
    data: {
      pod: {
        id: 'pod_y', desiredStatus: 'PROVISIONING',
        runtime: { uptimeInSeconds: 0, ports: [], gpus: [], container: null },
        machine: { gpuTypeId: 'NVIDIA RTX A4000' },
      },
    },
  })]);
  const r = await getPodStatus('pod_y', { apiKey: 'rp_test', fetch });
  assert.equal(r.ready, false);
  assert.equal(r.openai_url, null);
});

test('W910-D-RP #7 — getPodLogs returns tailed lines + truncated flag', async () => {
  const allLines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
  const fetch = fetchSequence([jsonResp({
    data: { pod: { id: 'pod_x', logs: allLines.join('\n') } },
  })]);
  const r = await getPodLogs('pod_x', { apiKey: 'rp_test', tail: 50, fetch });
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 50);
  assert.equal(r.lines[0], 'line 450');
  assert.equal(r.lines[49], 'line 499');
  assert.equal(r.truncated, true);
  assert.equal(r.total_lines, 500);
});

test('W910-D-RP #8 — testConnection ok:true for valid mock', async () => {
  const fetch = fetchSequence([jsonResp({
    data: { myself: { id: 'u_1', email: 'tester@example.com', currentSpendPerHr: 0 } },
  })]);
  const r = await testConnection({ apiKey: 'rp_test', fetch });
  assert.equal(r.ok, true);
  assert.equal(r.account.id, 'u_1');
  assert.equal(r.account.email, 'tester@example.com');
});

test('W910-D-RP #9 — testConnection() with no key returns ok:false + action_url', async () => {
  const prevA = process.env.RUNPOD_API_KEY;
  const prevB = process.env.KOLM_RUNPOD_TOKEN;
  delete process.env.RUNPOD_API_KEY;
  delete process.env.KOLM_RUNPOD_TOKEN;
  try {
    const r = await testConnection({});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_api_key');
    assert.equal(r.action_url, '/account/settings/integrations');
  } finally {
    if (prevA != null) process.env.RUNPOD_API_KEY = prevA;
    if (prevB != null) process.env.KOLM_RUNPOD_TOKEN = prevB;
  }
});

test('W910-D-RP #10 — priceForGpu resolves common labels', () => {
  assert.equal(priceForGpu('RTX A4000'), 0.30);
  assert.equal(priceForGpu('A100'), 1.89);
  assert.equal(priceForGpu('H100'), 3.89);
  assert.equal(priceForGpu('A100-80GB'), 1.89);
  // Unknown label resolves to null
  assert.equal(priceForGpu('imaginary-gpu-9000'), null);
  // Pricing table is frozen
  assert.throws(() => { RUNPOD_GPU_PRICING_USD_HR['hack'] = 0; });
});

test('W910-D-RP #11 — provisionPod includes KOLM_MODEL_URL in env list', async () => {
  let captured = null;
  const fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return deployPodOk('pod_env_test');
  };
  await provisionPod({
    apiKey: 'rp_test',
    gpu_type: 'RTX A4000',
    artifact_url: 'https://example.com/special.kolm',
    fetch,
  });
  assert.ok(captured, 'fetch should have been called');
  const env = captured.variables.input.env;
  assert.ok(Array.isArray(env), 'env must be array');
  const modelEntry = env.find((x) => x.key === 'KOLM_MODEL_URL');
  assert.ok(modelEntry, 'KOLM_MODEL_URL must be present');
  assert.equal(modelEntry.value, 'https://example.com/special.kolm');
});

test('W910-D-RP #12 — GraphQL errors are tagged with op + docs_url', async () => {
  const fetch = fetchSequence([jsonResp({
    data: null,
    errors: [{ message: 'Field "podFoo" is not defined' }],
  })]);
  await assert.rejects(
    () => provisionPod({ apiKey: 'rp_test', gpu_type: 'A100', artifact_url: 'https://x/a.kolm', fetch }),
    (e) => {
      assert.equal(e.code, 'runpod_graphql_error');
      assert.equal(e.op, 'deployPod');
      assert.ok(e.docs_url && /runpod\.io/.test(e.docs_url));
      return true;
    },
  );
});

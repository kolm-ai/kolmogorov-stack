// W992 - live runtime proven-compute binding.
//
// The BYOC callback path already emits Proven-Compute Receipts. This wave locks
// the live inference path: an OpenAI-compatible confidential-GPU runtime can
// return an NRAS report, and the adapter emits a signed receipt bound to the
// exact request/response digests. Required proof fails closed.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { generateKeyPair } from '../src/ed25519.js';
import {
  clearAttestationVerifier,
  registerAttestationVerifier,
} from '../src/confidential-compute.js';
import { createOpenAICompatibleAdapter } from '../src/compute/backends/openai-compatible.js';
import { nonceBinding } from '../src/nras-verifier.js';
import {
  buildRuntimeProvenComputeReceipt,
  canonicalRuntimePayload,
  runtimeInferenceDigests,
} from '../src/proven-compute-runtime.js';
import { verifyProvenComputeReceipt } from '../src/proven-compute-receipt.js';

function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function validNrasReport(nonce) {
  return {
    gpu_id: 'GPU-wave992',
    driver_version: '550.90.07',
    vbios_version: '96.00.74.00.01',
    attestation_report: 'eyJhbGciOiJSUzI1NiJ9.eyJlYXRfbm9uY2UiOiJhYiJ9.c2ln',
    cert_chain: ['-----BEGIN CERTIFICATE-----FAKE-----END CERTIFICATE-----'],
    nonce,
  };
}

async function withEnv(values, fn) {
  const prev = new Map();
  for (const [k, v] of Object.entries(values)) {
    prev.set(k, process.env[k]);
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of prev.entries()) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withFetch(stub, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('W992 runtime digests strip proof metadata before nonce binding', () => {
  const baseReq = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const proofReq = { ...baseReq, kolm_proven_compute: { require: true, artifact_hash: sha256hex('artifact') } };
  const baseResp = { choices: [{ message: { content: 'ok' } }] };
  const proofResp = { ...baseResp, kolm_proven_compute: { nras_report: validNrasReport('00'.repeat(32)) } };

  assert.equal(canonicalRuntimePayload(baseReq), canonicalRuntimePayload(proofReq));
  assert.equal(canonicalRuntimePayload(baseResp), canonicalRuntimePayload(proofResp));
  assert.deepEqual(
    runtimeInferenceDigests({ request_body: baseReq, response_body: baseResp }),
    runtimeInferenceDigests({ request_body: proofReq, response_body: proofResp }),
  );
});

test('W992 buildRuntimeProvenComputeReceipt verifies a nonce-bound NRAS report', async () => {
  const requestBody = { model: 'tiny', messages: [{ role: 'user', content: 'ping' }] };
  const responseBody = { choices: [{ message: { role: 'assistant', content: 'pong' } }] };
  const digests = runtimeInferenceDigests({ request_body: requestBody, response_body: responseBody });
  const expectedNonce = nonceBinding(digests.input_digest, digests.output_digest);
  const report = validNrasReport(expectedNonce);

  try {
    registerAttestationVerifier('nras', async (_report, opts) => {
      const expected = nonceBinding(opts.input_digest, opts.output_digest);
      return {
        ok: true,
        verifier: 'nras',
        trust_root: 'pinned-nvidia-root',
        report_hash: sha256hex('runtime-report'),
        eat_nonce: expected,
        expected_nonce: expected,
        nonce_binding_alg: 'sha256(input_digest||output_digest)',
      };
    });
    const out = await buildRuntimeProvenComputeReceipt({
      request_body: requestBody,
      response_body: { ...responseBody, kolm_proven_compute: { nras_report: report } },
      artifact_hash: sha256hex('artifact'),
      nras_report: report,
      runtime_target: 'vllm-h100-cc',
      require_proven_compute: true,
      issued_at: '2026-06-19T00:00:00.000Z',
    }, { signer: generateKeyPair(), transparency: false });

    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.proof_scope, 'proven_compute');
    assert.equal(out.input_digest, digests.input_digest);
    assert.equal(out.output_digest, digests.output_digest);
    assert.equal(out.receipt.inference.nonce_binding, expectedNonce);
    assert.equal(verifyProvenComputeReceipt(out.receipt, { requireProvenCompute: true }).ok, true);
  } finally {
    clearAttestationVerifier('nras');
  }
});

test('W992 OpenAI-compatible runtime adapter emits a receipt from returned NRAS evidence', async () => {
  const requestBody = { model: 'tiny', messages: [{ role: 'user', content: 'ping' }] };
  const artifactHash = sha256hex('adapter-artifact');

  try {
    registerAttestationVerifier('nras', async (_report, opts) => {
      const expected = nonceBinding(opts.input_digest, opts.output_digest);
      return {
        ok: true,
        verifier: 'nras',
        trust_root: 'pinned-nvidia-root',
        report_hash: sha256hex('adapter-report'),
        eat_nonce: expected,
        expected_nonce: expected,
        nonce_binding_alg: 'sha256(input_digest||output_digest)',
      };
    });

    await withEnv({ KOLM_W992_URL: 'https://runtime.local/v1', KOLM_W992_KEY: 'test-key' }, async () => {
      await withFetch(async (_url, init = {}) => {
        const body = JSON.parse(init.body);
        const responseCore = { choices: [{ message: { role: 'assistant', content: 'pong' } }] };
        const digests = runtimeInferenceDigests({ request_body: body, response_body: responseCore });
        const expectedNonce = nonceBinding(digests.input_digest, digests.output_digest);
        return jsonResponse({
          ...responseCore,
          kolm_proven_compute: {
            artifact_hash: artifactHash,
            runtime_target: 'vllm-h100-cc',
            require_proven_compute: true,
            nras_report: validNrasReport(expectedNonce),
          },
        });
      }, async () => {
        const adapter = createOpenAICompatibleAdapter({
          name: 'w992',
          urlEnv: 'KOLM_W992_URL',
          keyEnv: 'KOLM_W992_KEY',
          device: 'nvidia-h100-cc',
        });
        const out = await adapter.run({
          body: requestBody,
          provenCompute: { signer: generateKeyPair(), transparency: false },
        });
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.equal(out.proven_compute.ok, true);
        assert.equal(out.proven_compute.proof_scope, 'proven_compute');
        assert.ok(out.proven_compute_receipt);
        assert.equal(verifyProvenComputeReceipt(out.proven_compute_receipt, { requireProvenCompute: true }).ok, true);
      });
    });
  } finally {
    clearAttestationVerifier('nras');
  }
});

test('W992 required proven compute fails closed when the runtime omits NRAS evidence', async () => {
  await withEnv({ KOLM_W992_URL: 'https://runtime.local/v1', KOLM_W992_KEY: null }, async () => {
    await withFetch(async () => jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'pong' } }],
    }), async () => {
      const adapter = createOpenAICompatibleAdapter({
        name: 'w992',
        urlEnv: 'KOLM_W992_URL',
        keyEnv: 'KOLM_W992_KEY',
        device: 'nvidia-h100-cc',
      });
      const out = await adapter.run({
        body: {
          model: 'tiny',
          messages: [{ role: 'user', content: 'ping' }],
          kolm_proven_compute: {
            require_proven_compute: true,
            artifact_hash: sha256hex('artifact'),
          },
        },
        provenCompute: { require_proven_compute: true, artifact_hash: sha256hex('artifact') },
      });
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'proven_compute_required_failed');
      assert.equal(out.detail, 'runtime_attestation_report_missing');
    });
  });
});

// W656 - direct contract/security tests for src/airgap-routes.js.
//
// The airgap routes are an authenticated HTTP boundary over local-only
// distill, sneakernet, and doctor primitives. The route layer must enforce
// tenant ownership before returning queued run specs or extracting verified
// bundles, and the doctor envelope must not leak raw host env paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mountAirgapRoutes } from '../src/airgap-routes.js';
import { _internal as distillInternal } from '../src/airgap-distill.js';
import {
  createSneakernetBundle,
  generateEd25519Keypair,
} from '../src/airgap-sneakernet.js';

const TARGET = 'src/airgap-routes.js';

function makeRouter() {
  const routes = { GET: {}, POST: {} };
  return {
    get(routePath, handler) {
      routes.GET[routePath] = handler;
    },
    post(routePath, handler) {
      routes.POST[routePath] = handler;
    },
    async call(method, routePath, { body = {}, params = {}, tenant = null } = {}) {
      const handler = routes[method][routePath];
      assert.ok(handler, `missing ${method} ${routePath}`);
      const req = {
        body,
        params,
        tenant_record: tenant ? { id: tenant } : undefined,
      };
      const captured = { status: 200, body: null };
      const res = {
        status(code) {
          captured.status = code;
          return this;
        },
        json(payload) {
          captured.body = payload;
          return this;
        },
      };
      await handler(req, res);
      return captured;
    },
  };
}

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-airgap-routes-w656-'));
  process.env.KOLM_HOME = path.join(dir, '.kolm');
  process.env.KOLM_DATA_DIR = path.join(dir, '.kolm');
  fs.mkdirSync(distillInternal.runsDir(), { recursive: true });
  return dir;
}

function writeFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
}

test('W656 airgap route status is tenant-fenced', async () => {
  assert.equal(TARGET, 'src/airgap-routes.js');
  freshDir();
  const runId = 'airgap_owned_run';
  distillInternal.persistQueuedRun(runId, {
    run_id: runId,
    status: 'queued',
    tenant: 'tenant_a',
    version: 'w831-test',
  });

  const router = makeRouter();
  mountAirgapRoutes(router, { fetch: async () => { throw new Error('offline'); } });

  const crossTenant = await router.call('GET', '/v1/airgap/distill/status/:id', {
    params: { id: runId },
    tenant: 'tenant_b',
  });
  assert.equal(crossTenant.status, 404);
  assert.equal(crossTenant.body.error, 'run_not_found');

  const owner = await router.call('GET', '/v1/airgap/distill/status/:id', {
    params: { id: runId },
    tenant: 'tenant_a',
  });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.ok, true);
  assert.equal(owner.body.tenant, 'tenant_a');
});

test('W656 sneakernet verify refuses cross-tenant extraction before writing bytes', async () => {
  const tmp = freshDir();
  const keys = generateEd25519Keypair();
  const signer = path.join(tmp, 'keys', 'signer.pem');
  const trusted = path.join(tmp, 'keys', 'trusted.pem');
  const artifact = path.join(tmp, 'artifact.kolm');
  const bundle = path.join(tmp, 'bundle.tar');
  const extractTo = path.join(tmp, 'extract');
  writeFile(signer, keys.private_key_pem);
  writeFile(trusted, keys.public_key_pem);
  writeFile(artifact, 'tenant-owned bytes\n');

  const packed = createSneakernetBundle({
    artifact_path: artifact,
    signing_key_path: signer,
    output_usb_path: bundle,
    artifact_id: 'owned-artifact',
    tenant: 'tenant_a',
  });
  assert.equal(packed.ok, true, JSON.stringify(packed));

  const router = makeRouter();
  mountAirgapRoutes(router);
  const body = {
    bundle_path: bundle,
    trusted_pubkey_path: trusted,
    extract_to: extractTo,
  };

  const denied = await router.call('POST', '/v1/airgap/sneakernet/verify', {
    body,
    tenant: 'tenant_b',
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'sneakernet_tenant_mismatch');
  assert.equal(fs.existsSync(path.join(extractTo, 'owned-artifact.kolm')), false);

  const allowed = await router.call('POST', '/v1/airgap/sneakernet/verify', {
    body,
    tenant: 'tenant_a',
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ok, true);
  assert.equal(allowed.body.trustworthy, true);
  assert.ok(fs.existsSync(path.join(extractTo, 'owned-artifact.kolm')));
});

test('W656 doctor reports readiness without raw env path disclosure', async () => {
  const tmp = freshDir();
  const oldTeacher = process.env.KOLM_LOCAL_TEACHER_URL;
  const oldSigningKey = process.env.KOLM_AIRGAP_SIGNING_KEY;
  try {
    const signingKey = path.join(tmp, 'private', 'signing-key.pem');
    writeFile(signingKey, 'fixture-key');
    process.env.KOLM_LOCAL_TEACHER_URL = 'http://127.0.0.1:11434/v1';
    process.env.KOLM_AIRGAP_SIGNING_KEY = signingKey;

    const router = makeRouter();
    mountAirgapRoutes(router, {
      doctorFetch: async () => ({ status: 204 }),
    });

    const noAuth = await router.call('GET', '/v1/airgap/doctor');
    assert.equal(noAuth.status, 401);

    const ok = await router.call('GET', '/v1/airgap/doctor', { tenant: 'tenant_a' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.network_reachable, true);
    assert.equal(ok.body.teacher_configured, true);
    assert.equal(ok.body.teacher_local, true);
    assert.equal(ok.body.teacher_kind, 'loopback-ipv4');
    assert.equal(ok.body.signing_key_configured, true);
    assert.equal(ok.body.signing_key_present, true);
    assert.equal(Object.prototype.hasOwnProperty.call(ok.body, 'teacher_url'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ok.body, 'signing_key_path'), false);
    assert.ok(/^w831-/.test(ok.body.version));
  } finally {
    if (oldTeacher === undefined) delete process.env.KOLM_LOCAL_TEACHER_URL;
    else process.env.KOLM_LOCAL_TEACHER_URL = oldTeacher;
    if (oldSigningKey === undefined) delete process.env.KOLM_AIRGAP_SIGNING_KEY;
    else process.env.KOLM_AIRGAP_SIGNING_KEY = oldSigningKey;
  }
});

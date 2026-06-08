// Local end-to-end smoke for the Agent Security-Review audit product, run with
// the ACTUAL production Ed25519 signing key as the live signer. This is the
// "try it out" + de-risk-the-deploy step: it proves the exact key we are about
// to put on Railway (KOLM_ED25519_PRIVATE_KEY) drives a real
// audit → sign → verify loop, that a genuine report is trusted, and that a
// rogue-signed forgery is rejected — before any production change.
//
// Usage:  node scripts/local-e2e-audit.mjs
// Reads the prod key from C:\Users\user\.kolm\prod-signing-key.pem (override
// with KOLM_E2E_KEY_PATH). Boots a throwaway server.js on a free port with a
// seeded enterprise tenant, exercises the surface, then tears everything down.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_PATH = process.env.KOLM_E2E_KEY_PATH || 'C:\\Users\\user\\.kolm\\prod-signing-key.pem';
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '  -> ' + JSON.stringify(extra) : ''}`); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function waitForHealth(base, retries = 100) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up');
}

const main = async () => {
  if (!fs.existsSync(KEY_PATH)) { console.error('FATAL: no key at ' + KEY_PATH); process.exit(2); }
  const pem = fs.readFileSync(KEY_PATH, 'utf8');
  const priv = crypto.createPrivateKey(pem);
  const pubPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }).toString();
  const expectedFp = 'fa562154f99c95f48a45d04272943435';

  const PORT = await freePort();
  const base = `http://127.0.0.1:${PORT}`;
  const scratch = path.join(os.tmpdir(), `kolm-e2e-${process.pid}-${Date.now()}`);
  const dataDir = path.join(scratch, 'data');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const tenantId = 't_e2e';
  fs.writeFileSync(path.join(dataDir, 'tenants.json'), JSON.stringify([
    { id: tenantId, name: 'e2e', email: 'e2e@example.com', plan: 'enterprise', quota: 50_000_000, seats: 1, created_at: new Date().toISOString() },
  ]), 'utf8');
  const apiKey = 'ks_e2e_local_key_dddddddddddddddddddddddddddddddd';
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  fs.writeFileSync(path.join(dataDir, 'api_keys.json'), JSON.stringify([
    { id: 'apik_e2e', tenant_id: tenantId, hash: keyHash, label: 'e2e', kind: 'user', created_at: new Date().toISOString(), revoked_at: null },
  ]), 'utf8');

  console.log(`\nBooting server.js on ${base} with the prod key as live signer...`);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
      KOLM_DATA_DIR: dataDir,
      KOLM_HOME: home,
      KOLM_STORE_DRIVER: 'json',
      KOLM_ALLOW_JSON_STORE: 'true',
      KOLM_RATE_LIMIT_DISABLED: '1',
      KOLM_ED25519_PRIVATE_KEY: pem, // the real prod key, real newlines
      DEFAULT_TENANT: 'e2e',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => { serverErr += d.toString(); });

  const auth = (extra = {}) => ({ Authorization: `Bearer ${apiKey}`, ...extra });
  try {
    await waitForHealth(base);
    console.log('Server up.\n');

    // 1) issuer-key advertises the PROD key
    console.log('[1] GET /v1/audit/issuer-key advertises the prod signing key');
    {
      const r = await fetch(`${base}/v1/audit/issuer-key`);
      const j = await r.json();
      ok(r.status === 200, 'issuer-key is 200', { status: r.status });
      ok(j.alg === 'ed25519', 'alg ed25519');
      ok(j.key_fingerprint === expectedFp, `fingerprint is the prod fingerprint`, { got: j.key_fingerprint });
      ok(j.public_key && j.public_key.replace(/\s+/g, '') === pubPem.replace(/\s+/g, ''), 'advertised public key == prod public key');
      ok(!String(j.public_key).includes('PRIVATE'), 'never leaks the private half');
    }

    // 2) one-shot scan signs with the prod key
    console.log('[2] POST /v1/audit/scan produces a prod-signed report');
    const logs = fs.readFileSync(FIXTURE, 'utf8');
    let envelope = null;
    {
      const r = await fetch(`${base}/v1/audit/scan`, {
        method: 'POST', headers: auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ logs, subject: 'E2E — Series-A agent fleet', source: 'litellm' }),
      });
      const j = await r.json();
      ok(r.status === 200, 'scan is 200', { status: r.status });
      ok(j.signed === true, 'report is signed');
      ok(j.key_fingerprint === expectedFp, 'signed with the prod key', { got: j.key_fingerprint });
      ok(j.report && j.report.schema === 'kolm-audit-report-1', 'envelope returned inline');
      ok(typeof j.summary.readiness_pct === 'number', 'readiness pct present', { pct: j.summary?.readiness_pct });
      ok(j.summary.blocking_count >= 1, 'blocking findings surfaced', { blocking: j.summary?.blocking_count });
      envelope = j.report;
    }

    // 3) genuine report verifies + is TRUSTED (live signer, recognized issuer)
    console.log('[3] POST /v1/audit/report/verify — genuine report is trusted');
    {
      const r = await fetch(`${base}/v1/audit/report/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: envelope }),
      });
      const j = await r.json();
      ok(r.status === 200, 'verify is 200', { status: r.status });
      ok(j.verify.ok === true, 'tier-1: signature valid + untampered');
      ok(j.issuer.recognized === true, 'tier-2: issuer recognized');
      ok(j.issuer.matches_live_signer === true, 'tier-2: matches the live prod signer');
      ok(j.trusted === true, 'combined verdict: TRUSTED');
    }

    // 4) tampered report -> verify.ok false
    console.log('[4] tampered report fails tier-1');
    {
      const tampered = JSON.parse(JSON.stringify(envelope));
      tampered.summary.readiness_pct = 100;
      const r = await fetch(`${base}/v1/audit/report/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: tampered }),
      });
      const j = await r.json();
      ok(j.verify.ok === false, 'forged readiness number fails verification');
      ok(j.trusted === false, 'tampered report is NOT trusted');
    }

    // 5) rogue-signed forgery -> verify.ok true but trusted false
    console.log('[5] rogue-signed forgery: valid signature, untrusted issuer');
    {
      const { generateKeyPair, buildSignatureBlock, keyFingerprint } = await import('../src/ed25519.js');
      const { canonicalizeReport } = await import('../src/attestation-report-builder.js');
      const forged = JSON.parse(JSON.stringify(envelope));
      forged.summary.readiness_pct = 100;
      forged.summary.blocking_count = 0;
      forged.findings = [];
      const kp = generateKeyPair();
      delete forged.signature_ed25519;
      const canonical = canonicalizeReport(forged);
      forged.signature_ed25519 = buildSignatureBlock({
        privateKey: kp.privateKey, publicKey: kp.publicKey,
        key_fingerprint: keyFingerprint(kp.publicKey),
        payloadCanonical: canonical, signed_at: forged.generated_at,
      });
      const r = await fetch(`${base}/v1/audit/report/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: forged }),
      });
      const j = await r.json();
      ok(j.verify.ok === true, 'tier-1 cannot tell — it IS validly signed');
      ok(j.issuer.recognized === false, 'tier-2 catches it: rogue key not an issuer');
      ok(j.trusted === false, 'combined verdict: NOT trusted (forgeable-verify fix holds)');
    }

    // 6) report renders in all three formats
    console.log('[6] report renders json / html / pdf');
    {
      // need a persisted session id from a run; reuse a fresh session
      const cr = await fetch(`${base}/v1/audit/sessions`, {
        method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify({ subject: 'E2E render' }),
      });
      const id = (await cr.json()).audit.id;
      await fetch(`${base}/v1/audit/sessions/${id}/ingest`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify({ logs }) });
      await fetch(`${base}/v1/audit/sessions/${id}/run`, { method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: '{}' });
      const jr = await fetch(`${base}/v1/audit/sessions/${id}/report?format=json`, { headers: auth() });
      ok(jr.status === 200 && /application\/json/.test(jr.headers.get('content-type') || ''), 'json renders');
      const hr = await fetch(`${base}/v1/audit/sessions/${id}/report?format=html`, { headers: auth() });
      const html = await hr.text();
      ok(hr.status === 200 && /^<!doctype html>/i.test(html), 'html renders');
      ok(!/honest/i.test(html), 'no banned "honest"/"honesty" in the report');
      const pr = await fetch(`${base}/v1/audit/sessions/${id}/report?format=pdf`, { headers: auth() });
      const buf = Buffer.from(await pr.arrayBuffer());
      ok(pr.status === 200 && buf.slice(0, 5).toString('latin1') === '%PDF-', 'pdf renders');
    }

    // 7) verify.html static page ships the prod key in its offline anchor
    console.log('[7] /verify offline page pins the prod issuer key');
    {
      const r = await fetch(`${base}/verify`);
      const txt = await r.text();
      ok(r.status === 200, 'verify.html served', { status: r.status });
      const body = pubPem.replace(/-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----/, '').replace(/\s+/g, '');
      ok(txt.replace(/\\n/g, '').replace(/\s+/g, '').includes(body), 'prod public key body present in /verify');
      ok(txt.includes('kolm-prod-2026'), 'prod issuer kid present in /verify');
    }
  } catch (e) {
    fail++;
    console.error('E2E THREW:', e && e.stack || e);
    if (serverErr) console.error('server stderr:\n' + serverErr.slice(-2000));
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${fail === 0 ? 'E2E PASS' : 'E2E FAIL'} — ${pass} checks passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
};

main();

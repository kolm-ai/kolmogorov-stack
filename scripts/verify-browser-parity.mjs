// Proves kolm-verify.js (the browser verifier) reconstructs byte-identical
// signed bytes and verifies a REAL receipt produced by src/gateway-receipt.js.
//
// We can't run a browser here, so we replicate the browser code path in Node:
//   - the SAME ALL_FIELDS order + JSON.stringify canonicalization
//   - import the embedded SPKI public_key PEM
//   - decode the base64url signature
//   - crypto.verify(null, msg, pubPem, sig)  (Node's Ed25519, same as WebCrypto)
// If this verifies a real builder-signed receipt and rejects a tampered one,
// the browser library (which does the identical steps via WebCrypto) is correct.

import crypto from 'node:crypto';
import fs from 'node:fs';

// Deterministic demo key + fixed id/timestamp so public/sample-receipt.json is
// byte-identical on every run. This is a throwaway DEMO key whose only job is to
// sign the public sample receipt — it is NOT a kolm issuer key. Reproducibility
// matters because the sample is shown on the site and its signing_key_id is
// quoted in copy; a churning file would desync those and noise up git.
const DEMO_SEED = Buffer.from(
  '6b6f6c6d2d73616d706c652d6465766f6e6c792d646f6e6f742d75736500ff', 'hex'); // 31B
const seed32 = Buffer.concat([DEMO_SEED, Buffer.from([0x01])]).subarray(0, 32);
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const demoKeyObj = crypto.createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519_PREFIX, seed32]), format: 'der', type: 'pkcs8' });
const DEMO_PRIVATE_PEM = demoKeyObj.export({ format: 'pem', type: 'pkcs8' }).toString();
const DEMO_RECEIPT_ID = 'rcpt_sample0000000000000000';
const DEMO_TIMESTAMP = '2026-06-01T00:00:00.000Z';

process.env.KOLM_ED25519_PRIVATE_KEY = DEMO_PRIVATE_PEM;
process.env.KOLM_ED25519_DISABLE = '';

const { buildAndSignReceipt, verifyReceipt: serverVerify } = await import('../src/gateway-receipt.js');

const built = buildAndSignReceipt({
  receipt_id: DEMO_RECEIPT_ID,
  timestamp: DEMO_TIMESTAMP,
  namespace_id: 'ns_demo',
  route_decision: 'local',
  provider: 'local-kolm',
  model: 'kolm-distill-7b',
  input: 'How do I reset my password?',
  output: 'Click "Forgot password" on the sign-in page; we email a reset link valid for 30 minutes.',
  confidence: 0.94,
  input_tokens: 18,
  output_tokens: 27,
  cost_usd: 0,
  verify_url: 'https://kolm.ai/verify',
});
const receipt = built.receipt;

// ---- server-side verify (ground truth) ----
const sv = serverVerify(receipt);
console.log('server verifyReceipt:', sv.ok, sv.reason || '');

// ---- replicate the BROWSER path exactly ----
const ALL_FIELDS = [
  'schema', 'receipt_id', 'timestamp', 'namespace_id', 'route_decision',
  'provider', 'model', 'artifact_id', 'confidence', 'fallback_reason',
  'input_hash', 'output_hash', 'capture_eligible', 'capture_id',
  'redaction_applied', 'input_tokens', 'output_tokens', 'cost_usd',
  'signing_key_id', 'verify_url',
];
function canonicalForSigning(r) {
  const out = {};
  for (const k of ALL_FIELDS) if (k in r) out[k] = r[k];
  return JSON.stringify(out);
}
function browserVerify(r) {
  const block = r.signature_ed25519;
  const canonical = canonicalForSigning(r);
  const der = Buffer.from(
    block.public_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  const fp = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  const fpOk = !block.key_fingerprint || block.key_fingerprint === fp;
  const sig = Buffer.from(block.signature, 'base64url');
  const sigOk = crypto.verify(null, Buffer.from(canonical, 'utf8'), block.public_key, sig);
  return { fpOk, sigOk, fp, canonicalLen: canonical.length };
}

const bv = browserVerify(receipt);
console.log('browser-parity verify:', JSON.stringify(bv));

// ---- negative: tamper a field, must fail ----
const tampered = JSON.parse(JSON.stringify(receipt));
tampered.output_hash = 'sha256:deadbeef' + tampered.output_hash.slice(15);
const tv = browserVerify(tampered);
console.log('tampered verify (must be sigOk=false):', JSON.stringify(tv));

const PASS = sv.ok === true && bv.fpOk === true && bv.sigOk === true && tv.sigOk === false;
console.log(PASS ? 'PARITY OK ✅' : 'PARITY FAILED ❌');

// Emit the real signed receipt so the demo page can ship a self-verifying sample.
fs.writeFileSync(
  new URL('../public/sample-receipt.json', import.meta.url),
  JSON.stringify(receipt, null, 2) + '\n');
console.log('wrote public/sample-receipt.json');

process.exit(PASS ? 0 : 1);

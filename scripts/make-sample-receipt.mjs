// Regenerate public/sample-receipt.json — the demo gateway receipt the
// /report, /how-it-works, and /solutions/enterprise-buyers verify widgets load
// (receipt mode: Tier-1 signature integrity, in-browser, offline).
//
//   node scripts/make-sample-receipt.mjs
//
// Why this script exists:
//   The old sample receipt carried the SHA-256 of an EMPTY input on BOTH
//   input_hash and output_hash (e3b0c442…) — and identical input/output hashes
//   are impossible for distinct content. An elite reviewer spots that instantly
//   as a placeholder. This regenerates the receipt with realistic, DISTINCT
//   content hashes and re-signs it with the SAME published demo issuer key the
//   sample audit report uses, so signing_key_id cross-checks against the
//   published keyring (public/keys/kolm-issuers.json) as "kolm demo issuer".
//
// The demo key is derived deterministically from a fixed public seed (identical
// to scripts/make-sample-audit-report.mjs), so the signature is reproducible and
// no private-key PEM is committed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { keyFingerprint } from '../src/ed25519.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Canonical field order — MUST match public/kolm-verify.js ALL_FIELDS exactly.
const ALL_FIELDS = [
  'schema', 'receipt_id', 'timestamp', 'namespace_id', 'route_decision',
  'provider', 'model', 'artifact_id', 'confidence', 'fallback_reason',
  'input_hash', 'output_hash', 'capture_eligible', 'capture_id',
  'redaction_applied', 'input_tokens', 'output_tokens', 'cost_usd',
  'signing_key_id', 'verify_url',
];

// Demo issuer key — deterministic from the fixed public seed (same as the
// sample audit report). PKCS8 for Ed25519 = 16-byte prefix + 32-byte seed.
const DEMO_SEED = crypto.createHash('sha256').update('kolm-agent-security-demo-issuer-2026').digest();
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, DEMO_SEED]);
const priv = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
const publicKeyPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
const fp = keyFingerprint(publicKeyPem); // 32 hex chars (128-bit)

// Realistic, DISTINCT content hashes from representative agent I/O. Truncated to
// "sha256:" + first 32 hex (128-bit), the receipt's stored hash format.
const h = (s) => 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
const INPUT = 'Where is my refund for order 48217?';
const OUTPUT = 'Your refund for order 48217 was issued on 2026-05-30 and posts in 3 to 5 business days.';

const receipt = {
  schema: 'kolm-audit-1',
  receipt_id: 'rcpt_sample0000000000000000',
  timestamp: '2026-06-01T00:00:00.000Z',
  namespace_id: 'ns_demo',
  route_decision: 'local',
  provider: 'local-kolm',
  model: 'kolm-distill-7b',
  artifact_id: null,
  confidence: 0.94,
  fallback_reason: null,
  input_hash: h(INPUT),
  output_hash: h(OUTPUT),
  capture_eligible: false,
  capture_id: null,
  redaction_applied: [],
  input_tokens: 18,
  output_tokens: 27,
  cost_usd: 0,
  signing_key_id: fp,
  verify_url: 'https://kolm.ai/v1/verify/rcpt_sample0000000000000000',
};

// Canonical payload over present ALL_FIELDS, in order, no whitespace.
const canon = {};
for (const k of ALL_FIELDS) if (k in receipt) canon[k] = receipt[k];
const canonical = JSON.stringify(canon);

const sigBytes = crypto.sign(null, Buffer.from(canonical, 'utf8'), priv);
const signature = sigBytes.toString('base64url');

receipt.signature_ed25519 = {
  spec: 'kolm-ed25519-v1',
  alg: 'ed25519',
  public_key: publicKeyPem,
  key_fingerprint: fp,
  signature,
  signed_at: '2026-06-01T00:00:00.000Z',
};

// Self-verify before writing: re-canonicalize and check the signature exactly
// the way the browser verifier will.
const verifyCanon = {};
for (const k of ALL_FIELDS) if (k in receipt) verifyCanon[k] = receipt[k];
const ok = crypto.verify(null, Buffer.from(JSON.stringify(verifyCanon), 'utf8'), publicKeyPem, sigBytes);
if (!ok) { console.error('FATAL: signature did not self-verify'); process.exit(1); }

const outPath = path.join(ROOT, 'public', 'sample-receipt.json');
fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(`wrote ${outPath}`);
console.log(`  key_fingerprint=${fp}`);
console.log(`  input_hash=${receipt.input_hash}`);
console.log(`  output_hash=${receipt.output_hash}`);
console.log(`  signature=${signature.slice(0, 16)}… (${sigBytes.length} bytes) self-verify=OK`);

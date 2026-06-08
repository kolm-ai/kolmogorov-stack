// Regenerate public/sample-audit-report.json — the demo signed evidence report
// the /verify page loads — AND public/keys/kolm-issuers.json, the published
// keyring of trusted kolm issuer keys the /verify page pins against.
//
//   node scripts/make-sample-audit-report.mjs
//
// Trust model (why this script signs with a DEMO key, not the machine key):
//   The /verify page proves two things about a pasted report:
//     1. cryptographic integrity — signed by the holder of the embedded key,
//        untampered since (verifyAuditReport);
//     2. issuer provenance — that embedded key is one kolm PUBLISHES
//        (issuerProvenance against the keyring).
//   Tier 2 is what stops a forger from re-signing a tampered "100% ready"
//   report with their OWN key and still getting a green check. For the bundled
//   sample to satisfy tier 2 offline, it must be signed by a key whose public
//   half is in the published keyring. So we sign the sample with a dedicated
//   DEMO issuer key (status:"demo") and publish that public half. A demo-signed
//   report is recognized as kolm-demo-issued — NOT as a production evidence
//   signer. The production issuer key (status:"production") is added to the
//   keyring out-of-band when the prod signer is installed; this script never
//   touches a production private key.
//
// The demo key is DERIVED DETERMINISTICALLY from a fixed seed (below), so:
//   * no private-key PEM is committed to the repo,
//   * the sample's signature is reproducible across regenerations,
//   * the keyring's public key always matches the sample's embedded key.
//
// Deterministic report inputs (fixed report_seed + generated_at) keep the rest
// of the file stable across regenerations.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runAudit } from '../src/audit-orchestrator.js';
import { buildAndSignReport } from '../src/attestation-report-builder.js';
import { keyFingerprint } from '../src/ed25519.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ---------------------------------------------------------------------------
// Demo issuer key — deterministic from a fixed seed. NOT a production signer.
// The seed is intentionally public: a demo-signed report is only ever trusted
// as "kolm demo issuer", never as production evidence. PKCS8 for an Ed25519 key
// is the fixed 16-byte prefix below followed by the 32-byte seed.
// ---------------------------------------------------------------------------
const DEMO_KID = 'kolm-demo-2026';
const DEMO_SEED = crypto.createHash('sha256').update('kolm-agent-security-demo-issuer-2026').digest(); // 32 bytes
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function demoSigner() {
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, DEMO_SEED]);
  const priv = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const privateKey = priv.export({ type: 'pkcs8', format: 'pem' });
  const publicKey = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
  return { privateKey, publicKey, key_fingerprint: keyFingerprint(publicKey) };
}

const signer = demoSigner();

// ---------------------------------------------------------------------------
// 1. Publish the keyring (public/keys/kolm-issuers.json). Preserve any existing
//    non-demo entries (e.g. a future production key added out-of-band); only
//    refresh the demo entry so the sample always verifies against it.
// ---------------------------------------------------------------------------
const keyringPath = path.join(ROOT, 'public', 'keys', 'kolm-issuers.json');
let keyring = { schema: 'kolm-issuer-keyring-1', updated_at: '2026-06-08', issuers: [] };
try {
  const prev = JSON.parse(fs.readFileSync(keyringPath, 'utf8'));
  if (prev && Array.isArray(prev.issuers)) keyring = prev;
} catch { /* first run — start fresh */ }
keyring.schema = 'kolm-issuer-keyring-1';
keyring.issuers = (keyring.issuers || []).filter((i) => i && i.kid !== DEMO_KID);
keyring.issuers.unshift({
  kid: DEMO_KID,
  label: 'kolm demo issuer',
  status: 'demo',
  alg: 'ed25519',
  public_key: signer.publicKey,
  fingerprint: signer.key_fingerprint,
  note: 'Signs the public sample report on /verify only. NOT a production evidence signer. A report signed by this key is recognized as a kolm demo, never as production-issued evidence.',
});
fs.writeFileSync(keyringPath, JSON.stringify(keyring, null, 2) + '\n');
console.log(`wrote ${keyringPath} (${keyring.issuers.length} issuer(s))`);

// ---------------------------------------------------------------------------
// 2. Build + sign the sample report with the demo key.
// ---------------------------------------------------------------------------
const fixture = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');
const logs = fs.readFileSync(fixture, 'utf8');

const audit = runAudit(logs, { source: 'litellm' });
const { envelope, report_id, key_fingerprint } = buildAndSignReport(audit, {
  subject: 'Helpwise · support & billing agents (demo)',
  report_seed: 'sample',
  generated_at: '2026-06-08T00:00:00.000Z',
  signer,
});

const outPath = path.join(ROOT, 'public', 'sample-audit-report.json');
fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n');
console.log(`wrote ${outPath}`);
console.log(`  report_id=${report_id} key=${key_fingerprint}`);
console.log(`  readiness=${envelope.summary.readiness_pct}% blocking=${envelope.summary.blocking_count} findings=${envelope.findings.length}`);
